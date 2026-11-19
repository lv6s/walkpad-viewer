'use strict';

/* 网页自动零偏补偿的算法验收（50 Hz 为主采样率，20/100 Hz 只做时间一致性边界）。
   合同：初始化 5 s / 50 独立帧；跟踪 3 s / 30 帧；陀螺 std .12 / range .56 /
   首尾向量 .14；加速度 std .01 / range .04 / 模长 .08 / 首尾 .02；
   raw 陀螺每轴 <=40 只是数值护栏；tracking alpha = 1-exp(-dt/10 s)，
   delta 向量限速 .5 °/s/s，无累计界、无固定锚冻结。
   恒速转动与常量偏置在六轴上不可区分，允许被吸收——本文件明确展示这一物理局限。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../js/insole-proto.js');
const source = fs.readFileSync(filename, 'utf8');
const BASE = 1800000000000;

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
  /* 一段从 now+step 到 now+ms 的连续窗口：首帧在开头，末帧正好跨满 ms。 */
  function observe(st, ms, g, hz = 50, options = {}) {
    const step = 1000 / hz, start = now + step, n = Math.round(ms / step);
    for (let i = 0; i <= n; i++) {
      const t = start + i * step;
      frame(st, t, typeof g === 'function' ? g(i, t) : g,
        typeof options === 'function' ? options(i, t) : options);
    }
  }
  function init(st, g = [0, 0, 0], hz = 50) {
    observe(st, 5000, g, hz);
    assert.equal(st.bias.ready, true, '5 s 静止应自动初始化');
    return st.bias.g.slice();
  }
  return { api, state, frame, observe, init, advance, timers, elements, now: () => now };
}

function close(actual, expected, eps = 1e-9) {
  expected.forEach((v, k) => assert.ok(Math.abs(actual[k] - v) <= eps, `axis ${k}: ${actual[k]} != ${v}`));
}
function vectorClose(actual, expected, eps = 1e-9) {
  assert.ok(Math.hypot(...actual.map((v, k) => v - expected[k])) <= eps, actual + ' != ' + expected);
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const ALPHA3 = 1 - Math.exp(-3 / 10);

test('默认就是自动模式：未静止前不学习、不创建定时器、补偿值为零', () => {
  const h = harness(), st = h.state();
  assert.equal(st.bias.mode, 'dynamic');
  assert.equal(st.bias.ready, false);
  close(st.bias.g, [0, 0, 0]);
  assert.match(st.bias.status, /未就绪|静止/);
  h.api.irBiasText(st);
  assert.match(h.elements.get('irBias-l').title, /原始角速度/);
  assert.equal(h.timers.size, 0);
});

test('50 Hz 静止 5 秒自动初始化，不需要 Start 或切模式', () => {
  const h = harness(), st = h.state();
  h.observe(st, 4980, [6.02, -4.06, 9.03], 50);
  assert.equal(st.bias.ready, false, '差 20 ms 不能提前就绪');
  h.frame(st, h.now() + 20, [6.02, -4.06, 9.03]);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [6.02, -4.06, 9.03]);
  assert.equal(st.bias.anchor, null, '自动初始化不建立固定锚');
  assert.equal(st.bias.boundary, false);
  assert.equal(st.bias.dynamic.rows.length, 0);
  assert.equal(h.timers.size, 0);
});

test('时间够但不足 50 个独立帧不初始化，补到第 50 帧立即就绪', () => {
  const h = harness(), st = h.state(), g = [0.2, -0.1, 0.1];
  for (let i = 0; i < 49; i++) h.frame(st, i * 110, g);
  assert.ok(h.now() > 5000);
  assert.equal(st.bias.ready, false, '49 帧即使超过 5 秒也不够');
  h.frame(st, 49 * 110, g);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, g);
});

