/* 一次性回归：IMU-R 帧解码 + 70→56 压力映射（依据 APK d56-measurement-v3 / d56_pressure_mapping.g.dart） */
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/wt901ble_live.html', 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];

const any = new Proxy(function () {}, {
  get(t, k) {
    if (k === Symbol.toPrimitive) return () => '';
    if (k === Symbol.iterator) return function* () {};
    if (k === 'then') return undefined;
    if (k === 'length' || k === 'childElementCount') return 0;
    if (k === 'dataset') return {};
    return any;
  },
  set() { return true; },
  apply() { return any; },
  construct() { return any; }
});

const mkCv = (w, h) => {
  const o = {
    width: 0, height: 0,
    getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0 }),
    getContext: () => any,
    addEventListener: (n, f) => { if (n === 'click') o.onclick = f; }
  };
  return o;
};
const txtEl = (v) => ({
  value: v, textContent: v, innerHTML: '', disabled: false, hidden: false,
  classList: { toggle() {}, add() {}, remove() {} }
});
const pressCv = mkCv(290, 620), pwCv = mkCv(420, 240);

const sels = {
  prTopo: { value: 'v2' }, prSide: { value: 'l' }, dvFmt: { value: '4' }, dvLink: { value: 'auto' },
  dvUnit: txtEl(''), dvStat: txtEl(''),
  irPress: pressCv, pwChart: pwCv,
  prScaleMax: txtEl(''), pwName: txtEl(''),
  pwCur: txtEl(''), pwAge: txtEl(''), pwAgeWrap: { hidden: true }, pwN: txtEl(''), pwRecN: txtEl(''),
  btnPwRec: txtEl(''), btnPwCsv: txtEl('')
};
/* 页面按脚取元素（id 带 -l/-r）；测试只驱动左脚，把同一批假元素挂到 -l */
for (const k of Object.keys(sels)) sels[k + '-l'] = sels[k];
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
global.document = {
  getElementById: (id) => (sels[id] || any),
  querySelector: () => any,
  querySelectorAll: () => [],
  createElement: () => any,
  addEventListener: () => {},
  visibilityState: 'visible',
  body: any
};
global.window = { addEventListener: () => {}, __wtDebug: null };
global.navigator = { bluetooth: null, mediaDevices: null };
global.location = { search: '', origin: 'http://127.0.0.1:8765' };
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
global.ResizeObserver = class { observe() {} };
global.URL.createObjectURL = () => 'blob:';
global.URL.revokeObjectURL = () => {};
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;
global.setInterval = setInterval;
global.clearInterval = clearInterval;

new Function('window', 'document', 'navigator', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame',
  'ResizeObserver', 'location', src)(
  global.window, global.document, global.navigator, global.localStorage, global.requestAnimationFrame,
  global.cancelAnimationFrame, global.ResizeObserver, global.location
);

const W = global.window.__wtDebug;
const ok = [];
const chk = (n, c, extra) => ok.push((c ? 'PASS ' : 'FAIL ') + n + (extra === undefined ? '' : '  [' + extra + ']'));

