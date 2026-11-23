/* 逐次深蹲指标。角度都是踝部 IMU 的旋转量，不推断膝角、躯干角或下蹲深度；
   侧向为水平主轴的残差代理，不是内翻 / 外翻判定。
   wrist 加速度按 g、角速度按原始 dps 计，腕部特征不做零偏扣除。 */
import type {SquatRep} from './squat-core';
import type {SideAngles} from './squat-axis';

/** 与 squat-core 的公共重采样网格一致。 */
export const FEATURE_HZ = 50;

export interface FeatureDef {
  key: string;
  label: string;
  unit: string;
  digits?: number;
  /** 仅用于数据质量，不进入评分特征白名单。 */
  quality?: boolean;
}

export interface RepFeatures {
  values: Record<string, number | null>;
  issues: string[];
}

type Vec3 = [number, number, number];
type Stance = {a: number; b: number; g: Vec3; gMag: number; gyro: Vec3};

const def = (key: string, label: string, unit: string, digits?: number, quality = false): FeatureDef =>
  quality ? {key, label, unit, digits, quality: true} : {key, label, unit, digits};
const sided = (base: string, label: string, unit: string, digits?: number): FeatureDef[] => [
  def(`${base}_left`, `左踝${label}`, unit, digits),
  def(`${base}_right`, `右踝${label}`, unit, digits),
];

/** 特征表的唯一来源：返回对象里每个键都会出现，缺数据时为 null。 */
export const FEATURE_DEFS: FeatureDef[] = [
  def('rep_duration_s', '本次时长', 's', 2),
  def('descent_s', '下降时长', 's', 2),
  def('bottom_s', '蹲底时长', 's', 2),
  def('ascent_s', '上升时长', 's', 2),
  def('descent_ascent_ratio', '下降/上升时长比', '1', 2),
  def('movement_duration_s', '运动时长（下降+上升）', 's', 2),

  ...sided('sagittal_speed_peak_dps', '矢状角速度峰值', '°/s', 1),
  ...sided('sagittal_speed_rms_dps', '矢状角速度均方根', '°/s', 1),
  ...sided('sagittal_excursion_deg', '矢状角运动量（积分）', '°', 1),
  ...sided('sagittal_range_deg', '矢状角峰峰值（积分）', '°', 1),
  ...sided('lateral_speed_peak_dps', '侧向角速度峰值', '°/s', 1),
  ...sided('lateral_speed_rms_dps', '侧向角速度均方根', '°/s', 1),
  ...sided('lateral_excursion_deg', '侧向角运动量（积分）', '°', 1),
  ...sided('lateral_range_deg', '侧向角峰峰值（积分）', '°', 1),
  ...sided('sagittal_axis_confidence', '主旋转轴集中度', '1', 2),
  ...sided('bottom_speed_rms_dps', '蹲底水平角速度均方根', '°/s', 1),
  ...sided('acc_dynamic_rms_g', '动态加速度均方根', 'g', 3),
  ...sided('acc_dynamic_peak_g', '动态加速度峰值', 'g', 3),
  ...sided('acc_magnitude_jerk_rms_g_s', '加速度模变化率均方根', 'g/s', 2),

  def('sagittal_excursion_symmetry', '矢状运动量对称性', '1', 2),
  def('sagittal_speed_symmetry', '矢状角速度对称性', '1', 2),
  def('lateral_excursion_symmetry', '侧向运动量对称性', '1', 2),
  def('acc_dynamic_symmetry', '动态加速度对称性', '1', 2),
  def('sagittal_motion_balance_left', '矢状运动量左占比', '1', 2),
  def('sagittal_range_lr_abs_deg', '左右矢状峰峰值绝对差', '°', 1),
  ...sided('device_pitch_bottom_deg', '设备俯仰蹲底变化', '°', 1),
  ...sided('device_tilt_range_deg', '设备侧倾动作峰峰值', '°', 1),
  def('device_pitch_lr_deg', '双踝设备俯仰变化绝对差', '°', 1),
  def('device_tilt_lr_deg', '双踝设备侧倾变化绝对差', '°', 1),
  def('device_tilt_mean_deg', '双踝设备侧倾平均变化', '°', 1),
  def('device_motion_lr_ratio', '双踝设备角度轨迹相对差', '1', 2),
  def('device_angle_return_deg', '双踝动作起止窗设备角度平均差', '°', 1),

  def('ascent_peak_delay_right_minus_left_s', '起身主轴速度峰时差（右−左）', 's', 2),
  ...sided('descent_end_speed_dps', '下降末段三轴角速度 RMS', '°/s', 1),
  ...sided('bottom_transition_acc_dev_peak_g', '入蹲底附近加速度模偏差峰值', 'g', 3),
  ...sided('squat_descent_lateral_deg', '下降侧向转角（轴估计）', '°', 1),
  ...sided('squat_descent_yaw_deg', '下降绕竖直转角（陀螺积分）', '°', 1),
  ...sided('return_gravity_angle_deg', '前后站立重力夹角', '°', 1),
  ...sided('return_gyro_bias_delta_dps', '前后站立角速度零偏差', '°/s', 1),

  def('coverage_left', '左踝数据覆盖率', '1', 2, true),
  def('coverage_right', '右踝数据覆盖率', '1', 2, true),
  def('coverage_bilateral', '双踝同时覆盖率', '1', 2, true),
  def('coverage_wrist', '腕部数据覆盖率', '1', 2, true),

  def('wrist_tilt_peak_deg', '腕部重力倾角峰值', '°', 1),
  def('wrist_tilt_peak_phase', '腕峰相位（开始 0，结束 1）', '1', 2),
  def('wrist_tilt_bottom_phase', '蹲底中点相位（开始 0，结束 1）', '1', 2),
  def('wrist_tilt_peak_to_bottom_s', '腕峰时刻减蹲底中点（负值为提前）', 's', 2),
  def('wrist_tilt_bottom_deg', '蹲底附近腕部重力倾角', '°', 1),
  def('wrist_tilt_bottom_retention', '蹲底腕角保留率（蹲底角 ÷ 峰值）', '1', 2),
  def('wrist_to_ankle_range_ratio', '腕角峰值 / 双踝主轴摆幅均值', '1', 2),
  def('wrist_gyro_rms_dps', '腕部角速度均方根', '°/s', 1),
  def('wrist_gyro_peak_dps', '腕部角速度峰值', '°/s', 1),
  def('wrist_gyro_path_deg', '腕部角速度路径（积分）', '°', 1),
  def('wrist_acc_dynamic_rms_g', '腕部动态加速度均方根', 'g', 3),
  def('wrist_acc_dynamic_peak_g', '腕部动态加速度峰值', 'g', 3),
  def('wrist_acc_dev_p90_g', '腕部动态加速度 90 分位', 'g', 3),
  def('wrist_acc_magnitude_jerk_rms_g_s', '腕部加速度模变化率均方根', 'g/s', 2),
];

