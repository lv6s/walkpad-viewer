import assert from 'node:assert/strict';
import {ankleTimebase} from '../src/squat-clock.ts';

const HZ = 50, N = 1500;

/** t/receive/elapsed 三列：offset 为接收偏移（秒），jitter 逐帧附加抖动（秒）。 */
function stream(offset, jitter = () => 0, origin = 0) {
  const t = new Float64Array(N), receive = new Float64Array(N), elapsed = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    t[i] = origin + Math.round(i * 1e6 / HZ);
    elapsed[i] = t[i] + 250e3;
    receive[i] = Math.round((t[i] / 1e6 + offset + jitter(i)) * 1e9);
  }
  return {t, values: new Float64Array(N * 6), receive, elapsed};
}

const tail = i => (i % 10 === 3 ? 0.05 + (i % 7) * 0.025 : 0);   // 一成帧晚到 50–200 ms
const spread = i => (i % 2 ? 0.05 : -0.05);                       // 主体每帧来回摆 50 ms
const ramp = i => (i > N / 2 ? 0.15 : 0);                         // 后半段整体后移

// 尾部晚到的 BLE 包不影响中位数锚点：应当通过
{
  const tb = ankleTimebase([stream(3.2, tail), stream(3.21, tail)], 0);
  assert.ok(Math.abs(tb.shifts[0] + tb.shifts[1]) < 1e-6, '两脚位移应对称抵消');
  assert.ok(Math.abs(Math.abs(tb.shifts[0]) - 0.005) < 0.005, '位移应接近两脚中位偏移之差的一半：' + tb.shifts[0]);
}

// 主体抖动大：中位数不再代表对时，应当拒绝
assert.throws(() => ankleTimebase([stream(3.2, spread), stream(3.2, spread)], 0), /时间轴波动较大/);

// 锚点在段间漂移：应当拒绝
assert.throws(() => ankleTimebase([stream(3.2, ramp), stream(3.2, ramp)], 0), /时间轴波动较大/);

// 两脚时钟差过大：应当拒绝
assert.throws(() => ankleTimebase([stream(3.2), stream(3.6)], 0), /时间轴差异过大/);

// 抖动只发生在单侧也不该被放过
assert.throws(() => ankleTimebase([stream(3.2, ramp), stream(3.2)], 0), /时间轴波动较大/);

console.log('ankle-clock: ok');
