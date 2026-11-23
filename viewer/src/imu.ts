/* IMU 页：physical / raw 两套数据、六轴分栏、全程总览条。 */

import {ACTIVITY_STILL, ACTIVITY_TURN, SEG_C, SEG_CN, SIDE_CN} from './core/constants';
import {$, el} from './core/dom';
import {imuView, state} from './core/state';
import {baseName, css, downloadCanvas, fmt, fmtT, niceMax} from './core/util';
import {idxAt} from './detail';
import {exportImuCsv} from './export';
import {ictoPaint} from './icto/view';
import {bindAxisPointer, showTipAt} from './interact';
import {dataOf, hzOf, stepOf} from './lod';
import {applyWin, fullDur, resetWin, visRange, winOf} from './timewin';

// ---------------------------------------------------------------- IMU
// 页面可切两套数据：physical = imu_physical_values（已换算成 g / °/s）；raw = imu_raw_values（硬件 LSB 计数）。
// raw 的通道序与物理轴不同——实测 X_phys = k·r2、Y_phys = −k·r1、Z_phys = k·r3（角速度同理，k = 0.07 °/s/LSB），
// 所以 raw 模式按原始通道序标 r1..r3 / r4..r6，不冒充 X/Y/Z。
const IMU_AX = ['X', 'Y', 'Z'];
const IMU_KINDS = [
  {k: 'acc', nm: '加速度', off: 0},
  {k: 'gyro', nm: '角速度', off: 3}
];
const IMU_SRC = {
  phys: {nm: '物理量', unit: {acc: 'g', gyro: '°/s'}, tag: '', fallback: {acc: 2, gyro: 50}, dec: 2},
  raw: {nm: '原始计数', unit: {acc: 'LSB', gyro: 'LSB'}, tag: 'raw ', fallback: {acc: 2000, gyro: 200}, dec: 0}
};
const AX_C = {X: '#2E86D6', Y: '#DE7024', Z: '#3A9E62'};
const TEMP_C = '#B5793A';
const PITCH_C = '#7A5CC4', TILT_C = '#2A8F83', HEAD_C = '#8A5A2B';
const TEMP_H = 62, ANG_H = 54, BAND_H = 128;

function activeKinds() { return IMU_KINDS.filter(kd => state.imuKinds.has(kd.k)); }
function activeAxes() { return IMU_AX.filter(a => state.imuAxes.has(a)); }

// 窄带（温度 / 俯仰角 / 侧倾角）：这些列不是 IMU 轴，各占一条独立量程的窄带。
// 列存在但整段都是 null 的包（维特的 pitchDeg）不该留一条空白带，所以按有限值个数决定画不画。
function bandRange(arr) {
  if (!arr) return null;
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) { n++; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  return n > 1 ? {lo, hi} : null;
}

// 角度带的范围只能按当前块算：懒加载的长包只有窗口块、全段抽样（LOD）根本没有角度列。
// 返回「这一侧真有数据的窄带」与「开关允许画的」，两者不同才是「有但被隐藏」。
function narrowBands(s) {
  const out = [];
  if (s.temp) {
    out.push({key: 'temp', title: '温度 (℃)', sub: (state.src && state.src.tempCol) || '逐帧温度',
      arr: s.temp, color: TEMP_C, lo: s.tLo, hi: s.tHi});
  }
  const ang = s.deviceAngles;
  if (ang) {
    if (ang.pitch) out.push({key: 'pitch', title: '俯仰角 pitchDeg (°)', sub: '设备俯仰，不是足部对地角',
      arr: ang.pitch, color: PITCH_C});
    if (ang.sideTilt) out.push({key: 'tilt', title: '侧倾角 sideTiltDeg (°)', sub: '设备侧倾，正负按导出定义',
      arr: ang.sideTilt, color: TILT_C});
    if (ang.heading) out.push({key: 'head', title: '相对航向 relativeHeadingDeg (°)', sub: '同一参考内展开，起点为跟踪建立时',
      arr: ang.heading, color: HEAD_C});
  }
  const all = [];
  for (const b of out) {
    if (Number.isFinite(b.lo) && Number.isFinite(b.hi) && b.hi >= b.lo) { all.push(b); continue; }
    const r = bandRange(b.arr);
    if (r) all.push({...b, lo: r.lo, hi: r.hi});
  }
  const shown = all.filter(b => b.key === 'temp' ? state.imuTemp : b.key === 'head' ? state.imuHead : state.imuAng);
  return {all, shown};
}
// 某侧实际可用的数据源：文件可能只有 raw 没有 physical，反之亦然
function srcOf(s) {
  const im = s.imu;
  if (state.imuSrc === 'raw') return im.raw ? 'raw' : 'phys';
  return im.phys ? 'phys' : 'raw';
}
function srcMeta() { return IMU_SRC[state.imuSrc]; }
// 取某栏某槽位的数组；raw 模式下按原始通道序（accel = r1..r3，gyro = r4..r6）
function imuArr(s, kd, ax) {
  const src = srcOf(s);
  const arr = s.imu[src];
  return arr ? arr[kd.off + IMU_AX.indexOf(ax)] : null;
}
// 槽位显示名：phys 用 X/Y/Z，raw 用 r1..r6（编号接在物理量之后，避免两栏都叫 r1）
function axLabel(kd, ax) {
  return state.imuSrc === 'raw' ? 'r' + (kd.off + IMU_AX.indexOf(ax) + 1) : ax;
}
function unitOf(kd) { return srcMeta().unit[kd.k]; }

// 纵轴上界：手填优先；否则按全段或当前时间窗取该栏所用轴的最大 |值|。
// 自动时宁可刻度宽一点也不裁峰，冲击尖峰本身就是有效信息。
// 全段用导入/后台扫描算好的每轴极值 —— 抽样的点里没有峰，拿它定纵轴会削掉真实的尖峰。
function imuScale(view, kd, axes) {
  const manual = state.imuY[state.imuSrc][kd.k];
  if (manual > 0) return {v: manual, auto: false};
  const useWin = state.imuFit;
  if (!useWin) {
    const mm = view.imuMax && view.imuMax[srcOf(view)];
    if (mm) {
      let mx = 0;
      for (const ax of axes) {
        const q = mm[kd.off + IMU_AX.indexOf(ax)] || 0;
        if (q > mx) mx = q;
      }
      return {v: niceMax(mx * 1.02 || srcMeta().fallback[kd.k]), auto: true, win: false};
    }
  }
  let m = 0;
  const w = useWin ? winOf() : null;
  const {i0, i1} = w ? visRange(view, w.a, w.b) : {i0: 0, i1: view.n - 1};
  for (const ax of axes) {
    const arr = imuArr(view, kd, ax);
    if (!arr) continue;
    for (let k = i0; k <= i1; k++) {
      const v = arr[k];
      if (!Number.isFinite(v)) continue;
      const a = Math.abs(v);
      if (a > m) m = a;
    }
  }
  return {v: niceMax(m * 1.02 || srcMeta().fallback[kd.k]), auto: true, win: useWin && !!state.win};
}

