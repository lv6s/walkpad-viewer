import {AXES, R2D, clamp1, pct, sgn, vec3} from './math';
import type {AxisOffline} from './offline';
import {QUIET_NEAR} from './offline';
import {bindOrbit, paint3d} from './view';
import {SIDE_CN} from '../core/constants';
import {downloadCanvas} from '../core/util';

const CONF = {hi: '高', mid: '中'};
const tm = w => `${w.a.toFixed(2)}–${w.b.toFixed(2)} s`;

function addRow(table: HTMLTableElement, values: string[], head = false) {
  const tr = table.insertRow();
  for (const text of values) {
    const cell = document.createElement(head ? 'th' : 'td');
    cell.textContent = text;
    tr.appendChild(cell);
  }
  return tr;
}

export function axisStatus(r: AxisOffline) {
  return r.forward ? '水平轴线已推断' : r.up ? '仅垂直' : '未能推断';
}

export function fillCard(e, r: AxisOffline | null, source = '', progress?: number, validTicks?: number) {
  e.res = null;
  e.cv3.hidden = true;
  e.bPng.disabled = true;
  e.details.hidden = true;
  e.warn.hidden = !r?.reason;
  for (const node of [e.sum, e.tbl, e.ev, e.warn, e.seg]) node.replaceChildren();
  if (!r) {
    e.meta.textContent = source && progress != null ? `${source} · ${progress}%` : '';
    e.sum.textContent = '正在分析步行段…';
    return;
  }

  e.meta.textContent = `${source} · ${r.candidates.length} 段步行候选` + (r.fs ? ` · ${r.fs.toFixed(1)} Hz` : '');
  e.sum.textContent = axisStatus(r) + (r.forward ? ` · ${r.supportCycles ? '承重姿态估计，非几何安装标定 · ' : ''}前后正负未定` : r.up ? ` · 向上 ${vec3(r.up)}` : '');
  if (r.reason) e.warn.textContent = validTicks === 0 ? '双侧状态检测没有有效窗口，不推断水平轴线。' : r.reason;
  else if (r.quietUpDelta != null && r.quietUpDelta >= 12) {
    e.warn.hidden = false;
    e.warn.textContent = `普通静止与承重参考相差 ${r.quietUpDelta.toFixed(1)}°，未用普通静止姿态定向上。`;
  }
  if (!r.up && !r.candidates.length) return;

  e.details.hidden = false;
  addRow(e.ev, ['依据', '观测'], true);
  if (r.supportRange) addRow(e.ev, ['承重竖直参考', `${tm(r.supportRange)} · ${r.supportCycles} 个同侧周期 · 最大偏角 ${r.supportSpread.toFixed(1)}°`]);
  if (r.quiet) {
    addRow(e.ev, [r.supportRange ? '静止段（仅用于陀螺）' : '静止参考', `${tm(r.quiet)} · 证据 ${CONF[r.confA]} · 加速度最大偏差 ${r.accSpread.toFixed(3)} g`]);
    addRow(e.ev, ['静止角速度均值', `${vec3(r.bias)} °/s · 静止角速度最大偏差 ${r.gyroSpread.toFixed(1)} °/s`]);
  }
  if (r.walk) addRow(e.ev, ['实际采用', `${tm(r.walk)} · ${r.cycles} 个有效同侧周期 · 证据 ${CONF[r.confB]}`]);
  // 静站离动作越远，零偏与佩戴越可能已经变了：亮出来，别让「证据高」盖住这段距离
  if (r.quietDist != null && Number.isFinite(r.quietDist)) {
    addRow(e.ev, ['静站间隔', `${r.quietDist.toFixed(1)} s` + (!r.supportRange && r.quietDist > QUIET_NEAR ? ' · 超过 10 s，证据最高只到「中」' : '')]);
  }
  if (r.candidates.length) {
    addRow(e.seg, ['步行候选', '分析结果'], true);
    for (const w of r.candidates) addRow(e.seg, [tm(w), w === r.used ? '采用其中合格周期' : '未用于最终结果']);
  }
  if (!r.forward) return;

  addRow(e.ev, ['跨周期一致性', `最小主轴能量占比 ${pct(r.ratio)} · 最大偏角 ${r.spread.toFixed(1)}°`]);
  addRow(e.tbl, ['设备轴', '最接近', '夹角', '前后轴（绝对值）', '左右轴（绝对值）', '向上'], true);
  const rows = AXES.map((nm, i) => {
    const v = [r.forward[i], r.lateral[i], r.up[i]];
    const [f, l, u] = v, ab = v.map(Math.abs), j = ab.indexOf(Math.max(...ab));
    const desc = j === 0 ? '前后轴' : j === 1 ? '左右轴' : u >= 0 ? '上' : '下';
    const gap = Math.acos(clamp1(ab[j])) * R2D;
    addRow(e.tbl, ['+' + nm, desc, `${gap.toFixed(1)}°`, Math.abs(f).toFixed(2), Math.abs(l).toFixed(2), sgn(u)]);
    return {desc};
  });
  e.res = {R: [r.forward, r.lateral, r.up], rows};
  e.cv3.hidden = false;
  e.bPng.disabled = false;
  paint3d(e.cv3, e.res);
}

export function makeCard(s, opt: {title?: string; file?: string} = {}): any {
  const sec = document.createElement('section'); sec.className = 'side';
  const head = document.createElement('div'); head.className = 'sechead';
  const h = document.createElement('h2'); h.textContent = opt.title || SIDE_CN[s.side] || s.side;
  const grow = document.createElement('span'); grow.className = 'grow';
  const bPng = document.createElement('button'); bPng.className = 'mini'; bPng.textContent = 'PNG'; bPng.title = '导出三维轴线';
  bPng.disabled = true;
  head.append(h, grow, bPng);
  const meta = document.createElement('p'); meta.className = 'meta';
  const sum = document.createElement('div'); sum.className = 'axsum'; sum.setAttribute('role', 'status');
  const card = document.createElement('div'); card.className = 'axcard';
  const cv3 = document.createElement('canvas'); cv3.hidden = true;
  cv3.title = '拖动旋转视角 · 滚轮缩放 · 双击复位'; card.appendChild(cv3);
  const tbl = document.createElement('table'); tbl.className = 'axtbl';
  const details = document.createElement('details'); details.hidden = true;
  const label = document.createElement('summary'); label.textContent = '查看步行候选与推断依据';
  const ev = document.createElement('table'); ev.className = 'axev';
  const seg = document.createElement('table'); seg.className = 'axseg';
  details.append(label, seg, ev);
  const warn = document.createElement('div'); warn.className = 'axwarn';
  sec.append(head, meta, sum, warn, tbl, details, card);
  const e = {s, sec, bPng, cv3, meta, sum, tbl, details, ev, seg, warn, res: null};
  bindOrbit(cv3);
  bPng.addEventListener('click', () => { if (e.res) downloadCanvas(cv3, `${opt.file || 'data'}_${s.side}_axis.png`); });
  return e;
}