test('5 秒内 49 个独立帧不能初始化，正好 5 秒的第 50 帧才成功', () => {
  const h = harness(), st = h.state(), g = [0.2, -0.1, 0.1];
  h.frame(st, 0, g);
  for (let t = 100; t <= 4800; t += 100) h.frame(st, t, g);
  assert.equal(st.bias.ready, false);
  h.frame(st, 4900, g);
  assert.equal(st.bias.ready, false);
  h.frame(st, 5000, g);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, g);
});

test('大初偏 [6,-4,9] 在 50 Hz 直接自动初始化，没有 .35 °/s 限制', () => {
  const h = harness(), st = h.state();
  close(h.init(st, [6, -4, 9]), [6, -4, 9]);
  assert.match(st.bias.status, /已初始化/);
  assert.doesNotMatch(st.bias.status, /手动|偏置较大|请校准/);
});

test('恒速转动可被当成初偏吸收（物理局限，明确展示而非假断言拒绝）', () => {
  const h = harness(), st = h.state();
  close(h.init(st, [5, 0, 0]), [5, 0, 0]);
  h.api.irBiasText(st);
  assert.match(h.elements.get('irBias-l').title, /匀速|恒速|匀转/);
});

test('已就绪后恒定 1.4 °/s 转动会被慢速吸收，限速 .5 °/s/s 生效', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, [1.4, 0, 0]);
  const expected = 1.4 * ALPHA3;
  assert.ok(expected < 0.5 * 3, '单窗增量应小于限速上限');
  close(st.bias.g, [expected, 0, 0]);
  assert.match(st.bias.status, /已更新/);
  h.api.irBiasText(st);
  assert.match(h.elements.get('irBias-l').title, /匀速|恒速|匀转/);
});

test('跟踪 alpha = 1-exp(-dt/10 s)，两个不重叠窗口各积分一次', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, [0.1, 0, 0]);
  close(st.bias.g, [0.1 * ALPHA3, 0, 0]);
  h.observe(st, 3000, [0.1, 0, 0]);
  close(st.bias.g, [0.1 * (1 - Math.exp(-0.6)), 0, 0]);
});

test('delta 向量限速 .5 °/s/s：3 秒大残差最多只走 1.5 °/s', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, [10, 0, 0]);
  close(st.bias.g, [1.5, 0, 0]);
  h.observe(st, 3000, [10, 0, 0]);
  close(st.bias.g, [3, 0, 0]);
});

test('无累计界、无固定锚：偏置可越过原 .28 并长期继续跟随，永不触界冻结', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  for (let i = 0; i < 60; i++) h.observe(st, 3000, [0.6, 0, 0]);
  assert.ok(st.bias.g[0] > 0.59, String(st.bias.g[0]));
  assert.ok(st.bias.g[0] > 0.28);
  assert.equal(st.bias.boundary, false);
  assert.equal(st.bias.anchor, null);
  assert.doesNotMatch(st.bias.status, /触界|需重新静止校准|请手动校准/);
  const before = st.bias.g[0];
  h.observe(st, 3000, [0.6, 0, 0]);
  assert.ok(st.bias.g[0] > before, '触界语义已移除，必须继续更新');
});

test('初始化遇到持续角速度缓变不成功，停稳后自动恢复且无需用户操作', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, (i) => [0.6 * i / 250, 0, 0], 50);
  assert.equal(st.bias.ready, false);
  assert.match(st.bias.status, /变化|首尾/);
  h.observe(st, 5000, [0.6, 0, 0]);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [0.6, 0, 0]);
});

test('初始化遇到持续振荡不成功，停稳后自动恢复', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, (i) => [i % 25 < 13 ? 0.2 : -0.2, 0, 0], 50);
  assert.equal(st.bias.ready, false);
  assert.match(st.bias.status, /窗口变化/);
  h.observe(st, 5000, [0.2, 0, 0]);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [0.2, 0, 0]);
});

test('末段才出现的运动不会被整窗低残差掩盖', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, (i) => (i < 200 ? [0, 0, 0] : [0.6, 0, 0]), 50);
  assert.equal(st.bias.ready, false);
  assert.match(st.bias.status, /变化|首尾/);
});

