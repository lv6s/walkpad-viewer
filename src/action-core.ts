/* 单次动作的竖直速度：六轴 → 姿态 → 去重力 → 相位内积分。
   全流程只有「转向点竖直速度为零」这一个外部假设，其余全靠积分，所以深度与速度带系统误差；
   表里下蹲/起身两个独立估计的差就是它的量级。 */

import type {Side} from './types';

const DEG = Math.PI / 180;
const GS = 9.80665;

export const FS = 200;
const DT = 1 / FS;
/** 去重力前的低通：动作基频 ~0.5 Hz，6 Hz 不动波形，只压掉高频噪声进积分 */
const FC_A = 6;
/** jerk 用来看底部制动陡缓，截止高一些 */
const FC_J = 12;
/** 静止判据：陀螺 <3 °/s 且合量偏离 1 g <0.04 */
const STATIC_GYRO = 3;
const STATIC_ACC = 0.04;
const STATIC_MIN_S = 0.25;
/** 姿态纠偏时间常数；合量偏离 1 g 超过 GATE_ACC 时完全不信重力方向 */
const TAU_TILT = 0.6;
const GATE_ACC = 0.25;
/** 两转向点最小间隔，短于它的是抖动不是一次动作 */
const MIN_PHASE_S = 0.18;
/** 单次分析上限，再长就不是「单次动作」了 */
const MAX_SPAN_S = 600;

export interface Phase {
  t0: number;
  t1: number;
  dir: 'down' | 'up';
  /** 带符号位移，m */
  disp: number;
  peakV: number;
  peakA: number;
  peakJ: number;
  peakVAt: number;
}

export interface Rep {
  index: number;
  /** 下蹲起点（相对记录起点，秒） */
  t0: number;
  down: number;
  up: number;
  /** 下蹲/起身两个独立估计的平均值 */
  depth: number;
  depthDown: number;
  depthUp: number;
  vDown: number;
  vUp: number;
  vDownMean: number;
  vUpMean: number;
  /** 从最大下蹲速度到最大起身速度的用时 */
  turn: number;
  /** 底部 ±0.1 s 内竖直加速度峰，m/s² */
  aBottom: number;
  /** |下蹲深度-起身深度| / 均值；越大越不可信 */
  mismatch: number;
}

export interface ActionResult {
  from: number;
  to: number;
  fs: number;
  n: number;
  reps: Rep[];
  phases: Phase[];
  /** 画图用的降采样曲线，t 相对记录起点 */
  curve: {t: Float32Array; v: Float32Array; a: Float32Array};
  staticSegs: number;
  /** 静止段估出的陀螺零偏，°/s */
  biasG: [number, number, number];
  /** 竖直残差补偿量的变化范围，m/s²；大就说明姿态倾角在漂 */
  biasSwing: number;
  notes: string[];
}

function biquad(fc: number, fs: number) {
  const w = Math.tan(Math.PI * fc / fs);
  const k1 = Math.SQRT2 * w, k2 = w * w;
  const a0 = 1 + k1 + k2;
  return {b0: k2 / a0, b1: 2 * k2 / a0, b2: k2 / a0, a1: 2 * (k2 - 1) / a0, a2: (1 - k1 + k2) / a0};
}

