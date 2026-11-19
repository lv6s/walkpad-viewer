'use strict';
/* 自动零偏（穿戴版）验收：短窗判“在不在动”，长跨度判“稳不稳”。
   合同：合格时长 5 s（跨度 ≤10 s、占比 ≥50%）初始化；就绪后连续静止 1.5 s 才更新，
   tau=10 s、限速 0.5 °/s/s；观测与当前偏置差 >0.8 °/s 时不直接学，
   需要 ≥6 s 连续静止且首尾一致才快速重定位；>8 °/s 一律保留补偿。
   恒速转动与零偏在六轴上不可区分，本文件明确展示这一物理局限。 */
const assert = require('node:assert/strict');
const { createBiasRecovery } = require('../backend/bias_recovery.cjs');
const { createBiasTracker } = require('../backend/reference/insole_bias.cjs');
let count = 0;
function test(name, fn) { fn(); console.log('PASS', name); count++; }
function rig(hz = 50, recovery = true) {
  const tr = createBiasTracker({ recovery });
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
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const norm = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));

test('静止 5 秒合格才初始化，4.5 秒不足', () => {
  const r = rig();
  assert.equal(r.feed(4.5).ready, false);
  assert.equal(r.feed(1.0).ready, true);
  assert.equal(r.tr.snapshot().gate_version, 'confirmed-rest-v4');
});

test('初始化均值按时间加权，与真实偏置一致', () => {
  const r = rig(), s = r.feed(6, [6.02, -4.06, 9.03]);
  assert.ok(s.ready); near(s.gyro_bias_dps[0], 6.02); near(s.gyro_bias_dps[2], 9.03);
});

test('中途 0.4 秒抖动只推迟、不污染初始化', () => {
  const r = rig();
  for (let k = 0; k < 6; k++) {
    r.feed(1.2, [0.1, 0, 0]);
    r.feed(0.4, [1.2, 0, 0]);
  }
  const s = r.feed(3, [0.1, 0, 0]);
  assert.ok(s.ready, s.status);
  assert.ok(Math.abs(s.gyro_bias_dps[0] - 0.1) < 0.06, String(s.gyro_bias_dps));
});

test('斜坡不能靠“合格时长”拼成初始化', () => {
  const ramp = rig(); ramp.feed(20, t => [t / 5000, 0, 0]);
  assert.equal(ramp.tr.snapshot().ready, false);
});

test('0.5 °/s 慢摆会进入初始化，但误差有界（5 秒窗能分辨的极限）', () => {
  const sway = rig(); const s = sway.feed(20, t => [0.5 * Math.sin(t / 1600), 0, 0]);
  assert.ok(s.ready);
  assert.ok(Math.abs(s.gyro_bias_dps[0]) < 0.6, String(s.gyro_bias_dps));
});

test('步行级运动永不初始化', () => {
  const r = rig();
  assert.equal(r.feed(20, t => [60 * Math.sin(t / 500), 0, 0]).ready, false);
});

test('就绪后按 tau=10 慢跟随，不会一次跳到位', () => {
  const r = rig(); r.feed(6);
  const s = r.feed(30, [0.1, 0, 0]);
  assert.ok(s.gyro_bias_dps[0] > 0.08 && s.gyro_bias_dps[0] < 0.1, String(s.gyro_bias_dps));
  assert.equal(s.recovery.phase, 'slow_tracking');
});

test('运动期间保留偏置与就绪状态', () => {
  const r = rig(); r.feed(6); r.feed(5, [0.2, 0, 0]);
  const before = r.tr.snapshot().gyro_bias_dps;
  const s = r.feed(10, t => [60 * Math.sin(t / 500), 0, 0]);
  assert.ok(norm(s.gyro_bias_dps, before) < 0.01, String(s.gyro_bias_dps));
  assert.equal(s.ready, true);
});

test('运动后不足 1.5 秒不更新', () => {
  const r = rig(); r.feed(6, [0, 0, 0]); r.feed(2, [60, 0, 0]);
  const before = r.tr.snapshot().gyro_bias_dps;
  r.feed(1.0, [2.5, 0, 0]);
  assert.deepEqual(r.tr.snapshot().gyro_bias_dps, before);
});

test('穿戴级 2.5 °/s 台阶：先不学，6 秒静止复核后快速重定位', () => {
  const r = rig(); r.feed(6); r.feed(2, [60, 0, 0]);
  const hold = r.feed(6.2, [2.5, 0, 0]);
  assert.ok(hold.gyro_bias_dps[0] < 0.2, '复核前不能直接吸收：' + hold.gyro_bias_dps);
  assert.match(hold.status, /连续静止确认 5\.\d\/6 秒 · 保留原补偿/);
  assert.equal(hold.recovery.confirmed_changes, 0);
  const moved = r.feed(8, [2.5, 0, 0]);
  assert.ok(moved.gyro_bias_dps[0] > 2.0, String(moved.gyro_bias_dps));
  assert.ok(moved.gyro_bias_dps[0] < 2.6, String(moved.gyro_bias_dps));
});

test('重定位收敛后回到慢跟踪', () => {
  const r = rig(); r.feed(6); r.feed(2, [60, 0, 0]); r.feed(16, [2.5, 0, 0]);
  const s = r.tr.snapshot();
  assert.equal(s.recovery.phase, 'slow_tracking');
  assert.ok(Math.abs(s.gyro_bias_dps[0] - 2.5) < 0.12, String(s.gyro_bias_dps));
});

