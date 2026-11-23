import {analyzeAxes, hasPhys} from '../axis';
import {axisStatus, fillCard, makeCard} from './card';
import {SIDE_CN} from '../core/constants';
import {axisView, state} from '../core/state';
import {parse} from '../parse';

const $ = s => document.querySelector(s);
const el = {
  drop: $('#drop'), file: $('#file'), pick: $('#pick'), err: $('#err'), list: $('#fileList'), cards: $('#axCards'),
  note: $('#axNote'), tools: $('#axTools'), clear: $('#axClear')
};
const files = [];
let adding = false;

async function addFiles(list: FileList | File[]) {
  if (adding) return;
  adding = true;
  el.clear.disabled = true;
  try {
    for (const f of Array.from(list || [])) {
      if (files.some(x => x.name === f.name)) continue;
      const old = state.sides;
      await parse(f);
      if (state.sides === old || !state.sides.length) continue;
      const file = {name: f.name, sides: state.sides.filter(hasPhys), rebuilt: state.rebuilt, entries: new Map(), stop: () => {}};
      files.push(file);
      addRecording(file);
    }
  } finally { adding = false; el.clear.disabled = false; }
}

function updateScope() {
  el.tools.hidden = !files.length;
  el.list.hidden = !files.length;
  el.drop.classList.toggle('compact', files.length > 0);
  el.note.textContent = `${files.length} 份录制 · 每份独立分析，不混用时间轴`;
}

function addRecording(file) {
  const row = document.createElement('div'); row.className = 'axfrow';
  const name = document.createElement('span'); name.className = 'nm'; name.textContent = file.name; name.title = file.name;
  const status = document.createElement('span'); status.className = 'chip';
  status.textContent = file.sides.length ? '正在分析' : '没有可用的物理量 IMU';
  const remove = document.createElement('button'); remove.className = 'mini'; remove.textContent = '移除';
  remove.addEventListener('click', () => removeRecording(file));
  row.append(name, status, remove);
  el.list.appendChild(row);
  file.row = row;
  const completed = new Map();
  for (const s of file.sides) {
    const title = `${file.name} · ${SIDE_CN[s.side] || s.side}`;
    const entry = makeCard(s, {title, file: file.name.replace(/\.[^.]+$/, '')});
    el.cards.appendChild(entry.sec);
    file.entries.set(s, entry);
    axisView.set(entry.sec, entry);
    fillCard(entry, null);
  }
  file.stop = analyzeAxes(file.sides, file.rebuilt, undefined, (s, r, source, progress, validTicks) => {
    fillCard(file.entries.get(s), r, source, progress, validTicks);
    if (r) completed.set(s, axisStatus(r));
    if (completed.size === file.sides.length) status.textContent = [...completed.values()].join(' / ');
  });
  updateScope();
}

function removeRecording(file) {
  file.stop();
  files.splice(files.indexOf(file), 1);
  for (const entry of file.entries.values()) { axisView.delete(entry.sec); entry.sec.remove(); }
  file.row.remove();
  updateScope();
}

export function initAxisPage() {
  const hot = on => el.drop.classList.toggle('hot', on);
  el.drop.addEventListener('dragover', e => { e.preventDefault(); hot(true); });
  el.drop.addEventListener('dragleave', () => hot(false));
  el.drop.addEventListener('drop', e => { e.preventDefault(); hot(false); void addFiles(e.dataTransfer.files); });
  el.pick.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => { void addFiles(el.file.files); el.file.value = ''; });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    if (!(e.target as HTMLElement | null)?.closest?.('#drop')) void addFiles(e.dataTransfer.files);
  });
  el.clear.addEventListener('click', () => {
    for (const file of [...files]) removeRecording(file);
    el.err.textContent = '';
  });
}
