/* 逐次三向角：每侧自估竖直 / 左右 / 前后三轴，把角速度积分投影上去。
   只算相对转角 —— 安装零位在差分里消掉，所以不估安装角，也不做几何标定。 */

import {cross, dot, eig3, unit} from './axis/math.ts';

type Vec = number[];
const R2D = 180/Math.PI, D2R = Math.PI/180;
const STILL_SD = .04, STILL_DEV = .08;     // 与轴向页 auto 判据同源
const STILL_GYRO = 10;                      // 静止窗的补偿角速度均值上限（°/s）：只看 |a| 会把缓慢转动也算成静止
const STILL_MIN = .30;                      // 单段静止最短时长（s）
const UP_TOL = 8;                           // 多段静止归入同一簇的夹角上限（°）
const MOTION = 12;                          // 计入主轴的角速度下限（°/s）
const CAP = 1.6;                            // 主轴加权上限 = CAP × 中位角速度，防单帧尖峰独占主轴

export type SquatAxesInput = {t: ArrayLike<number>; values: ArrayLike<number>; heading?: ArrayLike<number>};

export type RepAngle = {
  i: number; ap: number; ml: number; yaw: number;
  back: number; hold: number;
  heading: number; headingApp: number | null;
};

// 每次从下降起点归零。时间为会话秒，deg 按帧交错存前后倾、左右倾和绕竖直转角。
// linked[i] 为 1 才能把 i-1 和 i 连起来（失效帧、长间隔不连线）。
export type SquatAngleTrace = {t: Float64Array; deg: Float32Array; linked: Uint8Array};

export type SideAngles = {
  ok: boolean; reason?: string;
  up?: Vec; lateral?: Vec; forward?: Vec;
  upSource?: 'quiet'|'stand'; quietDur?: number; upSpread?: number;
  ratio?: number; spread?: number; tilt?: number; axisSource?: 'flexion'|'net-turn';
  net?: {n: number; coh: number; gap: number};
  bias?: Vec; biasNorm?: number; conf?: 'hi'|'mid'|'lo';
  reps?: RepAngle[]; traces?: SquatAngleTrace[]; warns?: string[];
};

const angDeg = (a: Vec, b: Vec) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * R2D;
const zeros = () => [[0,0,0],[0,0,0],[0,0,0]];
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a-b); return s[s.length >> 1]; };

