import type {activityEngine} from './activity-engine.ts';
import {ACTIVITY_STILL} from './core/constants.ts';
import asset from './moticon-tas-model.json' with {type: 'json'};

export const MOTICON_TAS_ID = asset.id;
const DILATIONS = [1, 2, 4, 8, 16], STRIDE = 5, WIDTH = 48, FOOT = 24;
// The edge head, dilated blocks and foot encoder all need context at chunk joins.
const HALO = 2 + DILATIONS.reduce((a, b) => a + b, 0);
const CLASS_MAP = [ACTIVITY_STILL, 0, 1, 2];
const A = [1, 1.561018075800718, .641351538057563];
const B = [.8005924034645703, 1.6011848069291406, .8005924034645703];
let weights: Record<string, Float32Array>;

function loadWeights() {
  return Object.fromEntries(Object.entries(asset.weights).map(([key, text]) => {
    const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    return [key, Float32Array.from({length: bytes.length / 4}, (_, i) => view.getFloat32(4 * i, true))];
  }));
}

function conv(x: Float32Array, n: number, ci: number, co: number, name: string, kernel = 1, dilation = 1) {
  const w = weights[name + '.weight'], b = weights[name + '.bias'];
  const out = new Float32Array(co * n), row = new Float64Array(n);
  for (let o = 0; o < co; o++) {
    row.fill(b[o]);
    for (let c = 0; c < ci; c++) for (let j = 0; j < kernel; j++) {
      const lag = (j - (kernel - 1) / 2) * dilation;
      const base = c * n + lag, value = w[(o * ci + c) * kernel + j];
      for (let t = Math.max(0, -lag), stop = Math.min(n, n - lag); t < stop; t++) row[t] += value * x[base + t];
    }
    out.set(row, o * n);
  }
  return out;
}

function gelu(x: Float32Array) {
  for (let i = 0; i < x.length; i++) {
    const v = x[i], z = Math.abs(v) * Math.SQRT1_2, t = 1 / (1 + .3275911 * z);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-z * z);
    x[i] = .5 * v * (1 + (v < 0 ? -erf : erf));
  }
  return x;
}

function footFeatures(x: Float32Array, n: number, foot: number) {
  const input = new Float32Array(8 * n);
  for (let t = 0; t < n; t++) {
    let acc2 = 0, gyro2 = 0;
    for (let c = 0; c < 6; c++) {
      const v = x[(foot * 6 + c) * n + t] / (c < 3 ? 1 : 300);
      input[c * n + t] = v;
      if (c < 3) acc2 += v * v; else gyro2 += v * v;
    }
    input[6 * n + t] = Math.sqrt(acc2) - 1;
    input[7 * n + t] = Math.sqrt(gyro2);
  }
  const full = gelu(conv(input, n, 8, FOOT, 'foot', 7)), ticks = n / STRIDE;
  const pooled = new Float32Array(FOOT * ticks);
  for (let i = 0; i < pooled.length; i++) {
    let sum = 0;
    for (let j = 0; j < STRIDE; j++) sum += full[i * STRIDE + j];
    pooled[i] = sum / STRIDE;
  }
  return pooled;
}

export function predictMoticonTas(x: Float32Array, n: number) {
  weights ??= loadWeights();
  const ticks = n / STRIDE, left = footFeatures(x, n, 0), right = footFeatures(x, n, 1);
  const mix = new Float32Array(2 * left.length);
  for (let i = 0; i < left.length; i++) {
    mix[i] = (left[i] + right[i]) * .5;
    mix[left.length + i] = Math.abs(left[i] - right[i]);
  }
  const h0 = gelu(conv(mix, ticks, 2 * FOOT, WIDTH, 'mix'));
  let h = h0;
  for (const [i, d] of DILATIONS.entries()) {
    const hidden = gelu(conv(h, ticks, WIDTH, WIDTH, `blocks.${i}.conv`, 3, d));
    const next = conv(hidden, ticks, WIDTH, WIDTH, `blocks.${i}.proj`);
    for (let j = 0; j < next.length; j++) next[j] = h[j] + .5 * next[j];
    h = next;
  }
  const edges = new Float32Array(2 * h.length); edges.set(h0); edges.set(h, h.length);
  const boundary = conv(gelu(conv(edges, ticks, 2 * WIDTH, FOOT, 'edge.0', 3)), ticks, FOOT, 1, 'edge.2');
  for (let t = 0; t < ticks; t++) boundary[t] = 1 / (1 + Math.exp(-boundary[t]));
  return {logits: conv(h, ticks, WIDTH, 4, 'state'), boundary};
}

