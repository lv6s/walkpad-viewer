/* 丢包 / 采样率页：按帧序号的缺口算丢包，按时间桶看每秒实到多少帧。 */

import {SIDE_CN} from './core/constants';
import {$, el} from './core/dom';
import {gapView, state} from './core/state';
import {baseName, css, downloadCanvas, downloadCsv, fmt, miniBtn, miniRow} from './core/util';

const RATE_H = 210, DT_H = 148;
const PAD = {l: 64, r: 16, t: 18, b: 28};
const BAD = 0.9;      // 桶内实到帧数低于标称的 90% 记为缺
const DT_HI = 1.5;    // 帧间隔超过标称的 1.5 倍记为异常

// 标称周期：先用中位数定标尺，再对「不超过 1.5 倍中位」的间隔取均值。
// 中位数单独用会偏高——时间戳按毫秒量化，真实 19.5 ms 会被记成 19/20/21 交替，
// 中位落 20 ms 就把标称报成 50 Hz，与顶部 chips 的 (n−1)/总时长 对不上；
// 均值单独用又会被丢包的长间隔拉低，丢得越多标称越低、反而掩盖丢包。
// 也不能用 manifest 的 nominal_fps：那份实测写的是 40，真实是 50。
function nominalPeriod(s) {
  const d = [];
  for (let k = 1; k < s.n; k++) { const v = s.t[k] - s.t[k - 1]; if (v > 0) d.push(v); }
  if (!d.length) return NaN;
  d.sort((a, b) => a - b);
  const p0 = d[d.length >> 1];
  let sum = 0, cnt = 0;
  for (const v of d) if (v <= p0 * 1.5) { sum += v; cnt++; }
  return cnt ? sum / cnt : p0;
}

// 帧序号相邻差 d>1 就是中间少了 d-1 帧；d<=0 是序号倒退（换连接 / 回绕 / 重新计数）。
// ⚠ 倒退处必须切段累计：拿「末值 − 首值 + 1」当跨度，一次重连就能算出负跨度、缺帧数变 0。
function analyze(s) {
  if (s.gapStat !== undefined) return s.gapStat;
  const p0 = nominalPeriod(s);
  const st = {has: !!s.fno, p0, fs0: p0 > 0 ? 1 / p0 : NaN, events: [], back: 0, backAt: NaN,
              runs: 0, arrived: 0, span: 0, missing: 0, rate: NaN, maxDt: 0, maxDtAt: NaN};
  if (!s.fno) { s.gapStat = st; return st; }

  let runFirst = NaN, last = NaN, span = 0, arrived = 0;
  for (let k = 0; k < s.n; k++) {
    const v = s.fno[k];
    if (!Number.isFinite(v)) continue;
    arrived++;
    if (!Number.isFinite(last)) { runFirst = last = v; continue; }
    const d = v - last;
    if (d <= 0) {
      span += last - runFirst + 1;          // 闭合当前段，跨段差值不计入缺帧
      st.back++;
      if (!Number.isFinite(st.backAt)) st.backAt = s.t[k];
      runFirst = last = v;
      continue;
    }
    if (d > 1) st.events.push({i0: k - 1, i1: k, t0: s.t[k - 1], t1: s.t[k], miss: d - 1, span: d});
    last = v;
  }
  if (Number.isFinite(last)) span += last - runFirst + 1;
  st.arrived = arrived;
  st.span = span;
  st.runs = st.back + 1;
  st.missing = Math.max(0, span - arrived);
  st.rate = span > 0 ? st.missing / span : NaN;
  for (let k = 1; k < s.n; k++) {
    const dt = s.t[k] - s.t[k - 1];
    if (dt > st.maxDt) { st.maxDt = dt; st.maxDtAt = s.t[k - 1]; }
  }
  s.gapStat = st;
  return st;
}

// 每秒实到多少帧。桶数太多就自动放宽到 dur/120。
function buckets(s, st) {
  const dur = Math.max(s.dur, st.p0 || 1);
  const bin = dur <= 120 ? 1 : dur / 120;
  const nb = Math.max(1, Math.ceil(dur / bin));
  const cnt = new Float64Array(nb);
  for (let k = 0; k < s.n; k++) {
    let b = Math.floor(s.t[k] / bin);
    if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
    cnt[b]++;
  }
  return {bin, nb, cnt};
}

function geo(cv, H) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = Math.max(360, cv.parentElement.clientWidth || 900);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return {g, W, H, plotW: W - PAD.l - PAD.r, plotH: H - PAD.t - PAD.b};
}

