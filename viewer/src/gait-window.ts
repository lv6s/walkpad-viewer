import type {activityEngine} from './activity-engine';
import {ACTIVITY_STILL} from './core/constants.ts';
import weights from './frozen_model.json' with {type: 'json'};
const W = 120, HALF = W / 2, STRIDE = 10, BINS = W / 2 + 1;
const FILTER_A = [1, 1.561018075800718, .641351538057563];
const FILTER_B = [.8005924034645703, 1.6011848069291406, .8005924034645703];
const BANDS = [1, 3, 5, 8, 13, 22, BINS];
const HANN = Float64Array.from({length: W}, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (W - 1)));
const basis = (fn: (x: number) => number) => Float64Array.from({length: BINS * W}, (_, i) =>
  HANN[i % W] * fn(2 * Math.PI * Math.floor(i / W) * (i % W) / W));
const COS = basis(Math.cos), SIN = basis(Math.sin);
const quantile = (sorted: Float64Array, q: number) => {
  const i = (sorted.length - 1) * q, lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
};

// Feature order is part of the frozen logistic model contract.
export function windowFeatures(x: Float32Array, length: number, from: number) {
  const feet: number[][] = [[], []];
  const v = new Float64Array(3 * W), magnitudes = new Float64Array(W), diffs = new Float64Array(W - 1);
  for (let foot = 0; foot < 2; foot++) for (let q = 0; q < 2; q++) {
    const cols = feet[foot], floor = q ? 3 : .025;
    let energy = 0;
    for (let a = 0; a < 3; a++) {
      const start = (foot * 6 + q * 3 + a) * length + from, axis = a * W;
      let mean = 0;
      for (let t = 0; t < W; t++) mean += x[start + t];
      mean /= W;
      for (let t = 0; t < W; t++) { const z = x[start + t] - mean; v[axis + t] = z; energy += z * z; }
    }
    const rms = Math.sqrt(energy / W), scale = Math.max(rms, floor);
    for (let i = 0; i < v.length; i++) v[i] /= scale;
    for (let t = 0; t < W; t++) magnitudes[t] = Math.hypot(v[t], v[W + t], v[2 * W + t]);
    magnitudes.sort();
    for (const p of [.15, .5, .85, .97]) cols.push(quantile(magnitudes, p));
    for (let lag = 22; lag < 74; lag += 3) {
      let dot = 0, lu = 0, ru = 0;
      for (let a = 0; a < 3; a++) for (let i = a * W; i < (a + 1) * W - lag; i++) {
        const l = v[i], r = v[i + lag]; dot += l * r; lu += l * l; ru += r * r;
      }
      cols.push(dot / Math.sqrt(lu * ru + 1e-9));
    }
    const bands = new Float64Array(BANDS.length - 1);
    let total = 1e-9;
    for (let band = 0; band < bands.length; band++) for (let k = BANDS[band]; k < BANDS[band + 1]; k++) {
      let power = 0;
      for (let a = 0; a < 3; a++) {
        let re = 0, im = 0;
        for (let t = 0, j = k * W, i = a * W; t < W; t++, j++, i++) { re += v[i] * COS[j]; im += v[i] * SIN[j]; }
        power += re * re + im * im;
      }
      bands[band] += power; total += power;
    }
    for (const band of bands) cols.push(band / total);
    let sum = 0, sq = 0;
    for (let t = 1; t < W; t++) {
      const d = Math.hypot(v[t] - v[t - 1], v[W + t] - v[W + t - 1], v[2 * W + t] - v[2 * W + t - 1]);
      diffs[t - 1] = d; sum += d; sq += d * d;
    }
    cols.push(sum / diffs.length, quantile(diffs.sort(), .9), sq / diffs.length, Math.log1p(rms / floor));
  }
  const [a, b] = feet;
  return [...a.map((v, i) => (v + b[i]) / 2), ...a.map((v, i) => Math.abs(v - b[i]))];
}

export function windowProbabilities(features: number[]) {
  const logits = weights.coef.map((row, j) => row.reduce((s, w, i) => s + w * features[i], weights.bias[j]));
  const max = Math.max(...logits), q = logits.map(v => Math.exp(v - max)), sum = q.reduce((s, v) => s + v, 0);
  return q.map(v => v / sum);
}

