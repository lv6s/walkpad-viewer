/* 独立轴向推断页的接线：拖入任意份文件 → 自动分工（谁当参考）→ 对齐 → 分段 → 逐段推断 → 汇总表。
   算法全在 math / align，绘制在 view，卡片在 card，这里只管 DOM 与「一键」的编排。 */

import {axRun} from '../axis';
import {fillCard, fillSeg, makeCard} from './card';
import {SENS, infer} from './math';
import {SIDE_CN} from '../core/constants';
import {state} from '../core/state';
import {blkOf} from '../core/util';
import {parse} from '../parse';

const $ = s => document.querySelector(s);
const el = {
  drop: $('#drop'), file: $('#file'), pick: $('#pick'), err: $('#err'), busy: $('#busy'),
  list: $('#fileList'), sum: $('#axSummary'), cards: $('#axCards'), note: $('#axNote'),
  tools: $('#axTools'), again: $('#axAgain'), clear: $('#axClear')
};

// 独立页没有主查看器那套 DOM：renderAll / setTab / renderAxis 各自判空后直接返回，
// 所以 parse 收尾那几下落到本页是无害的空操作
const files = [];          // [{name, sides, mode}]
let manualRef = null;      // 手动指定哪份当参考；null = 自动挑
let sensKey = 'auto';
const cards = new Map();   // 'fi:side' -> entry

// ---------------------------------------------------------------- 解析
async function addFiles(list: FileList | File[]) {
  for (const f of Array.from(list || [])) {
    if (files.some(x => x.name === f.name)) continue;   // 同名文件不重复加
    await parse(f);
    if (state.name !== f.name || !state.sides.length) continue;   // 解析失败，错误已写在 #err
    files.push({name: state.name, sides: state.sides, mode: state.mode});
  }
  manualRef = null;
  render();
}

// ---------------------------------------------------------------- 推断
const CONF = {hi: '高', mid: '中', lo: '低'};
const W = {hi: 3, mid: 2, lo: 1};

// 结果好坏：完整结论 > 部分结论（只定了垂直轴）> 定不出
function rank(r) {
  if (!r || r.err) return -1;
  if (r.partial) return 1;
  return 10 + (W[r.confB] || 0) * 3 + (W[r.confC] || 0) * 2 + (W[r.confA] || 0);
}

// 一台设备的全部候选段（含「全段」）：先算好，卡片和汇总表共用
function evalSegs(s, plan, sens) {
  const ds = blkOf(s);      // 懒加载时只有窗口块，范围也跟着改用块内的
  const segs = (plan && plan.segs) || [];
  const cand: any[] = [{i: -1, a: ds.t[0], b: ds.t[ds.n - 1], kind: '—'}]
    .concat(segs.map((g, i) => ({i, a: g.a, b: g.b, kind: g.kind})));
  for (const c of cand) c.res = infer(s, {sens, win: c.i < 0 ? null : {a: c.a, b: c.b}});
  let best = cand[0];
  for (const c of cand) if (rank(c.res) > rank(best.res)) best = c;
  return {cand, best};
}

const fmtT = v => v.toFixed(1);

function render() {
  cards.clear();
  el.cards.innerHTML = '';
  el.sum.innerHTML = '';
  el.list.hidden = !files.length;
  el.tools.hidden = !files.length;
  el.drop.classList.toggle('compact', files.length > 0);
  if (!files.length) {
    el.note.textContent = '';
    return;
  }

  const sens = SENS[sensKey] || SENS.auto;
  const res = axRun(files, {refIdx: manualRef, sens: sensKey});
  renderList(res);
  renderCards(res, sens);
  renderSummary(res);
}

