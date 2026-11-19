/* 单台设备的详情卡：结论、轴表、判据明细、分段表。只负责渲染，不算东西也不读全局状态。 */

import {AXES, R2D, SENS, angStr, clamp1, infer, pct, sgn, vec3} from './math';
import {bindOrbit, paint3d} from './view';
import {SIDE_CN} from '../core/constants';
import {blkOf, downloadCanvas} from '../core/util';

// ---------------------------------------------------------------- DOM
function badge(level, txt) {
  const b = document.createElement('span');
  b.className = 'badge ' + level;
  b.textContent = txt + ' ' + ({hi: '高', mid: '中', lo: '低'}[level] || '—');
  return b;
}

function td(txt: string, cls?: string) {
  const c = document.createElement('td');
  if (cls) c.className = cls;
  c.textContent = txt;
  return c;
}

// win: {a,b} 或 null（全段）；sens: 静止判据；pre: 已经算好的结果，省一次重复推断
function fillCard(e: any, win: any, sens: any, pre?: any) {
  const s = e.s;
  const res = pre || infer(s, {sens: sens || SENS.auto, win: win || null});
  e.res = res;
  e.sum.innerHTML = '';
  e.tbl.innerHTML = '';
  e.ev.innerHTML = '';
  e.warn.innerHTML = '';

  if (res.err) {
    e.meta.textContent = '无法推断';
    const p = document.createElement('p');
    p.className = 'sub';
    p.style.padding = '6px 0';
    p.textContent = res.err;
    e.sum.appendChild(p);
    e.cv3.hidden = true;
    return;
  }
  if (res.partial) {
    // 垂直轴已经定出来了，只是内外侧轴 / 前向定不了：只报已经确定的那部分
    e.cv3.hidden = true;
    const i = res.up.map(Math.abs).indexOf(Math.max(...res.up.map(Math.abs)));
    const tilt = Math.acos(clamp1(Math.abs(res.up[i]))) * R2D;
    const big = document.createElement('span');
    big.className = 'big';
    big.textContent = `竖直方向最接近 +${AXES[i]}_s（偏 ${tilt.toFixed(0)}°）；内外侧轴与前向符号未定`;
    e.sum.append(big, badge(res.confA, '垂直'));
    e.meta.textContent = `${res.t0.toFixed(2)} – ${res.t1.toFixed(2)} s · ${res.fs.toFixed(1)} Hz`
      + `　|　静止 ${res.nSeg} 段 / ${res.stillDur.toFixed(1)} s（主簇 ${res.nMain} 段，簇内离散 ${res.upDev.toFixed(1)}°），|a| ${res.accMean.toFixed(3)} g`
      + `　|　陀螺零偏 ${vec3(res.bias)} °/s（范数 ${res.biasNorm.toFixed(1)}，取自 ${res.biasN} 帧零速样本 / ${res.biasDur.toFixed(2)} s）`;
    const d = document.createElement('div');
    d.className = 'axwarn';
    d.textContent = res.reason;
    e.warn.appendChild(d);
    return;
  }
  e.cv3.hidden = false;

  const sum = res.rows.map(r => `+${r.nm} → ${r.desc} ${r.gap.toFixed(0)}°`).join('　')
    + (res.sign === null ? '　（前向符号未定）' : '');
  const big = document.createElement('span');
  big.className = 'big';
  big.textContent = sum;
  e.sum.append(big, badge(res.confA, '垂直'), badge(res.confB, '内外侧'), badge(res.confC, '前向'));

  e.meta.textContent = `${res.t0.toFixed(2)} – ${res.t1.toFixed(2)} s · ${res.fs.toFixed(1)} Hz`
    + `　|　静止 ${res.nSeg} 段 / ${res.stillDur.toFixed(1)} s（主簇 ${res.nMain} 段，簇内离散 ${res.upDev.toFixed(1)}°），|a| ${res.accMean.toFixed(3)} g`
    + `　|　陀螺零偏 ${vec3(res.bias)} °/s（范数 ${res.biasNorm.toFixed(1)}，取自 ${res.biasN} 帧零速样本 / ${res.biasDur.toFixed(2)} s）`;

  // 轴表
  const head = document.createElement('tr');
  for (const h of ['传感器轴', '主指向', '与主轴夹角', '前', '左', '上', '仰角', '方位角']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  e.tbl.appendChild(head);
  for (const r of res.rows) {
    const tr = document.createElement('tr');
    tr.appendChild(td('+' + r.nm, 'ax'));
    tr.appendChild(td(r.desc, ''));
    tr.appendChild(td(angStr(r.gap), ''));
    tr.appendChild(td(sgn(r.v[0]), 'num'));
    tr.appendChild(td(sgn(r.v[1]), 'num'));
    tr.appendChild(td(sgn(r.v[2]), 'num'));
    tr.appendChild(td(angStr(r.elev), 'num'));
    tr.appendChild(td(angStr(r.azim), 'num'));
    e.tbl.appendChild(tr);
  }

  // 判据明细
  const evHead = document.createElement('tr');
  for (const h of ['判据', '观测', '判定']) {
    const th = document.createElement('th');
    th.textContent = h;
    evHead.appendChild(th);
  }
  e.ev.appendChild(evHead);
  const evRow = (a, b, c) => {
    const tr = document.createElement('tr');
    tr.appendChild(td(a));
    tr.appendChild(td(b));
    tr.appendChild(td(c));
    e.ev.appendChild(tr);
  };
  evRow('① 静止段 → 垂直轴',
    `${res.nSeg} 段 / ${res.stillDur.toFixed(1)} s，|a| ${res.accMean.toFixed(3)} g，主簇 ${res.nMain} 段，簇内离散 ${res.upDev.toFixed(1)}°，全段离散 ${res.allDev.toFixed(1)}°`,
    `+z_s 对齐重力 ${vec3(res.up)}`);
  evRow('② 角速度主成分 → 内外侧轴',
    `第一主成分占方差 ${pct(res.pca.ratio)}，${res.pcaWin} 窗离散 ${res.pcaSpread.toFixed(1)}°，${res.pca.n} 帧`,
    `内外侧轴 ${vec3(res.l)}`);
  for (const k of ['j1', 'j2']) {
    const j = res[k];
    const nm = k === 'j1' ? '③ 步幅位移（相邻支撑中点）' : '④ 摆动位移（支撑末→支撑初）';
    if (!j.valid) evRow(nm, j.why, '不参与投票');
    else evRow(nm, `${j.n} 段，位移中位 ${j.med.toFixed(2)} m，方向圆标准差 ${j.std.toFixed(0)}°`,
      `${j.pos ? '同向' : '反向'}，偏 ${j.dev.toFixed(0)}°`);
  }
  const j3 = res.j3;
  if (!j3.valid) evRow('⑤ 脚背外法线几何', j3.why, '不参与投票');
  else evRow('⑤ 脚背外法线几何', `z_s 水平投影 ${j3.zh.toFixed(2)}（与重力夹角 ${(Math.acos(clamp1(res.upS[2])) * R2D).toFixed(0)}°）`,
    `${j3.pos ? '同向' : '反向'}，偏 ${j3.dev.toFixed(0)}°`);
  evRow('合计', `${res.judges.length} 项可用（${res.npos} 指前 / ${res.nneg} 指后）`
    + (res.sign === null ? '' : `，方向离散 ${res.spreadJ.toFixed(0)}°`),
    res.sign === null ? '前向符号不可判定' : `前向符号${res.sign > 0 ? '取 +' : '取 −'}（${res.confC === 'hi' ? '确定' : res.confC === 'mid' ? '较可信' : '仅一项支撑'}）`);

  for (const w of res.warns) {
    const d = document.createElement('div');
    d.className = 'axwarn';
    d.textContent = w;
    e.warn.appendChild(d);
  }

  paint3d(e.cv3, res);
}

// 分段表：全段一行 + 每段一行，点行把该段结果换成上面的详情。
// plan: {segs:[{a,b,kind}], err} —— 时间已平移到本设备自己的时间基；null 表示没有分段
function fillSeg(e, plan, sens) {
  const tbl = e.seg;
  if (!tbl) return;
  tbl.innerHTML = '';
  if (!plan) { tbl.hidden = true; e.segPick = -1; return; }
  tbl.hidden = false;

  const cols = ['段', '时间 (s)', '类型', '三轴结论', '垂直', '内外侧', '前向', '主成分'];
  const head = document.createElement('tr');
  for (const h of cols) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); }
  tbl.appendChild(head);

  const one = (i, a, b, kind) => {
    const win = i < 0 ? null : {a, b};
    const res = infer(e.s, {sens: sens || SENS.auto, win});
    const tr = document.createElement('tr');
    if (i === (e.segPick == null ? -1 : e.segPick)) tr.className = 'on';
    tr.appendChild(td(i < 0 ? (e.s.lazy ? '窗口' : '全段') : String(i + 1), 'ax'));
    tr.appendChild(td(`${a.toFixed(1)}–${b.toFixed(1)}`, 'num'));
    tr.appendChild(td(kind || '—'));
    if (res.err) {
      const short = /静止样本/.test(res.err) ? '静止不足'
        : /帧数太少/.test(res.err) ? '帧数太少' : '无法推断';
      tr.appendChild(td(short, 'dim'));
      for (let j = 0; j < 4; j++) tr.appendChild(td('—', 'dim'));
    } else if (res.partial) {
      const tilt = res.l ? (Math.acos(clamp1(Math.abs(res.l[2]))) * R2D).toFixed(0) + '°' : null;
      tr.appendChild(td(tilt ? `定不出（倾角 ${tilt}）` : '定不出', 'dim'));
      tr.appendChild(td({hi: '高', mid: '中', lo: '低'}[res.confA] || '—'));
      for (let j = 0; j < 2; j++) tr.appendChild(td('—', 'dim'));
      tr.appendChild(td(tilt || '—'));
    } else {
      tr.appendChild(td(res.rows.map(r => `${r.nm}→${r.desc}`).join(' '), ''));
      tr.appendChild(td({hi: '高', mid: '中', lo: '低'}[res.confA] || '—'));
      tr.appendChild(td({hi: '高', mid: '中', lo: '低'}[res.confB] || '—'));
      tr.appendChild(td({hi: '高', mid: '中', lo: '低'}[res.confC] || '—'));
      const tilt = (Math.acos(clamp1(Math.abs(res.l[2]))) * R2D).toFixed(0);
      tr.appendChild(td(`${tilt}° / ${(res.pca.ratio * 100).toFixed(0)}%`));
    }
    tr.addEventListener('click', () => {
      e.segPick = i;
      fillCard(e, win, sens);
      fillSeg(e, plan, sens);
      if (e.onPick) e.onPick(i);
    });
    tbl.appendChild(tr);
  };

  // 「全段」那一行：懒加载时能用的只有已载入的窗口块，照着写实际范围，别把块当成整段
  const ds = blkOf(e.s);
  one(-1, ds.t[0], ds.t[ds.n - 1], e.s.lazy ? '已载入段' : '—');

  if (plan.err) {
    const tr = document.createElement('tr');
    const c = document.createElement('td');
    c.colSpan = cols.length; c.className = 'dim';
    c.textContent = '参考数据：' + plan.err;
    tr.appendChild(c); tbl.appendChild(tr);
    return;
  }
  plan.segs.forEach((g, i) => one(i, g.a, g.b, g.kind));
}

