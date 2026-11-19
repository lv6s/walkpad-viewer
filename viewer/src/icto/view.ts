/* IC/TO 标注：每个文件算一次存 state.icto，绘制只画在底图上 —— PNG 导出取的是底图，
   画在叠加层里的标记导不出来。 */

import {setTab} from '../app';
import {SIDE_CN} from '../core/constants';
import {$, el} from '../core/dom';
import {state} from '../core/state';
import {baseName, css, downloadCsv} from '../core/util';
import {drawGap} from '../gap';
import {ictoDetectRows} from './core';
import {redrawImu} from '../imu';
import {applyWin, redrawWave} from '../timewin';

const C_IC = '#c2410c';      // 首触地：暖色，跟压力起跳对得上眼
const C_TO = '#1d4ed8';
// 检测路径：内部是常态，首尾与弱起步是「独立候选，需视频确认」的补充事件
const PATH_CN: Record<string, string> = {
  interior: '内部分段', record_start: '首端 TO', record_end: '末端 IC', startup_recovery: '弱起步'
};

function computeAll() {
  const out = new Map();
  for (const s of state.sides) {
    if (!s.ictoIn) continue;
    try { out.set(s.side, ictoDetectRows(s.ictoIn, s.side, baseName())); }
    catch (e) { out.set(s.side, {events: [], cycles: [], diagnostics: {status: '计算失败：' + ((e && e.message) || e)}}); }
  }
  state.icto = out;
  return out;
}
function ensure() { return state.icto || computeAll(); }

function sideTag(side) { return SIDE_CN[side] || side; }

const num = (v: any) => (typeof v === 'number' && isFinite(v)) ? v : NaN;

function noteText() {
  const rec = ensure();
  const parts = [];
  for (const s of state.sides) {
    const r = rec.get(s.side);
    if (!r) { parts.push(sideTag(s.side) + ' 无 IC/TO'); continue; }
    const d = r.diagnostics || {};
    if (d.status) { parts.push(sideTag(s.side) + '：' + d.status); continue; }
    const ic = (d.events && d.events.IC) || 0;
    const to = (d.events && d.events.TO) || 0;
    const rej = r.cycles.filter(c => c.status !== 'candidate_pair').length;
    const cut = isFinite(d.swing_lobe_threshold_dps) ? d.swing_lobe_threshold_dps.toFixed(0) : '—';
    parts.push(`${sideTag(s.side)} IC ${ic} / TO ${to}　拒绝分段 ${rej}　轴 ${d.sign > 0 ? '+' : '−'}g${d.gyro_axis}　门限 ${cut} °/s`);
  }
  return parts.join('　｜　') || '本文件没有可算 IC/TO 的六轴';
}

// 悬停看构成：内部搜索给几条、首尾补了几条、弱起步补了几条，以及两个方向的支撑窗评分
function noteTitle() {
  const rec = ensure();
  const out = [];
  for (const s of state.sides) {
    const r = rec.get(s.side);
    const d = (r && r.diagnostics) || {};
    if (!r || d.status) continue;
    const k = (o: any) => `${(o && o.IC) || 0}/${(o && o.TO) || 0}`;
    const pol = d.polarity_selection || {};
    const sc = (pol.options || []).map((o: any) => `${o.sign > 0 ? '+' : '−'} ${num(o.median_support_G_dps).toFixed(1)}`);
    out.push(`${sideTag(s.side)}：内部 ${k(d.interior_events)} · 首尾 ${k(d.boundary_events)} · 弱起步 ${k(d.startup_events)}；`
      + `方向 ${pol.status || '—'}（支撑窗 |ω| 中位 ${sc.join(' / ') || '—'} °/s）；`
      + `首端 ${d.boundary_diagnostics ? d.boundary_diagnostics[0]?.status : '—'}，`
      + `弱起步 ${d.startup_diagnostics ? d.startup_diagnostics.status : '—'}`);
  }
  return out.join('\n');
}

