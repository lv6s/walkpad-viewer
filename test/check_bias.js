'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../js/insole-proto.js');
const source = fs.readFileSync(filename, 'utf8');
const BASE = 1800000000000;
const BIAS = [12, -8, 16];

function harness() {
  let now = 0, timerId = 0;
  const timers = new Map(), elements = new Map();
  const context = vm.createContext({
    performance: { now: () => now },
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, due: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    $: (id, foot) => {
      const key = id + '-' + foot;
      if (!elements.has(key)) elements.set(key, { textContent: '', title: '' });
      return elements.get(key);
    },
    log() {}, console
  });
  vm.runInContext(source + '\n;globalThis.biasApi = { irNewState, irBiasNew, irBiasSetMode, irBiasStart, irBiasTrack, irBiasReset, irBiasCancel, irBiasText };', context, { filename });
  const api = context.biasApi;
  function advance(to) {
    if (to >= now) {
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= to)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].due;
        next[1].fn();
      }
    }
    now = to;
  }
  function state(foot = 'l', bias) {
    const st = api.irNewState(foot);
    st.dev = { gatt: { connected: true } };
    st.chr = {};
    if (bias) {
      st.bias.g = bias.slice();
      st.bias.ready = true;
    }
    /* 本文件保留旧手动语义；默认已改为自动，这里显式切回手动。 */
    api.irBiasSetMode(st, 'manual');
    return st;
  }
  function frame(st, seq, time, options = {}) {
    advance(time);
    const g = options.g || BIAS, a = options.a || [0, 0, 1];
    const s = { seq: seq >>> 0, gx0: g[0], gy0: g[1], gz0: g[2],
      ax: a[0], ay: a[1], az: a[2], clk: { epoch: BASE + time }, ...options };
    api.irBiasTrack(st, s);
    return s;
  }
  function stable(st, count = 31, start = now, firstSeq = 0, options = {}) {
    for (let i = 0; i < count; i++) frame(st, (firstSeq + i) >>> 0, start + i * 100, options);
  }
  return { api, state, frame, stable, advance, timers, elements, now: () => now };
}

function vector(st, expected = BIAS) {
  assert.equal(st.bias.ready, true, 'a valid calibration must remain available');
  assert.equal(st.bias.g.length, 3);
  expected.forEach((value, i) => assert.ok(Math.abs(st.bias.g[i] - value) < 1e-9,
    `axis ${i}: expected ${value}, got ${st.bias.g[i]}`));
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('no explicit request means no learning, even during long stable input', () => {
  const h = harness(), st = h.state();
  h.stable(st, 101);
  assert.equal(st.bias.ready, false);
  assert.deepEqual(Array.from(st.bias.g), [0, 0, 0]);
  assert.equal(st.bias.collect, null);
});

test('explicit calibration needs three seconds and commits large bias atomically', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st);
  h.stable(st, 30);
  assert.equal(st.bias.ready, false);
  assert.deepEqual(Array.from(st.bias.g), [0, 0, 0]);
  h.frame(st, 30, 3000);
  vector(st);
  assert.equal(st.bias.collect, null);
  assert.equal(h.timers.size, 0);
});

test('three seconds alone cannot replace the minimum thirty distinct frames', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st);
  for (let i = 0; i < 16; i++) h.frame(st, i, i * 200);
  assert.equal(st.bias.ready, false);
  for (let i = 16; i < 29; i++) h.frame(st, i, 3000);
  assert.equal(st.bias.ready, false);
  h.frame(st, 29, 3000);
  vector(st);
});

test('frames observed before clicking cannot be reused', () => {
  const h = harness(), st = h.state();
  h.stable(st, 31);
  h.api.irBiasStart(st);
  h.frame(st, 31, 3100);
  assert.equal(st.bias.ready, false);
  assert.equal(st.bias.still, 1);
});

test('locked bias survives slow yaw, accelerating yaw and apparent thermal drift', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st); h.stable(st);
  const cases = [() => 0.2, (i) => i * 0.01, () => 0.3];
  let seq = 31, time = 3100;
  for (const motion of cases) {
    for (let i = 0; i < 101; i++, seq++, time += 100) {
      h.frame(st, seq, time, { g: [12, -8, 16 + motion(i)] });
      vector(st);
    }
  }
});

test('successful recalibration retains old bias until one atomic replacement', () => {
  const h = harness(), st = h.state('l', BIAS), next = [13, -7, 15];
  h.api.irBiasStart(st); h.stable(st, 30, 0, 0, { g: next });
  vector(st);
  h.frame(st, 30, 3000, { g: next });
  vector(st, next);
});

test('recalibration movement failure retains old compensation', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st); h.stable(st, 10);
  h.frame(st, 10, 1000, { a: [0.2, 0, Math.sqrt(0.96)] });
  vector(st);
  assert.equal(st.bias.still, 0);
  assert.ok(st.bias.collect);
});

