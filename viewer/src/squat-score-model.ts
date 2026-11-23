/* 深蹲 3 档评分（bad < fair < good）的可替换线性比例优势模型。
   契约走 JSON：先 JSON.parse 再 parseScoreModel；文本里的重复键、数值精度由调用方负责。
   特征完整才出分，缺失 / null / 非有限值一律返回 null，不做插补。 */

export const SCORE_SCHEMA = 'walkpad-squat-score-model-v1';
export const FEATURE_SCHEMA = 'walkpad-squat-features-v1';
export type Grade = 'bad' | 'fair' | 'good';

export interface ScoreFeature {
  name: string;
  weight: number;
  center: number;
  scale: number;
}

export interface ScorePolicy {
  maxBias: number;
  l2: number;
  minExamples: number;
  minPerGrade: number;
}

export interface ScoreModel {
  schema: typeof SCORE_SCHEMA;
  featureSchema: typeof FEATURE_SCHEMA;
  modelId: string;
  features: readonly ScoreFeature[];
  thresholds: readonly [number, number];
  clamp: {min: number; max: number};
  personalization: ScorePolicy;
}

export interface GradePrediction {
  grade: Grade;
  score: number;
  probabilities: Record<Grade, number>;
}

export interface BiasFit {bias: number; count: number}

const GRADES = ['bad', 'fair', 'good'] as const;
export const MAX_BIAS_LIMIT = 1.5;
export const DEFAULT_PERSONALIZATION: Readonly<ScorePolicy> = Object.freeze({maxBias: .5, l2: 4, minExamples: 12, minPerGrade: 3});
const MAX_FEATURES = 32, MAX_LATENT = 20, MAX_Z = 64, MAX_WEIGHT = 1e6;

function fail(path: string, why: string): never { throw new TypeError(`评分模型 ${path}：${why}`); }

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, '必须是 JSON 对象。');
  return value as Record<string, unknown>;
}

function only(node: Record<string, unknown>, allowed: readonly string[], path: string) {
  for (const key of Object.keys(node)) if (!allowed.includes(key)) fail(`${path}.${key}`, '是未知字段。');
}

function text(value: unknown, path: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 96 || /[\u0000-\u001f\u007f]/.test(value)) fail(path, '必须是不超过 96 字符的非空文本。');
  return value;
}

function finite(value: unknown, path: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数值。');
  return value as number;
}

function policy(node: unknown): ScorePolicy {
  if (node === undefined) return {...DEFAULT_PERSONALIZATION};
  const box = record(node, 'personalization');
  only(box, ['maxBias', 'l2', 'minExamples', 'minPerGrade'], 'personalization');
  const maxBias = finite(box.maxBias, 'personalization.maxBias');
  const l2 = finite(box.l2, 'personalization.l2');
  const minExamples = finite(box.minExamples, 'personalization.minExamples');
  const minPerGrade = finite(box.minPerGrade, 'personalization.minPerGrade');
  if (!(maxBias > 0 && maxBias <= MAX_BIAS_LIMIT)) fail('personalization.maxBias', `必须在 (0, ${MAX_BIAS_LIMIT}] 内。`);
  if (!(l2 >= .25 && l2 <= 100)) fail('personalization.l2', '必须在 [0.25, 100] 内。');
  if (!Number.isInteger(minExamples) || minExamples < 3 || minExamples > 10000) fail('personalization.minExamples', '必须是 3–10000 的整数。');
  if (!Number.isInteger(minPerGrade) || minPerGrade < 1 || minPerGrade > 100) fail('personalization.minPerGrade', '必须是 1–100 的整数。');
  if (minExamples < 3 * minPerGrade) fail('personalization.minExamples', '不得小于三档各 minPerGrade 条。');
  return {maxBias, l2, minExamples, minPerGrade};
}