function isStill(x: Float32Array, grid: number, lo: number, hi: number) {
  let ax = 0, ay = 0, az = 0, energy = 0;
  for (let k = lo; k < hi; k++) {
    if (Math.hypot(x[3 * grid + k], x[4 * grid + k], x[5 * grid + k]) > 10) return false;
    const a = x[k], b = x[grid + k], c = x[2 * grid + k];
    ax += a; ay += b; az += c; energy += a * a + b * b + c * c;
  }
  const n = hi - lo, g2 = (ax / n) ** 2 + (ay / n) ** 2 + (az / n) ** 2;
  return g2 > .81 && g2 < 1.21 && energy / n - g2 < .025 ** 2;
}

export const ACTIVITY_WALK_RUN_UNCERTAIN = 5;

type GaitRun = {a: number; b: number; c: number};

function gaitRuns(labels: number[]) {
  const runs: GaitRun[] = [];
  for (let a = 0; a < labels.length;) {
    let b = a + 1;
    while (b < labels.length && labels[b] === labels[a]) b++;
    runs.push({a, b, c: labels[a]});
    a = b;
  }
  return runs;
}

function gyroSimilarity(x: Float32Array, n: number, a: number, b: number, lag: number) {
  let uv = 0, uu = 0, vv = 0;
  const count = b - a;
  for (let c = 3; c < 6; c++) {
    let u = 0, v = 0, s = 0, t = 0, p = 0;
    for (let i = c * n + a; i < c * n + b; i++) {
      const l = x[i], r = x[i + lag];
      u += l; v += r; s += l * l; t += r * r; p += l * r;
    }
    uv += p - u * v / count; uu += s - u * u / count; vv += t - v * v / count;
  }
  return {corr: uv / Math.sqrt(Math.max(0, uu) * Math.max(0, vv) + 1e-9), rms: Math.sqrt(Math.max(0, uu) / count)};
}

export function continuesGait(left: Float32Array, right: Float32Array, grid: number, a: number, b: number,
  before: number, after: number) {
  const refEnd = Math.min(after, b + 160);
  if (refEnd - b < 90) return false;
  const lags: number[] = [];
  for (const foot of [left, right]) {
    const corr = Array.from({length: 56}, (_, i) => {
      const lag = i + 22;
      return refEnd - b - lag >= 30 ? gyroSimilarity(foot, grid, b, refEnd - lag, lag).corr : -1;
    });
    const peaks = corr.map((v, i) => i > 0 && i + 1 < corr.length && v >= corr[i - 1] && v > corr[i + 1] ? v : -1);
    const peak = Math.max(...peaks);
    if (peak < .65) return false;
    const lag = 22 + peaks.findIndex(v => v >= peak - .06);
    const ref = gyroSimilarity(foot, grid, b, refEnd - lag, lag);
    const lo = Math.max(a, before + lag), hi = Math.min(b, after - lag);
    if (hi - lo < lag) return false;
    const past = gyroSimilarity(foot, grid, lo, hi, -lag), next = gyroSimilarity(foot, grid, lo, hi, lag);
    if (Math.min(past.corr, next.corr) < .65 || next.rms < .5 * ref.rms) return false;
    lags.push(lag);
  }
  return Math.abs(lags[0] - lags[1]) <= .12 * Math.max(...lags);
}

function decodeGaitSequence(base: number[], p: (c: number, i: number) => number,
  continuous?: (a: number, b: number, before: number, after: number) => boolean) {
  const out = base.slice(), runs = gaitRuns(base);
  const odds = (c: number, alt: number, a: number, b: number) => {
    let sum = 0;
    for (let i = a; i < b; i++) sum += Math.log(Math.max(1e-7, p(c, i)) / Math.max(1e-7, p(alt, i)));
    return sum;
  };
  const weak = (c: number, a: number, b: number) => {
    for (let i = a; i < b; i++) if (p(c === -1 ? base[i] : c, i) > .8) return false;
    return true;
  };
  const shortGait = ({a, b, c}: GaitRun) => (c === 0 || c === 1) && b - a <= 3;
  for (let i = 1; i + 1 < runs.length;) {
    const cur = runs[i], prev = runs[i - 1];
    if (continuous && shortGait(cur)) {
      let j = i + 1;
      while (j < runs.length && shortGait(runs[j])) j++;
      if (j - i > 1) {
        const next = runs[j], end = runs[j - 1].b, len = end - cur.a;
        // Resolve a cluster once against immutable long flanks, never against another edited fragment.
        if (j - i >= 3 && len <= 8 && next && prev.c === next.c && prev.c === 1 - cur.c &&
            prev.b - prev.a >= 4 && next.b - next.a >= 4 && weak(-1, cur.a, end) &&
            Math.abs(odds(1, 0, cur.a, end)) / len < .35) {
          out.fill(continuous(cur.a, end, prev.a, next.b) ? prev.c : ACTIVITY_WALK_RUN_UNCERTAIN, cur.a, end);
        }
        i = j;
        continue;
      }
    }
    const next = runs[i + 1], {a, b, c} = cur, len = b - a;
    if (len <= 5 && prev.c === next.c && !(c === 0 && prev.c === 2) &&
        (c === 2 || (len <= 4 && weak(c, a, b))) && odds(c, prev.c, a, b) <= 4) out.fill(prev.c, a, b);
    i++;
  }
  return out;
}

