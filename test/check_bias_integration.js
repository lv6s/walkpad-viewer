'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
let passed = 0;

function harness(realQuery = false) {
  let now = 100, nextTimer = 1, uid = 0;
  const timers = new Map(), elements = new Map();
  const el = (id, foot) => {
    const key = id + ':' + (foot || '');
    if (!elements.has(key)) elements.set(key, { textContent: '', title: '', value: '', disabled: false });
    return elements.get(key);
  };
  const context = vm.createContext({
    console, TextDecoder, Uint8Array, Int8Array, Float32Array, Float64Array, DataView,
    performance: { now: () => now, timeOrigin: 1000000 },
    setTimeout: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => 1, clearInterval: () => {},
    $: el, log: () => {}, ulid: () => 'test-' + ++uid, irCur: 'l', navigator: { bluetooth: {} },
    prReset: () => {}, irHead: () => {}, irDraw: () => {}, irPressDraw: () => {},
    pwDraw: () => {}, prNums: () => {}, pwPush: () => {}, sha256Hex: () => 'test-hash',
    hexOf: (bytes) => Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join(' '),
    irFmtText: () => {}, window: {}
  });
  const proto = fs.readFileSync(path.join(ROOT, 'js/insole-proto.js'), 'utf8');
  const exp = fs.readFileSync(path.join(ROOT, 'js/insole-export.js'), 'utf8');
  vm.runInContext(proto + '\n' + exp + `
    ${realQuery ? '' : 'irQueryState = async () => {};'}
    globalThis.api = { irBiasStart, irBiasTrack, irBiasReset, irBiasCancel, irBiasSetMode,
      irStates, irFrame, irFramesRows, irParquetColumns, irConnect, irClose, irGone, irSend, irProbe };
  `, context);
  return { W: context.api, context, timers, el, advance: (dt) => { now += dt; } };
}
function panelHarness() {
  const html = fs.readFileSync(path.join(ROOT, 'wt901ble_live.html'), 'utf8');
  const template = html.match(/<template[^>]*id="irPanelTpl"[^>]*>([\s\S]*?)<\/template>/);
  assert.ok(template, 'panel template must exist');
  const elements = new Map();
  const parse = (source) => {
    for (const match of source.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const element = {
        id: match[3], textContent: '', title: match[2].match(/\btitle="([^"]*)"/)?.[1] || '',
        value: '', style: {}, disabled: /\bdisabled\b/.test(match[2]),
        classList: { toggle() {}, add() {}, remove() {} }, dataset: {},
        addEventListener() {}, appendChild() {},
        set innerHTML(value) { this.markup = value; parse(value); },
        get innerHTML() { return this.markup || ''; }
      };
      if (match[1] === 'select') {
        const body = source.slice(match.index + match[0].length).split('</select>')[0];
        const options = [...body.matchAll(/<option\b([^>]*\bvalue="([^"]*)"[^>]*)>/g)];
        const selected = options.find((option) => /\bselected\b/.test(option[1])) || options[0];
        element.value = selected ? selected[2] : '';
      }
      elements.set(element.id, element);
    }
  };
  parse(html.replace(template[0], '<template id="irPanelTpl"></template>'));
  elements.get('irPanelTpl').markup = template[1];
  let approve = false;
  const confirmations = [];
  const context = vm.createContext({
    console, performance: { now: () => 100 }, window: { addEventListener() {} },
    document: { getElementById: (id) => elements.get(id) || null,
      createElement: () => ({ dataset: {}, set innerHTML(value) { parse(value); } }) },
    confirm: (message) => { confirmations.push(message); return approve; },
    setTimeout: () => 1, clearTimeout() {}, ulid: () => 'test-id', updateBtns() {}, irParquet() {}
  });
  const source = ['js/core.js', 'js/insole-proto.js', 'js/insole-ui.js']
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n;\n');
  vm.runInContext(source + `
    log = () => {};
    irRenderPanels();
    for (const foot of IR_SIDES) irBindPanel(foot);
    globalThis.api = { irStates, irHead, irBiasSetMode, irBiasStart, irBiasTrack, irBiasReset, irBiasText, $ };
  `, context);
  return { W: context.api, context, elements, html, confirmations, approve: (value) => { approve = value; } };
}
function near(actual, expected, eps = 1e-9) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < eps, `${v} != ${expected[i]}`));
}
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
class Emitter {
  constructor() { this.events = new Map(); }
  addEventListener(name, fn) {
    if (!this.events.has(name)) this.events.set(name, new Set());
    this.events.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
  emit(name, event = { target: this }) { for (const fn of [...(this.events.get(name) || [])]) fn(event); }
  listeners(name) { return [...(this.events.get(name) || [])]; }
}
function device(name = 'W01-L', connectGate = null, writable = false) {
  const d = new Emitter(), chr = new Emitter(), write = new Emitter();
  d.name = name; chr.startNotifications = async () => chr;
  write.startNotifications = async () => write; write.properties = { notify: true };
  const service = { getCharacteristic: async (id) => {
    if (id.includes('2a37')) return chr;
    if (id.includes('ffe1') && writable) return write;
    throw Error('absent');
  } };
  d.gatt = {
    connected: false,
    async connect() { if (connectGate) await connectGate; this.connected = true; return this; },
    async getPrimaryService(id) { if (id.includes('180d')) return service; throw Error('absent'); },
    disconnect() { this.connected = false; d.emit('gattserverdisconnected'); }
  };
  return { d, chr, write };
}
function frame(seq, raw = [0, 0, 2048, 100, 200, 300]) {
  const f = new Uint8Array(46), dv = new DataView(f.buffer);
  f.set([0x5a, 0, 9]); dv.setUint32(3, seq >>> 0, true);
  raw.forEach((v, i) => dv.setInt16(17 + i * 2, v, true));
  let crc = 0xffff;
  for (let i = 0; i < 138; i++) {
    crc ^= (i < 44 ? f[i] : 0) << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  dv.setUint16(44, crc, true);
  return f;
}
const notify = (chr, f) => chr.emit('characteristicvaluechanged', { target: { value: new DataView(f.buffer) } });
function stream(h, chr, first, count, raw, step = 20) {
  for (let i = 0; i < count; i++) { notify(chr, frame(first + i, raw)); h.advance(step); }
}
const gyro0 = (sample) => [sample.gx0, sample.gy0, sample.gz0];
const shownGyro = (sample) => [sample.gx, sample.gy, sample.gz];

(async () => {
  await test('真实元素路由和左右脚校准按钮能完成绑定', () => {
    const html = fs.readFileSync(path.join(ROOT, 'wt901ble_live.html'), 'utf8');
    const template = html.match(/<template[^>]*id="irPanelTpl"[^>]*>([\s\S]*?)<\/template>/);
    assert.ok(template, 'panel template must exist');
    const elements = new Map();
    for (const foot of ['l', 'r']) {
      for (const match of template[1].matchAll(/id="([^"]+)"/g)) {
        elements.set(match[1].replace(/-FT/g, '-' + foot), { addEventListener() {}, classList: { toggle() {} } });
      }
    }
    let confirmCount = 0, approve = false;
    const context = vm.createContext({
      console, performance: { now: () => 0 }, window: { addEventListener() {} },
      document: { getElementById: (id) => elements.get(id) || null },
      confirm: () => { confirmCount++; return approve; },
      setTimeout: () => 1, clearTimeout() {},
      ulid: () => 'test-id', updateBtns() {}, irParquet() {},
    });
    const source = ['js/core.js', 'js/insole-proto.js', 'js/insole-ui.js']
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n;\n');
    vm.runInContext(source + `
      log = () => {};
      for (const foot of IR_SIDES) {
        irStates[foot].dev = { gatt: { connected: true } };
        irBindPanel(foot);
        if ($('btnBiasCal', foot) !== document.getElementById('btnBiasCal-' + foot)) throw Error('wrong button route');
        $('btnBiasCal', foot).onclick();
      }
    `, context);
    assert.equal(confirmCount, 2);
    vm.runInContext(`
      if (irStates.l.bias.collect || irStates.r.bias.collect) throw Error('cancelled confirmation must not start calibration');
    `, context);
    approve = true;
    vm.runInContext(`
      $('btnBiasCal', 'r').onclick();
      if (!irStates.r.bias.collect || irStates.l.bias.collect) throw Error('calibration must target right foot only');
      $('btnBiasReset', 'r').onclick();
      if (irStates.r.bias.collect || irStates.r.bias.ready) throw Error('reset must cancel calibration');
      irStates.r.dev.gatt.connected = false;
      $('btnBiasCal', 'r').onclick();
      if (irStates.r.bias.collect) throw Error('disconnected foot must not start calibration');
    `, context);
    assert.equal(confirmCount, 3);
    assert.equal(typeof elements.get('btnBiasReset-l').onclick, 'function');
    assert.equal(typeof elements.get('btnBiasReset-r').onclick, 'function');
  });
  await test('首尾比较按真实时间划分，不被中段密集帧稀释', () => {
    const h = harness(), st = h.W.irStates.l; h.W.irBiasSetMode(st, 'manual'); h.W.irBiasStart(st);
    let seq = 0, previous = 0;
    const sample = (t, g) => {
      h.advance(t - previous); previous = t;
      h.W.irBiasTrack(st, { seq: seq++, gx0: g, gy0: 0, gz0: 0, ax: 0, ay: 0, az: 1, clk: { epoch: 100000 + t } });
    };
    for (let t = 0; t <= 900; t += 100) sample(t, 0);
    for (let t = 1000; t < 2000; t++) sample(t, .4);
    for (let t = 2000; t <= 3000; t += 100) sample(t, .8);
    assert.equal(st.bias.ready, false); assert.ok(st.bias.collect);
  });
  await test('真实解帧只改显示，导出与raw6保留设备原值', () => {
    const h = harness(), st = h.W.irStates.l;
    h.W.irBiasSetMode(st, 'manual');
    st.bias.g = [12, -8, 16]; st.bias.ready = true; st.recording = true;
    const raw = [20, 30, 2048, 100, 200, 300];
    h.W.irFrame(frame(1, raw), 'l'); h.advance(20); h.W.irFrame(frame(1, raw), 'l');
    near(st.last.raw6, raw); near([st.last.gx0, st.last.gy0, st.last.gz0], [14, -7, 21]);
    near([st.last.gx, st.last.gy, st.last.gz], [2, 1, 5]);
    assert.equal(st.rec.length, 2);
    const rows = h.W.irFramesRows().rows;
    near(rows[0].phy, [30 / 2048, -20 / 2048, 1, 14, -7, 21]);
    const cols = h.W.irParquetColumns().cols;
    near(cols.find((c) => c.name === 'imu_raw_values').data[0], raw);
    near(cols.find((c) => c.name === 'imu_physical_values').data[0], rows[0].phy);
  });
  await test('通过真实BLE通知完成手动校准，随后真实转动不被吸收', async () => {
    const h = harness(), { d, chr } = device(); await h.W.irConnect(d, 'l');
    const st = h.W.irStates.l; st.recording = true; h.W.irBiasSetMode(st, 'manual'); h.W.irBiasStart(st);
    for (let i = 0; i <= 150; i++) { notify(chr, frame(i)); h.advance(20); }
    assert.equal(st.bias.ready, true); near(st.bias.g, [14, -7, 21]);
    near([st.last.gx, st.last.gy, st.last.gz], [0, 0, 0]);
    for (let i = 151; i < 600; i++) { notify(chr, frame(i, [0, 0, 2048, 100, 200, 320])); h.advance(20); }
    near(st.bias.g, [14, -7, 21]); assert.ok(Math.abs(st.last.gz - 1.4) < 1e-9);
    const rows = h.W.irFramesRows().rows;
    assert.equal(rows.length, 600); assert.ok(Math.abs(rows[599].phy[5] - 22.4) < 1e-9);
    h.W.irClose('l');
  });
  await test('自然断连与主动断连清补偿且无空设备异常', async () => {
    const h = harness(), { d, chr } = device(); await h.W.irConnect(d, 'l');
    const st = h.W.irStates.l; st.bias.g = [1, 2, 3]; st.bias.ready = true; h.W.irBiasStart(st);
    d.gatt.disconnect(); assert.equal(st.bias.ready, false); assert.equal(st.bias.collect, null);
    assert.equal(st.bias.mode, 'dynamic');
    assert.equal(chr.listeners('characteristicvaluechanged').length, 0);
    h.W.irClose('l'); h.W.irClose('l'); assert.equal(h.timers.size, 0);
  });
  await test('重连隔离旧设备通知和断开事件', async () => {
    const h = harness(), first = device(), second = device(); await h.W.irConnect(first.d, 'l');
    const oldNotify = first.chr.listeners('characteristicvaluechanged')[0];
    const oldGone = first.d.listeners('gattserverdisconnected')[0];
    h.W.irClose('l'); await h.W.irConnect(second.d, 'l');
    const st = h.W.irStates.l; h.W.irBiasStart(st);
    oldNotify({ target: { value: new DataView(frame(1).buffer) } }); oldGone();
    assert.equal(st.dev, second.d); assert.ok(st.bias.collect); assert.equal(st.frames, 0);
    notify(second.chr, frame(1)); assert.equal(st.frames, 1);
    h.W.irClose('l');
  });
  await test('连接后不自动发送 0x0D 状态查询', async () => {
    const h = harness(true), { d, write } = device('W01-L', null, true);
    let writes = 0;
    write.writeValueWithoutResponse = async () => { writes++; };
    await h.W.irConnect(d, 'l');
    assert.equal(writes, 0);
    assert.equal(h.W.irStates.l.wait, null);
  });
  await test('相同设备重连不累积通知和断开监听器', async () => {
    const h = harness(), { d, chr, write } = device('W01-L', null, true);
    for (let i = 0; i < 3; i++) {
      await h.W.irConnect(d, 'l');
      assert.equal(chr.listeners('characteristicvaluechanged').length, 1);
      assert.equal(write.listeners('characteristicvaluechanged').length, 1);
      assert.equal(d.listeners('gattserverdisconnected').length, 1);
      h.W.irClose('l');
      assert.equal(chr.listeners('characteristicvaluechanged').length, 0);
      assert.equal(write.listeners('characteristicvaluechanged').length, 0);
      assert.equal(d.listeners('gattserverdisconnected').length, 0);
    }
  });
  await test('尚未完成的旧连接不能覆盖新连接', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const h = harness(), first = device('W01-L', gate), second = device('W01-L');
    const pending = h.W.irConnect(first.d, 'l'); h.W.irClose('l');
    await h.W.irConnect(second.d, 'l'); release(); await pending;
    assert.equal(h.W.irStates.l.dev, second.d);
    assert.equal(first.chr.listeners('characteristicvaluechanged').length, 0);
    assert.equal(first.d.gatt.connected, false);
    h.W.irClose('l');
  });
  await test('订阅前清理旧补偿并正常接收后续数据', async () => {
    const h = harness(), dev = device(), st = h.W.irStates.l;
    st.bias.g = [12, -8, 16]; st.bias.ready = true;
    dev.chr.startNotifications = async () => {
      near(st.bias.g, [0, 0, 0]); assert.equal(st.bias.ready, false);
      return dev.chr;
    };
    await h.W.irConnect(dev.d, 'l'); notify(dev.chr, frame(1));
    assert.equal(st.frames, 1); near([st.last.gx, st.last.gy, st.last.gz], [14, -7, 21]);
    h.W.irClose('l');
  });
  await test('连接失败不保留候选与有效补偿', async () => {
    const h = harness(), { d } = device(), st = h.W.irStates.l;
    st.bias.g = [1, 2, 3]; st.bias.ready = true;
    d.gatt.connect = async () => { throw Error('connection failed'); };
    await h.W.irConnect(d, 'l');
    near(st.bias.g, [0, 0, 0]); assert.equal(st.bias.ready, false);
    assert.equal(st.bias.collect, null); assert.equal(st.chr, null);
    assert.equal(d.listeners('gattserverdisconnected').length, 0);
  });
  for (const outcome of ['resolve', 'reject']) await test('旧命令写入' + outcome + '不能清理或写入新连接', async () => {
    const h = harness(), old = device('W01-L', null, true), fresh = device('W01-L', null, true);
    await h.W.irConnect(old.d, 'l');
    const st = h.W.irStates.l;
    let resolveWrite, rejectWrite;
    old.write.writeValueWithoutResponse = () => new Promise((resolve, reject) => {
      resolveWrite = resolve; rejectWrite = reject;
    });
    h.el('dvLink', 'l').value = 'auto';
    const oldResult = h.W.irProbe(st, 0x0d, null, 1200).then(() => null, (e) => e);
    h.W.irClose('l'); await h.W.irConnect(fresh.d, 'l');
    let newWrites = 0;
    fresh.write.writeValueWithoutResponse = async () => { newWrites++; };
    const newResult = h.W.irSend(st, 0x0d, null, 1200).then(() => null, (e) => e);
    const wait = st.wait;
    if (outcome === 'resolve') resolveWrite(); else rejectWrite(Error('late write error'));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(st.wait, wait); assert.equal(newWrites, 1);
    assert.equal((await oldResult).cancelled, true);
    h.W.irClose('l'); assert.equal((await newResult).cancelled, true);
  });
  await test('旧连接的状态查询写失败不会向新设备发送fallback', async () => {
    const h = harness(true), old = device('W01-L', null, true), fresh = device('W01-L', null, true);
    let rejectOld, oldWrites = 0, freshWrites = 0;
    old.write.writeValueWithoutResponse = () => {
      oldWrites++;
      return new Promise((resolve, reject) => { rejectOld = reject; });
    };
    fresh.write.writeValueWithoutResponse = async () => { freshWrites++; };
    h.el('dvLink', 'l').value = 'auto';
    await h.W.irConnect(old.d, 'l');
    const st = h.W.irStates.l;
    const oldResult = h.W.irProbe(st, 0x0d, null, 1200).then(() => null, (e) => e);
    assert.equal(oldWrites, 1);
    h.W.irClose('l'); await h.W.irConnect(fresh.d, 'l');
    const freshResult = h.W.irSend(st, 0x0d, null, 1200).then(() => null, (e) => e);
    const pending = st.wait;
    assert.ok(pending); h.W.irBiasStart(st);
    rejectOld(Error('late query write failure'));
    for (let i = 0; i < 16; i++) await Promise.resolve();
    assert.equal(st.wait, pending); assert.equal(freshWrites, 1); assert.ok(st.bias.collect);
    assert.equal((await oldResult).cancelled, true);
    h.W.irClose('l'); assert.equal((await freshResult).cancelled, true);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(h.timers.size, 0);
  });
  await test('写入长时间未完成时断开也立即结束命令等待', async () => {
    const h = harness(), { d, write } = device('W01-L', null, true);
    await h.W.irConnect(d, 'l');
    const st = h.W.irStates.l;
    write.writeValueWithoutResponse = () => new Promise(() => {});
    let settled = false;
    const result = h.W.irSend(st, 0x0d, null, 1200).then(() => null, (e) => { settled = true; return e; });
    h.W.irClose('l');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(settled, true); assert.equal((await result).cancelled, true);
    assert.equal(st.wait, null); assert.equal(h.timers.size, 0);
  });
  await test('左脚断开不取消右脚校准或数据流', async () => {
    const h = harness(), left = device('W01-L'), right = device('W01-R');
    await h.W.irConnect(left.d, 'l'); await h.W.irConnect(right.d, 'r');
    const r = h.W.irStates.r; h.W.irBiasStart(r); h.W.irClose('l');
    assert.ok(r.bias.collect); assert.equal(right.d.gatt.connected, true);
    notify(right.chr, frame(1)); assert.equal(r.frames, 1); assert.equal(r.bias.still, 1);
    h.W.irClose('r');
  });
  await test('真实双面板默认自动、离线拒绝、切换模式不再确认', () => {
    const h = panelHarness(), { W } = h;
    for (const foot of ['l', 'r']) {
      const mode = h.elements.get('irBiasMode-' + foot);
      assert.ok(mode, 'HTML must render a distinct mode element for ' + foot);
      assert.equal(W.$('irBiasMode', foot), mode);
      assert.equal(typeof mode.onchange, 'function');
      assert.equal(W.irStates[foot].bias.mode, 'dynamic');
      assert.equal(mode.value, 'dynamic');
    }
    W.irHead();
    for (const foot of ['l', 'r']) assert.equal(W.$('irBiasMode', foot).disabled, true);
    const mode = W.$('irBiasMode', 'l');
    mode.value = 'manual'; mode.onchange();
    assert.equal(W.irStates.l.bias.mode, 'dynamic');
    assert.equal(mode.value, 'dynamic');
    assert.equal(h.confirmations.length, 0, '离线选择必须在任何确认之前被拒绝');
    for (const foot of ['l', 'r']) W.irStates[foot].dev = { gatt: { connected: true } };
    W.irHead();
    for (const foot of ['l', 'r']) assert.equal(W.$('irBiasMode', foot).disabled, false);
    W.$('irBiasMode', 'r').value = 'manual'; W.$('irBiasMode', 'r').onchange();
    assert.equal(W.irStates.r.bias.mode, 'manual');
    assert.equal(W.irStates.l.bias.mode, 'dynamic');
    assert.equal(h.confirmations.length, 0, '切换模式不得再弹确认');
    const warnsInitialization = (text) => /匀转|匀速|恒速/.test(text)
      && /误|不可分|无法区分|不能区分/.test(text) && /自动/.test(text);
    for (const foot of ['l', 'r']) {
      assert.ok(warnsInitialization(W.$('irBias', foot).title), 'status title must disclose rotation ambiguity');
    }
    assert.ok(warnsInitialization(h.html), 'HTML must disclose rotation ambiguity');
  });
  await test('真实模式左右独立，重置返回自动并清动态候选', () => {
    const h = panelHarness(), { W } = h, left = W.irStates.l, right = W.irStates.r;
    W.irHead();
    left.dev = { gatt: { connected: true } }; right.dev = { gatt: { connected: true } };
    W.irHead();
    const leftMode = W.$('irBiasMode', 'l'), rightMode = W.$('irBiasMode', 'r');
    left.bias.g = [1.5, -2, 0.3]; left.bias.ready = true;
    W.irBiasText(left);
    rightMode.value = 'manual'; rightMode.onchange();
    assert.equal(right.bias.mode, 'manual');
    assert.equal(left.bias.mode, 'dynamic');
    assert.equal(leftMode.value, 'dynamic');
    W.irBiasTrack(right, { seq: 1, gx0: .07, gy0: 0, gz0: 0, ax: 0, ay: 0, az: 1 });
    assert.equal(right.bias.dynamic, null, '手动冻结不得收集候选');
    assert.equal(right.bias.still, 0);
    W.irBiasTrack(left, { seq: 1, gx0: .07, gy0: 0, gz0: 0, ax: 0, ay: 0, az: 1 });
    assert.ok(left.bias.dynamic); assert.equal(left.bias.dynamic.rows.length, 1);
    W.$('btnBiasReset', 'r').onclick();
    assert.equal(right.bias.mode, 'dynamic');
    assert.equal(rightMode.value, 'dynamic');
    assert.equal(right.bias.collect, null);
    assert.equal(right.bias.dynamic, null);
    assert.equal(right.bias.anchor, null);
    assert.equal(right.bias.ready, false);
    near(right.bias.g, [0, 0, 0]);
    leftMode.value = 'manual'; leftMode.onchange();
    assert.equal(left.bias.mode, 'manual'); near(left.bias.g, [1.5, -2, 0.3]);
    leftMode.value = 'dynamic'; leftMode.onchange();
    assert.equal(left.bias.mode, 'dynamic');
    assert.equal(left.bias.collect, null);
    assert.equal(h.confirmations.length, 0);
  });
  await test('默认自动模式从真实BLE通知静置5秒自动学习，切手动后冻结', async () => {
    const h = harness(), { d, chr } = device(); await h.W.irConnect(d, 'l');
    const st = h.W.irStates.l;
    assert.equal(st.bias.mode, 'dynamic');
    stream(h, chr, 0, 250, [0, 0, 2048, 1, 2, 1]);
    assert.equal(st.bias.ready, false); near(st.bias.g, [0, 0, 0]);
    near(gyro0(st.last), [.14, -.07, .07]); near(shownGyro(st.last), [.14, -.07, .07]);
    stream(h, chr, 250, 1, [0, 0, 2048, 1, 2, 1]);
    assert.equal(st.bias.ready, true); near(st.bias.g, [.14, -.07, .07]);
    assert.equal(st.bias.anchor, null);
    near(shownGyro(st.last), [0, 0, 0]);
    h.W.irBiasSetMode(st, 'manual');
    stream(h, chr, 251, 501, [0, 0, 2048, 1, 2, 1]);
    near(st.bias.g, [.14, -.07, .07]); assert.equal(st.bias.dynamic, null);
    h.W.irClose('l');
  });
  await test('自动小偏置由真实CRC通知5秒初始化，坏CRC不进入候选', async () => {
    const h = harness(), { d, chr } = device(); await h.W.irConnect(d, 'l');
    const st = h.W.irStates.l;
    assert.equal(st.bias.mode, 'dynamic');
    const bad = frame(0, [0, 0, 2048, 1, 2, 1]); bad[45] ^= 0xff;
    const before = JSON.stringify(st.bias);
    notify(chr, bad);
    assert.equal(st.frames, 0); assert.equal(st.bad, 1); assert.equal(JSON.stringify(st.bias), before);
    stream(h, chr, 0, 250, [0, 0, 2048, 1, 2, 1]);
    assert.equal(st.bias.ready, false, 'less than 5 seconds must not initialize');
    stream(h, chr, 250, 1, [0, 0, 2048, 1, 2, 1]);
    assert.equal(st.bias.ready, true); near(st.bias.g, [.14, -.07, .07]);
    assert.equal(st.bias.anchor, null); near(shownGyro(st.last), [0, 0, 0]);
    h.W.irClose('l');
  });
  await test('真实BLE低帧率候选满5秒仍需至少50个有效帧', async () => {
    const h = harness(), { d, chr } = device(); await h.W.irConnect(d, 'l');
    const st = h.W.irStates.l;
    assert.equal(st.bias.mode, 'dynamic');
    stream(h, chr, 0, 26, [0, 0, 2048, 0, 1, 0], 200);
    assert.equal(st.bias.ready, false); assert.equal(st.bias.still, 26);
    stream(h, chr, 26, 23, [0, 0, 2048, 0, 1, 0], 200);
    assert.equal(st.bias.ready, false); assert.equal(st.bias.still, 49);
    stream(h, chr, 49, 1, [0, 0, 2048, 0, 1, 0], 200);
    assert.equal(st.bias.ready, true); near(st.bias.g, [.07, 0, 0]); h.W.irClose('l');
  });
  await test('左右真实BLE自动状态与候选窗口互不影响', async () => {
    const h = harness(), left = device('W01-L'), right = device('W01-R');
    await h.W.irConnect(left.d, 'l'); await h.W.irConnect(right.d, 'r');
    const l = h.W.irStates.l, r = h.W.irStates.r;
    h.W.irBiasSetMode(r, 'manual');
    for (let seq = 0; seq <= 250; seq++) {
      notify(left.chr, frame(seq, [0, 0, 2048, 1, 2, 1]));
      notify(right.chr, frame(seq, [0, 0, 2048, 0, 1, 0])); h.advance(20);
    }
    assert.equal(l.bias.ready, true); assert.equal(l.bias.anchor, null);
    assert.equal(r.bias.mode, 'manual'); assert.equal(r.bias.ready, false); assert.equal(r.bias.dynamic, null);
    h.W.irBiasSetMode(r, 'dynamic'); stream(h, right.chr, 251, 100, [0, 0, 2048, 0, 1, 0]);
    const rightCandidate = JSON.stringify(r.bias); h.W.irClose('l');
    assert.equal(JSON.stringify(r.bias), rightCandidate); assert.equal(right.d.gatt.connected, true);
    stream(h, right.chr, 351, 151, [0, 0, 2048, 0, 1, 0]);
    assert.equal(r.bias.ready, true); near(r.bias.g, [.07, 0, 0]);
    assert.equal(r.bias.anchor, null); h.W.irClose('r');
  });
  await test('自动慢漂越过原 .28 仍持续更新，raw6、物理值、导出与录制历史不回写', async () => {
    const h = harness(), { d, chr } = device(); await h.W.irConnect(d, 'l');
    const st = h.W.irStates.l; st.recording = true;
    const baseRaw = [0, 0, 2048, 1, 2, 1], driftRaw = [0, 0, 2048, 1, 8, 1];
    stream(h, chr, 0, 251, baseRaw);
    assert.equal(st.bias.ready, true);
    const initial = Array.from(st.bias.g);
    near(initial, [.14, -.07, .07]);
    const history = st.rec.slice(), snapshots = history.map((s) => JSON.stringify(s));
    const sampleHistory = st.samples.slice(), sampleSnapshots = sampleHistory.map((s) => JSON.stringify(s));
    const priorRows = h.W.irFramesRows().rows.map((r) => Array.from(r.phy));
    const priorCols = h.W.irParquetColumns().cols;
    const priorRaw = priorCols.find((c) => c.name === 'imu_raw_values').data.map((v) => Array.from(v));
    const priorPhy = priorCols.find((c) => c.name === 'imu_physical_values').data.map((v) => Array.from(v));
    stream(h, chr, 251, 151, driftRaw);
    const firstUpdate = Array.from(st.bias.g);
    near(firstUpdate, [initial[0] + .42 * -Math.expm1(-3 / 10), initial[1], initial[2]]);
    stream(h, chr, 402, 151, driftRaw);
    assert.ok(st.bias.g[0] > firstUpdate[0]);
    stream(h, chr, 551, 1700, driftRaw);
    assert.ok(st.bias.g[0] > .5, 'stable residual must keep tracking');
    assert.ok(st.bias.g[0] > initial[0] + .28, '必须越过旧固定锚上限');
    assert.equal(st.bias.anchor, null); assert.equal(st.bias.boundary, false);
    near(st.last.raw6, driftRaw); near(gyro0(st.last), [.56, -.07, .07]);
    near(shownGyro(st.last), gyro0(st.last).map((v, i) => v - st.bias.g[i]));
    assert.ok(st.last.gx > 0 && st.last.gx < .07);
    history.forEach((sample, i) => assert.equal(JSON.stringify(sample), snapshots[i]));
    sampleHistory.forEach((sample, i) => assert.equal(JSON.stringify(sample), sampleSnapshots[i]));
    const rows = h.W.irFramesRows().rows, cols = h.W.irParquetColumns().cols;
    const raw = cols.find((c) => c.name === 'imu_raw_values').data;
    const phy = cols.find((c) => c.name === 'imu_physical_values').data;
    priorRows.forEach((values, i) => near(rows[i].phy, values));
    priorRaw.forEach((values, i) => near(raw[i], values));
    priorPhy.forEach((values, i) => near(phy[i], values));
    for (let i = 251; i < rows.length; i++) {
      near(raw[i], driftRaw); near(phy[i], [0, 0, 1, .56, -.07, .07]);
    }
    assert.equal(st.rec.length, 2253);
    const frozen = Array.from(st.bias.g); h.W.irBiasSetMode(st, 'manual');
    stream(h, chr, 2253, 501, driftRaw);
    near(st.bias.g, frozen); assert.equal(st.bias.dynamic, null);
    h.W.irClose('l');
  });
  await test('大初偏自动初始化，随后恒速转动按 .5 °/s/s 被吸收（诚实展示风险）', async () => {
    const h = harness(), { d, chr } = device(); await h.W.irConnect(d, 'l');
    const st = h.W.irStates.l;
    assert.equal(st.bias.mode, 'dynamic');
    stream(h, chr, 0, 501, [0, 0, 2048, 100, 200, 300]);
    assert.equal(st.bias.ready, true); near(st.bias.g, [14, -7, 21]);
    assert.equal(st.bias.anchor, null);
    stream(h, chr, 501, 2000, [0, 0, 2048, 100, 200, 320]);
    assert.ok(st.bias.g[2] > 21.5, '恒定 1.4 °/s 转动会被当成漂移吸收');
    assert.ok(st.bias.g[2] < 22.4);
    assert.equal(st.bias.boundary, false);
    const residual = Math.abs(st.last.gz);
    assert.ok(residual < 0.1, '长时间匀速转动几乎被完全吸收，展示物理局限');
    h.W.irClose('l');
  });
  await test('重连后仍是自动，无需用户操作自行重建；旧notify与断开回调不能污染新窗口', async () => {
    const h = harness(), first = device(), fresh = device(); await h.W.irConnect(first.d, 'l');
    const st = h.W.irStates.l;
    assert.equal(st.bias.mode, 'dynamic');
    stream(h, first.chr, 0, 251, [0, 0, 2048, 1, 2, 1]);
    assert.equal(st.bias.ready, true);
    stream(h, first.chr, 251, 100, [0, 0, 2048, 1, 3, 1]);
    const oldNotify = first.chr.listeners('characteristicvaluechanged')[0];
    const oldGone = first.d.listeners('gattserverdisconnected')[0];
    first.d.gatt.disconnect();
    assert.equal(st.bias.mode, 'dynamic'); assert.equal(st.bias.ready, false);
    assert.equal(st.bias.dynamic, null); assert.equal(st.bias.anchor, null); h.W.irClose('l');
    await h.W.irConnect(fresh.d, 'l');
    assert.equal(st.bias.mode, 'dynamic'); assert.equal(st.bias.ready, false); near(st.bias.g, [0, 0, 0]);
    stream(h, fresh.chr, 0, 100, [0, 0, 2048, 0, 1, 0]);
    const before = JSON.stringify(st.bias), count = st.frames;
    for (let i = 0; i < 300; i++) oldNotify({ target: { value: new DataView(frame(351 + i).buffer) } });
    oldGone();
    assert.equal(st.dev, fresh.d); assert.equal(st.frames, count); assert.equal(JSON.stringify(st.bias), before);
    stream(h, fresh.chr, 100, 151, [0, 0, 2048, 0, 1, 0]);
    assert.equal(st.bias.ready, true); near(st.bias.g, [.07, 0, 0]);
    assert.equal(st.bias.anchor, null);
    const anchored = JSON.stringify(st.bias);
    oldNotify({ target: { value: new DataView(frame(999).buffer) } }); oldGone();
    assert.equal(JSON.stringify(st.bias), anchored); assert.equal(st.dev, fresh.d); h.W.irClose('l');
  });
  console.log(`\n${passed}/${passed} bias integration cases passed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