export function parseScoreModel(input: unknown, knownFeatures: ReadonlySet<string>): ScoreModel {
  if (typeof knownFeatures?.has !== 'function') throw new TypeError('已知特征集合必须是 Set。');
  const root = record(input, '根');
  only(root, ['schema', 'featureSchema', 'modelId', 'features', 'thresholds', 'clamp', 'personalization'], '根');
  if (root.schema !== SCORE_SCHEMA) fail('schema', `必须是 ${SCORE_SCHEMA}。`);
  if (root.featureSchema !== FEATURE_SCHEMA) fail('featureSchema', `必须是 ${FEATURE_SCHEMA}。`);
  const modelId = text(root.modelId, 'modelId');
  const clamp = record(root.clamp, 'clamp');
  only(clamp, ['min', 'max'], 'clamp');
  const min = finite(clamp.min, 'clamp.min'), max = finite(clamp.max, 'clamp.max');
  if (!(min < max)) fail('clamp', 'min 必须小于 max。');
  if (Math.max(Math.abs(min), Math.abs(max)) > MAX_LATENT) fail('clamp', `绝对值不得超过 ${MAX_LATENT}。`);
  const list = root.features;
  if (!Array.isArray(list) || !list.length || list.length > MAX_FEATURES) fail('features', `必须是 1–${MAX_FEATURES} 项的数组。`);
  const names = new Set<string>();
  const features = list.map((raw, i) => {
    const path = `features[${i}]`, node = record(raw, path);
    only(node, ['name', 'weight', 'center', 'scale'], path);
    const name = text(node.name, `${path}.name`);
    if (!knownFeatures.has(name)) fail(`${path}.name`, `不是已知特征：${name}。`);
    if (names.has(name)) fail(`${path}.name`, '重复出现。');
    names.add(name);
    const weight = finite(node.weight, `${path}.weight`), center = finite(node.center, `${path}.center`), scale = finite(node.scale, `${path}.scale`);
    if (!weight) fail(`${path}.weight`, '不得为 0。');
    if (!(Math.abs(weight) <= MAX_WEIGHT)) fail(`${path}.weight`, `绝对值不得超过 ${MAX_WEIGHT}。`);
    if (!(scale > 0)) fail(`${path}.scale`, '必须大于 0。');
    return {name, weight, center, scale};
  });
  const rawThresholds = root.thresholds;
  if (!Array.isArray(rawThresholds) || rawThresholds.length !== 2) fail('thresholds', '必须是 2 项数组。');
  const low = finite(rawThresholds[0], 'thresholds[0]'), high = finite(rawThresholds[1], 'thresholds[1]');
  if (!(min < low && low < high && high < max)) fail('thresholds', '必须严格递增且落在 clamp 内。');
  return {schema: SCORE_SCHEMA, featureSchema: FEATURE_SCHEMA, modelId, features, thresholds: [low, high], clamp: {min, max}, personalization: policy(root.personalization)};
}

const logistic = (x: number) => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));

export function boundBias(model: ScoreModel, bias: number): number {
  if (!Number.isFinite(bias)) throw new RangeError('个人偏置必须是有限数值。');
  const limit = model.personalization.maxBias;
  return Math.max(-limit, Math.min(limit, bias));
}

export function predictGrade(model: ScoreModel, values: Record<string, number | null>, bias = 0): GradePrediction | null {
  if (!Number.isFinite(bias)) throw new RangeError('个人偏置必须是有限数值。');
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new TypeError('特征必须是对象。');
  let latent = 0;
  for (const feature of model.features) {
    if (!Object.hasOwn(values, feature.name)) return null;
    const value = values[feature.name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    latent += feature.weight * Math.max(-MAX_Z, Math.min(MAX_Z, (value - feature.center) / feature.scale));
  }
  // clamp 只约束模型潜变量，个人偏置在钳制之后叠加，保证拟合时梯度单调。
  const score = Math.max(model.clamp.min, Math.min(model.clamp.max, latent)) + boundBias(model, bias);
  const fair = logistic(score - model.thresholds[0]), good = logistic(score - model.thresholds[1]);
  return {
    grade: score < model.thresholds[0] ? 'bad' : score < model.thresholds[1] ? 'fair' : 'good',
    score,
    probabilities: {bad: 1 - fair, fair: fair - good, good},
  };
}

export function fitPersonalBias(model: ScoreModel, examples: readonly {values: Record<string, number | null>; grade: Grade}[]): BiasFit | null {
  if (!Array.isArray(examples)) throw new TypeError('标注样本必须是数组。');
  const {maxBias, l2, minExamples, minPerGrade} = model.personalization;
  const tally: Record<Grade, number> = {bad: 0, fair: 0, good: 0}, rows: {score: number; grade: Grade}[] = [];
  examples.forEach((example, i) => {
    const path = `examples[${i}]`, box = record(example, path);
    only(box, ['values', 'grade'], path);
    const grade = box.grade;
    if (grade !== 'bad' && grade !== 'fair' && grade !== 'good') fail(`${path}.grade`, '必须是 bad / fair / good。');
    const values = box.values;
    if (typeof values !== 'object' || values === null || Array.isArray(values)) fail(`${path}.values`, '必须是特征对象。');
    const prediction = predictGrade(model, values as Record<string, number | null>);
    if (!prediction) return;
    tally[grade]++;
    rows.push({score: prediction.score, grade});
  });
  if (rows.length < minExamples) return null;
  if (GRADES.some(grade => tally[grade] < minPerGrade)) return null;
  const gradient = (b: number) => rows.reduce((sum, row) => {
    const s = row.score + b, fair = logistic(s - model.thresholds[0]), good = logistic(s - model.thresholds[1]);
    return sum + (row.grade === 'bad' ? -fair : row.grade === 'good' ? 1 - good : 1 - fair - good);
  }, -l2 * b);
  let lo = -maxBias, hi = maxBias;
  if (gradient(lo) <= 0) return {bias: lo, count: rows.length};
  if (gradient(hi) >= 0) return {bias: hi, count: rows.length};
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (gradient(mid) > 0) lo = mid; else hi = mid;
  }
  return {bias: (lo + hi) / 2, count: rows.length};
}