export function reviewGaitSpan(labels: Int8Array, probs: Float32Array, reviewed: Uint8Array,
  left: Float32Array, right: Float32Array, grid: number, start: number, end: number, pairs: number[], temporal = false) {
  const a = Math.ceil(start / 5), b = Math.floor(end / 5);
  if (a >= b) return;
  const still = new Uint8Array(b - a);
  for (let i = a; i < b; i++) {
    const lo = Math.max(start, i * 5 - 8), hi = Math.min(end, i * 5 + 13);
    if (hi - lo >= 14 && isStill(left, grid, lo, hi) && isStill(right, grid, lo, hi)) still[i - a] = 1;
  }
  const blocked = (i: number) => !!(still[pairs[i] - a] || still[pairs[i] + 1 - a]);
  const p = (c: number, i: number) => probs[c * labels.length + pairs[i]];
  // Each overlapping model window casts one vote; still anchors break the review span.
  for (let u = 0; u < pairs.length;) {
    if (blocked(u)) { u++; continue; }
    let w = u + 1;
    while (w < pairs.length && !blocked(w) && pairs[w] === pairs[w - 1] + 2) w++;
    if (w - u >= 20) {
      const base = pairs.slice(u, w).map(k => labels[k]);
      const sample = (i: number) => (pairs[u] + 2 * i) * 5;
      const decoded = decodeGaitSequence(base, (c, i) => p(c, u + i), temporal ?
        (a, b, before, after) => continuesGait(left, right, grid, sample(a), sample(b), sample(before), sample(after)) : undefined);
      decoded.forEach((c, i) => {
        if (c === base[i]) return;
        const k = pairs[u + i];
        labels.fill(c, k, k + 2); reviewed.fill(1, k, k + 2);
      });
    }
    u = w;
  }
  for (let i = a; i < b; i++) if (still[i - a]) labels[i] = ACTIVITY_STILL;
}

export async function analyzeGaitWindow(engine: ReturnType<typeof activityEngine>, modelId: string, sources, duration: number,
  progress = (_p: number) => {}, review: boolean | 'temporal' = false) {
  const grid = Math.floor(duration * 50 + 1e-7), ticks = Math.floor(grid / 5);
  const labels = new Int8Array(ticks).fill(-1), probs = new Float32Array(ticks * 3).fill(NaN), edge = new Uint8Array(ticks);
  const [l, r] = sources.map(source => engine.sample(source, grid));
  const reviewed = review ? new Uint8Array(ticks) : null;
  let start = 0, windows = 0;
  while (start < grid) {
    if (l.group[start] < 0 || r.group[start] < 0) { start++; continue; }
    let end = start + 1;
    while (end < grid && l.group[end] === l.group[start] && r.group[end] === r.group[start]) end++;
    const first = start + 10, pairs: number[] = [];
    if (end - first >= W) {
      const x = engine.filterSpan(l.values, r.values, grid, start, end, FILTER_A, FILTER_B);
      for (let center = Math.ceil((first + HALF) / STRIDE) * STRIDE; center + HALF <= end; center += STRIDE) {
        const q = windowProbabilities(windowFeatures(x, end - start, center - HALF - start));
        const label = q.indexOf(Math.max(...q)), tick = center / 5;
        for (const k of [tick - 1, tick]) {
          labels[k] = label;
          for (let c = 0; c < 3; c++) probs[c * ticks + k] = q[c];
        }
        if (reviewed) pairs.push(tick - 1);
        if (++windows % 128 === 0) {
          progress(Math.min(99, Math.round(100 * center / grid)));
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
    if (reviewed) reviewGaitSpan(labels, probs, reviewed, l.values, r.values, grid, start, end, pairs, review === 'temporal');
    start = end;
  }
  const validTicks = labels.reduce((n, c) => n + (c >= 0 ? 1 : 0), 0);
  progress(100);
  return {labels, probs, edge, reviewed, ticks, validTicks, duration, modelId};
}