test('cancel retains old compensation and stops collecting', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st); h.stable(st, 10);
  h.api.irBiasCancel(st, 'test cancel');
  vector(st);
  assert.equal(st.bias.collect, null);
  assert.equal(h.timers.size, 0);
  h.stable(st, 40, 1000, 10, { g: [2, 3, 4] });
  vector(st);
});

test('timeout without any further frame retains old compensation', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st); h.stable(st, 10);
  h.advance(12000);
  vector(st);
  assert.equal(st.bias.collect, null);
  assert.match(st.bias.status, /超时/);
});

test('same-host-time burst cannot manufacture elapsed stationary time', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st);
  for (let i = 0; i < 200; i++) h.frame(st, i, 0, { clk: { epoch: BASE + i * 20 } });
  assert.equal(st.bias.ready, false);
  h.stable(st, 29, 100, 200, { clk: { epoch: BASE + 3980 } });
  assert.equal(st.bias.ready, false);
  h.frame(st, 229, 3000, { clk: { epoch: BASE + 3980 } });
  vector(st);
});

test('duplicate sequences do not increase sample count or achieve calibration', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st); h.frame(st, 7, 0);
  for (let i = 1; i <= 35; i++) h.frame(st, 7, i * 100);
  assert.equal(st.bias.ready, false);
  assert.equal(st.bias.still, 1);
  h.frame(st, 8, 3600);
  assert.ok(st.bias.still <= 1, 'duplicate traffic must not hide a gap between unique source frames');
});

for (const [name, inject] of [
  ['sequence skip', (h, st) => h.frame(st, 12, 1100)],
  ['sequence reversal', (h, st) => h.frame(st, 3, 1100)],
  ['host gap above 250 ms', (h, st) => h.frame(st, 11, 1251)],
  ['host clock reversal', (h, st) => h.frame(st, 11, 999)],
  ['fine device clock gap', (h, st) => h.frame(st, 11, 1100, { clk: { epoch: BASE + 1400 } })]
]) {
  test(name + ' clears the continuous candidate', () => {
    const h = harness(), st = h.state('l', BIAS);
    h.api.irBiasStart(st); h.stable(st, 11);
    inject(h, st);
    vector(st);
    assert.ok(st.bias.still <= 1);
    assert.ok(st.bias.collect);
  });
}

test('unsigned 32-bit sequence wrap remains continuous', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st); h.stable(st, 31, 0, 0xfffffff0);
  vector(st);
});

test('coarse repeated device epoch with one-second ticks does not block calibration', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st);
  for (let i = 0; i <= 30; i++) {
    h.frame(st, i, i * 100, { clk: { epoch: BASE + Math.floor(i / 10) * 1000 } });
  }
  vector(st);
});

test('an established coarse clock still rejects a five-second forward jump', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st);
  h.stable(st, 11, 0, 0, { clk: { epoch: BASE } });
  h.frame(st, 11, 1100, { clk: { epoch: BASE + 5000 } });
  vector(st);
  assert.ok(st.bias.still <= 1, 'coarse fallback must not waive large device clock jumps');
  assert.ok(st.bias.collect);
});

test('a missing device clock uses host elapsed time without inventing rest', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st);
  h.stable(st, 30, 0, 0, { clk: null });
  assert.equal(st.bias.ready, false);
  h.frame(st, 30, 3000, { clk: null });
  vector(st);
});

test('a fine device clock must also span three seconds', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st);
  for (let i = 0; i <= 30; i++) h.frame(st, i, i * 100, { clk: { epoch: BASE + i * 50 } });
  assert.equal(st.bias.ready, false);
  assert.ok(st.bias.collect);
});

test('deterministic quantized noise is averaged instead of using the last sample', () => {
  const h = harness(), st = h.state(), expected = BIAS.slice();
  h.api.irBiasStart(st);
  for (let i = 0; i <= 30; i++) {
    const noise = (i % 3 - 1) * 0.07;
    h.frame(st, i, i * 100, { g: [12 + noise, -8 - noise, 16 + noise] });
    expected[0] += noise / 31; expected[1] -= noise / 31; expected[2] += noise / 31;
  }
  vector(st, expected);
});

test('device epoch reversal still clears an already coarse-clock segment', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st);
  h.stable(st, 11, 0, 0, { clk: { epoch: BASE } });
  h.frame(st, 11, 1100, { clk: { epoch: BASE - 1 } });
  vector(st);
  assert.ok(st.bias.still <= 1);
});

for (const [name, options] of [
  ['NaN gyro', { g: [NaN, -8, 16] }],
  ['non-finite acceleration', { a: [0, Infinity, 1] }],
  ['gyro beyond forty dps', { g: [40.01, -8, 16] }],
  ['acceleration norm outside gravity band', { a: [0, 0, 1.13] }],
  ['raw sensor saturation', { raw6: [0, 0, 2048, 32767, 0, 0] }]
]) {
  test(name + ' rejects candidate without clearing valid bias', () => {
    const h = harness(), st = h.state('l', BIAS);
    h.api.irBiasStart(st); h.stable(st, 10);
    h.frame(st, 10, 1000, options);
    vector(st);
    assert.equal(st.bias.still, 0);
    assert.ok(st.bias.collect);
  });
}

