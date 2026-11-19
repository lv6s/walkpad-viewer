import {groupsOf} from './core.ts';
import type {ActivitySegment, Candidate, DeviceAngleArrays, GaitSideInput} from './core';
import {gaitImu} from './walking-imu.ts';
import type {GaitMeasures} from './walking-imu.ts';

type Side = 'left' | 'right';
type Interval = {start_ms: number; end_ms: number};
type PitchFields = 'ic_pitch_deg' | 'to_pitch_deg' | 'icIssue' | 'toIssue';
export interface GaitStep extends Omit<GaitMeasures, PitchFields> {
  ic_pitch_deg: number | null;
  to_pitch_deg: number | null;
  icIssue: 'app_pitch_missing' | null;
  toIssue: 'app_pitch_missing' | 'no_to' | 'to_outside' | null;
  footPitch: Pick<GaitMeasures, PitchFields>;
  step_index: number;
  side: Side;
  ic_ms: number;
  to_ms: number | null;
  deviceAngles?: {ic: DeviceAngle | null; to: DeviceAngle | null};
}
interface DeviceAngle {pitch: number; sideTilt: number}
function deviceAngle(angles: DeviceAngleArrays, row: number | null): DeviceAngle | null {
  if (row === null) return null;
  const pitch = angles.pitch[row], sideTilt = angles.sideTilt[row];
  return Number.isFinite(pitch) || Number.isFinite(sideTilt) ? {pitch, sideTilt} : null;
}
export interface GaitReportSegment {
  index: number;
  cls: number;
  durationMs: number;
  countable_intervals: Interval[];
  steps: GaitStep[];
}

const ms = (s: number) => Math.round(s * 1000);
const ordered = (a: Interval, b: Interval) => a.start_ms - b.start_ms || a.end_ms - b.end_ms;
function union(values: Interval[]) {
  const merged: Interval[] = [];
  for (const v of values.sort(ordered)) {
    const last = merged.at(-1);
    if (last && v.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, v.end_ms);
    else merged.push({...v});
  }
  return merged;
}

function intersect(left: Interval[], right: Interval[]) {
  const out: Interval[] = [];
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    const a = left[i], b = right[j];
    const start_ms = Math.max(a.start_ms, b.start_ms), end_ms = Math.min(a.end_ms, b.end_ms);
    if (end_ms > start_ms) out.push({start_ms, end_ms});
    if (a.end_ms <= b.end_ms) i++; else j++;
  }
  return out;
}

function firstAfter<T>(xs: T[], key: number, before: (x: T, key: number) => boolean) {
  let a = 0, b = xs.length;
  while (a < b) { const m = (a + b) >>> 1; if (before(xs[m], key)) a = m + 1; else b = m; }
  return a;
}

function prepare(s: GaitSideInput, side: Side, segments: ActivitySegment[]) {
  type Event = {side: Side; ic_ms: number; to_ms: number | null; icRow: number; toRow: number | null};
  const support: Interval[] = [], steps: Event[] = [];
  if (!s?.inp || !s.rec) return {support, steps, imu: null};
  const {inp, rec} = s, origin = s.t0 / 1e6, groups = groupsOf(inp);
  const bounds: {a: number; b: number}[] = [];
  let previousEnd = -Infinity;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]; if (g < 0) continue;
    const t = inp.tUs[i] / 1e6 - origin;
    if (!bounds[g]) {
      // Compare actual blocks without assuming group IDs start at zero.
      if (t <= previousEnd) return {support, steps, imu: null};
      bounds[g] = {a: t, b: t};
    } else bounds[g].b = t;
    previousEnd = t;
  }
  const cycles = new Map(rec.cycles?.map(c => [c.cycle, c]));
  const ics = new Map<number, Candidate>(), tos = new Map<number, Candidate>();
  for (const e of rec.events) {
    if (e.detection_path !== 'interior' || e.uncertain || !Number.isFinite(e.imu_packet_time_s) || !(groups[e.rowIdx] >= 0)) continue;
    if (e.event !== 'IC' && e.event !== 'TO') continue;
    const events = e.event === 'IC' ? ics : tos;
    if (!events.has(e.cycle)) events.set(e.cycle, e);
  }
  const orderedIcs = [...ics.values()].sort((a, b) => a.rowIdx - b.rowIdx);
  for (let i = 0; i < orderedIcs.length; i++) {
    const ic = orderedIcs[i], window = cycles.get(ic.cycle);
    if (window?.status !== 'candidate_pair') continue;
    const g = groups[ic.rowIdx], bound = bounds[g];
    const start = Math.max(window.swing_start_s - origin, bound.a), end = Math.min(window.swing_end_s - origin, bound.b);
    const start_ms = ms(start), end_ms = ms(end), ic_ms = ms(ic.imu_packet_time_s - origin);
    if (!(ic_ms >= start_ms && ic_ms < end_ms)) continue;
    const to = tos.get(ic.cycle), toMs = ms(to?.imu_packet_time_s - origin), next = orderedIcs[i + 1];
    const to_ms = to && groups[to.rowIdx] === g && to.rowIdx > ic.rowIdx && toMs > ic_ms && toMs < end_ms && (!next || to.rowIdx < next.rowIdx) ? toMs : null;
    support.push({start_ms, end_ms});
    steps.push({side, ic_ms, to_ms, icRow: ic.rowIdx, toRow: to_ms === null ? null : to.rowIdx});
  }
  return {support: union(support), steps, imu: gaitImu(s, groups, segments)};
}

