/* 全程缩略条 + 时间段直接输入：不改窗口也能一眼看出哪里在受力，拖一下就换段。 */

import {el} from './core/dom';
import {state} from './core/state';
import {css, fmtT} from './core/util';
import {lazyWin} from './parse';
import {applyWin, fullDur, resetWin, winOf} from './timewin';

// 桶宽 0.5 s：再细看不出变化，再粗定位就费劲；上限防止长录制把桶数堆到几万
const BIN_S = 0.5, BIN_MAX = 6000;
const H = 54, PAD_X = 6, PAD_T = 8, PAD_B = 14;

// ---------------------------------------------------------------- 缩略数据
// 缩略量取「每帧通道读数之和」的桶内峰值：单通道峰值看不出整只脚在受力，
// 求和才把站立 / 行走这类区间和静止空载分开。
function ovInit(s) {
  const nb = Math.round(Math.max(64, Math.min(BIN_MAX, s.dur / BIN_S)));
  s.ov = (s.dur > 0 && s.nch > 0)
    ? {n: nb, v: new Float32Array(nb), max: 0, upto: 0, partial: !!s.lazy}
    : null;
  return s.ov;
}
function ovFeed(s, t, sum) {
  const ov = s.ov;
  if (!ov || !(sum > 0)) return;
  let b = Math.floor(t / s.dur * ov.n);
  b = b < 0 ? 0 : (b >= ov.n ? ov.n - 1 : b);
  if (sum > ov.v[b]) { ov.v[b] = sum; if (sum > ov.max) ov.max = sum; }
}
// 短片段整段数组都在手上，直接扫一遍；长录制由后台扫描逐块喂
function ovBuild(s) {
  if (!s.ov || !s.ch) return;
  for (let k = 0; k < s.n; k++) {
    let sum = 0;
    for (let j = 0; j < s.nch; j++) { const v = s.ch[j][k]; if (v > 0) sum += v; }
    ovFeed(s, s.t[k], sum);
  }
  s.ov.upto = s.dur;
}
function ovInitAll(sides) {
  for (const s of sides) {
    ovInit(s);
    if (!s.lazy) { ovBuild(s); if (s.ov) s.ov.partial = false; }
  }
}