function drawRate(entry, hover?) {
  const {s, st, cvRate: cv} = entry;
  const {bin, nb, cnt} = entry.bk;
  const fs0 = st.fs0;
  const {g, W, plotW, plotH} = geo(cv, RATE_H);
  const ymax = Math.max(fs0 * 1.15, ...cnt) / bin * 1.02 || 1;
  const X = t => PAD.l + t / (nb * bin) * plotW;
  const Y = v => PAD.t + plotH - v / ymax * plotH;
  entry.geo = {X, Y, bin, nb, plotW, plotH};

  // 网格 + y 轴刻度
  g.strokeStyle = css('--grid'); g.lineWidth = 1;
  g.fillStyle = css('--faint'); g.font = '10px system-ui,sans-serif'; g.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = ymax * i / 4, y = Y(v);
    g.beginPath(); g.moveTo(PAD.l, y + .5); g.lineTo(W - PAD.r, y + .5); g.stroke();
    g.fillText(fmt(v, v < 10 ? 1 : 0), PAD.l - 6, y + 3.5);
  }

  // 柱子
  const bw = Math.max(1, plotW / nb - 1);
  for (let k = 0; k < nb; k++) {
    const cov = Math.min(bin, Math.max(0, s.dur - k * bin));
    const fs = cnt[k] / Math.max(cov, bin * 0.3);
    const short = cov >= bin * 0.3 && fs0 > 0 && fs < fs0 * BAD;
    g.fillStyle = short ? '#d64545' : css('--accent');
    g.globalAlpha = short ? 0.95 : 0.55;
    const h = Math.max(1, plotH - (Y(fs) - PAD.t));
    g.fillRect(X(k * bin), Y(fs), bw, h);
  }
  g.globalAlpha = 1;

  // 标称参考线
  if (fs0 > 0) {
    const y = Y(fs0);
    g.strokeStyle = css('--ink'); g.globalAlpha = .55; g.lineWidth = 1.2;
    g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(PAD.l, y + .5); g.lineTo(W - PAD.r, y + .5); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
    g.fillStyle = css('--ink'); g.textAlign = 'left'; g.font = '10.5px system-ui,sans-serif';
    g.fillText('标称 ' + fs0.toFixed(2) + ' Hz', PAD.l + 4, y - 5);
  }

  // x 轴
  g.strokeStyle = css('--line');
  g.beginPath(); g.moveTo(PAD.l, PAD.t + plotH + .5); g.lineTo(W - PAD.r, PAD.t + plotH + .5); g.stroke();
  g.fillStyle = css('--faint'); g.font = '10px system-ui,sans-serif'; g.textAlign = 'center';
  const step = niceStep(nb * bin, 8);
  for (let t = 0; t <= nb * bin + 1e-9; t += step) {
    const x = X(t);
    if (x > W - PAD.r + 1) break;
    g.fillText(t.toFixed(0), x, PAD.t + plotH + 14);
  }
  g.textAlign = 'left';
  g.fillText('时间 (s)', W - PAD.r - 44, PAD.t + plotH + 14);
  g.save();
  g.translate(13, PAD.t + plotH / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center';
  g.fillText('帧 / 秒', 0, 0);
  g.restore();

  // 悬停：定位到桶
  if (hover && entry.hoverK != null) {
    const k = entry.hoverK;
    const cov = Math.min(bin, Math.max(0, s.dur - k * bin));
    const fs = cnt[k] / Math.max(cov, bin * 0.3);
    const x = X(k * bin);
    g.strokeStyle = css('--accent'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + .5, PAD.t); g.lineTo(x + .5, PAD.t + plotH); g.stroke();
    g.fillStyle = css('--ink'); g.textAlign = 'left';
    g.font = '10.5px system-ui,sans-serif';
    g.fillText(fmt(cnt[k]) + ' 帧 / ' + bin.toFixed(1) + ' s = ' + fs.toFixed(2) + ' Hz', x + 6, PAD.t + 12);
  }
}

function drawDt(entry, hover?) {
  const {s, st, cvDt: cv} = entry;
  const {g, W, plotW, plotH} = geo(cv, DT_H);
  const p0 = st.p0 > 0 ? st.p0 : 0.02;
  const ymax = Math.max(p0 * 3, st.maxDt * 1.1) * 1000;
  const dur = Math.max(s.dur, 1e-6);
  const X = t => PAD.l + t / dur * plotW;
  const Y = v => PAD.t + plotH - v / ymax * plotH;
  entry.geoDt = {X, Y, plotW, plotH, ymax};

  g.strokeStyle = css('--grid'); g.lineWidth = 1;
  g.fillStyle = css('--faint'); g.font = '10px system-ui,sans-serif'; g.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const v = ymax * i / 3, y = Y(v);
    g.beginPath(); g.moveTo(PAD.l, y + .5); g.lineTo(W - PAD.r, y + .5); g.stroke();
    g.fillText(v.toFixed(0), PAD.l - 6, y + 3.5);
  }

  // 正常间隔一条带：标称 ±20%
  const yA = Y(p0 * 1000 * 1.2), yB = Y(p0 * 1000 * 0.8);
  g.fillStyle = css('--accent'); g.globalAlpha = .10;
  g.fillRect(PAD.l, yA, plotW, yB - yA);
  g.globalAlpha = 1;

  // 逐帧间隔
  g.strokeStyle = css('--accent'); g.globalAlpha = .8; g.lineWidth = 1;
  g.beginPath();
  for (let k = 1; k < s.n; k++) {
    const x = X(s.t[k]), y = Y((s.t[k] - s.t[k - 1]) * 1000);
    if (k === 1) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.globalAlpha = 1;

  // 异常点：超过标称 1.5 倍
  g.fillStyle = '#d64545';
  for (let k = 1; k < s.n; k++) {
    const dt = s.t[k] - s.t[k - 1];
    if (dt <= p0 * DT_HI) continue;
    g.beginPath(); g.arc(X(s.t[k]), Y(dt * 1000), 2.6, 0, Math.PI * 2); g.fill();
  }

  g.strokeStyle = css('--line');
  g.beginPath(); g.moveTo(PAD.l, PAD.t + plotH + .5); g.lineTo(W - PAD.r, PAD.t + plotH + .5); g.stroke();
  g.fillStyle = css('--faint'); g.font = '10px system-ui,sans-serif'; g.textAlign = 'center';
  const step = niceStep(dur, 8);
  for (let t = 0; t <= dur + 1e-9; t += step) {
    const x = X(t);
    if (x > W - PAD.r + 1) break;
    g.fillText(t.toFixed(0), x, PAD.t + plotH + 14);
  }
  g.textAlign = 'left';
  g.fillText('时间 (s)', W - PAD.r - 44, PAD.t + plotH + 14);
  g.save();
  g.translate(13, PAD.t + plotH / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center';
  g.fillText('帧间隔 (ms)', 0, 0);
  g.restore();

  if (hover && entry.hoverI != null) {
    const k = entry.hoverI;
    const x = X(s.t[k]), y = Y((s.t[k] - s.t[k - 1]) * 1000);
    g.strokeStyle = css('--accent'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + .5, PAD.t); g.lineTo(x + .5, PAD.t + plotH); g.stroke();
    g.fillStyle = css('--ink'); g.fillRect(x - 2.5, y - 2.5, 5, 5);
    g.textAlign = 'left'; g.font = '10.5px system-ui,sans-serif';
    g.fillText(((s.t[k] - s.t[k - 1]) * 1000).toFixed(1) + ' ms', x + 7, Math.max(PAD.t + 10, y - 6));
  }
}

function niceStep(span, n) {
  if (!(span > 0)) return 1;
  const raw = span / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= raw) return k * p;
  return 10 * p;
}

