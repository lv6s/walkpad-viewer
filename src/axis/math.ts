/* 轴向推断的纯计算层：静止段、重力系、角速度主成分、三项判据。不碰 DOM，不读全局状态。 */

const G = 9.80665;
// 静止判据（单位 g）：加速度模长的滑窗标准差 + 模长偏离 1 g 的上限。
// 不用「角速度模长 < 15 °/s」那套：零偏大的器件静止时就有 17–20 °/s，会把所有静止段判掉。
const SENS = {
  auto:   {std: 0.04, dev: 0.08},
  loose:  {std: 0.09, dev: 0.16},
  strict: {std: 0.02, dev: 0.05}
};
const AXES = ['x', 'y', 'z'];
const AX_COL = {x: '#2E86D6', y: '#DE7024', z: '#3A9E62'};
const MIN_STATIC = 1.0;      // 静止总时长下限（s），低于此定不出垂直轴
const MIN_DISP = 0.15;       // 位移中位下限（m），低于此认为没有行走
const MIN_STATIC_SEG = 0.12; // 单段静止最短时长（s）
// 零速样本的角速度滑窗离散上限（°/s），逐级放宽直到样本够用
const ZV_LEVELS = [2, 5, 10, 20];

// ---------------------------------------------------------------- 向量与特征分解
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const m = vlen(a); return m > 1e-12 ? [a[0] / m, a[1] / m, a[2] / m] : [0, 0, 0]; };
const mul = (R, v) => [dot(R[0], v), dot(R[1], v), dot(R[2], v)];
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp1 = x => Math.max(-1, Math.min(1, x));
const angDeg = (a, b) => Math.acos(clamp1(dot(a, b))) * R2D;

// 把 a 旋到 +z 的最小旋转：gravity 系下的分量 = R·a
function rotToZ(a) {
  const u = unit(a), c = u[2];
  if (c > 1 - 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (c < -1 + 1e-12) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const v = cross(u, [0, 0, 1]);
  const K = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]];
  const f = 1 / (1 + c);
  const K2 = [0, 1, 2].map(i => [0, 1, 2].map(j => K[i][0] * K[0][j] + K[i][1] * K[1][j] + K[i][2] * K[2][j]));
  return [0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? 1 : 0) + K[i][j] + K2[i][j] * f));
}

// 对称 3×3 特征分解（Jacobi）：val 升序，vec[i] 为对应特征向量
function eig3(Ain) {
  const A = Ain.map(r => r.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 40; sweep++) {
    if (Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]) < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = A[p][q];
      if (Math.abs(apq) < 1e-16) continue;
      const th = (A[q][q] - A[p][p]) / (2 * apq);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      const app = A[p][p], aqq = A[q][q];
      A[p][p] = app - t * apq;
      A[q][q] = aqq + t * apq;
      A[p][q] = A[q][p] = 0;
      const r = p === 0 ? (q === 1 ? 2 : 1) : 0;
      const arp = A[r][p], arq = A[r][q];
      A[r][p] = A[p][r] = c * arp - s * arq;
      A[r][q] = A[q][r] = s * arp + c * arq;
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = [0, 1, 2].sort((a, b) => A[a][a] - A[b][b]);
  return {val: idx.map(i => A[i][i]), vec: idx.map(i => [V[0][i], V[1][i], V[2][i]])};
}

const cmean = angs => {
  let sx = 0, sy = 0;
  for (const a of angs) { sx += Math.cos(a * D2R); sy += Math.sin(a * D2R); }
  const m = angs.length || 1;
  const r = Math.hypot(sx, sy) / m;
  return {ang: Math.atan2(sy, sx) * R2D, r, std: angs.length > 1 ? Math.sqrt(Math.max(0, -2 * Math.log(Math.max(r, 1e-9)))) * R2D : NaN};
};

const pct = (v: number, n?: number) => (100 * v).toFixed(n == null ? 1 : n) + '%';
const sgn = v => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2);
const angStr = (v: number, n?: number) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(n == null ? 1 : n) + '°';
const vec3 = v => `(${v.map(x => sgn(x)).join(', ')})`;