// ---------------------------------------------------------------- 绘制
function drawScrub() {
  const cv = el.scrubCv, box = el.scrub;
  if (!cv || !box) return;
  const show = state.sides.length > 0 && state.hasP && state.tab === 'wave';
  box.hidden = !show;
  if (!show) return;
  const W = Math.round(cv.clientWidth);
  if (!(W > 40)) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const D = fullDur() || 1;
  const pw = W - PAD_X * 2, y0 = PAD_T, y1 = H - PAD_B, ph = y1 - y0;
  cv._geo = {
    D, x0: PAD_X, pw, y0, y1,
    tAt: px => Math.max(0, Math.min(1, (px - PAD_X) / pw)) * D,
    pxOf: t => PAD_X + Math.max(0, Math.min(1, t / D)) * pw
  };

  const cLine = css('--line'), cAcc = css('--accent');
  const cFaint = css('--faint'), cCard = css('--card');

  const ovs = state.sides.filter(s => s.ov).map(s => ({s, ov: s.ov}));
  const maxV = Math.max(1e-6, ...ovs.map(o => o.ov.max));
  const npx = Math.max(1, Math.round(pw));
  // 几千个桶压在千把像素上，逐桶画只会糊成一片：每像素取覆盖到的桶最大
  const per = new Float32Array(npx);
  for (const {s, ov} of ovs) {
    const k = ov.n / s.dur;
    for (let px = 0; px < npx; px++) {
      let b0 = Math.floor(px / npx * D * k), b1 = Math.floor((px + 1) / npx * D * k);
      if (b1 < b0) b1 = b0;
      let m = 0;
      for (let b = Math.max(0, b0); b <= b1 && b < ov.n; b++) if (ov.v[b] > m) m = ov.v[b];
      if (m > per[px]) per[px] = m;
    }
  }

  g.fillStyle = cAcc; g.globalAlpha = .5;
  for (let px = 0; px < npx; px++) {
    const v = per[px];
    if (!(v > 0)) continue;
    const h = Math.max(1, Math.sqrt(v / maxV) * ph);
    g.fillRect(PAD_X + px, y1 - h, 1, h);
  }
  g.globalAlpha = 1;
  g.strokeStyle = cLine; g.lineWidth = 1;
  g.beginPath(); g.moveTo(PAD_X, y1 + .5); g.lineTo(W - PAD_X, y1 + .5); g.stroke();

  // 后台统计还没扫到尾：扫过的实色，没扫的压一层淡底并写明状态
  const pend = ovs.filter(o => o.ov.partial);
  if (pend.length) {
    const up = Math.min(...pend.map(o => o.ov.upto));
    const x = PAD_X + Math.max(0, Math.min(1, up / D)) * pw;
    g.fillStyle = cCard; g.globalAlpha = .62;
    g.fillRect(x, y0, W - PAD_X - x, ph); g.globalAlpha = 1;
    g.fillStyle = cFaint; g.font = '10px system-ui,"Microsoft YaHei",sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    if (W - PAD_X - x > 56) g.fillText('统计中…', x + 4, y0 + 10);
  }

  const {a, b} = drag?.mode === 'sel'
    ? {a: Math.min(drag.t0, drag.t1), b: Math.max(drag.t0, drag.t1)} : winOf();
  const wx0 = cv._geo.pxOf(a), wx1 = Math.max(wx0 + 1.5, cv._geo.pxOf(b));
  g.fillStyle = cAcc; g.globalAlpha = state.win ? .14 : .07;
  g.fillRect(wx0, y0, wx1 - wx0, ph); g.globalAlpha = 1;
  g.strokeStyle = cAcc; g.lineWidth = 1.4;
  g.strokeRect(wx0 + .5, y0 + .5, Math.max(1, wx1 - wx0 - 1), ph - 1);
  if (state.win) {
    g.fillStyle = cAcc;
    g.fillRect(wx0 - 1, y0, 2.5, ph);
    g.fillRect(wx1 - 1.5, y0, 2.5, ph);
  }

  g.font = '10px system-ui,sans-serif'; g.fillStyle = cFaint;
  g.textAlign = 'left'; g.fillText('0 s', PAD_X + 1, H - 3);
  g.textAlign = 'right';
  g.fillText(fmtT(D, D), W - PAD_X - 1, H - 3);
}

// ---------------------------------------------------------------- 时间输入
const dirtyInputs = new Set<HTMLInputElement>();
let inputSides = state.sides;
function syncInputs(force = false) {
  if (inputSides !== state.sides) { dirtyInputs.clear(); inputSides = state.sides; }
  const D = fullDur();
  if (!(D > 0)) return;
  const w = winOf();
  for (const [inp, v] of [[el.tA, w.a], [el.tB, w.b]]) {
    if (!inp || (!force && (document.activeElement === inp || dirtyInputs.has(inp)))) continue;
    inp.value = v.toFixed(2);
    inp.max = D.toFixed(2);
    inp.setCustomValidity('');
    inp.removeAttribute('aria-invalid');
  }
}
// 只填一头也认：另一头保持当前跨度，省得每次都要填两个数
function jumpFromInputs() {
  const D = fullDur();
  if (!(D > 0)) return;
  const w = winOf(), span = Math.max(0.02, w.b - w.a);
  const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : NaN; };
  let a = num(el.tA && el.tA.value), b = num(el.tB && el.tB.value);
  if (!Number.isFinite(a) && !Number.isFinite(b)) { syncInputs(); return; }
  if (!Number.isFinite(a)) a = b - span;
  if (!Number.isFinite(b)) b = a + span;
  const invalid = !(b > a) || a < 0 || b > D + 0.005;
  if (invalid) {
    el.tB.setCustomValidity(`请输入 0–${D.toFixed(2)} s 内的时间段，结束时间须大于开始时间。`);
    el.tB.setAttribute('aria-invalid', 'true');
    el.tB.reportValidity();
    return;
  }
  dirtyInputs.clear();
  applyWin(a, Math.min(b, D));
  syncInputs(true);
}

// 点到缩略条空白处：以该时刻为中心开一段（跨度沿用当前窗口）
function jumpTo(t) {
  const D = fullDur();
  if (!(D > 0)) return;
  const w = winOf();
  const span = Math.min(D, Math.max(1, state.win ? w.b - w.a : (lazyWin || 60)));
  const a = Math.max(0, Math.min(t - span / 2, D - span));
  applyWin(a, a + span);
}

