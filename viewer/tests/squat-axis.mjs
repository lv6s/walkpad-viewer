import assert from 'node:assert/strict';
import {squatSideAngles} from '../src/squat-axis.ts';
import {squatTraceAt} from '../src/squat-angle-chart.ts';

const D2R = Math.PI/180;
const mul = (A, B) => A.map(r => B[0].map((_, j) => r.reduce((s, x, k) => s + x*B[k][j], 0)));
const Rx = a => [[1,0,0],[0,Math.cos(a),-Math.sin(a)],[0,Math.sin(a),Math.cos(a)]];
const Ry = a => [[Math.cos(a),0,Math.sin(a)],[0,1,0],[-Math.sin(a),0,Math.cos(a)]];
const Rz = a => [[Math.cos(a),-Math.sin(a),0],[Math.sin(a),Math.cos(a),0],[0,0,1]];
const apply = (R, v) => R.map(r => r[0]*v[0] + r[1]*v[1] + r[2]*v[2]);

// 动作在世界系里固定（站直、绕左右轴屈伸），只换安装旋转 R：设备装成什么朝向都不该改结论。
const HZ = 100, DOWN = 1.0, TURN = .8, RESET = .3;
const REPS = [[2.0, 3.0, 3.4, 4.4], [5.9, 6.9, 7.3, 8.3], [9.8, 10.8, 11.2, 12.2]];

// mode 'sync'：侧倾与屈伸严格成比例（往返，无法与屈伸分离）
// mode 'drift'：蹲内一直内扣、到站立时才回正（净旋转非零，可分离）
function fixture({R = mul(Rx(35*D2R), Rz(25*D2R)), flex = 25, tilt = 5, turnAt = 2, turnDeg = 8, mode = 'sync'} = {}) {
  const n = Math.round(14*HZ);
  const t = new Float64Array(n), values = new Float64Array(n*6);
  const turnStart = turnAt < 0 ? Infinity : REPS[turnAt][0] - TURN;
  for (let i = 0; i < n; i++) {
    const s = i/HZ;
    let phi = 0, dphi = 0, psi = 0, dpsi = 0;
    for (const [t0, t1, t2, t3] of REPS) {
      if (s >= t0 && s < t1) { const u = (s-t0)/DOWN; phi = -flex*u; dphi = -flex/DOWN; }
      else if (s >= t1 && s < t2) { phi = -flex; }
      else if (s >= t2 && s < t3) { const u = (s-t2)/DOWN; phi = -flex*(1-u); dphi = flex/DOWN; }
    }
    let theta = 0, dtheta = 0;
    if (mode === 'sync') { theta = -tilt*phi/flex; dtheta = -tilt*dphi/flex; }
    else {
      for (const [t0, t1, , t3] of REPS) {
        if (s >= t0 && s < t1) { const u = (s-t0)/DOWN; theta = tilt*u; dtheta = tilt/DOWN; }
        else if (s >= t1 && s < t3) { theta = tilt; }
        else if (s >= t3 && s < t3+RESET) { const u = (s-t3)/RESET; theta = tilt*(1-u); dtheta = -tilt/RESET; }
      }
    }
    if (turnAt >= 0 && s >= turnStart && s < turnStart+TURN) { const u = (s-turnStart)/TURN; psi = turnDeg*u; dpsi = turnDeg/TURN; }
    else if (turnAt >= 0 && s >= turnStart+TURN) psi = turnDeg;
    const Rz_ = Rz(psi*D2R), Rf = Rx(phi*D2R), Rt = Ry(theta*D2R);
    const a = apply(mul(Rz_, mul(Rf, Rt)), [0, 0, 1]);
    // 空间角速度 = Rz Rx Ry 的导数：每层绕的轴都要被外层带着转，不能拿合成姿态整乘
    const ex = apply(Rz_, [1, 0, 0]), ey = apply(mul(Rz_, Rf), [0, 1, 0]);
    const g = [dphi*ex[0] + dtheta*ey[0], dphi*ex[1] + dtheta*ey[1], dpsi + dphi*ex[2] + dtheta*ey[2]];
    t[i] = Math.round(s*1e6);
    const av = apply(R, a), gv = apply(R, g);
    for (let j = 0; j < 3; j++) { values[i*6+j] = av[j]; values[i*6+3+j] = gv[j]; }
  }
  return {t, values};
}

