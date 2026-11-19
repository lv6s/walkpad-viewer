import type {ActivitySegment, Candidate, GaitSideInput} from './core';

export const IC_TO_LABELS = {legacy: '原版', running: '跑步实验版'} as const;
export type IctoVersion = keyof typeof IC_TO_LABELS;

interface Sample {t: number; pitch: number; gyro: number; acc: number}
interface Choice {ic: number; to: number; uncertain: boolean; note?: string}

function minimum(xs: Sample[], a: number, b: number, key: 'pitch' | 'gyro') {
  let best = -1;
  for (let i = a; i <= b; i++) if (best < 0 || xs[i][key] < xs[best][key]) best = i;
  return best;
}

export function runningPair(xs: Sample[], baseIC: number, baseTO: number): Choice {
  const span = xs.at(-1).t - xs[0].t;
  const phase = (i: number) => (xs[i].t - xs[0].t) / span;
  const indices = xs.map((_, i) => i);
  const low = (a: number, b: number) => {
    const win = indices.filter(i => phase(i) >= a && phase(i) <= b);
    return win.length ? minimum(xs, win[0], win.at(-1), 'gyro') : -1;
  };
  const middle = low(.30, .45), broad = low(.20, .60);
  let ic = baseIC, to = baseTO, uncertain = false;
  const notes: string[] = [];
  if (middle <= baseIC || middle >= baseTO) return {ic, to: -1, uncertain: true, note: '未找到可信的支撑参照'};

  const peaks = indices.filter(i => i > 0 && i < broad && phase(i) >= .06 && phase(i) <= .31
    && xs[i].acc >= xs[i - 1].acc && xs[i].acc > xs[i + 1].acc);
  const peak = peaks.reduce((best, i) => best < 0 || xs[i].acc > xs[best].acc ? i : best, -1);
  const floor = Math.max(1, xs[broad]?.acc ?? 1);
  if (peak >= 0 && baseIC - peak >= 3 && xs[baseIC].t - xs[peak].t >= .035
    && xs[peak].acc >= 2.5 * floor && xs[broad].gyro <= .65 * xs[middle].gyro) {
    const cross = indices.find(i => i > 0 && i < broad && xs[i - 1].pitch > 0 && xs[i].pitch <= 0);
    if (cross != null) {
      const alternative = minimum(xs, cross, broad - 1, 'pitch');
      if (alternative < baseIC && Math.abs(alternative - peak) <= 2 && Math.abs(xs[alternative].t - xs[peak].t) <= .065) ic = alternative;
    }
    uncertain = ic === baseIC;
    notes.push(uncertain ? 'IC 信号冲突，原点仅作周期参照' : 'IC 改选：加速度峰与俯仰转折相符');
  }

  const valleys = [];
  const deepest = Math.max(0, ...xs.slice(middle + 1, -1).map(x => -x.pitch));
  for (let i = middle + 1; i < xs.length - 1; i++) {
    const p = xs[i].pitch, depth = -p;
    if (!(depth > 0 && depth >= .55 * deepest && p <= xs[i - 1].pitch && p < xs[i + 1].pitch)) continue;
    let left = i - 1, right = i + 1;
    while (left > middle && xs[i].t - xs[left].t < .09) left--;
    while (right < xs.length - 1 && xs[right].t - xs[i].t < .09) right++;
    const fall = Math.max(...xs.slice(left, i).map(x => x.pitch)) - p;
    const rise = Math.max(...xs.slice(i + 1, right + 1).map(x => x.pitch)) - p;
    const turn = Math.max(...xs.slice(left, right + 1).map(x => x.gyro)) - Math.min(...xs.slice(left, right + 1).map(x => x.gyro));
    valleys.push({i, supported: Math.min(rise, fall) >= .20 * deepest && turn >= .20 * depth});
  }
  const separation = Math.max(.065, .12 * span);
  const similarToBase = (i: number) => Math.abs(xs[i].t - xs[baseTO].t) < separation;
  const earlier = valleys.filter(v => v.i < baseTO && !similarToBase(v.i));
  const alternative = earlier.find(v => v.supported);
  // Distinct early candidates must agree on the transition before overriding the deepest valley.
  if (alternative && !earlier.some(v => Math.abs(xs[alternative.i].t - xs[v.i].t) >= separation)) {
    to = alternative.i;
    notes.push('TO 改选：较早谷有回升证据');
  } else if (earlier.length || !valleys.some(v => v.supported && similarToBase(v.i))) {
    to = -1;
    notes.push(earlier.length ? 'TO 多个谷，证据不足' : 'TO 缺少可确认的转折');
  }
  return {ic, to, uncertain, note: notes.length ? notes.join('；') : undefined};
}

