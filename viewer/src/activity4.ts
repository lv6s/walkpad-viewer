import type {activityEngine} from './activity-engine.ts';
import {ACTIVITY4, ACTIVITY_STILL} from './core/constants.ts';
import {decodeMoticonTas} from './moticon-tas.ts';
import asset from './activity4-model.json' with {type: 'json'};
const FS = 50, STRIDE = 5, DILATIONS = [1, 2, 4, 8, 12];
const HALO = DILATIONS.reduce((a, b) => a + b, 0) + Math.ceil((12 + 4 + 3) / STRIDE) + 3;
const CLASS_MAP = [ACTIVITY_STILL, 0, 1, 2];
let weights: Record<string, Float32Array>;

function conv(x: Float32Array, n: number, ci: number, name: string, kernel = 1, dilation = 1) {
  const w = weights[name + '.weight'], bias = weights[name + '.bias'];
  const out = new Float32Array(bias.length * n), row = new Float64Array(n);
  for (let o = 0; o < bias.length; o++) {
    row.fill(bias[o]);
    for (let c = 0; c < ci; c++) for (let j = 0; j < kernel; j++) {
      const shift = (j - (kernel - 1) / 2) * dilation;
      const base = c * n + shift, value = w[(o * ci + c) * kernel + j];
      for (let t = Math.max(0, -shift), stop = Math.min(n, n - shift); t < stop; t++) row[t] += value * x[base + t];
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

function features(x: Float32Array, n: number) {
  const norm = (v: number) => Math.sqrt(v + 1e-8);
  const out = new Float32Array(17 * n), unit = new Float32Array(6 * n);
  const ap = new Float64Array(n + 1), gp = new Float64Array(n + 1);
  out.set(x);
  for (let i = 3 * n; i < 6 * n; i++) out[i] /= 300;
  for (let t = 0; t < n; t++) {
    const a = norm(out[t] ** 2 + out[n + t] ** 2 + out[2 * n + t] ** 2);
    const g = norm(out[3 * n + t] ** 2 + out[4 * n + t] ** 2 + out[5 * n + t] ** 2);
    out[6 * n + t] = a - 1; out[7 * n + t] = g;
    ap[t + 1] = ap[t] + (a - 1) ** 2; gp[t + 1] = gp[t] + g ** 2;
    for (let c = 0; c < 6; c++) unit[c * n + t] = out[c * n + t] / (c < 3 ? Math.max(.1, a) : Math.max(.03, g));
  }
  for (let t = 0; t < n; t++) {
    const prev = Math.max(0, t - 1), lag = Math.max(0, t - 5);
    let da = 0, dg = 0, la = 0, lg = 0, ag = 0, aa = 0, gg = 0;
    for (let c = 0; c < 3; c++) {
      const a = c * n, g = (c + 3) * n;
      da += (out[a + t] - out[a + prev]) ** 2; dg += (out[g + t] - out[g + prev]) ** 2;
      la += (out[a + t] - out[a + lag]) ** 2; lg += (out[g + t] - out[g + lag]) ** 2;
      ag += unit[a + t] * unit[g + t]; aa += unit[a + t] * unit[a + lag]; gg += unit[g + t] * unit[g + lag];
    }
    out[8 * n + t] = norm(da); out[9 * n + t] = norm(dg);
    out[10 * n + t] = norm(la); out[11 * n + t] = norm(lg);
    out[12 * n + t] = ag * Math.min(1, out[7 * n + t]); out[13 * n + t] = aa; out[14 * n + t] = gg;
    const lo = Math.max(0, t - 12), hi = Math.min(n, t + 13);
    out[15 * n + t] = Math.sqrt(Math.max(1e-8, (ap[hi] - ap[lo]) / 25));
    out[16 * n + t] = Math.sqrt(Math.max(1e-8, (gp[hi] - gp[lo]) / 25));
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-12, Math.min(12, out[i]));
  return out;
}

function foot(x: Float32Array, n: number) {
  const h = gelu(conv(gelu(conv(features(x, n), n, 17, 'foot.0', 9)), n, 32, 'foot.2', 7));
  const ticks = n / STRIDE, out = new Float32Array(64 * ticks);
  for (let i = 0; i < 32 * ticks; i++) {
    let sum = 0, max = -Infinity;
    for (let j = 0; j < STRIDE; j++) { const v = h[i * STRIDE + j]; sum += v; max = Math.max(max, v); }
    out[i] = sum / STRIDE; out[i + 32 * ticks] = max;
  }
  return out;
}

export function predictActivity4(x: Float32Array, n: number) {
  weights ??= Object.fromEntries(Object.entries(asset.weights).map(([name, text]) => {
    const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
    return [name, Float32Array.from({length: bytes.length / 4}, (_, i) => view.getFloat32(4 * i, true))];
  }));
  const ticks = n / STRIDE, l = foot(x.subarray(0, 6 * n), n), r = foot(x.subarray(6 * n), n);
  const f = new Float32Array(2 * l.length);
  for (let i = 0; i < l.length; i++) { f[i] = (l[i] + r[i]) * .5; f[l.length + i] = Math.abs(l[i] - r[i]); }
  const h0 = gelu(conv(f, ticks, 128, 'mix'));
  let h = h0;
  for (const [i, d] of DILATIONS.entries()) {
    const b = gelu(conv(h, ticks, 64, `blocks.${i}.conv`, 3, d));
    const y = conv(b, ticks, 64, `blocks.${i}.out`);
    for (let j = 0; j < y.length; j++) y[j] = h[j] + .5 * y[j];
    h = y;
  }
  const logits = conv(h, ticks, 64, 'state');
  const probabilities = new Float32Array(logits.length);
  for (let t = 0; t < ticks; t++) {
    const max = Math.max(logits[t], logits[ticks + t], logits[2 * ticks + t], logits[3 * ticks + t]);
    let sum = 0;
    for (let c = 0; c < 4; c++) sum += Math.exp(logits[c * ticks + t] - max);
    for (let c = 0; c < 4; c++) probabilities[c * ticks + t] = Math.exp(logits[c * ticks + t] - max) / sum;
  }
  const hBoundary = new Float32Array(132 * ticks);
  hBoundary.set(h0); hBoundary.set(h, h0.length); hBoundary.set(probabilities, h0.length + h.length);
  const b0 = gelu(conv(hBoundary, ticks, 132, 'boundary.0', 5));
  const b1 = gelu(conv(b0, ticks, 32, 'boundary.3', 3));
  return {logits, probabilities, boundaryLogits: conv(b1, ticks, 16, 'boundary.5')};
}

export async function analyzeActivity4(engine: ReturnType<typeof activityEngine>, sources, duration: number, progress = (_p: number) => {}) {
  const grid = Math.floor(duration * FS + 1e-7), ticks = Math.floor(grid / STRIDE);
  const labels = new Int8Array(ticks).fill(-1), probs = new Float32Array(ticks * (ACTIVITY_STILL + 1)).fill(NaN);
  const edge = new Uint8Array(ticks), [l, r] = sources.map(source => engine.sample(source, grid));
  const values = [l.values, r.values];
  let validTicks = 0;
  for (let start = 0; start < grid;) {
    if (l.group[start] < 0 || r.group[start] < 0) { start++; continue; }
    let end = start + 1;
    while (end < grid && l.group[end] === l.group[start] && r.group[end] === r.group[start]) end++;
    const first = Math.ceil(start / STRIDE), last = Math.floor(end / STRIDE), span = last - first;
    if (span >= 2) {
      const stateLogits = new Float32Array(4 * span), boundary = new Float32Array(span);
      for (let k = first; k < last; k += 256) {
        const stop = Math.min(last, k + 256), a = Math.max(first, k - HALO), b = Math.min(last, stop + HALO);
        const count = b - a, n = count * STRIDE, x = new Float32Array(12 * n);
        for (let c = 0; c < 12; c++) {
          const from = (c % 6) * grid + a * STRIDE;
          x.set(values[Math.floor(c / 6)].subarray(from, from + n), c * n);
        }
        const {logits, probabilities, boundaryLogits} = predictActivity4(x, n);
        for (let c = 0; c < 4; c++) {
          const from = c * count + k - a, to = from + stop - k;
          stateLogits.set(logits.subarray(from, to), c * span + k - first);
          probs.set(probabilities.subarray(from, to), CLASS_MAP[c] * ticks + k);
        }
        for (let t = k; t < stop; t++) {
          boundary[t - first] = 1 / (1 + Math.exp(-boundaryLogits[t - a]));
          edge[t] = +(t - first < HALO || t + HALO >= last);
        }
        progress(Math.min(99, Math.round(100 * stop / ticks)));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const path = decodeMoticonTas(stateLogits, boundary, asset.decodeStrength);
      for (let i = 0; i < path.length; i++) labels[first + i] = CLASS_MAP[path[i]];
      validTicks += span;
    }
    start = end;
  }
  progress(100);
  return {labels, probs, edge, ticks, validTicks, duration, modelId: ACTIVITY4.id, reviewed: null};
}
