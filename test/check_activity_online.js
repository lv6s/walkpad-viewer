/* DOM-free page scheduling checks; real engine/HTTP covered by check_online.py. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
let now = 0, posts = [], pending = null;
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { value: '51.2', style: {}, textContent: '', disabled: false });
  return nodes.get(id);
};
const states = Object.fromEntries(['l', 'r'].map(f => [f, {
  foot: f, dev: {}, capI: 1, bias: { ready: true, g: [0, 0, 0] }, rate: 51
}]));
const context = vm.createContext({
  console, performance: { now: () => now }, $: node, irStates: states,
  log: () => {}, fit: () => null, setInterval: () => 0,
  fetch: async (url, init) => {
    const data = JSON.parse(init.body); posts.push({ url, data });
    if (pending && url === '/act/step') await pending;
    return { ok: true, json: async () => url === '/act/step' ? {
      valid: false, reason: 'stream_gap', label: null
    } : { ok: true } };
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/activity-live.js'), 'utf8'), context);
const run = code => vm.runInContext(code, context);
const flush = () => new Promise(resolve => setImmediate(resolve));
const feed = (foot, time, seq, gyro = 42) => run(`actFeed(irStates.${foot}, {
  clk: { epoch: ${time} }, receiptPerf: ${now}, seq: ${seq},
  perf: -999999, ax: 0, ay: 0, az: 1, gx: ${gyro}, gy: 43, gz: 44,
  gx0: 999, gy0: 999, gz0: 999, raw6: [0,0,2048,1,2,3] })`);
(async () => {
  run("act.info = { online_policy: { version: 'activity-online-linear-v2' } }");
  await run('actStart()');
  assert.equal(posts[0].data.mode, 'online-v2');
  feed('l', 100000, 0);
  assert.equal(run('act.buf.l[0].values[3]'), 42);
  assert.equal(run('act.buf.l[0].device_ms'), 100000);
  assert.equal(run('act.buf.l[0].receipt_ms'), now);
  assert.equal(run('act.buf.l[0].seq'), 0);
  assert(!run('act.buf.l[0].values.includes(999)'));
  now = 350;
  run('actTick()'); await flush();
  let sent = posts.filter(p => p.url === '/act/step');
  assert.equal(sent[0].data.t_end, 200);
  assert.equal(sent[0].data.now_ms, 350);
  now = 550;
  run('actTick()'); await flush();
  sent = posts.filter(p => p.url === '/act/step');
  assert.equal(sent[1].data.events.length, 0);
  assert(run('act.on'));
  feed('l', 100040, 2);
  feed('l', 100020, 1);
  assert(run('act.on'));
  const segment = run('act.buf.l[0].segment');
  states.l.bias.g = [10, 0, 0];
  feed('l', 100060, 3);
  assert.notEqual(run('act.buf.l[0].segment'), segment);
  const biasSegment = run('act.buf.l[0].segment');
  states.l.capI++;
  feed('l', 100080, 4);
  assert.notEqual(run('act.buf.l[0].segment'), biasSegment);
  const count = run('act.buf.l.length');
  run('actFeed(irStates.l, { perf: 600, ax: 0,ay:0,az:1,gx:0,gy:0,gz:0 })');
  assert.equal(run('act.buf.l.length'), count);
  assert(run('act.clockBad.l'));
  let release;
  pending = new Promise(resolve => { release = resolve; });
  now = 750; run('actTick()');
  const steps = run('act.steps');
  run('actStop()'); release(); await flush();
  assert.equal(run('act.steps'), steps);
  assert(!run('act.on'));
  console.log('ACTIVITY_ONLINE_PAGE_PASS: device time, receipt, compensated gyro, fixed target, silence, reorder, bias/reconnect, stale response');
})().catch(error => { console.error(error); process.exitCode = 1; });
