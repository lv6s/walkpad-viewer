import assert from 'node:assert/strict';
import fs from 'node:fs';
import {activityEngine} from '../src/activity-engine.ts';
const variant = process.argv[2] === 'b1q' ? 'b1q' : 'b1';
const name = variant.toUpperCase();
const contract = JSON.parse(fs.readFileSync(new URL(`../src/${variant}-model.json`, import.meta.url)));
const fixture = JSON.parse(fs.readFileSync(new URL(`./${variant}-parity.json`, import.meta.url)));
const engine = activityEngine(), models = engine.load(contract), n = fixture.input[0].length;
const x = Float32Array.from(fixture.input.flat());
const tic = performance.now(), p = engine.predict(models, x, n), expected = fixture.probabilities.flat();
let error = 0; for (let i = 0; i < p.length; i++) error = Math.max(error, Math.abs(p[i] - expected[i]));
assert.ok(error < 2e-5, `PyTorch mismatch ${error}`);
console.log(`PASS ${name} two-checkpoint PyTorch parity`, error, 'milliseconds', performance.now() - tic);

const part = new Float32Array(p.length), total = n / 5, halo = contract.radius + 3;
for (let s = 0; s < total; s += 47) {
  const e = Math.min(total, s + 47), a = Math.max(0, s - halo), b = Math.min(total, e + halo), nn = (b - a) * 5;
  const xx = new Float32Array(12 * nn);
  for (let c = 0; c < 12; c++) xx.set(x.subarray(c * n + a * 5, c * n + b * 5), c * nn);
  const pp = engine.predict(models, xx, nn);
  for (let c = 0; c < 3; c++) part.set(pp.subarray(c * (b - a) + s - a, c * (b - a) + e - a), c * total + s);
}
let chunkError = 0; for (let k = 0; k < p.length; k++) chunkError = Math.max(chunkError, Math.abs(p[k] - part[k]));
assert.ok(chunkError < 2e-5, String(chunkError));
console.log(`PASS ${name} chunked inference stability`, chunkError);

const make = (count) => ({t: Float64Array.from({length: count}, (_, i) => i / 50), seq: Float64Array.from({length: count}, (_, i) => i), ok: new Uint8Array(count).fill(1), axes: Array.from({length: 6}, (_, c) => Float32Array.from({length: count}, (_, i) => c === 2 ? 1 : Math.sin(i / 10) * (c > 2 ? 30 : .1)))});
const out = await engine.analyze(contract, [make(501), make(501)], 10);
assert.equal(out.ticks, 100); assert.equal(out.modelId, `WT-offline-${name}`);
assert.ok([...out.labels.slice(0, 2)].every(v => v === -1));
// 10 s is shorter than twice the halo, so every analysed tick stays flagged.
assert.ok([...out.edge.slice(2, 100)].every(v => v === 1));
const wide = await engine.analyze(contract, [make(2001), make(2001)], 40);
assert.equal(wide.ticks, 400);
assert.ok(wide.edge[62] === 1 && wide.edge[339] === 1 && [...wide.edge.slice(63, 339)].every(v => v === 0));
console.log(`PASS ${name} analyze pipeline, wider edge band from radius`, contract.radius);
if (variant === 'b1q') {
  assert.deepEqual(contract.weights.map(w => w.sha256), [
    '80a55b9ce3415798873eb75fa238b3510438a9c338bc9ba69f354deb41cb27f0',
    'a66c94c5c5b3d6525e4ec027b6f51a76ceefabbdaa812570853b81ec0557dbe5'
  ]);
}
if (process.argv[3]) {
  const full = JSON.parse(fs.readFileSync(process.argv[3]));
  const inputs = full.inputs.map(s => ({t: Float64Array.from(s.t, v => v ?? NaN), seq: Float64Array.from(s.seq, v => v ?? NaN), ok: Uint8Array.from(s.ok), axes: s.axes.map(a => Float32Array.from(a))}));
  const actual = await engine.analyze(contract, inputs, full.duration);
  assert.deepEqual([...actual.labels], full.result.labels);
  let fullError = 0;
  for (let c = 0; c < 3; c++) for (let k = 0; k < actual.ticks; k++) {
    const expected = full.result.probs[c][k];
    if (expected == null) assert.ok(Number.isNaN(actual.probs[c * actual.ticks + k]));
    else fullError = Math.max(fullError, Math.abs(actual.probs[c * actual.ticks + k] - expected));
  }
  assert.ok(fullError < 2e-5, String(fullError));
  console.log(`PASS ${name} full real-input preprocessing, PyTorch, chunking and decoding parity`, fullError, 'valid ticks', actual.validTicks);
}
