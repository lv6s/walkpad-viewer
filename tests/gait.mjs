/* 步态指标的两道闸门：
   1. 合成周期：IC/TO 时间与摆动 / 支撑窗是手写的，指标必须精确复现这些数。
   2. 真实数据：WT 走路记录跑一遍 icto + 指标，步频与步数落在物理范围，且与录制命名（64 步 / 29 步）对得上。
   用法：node tests/gait.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ictoDetectRows} from '../src/icto/core.ts';
import {gaitIctoInput, gaitMetrics, gaitSummary, groupsOf} from '../src/gait/core.ts';
import {carryUp, gaitImu} from '../src/gait/walking-imu.ts';
import {activityEngine} from '../src/activity-engine.ts';
import {spreadNotified} from '../src/data/notification-time.ts';
import {runningPair, refineRunning} from '../src/gait/running-icto.ts';
import {gaitReport, metricMean, reportSummary} from '../src/gait/walking.ts';

// ---------------------------------------------------------------- 1. 合成
const FS = 50, DUR = 20, T0 = 0;
const n = DUR * FS + 1, tUs = new Float64Array(n), ax = new Float64Array(n * 6);
const IC = [], TO = [];
for (let k = 0, t = 1; t < DUR - 1; k++, t += 0.9) { IC.push(t); TO.push(t + 0.55); }
const icSet = IC.map(v => Math.round(v * FS)), toSet = TO.map(v => Math.round(v * FS));
for (let i = 0; i < n; i++) { tUs[i] = (T0 + i / FS) * 1e6; ax[i * 6] = 1; }
for (let i = 0; i < n; i++) {
  const stance = icSet.some((v, k) => i >= v && i <= toSet[k]);
  const swing = toSet.some((v, k) => icSet[k + 1] != null && i > v && i < icSet[k + 1]);
  ax[i * 6] = stance ? 2 : 1;                       // 支撑期 2 g，其余 1 g
  ax[i * 6 + 5] = swing ? 180 : 0;                  // 摆动期角速度 180 °/s（轴 z、正方向）
}
const mkSide = (side, cycles) => {
  const events = [];
  IC.forEach((t, k) => {
    if (cycles && cycles[k] == null) return;
    const c = cycles ? cycles[k] : k + 1;
    events.push({event: 'IC', cycle: c, detection_path: 'interior', imu_packet_time_s: t, rowIdx: icSet[k]});
    events.push({event: 'TO', cycle: c, detection_path: 'interior', imu_packet_time_s: TO[k], rowIdx: toSet[k]});
  });
  return {side, t0: T0 * 1e6, inp: {n, tUs: tUs.slice(), ok: new Uint8Array(n).fill(1), ax, seq: Float64Array.from({length: n}, (_, i) => i)},
    rec: {events, cycles: [], diagnostics: {gyro_axis: 'z', sign: 1}}};
};
const sides = [mkSide('left'), mkSide('right')];
const seg = (a, b, cls = 0, edge = false) => ({a, b, cls, edge});

const all = gaitMetrics({segments: [seg(.5, 19.5)], sides});
const cell = all[0].cells[0];
assert.ok(Math.abs(cell.cadence - 120 / .9) < .01, `cadence ${cell.cadence}`);
assert.ok(Math.abs(cell.strideMed - .9) < 1e-9 && Math.abs(cell.stanceMed - .55) < 1e-9, `stride ${cell.strideMed} stance ${cell.stanceMed}`);
assert.ok(Math.abs(cell.swingMed - .35) < 1e-9 && Math.abs(cell.duty - .55 / .9) < 1e-9, `swing ${cell.swingMed} duty ${cell.duty}`);
assert.ok(Math.abs(cell.pitchMed - 180) < 1e-9 && Math.abs(cell.accMed - 2) < 1e-9, `peaks ${cell.pitchMed} ${cell.accMed}`);
assert.equal(cell.strides, IC.length - 1);
assert.equal(all[0].cadenceDiff, 0); assert.ok(Math.abs(all[0].stanceSi) < 1e-9);
const sum = gaitSummary(all); assert.equal(sum[0].steps, cell.steps * 2);
console.log('PASS 合成周期：步频 / 支撑 / 摆动 / 占空比 / 峰值 / 对称 全部精确复现');

// 边界：窗口端点卡在周期中间时，那个跨界周期必须整段丢掉，不能两段各算一次
const cut = gaitMetrics({segments: [seg(1.0, 2.8)], sides, guard: .2, minCycles: 1, minSeg: 0});
assert.equal(cut[0].cells[0].strides, 0, '跨界周期应被 guard 排除');
const noGuard = gaitMetrics({segments: [seg(1.0, 2.8)], sides, guard: 0, minCycles: 1, minSeg: 0});
assert.equal(noGuard[0].cells[0].strides, 1, '右端属于下一段，不能纳入周期');
console.log('PASS guard：跨界周期不重复计数');

// 漏检周期：中间少一个 IC 时，跨过它的那一步不能用（差出两倍周期）
const hole = [mkSide('left', [1, 2, null, 4]), mkSide('right', [1, 2, null, 4])];
const h = gaitMetrics({segments: [seg(0, 20)], sides: hole, minCycles: 1, minSeg: 0});
assert.equal(h[0].cells[0].strides, 1, `跳号后应只剩 1 步，实际 ${h[0].cells[0].strides}`);
console.log('PASS 跳号：周期号不连续的一步被拒绝');

const cutPeriod = () => mkSide('left', [1, 2]);
const check = s => gaitMetrics({segments: [seg(0, 20)], sides: [s], minCycles: 1})[0].cells[0];
for (const cut of [s => { s.inp.ok[60] = 0; }, s => { s.inp.seq[60] += 3; },
  s => { s.inp.tUs[60] += 100000; }, s => { s.inp.tUs[60] = s.inp.tUs[59]; }]) {
  const s = cutPeriod(); cut(s); assert.equal(check(s).strides, 0);
}
const short = cutPeriod();
assert.ok(Number.isNaN(gaitMetrics({segments: [seg(0, 20)], sides: [short]})[0].cells[0].cadence));
short.rec.events = short.rec.events.filter(e => e.event !== 'TO');
const icOnly = check(short);
assert.equal(icOnly.strides, 1); assert.equal(icOnly.stances, 0); assert.ok(Number.isNaN(icOnly.stanceMed));
const fallback = gaitMetrics({segments: [seg(0, 20, 1)], sides: [sides[0], {side: 'right', t0: 0, inp: null, rec: null}]})[0];
assert.ok(fallback.cadence > 0); assert.ok(fallback.flags.includes('步频仅由单侧估算')); assert.ok(Number.isNaN(fallback.stanceSi));
const clock = gaitIctoInput({t: Float64Array.of(0, .02, .12, .14), seq: Float64Array.of(0, 1, 2, 3), ok: Uint8Array.of(1, 1, 1, 1),
  axes: Array.from({length: 6}, (_, i) => Float32Array.of(0, 0, 0, i ? 0 : NaN))});
assert.deepEqual([...clock.seq], [0, 1, 3, 4]); assert.deepEqual([...clock.ok], [1, 1, 1, 0]);
console.log('PASS 缺口、无效值、单侧、少周期和缺 TO 的降级规则');

// 段过短 / 非步行跑步段不出指标
assert.deepEqual(gaitMetrics({segments: [seg(1, 2)], sides})[0].flags, ['段过短']);
assert.equal(gaitMetrics({segments: [seg(1, 15, 2)], sides})[0].flags[0], '非步行 / 跑步段，不计入');
console.log('PASS 短段与非步行 / 跑步段');

const runPitch = [250, 120, 30, -140, -80, -5, 0, 0, -15, -20, -35, -135, -220, -105, -40, -30, -80, -280, -115, 0, 190, 300, 350, 400];
const samplePair = () => runPitch.map((pitch, i) => ({t: i * .032, pitch, gyro: Math.hypot(pitch, i === 7 ? 3 : 35), acc: i === 3 ? 8 : 1}));
const good = runningPair(samplePair(), 3, 17);
assert.equal(good.ic, 3); assert.equal(good.to, 12);
const weak = samplePair(); weak[12].pitch = -130;
assert.equal(runningPair(weak, 3, 17).to, 17);
const ambiguous = samplePair(); ambiguous[11].pitch = -219; ambiguous[13].pitch = -218; ambiguous[14].pitch = -215; ambiguous[15].pitch = -215;
assert.equal(runningPair(ambiguous, 3, 17).to, -1);
const earlyPitch = [250, 120, -120, -35, -30, -25, 0, 30, 45, -140, -15, -90, -220, -105, -40, -30, -80, -280, -115, 0, 190, 300, 350, 400];
const earlySamples = peak => earlyPitch.map((pitch, i) => ({t: i * .032, pitch, gyro: Math.hypot(pitch, i === 6 ? 3 : 35), acc: i === peak ? 8 : 1}));
const supportedIC = runningPair(earlySamples(2), 9, 17), conflictIC = runningPair(earlySamples(5), 9, 17);
assert.equal(supportedIC.ic, 2); assert.equal(supportedIC.uncertain, false);
assert.equal(conflictIC.ic, 9); assert.equal(conflictIC.uncertain, true);
assert.strictEqual(refineRunning(sides[0], [seg(0, 20)]), sides[0]);
const doubtful = mkSide('right', [1, 2, 3]);
doubtful.rec.events.find(e => e.cycle === 2 && e.event === 'IC').uncertain = true;
const held = check(doubtful);
assert.equal(held.strides, 2); assert.equal(held.stances, 0);
assert.equal(held.periods[0].nextIcUncertain, true); assert.equal(held.periods[1].icUncertain, true);
assert.ok(Number.isNaN(held.stanceMed));
console.log('PASS 跑步 TO 多谷改选与拒报，IC 存疑时相邻周期不报支撑和摆动');

const walkingFoot = (side, items) => ({...mkSide(side), rec: {cycles: items.map(([cycle, a, b, ic, to, status]) =>
  ({cycle, swing_start_s: a, swing_end_s: b, status: status || 'candidate_pair'})), events: items.flatMap(([cycle, a, b, ic, to]) =>
  [['IC', ic], ['TO', to]].filter(([, time]) => time != null).map(([event, time]) =>
    ({cycle, event, imu_packet_time_s: time, rowIdx: Math.round(time * FS), detection_path: 'interior'})))}});
const labFeet = [
  walkingFoot('left', [[1, 1, 2.2, 1.02, 1.64], [2, 3, 4, 3.2, null], [3, 4, 5, 4.2, 4.8, 'missing_zero_crossing']]),
  walkingFoot('right', [[1, 1, 2.2, 1.56, 2.19], [2, 3.1, 4, 3.4, 3.99], [3, 4, 5, 4.4, 4.9]])
];
const example = gaitReport([seg(1, 2.2), seg(2.2, 3, 1), seg(3, 3.99), seg(4, 5)], labFeet);
assert.deepEqual(example[0].countable_intervals, [{start_ms: 1000, end_ms: 2200}]);
assert.deepEqual(example[0].steps.map(e => [e.step_index, e.side, e.ic_ms, e.to_ms]), [[1, 'left', 1020, 1640], [2, 'right', 1560, 2190]]);
const lab = reportSummary([example[0]]);
assert.deepEqual([lab.durationMs, lab.countableMs, lab.steps, lab.cadence], [1200, 1200, 2, 100]);
assert.equal(metricMean(lab, 'left', 'contact'), 620); assert.equal(metricMean(lab, 'right', 'contact'), 630);
assert.equal(metricMean(lab, 'right', 'impact'), 1); assert.ok(Number.isNaN(metricMean(lab, 'left', 'impact')));
assert.deepEqual(reportSummary(gaitReport([seg(1, 2.2, 1)], labFeet)), lab);
assert.equal(gaitReport([seg(1, 2.2, 2)], labFeet)[0], null);
assert.equal(gaitReport([seg(1, 2.2)], labFeet, true)[0], null);
assert.equal(example[1].cls, 1); assert.equal(example[1].steps.length, 0);
assert.deepEqual(example[2].countable_intervals, [{start_ms: 3100, end_ms: 3990}]);
assert.deepEqual(example[2].steps.map(e => [e.step_index, e.ic_ms, e.to_ms]), [[1, 3200, null], [2, 3400, null]]);
assert.deepEqual(example[3].countable_intervals, []);
const paired = reportSummary(example);
assert.equal(paired.countableMs, 2090); assert.equal(paired.steps, 4); assert.equal(paired.cadence, 60000 * 4 / 2090);
assert.equal(metricMean(paired, 'right', 'contact') - metricMean(paired, 'left', 'contact'), 10);
assert.equal(paired.durationMs, 3990);
assert.equal(example[2].steps[0].toIssue, 'no_to'); assert.equal(example[2].steps[1].toIssue, 'to_outside');
assert.ok(Number.isNaN(reportSummary([example[3]]).cadence));
assert.ok(Number.isNaN(reportSummary(gaitReport([seg(1, 2.2)], [labFeet[0]])).steps));
const center = gaitReport([seg(1, 1.56), seg(1.56, 2.2)], labFeet);
assert.deepEqual(center.map(s => s.steps.map(e => e.ic_ms)), [[1020], [1560]]);
const gapFeet = [walkingFoot('left', [[1, 1, 2.2, 1.02, 1.64]]), walkingFoot('right', [[1, 1, 2.2, 1.56, 2.19]])];
gapFeet[0].inp.ok[75] = 0;
const gapWalk = gaitReport([seg(1, 2.2)], gapFeet)[0];
assert.deepEqual(gapWalk.countable_intervals, [{start_ms: 1000, end_ms: 1480}]);
assert.deepEqual(gapWalk.steps.map(e => [e.ic_ms, e.to_ms]), [[1020, null]]);
assert.ok(Number.isNaN(metricMean(reportSummary([gapWalk]), 'left', 'contact')));
console.log('PASS shared walking/running metrics: 2 steps / 1.2 s = 100 spm, 620/630 ms, coverage, missing TO, gaps and half-open boundaries');

const eps = (a, b, d) => assert.ok(Number.isFinite(a) && Math.abs(a - b) < d, `${a} vs ${b}`);
const rotateY = (v, deg) => {
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return [c*v[0] + s*v[2], v[1], -s*v[0] + c*v[2]];
};
eps(carryUp([0, 0, 1], [0, -100, 0], .2)[0], Math.sin(Math.PI / 9), 1e-12);
const pitchAt = p => p >= .2 && p < .8 ? 20 * Math.sin(2 * Math.PI * (p - .2) / .6) : 0;
function incline(mount) {
  const n = 801, tUs = Float64Array.from({length: n}, (_, i) => i * 10000), ax = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    const t = i / 100, p = (i % 100) / 100, pitch = pitchAt(p), gyro = (pitchAt((t + .00001) % 1) - pitchAt((t - .00001 + 1) % 1)) / .00002;
    const forward = p >= .2 && p < .8 ? .85 * Math.sin(2 * Math.PI * (p - .2) / .6) : 0;
    const up = i % 100 === 39 ? 3.2 : 1;
    ax.set(rotateY([forward, 0, up], pitch + mount), i * 6);
    ax.set([0, -gyro + 7, 0], i * 6 + 3);
  }
  return {side: 'left', t0: 0, inp: {n, tUs, ax, ok: new Uint8Array(n).fill(1), seq: tUs.map((_, i) => i)}};
}
const checkImu = (s, ic = 235, to = 270, end = 8, cls = 0) => gaitImu(s, groupsOf(s.inp), [seg(0, 8, cls)])(ic, to, end);
for (const mount of [0, 37, -46]) {
  const s = incline(mount), clean = checkImu(s);
  eps(clean.ic_pitch_deg, 20, 1); eps(clean.to_pitch_deg, pitchAt(.7), 1);
  eps(clean.impact_peak_g, 2.2, .02); assert.equal(clean.impact_peak_ms, 2390);
  assert.deepEqual(checkImu(s, 235, 270, 8, 1), clean);
  assert.equal(checkImu(s, 235, null).to_pitch_deg, null);
  assert.equal(checkImu(s, 235, null).toIssue, 'no_to');
  assert.equal(checkImu(s, 235, null).impact_peak_ms, 2390);
  assert.equal(checkImu(s, 235, 270, 2.4).impactIssue, 'window_short');
  assert.equal(checkImu(s, 235, 241).impact_peak_ms, null);
  s.accAtRail = new Uint8Array(s.inp.n); s.accAtRail[239] = 1;
  assert.equal(checkImu(s).impactIssue, 'rail');
  s.accAtRail[239] = 0; s.inp.ok[240] = 0;
  assert.equal(checkImu(s).impact_peak_ms, null);
}
const noAnchor = incline(37);
for (let i = 0; i < noAnchor.inp.n; i++) for (let j = 0; j < 3; j++) noAnchor.inp.ax[i*6+j] *= 2;
assert.deepEqual(checkImu(noAnchor), {ic_pitch_deg: null, to_pitch_deg: null, impact_peak_g: null, impact_peak_ms: null,
  icIssue: 'no_anchor', toIssue: 'no_anchor', impactIssue: 'no_anchor'});
const noAxis = gaitImu(incline(37), groupsOf(incline(37).inp), [])(235, 270, 8);
assert.equal(noAxis.icIssue, 'no_axis'); assert.equal(noAxis.toIssue, 'no_axis'); eps(noAxis.impact_peak_g, 2.2, .02);
console.log('PASS native-rate pitch and impact: sensor tilt, gyro bias, peak time, gaps, raw clipping, missing anchors and truncated windows');

// ---------------------------------------------------------------- 2. 真实数据
const fixture = new URL('./.activity-fixtures/wt_dev_walk_frames.json', import.meta.url);
if (!fs.existsSync(fixture)) { console.log('SKIP local WT recordings not available'); process.exit(0); }
const fx = JSON.parse(fs.readFileSync(fixture));
const engine = activityEngine();
const contract = JSON.parse(fs.readFileSync(new URL('../src/b1q-model.json', import.meta.url)));
for (const [file, data] of Object.entries(fx)) {
  const feet = [data.left, data.right], times = feet.map(s => spreadNotified(s.us));
  const origin = Math.min(...times.map(t => t[0]));
  const inputs = feet.map((rows, i) => ({t: times[i].map(t => (t - origin) / 1e6),
    seq: Float64Array.from(rows.us, (_, k) => k), ok: Uint8Array.from(rows.ok),
    axes: Array.from({length: 6}, (_, j) => Float32Array.from(rows.axes, a => a[j]))}));
  const sides = inputs.map((s, i) => {
    const side = i ? 'right' : 'left', inp = gaitIctoInput(s);
    return {side, t0: 0, inp, rec: ictoDetectRows(inp, side, file)};
  });
  const dur = Math.max(...inputs.map(x => x.t.at(-1)));
  const r = await engine.analyze(contract, inputs, dur);
  const segments = [];
  for (let i = 0; i < r.ticks;) {
    let end = i + 1; while (end < r.ticks && r.labels[i] === r.labels[end]) end++;
    segments.push(seg(i / 10, end / 10, r.labels[i] < 0 ? 3 : r.labels[i])); i = end;
  }
  const list = gaitMetrics({segments, sides});
  const walking = list.filter(s => s.cls === 0 && Number.isFinite(s.cadence));
  assert.ok(walking.length, `${file}: no walking segment with usable cadence`);
  for (const s of walking) {
    assert.ok(s.cadence > 60 && s.cadence < 220, `${file}: ${s.cadence} spm`);
    for (const c of s.cells) for (const p of c.periods) {
      assert.ok(p.a >= s.a + .2 && p.b < s.b - .2);
      if (Number.isFinite(p.to)) assert.ok(p.a < p.to && p.to < p.b && Math.abs((p.to - p.a) + (p.b - p.to) - p.dt) < 1e-8);
    }
  }
  const report = gaitReport(segments, sides).filter(s => s?.cls === 0);
  const summary = reportSummary(report);
  assert.ok(summary.countableMs > 0 && summary.countableMs <= summary.durationMs, file);
  assert.ok(summary.steps > 0 && summary.cadence > 60 && summary.cadence < 220, file);
  for (const piece of report.filter(Boolean)) {
    for (const step of piece.steps) assert.ok(piece.countable_intervals.some(w => w.start_ms <= step.ic_ms && step.ic_ms < w.end_ms), file);
  }
  const steps = report.filter(Boolean).flatMap(s => s.steps);
  for (const s of steps) {
    assert.equal(s.impact_peak_g === null, s.impact_peak_ms === null);
    if (s.impact_peak_ms !== null) assert.ok(s.impact_peak_ms >= s.ic_ms && s.impact_peak_ms - s.ic_ms <= 100);
    if (s.to_ms === null) assert.equal(s.to_pitch_deg, null);
  }
  console.log(`${file} · ${summary.steps} 步 / ${(summary.countableMs / 1000).toFixed(2)} s · ${summary.cadence.toFixed(1)} 步/分 · 有触地角 ${steps.filter(s => s.ic_pitch_deg !== null).length} / 离地角 ${steps.filter(s => s.to_pitch_deg !== null).length} / 垂向峰 ${summary.feet.left.impact.n + summary.feet.right.impact.n}`);
}
console.log('PASS 真实 WT 通知批次时间重建、B1Q 分段、IMU 周期统计');