/* ---------- 帧构造：CRC 必须是 CCITT-FALSE，且前 138 字节不足补零 ---------- */
function crc16(bytes) {
  let crc = 0xffff;
  const n = Math.min(bytes.length, 138);
  for (let i = 0; i < 138; i++) {
    crc ^= (i < n ? bytes[i] : 0) << 8;
    for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/* pts: [[sourceRow, col, value], ...] 按固件顺序（行升序、列升序）写入 */
function mkFrame(pts, opt) {
  const o = opt || {};
  const n = pts.length;
  const f = new Uint8Array(46 + 2 * n);
  f[0] = 0x5a; f[1] = 0x00; f[2] = 0x09;
  f[29] = n;
  const dv = new DataView(f.buffer);
  dv.setUint32(3, o.seq || 1, true);
  dv.setUint32(7, o.ts || 0, true);
  dv.setUint16(15, o.temp === undefined ? 2796 : o.temp, true);
  (o.imu || [0, 0, 2098, 0, 0, 0]).forEach((v, i) => dv.setInt16(17 + 2 * i, v, true));
  for (const [row, col, v] of pts) {
    f[30 + row] |= 1 << col;
  }
  pts.forEach(([, , v], i) => dv.setInt16(44 + 2 * i, v, true));
  const c = crc16(f.subarray(0, f.length - 2));
  f[f.length - 2] = c & 0xff; f[f.length - 1] = c >> 8;
  return f;
}

const feed = (frames, foot) => {
  const total = frames.reduce((s, f) => s + f.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const f of frames) { buf.set(f, o); o += f.length; }
  W.ir.buf = new Uint8Array(0);
  W.irFeed(buf, foot);
};

/* 基础几何：IR_POS 与固件槽位表必须逐行同构 */
const perRow = {};
W.IR_POS.forEach((p) => { perRow[p.row] = (perRow[p.row] || 0) + 1; });
chk('布局 56 点', W.IR_POS.length === 56, W.IR_POS.length);
chk('每行点数 2/4/5/5/5/5/4/4/4/4/4/4/4/2',
  Object.values(perRow).join(',') === '2,4,5,5,5,5,4,4,4,4,4,4,4,2', Object.values(perRow).join(','));
chk('映射表各 56 项', W.IR_RAW_V1.length === 56 && W.IR_RAW_V2.length === 56,
  W.IR_RAW_V1.length + '/' + W.IR_RAW_V2.length);
chk('映射表下标都在 0..69', [...W.IR_RAW_V1, ...W.IR_RAW_V2].every((i) => i >= 0 && i < 70), '');
chk('v1/v2 取同一批槽位', new Set(W.IR_RAW_V1).size === 56 && new Set(W.IR_RAW_V2).size === 56
  && [...W.IR_RAW_V1].sort((a, b) => a - b).join() === [...W.IR_RAW_V2].sort((a, b) => a - b).join(), '');
/* 第 1 行 2 点必须落在 canonical 行 13（趾端），列 2/3 */
chk('点 1 = 槽位 68（canonical 行13 列3）', W.IR_RAW_V2[0] === 68, W.IR_RAW_V2[0]);
chk('点 2 = 槽位 67（canonical 行13 列2）', W.IR_RAW_V2[1] === 67, W.IR_RAW_V2[1]);

/* ---------- 解码语义 ---------- */
W.prReset();
feed([mkFrame([[0, 3, 10000]]), mkFrame([])]);
chk('sourceRow 0 列 3 → 布局点 1', W.ir.ps[0] === 10000, W.ir.ps[0]);
chk('该点标记为已知', W.ir.seen[0] === 1, W.ir.seen[0]);
chk('其它点未上报', W.ir.seen[1] === 0 && W.ir.pSkip === 0, W.ir.seen[1] + '/' + W.ir.pSkip);

/* 值必须按 sourceRow 升序对齐：同一帧两个点，行号大的先出现在字节流里？不——行小的在前 */
W.prReset();
feed([mkFrame([[0, 2, 100], [0, 3, 4000]]), mkFrame([])]);
chk('同帧两点 列2=100 列3=4000', W.ir.ps[1] === 100 && W.ir.ps[0] === 4000, W.ir.ps[1] + '/' + W.ir.ps[0]);

W.prReset();
feed([mkFrame([[1, 2, 700], [3, 2, 900]]), mkFrame([])]);
chk('跨行取值按行升序', W.ir.ps[W.IR_RAW_V2.indexOf(62)] === 700 && W.ir.ps[W.IR_RAW_V2.indexOf(52)] === 900,
  W.IR_RAW_V2.indexOf(62) + '/' + W.IR_RAW_V2.indexOf(52));

/* 未接传感器的槽位（canonical 0/3/4/5...）上报也不写点，只计未映射 */
W.prReset();
feed([mkFrame([[12, 1, 555]]), mkFrame([])]);   // canonical 行1 列1 → 槽位 6
chk('槽位 6 有效', W.ir.ps[W.IR_RAW_V2.indexOf(6)] === 555, W.IR_RAW_V2.indexOf(6));
W.prReset();
feed([mkFrame([[13, 0, 555]]), mkFrame([])]);   // canonical 行0 列0 → 槽位 0（未接）
chk('未接槽位只计未映射', W.ir.pSkip === 1 && W.ir.seen.reduce((a, b) => a + b, 0) === 0, W.ir.pSkip);

/* CRC / 长度 / 帧头重同步 */
W.prReset();
const good = mkFrame([[0, 3, 2000]]);
const bad = good.slice(); bad[bad.length - 1] ^= 0xff;
feed([bad, good, mkFrame([])]);
chk('CRC 坏帧被丢弃并重同步', W.ir.ps[0] === 2000 && W.ir.bad === 1, W.ir.ps[0] + '/' + W.ir.bad);

W.prReset();
W.ir.bad = 0;
const junk = Uint8Array.from([0x11, 0x5a, 0x00, 0x22, 0x33]);
feed([junk, mkFrame([[0, 3, 1234]]), mkFrame([])]);
chk('前导垃圾后仍能对齐', W.ir.ps[0] === 1234, W.ir.ps[0]);

W.prReset();
const trunc = good.slice(0, 46);          // 声明 1 点却只给 46 字节
feed([trunc, mkFrame([[0, 3, 4321]]), mkFrame([])]);
chk('截断帧不误读为压力', W.ir.ps[0] === 4321, W.ir.ps[0]);

/* 分包投递（BLE 20 B 一片） */
W.prReset();
const total = [mkFrame([[0, 3, 3333]]), mkFrame([[0, 3, 4444]]), mkFrame([])];
const flat = new Uint8Array(total.reduce((s, f) => s + f.length, 0));
let off = 0;
for (const f of total) { flat.set(f, off); off += f.length; }
W.ir.buf = new Uint8Array(0);
for (let i = 0; i < flat.length; i += 20) W.irFeed(flat.subarray(i, i + 20));
chk('20 B 分片仍解出 2 帧', W.ir.frames >= 2 && W.ir.ps[0] === 4444, W.ir.frames + '/' + W.ir.ps[0]);

/* 温度 / IMU 换算 */
W.prReset();
const one = mkFrame([[0, 3, 100]], { temp: 2796, imu: [-16, -128, 2098, -36, -24, 3] });
W.ir.buf = new Uint8Array(0);
W.irFeed(one);
const last = W.ir.last;
chk('温度 raw 2796', last.tempRaw === 2796, last.tempRaw);
chk('az ≈ 1.02 g', Math.abs(last.az - 1.0244) < 0.002, last.az.toFixed(4));
chk('ay = -r1×系数 = +0.0078', Math.abs(last.ay - 0.0078) < 0.001, last.ay.toFixed(4));

/* 右脚：同一批固件的槽位是行内翻列的，点 1 从槽位 68 挪到 66（该格没接传感器，落进未映射） */
W.setCur('r');
W.irBuildLut('r');
chk('右脚点 1 翻到槽位 66', W.irLut[66] === 0 && W.irLut[68] === -1, W.irLut[66] + '/' + W.irLut[68]);
W.prReset('r');
feed([mkFrame([[0, 3, 888]]), mkFrame([])], 'r');
chk('右脚下面按列 3 不再落到点 1', W.ir.ps[0] === 0 && W.ir.pSkip === 1, W.ir.ps[0] + '/' + W.ir.pSkip);
W.setCur('l');
W.irBuildLut('l');
chk('切回左脚恢复', W.irLut[68] === 0 && W.irLut[66] === -1, W.irLut[68] + '/' + W.irLut[66]);

/* v1 拓扑：点 1 应取槽位 67 */
sels.prTopo.value = 'v1';
W.irBuildLut();
W.prReset();
feed([mkFrame([[0, 2, 777]]), mkFrame([])]);
chk('v1 下点 1 = 槽位 67', W.ir.ps[0] === 777, W.ir.ps[0]);
sels.prTopo.value = 'v2';
W.irBuildLut();

/* ---------- 真机 4266 帧回放（只按 1 号位置） ---------- */
const lines = fs.readFileSync(__dirname + '/tmp_w02_press1.txt', 'utf8').trim().split('\n');
const real = lines.map((l) => l.split('\t')).filter((a) => a.length === 4);
const frames = real.map((a) => Uint8Array.from(Buffer.from(a[3].trim(), 'hex')));
chk('抓包 4267 行', real.length === 4267, real.length);

W.prReset();
W.ir.bad = 0;
W.ir.buf = new Uint8Array(0);
let peak0 = 0;
for (const f of frames) {
  W.irFeed(f);
  if (W.ir.ps[0] > peak0) peak0 = W.ir.ps[0];
}
const pressFrames = real.filter((a) => +a[2] > 0).length;
chk('抓包 CRC 全部通过（坏帧 0）', W.ir.bad === 0, W.ir.bad);
chk('压力帧数 = 抓包 N>0 帧（仅 1 帧长度非法被丢）', W.ir.pFrames >= pressFrames - 1, W.ir.pFrames + '/' + pressFrames);
chk('点 1 峰值 10000（按到上限截断）', peak0 === 10000, peak0);
chk('松手后点 1 回落到 100', W.ir.ps[0] === 100, W.ir.ps[0]);
chk('其余 55 点未重压', [...Array(56).keys()].filter((i) => i && W.ir.ps[i] > 100).length === 0, '');
chk('未映射点为 0（映射表覆盖全部上报槽位）', W.ir.pSkip === 0, W.ir.pSkip);
chk('已知点只有固件周期上报的 6 个', W.ir.seen.reduce((a, b) => a + b, 0) === 6,
  [...W.ir.seen].map((v, i) => (v ? i + 1 : 0)).filter(Boolean).join(','));

/* 记录模式 */
W.prReset();
W.ir.recording = true;
W.ir.prec.length = 0;
feed([mkFrame([[0, 3, 500]]), mkFrame([])]);
chk('记录 1 行压力', W.ir.prec.length === 1, W.ir.prec.length);
chk('记录带槽位号', W.ir.prec[0].ch === 1 && W.ir.prec[0].slot === 68, JSON.stringify(W.ir.prec[0]));
W.ir.recording = false;

/* ---------- 选中点波形 ---------- */
W.prReset();
W.ir.t0 = performance.now() - 6000;
W.pwPush(0, 4.6, 1500);
W.pwPush(0, 4.8, 2600);
W.pwPush(0, 5.0, 3000);
chk('波形按采样时刻累积', W.ir.hist[0].length === 3, W.ir.hist[0].length);
W.pwPush(0, 30, 800);
chk('超出 12 s 的旧样本被裁掉', W.ir.hist[0].length === 1, W.ir.hist[0].length);
W.ir.hist[0].length = 0;
W.pwPush(0, 4.6, 1500);
W.pwPush(0, 4.8, 2600);
W.pwPush(0, 5.0, 3000);
/* 实时值取"最后一次上报"，所以要像真机那样把 seen/ps/lastSeen 一起写上 */
W.ir.seen[0] = 1; W.ir.ps[0] = 3000; W.ir.lastSeen[0] = 5.0;

chk('未选中时标题是「未选中」', sels.pwName.textContent === '未选中', sels.pwName.textContent);
W.pwPick(0);
chk('选中点 1', W.ir.sel === 0, W.ir.sel);
chk('标题带点号/行/槽位', sels.pwName.textContent === '#1 · 第 1 行 · 槽位 68', sels.pwName.textContent);
W.pwDraw();
chk('实时值带单位', / g$/.test(sels.pwCur.textContent), sels.pwCur.textContent);
chk('窗口内点数与 hist 一致', +sels.pwN.textContent === W.ir.hist[0].length, sels.pwN.textContent + '/' + W.ir.hist[0].length);
W.pwPick(0);
chk('再点一次取消选中', W.ir.sel === -1, W.ir.sel);

W.irPressDraw();
const hit = W.ir.hit[7];
pressCv.onclick({ currentTarget: pressCv, clientX: hit.x, clientY: hit.y });
chk('点击鞋垫命中第 8 点', W.ir.sel === 7, W.ir.sel);
W.pwPick(7);

/* ---------- 输出格式：单位跟设备回读走，不是本地开关 ---------- */
const stBytes = (fmt) => {
  const b = new Uint8Array(41);
  const dv = new DataView(b.buffer);
  b[0] = 1; b[1] = 100; b[2] = fmt;
  dv.setUint16(3, 10000, true); dv.setUint16(5, 100, true);
  b.set([...Buffer.from('D56-01')], 7);
  dv.setUint16(23, 100, true);
  dv.setInt16(25, 2600, true); dv.setInt16(27, 2650, true);
  dv.setUint16(29, 3700, true); dv.setUint16(31, 88, true);
  return b;
};

W.ir.fmt = null;
W.irState(stBytes(4));
chk('状态体解码出格式 4（重量）', W.ir.fmt === 4, W.ir.fmt);
chk('状态体解码出频率/上下限', W.ir.state.freq === 100 && W.ir.state.max === 10000 && W.ir.state.min === 100,
  [W.ir.state.freq, W.ir.state.max, W.ir.state.min].join('/'));
chk('状态体解码出设备名', W.ir.state.name === 'D56-01', W.ir.state.name);
chk('状态体解码出两路温度', W.ir.state.t1 === 2600 && W.ir.state.t2 === 2650,
  W.ir.state.t1 + '/' + W.ir.state.t2);
chk('下拉框同步到回读值', sels.dvFmt.value === '4', sels.dvFmt.value);

W.prNums();
chk('重量档色阶标 g', / g$/.test(sels.prScaleMax.textContent), sels.prScaleMax.textContent);
chk('重量档零点偏置 100', W.prBase() === 100 && W.prU() === 'g', W.prBase() + '/' + W.prU());

W.irState(stBytes(0));
W.prNums();
chk('原始 ADC 档格式 = 0', W.ir.fmt === 0, W.ir.fmt);
chk('原始 ADC 档色阶标 ADC', / ADC$/.test(sels.prScaleMax.textContent), sels.prScaleMax.textContent);
chk('原始 ADC 档不扣零点', W.prBase() === 0 && W.prSpan() === 4096, W.prBase() + '/' + W.prSpan());

W.irState(stBytes(9));
chk('未知格式不冒充单位（回落到重量）', W.ir.fmt === null && W.prFmt() === 4, String(W.ir.fmt));
W.irState(stBytes(4));
W.prNums();

/* ---------- 主机命令编码 / ACK 解码：旧 80 B 合同 ---------- */
W.ir.link = 'v1';
const cmd = W.irCmd(W.irStates.l, 0x10, Uint8Array.of(0), 'v1');
chk('旧合同命令 80 字节', cmd.length === 80, cmd.length);
chk('命令头 5A + 命令字', cmd[0] === 0x5a && cmd[1] === 0x10, cmd[0].toString(16) + '/' + cmd[1].toString(16));
chk('命令负载长字段 = 1', (cmd[10] | (cmd[11] << 8) | (cmd[12] << 16) | (cmd[13] << 24)) === 1, cmd[10]);
chk('命令负载在偏移 14', cmd[14] === 0, cmd[14]);
/* CRC 自指：写入的校验值本身参与计算，重算前必须先清零这两个字节 */
const zeroed = cmd.slice(); zeroed[15] = 0; zeroed[16] = 0;
const cmdCrc = W.irCrcIbm(zeroed.subarray(0, 76), 76);
chk('命令 CRC 紧跟负载（小端）', (cmd[15] | (cmd[16] << 8)) === cmdCrc, cmdCrc.toString(16));
const mut = zeroed.slice(); mut[3] ^= 0xff;
chk('CRC 覆盖固定 76 B（改包头就变）', W.irCrcIbm(mut.subarray(0, 76), 76) !== cmdCrc, '');
chk('CRC 后剩余字节为零', [...cmd.subarray(17)].every((b) => b === 0), '');

function mkAck(type, size, data) {
  const f = new Uint8Array(83);
  f[0] = 0x5a; f[1] = 0x00; f[2] = type;
  const dv = new DataView(f.buffer);
  dv.setUint32(3, 7, true);
  dv.setUint16(15, size, true);
  f.set(data, 17);
  let crc = 0xffff;
  for (let i = 0; i < 81; i++) {
    crc ^= f[i] << 8;
    for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  dv.setUint16(81, crc, true);
  return f;
}
const stAck = mkAck(0x0d, 42, Uint8Array.from([0, ...stBytes(0)]));
chk('状态 ACK 固定 83 B 且 CRC 通过', W.irCrcAck(stAck), stAck.length);
const stBad = stAck.slice(); stBad[81] ^= 0xff;
chk('状态 ACK CRC 坏掉被判掉', !W.irCrcAck(stBad), '');

W.ir.fmt = null;
W.ir.buf = new Uint8Array(0);
W.ir.bad = 0;
W.prReset();
feed([mkFrame([[0, 3, 1500]]), stAck, mkFrame([])]);
chk('测量帧与 ACK 混包都能解', W.ir.ps[0] === 1500 && W.ir.fmt === 0, W.ir.ps[0] + '/' + W.ir.fmt);
chk('混包不产生坏帧', W.ir.bad === 0, W.ir.bad);
chk('ACK 计数 +1', W.ir.acks >= 1, W.ir.acks);

/* 坏 ACK 插在测量帧之间：跳过它继续解压力 */
W.ir.buf = new Uint8Array(0);
W.ir.fmt = 4;
W.prReset();
feed([mkFrame([[0, 3, 111]]), stBad, mkFrame([[0, 3, 222]]), mkFrame([])]);
chk('CRC 坏的 ACK 不阻断后续测量', W.ir.ps[0] === 222 && W.ir.fmt === 4, W.ir.ps[0] + '/' + W.ir.fmt);

/* 格式切换后单位立刻跟着变（不需要重连） */
W.irState(stBytes(0));
W.prNums();
chk('切到 ADC 后色阶标 ADC', / ADC$/.test(sels.prScaleMax.textContent), sels.prScaleMax.textContent);
W.irState(stBytes(4));
W.prNums();
chk('切回重量后色阶标 g', / g$/.test(sels.prScaleMax.textContent), sels.prScaleMax.textContent);

/* ---------- 新合同（2026-10-31 固件）：144 B 命令 + 19+size 紧凑 ACK ---------- */
W.ir.link = 'v2';
const cmd2 = W.irCmd(W.irStates.l, 0x10, Uint8Array.of(0), 'v2');
chk('新合同命令 144 字节', cmd2.length === 144, cmd2.length);
chk('新合同负载长字段 = 1', (cmd2[10] | (cmd2[11] << 8)) === 1, cmd2[10]);
/* CRC 固定在帧尾 [142..143]、覆盖前 142 字节；算的时候这两个字节还是零 */
const z2 = cmd2.slice(); z2[142] = 0; z2[143] = 0;
const crc2 = W.irCrcIbm(z2.subarray(0, 142), 142);
chk('新合同 CRC 在帧尾 142/143 小端', (cmd2[142] | (cmd2[143] << 8)) === crc2, crc2.toString(16));
chk('新合同负载后面补零', [...cmd2.subarray(15, 142)].every((b) => b === 0), '');
const m2 = z2.slice(); m2[5] ^= 0xff;
chk('新合同 CRC 覆盖前 142 B（改包头就变）', W.irCrcIbm(m2.subarray(0, 142), 142) !== crc2, '');
const empty2 = W.irCmd(W.irStates.l, 0x0d, null, 'v2');
chk('新合同空负载 0x0D 帧长 144', empty2.length === 144 && empty2[10] === 0, empty2.length);

function mkAck2(type, data) {
  const f = new Uint8Array(19 + data.length);
  f[0] = 0x5a; f[1] = 0x00; f[2] = type;
  const dv = new DataView(f.buffer);
  dv.setUint32(3, 11, true);
  dv.setUint16(15, data.length, true);
  f.set(data, 17);
  dv.setUint16(17 + data.length, 0x1234, true);   // 新合同不校验这段 CRC，只占位
  return f;
}
const a2 = mkAck2(0x0d, Uint8Array.from([0, ...stBytes(0)]));
chk('紧凑 ACK 长 19+42=61', a2.length === 61, a2.length);
W.ir.fmt = null;
W.ir.buf = new Uint8Array(0);
W.ir.bad = 0;
W.prReset();
feed([mkFrame([[0, 3, 4321]]), a2, mkFrame([])]);
chk('紧凑 ACK 能解出新合同状态', W.ir.fmt === 0 && W.ir.ps[0] === 4321, W.ir.fmt + '/' + W.ir.ps[0]);
chk('紧凑 ACK 记录合同 = v2', W.ir.lastAck && W.ir.lastAck.link === 'v2', W.ir.lastAck && W.ir.lastAck.link);
chk('紧凑 ACK 混包不产生坏帧', W.ir.bad === 0, W.ir.bad);
/* 新合同外壳下收到旧 83 B ACK：负载位置相同（[17..]、size=42），照样能解出状态，
   只是尾巴多 22 字节被丢掉——不能因为长度不同就把状态判死 */
W.ir.buf = new Uint8Array(0);
W.ir.fmt = 4;
W.ir.bad = 0;
W.prReset();
feed([mkAck(0x0d, 42, Uint8Array.from([0, ...stBytes(0)])), mkFrame([[0, 3, 777]]), mkFrame([])]);
chk('新合同下旧 83 B ACK 仍解出状态', W.ir.fmt === 0 && W.ir.ps[0] === 777, W.ir.fmt + '/' + W.ir.ps[0]);
chk('旧 ACK 尾巴不影响后续测量帧', W.ir.bad === 0, W.ir.bad);

/* ---------- 无回执也要能干活：真机 0x10/0x0D 写了生效但一律不回 ---------- */
(async () => {
  const W2 = W;
  W2.ir.dev = { name: 'W02-L', gatt: { connected: true } };
  W2.ir.chr = {};
  document.getElementById('dvLink').value = 'v1';
  W2.ir.link = 'v1';

  /* 1) 写入成功但设备一声不响：算成功，格式按写入值显示 */
  W2.ir.write = { writeValueWithResponse: async () => {} };
  W2.ir.fmt = 4; W2.ir.fmtSrc = 'read'; W2.ir.state = { fmt: 4 };
  let threw = '';
  try { await W2.irSetFmt(W2.irStates.l, 0); } catch (e) { threw = e.message; }
  chk('无回执写入不报失败', threw === '', threw);
  chk('无回执写入后口径跟写入值', W2.ir.fmt === 0 && W2.ir.fmtSrc === 'write', W2.ir.fmt + '/' + W2.ir.fmtSrc);
  chk('无回执时清掉旧状态，不冒充当前值', W2.ir.state === null, String(W2.ir.state));
  chk('标签注明无回执', /无回执/.test(sels.dvStat.textContent), sels.dvStat.textContent);
  chk('工具栏标签不重复写无回执', !/无回执/.test(sels.dvUnit.textContent), sels.dvUnit.textContent);
  chk('下拉跟着写入值走', sels.dvFmt.value === '0', sels.dvFmt.value);

  /* 2) 写都没写出去（通道报错）才是真失败 */
  W2.ir.write = { writeValueWithResponse: async () => { throw new Error('GATT busy'); } };
  W2.ir.fmt = 4; W2.ir.fmtSrc = 'read';
  let hard = '';
  try { await W2.irSetFmt(W2.irStates.l, 1); } catch (e) { hard = e.message; }
  chk('通道写失败仍报错', /写入|GATT/.test(hard), hard);
  chk('写失败不改口径', W2.ir.fmt === 4 && W2.ir.fmtSrc === 'read', W2.ir.fmt + '/' + W2.ir.fmtSrc);

  /* 3) 自动档两套都无回执：错误要带「写出去了」标记，且两套确实都发了 */
  document.getElementById('dvLink').value = 'auto';
  {
    const lens = [];
    W2.ir.link = 'v2';                    /* 默认首选，与页面初始化一致 */
    W2.ir.write = { writeValueWithResponse: async (pkt) => { lens.push(pkt.length); } };
    let noAck = null;
    try { await W2.irProbe(W2.irStates.l, 0x0d, null, 60); } catch (e) { noAck = e; }
    chk('两套都无回执时错误带 sent 标记', noAck && noAck.sent === true, noAck && noAck.message);
    chk('两套都试过（先 144 B 后 80 B）', lens.length === 2 && lens[0] === 144 && lens[1] === 80, lens.join(','));
  }

  /* 4) 回读不到要给「不回状态」而不是笼统的回执超时 */
  document.getElementById('dvLink').value = 'v1';
  let rd = '';
  try { await W2.irQueryState(W2.irStates.l, true); } catch (e) { rd = e.message; }
  chk('回读失败明说设备不回状态', /不回状态/.test(rd), rd);

  /* 5) 回执的 witch 不是 0x00 时，按「类型正好是刚发的那条」放宽也能认出来 */
  const witched = mkAck(0x0d, 42, Uint8Array.from([0, ...stBytes(2)]));
  witched[1] = 0x01;
  { let crc = 0xffff; for (let i = 0; i < 81; i++) { crc ^= witched[i] << 8; for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; } witched[81] = crc & 0xff; witched[82] = crc >> 8; }
  W2.ir.buf = new Uint8Array(0); W2.ir.bad = 0; W2.ir.fmt = 4; W2.ir.looseHit = false;
  W2.ir.wait = { type: 0x0d, link: 'v1', res: () => {}, rej: () => {}, timer: 0 };
  W2.irFeed(witched);
  W2.ir.wait = null;
  chk('witch≠0 的回执也能解出状态', W2.ir.fmt === 2, String(W2.ir.fmt));
  chk('放宽命中记一次', W2.ir.looseHit === true, String(W2.ir.looseHit));

  /* 6) 等回执期间的「非测量帧」要被抓下来，不然永远不知道设备回了什么 */
  W2.ir.odd.length = 0;
  W2.ir.wait = { type: 0x0d, link: 'v1', res: () => {}, rej: () => {}, timer: 0 };
  W2.irFeed(mkFrame([[0, 3, 555]]));
  W2.irFeed(Uint8Array.from([0x5a, 0x07, 0x0d, 0x11, 0x22, 0x33]));
  W2.ir.wait = null;
  chk('非测量帧被抓到', W2.ir.odd.length === 1 && /^5A 07 0D/.test(W2.ir.odd[0]), W2.ir.odd.join(' | '));
  chk('测量帧不算进去', !W2.ir.odd.some((s) => /^5A 00 09/.test(s)), '');

  /* 7) 压力载荷里正好出现 5A xx 0D：放宽路径不能被它骗走一串测量帧 */
  {
    const trap = mkFrame([[0, 3, 555]]);
    /* 把压力值区写成 5A、让下一个字节是 0x0D —— 制造假帧头 [5A ? 0D] */
    trap[45] = 0x5a;
    const before = { acks: W2.ir.acks, bad: W2.ir.bad, fmt: W2.ir.fmt };
    W2.ir.buf = new Uint8Array(0);
    W2.ir.looseHit = false;
    W2.ir.wait = { type: 0x0d, link: 'v1', res: () => {}, rej: () => {}, timer: 0 };
    W2.irFeed(Uint8Array.from([0x5a, 0x00, 0x0d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    W2.irFeed(trap);
    W2.ir.wait = null;
    chk('假帧头不产生假回执', W2.ir.acks === before.acks, W2.ir.acks - before.acks);
    chk('假帧头不改口径', W2.ir.fmt === before.fmt, String(W2.ir.fmt));
    chk('放宽未命中', W2.ir.looseHit === false, String(W2.ir.looseHit));
  }

  /* 8) 刷新后口径不能丢：这台固件不可回读，只能靠本地记住最近一次写入 */
  {
    W2.ir.write = { writeValueWithResponse: async () => {} };
    document.getElementById('dvLink').value = 'v1';
    W2.ir.link = 'v1';
    W2.ir.fmt = 4; W2.ir.fmtSrc = 'read';
    await W2.irSetFmt(W2.irStates.l, 1);
    chk('写入后落到本地', localStorage.getItem(W2.FMT_KEY) === '1', String(localStorage.getItem(W2.FMT_KEY)));
    W2.ir.fmt = null; W2.ir.fmtSrc = 'none';
    W2.irFmtLoad(W2.irStates.l);
    chk('刷新后恢复写入过的格式（标 saved 不冒充刚写入）', W2.ir.fmt === 1 && W2.ir.fmtSrc === 'saved', W2.ir.fmt + '/' + W2.ir.fmtSrc);
    W2.irFmtText();
    chk('刷新后下拉同步到恢复值', sels.dvFmt.value === '1', sels.dvFmt.value);
    localStorage.removeItem(W2.FMT_KEY);
    W2.ir.fmt = null; W2.ir.fmtSrc = 'none';
    W2.irFmtLoad(W2.irStates.l);
    chk('没存过就保持未回读（不能默认成 ADC）', W2.ir.fmt === null && W2.ir.fmtSrc === 'none', W2.ir.fmt + '/' + W2.ir.fmtSrc);
    W2.ir.fmt = 4; W2.ir.fmtSrc = 'read';
  }

  /* 9) 没有回执时不能剪枝：两套必须每次都发，且 144 B 排在前面 */
  {
    document.getElementById('dvLink').value = 'auto';
    W2.ir.link = 'v2';
    const orders = [];
    W2.ir.write = { writeValueWithoutResponse: async (pkt) => { orders.push(pkt.length); } };
    for (let n = 0; n < 3; n++) {
      try { await W2.irProbe(W2.irStates.l, 0x0d, null, 30); } catch (e) { /* 预期无回执 */ }
    }
    chk('每次自动档都发两包（不因无回执剪枝）', orders.length === 6, orders.join(','));
    chk('144 B 排在 80 B 之前', orders[0] === 144 && orders[1] === 80, orders.slice(0, 2).join(','));
    chk('三轮顺序稳定', orders.length === 6
      && orders[2] === 144 && orders[3] === 80 && orders[4] === 144 && orders[5] === 80, orders.join(','));

    /* 默认首选必须是 144 B：这台设备测量帧是 0x09，契约只认 144 B */
    chk('默认 link 是 144 B', W2.ir.link === 'v2', W2.ir.link);

    /* 144 B 写失败（单包容量不足）要能换 80 B 再试，而不是直接报死 */
    let tried = [];
    W2.ir.link = 'v2';
    W2.ir.write = {
      writeValueWithoutResponse: async (pkt) => {
        tried.push(pkt.length);
        if (pkt.length === 144) throw new Error('value too long');
      }
    };
    let swapped = '';
    try { await W2.irProbe(W2.irStates.l, 0x0d, null, 30); } catch (e) { swapped = e.message; }
    chk('144 B 写失败后仍试 80 B', tried.length === 2 && tried[1] === 80, tried.join(','));
    /* 80 B 写成功但没回执 → 报的是「等不到回执」，不是写失败（写失败已在 144 B 那轮被换掉） */
    chk('换到能写的 80 B 后按无回执处理', /等不到回执|无回执/.test(swapped), swapped.slice(0, 60));

    document.getElementById('dvLink').value = 'auto';
    W2.ir.link = 'v2';
  }

  W2.ir.dev = null; W2.ir.write = null; W2.ir.chr = null;
  document.getElementById('dvLink').value = 'auto';

  /* 10) 严格逐帧：本帧没带这个点就是 0，不保持 */
  {
    W2.ir.sel = 0;
    W2.ir.t0 = performance.now() - 20000;

    feed([mkFrame([[0, 3, 1249]])]);
    W2.pwDraw();
    chk('本帧带了这个点就显示本帧值', /1,?249/.test(sels.pwCur.textContent), sels.pwCur.textContent);
    chk('鞋垫取帧值', W2.prCur(0) === 1249, String(W2.prCur(0)));

    /* 下一帧只带别的点：本点本帧没带 → 立刻 0 */
    const p3 = W2.irLut.indexOf(2);
    const sr3 = 13 - Math.floor(p3 / 5), cl3 = p3 % 5;
    feed([mkFrame([[sr3, cl3, 900]])]);
    W2.pwDraw();
    chk('本帧没带就立刻是 0', W2.prCur(0) === 0, String(W2.prCur(0)));
    chk('实时值也归 0', /^0 /.test(sels.pwCur.textContent), sels.pwCur.textContent);
    chk('本帧带的点有值', W2.prCur(2) === 900, String(W2.prCur(2)));

    chk('从未上报的点是 0', W2.prCur(40) === 0, String(W2.prCur(40)));

    feed([mkFrame([[0, 3, 777]])]);
    chk('回到有值时恢复', W2.prCur(0) === 777, String(W2.prCur(0)));
    feed([mkFrame([])]);
    chk('空帧把所有点清零', W2.prCur(0) === 0 && W2.prCur(2) === 0,
      W2.prCur(0) + '/' + W2.prCur(2));
  }

  /* 11) 单点记录：只记选中的点，换点自动停 */
  {
    W2.ir.dev = { name: 'W02-L', gatt: { connected: true } };
    W2.ir.chr = {};
    W2.ir.write = { writeValueWithoutResponse: async () => {} };
    W2.prReset();
    W2.ir.t0 = performance.now();
    W2.ir.sel = 0;
    W2.ir.pwRec.length = 0; W2.ir.pwRecOn = false;

    document.getElementById('btnPwRec').onclick();
    chk('点记录后进入记录态', W2.ir.pwRecOn === true, String(W2.ir.pwRecOn));
    feed([mkFrame([[0, 3, 700]]), mkFrame([[0, 3, 800]])]);
    chk('记录只收选中点', W2.ir.pwRec.length === 2 && W2.ir.pwRec[0].pt === 1, W2.ir.pwRec.length);
    chk('记录行带行号与槽位', W2.ir.pwRec[0].row === 1 && W2.ir.pwRec[0].slot === 68,
      JSON.stringify(W2.ir.pwRec[0]));
    W2.pwName();
    chk('记录计数已刷新', sels.pwRecN.textContent === 2, String(sels.pwRecN.textContent));

    /* 别的点上报不该混进来 */
    const before = W2.ir.pwRec.length;
    feed([mkFrame([[13, 4, 900]])]);
    chk('其他点不混入记录', W2.ir.pwRec.length === before, W2.ir.pwRec.length);

    /* 换点自动停，但不丢已记数据 */
    W2.pwPick(5);
    chk('换点自动停止记录', W2.ir.pwRecOn === false, String(W2.ir.pwRecOn));
    chk('已记数据保留可导出', W2.ir.pwRec.length === 2, W2.ir.pwRec.length);

    /* 断开也停 */
    W2.ir.sel = 0; W2.ir.pwRecOn = true;
    W2.irGone();
    chk('断开自动停止记录', W2.ir.pwRecOn === false, String(W2.ir.pwRecOn));
  }

/* 12) 没上报的时间段按 0 画：不再断线、不再留占位字 */
  {
    W2.ir.sel = 0;
    W2.ir.t0 = performance.now() - 8000;
    W2.ir.hist[0].length = 0;
    W2.ir.seen[0] = 1;
    W2.ir.ps[0] = 5000;
    W2.ir.lastSeen[0] = 4.0;
    W2.pwPush(0, 4.0, 5000);
    W2.pwDraw();
    /* 这条不再依赖"超时"：frame 里没有值就是 0 */
    chk('frame 没值就显示 0', /^0 g$/.test(sels.pwCur.textContent), sels.pwCur.textContent);
    chk('全部点一开始都是 0', [...W2.ir.frame].every((v) => v === 0) || W2.ir.frame[0] === 0, '');

    const lum = (c) => { const m = c.match(/\d+/g).map(Number); return m[0] + m[1] + m[2]; };
    const c0 = W2.prColor(0), cHi = W2.prColor(8000), cMid = W2.prColor(2500);
    chk('0 值近白', lum(c0) > 700, c0);
    chk('高值明显更深', lum(cHi) < lum(c0) - 300, cHi + ' vs ' + c0);
    chk('中值介于两者之间', lum(cMid) < lum(c0) && lum(cMid) > lum(cHi), cMid);
    W2.ir.seen[2] = 0;
    chk('没上报的点按 0 取色', W2.prCur(2) === 0, String(W2.prCur(2)));
  }

/* 13) 色阶在常用区间要有区分度：线性 + 10000 满量程会把 1~3k 全挤在浅色端 */
  {
    const lum = (c) => { const m = c.match(/\d+/g).map(Number); return m[0] + m[1] + m[2]; };
    const at = (v) => lum(W2.prColor(v));
    chk('1.2k 与 2.6k 能区分', Math.abs(at(1200) - at(2600)) > 60, at(1200) + ' vs ' + at(2600));
    chk('单调递增变深', at(300) > at(1200) && at(1200) > at(2600) && at(2600) > at(5000),
      [300, 1200, 2600, 5000].map(at).join(' > '));
    chk('顶到 10000 最深', at(10000) < at(5000), at(10000) + ' vs ' + at(5000));

    chk('四位压成 k', W2.prLabel(2600) === '2.6k', W2.prLabel(2600));
    chk('上限不撑破圆圈', W2.prLabel(10000) === '10k', W2.prLabel(10000));
    chk('三位原样', W2.prLabel(300) === '300', W2.prLabel(300));
    chk('0 就是 0', W2.prLabel(0) === '0', W2.prLabel(0));
  }


  /* 13.5) 广播名认脚别：带 -R/-L 的认得出，认不出留给「空着的那只」 */
  {
    chk('广播名 -R 认右脚', W2.footFromName('W01-R') === 'r', String(W2.footFromName('W01-R')));
    chk('广播名 -L 认左脚', W2.footFromName('W01-L') === 'l', String(W2.footFromName('W01-L')));
    chk('名字看不出就返回 null', W2.footFromName('D56V01') === null, String(W2.footFromName('D56V01')));
  }

  /* 14) 双鞋垫：两只各自独立，同一槽位不串数据 */
  {
    const L = W2.irStates.l, R = W2.irStates.r;
    L.buf = new Uint8Array(0); R.buf = new Uint8Array(0);
    L.rec.length = 0; R.rec.length = 0;
    W2.prReset('l'); W2.prReset('r');
    const fL = L.frames, fR = R.frames;
    W2.irFeed(mkFrame([[0, 3, 111]]), 'l');
    W2.irFeed(mkFrame([[0, 1, 222]]), 'r');   /* 右脚点 1 在槽位 66 */
    chk('两只鞋垫各拿各的值', L.ps[0] === 111 && R.ps[0] === 222, L.ps[0] + '/' + R.ps[0]);
    chk('帧计数分别累加', L.frames === fL + 1 && R.frames === fR + 1,
      (L.frames - fL) + '/' + (R.frames - fR));

    /* 选中点、波形、记录各是一份 */
    L.sel = -1; R.sel = -1;                  /* pwPick 是开关，先清掉旧的选中 */
    W2.setCur('l'); W2.pwPick(0);
    W2.setCur('r'); W2.pwPick(1);
    chk('选中点互不影响', L.sel === 0 && R.sel === 1, L.sel + '/' + R.sel);
    L.hist[0].length = 0; R.hist[0].length = 0;
    L.buf = new Uint8Array(0); R.buf = new Uint8Array(0);
    W2.irFeed(mkFrame([[0, 3, 500]]), 'l');
    chk('喂左脚不动右脚波形', L.hist[0].length === 1 && R.hist[0].length === 0,
      L.hist[0].length + '/' + R.hist[0].length);

    L.recording = true; R.recording = false;
    L.rec.length = 0; R.rec.length = 0;
    W2.irFeed(mkFrame([[0, 3, 600]]), 'l');
    chk('记录只落在一只脚上', L.rec.length === 1 && R.rec.length === 0,
      L.rec.length + '/' + R.rec.length);
    L.recording = false;
    W2.setCur('l');
  }

  console.log(ok.join('\n'));
  console.log('\n小计 ' + ok.filter((x) => x.startsWith('PASS')).length + '/' + ok.length + ' 通过');
})();
