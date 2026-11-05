/* 全局基础设施：元素寻址、日志、格式化、下载、名称记忆。 */

/* 面板内元素左右脚各一份（id 带 -l/-r 后缀）：irCur 决定 $() 取哪只脚的，
   也可显式传 foot。面板外元素不受影响。 */
const IR_ELS = new Set(('btnFmtRead btnFmtSet btnIrParquet btnIrOff dvFmt dvLink dvStat dvUnit ' +
  'irAux irBad irChart irDev irInfo irLen irN irPress irRate irRaw irStat irTs irax iray iraz irgx irgy irgz ' +
  'prHover prScaleBar prScaleMax prTopo pwChart pwCur pwLive pwN pwName ' +
  'irBias irBiasMode irStill btnBiasCal btnBiasReset').split(' '));

let irCur = 'l';

const $ = (id, foot) => document.getElementById(IR_ELS.has(id) ? id + '-' + (foot || irCur) : id);

window.addEventListener('error', (e) => log('脚本错误：' + e.message + ' @' + e.lineno, 'e'));

const CLOCK = { wall0: Date.now(), perf0: performance.now() };

const state = {
  devices: new Map(), order: [],
  T0: 0, tEnd: 0, window: 10, views: new Set(['grid']),
  cmp: { key: 'acc', axis: '2' }, cmpYmax: 1,
  recording: false, rec: [], recT0Wall: 0,
  demoN: 0, wakeLock: null
};

/* 警告与错误另浮一份在右上角：日志区在页面最底部，盯着摄像头 / 鞋垫面板时
   「这次没录视频」这类提醒根本看不到，等发现时一段数据已经废了 */
const toastLast = new Map();

function toast(msg, kind) {
  const now = performance.now();
  /* 逐帧路径上的警告（时钟跳变之类）会连发，同一句 3 s 内只留一条 */
  if (now - (toastLast.get(msg) || 0) < 3000) return;
  if (toastLast.size > 60) toastLast.clear();
  toastLast.set(msg, now);
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = 't' + (kind === 'e' ? ' e' : '');
  el.textContent = msg;
  box.append(el);
  while (box.childElementCount > 3) box.firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 5200);
}

function log(msg, kind) {
  const el = document.createElement('div');
  el.className = kind || '';
  el.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + msg;
  $('log').prepend(el);
  while ($('log').childElementCount > 60) $('log').lastChild.remove();
  if (kind === 'w' || kind === 'e') toast(msg, kind);
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

/* ---------- 标识与摘要 ---------- */

/* app 的 26 位 id 是 ULID（Crockford base32：前 10 位是毫秒时间、后 16 位随机），
   不是随机 hex —— 下游按字符串排序就等于按时间排序，导出必须同构。 */
const ULID_A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(ms) {
  let t = Math.floor(ms === undefined ? Date.now() : ms);
  const b = new Uint8Array(16);
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); }
  crypto.getRandomValues(b.subarray(6));
  /* 128 bit 编成 26 个 base32 字符：先把整体左移 2 位补满 130 bit，
     所以起点是 bits = 2（在右边补零的话时间戳会整体错位） */
  let out = '', val = 0, bits = 2;
  for (const x of b) {
    val = (val << 8) | x;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += ULID_A[(val >>> bits) & 31]; }
    val &= (1 << bits) - 1;
  }
  if (bits) out += ULID_A[(val << (5 - bits)) & 31];
  return out;
}

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/* 同步 sha256：crypto.subtle 是异步的，而帧回调里每帧都要算（raw_packet_sha256 /
   frame_identity），导出时也不能让入口变成 async。 */
function sha256Hex(data) {
  const src = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const n = src.length;
  const buf = new Uint8Array(Math.ceil((n + 9) / 64) * 64);
  buf.set(src);
  buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(n / 0x20000000), false);
  dv.setUint32(buf.length - 4, (n << 3) >>> 0, false);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x, k) => (x >>> k) | (x << (32 - k));
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  let out = '';
  for (const v of [h0, h1, h2, h3, h4, h5, h6, h7]) out += v.toString(16).padStart(8, '0');
  return out;
}

function download(parts, mime, name) {
  const blob = new Blob(parts, { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
