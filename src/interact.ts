/* 波形页与 IMU 页共用的悬停、框选、平移手势。 */

import {GRID} from './core/constants';
import {$, el} from './core/dom';
import {state, view} from './core/state';
import {fmt} from './core/util';
import {idxAt, openDetail} from './detail';
import {dataOf} from './lod';
import {applyWin, resetWin} from './timewin';
import {blit} from './wave';

// 时间轴的换算全部走窗口，不再假设 0…全段
function timeFrac(entry, x) {
  const g = entry.geo;
  if (!g) return null;
  const gw = g.gridX1 - g.gridX0;
  if (!(gw > 0)) return null;
  return Math.min(1, Math.max(0, (x - g.gridX0) / gw));
}

function cellAt(entry, x, y) {
  const g = entry.geo;
  if (!g || !entry.cells) return null;
  const tolX = (g.gapX || 12) / 2, tolY = (g.gapY || 16) / 2;
  for (let j = 0; j < entry.s.nch; j++) {
    const c = entry.cells[j];
    if (!c) continue;
    // 容差吃掉格子之间的缝隙，鼠标扫过时不会断线
    if (x >= c.x0 - tolX && x <= c.x0 + c.w + tolX && y >= c.y0 - tolY && y <= c.y0 + c.h + tolY) return j;
  }
  return null;
}

// 悬停：游标贴合真实采样点（原始数据可视化，不插值），两只脚 + 同侧全部通道一起对齐
function onHover(entry, ev) {
  const g = entry.geo;
  if (!g || drag) return;
  const r = entry.cv.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (x < g.gridX0 - 6 || x > g.gridX1 + 6 || y < g.gridY0 - 6 || y > g.gridY1 + 10) {
    el.tip.style.display = 'none';
    state.hoverT = null;
    for (const e of view.values()) blit(e);
    return;
  }
  const frac = timeFrac(entry, x);
  const s = entry.s, blk = dataOf(s, g.a, g.b);
  let t = g.a + frac * (g.b - g.a);
  if (blk.n > 0 && t >= blk.a - 1e-9 && t <= blk.b + 1e-9) t = blk.t[idxAt(t, blk)];
  state.hoverT = t;

  const j = cellAt(entry, x, y);
  if (j == null) {
    el.tip.style.display = 'none';
  } else {
    const k = idxAt(t, blk), v = blk.ch[j][k];
    const gr = GRID[s.side] && GRID[s.side][j];
    el.tip.innerHTML = `P${j + 1}${gr ? ` <span style="opacity:.7">r${gr[0]} c${gr[1]}</span>` : ''}<br>`
      + `t = ${t.toFixed(2)} s<br>${Number.isFinite(v) ? fmt(v) + ' ADC' : '缺值（该帧没有读数）'}`
      + (blk._lod ? '<br><span style="opacity:.7">全段抽样点</span>' : '');
    showTipAt(ev.clientX, ev.clientY);
  }
  for (const e of view.values()) blit(e);
}

function showTipAt(cx, cy) {
  el.tip.style.display = 'block';
  const tw = el.tip.offsetWidth, th = el.tip.offsetHeight;
  let x = cx + 14, y = cy + 14;
  if (x + tw > window.innerWidth - 8) x = cx - tw - 14;
  if (y + th > window.innerHeight - 8) y = cy - th - 14;
  el.tip.style.left = Math.max(8, x) + 'px';
  el.tip.style.top = Math.max(8, y) + 'px';
}

// 拖动：Shift = 框选放大，直接拖 = 平移；原地没动才算点击（波形页点格子开详情）
let drag: any = null;
export const dragRef = (): any => drag;
let pickAt = 0;

