/* 设备侧图表：折线图、指标对比、姿态 cubes、演示数据。 */

const AXIS_COLORS = ['#e03131', '#2f9e44', '#1971c2'];

const GREY = '#adb5bd';

const DEV_COLORS = ['#1971c2', '#e8590c', '#2f9e44', '#9c36b5', '#0b7285', '#c2255c', '#5f3dc4', '#847545'];

/* ---------- 工具栏 ---------- */
function segPick(id, onPick, multi) {
  $(id).onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    /* multi 段由 onPick 自己同步高亮（面板可叠加，不能在这里按单选互斥） */
    if (!multi) [...e.currentTarget.children].forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset);
  };
}

/* 四个面板可任意叠加：现场采集时经常要同时盯维特波形和摄像头画面，
   互斥切换会逼着来回点。哪些开着记进 localStorage，下次打开还是同一套。 */
const VIEWS = ['grid', 'compare', 'cam', 'imur'];
const VIEW_KEY = 'wt901.views';

function loadViews() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    if (Array.isArray(v) && v.length) {
      const ok = v.filter((x) => VIEWS.includes(x));
      if (ok.length) return new Set(ok);
    }
  } catch (e) { /* 存不下或格式坏了就回默认 */ }
  return new Set(['grid']);
}

function saveViews(v) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify([...v])); } catch (e) { /* 忽略 */ }
}

/* 摄像头卡只在有设备卡同排时占半列。没有设备卡就独占整行，
   否则单开「摄像头 + 鞋垫」时右半屏整块是空的。
   摄像头是竖画面时改成按画面比例收窄那一列，见 #stage.withcam。 */
function syncCamSpan() {
  const n = $('devGrid').querySelectorAll('.dev').length;
  const pair = state.views.has('grid') && n > 0;
  $('camCard').classList.toggle('solo', state.views.has('cam') && !pair);
  /* 横画面的比例本来就接近半列，收窄反而把画面变小；只在竖画面时动手。
     「分设备」没开时设备卡不显示，摄像头独占两列，收了反而把画面挤到左边 */
  const ar = camAspect();
  $('stage').classList.toggle('withcam',
    state.views.has('cam') && state.views.has('grid') && n === 1 && ar > 0 && ar < 0.9);
  camColFit();
  requestAnimationFrame(camSpanWide);
}

/* 摄像头卡被挤到新的一行、那一行只有它自己时（设备数是偶数），
   让它跨整行：否则旁边留半格空洞，比画面两侧的留白更扎眼。 */
function camSpanWide() {
  const card = $('camCard');
  if (!card.classList.contains('on')) { card.classList.remove('wide'); return; }
  const top = card.getBoundingClientRect().top;
  const same = [...$('devGrid').querySelectorAll('.dev')]
    .some((d) => Math.abs(d.getBoundingClientRect().top - top) < 2);
  card.classList.toggle('wide', !same);
}

function applyViews() {
  const v = state.views;
  const cmp = v.has('compare'), cm = v.has('cam'), im = v.has('imur');
  $('segMetric').style.display = cmp ? '' : 'none';
  $('segAxis').style.display = cmp ? '' : 'none';
  $('cmpCard').classList.toggle('on', cmp);
  $('camCard').classList.toggle('on', cm);
  $('imurCard').classList.toggle('on', im);
  $('devGrid').style.display = v.has('grid') ? 'contents' : 'none';
  syncCamSpan();
  if (cm) { camList(); camPermNote(); }
  if (im) { irHead(); irNums(ir.last); irDraw(); irPressDraw(); prNums(); }
  renderLegend();
  lastDraw = 0;
}

function syncViewBtns() {
  for (const b of $('segMode').children) b.classList.toggle('on', state.views.has(b.dataset.m));
}

/* 单选语义：只留指定面板（?view= 参数和代码里切页用） */
function setMode(m, syncBtns) {
  state.views = new Set([m]);
  if (syncBtns) syncViewBtns();
  saveViews(state.views);
  applyViews();
}

function toggleView(m) {
  const v = state.views;
  if (v.has(m)) v.delete(m); else v.add(m);
  if (!v.size) v.add('grid');           // 全关掉会剩一片空白，兜底回「分设备」
  saveViews(v);
  syncViewBtns();
  applyViews();
}