/** 正反各过一遍：零相位，峰值不会被推后 */
function lp(x: Float64Array, fc: number): Float64Array {
  const {b0, b1, b2, a1, a2} = biquad(fc, FS);
  const n = x.length, fwd = new Float64Array(n), out = new Float64Array(n);
  let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
  for (let i = 0; i < n; i++) {
    const v = x[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o; fwd[i] = o;
  }
  x1 = x2 = y1 = y2 = fwd[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    const v = fwd[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o; out[i] = o;
  }
  return out;
}

function qmul(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
  ];
}

function qunit(q: number[]): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** body → world */
function rot(q: number[], v: number[]): number[] {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

const rotInv = (q: number[], v: number[]) => rot([q[0], -q[1], -q[2], -q[3]], v);

/** 初始姿态：让 body 里的重力方向对齐世界 +z；航向留 0，竖直与航向无关 */
function qFromGravity(a: number[]): number[] {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  const ux = a[0] / n, uy = a[1] / n, uz = a[2] / n;
  if (uz > 1 - 1e-9) return [1, 0, 0, 0];
  if (uz < -1 + 1e-9) return [0, 1, 0, 0];
  const s = Math.hypot(uy, ux, 0);
  if (s < 1e-9) return [1, 0, 0, 0];
  const ang = Math.atan2(s, uz), k = Math.sin(ang / 2) / s;
  return [Math.cos(ang / 2), uy * k, -ux * k, 0];
}

export function analyzeAction(side: Side, opts: {from?: number; to?: number} = {}): ActionResult {
  const notes: string[] = [];
  if (!side.imu || !side.imu.phys) throw new Error('这侧没有物理量六轴，无法估速');

  const t0 = Math.max(opts.from ?? 0, side.t[0]);
  let t1 = Math.min(opts.to ?? side.t[side.n - 1], side.t[side.n - 1]);
  if (!(t1 > t0)) throw new Error('时间窗无效');
  if (t1 - t0 > MAX_SPAN_S) {
    t1 = t0 + MAX_SPAN_S;
    notes.push(`分析范围限制在 ${MAX_SPAN_S} s 内`);
  }

  let i0 = 0, i1 = side.n - 1;
  while (i0 < i1 && side.t[i0] < t0) i0++;
  while (i1 > i0 && side.t[i1] > t1) i1--;
  const nSrc = i1 - i0 + 1;
  if (nSrc < 20) throw new Error('窗口内帧太少');
  const ta = side.t[i0], tb = side.t[i1];
  if (!(tb > ta)) throw new Error('时间戳不单调，无法积分');

  // 六轴逐轴取窗口段；NaN 按前值保持（维特 TXT 常有半截行）
  const raw: Float64Array[][] = [[], []];
  for (let k = 0; k < 6; k++) {
    const src = side.imu.phys[k], dst = new Float64Array(nSrc);
    let last = NaN;
    for (let i = 0; i < nSrc; i++) {
      const v = src[i0 + i];
      if (Number.isFinite(v)) last = v;
      dst[i] = last;
    }
    let first = NaN;
    for (let i = 0; i < nSrc; i++) if (Number.isFinite(dst[i])) { first = dst[i]; break; }
    if (!Number.isFinite(first)) throw new Error('窗口内该轴全是无效值');
    for (let i = 0; i < nSrc && !Number.isFinite(dst[i]); i++) dst[i] = first;
    raw[Math.floor(k / 3)].push(dst);
  }

  // 重采样到固定步长：姿态滤波与积分都要等间隔，且时间轴用真实时间戳内插
  const N = Math.floor((tb - ta) / DT) + 1;
  const tg = new Float64Array(N);
  const acc = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  const gyr = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  const ts = side.t;
  for (let i = 0; i < N; i++) {
    const tt = ta + i * DT;
    tg[i] = tt;
    let lo = i0, hi = i1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= tt) lo = m; else hi = m; }
    const span = ts[lo + 1] - ts[lo];
    const f = span > 0 ? Math.min(1, Math.max(0, (tt - ts[lo]) / span)) : 0;
    for (let k = 0; k < 3; k++) {
      const a0 = raw[0][k][lo - i0], a1 = raw[0][k][lo + 1 - i0];
      const g0 = raw[1][k][lo - i0], g1 = raw[1][k][lo + 1 - i0];
      acc[k][i] = a0 + (a1 - a0) * f;
      gyr[k][i] = g0 + (g1 - g0) * f;
    }
  }

  // 静止段：判据同时看陀螺与合量，只用来定零偏和竖直残差，不用来清零速度
  const segs: [number, number][] = [];
  {
    let s = -1;
    for (let i = 0; i < N; i++) {
      const g = Math.hypot(gyr[0][i], gyr[1][i], gyr[2][i]);
      const a = Math.hypot(acc[0][i], acc[1][i], acc[2][i]);
      const ok = g < STATIC_GYRO && Math.abs(a - 1) < STATIC_ACC;
      if (ok) { if (s < 0) s = i; }
      else if (s >= 0) { if (i - s >= STATIC_MIN_S * FS) segs.push([s, i - 1]); s = -1; }
    }
    if (s >= 0 && N - s >= STATIC_MIN_S * FS) segs.push([s, N - 1]);
  }
  const biasG: [number, number, number] = [0, 0, 0];
  {
    let cnt = 0;
    for (const [a, b] of segs) for (let i = a; i <= b; i++) {
      biasG[0] += gyr[0][i]; biasG[1] += gyr[1][i]; biasG[2] += gyr[2][i]; cnt++;
    }
    if (cnt > 0) { biasG[0] /= cnt; biasG[1] /= cnt; biasG[2] /= cnt; }
    else {
      const m = Math.min(N, Math.round(FS));
      for (let i = 0; i < m; i++) { biasG[0] += gyr[0][i]; biasG[1] += gyr[1][i]; biasG[2] += gyr[2][i]; }
      biasG[0] /= m; biasG[1] /= m; biasG[2] /= m;
      notes.push('没有满足判据的静止段，陀螺零偏按前 1 s 估计');
    }
  }

  // 姿态：陀螺积分 + 只在合量接近 1 g 时用重力方向纠偏
  const m0 = Math.min(N, Math.round(0.2 * FS));
  const seed = [0, 0, 0];
  for (let i = 0; i < m0; i++) for (let k = 0; k < 3; k++) seed[k] += acc[k][i];
  const q = qFromGravity(seed);
  const vert = new Float64Array(N);
  const gb = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const wx = (gyr[0][i] - biasG[0]) * DEG;
    const wy = (gyr[1][i] - biasG[1]) * DEG;
    const wz = (gyr[2][i] - biasG[2]) * DEG;
    const wm = Math.hypot(wx, wy, wz);
    if (wm > 1e-12) {
      const half = wm * DT / 2, s = Math.sin(half) / wm;
      const nq = qunit(qmul(q, [Math.cos(half), wx * s, wy * s, wz * s]));
      for (let k = 0; k < 4; k++) q[k] = nq[k];
    }
    const an = Math.hypot(acc[0][i], acc[1][i], acc[2][i]);
    const gate = Math.max(0, 1 - Math.abs(an - 1) / GATE_ACC);
    if (gate > 0 && an > 1e-6) {
      const gv = rotInv(q, [0, 0, 1]);
      const ax0 = acc[0][i] / an, ay0 = acc[1][i] / an, az0 = acc[2][i] / an;
      // 轴取 u × g：右乘修正的是 body 系，符号取反才是把估计重力拉向实测方向
      const cx = ay0 * gv[2] - az0 * gv[1];
      const cy = az0 * gv[0] - ax0 * gv[2];
      const cz = ax0 * gv[1] - ay0 * gv[0];
      const s = Math.hypot(cx, cy, cz), c = gv[0] * ax0 + gv[1] * ay0 + gv[2] * az0;
      if (s > 1e-9) {
        const ang = Math.atan2(s, c);
        const alpha = 1 - Math.exp(-gate * DT / TAU_TILT);
        const k = Math.sin(ang * alpha / 2) / s;
        const nq = qunit(qmul(q, [Math.cos(ang * alpha / 2), cx * k, cy * k, cz * k]));
        for (let m = 0; m < 4; m++) q[m] = nq[m];
      }
    }
    rot(q, [acc[0][i], acc[1][i], acc[2][i]]).forEach((v, k) => { gb[k] = v; });
    vert[i] = (gb[2] - 1) * GS;
  }

  let av = lp(vert, FC_A);
  // 静止段的竖直残差按段中心线性串联：去掉的是倾角误差造成的常值泄漏，不是把速度清零
  let vmin = Infinity, vmax = -Infinity;
  if (segs.length) {
    const nodes = segs.map(([a, b]) => tg[(a + b) >> 1]);
    const vals = segs.map(([a, b]) => {
      let s = 0;
      for (let i = a; i <= b; i++) s += av[i];
      return s / (b - a + 1);
    });
    for (let i = 0; i < N; i++) {
      let v;
      if (nodes.length === 1 || tg[i] <= nodes[0]) v = vals[0];
      else if (tg[i] >= nodes[nodes.length - 1]) v = vals[vals.length - 1];
      else {
        let k = 0;
        while (k < nodes.length - 2 && nodes[k + 1] < tg[i]) k++;
        const f = (tg[i] - nodes[k]) / (nodes[k + 1] - nodes[k]);
        v = vals[k] + (vals[k + 1] - vals[k]) * f;
      }
      av[i] -= v;
    }
    for (const v of vals) { if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
  } else {
    vmin = vmax = 0;
    notes.push('这段里没有静止段，零偏与竖直残差只能靠初值');
  }
  av = lp(av, FC_A);

  // 全局速度：起止按零速收尾。只用来找转向点，不直接用它的绝对值
  const T = (N - 1) * DT;
  const gv = new Float64Array(N);
  for (let i = 1; i < N; i++) gv[i] = gv[i - 1] + 0.5 * (av[i] + av[i - 1]) * DT;
  for (let i = 0; i < N; i++) gv[i] -= (i * DT / T) * gv[N - 1];

  // 转向点：竖直速度过零，插值到真实时间
  const cross: number[] = [];
  for (let i = 1; i < N; i++) {
    if ((gv[i - 1] > 0) === (gv[i] > 0) || gv[i] === gv[i - 1]) continue;
    const at = (i - 1 - gv[i - 1] / (gv[i] - gv[i - 1])) * DT;
    if (at < 0.05) continue;
    if (cross.length && at - cross[cross.length - 1] < MIN_PHASE_S) continue;
    cross.push(at);
  }

  const jerkRaw = new Float64Array(N);
  for (let i = 1; i < N - 1; i++) jerkRaw[i] = (av[i + 1] - av[i - 1]) / (2 * DT);
  jerkRaw[0] = jerkRaw[1];
  jerkRaw[N - 1] = jerkRaw[N - 2];
  const jerk = lp(jerkRaw, FC_J);

  const phases: Phase[] = [];
  for (let k = 0; k + 1 < cross.length; k++) {
    const a = Math.max(1, Math.round(cross[k] / DT));
    const b = Math.min(N - 1, Math.round(cross[k + 1] / DT));
    if (b - a < 2) continue;
    // 相位内重新积分并要求两端速度为零 —— 唯一依赖的假设就是转向点竖直速度为零
    const m = b - a + 1, v = new Float64Array(m);
    for (let i = 1; i < m; i++) v[i] = v[i - 1] + 0.5 * (av[a + i] + av[a + i - 1]) * DT;
    const tend = v[m - 1];
    for (let i = 0; i < m; i++) v[i] -= (i / (m - 1)) * tend;
    let disp = 0, pv = 0, pvi = 0, pa = 0, pj = 0;
    for (let i = 1; i < m; i++) disp += 0.5 * (v[i] + v[i - 1]) * DT;
    for (let i = 0; i < m; i++) {
      const s = Math.abs(v[i]);
      if (s > pv) { pv = s; pvi = i; }
      const aa = Math.abs(av[a + i]); if (aa > pa) pa = aa;
      const jj = Math.abs(jerk[a + i]); if (jj > pj) pj = jj;
    }
    phases.push({t0: tg[a], t1: tg[b], dir: disp < 0 ? 'down' : 'up', disp, peakV: pv, peakA: pa, peakJ: pj, peakVAt: tg[a + pvi]});
  }

  const reps: Rep[] = [];
  for (let k = 0; k + 1 < phases.length; k++) {
    const p0 = phases[k], p1 = phases[k + 1];
    if (p0.dir !== 'down' || p1.dir !== 'up') continue;
    const dDown = Math.abs(p0.disp), dUp = Math.abs(p1.disp), depth = (dDown + dUp) / 2;
    // 0.02 m / 0.15 m/s 以下的多半是噪声或微小晃动，不足以算一次动作
    if (depth < 0.02 || Math.max(p0.peakV, p1.peakV) < 0.15) continue;
    const near = Math.round(0.1 * FS);
    const bc = Math.max(0, Math.min(N - 1, Math.round((p1.t0 - tg[0]) / DT)));
    let aB = 0;
    for (let i = Math.max(0, bc - near); i <= Math.min(N - 1, bc + near); i++) aB = Math.max(aB, Math.abs(av[i]));
    reps.push({
      index: reps.length + 1, t0: p0.t0, down: p0.t1 - p0.t0, up: p1.t1 - p1.t0,
      depth, depthDown: dDown, depthUp: dUp, vDown: p0.peakV, vUp: p1.peakV,
      vDownMean: dDown / Math.max(1e-6, p0.t1 - p0.t0), vUpMean: dUp / Math.max(1e-6, p1.t1 - p1.t0),
      turn: p1.peakVAt - p0.peakVAt, aBottom: aB, mismatch: Math.abs(dDown - dUp) / depth
    });
  }
  if (!reps.length) notes.push('没有识别到「下蹲+起身」的完整动作，试试框选一段或换设备');

  // 降采样到绘图够用的密度；速度用同一个累积量取，避免和相位内积分口径混用
  const step = Math.max(1, Math.floor(N / 2400));
  const cn = Math.ceil(N / step);
  const curve = {t: new Float32Array(cn), v: new Float32Array(cn), a: new Float32Array(cn)};
  for (let i = 0, j = 0; i < N; i += step, j++) {
    curve.t[j] = tg[i];
    curve.v[j] = gv[i];
    curve.a[j] = av[i];
  }

  return {
    from: tg[0], to: tg[N - 1], fs: FS, n: N, reps, phases, curve,
    staticSegs: segs.length, biasG, biasSwing: vmax - vmin, notes
  };
}