// ---------------------------------------------------------------- 推断
// opt: {sens, win:{a,b}|null}
// src 可能是懒加载的全段对象（n/t 是全段、imu 只有窗口块）：先换成块视图，
// 时间、信号、下标必须来自同一块 —— 否则块首的加速度会被绑到全段的第 0 帧上。
function infer(src: any, opt?: any): any {
  const s = src.blk ? Object.assign(Object.create(src), src.blk) : src;
  const im = s.imu;
  if (!im || !im.phys) return {err: '本侧没有 imu_physical_values，无法推断。'};
  const n = s.n, t = s.t;
  const acc = [im.phys[0], im.phys[1], im.phys[2]];
  const gyr = [im.phys[3], im.phys[4], im.phys[5]];
  const w = opt.win || {a: t[0], b: t[n - 1]};
  let i0 = 0, i1 = n - 1;
  while (i0 < n && t[i0] < w.a) i0++;
  while (i1 > 0 && t[i1] > w.b) i1--;
  if (i1 - i0 < 30) return {err: '区间内帧数太少，无法推断。'};
  const valid = k => Number.isFinite(acc[0][k]) && Number.isFinite(acc[1][k]) && Number.isFinite(acc[2][k])
    && Number.isFinite(gyr[0][k]) && Number.isFinite(gyr[1][k]) && Number.isFinite(gyr[2][k]);

  // 采样率取「有效记录的平均间隔」：(样本数 − 1) ÷ 首末跨度。
  // ⚠ 不能只累计正间隔再取倒数：批内多条记录共享同一接收时间戳时，正间隔的个数比样本数少一半，
  // 实测 49.7 Hz 的惯性流会被算成 24.8 Hz，而静止窗、零速样本数、1/fs 双积分都跟着它走。
  const span = t[i1] - t[i0];
  const fs = (i1 > i0 && span > 0) ? (i1 - i0) / span : s.fs;
  if (!(fs > 1)) return {err: '采样率异常，无法推断。'};
  // 有重复时间戳就说明时间轴比样本粗：按平均间隔积分的误差要讲明白，不能当成等间隔采样
  let nDup = 0;
  for (let k = i0 + 1; k <= i1; k++) if (!(t[k] > t[k - 1])) nDup++;

  // --- ① 静止段：加速度模长的滑窗标准差
  const sens = opt.sens;
  const half = Math.max(1, Math.round(0.1 * fs));
  const W = half * 2 + 1;
  const cN = new Int32Array(n + 1), cS = new Float64Array(n + 1), cQ = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const ok = Number.isFinite(acc[0][k]) && Number.isFinite(acc[1][k]) && Number.isFinite(acc[2][k]);
    const m = ok ? Math.hypot(acc[0][k], acc[1][k], acc[2][k]) : 0;
    cN[k + 1] = cN[k] + (ok ? 1 : 0);
    cS[k + 1] = cS[k] + (ok ? m : 0);
    cQ[k + 1] = cQ[k] + (ok ? m * m : 0);
  }
  const still = new Uint8Array(n);
  for (let k = i0; k <= i1; k++) {
    const a = Math.max(0, k - half), b = Math.min(n, k + half + 1);
    const cnt = cN[b] - cN[a];
    if (cnt < W * 0.7) continue;
    const mu = (cS[b] - cS[a]) / cnt;
    const sd = Math.sqrt(Math.max(0, (cQ[b] - cQ[a]) / cnt - mu * mu));
    if (sd < sens.std && Math.abs(mu - 1) < sens.dev) still[k] = 1;
  }

  // 静止判据只看加速度：行走支撑相脚虽然不移动，但角速度并不为零，
  // 用角速度阈值会把支撑相切碎、双积分的锚点就没了（实测位移会从 0.34 m 掉到 0.03 m）。
  // 这段里到底有没有可用的转动，交给后面「非静止帧角速度中位」的检查去判。
  const minLen = Math.max(3, Math.round(MIN_STATIC_SEG * fs));
  const segs = [];
  for (let k = i0; k <= i1;) {
    if (!still[k]) { k++; continue; }
    let j = k;
    while (j + 1 <= i1 && still[j + 1]) j++;
    if (j - k + 1 >= minLen) segs.push([k, j]);
    k = j + 1;
  }
  let nStill = 0;
  for (let k = i0; k <= i1; k++) if (still[k]) nStill++;
  const stillDur = nStill / fs;
  if (stillDur < MIN_STATIC || !segs.length) {
    return {err: `区间内静止样本只有 ${stillDur.toFixed(2)} s（${segs.length} 段），定不出垂直轴；可把静止判据调成「宽松」，或换一段含站立的数据。`};
  }

  // --- 垂直轴：静止段均值聚类。一份记录里可能既有站立又有深蹲，脚朝向不同，
  // 直接取全均值等于把两种姿态平均掉；这里取最密的一簇（主姿态）定重力方向。
  const segU = segs.map(([a, b]) => {
    let mx = 0, my = 0, mz = 0, c = 0;
    for (let k = a; k <= b; k++) { mx += acc[0][k]; my += acc[1][k]; mz += acc[2][k]; c++; }
    return {u: unit([mx / c, my / c, mz / c]), w: c};
  });
  const meanOf = pick => {
    const s = [0, 0, 0];
    let w = 0;
    segU.forEach((x, i) => { if (pick[i]) { s[0] += x.u[0] * x.w; s[1] += x.u[1] * x.w; s[2] += x.u[2] * x.w; w += x.w; } });
    return {sum: s, w};
  };
  let keep = segU.map(() => true);
  let up = unit(meanOf(keep).sum);
  for (let it = 0; it < 3; it++) {
    const next = segU.map(x => angDeg(x.u, up) <= 8);
    if (!next.some(Boolean)) break;
    keep = next;
    up = unit(meanOf(keep).sum);
  }
  const nMain = keep.filter(Boolean).length;
  const m0 = meanOf(keep);
  const accMean = vlen(m0.sum) / Math.max(1, m0.w);
  let upDev = 0, allDev = 0;
  segU.forEach((x, i) => {
    const a = angDeg(x.u, up);
    if (a > allDev) allDev = a;
    if (keep[i] && a > upDev) upDev = a;
  });
  // 零偏只取真正零速的帧：|a| 定义的「静止段」里大半是行走支撑相——脚不移动，
  // 但踝在滚动，陀螺有 10–30 °/s 的常值电平，整体取中位数会把支撑相电平当成零偏。
  // 零速判据用角速度的滑窗离散（只看散布、不看电平，零偏大的器件也不会被判掉）。
  const main = new Uint8Array(n);
  segs.forEach(([a, b], i) => { if (keep[i]) for (let k = a; k <= b; k++) main[k] = 1; });
  const g1 = new Float64Array(n + 1), g2 = new Float64Array(n + 1), gN = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const ok = Number.isFinite(gyr[0][k]) && Number.isFinite(gyr[1][k]) && Number.isFinite(gyr[2][k]);
    const m = ok ? Math.hypot(gyr[0][k], gyr[1][k], gyr[2][k]) : 0;
    g1[k + 1] = g1[k] + (ok ? m : 0);
    g2[k + 1] = g2[k] + (ok ? m * m : 0);
    gN[k + 1] = gN[k] + (ok ? 1 : 0);
  }
  const minZV = Math.max(10, Math.round(0.2 * fs));
  let zv = null, zvN = 0, zvThr = 0;
  for (const thr of ZV_LEVELS) {
    const m = new Uint8Array(n);
    let c = 0;
    for (let k = i0; k <= i1; k++) {
      if (!main[k]) continue;
      const a = Math.max(0, k - half), b = Math.min(n, k + half + 1);
      const cnt = gN[b] - gN[a];
      if (cnt < W * 0.7) continue;
      const mu = (g1[b] - g1[a]) / cnt;
      const sd = Math.sqrt(Math.max(0, (g2[b] - g2[a]) / cnt - mu * mu));
      if (sd < thr) { m[k] = 1; c++; }
    }
    zv = m; zvN = c; zvThr = thr;
    if (c >= minZV) break;
  }
  // 一个零速帧都没有时退回主簇静止段整体，零偏必然偏大，由警告提示
  const biasSrc = zvN ? zv : main;
  const bias = [0, 1, 2].map(j => {
    const v = [];
    for (let k = i0; k <= i1; k++) if (biasSrc[k]) v.push(gyr[j][k]);
    v.sort((x, y) => x - y);
    return v.length ? v[v.length >> 1] : 0;
  });
  const biasNorm = Math.hypot(bias[0], bias[1], bias[2]);
  const biasInfo = {biasN: zvN, biasDur: zvN / fs, biasThr: zvThr};

  // 垂直轴的置信度：只看主簇离散与 |a| 是否贴 1 g（簇间差异是脚真的换了姿态，不算误差）
  const confA = (nMain >= 2 && stillDur >= 2 && upDev <= 4 && Math.abs(accMean - 1) <= 0.03) ? 'hi'
    : (upDev <= 10 && Math.abs(accMean - 1) <= 0.08) ? 'mid' : 'lo';

  // 内外侧轴定不出来时不再往下走，但垂直轴已经拿到了：退化成部分结论，别把整页判死。
  // 已经算出来的主成分也带上 —— 分段表要靠它比较各段「转轴有多水平」
  let pca = null;
  const partial = reason => ({partial: true, reason, fs, stillDur, nSeg: segs.length, nMain, confA,
                              up, upDev, allDev, accMean, bias, biasNorm, ...biasInfo, l: pca ? pca.vec : null, pca,
                              t0: t[i0], t1: t[i1]});
  const R1 = rotToZ(up);
  const gw = k => {   // 重力系角速度
    const v = [gyr[0][k] - bias[0], gyr[1][k] - bias[1], gyr[2][k] - bias[2]];
    return mul(R1, v);
  };
  const aw = k => mul(R1, [acc[0][k] * G, acc[1][k] * G, acc[2][k] * G]);

  // --- ② 内外侧轴：非静止帧角速度的第一主成分（方差最大方向）
  function domAxis(from, to) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const mags = [];
    let c = 0;
    for (let k = from; k <= to; k++) {
      if (still[k] || !valid(k)) continue;
      const v = gw(k);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += v[i] * v[j];
      mags.push(Math.hypot(v[0], v[1], v[2]));
      c++;
    }
    if (c < 20) return null;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] /= c;
    const e = eig3(C);
    const sum = e.val[0] + e.val[1] + e.val[2];
    mags.sort((x, y) => x - y);
    return {vec: unit(e.vec[2]), ratio: sum > 0 ? e.val[2] / sum : 0, n: c, med: mags[mags.length >> 1]};
  }
  pca = domAxis(i0, i1);
  if (!pca) return partial('区间内几乎全是静止段，取不到角速度主成分，内外侧轴与前向都定不出来。');
  const l = pca.vec;
  // 分窗一致性：主成分方向本身有 ±，用 |cos| 比
  let pcaSpread = 0, pcaWin = 0;
  const K = 6;
  for (let q = 0; q < K; q++) {
    const a = i0 + Math.floor((i1 - i0) * q / K), b = i0 + Math.floor((i1 - i0) * (q + 1) / K) - 1;
    const d = domAxis(a, b);
    if (!d) continue;
    pcaWin++;
    pcaSpread = Math.max(pcaSpread, Math.acos(clamp1(Math.abs(dot(d.vec, l)))) * R2D);
  }

  // 前向候选：up × 内外侧轴（水平方向，符号待定）。
  // 先确认这段里脚真的在转：角速度太小的话主成分只是噪声，跟方向无关。
  if (pca.med < 10) {
    return partial(`这段数据里脚几乎不转（非静止帧角速度中位 ${pca.med.toFixed(0)} °/s），没有可用的转动信号，内外侧轴与前向都定不出来。`);
  }
  // 内外侧轴必须接近水平——主成分若指向垂直方向，说明主导动作是绕垂直轴转（转身 / 原地扭动）。
  const lTilt = Math.acos(clamp1(Math.abs(l[2]))) * R2D;
  if (lTilt < 60) {
    return partial(`角速度第一主成分与垂直方向只差 ${lTilt.toFixed(0)}°，不是水平的内外侧轴：这段数据里主导动作是绕垂直轴转（转身 / 原地扭动）。`);
  }
  const f0raw = cross([0, 0, 1], l);
  const f0 = unit([f0raw[0], f0raw[1], 0]);
  const leftC = cross([0, 0, 1], f0);

  // --- ③ 前向符号：三项判据
  // 判据 1/2：加速度双积分。两种积分区间——相邻支撑中点（步幅）、支撑末到支撑初（摆动）。
  function dispList(mode) {
    const out = [];
    for (let r = 0; r + 1 < segs.length; r++) {
      const [a0, b0] = segs[r], [a1, b1] = segs[r + 1];
      const from = mode === 'mid' ? (a0 + b0) >> 1 : b0;
      const to = mode === 'mid' ? (a1 + b1) >> 1 : a1;
      if (to - from < 4) continue;
      let ok = true;
      for (let k = from; k <= to && ok; k++) ok = valid(k);
      if (!ok) continue;
      // 末端速度归零（线性去漂）：不扣掉的话零偏会积成一个大漂移，方向就随零偏走了
      const m = to - from + 1, T = (m - 1) / fs;
      const vx = new Float64Array(m), vy = new Float64Array(m), vz = new Float64Array(m);
      let ax_ = 0, ay_ = 0, az_ = 0;
      for (let k = from; k <= to; k++) {
        const a = aw(k);
        ax_ += a[0] / fs; ay_ += a[1] / fs; az_ += (a[2] - G) / fs;
        const i = k - from;
        vx[i] = ax_; vy[i] = ay_; vz[i] = az_;
      }
      const ex = vx[m - 1], ey = vy[m - 1], ez = vz[m - 1];
      let dx = 0, dy = 0, dz = 0;
      for (let i = 0; i < m; i++) {
        const f = i / fs / T;
        dx += (vx[i] - f * ex) / fs;
        dy += (vy[i] - f * ey) / fs;
        dz += (vz[i] - f * ez) / fs;
      }
      out.push([dx, dy, dz]);
    }
    return out;
  }

  function judgeDisp(key, list) {
    const angs = [], mags = [];
    for (const d of list) {
      const hx = d[0], hy = d[1];
      const m = Math.hypot(hx, hy);
      if (!(m > 1e-6)) continue;
      angs.push(Math.atan2((hx * leftC[0] + hy * leftC[1]) / m, (hx * f0[0] + hy * f0[1]) / m) * R2D);
      mags.push(m);
    }
    if (angs.length < 3) return {key, valid: false, why: `可用区间 ${angs.length} 段，不足 3 段`};
    const cm = cmean(angs);
    mags.sort((x, y) => x - y);
    const med = mags[mags.length >> 1];
    if (med < MIN_DISP) return {key, valid: false, why: `位移中位 ${med.toFixed(2)} m，没有行走`, n: angs.length, med};
    if (cm.std > 75) return {key, valid: false, why: `方向圆标准差 ${cm.std.toFixed(0)}°，离散过大`, n: angs.length, med, std: cm.std};
    const pos = Math.cos(cm.ang * D2R) > 0;
    const dev = pos ? Math.abs(cm.ang) : Math.abs(180 - Math.abs(cm.ang));
    return {key, valid: true, pos, dev, ang: cm.ang, n: angs.length, med, std: cm.std};
  }

  const j1 = judgeDisp('j1', dispList('mid'));
  const j2 = judgeDisp('j2', dispList('swing'));

  // 判据 3：若 z_s 是脚背外法线，其水平投影朝脚尖（与积分无关，纯几何）
  const zs = mul(R1, [0, 0, 1]);
  const zh = Math.hypot(zs[0], zs[1]);
  let j3;
  if (opt.useMountGeometry === false) {
    j3 = {key: 'j3', valid: false};
  } else if (zh < 0.25) {
    j3 = {key: 'j3', valid: false, why: `z 轴几乎垂直（水平投影 ${zh.toFixed(2)}），几何判据没有分辨力`};
  } else {
    const a = Math.atan2((zs[0] * leftC[0] + zs[1] * leftC[1]) / zh, (zs[0] * f0[0] + zs[1] * f0[1]) / zh) * R2D;
    const pos = Math.cos(a * D2R) > 0;
    j3 = {key: 'j3', valid: true, pos, dev: pos ? Math.abs(a) : Math.abs(180 - Math.abs(a)), ang: a, zh};
  }

  const judges = [j1, j2, j3].filter(j => j.valid);
  const npos = judges.filter(j => j.pos).length;
  const nneg = judges.length - npos;
  let sign = null;
  if (judges.length && npos !== nneg) sign = npos > nneg ? 1 : -1;
  // 判据之间的方向离散：同号但彼此差 50° 也算「都同意」，不能因此给高
  let spreadJ = 0;
  if (sign !== null) {
    const rel = judges.map(j => {
      let a = j.ang;
      if (sign < 0) a += 180;
      while (a <= -180) a += 360;
      while (a > 180) a -= 360;
      return a;
    });
    spreadJ = Math.max(...rel) - Math.min(...rel);
  }

  // --- 组装解剖系：行 = 前 / 左 / 上 在传感器系下的分量
  const fwdG = sign === null ? f0 : [f0[0] * sign, f0[1] * sign, 0];
  const leftG = cross([0, 0, 1], fwdG);
  const R1T = [0, 1, 2].map(i => [R1[0][i], R1[1][i], R1[2][i]]);
  const fwdS = mul(R1T, fwdG), leftS = mul(R1T, leftG), upS = mul(R1T, [0, 0, 1]);
  const R = [fwdS, leftS, upS];

  const rows = AXES.map((nm, i) => {
    const v = [R[0][i], R[1][i], R[2][i]];      // (前, 左, 上)
    const cand: [string, number][] = [['前', v[0]], ['后', -v[0]], ['左', v[1]], ['右', -v[1]], ['上', v[2]], ['下', -v[2]]];
    let best = cand[0];
    for (const c of cand) if (Math.abs(c[1]) > Math.abs(best[1])) best = c;
    const ha = Math.hypot(v[0], v[1]);
    const az = Math.abs(v[0]) >= Math.abs(v[1]) ? (v[0] >= 0 ? '前' : '后') : (v[1] >= 0 ? '左' : '右');
    const el = v[2] >= 0 ? '上' : '下';
    let desc = '';
    if (ha >= 0.2) desc += az;
    if (Math.abs(v[2]) >= 0.2) desc += el;
    if (!desc) desc = best[0];
    return {nm, v, desc, gap: Math.acos(clamp1(Math.abs(best[1]))) * R2D,
            elev: Math.asin(clamp1(v[2])) * R2D, azim: Math.atan2(v[1], v[0]) * R2D};
  });

  // --- 置信度
  const confB = (pca.ratio >= 0.5 && pcaSpread <= 10) ? 'hi'
    : (pca.ratio >= 0.3 && pcaSpread <= 25) ? 'mid' : 'lo';
  // 双积分两项方向离散大 = 这段数据里积分不可靠；判据之间方向差得远 = 只算符号相同，不算结论一致
  const dispOK = [j1, j2].every(j => !j.valid || j.std <= 40);
  let confC;
  if (sign === null) confC = 'lo';
  else if (judges.length >= 3 && npos === judges.length && dispOK && spreadJ <= 40) confC = 'hi';
  else if (judges.length >= 2) confC = 'mid';
  else confC = 'lo';

  const warns = [];
  if (!zvN) warns.push(`静止段里没有一帧角速度是稳的（离散都超过 ${ZV_LEVELS[ZV_LEVELS.length - 1]} °/s）：零偏退回「静止段整体中位数」，做姿态积分前必须另找静置段标定。`);
  else if (zvN < minZV) warns.push(`零速样本只有 ${zvN} 帧 / ${(zvN / fs).toFixed(2)} s（角速度离散 < ${zvThr} °/s），零偏估计不稳，做姿态积分前建议另录一段静置。`);
  if (biasNorm > 5) warns.push(`静止时角速度零偏 ${vec3(bias)} °/s（范数 ${biasNorm.toFixed(1)}）偏大：本页不做陀螺积分，结论不受影响，但这份数据做姿态积分前必须先扣零偏。`);
  if (fs < 60) warns.push(`采样率 ${fs.toFixed(1)} Hz 偏低，加速度双积分的位移会被低估（本段中位 ${(j1.med || j2.med || 0).toFixed(2)} m），前向符号因此到不了「高」。`);
  if (nDup > 0.02 * (i1 - i0)) warns.push(`区间内有 ${nDup} 处相邻帧时间不增（接收时间被量化到同一刻）：${fs.toFixed(1)} Hz 是按平均间隔估的记录率，逐样本积分只能在均间隔近似下成立，做精确积分要另取更细的时间戳。`);
  if (pcaSpread > 25) warns.push(`各窗角速度主成分离散 ${pcaSpread.toFixed(0)}°：这段里混了不止一种动作，内外侧轴不稳，切到纯行走或纯深蹲再看。`);
  if (allDev - upDev > 3) warns.push(`静止段之间相差 ${allDev.toFixed(0)}°：这段里脚有不止一种朝向，垂直轴取的是样本最多的那一簇（${nMain}/${segs.length} 段）。`);
  if (sign === null) warns.push('三项判据没有形成多数：前向符号不可判定。下面按任意一侧给出姿态，只可用于判断垂直轴与内外侧轴。');
  if (judges.length && npos !== judges.length && nneg !== judges.length) warns.push(`判据分裂（${npos} 项指前 / ${nneg} 项指后），前向符号不可靠。`);
  if (!j1.valid && !j2.valid && j3.valid) warns.push('没有可用的行走段，前向符号只由几何判据一项决定，置信度低。');

  return {fs, stillDur, nSeg: segs.length, nMain, up, upDev, allDev, accMean, bias, biasNorm, ...biasInfo,
          l, pca, pcaSpread, pcaWin, f0, fwdG, leftG, fwdS, leftS, upS, R, rows,
          j1, j2, j3, judges, npos, nneg, sign, spreadJ, confA, confB, confC, warns,
          t0: t[i0], t1: t[i1]};
}

export {AXES, AX_COL, D2R, G, R2D, SENS, angDeg, angStr, clamp1, cmean, cross, dot, infer, mul, pct, sgn, unit, vec3, vlen};
