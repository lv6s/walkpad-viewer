// Kept self-contained so file:// can run the same engine in a Blob worker.
export function activityEngine() {
  const unpack = (item) => {
    const raw = atob(item.data), buf = new ArrayBuffer(raw.length), bytes = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Float32Array(buf);
  };
  function load(contract) {
    return contract.weights.map(m => ({...m, state: Object.fromEntries(Object.entries(m.state).map(([k, v]: any) => [k, unpack(v)]))}));
  }
  function conv(x, n, ci, co, w, bias) {
    const y = new Float32Array(co * n);
    for (let o = 0; o < co; o++) for (let t = 0; t < n; t++) {
      let z = bias[o]; for (let c = 0; c < ci; c++) z += w[o * ci + c] * x[c * n + t];
      y[o * n + t] = z;
    }
    return y;
  }
  function norm(x, n, c, w, b) {
    const y = new Float32Array(x.length);
    for (let t = 0; t < n; t++) {
      let mean = 0, variance = 0;
      for (let j = 0; j < c; j++) mean += x[j * n + t]; mean /= c;
      for (let j = 0; j < c; j++) variance += (x[j * n + t] - mean) ** 2;
      const inv = 1 / Math.sqrt(variance / c + 1e-5);
      for (let j = 0; j < c; j++) y[j * n + t] = (x[j * n + t] - mean) * inv * w[j] + b[j];
    }
    return y;
  }
  function silu(x) { for (let i = 0; i < x.length; i++) x[i] /= 1 + Math.exp(-x[i]); return x; }
  function softmax(x, n) {
    const out = new Float32Array(x.length);
    for (let t = 0; t < n; t++) {
      const m = Math.max(x[t], x[n + t], x[2 * n + t]); let sum = 0;
      for (let c = 0; c < 3; c++) { out[c * n + t] = Math.exp(x[c * n + t] - m); sum += out[c * n + t]; }
      for (let c = 0; c < 3; c++) out[c * n + t] /= sum;
    }
    return out;
  }
  // 50 Hz ratio features: 9 per foot, already clipped at the training bound.
  function ratios(x, n) {
    const f = new Float32Array(18 * n);
    for (let foot = 0; foot < 2; foot++) for (let t = 0; t < n; t++) {
      const get = (q, a, k) => x[(foot * 6 + q * 3 + a) * n + Math.max(0, Math.min(n - 1, k))] / (q ? 200 : 1);
      let aa = 1e-8, gg = 1e-8, ag = 0;
      for (let a = 0; a < 3; a++) { const av = get(0, a, t), gv = get(1, a, t); aa += av * av; gg += gv * gv; ag += av * gv; }
      const vals = [Math.sqrt(aa) / 2, Math.sqrt(gg), ag / 2];
      for (const lag of [1, 5, 10]) for (let q = 0; q < 2; q++) {
        let dl = 1e-8, dr = 1e-8;
        for (let a = 0; a < 3; a++) { const z = get(q, a, t); dl += (z - get(q, a, t - lag)) ** 2; dr += (z - get(q, a, t + lag)) ** 2; }
        vals.push((Math.sqrt(dl) + Math.sqrt(dr)) / (2 * (q ? 1 : 2)));
      }
      for (let j = 0; j < 9; j++) f[(foot * 9 + j) * n + t] = Math.max(-12, Math.min(12, vals[j]));
    }
    return f;
  }
  // Same ratios divided by a four-second local strength: motion strength cancels out.
  function shapeFeatures(f, n) {
    const out = new Float32Array(36 * n); out.set(f);
    for (let foot = 0; foot < 2; foot++) {
      const strength = [0, 1].map(j => {
        const base = (foot * 9 + j) * n, prefix = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + f[base + i] ** 2;
        const edgeLo = f[base] ** 2, edgeHi = f[base + n - 1] ** 2, mean = new Float32Array(n);
        for (let t = 0; t < n; t++) {
          const lo = t - 100, hi = t + 100, a = Math.max(0, lo), b = Math.min(n - 1, hi);
          let sum = prefix[b + 1] - prefix[a];
          if (lo < 0) sum += -lo * edgeLo;
          if (hi > n - 1) sum += (hi - n + 1) * edgeHi;
          mean[t] = sum / 201;
        }
        return mean;
      });
      for (let t = 0; t < n; t++) {
        const a = Math.sqrt(Math.max(strength[0][t], .04)), g = Math.sqrt(Math.max(strength[1][t], .01)), den = [a, g, a * g, a, g, a, g, a, g];
        for (let j = 0; j < 9; j++) out[(18 + foot * 9 + j) * n + t] = Math.max(-12, Math.min(12, f[(foot * 9 + j) * n + t] / den[j]));
      }
    }
    return out;
  }
  // 50 Hz to 10 Hz: tick k is the mean of samples 5k..5k+4.
  function pool(v, c, n) {
    const ticks = n / 5, out = new Float32Array(c * ticks);
    for (let ch = 0; ch < c; ch++) for (let k = 0; k < ticks; k++) {
      let sum = 0; for (let j = 0; j < 5; j++) sum += v[ch * n + k * 5 + j];
      out[ch * ticks + k] = sum / 5;
    }
    return out;
  }
  function forward(model, x, n) {
    const s = model.state, width = model.width, nt = n / 5;
    const cv = (v, ci, co, key) => conv(v, nt, ci, co, s[key + '.weight'], s[key + '.bias']);
    const nm = (v, key) => norm(v, nt, width, s[key + '.weight'], s[key + '.bias']);
    function block(x, key, dilation) {
      const z = new Float32Array(x.length), w = s[key + '.dw.weight'], b = s[key + '.dw.bias'];
      for (let c = 0; c < width; c++) for (let t = 0; t < nt; t++) {
        let v = b[c]; for (let k = 0; k < 3; k++) { const u = t + (k - 1) * dilation; if (u >= 0 && u < nt) v += w[c * 3 + k] * x[c * nt + u]; }
        z[c * nt + t] = v;
      }
      const h = cv(silu(cv(nm(z, key + '.norm.norm'), width, width * 2, key + '.pw.0')), width * 2, width, key + '.pw.3');
      for (let i = 0; i < h.length; i++) h[i] += x[i]; return h;
    }
    const r = ratios(x, n), short = !!model.short_local;
    let h = silu(nm(cv(pool(short ? shapeFeatures(r, n) : r, short ? 36 : 18, n), short ? 36 : 18, width, 'stem.0'), 'stem.1.norm')), local;
    const dilations = model.long ? [1, 2, 4, 8, 16, 32] : [1, 2, 4, 8, 16];
    dilations.forEach((d, i) => { h = block(h, 'blocks.' + i, d); if (i === 1) local = h; });
    if (short) {
      // Boundary evidence must not inherit the four-second ratio context.
      local = silu(norm(conv(pool(r, 18, n), nt, 18, width, s['raw_stem.0.weight'], s['raw_stem.0.bias']), nt, width, s['raw_stem.1.norm.weight'], s['raw_stem.1.norm.bias']));
      [1, 2, 4].forEach((d, i) => { local = block(local, 'raw_blocks.' + i, d); });
    }
    const coarse = cv(h, width, 3, 'coarse'), cat = new Float32Array((width + 3) * nt); cat.set(h); cat.set(softmax(coarse, nt), h.length);
    let ref = cv(cat, width + 3, width, 'refine_stem'); [1, 2, 4].forEach((d, i) => { ref = block(ref, 'refine.' + i, d); });
    const fine = cv(ref, width, 3, 'fine');
    if (s['local_head.weight']) {
      const joined = new Float32Array(width * 2 * nt); joined.set(local); joined.set(h, local.length);
      const gate = cv(silu(cv(joined, width * 2, width / 2, 'local_gate.0')), width / 2, 1, 'local_gate.2'), lp = cv(local, width, 3, 'local_head');
      for (let c = 0; c < 3; c++) for (let t = 0; t < nt; t++) { const g = .1 + .8 / (1 + Math.exp(-gate[t])), k = c * nt + t; fine[k] = g * lp[k] + (1 - g) * fine[k]; }
    }
    return softmax(fine, nt);
  }
  function predict(models, x, n, members?: Float32Array[]) {
    const p = new Float32Array(n / 5 * 3);
    for (const model of models) {
      const q = forward(model, x, n);
      members?.push(q);
      for (let i = 0; i < p.length; i++) p[i] += q[i] * model.weight;
    }
    return p;
  }
  function period(values: Float32Array, stride: number, from: number, centered: Float64Array, cor: Float64Array) {
    const n = 205;
    let energy = 0;
    for (let c = 0; c < 3; c++) {
      const first = (3 + c) * stride + from, col = c * n;
      let mean = 0;
      for (let k = 0; k < n; k++) mean += values[first + k];
      mean /= n;
      for (let k = 0; k < n; k++) {
        const v = values[first + k] - mean;
        centered[col + k] = v;
        energy += v * v;
      }
    }
    if (!(energy >= n * 40 ** 2)) return 0;
    for (let lag = 23; lag <= 81; lag++) {
      let cross = 0, left = 0, right = 0;
      for (let c = 0; c < 3; c++) for (let k = c * n; k < (c + 1) * n - lag; k++) {
        const a = centered[k], b = centered[k + lag];
        cross += a * b; left += a * a; right += b * b;
      }
      cor[lag] = cross / Math.sqrt(left * right + 1e-12);
    }
    let best = -1;
    for (let lag = 24; lag <= 80; lag++) if (cor[lag] >= cor[lag - 1] && cor[lag] >= cor[lag + 1]) best = Math.max(best, cor[lag]);
    for (let lag = 24; lag <= 80; lag++) {
      if (cor[lag] >= best - .10 && cor[lag] > .5 && cor[lag] >= cor[lag - 1] && cor[lag] >= cor[lag + 1]) return cor[lag] >= .70 ? lag : 0;
    }
    return 0;
  }
  function reviewRunning(y: Int8Array, members: Float32Array[], l: Float32Array, r: Float32Array, grid: number, first: number, reviewed: Uint8Array) {
    const n = y.length;
    if (members.length < 2 || n < 80 || !y.includes(2)) return;
    const centered = new Float64Array(3 * 205), cor = new Float64Array(82);
    function accept(a: number, z: number) {
      if (z - a < 40 || !y.subarray(a, z).includes(2)) return;
      const limit = z - a;
      let bestRun = 0;
      for (const p of members) {
        let walk = 0, run = 0;
        for (let i = a; i < z; i++) { walk += p[i]; run += p[n + i]; }
        if (!(walk <= .20 * limit)) return;
        bestRun = Math.max(bestRun, run / limit);
      }
      if (!(bestRun >= .60)) return;
      for (let i = a; i < z; i++) if (y[i] === 2) { y[i] = 1; reviewed[first + i] = 1; }
    }
    // One call per contiguous valid span; never infer across a recording gap.
    let a = -1;
    for (let i = 20; i + 20 < n; i++) {
      const from = (first + i - 20) * 5;
      const left = y[i] > 0 ? period(l, grid, from, centered, cor) : 0;
      const right = left ? period(r, grid, from, centered, cor) : 0;
      if (right && Math.abs(left - right) <= 4) { if (a < 0) a = i; }
      else if (a >= 0) { accept(a, i); a = -1; }
    }
    if (a >= 0) accept(a, n - 20);
  }
  function decode(p, penalty) {
    const n = p.length / 3, back = new Uint8Array(n * 3), y = new Int8Array(n);
    let dp = [0, 1, 2].map(c => -Math.log(Math.max(1e-7, p[c * n])));
    for (let t = 1; t < n; t++) {
      const next = [];
      for (let c = 0; c < 3; c++) {
        let best = Infinity, index = 0;
        for (let k = 0; k < 3; k++) { const v = dp[k] + (k === c ? 0 : penalty); if (v < best) { best = v; index = k; } }
        back[t * 3 + c] = index; next[c] = best - Math.log(Math.max(1e-7, p[c * n + t]));
      }
      const m = Math.min(...next); dp = next.map(v => v - m);
    }
    y[n - 1] = dp.indexOf(Math.min(...dp)); for (let t = n - 2; t >= 0; t--) y[t] = back[(t + 1) * 3 + y[t + 1]];
    return y;
  }
  function sample(source, grid) {
    const n = source.t.length, values = new Float32Array(grid * 6).fill(NaN), group = new Int32Array(grid).fill(-1);
    const ids = new Int32Array(n).fill(-1); let id = 0;
    for (let i = 0; i < n; i++) {
      const valid = source.ok[i] && Number.isFinite(source.t[i]) && source.axes.every(a => Number.isFinite(a[i]));
      if (!valid) { id++; continue; }
      if (i && (ids[i - 1] < 0 || source.t[i] <= source.t[i - 1] || source.t[i] - source.t[i - 1] > .080000001 || (Number.isFinite(source.seq[i]) && Number.isFinite(source.seq[i - 1]) && source.seq[i] <= source.seq[i - 1]))) id++;
      ids[i] = id;
    }
    // Never sort clock resets into a fictitious continuous signal.
    for (let i = 1; i < n; i++) if (source.t[i] < source.t[i - 1]) throw new Error('源时间倒退，请分开导入重启前后的记录');
    let right = 0;
    for (let k = 0; k < grid; k++) {
      const t = (k + .5) / 50;
      while (right < n && (!Number.isFinite(source.t[right]) || source.t[right] < t - 1e-9)) right++;
      if (right >= n) break;
      const exact = Math.abs(source.t[right] - t) < 1e-8, left = exact ? right : right - 1;
      if (left < 0 || ids[left] < 0 || ids[left] !== ids[right]) continue;
      const dt = source.t[right] - source.t[left]; if (dt > .080000001) continue;
      const w = dt ? (t - source.t[left]) / dt : 0;
      for (let c = 0; c < 6; c++) values[c * grid + k] = source.axes[c][left] + w * (source.axes[c][right] - source.axes[c][left]);
      group[k] = ids[right];
    }
    return {values, group};
  }
  function filterSpan(l, r, grid, start, end, a: number[], b: number[]) {
    const length = end - start, filtered = new Float32Array(12 * length);
    for (let c = 0; c < 12; c++) {
      const input = c < 6 ? l : r, ci = c % 6, first = input[ci * grid + start];
      let z1 = (1 - b[0]) * first, z2 = (b[2] - a[2]) * first;
      for (let k = 0; k < length; k++) { const x = input[ci * grid + start + k], y = b[0] * x + z1; z1 = b[1] * x - a[1] * y + z2; z2 = b[2] * x - a[2] * y; filtered[c * length + k] = y; }
    }
    return filtered;
  }
  async function analyze(contract, sources, duration, progress = (_p) => {}) {
    const grid = Math.floor(duration * 50 + 1e-7), ticks = Math.floor(grid / 5), labels = new Int8Array(ticks).fill(-1), probs = new Float32Array(ticks * 3).fill(NaN), edge = new Uint8Array(ticks);
    const models = load(contract), l = sample(sources[0], grid), r = sample(sources[1], grid), halo = (contract.radius || 38) + 3;
    const reviewed = contract.reviewRunning ? new Uint8Array(ticks) : null;
    let start = 0, done = 0;
    while (start < grid) {
      if (l.group[start] < 0 || r.group[start] < 0) { start++; continue; }
      let end = start + 1;
      while (end < grid && l.group[end] === l.group[start] && r.group[end] === r.group[start]) end++;
      const length = end - start, filtered = filterSpan(l.values, r.values, grid, start, end, contract.a, contract.b);
      const s = Math.ceil((start + 10) / 5), e = Math.floor(end / 5), nt = e - s;
      if (nt >= 10) {
        const pp = new Float32Array(nt * 3);
        const members = reviewed && nt >= 80 ? models.map(() => new Float32Array(nt * 3)) : null;
        for (let k = 0; k < nt; k += 256) {
          const stop = Math.min(nt, k + 256), aa = Math.max(0, k - halo), bb = Math.min(nt, stop + halo), nn = (bb - aa) * 5;
          const x = new Float32Array(12 * nn), offset = s * 5 - start + aa * 5;
          for (let c = 0; c < 12; c++) x.set(filtered.subarray(c * length + offset, c * length + offset + nn), c * nn);
          const chunkMembers = members ? [] : null;
          const p = predict(models, x, nn, chunkMembers);
          for (let c = 0; c < 3; c++) {
            const from = c * (bb - aa) + k - aa, to = from + stop - k, dest = c * nt + k;
            pp.set(p.subarray(from, to), dest);
            members?.forEach((m, j) => m.set(chunkMembers[j].subarray(from, to), dest));
          }
          progress(Math.min(99, Math.round(100 * (s + stop) / Math.max(ticks, 1)))); await new Promise(resolve => setTimeout(resolve, 0));
        }
        const y = decode(pp, contract.penalty);
        if (members) reviewRunning(y, members, l.values, r.values, grid, s, reviewed);
        for (let k = 0; k < nt; k++) { labels[s + k] = y[k]; edge[s + k] = k < halo || k >= nt - halo ? 1 : 0; for (let c = 0; c < 3; c++) probs[c * ticks + s + k] = pp[c * nt + k]; }
        done += nt;
      }
      start = end;
    }
    progress(100); return {labels, probs, edge, reviewed, ticks, validTicks: done, duration, modelId: contract.id};
  }
  return {load, predict, decode, analyze, sample, filterSpan, reviewRunning};
}