test('逐帧加速度模长门：1.09 g 不进入初始化候选', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0, 0, 0], 50, { a: [0, 0, 1.09] });
  assert.equal(st.bias.ready, false);
  assert.match(st.bias.status, /加速度|重力|数据/);
});

test('加速度方向抖动（模长仍为 1）按变化拒绝，不能只靠模长判断静止', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0, 0, 0], 50, (i) => {
    const x = i % 2 ? 0.05 : -0.05;
    return { a: [x, 0, Math.sqrt(1 - x * x)] };
  });
  assert.equal(st.bias.ready, false);
  assert.match(st.bias.status, /窗口变化/);
});

test('加速度单帧尖峰也会让窗口变化超限', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0, 0, 0], 50, (i) => {
    const x = i === 100 ? 0.05 : 0;
    return { a: [x, 0, Math.sqrt(1 - x * x)] };
  });
  assert.equal(st.bias.ready, false);
  assert.match(st.bias.status, /窗口变化/);
});

test('运动期间 ready=false 时补偿值保持 0，界面取用只能显示原始角速度', () => {
  const h = harness(), st = h.state();
  h.observe(st, 2000, (i) => [i % 2 ? 1 : -1, 0, 0], 50);
  assert.equal(st.bias.ready, false);
  close(st.bias.g, [0, 0, 0]);
  assert.match(st.bias.status, /未就绪/);
});

test('跟踪阶段的单帧陀螺尖峰（range>.56）拒绝候选并保留补偿', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, (i) => [i === 75 ? 0.6 : 0, 0, 0], 50);
  close(st.bias.g, [0, 0, 0]);
  assert.match(st.bias.status, /窗口变化/);
  h.observe(st, 3000, [0.1, 0, 0]);
  close(st.bias.g, [0.1 * ALPHA3, 0, 0]);
});

test('跟踪阶段均值为零的快速振荡不移动补偿（std 未过门时靠零均值自限）', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, (i) => [i % 2 ? 0.2 : -0.2, 0, 0], 50);
  close(st.bias.g, [0, 0, 0], 1e-6);
  assert.match(st.bias.status, /已更新|窗口变化/);
});

test('跟踪阶段 3 秒内 0→0.2 的缓慢爬升按时间均值部分吸收，不是跳变', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, (i) => [0.2 * i / 150, 0, 0], 50);
  close(st.bias.g, [0.1 * ALPHA3, 0, 0], 1e-6);
  assert.match(st.bias.status, /已更新/);
});

test('跟踪阶段加速度首尾方向变化 .02 拒绝', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, [0, 0, 0], 50, (i) => {
    const x = 0.03 * i / 150;
    return { a: [x, 0, Math.sqrt(1 - x * x)] };
  });
  close(st.bias.g, [0, 0, 0]);
  assert.match(st.bias.status, /首尾|加速度/);
});

test('跟踪阶段加速度 std>.01 拒绝', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, [0, 0, 0], 50, (i) => {
    const x = i % 2 ? 0.02 : -0.02;
    return { a: [x, 0, Math.sqrt(1 - x * x)] };
  });
  close(st.bias.g, [0, 0, 0]);
  assert.match(st.bias.status, /窗口变化/);
});

test('raw 陀螺每轴 40 °/s 是数值护栏：40.01 立即清候选且不当作运动学习', () => {
  const h = harness(), st = h.state();
  h.init(st, [0.1, 0, 0]);
  h.observe(st, 500, [0.1, 0, 0]);
  assert.ok(st.bias.still > 0);
  h.frame(st, h.now() + 20, [40.01, 0, 0]);
  assert.equal(st.bias.still, 0);
  close(st.bias.g, [0.1, 0, 0]);
  assert.match(st.bias.status, /数值保护/);
});

test('恒定 10 °/s 不被“离 0 太远”判成运动：仍按限速慢吸收', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.observe(st, 3000, [10, 0, 0]);
  close(st.bias.g, [1.5, 0, 0]);
  assert.doesNotMatch(st.bias.status, /瞬时运动|窗口变化|固定锚/);
});

