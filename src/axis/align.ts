/* 对齐与分段：找落地冲击锚点、算两份数据的时间偏移、按动作切段、给多份文件分工。
   只处理加速度模长序列，与轴向推断解耦。 */

import {blkOf} from '../core/util';

const PEAK_THR = 3.0;      // g，算作「冲击」的下限
const SEG_STILL = 0.06;    // g，滑窗标准差低于此值算「贴地不动」
const SEG_MIN = 1.0;       // s，更短的段并进邻居

// 一份数据的加速度模长序列：取帧数最多的那一侧，多侧不必平均（都在做同一个动作）。
// 懒加载的长录制只有窗口块，所以帧数、时间、信号一律取块视图，不能拿全段帧数配块内数组。
function accSeries(sides) {
  const withImu = sides.filter(x => x.imu && x.imu.phys).map(x => ({s: x, b: blkOf(x)}));
  const pick = withImu.sort((p, q) => q.b.n - p.b.n)[0];
  if (!pick || !(pick.b.n > 1)) return null;
  const b = pick.b;
  const n = b.n, t = b.t, phys = b.imu.phys;
  const a = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const x = phys[0][k], y = phys[1][k], z = phys[2][k];
    a[k] = (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) ? Math.hypot(x, y, z) : NaN;
  }
  const span = t[n - 1] - t[0];
  return {t, a, n, fs: span > 0 ? (n - 1) / span : pick.s.fs};
}

// 超过 PEAK_THR 的局部极大，按强度降序；0.4 s 内的相邻峰合成一个
function strongPeaks(ser) {
  const {t, a, n} = ser, out = [];
  for (let k = 1; k + 1 < n; k++) {
    if (!(a[k] >= PEAK_THR) || !(a[k] >= a[k - 1]) || !(a[k] >= a[k + 1])) continue;
    const p = out[out.length - 1];
    if (p && t[k] - p.t < 0.4) { if (a[k] > p.a) { p.t = t[k]; p.a = a[k]; } continue; }
    out.push({t: t[k], a: a[k]});
  }
  return out.sort((x, y) => y.a - x.a);
}

// 两份数据各取最强的一次冲击配对：跳 / 落地是瞬时的，两边撞在同一时刻几乎不可能
function alignRef(main, ref) {
  const pm = strongPeaks(main), pr = strongPeaks(ref);
  if (!pm.length || !pr.length) {
    return {err: `主数据 ${pm.length} 处、参考数据 ${pr.length} 处超过 ${PEAK_THR} g 的冲击，找不到对齐锚点；`
      + '两份数据里至少要有一次跳跃或重落地'};
  }
  return {dt: pm[0].t - pr[0].t, pm: pm[0], pr: pr[0], nM: pm.length, nR: pr.length};
}

// 加速度模长的滑窗标准差：低于 SEG_STILL 算「贴地不动」
function sdSeries(ser) {
  const {a, n, fs} = ser;
  const half = Math.max(1, Math.round(0.12 * fs));
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - half), hi = Math.min(n, k + half + 1);
    let m = 0, q = 0, c = 0;
    for (let i = lo; i < hi; i++) if (Number.isFinite(a[i])) { m += a[i]; q += a[i] * a[i]; c++; }
    out[k] = c > 1 ? Math.sqrt(Math.max(0, q / c - (m / c) * (m / c))) : 0;
  }
  return out;
}

// 一份数据里「落地冲击有多清楚」：峰值、次数、贴地静止占比。
// 参考数据只干两件事 —— 给对齐锚点、给动作边界，所以冲击越尖锐、贴地越安静越适合当参考。
// 实测脚背 16.6 g / 大腿 8 g，这条判据自动把脚背挑出来。
function fileScore(ser) {
  if (!ser) return null;
  const sd = sdSeries(ser);
  let mx = 0, quiet = 0;
  for (let k = 0; k < ser.n; k++) {
    if (Number.isFinite(ser.a[k]) && ser.a[k] > mx) mx = ser.a[k];
    if (sd[k] < SEG_STILL) quiet++;
  }
  const nPeak = strongPeaks(ser).length;
  const frac = quiet / Math.max(1, ser.n);
  return {maxPeak: mx, nPeak, quietFrac: frac,
          score: 0.6 * Math.min(mx / 12, 1) + 0.25 * Math.min(nPeak / 8, 1) + 0.15 * frac};
}

// 多文件分工：分数最高的一份当参考（只提供时间锚点与动作边界），其余全部照常逐段推断。
// 参考的轴向结论不搬给任何人 —— 贴的部位不同，坐标系就不同。
function assignRoles(files) {
  const scored = files.map(f => ({f, ser: accSeries(f.sides)}));
  for (const x of scored) x.sc = fileScore(x.ser);
  const ok = scored.filter(x => x.sc);
  if (!ok.length) return {ref: -1, scored};
  let bi = 0;
  for (let i = 1; i < ok.length; i++) if (ok[i].sc.score > ok[bi].sc.score) bi = i;
  return {ref: files.indexOf(ok[bi].f), scored, best: ok[bi]};
}

