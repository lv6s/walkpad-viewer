import assert from 'node:assert/strict';
import {headingCursor} from '../src/data/heading.ts';

const run = (vals, refs = null) => {
  const c = headingCursor();
  return vals.map((v, i) => c(v, refs ? refs[i] : 'r1'));
};
const near = (a, b, tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// 跨越 ±180 不跳圈：+方向与 −方向都要连续
assert.ok(near(run([170, 175, -179, -175]), [170, 175, 181, 185]), '正向跨 +180 未展开');
assert.ok(near(run([-175, -179, 179, 175]), [-175, -179, -181, -185]), '负向跨 −180 未展开');
// 未跨圈时保持原值，不能把真实的大幅转动改小
assert.ok(near(run([0, 90, -90, 0]), [0, 90, -90, 0]), '未跨圈时被改写');
// 首帧不是 0 也不重设，避免把「跟踪建立时就在 40°」当成 0
assert.ok(near(run([40, 45]), [40, 45]), '首帧被强制归零');
// 参考切换必须重新起算：换参考后沿用旧累计会把两段基准混成一条线
assert.ok(near(run([170, 175, -179], ['a', 'a', 'b']), [170, 175, -179]), '换参考后未重新起算');
// 中间缺帧（NaN）不重置累计，补回后继续接上
const gap = run([170, 175, NaN, -179]);
assert.ok(Number.isNaN(gap[2]) && Math.abs(gap[3] - 181) < 1e-6, 'NaN 打断展开');
// 缺 referenceId 的旧包按同一参考处理
const old = headingCursor();
assert.ok(Math.abs(old(179, null) - 179) < 1e-6 && Math.abs(old(-179, null) - 181) < 1e-6, '无 referenceId 时未展开');

console.log('PASS heading: wrap unwrap both directions, no-op within range, reference reset, gaps, missing referenceId');
