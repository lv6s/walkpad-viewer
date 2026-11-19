import {D2R, R2D, SENS, cross, dot, infer, unit} from '../axis/math.ts';
import type {ActivitySegment, GaitSideInput} from './core';

const MAX_DT = .05, ANCHOR_SPAN = .12, ANCHOR_REACH = .85;
const IMPACT_WINDOW = .100;
type Vec = number[];
type Quiet = {row: number; up: Vec; gyro: Vec; spread: number};
export type PoseIssue = 'no_anchor' | 'pose_path' | 'pose_conflict' | 'no_axis';
type ToIssue = PoseIssue | 'no_to' | 'to_outside';
type ImpactIssue = PoseIssue | 'window_short' | 'window_gap' | 'rail' | 'no_positive_peak';
export type GaitMeasures = {ic_pitch_deg: number | null; to_pitch_deg: number | null; impact_peak_g: number | null; impact_peak_ms: number | null;
  icIssue: PoseIssue | null; toIssue: ToIssue | null; impactIssue: ImpactIssue | null};
export const emptyGaitImu = (): GaitMeasures => ({ic_pitch_deg: null, to_pitch_deg: null, impact_peak_g: null, impact_peak_ms: null,
  icIssue: null, toIssue: null, impactIssue: null});

const len = (x: Vec) => Math.hypot(...x);
const sub = (a: Vec, b: Vec) => a.map((v, j) => v - b[j]);
const mix = (a: Vec, b: Vec, f: number) => a.map((v, j) => v + (b[j] - v) * f);
function lower(n: number, pred: (i: number) => boolean) {
  let lo = 0;
  while (lo < n) { const m = (lo + n) >>> 1; if (pred(m)) n = m; else lo = m + 1; }
  return lo;
}

// Gravity expressed in sensor coordinates evolves as -omega × up.
export function carryUp(up: Vec, gyro: Vec, dt: number) {
  const speed = len(gyro);
  if (!speed) return up;
  const axis = gyro.map(v => v / speed), angle = -dt * speed * D2R;
  const c = Math.cos(angle), s = Math.sin(angle), turn = cross(axis, up), parallel = dot(axis, up);
  return unit(up.map((v, j) => c * v + s * turn[j] + (1 - c) * parallel * axis[j]));
}

