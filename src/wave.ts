/* 波形页：56 格同尺描边、悬停对齐、离屏底图。 */

import {GRID} from './core/constants';
import {$} from './core/dom';
import {state} from './core/state';
import {css, fmt, fmtT} from './core/util';
import {idxAt} from './detail';
import {ictoPaint} from './icto/view';
import {dataOf, hzOf, stepOf} from './lod';
import {gridDims} from './parse';
import {metaText, visRange, winOf} from './timewin';

// 波形描边。抽帧优先：步长由屏宽与显示采样率定，跳着取真实帧，不插值、不做 min–max ——
// 一个异常值不该把整格都占满。步长 1 且帧数已远多于像素列时才退回按列包络。
// 只画 [A,B] 窗口内的帧，并裁到格子边界——窗口外的帧不裁掉会横穿相邻格子
function tracePath(g, blk, j, x0, y0, w, h, ymax, A, B, step = 1) {
  const ch = blk.ch[j], t = blk.t;
  const a = A == null ? 0 : A, b = B == null ? (blk.b || 1) : B;
  const span = (b - a) || 1;
  const {i0, i1} = visRange(blk, a, b);
  if (i1 < i0) return;

  g.save();
  g.beginPath(); g.rect(x0, y0, w, h); g.clip();
  g.beginPath();
  const count = Math.ceil((i1 - i0 + 1) / step);
  if (count <= 6 * w) {
    const kx = w / span;
    let pen = false;      // 缺值处断笔：NaN 不能当 0 画，也不能拖一条斜线跨过去
    for (let k = i0; k <= i1; k += step) {
      const v = ch[k];
      if (!Number.isFinite(v)) { pen = false; continue; }
      const x = x0 + (t[k] - a) * kx;
      const y = y0 + h - Math.min(1, v / ymax) * h;
      if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
    }
    g.stroke();
    g.restore();
    return;
  }
  const cols = Math.max(1, Math.round(w));
  const mn = new Float32Array(cols).fill(Infinity);
  const mxs = new Float32Array(cols).fill(-Infinity);
  for (let k = i0; k <= i1; k += step) {
    const v = ch[k];
    if (!Number.isFinite(v)) continue;
    let px = Math.round(((t[k] - a) / span) * (cols - 1));
    if (px < 0) px = 0; else if (px >= cols) px = cols - 1;
    if (v < mn[px]) mn[px] = v;
    if (v > mxs[px]) mxs[px] = v;
  }
  let pen = false;
  for (let px = 0; px < cols; px++) {
    // 空列只跳过一个采样点，不打断路径，否则帧数略多于像素列时会碎成一串短线
    if (mxs[px] === -Infinity) continue;
    const x = x0 + (px + .5) / cols * w;
    const ya = y0 + h - Math.min(1, mxs[px] / ymax) * h;
    const yb = y0 + h - Math.min(1, mn[px] / ymax) * h;
    if (pen) g.lineTo(x, ya); else { g.moveTo(x, ya); pen = true; }
    if (yb > ya) g.lineTo(x, yb);
  }
  g.stroke();
  g.restore();
}

