'use strict';
/* 大偏移恢复：只有“静止持续时间够长、且窗内没有缓变”才允许快速跟踪。
   恒速转动在这些判据下仍与零偏不可区分，这是六轴的物理局限，不是门限漏洞。 */
function createBiasRecovery(overrides = {}) {
  const limits = Object.freeze({ innovation: 0.8, confirm: 6000, drift: 0.35, gravity: 0.02,
    max: 8, settled: 0.1, fastTau: 2.5, slowTau: 10, ...overrides });
  let phase = 'initializing', fast = false, confirmed = 0;
  function invalidate() { fast = false; phase = 'holding'; }
  function reset() { fast = false; phase = 'initializing'; confirmed = 0; }
  /* drift / gravity 是候选静止跨度内首尾均值差，由调用方按同一批帧算出。 */
  function assess({ bias, gyro, drift, gravity, runMs }) {
    const innovation = Math.hypot(...gyro.map((x, k) => x - bias[k]));
    if (innovation > limits.max) {
      invalidate(); phase = 'change_too_large';
      return { hold: true, reason: '候选偏移超出恢复上限，保留补偿' };
    }
    if (innovation > limits.innovation) {
      fast = false;
      if (!(runMs >= limits.confirm)) {
        phase = 'confirming';
        return { hold: true, reason: '候选偏移 ' + innovation.toFixed(2) + ' °/s，等待 6 秒静止复核' };
      }
      if (!(drift <= limits.drift) || !(gravity <= limits.gravity)) {
        phase = 'confirming';
        return { hold: true, reason: '候选静止跨度内仍在变化，保留补偿' };
      }
      fast = true; confirmed++; phase = 'fast_tracking';
      return { hold: false, tau: limits.fastTau };
    }
    if (fast && innovation <= limits.settled) fast = false;
    phase = fast ? 'fast_tracking' : 'slow_tracking';
    return { hold: false, tau: fast ? limits.fastTau : limits.slowTau };
  }
  return { assess, invalidate, reset, initialized() { fast = false; phase = 'slow_tracking'; },
    snapshot: () => ({ phase, confirmed_changes: confirmed, fast, limits: { ...limits } }) };
}
module.exports = { createBiasRecovery };
