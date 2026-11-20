/* 页签切换与总渲染编排。 */

import {renderActivity} from './activity';
import {drawAction, renderAction} from './action';
import {drawAxis, renderAxis} from './axis';
import {renderCop, stopPlay} from './cop';
import {SIDE_CN} from './core/constants';
import {$, el} from './core/dom';
import {gapView, imuView, state, view, zeroView} from './core/state';
import {fmt} from './core/util';
import {openDetail} from './detail';
import {exportCsv, exportPng} from './export';
import {drawGap, renderGap} from './gap';
import {drawImu, renderImu} from './imu';
import {bindWavePointer} from './interact';
import {updateWinBar} from './timewin';
import {drawSide} from './wave';
import {applyZeroFilter, drawZero, renderZero} from './zero';

// 时间窗条摆在页签下面、所有页共用一份：窗口是全局状态，换页还要重新找它没有意义。
// 缩略条同样常驻，长录制里它就是「现在看的是哪一段」的唯一全局参照。
function placeWinBar(name) {
  el.winBar.hidden = !state.sides.length;
  if (el.winKeys) el.winKeys.textContent = name === 'activity'
    ? '点色块定位 · 时间框缩放'
    : name === 'axis'
    ? '时间段只影响「当前时间窗」推断'
    : name === 'action'
    ? '框选一段动作再分析'
    : 'Shift+拖动 框选 · 滚轮 缩放 · 双击 复位'
      + (name === 'wave' ? ' · 点格子看单通道' : '');
  updateWinBar();
}

// 标签页只有一页可见，隐藏页的 canvas 宽度为 0，所以只画当前页
function setTab(name) {
  // 独立轴向页没有页签栏：这一页的一切都在 axis/page.ts 自己那边
  if (!el.tabs) return;
  const hasP = state.hasP;
  if (!hasP && (name === 'wave' || name === 'cop' || name === 'zero')) name = 'imu';
  if (name === 'imu' && !state.sides.some(s => s.imu)) name = hasP ? 'wave' : 'axis';   // 无 IMU 列时回退
  if (name === 'axis' && !state.sides.some(s => s.imu && s.imu.phys)) name = hasP ? 'wave' : 'imu';
  // 动作速度只认物理量六轴：raw 是硬件计数，量纲不对
  if (name === 'action' && !state.sides.some(s => s.imu && s.imu.phys)) name = hasP ? 'wave' : 'imu';
  state.tab = name;
  el.viewWave.hidden = name !== 'wave';
  el.viewCop.hidden = name !== 'cop';
  el.viewZero.hidden = name !== 'zero';
  el.viewGap.hidden = name !== 'gap';
  el.viewImu.hidden = name !== 'imu';
  el.viewAxis.hidden = name !== 'axis';
  if (el.viewActivity) el.viewActivity.hidden = name !== 'activity';
  if (el.viewAction) el.viewAction.hidden = name !== 'action';
  el.tabs.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  if (name !== 'cop') stopPlay();
  if (name !== 'wave') { state.hoverT = null; el.tip.style.display = 'none'; }
  placeWinBar(name);
  if (name === 'wave') {
    for (const e of view.values()) drawSide(e);
    updateWinBar();
    if (state.detail) openDetail(state.detail.side, state.detail.j);
  } else if (name === 'cop') {
    void renderCop();
  } else if (name === 'zero') {
    for (const e of zeroView.values()) drawZero(e);
    applyZeroFilter();
  } else if (name === 'gap') {
    drawGap();
  } else if (name === 'activity') {
    renderActivity();
  } else if (name === 'action') {
    renderAction();
  } else if (name === 'axis') {
    drawAxis();
  } else {
    const gaitFocus = document.getElementById('gaitWaveFocus');
    gaitFocus.hidden = !state.gaitFocus;
    const focus = state.gaitFocus;
    if (focus) document.getElementById('gaitWaveNote').textContent = [SIDE_CN[focus.side], `IC/TO ${focus.algorithm}`,
      focus.note || (Number.isFinite(focus.to) ? '步态统计使用的候选周期' : '无可用配对')].join(' · ');
    for (const e of imuView.values()) drawImu(e);
  }
}

