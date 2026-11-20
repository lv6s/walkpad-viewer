/* 零值率页：足底散点图与 14×5 矩阵联动。 */

import {setTab} from './app';
import {GRID, NCH, REV, SIDE_CN} from './core/constants';
import {$, el} from './core/dom';
import {state, zeroView} from './core/state';
import {baseName, css, downloadCanvas, fmt, med, miniBtn} from './core/util';
import {openDetail} from './detail';
import {exportZeroCsv} from './export';
import {COP_PTS, INNER_RIGHT, strokeOutline} from './geometry';
import {showTipAt} from './interact';

// ---------------------------------------------------------------- 零值率
// 零值率 = 该通道读数恰为 0 的帧占比。它把两件事压在一个数上：该位置受压的时间占比，
// 以及通道是否根本没接上。判断有没有问题不看单点数值，看缺口是否连成片。
const ZERO_VIS = [-4, 82, -6, 276];
const ZERO_STOPS: [number, number[]][] = [[0, [18, 57, 91]], [.35, [46, 134, 214]], [.6, [174, 214, 241]],
  [.8, [246, 198, 192]], [1, [214, 69, 69]]];

function rampRGB(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const S = ZERO_STOPS;
  for (let i = 1; i < S.length; i++) {
    if (t <= S[i][0]) {
      const f = (t - S[i - 1][0]) / (S[i][0] - S[i - 1][0]);
      return S[i - 1][1].map((v, k) => Math.round(v + (S[i][1][k] - v) * f));
    }
  }
  return S[S.length - 1][1];
}
const rgbCss = c => `rgb(${c[0]},${c[1]},${c[2]})`;
const lumOf = c => .299 * c[0] + .587 * c[1] + .114 * c[2];

// 零值率 = 读数为 0 的帧 / 该通道有效帧。四类互斥且穷尽，便于核对 n = 各类之和。
function zeroStat(s) {
  // 全段统计还没扫出来时（懒加载的长录制）先按已载入的窗口块算，分母也随之换成块内帧数
  const n = s.zc ? s.n : (s.blk ? s.blk.n : 0), nch = Math.min(NCH, s.nch);
  const zr = new Float64Array(nch);
  const cat = {always: [], hot: [], mid: [], low: [], nodata: []};
  let miss = 0;
  for (let j = 0; j < nch; j++) {
    const ms = (s.miss && s.miss[j]) || 0;
    const valid = n - ms;
    miss += ms;
    if (valid <= 0) { zr[j] = NaN; cat.nodata.push(j); continue; }
    let z = 0;
    if (s.zc) z = s.zc[j];
    else if (s.blk) { const col = s.blk.ch[j]; for (let k = 0; k < n; k++) if (col[k] === 0) z++; }
    zr[j] = z / valid;
    if (zr[j] >= 1) cat.always.push(j);
    else if (zr[j] > .95) cat.hot.push(j);
    else if (zr[j] >= .05) cat.mid.push(j);
    else cat.low.push(j);
  }
  return {zr, nch, miss, ...cat};
}