function drawSide(entry) {
  const {cv, off, s} = entry;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = cv.parentElement.clientWidth;
  const dims = gridDims(W);
  const {padL, padR, gapX, gapY, C, R} = dims;
  const padT = 18, padB = 54;

  const cellW = (W - padL - padR - gapX * (C - 1)) / C;
  const cellH = Math.max(46, Math.min(132, cellW * 0.46));
  const H = padT + padB + cellH * R + gapY * (R - 1);

  cv.style.height = H + 'px';
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  off.width = cv.width; off.height = cv.height;

  entry.geo = {W, H, dpr, padL, padT, cellW, cellH, gapX, gapY};
  entry.dims = dims;

  const g = off.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.textBaseline = 'middle';

  const cLine = css('--line'), cGrid = css('--grid'),
        cFaint = css('--faint'), cMuted = css('--muted'), cAcc = css('--accent');
  const {a: A, b: B} = winOf();
  const span = (B - A) || 1;
  // 跨度大到装不下时画的是全段抽样（dataOf 决定）。步长按整张网格的总宽算：
  // 56 格共用同一份抽样，逐格宽度会把上限算窄 56 倍
  const data = dataOf(s, A, B);
  const hz = hzOf(s, data);
  const step = stepOf(span * hz, span, C * cellW + gapX * (C - 1), hz);
  const snap = v => Math.round(v * dpr) / dpr + 0.5 / dpr;
  const fs0 = cellW > 150 ? 11 : 9.5;      // 通道号字号随格子放大

  for (let j = 0; j < s.nch; j++) {
    const r = Math.floor(j / C), c = j % C;
    const x0 = padL + c * (cellW + gapX), y0 = padT + r * (cellH + gapY);
    entry.cells[j] = {x0, y0, w: cellW, h: cellH};

    g.fillStyle = cGrid;
    g.globalAlpha = 0.3;
    g.fillRect(x0, y0, cellW, cellH);
    g.globalAlpha = 1;
    g.strokeStyle = cLine; g.lineWidth = 1;
    g.strokeRect(x0 + .5, y0 + .5, cellW - 1, cellH - 1);

    // 波形
    g.strokeStyle = cAcc; g.lineWidth = 1.2; g.lineCap = 'round'; g.lineJoin = 'round';
    tracePath(g, data, j, x0, y0, cellW, cellH, state.ymax, A, B, step);

    g.fillStyle = cMuted;
    g.font = fs0 + 'px system-ui,"Microsoft YaHei",sans-serif';
    g.textAlign = 'left';
    g.fillText('P' + (j + 1), x0 + 4, y0 + fs0 - 1);

    const gr = GRID[s.side] && GRID[s.side][j];
    if (gr) {
      g.fillStyle = cFaint; g.font = (fs0 - 1.5) + 'px system-ui,sans-serif'; g.textAlign = 'right';
      g.fillText('r' + gr[0] + ' c' + gr[1], x0 + cellW - 4, y0 + fs0 - 1);
    }

    if (s.mx && s.mx[j] === 0) {
      g.fillStyle = cFaint; g.font = fs0 + 'px system-ui,"Microsoft YaHei",sans-serif';
      g.textAlign = 'center';
      g.fillText('全 0', x0 + cellW / 2, y0 + cellH / 2);
    }
  }

  const gridX0 = padL, gridX1 = padL + C * cellW + gapX * (C - 1);
  const gridY0 = padT, gridY1 = padT + R * cellH + gapY * (R - 1);
  const yAx = gridY1 + 10;

  // 纵轴（整张图共用一把尺）
  g.strokeStyle = cLine; g.lineWidth = 1;
  g.beginPath(); g.moveTo(gridX0 - .5, gridY0); g.lineTo(gridX0 - .5, gridY1); g.stroke();
  g.font = '10px system-ui,sans-serif'; g.fillStyle = cFaint; g.textAlign = 'right';
  for (const [val, yy] of [[state.ymax, gridY0 + 8], [0, gridY1 - 3]]) {
    g.beginPath(); g.moveTo(gridX0 - 5, yy - 3); g.lineTo(gridX0 - 1, yy - 3); g.stroke();
    g.fillText(fmt(val), gridX0 - 9, yy);
  }

  // 横轴：刻度跟窗口走，不总是 0…全段
  g.beginPath(); g.moveTo(gridX0, yAx + .5); g.lineTo(gridX1, yAx + .5); g.stroke();
  g.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const x = gridX0 + (gridX1 - gridX0) * i / 4;
    g.beginPath(); g.moveTo(x + .5, yAx); g.lineTo(x + .5, yAx + 4); g.stroke();
    g.fillText(fmtT(A + span * i / 4, span), x, yAx + 15);
  }
  g.fillStyle = cMuted;
  g.fillText('时间', (gridX0 + gridX1) / 2, yAx + 32);

  // 纵轴标题
  g.save();
  g.translate(12, padT + (cellH * R + gapY * (R - 1)) / 2);
  g.rotate(-Math.PI / 2);
  g.fillStyle = cMuted; g.font = '10px system-ui,"Microsoft YaHei",sans-serif'; g.textAlign = 'center';
  g.fillText('ADC', 0, 0);
  g.restore();

  Object.assign(entry.geo, {a: A, b: B, gridX0, gridX1, gridY0, gridY1});

  // IC/TO 候选压在 56 格上：压力起跳点与 IC 的时差才是人眼能判的东西。
  // 56 格里不写字，只留竖线与顶端色杠 —— 格高不够，字会盖掉波形
  if (ictoPaint) ictoPaint(g, s, {x0: gridX0, x1: gridX1, top: gridY0, bot: gridY1, a: A, b: B, label: false});

  if (entry.metaEl) {
    entry.metaEl.textContent = metaText(s, dims)
      + (step > 1 ? `　|　按 ${(hz / step).toFixed(2)} Hz 抽样绘制（放大后自动加密）` : '');
  }
  blit(entry);
}