export function decodeMoticonTas(logits: Float32Array, boundary: Float32Array) {
  const n = boundary.length, labels = new Int8Array(n), back = new Uint8Array(4 * n);
  if (!n) return labels;
  // Per-tick normalization cancels in path comparisons, so decode directly from logits.
  let dp = Float64Array.from({length: 4}, (_, c) => logits[c * n]), next = new Float64Array(4);
  for (let t = 1; t < n; t++) {
    const cost = 1.5 * (1.35 - 1.15 * boundary[t]);
    for (let c = 0; c < 4; c++) {
      let best = -Infinity, from = 0;
      for (let k = 0; k < 4; k++) {
        const v = dp[k] - (c === k ? 0 : cost);
        if (v > best) { best = v; from = k; }
      }
      back[4 * t + c] = from;
      next[c] = best + logits[c * n + t];
    }
    [dp, next] = [next, dp];
  }
  let c = dp.indexOf(Math.max(...dp));
  for (let t = n - 1; t >= 0; t--) { labels[t] = c; c = back[4 * t + c]; }
  return labels;
}

export async function analyzeMoticonTas(engine: ReturnType<typeof activityEngine>, sources, duration: number, progress = (_p: number) => {}) {
  const grid = Math.floor(duration * 50 + 1e-7), ticks = Math.floor(grid / STRIDE);
  const labels = new Int8Array(ticks).fill(-1), probs = new Float32Array(ticks * (ACTIVITY_STILL + 1)).fill(NaN);
  const edge = new Uint8Array(ticks), [l, r] = sources.map(source => engine.sample(source, grid));
  let validTicks = 0;
  for (let start = 0; start < grid;) {
    if (l.group[start] < 0 || r.group[start] < 0) { start++; continue; }
    let end = start + 1;
    while (end < grid && l.group[end] === l.group[start] && r.group[end] === r.group[start]) end++;
    const first = Math.ceil((start + 10) / STRIDE), last = Math.floor(end / STRIDE), n = last - first;
    if (n >= 10) {
      const filtered = engine.filterSpan(l.values, r.values, grid, start, end, A, B);
      const logits = new Float32Array(4 * n), boundary = new Float32Array(n);
      for (let i = 0; i < n; i += 256) {
        const stop = Math.min(n, i + 256), a = Math.max(0, i - HALO), b = Math.min(n, stop + HALO);
        const length = (b - a) * STRIDE, input = new Float32Array(12 * length);
        for (let c = 0; c < 12; c++) {
          const from = c * (end - start) + (first + a) * STRIDE - start;
          input.set(filtered.subarray(from, from + length), c * length);
        }
        const chunk = predictMoticonTas(input, length);
        for (let c = 0; c < 4; c++) {
          const from = c * (b - a) + i - a;
          logits.set(chunk.logits.subarray(from, from + stop - i), c * n + i);
        }
        boundary.set(chunk.boundary.subarray(i - a, stop - a), i);
        progress(Math.min(99, Math.round(100 * (first + stop) / ticks)));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const path = decodeMoticonTas(logits, boundary);
      for (let i = 0; i < n; i++) {
        const tick = first + i;
        labels[tick] = CLASS_MAP[path[i]];
        edge[tick] = i < HALO || i >= n - HALO ? 1 : 0;
        const m = Math.max(logits[i], logits[n + i], logits[2 * n + i], logits[3 * n + i]);
        let sum = 0;
        for (let c = 0; c < 4; c++) sum += Math.exp(logits[c * n + i] - m);
        for (let c = 0; c < 4; c++) probs[CLASS_MAP[c] * ticks + tick] = Math.exp(logits[c * n + i] - m) / sum;
      }
      validTicks += n;
    }
    start = end;
  }
  progress(100);
  return {labels, probs, edge, ticks, validTicks, duration, modelId: MOTICON_TAS_ID, reviewed: null};
}
