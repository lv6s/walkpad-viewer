// Frames in one BLE notification share its receive timestamp, not a hardware sample clock.
export function spreadNotified(src: ArrayLike<number>) {
  const n = src.length, out = new Float64Array(n).fill(NaN), runs = [];
  for (let i = 0; i < n;) {
    const v = src[i];
    if (!Number.isFinite(v)) { i++; continue; }
    let e = i + 1;
    while (e < n && src[e] === v) e++;
    runs.push({s: i, k: e - i, v}); i = e;
  }
  runs.forEach((run, r) => {
    const prev = runs[r - 1], next = runs[r + 1];
    const gap = prev ? run.v - prev.v : (next ? next.v - run.v : 0), den = prev ? run.k : (next ? next.k : run.k);
    const step = gap > 0 ? gap / den : 0;
    for (let m = 0; m < run.k; m++) out[run.s + m] = run.v - (run.k - 1 - m) * step;
  });
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(out[i])) continue;
    if (!(out[i] > last)) out[i] = last + 1;
    last = out[i];
  }
  return out;
}
