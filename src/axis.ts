/* 轴向推断入口：把 math（纯计算）/ align（对齐与分段）/ view（三维投影）/ card（详情卡）串起来。
   两个用法 —— 主查看器的「轴向推断」页（一份主数据 + 可选参考数据），
   以及独立页的一键模式（多份文件自动分工 → 一张汇总表）。 */

import {accSeries, alignRef, assignRoles, segmentsOf} from './axis/align';
import {fillCard, fillSeg, makeCard} from './axis/card';
import {SENS} from './axis/math';
import {SIDE_CN} from './core/constants';
import {el} from './core/dom';
import {axisView, state} from './core/state';
import {baseName} from './core/util';
import {sideWin} from './timewin';

// ---------------------------------------------------------------- 分段计划
// files: [{name, sides, mode}]；refIdx 指向提供时间锚点与动作边界的那一份。
// 返回的 segs 落在**参考数据**的时间基上，每份文件的 dts[i] 满足 main = ref + dts[i]；
// 对不上的那份 dts[i] 为 null，errs[i] 说明原因。
function planAll(files, refIdx) {
  if (refIdx == null || refIdx < 0 || !files[refIdx]) return {segs: null, dts: [], errs: []};
  const refSer = accSeries(files[refIdx].sides);
  if (!refSer) return {segs: null, dts: [], errs: [], err: '参考数据里没有可用的 IMU 列'};

  const dts = [], errs = [], mains = [{sides: files[refIdx].sides, dt: 0}];
  for (let i = 0; i < files.length; i++) {
    if (i === refIdx) { dts[i] = 0; continue; }
    const ser = accSeries(files[i].sides);
    if (!ser) { dts[i] = null; errs[i] = '没有可用的 IMU 列'; continue; }
    const al = alignRef(ser, refSer);
    if (al.err) { dts[i] = null; errs[i] = al.err; continue; }
    dts[i] = al.dt;
    mains.push({sides: files[i].sides, dt: al.dt});
  }
  const segs = segmentsOf(refSer, mains);
  if (!segs.length) return {segs: [], dts, errs, err: '参考数据里切不出动作段'};
  return {segs, dts, errs};
}

// 把参考时间基上的段平移到某一份文件自己的时间基
const shift = (segs, dt) => (segs || []).map(g => ({a: g.a + dt, b: g.b + dt, kind: g.kind}));

// ---------------------------------------------------------------- 主查看器的轴向页
let planCache = null;
function buildPlan() {
  if (!state.ref) { planCache = null; return null; }
  const key = state.ref.name + '|' + state.name;
  if (planCache && planCache.key === key) return planCache;
  const res = planAll([{name: state.name, sides: state.sides}, state.ref], 1);
  const dt = res.dts ? res.dts[0] : null;
  planCache = {
    key,
    dt: dt == null ? null : dt,
    err: res.err || (dt == null ? '主数据与参考数据找不到共同的落地冲击，无法对齐时间戳' : null),
    segs: dt == null ? [] : shift(res.segs, dt)
  };
  return planCache;
}

function sens() { return SENS[state.axisSens] || SENS.auto; }

function renderAxis() {
  if (!el.axis) return;     // 独立轴向页自己渲染卡片
  el.axis.innerHTML = '';
  axisView.clear();
  const withPhys = state.sides.filter(s => s.imu && s.imu.phys);
  const tab = el.tabs.querySelector('[data-tab="axis"]');
  tab.disabled = !withPhys.length;
  tab.title = withPhys.length
    ? '只用 IMU 自身数据反推三轴语义与正方向（静止定垂直 / 陀螺主成分定内外侧 / 三项判据定前向）'
    : '本文件没有 imu_physical_values 列';
  if (!withPhys.length) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.style.padding = '14px 2px';
    p.textContent = state.sides.some(s => s.imu)
      ? '本文件只有 imu_raw_values：raw 的通道序与物理轴相差一次置换与变号，不是解剖轴，做不了轴向推断。'
      : '这份 parquet 不含 IMU 列，没有可推断的数据。';
    el.axis.appendChild(p);
    syncAxisUi();
    return;
  }

  for (const s of withPhys) {
    const entry = makeCard(s, {file: baseName(), title: (SIDE_CN[s.side] || s.side) + ' · 轴向推断'});
    el.axis.appendChild(entry.sec);
    axisView.set(s.side, entry);
  }
  // 参考数据变化会直接重建本页（不经过 renderAll），重建后得自己把内容填上
  if (state.tab === 'axis') drawAxis(); else syncAxisUi();
}