// 有正负的波形：缺值处断笔，不跨空洞连线；只画窗口内并裁到绘图区
function traceImu(g, s, arr, x0, y0, w, h, ymax, color, A, B, step = 1) {
  const span = (B - A) || 1, ymid = y0 + h / 2;
  const {i0, i1} = visRange(s, A, B);
  if (i1 < i0) return;
  g.save();
  g.beginPath(); g.rect(x0, y0, w, h); g.clip();
  g.strokeStyle = color; g.lineWidth = 1.3; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  let pen = false;
  for (let k = i0; k <= i1; k += step) {
    const v = arr[k];
    if (!Number.isFinite(v)) { pen = false; continue; }
    const x = x0 + (s.t[k] - A) / span * w;
    const y = ymid - Math.max(-1, Math.min(1, v / ymax)) * (h / 2);
    if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
  }
  g.stroke();
  g.restore();
}

// 点图：同样的裁剪与缺值处理，只是不落笔连线。点密到每像素列一个还挤不下时，
// 每列只留最小、最大两个点 —— 包络不丢，圆的数量也被屏宽卡住。
function dotsImu(g, s, arr, x0, y0, w, h, ymax, color, A, B, step = 1) {
  const span = (B - A) || 1, ymid = y0 + h / 2;
  const {i0, i1} = visRange(s, A, B);
  if (i1 < i0) return;
  g.save();
  g.beginPath(); g.rect(x0, y0, w, h); g.clip();
  g.fillStyle = color;
  const py = v => ymid - Math.max(-1, Math.min(1, v / ymax)) * (h / 2);
  const dot = (x, y) => { g.beginPath(); g.arc(x, y, 1.5, 0, Math.PI * 2); g.fill(); };
  if (i1 - i0 <= w * 1.5) {
    for (let k = i0; k <= i1; k += step) {
      const v = arr[k];
      if (Number.isFinite(v)) dot(x0 + (s.t[k] - A) / span * w, py(v));
    }
  } else {
    let col = NaN, lo = 0, hi = 0;
    const flush = () => {
      if (Number.isNaN(col)) return;
      const x = x0 + col;
      dot(x, py(lo));
      if (hi !== lo) dot(x, py(hi));
    };
    for (let k = i0; k <= i1; k += step) {
      const v = arr[k];
      if (!Number.isFinite(v)) continue;
      const c = Math.round((s.t[k] - A) / span * w);
      if (c !== col) { flush(); col = c; lo = hi = v; }
      else { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    flush();
  }
  g.restore();
}

// 相邻两帧时间差超过阈值的位置。空档本身没有采样点，曲线上只有一段长直连，
// 铺底色才看得出来。缓存必须挂在块对象上：视图是每次绘制新建的，挂在它上面等于没有缓存，
// 长录制每画一次都要扫几十万帧。
function gapSpans(s, thr) {
  // 视图是每次绘制新建的：缓存要挂在块或侧对象上，否则等于没有缓存
  const host = s.blk || Object.getPrototypeOf(s) || s;
  if (host._gap && host._gap.thr === thr) return host._gap;
  const list = [];
  let total = 0;
  for (let k = 1; k < s.n; k++) {
    const d = s.t[k] - s.t[k - 1];
    if (d * 1000 > thr) { list.push(k); total += d; }
  }
  return (host._gap = {thr, list, total});
}

function gapOn() { return state.imuGap; }

function paintGaps(g, s, x0, y0, w, h, A, B) {
  const gs = gapSpans(s, state.imuGapMs);
  if (!gs.list.length) return;
  const span = (B - A) || 1;
  const X = t => x0 + (t - A) / span * w;
  g.save();
  g.beginPath(); g.rect(x0, y0, w, h); g.clip();
  g.fillStyle = css('--loss-soft');
  for (const k of gs.list) {
    const a = s.t[k - 1], b = s.t[k];
    if (b < A || a > B) continue;
    const xa = X(Math.max(a, A)), xb = X(Math.min(b, B));
    g.fillRect(xa, y0, Math.max(1.5, xb - xa), h);
  }
  // 栏顶短杠：全段视图里一段 58 ms 的缺帧只有不到 1 px 宽，光靠底色找不到
  g.fillStyle = css('--loss');
  for (const k of gs.list) {
    const a = s.t[k - 1];
    if (a < A || a > B) continue;
    g.fillRect(X(a) - .75, y0, 3, 6);
  }
  g.restore();
}

// 状态分段底色：与「状态分段」页共用同一份整段结果（state.seg），这里只铺色不重算。
// 色调压到能看清六轴波形；「无法判断」段不上色，缺口靠丢帧标记区分。
function paintSegments(g, x0, y0, w, h, A, B) {
  const list = state.imuSeg ? state.seg?.list : null;
  if (!list || !list.length) return;
  const span = (B - A) || 1;
  g.save();
  g.beginPath(); g.rect(x0, y0, w, h); g.clip();
  for (const s of list) {
    if (s.cls === 3 || s.b <= A || s.a >= B) continue;
    const xa = x0 + (Math.max(s.a, A) - A) / span * w;
    const xb = x0 + (Math.min(s.b, B) - A) / span * w;
    g.fillStyle = SEG_C[s.cls]; g.globalAlpha = s.cls === 2 ? .09 : .14;
    g.fillRect(xa, y0, Math.max(1, xb - xa), h);
  }
  g.restore();
}

/** 状态底色的按钮与说明（结果来自分段页，模型也在那边选） */
export function syncImuSegUi(): void {
  if (!el.imuSegOn) return;
  const seg = state.seg, has = !!(seg && seg.list.length);
  const id = (seg?.modelId || '').replace(/^WT-offline-/, '');
  el.imuSegOn.classList.toggle('on', state.imuSeg);
  el.imuSegOn.disabled = !has;
  el.imuRun.disabled = !!seg?.busy;
  el.imuRun.textContent = seg?.busy ? '分析中…' : '分析整段';
  if (seg?.busy) el.imuSegNote.textContent = (id ? id + ' · ' : '') + '分析中…';
  else if (has) {
    const t = SEG_CN.map(() => 0);
    for (const s of seg.list) t[s.cls] += s.b - s.a;
    const modelStill = seg.list.some(s => s.cls === ACTIVITY_STILL && s.confidence != null);
    el.imuSegNote.innerHTML = `${id} · ` + SEG_CN
      .map((nm, i) => i < 3 || ((i === ACTIVITY_STILL || i >= ACTIVITY_TURN) && t[i] > 0) ? `<span style="color:${SEG_C[i]}">■</span>${i === ACTIVITY_STILL && modelStill ? '静止' : nm} ${t[i].toFixed(1)} s` : '')
      .filter(Boolean).join('　')
      + (state.imuSeg ? '' : ' · 底色已关');
  } else el.imuSegNote.textContent = '未分析';
  el.imuSegNote.title = seg?.status || '点「分析整段」把步行/跑步/其他铺到波形背后；结果与「状态分段」页共用一份';
  el.imuRun.title = `用「状态与步态」页当前所选模型（${id || '未分析'}）分析整段；结果显示在「状态与步态」页，并铺到这里的波形背后`;
}

// ---------------------------------------------------------------- IMU 总览条// 缩到某一段之后，光看「窗口 x–y s 占 n%」判断不出看的是哪一拍。总览条把全段包络压成一条，
// 窗口矩形画在上面：拖中间移段、拖两端改宽、点空白跳转，和波形页的框选是同一份 state.win。
const OV_N = 1200;                 // 包络分桶数，比任何屏宽都密，缩放时不必重算
const OV_LANE = 26, OV_GAP = 7, OV_PAD = 2, OV_TOP = 10, OV_BOT = 14;
// 包络按「数据源 + 轴 + 物理量」缓存：切一次开关就整条重算太慢，但换了文件必须作废
let ovCache: {key: string; lanes: any} | null = null;
/** 换文件 / 换轴 / 换物理量时作废缓存（从外面调，所以要以函数形式暴露） */
export function clearOvCache(): void { ovCache = null; ovBase = null; }
let ovDrag = null;

function ovKey() {
  return state.imuSrc + '|' + activeKinds().map(k => k.k).join(',') + '|' + activeAxes().join('');
}

// 每栏（物理量）每条轴按时间分桶取 min/max，多侧取并集：总览只回答「哪一段有动作」，
// 不承担读数，所以不区分左右。轴/物理量变了才重算。
function ovEnv() {
  const key = ovKey();
  if (ovCache && ovCache.key === key) return ovCache;
  const D = fullDur() || 1;
  const sides = state.sides.filter(s => s.imu);
  const lanes = [];
  for (const kd of activeKinds()) {
    const per = activeAxes().map(ax => {
      const lo = new Float64Array(OV_N).fill(Infinity);
      const hi = new Float64Array(OV_N).fill(-Infinity);
      for (const s of sides) {
        const b0 = dataOf(s, 0, D);
        const arr = imuArr(b0, kd, ax);
        if (!arr) continue;
        const st = Math.max(1, Math.floor(b0.n / (OV_N * 4)));   // 总览条只有 1200 桶，不必逐帧扫
        for (let k = 0; k < b0.n; k += st) {
          const v = arr[k];
          if (!Number.isFinite(v)) continue;
          const b = Math.min(OV_N - 1, Math.floor(b0.t[k] / D * OV_N));
          if (b < 0) continue;
          if (v < lo[b]) lo[b] = v;
          if (v > hi[b]) hi[b] = v;
        }
      }
      let m = 0;
      for (let b = 0; b < OV_N; b++) {
        if (!Number.isFinite(hi[b])) continue;   // lo/hi 同桶同存同缺
        if (hi[b] > m) m = hi[b];
        if (-lo[b] > m) m = -lo[b];
      }
      return {ax, lo, hi, m};
    });
    lanes.push({kd, per});
  }
  ovCache = {key, lanes};
  return ovCache;
}

// 静态层（宫格 + 包络 + 栏标）只在宽度/轴/主题变化时重画；拖窗口时每帧重画的只有矩形
let ovBase = null;

function ovPaintBase(W, H, dpr, lanes, x0, x1, plotW) {
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cGrid = css('--grid'), cLine = css('--line'), cFaint = css('--faint'),
        cMuted = css('--muted'), cCard = css('--card');
  g.textBaseline = 'middle';

  let y = OV_TOP;
  for (const lane of lanes) {
    const y0 = y, ymid = y0 + OV_LANE / 2;
    g.fillStyle = cGrid; g.globalAlpha = .28;
    g.fillRect(x0, y0, plotW, OV_LANE); g.globalAlpha = 1;
    g.strokeStyle = cFaint; g.globalAlpha = .5; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, ymid + .5); g.lineTo(x1, ymid + .5); g.stroke();
    g.globalAlpha = 1; g.strokeStyle = cLine;
    g.strokeRect(x0 + .5, y0 + .5, plotW - 1, OV_LANE - 1);

    for (const p of lane.per) {
      if (!(p.m > 0)) continue;
      const k = (OV_LANE / 2 - 2) / p.m;
      g.strokeStyle = AX_C[p.ax]; g.globalAlpha = .8; g.lineWidth = 1;
      g.beginPath();
      for (let px = 0; px < plotW; px++) {
        const b = Math.min(OV_N - 1, Math.floor(px / plotW * OV_N));
        if (!Number.isFinite(p.hi[b])) continue;
        const xx = x0 + px + .5;
        g.moveTo(xx, ymid - p.hi[b] * k);
        g.lineTo(xx, ymid - p.lo[b] * k);
      }
      g.stroke(); g.globalAlpha = 1;
    }

    // 栏标压一层底色，否则和包络糊在一起
    g.font = '10px system-ui,"Microsoft YaHei",sans-serif';
    g.textAlign = 'left';
    const lb = lane.kd.nm, lw = g.measureText(lb).width + 8;
    g.fillStyle = cCard; g.globalAlpha = .85;
    g.fillRect(x0 + 1, y0 + 1, lw, 13); g.globalAlpha = 1;
    g.fillStyle = cMuted;
    g.fillText(lb, x0 + 5, y0 + 8);

    y = y0 + OV_LANE + OV_GAP;
  }
  return cv;
}

function updateOverview() {
  if (!el.imuOv) return;
  const show = state.tab === 'imu' && state.sides.some(s => s.imu);
  el.imuOvBar.hidden = !show;
  if (!show) return;

  const cv = el.imuOv;
  const W = Math.round(cv.clientWidth);
  if (!(W > 40)) return;
  const env = ovEnv(), lanes = env.lanes;
  if (!lanes.length) return;
  const laneH = lanes.length * OV_LANE + Math.max(0, lanes.length - 1) * OV_GAP;
  const H = OV_TOP + laneH + OV_BOT;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  cv.style.height = H + 'px';
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }

  const D = fullDur() || 1;
  const x0 = OV_PAD, x1 = W - OV_PAD, plotW = x1 - x0;
  cv._geo = {W, H, x0, plotW, D};

  const cGrid = css('--grid'), cFaint = css('--faint'), cAcc = css('--accent');
  const baseKey = [env.key, W, H, dpr, cGrid, cFaint, cAcc].join('|');
  if (!ovBase || ovBase.key !== baseKey) {
    ovBase = {key: baseKey, cv: ovPaintBase(W, H, dpr, lanes, x0, x1, plotW)};
  }

  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(ovBase.cv, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 窗口矩形：全段时铺满，只是提示「还没缩放」
  const {a, b} = winOf();
  const wx0 = x0 + a / D * plotW, wx1 = Math.max(wx0 + 1.5, x0 + b / D * plotW);
  const rw = wx1 - wx0, rh = laneH;
  g.fillStyle = cAcc; g.globalAlpha = state.win ? .13 : .07;
  g.fillRect(wx0, OV_TOP, rw, rh); g.globalAlpha = 1;
  g.strokeStyle = cAcc; g.lineWidth = 1.4;
  g.strokeRect(wx0 + .5, OV_TOP + .5, Math.max(1, rw - 1), rh - 1);
  if (state.win) {
    g.fillStyle = cAcc;
    g.fillRect(wx0 - 1, OV_TOP, 2.5, rh);
    g.fillRect(wx1 - 1.5, OV_TOP, 2.5, rh);
  }

  g.font = '10px system-ui,sans-serif'; g.fillStyle = cFaint;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillText('0 s', x0 + 1, H - 3);
  g.textAlign = 'right';
  g.fillText(D.toFixed(D < 10 ? 2 : 1) + ' s', x1 - 1, H - 3);

  if (el.imuOvLbl) {
    el.imuOvLbl.textContent = (state.win
      ? `窗口 ${a.toFixed(2)} – ${b.toFixed(2)} s（${(100 * (b - a) / D).toFixed(1)}%）`
      : `全段 0 – ${D.toFixed(2)} s`)
      + (state.lazy ? ' · 包络仅含已载入段，空白不代表无动作' : '');
  }
}

function ovTimeAt(px) {
  const geo = el.imuOv._geo;
  const f = Math.max(0, Math.min(1, (px - geo.x0) / geo.plotW));
  return f * geo.D;
}

// 命中区：两端各 6 px 算改宽，窗内算移段，窗外算跳转
function ovHit(px, x0, x1) {
  if (!state.win) return 'select';
  if (Math.abs(px - x0) <= 6) return 'l';
  if (Math.abs(px - x1) <= 6) return 'r';
  return px > x0 && px < x1 ? 'move' : 'jump';
}

function bindOverview() {
  const cv = el.imuOv;
  const localX = ev => ev.clientX - cv.getBoundingClientRect().left;
  const edges = () => {
    const geo = cv._geo, {a, b} = winOf();
    return {geo, a, b,
            x0: geo.x0 + a / geo.D * geo.plotW,
            x1: geo.x0 + b / geo.D * geo.plotW};
  };

  cv.addEventListener('pointerdown', ev => {
    if (!cv._geo || ev.button !== 0) return;
    const {geo, a, b, x0, x1} = edges();
    const px = localX(ev);
    let mode = ovHit(px, x0, x1);
    if (mode === 'jump') {
      // 点空白处 = 把窗口中心挪过去、带宽不变，接着就能继续拖
      const t = ovTimeAt(px), half = (b - a) / 2;
      applyWin(t - half, t + half);
      mode = 'move';
    }
    const w = winOf();
    ovDrag = {mode, x: ev.clientX, start: ovTimeAt(px), a: w.a, b: w.b, D: geo.D, plotW: geo.plotW};
    try { cv.setPointerCapture(ev.pointerId); } catch (_) {}
    cv.style.cursor = mode === 'move' ? 'grabbing' : 'col-resize';
    ev.preventDefault();
  });

  cv.addEventListener('pointermove', ev => {
    if (!cv._geo) return;
    if (!ovDrag) {
      const {x0, x1} = edges();
      const m = ovHit(localX(ev), x0, x1);
      cv.style.cursor = m === 'move' ? 'grab' : m === 'jump' ? 'pointer' : 'col-resize';
      return;
    }
    const dt = (ev.clientX - ovDrag.x) / ovDrag.plotW * ovDrag.D;
    if (ovDrag.mode === 'select') {
      const t = ovTimeAt(localX(ev));
      if (Math.abs(ev.clientX - ovDrag.x) >= 4) applyWin(Math.min(ovDrag.start, t), Math.max(ovDrag.start, t));
    } else if (ovDrag.mode === 'move') applyWin(ovDrag.a + dt, ovDrag.b + dt);
    else if (ovDrag.mode === 'l') applyWin(Math.min(ovDrag.a + dt, ovDrag.b - 0.02), ovDrag.b);
    else applyWin(ovDrag.a, Math.max(ovDrag.b + dt, ovDrag.a + 0.02));
  });

  const end = () => { ovDrag = null; cv.style.cursor = 'ew-resize'; };
  cv.addEventListener('pointerup', ev => {
    if (ovDrag?.mode === 'select' && Math.abs(ev.clientX - ovDrag.x) < 4) {
      const span = Math.min(60, ovDrag.D), t = ovTimeAt(localX(ev));
      applyWin(t - span / 2, t + span / 2);
    }
    end();
  });
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('lostpointercapture', end);

  cv.addEventListener('wheel', ev => {
    if (!cv._geo) return;
    ev.preventDefault();
    const t = ovTimeAt(localX(ev));
    const k = Math.pow(1.0016, ev.deltaY * (ev.deltaMode === 1 ? 18 : 1));
    const w = winOf();
    applyWin(t - (t - w.a) * k, t + (w.b - t) * k);
  }, {passive: false});

  cv.addEventListener('dblclick', ev => { ev.preventDefault(); resetWin(); });
}

function drawImu(entry) {
  const {cv, off} = entry;
  const {a: A, b: B} = winOf();
  const span = (B - A) || 1;
  // 跨度大到装不下时画全段抽样；步长按屏宽与显示采样率算，跳着取真实帧
  const s = dataOf(entry.s, A, B);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = Math.max(360, cv.parentElement.clientWidth || 0);
  const padL = 62, padR = 18, padT = 26, padB = 34, bandGap = 14;
  const plotW = Math.max(60, W - padL - padR);
  const hz = hzOf(entry.s, s);
  const step = stepOf(span * hz, span, plotW, hz);
  const kinds = activeKinds(), axes = activeAxes();
  const bandH = BAND_H;
  // 窄带贴在六轴下面：温度、俯仰角、侧倾角各占一条，量程各按自己的 min–max
  // （温度都是正值，按 ±max 居中会压成一条直线；设备的俯仰角也带安装偏置，同理不居中）
  const nb = narrowBands(s), narrow = nb.shown;
  let H = padT + kinds.length * bandH + Math.max(0, kinds.length - 1) * bandGap + padB;
  for (const nb of narrow) H += bandGap + (nb.key === 'temp' ? TEMP_H : ANG_H);

  cv.style.height = H + 'px';
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  off.width = cv.width; off.height = cv.height;

  const cLine = css('--line'), cGrid = css('--grid'), cFaint = css('--faint'),
        cMuted = css('--muted'), cInk = css('--ink');
  const g = off.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.textBaseline = 'middle';
  g.font = '11px system-ui,"Microsoft YaHei",sans-serif';

  const bands = [];
  entry.geo = {W, H, dpr, padL, padT, plotW, bands, narrow: [],
               bandTop: padT, bandBot: padT, gridX0: padL, gridX1: padL + plotW, a: A, b: B};

  if (!kinds.length || !axes.length) {
    g.fillStyle = cMuted; g.textAlign = 'center';
    g.fillText('没有选中任何' + (kinds.length ? '轴' : '物理量'), W / 2, H / 2);
    imuBlit(entry, null);
    return;
  }

  kinds.forEach((kd, bi) => {
    const y0 = padT + bi * (bandH + bandGap);
    const sc = imuScale(s, kd, axes);
    const ymax = sc.v;
    bands.push({kd, y0, h: bandH, ymax, auto: sc.auto, win: sc.win});

    g.fillStyle = cGrid; g.globalAlpha = .3;
    g.fillRect(padL, y0, plotW, bandH);
    g.globalAlpha = 1;
    paintSegments(g, padL, y0, plotW, bandH, A, B);
    if (gapOn() && !s._lod) paintGaps(g, s, padL, y0, plotW, bandH, A, B);

    // 零线与 ±满刻
    const ymid = y0 + bandH / 2;
    g.strokeStyle = cLine; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL + .5, y0); g.lineTo(padL + .5, y0 + bandH); g.stroke();
    g.strokeStyle = cFaint; g.globalAlpha = .55;
    g.beginPath(); g.moveTo(padL, ymid + .5); g.lineTo(padL + plotW, ymid + .5); g.stroke();
    g.globalAlpha = 1;
    g.strokeRect(padL + .5, y0 + .5, plotW - 1, bandH - 1);

    g.fillStyle = cFaint; g.textAlign = 'right';
    for (const [v, yy] of [[ymax, y0 + 8], [0, ymid], [-ymax, y0 + bandH - 8]]) {
      g.beginPath(); g.moveTo(padL - 5, yy); g.lineTo(padL - 1, yy); g.stroke();
      g.fillText(Number.isInteger(v) ? String(v) : v.toFixed(2), padL - 8, yy);
    }

    // 栏标题 + 轴图例（图例的形状即该轴的画法，与波形一一对应）
    g.textAlign = 'left'; g.fillStyle = cInk;
    const ttl = kd.nm + ' ' + srcMeta().tag + '(' + unitOf(kd) + ')';
    g.fillText(ttl, padL + 2, y0 - 9);
    let lx = padL + 2 + g.measureText(ttl).width + 14;
    g.font = '10.5px system-ui,"Microsoft YaHei",sans-serif';
    const dots = state.imuDraw === 'dot';
    for (const ax of axes) {
      const arr = imuArr(s, kd, ax);
      g.fillStyle = AX_C[ax];
      if (dots) {
        for (let d = 0; d < 3; d++) { g.beginPath(); g.arc(lx + 1.5 + d * 4.5, y0 - 9, 1.6, 0, Math.PI * 2); g.fill(); }
      } else {
        g.strokeStyle = AX_C[ax]; g.lineWidth = 2;
        g.beginPath(); g.moveTo(lx, y0 - 9); g.lineTo(lx + 12, y0 - 9); g.stroke();
      }
      g.fillStyle = cMuted; g.textAlign = 'left';
      const lb = axLabel(kd, ax);
      g.fillText(lb, lx + 15, y0 - 9);
      lx += 15 + g.measureText(lb).width + 10;
      if (arr) (dots ? dotsImu : traceImu)(g, s, arr, padL, y0, plotW, bandH, ymax, AX_C[ax], A, B, step);
    }
    if (sc.win) {
      g.fillStyle = cFaint; g.textAlign = 'right';
      g.fillText('纵轴按窗口', padL + plotW - 2, y0 - 9);
    }
  });

  // 窄带：与六轴共用同一条时间轴与窗口，量程换成本列自己的 min–max
  let ny = padT + kinds.length * bandH + Math.max(0, kinds.length - 1) * bandGap;
  for (const nb of narrow) {
    const h = nb.key === 'temp' ? TEMP_H : ANG_H;
    const y0 = ny + bandGap;
    ny = y0 + h;
    const pad = Math.max(h > 60 ? 0.05 : 0.4, (nb.hi - nb.lo) * 0.15);
    const lo = nb.lo - pad, hi = nb.hi + pad;
    const yOf = v => y0 + 2 + (hi - v) / (hi - lo) * (h - 4);
    entry.geo.narrow.push({key: nb.key, y0, h, lo, hi, arr: nb.arr, color: nb.color,
      title: nb.title, sub: nb.sub});

    g.fillStyle = cGrid; g.globalAlpha = .3;
    g.fillRect(padL, y0, plotW, h); g.globalAlpha = 1;
    paintSegments(g, padL, y0, plotW, h, A, B);
    if (gapOn() && !s._lod) paintGaps(g, s, padL, y0, plotW, h, A, B);
    g.strokeStyle = cLine; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL + .5, y0); g.lineTo(padL + .5, y0 + h); g.stroke();
    g.strokeRect(padL + .5, y0 + .5, plotW - 1, h - 1);

    g.fillStyle = cFaint; g.textAlign = 'right';
    for (const [v, yy] of [[hi, y0 + 8], [(lo + hi) / 2, y0 + h / 2], [lo, y0 + h - 8]]) {
      g.beginPath(); g.moveTo(padL - 5, yy); g.lineTo(padL - 1, yy); g.stroke();
      g.fillText(v.toFixed(2), padL - 8, yy);
    }

    g.textAlign = 'left'; g.fillStyle = cInk;
    g.fillText(nb.title, padL + 2, y0 - 9);
    let lx = padL + 2 + g.measureText(nb.title).width + 12;
    g.strokeStyle = nb.color; g.lineWidth = 2;
    g.beginPath(); g.moveTo(lx, y0 - 9); g.lineTo(lx + 12, y0 - 9); g.stroke();
    lx += 17;
    g.font = '10.5px system-ui,"Microsoft YaHei",sans-serif';
    g.fillStyle = cMuted;
    g.fillText(nb.sub, lx, y0 - 9);
    g.font = '11px system-ui,"Microsoft YaHei",sans-serif';

    const {i0: n0, i1: n1} = visRange(s, A, B);
    if (n1 >= n0) {
      g.save();
      g.beginPath(); g.rect(padL, y0, plotW, h); g.clip();
      g.strokeStyle = nb.color; g.lineWidth = 1.5; g.lineJoin = 'round';
      g.beginPath();
      let pen = false;
      for (let k = n0; k <= n1; k += step) {
        const v = nb.arr[k];
        if (!Number.isFinite(v)) { pen = false; continue; }
        const x = padL + (s.t[k] - A) / span * plotW;
        if (pen) g.lineTo(x, yOf(v)); else { g.moveTo(x, yOf(v)); pen = true; }
      }
      g.stroke();
      g.restore();
    }
  }

  // IC/TO 候选画在底图上：PNG 导出取的是这张离屏图，画进叠加层就导不出来
  const bandBot = narrow.length
    ? entry.geo.narrow[entry.geo.narrow.length - 1].y0 + entry.geo.narrow[entry.geo.narrow.length - 1].h
    : padT + kinds.length * bandH + Math.max(0, kinds.length - 1) * bandGap;
  entry.geo.bandTop = padT;
  entry.geo.bandBot = bandBot;
  const focus = state.gaitFocus;
  if (!focus) ictoPaint(g, s, {x0: padL, x1: padL + plotW, top: padT, bot: bandBot, a: A, b: B});
  else if (focus.side === s.side) {
    g.save(); g.beginPath(); g.rect(padL, padT, plotW, bandBot - padT); g.clip();
    g.font = 'bold 11px system-ui,sans-serif'; g.textAlign = 'left';
    for (const [t, label, color, dy, uncertain] of [[focus.ic, focus.icUncertain ? 'IC 待确认' : 'IC', SEG_C[1], 13, focus.icUncertain],
      [focus.to, 'TO', SEG_C[0], 27, false], [focus.nextIc, focus.nextIcUncertain ? '下一 IC 待确认' : '下一 IC', SEG_C[1], 13, focus.nextIcUncertain],
      [focus.peak, '三轴合量峰', '#a45ce4', 41, false]] as const) {
      if (!(t >= A && t <= B)) continue;
      const x = padL + (t - A) / span * plotW;
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2; g.setLineDash(uncertain ? [4, 3] : []);
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, bandBot); g.stroke();
      g.fillText(label, Math.min(x + 4, padL + plotW - g.measureText(label).width), padT + dy);
    }
    g.restore();
  }

  // 横轴只在最后一栏下方画一次，刻度跟窗口走
  const yAx = bandBot + 10;
  g.strokeStyle = cLine; g.lineWidth = 1;
  g.beginPath(); g.moveTo(padL, yAx + .5); g.lineTo(padL + plotW, yAx + .5); g.stroke();
  g.fillStyle = cFaint; g.font = '10px system-ui,sans-serif'; g.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const x = padL + plotW * i / 4;
    g.beginPath(); g.moveTo(x + .5, yAx); g.lineTo(x + .5, yAx + 4); g.stroke();
    g.fillText(fmtT(A + span * i / 4, span), x, yAx + 15);
  }
  g.fillStyle = cMuted;
  g.fillText('时间', padL + plotW / 2, yAx + 29);

  if (entry.metaEl) {
    const src = srcOf(s);
    const note = src === 'raw' ? 'imu_raw_values（硬件 LSB 计数，通道序 r1..r6）' : 'imu_physical_values（加速度 g / 角速度 °/s；角速度优先用扣偏值）';
    const gs = gapOn() && !s._lod ? gapSpans(s, state.imuGapMs) : null;
    entry.metaEl.textContent = `录制 ${(s.span || s.dur).toFixed(1)} s`
      + (s.t[0] > 0.05 ? `（会话 ${s.t[0].toFixed(1)}–${s.dur.toFixed(1)} s）` : '')
      + ` · 均记录率 ${isFinite(s.fs) ? s.fs.toFixed(2) : '—'} Hz`
      + ` · ${fmt(entry.s.n)} 帧　|　数据源 ${note}`
      + (step > 1 ? `　|　按 ${(hz / step).toFixed(2)} Hz 抽样绘制（放大后自动加密）` : '')
      + (nb.all.some(b => b.key === 'temp') && state.imuTemp
          ? `　|　温度 ${s.tLo.toFixed(2)}–${s.tHi.toFixed(2)} ℃（${(state.src && state.src.tempCol) || '逐帧温度'}）`
          : '')
      + (() => {
        const ang = nb.all.filter(b => b.key === 'pitch' || b.key === 'tilt').map(b => b.key === 'pitch' ? '俯仰' : '侧倾');
        const hd = nb.all.some(b => b.key === 'head');
        const parts = [ang.length ? `设备角 ${ang.join('+')}${state.imuAng ? '' : '（已隐藏）'}` : '',
          hd ? `相对航向${state.imuHead ? '' : '（已隐藏）'}` : ''].filter(Boolean);
        return parts.length ? `　|　${parts.join('　')}` : '';
      })()
      + (s.imu.nPart ? `　|　${s.imu.nPart} 帧单位未确认（加速度为空）` : '')
      + (gs ? (gs.list.length
          ? `　|　间隔 > ${state.imuGapMs} ms 的区段 ${fmt(gs.list.length)} 处，共 ${gs.total.toFixed(3)} s`
          : `　|　没有间隔 > ${state.imuGapMs} ms 的区段`)
        : '')
      + (gs && state.mode === 'imu' ? '（维特 TXT：标的是写盘节奏抖动，不是真实丢帧）' : '');
  }
  imuBlit(entry, null);
}