function drawZero(entry) {
  const {s, st, cv} = entry;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const padT = 26, padB = 30, padL = 16, padR = 14, H = 600;
  const scale = (H - padT - padB) / (ZERO_VIS[3] - ZERO_VIS[2]);
  const W = Math.round(padL + (ZERO_VIS[1] - ZERO_VIS[0]) * scale + padR);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const X = x => padL + (x - ZERO_VIS[0]) * scale;
  const Y = y => padT + (ZERO_VIS[3] - y) * scale;

  g.save();
  g.strokeStyle = css('--faint'); g.globalAlpha = .7; g.lineWidth = 1.2; g.lineJoin = 'round';
  strokeOutline(g, s.side, X, Y);
  g.restore();

  const P = COP_PTS[s.side];
  const nch = P ? Math.min(NCH, s.nch, P.x.length) : 0;
  const pts = [];
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let j = 0; j < nch; j++) {
    const ok = isFinite(st.zr[j]);
    const c = ok ? rampRGB(st.zr[j]) : [200, 205, 212];
    const cx = X(P.x[j]), cy = Y(P.y[j]), hl = entry.hl === j;
    const bad = !ok || st.zr[j] >= .95;
    // 悬停压暗其余点；「只看异常」时非异常点也压暗，与右侧矩阵的淡出对齐
    const dim = entry.hl != null ? !hl : (state.zeroOnlyBad && !bad);
    if (hl) {
      g.beginPath(); g.arc(cx, cy, 11, 0, Math.PI * 2);
      g.strokeStyle = css('--accent'); g.lineWidth = 2; g.stroke();
    }
    g.save();
    g.globalAlpha = dim ? .22 : 1;
    g.beginPath(); g.arc(cx, cy, 8.6, 0, Math.PI * 2);
    g.fillStyle = rgbCss(c); g.fill();
    g.strokeStyle = css('--card'); g.lineWidth = 1.2; g.stroke();
    g.fillStyle = !ok ? '#5a646f' : lumOf(c) > 150 ? '#16202c' : '#ffffff';
    g.font = '7.5px system-ui,sans-serif';
    g.fillText(ok ? String(j + 1) : '–', cx, cy + .4);
    g.restore();
    pts.push({x: cx, y: cy, j, ok});
  }
  entry.pts = pts;

  g.font = '10px system-ui,"Microsoft YaHei",sans-serif'; g.fillStyle = css('--faint');
  const innerR = INNER_RIGHT[s.side];
  g.textAlign = 'left';
  g.fillText(innerR ? '外侧' : '内侧', padL - 4, padT - 10);
  g.textAlign = 'right';
  g.fillText(innerR ? '内侧' : '外侧', W - padR + 4, padT - 10);
  g.textAlign = 'center'; g.fillStyle = css('--muted');
  g.fillText('足尖 ↑', W / 2, 13);
}

// 足底图与 14×5 矩阵是同一份数据的两种排布：hover / 点击两边联动
function zeroAt(entry, ev) {
  const r = entry.cv.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  let best = null, bd = 1e9;
  for (const p of entry.pts || []) {
    const dd = Math.hypot(p.x - x, p.y - y);
    if (dd < bd) { bd = dd; best = p; }
  }
  return bd <= 13 ? best : null;
}

function setZeroHl(entry, j) {
  if (entry.hl === j) return;
  entry.hl = j;
  drawZero(entry);
  for (const k of Object.keys(entry.cellsByJ)) {
    entry.cellsByJ[k].classList.toggle('hl', +k === j);
  }
}

function bindZeroCanvas(cv, entry) {
  cv.addEventListener('mousemove', ev => {
    const p = zeroAt(entry, ev);
    if (!p) {
      setZeroHl(entry, null);
      el.tip.style.display = 'none';
      return;
    }
    setZeroHl(entry, p.j);
    const s = entry.s, j = p.j, zr = entry.st.zr[j];
    const gr = GRID[s.side] && GRID[s.side][j];
    const valid = (s.zc ? s.n : (s.blk ? s.blk.n : 0)) - ((s.miss && s.miss[j]) || 0);
    el.tip.innerHTML = `<b>P${j + 1}</b>${gr ? ` <span style="opacity:.7">r${gr[0]} c${gr[1]}</span>` : ''}<br>`
      + `零值率 ${isFinite(zr) ? (100 * zr).toFixed(1) : '—'}%（${fmt((s.zc && s.zc[j]) || 0)}/${fmt(valid)} 帧）<br>`
      + `最大 ${fmt(s.mx ? s.mx[j] : 0)} ADC<br><span style="opacity:.7">点一下看该通道波形</span>`;
    showTipAt(ev.clientX, ev.clientY);
  });
  cv.addEventListener('mouseleave', () => {
    setZeroHl(entry, null);
    el.tip.style.display = 'none';
  });
  cv.addEventListener('click', ev => {
    const p = zeroAt(entry, ev);
    if (!p) return;
    setTab('wave');
    openDetail(entry.s.side, p.j);
    el.detail.scrollIntoView({block: 'nearest'});
  });
}

function applyZeroFilter() {
  const on = !!state.zeroOnlyBad;
  document.querySelectorAll('#zeroPanels .zerorow').forEach(r => r.classList.toggle('onlybad', on));
}