test('7.5 °/s 持续偏移跨过历史窗口后仍能完整收敛', () => {
  for (const hz of [20, 50, 100]) {
    const r = rig(hz); r.feed(6);
    const s = r.feed(40, [7.5, 0, 0]);
    assert.equal(s.recovery.phase, 'slow_tracking', `${hz} Hz: ${s.status}`);
    assert.ok(Math.abs(s.gyro_bias_dps[0] - 7.5) < 0.1, String(s.gyro_bias_dps));
    assert.equal(s.recovery.confirmed_changes, 1);
  }
});

test('超过 8 °/s 的偏移一律保留补偿', () => {
  const r = rig(); r.feed(6); r.feed(2, [60, 0, 0]);
  const s = r.feed(20, [10, 0, 0]);
  assert.ok(Math.abs(s.gyro_bias_dps[0]) < 0.2, String(s.gyro_bias_dps));
  assert.match(s.status, /恢复上限/);
});

test('复核期间再次运动立即停止学习', () => {
  const r = rig(); r.feed(6); r.feed(2, [60, 0, 0]); r.feed(4, [2.5, 0, 0]);
  const before = r.tr.snapshot().gyro_bias_dps;
  const s = r.feed(3, [60, 0, 0]);
  assert.deepEqual(s.gyro_bias_dps, before);
  assert.equal(s.recovery.fast, false);
});

test('中断后重新积累完整确认窗，两次通过各计一次', () => {
  const r = rig(); r.feed(6); r.feed(8, [2.5, 0, 0]);
  assert.equal(r.tr.snapshot().recovery.phase, 'fast_tracking');
  assert.equal(r.tr.snapshot().recovery.confirmed_changes, 1);
  r.feed(0.1, [60, 0, 0]);
  const before = r.tr.snapshot().gyro_bias_dps;
  const hold = r.feed(6.2, [2.5, 0, 0]);
  assert.equal(hold.recovery.phase, 'confirming');
  assert.deepEqual(hold.gyro_bias_dps, before);
  assert.equal(hold.recovery.confirmed_changes, 1);
  assert.equal(r.feed(1, [2.5, 0, 0]).recovery.confirmed_changes, 2);
});

test('复核进度取自配置，缺样与不稳定均不能通过', () => {
  const recovery = createBiasRecovery({ confirm: 4000 });
  const check = (runMs, measureStability) => recovery.assess({
    bias: [0, 0, 0], gyro: [2.5, 0, 0], runMs, measureStability
  });
  assert.match(check(3999, () => assert.fail('未满确认窗不应计算稳定性')).reason, /3\.9\/4 秒/);
  assert.match(check(4000, () => null).reason, /样本不足/);
  assert.match(check(4000, () => ({ gyro: 0.4, gravity: 0 })).reason, /仍有变化/);
  assert.equal(check(4000, span => {
    assert.equal(span, 4000);
    return { gyro: 0.2, gravity: 0.01 };
  }).fast, true);
});

test('断流保留补偿并清除候选', () => {
  const r = rig(); r.feed(6); r.feed(2, [0.3, 0, 0]);
  const before = r.tr.snapshot().gyro_bias_dps;
  const s = r.tr.push({ seq: r.seq + 1, gx0: .3, gy0: 0, gz0: 0, ax: 0, ay: 0, az: 1, clk: { epoch: r.time + 1000 } }, r.time + 1000);
  assert.deepEqual(s.gyro_bias_dps, before);
  assert.equal(s.ready, true);
  assert.equal(s.candidate_frames, 0);
  assert.equal(s.last_reject, '数据不连续');
});

test('reset 清空补偿与恢复诊断', () => {
  const r = rig(); r.feed(6); r.tr.reset();
  const s = r.tr.snapshot();
  assert.equal(s.ready, false);
  assert.equal(s.recovery.confirmed_changes, 0);
  assert.equal(s.recovery.phase, 'initializing');
  assert.deepEqual(s.gyro_bias_dps, [0, 0, 0]);
});

test('20 / 50 / 100 Hz 初始化结果一致', () => {
  const values = [20, 50, 100].map((hz) => {
    const r = rig(hz), s = r.feed(6, [6, -4, 9], [0, 0, 1]);
    assert.ok(s.ready, hz + ' Hz 未就绪');
    return s.gyro_bias_dps.slice();
  });
  for (const v of values) assert.ok(norm(v, values[0]) < 1e-9, v.join(','));
  assert.ok(norm(values[0], [6, -4, 9]) < 1e-9);
});

test('恒速转动会被当作零偏（不可辨识，明确展示）', () => {
  const r = rig(); r.feed(6); const s = r.feed(30, [0, 0, 0.5]);
  assert.ok(s.gyro_bias_dps[2] > 0.45, String(s.gyro_bias_dps));
});

test('手动校准仍可覆盖并继续自动跟踪', () => {
  const r = rig(); r.feed(6); r.tr.setMode('manual'); r.tr.startCalibration();
  const s = r.feed(4, [2, 0, 0]);
  near(s.gyro_bias_dps[0], 2);
  r.feed(3, [4, 0, 0]);
  assert.deepEqual(r.tr.snapshot().gyro_bias_dps, s.gyro_bias_dps);
});

console.log(`${count} confirmed-rest tests passed`);
