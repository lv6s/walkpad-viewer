import assert from 'node:assert/strict';
import {inferOffline, walkingRanges} from '../src/axis/offline.ts';

const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a.reduce((s, x, i) => s + x*b[i], 0);
const unit = a => a.map(x => x / Math.hypot(...a));
const mount = unit([1, 2, -3]), turn = 1.35;
const sensor = v => v.map((x, i) => x*Math.cos(turn) + cross(mount, v)[i]*Math.sin(turn) + mount[i]*dot(mount, v)*(1-Math.cos(turn)));
const bias = [18, -12, 5];
const hz = 50, quiet = 2.2, period = 1.04;

export function fixture({direction = 1, count = 5, mode = 'walk', mountFn = sensor, gapAt, batched = false, skipQuiet = false, lead = 0, hz: fs = hz} = {}) {
  const n = Math.round((quiet + lead + period*count + (mode === 'mixed' ? 9 : .35))*fs);
  const t = new Float64Array(n), phys = Array.from({length: 6}, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const x = i/fs, w = x-quiet-lead;
    t[i] = (batched ? Math.floor(i/2)*2 : i)/fs + 10 + (gapAt != null && x >= gapAt ? .25 : 0);
    let a = [0, 0, 1], g = [0, 0, 0];
    if (lead && x >= quiet && x < quiet + lead) {
      // 静站与步行之间的过渡动作：加速度接近 1 g 但陀螺远高于静止门限，不算静站
      a = [.3*Math.sin(i*.1), 0, 1]; g = [90*Math.cos(i*.1), 0, 0];
    } else if (w >= 0 && w < period*count) {
      const cy = Math.floor(w/period), ph = w-cy*period;
      const u = (ph-.27)/.66;
      const phi = u > 0 && u < 1 ? .43*Math.sin(Math.PI*u)**2 : 0;
      const rate = u > 0 && u < 1 ? .43*Math.PI/.66*Math.sin(2*Math.PI*u)*180/Math.PI : 0;
      const ax = u > 0 && u < 1 ? direction*.55*2*Math.PI*Math.sin(2*Math.PI*u)/(.66**2*9.80665) : 0;
      const z = Math.abs(ph-.98) < .025 && mode !== 'squat' ? .85*Math.exp(-(((ph-.98)/.015)**2)) : 0;
      a = [Math.cos(phi)*ax - Math.sin(phi)*(1+z), 0, Math.sin(phi)*ax + Math.cos(phi)*(1+z)];
      g = mode === 'turn' ? [0, rate*.35, 48] : mode === 'disagree' && cy % 2 ? [rate, 0, 0] : [0, rate, 0];
    } else if (mode === 'mixed' && w >= period*count + .2) {
      a = [0, .25*Math.sin(i*.5), 1]; g = [160*Math.cos(i*.4), 0, 45];
    } else if (skipQuiet && w < 0) {
      a = [.3*Math.sin(i*.1), 0, 1]; g = [90*Math.cos(i*.1), 0, 0];
    }
    const aa = mountFn(a), gg = mountFn(g);
    for (let j = 0; j < 3; j++) {phys[j][i] = aa[j]; phys[3+j][i] = gg[j]+bias[j];}
  }
  return {t, n, imu: {phys}};
}

const angle = (u, v, signed = true) => Math.acos(Math.max(-1, Math.min(1, signed ? dot(u,v) : Math.abs(dot(u,v))))) * 180 / Math.PI;