// 一台设备一张卡：标题 + 结论 + 三维图 + 轴表 + 判据 + 段表
function makeCard(s: any, opt?: any): any {
  const o = opt || {};
  const sec = document.createElement('section');
  sec.className = 'side';
  const head = document.createElement('div');
  head.className = 'sechead';
  const h = document.createElement('h2');
  h.textContent = o.title || (SIDE_CN[s.side] || s.side);
  const grow = document.createElement('span');
  grow.className = 'grow';
  const bPng = document.createElement('button');
  bPng.className = 'mini'; bPng.textContent = 'PNG'; bPng.title = '导出三维轴投影为图片';
  head.append(h, grow, bPng);

  const meta = document.createElement('p');
  meta.className = 'meta';
  const sum = document.createElement('div');
  sum.className = 'axsum';
  const card = document.createElement('div');
  card.className = 'axcard';
  const cv3 = document.createElement('canvas');
  cv3.title = '拖动旋转视角 · 滚轮缩放 · 双击复位（各设备共用视角）';
  card.appendChild(cv3);
  bindOrbit(cv3);
  const tbl = document.createElement('table');
  tbl.className = 'axtbl';
  const ev = document.createElement('table');
  ev.className = 'axev';
  const seg = document.createElement('table');
  seg.className = 'axseg';
  seg.hidden = true;   // 没有分段时不占位
  const warn = document.createElement('div');

  sec.append(head, meta, sum, card, tbl, ev, seg, warn);
  const entry = {s, sec, cv3, meta, sum, tbl, ev, seg, warn, res: null, segPick: -1, onPick: null};
  bPng.addEventListener('click', () => {
    if (!entry.res || entry.res.err || entry.res.partial || !cv3.width) return;
    downloadCanvas(cv3, `${o.file || 'data'}_${s.side}_axis.png`);
  });
  return entry;
}

export {badge, fillCard, fillSeg, makeCard, td};
