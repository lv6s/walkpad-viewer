import {R2D, SENS, clamp1, cross, dot, eig3, unit, vlen} from './math.ts';

type Vec = number[];
export type AxisRange = {a: number; b: number};
type Quiet = {a: number; b: number; up: Vec; bias: Vec; accSpread: number; gyroSpread: number};
type Cycle = {a: number; b: number; axis: Vec; ratio: number};
type Candidate = {a: number; b: number; peaks: number[]; anchors: Quiet[]; from: number};
type Level = 'hi' | 'mid';
export type AxisSupport = [Float32Array, Float32Array, Float32Array];
type SupportRef = {up: Vec; supportCycles: number; supportSpread: number; supportRange: AxisRange};
export type AxisOffline = Partial<SupportRef> & {
  blocked?: boolean; quietUpDelta?: number;
  reason?: string; up?: Vec; bias?: Vec; quiet?: AxisRange; accSpread?: number; gyroSpread?: number;
  fs?: number; candidates: AxisRange[]; used?: AxisRange; walk?: AxisRange; cycles?: number; ratio?: number; spread?: number;
  quietDist?: number;
  forward?: Vec; lateral?: Vec; confA?: Level; confB?: Level; fallback?: boolean;
};

type Opt = {win?: AxisRange; sens?: typeof SENS.auto; walking?: AxisRange[]; fallback?: boolean; support?: AxisSupport};

const sub = (a: Vec, b: Vec) => a.map((x, i) => x - b[i]);
const between = (a: Vec, b: Vec) => Math.acos(clamp1(Math.abs(dot(a, b)))) * R2D;
const mean = (xs: Vec[]) => xs.reduce((sum, v) => sum.map((x, i) => x + v[i] / xs.length), [0, 0, 0]);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const addOuter = (c: Vec[], v: Vec, w = 1) => {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += w * v[i] * v[j];
};
const zeros = () => Array.from({length: 3}, () => [0, 0, 0]);
const steadyTempo = (a: number, b: number) => Math.abs(a - b) <= .25 * Math.max(a, b);
// 静站只提供向上与零偏，离动作越远越可能有漂移或中途重戴：近处不降级，远处降级，过远不用
const QUIET_MAX = 120;
export const QUIET_NEAR = 10;

export function walkingRanges(labels: ArrayLike<number>): AxisRange[] {
  const out: AxisRange[] = [];
  for (let i = 0; i < labels.length;) {
    if (labels[i] !== 0) { i++; continue; }
    let j = i + 1;
    while (j < labels.length && labels[j] === 0) j++;
    out.push({a: i / 10, b: j / 10});
    i = j;
  }
  return out;
}

export function inferOffline(src, opt: Opt = {}): AxisOffline {
  if (opt.walking && !opt.fallback) {
    const primary = inferOnce(src, opt);
    if (primary.forward || primary.blocked || opt.support) return primary;
    const fallback = inferOnce(src, {...opt, walking: undefined, fallback: true});
    if (fallback.forward) return {...fallback, fallback: true};
    if (fallback.blocked) return {...fallback, fallback: true};
    return {...primary, reason: '步行段检测未找到合格周期，兜底周期筛查也未通过。'};
  }
  return inferOnce(src, opt);
}

