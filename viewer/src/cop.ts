/* COP 页：Otsu 分段、零相位低通、零点扣除、平均轨迹与逐帧播放。 */

import {NCH, SIDE_CN} from './core/constants';
import {$, el} from './core/dom';
import {meanView, seekView, state} from './core/state';
import {baseName, blkOf, css, downloadCanvas, fmt, med, miniBtn, miniRow} from './core/util';
import {idxAt} from './detail';
import {exportCopCsv} from './export';
import {COP_PTS, INNER_RIGHT, VIS_X, VIS_Y, strokeOutline} from './geometry';
import {showTipAt} from './interact';

const COP_LP = 6;
// 支撑判定阈值由 Otsu 自动定（实测稳定落在 44–49% 峰值），落点是「两簇之间的间隙」，
// 与峰值百分比无关。底数抬高后摆动簇整体上移，任何固定小百分比都会跌进簇内而失效，
// 所以只在双峰不显著（eta 低）或越界时回退半峰。
const THR_LO = 0.25, THR_HI = 0.65, THR_FALLBACK = 0.5, THR_OFF = 0.55, THR_ETA_MIN = 0.6;
// 两级阈值：Otsu 只判「是不是一步」，段端点由窗宽门限外扩决定。
// gate 取摆动底（段外帧的中位载）的 2 倍，干净数据等价于固定 3% 峰值，软鞋垫抬到实际平地线之上。
const GATE_FLOOR = 0.03, GATE_K = 2, GATE_MAX_OFF = 0.9;
// 两级阈值：Otsu 只判「是不是一步」，段端点由窗宽门限外扩决定。
// gate 取摆动底（段外帧的中位载）的 2 倍，干净数据等价于固定 3% 峰值，软鞋垫抬到实际平地线之上。

// 总载直方图做 Otsu 分割，返回分界值与类间方差占比 eta。
// eta 接近 1 表示双峰分离干净；单峰（全程受载）时 eta 低，调用方应回退。
function otsuSplit(tot, n) {
  const NB = 256;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) { const v = tot[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(n > 0) || !(hi > lo)) return {t: 0, eta: 0};
  const bin = (hi - lo) / NB, hist = new Float64Array(NB);
  for (let k = 0; k < n; k++) {
    let b = ((tot[k] - lo) / bin) | 0;
    if (b < 0) b = 0; else if (b >= NB) b = NB - 1;
    hist[b]++;
  }
  const w0 = new Float64Array(NB), m0 = new Float64Array(NB);
  let W = 0, M = 0;
  for (let i = 0; i < NB; i++) {
    const x = lo + (i + 0.5) * bin;
    W += hist[i]; M += hist[i] * x;
    w0[i] = W; m0[i] = M;
  }
  if (!(W > 0)) return {t: 0, eta: 0};
  const mu = M / W;
  let varT = 0;
  for (let k = 0; k < n; k++) { const d = tot[k] - mu; varT += d * d; }
  let best = 0, bi = 0;
  for (let i = 0; i < NB - 1; i++) {
    const wa = w0[i], wb = W - wa;
    if (wa < 1 || wb < 1) continue;
    const d = m0[i] / wa - (M - m0[i]) / wb;
    const sb = wa * wb * d * d;
    if (sb > best) { best = sb; bi = i; }
  }
  return {t: lo + (bi + 0.5) * bin, eta: varT > 0 ? best / (W * varT) : 0};
}

// 滞回定段：过 ON 起段，跌破 OFF 才收段。只判「是不是一步」，不决定这步从哪算到哪。
// 最短段长用绝对下限而非中位段长的比例：记录里一旦有长静立段，比例判据会把真实短步删掉。
function contactsOf(tot, on, off, minLen) {
  const segs = [];
  let i = 0;
  const n = tot.length;
  while (i < n) {
    if (tot[i] > on) {
      let j = i;
      while (j + 1 < n && tot[j + 1] > off) j++;
      if (j - i + 1 >= minLen) segs.push([i, j]);
      i = j + 1;
    } else i++;
  }
  return segs;
}

// 段外帧就是摆动相，它们的中位载反映这份数据的「平地线」高度
function gapMedian(tot, segs, n) {
  const mark = new Uint8Array(n);
  for (const [a, b] of segs) mark.fill(1, a, b + 1);
  const buf = [];
  for (let k = 0; k < n; k++) if (!mark[k]) buf.push(tot[k]);
  if (!buf.length) return 0;
  buf.sort((x, y) => x - y);
  return buf[buf.length >> 1];
}

// 端点外扩到载荷跌破 gate 处，上限取相邻段中点——结构上保证不会并段。
// 不扩会把触地上升段和蹬离下降段截掉：轨迹长被砍三成、支撑时长少 10%，那是截断不是降噪。
function extendSegs(tot, segs, gate, n) {
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    let [a, b] = segs[i];
    const lo = i > 0 ? ((segs[i - 1][1] + a) >> 1) : 0;
    const hi = i < segs.length - 1 ? ((b + segs[i + 1][0]) >> 1) : n - 1;
    while (a > lo && tot[a - 1] > gate) a--;
    while (b < hi && tot[b + 1] > gate) b++;
    out.push([a, b]);
  }
  return out;
}

function biquadLP(fc, fs) {
  if (!(fs > 0) || !(fc > 0) || fc >= fs / 2) return null;
  const w = 2 * Math.PI * fc / fs, cw = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha, b0 = (1 - cw) / 2;
  return [b0 / a0, (1 - cw) / a0, b0 / a0, -2 * cw / a0, (1 - alpha) / a0];
}

