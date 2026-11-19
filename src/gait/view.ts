import {ACTIVITY_STILL, SEG_CN, SIDE_CN} from '../core/constants';
import type {ActivitySegment, GaitSegment} from './core';
import {metricMean, reportSummary} from './walking';
import type {FootMetric, GaitReportSegment, GaitStep, ReportSummary} from './walking';

const $ = (id: string) => document.getElementById(id);
const details = (id: string) => $(id) as HTMLDetailsElement;
export const gaitFormat = (v: number, digits = 3) => Number.isFinite(v) ? v.toFixed(digits) : '—';
const PAGE_SIZE = 25;
interface Focus {side: string; ic: number; to: number; nextIc?: number; peak?: number; at: number; icUncertain?: boolean; nextIcUncertain?: boolean; note?: string}
let detail: GaitSegment, report: GaitReportSegment, current: ActivitySegment, page = 0, stepPage = 0, locate: (focus: Focus) => void;

const labels: Record<NonNullable<GaitStep['icIssue'] | GaitStep['toIssue'] | GaitStep['impactIssue']>, string> = {
  no_anchor: '缺附近重力参考', pose_path: '姿态路径不连续或陀螺疑似削顶', pose_conflict: '前后姿态估计不一致', no_axis: '足尖方向未确认',
  no_to: '无可信离地事件', to_outside: '离地超出本段', window_short: '冲击窗被边界或离地截断', window_gap: '冲击窗断流或样本不足',
  rail: '加速度疑似削顶', no_positive_peak: '无正向峰'
};
const measured = (value: number, digits: number, issue?: keyof typeof labels) => Number.isFinite(value) ? gaitFormat(value, digits) :
  issue ? text('span', `— ${labels[issue]}`, 'gait-missing') : '—';
function text(tag: string, value: string, cls = '') {
  const el = document.createElement(tag); el.textContent = value; el.className = cls; return el;
}
export const gaitBadge = (cls: number, value: string) => text('span', value, `gait-state ${cls === 0 ? 'walk' : cls === 1 ? 'run' : ''}`);
const percent = (m: ReportSummary) => m.durationMs ? 100 * m.countableMs / m.durationMs : NaN;
function coverageCell(m: ReportSummary, numeric = true) {
  const pct = percent(m);
  const el = text('div', Number.isFinite(pct) ? `${numeric ? `${gaitFormat(m.countableMs / 1000, 2)} · ` : ''}${pct.toFixed(0)}%` : '—', 'gait-coverage-cell');
  if (Number.isFinite(pct)) {
    const bar = document.createElement('progress'); bar.max = 100; bar.value = pct; bar.setAttribute('aria-label', '有效计步覆盖'); el.append(bar);
  }
  return el;
}
export function renderGaitOverview(summaries: ReportSummary[], note: string) {
  const body = $('gaitOverviewRows'); body.replaceChildren();
  summaries.forEach((m, cls) => row(body, [gaitBadge(cls, SEG_CN[cls]), m.durationMs ? gaitFormat(m.durationMs / 1000, 2) : '—', coverageCell(m),
    gaitFormat(m.steps, 0), gaitFormat(m.cadence, 1), ['left', 'right'].map((side: 'left' | 'right') => gaitFormat(metricMean(m, side, 'contact'), 1)).join(' / ')], true));
  $('gaitOverviewHint').textContent = ['步数仅统计有效覆盖内的候选事件；「—」表示无可报告值。', note].filter(Boolean).join(' ');
}