// ---------------------------------------------------------------- 交互
let drag = null;

function bindScrub() {
  const cv = el.scrubCv;
  if (!cv) return;
  const localX = ev => ev.clientX - cv.getBoundingClientRect().left;

  cv.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    cv.setPointerCapture(ev.pointerId);
    const geo = cv._geo;
    if (!geo || !state.sides.length) return;
    ev.preventDefault();
    const x = localX(ev), t = geo.tAt(x);
    if (!state.win) { drag = {mode: 'sel', t0: t, t1: t}; drawScrub(); return; }
    const pa = geo.pxOf(state.win.a), pb = geo.pxOf(state.win.b);
    let mode = Math.abs(x - pa) <= 6 ? 'l' : Math.abs(x - pb) <= 6 ? 'r'
      : (x > pa && x < pb ? 'move' : 'jump');
    drag = {mode, t0: t, a0: state.win.a, b0: state.win.b};
    if (mode === 'jump') {          // 窗外按下：先跳过去，接着还能继续拖
      jumpTo(t);
      const w = winOf();
      drag = {mode: 'move', t0: t, a0: w.a, b0: w.b};
    }
  });

  cv.addEventListener('pointermove', ev => {
    if (!drag) return;
    const geo = cv._geo;
    if (!geo) return;
    const t = geo.tAt(localX(ev)), D = geo.D;
    if (drag.mode === 'sel') { drag.t1 = t; drawScrub(); return; }
    if (drag.mode === 'l') { applyWin(Math.min(t, drag.b0 - 0.02), drag.b0); return; }
    if (drag.mode === 'r') { applyWin(drag.a0, Math.max(t, drag.a0 + 0.02)); return; }
    const span = drag.b0 - drag.a0;
    const a = Math.max(0, Math.min(t - (drag.t0 - drag.a0), D - span));
    applyWin(a, a + span);
  });

  cv.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode !== 'sel') { drawScrub(); return; }
    const D = (cv._geo && cv._geo.D) || 0;
    const a = Math.min(d.t0, d.t1), b = Math.max(d.t0, d.t1);
    // 拖出可见长度才算框选，否则当单击定位
    if (b - a > Math.max(0.2, D * 0.003)) applyWin(a, b);
    else jumpTo(d.t0);
    drawScrub();
  });

  cv.addEventListener('pointercancel', () => { drag = null; drawScrub(); });
  cv.addEventListener('lostpointercapture', () => { drag = null; });
  cv.addEventListener('dblclick', ev => { ev.preventDefault(); resetWin(); });

  // 指针位置读数：拖窗口时也要有，不然不知道拖到哪了
  cv.addEventListener('mousemove', ev => {
    const geo = cv._geo;
    if (!geo || !el.scrubTip) return;
    el.scrubTip.textContent = '游标 ' + geo.tAt(localX(ev)).toFixed(2) + ' s';
  });
  cv.addEventListener('mouseleave', () => { if (el.scrubTip) el.scrubTip.textContent = ''; });

  cv.addEventListener('wheel', ev => {
    const geo = cv._geo;
    if (!geo || !state.sides.length) return;
    ev.preventDefault();
    const D = geo.D, t = geo.tAt(localX(ev)), w = winOf();
    const span = Math.max(0.02, w.b - w.a);
    const ns = Math.max(0.1, Math.min(D, span * (ev.deltaY > 0 ? 1.3 : 1 / 1.3)));
    const f = (t - w.a) / span;                    // 以指针处为锚缩放
    const a = Math.max(0, Math.min(t - f * ns, D - ns));
    applyWin(a, a + ns);
  }, {passive: false});

  if (el.tGo) el.tGo.addEventListener('click', jumpFromInputs);
  for (const inp of [el.tA, el.tB]) {
    if (!inp) continue;
    inp.addEventListener('input', () => {
      dirtyInputs.add(inp);
      for (const field of [el.tA, el.tB]) { field.setCustomValidity(''); field.removeAttribute('aria-invalid'); }
    });
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); jumpFromInputs(); }
      if (ev.key === 'Escape') { dirtyInputs.clear(); syncInputs(true); inp.blur(); }
    });
  }
}

export {bindScrub, drawScrub, jumpFromInputs, ovFeed, ovInit, ovInitAll, syncInputs};