// 段内双向二阶低通（零相位），不跨段，避免把相邻两步混在一起。
// 端点做奇对称延拓（同 scipy filtfilt 的 padtype='odd'），否则段首段尾会被常值外推拽住，
// 离地那几帧的 COP 偏差能到 10 mm 以上，轨迹长度跟着算短近 10%。
function lowpassSeg(arr, segs, c) {
  if (!c) return;
  const [b0, b1, b2, a1, a2] = c;
  for (const [i0, i1] of segs) {
    const len = i1 - i0 + 1;
    if (len < 9) continue;
    const src = new Float64Array(len);
    let nOk = 0;
    for (let k = 0; k < len; k++) {
      const v = arr[i0 + k];
      src[k] = v;
      if (isFinite(v)) nOk++;
    }
    if (!nOk) continue;
    if (nOk < len) {                    // 段内个别帧低于阈值：线性插值补齐，免得 NaN 顺着滤波器扩散
      for (let k = 0; k < len; k++) {
        if (isFinite(src[k])) continue;
        let p = k - 1, q = k + 1;
        while (p >= 0 && !isFinite(src[p])) p--;
        while (q < len && !isFinite(src[q])) q++;
        src[k] = p < 0 ? src[q] : q >= len ? src[p] : src[p] + (src[q] - src[p]) * (k - p) / (q - p);
      }
    }
    const pad = Math.min(9, len - 1), N = len + 2 * pad;
    const x = new Float64Array(N), y = new Float64Array(N), z = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      if (k < pad) x[k] = 2 * src[0] - src[pad - k];
      else if (k < pad + len) x[k] = src[k - pad];
      else { const m = k - (pad + len); x[k] = 2 * src[len - 1] - src[len - 2 - m]; }
    }
    for (let k = 0; k < N; k++) {
      const x1 = k > 0 ? x[k - 1] : x[0], x2 = k > 1 ? x[k - 2] : x[0];
      const y1 = k > 0 ? y[k - 1] : x[0], y2 = k > 1 ? y[k - 2] : x[0];
      y[k] = b0 * x[k] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    }
    for (let k = N - 1; k >= 0; k--) {
      const x1 = k < N - 1 ? y[k + 1] : y[N - 1], x2 = k < N - 2 ? y[k + 2] : y[N - 1];
      const y1 = k < N - 1 ? z[k + 1] : y[N - 1], y2 = k < N - 2 ? z[k + 2] : y[N - 1];
      z[k] = b0 * y[k] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    }
    for (let k = 0; k < len; k++) arr[i0 + k] = z[pad + k];
  }
}

// 每通道零点：取总载最低 12% 的帧逐通道求中位数。
// 数据全程带直流偏置（从不归零）时，这些帧就是摆动/空载，其读数即偏置；
// 不扣会同时压垮分段（整段连成一步）和 COP（权重重心被固定格点拽住）。
function estimateZero(src, nch) {
  const s = blkOf(src), n = s.n, base = new Float64Array(nch);
  if (n < 20) return base;
  const tot = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let T = 0;
    for (let j = 0; j < nch; j++) { const v = s.ch[j][k]; if (v > 0) T += v; }
    tot[k] = T;
  }
  const sorted = Float64Array.from(tot).sort();
  const thr = sorted[Math.floor(0.12 * (n - 1))];
  let idx = [];
  for (let k = 0; k < n; k++) if (tot[k] <= thr) idx.push(k);
  if (idx.length < 10) {
    idx = Array.from({length: n}, (_, k) => k).sort((a, b) => tot[a] - tot[b]).slice(0, Math.min(10, n));
  }
  const buf = new Float64Array(idx.length);
  for (let j = 0; j < nch; j++) {
    const col = s.ch[j];
    for (let m = 0; m < idx.length; m++) { const v = col[idx[m]]; buf[m] = v > 0 ? v : 0; }
    base[j] = Float64Array.from(buf).sort()[buf.length >> 1];
  }
  return base;
}

