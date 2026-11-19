import type {activityEngine} from './activity-engine';
import {ACTIVITY_STILL, ACTIVITY_TURN, ACTIVITY_TURN_L, ACTIVITY_TURN_R} from './core/constants.ts';

// 方向以项目左脚的同轴右手系为基准；右脚镜像归一不改变该约定。
const TURN_RULE = {yawOn: 15, minAngle: 90, minDuration: 1, maxGapS: .3, gravityWinS: 1, yawWinS: 2.5, edgeS: 1};
const RATE = 50;

// 窗口在连续有效段边缘截断，不跨缺口。
function boxMean(input: Float32Array, from: number, to: number, win: number) {
  const n = to - from, out = new Float32Array(n), half = Math.max(1, Math.round(win / 2)) | 0;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + input[from + i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

type Sampled = ReturnType<ReturnType<typeof activityEngine>['sample']>;

function projectedGyro({values, group}: Sampled, grid: number, gravity: number, smooth: number, perpendicular = false) {
  const out = new Float32Array(grid).fill(NaN);
  const acc = [0, 1, 2].map(c => values.subarray(c * grid, (c + 1) * grid));
  const gyr = [3, 4, 5].map(c => values.subarray(c * grid, (c + 1) * grid));
  for (let start = 0; start < grid;) {
    if (!(group[start] >= 0)) { start++; continue; }
    let end = start + 1;
    while (end < grid && group[end] === group[start]) end++;
    const grav = acc.map(a => boxMean(a, start, end, gravity));
    const raw = new Float32Array(end - start);
    for (let i = 0; i < raw.length; i++) {
      const x = grav[0][i], y = grav[1][i], z = grav[2][i], norm = Math.hypot(x, y, z);
      const a = gyr[0][start + i], b = gyr[1][start + i], c = gyr[2][start + i];
      const yaw = norm > 1e-6 ? (a * x + b * y + c * z) / norm : 0;
      raw[i] = perpendicular ? norm > 1e-6 ? Math.max(0, a * a + b * b + c * c - yaw * yaw) : 0 : yaw;
    }
    out.set(smooth ? boxMean(raw, 0, raw.length, smooth) : raw, start);
    start = end;
  }
  return out;
}

export type TurnRun = {a: number; b: number; angle: number; source: number; dir: number; left: number; right: number};

const WALK_RULE = {swing: 110, quiet: 40, quietTicks: 4, minTicks: 20};
export const WALK_REVIEW = {lowSwing: 1, pause: 2, short: 4};

function rmsWindows(power: Float32Array, group: Int32Array, ticks: number) {
  const swing = new Float32Array(ticks).fill(NaN), quiet = new Float32Array(ticks).fill(NaN);
  for (let a = 0; a < power.length;) {
    if (group[a] < 0) { a++; continue; }
    let b = a + 1;
    while (b < power.length && group[b] === group[a]) b++;
    const local = boxMean(power, a, b, 120), brief = boxMean(power, a, b, 14);
    for (let t = Math.ceil(a / 5); t < Math.min(ticks, Math.floor(b / 5)); t++) {
      const mid = t * 5 + 2 - a;
      swing[t] = Math.sqrt(local[mid]); quiet[t] = Math.sqrt(brief[mid]);
    }
    a = b;
  }
  return {swing, quiet};
}

export function screenGait(labels: Int8Array, turns: Int8Array, feet: readonly [Sampled, Sampled], grid: number) {
  const ticks = labels.length, out = labels.slice(), reasons = new Uint8Array(ticks);
  const [l, r] = feet.map(foot => rmsWindows(projectedGyro(foot, grid, 2 * RATE, 0, true), foot.group, ticks));
  for (let t = 0; t < ticks;) {
    if (!(l.quiet[t] < WALK_RULE.quiet && r.quiet[t] < WALK_RULE.quiet)) { t++; continue; }
    let e = t + 1;
    while (e < ticks && l.quiet[e] < WALK_RULE.quiet && r.quiet[e] < WALK_RULE.quiet) e++;
    if (e - t >= WALK_RULE.quietTicks) for (let i = t; i < e; i++) if (labels[i] === 0) reasons[i] |= WALK_REVIEW.pause;
    t = e;
  }
  for (let t = 0; t < ticks; t++) {
    if (turns[t]) { out[t] = turns[t]; reasons[t] = 0; continue; }
    if (out[t] < 0) { reasons[t] = 0; continue; }
    if (out[t] === ACTIVITY_STILL) out[t] = 2;
    if (out[t] !== 0) continue;
    if (!(l.swing[t] >= WALK_RULE.swing && r.swing[t] >= WALK_RULE.swing)) reasons[t] |= WALK_REVIEW.lowSwing;
    if (reasons[t]) out[t] = 2;
  }
  for (let t = 0; t < ticks;) {
    if (out[t] !== 0) { t++; continue; }
    let e = t + 1;
    while (e < ticks && out[e] === 0) e++;
    if (e - t < WALK_RULE.minTicks) { out.fill(2, t, e); reasons.fill(WALK_REVIEW.short, t, e); }
    t = e;
  }
  return {labels: out, walkReview: reasons};
}

export async function analyzeGaitExtraction(engine: ReturnType<typeof activityEngine>, sources, duration: number,
  progress: (p: number) => void, modelId: string, base: {labels: Int8Array; probs: Float32Array; edge: Uint8Array}) {
  const rule = TURN_RULE;
  const grid = Math.floor(duration * RATE + 1e-7), ticks = Math.floor(grid / 5);
  const l = engine.sample(sources[0], grid), r = engine.sample(sources[1], grid);
  const gravity = rule.gravityWinS * RATE, yawWindow = rule.yawWinS * RATE;
  const left = projectedGyro(l, grid, gravity, yawWindow), right = projectedGyro(r, grid, gravity, yawWindow);
  progress(30);
  await new Promise(resolve => setTimeout(resolve, 0));

  // 双足符号归一：同一次转身两脚应同号；显著负相关说明某只脚的轴是镜像的。
  let flip = 1, dot = 0, ll = 0, rr = 0, pairs = 0;
  for (let k = 0; k < grid; k++) {
    const a = left[k], b = right[k];
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) < 5 || Math.abs(b) < 5) continue;
    dot += a * b; ll += a * a; rr += b * b; pairs++;
  }
  if (pairs > 100 && dot < -.5 * Math.sqrt(ll * rr)) flip = -1;
  const yaw = new Float32Array(grid).fill(NaN);
  for (let k = 0; k < grid; k++) {
    const a = left[k], b = right[k] * flip;
    if (Number.isFinite(a) && Number.isFinite(b)) yaw[k] = (a + b) / 2;
  }

  // 同向段：低于阈值可容忍 maxGapS；累计只用同号样本，反向摆动不倒扣。
  const runs: TurnRun[] = [];
  const minGap = Math.max(1, Math.round(rule.maxGapS * RATE));
  for (let k = 0; k < grid;) {
    const first = yaw[k];
    if (!(Number.isFinite(first) && Math.abs(first) >= rule.yawOn)) { k++; continue; }
    const sign = Math.sign(first);
    let end = k, dead = 0;
    for (let i = k; i < grid; i++) {
      const v = yaw[i];
      if (!Number.isFinite(v) || l.group[i] !== l.group[k] || r.group[i] !== r.group[k]) break;
      if (Math.sign(v) === sign && Math.abs(v) >= rule.yawOn) { end = i; dead = 0; }
      else if (++dead > minGap) break;
    }
    let sum = 0, sumL = 0, sumR = 0, nL = 0, nR = 0;
    for (let i = k; i <= end; i++) {
      const v = yaw[i];
      if (Math.sign(v) === sign) sum += v;
      const a = left[i], b = right[i] * flip;
      if (Number.isFinite(a) && Math.sign(a) === sign) { sumL += a; nL++; }
      if (Number.isFinite(b) && Math.sign(b) === sign) { sumR += b; nR++; }
    }
    const angle = sum / RATE, span = (end - k + 1) / RATE;
    if (Math.abs(angle) >= rule.minAngle && span >= rule.minDuration) {
      // 双脚各自积分：都同向且量级都过半才敢给左右，否则只报「转身」
      const same = (s: number, n: number) => n >= span * RATE * .25 && Math.sign(s) === sign && Math.abs(s) / RATE >= .5 * Math.abs(angle);
      runs.push({a: k / RATE, b: (end + 1) / RATE, angle, source: span, dir: same(sumL, nL) && same(sumR, nR) ? sign : 0,
        left: sumL / RATE, right: sumR / RATE});
    }
    k = end + 1;
  }
  progress(60);
  await new Promise(resolve => setTimeout(resolve, 0));

  // 1 = 左转，−1 = 右转，2 = 转身但方向判不出（含双脚不一致）
  const turnAt = new Int8Array(grid);
  for (const run of runs) turnAt.fill(run.dir === 0 ? 2 : run.dir > 0 ? 1 : -1, Math.round(run.a * RATE), Math.round(run.b * RATE));
  const turns = new Int8Array(ticks);
  const strength = new Float32Array(ticks).fill(NaN);
  const edge = base.edge.slice();
  const edgeWin = Math.round(rule.edgeS * RATE);
  for (let t = 0; t < ticks; t++) {
    const from = t * 5, to = from + 5;
    if (l.group[from] < 0 || r.group[from] < 0) continue;
    let continuous = true;
    for (let i = from + 1; i < to; i++) continuous &&= l.group[i] === l.group[from] && r.group[i] === r.group[from];
    if (!continuous) continue;
    let hot = 0, s = 0, nl = 0, nr = 0, nu = 0;
    for (let i = from; i < to; i++) {
      const v = turnAt[i];
      if (v) { hot++; if (v === 1) nl++; else if (v === -1) nr++; else nu++; }
      if (Number.isFinite(yaw[i])) s += Math.min(1, Math.abs(yaw[i]) / rule.minAngle);
    }
    strength[t] = s / Math.max(1, to - from);
    // 一个 tick 内混了两个方向的转身段就不给方向
    turns[t] = hot >= 3 ? nl >= 3 && !nr && !nu ? ACTIVITY_TURN_L : nr >= 3 && !nl && !nu ? ACTIVITY_TURN_R : ACTIVITY_TURN : 0;
    if (turns[t] && (from < edgeWin || to + edgeWin > grid || l.group[from - edgeWin] !== l.group[from]
      || l.group[to + edgeWin - 1] !== l.group[from] || r.group[from - edgeWin] !== r.group[from]
      || r.group[to + edgeWin - 1] !== r.group[from])) edge[t] = 1;
  }
  progress(70);
  await new Promise(resolve => setTimeout(resolve, 0));

  const {labels, walkReview} = screenGait(base.labels, turns, [l, r], grid);
  const probs = new Float32Array(ticks * (ACTIVITY_TURN + 1)).fill(NaN);
  probs.set(base.probs);
  probs.set(strength, ACTIVITY_TURN * ticks);
  progress(100);
  const validTicks = labels.reduce((n, c) => n + (c >= 0 ? 1 : 0), 0);
  return {labels, probs, edge, ticks, validTicks, duration, modelId, reviewed: null, walkReview, baseLabels: base.labels, turnRuns: runs};
}
