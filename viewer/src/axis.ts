import ActivityWorker from './activity-worker?worker&inline';
import {fillCard, makeCard} from './axis/card';
import type {AxisOffline, AxisRange} from './axis/offline';
import {redraw3d} from './axis/view';
import {SIDE_CN} from './core/constants';
import {el} from './core/dom';
import {axisView, state} from './core/state';
import {baseName, blkOf} from './core/util';
import {winOf} from './timewin';
import {activityInput} from './parse';

const hasPhys = s => !!(s.imu?.phys || s.blk?.imu?.phys || s.lazy && s.files?.some(f =>
  f.cols.includes('accelerationG') && f.cols.includes('angularVelocityDps')));
const failure = (reason: string): AxisOffline => ({reason, candidates: []});

export function analyzeAxes(sides, rebuilt: boolean, win: AxisRange | undefined, update) {
  let closed = false, worker: Worker | null = null;
  const stop = () => { closed = true; worker?.terminate(); worker = null; };
  const left = sides.filter(s => s.side === 'left'), right = sides.filter(s => s.side === 'right');
  const useState = !rebuilt && sides.length === 2 && left.length === 1 && right.length === 1
    && sides.every(s => s.activityIn || s.lazy);
  const ordered = useState ? [left[0], right[0]] : sides;
  const source = useState ? '双侧状态检测' : '单设备周期筛查';
  const finish = (axes: AxisOffline[], validTicks?: number) => {
    if (closed) return;
    stop();
    ordered.forEach((s, i) => update(s, axes[i], axes[i]?.fallback ? '兜底周期筛查' : source, 100, validTicks));
  };
  void (async () => {
    try {
      const inputs = [];
      for (const s of ordered) {
        if (closed) return;
        let t, seq, ok, axes, support;
        if (s.activityIn || s.lazy) {
          const input = await activityInput(s, () => !closed, true);
          ({t, seq, ok, support} = input);
          axes = input.axes;
        } else {
          const b = blkOf(s);
          ({t} = b);
          axes = b.imu.phys.slice(0, 6);
        }
        // 段尾 afterEnd 帧的有效时间为空，尾部 NaN 会让总时长算成 NaN、整页判「时长无效」
        let keep = t.length;
        while (keep > 0 && !Number.isFinite(t[keep - 1])) keep--;
        inputs.push({t: t.slice(0, keep), ...(seq ? {seq: seq.slice(0, keep), ok: ok.slice(0, keep)} : {}),
          axes: axes.map(a => a.slice(0, keep)), support: support?.map(a => a.slice(0, keep))});
      }
      if (closed || !inputs.length) return;
      const duration = Math.max(...inputs.map(s => s.t.at(-1)));
      if (useState && (!(duration > 0) || duration > 86400)) throw new Error('记录时长无效或超过 24 小时。');
      worker = new ActivityWorker();
      worker.onerror = ev => finish(ordered.map(() => failure('分析失败：' + ev.message)));
      worker.onmessage = ({data}) => {
        if (closed) return;
        if (data.error) finish(ordered.map(() => failure('分析失败：' + data.error)));
        else if (data.axes) finish(data.axes, data.validTicks);
        else if (typeof data.progress === 'number') ordered.forEach(s => update(s, null, source, data.progress));
      };
      worker.postMessage({contract: useState ? {id: 'WT-gait-extraction-v1', kind: 'gait-extraction'} : null,
        inputs, duration, axis: {win}}, inputs.flatMap(s =>
        [s.t.buffer, ...(s.seq ? [s.seq.buffer, s.ok.buffer] : []), ...s.axes.map(a => a.buffer),
          ...(s.support?.map(a => a.buffer) ?? [])]));
    } catch (e) { finish(ordered.map(() => failure('分析失败：' + (e?.message || e)))); }
  })();
  return stop;
}

let cancel = () => {}, pending: ReturnType<typeof setTimeout> | undefined;
let scope: string | null = null;

function renderAxis() {
  if (!el.axis) return;
  clearTimeout(pending);
  cancel();
  scope = null;
  el.axis.replaceChildren();
  axisView.clear();
  const devices = state.sides.filter(hasPhys);
  const tab = el.tabs.querySelector('[data-tab="axis"]');
  tab.disabled = !devices.length;
  tab.title = devices.length ? '先检测步行段，再核验安装轴线' : '没有可用的物理量 IMU';
  for (const s of devices) {
    const entry = makeCard(s, {file: baseName(), title: SIDE_CN[s.side] || s.side});
    el.axis.appendChild(entry.sec);
    axisView.set(s.side, entry);
  }
  syncAxisUi();
  if (state.tab === 'axis') drawAxis();
}

function drawAxis(force = false) {
  if (state.tab !== 'axis' || !axisView.size) return;
  const win = state.axisRange === 'win' && state.win ? winOf() : undefined;
  const key = win ? `${win.a}:${win.b}` : 'all';
  syncAxisUi();
  if (scope === key && !force) { redraw3d(); return; }
  scope = key;
  clearTimeout(pending);
  cancel();
  const entries = [...axisView.values()];
  entries.forEach(e => fillCard(e, null));
  pending = setTimeout(() => {
    cancel = analyzeAxes(entries.map(e => e.s), state.rebuilt, win, (s, r, source, progress, validTicks) => {
      const e = axisView.get(s.side);
      if (e?.s === s) fillCard(e, r, source, progress, validTicks);
    });
  }, 120);
}

function syncAxisUi() {
  if (!el.axisTools) return;
  const ranged = state.win && state.axisRange === 'win';
  el.axisTools.querySelectorAll('button[data-range]').forEach(b => {
    b.classList.toggle('on', b.dataset.range === (ranged ? 'win' : 'all'));
    b.disabled = b.dataset.range === 'win' && !state.win;
  });
  el.axisNote.textContent = ranged ? '当前时间窗 · 步行检测后推断' : '整段录制 · 步行检测后推断';
}

export {drawAxis, hasPhys, renderAxis, syncAxisUi};
