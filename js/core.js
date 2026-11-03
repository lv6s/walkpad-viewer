/* 全局基础设施：元素寻址、日志、格式化、下载、名称记忆。 */

/* 面板内元素左右脚各一份（id 带 -l/-r 后缀）：irCur 决定 $() 取哪只脚的，
   也可显式传 foot。面板外元素不受影响。 */
const IR_ELS = new Set(('btnFmtRead btnFmtSet btnIrCsv btnIrOff dvFmt dvLink dvStat dvUnit ' +
  'irAux irBad irChart irDev irInfo irLen irN irPress irRate irRaw irStat irTs irax iray iraz irgx irgy irgz ' +
  'prHover prScaleBar prScaleMax prTopo pwChart pwCur pwLive pwN pwName ' +
  'irBias irStill btnBiasReset').split(' '));

let irCur = 'l';

const $ = (id, foot) => document.getElementById(IR_ELS.has(id) ? id + '-' + (foot || irCur) : id);

window.addEventListener('error', (e) => log('脚本错误：' + e.message + ' @' + e.lineno, 'e'));

const CLOCK = { wall0: Date.now(), perf0: performance.now() };

const state = {
  devices: new Map(), order: [],
  T0: 0, tEnd: 0, window: 10, mode: 'grid',
  cmp: { key: 'acc', axis: '2' }, cmpYmax: 1,
  recording: false, rec: [], recT0Wall: 0,
  demoN: 0, wakeLock: null
};

function log(msg, kind) {
  const el = document.createElement('div');
  el.className = kind || '';
  el.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + msg;
  $('log').prepend(el);
  while ($('log').childElementCount > 60) $('log').lastChild.remove();
}

/* ---------- 时间与数值格式 ---------- */
const pad = (n, w) => String(n).padStart(w || 2, '0');

function isoLocal(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    '.' + pad(d.getMilliseconds(), 3);
}

const num = (v, dec) => (v === null || v === undefined || !isFinite(v)) ? 'null' : v.toFixed(dec);

const stampName = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
  pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());

/* ---------- 设备注册与标签持久化 ---------- */
function loadLabels() {
  try { return JSON.parse(localStorage.getItem(LBL_KEY)) || {}; } catch { return {}; }
}

function saveLabels(map) {
  try { localStorage.setItem(LBL_KEY, JSON.stringify(map)); } catch {}
}

function rememberLabel(key, label) {
  const m = loadLabels();
  m[key] = Object.assign({}, m[key], { label });
  saveLabels(m);
}

const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();

/* 必须走 Array.from：Uint8Array.prototype.map 会把回填的十六进制串再压回字节，全变 0 */
const hexOf = (b) => Array.from(b, hex2).join(' ');

function download(parts, mime, name) {
  const blob = new Blob(parts, { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