test('acceleration direction motion is rejected even with constant norm', () => {
  const h = harness(), st = h.state();
  h.api.irBiasStart(st);
  for (let i = 0; i <= 30; i++) {
    const x = i % 2 ? 0.04 : -0.04;
    h.frame(st, i, i * 100, { a: [x, 0, Math.sqrt(1 - x * x)] });
  }
  assert.equal(st.bias.ready, false);
});

test('gyro variability and full-span range reject unstable candidates', () => {
  for (const sequence of [
    (i) => i % 2 ? 2 : -2,
    (i) => i === 29 ? 7 : 0
  ]) {
    const h = harness(), st = h.state();
    h.api.irBiasStart(st);
    for (let i = 0; i <= 30; i++) h.frame(st, i, i * 100, { g: [12 + sequence(i), -8, 16] });
    assert.equal(st.bias.ready, false);
  }
});

test('smooth angular-rate ramp fails the first-to-last-third check', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st);
  for (let i = 0; i <= 30; i++) h.frame(st, i, i * 100, { g: [12 + i * 0.03, -8, 16] });
  vector(st);
  assert.ok(st.bias.collect, 'ramp must not commit an apparently stable biased mean');
  assert.equal(st.bias.still, 0);
});

test('nonuniform burst sampling cannot dilute a time-domain angular-rate ramp', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st);
  let seq = 0;
  for (let i = 0; i < 200; i++) h.frame(st, seq++, i / 2, { clk: null });
  for (let time = 200; time <= 3000; time += 100) {
    const delta = 0.9 * (time - 100) / 2900;
    h.frame(st, seq++, time, { clk: null, g: [12 + delta, -8, 16] });
  }
  vector(st);
  assert.ok(st.bias.collect, 'time-domain drift must not be diluted by the initial dense burst');
  assert.equal(st.bias.still, 0);
});

test('segment resets do not extend the twelve-second request deadline', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st);
  const originalDeadline = [...h.timers.values()][0].due;
  for (let time = 0, seq = 0; time < 12000; time += 1000, seq += 2) {
    h.frame(st, seq, time);
    vector(st);
    assert.ok(st.bias.collect);
    assert.equal([...h.timers.values()][0].due, originalDeadline);
  }
  h.advance(12000);
  assert.equal(st.bias.collect, null);
  assert.match(st.bias.status, /超时/);
  vector(st);
});

test('restarting gets one fresh deadline which later segment resets cannot postpone', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st);
  const stale = [...h.timers.values()][0].fn;
  h.advance(1000); h.api.irBiasStart(st);
  for (let time = 1000, seq = 0; time <= 12000; time += 1000, seq += 2) h.frame(st, seq, time);
  assert.ok(st.bias.collect, 'the earlier request timeout must not cancel a later request');
  const current = st.bias.collect;
  stale();
  assert.equal(st.bias.collect, current);
  h.advance(12999);
  assert.equal(st.bias.collect, current);
  h.advance(13000);
  assert.equal(st.bias.collect, null);
  assert.match(st.bias.status, /超时/);
  vector(st);
});

test('left and right calibration states and timers remain independent', () => {
  const h = harness(), left = h.state('l'), right = h.state('r');
  h.api.irBiasStart(left); h.api.irBiasStart(right);
  for (let i = 0; i <= 30; i++) {
    h.frame(left, i, i * 100);
    if (i < 10) h.frame(right, i, i * 100, { g: [2, 3, 4] });
  }
  vector(left);
  assert.equal(right.bias.ready, false);
  h.api.irBiasCancel(right, 'right only');
  vector(left);
  assert.notEqual(left.bias, right.bias);
});

test('reset cancels collection and makes an already captured timeout callback stale', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st); h.stable(st, 5);
  const stale = [...h.timers.values()][0].fn;
  h.api.irBiasReset(st, true);
  const resetBias = st.bias;
  assert.equal(h.timers.size, 0);
  stale();
  assert.equal(st.bias, resetBias);
  assert.equal(st.bias.mode, 'dynamic');
  assert.equal(st.bias.ready, false);
  assert.equal(st.bias.collect, null);
  assert.deepEqual(Array.from(st.bias.g), [0, 0, 0]);
  h.api.irBiasStart(st);
  const current = st.bias.collect;
  stale();
  assert.equal(st.bias.collect, current);
  h.stable(st, 31, 500, 0);
  vector(st);
});

test('starting again invalidates the previous request timeout', () => {
  const h = harness(), st = h.state('l', BIAS);
  h.api.irBiasStart(st);
  const stale = [...h.timers.values()][0].fn;
  h.advance(100); h.api.irBiasStart(st);
  const current = st.bias.collect;
  stale();
  assert.equal(st.bias.collect, current);
  vector(st);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (error) {
    failed++;
    console.error('FAIL ' + name + '\n' + (error.stack || error));
  }
}
console.log(`${tests.length - failed}/${tests.length} bias checks passed`);
if (failed) process.exitCode = 1;
