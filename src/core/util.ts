/* 通用工具：格式化、下载、错误提示，以及「块视图」这个跨层契约。 */

import type {Side, SideView} from '../types';
import {el} from './dom';
import {state} from './state';

export const css = (v: string): string => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export const fmt = (v: number, n?: number): string =>
  Number(v).toLocaleString('zh-CN', {maximumFractionDigits: n == null ? 0 : n});

/** 时长：过了 1 h 就不该再看着 46800.00 s */
export const fmtDur = (v: number): string => v >= 3600 ? (v / 3600).toFixed(2) + ' h' : v.toFixed(2) + ' s';

/** 时间轴刻度：跨度决定单位，免得 13 h 的轴挤成一串 5 位数 */
export function fmtT(v: number, span: number): string {
  if (!Number.isFinite(v)) return '—';
  if (span >= 3600) return (v / 3600).toFixed(1) + ' h';
  if (span >= 120) {
    const s = Math.round(v);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  return v.toFixed(span < 1 ? 2 : (span < 10 ? 1 : 0));
}

export const baseName = (): string => (state.name || 'data').replace(/\.(parquet|txt|csv|zip)$/i, '');

export function downloadCanvas(cv: HTMLCanvasElement, name: string): void {
  if (!cv || !cv.width) return;
  const a = document.createElement('a');
  a.href = cv.toDataURL('image/png');
  a.download = name;
  a.click();
}

export function downloadCsv(rows: string[], name: string): void {
  const blob = new Blob(['\uFEFF' + rows.join('\n')], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 图上的小按钮：各页共用一套样式 */
export function miniBtn(text: string, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'mini'; b.type = 'button';
  b.textContent = text; b.title = title;
  b.addEventListener('click', fn);
  return b;
}

export function miniRow(...btns: HTMLElement[]): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;gap:6px;justify-content:center;margin-top:4px';
  d.append(...btns);
  return d;
}

export function niceMax(v: number): number {
  if (!(v > 0)) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

export function fail(msg: string): void {
  if (!el.err) return;
  el.err.textContent = msg;
  el.err.classList.add('on');
}

export function clearErr(): void {
  if (el.err) el.err.classList.remove('on');
}

/* 计算与绘图统一读「窗口块」：懒加载时 s 上只有全段时间轴与统计，
   压力与 IMU 在 s.blk 里；整段载入时两者是同一批数组，视图与 s 等价。
   ⚠ 拿到的下标只对同一个块有效，不能与 s.n / s.t 混用。 */
export const blkOf = (s: Side): SideView => Object.assign(Object.create(s), s.blk || {}) as SideView;

export const med = (a: ArrayLike<number>): number => {
  const b = Array.from(a).filter(v => isFinite(v)).sort((x, y) => x - y), m = b.length;
  return m ? (m % 2 ? b[m >> 1] : (b[m / 2 - 1] + b[m / 2]) / 2) : NaN;
};
