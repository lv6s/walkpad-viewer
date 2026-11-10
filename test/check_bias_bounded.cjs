'use strict';
const assert = require('node:assert/strict');
const { createBiasTracker } = require('../backend/reference/insole_bias.cjs');
let count = 0;
function test(name, fn) { fn(); console.log('PASS', name); count++; }
function run({ adaptive = true, duration = 20000, gyro = () => [-6.45, -4.52, -0.33], accel = () => [0, 0, 1], noise = [0.07, 0.17, 0.06], gap = false, duplicate = false } = {}) {
  const tr = createBiasTracker({ adaptive });
  let seed = 4513, first = null, last, reject;
  function rand() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 1) / 4294967297; }
  function normal() { return Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()); }
  for (let i = 0; i <= duration / 20; i++) {
    const t = i * 20, g = gyro(t).map((x, k) => Math.round((x + noise[k] * normal()) / 0.07) * 0.07), a = accel(t);
    last = tr.push({ seq: i, gx0: g[0], gy0: g[1], gz0: g[2], ax: a[0], ay: a[1], az: a[2], clk: { epoch: t + (gap && t >= 3000 ? 1000 : 0) } }, duplicate ? 0 : t);
    if (last.ready && first === null) first = t;
    if (last.last_reject) reject = last.last_reject;
  }
  return { tr, last, first, reject };
}
test('异方差静置：受限自适应初始化且均值准确', () => {
  const r = run(); assert.ok(r.first <= 20000 && r.first >= 10000, String(r.first));
  assert.ok(Math.hypot(...r.last.gyro_bias_dps.map((x, k) => x - [-6.45, -4.52, -0.33][k])) < 0.04);
  assert.ok(r.last.diagnostics.gyro_std_limit_dps.every(x => x <= 0.45));
  assert.ok(r.last.diagnostics.gyro_range_limit_dps.every(x => x <= 2.52));
});
test('旧版同噪声数据不通过', () => { assert.equal(run({ adaptive: false }).last.ready, false); });
test('严格静置窗仍保留 5 秒初始化', () => { assert.equal(run({ noise: [0, 0, 0] }).first, 5000); });
test('持续角速度斜坡拒绝初始化', () => { assert.equal(run({ gyro: t => [t / 5000, 0, 0] }).last.ready, false); });
test('平滑往返转动不能伪装成噪声', () => { assert.equal(run({ gyro: t => [Math.sin(t / 1600) * 0.5, 0, 0] }).last.ready, false); });
test('重力方向变化拒绝初始化', () => {
  assert.equal(run({ accel: t => [Math.sin(t / 10000), 0, Math.cos(t / 10000)] }).last.ready, false);
});
test('连续高噪声不得无限抬高门限', () => { assert.equal(run({ noise: [0.35, 0.35, 0.35] }).last.ready, false); });
test('加速度模长异常拒绝', () => { assert.equal(run({ accel: () => [0, 0, 1.2] }).last.ready, false); });
test('同 host 多帧不能伪造静止时长', () => { assert.equal(run({ duplicate: true }).last.ready, false); });
test('设备时钟间断重建候选窗', () => {
  const r = run({ gap: true }); assert.ok(r.first >= 8020, String(r.first));
});
test('运动阶段保留补偿，不更新', () => {
  const r = run({ noise: [0, 0, 0] }), before = r.last.gyro_bias_dps;
  for (let i = 1; i <= 500; i++) {
    const t = 20000 + 20 * i;
    r.tr.push({ seq: 1000 + i, gx0: 60 * Math.sin(i / 5), gy0: 0, gz0: 0, ax: 0, ay: 0, az: 1 }, t);
  }
  assert.deepEqual(r.tr.snapshot().gyro_bias_dps, before); assert.equal(r.tr.snapshot().ready, true);
});
test('reset 清除诊断与补偿', () => {
  const r = run(); r.tr.reset(); const s = r.tr.snapshot();
  assert.equal(s.ready, false); assert.equal(s.diagnostics, null); assert.equal(s.accepted_windows, 0);
});
test('恒速绕重力轴转动不可辨识，仍明确展示局限', () => {
  const r = run({ noise: [0, 0, 0], gyro: () => [0, 0, 5] }); assert.equal(r.last.ready, true);
  assert.ok(Math.abs(r.last.gyro_bias_dps[2] - 4.97) < 1e-9);
});
test('20/50/100 Hz 严格窗初始化一致', () => {
  for (const hz of [20, 50, 100]) {
    const tr = createBiasTracker({ adaptive: true });
    for (let i = 0; i <= hz * 5; i++) tr.push({seq:i, gx0:6, gy0:-4, gz0:9, ax:0, ay:0, az:1, clk:{epoch:i*1000/hz}}, i*1000/hz);
    assert.equal(tr.snapshot().ready, true);
  }
});
test('断流后 ready 与既有补偿保留，候选窗重建', () => {
  const r = run({ noise: [0, 0, 0] }), before = r.last.gyro_bias_dps;
  const s = r.tr.push({seq:1001, gx0:8, gy0:8, gz0:8, ax:0, ay:0, az:1, clk:{epoch:21000}},21000);
  assert.equal(s.ready,true); assert.deepEqual(s.gyro_bias_dps,before); assert.equal(s.candidate_frames,0);
  assert.equal(s.last_reject,'数据不连续');
});
test('跟踪仍按不重叠窗 tau=10s 更新', () => {
  const tr = createBiasTracker({adaptive:true});
  for (let i=0;i<=250;i++) tr.push({seq:i,gx0:0,gy0:0,gz0:0,ax:0,ay:0,az:1,clk:{epoch:i*20}},i*20);
  for (let i=251;i<=401;i++) tr.push({seq:i,gx0:0.1,gy0:0,gz0:0,ax:0,ay:0,az:1,clk:{epoch:i*20}},i*20);
  assert.ok(Math.abs(tr.snapshot().gyro_bias_dps[0] - 0.1*(1-Math.exp(-0.3))) < 1e-9);
});
console.log(`${count} bounded-noise tests passed`);
