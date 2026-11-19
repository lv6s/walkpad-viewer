/* 全段抽样（LOD）。
   懒加载的长包只把 60 s 窗口读进内存，看全段时没有帧可抽 —— 所以后台全表扫一遍，
   按固定时间网格每格留一帧真实读数。抽帧不是 min–max：异常值只会变成一个孤立的点，
   不会被拉成一条占满整格高低的带子。格子填一帧真值，缺帧的格子在通道里留 NaN 断笔。 */

import type {Lod, Side, SideView} from './types';
import {state} from './core/state';
import {blkOf} from './core/util';

const LOD_N = 32768;         // 每侧格数上限：13 h 下约 1.4 s 一格
const LOD_BIN = 0.5;         // 目标格宽（s），短包不必用满格数
const LOD_MIN_BUCKETS = 900; // 窗口里少于这么多格才值得去读精确块

const nanArr = (n: number): Float32Array => new Float32Array(n).fill(NaN);

function lodInit(s: Side): void {
  if (!(s.dur > 0)) return;
  const n = Math.max(256, Math.min(LOD_N, Math.round(s.dur / LOD_BIN)));
  const t = new Float64Array(n);
  const bin = s.dur / n;
  for (let i = 0; i < n; i++) t[i] = (i + 0.5) * bin;
  s.lod = {n, bin, dur: s.dur, upto: 0, partial: true, t,
    ch: null, imu: null, temp: null, imuMax: null, tLo: NaN, tHi: NaN};
}

function growImu(L: Lod, hasPhys: boolean, hasRaw: boolean): void {
  const six = () => Array.from({length: 6}, () => nanArr(L.n));
  L.imu = {nch: 6, phys: hasPhys ? six() : null, raw: hasRaw ? six() : null};
  L.imuMax = {phys: new Float32Array(6), raw: new Float32Array(6)};
}

/** 扫描读到一帧：只写它落在的那一格。同一格后来者覆盖前者 = 按格抽帧，不合并、不插值。 */
function lodFeed(s: Side, t: number, pv: number[] | null,
                 a6: number[] | null, b6: number[] | null, temp: number): void {
  const L = s.lod;
  if (!L || !(t >= 0) || !(L.dur > 0)) return;
  let b = Math.floor(t / L.dur * L.n);
  if (b < 0) b = 0; else if (b >= L.n) b = L.n - 1;

  if (s.nch > 0) {
    if (!L.ch) L.ch = Array.from({length: s.nch}, () => nanArr(L.n));
    for (let j = 0; j < s.nch; j++) {
      const v = pv ? pv[j] : null;
      L.ch[j][b] = (v != null && Number.isFinite(v)) ? v : NaN;
    }
  }
  if (a6 || b6) {
    if (!L.imu) growImu(L, !!a6, !!b6);
    if (a6 && L.imu.phys) put6(L.imu.phys, L.imuMax.phys, a6, b);
    if (b6 && L.imu.raw) put6(L.imu.raw, L.imuMax.raw, b6, b);
  }
  if (Number.isFinite(temp)) {
    if (!L.temp) L.temp = new Float64Array(L.n).fill(NaN);
    L.temp[b] = temp;
    if (!Number.isFinite(L.tLo) || temp < L.tLo) L.tLo = temp;
    if (!Number.isFinite(L.tHi) || temp > L.tHi) L.tHi = temp;
  }
  if (t > L.upto) L.upto = t;
}

function put6(dst: Float32Array[], mx: Float32Array, arr: number[], b: number): void {
  for (let j = 0; j < 6; j++) {
    const v = arr[j];
    if (!Number.isFinite(v)) continue;
    dst[j][b] = v;
    const a = Math.abs(v);
    if (a > mx[j]) mx[j] = a;
  }
}

function lodDone(s: Side): void {
  if (!s.lod) return;
  s.lod.partial = false;
  s.lod.upto = s.lod.dur;
}

// ---------------------------------------------------------------- 渲染侧
/** 该跨度该不该画抽样：窗口里至少能有 LOD_MIN_BUCKETS 个格才值得 */
function useLod(s: Side, a: number, b: number): boolean {
  const L = s.lod;
  if (!L || !s.lazy || !(L.bin > 0)) return false;
  return (b - a) / L.bin >= LOD_MIN_BUCKETS;
}

/** 绘图与读数统一走这里：跨度大就用抽样，否则用已载入的精确块 */
function dataOf(s: Side, a: number, b: number): SideView {
  if (!useLod(s, a, b)) return blkOf(s);
  const L = s.lod;
  return Object.assign(Object.create(s), {
    n: L.n, t: L.t, ch: L.ch || [], imu: L.imu, temp: L.temp,
    a: 0, b: L.dur, tLo: L.tLo, tHi: L.tHi, _lod: true
  }) as SideView;
}

/**
 * 抽样步长。
 * 往粗里抽听用户的：选了 0.1 Hz 就按 0.1 Hz 取。
 * 往细里抽不听：一像素画三个点以上只是把同一条线重描一遍，白花时间。
 */
function stepOf(nInWin: number, span: number, plotW: number, hz: number): number {
  if (!(nInWin > 0) || !(hz > 0) || !isFinite(hz)) return 1;
  const cap = Math.max(1, Math.floor(nInWin / Math.max(1, plotW * 3)));
  if (!state.drawHz) return cap;
  return Math.max(cap, Math.max(1, Math.round(hz / state.drawHz)));
}

/** 当前绘制数组自身的采样率：精确块用平均记录率，抽样用格宽的倒数 */
function hzOf(s: Side, view: SideView): number {
  if (view._lod && s.lod) return 1 / s.lod.bin;
  return isFinite(s.fs) && s.fs > 0 ? s.fs : 50;
}

export {dataOf, hzOf, lodDone, lodFeed, lodInit, stepOf, useLod};
