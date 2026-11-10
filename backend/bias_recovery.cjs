'use strict';
function createBiasRecovery() {
  const limits = Object.freeze({ innovation: 0.8, trigger: 0.12, agree: 0.08, gravity: 0.015,
    settled: 0.04, fastTau: 2.5, slowTau: 10 });
  let pending = null, fastReference = null, recheck = false, phase = 'initializing', confirmed = 0;
  const distance = (a, b) => Math.hypot(...a.map((x, k) => x - b[k]));
  function invalidate() {
    pending = null; fastReference = null; recheck = true; phase = 'holding';
  }
  function reset() {
    pending = null; fastReference = null; recheck = false; phase = 'initializing'; confirmed = 0;
  }
  function assess({ bias, gyro, accel, start, end }) {
    const innovation = distance(gyro, bias);
    if (innovation > limits.innovation) {
      invalidate(); phase = 'change_too_large';
      return { hold: true, reason: '候选偏移过大，保留补偿；需静止校准或外部确认' };
    }
    if (fastReference && (distance(gyro, fastReference.gyro) > limits.agree
      || distance(accel, fastReference.accel) > limits.gravity)) invalidate();
    if (pending || recheck || (!fastReference && innovation > limits.trigger)) {
      if (!pending || start <= pending.end || distance(gyro, pending.gyro) > limits.agree
        || distance(accel, pending.accel) > limits.gravity) {
        pending = { gyro: [...gyro], accel: [...accel], end, duration: end - start };
        phase = 'confirming';
        return { hold: true, reason: '候选静止窗已取得，等待独立窗确认' };
      }
      // 两个不重叠窗只用于确认；更新增益只计本次窗时长。
      const dt = end - start, total = dt + pending.duration;
      gyro = gyro.map((x, k) => (x * dt + pending.gyro[k] * pending.duration) / total);
      pending = null; recheck = false; confirmed++;
      fastReference = innovation > limits.trigger ? { gyro: [...gyro], accel: [...accel] } : null;
    }
    if (fastReference && distance(gyro, bias) <= limits.settled) fastReference = null;
    phase = fastReference ? 'fast_tracking' : 'slow_tracking';
    return { hold: false, gyro, tau: fastReference ? limits.fastTau : limits.slowTau };
  }
  return { assess, invalidate, reset, initialized() { pending = null; fastReference = null; recheck = false; phase = 'slow_tracking'; },
    snapshot: () => ({ phase, confirmed_changes: confirmed,
    pending: pending !== null, limits: { ...limits } }) };
}
module.exports = { createBiasRecovery };