if (import.meta.main) {
  const data = fixture();
  const result = inferOffline(data);
  assert.ok(result.cycles >= 3, JSON.stringify(result));
  assert.ok(angle(result.up, sensor([0,0,1])) < .01);
  assert.ok(angle(result.forward, sensor([1,0,0]), false) < .01);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.used, result.candidates[0]);
  assert.ok(result.bias.every((x, j) => Math.abs(x-bias[j]) < 1e-9));
  const short = inferOffline(fixture({count: 3}));
  assert.equal(short.cycles, 2);
  assert.equal(short.confB, 'mid');
  assert.equal(inferOffline(fixture({count: 2})).forward, undefined);

  for (const direction of [1, -1]) for (const mountFn of [v => v, sensor]) {
    const r = inferOffline(fixture({direction, mountFn}));
    assert.ok(angle(r.forward, mountFn([direction,0,0]), false) < .01);
  }
  assert.deepEqual(walkingRanges(Int8Array.of(-1, 0, 0, 4, 1, -1, 0)), [{a: .1, b: .3}, {a: .6, b: .7}]);
  // 状态检测给出空步行段时回退到周期筛查，不能让一次误判清零结果
  const emptyState = inferOffline(data, {walking: []});
  assert.ok(emptyState.forward && emptyState.fallback, JSON.stringify(emptyState));
  const wrongState = inferOffline(data, {walking: [{a: 14, b: 15.5}]});
  assert.ok(wrongState.forward && wrongState.fallback, JSON.stringify(wrongState));
  const fromState = inferOffline(data, {walking: [{a: 13, b: 17.4}]});
  assert.ok(!fromState.fallback);
  assert.ok(fromState.forward && fromState.walk.a >= 13 && fromState.walk.b < 17.4);
  const mixed = inferOffline(fixture({mode: 'mixed'}));
  assert.deepEqual(mixed.walk, result.walk);
  assert.ok(angle(mixed.forward, result.forward, false) < .01);
  for (const mode of ['turn', 'squat', 'disagree']) {
    const r = inferOffline(fixture({mode}));
    assert.ok(r.up && !r.forward, `${mode}: ${JSON.stringify(r)}`);
  }
  assert.equal(inferOffline(data, {win: {a: 12.8, b: 16}}).forward, undefined);
  assert.equal(inferOffline(fixture({skipQuiet: true}), {win: {a: 10, b: 16}}).up, undefined);
  assert.equal(inferOffline(fixture({gapAt: 3, count: 3})).forward, undefined);
  const quality = fixture({count: 3});
  const ok = new Uint8Array(quality.n).fill(1); ok[3 * hz] = 0;
  assert.equal(inferOffline({...quality, activityIn: {t: quality.t, ok}}).forward, undefined);
  const seq = Float64Array.from(quality.t, (_, i) => i % (3 * hz));
  assert.equal(inferOffline({...quality, activityIn: {t: quality.t, seq}}).forward, undefined);
  assert.ok(inferOffline(fixture({batched: true})).forward);
  assert.ok(angle(inferOffline(fixture({hz: 100})).forward, sensor([1,0,0]), false) < .01);
  assert.ok(inferOffline({n: data.n * 10, blk: data}).forward);
  const endQuiet = fixture({skipQuiet: true});
  const t = Float64Array.from({length: endQuiet.n + 95}, (_, i) => 10 + i / hz);
  const phys = endQuiet.imu.phys.map(p => Float64Array.from(t, (_, i) => p[Math.min(i, p.length - 1)]));
  const lateRef = inferOffline({t, n: t.length, imu: {phys}}, {walking: [{a: 12, b: 17.4}]});
  assert.ok(lateRef.forward && lateRef.quiet.a > lateRef.walk.b);
  // 静站只提供向上与零偏：10 s 内不降级，较远降为「中」，超过 120 s 干脆不用
  const nearRef = inferOffline(fixture({lead: 6}));
  assert.ok(nearRef.forward && nearRef.confB === 'hi' && nearRef.quietDist > 5, JSON.stringify(nearRef));
  const farRef = inferOffline(fixture({lead: 30}));
  assert.ok(farRef.forward && farRef.confB === 'mid' && farRef.quietDist > 10, JSON.stringify(farRef));
  assert.equal(inferOffline(fixture({lead: 150})).forward, undefined);
  const other = fixture({mountFn: v => sensor([-v[1], v[0], v[2]])});
  const bothT = Float64Array.from([...data.t, ...other.t.map(x => x + 12)]);
  const both = data.imu.phys.map((p, i) => Float64Array.from([...p, ...other.imu.phys[i]]));
  const inconsistent = inferOffline({t: bothT, n: bothT.length, imu: {phys: both}});
  assert.ok(inconsistent.up && !inconsistent.forward);
  assert.match(inconsistent.reason, /不一致/);
  const separated = inferOffline({t: bothT, n: bothT.length, imu: {phys: both}},
    {walking: [{a: 12.2, b: 17.4}, {a: 24.2, b: 29.4}]});
  assert.ok(separated.blocked && !separated.fallback && !separated.forward, JSON.stringify(separated));

  const shoe = fixture({count: 6});
  const pressure = Array.from({length: 3}, () => new Float32Array(shoe.n));
  for (let i = 0; i < shoe.n; i++) {
    const w = i / hz - quiet;
    if (w < 0) {
      const tilted = sensor([Math.sin(.7), 0, Math.cos(.7)]);
      for (let j = 0; j < 3; j++) shoe.imu.phys[j][i] = tilted[j];
    } else if (w % period >= .07 && w % period <= .23) {
      [40, 40, 100].forEach((v, j) => pressure[j][i] = v);
    }
    for (let j = 0; j < 3; j++) shoe.imu.phys[j + 3][i] -= bias[j];
  }
  const mask = [{a: 12.2, b: 18.45}];
  assert.ok(angle(inferOffline(shoe, {walking: mask}).up, sensor([0,0,1])) > 35);
  const supported = inferOffline(shoe, {walking: mask, support: pressure});
  assert.ok(supported.forward && supported.supportCycles >= 3 && supported.quietUpDelta > 35, JSON.stringify(supported));
  assert.ok(angle(supported.up, sensor([0,0,1])) < .01);
  assert.ok(angle(supported.forward, sensor([1,0,0]), false) < .01);
  const onlyForefoot = [new Float32Array(shoe.n), pressure[1], pressure[2]];
  const abstain = inferOffline(shoe, {walking: mask, support: onlyForefoot});
  assert.ok(!abstain.up && !abstain.forward && !abstain.fallback);
  assert.match(abstain.reason, /稳定承重/);
  const tiltedSupport = sensor([Math.sin(.7), 0, Math.cos(.7)]);
  for (let i = 0; i < shoe.n; i++) if (shoe.t[i] > 15.4 && pressure[2][i]) {
    for (let j = 0; j < 3; j++) shoe.imu.phys[j][i] = tiltedSupport[j];
  }
  const conflict = inferOffline(shoe, {walking: mask, support: pressure});
  assert.ok(conflict.blocked && !conflict.up && !conflict.forward && !conflict.fallback, JSON.stringify(conflict));
  assert.match(conflict.reason, /承重片段.*不一致/);
  console.log('PASS offline axis: walk masks, rotated mount, gaps and conflicts, pressure reference vs tilted quiet, no unsupported pose');
}
