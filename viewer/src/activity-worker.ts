import {activityEngine} from './activity-engine';
import {analyzeGaitWindow} from './gait-window';
import {analyzeMoticonTas} from './moticon-tas';
import {analyzeGaitExtraction} from './turn-rule';
import {ACTIVITY_STILL} from './core/constants';
import {ictoDetectRows} from './icto/core';
import {gaitIctoInput, gaitMetrics} from './gait/core';
import type {ActivitySegment, GaitSegment, GaitSideInput, GaitSource} from './gait/core';
import {refineRunning} from './gait/running-icto';
import {gaitReport} from './gait/walking';
import type {GaitReportSegment} from './gait/walking';

function buildSegments(r): ActivitySegment[] {
  const out: ActivitySegment[] = [];
  for (let i = 0; i < r.ticks;) {
    let end = i + 1; while (end < r.ticks && r.labels[end] === r.labels[i]) end++;
    const label = r.labels[i], cls = label < 0 ? 3 : label;
    let sum = 0, edge = false, reviewed = false, walkReview = 0, changed = false;
    const modeled = (label >= 0 && label < 3) || (label === ACTIVITY_STILL && r.probs.length > ACTIVITY_STILL * r.ticks);
    for (let k = i; k < end; k++) {
      if (modeled) sum += r.probs[label * r.ticks + k];
      edge ||= !!r.edge[k]; reviewed ||= !!r.reviewed?.[k]; walkReview |= r.walkReview?.[k] ?? 0;
      changed ||= !!r.baseLabels && r.baseLabels[k] !== label;
    }
    out.push({a: i / 10, b: end / 10, cls, confidence: !modeled || reviewed || changed ? null : sum / (end - i), edge, reviewed, walkReview}); i = end;
  }
  const end = r.ticks / 10;
  if (r.duration > end + 1e-6) {
    const last = out[out.length - 1];
    if (last?.cls === 3) last.b = r.duration;
    else out.push({a: end, b: r.duration, cls: 3, confidence: null});
  }
  return out;
}

const engine = activityEngine();
const dispatch = (contract, inputs, duration, progress) =>
  contract.kind === 'moticon-tas' ? analyzeMoticonTas(engine, inputs, duration, progress)
    : contract.kind === 'gait-window' ? analyzeGaitWindow(engine, contract.id, inputs, duration, progress, contract.reviewGait)
    : engine.analyze(contract, inputs, duration, progress);
self.onmessage = async ({data: {contract, inputs, duration, receiptTiming}}) => {
  try {
    const progress = (value: number) => self.postMessage({progress: value});
    let result;
    if (contract.kind === 'gait-extraction') {
      const base = await analyzeMoticonTas(engine, inputs, duration, p => progress(Math.round(p * .7)));
      result = await analyzeGaitExtraction(engine, inputs, duration, p => progress(Math.round(70 + p * .3)), contract.id, base);
    } else {
      result = await dispatch(contract, inputs, duration, progress);
    }
    const segments = buildSegments(result);
    self.postMessage({phase: 'gait'});
    let gait: GaitSegment[] = [], runningGait: GaitSegment[] | null = null;
    let report: GaitReportSegment[] = [], refinedRunReport: GaitReportSegment[] | null = null;
    const failed: string[] = [];
    let debugError = false, runningError = false, reportError = false;
    if (segments.some(s => s.cls < 2)) {
      const sides = (inputs as GaitSource[]).map((s, i) => {
        const side = i === 0 ? 'left' : 'right';
        try {
          const inp = gaitIctoInput(s);
          return {side, t0: 0, inp, accAtRail: s.accAtRail, deviceAngles: s.deviceAngles, rec: ictoDetectRows(inp, side, 'activity')};
        } catch { failed.push(side); return {side, t0: 0, inp: null, rec: null}; }
      });
      try { report = gaitReport(segments, sides, false, !receiptTiming); } catch { reportError = true; }
      const runs = segments.map((s, i) => s.cls === 1 ? i : -1).filter(i => i >= 0);
      const runSegments = runs.map(i => segments[i]);
      const diagnostics = (events: GaitSideInput[]) => {
        const list: GaitSegment[] = [], computed = gaitMetrics({segments: runSegments, sides: events});
        runs.forEach((i, j) => { list[i] = {...computed[j], index: i}; });
        return list;
      };
      if (runs.length) {
        try { gait = diagnostics(sides); } catch { debugError = true; }
        try {
          const refined = sides.map(s => refineRunning(s, runSegments));
          if (refined.some((s, i) => s !== sides[i])) {
            const newReport = gaitReport(segments, refined, true, !receiptTiming);
            try { runningGait = diagnostics(refined); } catch { debugError = true; }
            refinedRunReport = newReport;
          }
        } catch { runningError = true; }
      }
    }
    const transfer = [result.labels.buffer, result.probs.buffer, result.edge.buffer];
    if (result.reviewed) transfer.push(result.reviewed.buffer);
    self.postMessage({result, segments, gait, runningGait, report, refinedRunReport, failed, debugError, reportError, runningError}, {transfer});
  } catch (e) { self.postMessage({error: e?.message || String(e)}); }
};