const COVERAGE_WARN = 0.8;
const AXIS_WARN = 0.35;
const AXIS_TRUST = 0.5;
const STANCE_LOOKBACK_S = 2.0;
const STANCE_WINDOW_N = Math.round(0.5 * FEATURE_HZ);
const STANCE_MIN_N = Math.round(0.3 * FEATURE_HZ);
const MIN_SAMPLES = 5;
const MIN_JERK_PAIRS = 3;

const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: ArrayLike<number>) => Math.sqrt(dot3(a, a));
const cross3 = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit3(a: Vec3): Vec3 | null {
  const n = norm3(a);
  return n > 1e-8 && Number.isFinite(n) ? [a[0] / n, a[1] / n, a[2] / n] : null;
}
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), k = (s.length - 1) / 2;
  return k % 1 ? (s[k - .5] + s[k + .5]) / 2 : s[k];
}
function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), k = q * (s.length - 1), i = Math.floor(k), f = k - i;
  return f ? s[i] + f * (s[i + 1] - s[i]) : s[i];
}

function accAt(x: Float64Array, i: number): Vec3 | null {
  const o = i * 6;
  return o + 2 < x.length && Number.isFinite(x[o]) && Number.isFinite(x[o + 1]) && Number.isFinite(x[o + 2])
    ? [x[o], x[o + 1], x[o + 2]] : null;
}
function gyroAt(x: Float64Array, i: number): Vec3 | null {
  const o = i * 6 + 3;
  return o + 2 < x.length && Number.isFinite(x[o]) && Number.isFinite(x[o + 1]) && Number.isFinite(x[o + 2])
    ? [x[o], x[o + 1], x[o + 2]] : null;
}
const all6 = (x: Float64Array, i: number) => accAt(x, i) !== null && gyroAt(x, i) !== null;
const accIn = (x: Float64Array, phase: Int8Array, i: number) => phase[i] >= 0 ? accAt(x, i) : null;
const gyroIn = (x: Float64Array, phase: Int8Array, i: number) => phase[i] >= 0 ? gyroAt(x, i) : null;
const all6In = (x: Float64Array, phase: Int8Array, i: number) => phase[i] >= 0 && all6(x, i);

