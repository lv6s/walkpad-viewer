import assert from 'node:assert/strict';
import {FEATURE_DEFS, extractSquatFeatures} from '../src/squat-score-features.ts';

const HZ = 50, START = 100, N = 50 * 12 + 1;
const at = (t) => Math.round((t - START) * HZ);

function fill(x, i, acc, gyro) {
  const o = i * 6;
  for (let k = 0; k < 3; k++) {x[o + k] = acc[k]; x[o + 3 + k] = gyro[k];}
}

const phase = new Int8Array(N);
const left = new Float64Array(N * 6), right = new Float64Array(N * 6);
const gyro0 = [0.5, -0.3, 0.2];
for (let i = 0; i < N; i++) {
  const t = START + i / HZ;
  fill(left, i, [0, 0, 1], gyro0);
  fill(right, i, [0, 0, 1], gyro0);
  if (t >= 103 && t < 104.2) phase[i] = t < 104 ? 1 : 2;
  else if (t >= 104.2 && t < 105.2) phase[i] = 3;
  else if (t >= 107.5 && t < 108.3) phase[i] = 1;
  else if (t >= 108.3 && t < 108.5) phase[i] = 2;
  else if (t >= 108.5 && t < 109.3) phase[i] = 3;
}

for (let i = at(103); i <= at(105.2); i++) {
  const t = START + i / HZ;
  const az = 1 + .2 * Math.sin(2 * Math.PI * 1.5 * (t - 103));
  if (t < 104) fill(left, i, [0, 0, az], [gyro0[0] + 90, gyro0[1], gyro0[2]]);
  else if (t < 104.2) fill(left, i, [0, 0, az], [gyro0[0] + 2, gyro0[1], gyro0[2]]);
  else fill(left, i, [0, 0, az], [gyro0[0] - 90, gyro0[1], gyro0[2]]);

  const gx = t < 104 ? -90 : t < 104.2 ? 2 : 90;
  fill(right, i, [0, 0, 1], [gyro0[0] + gx, gyro0[1] + (t < 104 ? 12 : 0), gyro0[2]]);
}

const rep1 = [103, 104, 104.2, 105.2];
const rep2 = [107.5, 108.3, 108.5, 109.3];
const out = extractSquatFeatures(START, phase, [left, right], [rep1, rep2]);

assert.equal(out.length, 2);
for (const r of out) {
  assert.deepEqual(Object.keys(r.values).sort(), FEATURE_DEFS.map(d => d.key).sort());
  for (const v of Object.values(r.values)) assert(v === null || Number.isFinite(v));
}

const close = (v, x) => assert(Math.abs(v - x) < 1e-9, `${v} != ${x}`);
const a = out[0].values;
close(a.rep_duration_s, 2.2);
close(a.descent_s, 1);
close(a.bottom_s, .2);
close(a.ascent_s, 1);
close(a.descent_ascent_ratio, 1);
close(a.movement_duration_s, 2);
assert.equal(a.coverage_left, 1);
assert.equal(a.coverage_right, 1);
assert.equal(a.coverage_bilateral, 1);
assert.equal(a.coverage_wrist, null);
assert.equal(a.wrist_gyro_rms_dps, null);
assert(Math.abs(a.sagittal_speed_peak_dps_left - 90) < 1e-6);
assert(a.sagittal_speed_peak_dps_right > 90 && a.sagittal_speed_peak_dps_right < 92);
assert(a.sagittal_excursion_deg_left > 180);
assert(a.sagittal_excursion_deg_right > 180);
assert(a.sagittal_range_deg_left > 85 && a.sagittal_range_deg_left < 100);
assert(a.sagittal_range_deg_left < a.sagittal_excursion_deg_left);
assert(Math.abs(a.lateral_range_deg_left) < 1e-6);
assert(a.lateral_range_deg_right > 10 && a.lateral_range_deg_right < 13);
assert(Math.abs(a.sagittal_range_lr_abs_deg - Math.abs(a.sagittal_range_deg_left - a.sagittal_range_deg_right)) < 1e-9);
assert(Math.abs(a.lateral_speed_peak_dps_left) < 1e-6);
assert(a.lateral_speed_peak_dps_right > 0 && a.lateral_speed_peak_dps_right < 12);
assert(a.sagittal_axis_confidence_left > .98);
assert(a.sagittal_axis_confidence_right > .9);
assert(Math.abs(a.bottom_speed_rms_dps_left - 2) < 1e-6);
assert(a.sagittal_excursion_symmetry > .98);
assert(Math.abs(a.sagittal_motion_balance_left - .5) < .02);
assert(Math.abs(a.return_gravity_angle_deg_left) < 1e-6);
assert(Math.abs(a.return_gravity_angle_deg_right) < 1e-6);
assert(Math.abs(a.return_gyro_bias_delta_dps_left) < 1e-6);
assert(a.acc_dynamic_rms_g_left > 0);
assert(a.acc_magnitude_jerk_rms_g_s_left > 0);
assert.deepEqual(out[0].issues, []);

const again = extractSquatFeatures(START, phase, [left, right], [rep1, rep2]);
assert.equal(JSON.stringify(again), JSON.stringify(out));

// 无站立：相位缺口覆盖所有 phase==0，重力方向与前后站立特征必须为 null。
const gapPhase = Int8Array.from(phase, p => p === 0 ? -1 : p);
const gap = extractSquatFeatures(START, gapPhase, [left, right], [rep1])[0];
assert.equal(gap.values.rep_duration_s !== null, true);
close(gap.values.rep_duration_s, 2.2);
assert.equal(gap.values.sagittal_speed_peak_dps_left, null);
assert.equal(gap.values.bottom_speed_rms_dps_left, null);
assert.equal(gap.values.lateral_range_deg_left, null);
assert.equal(gap.values.return_gravity_angle_deg_left, null);
assert.notEqual(gap.values.acc_dynamic_rms_g_left, null);
assert(gap.issues.some(s => s.includes('缺少相邻站立基线')));