segPick('segMode', (ds) => { toggleView(ds.m); renderLegend(); }, true);

segPick('segWin', (ds) => { state.window = +ds.w; });

segPick('segMetric', (ds) => { state.cmp.key = ds.k; renderLegend(); });

segPick('segAxis', (ds) => { state.cmp.axis = ds.a; renderLegend(); });

function renderLegend() {
  const box = $('legend');
  box.innerHTML = '';
  if (!state.views.has('compare')) return;
  for (const k of state.order) {
    const d = state.devices.get(k);
    if (!(d.connected || d.demo)) continue;
    const s = document.createElement('span');
    s.innerHTML = '<i style="background:' + d.color + '"></i>';
    s.append(document.createTextNode(d.label));
    box.append(s);
  }
  if (!box.childElementCount) box.innerHTML = '<span style="color:var(--mute)">无在线设备</span>';
}

/* ---------- 画布 ---------- */
function fit(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

function sliceFrom(arr, tStart) {
  let i = arr.length;
  while (i > 0 && arr[i - 1].t >= tStart) i--;
  return arr.slice(i);
}

/* ---------- 姿态线框 ---------- */
const CUBE = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];

const EDGES = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

function rot(r, p, y) {
  const k = Math.PI / 180, cr = Math.cos(r * k), sr = Math.sin(r * k);
  const cp = Math.cos(p * k), sp = Math.sin(p * k), cy = Math.cos(y * k), sy = Math.sin(y * k);
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr]
  ];
}

function project(v, unit, cx, cy) {
  return [cx + (v[0] - v[1]) * 0.866 * unit, cy + ((v[0] + v[1]) * 0.5 - v[2]) * unit];
}

function drawGizmo(canvas, ang) {
  const g = fit(canvas);
  if (!g) return;
  const { ctx, w, h } = g;
  const cx = w / 2, cy = h / 2 + 2, unit = Math.min(w, h) * 0.2;
  ctx.clearRect(0, 0, w, h);
  const R = ang ? rot(ang[0], ang[1], ang[2]) : rot(0, 0, 0);
  const T = (p) => [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2]
  ];
  ctx.strokeStyle = '#d5dde8'; ctx.lineWidth = 1.1;
  for (const [a, b] of EDGES) {
    const p1 = project(T(CUBE[a]), unit, cx, cy), p2 = project(T(CUBE[b]), unit, cx, cy);
    ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
  }
  [[[1.5, 0, 0], 0], [[0, 1.5, 0], 1], [[0, 0, 1.5], 2]].forEach(([v, k]) => {
    const p = project(T(v), unit, cx, cy);
    ctx.strokeStyle = AXIS_COLORS[k]; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p[0], p[1]); ctx.stroke();
    ctx.fillStyle = AXIS_COLORS[k];
    ctx.beginPath(); ctx.arc(p[0], p[1], 4.4, 0, 7); ctx.fill();
    ctx.font = '700 11px ui-monospace,Consolas,monospace';
    ctx.fillText('XYZ'[k], p[0] + 7, p[1] - 5);
  });
  ctx.fillStyle = '#b6c1cf';
  ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, 7); ctx.fill();
}

/* 刻度上取整到 1/2/5×10^n，纵轴标签固定为整数档 */
function niceUp(v) {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
}