function row(body: HTMLElement, values: (string | HTMLElement)[], head = false) {
  const tr = document.createElement('tr');
  values.forEach((value, i) => {
    const cell = document.createElement(head && i === 0 ? 'th' : 'td');
    if (head && i === 0) cell.scope = 'row';
    cell.append(value); tr.append(cell);
  });
  body.append(tr);
}
function button(text: string, title: string, action: () => void) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
  b.setAttribute('aria-label', title); b.onclick = action;
  return b;
}
function pagination(prefix: string, index: number, n: number, label: string) {
  const pages = Math.max(1, Math.ceil(n / PAGE_SIZE)), i = Math.min(index, pages - 1);
  $(prefix + 'Page').textContent = `${n} ${label} · 第 ${i + 1} / ${pages} 页`;
  ($(prefix + 'Prev') as HTMLButtonElement).disabled = i === 0;
  ($(prefix + 'Next') as HTMLButtonElement).disabled = i + 1 >= pages;
  return i;
}
function renderPeriods() {
  if (!details('gaitPeriods').open || !detail?.cells.length) return;
  const side = ($('gaitSide') as HTMLSelectElement).value;
  const periods = detail.cells.find(c => c.side === side)?.periods || [];
  page = pagination('gait', page, periods.length, '个候选周期');
  const body = $('gaitPeriodRows'); body.replaceChildren();
  for (const c of periods.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const link = button('看波形', `查看${SIDE_CN[side]} ${gaitFormat(c.a)} 秒处的周期波形`, () => locate({side, ic: c.a,
      to: c.to, nextIc: c.b, at: c.a, icUncertain: c.icUncertain, nextIcUncertain: c.nextIcUncertain, note: c.eventNote}));
    row(body, [gaitFormat(c.a) + (c.icUncertain ? '（待确认）' : ''), gaitFormat(c.to),
      gaitFormat(c.b) + (c.nextIcUncertain ? '（待确认）' : ''), c.eventNote || '—', link]);
  }
}
function renderSteps() {
  if (!details('gaitSteps').open) return;
  const side = ($('gaitStepSide') as HTMLSelectElement).value;
  const list = (report?.steps || []).filter(s => side === 'both' || s.side === side);
  stepPage = pagination('gaitStep', stepPage, list.length, '步');
  const body = $('gaitStepRows'); body.replaceChildren();
  const hasDevice = report?.steps.some(s => s.deviceAngles?.ic || s.deviceAngles?.to) ?? false;
  details('gaitSteps').querySelector<HTMLElement>('[data-gait-device]').hidden = !hasDevice;
  const useDevice = hasDevice && ($('gaitStepAngleSource') as HTMLSelectElement).value === 'device';
  $('gaitStepAngleGroup').textContent = useDevice ? 'App 导出设备角 · 俯仰 / 侧倾' : '足部俯仰估计';
  $('gaitStepIcAngle').textContent = useDevice ? '触地设备角（°）' : '触地俯仰（°）';
  $('gaitStepToAngle').textContent = useDevice ? '离地设备角（°）' : '离地俯仰（°）';
  $('gaitStepAngleNote').textContent = useDevice ? '取同脚事件帧的设备体轴角，按「俯仰 / 侧倾」显示；不插值、不替代足部俯仰。'
    : '足部俯仰以低运动参考姿态为零、足尖抬起为正。缺少可靠参考时不填值。';
  const formatDevice = (a: {pitch: number; sideTilt: number} | null | undefined) =>
    a ? `${gaitFormat(a.pitch, 1)} / ${gaitFormat(a.sideTilt, 1)}` : '—';
  for (const s of list.slice(stepPage * PAGE_SIZE, (stepPage + 1) * PAGE_SIZE)) {
    const evt = (name: string, ms: number | null) => ms === null ? '—' : button(String(ms),
      `定位第 ${s.step_index} 步${SIDE_CN[s.side]}${name} ${ms} 毫秒`, () => locate({side: s.side, ic: s.ic_ms / 1000,
        to: s.to_ms === null ? NaN : s.to_ms / 1000, peak: s.impact_peak_ms === null ? undefined : s.impact_peak_ms / 1000,
        at: ms / 1000, note: `${SEG_CN[report.cls]}第 ${s.step_index} 步 · ${name} ${ms} ms${s.to_ms === null ? ' · 无可用 TO' : ''}`}));
    row(body, [String(s.step_index), text('span', SIDE_CN[s.side], `gait-foot ${s.side}`), evt('触地 IC', s.ic_ms), evt('离地 TO', s.to_ms),
      s.to_ms === null ? '—' : String(s.to_ms - s.ic_ms),
      useDevice ? formatDevice(s.deviceAngles?.ic) : measured(s.ic_pitch_deg, 1, s.icIssue),
      useDevice ? formatDevice(s.deviceAngles?.to) : measured(s.to_pitch_deg, 1, s.toIssue),
      measured(s.impact_peak_g, 2, s.impactIssue), evt('垂向加速度峰值', s.impact_peak_ms)]);
  }
}
export function initGaitDetail(onLocate: typeof locate) {
  locate = onLocate;
  details('gaitPeriods').ontoggle = renderPeriods;
  details('gaitSteps').ontoggle = renderSteps;
  $('gaitSide').onchange = () => { page = 0; renderPeriods(); };
  $('gaitPrev').onclick = () => { page = Math.max(0, page - 1); renderPeriods(); };
  $('gaitNext').onclick = () => { page++; renderPeriods(); };
  $('gaitStepPrev').onclick = () => { stepPage = Math.max(0, stepPage - 1); renderSteps(); };
  $('gaitStepNext').onclick = () => { stepPage++; renderSteps(); };
  $('gaitStepSide').onchange = () => { stepPage = 0; renderSteps(); };
  $('gaitStepAngleSource').onchange = renderSteps;
  $('gaitRules').textContent = '步行和跑步共用统计口径，按状态分别汇总。有效计步区间取双脚有内部 IC 候选支持的观察窗口交集，按状态段裁切，不跨断流，不含首尾补点。每个有效 IC 计一步；平均步频＝60 × 双脚步数 ÷ 有效计步秒数。接地＝同脚、同一步 TO − IC；缺可信 TO 仍可计步，但不算接地时长和离地角。左右差＝右均值 − 左均值。有 App 导出角时，逐步表默认显示同脚事件帧的设备角；不与足部俯仰混合统计。足部俯仰以轴向推断的低运动参考为零，足尖抬起为正，不是踝关节角。垂向加速度峰值取 IC 后 100 ms 内原采样点沿重力反方向的加速度，减去 1 g 后取最大正值。它不是鞋底法向加速度，也不是地面反作用力。窗口不完整、疑似削顶或姿态不可靠时留空，不额外滤波或插值找峰。峰时为录制时刻，平均峰值延迟为峰时减 IC。IC/TO 为 IMU 估计，毫秒是单位，不代表精度。';
}