const p95 = (v) => {
  if (!v.length) return NaN;
  v.sort((x, y) => x - y);
  return v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
};

// 参考数据上按「贴地不动 / 在动」切段；返回的段落在参考数据的时间基上。
// mains: [{sides, dt}]，dt 满足 main_time = ref_time + dt —— 参考数据看不出深蹲（脚一直贴地），
// 得借主数据的角速度判「原地动作」，所以分段时要一起看。
function segmentsOf(ref, mains) {
  const {t, a, n} = ref;
  const sd = sdSeries(ref);
  const quiet = k => sd[k] < SEG_STILL;

  const raw = [];
  for (let k = 0; k < n;) {
    let j = k;
    while (j + 1 < n && quiet(j + 1) === quiet(k)) j++;
    raw.push({a: t[k], b: t[j], quiet: quiet(k)});
    k = j + 1;
  }
  // 碎段并进邻居：太短的段切开也推不出东西，只会让表变长
  const merged = [];
  for (const g of raw) {
    const p = merged[merged.length - 1];
    if (p && g.b - g.a < SEG_MIN) { p.b = g.b; continue; }
    if (p && p.b - p.a < SEG_MIN) { p.b = g.b; p.quiet = p.quiet && g.quiet; continue; }
    merged.push({...g});
  }

  const p95ref = (from, to) => {
    const v = [];
    for (let k = 0; k < n; k++) if (t[k] >= from && t[k] <= to && Number.isFinite(a[k])) v.push(a[k]);
    return p95(v);
  };
  const p95side = (s, from, to) => {
    const v = [];
    for (let k = 0; k < s.n; k++) {
      if (s.t[k] < from || s.t[k] > to) continue;
      const x = s.imu.phys[0][k], y = s.imu.phys[1][k], z = s.imu.phys[2][k];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) v.push(Math.hypot(x, y, z));
    }
    return p95(v);
  };
  // 角速度「有没有在动」不能看模长中位数：零偏大的器件静止时就有 17–20 °/s，
  // 模长会一直高于任何阈值。看四分位距 —— 零偏是常数，静止时 IQR 只有 1–2 °/s，动作时才张开。
  const gyrStats = (s, from, to) => {
    const v = [];
    for (let k = 0; k < s.n; k++) {
      if (s.t[k] < from || s.t[k] > to) continue;
      const gx = s.imu.phys[3][k], gy = s.imu.phys[4][k], gz = s.imu.phys[5][k];
      if (Number.isFinite(gx) && Number.isFinite(gy) && Number.isFinite(gz)) v.push(Math.hypot(gx, gy, gz));
    }
    if (!v.length) return {med: NaN, iqr: NaN};
    v.sort((x, y) => x - y);
    const q = f => v[Math.min(v.length - 1, Math.floor(v.length * f))];
    return {med: q(0.5), iqr: q(0.75) - q(0.25)};
  };

  const out = [];
  for (const g of merged) {
    let wm = NaN, wi = NaN, h = p95ref(g.a, g.b), covered = false;
    for (const m of mains) {
      const s0 = (m.sides || []).filter(x => x.imu && x.imu.phys)[0];
      if (!s0) continue;
      // 块视图：p95side / gyrStats 按 s.n 与 s.t 遍历，必须和 s.imu 来自同一块
      const s = blkOf(s0);
      const a2 = g.a + m.dt, b2 = g.b + m.dt;
      if (b2 - a2 < SEG_MIN * 0.6) continue;
      covered = true;
      const st = gyrStats(s, a2, b2);
      if (Number.isFinite(st.med) && !(st.med <= wm)) wm = st.med;
      if (Number.isFinite(st.iqr) && !(st.iqr <= wi)) wi = st.iqr;
      const hm = p95side(s, a2, b2);
      if (Number.isFinite(hm) && !(hm <= h)) h = hm;
    }
    if (!covered) continue;
    // 所有设备都不动 ⇒ 静止；任一侧测到落地冲击 ⇒ 走动；
    // 其余是「参考不动、设备在转」⇒ 原地动作（深蹲这类）
    const kind = (!(wi >= 10)) ? '静止' : (h >= 2.0) ? '走动' : '原地动作';
    out.push({a: g.a, b: g.b, kind, wm, wiqr: wi, h95: h, span: g.b - g.a});
  }
  // 相邻同类合并：静/动边界抖一下就会把同一段动作切成两三块，推断出来反而更差
  const tidy = [];
  for (const g of out) {
    const p = tidy[tidy.length - 1];
    if (p && p.kind === g.kind && g.a - p.b < 0.4) { p.b = g.b; continue; }
    tidy.push(g);
  }
  return tidy;
}

export {PEAK_THR, SEG_MIN, SEG_STILL, accSeries, alignRef, assignRoles, fileScore, sdSeries, segmentsOf, strongPeaks};
