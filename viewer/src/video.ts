/* 测量包里的现场视频：浮窗播放，并用一个显式 offset 挂到会话时间轴上。
   包内没有视频起点字段（manifest / timeline 都没有），所以起点只能推定或手填，
   口径固定为「会话时刻 = 视频时刻 + offset」，不做任何隐式对齐。 */

import {el} from './core/dom';
import {state} from './core/state';
import {paintVideoCursor} from './imu';

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm'
};

const s2 = (v: number): string => Number.isFinite(v) ? v.toFixed(2) : '—';

// 会话末端：视频起点推定要拿它当参照，取所有流里最晚的末端
const sessionDur = (): number => state.sides.length ? Math.max(...state.sides.map(s => s.dur)) : 0;

export function attachVideo(u8: Uint8Array, name: string, total = 1): void {
  clearVideo();
  const ext = (name.split('.').pop() || '').toLowerCase();
  // zip 里的字节是整包 buffer 上的视图，Blob 要独占的 ArrayBuffer 才收
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([ab], {type: MIME[ext] || 'video/mp4'}));
  state.video = {url, name, bytes: u8.byteLength, offset: 0, auto: true, dur: NaN, total};
  if (el.vidToggle) el.vidToggle.hidden = false;
  if (el.vid) el.vid.src = url;
  if (el.vidPanel) el.vidPanel.hidden = false;
  renderVideo();
}

// 换文件时必须撤销旧 URL：blob 不撤销就一直占着内存，几个大包之后页面会明显变卡
export function clearVideo(): void {
  const old = state.video;
  if (old) URL.revokeObjectURL(old.url);
  state.video = null;
  state.videoT = null;
  paintVideoCursor();
  if (el.vidToggle) el.vidToggle.hidden = true;
  if (el.vidPanel) el.vidPanel.hidden = true;
  if (el.vid) { el.vid.pause(); el.vid.removeAttribute('src'); el.vid.load(); }
}

/** 起点推定：录制在停止时收尾，视频结束大致就是会话结束，据此反推视频 0 s 落在哪 */
function guessOffset(): number {
  const vid = state.video;
  if (!vid) return 0;
  const D = sessionDur();
  if (!Number.isFinite(vid.dur) || !(D > 0)) return 0;
  return Math.max(0, Math.round((D - vid.dur) * 100) / 100);
}

// 视频时刻 → 会话时刻。IMU 页的游标只读 state.videoT，所以这里写一次就够
// （暂停时保留最后位置，方便停下来对着波形看）
function syncTime(): void {
  const vid = state.video;
  state.videoT = vid && el.vid ? (el.vid.currentTime || 0) + vid.offset : null;
  paintVideoCursor();
}

function nowText(): string {
  const vid = state.video;
  if (!vid || !el.vid) return '';
  const t = el.vid.currentTime || 0;
  return `视频 ${s2(t)} s → 会话 ${s2(t + vid.offset)} s`;
}

function renderVideo(): void {
  const vid = state.video;
  if (!vid || !el.vidPanel) return;
  el.vidName.textContent = `${vid.name} · ${s2(vid.dur)} s`
    + (vid.total > 1 ? `（包内共 ${vid.total} 段，只载入第一段）` : '');
  if (document.activeElement !== el.vidOff) el.vidOff.value = vid.auto ? vid.offset.toFixed(2) : String(vid.offset);
  el.vidNote.textContent = vid.auto ? '起点为推定值（视频结束 ≈ 录制结束）' : '起点为手动给定';
  el.vidNote.title = '会话时刻 = 视频时刻 + 起点；「跳到会话」只接受视频覆盖到的区间，越界会提示而不会贴边。';
  el.vidNow.textContent = nowText();
  syncTime();
}

function setOffset(v: number, auto = false): void {
  const vid = state.video;
  if (!vid || !Number.isFinite(v)) return;
  vid.offset = v;
  vid.auto = auto;
  renderVideo();
}