/** 对称 3×3 的 Jacobi 特征分解；返回按特征值降序的轴。 */
function eigenSym3(m0: number[][]) {
  const a = m0.map(r => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iter = 0; iter < 32; iter++) {
    let p = 0, q = 1, max = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
      if (Math.abs(a[i][j]) > max) {max = Math.abs(a[i][j]); p = i; q = j;}
    const scale = Math.max(1, Math.abs(a[0][0]), Math.abs(a[1][1]), Math.abs(a[2][2]));
    if (max <= 1e-14 * scale) break;
    const apq = a[p][q], ang = .5 * Math.atan2(2 * apq, a[q][q] - a[p][p]);
    const c = Math.cos(ang), s = Math.sin(ang), pp = a[p][p], qq = a[q][q];
    a[p][p] = c * c * pp - 2 * c * s * apq + s * s * qq;
    a[q][q] = s * s * pp + 2 * c * s * apq + c * c * qq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) if (k !== p && k !== q) {
      const u = a[k][p], w = a[k][q];
      a[k][p] = a[p][k] = c * u - s * w;
      a[k][q] = a[q][k] = s * u + c * w;
    }
    for (let k = 0; k < 3; k++) {
      const u = v[k][p], w = v[k][q];
      v[k][p] = c * u - s * w;
      v[k][q] = s * u + c * w;
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: order.map(i => a[i][i]),
    axes: order.map(i => [v[0][i], v[1][i], v[2][i]] as Vec3),
  };
}

/** 只取紧贴本次动作的一段连续站立；缺口或另一次深蹲会截断它，绝不借用更远的一段。 */
function stanceWindow(x: Float64Array, a: number, b: number, toward: 'start' | 'end'): Stance | null {
  const len = b - a + 1;
  if (len < STANCE_MIN_N) return null;
  let best: {score: number; a: number; b: number} | null = null;
  const w = Math.min(STANCE_WINDOW_N, len);
  for (let s = a; s + w - 1 <= b; s++) {
    const gyroMag: number[] = [], accDev: number[] = [];
    let score = 0;
    for (let k = s; k < s + w; k++) {
      const g = norm3(gyroAt(x, k)!), aDev = Math.abs(norm3(accAt(x, k)!) - 1);
      gyroMag.push(g); accDev.push(aDev); score += g + 30 * aDev;
    }
    score /= w;
    const medG = median(gyroMag)!, p90G = quantile(gyroMag, .9)!, medA = median(accDev)!;
    if (medG > 20 || p90G > 35 || medA > .12) continue;
    const better = !best || score < best.score - 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && (toward === 'end' ? s > best.a : s < best.a));
    if (better) best = {score, a: s, b: s + w - 1};
  }
  if (!best) return null;
  let ax = 0, ay = 0, az = 0, gx = 0, gy = 0, gz = 0;
  const mags: number[] = [];
  for (let i = best.a; i <= best.b; i++) {
    const acc = accAt(x, i)!, gyro = gyroAt(x, i)!;
    ax += acc[0]; ay += acc[1]; az += acc[2]; gx += gyro[0]; gy += gyro[1]; gz += gyro[2];
    mags.push(norm3(acc));
  }
  const count = best.b - best.a + 1;
  const g = unit3([ax / count, ay / count, az / count]);
  const gMag = median(mags)!;
  return g && Number.isFinite(gMag) && gMag > 0
    ? {a: best.a, b: best.b, g, gMag, gyro: [gx / count, gy / count, gz / count]} : null;
}

function findStance(x: Float64Array, phase: Int8Array, from: number, to: number, toward: 'start' | 'end'): Stance | null {
  const n = phase.length;
  from = Math.max(0, from);
  to = Math.min(n - 1, to);
  const valid = (i: number) => phase[i] === 0 && all6(x, i);
  if (toward === 'end') {
    if (to < from || !valid(to)) return null;
    let a = to;
    while (a > from && valid(a - 1)) a--;
    return stanceWindow(x, a, to, 'end');
  }
  if (from > to || !valid(from)) return null;
  let b = from;
  while (b < to && valid(b + 1)) b++;
  return stanceWindow(x, from, b, 'start');
}