for (const [name, inject] of [
  ['陀螺 NaN', (h, st) => h.frame(st, h.now() + 20, [NaN, 0, 0])],
  ['加速度 Infinity', (h, st) => h.frame(st, h.now() + 20, [0, 0, 0], { a: [0, Infinity, 1] })],
  ['raw6 饱和', (h, st) => h.frame(st, h.now() + 20, [0, 0, 0], { raw6: [0, 0, 2048, 32767, 0, 0] })],
  ['帧序号跳号', (h, st) => { st.testSeq += 1; h.frame(st, h.now() + 20, [0.1, 0, 0]); }],
  ['主机间隔 251 ms', (h, st) => h.frame(st, h.now() + 251, [0.1, 0, 0])],
  ['主机时钟倒退', (h, st) => h.frame(st, h.now() - 1, [0.1, 0, 0])],
  ['设备时钟倒退', (h, st) => h.frame(st, h.now() + 20, [0.1, 0, 0], { clk: { epoch: BASE + h.now() - 1000 } })],
  ['设备时钟前跳 251 ms', (h, st) => h.frame(st, h.now() + 20, [0.1, 0, 0], { clk: { epoch: BASE + h.now() + 251 } })]
]) {
  test(name + ' 清空候选但保留已提交补偿', () => {
    const h = harness(), st = h.state();
    h.init(st, [0, 0, 0]);
    h.observe(st, 500, [0.1, 0, 0]);
    assert.ok(st.bias.still > 0);
    inject(h, st);
    assert.equal(st.bias.still, 0);
    assert.equal(st.bias.ready, true);
    close(st.bias.g, [0, 0, 0]);
  });
}

test('重复 seq 不增加独立样本，也不能掩盖主机间隔', () => {
  const h = harness(), st = h.state();
  h.frame(st, 0, [0.1, 0, 0]);
  for (let i = 1; i <= 300; i++) h.frame(st, i * 20, [0.1, 0, 0], { seq: 0 });
  assert.equal(st.bias.still, 1);
  assert.equal(st.bias.ready, false);
  st.testSeq = 1;
  h.frame(st, 6020, [0.1, 0, 0]);
  assert.equal(st.bias.still, 0);
});

test('同一主机时刻的突发帧不能制造独立样本或 5 秒时长', () => {
  const h = harness(), st = h.state();
  for (let i = 0; i < 2000; i++) h.frame(st, 0, [0.1, 0, 0], { clk: { epoch: BASE + i } });
  assert.equal(st.bias.ready, false);
  assert.equal(st.bias.still, 1);
});

test('候选窗口有上限：超长时清空候选且不学习，内存不无限增长', () => {
  const h = harness(), st = h.state();
  h.frame(st, 0, [0.1, 0, 0]);
  for (let i = 1; i <= 16500; i++) h.frame(st, i * 0.01, [0.1, 0, 0]);
  assert.equal(st.bias.ready, false);
  close(st.bias.g, [0, 0, 0]);
  assert.ok(st.bias.dynamic.rows.length <= 16384, String(st.bias.dynamic.rows.length));
});

test('非均匀采样：密集静止突发不能稀释时间域上的真实运动', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  const start = h.now();
  for (let i = 1; i <= 1000; i++) h.frame(st, start + i * 0.1, [0, 0, 0]);
  for (let t = 100; t <= 3000; t += 100) {
    const value = 0.5 * (t - 100) / 2900;
    h.frame(st, start + t, [value, 0, 0]);
  }
  close(st.bias.g, [0, 0, 0], 1e-6);
  assert.match(st.bias.status, /采样中|窗口变化|首尾/);
});

test('seq uint32 回绕仍连续，5 秒可正常初始化', () => {
  const h = harness(), st = h.state();
  st.testSeq = 0xfffffff0;
  h.observe(st, 5000, [0.1, 0, 0], 50);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [0.1, 0, 0]);
});