// 视频游标：视频播放时在每一栏上跑一条竖线，位置取视频当前时刻对应的会话时间。
// 窗口比视频短时它会跑出画面，这时贴边画个三角指向那一侧，而不是让游标凭空消失。
function paintCursor(ctx, geo) {
  const t = state.videoT;
  if (t == null || !(geo.bandBot > geo.bandTop)) return;
  const cWarn = css('--warn');
  const span = (geo.b - geo.a) || 1;
  const inside = t >= geo.a && t <= geo.b;
  const x = inside ? geo.padL + (t - geo.a) / span * geo.plotW
    : (t < geo.a ? geo.padL + 1 : geo.padL + geo.plotW - 1);
  ctx.save();
  ctx.strokeStyle = cWarn; ctx.lineWidth = 2; ctx.globalAlpha = inside ? .85 : .45;
  ctx.beginPath(); ctx.moveTo(x + .5, geo.bandTop); ctx.lineTo(x + .5, geo.bandBot); ctx.stroke();
  if (!inside) {
    const d = t < geo.a ? 1 : -1, y0 = geo.bandTop + 5;
    ctx.fillStyle = cWarn; ctx.globalAlpha = .9;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x + 7 * d, y0 + 5); ctx.lineTo(x, y0 + 10); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

/** 视频时刻变了：只重贴叠加层，不重算底图 */
function paintVideoCursor(): void {
  if (state.tab !== 'imu') return;
  for (const e of imuView.values()) {
    if (!e.geo) continue;
    imuBlit(e, e.hover || null);
  }
}

function imuBlit(entry, hover) {
  const {cv, off, geo} = entry;
  const ctx = cv.getContext('2d');
  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.W, geo.H);
  ctx.drawImage(off, 0, 0, geo.W, geo.H);
  const cAcc = css('--accent');

  // 视频游标先画：它在最底下，框选/hover 的竖线要压在上面
  paintCursor(ctx, geo);

  if (entry.sel) {
    const bs = geo.bands;
    const top = geo.padT - 4;
    const bot = geo.bandBot || (bs.length ? bs[bs.length - 1].y0 + bs[bs.length - 1].h : geo.H - 34);
    const x0 = Math.min(entry.sel.x0, entry.sel.x1), x1 = Math.max(entry.sel.x0, entry.sel.x1);
    ctx.save();
    ctx.fillStyle = cAcc; ctx.globalAlpha = .12;
    ctx.fillRect(x0, top, x1 - x0, bot - top);
    ctx.globalAlpha = .7; ctx.strokeStyle = cAcc; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + .5, top + .5, Math.max(0, x1 - x0 - 1), bot - top);
    ctx.restore();
  }
  if (!hover) return;

  ctx.save();
  ctx.strokeStyle = cAcc; ctx.globalAlpha = .8; ctx.lineWidth = 1;
  for (const b of geo.bands) {
    ctx.beginPath(); ctx.moveTo(hover.x + .5, b.y0); ctx.lineTo(hover.x + .5, b.y0 + b.h); ctx.stroke();
  }
  for (const nb of geo.narrow) {
    ctx.beginPath(); ctx.moveTo(hover.x + .5, nb.y0); ctx.lineTo(hover.x + .5, nb.y0 + nb.h); ctx.stroke();
  }
  for (const p of hover.pts) {
    ctx.beginPath(); ctx.arc(hover.x, p.y, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = p.c; ctx.fill();
  }
  ctx.restore();
}