function sampleRange(start: number, t0: number, t1: number, n: number, includeEnd: boolean): [number, number] | null {
  let a = Math.max(0, Math.ceil((t0 - start) * FEATURE_HZ - 1e-6));
  let b = includeEnd
    ? Math.floor((t1 - start) * FEATURE_HZ + 1e-6)
    : Math.ceil((t1 - start) * FEATURE_HZ - 1e-6) - 1;
  a = Math.min(a, n - 1);
  b = Math.min(b, n - 1);
  return b >= a ? [a, b] : null;
}

const symmetry = (l: number | null, r: number | null) =>
  l != null && r != null && l + r > 0 ? 1 - Math.abs(l - r) / (l + r) : null;

function deviceMotion(axes: [Float64Array,Float64Array], a: number, b: number, bottom: number) {
  const traces=axes.map(axis=>{
    const trace=Array.from(axis.subarray(a,b+1));
    if(trace.length<MIN_SAMPLES || !trace.every(Number.isFinite)) return null;
    let previous=trace[0], delta=0;
    return trace.map(value=>{
      delta+=((value-previous+540)%360)-180;previous=value;return delta;
    });
  });
  if(traces.some(t=>!t)) return null;
  const half=Math.min(11,Math.round(.32*Math.min(bottom-a,b-bottom))), width=Math.min(8,Math.floor((b-a)/4));
  const start=traces.map(t=>median(t.slice(0,width+1))), end=traces.map(t=>median(t.slice(-width-1)));
  const ref=start.map((v,i)=>(v+end[i])/2);
  const change=traces.map((t,i)=>Math.abs(median(t.slice(bottom-a-half,bottom-a+half+1))-ref[i]));
  const magnitude=traces[0].map((v,i)=>Math.hypot(v-ref[0],traces[1][i]-ref[1]));
  return {change,magnitude,range:Math.max(...traces[1])-Math.min(...traces[1]),ret:Math.hypot(end[0]-start[0],end[1]-start[1])};
}

function wristTilt(x: Float64Array, phase: Int8Array, pre: Stance, a: number, b: number) {
  const alpha = 1 - Math.exp(-1 / (FEATURE_HZ * .15));
  const trace: number[] = [];
  let lp = scale3(pre.g, pre.gMag);
  for (let i = pre.b + 1; i <= b; i++) {
    const acc = accIn(x, phase, i);
    if (!acc) return null;
    lp = add3(lp, scale3(sub3(acc, lp), alpha));
    const g = unit3(lp);
    if (!g) return null;
    if (i >= a) trace.push(Math.atan2(norm3(cross3(pre.g, g)), dot3(pre.g, g)) * 180 / Math.PI);
  }
  return trace;
}