// 悬停：采样率图按桶，帧间隔图按最近帧
function bindHover(entry) {
  const rate = entry.cvRate, dtc = entry.cvDt;
  rate.addEventListener('mousemove', ev => {
    const r = rate.getBoundingClientRect();
    const geo = entry.geo;
    if (!geo) return;
    const x = ev.clientX - r.left;
    const k = Math.floor((x - PAD.l) / geo.plotW * geo.nb);
    if (k < 0 || k >= geo.nb) { entry.hoverK = null; entry.paint(); el.tip.style.display = 'none'; return; }
    entry.hoverK = k;
    entry.paint();
    // 桶内帧数受桶边界切分影响，与丢包区间表的口径不完全一致，这里只报实到帧数与频率
    const fs = entry.bk.cnt[k] / entry.bk.bin;
    tipAt(ev, `t = ${(k * geo.bin).toFixed(1)}–${((k + 1) * geo.bin).toFixed(1)} s\n`
      + `实到 ${fmt(entry.bk.cnt[k])} 帧　${fs.toFixed(2)} Hz（标称 ${entry.st.fs0.toFixed(2)}）`);
  });
  rate.addEventListener('mouseleave', () => {
    entry.hoverK = null; entry.paint(); el.tip.style.display = 'none';
  });

  dtc.addEventListener('mousemove', ev => {
    const r = dtc.getBoundingClientRect();
    const geo = entry.geoDt;
    if (!geo) return;
    const s = entry.s;
    const t = (ev.clientX - r.left - PAD.l) / geo.plotW * Math.max(s.dur, 1e-6);
    let lo = 1, hi = s.n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s.t[m] < t) lo = m + 1; else hi = m; }
    entry.hoverI = Math.max(1, lo);
    entry.paintDt();
    const k = entry.hoverI, d = (s.t[k] - s.t[k - 1]) * 1000;
    tipAt(ev, `t = ${s.t[k].toFixed(2)} s\n间隔 ${d.toFixed(1)} ms（标称 ${(entry.st.p0 * 1000).toFixed(1)}）`);
  });
  dtc.addEventListener('mouseleave', () => {
    entry.hoverI = null; entry.paintDt(); el.tip.style.display = 'none';
  });
}

function tipAt(ev, text) {
  el.tip.textContent = text;
  el.tip.style.display = 'block';
  el.tip.style.left = (ev.clientX + 14) + 'px';
  el.tip.style.top = (ev.clientY + 14) + 'px';
}

// ---------------------------------------------------------------- 维特 TXT
// 时间戳是上位机写盘时刻，不是采样时刻：实测 40 帧挤在 16 ms 内写完，38% 的相邻帧时间戳相同。
// 逐帧间隔因此不可用，能用的只有累计帧数：
//   局部帧率 = ±3 s 窗内对「累计帧数 ~ 墙钟时间」做线性回归的斜率
//   整段缺口 = 总时长 ÷ 名义周期 − 实到帧数
const WIT_HALF = 3;      // 局部帧率的半窗（s）。±1 s 散幅 35%、±2 s 11%、±3 s 5%
const WIT_NOM_HZ = 50;   // 器件设定速率，只用来算整段缺口