function copCalc(src) {
  const s = blkOf(src), P = COP_PTS[s.side];
  if (!P) return null;
  const n = s.n, nch = Math.min(NCH, s.nch, P.x.length);
  if (nch < 2) return null;
  const zero = estimateZero(s, nch);
  let zsum = 0, zch = 0;
  for (let j = 0; j < nch; j++) { zsum += zero[j]; if (zero[j] > 50) zch++; }
  const base = state.copZero ? zero : null;
  const tot = new Float64Array(n), cx = new Float64Array(n), cy = new Float64Array(n);
  // rawPeak / rawMin 取自未扣零点的原始读数，是文件自身属性，不随零点开关变化
  let rawPeak = 0, rawMin = Infinity;
  for (let k = 0; k < n; k++) {
    let T = 0, sx = 0, sy = 0, R = 0;
    for (let j = 0; j < nch; j++) {
      const v0 = s.ch[j][k];
      if (v0 > 0) R += v0;
      let v = v0;
      if (base) v -= base[j];
      if (v > 0) { T += v; sx += v * P.x[j]; sy += v * P.y[j]; }
    }
    if (R > rawPeak) rawPeak = R;
    if (R < rawMin) rawMin = R;
    tot[k] = T;
    if (T > 0) { cx[k] = sx / T; cy[k] = sy / T; }
  }
  if (!isFinite(rawMin)) rawMin = 0;
  let peak = 0;
  for (let k = 0; k < n; k++) if (tot[k] > peak) peak = tot[k];
  if (!(peak > 0)) return null;
  const otsu = otsuSplit(tot, n);
  let auto = otsu.eta >= THR_ETA_MIN && otsu.t >= THR_LO * peak && otsu.t <= THR_HI * peak;
  const minLen = Math.max(3, Math.round(0.1 * (s.fs || 50)));
  const detect = uOn => {
    const uOff = THR_OFF * uOn;
    const d = contactsOf(tot, uOn, uOff, minLen);
    const gm = gapMedian(tot, d, n);
    const g = Math.min(Math.max(GATE_FLOOR * peak, GATE_K * gm), GATE_MAX_OFF * uOff);
    return {segs: d, gapMed: gm, gate: g, off: uOff};
  };
  let on = auto ? otsu.t : THR_FALLBACK * peak;
  let det = detect(on);
  // 检测阈值掉进摆动带里（底数没扣、或数据全程受载）⇒ 分段不可信，退回半峰重判一次
  if (on <= det.gate) { on = THR_FALLBACK * peak; det = detect(on); auto = false; }
  const off = det.off, gate = det.gate, gapMed = det.gapMed;
  const segs = extendSegs(tot, det.segs, gate, n);
  const thr = gate;
  for (let k = 0; k < n; k++) {
    if (!(tot[k] > thr)) { cx[k] = NaN; cy[k] = NaN; }
  }
  if (state.copLp) {
    const bq = biquadLP(COP_LP, s.fs);
    lowpassSeg(cx, segs, bq);
    lowpassSeg(cy, segs, bq);
  }

  const dur = segs.map(([a, b]) => s.t[b] - s.t[a]);
  const ap = [], ml = [], path = [];
  for (const [a, b] of segs) {
    let ylo = Infinity, yhi = -Infinity, xlo = Infinity, xhi = -Infinity;
    for (let k = a; k <= b; k++) {
      if (cy[k] < ylo) ylo = cy[k];
      if (cy[k] > yhi) yhi = cy[k];
      if (cx[k] < xlo) xlo = cx[k];
      if (cx[k] > xhi) xhi = cx[k];
    }
    ap.push(yhi - ylo); ml.push(xhi - xlo);
    let L = 0;
    for (let k = a + 1; k <= b; k++) L += Math.hypot(cx[k] - cx[k - 1], cy[k] - cy[k - 1]);
    path.push(L);
  }
  const out: any = {tot, cx, cy, peak, thr, segs, dur, ap, ml, path, rawPeak, rawMin,
               on, off, gate, gapMed, eta: otsu.eta, auto, thrPct: 100 * on / peak,
               gatePct: 100 * gate / peak,
               zero: {sum: zsum, n: zch, applied: !!base},
               landX: segs.map(([a]) => cx[a]), offX: segs.map(([, b]) => cx[b]),
               landY: segs.map(([a]) => cy[a]), offY: segs.map(([, b]) => cy[b])};
  out.mean = copMean(out);
  return out;
}

// 各步按步内进程 0→1 重采样后取均值，得到与步长无关的一条平均轨迹
function copMean(d, N = 96) {
  const ax = new Float64Array(N), ay = new Float64Array(N), nc = new Int32Array(N);
  for (const [a, b] of d.segs) {
    const L = b - a;
    if (L < 4) continue;
    for (let i = 0; i < N; i++) {
      const pos = a + (i / (N - 1)) * L;
      const k0 = Math.floor(pos), k1 = Math.min(b, k0 + 1), f = pos - k0;
      const x = d.cx[k0] + (d.cx[k1] - d.cx[k0]) * f;
      const y = d.cy[k0] + (d.cy[k1] - d.cy[k0]) * f;
      if (!isFinite(x) || !isFinite(y)) continue;   // 该步此相位缺样本，不参与均值
      ax[i] += x; ay[i] += y; nc[i]++;
    }
  }
  const x = new Float64Array(N), y = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = nc[i] ? ax[i] / nc[i] : NaN;
    y[i] = nc[i] ? ay[i] / nc[i] : NaN;
  }
  return {x, y, N};
}

function copCaption(s, d) {
  if (!d.segs.length) return '';
  const n = d.segs.length;
  const durM = med(d.dur) * 1000, pathM = med(d.path), sp = med(d.path.map((v, i) => v / d.dur[i]));
  return `${SIDE_CN[s.side] || s.side}　${n} 次触地`
    + `<em>支撑 ${fmt(durM)} ms　前后行程 ${fmt(med(d.ap))} mm　内外摆幅 ${fmt(med(d.ml))} mm</em>`
    + `<em>轨迹长 ${fmt(pathM)} mm　均速 ${fmt(sp)} mm/s　起 y ${fmt(med(d.landY))} → 止 y ${fmt(med(d.offY))} mm</em>`;
}

// 高度按视口给，宽度由足形比例（62 × 256 mm）反推
function copGeo(h) {
  const padT = 34, padB = 44, padL = 42, padR = 16;
  const scale = (h - padT - padB) / (VIS_Y[1] - VIS_Y[0]);
  const W = Math.round(padL + (VIS_X[1] - VIS_X[0]) * scale + padR);
  return {H: h, W, padT, padB, padL, padR, scale};
}
// 加了鞋垫外框后视窗是整只脚，画布相应加高，否则轮廓细得看不出形状
const meanH = () => Math.round(Math.max(370, Math.min(window.innerHeight * 0.42, 450)));
const seekH = () => Math.round(Math.max(450, Math.min(window.innerHeight * 0.56, 600)));

