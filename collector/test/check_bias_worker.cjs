'use strict';
/* 进程级验收：algorithm.py 真正调用的 bias_worker 契约（raw6 进制 → 事件/状态）。
   也用来锁住“就绪才发事件”和“补偿只用当帧偏置”。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function records(plan) {
  const out = [];
  let seq = 0;
  for (const [seconds, gx] of plan) {
    for (let i = 0; i < Math.round(seconds * 50); i++) {
      const t = 20 * seq;
      out.push({ key: 'l', foot: 'l', connection: 'c1', processing_ms: t, receipt_ms: t, device_ms: t, seq,
        raw6: [0, 0, 2048, 0, Math.round(gx / 0.07), 0] });
      seq++;
    }
  }
  return out;
}

function run(plan) {
  const input = JSON.stringify({ records: records(plan) }) + '\n';
  const stdout = execFileSync(process.execPath, [path.join(ROOT, 'backend', 'bias_worker.cjs')],
    { input, encoding: 'utf-8', maxBuffer: 1 << 28, env: { ...process.env, WALKPAD_BIAS_GATE: 'confirmed' } });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, result.error);
  return result;
}

let count = 0;
const test = (name, fn) => { fn(); console.log('PASS', name); count++; };

test('静置 7 秒内就绪，事件值按当帧偏置补偿', () => {
  const r = run([[7, 6.0]]);
  const first = r.states.find(s => s.ready);
  assert.ok(first, '应已就绪');
  assert.ok(Math.abs(first.processing_ms) <= 7000);
  assert.ok(Math.abs(first.gyro_bias_dps[0] - 6.0) < 0.08, String(first.gyro_bias_dps));
  const event = r.events[r.events.length - 1];
  assert.ok(Math.abs(event.values[3] - (6.0 - 6.0)) < 0.1, String(event.values));
});

test('步行段冻结偏置，就绪状态不变', () => {
  const plan = [[7, 6.0], [10, 60]];
  const r = run(plan);
  const walk = r.states.filter(s => s.processing_ms > 7200);
  assert.ok(walk.every(s => s.ready));
  const g = walk[walk.length - 1].gyro_bias_dps[0];
  assert.ok(Math.abs(g - 6.0) < 0.15, String(g));
});

test('穿戴级 2.5 °/s 偏移在 6 秒静止复核后跟上', () => {
  const r = run([[7, 6.0], [2, 60], [14, 8.5]]);
  const tail = r.states[r.states.length - 1].gyro_bias_dps[0];
  assert.ok(tail > 8.0 && tail < 8.7, String(tail));
});

test('未就绪时不产生事件', () => {
  const r = run([[2, 6.0]]);
  assert.equal(r.events.length, 0);
  assert.ok(r.states.every(s => s.ready === false));
});

console.log(`${count} worker tests passed`);