/* ---------- 每台独立波形（三组子图 + 共用时间轴） ---------- */
function drawDeviceChart(d) {
  const g = fit(d.ui.chart);
  if (!g) return;
  const { ctx, w, h } = g;
  ctx.clearRect(0, 0, w, h);
  const PL = 40, PR = 8, PT = 19, PB = 21, GAP = 17;
  const iw = w - PL - PR;
  const ph = (h - PT - PB - GAP * (PANELS.length - 1)) / PANELS.length;
  const tEnd = state.tEnd;
  const tStart = Math.max(0, tEnd - state.window);
  const vis = sliceFrom(d.samples, tStart);
  const X = (t) => PL + ((t - tStart) / state.window) * iw;

  ctx.strokeStyle = '#eef1f6'; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const x = PL + (iw * k) / 4;
    ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, h - PB); ctx.stroke();
  }

  PANELS.forEach((p, idx) => {
    const top = PT + idx * (ph + GAP);
    let peak = 0;
    for (const s of vis) {
      const v = s[p.key];
      if (!v) continue;
      for (const x of v) peak = Math.max(peak, Math.abs(x));
    }
    const raw = Math.max(peak * 1.15, p.floor);
    const cur = d.ymax[p.key];
    /* 刻度吸附到 1/2/5×10^n：窗口滚动时可见峰值每帧都在变，直接跟着变会让整条曲线上下跳。
       变大立刻换档（否则波形被裁），变小时要跌破本档 70% 才退一档，档位边界不会来回抖。 */
    const up = niceUp(raw);
    if (up > cur || (up < cur && raw < cur * 0.7)) d.ymax[p.key] = up;
    const ymax = d.ymax[p.key];
    const Y = (v) => top + ph / 2 - (v / ymax) * (ph / 2);

    ctx.strokeStyle = '#f4f6fa';
    for (let k = 0; k <= 2; k++) {
      const y = top + (ph * k) / 2;
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
    }
    ctx.fillStyle = '#eef1f6';
    ctx.fillRect(PL, Y(0) - 0.5, iw, 1);

    ctx.font = '9.5px ui-monospace,Consolas,monospace';
    ctx.fillStyle = '#98a2b0'; ctx.textAlign = 'right';
    for (let k = 0; k <= 2; k++) {
      ctx.fillText((ymax - ymax * k).toFixed(p.fmt), PL - 5, top + (ph * k) / 2 + 3.2);
    }
    ctx.textAlign = 'left';
    const ty = top - 4;
    ctx.font = '600 10.5px system-ui,"Microsoft YaHei",sans-serif';
    const tw = ctx.measureText(p.title).width;
    ctx.font = '9.5px ui-monospace,Consolas,monospace';
    const uw = ctx.measureText(p.unit).width;
    ctx.fillStyle = '#fff';
    ctx.fillRect(PL + 2, ty - 10, tw + uw + 12, 13);   // 白底，避免与上一块曲线叠字
    ctx.fillStyle = '#6b7787';
    ctx.font = '600 10.5px system-ui,"Microsoft YaHei",sans-serif';
    ctx.fillText(p.title, PL + 4, ty);
    ctx.fillStyle = '#b0b9c6';
    ctx.font = '9.5px ui-monospace,Consolas,monospace';
    ctx.fillText(p.unit, PL + 4 + tw + 6, ty);

    const step = vis.length > 700 ? Math.ceil(vis.length / 700) : 1;
    for (let c = 0; c < 3; c++) {
      ctx.strokeStyle = AXIS_COLORS[c]; ctx.lineWidth = 1.3;
      ctx.beginPath();
      let started = false, prevT = 0;
      for (let i = 0; i < vis.length; i += step) {
        const s = vis[i], v = s[p.key];
        if (!v) continue;
        if (started && s.t - prevT > 0.2) started = false;   // 断档处断开，别拉成直线
        const px = X(s.t), py = Y(v[c]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        prevT = s.t;
      }
      ctx.stroke();
    }
    if (p.key === 'acc') {
      ctx.strokeStyle = GREY; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath();
      let started = false, prevT = 0;
      for (let i = 0; i < vis.length; i += step) {
        const s = vis[i];
        if (!s.acc) continue;
        if (started && s.t - prevT > 0.2) started = false;
        const px = X(s.t), py = Y(Math.hypot(s.acc[0], s.acc[1], s.acc[2]));
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        prevT = s.t;
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
  });

  ctx.fillStyle = '#98a2b0';
  ctx.font = '9.5px ui-monospace,Consolas,monospace';
  for (let k = 0; k <= 4; k++) {
    const x = PL + (iw * k) / 4;
    ctx.textAlign = k === 0 ? 'left' : k === 4 ? 'right' : 'center';
    ctx.fillText((tStart + (state.window * k) / 4).toFixed(1) + 's', x, h - 4);
  }
  ctx.textAlign = 'left';
}

/* ---------- 对比叠加 ---------- */
function cmpValue(s, key, axis) {
  const v = s[key];
  if (!v) return null;
  return axis === 'm' ? Math.hypot(v[0], v[1], v[2]) : v[+axis];
}

function drawCompare() {
  const g = fit($('cmpChart'));
  if (!g) return;
  const { ctx, w, h } = g;
  ctx.clearRect(0, 0, w, h);
  const PL = 46, PR = 12, PT = 20, PB = 26;
  const iw = w - PL - PR, ih = h - PT - PB;
  const list = [];
  for (const k of state.order) {
    const d = state.devices.get(k);
    if (d.connected || d.demo) list.push(d);
  }
  const p = PANELS.find((x) => x.key === state.cmp.key);
  const tEnd = state.tEnd;
  const tStart = Math.max(0, tEnd - state.window);
  const X = (t) => PL + ((t - tStart) / state.window) * iw;

  const visMap = new Map();
  let peak = 0;
  for (const d of list) {
    const seg = sliceFrom(d.samples, tStart);
    visMap.set(d.key, seg);
    for (const s of seg) {
      const v = cmpValue(s, p.key, state.cmp.axis);
      if (v !== null && Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  const target = Math.max(peak * 1.15, state.cmp.axis === 'm' ? p.floor * 1.4 : p.floor);
  state.cmpYmax = target > state.cmpYmax ? target : state.cmpYmax * 0.985 + target * 0.015;
  const ymax = state.cmpYmax;
  const Y = (v) => PT + ih / 2 - (v / ymax) * (ih / 2);

  ctx.strokeStyle = '#f1f4f8'; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const y = PT + (ih * k) / 4;
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
    const x = PL + (iw * k) / 4;
    ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, h - PB); ctx.stroke();
  }
  ctx.fillStyle = '#e3e8ef';
  ctx.fillRect(PL, Y(0) - 0.5, iw, 1);

  ctx.font = '10px ui-monospace,Consolas,monospace';
  ctx.fillStyle = '#98a2b0'; ctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) {
    const val = ymax - (2 * ymax * k) / 4;
    ctx.fillText(val.toFixed(p.fmt), PL - 7, PT + (ih * k) / 4 + 3.5);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#6b7787';
  ctx.font = '600 11px system-ui,"Microsoft YaHei",sans-serif';
  const title = p.title + ' ' + (state.cmp.axis === 'm' ? '模' : 'XYZ'[+state.cmp.axis]);
  ctx.fillText(title, PL, PT - 7);
  ctx.fillStyle = '#98a2b0';
  ctx.font = '10px ui-monospace,Consolas,monospace';
  ctx.fillText(p.unit, PL + ctx.measureText(title).width + 22, PT - 7);

  for (const d of list) {
    const seg = visMap.get(d.key);
    ctx.strokeStyle = d.color; ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false, prevT = 0;
    const step = seg.length > 900 ? Math.ceil(seg.length / 900) : 1;
    for (let i = 0; i < seg.length; i += step) {
      const s = seg[i];
      const v = cmpValue(s, p.key, state.cmp.axis);
      if (v === null) continue;
      if (started && s.t - prevT > 0.2) started = false;
      const px = X(s.t), py = Y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      prevT = s.t;
    }
    ctx.stroke();
  }

  if (!list.length) {
    ctx.fillStyle = '#c3ccd8';
    ctx.font = '12px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('还没有在线设备', w / 2, h / 2);
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = '#98a2b0';
  ctx.font = '10px ui-monospace,Consolas,monospace';
  for (let k = 0; k <= 5; k++) {
    const x = PL + (iw * k) / 5;
    ctx.textAlign = k === 0 ? 'left' : k === 5 ? 'right' : 'center';
    ctx.fillText((tStart + (state.window * k) / 5).toFixed(1) + 's', x, h - 5);
  }
  ctx.textAlign = 'left';
}

/* ---------- 读数更新 ---------- */
const fmt = (v, dec) => (v === null || v === undefined ? '—' : v.toFixed(dec));

function updateReadout(d) {
  if (!d.ui) return;
  const S = d.samples, last = S[S.length - 1], f = d.ui.f;
  if (last) {
    const a = last.acc, g = last.gyr, n = last.ang;
    if (a) {
      f.ax.textContent = fmt(a[0], 2); f.ay.textContent = fmt(a[1], 2); f.az.textContent = fmt(a[2], 2);
      f.am.textContent = Math.hypot(a[0], a[1], a[2]).toFixed(2);
    }
    if (g) {
      f.gx.textContent = fmt(g[0], 1); f.gy.textContent = fmt(g[1], 1); f.gz.textContent = fmt(g[2], 1);
      f.gm.textContent = Math.hypot(g[0], g[1], g[2]).toFixed(1);
    }
    if (n) {
      f.rx.textContent = fmt(n[0], 1); f.ry.textContent = fmt(n[1], 1); f.rz.textContent = fmt(n[2], 1);
      f.rm.textContent = Math.hypot(n[0], n[1], n[2]).toFixed(1);
    }
  }
  const e = d.extra;
  const packedOnly = !!d.types['0x61'] && !d.types['0x51'] && !d.types['0x52'] && !d.types['0x54'];
  f.temp.textContent = e.temp !== null ? e.temp.toFixed(1) + ' °C' : (packedOnly ? '未输出' : '—');
  f.mag.textContent = e.mag ? e.mag.map((v) => v.toFixed(0)).join(' / ') + ' mG' : (packedOnly ? '未输出' : '—');
  f.rate.textContent = d.rate;
  f.nf.textContent = d.frames;
  f.dur.textContent = last ? last.t.toFixed(1) : '0.0';
}

/* 无硬件预览：?demo=1 单台；?demo=3 三台；?demo=2 三台（拆分帧，带温度/磁场） */
function startDemo(n) {
  const count = n === 1 ? 1 : 3;
  const split = n === 2;
  for (let i = 0; i < count; i++) {
    const d = makeDevice({ demo: true, name: 'SYNTH-' + (i + 1), label: '模拟 ' + (i + 1) });
    d.connected = true;
    d.types['0x61'] = 0;
    feedDemo(d, split, i);
  }
  syncGrid();
  renderLegend();
  log('演示模式：' + count + ' 台合成设备' + (split ? '（拆分帧 + 温度/磁场）' : '（0x61 打包帧）'), 'i');
}

function feedDemo(d, split, idx) {
  const enc = (v, s) => {
    const r = Math.max(-32768, Math.min(32767, Math.round(v / s)));
    return [r & 255, (r >> 8) & 255];
  };
  const phase = idx * 1.7, gain = 1 + idx * 0.28;
  let k = 0;
  setInterval(() => {
    const bytes = [];
    const w6 = 6.2832;
    for (let j = 0; j < 2; j++, k++) {
      const t = k / 50 + phase;
      const acc = [0.45 * gain * Math.sin(w6 * t), 0.35 * gain * Math.sin(w6 * 1.3 * t + 0.7), 0.98 + 0.05 * gain * Math.sin(w6 * 2 * t)];
      const gyr = [60 * gain * Math.sin(w6 * 0.4 * t), -30 + 45 * gain * Math.sin(w6 * 0.7 * t), 20 * gain * Math.sin(w6 * 1.1 * t)];
      const ang = [25 * Math.sin(w6 * 0.15 * t), -15 + 10 * Math.sin(w6 * 0.2 * t), 120 * Math.sin(w6 * 0.1 * t)];
      const temp = 26.5 + idx * 0.6 + 0.3 * Math.sin(w6 * 0.05 * t);
      if (split) {
        bytes.push(0x55, 0x51, ...acc.flatMap((v) => enc(v, ACC_S)), ...enc(temp, 0.01), 0);
        bytes.push(0x55, 0x52, ...gyr.flatMap((v) => enc(v, GYR_S)), ...enc(temp, 0.01), 0);
        bytes.push(0x55, 0x53, ...ang.flatMap((v) => enc(v, ANG_S)), 0, 0, 0);
        if (k % 5 === 0) bytes.push(0x55, 0x54, ...enc(180, MAG_S), ...enc(-60, MAG_S), ...enc(320, MAG_S), 0, 0, 0);
      } else {
        bytes.push(0x55, 0x61, ...acc.flatMap((v) => enc(v, ACC_S)),
          ...gyr.flatMap((v) => enc(v, GYR_S)), ...ang.flatMap((v) => enc(v, ANG_S)));
      }
    }
    onPacket(d, new DataView(new Uint8Array(bytes).buffer));
  }, 40);
}