function inferOnce(src, opt: Opt = {}): AxisOffline {
  const s = src.blk || src;
  const t: ArrayLike<number> = s.t, p: ArrayLike<number>[] = s.imu?.phys;
  const empty = {candidates: []};
  if (!p || p.length < 6) return {...empty, reason: '没有可用的物理量六轴 IMU。'};
  const n = Math.min(s.n, t?.length || 0, ...p.slice(0, 6).map(x => x?.length || 0));
  let lo = 0, hi = n - 1;
  if (opt.win) {
    while (lo < n && t[lo] < opt.win.a) lo++;
    while (hi >= lo && t[hi] > opt.win.b) hi--;
  }
  // 段尾 afterEnd 帧的有效时间为空：尾部 NaN 会把采样率与时长一起算坏
  while (hi > lo && !Number.isFinite(t[hi])) hi--;
  while (lo < hi && !Number.isFinite(t[lo])) lo++;
  const rates = [], width = Math.min(24, hi - lo);
  if (width > 0) for (let k = lo; k + width <= hi; k += Math.max(width, Math.floor((hi - lo) / 128))) {
    const dt = t[k + width] - t[k];
    if (dt > 0) rates.push(width / dt);
  }
  const fs = median(rates);
  if (!(fs >= 19.99 && fs <= 500.01) || hi - lo < fs * .75) return {...empty, reason: '有效数据太短，或采样率不在 20–500 Hz 范围内。'};
  const range = (a: number, b: number) => ({a: t[a], b: t[b]});
  const read = (k: number, ch: number): Vec => [p[ch][k], p[ch + 1][k], p[ch + 2][k]];
  const acc = (k: number) => read(k, 0);
  const gyr = (k: number) => read(k, 3);
  const aNorm = new Float32Array(hi - lo + 1), gNorm = new Float32Array(aNorm.length);
  const good = new Uint8Array(aNorm.length);
  const original = src.activityIn?.t === t ? src.activityIn : null;
  const quality = original?.ok, seq = original?.seq;
  for (let k = lo; k <= hi; k++) {
    aNorm[k - lo] = Math.hypot(p[0][k], p[1][k], p[2][k]);
    gNorm[k - lo] = Math.hypot(p[3][k], p[4][k], p[5][k]);
    good[k - lo] = Number.isFinite(t[k]) && quality?.[k] !== 0 && Number.isFinite(aNorm[k - lo])
      && Number.isFinite(gNorm[k - lo]) && Math.max(Math.abs(p[3][k]), Math.abs(p[4][k]), Math.abs(p[5][k])) < 1995 ? 1 : 0;
  }
  const gap = Math.max(.10, 3.5 / fs);
  const sens = opt.sens || SENS.auto;
  const qn = Math.ceil(fs * .85), hop = Math.max(1, Math.round(fs * .12));
  const candidates: Candidate[] = [];
  const classified = opt.walking?.map(w => ({a: Math.max(w.a, t[lo]), b: Math.min(w.b, t[hi])})).filter(w => w.b > w.a);
  let firstQuiet: Quiet | null = null;

  const quietAt = (a: number, b: number): Quiet | null => {
    const aa = [], gg = [];
    for (let k = a; k <= b; k++) {
      if (Math.abs(aNorm[k - lo] - 1) > sens.dev * 1.25 || gNorm[k - lo] > 57) return null;
      aa.push(acc(k)); gg.push(gyr(k));
    }
    const av = mean(aa), bias = mean(gg), am = vlen(av);
    if (Math.abs(am - 1) > sens.dev || vlen(bias) > 50) return null;
    const accSpread = Math.max(...aa.map(v => vlen(sub(v, av))));
    const gyroSpread = Math.max(...gg.map(v => vlen(sub(v, bias))));
    return accSpread <= 2 * sens.std && gyroSpread <= 7
      ? {a, b, up: unit(av), bias, accSpread, gyroSpread} : null;
  };
  const base = (q: Quiet) => ({up: q.up, bias: q.bias, quiet: range(q.a, q.b),
    accSpread: q.accSpread, gyroSpread: q.gyroSpread, confA: (q.accSpread <= .04 && q.gyroSpread <= 4 ? 'hi' : 'mid') as Level});

  const estimate = (a: number, b: number, bias: Vec, up: Vec): Cycle | null => {
    const dur = t[b] - t[a];
    if (dur < .60 || dur > 1.75) return null;
    const ws = [], mags = [];
    let turn = 0;
    for (let k = a; k < b; k++) {
      const v = sub(gyr(k), bias), m = vlen(v);
      turn += dot(v, up) * (t[k + 1] - t[k]);
      if (m >= 12) { ws.push(v); mags.push(m); }
    }
    if (ws.length < .18 * fs || Math.abs(turn) > 22) return null;
    const c = zeros(), cap = 1.6 * median(mags);
    let energy = 0, motion = 0, yaw = 0;
    for (let k = 0; k < ws.length; k++) {
      const v = ws[k], m = mags[k], w = Math.min(1, cap / m) ** 2, z = dot(v, up);
      energy += w * m * m;
      yaw += w * z * z;
      motion += Math.min(m, cap) / fs;
      addOuter(c, sub(v, up.map(x => x * z)), w);
    }
    const e = eig3(c), axis = unit(e.vec[2]), ratio = e.val[2] / energy;
    return ratio >= .67 && yaw / energy <= .24 && motion >= 22 ? {a, b, axis, ratio} : null;
  };

  // 候选分段不读取 PCA 结果，避免用主轴本身证明这里是直走。
  let wi = 0;
  for (let a = lo; a <= hi;) {
    if (!good[a - lo]) { a++; continue; }
    let b = a;
    while (b < hi && good[b + 1 - lo] && t[b + 1] >= t[b] && t[b + 1] - t[b] <= gap &&
      !(Number.isFinite(seq?.[b]) && Number.isFinite(seq?.[b + 1]) && seq[b + 1] <= seq[b])) b++;
    const anchors: Quiet[] = [], peaks: number[] = [];
    for (let k = a; k + qn <= b; k += hop) {
      if (t[k + qn] - t[k] < .72 || t[k + qn] - t[k] > 1.2) continue;
      const q = quietAt(k, k + qn);
      if (q) { anchors.push(q); firstQuiet ||= q; }
    }
    const emit = (first: number, end: number, ps: number[], from: number) => {
      candidates.push({a: first, b: end, peaks: ps, anchors, from});
    };
    const norm = (k: number) => aNorm[k - lo];
    const half = Math.max(2, Math.round(.07 * fs));
    const prominence = (k: number) => norm(k) - Math.max(norm(k - half), norm(k + half));
    if (!classified || classified.length) for (let k = a + half; k + half <= b; k++) {
      if (norm(k) < 1.15 || norm(k) <= norm(k - 1) || norm(k) < norm(k + 1) || prominence(k) < .12) continue;
      const last = peaks.at(-1);
      if (last != null && t[k] - t[last] < .50) {
        if (prominence(k) > prominence(last)) peaks[peaks.length - 1] = k;
      } else peaks.push(k);
    }
    if (classified) {
      let pi = 0;
      while (wi < classified.length && classified[wi].b <= t[a]) wi++;
      for (let j = wi; j < classified.length && classified[j].a <= t[b]; j++) {
        const w = classified[j], ps = [];
        while (pi < peaks.length && t[peaks[pi]] < w.a) pi++;
        while (pi < peaks.length && t[peaks[pi]] < w.b) ps.push(peaks[pi++]);
        if (ps.length >= 3) emit(ps[0], ps.at(-1), ps, j);
      }
    } else {
      let ps: number[] = [], prior = 0;
      for (let j = 0; j + 1 < peaks.length; j++) {
        const l = peaks[j], r = peaks[j + 1], dur = t[r] - t[l];
        let peak = 0;
        for (let k = l; k < r; k++) peak = Math.max(peak, gNorm[k - lo]);
        const valid = dur >= .60 && dur <= 1.75 && peak >= 48;
        if (!valid || (ps.length > 1 && !steadyTempo(dur, prior))) {
          if (ps.length >= 3) emit(ps[0], ps.at(-1), ps, candidates.length);
          ps = [];
        }
        if (valid) { if (!ps.length) ps.push(l); ps.push(r); prior = dur; }
      }
      if (ps.length >= 3) emit(ps[0], ps.at(-1), ps, candidates.length);
    }
    a = b + 1;
  }

  const support = opt.support;
  const out: AxisOffline = {fs, candidates: classified || candidates.map(c => range(c.a, c.b)),
    ...(!support && firstQuiet ? base(firstQuiet) : {})};
  if (!out.candidates.length) return {...out, reason: '没有检测到可用于推断的步行候选。'};
  if (!support && !firstQuiet) return {...out, reason: '找到步行候选，但没有连续静止参考，不能定向上或水平轴线。'};

  const supportLimit = Math.cos(12 / R2D);
  const reference = (ps: number[]): SupportRef | 'conflict' | null => {
    const [heel, fore, total] = support!;
    const loads = [];
    for (let k = ps[0]; k < ps.at(-1)!; k++) if (total[k] > 0) loads.push(total[k]);
    const floor = median(loads);
    if (!(floor > 0)) return null;
    const votes: Vec[] = [];
    let start = -1, end = -1;
    for (let i = 0; i < ps.length - 1; i++) {
      const a = ps[i], b = ps[i + 1], samples: Vec[] = [];
      if (t[b] - t[a] < .60 || t[b] - t[a] > 1.75) continue;
      let first = -1, last = -1;
      for (let k = a; k < b; k++) {
        const g = aNorm[k - lo], load = total[k];
        if (!(g >= .90 && g <= 1.10 && gNorm[k - lo] <= 20 && load >= floor &&
            heel[k] >= .05 * load && fore[k] >= .05 * load)) continue;
        samples.push(unit(acc(k)));
        if (first < 0) first = k;
        last = k;
      }
      if (samples.length < Math.max(2, Math.ceil(.04 * fs))) continue;
      const v = unit(mean(samples));
      if (samples.some(x => dot(v, x) < supportLimit)) continue;
      votes.push(v);
      if (start < 0) start = first;
      end = last;
    }
    if (votes.length < 3) return null;
    const up = unit(mean(votes)), worst = Math.min(...votes.map(v => dot(v, up)));
    if (worst < supportLimit) return 'conflict';
    return {up, supportCycles: votes.length, supportSpread: Math.acos(clamp1(worst)) * R2D, supportRange: range(start, end)};
  };

  const fits = new Map<number, AxisOffline>();
  const refs: SupportRef[] = [];
  let farRef = 0;
  for (const c of candidates) {
    const ps = c.peaks, ref = support ? reference(ps) : null;
    if (ref === 'conflict' || ref && refs.some(r => dot(r.up, ref.up) < supportLimit)) {
      return {...out, blocked: true, reason: '承重片段的向上方向不一致，不显示鞋垫姿态。'};
    }
    if (support && !ref) continue;
    if (ref) refs.push(ref);
    let qi = 0;
    const at = (q: Quiet, a: number, b: number) => t[q.b] <= t[a] ? t[a] - t[q.b] : t[q.a] >= t[b] ? t[q.a] - t[b] : Infinity;
    for (let i = 0; i + 2 < ps.length; i++) {
      const a = ps[i], end = ps[i + 2];
      const qs = c.anchors;
      while (qi < qs.length && qs[qi].b <= a) qi++;
      let j = qi;
      while (j < qs.length && qs[j].a < end) j++;
      const before = qs[qi - 1], after = qs[j];
      const q = !after || (before && at(before, a, end) <= at(after, a, end)) ? before : after;
      const dist = q ? at(q, a, end) : Infinity;
      if (!ref && !(dist <= QUIET_MAX)) { farRef++; continue; }
      const anchor = dist <= QUIET_MAX ? q : undefined;
      const up = ref?.up ?? anchor!.up, bias = anchor?.bias ?? [0, 0, 0];
      const steps: Cycle[] = [];
      for (let k = i; k + 1 < ps.length && steps.length < 4; k++) {
        if (anchor && ps[k + 1] > anchor.a && anchor.b > a) break;
        const st = estimate(ps[k], ps[k + 1], bias, up);
        if (!st || steps.some(x => between(x.axis, st.axis) > 15 || !steadyTempo(t[x.b] - t[x.a], t[st.b] - t[st.a]))) break;
        steps.push(st);
      }
      if (steps.length < 2) continue;
      const m = zeros();
      steps.forEach(st => addOuter(m, st.axis));
      const lateral0 = unit(eig3(m).vec[2]), forward = unit(cross(up, lateral0));
      const spread = Math.max(...steps.map(st => between(st.axis, lateral0)));
      const ratio = Math.min(...steps.map(st => st.ratio));
      const confB = (ref || dist <= QUIET_NEAR) && steps.length >= 3 && ratio >= .82 && spread <= 7 ? 'hi' : 'mid';
      const quietUpDelta = ref && anchor ? Math.acos(clamp1(dot(ref.up, anchor.up))) * R2D : undefined;
      const old = fits.get(c.from);
      if (old && (old.confB === 'hi' && confB !== 'hi' || old.confB === confB && (old.cycles > steps.length ||
        old.cycles === steps.length && old.spread <= spread + .1))) continue;
      fits.set(c.from, {...out, ...(anchor ? base(anchor) : {}), ...ref, up, quietUpDelta,
        used: out.candidates[c.from], walk: range(a, steps.at(-1).b), cycles: steps.length,
        ratio, spread, forward, lateral: cross(up, forward), quietDist: anchor ? dist : undefined, confB});
      if (confB === 'hi' && steps.length === 4 && spread <= 3) break;
    }
  }
  const ranked = [...fits.values()].sort((a, b) => Number(b.confB === 'hi') - Number(a.confB === 'hi') || b.cycles - a.cycles || a.spread - b.spread);
  if (!ranked.length && support) return {...out, ...refs[0], reason: refs.length
    ? '已找到承重竖直参考，但步行主轴证据不足，不显示完整姿态。'
    : '找不到跨步重复的稳定承重参考，不用普通静止段代替。'};
  if (!ranked.length) return {...out, reason: farRef ? `最近的静止参考离步行段超过 ${QUIET_MAX} s，不拿它定零偏与向上。`
    : '步行候选中的有效周期、附近静止参考或跨步一致性不足，未推断水平轴线。'};
  const best = ranked[0];
  if (ranked.some(r => between(r.lateral, best.lateral) > 18 || dot(r.up, best.up) < .94)) {
    return {...out, blocked: true, reason: '不同步行段推断的轴线不一致，未合并为一套姿态。'};
  }
  return best;
}