// 每个标记画一条竖线；全段缩到标记挤在一起时只剩顶端那道色杠看得见
function paint(ctx, s, geo) {
  if (!state.ictoOn) return;
  const rec = state.icto;
  if (!rec) return;
  const r = rec.get(s.side);
  if (!r || !r.events.length) return;
  const span = (geo.b - geo.a) || 1;
  const W = geo.x1 - geo.x0;
  if (!(W > 0) || !(geo.bot > geo.top)) return;
  const t0 = (s.t0 || 0) / 1e6;
  // 全段缩到几十个事件挤一起时只留竖线与顶端色杠；写字从 span ≤ 8 s 开始，否则满屏 IC/TO 糊成一片
  const labOn = geo.label !== false && (geo.b - geo.a) <= 8;
  let nextLbl = -Infinity;
  ctx.save();
  ctx.beginPath(); ctx.rect(geo.x0, geo.top, W, geo.bot - geo.top); ctx.clip();
  for (const e of r.events) {
    const t = e.imu_packet_time_s - t0;
    if (!(t >= geo.a && t <= geo.b)) continue;
    const x = Math.round(geo.x0 + (t - geo.a) / span * W) + .5;
    const ic = e.event === 'IC';
    // 首尾与弱起步是补出来的候选（需视频确认），画得淡一点、顶端换成空心点，跟内部分段区分开
    const fitted = e.detection_path !== 'interior';
    ctx.strokeStyle = ic ? C_IC : C_TO;
    ctx.lineWidth = 1;
    ctx.globalAlpha = fitted ? .34 : .5;
    ctx.setLineDash(ic ? [] : [4, 3]);
    ctx.beginPath(); ctx.moveTo(x, geo.top); ctx.lineTo(x, geo.bot); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = .95;
    if (fitted) {
      ctx.beginPath(); ctx.arc(x, geo.top + 3.5, 2.5, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillRect(x - 1, geo.top, 2, 3);
    }
    if (labOn && x >= nextLbl) {
      const lb = ic ? 'IC' : 'TO';
      const yy = geo.top + (ic ? 12 : 25);
      ctx.font = '10px system-ui,"Microsoft YaHei",sans-serif';
      const w = ctx.measureText(lb).width + 6;
      ctx.globalAlpha = .82; ctx.fillStyle = css('--card');
      ctx.fillRect(x + 1, yy - 7, w, 13);
      ctx.globalAlpha = 1; ctx.fillStyle = ic ? C_IC : C_TO;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(lb, x + 4, yy);
      nextLbl = x + w + 4;
    }
  }
  ctx.restore();
}

function redraw() {
  if (state.tab === 'imu') redrawImu();
  else if (state.tab === 'wave') redrawWave();
  else if (state.tab === 'gap') drawGap();
}

// ---------------------------------------------------------------- 事件表
function rowsOf() {
  const rec = ensure();
  const out: any[] = [];
  for (const s of state.sides) {
    const r = rec.get(s.side);
    if (!r) continue;
    const byCycle = new Map<number, any>();
    for (const e of r.events) {
      let c = byCycle.get(e.cycle);
      if (!c) { c = {cycle: e.cycle, ic: null, to: null, path: e.detection_path, note: '', sw: e.swing_start_s, status: ''}; byCycle.set(e.cycle, c); }
      if (e.event === 'IC') c.ic = e; else c.to = e;
      if (e.detection_path !== 'interior') c.path = e.detection_path;
      if (e.review_note) c.note = e.review_note;
    }
    for (const c of r.cycles) {
      if (!byCycle.has(c.cycle)) byCycle.set(c.cycle, {cycle: c.cycle, ic: null, to: null, path: 'interior',
        note: '', sw: c.swing_start_s, status: c.status});
    }
    for (const c of [...byCycle.values()].sort((a, b) => a.cycle - b.cycle)) {
      // 首尾 / 弱起步不在 cycles 里，成不成对只看这一行有没有凑齐
      if (!c.status) c.status = (c.ic && c.to) ? 'candidate_pair' : ('only_' + (c.ic ? 'IC' : c.to ? 'TO' : 'none'));
      out.push({side: s.side, ...c});
    }
  }
  return out;
}

function statusText(r: any) {
  // 首尾与弱起步本来就是单边补出来的，没有「缺一对」这回事
  if (r.path === 'record_start') return '首端补 TO';
  if (r.path === 'record_end') return '末端补 IC';
  if (r.path === 'startup_recovery') return '弱起步补一对';
  if (r.status === 'candidate_pair') return '成对';
  if (r.status === 'only_IC') return '<b>仅 IC（缺 TO）</b>';
  if (r.status === 'only_TO') return '<b>仅 TO（缺 IC）</b>';
  return '<b>' + r.status + '</b>';
}

function renderTable() {
  if (!el.ictoBox) return;
  const rows = rowsOf();
  const t0 = new Map(state.sides.map(s => [s.side, (s.t0 || 0) / 1e6]));
  const head = ['侧别', '周期', '来源', 'IC (s)', 'TO (s)', '间隔 (s)', '状态', '备注'];
  const h = ['<table><thead><tr>' + head.map(v => `<th>${v}</th>`).join('') + '</tr></thead><tbody>'];
  for (const r of rows) {
    const o = t0.get(r.side) || 0;
    const ic = r.ic ? r.ic.imu_packet_time_s - o : NaN;
    const to = r.to ? r.to.imu_packet_time_s - o : NaN;
    // 内部周期是 IC（触地）→TO（离地），量的是支撑期；弱起步那一对是 TO→IC，量的是摆动
    const d = to - ic;
    const gap = !isFinite(d) ? '—' : (d >= 0 ? d.toFixed(3) : 'TO→IC ' + (-d).toFixed(3));
    const ok = r.status === 'candidate_pair' || r.path !== 'interior';
    // 没成对的周期（拒绝分段）跳到摆动起点，成对的跳到 IC
    const sw = num(r.sw);
    const tk = isFinite(ic) ? ic : (isFinite(sw) ? sw - o : NaN);
    h.push(`<tr data-t="${isFinite(tk) ? tk : ''}" class="${ok ? '' : 'bad'}">`
      + `<td>${sideTag(r.side)}</td><td>${r.cycle}</td>`
      + `<td>${PATH_CN[r.path] || r.path}</td>`
      + `<td>${isFinite(ic) ? ic.toFixed(4) : '—'}</td>`
      + `<td>${isFinite(to) ? to.toFixed(4) : '—'}</td>`
      + `<td>${gap}</td>`
      + `<td>${statusText(r)}</td>`
      + `<td>${r.note || ''}</td></tr>`);
  }
  h.push('</tbody></table>');
  el.ictoBox.innerHTML = h.join('');
  el.ictoBox.querySelectorAll('tbody tr').forEach(tr => {
    tr.title = '点击把这个周期放大到 ±0.4 s';
    tr.addEventListener('click', () => {
      const t = Number(tr.dataset.t);
      if (!isFinite(t) || tr.dataset.t === '') return;
      setTab('imu');
      applyWin(Math.max(0, t - .4), t + .4);
    });
  });
}

function csvEvents() {
  const rec = ensure();
  const out = ['side,event_id,cycle,event,detection_path,time_s,swing_start_s,swing_end_s,pitch_proxy_dps,acc_norm_g,'
    + 'source_frame_ordinal,reference_stride_s,support_window_start_s,support_window_end_s,status,review_note'];
  const s6 = (v: any, o: number) => isFinite(num(v)) ? (num(v) - o).toFixed(6) : '';
  for (const s of state.sides) {
    const r = rec.get(s.side);
    if (!r) continue;
    const t0 = (s.t0 || 0) / 1e6;
    for (const e of r.events) {
      const win = e.support_window || [null, null];
      out.push([e.side, e.id, e.cycle, e.event, e.detection_path,
        (e.imu_packet_time_s - t0).toFixed(6),
        s6(e.swing_start_s, t0), s6(e.swing_end_s, t0),
        e.pitch_proxy_dps, e.acc_norm_g,
        isFinite(e.source_frame_ordinal) ? e.source_frame_ordinal : '',
        isFinite(num(e.reference_stride_s)) ? num(e.reference_stride_s).toFixed(6) : '',
        isFinite(num(win[0])) ? (num(win[0]) - t0).toFixed(6) : '',
        isFinite(num(win[1])) ? (num(win[1]) - t0).toFixed(6) : '',
        e.status, e.review_note].join(','));
    }
  }
  if (out.length === 1) return;
  downloadCsv(out, `${baseName()}_ic_to_events.csv`);
}

function csvCycles() {
  const rec = ensure();
  const out = ['side,cycle,swing_start_s,swing_end_s,status'];
  for (const s of state.sides) {
    const r = rec.get(s.side);
    if (!r) continue;
    const t0 = (s.t0 || 0) / 1e6;
    for (const c of r.cycles) {
      out.push([c.side, c.cycle, (c.swing_start_s - t0).toFixed(6), (c.swing_end_s - t0).toFixed(6), c.status].join(','));
    }
  }
  if (out.length === 1) return;
  downloadCsv(out, `${baseName()}_ic_to_cycles.csv`);
}

// ---------------------------------------------------------------- 接线
function syncUi() {
  const anyIn = state.sides.some(s => s.ictoIn);
  // 这份文件根本没有六轴（或六轴里带空值）时整条工具条收起来，不摆一排按不动的按钮
  const tools = document.getElementById('ictoTools');
  if (tools) tools.hidden = !anyIn;
  if (el.ictoOn) {
    el.ictoOn.classList.toggle('on', !!state.ictoOn);
    el.ictoOn.textContent = state.ictoOn ? '已标出' : '标注';
  }
  if (el.ictoBox) el.ictoBox.hidden = !state.ictoListOn || !anyIn;
  if (el.ictoNote) {
    el.ictoNote.textContent = anyIn ? noteText() : '本文件没有可算 IC/TO 的六轴';
    el.ictoNote.title = anyIn ? noteTitle() : '';
  }
  if (el.ictoRe) el.ictoRe.disabled = !anyIn;
}

// 换文件后调用：重算并刷新工具条与表
function reset() {
  state.icto = null;
  if (el.ictoBox) el.ictoBox.innerHTML = '';
  state.ictoOn = state.sides.some(s => s.ictoIn);
  state.ictoListOn = false;
  ensure();
  syncUi();
  renderTable();
}

function bind() {
  if (el.ictoOn) el.ictoOn.addEventListener('click', () => {
    state.ictoOn = !state.ictoOn;
    syncUi(); redraw();
  });
  if (el.ictoList) el.ictoList.addEventListener('click', () => {
    state.ictoListOn = !state.ictoListOn;
    syncUi(); renderTable();
  });
  if (el.ictoRe) el.ictoRe.addEventListener('click', () => {
    state.icto = null; ensure(); syncUi(); renderTable(); redraw();
  });
  if (el.ictoCsvEv) el.ictoCsvEv.addEventListener('click', csvEvents);
  if (el.ictoCsvCy) el.ictoCsvCy.addEventListener('click', csvCycles);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
else bind();

export {csvCycles as ictoCsvCycles, csvEvents as ictoCsvEvents, paint as ictoPaint, reset as ictoReset, rowsOf as ictoRows, syncUi as ictoSyncUi};
