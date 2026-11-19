/* 动作速度页：把手腕/脚背的单次动作竖直速度估计接到页签上。
   分析范围跟共用时间窗走，所以和波形、IMU 页看到的是同一段；换设备或换窗口就重算。 */

import {analyzeAction, FS, type ActionResult} from './action-core';
import {state} from './core/state';
import {sideWin} from './timewin';

const $ = (id: string): any => document.getElementById(id);

let res: ActionResult | null = null;
let resKey = '';
let sideId = '';
let error = '';
let timer = 0;

const hasImu = (s: any) => !!(s.imu && s.imu.phys);

/** 静止设备的陀螺只有噪声，默认应该落在动作最大的那台上 */
function motionScore(s: any): number {
  const mx = s.imuMax && s.imuMax.phys;
  if (mx) return Math.max(mx[3], mx[4], mx[5]);
  const g = s.imu.phys[3], n = Math.min(400, s.n);
  let m = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(g[i]); if (v > m) m = v; }
  return m;
}

function candidates(): any[] { return state.sides.filter(hasImu); }

function pickDefault(): string {
  const c = candidates();
  if (!c.length) return '';
  let best = c[0], score = -1;
  for (const s of c) { const v = motionScore(s); if (v > score) { score = v; best = s; } }
  return best.side;
}

function currentSide(): any {
  const c = candidates();
  return c.find(s => s.side === sideId) || c[0] || null;
}

function run(force = false): void {
  const s = currentSide();
  if (!s) { res = null; error = '这份文件没有物理量六轴，估不了速度。'; resKey = ''; return; }
  const w = sideWin(s);
  const key = `${s.side}|${w.a.toFixed(3)}|${w.b.toFixed(3)}`;
  if (!force && key === resKey) return;
  resKey = key;
  try {
    res = analyzeAction(s, {from: w.a, to: w.b});
    error = '';
  } catch (e: any) {
    res = null;
    error = e?.message || String(e);
  }
}

/** 时间窗变了要重算：分析范围就是窗口，不重算等于拿旧窗口的结论 */
export function refreshAction(): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (state.tab !== 'action') return;
    run();
    renderAction();
  }, 140);
}

export function initAction(): void {
  if (!$('viewAction')) return;
  const sel = $('actionSide');
  if (sel) sel.onchange = () => {
    sideId = sel.value;
    run(true);
    renderAction();
  };
  const rb = $('actionRun');
  if (rb) rb.onclick = () => { run(true); renderAction(); };
  const cb = $('actionCsv');
  if (cb) cb.onclick = () => saveCsv();
}

function fmt3(v: number, d = 3): string { return Number.isFinite(v) ? v.toFixed(d) : '—'; }

