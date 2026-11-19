import type {IctoInput} from '../types';

export const GAIT_GUARD = .2;
export const GAIT_MIN_CYCLES = 5;
export const GAIT_MIN_SEG = 3;
const STRIDE_MIN = .25, STRIDE_MAX = 2;

export interface ActivitySegment {a: number; b: number; cls: number; confidence?: number; edge?: boolean; reviewed?: boolean}
export interface GaitSource {t: Float64Array; seq: Float64Array; ok: Uint8Array; axes: Float32Array[]; accAtRail?: Uint8Array}
export interface Candidate {
  event: string; cycle: number; detection_path: string; imu_packet_time_s: number; rowIdx?: number;
  uncertain?: boolean; eventNote?: string;
}
export interface GaitSideInput {
  side: string;
  t0: number;
  inp: IctoInput | null;
  accAtRail?: Uint8Array;
  rec: {events: Candidate[]; cycles?: {cycle: number; swing_start_s: number; swing_end_s: number; status?: string}[];
    diagnostics?: {gyro_axis?: string; sign?: number}} | null;
}
export interface GaitCycle {
  a: number; b: number; dt: number; to: number; cycle: number; pitch: number; acc: number;
  icUncertain?: boolean; nextIcUncertain?: boolean; eventNote?: string;
}
export interface GaitCell {
  side: string; steps: number; strides: number; stances: number; cadence: number;
  strideMed: number; strideQ1: number; strideQ3: number; strideCv: number;
  stanceMed: number; swingMed: number; duty: number; pitchMed: number; accMed: number;
  periods: GaitCycle[]; flags: string[];
}
export interface GaitSegment {
  index: number; cls: number; a: number; b: number; dur: number; steps: number; cadence: number;
  cadenceDiff: number; stanceSi: number; cells: GaitCell[]; flags: string[];
}

const finite = Number.isFinite;
function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * q, lo = Math.floor(h);
  return sorted[lo] + (sorted[Math.ceil(h)] - sorted[lo]) * (h - lo);
}
const sort = (xs: number[]) => xs.sort((a, b) => a - b);
const median = (xs: number[]) => quantile(sort(xs), .5);
function cv(xs: number[]) {
  const mean = xs.reduce((sum, v) => sum + v, 0) / xs.length;
  return 100 * Math.sqrt(xs.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (xs.length - 1)) / mean;
}
function lowerBound<T>(xs: T[], get: (value: T) => number, key: number) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (get(xs[m]) < key) lo = m + 1; else hi = m; }
  return lo;
}

function continuous(t: number, prevT: number, seq: number, prevSeq: number) {
  const delta = seq - prevSeq;
  return t > prevT && t - prevT <= .080000001 && (!finite(delta) || (delta >= 0 && delta <= 1));
}

// Use the classifier's full-rate session clock, not its resampled grid or the waveform viewport.
export function gaitIctoInput(s: GaitSource): IctoInput {
  const n = s.t.length, ax = new Float64Array(n * 6), tUs = new Float64Array(n);
  const seq = new Float64Array(n), ok = new Uint8Array(n), ord = new Float64Array(n), row = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let valid = !!s.ok[i] && finite(s.t[i]);
    tUs[i] = s.t[i] * 1e6;
    for (let j = 0; j < 6; j++) {
      const v = s.axes[j][i]; valid &&= finite(v); ax[i * 6 + j] = v;
    }
    ok[i] = +valid; row[i] = i; ord[i] = i;
    if (i) seq[i] = seq[i - 1] + (continuous(s.t[i], s.t[i - 1], s.seq[i], s.seq[i - 1]) ? 1 : 2);
  }
  return {n, tUs, seq, ok, ax, ord, row, sfo: ord};
}

export function groupsOf(inp: IctoInput) {
  const groups = new Int32Array(inp.n).fill(-1);
  let group = 0;
  for (let i = 0; i < inp.n; i++) {
    if (!inp.ok[i] || !finite(inp.tUs[i])) continue;
    if (i && (groups[i - 1] < 0 || !continuous(inp.tUs[i] / 1e6, inp.tUs[i - 1] / 1e6, inp.seq[i], inp.seq[i - 1]))) group++;
    groups[i] = group;
  }
  return groups;
}