export function gaitReport(segments: ActivitySegment[], sides: GaitSideInput[], onlyRuns = false): GaitReportSegment[] {
  const bySide = {left: sides.find(s => s.side === 'left'), right: sides.find(s => s.side === 'right')};
  const left = prepare(bySide.left, 'left', segments), right = prepare(bySide.right, 'right', segments);
  const imu = {left: left.imu, right: right.imu};
  const coverage = intersect(left.support, right.support);
  const events = [...left.steps, ...right.steps].sort((a, b) => a.ic_ms - b.ic_ms);
  return segments.map(({a, b, cls}, index) => {
    if (cls !== 1 && (onlyRuns || cls !== 0)) return null;
    const start_ms = ms(a), end_ms = ms(b);
    const countable_intervals: Interval[] = [], steps: GaitStep[] = [];
    for (let i = firstAfter(coverage, start_ms, (v, t) => v.end_ms <= t); i < coverage.length && coverage[i].start_ms < end_ms; i++) {
      const start = Math.max(start_ms, coverage[i].start_ms), end = Math.min(end_ms, coverage[i].end_ms);
      if (end <= start) continue;
      countable_intervals.push({start_ms: start, end_ms: end});
      for (let j = firstAfter(events, start, (e, t) => e.ic_ms < t); j < events.length && events[j].ic_ms < end; j++) {
        const {side, ic_ms, icRow, toRow, to_ms} = events[j], usableTo = to_ms !== null && to_ms < end_ms;
        const {ic_pitch_deg, to_pitch_deg, icIssue, toIssue, ...impact} = imu[side](icRow, toRow, b);
        const angles = bySide[side]?.deviceAngles;
        const deviceAngles = angles && {ic: deviceAngle(angles, icRow), to: deviceAngle(angles, usableTo ? toRow : null)};
        const icPitch = Number.isFinite(deviceAngles?.ic?.pitch) ? deviceAngles.ic.pitch : null;
        const toPitch = Number.isFinite(deviceAngles?.to?.pitch) ? deviceAngles.to.pitch : null;
        const toUnavailable = to_ms === null ? 'no_to' : usableTo ? null : 'to_outside';
        steps.push({side, ic_ms, step_index: steps.length + 1, to_ms: usableTo ? to_ms : null, ...impact,
          ic_pitch_deg: icPitch, to_pitch_deg: toPitch,
          icIssue: icPitch === null ? 'app_pitch_missing' : null,
          toIssue: toUnavailable ?? (toPitch === null ? 'app_pitch_missing' : null),
          footPitch: {ic_pitch_deg, to_pitch_deg: usableTo ? to_pitch_deg : null, icIssue, toIssue: toUnavailable ?? toIssue},
          ...(deviceAngles && {deviceAngles})});
      }
    }
    return {index, cls, durationMs: end_ms - start_ms, countable_intervals, steps};
  });
}

export function reportSummary(segments: GaitReportSegment[]) {
  let durationMs = 0, countableMs = 0, count = 0;
  const sample = () => ({sum: 0, n: 0});
  const foot = () => ({steps: 0, contact: sample(), ic: sample(), to: sample(), impact: sample(), delay: sample()});
  const feet = {left: foot(), right: foot()};
  const add = (s: ReturnType<typeof sample>, value: number | null) => { if (value !== null) { s.sum += value; s.n++; } };
  for (const s of segments) {
    if (!s) continue;
    durationMs += s.durationMs;
    for (const {start_ms, end_ms} of s.countable_intervals) countableMs += end_ms - start_ms;
    count += s.steps.length;
    for (const step of s.steps) {
      const f = feet[step.side]; f.steps++;
      add(f.contact, step.to_ms === null ? null : step.to_ms - step.ic_ms);
      add(f.ic, step.ic_pitch_deg); add(f.to, step.to_pitch_deg); add(f.impact, step.impact_peak_g);
      add(f.delay, step.impact_peak_ms === null ? null : step.impact_peak_ms - step.ic_ms);
    }
  }
  return {durationMs, countableMs, steps: countableMs ? count : NaN, cadence: countableMs ? 60000 * count / countableMs : NaN, feet};
}
export type ReportSummary = ReturnType<typeof reportSummary>;
export type FootMetric = Exclude<keyof ReportSummary['feet']['left'], 'steps'>;
export const metricMean = (s: ReportSummary, side: Side, key: FootMetric) => s.feet[side][key].sum / s.feet[side][key].n;