function saveCsv(): void {
  if (!res) return;
  const head = ['rep,start_s,down_s,up_s,depth_m,depth_down_m,depth_up_m,v_down_peak_mps,v_up_peak_mps,v_up_mean_mps,turn_ms,a_bottom_mps2,mismatch_ratio'];
  const rows = res.reps.map(r => [r.index, r.t0.toFixed(3), r.down.toFixed(3), r.up.toFixed(3), r.depth.toFixed(4),
    r.depthDown.toFixed(4), r.depthUp.toFixed(4), r.vDown.toFixed(3), r.vUp.toFixed(3), r.vUpMean.toFixed(3),
    (r.turn * 1000).toFixed(0), r.aBottom.toFixed(3), r.mismatch.toFixed(3)].join(','));
  const s = currentSide();
  const name = (state.name || 'record').replace(/\.[^.]+$/, '');
  const url = URL.createObjectURL(new Blob(['\uFEFF' + [head[0], ...rows].join('\r\n')], {type: 'text/csv;charset=utf-8'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}_动作速度_${(s?.dev || s?.side || 'IMU').replace(/[^\w.-]+/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderAction(): void {
  const box = $('viewAction');
  if (!box) return;
  const c = candidates();
  const sel = $('actionSide');
  if (sel) {
    const want = c.map(s => s.side).join('|');
    if (sel.dataset.sig !== want) {
      sel.replaceChildren();
      for (const s of c) {
        const o = document.createElement('option');
        o.value = s.side;
        o.textContent = s.dev || s.side;
        sel.append(o);
      }
      sel.dataset.sig = want;
    }
    if (!sideId || !c.some(s => s.side === sideId)) sideId = pickDefault();
    sel.value = sideId;
    sel.disabled = !c.length;
  }
  if (!resKey) run();

  const s = currentSide();
  const st = $('actionStatus');
  if (st) {
    if (error) st.textContent = error;
    else if (!res) st.textContent = '装载数据后自动分析当前时间窗。';
    else {
      const bits = [`重采样 ${FS} Hz`, `静止段 ${res.staticSegs} 段`,
        `陀螺零偏 ${res.biasG.map(v => v.toFixed(2)).join(' / ')} °/s`];
      st.textContent = `${s?.dev || s?.side || ''}　·　${bits.join('　·　')}`
        + (res.notes.length ? '　·　' + res.notes.join('；') : '');
    }
  }

  const sum = $('actionSummary');
  if (sum) {
    if (!res || !res.reps.length) sum.textContent = '按「转向点竖直速度为零」分段：下蹲 → 蹲到最低 → 起身算一次动作。';
    else {
      const r = res.reps, mean = (f: (x: any) => number) => r.reduce((a, x) => a + f(x), 0) / r.length;
      const sd = (f: (x: any) => number) => Math.sqrt(mean(x => (f(x) - mean(f)) ** 2));
      sum.textContent = `${r.length} 次动作　·　深度 ${mean(x => x.depth).toFixed(2)}±${sd(x => x.depth).toFixed(2)} m`
        + `　·　下蹲峰速 ${mean(x => x.vDown).toFixed(2)} m/s　·　起身均速 ${mean(x => x.vUpMean).toFixed(2)} m/s`
        + `　·　底部加速度 ${mean(x => x.aBottom).toFixed(2)}±${sd(x => x.aBottom).toFixed(2)} m/s²`;
    }
  }

  const cb = $('actionCsv');
  if (cb) cb.disabled = !res || !res.reps.length;

  const body = $('actionRows');
  if (body) {
    body.replaceChildren();
    for (const r of res?.reps || []) {
      const tr = document.createElement('tr');
      const cells = [String(r.index), r.t0.toFixed(2), r.down.toFixed(2), r.up.toFixed(2), fmt3(r.depth),
        r.vDown.toFixed(2), r.vUp.toFixed(2), r.vUpMean.toFixed(2), (r.turn * 1000).toFixed(0),
        r.aBottom.toFixed(2), (r.mismatch * 100).toFixed(0) + '%'];
      for (const t of cells) { const td = document.createElement('td'); td.textContent = t; tr.append(td); }
      // 下蹲与起身两个独立估计差得太多，说明这段漂了，别按精确深度用
      if (r.mismatch > 0.35) tr.title = '下蹲与起身估出的深度差超过 35%，这一段竖直速度不可靠';
      if (r.mismatch > 0.35) tr.style.opacity = '0.62';
      body.append(tr);
    }
  }
  drawAction();
}

export function drawAction(): void {
  const cv = $('actionChart') as HTMLCanvasElement | null;
  if (!cv || state.tab !== 'action') return;
  const width = Math.max(320, cv.clientWidth), height = 240, dpr = devicePixelRatio || 1;
  cv.width = width * dpr;
  cv.height = height * dpr;
  cv.style.height = height + 'px';
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--card').trim() || '#fff';
  const ink = css.getPropertyValue('--muted').trim() || '#536075';
  const line = css.getPropertyValue('--line').trim() || '#dce3ed';
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.font = '12px sans-serif';
  if (!res || !res.curve.t.length) {
    ctx.fillStyle = ink;
    ctx.fillText(error || '没有可画的曲线', 16, 40);
    return;
  }
  const padL = 54, padR = 16, padT = 18, padB = 28;
  const pw = Math.max(10, width - padL - padR), ph = Math.max(10, height - padT - padB);
  const a = res.from, b = res.to;
  const x = (t: number) => padL + (t - a) / Math.max(1e-9, b - a) * pw;
  let vmax = 0.4;
  for (const v of res.curve.v) if (Math.abs(v) > vmax) vmax = Math.abs(v);
  vmax = Math.ceil(vmax * 1.2 * 10) / 10;
  const y = (v: number) => padT + (vmax - v) / (2 * vmax) * ph;

  // 每次动作铺一条底，颜色区分下蹲/起身两半
  for (const r of res.reps) {
    const x0 = x(r.t0), xm = x(r.t0 + r.down), x1 = x(r.t0 + r.down + r.up);
    ctx.fillStyle = 'rgba(120,140,170,0.13)';
    ctx.fillRect(x0, padT, Math.max(0.6, x1 - x0), ph);
    ctx.fillStyle = 'rgba(70,110,190,0.16)';
    ctx.fillRect(x0, padT, Math.max(0.6, xm - x0), ph);
  }

  ctx.strokeStyle = line;
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(padL, y(0));
  ctx.lineTo(padL + pw, y(0));
  ctx.stroke();
  ctx.fillText('0', 34, y(0) + 4);
  ctx.fillText(`+${vmax.toFixed(1)}`, 22, y(vmax) + 4);
  ctx.fillText(`-${vmax.toFixed(1)}`, 26, y(-vmax) + 4);
  ctx.fillText('m/s', 22, padT + 2);

  for (let k = 0; k <= 5; k++) {
    const t = a + (b - a) * k / 5;
    ctx.fillText(t.toFixed(1) + 's', Math.min(width - 34, x(t) - 10), height - 8);
  }

  ctx.strokeStyle = '#2a6df4';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  const c = res.curve;
  for (let i = 0; i < c.t.length; i++) {
    const px = x(c.t[i]), py = y(c.v[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.lineWidth = 1;

  // 底部标记：最低点是竖直速度过零处，不是冲击峰
  ctx.fillStyle = '#ba5a24';
  for (const r of res.reps) {
    const px = x(r.t0 + r.down);
    ctx.beginPath();
    ctx.arc(px, y(0), 3, 0, Math.PI * 2);
    ctx.fill();
    if (pw / Math.max(1, res.reps.length) > 26) {
      ctx.fillStyle = ink;
      ctx.fillText(String(r.index), px - 4, padT + 10);
      ctx.fillStyle = '#ba5a24';
    }
  }
  ctx.fillStyle = ink;
  ctx.fillText(`竖直速度（转向点按零速约束）　${res.reps.length} 次`, padL + 4, padT - 4);
}
