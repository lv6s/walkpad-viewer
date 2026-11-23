import assert from 'node:assert/strict';
import {SCORE_SCHEMA, FEATURE_SCHEMA, MAX_BIAS_LIMIT, DEFAULT_PERSONALIZATION, parseScoreModel, predictGrade, fitPersonalBias, boundBias} from '../src/squat-score-model.ts';

/* 人工夹具：权重、中心、尺度、阈值只为契约测试编造，没有任何统计含义，不是生产权重。
   特征名取 squat-score-features 词表中的非质量项，单位与 FEATURE_DEFS 一致；数值本身仍为占位。 */
const KNOWN = new Set(['rep_duration_s', 'descent_s', 'sagittal_excursion_symmetry']);
const json = () => ({
  schema: SCORE_SCHEMA,
  featureSchema: FEATURE_SCHEMA,
  modelId: 'fixture-linear-ordinal-3',
  features: [
    {name: 'rep_duration_s', weight: 1.2, center: 3, scale: .4},
    {name: 'descent_s', weight: .8, center: 1.2, scale: .2},
    {name: 'sagittal_excursion_symmetry', weight: .5, center: .85, scale: .1},
  ],
  thresholds: [-.4, .5],
  clamp: {min: -6, max: 6},
  personalization: {maxBias: .5, l2: 4, minExamples: 12, minPerGrade: 3},
});
const neutral = {rep_duration_s: 3, descent_s: 1.2, sagittal_excursion_symmetry: .85};
const sig = (x) => 1 / (1 + Math.exp(-x));
const near = (actual, expected, eps = 1e-12) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
const bad = (mutate, label) => assert.throws(() => parseScoreModel(mutate(structuredClone(json())), KNOWN), TypeError, label);

const model = parseScoreModel(json(), KNOWN);
assert.equal(model.schema, SCORE_SCHEMA);
assert.equal(model.featureSchema, FEATURE_SCHEMA);
assert.equal(model.modelId, 'fixture-linear-ordinal-3');
assert.equal(model.features.length, 3);
assert.deepEqual(model.thresholds, [-.4, .5]);
console.log('PASS strict v1 contract parsed');

const at0 = predictGrade(model, neutral);
assert.equal(at0.grade, 'fair');
near(at0.score, 0);
near(at0.probabilities.fair, sig(.4) - sig(-.5));
near(at0.probabilities.bad, 1 - sig(.4));
near(at0.probabilities.good, sig(-.5));
near(at0.probabilities.bad + at0.probabilities.fair + at0.probabilities.good, 1);
assert.deepEqual(predictGrade(model, neutral), at0);
console.log('PASS proportional-odds probabilities and determinism');

const better = predictGrade(model, {rep_duration_s: 3.4, descent_s: 1.4, sagittal_excursion_symmetry: .95});
const worse = predictGrade(model, {rep_duration_s: 2.6, descent_s: 1, sagittal_excursion_symmetry: .75});
assert.equal(better.grade, 'good');
assert.equal(worse.grade, 'bad');
assert.ok(better.score > at0.score && at0.score > worse.score);
assert.ok(better.probabilities.good > at0.probabilities.good && at0.probabilities.good > worse.probabilities.good);
console.log('PASS grade order follows score');

assert.equal(predictGrade(model, {rep_duration_s: 3, descent_s: 1.2}), null);
assert.equal(predictGrade(model, {rep_duration_s: 3, descent_s: null, sagittal_excursion_symmetry: .85}), null);
assert.equal(predictGrade(model, {rep_duration_s: 3, descent_s: NaN, sagittal_excursion_symmetry: .85}), null);
assert.equal(predictGrade(model, {rep_duration_s: 3, descent_s: '1.2', sagittal_excursion_symmetry: .85}), null);
assert.equal(predictGrade(model, {rep_duration_s: 3, descent_s: undefined, sagittal_excursion_symmetry: .85}), null);
assert.throws(() => predictGrade(model, null), TypeError);
assert.throws(() => predictGrade(model, neutral, NaN), RangeError);
console.log('PASS missing / null / non-finite features reject instead of imputing');

const extreme = predictGrade(model, {rep_duration_s: 1e9, descent_s: 1e9, sagittal_excursion_symmetry: -1e9});
assert.equal(extreme.score, 6);
assert.ok(Object.values(extreme.probabilities).every(p => p >= 0 && p <= 1 && Number.isFinite(p)));
near(predictGrade(model, {rep_duration_s: -1e9, descent_s: -1e9, sagittal_excursion_symmetry: 1e9}).score, -6);
console.log('PASS standardized features and latent score are clamped');

assert.equal(predictGrade(model, neutral, .2).grade, 'fair');
near(predictGrade(model, neutral, .2).score, .2);
assert.equal(predictGrade(model, neutral, 100).score, .5);
assert.equal(predictGrade(model, neutral, -100).score, -.5);
assert.equal(predictGrade(model, neutral, -.4).grade, 'fair');
assert.equal(predictGrade(model, neutral, -.4000001).grade, 'bad');
assert.equal(predictGrade(model, neutral, .5).grade, 'good');
console.log('PASS personal bias is bounded and thresholds are upper-inclusive');