function prep(s: GaitSideInput) {
  const origin = s.t0 / 1e6, inp = s.inp, d = s.rec?.diagnostics;
  const groups = inp && groupsOf(inp), axis = ['x', 'y', 'z'].indexOf(d?.gyro_axis);
  const ics: Candidate[] = [], tos = new Map<number, Candidate>(), strides: GaitCycle[] = [];
  for (const e of s.rec?.events || []) {
    if (e.detection_path !== 'interior' || !finite(e.imu_packet_time_s)) continue;
    if (e.event === 'IC') ics.push(e);
    if (e.event === 'TO') tos.set(e.cycle, e);
  }
  ics.sort((a, b) => a.imu_packet_time_s - b.imu_packet_time_s);
  for (let k = 1; k < ics.length; k++) {
    const p = ics[k - 1], q = ics[k], dt = q.imu_packet_time_s - p.imu_packet_time_s;
    const g = groups?.[p.rowIdx];
    if (!(g >= 0 && g === groups[q.rowIdx] && p.rowIdx < q.rowIdx) || q.cycle !== p.cycle + 1 || dt < STRIDE_MIN || dt > STRIDE_MAX) continue;
    const t = tos.get(p.cycle);
    const a = p.imu_packet_time_s - origin, b = q.imu_packet_time_s - origin;
    let to = NaN, pitch = NaN, acc = NaN;
    if (!p.uncertain && !q.uncertain && t && p.rowIdx < t.rowIdx && t.rowIdx < q.rowIdx && t.imu_packet_time_s > p.imu_packet_time_s && t.imu_packet_time_s < q.imu_packet_time_s) {
      to = t.imu_packet_time_s - origin;
      let peakAcc = -Infinity, peakPitch = -Infinity;
      for (let i = p.rowIdx; i <= t.rowIdx; i++) {
        const j = 6 * i;
        peakAcc = Math.max(peakAcc, Math.hypot(inp.ax[j], inp.ax[j + 1], inp.ax[j + 2]));
      }
      if (axis >= 0 && (d.sign === 1 || d.sign === -1)) {
        for (let i = t.rowIdx + 1; i < q.rowIdx; i++) peakPitch = Math.max(peakPitch, d.sign * inp.ax[6 * i + 3 + axis]);
      }
      if (finite(peakAcc)) acc = peakAcc;
      if (finite(peakPitch)) pitch = peakPitch;
    }
    const stride: GaitCycle = {a, b, dt, to, pitch, acc, cycle: p.cycle};
    if (p.uncertain) stride.icUncertain = true;
    if (q.uncertain) stride.nextIcUncertain = true;
    if (p.eventNote || q.uncertain) stride.eventNote = [p.eventNote, q.uncertain && '下一 IC 待确认'].filter(Boolean).join('；');
    strides.push(stride);
  }
  return {side: s.side, ics: ics.map(e => e.imu_packet_time_s - origin), strides};
}

function cellOf(p: ReturnType<typeof prep>, wa: number, wb: number, minCycles: number): GaitCell {
  const periods: GaitCycle[] = [];
  for (let i = lowerBound(p.strides, c => c.a, wa); i < p.strides.length && p.strides[i].a < wb; i++) {
    if (p.strides[i].b < wb) periods.push(p.strides[i]);
  }
  const steps = Math.max(0, lowerBound(p.ics, v => v, wb) - lowerBound(p.ics, v => v, wa));
  const paired = periods.filter(c => finite(c.to)), strideOk = periods.length >= minCycles, pairOk = paired.length >= minCycles;
  const dt = strideOk ? sort(periods.map(c => c.dt)) : [], strideMed = quantile(dt, .5);
  const peaks = (key: 'pitch' | 'acc') => {
    const vals = paired.map(c => c[key]).filter(finite);
    return vals.length >= minCycles ? median(vals) : NaN;
  };
  return {
    side: p.side, steps, strides: periods.length, stances: paired.length, periods,
    cadence: 120 / strideMed, strideMed, strideQ1: quantile(dt, .25), strideQ3: quantile(dt, .75), strideCv: dt.length > 1 ? cv(dt) : NaN,
    stanceMed: pairOk ? median(paired.map(c => c.to - c.a)) : NaN,
    swingMed: pairOk ? median(paired.map(c => c.b - c.to)) : NaN,
    duty: pairOk ? median(paired.map(c => (c.to - c.a) / c.dt)) : NaN,
    pitchMed: peaks('pitch'), accMed: peaks('acc'),
    flags: !strideOk ? [periods.length ? '周期不足' : '无可用周期'] : !pairOk ? ['IC/TO 配对不足'] : []
  };
}

export function gaitMetrics({segments, sides, guard = GAIT_GUARD, minCycles = GAIT_MIN_CYCLES, minSeg = GAIT_MIN_SEG}: {
  segments: ActivitySegment[]; sides: GaitSideInput[]; guard?: number; minCycles?: number; minSeg?: number;
}): GaitSegment[] {
  const preps = sides.map(prep);
  return segments.map(({a, b, cls, edge}, index) => {
    const dur = b - a;
    const out: GaitSegment = {index, cls, a, b, dur, steps: 0, cadence: NaN, cadenceDiff: NaN, stanceSi: NaN, cells: [], flags: []};
    if (cls !== 0 && cls !== 1) { out.flags.push('非步行 / 跑步段，不计入'); return out; }
    if (dur < minSeg) { out.flags.push('段过短'); return out; }
    if (edge) out.flags.push('含上下文不足区');
    out.cells = preps.map(p => cellOf(p, a + guard, b - guard, minCycles));
    out.steps = out.cells.reduce((sum, c) => sum + c.steps, 0);
    const valid = out.cells.filter(c => finite(c.cadence));
    if (!valid.length) out.flags.push('周期不足，不出汇总');
    else if (valid.length === 1) out.flags.push('步频仅由单侧估算');
    if (valid.length) out.cadence = valid.reduce((sum, c) => sum + c.cadence, 0) / valid.length;
    if (valid.length === 2) {
      const [l, r] = valid;
      out.cadenceDiff = 200 * Math.abs(l.cadence - r.cadence) / (l.cadence + r.cadence);
      if (finite(l.stanceMed) && finite(r.stanceMed)) out.stanceSi = 200 * Math.abs(l.stanceMed - r.stanceMed) / (l.stanceMed + r.stanceMed);
    }
    return out;
  });
}

export function gaitSummary(list: GaitSegment[]) {
  return [0, 1].map(cls => {
    let seconds = 0, steps = 0, w = 0, acc = 0, count = 0;
    for (const s of list) {
      if (s.cls !== cls || !finite(s.cadence)) continue;
      seconds += s.dur; count++;
      for (const c of s.cells) {
        if (!finite(c.cadence)) continue;
        steps += c.steps; w += c.strides; acc += c.cadence * c.strides;
      }
    }
    return {cls, seconds, steps, count, cadence: w ? acc / w : NaN};
  });
}