// 时间尺度的手势两页共用（波形页、IMU 页）：同一套键位，同一份时间窗
function bindAxisPointer(cv, entry, onMove) {
  cv.addEventListener('mousedown', ev => {
    if (ev.button !== 0 || !entry.geo) return;
    const r = cv.getBoundingClientRect();
    drag = {
      entry, cx0: ev.clientX, cy0: ev.clientY,
      x0: ev.clientX - r.left, y0: ev.clientY - r.top,
      moved: false, mode: ev.shiftKey ? 'zoom' : 'pan',
      a: entry.geo.a, b: entry.geo.b
    };
    cv.classList.add('dragging');
    el.tip.style.display = 'none';
    ev.preventDefault();
  });
  cv.addEventListener('mousemove', ev => { if (!drag) onMove(entry, ev); });
  cv.addEventListener('mouseleave', () => {
    if (drag) return;
    el.tip.style.display = 'none';
    entry.hover = null;
    if (entry.repaint) entry.repaint(entry);
    else { state.hoverT = null; for (const e of view.values()) blit(e); }
  });
  cv.addEventListener('wheel', ev => onWaveWheel(entry, ev), {passive: false});
  cv.addEventListener('dblclick', ev => { ev.preventDefault(); resetWin(); });
}

function bindWavePointer(cv, entry) { bindAxisPointer(cv, entry, onHover); }

function onWaveWheel(entry, ev) {
  const g = entry.geo;
  if (!g) return;
  if (!(ev.ctrlKey || ev.metaKey)) return;
  ev.preventDefault();
  const r = entry.cv.getBoundingClientRect();
  const frac = timeFrac(entry, ev.clientX - r.left);
  if (frac == null) return;
  const span = g.b - g.a, pivot = g.a + frac * span;
  const k = ev.deltaY > 0 ? 1.25 : 0.8;   // 向上滚 = 放大
  applyWin(pivot - (pivot - g.a) * k, pivot + (g.b - pivot) * k);
}

function onDragMove(ev) {
  const d = drag, g = d && d.entry.geo;
  if (!g) return;
  if (!d.moved && Math.abs(ev.clientX - d.cx0) + Math.abs(ev.clientY - d.cy0) > 3) d.moved = true;
  if (!d.moved) return;
  const r = d.entry.cv.getBoundingClientRect();
  const x = Math.max(g.gridX0, Math.min(ev.clientX - r.left, g.gridX1));
  if (d.mode === 'zoom') {
    d.entry.sel = {x0: Math.max(g.gridX0, Math.min(d.x0, g.gridX1)), x1: x};
    (d.entry.repaint || blit)(d.entry);
    return;
  }
  const span = d.b - d.a, gw = g.gridX1 - g.gridX0;
  const dx = (x - d.x0) / gw * span;      // 抓住内容拖：窗口反向移动
  applyWin(d.a - dx, d.b - dx);
}

function endDrag(ev) {
  const d = drag;
  drag = null;
  if (!d) return;
  d.entry.cv.classList.remove('dragging');
  const g = d.entry.geo;

  if (d.mode === 'zoom') {
    const sel = d.entry.sel;
    d.entry.sel = null;
    if (sel && g) {
      const x0 = Math.min(sel.x0, sel.x1), x1 = Math.max(sel.x0, sel.x1);
      const gw = g.gridX1 - g.gridX0, span = g.b - g.a;
      if (x1 - x0 >= 6) {
        applyWin(g.a + (x0 - g.gridX0) / gw * span, g.a + (x1 - g.gridX0) / gw * span);
        return;
      }
    }
    (d.entry.repaint || blit)(d.entry);
    return;
  }
  if (!d.moved && g) {
    // 双击会先派发两次单击，第二次吞掉，让 dblclick 专心做复位
    const now = performance.now();
    if (now - pickAt < 320) return;
    pickAt = now;
    const j = cellAt(d.entry, d.x0, d.y0);
    if (j != null) openDetail(d.entry.s.side, j);
  }
}

export {bindAxisPointer, bindWavePointer, endDrag, onDragMove, showTipAt};