const near = (a, b, tol) => Math.abs(a-b) <= tol;

// ① 前后角＝屈伸幅度；蹲内航向只受欧拉耦合的少量污染
{
  const r = squatSideAngles(fixture(), 0, REPS);
  assert.ok(r.ok, '合成深蹲未被识别：' + r.reason);
  assert.equal(r.reps.length, 3);
  for (const x of r.reps) {
    assert.ok(near(x.ap, 25, 1.5), `前后角 ${x.ap.toFixed(1)} 应≈25`);
    assert.ok(near(x.yaw, 0, 2.5), `蹲内航向 ${x.yaw.toFixed(1)} 应≈0`);
    assert.ok(near(x.back, -25, 1.5), `回程 ${x.back.toFixed(1)} 应≈−25`);
  }
  assert.ok(r.conf === 'hi', '理想合成数据的可信度应为高：' + r.conf);
  assert.ok(r.ratio > .95, '主轴能量占比应接近 1：' + r.ratio);
}

// ② 已知数学极限：侧倾与屈伸严格同步时，两者合成一根轴，左右角被主轴吸收（不是实现缺陷）
{
  const r = squatSideAngles(fixture({mode: 'sync'}), 0, REPS);
  assert.equal(r.axisSource, 'flexion');
  assert.ok(r.reps.every(x => Math.abs(x.ml) < 2.5), '同步侧倾本应被吸收进主轴：' + r.reps.map(x => x.ml.toFixed(2)).join('/'));
}

// ③ 侧倾在蹲内不回位时能分离出来：净旋转定前后轴
{
  const r = squatSideAngles(fixture({mode: 'drift'}), 0, REPS);
  assert.equal(r.axisSource, 'net-turn', '净旋转足够一致时应改用净旋转定轴');
  for (const x of r.reps) {
    assert.ok(near(Math.abs(x.ml), 5, 1.2), `左右角 ${x.ml.toFixed(1)} 应≈±5`);
    assert.ok(near(x.ap, 25, 2), `前后角 ${x.ap.toFixed(1)} 应≈25`);
  }
}

// ④ 安装朝向无关：同一动作换三种装法，三组数值一致
{
  const setups = [mul(Rx(0), Rz(0)), mul(Rx(-70*D2R), Rz(120*D2R)), mul(Rz(200*D2R), Rx(15*D2R))];
  const outs = setups.map(R => squatSideAngles(fixture({R}), 0, REPS));
  assert.ok(outs.every(r => r.ok));
  const ref = outs[0].reps;
  for (const o of outs.slice(1)) for (let i = 0; i < 3; i++) {
    assert.ok(near(o.reps[i].ap, ref[i].ap, .5), `换装法后前后角变了 ${o.reps[i].ap.toFixed(2)} vs ${ref[i].ap.toFixed(2)}`);
    assert.ok(near(o.reps[i].ml, ref[i].ml, .5), '换装法后左右角变了');
  }
}

// ⑤ 两脚各估一套轴：不同装法下两侧符号仍对齐（同向运动必须同号）
{
  const L = squatSideAngles(fixture({R: mul(Rx(20*D2R), Rz(30*D2R)), mode: 'drift'}), 0, REPS);
  const Rr = squatSideAngles(fixture({R: mul(Rx(-45*D2R), Rz(-110*D2R)), mode: 'drift'}), 0, REPS);
  for (let i = 0; i < 3; i++) {
    assert.ok(L.reps[i].ap*Rr.reps[i].ap > 0, `两脚前后角异号：${L.reps[i].ap.toFixed(1)} / ${Rr.reps[i].ap.toFixed(1)}`);
    assert.ok(near(L.reps[i].ml, Rr.reps[i].ml, 1), `两脚左右角不同向：${L.reps[i].ml.toFixed(1)} / ${Rr.reps[i].ml.toFixed(1)}`);
  }
}

// ⑥ 航向以第一次为 0：第 3 次之前转身 8°，累计应≈8，前两次仍≈0
{
  const r = squatSideAngles(fixture({turnAt: 2, turnDeg: 8}), 0, REPS);
  assert.ok(near(r.reps[0].heading, 0, .1), '首蹲航向未归零');
  assert.ok(near(r.reps[1].heading, 0, .8), `第 2 次航向 ${r.reps[1].heading.toFixed(2)} 应≈0`);
  assert.ok(near(r.reps[2].heading, 8, 1.2), `第 3 次航向 ${r.reps[2].heading.toFixed(2)} 应≈8`);
}