// reps 来自深蹲页的分段：每项是 [开始下降, 进入蹲底, 开始上升, 结束上升] 的绝对时刻（s），
// shift 把本侧原生时间戳换算到同一绝对时间轴（ankleTimebase 的 shift + 预测范围 offset）。
export function squatSideAngles(s: SquatAxesInput, shift: number, reps: readonly (readonly number[])[]): SideAngles {
  const n = s.t.length, v = s.values;
  if (!reps.length) return {ok: false, reason: '没有可用的深蹲分段。'};
  if (n < 40 || v.length < n*6) return {ok: false, reason: '单踝有效帧不足。'};
  const tt = new Float64Array(n), good = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    tt[k] = s.t[k]/1e6 + shift;
    good[k] = Number.isFinite(tt[k]) && [0,1,2,3,4,5].every(j => Number.isFinite(v[k*6+j]))
      && Math.max(Math.abs(v[k*6+3]), Math.abs(v[k*6+4]), Math.abs(v[k*6+5])) < 1995 ? 1 : 0;
  }
  const span = tt[n-1] - tt[0];
  if (!(span > 0)) return {ok: false, reason: '时间轴异常，无法积分。'};
  const fs = (n-1)/span;
  if (!(fs > 10)) return {ok: false, reason: '采样率过低，无法积分角速度。'};

  const idx = (t: number) => {
    let k = 0;
    while (k < n-1 && !(tt[k] >= t)) k++;
    return k;
  };
  const meanAcc = (a: number, b: number): Vec => {
    let x = 0, y = 0, z = 0, c = 0;
    for (let k = a; k <= b; k++) if (good[k]) { x += v[k*6]; y += v[k*6+1]; z += v[k*6+2]; c++; }
    return c ? [x/c, y/c, z/c] : [0, 0, 0];
  };

  // 静止段：只看加速度模长的滑窗离散，与轴向页一致（角速度阈值会把零偏大的器件全判掉）
  const half = Math.max(1, Math.round(.1*fs));
  const cN = new Int32Array(n+1), cS = new Float64Array(n+1), cQ = new Float64Array(n+1), cG = new Float64Array(n+1);
  for (let k = 0; k < n; k++) {
    const ok = good[k] ? 1 : 0;
    const m = ok ? Math.hypot(v[k*6], v[k*6+1], v[k*6+2]) : 0;
    const g = ok ? Math.hypot(v[k*6+3], v[k*6+4], v[k*6+5]) : 0;
    cN[k+1] = cN[k] + ok; cS[k+1] = cS[k] + m*ok; cQ[k+1] = cQ[k] + m*m*ok; cG[k+1] = cG[k] + g*ok;
  }
  const still = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k-half), b = Math.min(n, k+half+1), cnt = cN[b] - cN[a];
    if (cnt < (b-a)*.7) continue;
    const mu = (cS[b]-cS[a])/cnt, sd = Math.sqrt(Math.max(0, (cQ[b]-cQ[a])/cnt - mu*mu));
    if (sd < STILL_SD && Math.abs(mu-1) < STILL_DEV && (cG[b]-cG[a])/cnt < STILL_GYRO) still[k] = 1;
  }
  const minLen = Math.max(3, Math.round(STILL_MIN*fs));
  const segs: [number, number][] = [];
  let stillN = 0;
  for (let k = 0; k < n;) {
    if (!still[k]) { k++; continue; }
    let j = k;
    while (j+1 < n && still[j+1]) j++;
    stillN += j-k+1;
    if (j-k+1 >= minLen) segs.push([k, j]);
    k = j+1;
  }

  // 竖直轴：多段静止取最密的一簇；没有静止段时退回「每次蹲前的站立瞬间」。
  // 深蹲站在原地的包这两种都拿得到；跳跃包会失败，不硬凑。
  let upSource: 'quiet'|'stand' = 'quiet';
  const cands: {a: number; b: number; u: Vec}[] = segs.map(([a, b]) => ({a, b, u: unit(meanAcc(a, b))}));
  const standSegs: [number, number][] = [];
  if (!cands.length) {
    upSource = 'stand';
    for (const r of reps) {
      const a = idx(r[0]-.30), b = idx(r[0]-.04);
      if (b-a < Math.max(3, Math.round(.05*fs))) continue;
      const m = meanAcc(a, b);
      if (Math.abs(Math.hypot(m[0], m[1], m[2]) - 1) > .12) continue;
      cands.push({a, b, u: unit(m)}); standSegs.push([a, b]);
    }
  }
  if (!cands.length) return {ok: false, reason: '找不到站立静止参考，定不出竖直轴；深蹲前后需要有短暂站立。'};
  // 蹲底那几帧也是静止的，但加速度已经跟着小腿倾过去，与站立时差二十几度 —— 两者都垂直于屈伸轴，
  // 靠几何分不开，只能按时长占比取：站立段总比蹲底长，取时长最多的那一簇。
  const clusters: {u: Vec; w: number}[] = [];
  for (const c of [...cands].sort((x, y) => (y.b-y.a)-(x.b-x.a))) {
    const hit = clusters.find(k => angDeg(k.u, c.u) <= UP_TOL);
    if (hit) hit.w += c.b-c.a+1; else clusters.push({u: c.u, w: c.b-c.a+1});
  }
  clusters.sort((x, y) => y.w-x.w);
  const members = cands.filter(c => angDeg(c.u, clusters[0].u) <= UP_TOL);
  const up = unit(members.reduce((acc, c) => {
    const w = c.b-c.a+1;
    return [acc[0]+c.u[0]*w, acc[1]+c.u[1]*w, acc[2]+c.u[2]*w];
  }, [0, 0, 0]));
  const upSpread = Math.max(...members.map(c => angDeg(c.u, up)));

  // 补偿后的残差零偏：静止帧各轴中位数，积分前扣掉
  const biasSegs: [number, number][] = segs.length ? segs : standSegs;
  const bias: Vec = [0,1,2].map(j => {
    const col: number[] = [];
    for (const [a, b] of biasSegs) for (let k = a; k <= b; k++) if (good[k]) col.push(v[k*6+3+j]);
    return col.length ? median(col) : 0;
  });
  const biasNorm = Math.hypot(bias[0], bias[1], bias[2]);
  const gyrC = (k: number): Vec => [v[k*6+3]-bias[0], v[k*6+4]-bias[1], v[k*6+5]-bias[2]];

  // 左右轴：深蹲段角速度去掉竖直分量后的第一主成分。
  const axisOf = (a: number, b: number) => {
    const ws: Vec[] = [], ms: number[] = [];
    for (let k = a; k <= b; k++) {
      if (!good[k]) continue;
      const w = gyrC(k), m = Math.hypot(w[0], w[1], w[2]);
      if (m >= MOTION) { ws.push(w); ms.push(m); }
    }
    if (ws.length < Math.max(8, Math.round(.12*fs))) return null;
    const cap = CAP*median(ms), C = zeros();
    for (let i = 0; i < ws.length; i++) {
      const w = Math.min(1, cap/ms[i])**2, z = dot(ws[i], up);
      const p = [ws[i][0]-up[0]*z, ws[i][1]-up[1]*z, ws[i][2]-up[2]*z];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += w*p[r]*p[c];
    }
    const e = eig3(C), sum = e.val[0]+e.val[1]+e.val[2];
    return {C, vec: unit(e.vec[2]), ratio: sum > 0 ? e.val[2]/sum : 0};
  };
  const perRep = reps.map(r => axisOf(Math.max(0, idx(r[0]-.05)), Math.min(n-1, idx(r[3]+.05))));
  const fits = perRep.filter(x => x);
  if (!fits.length) return {ok: false, reason: '深蹲段角速度太弱，定不出左右轴。'};
  const Csum = zeros();
  for (const f of fits) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) Csum[r][c] += f.C[r][c];
  const e = eig3(Csum), esum = e.val[0]+e.val[1]+e.val[2];
  const raw = e.vec[2];
  const tilt = 90 - angDeg(raw, up);          // 主轴离水平面的偏差
  const flat = [raw[0]-up[0]*dot(raw, up), raw[1]-up[1]*dot(raw, up), raw[2]-up[2]*dot(raw, up)];
  if (!(Math.hypot(flat[0], flat[1], flat[2]) > .5)) return {ok: false, reason: '主轴几乎沿竖直方向，这段动作不是屈伸。'};
  let lateral = unit(flat);
  let forward = unit(cross(up, lateral));
  const ratio = esum > 0 ? e.val[2]/esum : 0;
  const spread = Math.max(...fits.map(f => {
    const a = angDeg(f.vec, lateral);
    return a > 90 ? 180-a : a;               // 主成分本身有 ±，只比方向
  }));
  let axisSource: 'flexion'|'net-turn' = 'flexion';

  const interval = (k: number): number => {
    const dt = tt[k+1]-tt[k];
    return good[k] && good[k+1] && dt > 0 && dt <= .2 ? dt : 0;
  };
  const integral = (a: number, b: number, ax: Vec): number => {
    let sum = 0;
    for (let k = a; k < b; k++) {
      const dt = interval(k);
      if (dt) sum += dot(gyrC(k), ax)*dt;
    }
    return sum;
  };
  const netVec = (a: number, b: number): Vec => {
    const out = [0, 0, 0];
    for (let k = a; k < b; k++) {
      const dt = interval(k);
      if (!dt) continue;
      const w = gyrC(k);
      out[0] += w[0]*dt; out[1] += w[1]*dt; out[2] += w[2]*dt;
    }
    const z = dot(out, up);
    return [out[0]-up[0]*z, out[1]-up[1]*z, out[2]-up[2]*z];
  };

  // 身体转过之后，前后/左右方向跟着转：按该次起点的累计航向把轴一起转过去，
  // 否则一次转身就会让后面的深蹲把屈伸分到「左右」上。
  const rotUp = (v: Vec, deg: number): Vec => {
    const c = Math.cos(deg*D2R), s = Math.sin(deg*D2R), kv = cross(up, v), kd = dot(up, v);
    return [v[0]*c + kv[0]*s + up[0]*kd*(1-c), v[1]*c + kv[1]*s + up[1]*kd*(1-c), v[2]*c + kv[2]*s + up[2]*kd*(1-c)];
  };
  const headingAt = (k: number): number => {
    const h = s.heading;
    if (!h || k >= h.length) return NaN;
    if (Number.isFinite(h[k])) return h[k];
    for (let d = 1; d <= 100; d++) {
      if (k-d >= 0 && Number.isFinite(h[k-d])) return h[k-d];
      if (k+d < h.length && Number.isFinite(h[k+d])) return h[k+d];
    }
    return NaN;
  };
  const baseK = idx(reps[0][0]), baseH = headingAt(baseK);
  // 航向只累计两次深蹲之间的站立期：绕倾斜轴屈伸本身会带出一点绕竖直的转动，
  // 把它算进累计，一次转身就会被十几次屈伸的耦合量淹掉。
  const heads: number[] = [], hApps: (number|null)[] = [];
  {
    let acc = 0, prev = baseK;
    for (const r of reps) {
      const i0 = idx(r[0]);
      if (i0 > prev) acc += integral(prev, i0, up);
      heads.push(acc);
      prev = idx(r[3] + .4);   // 起身后还有零点几秒的回正余动，算进去会当成转身
      const h = headingAt(i0);
      hApps.push(Number.isFinite(baseH) && Number.isFinite(h) ? h-baseH : null);
    }
  }

  // 屈伸在每次深蹲里往返抵消，整段净旋转只剩「侧倾没回到原位」的那部分：
  // 它的水平方向就是前后轴，比屈伸主轴更少被同期的内扣拉偏 —— 只在各次方向一致时可用。
  let net: {n: number; coh: number; gap: number};
  {
    const dirs: Vec[] = [];
    for (let i = 0; i < reps.length; i++) {
      const v = rotUp(netVec(idx(reps[i][0]), idx(reps[i][3])), -heads[i]);
      const m = Math.hypot(v[0], v[1], v[2]);
      if (m >= 1.2) dirs.push([v[0]/m, v[1]/m, v[2]/m]);
    }
    const sum = dirs.reduce((a, x) => [a[0]+x[0], a[1]+x[1], a[2]+x[2]], [0, 0, 0]);
    const coh = dirs.length ? Math.hypot(sum[0], sum[1], sum[2])/dirs.length : 0;
    net = {n: dirs.length, coh, gap: Infinity};
    if (dirs.length >= 2 && coh >= .6) {
      const f0 = unit(sum), l0 = unit(cross(f0, up));
      const g = angDeg(l0, lateral);
      net.gap = Math.min(g, 180-g);   // 轴比较，不看正负：符号后面统一
      if (net.gap <= 35) { lateral = l0; forward = unit(cross(up, lateral)); axisSource = 'net-turn'; }
    }
  }

  // 两脚各估一套轴，符号必须对齐才能互比：让多数次的「下降段转向」为正。
  // 依据是两脚蹲下时的屈伸方向相同，所以这条规则之后两侧前后角同号同向。
  if (median(reps.map(r => integral(idx(r[0]), idx(r[1]), lateral))) < 0) {
    lateral = [-lateral[0], -lateral[1], -lateral[2]];
    forward = [-forward[0], -forward[1], -forward[2]];
  }

  const out: RepAngle[] = [], traces: SquatAngleTrace[] = [];
  for (let i = 0; i < reps.length; i++) {
    const r = reps[i], i0 = idx(r[0]), i1 = idx(r[1]), i2 = idx(r[2]), i3 = idx(r[3]);
    const li = rotUp(lateral, heads[i]), fi = rotUp(forward, heads[i]);
    const t = tt.slice(i0, i3+1), deg = new Float32Array(t.length*3).fill(NaN), linked = new Uint8Array(t.length);
    let ap=0, ml=0, yaw=0, back=0, bottom=[0,0,0];
    if (good[i0]) deg.set([0,0,0]);
    for (let k = i0; k < i3; k++) {
      const j=k+1-i0, dt=interval(k);
      if (dt) {
        const w=gyrC(k), delta=dot(w, li)*dt;
        ap+=delta; ml+=dot(w, fi)*dt; yaw+=dot(w, up)*dt;
        if (k>=i2) back+=delta;
        linked[j]=1;
      }
      if (good[k+1]) {deg[j*3]=ap; deg[j*3+1]=ml; deg[j*3+2]=yaw;}
      if (k+1===i1) bottom=[ap,ml,yaw];
    }
    traces.push({t,deg,linked});
    out.push({i, ap: bottom[0], ml: bottom[1], yaw: bottom[2],
      back, hold: tt[i2]-tt[i1], heading: heads[i], headingApp: hApps[i]});
  }


  const warns: string[] = [];
  if (!segs.length) warns.push(`没有连续静止段，竖直轴改用每次蹲前的站立瞬间（${standSegs.length} 处，离散 ${upSpread.toFixed(1)}°）。`);
  else if (clusters.length > 1) warns.push(`静止段分成 ${clusters.length} 种姿态（蹲到底时也算静止），竖直轴按时长最多的那一簇取。`);
  if (upSpread > 6) warns.push(`不同静止参考之间差 ${upSpread.toFixed(1)}°，脚可能换过朝向。`);
  if (Math.abs(tilt) > 25) warns.push(`屈伸主轴离水平面 ${Math.abs(tilt).toFixed(0)}°，动作里混了绕竖直的转动。`);
  if (ratio < .65) warns.push(`左右轴能量占比只有 ${(ratio*100).toFixed(0)}%，屈伸不占主导。`);
  if (spread > 12) warns.push(`每次深蹲的主轴彼此相差 ${spread.toFixed(1)}°，动作不一致。`);
  if (biasNorm > 5) warns.push(`静止时补偿角速度残差 ${biasNorm.toFixed(1)} °/s，积分前已扣。`);
  const conf: 'hi'|'mid'|'lo' = ratio >= .82 && spread <= 8 && upSpread <= 6 ? 'hi' : ratio >= .65 && spread <= 15 ? 'mid' : 'lo';

  return {ok: true, up, lateral, forward, upSource, quietDur: stillN/fs, upSpread,
    ratio, spread, tilt, axisSource, net, bias, biasNorm, conf, reps: out, traces, warns};
}