export function extractSquatFeatures(
  start: number,
  phase: Int8Array,
  ankles: [Float64Array, Float64Array],
  reps: SquatRep[],
  wrist?: Float64Array,
  deviceAngles?: ([Float64Array,Float64Array] | undefined)[],
  repAngles?: SideAngles[],
): RepFeatures[] {
  const n = phase.length;
  const empty = () => Object.fromEntries(FEATURE_DEFS.map(d => [d.key, null])) as Record<string, number | null>;
  const frame = (t: number) => Math.round((t - start) * FEATURE_HZ);

  return reps.map((rep, ri) => {
    const values = empty();
    const issues: string[] = [];
    const issue = (s: string) => {if (!issues.includes(s)) issues.push(s);};
    const put = (key: string, v: number | null | undefined) => {
      if (v != null && Number.isFinite(v)) values[key] = Object.is(v, -0) ? 0 : v;
    };

    const [t0, t1, t2, t3] = rep;
    if (![t0, t1, t2, t3].every(Number.isFinite) || t3 <= t0 || t1 < t0 || t2 < t1 || t3 < t2) {
      issue('无效的深蹲边界');
      return {values, issues};
    }

    const descent = t1 - t0, bottom = t2 - t1, ascent = t3 - t2;
    put('rep_duration_s', t3 - t0);
    put('descent_s', descent);
    put('bottom_s', bottom);
    put('ascent_s', ascent);
    put('descent_ascent_ratio', ascent > 1e-6 ? descent / ascent : null);
    put('movement_duration_s', descent + ascent);

    const full = sampleRange(start, t0, t3, n, true);
    const descRange = sampleRange(start, t0, t1, n, false);
    const bottomRange = sampleRange(start, t1, t2, n, false);
    const ascRange = sampleRange(start, t2, t3, n, true);

    if (!full) {
      issue('深蹲边界超出数据范围');
      return {values, issues};
    }

    const total = full[1] - full[0] + 1;
    let validL = 0, validR = 0, validBoth = 0;
    for (let i = full[0]; i <= full[1]; i++) {
      const l = all6In(ankles[0], phase, i), r = all6In(ankles[1], phase, i);
      validL += Number(l); validR += Number(r); validBoth += Number(l && r);
    }
    put('coverage_left', validL / total);
    put('coverage_right', validR / total);
    put('coverage_bilateral', validBoth / total);
    if (values.coverage_left! < COVERAGE_WARN) issue('左踝数据覆盖不足');
    if (values.coverage_right! < COVERAGE_WARN) issue('右踝数据覆盖不足');
    if (values.coverage_bilateral! < COVERAGE_WARN && values.coverage_left! >= COVERAGE_WARN && values.coverage_right! >= COVERAGE_WARN)
      issue('双踝同步覆盖不足');

    if(deviceAngles && validBoth===total) {
      const low=frame((t1+t2)/2), fits=deviceAngles.map(axes=>axes ? deviceMotion(axes,full[0],full[1],low) : null);
      const [l,r]=fits;
      for(const [side,fit] of [['left',l],['right',r]] as const) if(fit) {
        put(`device_pitch_bottom_deg_${side}`,fit.change[0]);
        put(`device_tilt_range_deg_${side}`,fit.range);
      }
      if(l && r) {
        put('device_pitch_lr_deg',Math.abs(l.change[0]-r.change[0]));
        put('device_tilt_lr_deg',Math.abs(l.change[1]-r.change[1]));
        put('device_tilt_mean_deg',(l.change[1]+r.change[1])/2);
        put('device_angle_return_deg',(l.ret+r.ret)/2);
        const motion=l.magnitude.map((v,i)=>(v+r.magnitude[i])/2);
        const level=quantile(motion,.9)*.4;
        put('device_motion_lr_ratio',median(motion.flatMap((v,i)=>v>=level ? [Math.abs(l.magnitude[i]-r.magnitude[i])/Math.max(5,v)] : [])));
      }
    }

    if (wrist) {
      let valid = 0;
      for (let i = full[0]; i <= full[1]; i++) valid += Number(all6In(wrist, phase, i));
      put('coverage_wrist', valid / total);
      if (values.coverage_wrist! < COVERAGE_WARN) issue('腕部数据覆盖不足');
    }

    const prevEnd = ri > 0 && Number.isFinite(reps[ri - 1][3]) ? frame(reps[ri - 1][3]) + 1 : 0;
    const nextStart = ri + 1 < reps.length && Number.isFinite(reps[ri + 1][0]) ? frame(reps[ri + 1][0]) - 1 : n - 1;
    const beforeFrom = Math.max(0, frame(t0 - STANCE_LOOKBACK_S), prevEnd);
    const beforeTo = Math.min(n - 1, frame(t0) - 1);
    const afterFrom = Math.max(0, frame(t3) + 1);
    const afterTo = Math.min(n - 1, frame(t3 + STANCE_LOOKBACK_S), nextStart);

    const sides = [
      {key: 'left', idx: 0, label: '左踝'},
      {key: 'right', idx: 1, label: '右踝'},
    ] as const;

    const movement: [number, number][] = [];
    if (descRange) movement.push(descRange);
    if (ascRange) movement.push(ascRange);
    const movementRanges = movement.length ? movement : [full];
    const ascentPeaks = [NaN, NaN];
    const descentEnd = sampleRange(start, Math.max(t0, t1 - .2), t1, n, false);
    const transition = sampleRange(start, Math.max(t0, t1 - .15), Math.min(t3, t1 + .15), n, true);

    for (const {key, idx, label} of sides) {
      const x = ankles[idx];
      const validSide = idx === 0 ? validL : validR;
      const pre = findStance(x, phase, beforeFrom, beforeTo, 'end');
      const post = findStance(x, phase, afterFrom, afterTo, 'start');
      if (!pre && !post) issue(`${label}缺少相邻站立基线`);
      else if (!pre) issue(`${label}缺少动作前站立基线`);
      else if (!post) issue(`${label}缺少动作后站立基线`);

      if (pre && post) {
        put(`return_gravity_angle_deg_${key}`,
          Math.acos(Math.min(1, Math.max(-1, dot3(pre.g, post.g)))) * 180 / Math.PI);
        put(`return_gyro_bias_delta_dps_${key}`, norm3(sub3(pre.gyro, post.gyro)));
      }

      const base = pre ?? post;
      const g = pre?.g ?? post?.g ?? null;
      const bias: Vec3 = pre && post
        ? scale3(add3(pre.gyro, post.gyro), .5)
        : base ? base.gyro : [0, 0, 0];
      const gMag = base?.gMag ?? 1;
      const side = repAngles?.[idx];
      const rotation = side?.ok && validSide === total ? side.reps?.[ri] : null;
      if (side?.conf !== 'lo') put(`squat_descent_lateral_deg_${key}`, rotation?.ml);
      put(`squat_descent_yaw_deg_${key}`, rotation?.yaw);

      if (descentEnd && base) {
        const [a, b] = descentEnd;
        let count = 0, sum = 0;
        for (let i = a; i <= b; i++) {
          const gyro = gyroIn(x, phase, i);
          if (!gyro) break;
          const w = sub3(gyro, bias); sum += dot3(w, w); count++;
        }
        if (count >= MIN_SAMPLES && count === b - a + 1) put(`descent_end_speed_dps_${key}`, Math.sqrt(sum / count));
      }
      if (transition) {
        const [a, b] = transition;
        let count = 0, peak = 0;
        for (let i = a; i <= b; i++) {
          const acc = accIn(x, phase, i);
          if (!acc) break;
          peak = Math.max(peak, Math.abs(norm3(acc) - gMag)); count++;
        }
        if (count >= MIN_SAMPLES && count === b - a + 1) put(`bottom_transition_acc_dev_peak_g_${key}`, peak);
      }

      let axis: Vec3 | null = null;
      if (g) {
        const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        let count = 0;
        for (const [a, b] of movementRanges) for (let i = a; i <= b; i++) {
          const raw = gyroIn(x, phase, i);
          if (!raw) continue;
          const w = sub3(raw, bias), proj = dot3(w, g);
          const h = [w[0] - proj * g[0], w[1] - proj * g[1], w[2] - proj * g[2]];
          for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += h[r] * h[c];
          count++;
        }
        if (count >= MIN_SAMPLES) {
          const e = eigenSym3(cov), l1 = e.values[0], l2 = e.values[1];
          if (l1 > 0 && l2 >= 0 && l1 + l2 > 0) {
            const conf = Math.max(0, Math.min(1, (l1 - l2) / (l1 + l2)));
            const u = unit3(e.axes[0]);
            // 与主轴相关的侧向分量归入矢状；只有正交剩余部分记为侧向。
            if (u && Math.abs(dot3(u, g)) < .99) {
              axis = unit3(sub3(u, scale3(g, dot3(u, g))));
              if (axis) put(`sagittal_axis_confidence_${key}`, conf);
            }
          }
        }
      }

      if (axis) {
        let sum = 0, count = 0;
        if (descRange) for (let i = descRange[0]; i <= descRange[1]; i++) {
          const raw = gyroIn(x, phase, i);
          if (raw) {sum += dot3(sub3(raw, bias), axis); count++;}
        }
        if (count >= 3 && Math.abs(sum) > 1e-9) {
          if (sum < 0) axis = scale3(axis, -1);
        } else {
          let peak = 0, signed = 0;
          for (const [a, b] of movementRanges) for (let i = a; i <= b; i++) {
            const raw = gyroIn(x, phase, i);
            if (!raw) continue;
            const p = dot3(sub3(raw, bias), axis);
            if (Math.abs(p) > Math.abs(peak)) {peak = p; signed = p;}
          }
          if (signed < 0) axis = scale3(axis, -1);
        }
      }

      if (axis && g) {
        const u = axis;
        if (ascRange && validSide === total && values[`sagittal_axis_confidence_${key}`]! >= AXIS_TRUST) {
          const [a, b] = ascRange;
          let peak = 5;
          for (let i = a + 2; i <= b - 2; i++) {
            let sum = 0;
            for (let j = i - 2; j <= i + 2; j++) sum += dot3(sub3(gyroIn(x, phase, j)!, bias), u);
            const speed = Math.abs(sum / 5);
            if (speed > peak + 1e-9) {peak = speed; ascentPeaks[idx] = i;}
          }
        }
        let count = 0, peakS = 0, sumS2 = 0, excursionS = 0, peakL = 0, sumL2 = 0, excursionL = 0;
        for (const [a, b] of movementRanges) for (let i = a; i <= b; i++) {
          const raw = gyroIn(x, phase, i);
          if (!raw) continue;
          const w = sub3(raw, bias), proj = dot3(w, g);
          const h: Vec3 = [w[0] - proj * g[0], w[1] - proj * g[1], w[2] - proj * g[2]];
          const s = dot3(h, u), lat = norm3(sub3(h, scale3(u, s)));
          peakS = Math.max(peakS, Math.abs(s)); sumS2 += s * s; excursionS += Math.abs(s) / FEATURE_HZ;
          peakL = Math.max(peakL, lat); sumL2 += lat * lat; excursionL += lat / FEATURE_HZ;
          count++;
        }
        if (count >= MIN_SAMPLES) {
          put(`sagittal_speed_peak_dps_${key}`, peakS);
          put(`sagittal_speed_rms_dps_${key}`, Math.sqrt(sumS2 / count));
          put(`sagittal_excursion_deg_${key}`, excursionS);
          put(`lateral_speed_peak_dps_${key}`, peakL);
          put(`lateral_speed_rms_dps_${key}`, Math.sqrt(sumL2 / count));
          put(`lateral_excursion_deg_${key}`, excursionL);
        }

        let rangeCount = 0, cum = 0, lo = 0, hi = 0, prev = -1;
        for (let i = full[0]; i <= full[1]; i++) {
          const raw = gyroIn(x, phase, i);
          if (!raw) {prev = -1; continue;}
          const w = sub3(raw, bias), proj = dot3(w, g);
          const h: Vec3 = [w[0] - proj * g[0], w[1] - proj * g[1], w[2] - proj * g[2]];
          if (prev === i - 1) cum += dot3(h, u) / FEATURE_HZ;
          lo = Math.min(lo, cum); hi = Math.max(hi, cum); rangeCount++; prev = i;
        }
        if (rangeCount >= MIN_SAMPLES) put(`sagittal_range_deg_${key}`, hi - lo);

        // 侧向峰峰值只在整段连续且主轴可信时给出；符号本身不代表内翻 / 外翻。
        const conf = values[`sagittal_axis_confidence_${key}`];
        if (validSide === total && conf != null && conf >= AXIS_TRUST) {
          const v = unit3(cross3(g, u));
          if (v) {
            let lateralCount = 0, cumL = 0, loL = 0, hiL = 0, prevL = -1;
            for (let i = full[0]; i <= full[1]; i++) {
              const raw = gyroIn(x, phase, i);
              if (!raw) {prevL = -1; continue;}
              const w = sub3(raw, bias), proj = dot3(w, g);
              const h: Vec3 = [w[0] - proj * g[0], w[1] - proj * g[1], w[2] - proj * g[2]];
              if (prevL === i - 1) cumL += dot3(h, v) / FEATURE_HZ;
              loL = Math.min(loL, cumL); hiL = Math.max(hiL, cumL); lateralCount++; prevL = i;
            }
            if (lateralCount >= MIN_SAMPLES) put(`lateral_range_deg_${key}`, hiL - loL);
          }
        }
        if (values[`sagittal_axis_confidence_${key}`] != null && values[`sagittal_axis_confidence_${key}`]! < AXIS_WARN)
          issue(`${label}主旋转轴不集中`);
      }

      if (g && bottomRange) {
        let count = 0, sum2 = 0;
        for (let i = bottomRange[0]; i <= bottomRange[1]; i++) {
          const raw = gyroIn(x, phase, i);
          if (!raw) continue;
          const w = sub3(raw, bias), proj = dot3(w, g);
          const h = [w[0] - proj * g[0], w[1] - proj * g[1], w[2] - proj * g[2]];
          sum2 += dot3(h, h); count++;
        }
        if (count >= MIN_SAMPLES) put(`bottom_speed_rms_dps_${key}`, Math.sqrt(sum2 / count));
      }

      let count = 0, sum2 = 0, peak = 0;
      for (const [a, b] of movementRanges) for (let i = a; i <= b; i++) {
        const acc = accIn(x, phase, i);
        if (!acc) continue;
        const dev = Math.abs(norm3(acc) - gMag);
        sum2 += dev * dev; peak = Math.max(peak, dev); count++;
      }
      if (count >= MIN_SAMPLES) {
        put(`acc_dynamic_rms_g_${key}`, Math.sqrt(sum2 / count));
        put(`acc_dynamic_peak_g_${key}`, peak);
      }

      let pairs = 0, jerk2 = 0, prev: number | null = null;
      for (let i = full[0]; i <= full[1]; i++) {
        const acc = accIn(x, phase, i);
        if (!acc) {prev = null; continue;}
        const mag = norm3(acc);
        if (prev != null) {const j = (mag - prev) * FEATURE_HZ; jerk2 += j * j; pairs++;}
        prev = mag;
      }
      if (pairs >= MIN_JERK_PAIRS) put(`acc_magnitude_jerk_rms_g_s_${key}`, Math.sqrt(jerk2 / pairs));
    }

    put('sagittal_excursion_symmetry', symmetry(values.sagittal_excursion_deg_left, values.sagittal_excursion_deg_right));
    put('sagittal_speed_symmetry', symmetry(values.sagittal_speed_rms_dps_left, values.sagittal_speed_rms_dps_right));
    put('lateral_excursion_symmetry', symmetry(values.lateral_excursion_deg_left, values.lateral_excursion_deg_right));
    put('acc_dynamic_symmetry', symmetry(values.acc_dynamic_rms_g_left, values.acc_dynamic_rms_g_right));
    const sl = values.sagittal_excursion_deg_left, sr = values.sagittal_excursion_deg_right;
    if (sl != null && sr != null && sl + sr > 0) put('sagittal_motion_balance_left', sl / (sl + sr));
    const rl = values.sagittal_range_deg_left, rr = values.sagittal_range_deg_right;
    if (rl != null && rr != null) put('sagittal_range_lr_abs_deg', Math.abs(rl - rr));

    put('ascent_peak_delay_right_minus_left_s', (ascentPeaks[1] - ascentPeaks[0]) / FEATURE_HZ);

    if (wrist) {
      const pre = findStance(wrist, phase, beforeFrom, beforeTo, 'end');
      if (!pre) issue('腕部缺少本次蹲前站立参考');
      else {
        const [a, b] = full, trace = wristTilt(wrist, phase, pre, a, b);
        if (!trace || trace.length < MIN_SAMPLES) issue('腕部倾角需要从蹲前到起身连续的数据');
        else {
          const peakIndex = trace.reduce((best, v, i) => v > trace[best] ? i : best, 0);
          const peak = trace[peakIndex], peakTime = start + (a + peakIndex) / FEATURE_HZ;
          const middle = (t1 + t2) / 2, middleIndex = frame(middle) - a;
          const atBottom = median(trace.slice(Math.max(0, middleIndex - 3), middleIndex + 4));
          put('wrist_tilt_peak_deg', peak);
          put('wrist_tilt_bottom_deg', atBottom);
          put('wrist_tilt_bottom_phase', (middle - t0) / (t3 - t0));
          // 小摆幅时峰值时刻与比值由噪声主导。
          if (peak >= 3) {
            put('wrist_tilt_peak_phase', Math.max(0, Math.min(1, (peakTime - t0) / (t3 - t0))));
            put('wrist_tilt_peak_to_bottom_s', peakTime - middle);
            put('wrist_tilt_bottom_retention', atBottom / peak);
          }
          const ankleMean = (rl + rr) / 2;
          if (validBoth === total && rl != null && rr != null && ankleMean >= 5 && values.sagittal_axis_confidence_left >= AXIS_TRUST &&
              values.sagittal_axis_confidence_right >= AXIS_TRUST) put('wrist_to_ankle_range_ratio', peak / ankleMean);
        }
      }
      let nG = 0, g2 = 0, gPeak = 0, gPath = 0, nA = 0, a2 = 0, aPeak = 0, pairs = 0, jerk2 = 0, prev: number | null = null;
      const devs: number[] = [];
      for (let i = full[0]; i <= full[1]; i++) {
        const g = gyroIn(wrist, phase, i), acc = accIn(wrist, phase, i);
        if (g) {const m = norm3(g); g2 += m * m; gPeak = Math.max(gPeak, m); gPath += m / FEATURE_HZ; nG++;}
        if (acc) {
          const dev = Math.abs(norm3(acc) - 1);
          a2 += dev * dev; aPeak = Math.max(aPeak, dev); devs.push(dev); nA++;
          const mag = norm3(acc);
          if (prev != null) {const j = (mag - prev) * FEATURE_HZ; jerk2 += j * j; pairs++;}
          prev = mag;
        } else prev = null;
      }
      if (nG >= MIN_SAMPLES) {
        put('wrist_gyro_rms_dps', Math.sqrt(g2 / nG));
        put('wrist_gyro_peak_dps', gPeak);
        put('wrist_gyro_path_deg', gPath);
      }
      if (nA >= MIN_SAMPLES) {
        put('wrist_acc_dynamic_rms_g', Math.sqrt(a2 / nA));
        put('wrist_acc_dynamic_peak_g', aPeak);
        put('wrist_acc_dev_p90_g', quantile(devs, .9));
      }
      if (pairs >= MIN_JERK_PAIRS) put('wrist_acc_magnitude_jerk_rms_g_s', Math.sqrt(jerk2 / pairs));
    }

    return {values, issues};
  });
}
