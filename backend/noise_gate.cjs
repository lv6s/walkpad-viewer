'use strict';
function quantile(values, p) {
  const v = [...values].sort((a, b) => a - b), pos = (v.length - 1) * p;
  const i = Math.floor(pos), f = pos - i;
  return v[i] * (1 - f) + v[Math.min(i + 1, v.length - 1)] * f;
}
function assessNoise(rows, stats, integrate) {
  const sigma = [], stdLimit = [], rangeLimit = [];
  for (let k = 0; k < 3; k++) {
    const d = rows.slice(1).map((q, i) => q[k] - rows[i][k]);
    const center = quantile(d, 0.5);
    // 差分尺度不是静止证明；必须同时通过绝对上限与分段均值门控。
    const s = quantile(d.map(x => Math.abs(x - center)), 0.5) / 0.95387255;
    sigma.push(s);
    stdLimit.push(Math.max(0.12, Math.min(0.45, 1.8 * s)));
    rangeLimit.push(Math.max(0.56, Math.min(2.52, 9 * s)));
  }
  const diag = { noise_sigma_dps: sigma, gyro_std_limit_dps: stdLimit, gyro_range_limit_dps: rangeLimit };
  for (let k = 0; k < 3; k++) {
    if (sigma[k] > 0.30) return { ...diag, reject: '噪声过大，拒绝扩大门限' };
    const values = rows.map(q => q[k]);
    if (stats.std[k] > stdLimit[k] + 1e-12 || Math.max(...values) - Math.min(...values) > rangeLimit[k] + 1e-12)
      return { ...diag, reject: '角速度变化超限' };
  }
  const start = rows[0][6], end = rows[rows.length - 1][6], means = [];
  for (let j = 0; j < 5; j++) means.push(integrate(rows, start + (end - start) * j / 5, start + (end - start) * (j + 1) / 5).mu.slice(0, 3));
  for (const a of means) for (const b of means)
    if (Math.hypot(...a.map((v, k) => v - b[k])) > 0.14 + 1e-12)
      return { ...diag, reject: '分段均值变化，疑似缓慢运动' };
  return { ...diag, reject: null };
}
module.exports = { assessNoise };