// ⑦ 有 APP 航向列时给出同口径差值；缺列时为 null
{
  const fx = fixture();
  const app = Array.from({length: fx.t.length}, (_, i) => 40 + i*.001);
  const r = squatSideAngles({...fx, heading: app}, 0, REPS);
  assert.ok(r.reps.every(x => Number.isFinite(x.headingApp)), '给了航向列却没有差值');
  const r2 = squatSideAngles(fx, 0, REPS);
  assert.ok(r2.reps.every(x => x.headingApp === null), '没有航向列时不应编造差值');
}

// ⑧ 没有任何静止段时退回蹲前站立瞬间，仍能出结果
{
  // 全程模长 1.10 g：不满足静止判据（|a|−1 < 0.08），但仍在蹲前站立量的容差内
  const fx = fixture();
  const values = new Float32Array(fx.values.length);
  for (let i = 0; i < fx.t.length; i++) for (let j = 0; j < 6; j++) values[i*6+j] = fx.values[i*6+j] * (j < 3 ? 1.10 : 1);
  const r = squatSideAngles({t: fx.t, values}, 0, REPS);
  assert.ok(r.ok, '无连续静止段时失败：' + r.reason);
  assert.equal(r.upSource, 'stand');
  assert.ok(near(r.reps[0].ap, 25, 2), '退化路径前后角偏差过大：' + r.reps[0].ap.toFixed(1));
}

// ⑨ 没有分段时明确报错，不返回空表
{
  const r = squatSideAngles(fixture(), 0, []);
  assert.equal(r.ok, false);
  assert.match(r.reason, /分段/);
}

// 双踝时间曲线沿用逐次表的积分口径，换时间基准后仍与分段、蹲底角一致。
{
  const offset=18;
  const reps=REPS.map(r=>r.map(t=>t+offset));
  const r=squatSideAngles(fixture({tilt:0,turnAt:-1}),offset,reps);
  assert.equal(r.traces.length,reps.length);
  for(const [i,[start,bottom,rise,end]] of reps.entries()) {
    assert.deepEqual(squatTraceAt(r.traces,start),[0,0,0]);
    const mid=squatTraceAt(r.traces,(start+bottom)/2)[0];
    const a=squatTraceAt(r.traces,bottom);
    for(const [j,v] of [r.reps[i].ap,r.reps[i].ml,r.reps[i].yaw].entries()) assert.ok(near(a[j],v,1e-4));
    assert.ok(near(mid,a[0]/2,1e-3));
    assert.ok(near(squatTraceAt(r.traces,(rise+end)/2)[0],a[0]/2,1e-3));
    assert.ok(near(squatTraceAt(r.traces,end)[0],0,1e-3));
    assert.equal(squatTraceAt(r.traces,end+.1),null,'不应连过两次深蹲之间的静止段');
  }
}

// 异常帧和长间隔均断线；后续有效帧可以继续读到，但缺口内不插值。
{
  const raw=fixture({tilt:0,turnAt:-1}), bad=259;
  const skip=k=>k>=227 && k<=252;
  raw.values[bad*6+3]=NaN;
  const t=raw.t.filter((_,k)=>!skip(k)), values=raw.values.filter((_,i)=>!skip(Math.floor(i/6)));
  const r=squatSideAngles({t,values},0,REPS);
  const tr=r.traces[0], gapEnd=tr.t.findIndex(x=>x===2.53), badFrame=tr.t.findIndex(x=>x===2.59);
  assert.equal(tr.linked[gapEnd],0);
  assert.equal(tr.linked[badFrame],0);
  assert.equal(tr.linked[badFrame+1],0);
  assert.equal(squatTraceAt(r.traces,2.4),null);
  assert.equal(squatTraceAt(r.traces,2.59),null);
  assert.equal(squatTraceAt(r.traces,2.595),null);
  assert.ok(squatTraceAt(r.traces,2.61).every(Number.isFinite));
}

console.log('squat-axis ok');