function drawAxis() {
  if (state.tab !== 'axis' || !axisView.size) return;
  const sg = sens(), plan = buildPlan();
  for (const e of axisView.values()) {
    const g = e.segPick >= 0 && plan && !plan.err ? plan.segs[e.segPick] : null;
    let win = g ? {a: g.a, b: g.b} : null;
    if (!win && state.axisRange === 'win' && sideWin) win = sideWin(e.s);
    fillCard(e, win, sg);
    fillSeg(e, plan, sg);
  }
  syncAxisUi();
}

function syncAxisUi() {
  if (!el.axisTools) return;
  const rng = state.win ? state.axisRange : 'all';   // 没有窗口时「当前时间窗」等价于全段
  el.axisTools.querySelectorAll('button[data-range]').forEach(b => {
    b.classList.toggle('on', b.dataset.range === rng);
    b.disabled = b.dataset.range === 'win' && !state.win;
    b.title = b.dataset.range === 'win'
      ? (state.win ? '只推断当前时间窗内的数据' : '先在波形图 / IMU 页框选一段时间')
      : '推断整段数据';
  });
  el.axisTools.querySelectorAll('button[data-sens]').forEach(b => {
    b.classList.toggle('on', b.dataset.sens === state.axisSens);
  });
  if (el.axisRefName) {
    const ref = state.ref;
    el.axisRefName.hidden = !ref;
    if (ref) {
      const plan = buildPlan();
      const dt = plan && plan.dt != null ? ` · 偏移 ${plan.dt >= 0 ? '+' : ''}${plan.dt.toFixed(2)} s` : '';
      el.axisRefName.textContent = ref.name + dt + ' ✕';
      el.axisRefName.title = (plan && plan.anchor
        ? `锚点：主 ${plan.anchor.pm.t.toFixed(2)} s / ${plan.anchor.pm.a.toFixed(1)} g ↔ 参考 ${plan.anchor.pr.t.toFixed(2)} s / ${plan.anchor.pr.a.toFixed(1)} g（主 = 参考 + 偏移）。`
        : '') + '点一下清除参考数据';
      el.axisRefName.onclick = () => { state.ref = null; planCache = null; renderAxis(); };
    }
  }
  if (el.axisNote) {
    const n = state.sides.filter(s => s.imu && s.imu.phys).length;
    // 懒加载的长录制只载入了一个窗口块：说清这里是「整段」还是「已载入的一段」
    const scope = state.lazy ? '已载入窗口' : (rng === 'win' ? '当前时间窗' : '全段');
    el.axisNote.textContent = scope
      + ` · 静止判据 ${({auto: '自动', loose: '宽松', strict: '严格'})[state.axisSens] || '自动'}`
      + ` · ${n} 侧`;
  }
}

// ---------------------------------------------------------------- 一键模式：多份文件自动分工
// files: [{name, sides, mode}]。参考数据只提供时间锚点与动作边界，轴向结论各自算各自的。
// opt: {refIdx 强制指定参考 / sens}
// 返回 perFile[i] = {name, dt, ref, devices:[{s, plan}]}，plan 已平移到该文件自己的时间基。
function axRun(files, opt) {
  const o = opt || {};
  const roles = assignRoles(files);
  const refIdx = o.refIdx != null ? o.refIdx : roles.ref;
  const plan = planAll(files, refIdx);
  const perFile = files.map((f, fi) => {
    const dt = plan.dts ? plan.dts[fi] : null;
    let cardPlan = null;
    if (refIdx >= 0) {
      cardPlan = dt == null
        ? {segs: [], err: (plan.errs && plan.errs[fi]) || plan.err || '这份文件对不上参考数据的时间'}
        : {segs: shift(plan.segs, dt)};
    }
    return {
      name: f.name, mode: f.mode, dt, ref: fi === refIdx,
      devices: f.sides.filter(x => x.imu && x.imu.phys).map(s => ({s, plan: cardPlan}))
    };
  });
  return {refIdx, plan, roles, perFile, sens: SENS[o.sens] || SENS.auto};
}

export {axRun, buildPlan, drawAxis, planAll, renderAxis, syncAxisUi};