// 只用完整窗：贴着首尾的半窗只有一半样本，斜率会偏
function witRates(T, cum, half, span) {
  const nb = T.length, out = new Float64Array(nb).fill(NaN);
  let lo = 0, hi = 0;
  for (let i = 0; i < nb; i++) {
    if (T[i] - half < T[0] || T[i] + half > span) continue;
    const a = T[i] - half, b = T[i] + half;
    while (lo < nb && T[lo] < a) lo++;
    if (hi < lo) hi = lo;
    while (hi < nb && T[hi] <= b) hi++;
    const m = hi - lo;
    if (m < 6) continue;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = lo; j < hi; j++) {
      sx += T[j]; sy += cum[j]; sxx += T[j] * T[j]; sxy += T[j] * cum[j];
    }
    const den = m * sxx - sx * sx;
    if (den > 0) out[i] = (m * sxy - sx * sy) / den;
  }
  return out;
}

function analyzeWit(s) {
  if (s.witStat !== undefined) return s.witStat;
  const st: any = {ok: false, span: 0, nBat: 0, maxBat: 0, maxGap: 0, maxGapAt: 0,
              p0: NaN, fs0: NaN, rate: null, rMin: NaN, rMax: NaN,
              band: NaN, med: NaN, nOut: 0, missNom: NaN, lossNom: NaN};
  const w = s.wit;
  if (!w || !w.K.length || s.n < 2) { s.witStat = st; return st; }
  st.ok = true;
  const nb = w.K.length, T = w.T, K = w.K;
  st.span = w.span;
  st.nBat = nb;
  st.p0 = w.span / (s.n - 1);
  st.fs0 = st.p0 > 0 ? 1 / st.p0 : NaN;
  for (let i = 0; i < nb; i++) if (K[i] > st.maxBat) st.maxBat = K[i];
  for (let i = 1; i < nb; i++) {
    const d = T[i] - T[i - 1];
    if (d > st.maxGap) { st.maxGap = d; st.maxGapAt = T[i - 1]; }
  }
  const cum = new Float64Array(nb);
  let c = 0;
  for (let i = 0; i < nb; i++) { c += K[i]; cum[i] = c; }
  st.cum = cum;
  st.rate = witRates(T, cum, WIT_HALF, w.span);

  // 噪声底用鲁棒标准差：窗内斜率本身就会被写盘突发拉偏，±3 s 窗实测约 ±11%
  const vals = [];
  for (let i = 0; i < nb; i++) if (Number.isFinite(st.rate[i])) vals.push(st.rate[i]);
  let med = NaN, band = NaN, nOut = 0;
  if (vals.length) {
    vals.sort((a, b) => a - b);
    med = vals[vals.length >> 1];
    const dev = vals.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    band = Math.max(3 * 1.4826 * dev[dev.length >> 1], Math.abs(med) * 0.02);
    for (const v of vals) if (Math.abs(v - med) > band) nOut++;
    st.rMin = vals[0]; st.rMax = vals[vals.length - 1];
  }
  st.med = med; st.band = band; st.nOut = nOut;
  const exp = w.span * WIT_NOM_HZ + 1;
  st.missNom = exp - s.n;
  st.lossNom = exp > 0 ? st.missNom / exp : NaN;
  s.witStat = st;
  return st;
}