function seekSession(t: number): void {
  const vid = state.video;
  if (!vid || !el.vid || !Number.isFinite(t)) return;
  const vt = t - vid.offset;
  if (!(vt >= 0) || (Number.isFinite(vid.dur) && vt > vid.dur)) {
    el.vidJump.setCustomValidity(`视频只覆盖会话 ${s2(vid.offset)}–${s2(vid.offset + (vid.dur || 0))} s。`);
    el.vidJump.reportValidity();
    return;
  }
  el.vidJump.setCustomValidity('');
  el.vid.currentTime = vt;
  el.vidNow.textContent = nowText();
  syncTime();
}

// 竖屏录制（手机竖着拍）按 340 px 摆只能看到一条窄缝，改按高度上限收窄浮窗，
// 横屏片仍用基准宽度
function fitPanel(): void {
  const v = el.vid;
  if (!el.vidPanel || !v || !v.videoWidth || !v.videoHeight) return;
  const ar = v.videoWidth / v.videoHeight;
  const maxH = window.innerHeight * 0.40;
  const w = ar < 1 ? Math.min(maxH * ar, 340) : 340;
  el.vidPanel.style.width = Math.round(Math.max(240, Math.min(440, w))) + 'px';
}

export function toggleVideoPanel(show?: boolean): void {
  if (!el.vidPanel || !state.video) return;
  el.vidPanel.hidden = show == null ? !el.vidPanel.hidden : !show;
  // 收起后游标也收掉：看不见视频还留一条线在波形上会让人对不上它是谁的
  state.videoT = el.vidPanel.hidden ? null : (el.vid.currentTime || 0) + state.video.offset;
  paintVideoCursor();
}

/* 拖动标题栏挪位置：浮窗压在波形上时得能挪开，挪过之后不再回到右下角 */
function bindDrag(): void {
  let drag: {dx: number; dy: number} | null = null;
  el.vidHead.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0 || (ev.target as HTMLElement).closest('button')) return;
    const r = el.vidPanel.getBoundingClientRect();
    drag = {dx: ev.clientX - r.left, dy: ev.clientY - r.top};
    el.vidPanel.style.right = 'auto';
    el.vidPanel.style.bottom = 'auto';
    el.vidPanel.style.left = r.left + 'px';
    el.vidPanel.style.top = r.top + 'px';
    el.vidHead.setPointerCapture(ev.pointerId);
  });
  el.vidHead.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!drag) return;
    const w = el.vidPanel.offsetWidth, h = el.vidPanel.offsetHeight;
    el.vidPanel.style.left = Math.max(0, Math.min(window.innerWidth - w, ev.clientX - drag.dx)) + 'px';
    el.vidPanel.style.top = Math.max(0, Math.min(window.innerHeight - h, ev.clientY - drag.dy)) + 'px';
  });
  el.vidHead.addEventListener('pointerup', () => { drag = null; });
  el.vidHead.addEventListener('pointercancel', () => { drag = null; });
}

export function bindVideo(): void {
  if (!el.vidPanel) return;
  bindDrag();
  el.vidToggle.addEventListener('click', () => toggleVideoPanel());
  el.vidClose.addEventListener('click', () => toggleVideoPanel(false));
  el.vid.addEventListener('loadedmetadata', () => {
    const vid = state.video;
    if (!vid) return;
    vid.dur = el.vid.duration;
    if (vid.auto) vid.offset = guessOffset();
    fitPanel();
    renderVideo();
  });
  el.vid.addEventListener('timeupdate', () => { el.vidNow.textContent = nowText(); syncTime(); });
  // 拖动视频进度条时 timeupdate 太稀，游标要跟手
  el.vid.addEventListener('seeking', () => { el.vidNow.textContent = nowText(); syncTime(); });
  el.vidOff.addEventListener('input', () => {
    const v = parseFloat(el.vidOff.value);
    if (Number.isFinite(v)) setOffset(v);
  });
  el.vidAuto.addEventListener('click', () => setOffset(guessOffset(), true));
  el.vidJump.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    seekSession(parseFloat(el.vidJump.value));
  });
}
