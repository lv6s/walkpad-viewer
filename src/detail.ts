/* 单通道详情图。 */

import {GRID, SIDE_CN} from './core/constants';
import {$, el} from './core/dom';
import {state, view} from './core/state';
import {css, fmt, fmtT, niceMax} from './core/util';
import {dataOf, hzOf, stepOf} from './lod';
import {sideWin} from './timewin';
import {tracePath} from './wave';

function openDetail(side, j) {
  const s = state.sides.find(x => x.side === side);
  if (!s) return;
  state.detail = {side, j};
  // 详情卡跟着所属那只脚走：原来固定在页尾，点下面几行时得滚很远才看得到
  const host = view.get(side);
  if (host && host.cv) {
    const sec = host.cv.closest('section');
    if (sec && sec.nextElementSibling !== el.detail) sec.insertAdjacentElement('afterend', el.detail);
  }
  el.detail.hidden = false;
  const g = GRID[side] && GRID[side][j];
  el.dTitle.textContent = `P${j + 1}　${SIDE_CN[side] || side}`;
  // 全段视图下详情图也画抽样：与主图同一份数据，读数不会是「另一段时间的值」
  const {a: A, b: B} = sideWin(s);
  const span = (B - A) || 1;
  const blk = dataOf(s, A, B);
  // 分母用「有效帧」而不是全部行：全段统计时是 s.n（已剔掉 validity 非 valid 的边界帧），
  // 还没扫完就退回块内帧数；缺值帧既不算零也不算非零
  const nBase = s.zc ? s.n : (blk ? blk.n : 0);
  const ms = (s.miss && s.miss[j]) || 0;
  const nValid = Math.max(0, nBase - ms);
  let nz = 0;
  if (s.zc) nz = Math.max(0, nValid - s.zc[j]);
  else if (blk) for (let k = 0; k < blk.n; k++) { const v = blk.ch[j][k]; if (Number.isFinite(v) && v !== 0) nz++; }
  const mxj = s.mx ? s.mx[j] : 0;
  el.dMeta.textContent = `${g ? `阵列 r${g[0]} c${g[1]}　·　` : ''}最大 ${fmt(mxj)} ADC　·　非零 ${fmt(nz)}/${fmt(nValid)} 帧（${nValid ? (100 * nz / nValid).toFixed(1) : '—'}%）`;

  const cv = el.dCanvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = cv.parentElement.clientWidth, H = 220;
  cv.style.height = H + 'px';
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const off = state.dOff || (state.dOff = document.createElement('canvas'));
  off.width = cv.width; off.height = cv.height;
  const c = off.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);

  const padL = 52, padR = 16, padT = 12, padB = 48;
  const pw = W - padL - padR, ph = H - padT - padB;
  const ymax = mxj > 0 ? niceMax(mxj) : 100;
  const hz = hzOf(s, blk);
  const step = stepOf(span * hz, span, pw, hz);
  const cLine = css('--line'), cGrid = css('--grid'), cFaint = css('--faint'),
        cMuted = css('--muted'), cAcc = css('--accent');

  // 网格 + 轴
  c.font = '9.5px system-ui,sans-serif'; c.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = ymax * i / 4, y = padT + ph - ph * i / 4;
    c.strokeStyle = i ? cGrid : cLine; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, y + .5); c.lineTo(padL + pw, y + .5); c.stroke();
    c.fillStyle = cFaint; c.textAlign = 'right';
    c.fillText(fmt(v), padL - 6, y);
  }
  c.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const x = padL + pw * i / 4;
    c.fillStyle = cFaint;
    c.fillText(fmtT(A + span * i / 4, span), x, padT + ph + 14);
  }
  c.fillStyle = cMuted; c.textAlign = 'center';
  c.fillText('时间', padL + pw / 2, padT + ph + 34);
  c.save();
  c.translate(11, padT + ph / 2); c.rotate(-Math.PI / 2);
  c.fillText('ADC', 0, 0);
  c.restore();

  // 波形
  if (mxj === 0) {
    c.fillStyle = cFaint; c.font = '11px system-ui,"Microsoft YaHei",sans-serif';
    c.fillText('全段读数恒为 0，无波形可画', padL + pw / 2, padT + ph / 2);
    state.dGeo = {padL, padT, pw, ph, ymax, a: A, span, s, blk, j, hasWave: false};
    paintDetail(null);
    return;
  }
  c.strokeStyle = cAcc; c.lineWidth = 1.2; c.lineCap = 'round'; c.lineJoin = 'round';
  tracePath(c, blk, j, padL, padT, pw, ph, ymax, A, B, step);
  state.dGeo = {padL, padT, pw, ph, ymax, a: A, span, s, blk, j, hasWave: true};
  paintDetail(null);
}

// 详情图：底图存在离屏画布，悬停只叠加十字线与读数，不重算降采样
function paintDetail(idx) {
  const geo = state.dGeo, cv = el.dCanvas, off = state.dOff;
  if (!geo || !off) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const c = cv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.drawImage(off, 0, 0);
  if (idx == null || !geo.hasWave) return;

  const {padL, padT, pw, ph, ymax, span, a, blk, j} = geo;
  const t = blk.t[idx], v = blk.ch[j][idx];
  const x = padL + Math.min(1, Math.max(0, (t - a) / span)) * pw;
  const y = padT + ph - Math.min(1, v / ymax) * ph;

  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cInk = css('--ink'), cCard = css('--card'), cAcc = css('--accent');

  c.save();
  c.strokeStyle = cAcc; c.globalAlpha = .5; c.lineWidth = 1;
  c.setLineDash([3, 3]);
  c.beginPath(); c.moveTo(x, padT); c.lineTo(x, padT + ph); c.stroke();
  c.restore();

  c.fillStyle = cAcc;
  c.beginPath(); c.arc(x, y, 3.4, 0, Math.PI * 2); c.fill();
  c.strokeStyle = cCard; c.lineWidth = 1.6; c.stroke();

  const txt = `${t.toFixed(2)} s　${fmt(v)} ADC`;
  c.font = '11.5px system-ui,"Microsoft YaHei",sans-serif';
  const tw = c.measureText(txt).width + 16, th = 21;
  let bx = x - tw / 2;
  bx = Math.max(padL, Math.min(bx, padL + pw - tw));
  let by = y < padT + 40 ? padT + ph - th - 6 : padT + 4;
  c.fillStyle = cCard; c.globalAlpha = .96;
  c.beginPath();
  if (c.roundRect) c.roundRect(bx, by, tw, th, 6); else c.rect(bx, by, tw, th);
  c.fill();
  c.globalAlpha = 1;
  c.strokeStyle = css('--line'); c.lineWidth = 1; c.stroke();
  c.fillStyle = cInk; c.textAlign = 'left'; c.textBaseline = 'middle';
  c.fillText(txt, bx + 8, by + th / 2 + .5);
}

function idxAt(tt, s) {
  let lo = 0, hi = s.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.t[mid] < tt) lo = mid; else hi = mid;
  }
  return Math.abs(s.t[lo] - tt) <= Math.abs(s.t[hi] - tt) ? lo : hi;
}

function closeDetail() {
  el.detail.hidden = true;
  state.detail = null;
  state.dGeo = null;
}

export {closeDetail, idxAt, openDetail, paintDetail};