export function renderGaitDetail(g: GaitSegment, w: GaitReportSegment, s: ActivitySegment, index: number, experimental = false) {
  const panel = $('gaitDetail'), periods = details('gaitPeriods'), steps = details('gaitSteps'), coverage = details('gaitCoverage');
  panel.hidden = !s;
  if (current !== s) {
    current = s; page = stepPage = 0; periods.open = steps.open = coverage.open = false;
    ($('gaitStepSide') as HTMLSelectElement).value = 'both';
    $('gaitPeriodRows').replaceChildren(); $('gaitStepRows').replaceChildren();
  }
  if (detail !== g) {
    detail = g;
    const select = $('gaitSide') as HTMLSelectElement, side = select.value;
    select.replaceChildren(...(g?.cells || []).map(c => new Option(SIDE_CN[c.side], c.side)));
    if (g?.cells.some(c => c.side === side)) select.value = side;
  }
  if (report !== w) stepPage = 0;
  report = w;
  if (!s) { ($('gaitStepAngleSource') as HTMLSelectElement).value = 'device'; return; }
  const modelStill = s.cls === ACTIVITY_STILL && s.confidence != null, gait = s.cls === 0 || s.cls === 1;
  $('gaitTitle').textContent = `第 ${index + 1} 段 · ${modelStill ? '静止' : SEG_CN[s.cls]} · ${gaitFormat(s.a, 2)}–${gaitFormat(s.b, 2)} s`;
  $('gaitMetrics').hidden = $('gaitSamples').hidden = !gait;
  periods.hidden = s.cls !== 1 || !g?.cells.some(c => c.periods.length);
  steps.hidden = !w?.steps.length;
  coverage.hidden = !w?.countable_intervals.length;
  const note = s.cls === ACTIVITY_STILL ? (modelStill ? '模型判为静止。该段不计算步态指标。' : '双脚 IMU 局部低运动，支持静止。该段不计算步态指标。')
    : s.cls === 3 ? '该段未判定，不计算步态指标。'
    : !gait ? '该段不计算步态指标。「其他」不等同于静止。'
    : `${s.cls === 1 && experimental ? '跑步实验版' : '原版'} IC/TO · ${w?.countable_intervals.length ? '汇总中的足部俯仰和垂向加速度峰值由脚背 IMU 估计，逐步表可查看角度来源和缺测原因。' : '本段无双脚可计步覆盖，不将缺失指标当作 0。'}`;
  $('gaitNote').textContent = note;
  const kpis = $('gaitCompare'), body = $('gaitMetricRows'); kpis.replaceChildren(); body.replaceChildren();
  if (!gait) return;
  const m = reportSummary([w ?? {index, cls: s.cls, durationMs: Math.round(s.b * 1000) - Math.round(s.a * 1000), countable_intervals: [], steps: []}]);
  const kpi = (label: string, value: string, extra?: HTMLElement) => {
    const el = text('div', '', 'gait-kpi'); el.append(text('small', label), text('strong', value)); if (extra) el.append(extra); kpis.append(el);
  };
  kpi('有效步数', gaitFormat(m.steps, 0)); kpi('平均步频（步/分）', gaitFormat(m.cadence, 1));
  kpi('有效计步 / 识别（s）', `${gaitFormat(m.countableMs / 1000, 2)} / ${gaitFormat(m.durationMs / 1000, 2)}`, coverageCell(m, false));
  const stats: [FootMetric, string, number][] = [
    ['contact', '接地均值（ms）', 1], ['ic', '足部触地俯仰均值（°）', 1], ['to', '足部离地俯仰均值（°）', 1],
    ['impact', '平均垂向加速度峰值（g）', 2], ['delay', '平均峰值延迟（ms）', 1]
  ];
  for (const [key, label, digits] of stats) {
    const foot = (side: 'left' | 'right') => {
      const f = m.feet[side], el = text('div', gaitFormat(metricMean(m, side, key), digits), 'gait-value');
      if (f.steps) el.append(text('span', `${f[key].n} / ${f.steps} 步`, 'gait-sample'));
      return el;
    };
    row(body, [label, foot('left'), foot('right'), gaitFormat(metricMean(m, 'right', key) - metricMean(m, 'left', key), digits)], true);
  }
  $('gaitCountable').textContent = '可计步区间（ms）：' + (w?.countable_intervals || []).map(r => `[${r.start_ms}, ${r.end_ms})`).join('、');
  renderSteps(); if (!periods.hidden) renderPeriods();
}
