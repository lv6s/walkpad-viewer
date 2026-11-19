'use strict';

/* 本轮「拿起就用」自动零偏的专属验收：
   默认自动、无需点击、重置/重连自动重建、大初偏直接学、无累计锚冻结、
   恒速转动可误判这一物理局限必须诚实展示，而不是假装能拒绝。
   主采样率 50 Hz；20/100 Hz 只做时间一致性边界。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const filename = path.join(ROOT, 'js/insole-proto.js');
const source = fs.readFileSync(filename, 'utf8');
const BASE = 1800000000000;
const ALPHA3 = 1 - Math.exp(-3 / 10);

function harness() {
  let now = 0, timerId = 0;
  const timers = new Map(), elements = new Map();
  const context = vm.createContext({
    performance: { now: () => now }, console, log() {},
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    $: (id, foot) => {
      const key = id + '-' + foot;
      if (!elements.has(key)) elements.set(key, { textContent: '', title: '', value: '' });
      return elements.get(key);
    }
  });
  vm.runInContext(source + '\n;globalThis.api = { irNewState, irBiasSetMode, irBiasStart, irBiasCancel, irBiasTrack, irBiasReset, irBiasText };', context, { filename });
  const api = context.api;
  function advance(to) {
    while (to >= now) {
      const next = [...timers].filter(([, t]) => t.due <= to).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].due; next[1].fn();
    }
    now = to;
  }
  function state(foot = 'l') { const st = api.irNewState(foot); st.testSeq = 0; return st; }
  function frame(st, time, g = [0, 0, 0], options = {}) {
    advance(time);
    const a = options.a || [0, 0, 1];
    api.irBiasTrack(st, { seq: st.testSeq++ >>> 0, gx0: g[0], gy0: g[1], gz0: g[2],
      ax: a[0], ay: a[1], az: a[2],
      clk: options.clk !== undefined ? options.clk : { epoch: BASE + time }, ...options });
  }
  function observe(st, ms, g, hz = 50, options = {}) {
    const step = 1000 / hz, start = now + step, n = Math.round(ms / step);
    for (let i = 0; i <= n; i++) {
      const t = start + i * step;
      frame(st, t, typeof g === 'function' ? g(i, t) : g,
        typeof options === 'function' ? options(i, t) : options);
    }
  }
  return { api, state, frame, observe, advance, timers, elements, now: () => now };
}
function close(actual, expected, eps = 1e-9) {
  expected.forEach((v, k) => assert.ok(Math.abs(actual[k] - v) <= eps, `axis ${k}: ${actual[k]} != ${v}`));
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('HTML 默认选中自动模式，切换自动不再弹确认，重置说明会自动重学', () => {
  const html = fs.readFileSync(path.join(ROOT, 'wt901ble_live.html'), 'utf8');
  assert.match(html, /<option value="dynamic" selected>自动模式<\/option>/);
  assert.match(html, /<option value="manual">手动模式<\/option>/);
  const ui = fs.readFileSync(path.join(ROOT, 'js/insole-ui.js'), 'utf8');
  const start = ui.indexOf("$('irBiasMode', f)");
  const end = ui.indexOf("$('btnBiasReset'", start);
  assert.ok(start > 0 && end > start, 'mode handler must exist');
  assert.doesNotMatch(ui.slice(start, end), /confirm\(/,
    '切换自动模式不得再要求确认');
  const resetTitle = html.match(/id="btnBiasReset-FT"[^>]*title="([^"]*)"/);
  assert.ok(resetTitle, 'reset button title must exist');
  assert.match(resetTitle[1], /自动|重新学习|自动学习/);
  const biasTitle = html.match(/id="irBiasMode-FT"[^>]*title="([^"]*)"/);
  assert.ok(biasTitle, 'mode title must exist');
  assert.match(biasTitle[1], /匀速|恒速|匀转/);
  assert.match(biasTitle[1], /误判|无法区分|不能区分/);
});

test('左右脚状态创建即自动，未就绪，无后台定时器', () => {
  const h = harness();
  for (const foot of ['l', 'r']) {
    const st = h.state(foot);
    assert.equal(st.bias.mode, 'dynamic');
    assert.equal(st.bias.ready, false);
    assert.equal(st.bias.anchor, null);
    close(st.bias.g, [0, 0, 0]);
  }
  assert.equal(h.timers.size, 0);
});

test('50 Hz 静止 5 秒自动初始化 [6,-4,9]，全程零次点击、零次切模式', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [6, -4, 9], 50);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [6, -4, 9]);
  assert.equal(st.bias.mode, 'dynamic');
  assert.equal(st.bias.anchor, null);
  assert.equal(st.bias.boundary, false);
  assert.equal(h.timers.size, 0);
});

test('就绪后 3 秒静止窗按 tau=10 s 自动更新，不需要任何按钮', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0, 0, 0], 50);
  h.observe(st, 3000, [0.2, 0, 0], 50);
  close(st.bias.g, [0.2 * ALPHA3, 0, 0]);
  assert.equal(st.bias.anchor, null);
});

test('运动中不初始化；停稳 5 秒自动就绪，无需用户操作', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, (i) => [i % 2 ? 1 : -1, 0, 0], 50);
  assert.equal(st.bias.ready, false);
  close(st.bias.g, [0, 0, 0]);
  h.observe(st, 5000, [0.2, 0, 0], 50);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [0.2, 0, 0]);
});

test('运动未停稳时取用：显示仍是原始角速度，不会凭空给出 ready', () => {
  const h = harness(), st = h.state();
  h.observe(st, 4000, (i) => [i % 2 ? 0.8 : -0.8, 0, 0], 50);
  assert.equal(st.bias.ready, false);
  close(st.bias.g, [0, 0, 0]);
  assert.match(st.bias.status, /未就绪/);
  h.api.irBiasText(st);
  assert.match(h.elements.get('irBias-l').title, /原始角速度/);
});

test('大初偏没有大小限制：恒定 10 °/s 也会被自动当成初偏（风险已披露）', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [10, 0, 0], 50);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [10, 0, 0]);
  h.api.irBiasText(st);
  assert.match(h.elements.get('irBias-l').title, /匀速|恒速|匀转/);
});

test('恒速转动与零偏不可区分：1.4 °/s 匀速转动会按 .5 °/s/s 被吸收', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0, 0, 0], 50);
  h.observe(st, 3000, [1.4, 0, 0], 50);
  close(st.bias.g, [1.4 * ALPHA3, 0, 0], 1e-9);
  assert.ok(st.bias.g[0] > 0.3);
});

test('没有累计锚/触界：偏置持续越过原 .28 后仍继续更新', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0, 0, 0], 50);
  for (let i = 0; i < 40; i++) h.observe(st, 3000, [0.6, 0, 0], 50);
  assert.ok(st.bias.g[0] > 0.28);
  assert.ok(st.bias.g[0] > 0.59);
  assert.equal(st.bias.boundary, false);
  assert.equal(st.bias.anchor, null);
  const before = st.bias.g[0];
  h.observe(st, 3000, [0.6, 0, 0], 50);
  assert.ok(st.bias.g[0] > before);
});

test('重置后自动回到自动模式，5 秒静置自行重建，不需要再点「静止校准」', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [6, -4, 9], 50);
  h.api.irBiasReset(st);
  assert.equal(st.bias.mode, 'dynamic');
  assert.equal(st.bias.ready, false);
  close(st.bias.g, [0, 0, 0]);
  h.observe(st, 5000, [-3, 2, -1], 50);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [-3, 2, -1]);
});

test('重连路径（静默 reset）后仍是自动，静置即重新学习', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [1, 2, 3], 50);
  h.api.irBiasReset(st, true);
  assert.equal(st.bias.mode, 'dynamic');
  assert.equal(st.bias.ready, false);
  assert.equal(st.bias.anchor, null);
  h.observe(st, 5000, [0.2, 0, 0], 50);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [0.2, 0, 0]);
});

test('手动模式是可选冻结：保留当前补偿且不学习；切回自动立即恢复跟随', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0.2, 0, 0], 50);
  h.api.irBiasSetMode(st, 'manual');
  h.observe(st, 9000, [0.9, 0, 0], 50);
  close(st.bias.g, [0.2, 0, 0]);
  assert.equal(st.bias.mode, 'manual');
  h.api.irBiasSetMode(st, 'dynamic');
  h.observe(st, 3000, [0.3, 0, 0], 50);
  assert.ok(st.bias.g[0] > 0.2);
});

test('大初偏的就绪状态不出现「请手动校准」「需重新静止校准」的前置要求', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [6, -4, 9], 50);
  assert.doesNotMatch(st.bias.status, /请手动|手动校准|需重新静止校准|触界/);
  assert.doesNotMatch(h.elements.get('irBias-l').title, /请手动|触界/);
});

test('20/50/100 Hz 的 5 秒自动初始化结果一致（50 Hz 为主验收）', () => {
  const values = [20, 50, 100].map((hz) => {
    const h = harness(), st = h.state();
    h.observe(st, 5000, [6, -4, 9], hz);
    assert.equal(st.bias.ready, true);
    return st.bias.g.slice();
  });
  for (const value of values) close(value, [6, -4, 9], 1e-9);
});

test('左右脚各自自动，互不串补偿', () => {
  const h = harness(), left = h.state('l'), right = h.state('r');
  for (let t = 20; t <= 5020; t += 20) {
    h.frame(left, t, [0.1, 0, 0]);
    h.frame(right, t, [0.3, 0, 0]);
  }
  close(left.bias.g, [0.1, 0, 0]);
  close(right.bias.g, [0.3, 0, 0]);
  assert.equal(left.bias.mode, 'dynamic');
  assert.equal(right.bias.mode, 'dynamic');
});

test('自动流程完全不创建后台定时器', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0, 0, 0], 50);
  for (let i = 0; i < 10; i++) h.observe(st, 3000, [0.1, 0, 0], 50);
  h.api.irBiasReset(st);
  assert.equal(h.timers.size, 0);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
console.log(`\nAuto bias acceptance: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