export function gaitImu(side: GaitSideInput, groups: Int32Array, segments: ActivitySegment[]) {
  const {inp, t0, accAtRail} = side, origin = t0 / 1e6;
  const time = (i: number) => inp.tUs[i] / 1e6 - origin;
  const vec = (i: number, j: number) => [inp.ax[i * 6 + j], inp.ax[i * 6 + j + 1], inp.ax[i * 6 + j + 2]];
  const ranges: {lo: number; hi: number}[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]; if (g < 0) continue;
    if (!ranges[g]) ranges[g] = {lo: i, hi: i}; else ranges[g].hi = i;
  }
  const motion = segments.filter(s => s.cls === 0 || s.cls === 1);
  const models = new Map<number, ReturnType<typeof prepare>>();
  function prepare(g: number) {
    const {lo, hi} = ranges[g];
    const quiet: Quiet[] = [];
    for (let end = lo + 1, start = lo; end <= hi; end++) {
      const dt = time(end) - time(end - 1);
      if (dt > MAX_DT || dt < .00001 || accAtRail?.[end - 1]) { start = end; continue; }
      if (accAtRail?.[end]) continue;
      while (start + 1 < end && time(end) - time(start + 1) >= ANCHOR_SPAN) start++;
      if (end - start < 4 || time(end) - time(start) < ANCHOR_SPAN) continue;
      const center = (start + end) >>> 1;
      if (quiet.length && time(center) - time(quiet.at(-1).row) < .06) continue;
      const a = [0, 0, 0], w = [0, 0, 0], n = end - start + 1;
      for (let i = start; i <= end; i++) for (let j = 0; j < 3; j++) {
        a[j] += inp.ax[i * 6 + j] / n; w[j] += inp.ax[i * 6 + 3 + j] / n;
      }
      if (Math.abs(len(a) - 1) > .10) continue;
      let av = 0, gv = 0;
      for (let i = start; i <= end; i++) {
        av = Math.max(av, len(sub(vec(i, 0), a))); gv = Math.max(gv, len(sub(vec(i, 3), w)));
      }
      if (av <= .08 && gv <= 8) quiet.push({row: center, up: unit(a), gyro: w, spread: gv});
    }
    const stable = [...quiet].sort((a, b) => a.spread - b.spread).slice(0, Math.max(3, Math.ceil(quiet.length / 4)));
    const bias = [0, 1, 2].map(j => stable.map(q => q.gyro[j]).sort((a, b) => a - b)[stable.length >> 1]);
    const anchors = stable.length >= 3 ? quiet.filter(q => len(sub(q.gyro, bias)) <= 18) : [];
    let basis: Vec = null;
    if (anchors.length) {
      const regions = motion.map(s => ({a: Math.max(s.a, time(lo)), b: Math.min(s.b, time(hi)), cls: s.cls}))
        .filter(s => s.b - s.a >= 1.5).sort((a, b) => (b.b - b.a) - (a.b - a.a));
      const candidates = [0, 1].flatMap(cls => regions.filter(r => r.cls === cls).slice(0, 4));
      for (const {a, b} of candidates) {
        const start = lo + lower(hi - lo + 1, i => time(lo + i) >= a);
        const end = start + lower(hi - start + 1, i => time(start + i) >= b);
        const t = Float64Array.from({length: end - start}, (_, k) => time(start + k));
        const phys = Array.from({length: 6}, (_, j) => Float64Array.from(t, (_, k) => inp.ax[(start + k) * 6 + j]));
        const r = infer({n: t.length, t, imu: {phys}}, {sens: SENS.auto, win: null, useMountGeometry: false});
        if (r.sign && r.confA !== 'lo' && r.confB !== 'lo' && r.confC !== 'lo' && r.spreadJ <= 60) {
          basis = r.fwdS; break;
        }
      }
    }
    return {anchors, bias, basis, hi};
  }
  function upAt(i: number, calibr: ReturnType<typeof prepare>): Vec | Exclude<PoseIssue, 'no_axis'> {
    const {anchors, bias} = calibr, k = lower(anchors.length, j => anchors[j].row >= i);
    const recover = (anchor?: Quiet) => {
      if (!anchor || Math.abs(time(i) - time(anchor.row)) > ANCHOR_REACH) return null;
      let up = anchor.up, from = anchor.row;
      for (const dir = Math.sign(i - from); from !== i; from += dir) {
        const to = from + dir, dt = time(to) - time(from);
        if (Math.abs(dt) > MAX_DT || Math.abs(dt) < .00001) return null;
        const a = vec(from, 3), b = vec(to, 3);
        if (a.some((v, j) => Math.abs(v) >= 1995 || Math.abs(b[j]) >= 1995)) return null;
        up = carryUp(up, sub(mix(a, b, .5), bias), dt);
      }
      return up;
    };
    if (anchors[k]?.row === i) return anchors[k].up;
    const before = anchors[k - 1], after = anchors[k];
    if (![before, after].some(a => a && Math.abs(time(i) - time(a.row)) <= ANCHOR_REACH)) return 'no_anchor' as const;
    const u = recover(before), v = recover(after);
    if (!u || !v) return (u || v) ?? 'pose_path' as const;
    if (dot(u, v) < Math.cos(12 * D2R)) return 'pose_conflict' as const;
    return unit(mix(u, v, (time(i) - time(before.row)) / (time(after.row) - time(before.row))));
  }
  return (ic: number, to: number | null, segmentEnd: number): GaitMeasures => {
    const m = emptyGaitImu(), g = groups[ic];
    if (!models.has(g)) models.set(g, prepare(g));
    const cal = models.get(g);
    const pitch = (i: number): [number | null, PoseIssue | null] => {
      const up = upAt(i, cal);
      if (typeof up === 'string') return [null, up];
      if (!cal.basis) return [null, 'no_axis'];
      return [Math.asin(Math.max(-1, Math.min(1, dot(cal.basis, up)))) * R2D, null];
    };
    [m.ic_pitch_deg, m.icIssue] = pitch(ic);
    if (to !== null && groups[to] === g) [m.to_pitch_deg, m.toIssue] = pitch(to);
    else m.toIssue = to === null ? 'no_to' : 'to_outside';
    const fail = (issue: ImpactIssue) => ({...m, impactIssue: issue});
    const end = time(ic) + IMPACT_WINDOW;
    if (end > segmentEnd + 1e-9 || (to !== null && end > time(to) + 1e-9)) return fail('window_short');
    let i = ic, peak = 0, at = -1;
    // Only native samples from the uninterrupted impact window are eligible.
    for (; i <= cal.hi && time(i) < end - 1e-9; i++) {
      if (i > ic && (time(i) - time(i - 1) > MAX_DT || time(i) - time(i - 1) < .00001)) return fail('window_gap');
      const a = vec(i, 0);
      if (accAtRail?.[i] || a.some((v, j) => Math.abs(v) >= 15.98 || (i > ic &&
        [2, 4, 8].some(rail => Math.abs(Math.abs(v) - rail) < .018) && Math.abs(v - inp.ax[(i - 1) * 6 + j]) < .0001))) return fail('rail');
      const up = upAt(i, cal);
      if (typeof up === 'string') return fail(up);
      const projected = dot(a, up) - 1;
      if (projected > peak) { peak = projected; at = i; }
    }
    if (i - ic < 3 || i > cal.hi || time(i) - time(i - 1) > MAX_DT) return fail('window_gap');
    if (at < 0) return fail('no_positive_peak');
    m.impact_peak_g = peak; m.impact_peak_ms = Math.round(time(at) * 1000);
    return m;
  };
}
