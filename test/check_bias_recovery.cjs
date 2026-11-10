'use strict';
const assert = require('node:assert/strict');
const { createBiasTracker } = require('../backend/reference/insole_bias.cjs');
const { createBiasRecovery } = require('../backend/bias_recovery.cjs');
let count = 0;
function test(name, fn) { fn(); console.log('PASS', name); count++; }
function rig(hz = 50, recovery = true) {
  const tr = createBiasTracker({ adaptive: true, recovery });
  let i = -1, time = -1000 / hz, state;
  function feed(seconds, gyro = [0, 0, 0], accel = [0, 0, 1]) {
    for (let j = 0; j < Math.round(seconds * hz); j++) {
      i++; time += 1000 / hz;
      const g = typeof gyro === 'function' ? gyro(time) : gyro;
      state = tr.push({ seq: i, gx0: g[0], gy0: g[1], gz0: g[2], ax: accel[0], ay: accel[1], az: accel[2], clk: { epoch: time } }, time);
    }
    return state;
  }
  return { tr, feed, get time() { return time; }, get seq() { return i; } };
}
function initialized() { const r = rig(); assert.ok(r.feed(6).ready); return r; }
const args = (end, gyro = [0.6, 0, 0], accel = [0, 0, 1]) => ({ bias: [0, 0, 0], gyro, accel, start: end - 3000, end });
test('严格初始化仍5秒且标记新版', () => {
  const r = rig(); assert.equal(r.feed(5).ready, false); const s = r.feed(.02);
  assert.equal(s.ready, true); assert.equal(s.gate_version, 'confirmed-rest-v2');
});
test('稳定小创新保持旧10秒慢更新', () => {
  const r = initialized(), old = rig(50, false); old.feed(6);
  const a = r.feed(30, [.03, 0, 0]), b = old.feed(30, [.03, 0, 0]);
  assert.deepEqual(a.gyro_bias_dps, b.gyro_bias_dps); assert.equal(a.recovery.phase, 'slow_tracking');
});
test('运动时保留零偏', () => {
  const r = initialized(), before = r.tr.snapshot().gyro_bias_dps;
  const s = r.feed(10, t => [60 * Math.sin(t / 100), 0, 0]);
  assert.deepEqual(s.gyro_bias_dps, before); assert.equal(s.ready, true);
});
test('运动后不足双窗不更新', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]);
  assert.deepEqual(r.feed(5.8, [.6, 0, 0]).gyro_bias_dps, [0, 0, 0]);
});
test('稳定台阶双窗确认后加快恢复', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]); const s = r.feed(13, [.6, 0, 0]);
  assert.ok(Math.abs(s.gyro_bias_dps[0] - .6) < .04, String(s.gyro_bias_dps));
  assert.ok(s.recovery.confirmed_changes >= 1);
});
test('重定位收敛后回到慢跟踪', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]); const s = r.feed(25, [.6, 0, 0]);
  assert.equal(s.recovery.phase, 'slow_tracking');
});
test('超过自动创新上限保留补偿', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]); const s = r.feed(25, [2, 0, 0]);
  assert.deepEqual(s.gyro_bias_dps, [0, 0, 0]); assert.equal(s.recovery.phase, 'change_too_large');
});
test('双窗不一致不快速更新', () => {
  const r = createBiasRecovery(); assert.ok(r.assess(args(3000)).hold);
  assert.ok(r.assess(args(6020, [.4, 0, 0])).hold); assert.equal(r.snapshot().confirmed_changes, 0);
});
test('跨窗重力方向变化拒绝确认', () => {
  const r = createBiasRecovery(); r.assess(args(3000));
  assert.ok(r.assess(args(6020, [.6, 0, 0], [.03, 0, .99955])).hold);
});
test('重叠窗口不能充当独立确认', () => {
  const r = createBiasRecovery(); r.assess(args(3000)); assert.ok(r.assess(args(4000)).hold);
  assert.equal(r.snapshot().confirmed_changes, 0);
});
test('中间无效数据清除确认', () => {
  const r = createBiasRecovery(); r.assess(args(3000)); r.invalidate(); assert.ok(r.assess(args(6020)).hold);
});
test('重定位期间再次运动立即停止', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]); r.feed(6.2, [.6, 0, 0]);
  const before = r.tr.snapshot().gyro_bias_dps; const s = r.feed(5, [60, 0, 0]);
  assert.deepEqual(s.gyro_bias_dps, before); assert.equal(s.recovery.pending, false);
});
test('断流保留已有补偿并废弃候选', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]); r.feed(3.2, [.6, 0, 0]);
  const before = r.tr.snapshot().gyro_bias_dps;
  const s = r.tr.push({ seq: r.seq + 1, gx0: .6, gy0: 0, gz0: 0, ax: 0, ay: 0, az: 1, clk: { epoch: r.time + 1000 } }, r.time + 1000);
  assert.deepEqual(s.gyro_bias_dps, before); assert.equal(s.recovery.pending, false); assert.equal(s.ready, true);
});
test('手动模式冻结且切回丢弃候选', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]); r.feed(3.2, [.6, 0, 0]);
  r.tr.setMode('manual'); const before = r.tr.snapshot().gyro_bias_dps;
  assert.deepEqual(r.feed(12, [.6, 0, 0]).gyro_bias_dps, before);
  r.tr.setMode('dynamic'); assert.equal(r.tr.snapshot().recovery.pending, false);
});
test('reset清除恢复诊断', () => {
  const r = initialized(); r.tr.reset(); const s = r.tr.snapshot();
  assert.equal(s.ready, false); assert.equal(s.recovery.confirmed_changes, 0); assert.equal(s.recovery.phase, 'initializing');
});
test('20/50/100Hz按时间而非帧数确认', () => {
  for (const hz of [20, 50, 100]) {
    const r = rig(hz); r.feed(6); r.feed(1, [60, 0, 0]);
    assert.deepEqual(r.feed(5.8, [.6, 0, 0]).gyro_bias_dps, [0, 0, 0]);
    assert.ok(Math.abs(r.feed(8, [.6, 0, 0]).gyro_bias_dps[0] - .6) < .04);
  }
});
test('运动后平滑慢转变化不允许确认', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]);
  assert.deepEqual(r.feed(20, t => [.5 * Math.sin(t / 1600), 0, 0]).gyro_bias_dps, [0, 0, 0]);
});
test('明确保留小恒速匀转不可辨识限制', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]); const s = r.feed(25, [0, 0, .5]);
  assert.ok(s.gyro_bias_dps[2] > .4);
});
test('确认后增益仅计当前窗而非累计等待时长', () => {
  const r = initialized(); r.feed(1, [60, 0, 0]); const s = r.feed(6.1, [.6, 0, 0]);
  const expected = .6 * (1 - Math.exp(-3 / 2.5));
  assert.ok(Math.abs(s.gyro_bias_dps[0] - expected) < 1e-9, String(s.gyro_bias_dps));
});
test('快速阶段偏离已确认中心时重新确认', () => {
  const r = createBiasRecovery(); r.assess(args(3000));
  assert.equal(r.assess(args(6020)).tau, 2.5);
  assert.ok(r.assess(args(9040, [.4, 0, 0])).hold);
});
test('创新硬上限不能因高噪声自适应而扩大', () => {
  const r = createBiasRecovery();
  for (const end of [3000, 6020, 9040]) assert.ok(r.assess(args(end, [.81, 0, 0])).hold);
  assert.equal(r.snapshot().confirmed_changes, 0);
});
test('动态复核不会改动手动校准结果', () => {
  const r = initialized(); r.tr.setMode('manual'); r.tr.startCalibration();
  const s = r.feed(4, [2, 0, 0]);
  assert.equal(s.ready, true); assert.ok(Math.abs(s.gyro_bias_dps[0] - 2) < 1e-9);
  assert.deepEqual(r.feed(4, [4, 0, 0]).gyro_bias_dps, s.gyro_bias_dps);
});
console.log(`${count} confirmed-rest tests passed`);
