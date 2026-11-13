'use strict';
/* σ̂ 只用于拦住“确实噪声过大”的数据，不用来自适应放大门限：
   穿戴时的小幅晃动与真实噪声不可分，放大门限会把运动当静止。 */
const MAX_SIGMA = 0.3;
function quantile(values, p) {
  const v = [...values].sort((a, b) => a - b), pos = (v.length - 1) * p;
  const i = Math.floor(pos), f = pos - i;
  return v[i] * (1 - f) + v[Math.min(i + 1, v.length - 1)] * f;
}
function assessNoise(rows, start, end) {
  const sigma = [];
  for (let k = 0; k < 3; k++) {
    const d = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][6] < start || rows[i - 1][6] < start || rows[i][6] > end) continue;
      d.push(rows[i][k] - rows[i - 1][k]);
    }
    if (d.length < 4) { sigma.push(null); continue; }
    const center = quantile(d, 0.5);
    sigma.push(quantile(d.map(x => Math.abs(x - center)), 0.5) / 0.95387255);
  }
  const reject = sigma.some(s => s !== null && s > MAX_SIGMA) ? '噪声过大，拒绝学习' : null;
  return { noise_sigma_dps: sigma, reject };
}
module.exports = { assessNoise, MAX_SIGMA };