function onImuHover(entry, ev) {
  const s = entry.s, geo = entry.geo;
  if (!geo || !geo.bands.length) return;
  // ⚠ 长录制里 s.n/s.t 是全段、s.blk 只有窗口块：游标、读数、时间显示必须都取自同一块（或同一份抽样）
  const bs = dataOf(s, geo.a, geo.b);
  if (!bs.imu) return;
  const rect = entry.cv.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  if (x < geo.padL || x > geo.padL + geo.plotW) { entry.hover = null; imuBlit(entry, null); el.tip.style.display = 'none'; return; }
  const frac = (x - geo.padL) / geo.plotW;
  const idx = idxAt(geo.a + frac * (geo.b - geo.a), bs);
  const axes = activeAxes();
  const pts = [];
  const rows = [];
  for (const b of geo.bands) {
    const ymid = b.y0 + b.h / 2;
    for (const ax of axes) {
      const arr = imuArr(bs, b.kd, ax);
      if (!arr) continue;
      const v = arr[idx];
      if (!Number.isFinite(v)) continue;
      pts.push({y: ymid - Math.max(-1, Math.min(1, v / b.ymax)) * (b.h / 2), c: AX_C[ax]});
      rows.push(['　' + b.kd.nm + ' ' + axLabel(b.kd, ax), v.toFixed(srcMeta().dec) + ' ' + unitOf(b.kd), AX_C[ax]]);
    }
  }
  for (const nb of geo.narrow) {
    const v = nb.arr[idx];
    if (!Number.isFinite(v)) continue;
    const fr = (nb.hi - v) / (nb.hi - nb.lo);
    pts.push({y: nb.y0 + 2 + Math.max(0, Math.min(1, fr)) * (nb.h - 4), c: nb.color});
    rows.push(['　' + nb.title.replace(/ \(.*$/, ''), v.toFixed(2) + ' ' + (nb.title.match(/\((.+)\)/) || [])[1],
      nb.color]);
  }
  entry.hover = {x: geo.padL + frac * geo.plotW, pts};
  imuBlit(entry, entry.hover);
  const tt = bs.t[idx];
  el.tip.innerHTML = `<b>t = ${Number.isFinite(tt) ? tt.toFixed(2) : '—'} s</b><br>`
    + rows.map(r => `<span style="color:${r[2]}">■</span>${r[0]} ${r[1]}`).join('<br>');
  showTipAt(ev.clientX, ev.clientY);
}

// 数据源切换后把控件整体换到那一套：按钮文案、纵轴单位、手填值、摘要
function syncImuSrcUi() {
  const im = state.sides.filter(s => s.imu);
  const nPhys = im.filter(s => s.imu.phys).length;
  const nRaw = im.filter(s => s.imu.raw).length;
  if (!nPhys && nRaw) state.imuSrc = 'raw';
  else if (nPhys && !nRaw) state.imuSrc = 'phys';
  const raw = state.imuSrc === 'raw';

  el.viewImu.querySelectorAll('button[data-src]').forEach(b => {
    const k = b.dataset.src;
    const has = k === 'raw' ? nRaw : nPhys;
    b.classList.toggle('on', k === state.imuSrc);
    b.disabled = !has;
    b.title = has
      ? (k === 'raw' ? 'imu_raw_values：硬件整数计数，未换算，通道序 r1..r6'
                     : 'imu_physical_values：采集端已换算，加速度 g、角速度 °/s；角速度有扣偏结果时用扣偏值')
      : state.mode === 'imu'
        ? '维特 TXT 只有上位机换算后的物理量，没有原始计数'
        : `本文件没有 imu_${k === 'raw' ? 'raw_values' : 'physical_values'} 列`;
  });

  // raw 模式按原始通道序编号：轴的三个槽位指加速度 r1–r3，角速度栏对应 r4–r6
  el.viewImu.querySelectorAll('button[data-ax]').forEach(b => {
    const j = IMU_AX.indexOf(b.dataset.ax);
    b.textContent = raw ? 'r' + (j + 1) : b.dataset.ax;
    b.title = raw ? `原始计数第 ${j + 1} 通道（角速度栏同一槽位是 r${j + 4}）` : `物理 ${b.dataset.ax} 轴`;
  });
  el.imuKindLbl.textContent = raw ? '原始通道' : '物理量';
  el.viewImu.querySelectorAll('button[data-kind]').forEach(b => {
    const acc = b.dataset.kind === 'acc';
    b.textContent = (acc ? '加速度 ' : '角速度 ') + (raw ? 'LSB' : IMU_SRC.phys.unit[b.dataset.kind]);
  });
  el.imuUa.textContent = raw ? 'LSB' : IMU_SRC.phys.unit.acc;
  el.imuUg.textContent = raw ? 'LSB' : IMU_SRC.phys.unit.gyro;

  const cur = state.imuY[state.imuSrc];
  el.imuYa.value = cur.acc == null ? '' : cur.acc;
  el.imuYg.value = cur.gyro == null ? '' : cur.gyro;
  const manual = cur.acc != null || cur.gyro != null;
  el.imuYauto.classList.toggle('on', !manual && !state.imuFit);
  el.imuYfit.classList.toggle('on', !manual && state.imuFit);

  el.imuGap.title = state.mode === 'imu'
    ? '维特 TXT 的时间轴是按写盘批次重建的，这里的间隔是重建产物：默认 100 ms（填 40 会把写盘抖动标满屏），标出来的是写盘节奏的抖动，不是真实丢帧 —— 真实缺口看「丢包 / 采样率」页'
    : '相邻两帧时间差超过阈值的区段铺淡红底，栏顶再加一道红杠 —— 缩到全段时区段只有 1 px 宽，靠那道杠才找得到';
  el.imuGap.classList.toggle('on', state.imuGap);

  if (!im.length) { el.imuNote.textContent = '本文件没有 IMU 列'; return; }
  const missing = state.sides.filter(s => !s.imu).map(s => SIDE_CN[s.side] || s.side);
  const noSrc = im.filter(s => !s.imu[state.imuSrc]).map(s => SIDE_CN[s.side] || s.side);
  el.imuNote.textContent = (missing.length ? missing.join('、') + ' 无 IMU　·　' : '')
    + (noSrc.length ? noSrc.join('、') + ` 无 ${raw ? 'raw' : 'physical'} 列　·　` : '')
    + (raw ? '原始计数 · 通道序 r1..r6'
           : state.mode === 'imu' ? '维特 TXT · 上位机已换算'
           : '物理量 · 角速度优先用扣偏值');
  el.imuNote.title = (raw ? 'imu_raw_values：硬件 LSB 计数，未换算。' : 'imu_physical_values：加速度 g、角速度 °/s。')
    + (state.lazy ? '纵轴「全段」档使用已载入段的最大 |值|。' : '纵轴默认按全段最大 |值| 定。')
    + '缩放后可用「按窗口」，所有通道 0 居中。';
}

function renderImu() {
  el.imu.innerHTML = '';
  imuView.clear();
  clearOvCache();
  if (!state.sides.length) { updateOverview(); return; }

  const withImu = state.sides.filter(s => s.imu);
  // 没有 IMU 列的文件：页签直接禁用，不让人点进一个空页
  const tabImu = el.tabs.querySelector('[data-tab="imu"]');
  tabImu.disabled = !withImu.length;
  tabImu.title = withImu.length ? '与压力同帧的六轴数据（物理量 / 原始计数可切）' : '本文件没有 imu_physical_values / imu_raw_values 列';
  if (!withImu.length) {
    el.imuNote.textContent = '本文件没有 IMU 列';
    const p = document.createElement('p');
    p.className = 'sub';
    p.style.padding = '14px 2px';
    p.textContent = '这份 parquet 不含 imu_physical_values / imu_raw_values 列，所以没有 IMU 可画；压力三页不受影响。';
    el.imu.appendChild(p);
    updateOverview();
    return;
  }
  syncImuSrcUi();

  for (const s of withImu) {
    const sec = document.createElement('section');
    sec.className = 'side';
    const head = document.createElement('div');
    head.className = 'sechead';
    const h = document.createElement('h2');
    h.textContent = (SIDE_CN[s.side] || s.side) + ' IMU 六轴';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const bPng = document.createElement('button');
    bPng.className = 'mini'; bPng.textContent = 'PNG'; bPng.title = '导出当前视图（含时间窗、纵轴刻度）为图片';
    const bCsv = document.createElement('button');
    bCsv.className = 'mini'; bCsv.textContent = 'CSV'; bCsv.title = '导出当前时间窗内六轴物理量';
    head.append(h, grow, bPng, bCsv);

    const p = document.createElement('p');
    p.className = 'meta';
    const wrap = document.createElement('div');
    wrap.className = 'canvas-wrap';
    const cv = document.createElement('canvas');
    cv.style.touchAction = 'none';
    wrap.appendChild(cv);
    sec.appendChild(head); sec.appendChild(p); sec.appendChild(wrap);
    el.imu.appendChild(sec);

    const entry = {s, cv, metaEl: p, off: document.createElement('canvas'),
                   geo: null, hover: null, repaint: e => imuBlit(e, e.hover)};
    imuView.set(s.side, entry);
    bindAxisPointer(cv, entry, onImuHover);
    bPng.addEventListener('click', () => downloadCanvas(entry.off, `${baseName()}_${s.side}_imu.png`));
    bCsv.addEventListener('click', () => exportImuCsv(entry));
  }
  syncImuSegUi();
  updateOverview();
}

function redrawImu() {
  for (const e of imuView.values()) drawImu(e);
  updateOverview();
  el.tip.style.display = 'none';
}

export {bindOverview, drawImu, paintVideoCursor, redrawImu, renderImu, srcOf, syncImuSrcUi, updateOverview};
