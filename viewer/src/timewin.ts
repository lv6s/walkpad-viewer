/* 两只脚共用一个时间窗：框选 / 平移 / 缩放都改这一份状态。 */

import {drawActivity} from './activity';
import {drawSquat} from './squat';
import {drawAxis} from './axis';
import {$, el} from './core/dom';
import {state, view} from './core/state';
import {clampRange} from './core/window-range';
import {fail, fmt, fmtDur} from './core/util';
import {openDetail} from './detail';
import {redrawImu, updateOverview} from './imu';
import {ensureWin} from './parse';
import {drawScrub, syncInputs} from './scrub';
import {drawSide} from './wave';

// ---------------------------------------------------------------- 时间窗口
// 两只脚共用同一个窗口：同一份记录里同一时刻的动作才对得上，各自独立缩放就没法横向比
const MIN_SPAN = 0.02;
function fullDur() { return state.sides.length ? Math.max(...state.sides.map(s => s.dur)) : 0; }
function winOf() {
  const D = fullDur() || 1;
  const w = state.win;
  if (!w) return {a: 0, b: D};
  const a = Math.max(0, Math.min(w.a, D - MIN_SPAN));
  return {a, b: Math.min(D, Math.max(w.b, a + MIN_SPAN))};
}
// 单侧窗口：窗口可能比这只脚的记录更长，裁到它自己的时长
function sideWin(s) {
  const w = winOf();
  const a = Math.max(0, Math.min(w.a, Math.max(0, s.dur - MIN_SPAN)));
  return {a, b: Math.max(a + MIN_SPAN, Math.min(w.b, s.dur))};
}
function applyWin(a, b) {
  const D = fullDur();
  if (!(D > 0)) return;
  const next = clampRange(a, b, D);
  if (!next) return;
  const prev = winOf();
  if (Math.abs(prev.a - next.a) < 1e-9 && Math.abs(prev.b - next.b) < 1e-9) return;
  state.win = next.a <= 1e-9 && next.b >= D - 1e-9 ? null : next;
  updateWinBar();
  scheduleWindowRender();
}
let renderFrame = 0, loadTimer = 0;
function scheduleWindowRender() {
  if (!renderFrame) renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    redrawTime();
  });
  clearTimeout(loadTimer);
  loadTimer = window.setTimeout(() => {
    const {a, b} = winOf();
    void ensureWin(a, b).catch(e => {
      fail('时间窗加载失败：' + (e?.message || e));
    });
  }, 120);
}

// 复位 = 回全段。长包不再退回开头 60 s：全段有抽样视图可看，
// 而一次「复位」就触发几十万帧的块读取才是不能做的事（ensureWin 会跳过抽样跨度）
function resetWin() {
  if (state.win) { state.win = null; redrawTime(); updateWinBar(); }
}

// 隐藏页 canvas 宽度为 0，只重画当前页；窗口变了，另一页在切回去时按新窗口重画
function redrawTime() {
  if (state.tab === 'wave') redrawWave();
  else if (state.tab === 'imu') redrawImu();
  else if (state.tab === 'activity') drawActivity();
  else if (state.tab === 'axis') drawAxis();   // 「当前时间窗」模式下窗口变了结论也要跟着变
  else if (state.tab === 'squat') drawSquat();
}

function redrawWave() {
  for (const e of view.values()) drawSide(e);
  if (state.detail) openDetail(state.detail.side, state.detail.j);
}

// 全段视图是抽样画的：说清楚密度、后台扫到哪儿了，别让人以为那就是全部帧
function lodNote() {
  const s = state.sides.find(x => x.lod);
  if (!s || !s.lod) return '';
  const L = s.lod;
  const hz = state.drawHz ? `${state.drawHz} Hz` : '按屏宽';
  const part = L.partial ? `　抽样中 ${Math.max(1, Math.floor(100 * Math.min(1, L.upto / L.dur)))}%` : '';
  return `　·　抽样 ${hz}（格 ${fmt(L.n)}）${part}`;
}

// 窗口条常驻：操作提示只有缩放过才出现的话，没人看得到
function updateWinBar() {
  if (!el.winBar) return;
  const supportsWindow = ['wave', 'imu', 'axis', 'activity', 'squat'].includes(state.tab);
  el.winBar.hidden = !state.sides.length || !supportsWindow;
  if (!state.sides.length) { drawScrub(); updateOverview(); return; }
  el.winReset.textContent = '复位全段';
  const D = fullDur() || 1, w = state.win;
  // 起止时间改由旁边的输入框显示，这里只说跨度和占比，免得同一组数字写两遍
  if (!w) {
    el.winText.innerHTML = `全段 <b>${fmtDur(D)}</b>${lodNote()}`;
    el.winReset.hidden = true;
  } else {
    const span = w.b - w.a;
    el.winText.innerHTML = `跨度 <b>${fmtDur(span)}</b>　占全段 ${(100 * span / D).toFixed(1)}%`;
    el.winReset.hidden = false;
  }
  if (syncInputs) syncInputs();
  if (drawScrub) drawScrub();
  updateOverview();
}

// [a,b] 内首末帧的下标（各多带一帧，让线在格子边界处闭合，不外溢——描边时另做裁剪）
function visRange(s, a, b) {
  const t = s.t, n = s.n;
  if (!n) return {i0: 0, i1: -1};
  if (b < t[0] || a > t[n - 1]) return {i0: 0, i1: -1};
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < a) lo = m + 1; else hi = m; }
  const i0 = Math.max(0, lo - 1);
  lo = 0; hi = n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] <= b) lo = m; else hi = m - 1; }
  return {i0, i1: Math.min(n - 1, lo + 1)};
}

// 严格边界：[a,b] 内首末帧，不多带邻帧。导出用 —— 绘图多带一帧是为了线不外溢，
// 导出的行数却必须和写出去的起止时间对得上。
function strictRange(s, a, b) {
  const t = s.t, n = s.n;
  if (!n) return {i0: 0, i1: -1};
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < a - 1e-9) lo = m + 1; else hi = m; }
  const i0 = lo;
  lo = 0; hi = n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] <= b + 1e-9) lo = m; else hi = m - 1; }
  const i1 = lo;
  return (i1 < i0 || t[i0] > b + 1e-9 || t[i1] < a - 1e-9) ? {i0: 0, i1: -1} : {i0, i1};
}

function metaText(s, dims) {
  return `全段 ${s.dur.toFixed(1)} s · 均记录率 ${isFinite(s.fs) ? s.fs.toFixed(2) : '—'} Hz · ${fmt(s.n)} 帧`
    + `　|　y 轴 0–${fmt(state.ymax)} ADC　|　本侧最大 ${fmt(Math.max(...s.mx))} ADC`
    + `　|　排列 ${dims.C} 列 × ${dims.R} 行（按通道序号 P1→P${s.nch}）`;
}

export {applyWin, fullDur, metaText, redrawWave, resetWin, sideWin, strictRange, updateWinBar, visRange, winOf};
