/* 说明抽屉：页面正文只留数据，格式与算法口径集中到这里，按当前页签自动定位。 */

import {state} from './core/state';

const TAB_SEC: Record<string, string> = {
  wave: 'wave', cop: 'cop', zero: 'zero', gap: 'gap',
  imu: 'imu', axis: 'axis', activity: 'activity', action: 'action'
};

let opener: HTMLElement | null = null;

function box(): HTMLElement | null { return document.getElementById('help'); }
function opened(): boolean { return !!box() && !box()!.hidden; }

function sections(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-help]')];
}

function mark(active: HTMLElement | null): void {
  const id = active?.dataset.help;
  document.querySelectorAll('#helpNav a').forEach(a => a.classList.toggle('on', (a as HTMLElement).dataset.sec === id));
}

function buildNav(nav: HTMLElement): void {
  nav.innerHTML = '';
  for (const s of sections()) {
    const a = document.createElement('a');
    a.href = '#';
    a.dataset.sec = s.dataset.help!;
    a.textContent = s.dataset.title || s.dataset.help!;
    a.addEventListener('click', ev => {
      ev.preventDefault();
      const text = document.getElementById('helpText');
      if (text) text.scrollTop = s.offsetTop - text.offsetTop;
      mark(s);
    });
    nav.appendChild(a);
  }
}

export function openHelp(id?: string): void {
  const b = box();
  if (!b) return;
  b.hidden = false;
  document.body.classList.add('help-open');
  const nav = document.getElementById('helpNav');
  if (nav && !nav.childElementCount) buildNav(nav);
  const key = id || TAB_SEC[state.tab] || (document.body.dataset.page === 'axis' ? 'axis' : 'file');
  const target = document.querySelector<HTMLElement>(`[data-help="${key}"]`)
    || document.querySelector<HTMLElement>('[data-help="file"]');
  const text = document.getElementById('helpText');
  if (text) text.scrollTop = target ? target.offsetTop - text.offsetTop : 0;
  mark(target);
  document.getElementById('helpClose')?.focus();
}

export function closeHelp(): void {
  const b = box();
  if (!b || b.hidden) return;
  b.hidden = true;
  document.body.classList.remove('help-open');
  if (opener) opener.focus();
}

export function bindHelp(): void {
  const btn = document.getElementById('helpBtn');
  if (!btn) return;
  opener = btn;
  btn.addEventListener('click', () => openHelp());
  document.getElementById('helpClose')?.addEventListener('click', closeHelp);
  document.getElementById('helpMask')?.addEventListener('click', closeHelp);
  document.getElementById('helpFoot')?.addEventListener('click', () => {
    opener = document.getElementById('helpFoot') as HTMLElement;
    openHelp('file');
  });
  // 捕获阶段拦 Esc：抽屉开着时先关抽屉，不落到详情卡的 Esc
  window.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && opened()) { ev.stopPropagation(); closeHelp(); }
  }, true);
}