test('缺设备时钟时用主机时长，5 秒仍可初始化', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0.1, 0, 0], 50, { clk: null });
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [0.1, 0, 0]);
});

test('非有限设备时钟退化为粗时钟，不阻断主机时长', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0.1, 0, 0], 50, { clk: { epoch: NaN } });
  assert.equal(st.bias.ready, true);
});

test('粗设备时钟（整秒重复）仍按主机时长 5 秒初始化', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0.1, 0, 0], 50, (i, t) => ({ clk: { epoch: BASE + Math.floor(t / 1000) * 1000 } }));
  assert.equal(st.bias.ready, true);
  assert.equal(st.bias.dynamic.rows.length, 0);
  close(st.bias.g, [0.1, 0, 0]);
});

test('细设备时钟比主机慢时，窗口成熟与积分都用较小的设备跨度', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  const start = h.now();
  /* 设备时钟每 20 ms 主机时间只走 10 ms：主机 3 秒时设备仅 1.5 秒，不得按 3 秒成熟。 */
  for (let i = 1; i <= 150; i++) {
    h.frame(st, start + i * 20, [0.1, 0, 0], { clk: { epoch: BASE + start + i * 10 } });
  }
  close(st.bias.g, [0, 0, 0], 1e-9);
  /* 设备跨度凑满 3 秒（主机已 6 秒）才成熟，且只按 3 秒积分。 */
  for (let i = 151; i <= 301; i++) {
    h.frame(st, start + i * 20, [0.1, 0, 0], { clk: { epoch: BASE + start + i * 10 } });
  }
  close(st.bias.g, [0.1 * (1 - Math.exp(-3 / 10)), 0, 0], 1e-6);
});

test('已建立的粗时钟遇到 5 秒设备前跳仍清候选', () => {
  const h = harness(), st = h.state();
  h.observe(st, 2000, [0.1, 0, 0], 50, (i, t) => ({ clk: { epoch: BASE + Math.floor(t / 1000) * 1000 } }));
  const before = st.bias.still;
  assert.ok(before > 0);
  h.frame(st, h.now() + 20, [0.1, 0, 0], { clk: { epoch: BASE + Math.floor(h.now() / 1000) * 1000 + 5000 } });
  assert.equal(st.bias.still, 0);
});

test('20 / 50 / 100 Hz 的 5 秒初始化结果一致', () => {
  const values = [20, 50, 100].map((hz) => {
    const h = harness(), st = h.state();
    h.observe(st, 5000, [6, -4, 9], hz);
    assert.equal(st.bias.ready, true, hz + ' Hz 应就绪');
    return st.bias.g.slice();
  });
  for (const value of values) vectorClose(value, values[0], 1e-9);
  vectorClose(values[0], [6, -4, 9], 1e-9);
});

test('20 / 50 / 100 Hz 单窗跟踪结果一致（按实际时间而非帧数）', () => {
  const values = [20, 50, 100].map((hz) => {
    const h = harness(), st = h.state();
    h.init(st, [0, 0, 0], 50);
    h.observe(st, 3000, [0.1, 0, 0], hz);
    return st.bias.g[0];
  });
  close(values, [values[0], values[0], values[0]], 1e-9);
  assert.ok(Math.abs(values[0] - 0.1 * ALPHA3) < 1e-9);
});

test('20 / 50 / 100 Hz 长时间跟踪收敛一致', () => {
  const values = [20, 50, 100].map((hz) => {
    const h = harness(), st = h.state();
    h.init(st, [0, 0, 0], 50);
    for (let i = 0; i < 40; i++) h.observe(st, 3000, [0.1, 0, 0], hz);
    return st.bias.g[0];
  });
  assert.ok(Math.max(...values) - Math.min(...values) < 1e-6, values.join(','));
  values.forEach((v) => assert.ok(v > 0.09999 && v < 0.1));
});

