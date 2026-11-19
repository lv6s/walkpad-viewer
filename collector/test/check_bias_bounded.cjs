'use strict';
/* 噪声与数值护栏：门限固定，不随候选窗自身噪声放大（否则运动会被当成静止）。
   σ̂ 只用于判定“确实噪声过大”，超过 0.3 °/s 一律拒绝学习。 */
const assert = require('node:assert/strict');
const { createBiasTracker } = require('../backend/reference/insole_bias.cjs');
let count = 0;
function test(name, fn) { fn(); console.log('PASS', name); count++; }
function run({ duration = 20000, gyro = () => [-6.45, -4.52, -0.33], accel = () => [0, 0, 1], noise = [0.07, 0.17, 0.06], gap = false, duplicate = false } = {}) {
  const tr = createBiasTracker({ recovery: true });
  let seed = 4513, first = null, last;
  function rand() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 1) / 4294967297; }
  function normal() { return Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()); }
  for (let i = 0; i <= duration / 20; i++) {
    const t = i * 20, g = gyro(t).map((x, k) => Math.round((x + noise[k] * normal()) / 0.07) * 0.07), a = accel(t);
    last = tr.push({ seq: i, gx0: g[0], gy0: g[1], gz0: g[2], ax: a[0], ay: a[1], az: a[2], clk: { epoch: t + (gap && t >= 3000 ? 1000 : 0) } }, duplicate ? 0 : t);
    if (last.ready && first === null) first = t;
  }
  return { tr, last, first };
}
test('异方差静置仍能初始化且均值准确', () => {
  const r = run();
  assert.ok(r.first >= 5000 && r.first <= 7000, String(r.first));
  assert.ok(Math.hypot(...r.last.gyro_bias_dps.map((x, k) => x - [-6.45, -4.52, -0.33][k])) < 0.04);
});
test('噪声 σ̂ > 0.3 一律拒绝学习，不放大门限', () => {
  assert.equal(run({ noise: [0.35, 0.35, 0.35] }).last.ready, false);
});
test('加速度模长异常拒绝', () => {
  assert.equal(run({ accel: () => [0, 0, 1.2] }).last.ready, false);
});
test('同 host 多帧不能伪造静止时长', () => {
  assert.equal(run({ duplicate: true }).last.ready, false);
});
test('设备时钟间断重建候选，初始化推迟到间断之后', () => {
  const r = run({ gap: true });
  assert.ok(r.first >= 8000, String(r.first));
});
test('运动阶段保留补偿且就绪状态不变', () => {
  const r = run({ noise: [0, 0, 0] }), before = r.last.gyro_bias_dps;
  for (let i = 1; i <= 500; i++) {
    r.tr.push({ seq: 1000 + i, gx0: 60 * Math.sin(i / 5), gy0: 0, gz0: 0, ax: 0, ay: 0, az: 1 }, 20000 + 20 * i);
  }
  assert.deepEqual(r.tr.snapshot().gyro_bias_dps, before);
  assert.equal(r.tr.snapshot().ready, true);
});
test('单帧 raw 陀螺 40 °/s 数值护栏：清候选但不改补偿', () => {
  const r = run({ noise: [0, 0, 0] });
  const before = r.tr.snapshot().gyro_bias_dps;
  const s = r.tr.push({ seq: 1001, gx0: 40.01, gy0: 0, gz0: 0, ax: 0, ay: 0, az: 1, clk: { epoch: 20020 } }, 20020);
  assert.equal(s.ready, true);
  assert.deepEqual(s.gyro_bias_dps, before);
  assert.equal(s.candidate_frames, 0);
  assert.match(s.status, /数值保护/);
});
test('reset 清除补偿与诊断', () => {
  const r = run(); r.tr.reset(); const s = r.tr.snapshot();
  assert.equal(s.ready, false); assert.deepEqual(s.gyro_bias_dps, [0, 0, 0]);
  assert.equal(s.diagnostics, null); assert.equal(s.accepted_windows, 0);
});
test('恒速绕重力轴转动不可辨识，仍明确展示局限', () => {
  const r = run({ noise: [0, 0, 0], gyro: () => [0, 0, 5] });
  assert.equal(r.last.ready, true);
  assert.ok(Math.abs(r.last.gyro_bias_dps[2] - 5) < 0.15, String(r.last.gyro_bias_dps));
});
console.log(`${count} guard tests passed`);