// 相邻深蹲太近：不能借用上一次的站立段。
const near = extractSquatFeatures(START, phase, [left, right], [rep1, [105.3, 105.5, 105.6, 106]]);
assert(near[1].issues.some(s => s.includes('缺少动作前站立基线')));
assert.equal(near[1].values.return_gravity_angle_deg_left, null);
assert.notEqual(near[1].values.return_gravity_angle_deg_left, 0);

// 缺口：1 s 的 NaN 拉低覆盖，但不能伪造缺失的数值。
const holed = new Float64Array(left);
for (let i = at(103.5); i <= at(104.5); i++) for (let k = 0; k < 6; k++) holed[i * 6 + k] = NaN;
const hole = extractSquatFeatures(START, phase, [holed, right], [rep1])[0];
assert.equal(hole.values.coverage_left < .8, true);
assert(hole.issues.some(s => s.includes('左踝数据覆盖不足')));
assert(Number.isFinite(hole.values.sagittal_speed_peak_dps_left));
assert(Number.isFinite(hole.values.return_gravity_angle_deg_left));
assert.equal(hole.values.lateral_range_deg_left, null);

// 插值后的 raw 仍可能是有限值；phase==-1 也必须按缺口处理。
const phaseHole = Int8Array.from(phase);
for (let i = at(103.5); i <= at(104.5); i++) phaseHole[i] = -1;
const ph = extractSquatFeatures(START, phaseHole, [left, right], [rep1])[0];
assert(ph.values.coverage_left < .8);
assert(ph.issues.some(s => s.includes('左踝数据覆盖不足')));

// 主轴不集中时不输出侧向峰峰值（符号和方向都不可信）。
const iso = new Float64Array(left);
for (let i = at(103); i <= at(105.2); i++) {
  const th = 2 * Math.PI * (START + i / HZ - 103);
  fill(iso, i, [0, 0, 1], [gyro0[0] + 90 * Math.cos(th), gyro0[1] + 90 * Math.sin(th), gyro0[2]]);
}
const isoOut = extractSquatFeatures(START, phase, [iso, right], [rep1])[0];
assert(isoOut.values.sagittal_axis_confidence_left < .1);
assert.equal(isoOut.values.lateral_range_deg_left, null);
assert(isoOut.issues.some(s => s.includes('主旋转轴不集中')));

// 站立段与动作之间有一个缺口时，不向更远处借站立基线。
const edgeGap = new Float64Array(left);
for (let k = 0; k < 6; k++) edgeGap[at(103) * 6 - 6 + k] = NaN;
const eg = extractSquatFeatures(START, phase, [edgeGap, right], [rep1])[0];
assert(eg.issues.some(s => s.includes('缺少动作前站立基线')));
assert.equal(eg.values.return_gravity_angle_deg_left, null);

// 腕部可选；提供后才计算腕部特征。
const wrist = new Float64Array(N * 6);
for (let i = 0; i < N; i++) {
  const t = START + i / HZ, gx = t >= 103 && t < 105.2 ? 20 : 0;
  fill(wrist, i, [0, 0, 1 + .1 * Math.sin(t)], [gx, 0, 0]);
}
const withWrist = extractSquatFeatures(START, phase, [left, right], [rep1], wrist)[0];
assert.equal(withWrist.values.coverage_wrist, 1);
assert(withWrist.values.wrist_gyro_rms_dps > 0);
assert(withWrist.values.wrist_gyro_path_deg > 40);
assert(withWrist.values.wrist_acc_dynamic_rms_g > 0);
assert(withWrist.values.wrist_acc_dev_p90_g > 0);
assert(withWrist.values.wrist_acc_magnitude_jerk_rms_g_s > 0);

// coverage_* 只作质量门控，不进入 grade 白名单。
const quality = FEATURE_DEFS.filter(d => d.quality).map(d => d.key).sort();
assert.deepEqual(quality, ['coverage_bilateral', 'coverage_left', 'coverage_right', 'coverage_wrist']);

// 非法边界只保留 null，不拿邻次数据补。
const bad = extractSquatFeatures(START, phase, [left, right], [[105, 104, 104.2, 105.2]])[0];
assert(bad.issues.includes('无效的深蹲边界'));
assert(Object.values(bad.values).every(v => v === null));

const axis=(base,delta)=>Float64Array.from(phase,(_,i)=>((base+(Math.abs(i-at(104.1))<=12 ? delta : 0)+540)%360)-180);
const device=[[axis(175,20),axis(0,11)],[axis(-170,-12),axis(0,-6)]];
const angles=extractSquatFeatures(START,phase,[left,right],[rep1],undefined,device)[0].values;
close(angles.device_pitch_bottom_deg_left,20);
close(angles.device_pitch_bottom_deg_right,12);
close(angles.device_pitch_lr_deg,8);
close(angles.device_tilt_lr_deg,5);
close(angles.device_tilt_range_deg_right,6);
assert(Number.isFinite(angles.device_motion_lr_ratio));
device[1][0][at(104)]=NaN;
const missingAngles=extractSquatFeatures(START,phase,[left,right],[rep1],undefined,device)[0].values;
assert.equal(missingAngles.device_pitch_lr_deg,null);
close(missingAngles.device_pitch_bottom_deg_left,20);
assert.equal(missingAngles.coverage_bilateral,1);

assert.equal(new Set(FEATURE_DEFS.map(d => d.key)).size, FEATURE_DEFS.length);

console.log(`squat-score-features: ${FEATURE_DEFS.length} defs, ${out.length} reps OK`);