// ---------------------------------------------------------------- 文件列表：角色、偏移、移除
function renderList(res) {
  el.list.innerHTML = '';
  res.perFile.forEach((pf, fi) => {
    const row = document.createElement('div');
    row.className = 'axfrow';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = pf.name;
    nm.title = pf.name;

    const role = document.createElement('button');
    role.className = 'badge ' + (pf.ref ? 'hi' : 'mid');
    role.textContent = pf.ref ? (files.length > 1 ? '参考' : '自身分段') : '主数据';
    role.title = pf.ref
      ? (files.length > 1
        ? '这份只提供时间锚点与动作边界，它的轴向结论不会搬给别的文件。点一下改成别份当参考'
        : '只有一份文件：用它自己切动作段，参考与主数据是同一份')
      : '点一下把这份设成参考数据（只用它的落地冲击对齐时间戳、只用它切动作段）';
    role.addEventListener('click', () => { manualRef = fi; render(); });

    const meta = document.createElement('span');
    meta.className = 'chip';
    const n = pf.devices.length;
    const dur = Math.max(...pf.devices.map(d => {
      const b = blkOf(d.s);
      return b.n ? b.t[b.n - 1] : 0;
    }), 0);
    const fs = pf.devices.length ? blkOf(pf.devices[0].s).fs : NaN;
    meta.innerHTML = `${n} 台 · ${dur.toFixed(1)} s · <b>${isFinite(fs) ? fs.toFixed(1) : '—'} Hz</b>`;
    meta.title = pf.devices.map(d => d.s.side).join(' / ');

    const off = document.createElement('span');
    off.className = 'chip';
    if (files.length < 2) off.textContent = '单份';
    else if (res.refIdx < 0) off.textContent = '未对齐';
    else if (pf.dt == null) { off.textContent = '对不上'; off.className = 'chip warn'; }
    else off.innerHTML = `偏移 <b>${pf.dt >= 0 ? '+' : ''}${pf.dt.toFixed(2)} s</b>`;

    const del = document.createElement('button');
    del.className = 'mini';
    del.textContent = '移除';
    del.addEventListener('click', () => { files.splice(fi, 1); manualRef = null; render(); });

    row.append(nm, role, meta, off, del);
    el.list.appendChild(row);
  });

  const p = res.plan || {};
  if (files.length === 1) {
    el.note.textContent = '只有一份文件：用它自己切动作段（走动 / 原地动作 / 静止），每段单独推断。'
      + '再拖一份同一次录制里另一台设备 / 另一只脚的文件，就能按它的落地冲击对齐时间戳、按它的动作边界切段。';
  } else if (res.refIdx < 0) {
    el.note.textContent = '没有一份文件含可用的 IMU 数据，无法分工。';
  } else if (p.err) {
    el.note.textContent = '分段失败：' + p.err;
  } else {
    const segs = p.segs || [];
    el.note.textContent = `参考 = ${res.perFile[res.refIdx].name} · 切成 ${segs.length} 段`
      + (segs.length ? '（' + segs.map(g => g.kind).join(' / ') + '）' : '')
      + ' · 每台设备各自推断，结论互不搬运';
  }
}

// ---------------------------------------------------------------- 卡片：默认停在「最像结论」的那一段
function renderCards(res, sens) {
  res.perFile.forEach((pf, fi) => {
    for (const d of pf.devices) {
      const s = d.s;
      const ev = evalSegs(s, d.plan, sens);
      const entry = makeCard(s, {
        title: (files.length > 1 ? pf.name + ' · ' : '') + (SIDE_CN[s.side] || s.side),
        file: pf.name.replace(/\.(parquet|txt|csv)$/i, '')
      });
      entry.cand = ev.cand;
      entry.best = ev.best;
      entry.plan = d.plan;
      entry.segPick = ev.best.i;
      entry.onPick = i => { entry.segPick = i; markSummary(); };
      el.cards.appendChild(entry.sec);
      cards.set(fi + ':' + s.side, entry);

      fillCard(entry, ev.best.i < 0 ? null : {a: ev.best.a, b: ev.best.b}, sens, ev.best.res);
      fillSeg(entry, d.plan, sens);
    }
  });
}