function drawWitRate(entry) {
  const {s, st, cvRate: cv} = entry;
  const {g, W, plotW, plotH} = geo(cv, RATE_H);
  const T = s.wit.T, R = st.rate, span = Math.max(st.span, 1e-6);
  const med = Number.isFinite(st.med) ? st.med : st.fs0;
  const lo = med - (st.band || 0), hi = med + (st.band || 0);
  let ymin = Math.min(lo, Number.isFinite(st.rMin) ? st.rMin : lo);
  let ymax = Math.max(hi, Number.isFinite(st.rMax) ? st.rMax : hi);
  if (!(ymax > ymin)) { ymin = 0; ymax = med * 2 || 1; }
  const padY = (ymax - ymin) * 0.12;
  ymin -= padY; ymax += padY;
  const X = t => PAD.l + t / span * plotW;
  const Y = v => PAD.t + plotH - (v - ymin) / (ymax - ymin) * plotH;
  entry.geoR = {X, Y, plotW, plotH, span};

  g.strokeStyle = css('--grid'); g.lineWidth = 1;
  g.fillStyle = css('--faint'); g.font = '10px system-ui,sans-serif'; g.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = ymin + (ymax - ymin) * i / 4, y = Y(v);
    g.beginPath(); g.moveTo(PAD.l, y + .5); g.lineTo(W - PAD.r, y + .5); g.stroke();
    g.fillText(v.toFixed(1), PAD.l - 6, y + 3.5);
  }

  // 噪声底：写盘突发让窗内斜率自己就晃，带内不算异常
  g.fillStyle = css('--accent'); g.globalAlpha = .10;
  g.fillRect(PAD.l, Y(hi), plotW, Y(lo) - Y(hi));
  g.globalAlpha = 1;

  // 中位参考线
  const y0 = Y(med);
  g.strokeStyle = css('--ink'); g.globalAlpha = .55; g.lineWidth = 1.2;
  g.setLineDash([5, 4]);
  g.beginPath(); g.moveTo(PAD.l, y0 + .5); g.lineTo(W - PAD.r, y0 + .5); g.stroke();
  g.setLineDash([]); g.globalAlpha = 1;
  g.fillStyle = css('--ink'); g.textAlign = 'left'; g.font = '10.5px system-ui,sans-serif';
  g.fillText('中位 ' + med.toFixed(2) + ' Hz　淡带 = ±3σ 写盘噪声（±'
    + (st.band || 0).toFixed(2) + ' Hz，' + (100 * (st.band || 0) / (med || 1)).toFixed(0) + '%）',
    PAD.l + 4, y0 - 5);

  // 曲线
  g.strokeStyle = css('--accent'); g.lineWidth = 1.4;
  g.beginPath();
  let started = false;
  for (let i = 0; i < T.length; i++) {
    const v = R[i];
    if (!Number.isFinite(v)) continue;
    const x = X(T[i]), y = Y(v);
    if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
  }
  g.stroke();

  // 出带的点
  g.fillStyle = '#d64545';
  for (let i = 0; i < T.length; i++) {
    const v = R[i];
    if (!Number.isFinite(v) || (v >= lo && v <= hi)) continue;
    g.beginPath(); g.arc(X(T[i]), Y(v), 2.2, 0, Math.PI * 2); g.fill();
  }

  g.strokeStyle = css('--line');
  g.beginPath(); g.moveTo(PAD.l, PAD.t + plotH + .5); g.lineTo(W - PAD.r, PAD.t + plotH + .5); g.stroke();
  g.fillStyle = css('--faint'); g.font = '10px system-ui,sans-serif'; g.textAlign = 'center';
  const step = niceStep(span, 8);
  for (let t = 0; t <= span + 1e-9; t += step) {
    const x = X(t);
    if (x > W - PAD.r + 1) break;
    g.fillText(t.toFixed(0), x, PAD.t + plotH + 14);
  }
  g.textAlign = 'left';
  g.fillText('时间 (s)', W - PAD.r - 44, PAD.t + plotH + 14);
  g.save();
  g.translate(13, PAD.t + plotH / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center';
  g.fillText('局部帧率 (Hz)', 0, 0);
  g.restore();

  if (entry.hoverR != null && Number.isFinite(R[entry.hoverR])) {
    const i = entry.hoverR, x = X(T[i]);
    g.strokeStyle = css('--accent'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + .5, PAD.t); g.lineTo(x + .5, PAD.t + plotH); g.stroke();
    g.fillStyle = css('--ink'); g.textAlign = 'left'; g.font = '10.5px system-ui,sans-serif';
    g.fillText('t = ' + T[i].toFixed(2) + ' s　' + R[i].toFixed(2) + ' Hz', x + 6, PAD.t + 12);
  }
}

function drawWitBatch(entry) {
  const {s, st, cvDt: cv} = entry;
  const {g, W, plotW, plotH} = geo(cv, DT_H);
  const T = s.wit.T, K = s.wit.K, span = Math.max(st.span, 1e-6);
  const ymax = Math.max(st.maxBat, 2) * 1.12;
  const X = t => PAD.l + t / span * plotW;
  const Y = v => PAD.t + plotH - v / ymax * plotH;
  entry.geoB = {X, Y, plotW, plotH, span, ymax};

  g.strokeStyle = css('--grid'); g.lineWidth = 1;
  g.fillStyle = css('--faint'); g.font = '10px system-ui,sans-serif'; g.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const v = ymax * i / 3, y = Y(v);
    g.beginPath(); g.moveTo(PAD.l, y + .5); g.lineTo(W - PAD.r, y + .5); g.stroke();
    g.fillText(v.toFixed(0), PAD.l - 6, y + 3.5);
  }

  const bw = Math.max(1, plotW / Math.max(T.length, 1) - 0.4);
  for (let i = 0; i < T.length; i++) {
    const big = K[i] > 3;
    g.fillStyle = big ? '#d64545' : css('--accent');
    g.globalAlpha = big ? .95 : .55;
    const y = Y(K[i]);
    g.fillRect(X(T[i]), y, bw, Math.max(1, PAD.t + plotH - y));
  }
  g.globalAlpha = 1;

  g.strokeStyle = css('--line');
  g.beginPath(); g.moveTo(PAD.l, PAD.t + plotH + .5); g.lineTo(W - PAD.r, PAD.t + plotH + .5); g.stroke();
  g.fillStyle = css('--faint'); g.font = '10px system-ui,sans-serif'; g.textAlign = 'center';
  const step = niceStep(span, 8);
  for (let t = 0; t <= span + 1e-9; t += step) {
    const x = X(t);
    if (x > W - PAD.r + 1) break;
    g.fillText(t.toFixed(0), x, PAD.t + plotH + 14);
  }
  g.textAlign = 'left';
  g.fillText('时间 (s)', W - PAD.r - 44, PAD.t + plotH + 14);
  g.save();
  g.translate(13, PAD.t + plotH / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center';
  g.fillText('每批帧数', 0, 0);
  g.restore();

  if (entry.hoverB != null) {
    const i = entry.hoverB, x = X(T[i]);
    g.strokeStyle = css('--accent'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + .5, PAD.t); g.lineTo(x + .5, PAD.t + plotH); g.stroke();
    g.fillStyle = css('--ink'); g.textAlign = 'left'; g.font = '10.5px system-ui,sans-serif';
    g.fillText('t = ' + T[i].toFixed(2) + ' s　这一批写了 ' + K[i] + ' 帧', x + 6, PAD.t + 12);
  }
}