function copBase(g, geo, s) {
  const {padT, padL, scale} = geo;
  const X = x => padL + (x - VIS_X[0]) * scale;
  const Y = y => padT + (VIS_Y[1] - y) * scale;
  const cLine = css('--line'), cGrid = css('--grid'), cFaint = css('--faint'),
        cMuted = css('--muted');
  const xstep = scale >= 2.2 ? 10 : 20;      // 窄画布上少放刻度，免得数字挤在一起
  g.textBaseline = 'middle';

  g.strokeStyle = cGrid; g.lineWidth = 1;
  for (let v = 50; v <= 250; v += 50) {
    g.beginPath(); g.moveTo(padL, Y(v) + .5); g.lineTo(X(VIS_X[1]), Y(v) + .5); g.stroke();
  }
  for (let v = 20; v <= 60; v += xstep) {
    g.beginPath(); g.moveTo(X(v) + .5, padT); g.lineTo(X(v) + .5, Y(VIS_Y[0])); g.stroke();
  }

  // 鞋垫轮廓：给格点和轨迹一个解剖参照，淡到不抢 COP 的视觉
  g.save();
  g.strokeStyle = cFaint; g.globalAlpha = .5; g.lineWidth = 1.1; g.lineJoin = 'round';
  strokeOutline(g, s.side, X, Y);
  g.restore();

  // 格点：实心 = 有读数，空心 = 该段恒为 0
  const P = COP_PTS[s.side];
  if (P) {
    const nch = Math.min(NCH, s.nch, P.x.length);
    for (let j = 0; j < nch; j++) {
      const live = !!(s.mx && s.mx[j] > 0);
      g.beginPath(); g.arc(X(P.x[j]), Y(P.y[j]), live ? 2.4 : 1.8, 0, Math.PI * 2);
      if (live) { g.fillStyle = cLine; g.fill(); }
      else { g.strokeStyle = cFaint; g.lineWidth = .9; g.stroke(); }
    }
    g.lineWidth = 1;
  }

  // 轴
  g.strokeStyle = cLine; g.lineWidth = 1;
  g.beginPath(); g.moveTo(padL - .5, padT); g.lineTo(padL - .5, Y(VIS_Y[0]) + .5); g.stroke();
  g.beginPath(); g.moveTo(padL - .5, Y(VIS_Y[0]) + .5); g.lineTo(X(VIS_X[1]), Y(VIS_Y[0]) + .5); g.stroke();
  g.font = '10px system-ui,sans-serif'; g.fillStyle = cFaint;
  g.textAlign = 'right';
  for (let v = 50; v <= 250; v += 50) g.fillText(String(v), padL - 6, Y(v));
  g.textAlign = 'center';
  for (let v = 20; v <= 60; v += xstep) g.fillText(String(v), X(v), Y(VIS_Y[0]) + 14);
  g.fillStyle = cMuted; g.font = '10px system-ui,"Microsoft YaHei",sans-serif';
  g.fillText('x 内外 (mm)', padL + (X(VIS_X[1]) - padL) / 2, Y(VIS_Y[0]) + 31);
  g.save();
  g.translate(12, padT + (Y(VIS_Y[0]) - padT) / 2);
  g.rotate(-Math.PI / 2);
  g.fillText('y 前后 (mm)', 0, 0);
  g.restore();

  // 朝向：内侧恒朝身体中线，两脚不做镜像
  g.font = '9.5px system-ui,"Microsoft YaHei",sans-serif'; g.fillStyle = cFaint;
  const innerR = INNER_RIGHT[s.side];
  g.textAlign = 'left';
  g.fillText(innerR ? '外侧' : '内侧', padL + 2, padT - 11);
  g.textAlign = 'right';
  g.fillText(innerR ? '内侧' : '外侧', X(VIS_X[1]) - 2, padT - 11);
}

// ① 平均轨迹：一条细线 + 起止点
function drawMean(entry) {
  const {s, d, cv} = entry;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const geo = copGeo(meanH());
  cv.style.width = geo.W + 'px'; cv.style.height = geo.H + 'px';
  cv.width = Math.round(geo.W * dpr); cv.height = Math.round(geo.H * dpr);
  entry.geo = geo;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, geo.W, geo.H);
  copBase(g, geo, s);

  const m = d.mean;
  if (!m) return;
  const X = x => geo.padL + (x - VIS_X[0]) * geo.scale;
  const Y = y => geo.padT + (VIS_Y[1] - y) * geo.scale;
  const cAcc = css('--accent'), cCard = css('--card');
  g.strokeStyle = cAcc; g.lineWidth = 1.4; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  let pen = false;
  for (let i = 0; i < m.N; i++) {
    if (!isFinite(m.x[i])) { pen = false; continue; }
    const x = X(m.x[i]), y = Y(m.y[i]);
    if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
  }
  g.stroke();

  for (const [i, filled] of ([[0, false], [m.N - 1, true]] as [number, boolean][])) {
    if (!isFinite(m.x[i])) continue;
    g.beginPath(); g.arc(X(m.x[i]), Y(m.y[i]), 3.4, 0, Math.PI * 2);
    if (filled) { g.fillStyle = cAcc; g.fill(); }
    else { g.fillStyle = cCard; g.fill(); g.strokeStyle = cAcc; g.lineWidth = 1.5; g.stroke(); }
  }

  // 悬停点：光标沿线走，读出该相位的坐标
  const hi = entry.hov;
  if (hi != null && isFinite(m.x[hi])) {
    g.beginPath(); g.arc(X(m.x[hi]), Y(m.y[hi]), 3.2, 0, Math.PI * 2);
    g.fillStyle = cCard; g.fill();
    g.strokeStyle = cAcc; g.lineWidth = 1.6; g.stroke();
  }
}