// ---------------------------------------------------------------- 汇总表：每台设备的每段一行
function renderSummary(res) {
  const tbl = document.createElement('table');
  tbl.className = 'axseg axsumtbl';
  const cols = ['文件 · 设备', '段', '时间 (s)', '类型', '三轴结论', '垂直', '内外侧', '前向'];
  const head = document.createElement('tr');
  for (const h of cols) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); }
  tbl.appendChild(head);

  res.perFile.forEach((pf, fi) => {
    for (const d of pf.devices) {
      const key = fi + ':' + d.s.side;
      const entry = cards.get(key);
      if (!entry) continue;
      entry.cand.forEach((c, ci) => {
        const tr = document.createElement('tr');
        tr.dataset.key = key;
        tr.dataset.seg = c.i;
        // 同一台设备的续行不再重复文件与设备名，表才看得清
        tr.appendChild(td(ci === 0
          ? (files.length > 1 ? pf.name + ' · ' : '') + (SIDE_CN[d.s.side] || d.s.side)
          : '', 'ax'));
        tr.appendChild(td(c.i < 0 ? '全段' : String(c.i + 1), 'num'));
        tr.appendChild(td(`${fmtT(c.a)}–${fmtT(c.b)}`, 'num'));
        tr.appendChild(td(c.kind || '—'));
        const r = c.res;
        if (!r || r.err) {
          tr.appendChild(td('无法推断', 'dim'));
          for (let j = 0; j < 3; j++) tr.appendChild(td('—', 'dim'));
        } else if (r.partial) {
          tr.appendChild(td('定不出（只定出垂直轴）', 'dim'));
          tr.appendChild(td(CONF[r.confA] || '—'));
          for (let j = 0; j < 2; j++) tr.appendChild(td('—', 'dim'));
        } else {
          tr.appendChild(td(r.rows.map(x => `${x.nm}→${x.desc}`).join(' ')));
          tr.appendChild(td(CONF[r.confA] || '—'));
          tr.appendChild(td(CONF[r.confB] || '—'));
          tr.appendChild(td(CONF[r.confC] || '—'));
        }
        if (c.i === entry.best.i) tr.classList.add('pick');
        tr.addEventListener('click', () => {
          entry.segPick = c.i;
          fillCard(entry, c.i < 0 ? null : {a: c.a, b: c.b}, SENS[sensKey] || SENS.auto, c.res);
          fillSeg(entry, entry.plan, SENS[sensKey] || SENS.auto);
          markSummary();
          entry.sec.scrollIntoView({block: 'start', behavior: 'smooth'});
        });
        tbl.appendChild(tr);
      });
    }
  });
  el.sum.appendChild(tbl);
  markSummary();
}

// 高亮「当前正在看的那一段」：卡片上段表被点、或汇总表被点，两处都要跟着走
function markSummary() {
  el.sum.querySelectorAll('tr[data-key]').forEach(tr => {
    const e = cards.get(tr.dataset.key);
    tr.classList.toggle('on', !!e && Number(tr.dataset.seg) === e.segPick);
  });
}

function td(txt: string, cls?: string) {
  const c = document.createElement('td');
  if (cls) c.className = cls;
  c.textContent = txt;
  return c;
}

// ---------------------------------------------------------------- 事件
function bind() {
  const hot = on => el.drop.classList.toggle('hot', on);
  el.drop.addEventListener('dragover', e => { e.preventDefault(); hot(true); });
  el.drop.addEventListener('dragleave', () => hot(false));
  el.drop.addEventListener('drop', e => {
    e.preventDefault(); hot(false);
    addFiles(e.dataTransfer.files);
  });
  el.pick.addEventListener('click', e => { e.stopPropagation(); el.file.click(); });
  el.file.addEventListener('change', () => { addFiles(el.file.files); el.file.value = ''; });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest('#drop')) return;
    addFiles(e.dataTransfer && e.dataTransfer.files);
  });

  el.tools.querySelectorAll('button[data-sens]').forEach(b => {
    b.addEventListener('click', () => {
      sensKey = b.dataset.sens;
      el.tools.querySelectorAll('button[data-sens]').forEach(x => x.classList.toggle('on', x === b));
      render();
    });
  });
  el.again.addEventListener('click', () => { manualRef = null; render(); });
  el.clear.addEventListener('click', () => { files.length = 0; manualRef = null; render(); });
}

export function initAxisPage(): void { bind(); }

export {addFiles, files, render};