bad(m => { m.schema = 'walkpad-squat-score-model-v2'; }, 'schema');
bad(m => { m.featureSchema = 'walkpad-squat-features-v2'; }, 'featureSchema');
bad(m => { m.note = 'x'; }, 'unknown root key');
bad(m => { m.modelId = ' '; }, 'empty modelId');
bad(m => { m.modelId = 'x'.repeat(97); }, 'long modelId');
bad(m => { m.features = []; }, 'empty features');
bad(m => { m.features[0].name = 'cadence'; }, 'unknown feature');
bad(m => { m.features[1].name = 'rep_duration_s'; }, 'duplicate feature');
bad(m => { m.features[0].weight = 0; }, 'zero weight');
bad(m => { m.features[0].scale = 0; }, 'non-positive scale');
bad(m => { m.features[0].center = NaN; }, 'non-finite center');
bad(m => { m.features[0].bias = 1; }, 'unknown feature key');
bad(m => { m.thresholds = [.5, -.4]; }, 'reversed thresholds');
bad(m => { m.thresholds = [-.4, -.4]; }, 'equal thresholds');
bad(m => { m.thresholds = [-.4, 6]; }, 'threshold outside clamp');
bad(m => { m.clamp = {min: 6, max: -6}; }, 'inverted clamp');
bad(m => { m.clamp = {min: -60, max: 60}; }, 'huge clamp');
bad(m => { m.clamp.scale = 1; }, 'unknown clamp key');
bad(m => { m.personalization.maxBias = 0; }, 'zero maxBias');
bad(m => { m.personalization.l2 = 0; }, 'zero l2');
bad(m => { m.personalization.minPerGrade = 0; }, 'zero minPerGrade');
bad(m => { m.personalization.minExamples = 5; }, 'minExamples below three grades');
bad(m => { m.personalization.extra = 1; }, 'unknown personalization key');
assert.throws(() => parseScoreModel(json(), new Set(['rep_duration_s'])), TypeError);
assert.throws(() => parseScoreModel(json(), []), TypeError);
console.log('PASS strict rejection of unknown fields, bad ranges and foreign features');

const bare = json();
delete bare.personalization;
assert.deepEqual(parseScoreModel(bare, KNOWN).personalization, {maxBias: .5, l2: 4, minExamples: 12, minPerGrade: 3});
assert.equal(MAX_BIAS_LIMIT, 1.5);
assert.ok(Object.isFrozen(DEFAULT_PERSONALIZATION));
assert.equal(boundBias(model, 100), .5);
assert.equal(boundBias(model, -.4), -.4);
assert.throws(() => boundBias(model, Infinity), RangeError);
assert.equal(JSON.stringify(parseScoreModel(bare, KNOWN)), JSON.stringify(parseScoreModel(json(), KNOWN)));
const reordered = json();
reordered.features.reverse();
assert.notEqual(JSON.stringify(parseScoreModel(reordered, KNOWN)), JSON.stringify(model));
console.log('PASS conservative personalization defaults and normalized model content');

const at = (descent, grade) => ({values: {rep_duration_s: 3, descent_s: descent, sagittal_excursion_symmetry: .85}, grade});
const mixed = [
  at(1.3, 'good'), at(1.3, 'good'), at(1.3, 'good'), at(1.3, 'good'),
  at(1.05, 'fair'), at(1.05, 'fair'), at(1.05, 'fair'), at(1.05, 'fair'),
  at(.7, 'bad'), at(.7, 'bad'), at(.7, 'bad'), at(.7, 'bad'),
];
const fit = fitPersonalBias(model, mixed);
assert.equal(fit.count, 12);
assert.ok(fit.bias > .3 && fit.bias < .45, String(fit.bias));
assert.deepEqual(fitPersonalBias(model, mixed), fit);
assert.equal(predictGrade(model, mixed[0].values).grade, 'fair');
assert.equal(predictGrade(model, mixed[0].values, fit.bias).grade, 'good');
assert.ok(mixed.every(e => predictGrade(model, e.values, fit.bias).grade === e.grade));
console.log('PASS regularized intercept fit is deterministic, bounded and label-consistent', fit.bias.toFixed(4));

const shifted = mixed.concat([
  {values: {rep_duration_s: 3}, grade: 'good'},
  {values: {rep_duration_s: 3, descent_s: null}, grade: 'good'},
]);
assert.equal(fitPersonalBias(model, shifted).count, 12);
console.log('PASS incomplete examples are excluded from the count');

assert.equal(fitPersonalBias(model, mixed.slice(9)), null);
assert.equal(fitPersonalBias(model, mixed.map(e => ({...e, grade: 'fair'}))), null);
assert.equal(fitPersonalBias(model, mixed.map((e, i) => ({...e, grade: i < 6 ? 'bad' : 'good'}))), null);
assert.throws(() => fitPersonalBias(model, mixed.map(e => ({...e, grade: 'great'}))), TypeError);
assert.throws(() => fitPersonalBias(model, mixed.map(e => ({...e, reviewed: true}))), TypeError);
assert.throws(() => fitPersonalBias(model, [...mixed, {values: neutral, grade: 'good', note: 1}]), TypeError);
assert.throws(() => fitPersonalBias(model, null), TypeError);
console.log('PASS insufficient count, missing grade diversity and unreviewed shapes are refused');

const low = (grade) => ({values: {rep_duration_s: 3, descent_s: 1.2, sagittal_excursion_symmetry: .225}, grade});
const saturated = fitPersonalBias(model, [
  low('good'), low('good'), low('good'), low('good'),
  low('fair'), low('fair'), low('fair'), low('fair'),
  low('bad'), low('bad'), low('bad'), low('bad'),
]);
assert.equal(saturated.count, 12);
assert.equal(saturated.bias, .5);
console.log('PASS shift stays inside the declared bound');