function bindWitHover(entry) {
  const near = (cv, T, ev) => {
    const r = cv.getBoundingClientRect();
    const span = entry.st.span;
    const t = (ev.clientX - r.left - PAD.l) / Math.max(entry.geoR ? entry.geoR.plotW : 1) * span;
    let lo = 0, hi = T.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(T[lo - 1] - t) < Math.abs(T[lo] - t)) lo--;
    return lo;
  };
  const T = entry.s.wit.T;
  entry.cvRate.addEventListener('mousemove', ev => {
    entry.hoverR = near(entry.cvRate, T, ev);
    entry.paintR();
    const i = entry.hoverR;
    tipAt(ev, `t = ${T[i].toFixed(2)} s\n局部帧率 ${entry.st.rate[i].toFixed(2)} Hz（±${WIT_HALF} s 窗）`);
  });
  entry.cvRate.addEventListener('mouseleave', () => {
    entry.hoverR = null; entry.paintR(); el.tip.style.display = 'none';
  });
  entry.cvDt.addEventListener('mousemove', ev => {
    entry.hoverB = near(entry.cvDt, T, ev);
    entry.paintB();
    const i = entry.hoverB;
    tipAt(ev, `t = ${T[i].toFixed(2)} s\n这一批写了 ${entry.s.wit.K[i]} 帧`);
  });
  entry.cvDt.addEventListener('mouseleave', () => {
    entry.hoverB = null; entry.paintB(); el.tip.style.display = 'none';
  });
}

function renderGapWit() {
  const sec0 = document.createElement('section');
  sec0.className = 'copsec';
  const h2 = document.createElement('h2');
  h2.textContent = '丢包 / 采样率（维特 TXT：按累计帧数估算）';
  const note = document.createElement('details');
  note.className = 'note';
  const sum = document.createElement('summary');
  sum.textContent = '口径说明：为什么不能逐帧算间隔，这条帧率曲线是怎么来的';
  const meta = document.createElement('p');
  meta.textContent = '维特上位机是「攒一批再写盘」：同一批样本的时间戳挤在几毫秒里，与真实采样时刻无关'
    + '（本类文件实测 40 帧挤在 16 ms 内写完，38% 的相邻帧时间戳完全相同）。所以逐帧间隔、'
    + '「某处有个 1 s 的空洞」都不能当丢包 —— 那是上位机在批量补写。能用的只有累计帧数：'
    + '局部帧率取 ±3 s 窗内对「累计帧数 ~ 墙钟时间」做线性回归的斜率；窗口再窄就会被写盘突发拉爆'
    + '（实测 ±1 s 窗散幅 35%、±2 s 11%、±3 s 5%），所以固定 3 s，并只用完整窗（贴首尾的半窗只有一半样本，斜率会偏）。'
    + '淡带取这条曲线自身的 ±3 倍鲁棒标准差——写盘突发让窗内斜率自己就晃，带内不算异常，出带才值得看。'
    + '整段缺口 = 总时长 × 名义速率 − 实到帧数，名义速率取器件设定的 50 Hz；'
    + '实测均率通常比 50 Hz 低 0.2%–0.8%，这部分分不清是晶振偏慢还是真丢了几个包 —— '
    + '这种导出格式的丢包率分辨率上限就在这里，做不到逐包。要逐包得让固件给每帧带序号，'
    + '或自己写采集脚本、在每包到达时用高精度时钟打点。';
  note.append(sum, meta);
  sec0.append(h2, note);

  const stat = document.createElement('div');
  stat.className = 'copstats';
  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = '整段汇总';
  stat.appendChild(hd);
  for (const s of state.sides) {
    const st = analyzeWit(s);
    const line = document.createElement('div');
    const label = `<b>${s.dev || SIDE_CN[s.side] || s.side}</b>`;
    if (!st.ok) { line.innerHTML = label + '　没有可用的时间戳，算不出采样率'; stat.appendChild(line); continue; }
    const bad = st.missNom > st.span * WIT_NOM_HZ * 0.005;   // 超过 0.5% 才算真缺
    line.innerHTML = label
      + `　实到 <b>${fmt(s.n)}</b> 帧 / ${st.span.toFixed(2)} s`
      + `　实测均率 <b>${st.fs0.toFixed(2)}</b> Hz（${(st.p0 * 1000).toFixed(2)} ms/帧）`
      + `　按 ${WIT_NOM_HZ} Hz 应有 ${fmt(Math.round(st.span * WIT_NOM_HZ + 1))} 帧，`
      + `缺 <b class="${bad ? 'warn' : ''}">${fmt(Math.round(st.missNom))}</b> 帧`
      + `（<b class="${bad ? 'warn' : ''}">${(100 * st.lossNom).toFixed(2)}%</b>）`
      + `　写盘 <b>${fmt(st.nBat)}</b> 批（平均 ${(s.n / st.nBat).toFixed(1)} 帧/批，最大 ${st.maxBat} 帧）`
      + `　最长空洞 ${(st.maxGap * 1000).toFixed(0)} ms @ ${st.maxGapAt.toFixed(2)} s`
      + `　帧率出带 <b class="${st.nOut ? 'warn' : ''}">${st.nOut}</b> 处`;
    stat.appendChild(line);
  }
  sec0.appendChild(stat);
  el.gap.appendChild(sec0);

  for (const s of state.sides) {
    const st = analyzeWit(s);
    if (!st.ok) continue;
    const sec = document.createElement('section');
    sec.className = 'side';

    const head = document.createElement('div');
    head.className = 'sechead';
    const h = document.createElement('h2');
    h.textContent = (s.dev || SIDE_CN[s.side] || s.side) + '　帧率与写盘批次';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const bPng = miniBtn('PNG', '导出帧率曲线为图片', () => {
      const e = gapView.get(s.side);
      if (e) downloadCanvas(e.cvRate, `${baseName()}_${s.side}_rate.png`);
    });
    const bCsv = miniBtn('CSV', '导出逐批的时间 / 帧数 / 累计帧数 / 局部帧率', () => exportWitCsv(s, st));
    head.append(h, grow, bPng, bCsv);

    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = `局部帧率 = ±${WIT_HALF} s 窗线性回归斜率　|　淡带 = 这条曲线的 ±3σ（写盘突发噪声底）`
      + `　|　红点 = 出带，可能是真丢帧，也可能是上位机停顿`;

    const wrap1 = document.createElement('div');
    wrap1.className = 'canvas-wrap';
    const cvRate = document.createElement('canvas');
    wrap1.appendChild(cvRate);

    const wrap2 = document.createElement('div');
    wrap2.className = 'canvas-wrap';
    wrap2.style.marginTop = '6px';
    const cvDt = document.createElement('canvas');
    wrap2.appendChild(cvDt);

    const p2 = document.createElement('p');
    p2.className = 'meta';
    p2.textContent = `写盘批次：${fmt(st.nBat)} 批 / ${fmt(s.n)} 帧，红柱 = 一批超过 3 帧（上位机卡了一下再补写）。`
      + `这一栏就是时间轴不可信的原因 —— 批次之间的空洞是补写，不是丢包。`;

    sec.append(head, p, wrap1, wrap2, p2);

    const entry: any = {s, st, cvRate, cvDt, hoverR: null, hoverB: null};
    gapView.set(s.side, entry);
    entry.paintR = () => drawWitRate(entry);
    entry.paintB = () => drawWitBatch(entry);
    bindWitHover(entry);

    el.gap.appendChild(sec);
  }
}