// ② 逐帧播放：底图（网格/格点/轴）存离屏，每帧只重画当前支撑段与拖尾
function drawSeek(entry) {
  const {s, cv, off} = entry;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const geo = copGeo(seekH());
  cv.style.width = geo.W + 'px'; cv.style.height = geo.H + 'px';
  cv.width = Math.round(geo.W * dpr); cv.height = Math.round(geo.H * dpr);
  off.width = cv.width; off.height = cv.height;
  entry.geo = geo;
  const g = off.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, geo.W, geo.H);
  copBase(g, geo, s);
  paintSeek(entry, state.copT);
}

function paintSeek(entry, t) {
  const {s, d, cv, off, geo, rd} = entry;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(off, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const X = x => geo.padL + (x - VIS_X[0]) * geo.scale;
  const Y = y => geo.padT + (VIS_Y[1] - y) * geo.scale;
  // ⚠ 段表 d.segs 与 d.cx/cy 都是块内下标：游标也必须用块内时间轴换算，不能用全段的 s
  const bs = s.blk;
  if (!bs || !(bs.n > 0)) return;
  const k = idxAt(t, bs);
  let si = -1;
  for (let i = 0; i < d.segs.length; i++) {
    if (k >= d.segs[i][0] && k <= d.segs[i][1]) { si = i; break; }
  }

  const cAcc = css('--accent');
  if (si >= 0) {
    const [a, b] = d.segs[si];
    const trace = (from, to, color, lw) => {
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = from; i <= to; i++) {
        if (!isFinite(d.cx[i])) { pen = false; continue; }
        const x = X(d.cx[i]), y = Y(d.cy[i]);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    };
    trace(a, b, css('--line'), 1.1);          // 本次支撑的完整路径
    trace(a, k, cAcc, 2.0);                   // 已走过的部分
    if (isFinite(d.cx[k])) {
      const x = X(d.cx[k]), y = Y(d.cy[k]);
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = cAcc; ctx.fill();
      ctx.strokeStyle = css('--card'); ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // 悬停帧：空心点标出该时刻 COP 落在哪，点一下就能把播放头挪过去
  const hk = entry.hov;
  if (hk != null && isFinite(d.cx[hk])) {
    const x = X(d.cx[hk]), y = Y(d.cy[hk]);
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = css('--card'); ctx.globalAlpha = .8; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = cAcc; ctx.lineWidth = 1.5; ctx.stroke();
  }

  if (rd) {
    const ok = si >= 0 && isFinite(d.cx[k]);
    // 固定三行，行数与字数变化不改变高度/宽度，面板不会左右或上下抖动
    rd.innerHTML = ok
      ? `<span>t ${t.toFixed(2)} s</span>`
        + `<span>COP (${d.cx[k].toFixed(1)}, ${d.cy[k].toFixed(1)}) mm</span>`
        + `<span>总载 ${fmt(d.tot[k])} ADC（${Math.round(100 * d.tot[k] / d.peak)}%）</span>`
      : `<span>t ${t.toFixed(2)} s</span><span>COP —</span><span>腾空，无 COP</span>`;
  }
}

// 播放图：指向某帧 = 那帧的 COP 落点；点一下把播放头挪过去
// 段跳转的基准脚：用第一只有支撑段的脚，按 [ ] 在它的段之间走
let copSegBase: any = null;
export const copSegBaseRef = (): any => copSegBase;

const copPlotW = g => g.W - g.padL - g.padR;

function seekIdxAt(entry, ev) {
  const g = entry.geo;
  if (!g) return null;
  const r = entry.cv.getBoundingClientRect();
  const x = ev.clientX - r.left;
  if (x < g.padL || x > g.padL + copPlotW(g)) return null;
  const b = entry.s.blk;
  if (!b || b.n < 2) return null;
  // 横轴铺的是这一块的时间跨度（不是全段时长），换块后映射才对得上
  return idxAt(b.t[0] + (x - g.padL) / copPlotW(g) * (b.b - b.t[0]), b);
}

function onSeekHover(entry, ev) {
  const k = seekIdxAt(entry, ev);
  if (k == null) {
    if (entry.hov != null) { entry.hov = null; paintSeek(entry, state.copT); }
    el.tip.style.display = 'none';
    return;
  }
  if (entry.hov !== k) { entry.hov = k; paintSeek(entry, state.copT); }
  const d = entry.d, s = entry.s, v = d.tot[k];
  el.tip.innerHTML = `<b>t = ${s.blk.t[k].toFixed(2)} s</b><br>`
    + (isFinite(d.cx[k]) ? `COP (${d.cx[k].toFixed(1)}, ${d.cy[k].toFixed(1)}) mm<br>` : '腾空，无 COP<br>')
    + `总载 ${fmt(v)} ADC（${Math.round(100 * v / d.peak)}%）<br>`
    + '<span style="opacity:.7">点一下跳到这一帧</span>';
  showTipAt(ev.clientX, ev.clientY);
}

function bindSeekPointer(cv, entry) {
  cv.addEventListener('mousemove', ev => onSeekHover(entry, ev));
  cv.addEventListener('mouseleave', () => {
    entry.hov = null; el.tip.style.display = 'none'; paintSeek(entry, state.copT);
  });
  cv.addEventListener('click', ev => {
    const k = seekIdxAt(entry, ev);
    if (k == null) return;
    stopPlay();
    setCopTime(entry.s.blk.t[k]);
  });
}

// 平均轨迹：沿轨迹找最近点，读出「步内进程」与坐标
function bindMeanHover(cv, entry) {
  cv.addEventListener('mousemove', ev => {
    const g = entry.geo, m = entry.d.mean;
    if (!g || !m) return;
    const r = cv.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const X = x => g.padL + (x - VIS_X[0]) * g.scale;
    const Y = y => g.padT + (VIS_Y[1] - y) * g.scale;
    let bi = -1, bd = 1e9;
    for (let i = 0; i < m.N; i++) {
      if (!isFinite(m.x[i])) continue;
      const dd = Math.hypot(X(m.x[i]) - mx, Y(m.y[i]) - my);
      if (dd < bd) { bd = dd; bi = i; }
    }
    if (bi < 0 || bd > 12) {
      if (entry.hov != null) { entry.hov = null; drawMean(entry); }
      el.tip.style.display = 'none';
      return;
    }
    if (entry.hov !== bi) { entry.hov = bi; drawMean(entry); }
    el.tip.innerHTML = `<b>步内 ${Math.round(100 * bi / (m.N - 1))}%</b><br>`
      + `COP (${m.x[bi].toFixed(1)}, ${m.y[bi].toFixed(1)}) mm`;
    showTipAt(ev.clientX, ev.clientY);
  });
  cv.addEventListener('mouseleave', () => {
    if (entry.hov == null) return;
    entry.hov = null; el.tip.style.display = 'none'; drawMean(entry);
  });
}

// 段跳转：以第一只有支撑段的脚为基准，两只脚一起跳到该段中点
function jumpSeg(dir) {
  if (!copSegBase) {
    for (const e of seekView.values()) if (e.d.segs.length) { copSegBase = e; break; }
  }
  if (!copSegBase) return;
  const segs = copSegBase.d.segs, s = copSegBase.s;
  const k = idxAt(state.copT, s.blk);      // 段表是块内下标，游标也得按块算
  let i = segs.findIndex(([a, b]) => k >= a && k <= b);
  if (i < 0) i = dir > 0 ? -1 : segs.length;   // 不在任何段内：下一段从第一段起、上一段到末段
  i = Math.max(0, Math.min(segs.length - 1, i + dir));
  const [a, b] = segs[i];
  stopPlay();
  setCopTime((s.blk.t[a] + s.blk.t[b]) / 2);
}

let copRaf = 0, copLast = 0;

function setCopTime(t) {
  state.copT = Math.max(state.copA || 0, Math.min(t, state.copSpan || 0));
  if (el.copSeek) el.copSeek.value = String(Math.round(state.copT * 1000));
  if (el.copClock) {
    el.copClock.textContent = state.copT.toFixed(2) + ' / ' + (state.copSpan || 0).toFixed(2) + ' s';
  }
  for (const e of seekView.values()) paintSeek(e, state.copT);
}

function stopPlay() {
  state.playing = false;
  if (copRaf) { cancelAnimationFrame(copRaf); copRaf = 0; }
  if (el.copPlay) el.copPlay.textContent = '▶ 播放';
}

function copTick(ts) {
  if (!state.playing) return;
  const dt = copLast ? (ts - copLast) / 1000 : 0;
  copLast = ts;
  let t = state.copT + dt * (state.copRate || 1);
  if (t >= state.copSpan) { t = 0; copLast = 0; }
  setCopTime(t);
  copRaf = requestAnimationFrame(copTick);
}

function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  if (!(state.copSpan > 0)) return;
  if (state.copT >= state.copSpan - 1e-3) state.copT = 0;
  state.playing = true;
  copLast = 0;
  if (el.copPlay) el.copPlay.textContent = '⏸ 暂停';
  copRaf = requestAnimationFrame(copTick);
}

function renderCop() {
  stopPlay();
  el.cop.innerHTML = '';
  meanView.clear(); seekView.clear();
  el.copPlay = el.copSeek = el.copClock = null;
  if (!state.sides.length) return;

  const sec = document.createElement('section');
  sec.className = 'copsec';
  const h2 = document.createElement('h2');
  h2.textContent = 'COP 平面轨迹（力加权质心）';
  const note = document.createElement('details');
  note.className = 'note';
  const sum = document.createElement('summary');
  sum.textContent = '口径说明：COP 怎么算、一段支撑怎么定、零点怎么扣';
  const meta = document.createElement('p');
  meta.textContent = 'COP = Σ(q·p)/Σq　q = 该格读数（无单位），p = D56 v3 格点坐标（mm）；读数本身是该格总载荷，'
    + '不加面积权重。支撑/摆动用两级阈值判定：先按总载直方图的 Otsu 分界（实测落在峰值 44–49%，即两簇间隙）'
    + '配合 55% 滞回定出「哪一段是一步」，再把每段端点外扩到总载跌破「摆动底 2 倍」处，'
    + '摆动底取段外帧的中位载——干净数据下等价于固定 3% 峰值，底数高的数据会自动抬高，不会把触地与蹬离截掉。'
    + '总载低于该门限的帧不出 COP（分母趋 0，质心无定义）。双峰不显著或分界掉进摆动带时回退到半峰并标注。'
    + '「扣除每通道零点」按各脚总载最低 12% 的帧逐通道取中位数当零点，扣完负值截 0——数据全程不归零时'
    + '（存在直流偏置）必须开，否则摆动簇被整体抬高、任何固定阈值都会跌进簇内，整段被判成一次支撑。'
    + '左右脚各按自身坐标绘制，内侧朝身体中线，未做镜像。';
  note.append(sum, meta);

  const ctl = document.createElement('div');
  ctl.className = 'copctl';

  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.id = 'copLp'; cb.checked = !!state.copLp;
  const lab = document.createElement('label');
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode('启用 ' + COP_LP + ' Hz 零相位低通'));
  const st = document.createElement('span');
  st.className = 'state';
  st.textContent = state.copLp
    ? '已滤波：轨迹及轨迹长 / 均速均为滤波后值'
    : '未滤波：轨迹直接由逐帧 COP 画出，轨迹长 / 均速为原始值';

  const cbZ = document.createElement('input');
  cbZ.type = 'checkbox'; cbZ.id = 'copZero'; cbZ.checked = !!state.copZero;
  const labZ = document.createElement('label');
  labZ.appendChild(cbZ);
  labZ.appendChild(document.createTextNode('扣除每通道零点'));
  const stZ = document.createElement('span');
  stZ.className = 'state';

  ctl.appendChild(lab); ctl.appendChild(st);
  ctl.appendChild(labZ); ctl.appendChild(stZ);
  cb.addEventListener('change', () => { state.copLp = cb.checked; renderCop(); });
  cbZ.addEventListener('change', () => { state.copZero = cbZ.checked; renderCop(); });

  const stat = document.createElement('div');
  stat.className = 'copstats';
  stat.hidden = true;                        // 侧别算完再填，无数据时不留空行

  sec.appendChild(h2); sec.appendChild(note); sec.appendChild(ctl); sec.appendChild(stat);
  if (state.lazy) {
    const w = document.createElement('p');
    w.className = 'meta';
    w.textContent = '⚠ 长录制只载入了一个时间窗：本页的支撑分段、平均轨迹与逐帧播放都只算这一块，'
      + '拖时间窗后按新块重算；全段的支撑统计要看「丢包 / 采样率」页。';
    sec.appendChild(w);
  }

  const hd1 = document.createElement('div');
  hd1.className = 'rowhd';
  hd1.textContent = '① 全程平均轨迹：各步按步内进程 0 → 100% 对齐后取均值，一条细线；空心点 = 着地，实心点 = 离地';
  const row1 = document.createElement('div');
  row1.className = 'cop-row';
  sec.appendChild(hd1); sec.appendChild(row1);

  const hd2 = document.createElement('div');
  hd2.className = 'rowhd';
  hd2.textContent = '② 逐帧播放：拖动进度条或点播放，圆点即该时刻的 COP，粗线为本次支撑已走过的路径，细线为整段路径';
  const row2 = document.createElement('div');
  row2.className = 'cop-row';
  const bar = document.createElement('div');
  bar.className = 'pbar';
  bar.innerHTML = '<button id="copPlay" type="button" title="空格：播放 / 暂停">▶ 播放</button>'
    + '<button id="copPrevSeg" type="button" title="上一段支撑（ [ ）">◀ 段</button>'
    + '<button id="copNextSeg" type="button" title="下一段支撑（ ] ）">段 ▶</button>'
    + '<input type="range" id="copSeek" min="0" max="1000" step="1" value="0">'
    + '<span class="clock" id="copClock"></span>'
    + '<select id="copRate" title="播放速度">'
    + '<option value="0.25">0.25×</option><option value="0.5">0.5×</option>'
    + '<option value="1" selected>1×</option><option value="2">2×</option>'
    + '<option value="4">4×</option></select>';
  sec.appendChild(hd2); sec.appendChild(row2); sec.appendChild(bar);
  el.cop.appendChild(sec);

  // 懒加载的长录制只载入了一个窗口块：本页的 COP 也只能算这一块，进度条长度跟着块走，
  // 否则拖到块外会一直停在块末帧、看起来像「这一秒没有 COP」。
  let span = 0, from = Infinity;
  for (const s of state.sides) {
    const b = blkOf(s);
    if (!(b.n > 1)) continue;
    span = Math.max(span, b.t[b.n - 1]);
    from = Math.min(from, b.t[0]);
  }
  state.copSpan = span;
  state.copA = Number.isFinite(from) ? from : 0;
  state.copT = Math.max(state.copA, Math.min(state.copT, span));

  const items = [];
  for (const s of state.sides) {
    const d = copCalc(s);
    if (d) items.push({s, d});
  }
  copSegBase = null;                                // 段跳转的基准脚，用第一只有支撑段的脚
  // 起手停在第一次支撑的中段，否则落点落在腾空里、第二排是空白。懒加载时块的起点不是 0，
  // 所以比的是「还没离开块首」，不是「等于 0」
  if (items.length && state.copT <= (state.copA || 0) && items[0].d.segs.length) {
    const [a, b] = items[0].d.segs[0];
    state.copT = (items[0].s.blk.t[a] + items[0].s.blk.t[b]) / 2;
  }

  for (const {s, d} of items) {
    const it1 = document.createElement('div');
    it1.className = 'cop-item';
    const cap1 = document.createElement('div');
    cap1.className = 'cap';
    cap1.innerHTML = d.segs.length ? copCaption(s, d) : `${SIDE_CN[s.side] || s.side}　无有效支撑段`;
    const cv1 = document.createElement('canvas');
    it1.appendChild(cap1); it1.appendChild(cv1);
    row1.appendChild(it1);
    const e1 = {s, d, cv: cv1, hov: null};
    meanView.set(s.side, e1);
    drawMean(e1);
    cap1.appendChild(miniRow(miniBtn('PNG', '导出平均轨迹图', () => {
      e1.hov = null; drawMean(e1);
      downloadCanvas(cv1, `${baseName()}_${s.side}_cop_mean.png`);
    })));
    bindMeanHover(cv1, e1);

    const it2 = document.createElement('div');
    it2.className = 'cop-item play';
    const cap2 = document.createElement('div');
    cap2.className = 'cap';
    cap2.innerHTML = `${SIDE_CN[s.side] || s.side}<em>${d.segs.length} 次支撑　峰值 ${fmt(d.peak)} ADC</em>`;
    const cv2 = document.createElement('canvas');
    const rd = document.createElement('div');
    rd.className = 'rd';
    it2.appendChild(cap2); it2.appendChild(cv2); it2.appendChild(rd);
    row2.appendChild(it2);
    const e2 = {s, d, cv: cv2, off: document.createElement('canvas'), rd, geo: null, hov: null};
    seekView.set(s.side, e2);
    drawSeek(e2);
    cap2.appendChild(miniRow(
      miniBtn('PNG', '导出播放视图（当前时刻）', () => {
        e2.hov = null; paintSeek(e2, state.copT);
        downloadCanvas(cv2, `${baseName()}_${s.side}_cop_seek.png`);
      }),
      miniBtn('CSV', '导出逐帧 COP（按支撑段，只含有 COP 的帧）', () => exportCopCsv(e2))
    ));
    bindSeekPointer(cv2, e2);
  }

  if (items.length) {
    stat.hidden = false;
    const hd = document.createElement('span');
    hd.className = 'hd';
    hd.textContent = '原始读数（未扣零点，不随上面的开关变化）';
    stat.appendChild(hd);
    for (const {s, d} of items) {
      const pct = d.rawPeak > 0 ? 100 * d.rawMin / d.rawPeak : 0;
      // 阈值与段数是判定可靠性的直接读数：单峰数据（全程受载）本就该只有 1 段
      const note = (d.auto ? '' : '　<span class="warn">自动分界不可靠，按半峰切</span>')
        + (d.segs.length <= 1 ? '　<span class="warn">只判出 1 段，本段可能全程受载</span>' : '');
      const row = document.createElement('div');
      row.innerHTML = `<b>${SIDE_CN[s.side] || s.side}</b>　峰值总载 <b>${fmt(d.rawPeak)}</b> ADC`
        + `　全程最低总载 <b>${fmt(d.rawMin)}</b> ADC（占峰值 ${pct.toFixed(1)}%）`
        + `　支撑 <b>${d.segs.length}</b> 段　阈值 <b>${Math.round(d.thrPct)}%</b>（η ${d.eta.toFixed(2)}）`
        + (d.gatePct > 5 ? `　摆动底 <b>${d.gatePct.toFixed(0)}%</b>` : '') + note;
      stat.appendChild(row);
    }
  }

  // 底数是原始读数的量，占比也按原始峰值算，免得和上面那行的「峰值总载」对不上
  const zside = it => `${SIDE_CN[it.s.side] || it.s.side} ${fmt(it.d.zero.sum)}（${it.d.zero.n} 通道 > 50，占峰值 ${Math.round(100 * it.d.zero.sum / it.d.rawPeak)}%）`;
  if (state.copZero) {
    stZ.textContent = '已扣零点：' + items.map(zside).join(' / ') + '，扣完负值截 0';
  } else {
    const bad = items.filter(it => it.d.zero.sum > 0.03 * it.d.peak);
    stZ.textContent = bad.length
      ? '未扣零点：检测到直流偏置　' + bad.map(zside).join(' / ') + '　底数偏高，建议勾选'
      : '未扣零点：底数很小　' + items.map(zside).join(' / ') + '　无需扣除';
  }

  el.copPlay = $('#copPlay'); el.copSeek = $('#copSeek'); el.copClock = $('#copClock');
  const bPrev = $('#copPrevSeg'), bNext = $('#copNextSeg'), selRate = $('#copRate');
  if (selRate) {
    selRate.value = String(state.copRate || 1);
    selRate.addEventListener('change', () => { state.copRate = +selRate.value || 1; });
  }
  if (bPrev) bPrev.addEventListener('click', () => jumpSeg(-1));
  if (bNext) bNext.addEventListener('click', () => jumpSeg(1));
  if (el.copSeek) {
    el.copSeek.min = String(Math.max(0, Math.round((state.copA || 0) * 1000)));
    el.copSeek.max = String(Math.max(1, Math.round(state.copSpan * 1000)));
    el.copPlay.addEventListener('click', togglePlay);
    el.copSeek.addEventListener('input', () => {
      stopPlay();
      setCopTime(+el.copSeek.value / 1000);
    });
  }
  setCopTime(state.copT);
}

export {drawMean, drawSeek, jumpSeg, renderCop, setCopTime, stopPlay, togglePlay};