export function refineRunning(s: GaitSideInput, segments: ActivitySegment[]): GaitSideInput {
  const {inp, rec} = s;
  if (!inp || !rec?.cycles?.length) return s;
  const axis = ['x', 'y', 'z'].indexOf(rec.diagnostics?.gyro_axis), sign = rec.diagnostics?.sign;
  if (axis < 0 || !(sign === 1 || sign === -1)) return s;
  const origin = s.t0 / 1e6;
  const {tUs, ok, seq, ax, n} = inp;
  const epoch = (i: number) => tUs[i] / 1e6;
  const linked = (i: number) => {
    const step = seq[i + 1] - seq[i], dt = tUs[i + 1] - tUs[i];
    return ok[i] && ok[i + 1] && dt > 0 && dt <= 80000.001 && (!Number.isFinite(step) || (step >= 0 && step <= 1));
  };
  const ics = rec.events.filter(e => e.detection_path === 'interior' && e.event === 'IC').sort((a, b) => a.rowIdx - b.rowIdx);
  const tos = new Map(rec.events.filter(e => e.detection_path === 'interior' && e.event === 'TO').map(e => [e.cycle, e]));
  const cycles = new Map(rec.cycles.map(c => [c.cycle, c]));
  const runs = segments.filter(s => s.cls === 1);
  let runIdx = 0;
  const edit = new Map<Candidate, Candidate | null>();
  for (const [k, e] of ics.entries()) {
    const c = cycles.get(e.cycle), oldTO = tos.get(e.cycle);
    if (!c || !oldTO) continue;
    const a = c.swing_start_s, b = c.swing_end_s;
    while (runs[runIdx]?.b <= a - origin) runIdx++;
    const run = runs[runIdx];
    if (!run || a - origin < run.a || b - origin >= run.b || !(b - a >= .25 && b - a <= 2)) continue;
    const icRow = e.rowIdx, toRow = oldTO.rowIdx;
    let l = icRow, r = toRow;
    while (l > 0 && epoch(l) > a && linked(l - 1)) l--;
    while (r + 1 < n && epoch(r) < b && linked(r)) r++;
    if (!(epoch(l) === a && epoch(r) === b && l < icRow && icRow < toRow && toRow < r)) continue;
    const samples: Sample[] = [];
    for (let i = l; i <= r; i++) {
      if (i < r && !linked(i)) break;
      const j = i * 6;
      samples.push({t: epoch(i), pitch: sign * ax[j + 3 + axis], gyro: Math.hypot(ax[j + 3], ax[j + 4], ax[j + 5]),
        acc: Math.hypot(ax[j], ax[j + 1], ax[j + 2])});
    }
    if (samples.length !== r - l + 1) continue;
    const x = runningPair(samples, icRow - l, toRow - l);
    let row = l + x.ic;
    const reference = edit.get(ics[k - 1]) || ics[k - 1];
    if (row !== icRow && (epoch(row) - (reference?.imu_packet_time_s ?? -Infinity) < .2
      || (ics[k + 1]?.imu_packet_time_s ?? Infinity) - epoch(row) < .2)) {
      row = icRow; x.uncertain = true; x.note = 'IC 改选与相邻事件冲突，原点仅作周期参照';
    }
    edit.set(e, {...e, rowIdx: row, imu_packet_time_s: epoch(row), uncertain: x.uncertain, eventNote: x.note});
    edit.set(oldTO, x.to < 0 ? null : {...oldTO, rowIdx: l + x.to, imu_packet_time_s: epoch(l + x.to)});
  }
  return edit.size ? {...s, rec: {...rec, events: rec.events.flatMap(e => !edit.has(e) ? [e] : edit.get(e) ? [edit.get(e)] : [])}} : s;
}