function renderZero() {
  el.zero.innerHTML = '';
  zeroView.clear();
  if (!state.sides.length) return;

  const sec0 = document.createElement('section');
  sec0.className = 'copsec';
  const h2 = document.createElement('h2');
  h2.textContent = '每通道零值率（读数恰好为 0 的帧占比）';
  const note = document.createElement('details');
  note.className = 'note';
  const sum = document.createElement('summary');
  sum.textContent = '口径说明：零值率的分母、四个分类、两张图怎么对应';
  const meta = document.createElement('p');
  let mnPos = Infinity;
  for (const s of state.sides) {
    if (!s.mn) continue;
    for (const v of s.mn) if (isFinite(v) && v < mnPos) mnPos = v;
  }
  meta.textContent = '零值率 = 该通道读数为 0 的帧 ÷ 该通道有效帧，按整段记录统计：不筛时间窗、不按质量标志剔帧、缺值帧不计入分母。'
    + '读数为 0 通常是压力低于 FSR 阈值'
    + (isFinite(mnPos) ? `（本数据最小非零读数 ${fmt(mnPos)} ADC）` : '')
    + '，所以它衡量的是「读数低于阈值的时间占比」，不等同于「是否接触」。'
    + '四类互斥且穷尽——恒为 0（整段无任何非零读数）、95–100%、5–95%、低于 5%，四类通道数之和等于该脚通道总数。'
    + '左侧是足底投影（圆内数字 = 通道序号 +1），右侧按 14 行 × 5 列阵列铺开（上方 = 足尖）。'
    + '阵列列号就是原始矩阵的列序（每行自左向右 c0→c4，缺槽画虚线），但各行传感器数只有 4–5 个，'
    + '同一列的行间横向位置会漂移，所以「列」不是等宽的解剖条带；判断缺口是否连成片，以左侧足底图为准。'
    + (state.sides.some(s => s.statPending)
      ? '　⚠ 整段统计还在后台扫描：这些侧现在的零值率与分母只算已载入的时间窗，扫完会自动换成整段。' : '');
  note.append(sum, meta);
  sec0.appendChild(h2); sec0.appendChild(note);

  const ctl = document.createElement('div');
  ctl.className = 'ptools';
  const lab = document.createElement('label');
  lab.className = 'ctrl';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = !!state.zeroOnlyBad;
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode('只看异常'));
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '异常 = 恒为 0 或 ≥95%；矩阵格与足底图点一下都能跳到该通道的波形';
  cb.addEventListener('change', () => { state.zeroOnlyBad = cb.checked; applyZeroFilter(); });
  ctl.append(lab, hint);
  sec0.appendChild(ctl);
  el.zero.appendChild(sec0);

  const row = document.createElement('div');
  row.className = 'zerorow';
  for (const s of state.sides) {
    if (!(s.nch > 0)) continue;         // 无压力通道的流（专用 IMU 设备）没有零值率可言
    const st = zeroStat(s);
    const rev = REV[s.side] || {};      // 侧别不在 d56 布局里时只有足形与数值，不铺矩阵
    const sec = document.createElement('section');
    sec.className = 'side';
    const head = document.createElement('div');
    head.className = 'sechead';
    const h = document.createElement('h2');
    h.textContent = (SIDE_CN[s.side] || s.side) + '　' + st.nch + ' 通道零值率';
    const grow = document.createElement('span');
    grow.className = 'grow';
    head.append(h, grow);

    const zs = Array.from(st.zr);
    const p = document.createElement('p');
    p.className = 'meta';
    p.innerHTML = `零值率中位 <b>${(100 * med(zs)).toFixed(1)}%</b>`
      + `　恒为 0 <b>${st.always.length}</b>`
      + `　95–100% <b>${st.hot.length}</b>`
      + `　5–95% <b>${st.mid.length}</b>`
      + `　&lt; 5% <b>${st.low.length}</b>`
      + (st.nodata.length ? `　无数据 <b>${st.nodata.length}</b>` : '')
      + (st.miss ? `　缺值帧 <b>${st.miss}</b>` : '')
      // 分母口径必须写在旁边：还没扫完整段时用的是窗口块，不能让人以为这是整段值
      + (s.zc ? '　（整段）'
              : (s.blk ? `　（窗口 ${s.blk.a.toFixed(1)}–${s.blk.b.toFixed(1)} s，整段统计未完成）` : ''));

    const wrap = document.createElement('div');
    wrap.className = 'zerowrap';
    const cv = document.createElement('canvas');
    cv.style.cursor = 'pointer';
    wrap.appendChild(cv);

    const entry = {s, st, cv, cellsByJ: {}, hl: null, pts: null};
    head.append(
      miniBtn('PNG', '导出足底零值率分布图', () => {
        entry.hl = null; drawZero(entry);
        downloadCanvas(cv, `${baseName()}_${s.side}_zero.png`);
      }),
      miniBtn('CSV', '导出每通道零值率表', () => exportZeroCsv(entry))
    );

    const zc = document.createElement('div');
    zc.className = 'zcol';
    const grid = document.createElement('div');
    grid.className = 'zgrid';
    for (let r = 13; r >= 0; r--) {
      for (let c = 0; c < 5; c++) {
        const cell = document.createElement('div');
        cell.className = 'zcell';
        const j = rev[r + ',' + c];
        if (j == null) { cell.classList.add('none'); grid.appendChild(cell); continue; }
        const ok = isFinite(st.zr[j]);
        const col = ok ? rampRGB(st.zr[j]) : [232, 235, 239];
        cell.style.background = rgbCss(col);
        cell.style.color = ok ? (lumOf(col) > 150 ? '#16202c' : '#fff') : '#5a646f';
        cell.innerHTML = ok
          ? `<b>${Math.round(100 * st.zr[j])}%</b><span>P${j + 1}</span>`
          : `<b>—</b><span>P${j + 1}</span>`;
        if (!ok || st.zr[j] >= .95) cell.classList.add('bad');
        entry.cellsByJ[j] = cell;
        cell.style.cursor = 'pointer';
        cell.tabIndex = 0;
        cell.setAttribute('role', 'button');
        cell.addEventListener('mouseenter', () => setZeroHl(entry, j));
        cell.addEventListener('mouseleave', () => setZeroHl(entry, null));
        const gotoWave = () => {
          setTab('wave');
          openDetail(s.side, j);
          el.detail.scrollIntoView({block: 'nearest'});
        };
        cell.addEventListener('click', gotoWave);
        cell.addEventListener('keydown', ev => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          gotoWave();
        });
        grid.appendChild(cell);
      }
    }
    const axis = document.createElement('div');
    axis.className = 'zaxis';
    const ax = INNER_RIGHT[s.side] ? ['外侧', 'c1', 'c2', 'c3', '内侧'] : ['内侧', 'c1', 'c2', 'c3', '外侧'];
    axis.innerHTML = ax.map(v => `<span>${v}</span>`).join('');

    const lg = document.createElement('div');
    lg.className = 'zmeta';
    lg.innerHTML = '<span>0%</span><span class="zbar"></span><span>100%</span>';

    // 列汇总：每列的通道数 + 四类计数（四类之和 = n），不给中位数——列内位置跨行漂移，中位数描述不了任何通道
    const sum = document.createElement('div');
    sum.className = 'zsum';
    const put = (t: string, cls?: string) => { const sp = document.createElement('span'); if (cls) sp.className = cls; sp.textContent = t; sum.appendChild(sp); };
    ['', '有效', '恒0', '≥95', '5–95', '<5'].forEach((t, k) => put(t, k ? 'hd' : 'hd rl'));
    for (let c = 0; c < 5; c++) {
      let nn = 0, a = 0, hh = 0, mm = 0, ll = 0;
      for (let r = 0; r < 14; r++) {
        const j = rev[r + ',' + c];
        if (j == null) continue;
        const v = st.zr[j];
        if (!isFinite(v)) continue;      // 无数据通道不计入，四类之和 = 有效通道数
        nn++;
        if (v >= 1) a++; else if (v > .95) hh++; else if (v >= .05) mm++; else ll++;
      }
      put('c' + c, 'rl');
      [nn, a, hh, mm, ll].forEach(v => put(String(v)));
    }

    const ids = document.createElement('p');
    ids.className = 'zids';
    const li = (name, arr) => arr.length ? `${name}：${arr.map(j => 'P' + (j + 1)).join(' ')}` : '';
    ids.innerHTML = [li('恒为 0', st.always), li('零值 95–100%', st.hot)].filter(Boolean).join('<br>')
      || '没有恒为 0 或接近恒 0 的通道。';

    zc.appendChild(grid); zc.appendChild(axis); zc.appendChild(lg); zc.appendChild(sum); zc.appendChild(ids);
    wrap.appendChild(zc);
    sec.appendChild(head); sec.appendChild(p); sec.appendChild(wrap);
    row.appendChild(sec);

    zeroView.set(s.side, entry);
    bindZeroCanvas(cv, entry);
    drawZero(entry);
  }
  el.zero.appendChild(row);
  applyZeroFilter();
}

export {applyZeroFilter, drawZero, renderZero};