test('手动模式冻结当前补偿，不再自动学习；切回自动后从当前值继续', () => {
  const h = harness(), st = h.state();
  h.init(st, [0.2, -0.1, 0.1]);
  h.api.irBiasSetMode(st, 'manual');
  assert.equal(st.bias.mode, 'manual');
  h.observe(st, 10000, [0.5, -0.1, 0.1]);
  close(st.bias.g, [0.2, -0.1, 0.1]);
  assert.equal(st.bias.dynamic, null);
  h.api.irBiasSetMode(st, 'dynamic');
  h.observe(st, 3000, [0.2, -0.1, 0.1]);
  assert.ok(st.bias.ready);
  h.observe(st, 3000, [0.3, -0.1, 0.1]);
  assert.ok(st.bias.g[0] > 0.2, '回到自动后应重新跟随');
});

test('手动 collect 优先于自动；超时后自动跟踪自行继续', () => {
  const h = harness(), st = h.state();
  h.init(st, [0, 0, 0]);
  h.api.irBiasStart(st);
  assert.equal(st.bias.dynamic, null);
  h.observe(st, 1000, (i) => [i % 2 ? 0.9 : -0.9, 0, 0]);
  close(st.bias.g, [0, 0, 0], 1e-9);
  assert.ok(st.bias.collect);
  h.advance(h.now() + 12000);
  assert.equal(st.bias.collect, null);
  assert.match(st.bias.status, /超时/);
  h.observe(st, 3000, [0.1, 0, 0]);
  close(st.bias.g, [0.1 * ALPHA3, 0, 0]);
  assert.equal(st.bias.mode, 'dynamic');
});

test('重置回到自动模式并清空候选，5 秒后无需点击自动重建', () => {
  const h = harness(), st = h.state();
  h.init(st, [6, -4, 9]);
  h.api.irBiasReset(st);
  assert.equal(st.bias.mode, 'dynamic');
  assert.equal(st.bias.ready, false);
  assert.equal(st.bias.anchor, null);
  assert.equal(st.bias.boundary, false);
  assert.equal(st.bias.dynamic, null);
  close(st.bias.g, [0, 0, 0]);
  assert.equal(h.timers.size, 0);
  h.observe(st, 5000, [1, 2, 3]);
  assert.equal(st.bias.ready, true);
  close(st.bias.g, [1, 2, 3]);
});

test('左右脚自动/手动状态、候选和补偿互相独立', () => {
  const h = harness(), left = h.state('l'), right = h.state('r');
  for (let t = 20; t <= 5020; t += 20) {
    h.frame(left, t, [0, 0, 0]);
    h.frame(right, t, [0.2, 0, 0]);
  }
  assert.equal(left.bias.ready, true);
  assert.equal(right.bias.ready, true);
  h.api.irBiasSetMode(right, 'manual');
  h.observe(left, 3000, [0.1, 0, 0]);
  h.observe(right, 3000, [0.2, 0, 0]);
  close(left.bias.g, [0.1 * ALPHA3, 0, 0]);
  close(right.bias.g, [0.2, 0, 0]);
  assert.equal(left.bias.mode, 'dynamic');
  assert.equal(right.bias.mode, 'manual');
});

test('自动流程不创建后台定时器；只有手动 collect 才有超时定时器', () => {
  const h = harness(), st = h.state();
  h.observe(st, 5000, [0.1, 0, 0]);
  h.observe(st, 3000, [0.15, 0, 0]);
  assert.equal(h.timers.size, 0);
  h.api.irBiasStart(st);
  assert.equal(h.timers.size, 1);
  h.api.irBiasReset(st);
  assert.equal(h.timers.size, 0);
});

test('状态文案诚实披露恒速转动风险，且不再出现触界/请手动校准的话术', () => {
  const h = harness(), st = h.state();
  h.init(st, [6, -4, 9]);
  const title = h.elements.get('irBias-l').title;
  assert.match(title, /匀速|恒速|匀转/);
  assert.match(title, /误判|无法区分|不能区分/);
  assert.doesNotMatch(title, /触界|0\.28|0\.14/);
  assert.doesNotMatch(st.bias.status, /触界|请手动校准/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
console.log(`\nDynamic bias: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