function exportWitCsv(s, st) {
  const T = s.wit.T, K = s.wit.K, out = ['t_s,batch_frames,cum_frames,rate_hz'];
  let c = 0;
  for (let i = 0; i < T.length; i++) {
    c += K[i];
    out.push([T[i].toFixed(4), K[i], c,
              Number.isFinite(st.rate[i]) ? st.rate[i].toFixed(3) : ''].join(','));
  }
  downloadCsv(out, `${baseName()}_${s.side}_rate.csv`);
}

function renderGap() {
  el.gap.innerHTML = '';
  gapView.clear();
  if (!state.sides.length) return;
  if (state.mode === 'imu') { renderGapWit(); return; }

  const sec0 = document.createElement('section');
  sec0.className = 'copsec';
  const h2 = document.createElement('h2');
  h2.textContent = '丢包 / 采样率（按帧序号缺口统计）';
  const note = document.createElement('details');
  note.className = 'note';
  const sum = document.createElement('summary');
  sum.textContent = '口径说明：丢包率怎么算、采样率的分母是哪来的';
  const meta = document.createElement('p');
  meta.textContent = '丢包率 = 缺帧 ÷ 序号跨度。跨度按「序号单调段」分别累计再相加：'
    + '相邻序号差 d > 1 就是中间少了 d − 1 帧；d ≤ 0 是序号倒退（重连 / 回绕 / 重新计数），'
    + '那里只切段、不把跨段的差值算成缺帧——用「末值 − 首值 + 1」一次算全段，遇到一次重连就会得出负跨度。'
    + '旧包用 source_frame_number_unwrapped（已处理 uint32 回绕），没有该列时退回 source_frame_ordinal；'
    + '新包的 deviceSequence 是设备序号，重连后是否归零取决于固件，同样按段处理。'
    + '标称周期先取全段帧间隔的中位数定标尺，再对「不超过 1.5 倍中位」的间隔取均值——'
    + '只用中位会被毫秒量化抬高（真实 19.5 ms 记成 19/20/21 交替，中位落 20 ms 就报成 50 Hz），'
    + '只用均值又会被丢包的长间隔拉低、反而掩盖丢包。'
    + '不用 manifest 里的 nominal_fps：那份值实测写的是 40，真实是 50，拿它当分母会把正常数据算成 27.5% 丢包。'
    + '采样率图按固定时长分桶，桶内实到帧数 ÷ 桶时长；低于标称 90% 的桶标红。'
    + '帧间隔图逐帧画相邻两帧的时间差，超过标称 1.5 倍的点标红——丢 1 帧那里会跳到 2 个周期，丢 2 帧跳到 3 个。'
    + '左右脚是两条独立流（各自 connection_epoch），序号不跨侧合并。';
  note.append(sum, meta);
  sec0.append(h2, note);

  // 汇总行：两侧一起报
  const stat = document.createElement('div');
  stat.className = 'copstats';
  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = '整段汇总';
  stat.appendChild(hd);
  let anySeq = false;
  for (const s of state.sides) {
    const st = analyze(s);
    const line = document.createElement('div');
    if (!st.has) {
      line.innerHTML = `<b>${SIDE_CN[s.side] || s.side}</b>　这个文件没有帧序号列（source_frame_number_unwrapped / source_frame_ordinal），算不出丢包`;
    } else {
      anySeq = true;
      const bad = st.missing > 0;
      line.innerHTML = `<b>${SIDE_CN[s.side] || s.side}</b>　帧级丢包率 `
        + `<b class="${bad ? 'warn' : ''}">${(100 * st.rate).toFixed(3)}%</b>`
        + `　实到 <b>${fmt(st.arrived)}</b> / 应有 ${fmt(st.span)} 帧`
        + `　缺 <b class="${bad ? 'warn' : ''}">${fmt(st.missing)}</b> 帧`
        + `　丢包区间 <b>${st.events.length}</b> 段`
        + `　标称 ${(st.p0 * 1000).toFixed(1)} ms（${st.fs0.toFixed(2)} Hz）`
        + `　最大间隔 ${(st.maxDt * 1000).toFixed(1)} ms @ ${isFinite(st.maxDtAt) ? st.maxDtAt.toFixed(2) : '—'} s`
        + (st.back ? `　序号倒退 <b class="warn">${st.back}</b> 处（按 ${st.runs} 段分开累计）` : '');
    }
    stat.appendChild(line);
  }
  sec0.appendChild(stat);
  el.gap.appendChild(sec0);

  for (const s of state.sides) {
    const st = analyze(s);
    const sec = document.createElement('section');
    sec.className = 'side';

    const head = document.createElement('div');
    head.className = 'sechead';
    const h = document.createElement('h2');
    h.textContent = (SIDE_CN[s.side] || s.side) + '　采样率与帧间隔';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const bPng = miniBtn('PNG', '导出当前视图为图片', () => {
      const e = gapView.get(s.side);
      if (e) downloadCanvas(e.cvRate, `${baseName()}_${s.side}_rate.png`);
    });
    const bCsv = miniBtn('CSV', '导出逐帧时间 / 序号 / 间隔', () => exportGapCsv(s, st));
    head.append(h, grow, bPng, bCsv);

    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = st.has
      ? `分桶 ${(s.dur <= 120 ? 1 : s.dur / 120).toFixed(2)} s　|　红柱 = 该桶实到帧数低于标称 ${(BAD * 100).toFixed(0)}%`
        + `　|　红点 = 帧间隔超过标称 ${DT_HI}×`
      : '没有帧序号列，只能看帧间隔这一半';

    const wrap1 = document.createElement('div');
    wrap1.className = 'canvas-wrap';
    const cvRate = document.createElement('canvas');
    wrap1.appendChild(cvRate);

    const wrap2 = document.createElement('div');
    wrap2.className = 'canvas-wrap';
    wrap2.style.marginTop = '6px';
    const cvDt = document.createElement('canvas');
    wrap2.appendChild(cvDt);

    sec.append(head, p, wrap1, wrap2);

    const entry: any = {s, st, cvRate, cvDt, bk: buckets(s, st), hoverK: null, hoverI: null};
    gapView.set(s.side, entry);
    entry.paint = () => drawRate(entry, true);
    entry.paintDt = () => drawDt(entry, true);
    bindHover(entry);

    if (st.events.length) {
      const tb = document.createElement('table');
      tb.className = 'gaptbl';
      tb.innerHTML = '<thead><tr><th>#</th><th>起 (s)</th><th>止 (s)</th><th>序号跨度</th>'
        + '<th>缺帧</th><th>间隔 (ms)</th></tr></thead><tbody>'
        + st.events.map((e, i) => `<tr><td>${i + 1}</td><td>${e.t0.toFixed(3)}</td>`
          + `<td>${e.t1.toFixed(3)}</td><td>${fmt(e.span)}</td>`
          + `<td class="warn">${fmt(e.miss)}</td><td>${((e.t1 - e.t0) * 1000).toFixed(1)}</td></tr>`).join('')
        + '</tbody>';
      sec.appendChild(tb);
    }
    el.gap.appendChild(sec);
  }
}

function exportGapCsv(s, st) {
  const out = ['t_s,frame_no,dt_ms,gap_before'];
  for (let k = 0; k < s.n; k++) {
    const dt = k ? (s.t[k] - s.t[k - 1]) * 1000 : NaN;
    const d = k && s.fno ? s.fno[k] - s.fno[k - 1] : NaN;
    out.push([s.t[k].toFixed(6),
              s.fno && Number.isFinite(s.fno[k]) ? s.fno[k] : '',
              Number.isFinite(dt) ? dt.toFixed(3) : '',
              Number.isFinite(d) && d > 1 ? (d - 1) : 0].join(','));
  }
  downloadCsv(out, `${baseName()}_${s.side}_gap.csv`);
}

function drawGap() {
  for (const e of gapView.values()) {
    if (e.paintR) { e.paintR(); e.paintB(); continue; }
    drawRate(e); drawDt(e);
  }
}

export {renderGap, drawGap};