// 顶栏标签：全段统计在后台扫完后要再刷一次，所以单独成函数
function updateChips() {
  if (!state.sides.length) return;
  const hasP = state.hasP;
  const totalFrames = state.sides.reduce((a, s) => a + s.n, 0);
  // 报「录了多久」用 span（末帧−首帧）：时间轴起点被先出流的那台设备拉到 0 之后，
  // 后开始录的流 t[n−1] 会明显大于它自己的录制长度
  const maxDur = Math.max(...state.sides.map(s => s.span || s.dur));
  const starts = state.sides.map(s => s.t[0]);
  const nImu = state.sides.filter(s => s.imu).length;
  // 一包里可能混着不同采样率的设备：只报第一条流的记录率会让人以为另一条也是这个数
  const rates = [...new Set(state.sides.map(s => s.fs).filter(v => isFinite(v)).map(v => v.toFixed(2)))];
  const rateTxt = rates.length > 1
    ? state.sides.filter(s => isFinite(s.fs)).map(s => `${SIDE_CN[s.side] || s.side} ${s.fs.toFixed(1)}`).join(' · ')
    : rates.length ? rates[0] + ' Hz' : '—';
  const nchMax = Math.max(...state.sides.map(s => s.nch));
  // 角速度口径：有扣偏结果的帧用扣偏值，其余回落原始换算值（逐帧判定，可能两种都有）
  const calReady = state.sides.reduce((a, s) => a + ((s.cal && s.cal.ready) || 0), 0);
  const calRaw = state.sides.reduce((a, s) => a + ((s.cal && s.cal.raw) || 0), 0);
  // 温度只有一部分导出才有（app 5.x / 网页导出 / 维特 TXT）；两侧都有时合成一条 min–max
  const tSides = state.sides.filter(s => s.temp || Number.isFinite(s.tLo));
  const tLo = tSides.length ? Math.min(...tSides.map(s => s.tLo)) : NaN;
  const tHi = tSides.length ? Math.max(...tSides.map(s => s.tHi)) : NaN;
  // 有效帧时间缺失、退回到达时刻也拿不到的帧被丢掉了，数量大到值得提一句
  const nUnmapped = state.sides.reduce((a, s) => a + (s.nT || 0), 0);
  // 文件条只放能一眼定性的几项；完整摘要（格式、起点、角速度口径、温度）挂在文件名上，悬停即见
  const rows: [string, string][] = [
    ['侧别', state.sides.map(s => SIDE_CN[s.side] || s.side).join(' / ')],
    ['帧数', fmt(totalFrames)],
    ['最长', maxDur.toFixed(1) + ' s'],
    ['均记录率', rateTxt],
    ...(hasP ? [['通道', nchMax + ' · 最大 ' + fmt(state.gmax) + ' ADC'] as [string, string]] : []),
    ...(nImu ? [['IMU', nImu + ' 侧 × 6 轴'] as [string, string]] : []),
    ...(nUnmapped ? [['时间未映射', nUnmapped + ' 帧'] as [string, string]] : [])
  ];
  el.chips.innerHTML = rows.map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('');
  el.fname.title = [
    state.name,
    ...(state.src && state.src.ver ? ['格式 ' + state.src.ver + (state.src.ncols ? ' · ' + state.src.ncols + ' 列' : '')] : []),
    ...(starts.some(v => v > 0.05)
      ? ['起点 ' + state.sides.map((s, i) => `${SIDE_CN[s.side] || s.side} ${starts[i].toFixed(1)} s`).join(' · ')]
      : []),
    ...(nImu ? ['角速度 ' + (calReady && calRaw ? `扣偏 ${fmt(calReady)} / 原始 ${fmt(calRaw)} 帧`
      : calReady ? '已扣偏' : '原始换算（无扣偏结果）')] : []),
    ...(tSides.length && Number.isFinite(tLo) ? ['温度 ' + `${tLo.toFixed(2)}–${tHi.toFixed(2)} ℃`] : [])
  ].join('\n');
}

function renderAll() {
  if (!el.bar) return;      // 独立轴向页没有顶栏
  el.bar.hidden = false;
  el.drop.hidden = true;
  el.tabs.hidden = false;
  el.fname.textContent = state.name;
  el.fname.title = state.name;

  const hasP = state.hasP;
  updateChips();

  // 只有 IMU 的文件没有压力通道，压力三页整块禁用（不是画空图）；
  // 丢包页对两种文件都有意义，维特 TXT 走按累计帧数的那套口径
  for (const t of ['wave', 'cop', 'zero', 'gap']) {
    const b = el.tabs.querySelector(`[data-tab="${t}"]`);
    if (!b) continue;
    b.disabled = !hasP && t !== 'gap';
    b.title = b.disabled ? '这份文件只有 IMU，没有压力通道'
      : (t === 'gap' && state.rebuilt ? '维特 TXT 的时间戳是上位机写盘时刻，这一页按累计帧数估' : '');
  }
  // 动作速度只认物理量六轴：raw 是硬件计数，量纲不对
  {
    const b = el.tabs.querySelector('[data-tab="action"]');
    const ok = state.sides.some(s => s.imu && s.imu.phys);
    if (b) { b.disabled = !ok; b.title = ok ? '' : '这一页需要物理量六轴（g / °/s）'; }
  }

  // 详情卡会被插到某个 section 后面，重建面板前先收回，否则跟着 innerHTML 一起被清掉
  el.viewWave.appendChild(el.detail);
  if (!state.detail) el.detail.hidden = true;
  if (hasP) {
    el.panels.innerHTML = '';
    view.clear();
    renderZero();
  }
  renderActivity();
  renderAction();
  renderGap();
  renderImu();
  renderAxis();

  if (hasP) for (const s of state.sides) {
    if (!(s.nch > 0)) continue;          // 纯 IMU 的设备（如专用 IMU 节点、腕带）没有压力面板
    const sec = document.createElement('section');
    sec.className = 'side';
    const head = document.createElement('div');
    head.className = 'sechead';
    const h = document.createElement('h2');
    h.textContent = (SIDE_CN[s.side] || s.side) + ' ' + s.nch + ' 个传感器原始压力波形';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const bPng = document.createElement('button');
    bPng.className = 'mini'; bPng.textContent = 'PNG'; bPng.title = '导出当前视图为图片';
    const bCsv = document.createElement('button');
    bCsv.className = 'mini'; bCsv.textContent = 'CSV'; bCsv.title = '导出当前时间窗内全部通道的读数';
    head.append(h, grow, bPng, bCsv);
    const p = document.createElement('p');
    p.className = 'meta';
    const wrap = document.createElement('div');
    wrap.className = 'canvas-wrap';
    const cv = document.createElement('canvas');
    wrap.appendChild(cv);
    sec.appendChild(head); sec.appendChild(p); sec.appendChild(wrap);
    el.panels.appendChild(sec);

    const entry = {s, cv, metaEl: p, off: document.createElement('canvas'), cells: [], sel: null};
    view.set(s.side, entry);

    bindWavePointer(cv, entry);
    bPng.addEventListener('click', () => exportPng(entry));
    bCsv.addEventListener('click', () => exportCsv(entry));
  }

  updateWinBar();

  setTab(state.tab);
}

export {renderAll, setTab, updateChips};