// 叠加层：底图复制 + 框选带 + 贯穿全图的时间游标（同侧所有格子、两只脚同时对齐）
function blit(entry) {
  const {cv, off, geo} = entry;
  if (!geo || !off.width) return;
  const ctx = cv.getContext('2d');
  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.W, geo.H);
  ctx.drawImage(off, 0, 0, geo.W, geo.H);

  const cAcc = css('--accent');
  const span = (geo.b - geo.a) || 1;
  const gw = geo.gridX1 - geo.gridX0;

  if (entry.sel) {
    const x0 = Math.min(entry.sel.x0, entry.sel.x1), x1 = Math.max(entry.sel.x0, entry.sel.x1);
    ctx.save();
    ctx.fillStyle = cAcc; ctx.globalAlpha = .12;
    ctx.fillRect(x0, geo.gridY0, x1 - x0, geo.gridY1 - geo.gridY0);
    ctx.globalAlpha = .7; ctx.strokeStyle = cAcc; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + .5, geo.gridY0 + .5, Math.max(0, x1 - x0 - 1), geo.gridY1 - geo.gridY0);
    ctx.restore();
    if (x1 - x0 > 40) {
      const ta = geo.a + (x0 - geo.gridX0) / gw * span;
      const tb = geo.a + (x1 - geo.gridX0) / gw * span;
      const txt = `${ta.toFixed(2)} – ${tb.toFixed(2)} s`;
      ctx.save();
      ctx.font = '11px system-ui,"Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(txt).width + 12;
      const bx = Math.min(Math.max(x0 + (x1 - x0) / 2, geo.gridX0 + tw / 2), geo.gridX1 - tw / 2);
      ctx.fillStyle = css('--card'); ctx.globalAlpha = .94;
      ctx.fillRect(bx - tw / 2, geo.gridY0 + 4, tw, 18);
      ctx.globalAlpha = 1; ctx.fillStyle = css('--ink');
      ctx.fillText(txt, bx, geo.gridY0 + 13);
      ctx.restore();
    }
  }

  const t = state.hoverT;
  if (t == null || t < geo.a || t > geo.b) return;
  const frac = (t - geo.a) / span;
  const x = geo.gridX0 + frac * gw;
  ctx.save();
  ctx.strokeStyle = cAcc; ctx.globalAlpha = .45; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x + .5, geo.gridY0); ctx.lineTo(x + .5, geo.gridY1); ctx.stroke();
  ctx.restore();

  const s = entry.s;
  const blk = dataOf(s, geo.a, geo.b);
  if (!(blk.n > 0) || t > s.dur) return;
  const k = idxAt(t, blk);
  ctx.save();
  ctx.fillStyle = cAcc;
  for (let j = 0; j < s.nch; j++) {
    const c = entry.cells[j];
    if (!c) continue;
    const v = blk.ch[j][k];
    if (!Number.isFinite(v)) continue;
    const cx = c.x0 + frac * c.w;
    const cy = c.y0 + c.h - Math.min(1, v / state.ymax) * c.h;
    ctx.beginPath(); ctx.arc(cx, cy, 1.9, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export {blit, drawSide, tracePath};
