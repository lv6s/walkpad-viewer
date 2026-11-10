/* 自研鞋垫协议层：状态、解帧、命令与应答、IMU 校准、零偏估计。 */

/* ---------- IMU-R（自研 BLE IMU，数据走 0x180D 的 2A37）---------- */
const U16 = (s) => '0000' + s + '-0000-1000-8000-00805f9b34fb';

/* 加速度 2048 LSB/g、角速度 0.07 °/s/LSB（与 d56-imu-acc488ug-gyro70mdps contract 同值）。
   静置 az≈2098 与 1 g 吻合；固件改量程就只动这两个常数。 */
const IR_ACC_G = 1 / 2048, IR_GYR_DPS = 0.07, IR_KEEP = 40;

const IR_COLORS = ['#e03131', '#2f9e44', '#1971c2'];

/* 鞋垫布局：14 行、共 56 点，行内编号从右往左（1→56）。坐标量自布局图，按 209×671 归一化 */
const PR_W = 209, PR_H = 671, PR_N = 56;

const PR_ROWS = [
  [45.4, [95.5, 143.8]],
  [91.8, [69.0, 95.5, 131.5, 163.5]],
  [145.1, [43.2, 69.6, 96.4, 130.0, 164.8]],
  [195.5, [34.6, 59.6, 88.9, 118.4, 159.9]],
  [232.5, [34.6, 59.4, 87.5, 118.4, 155.5]],
  [268.3, [33.8, 60.5, 89.6, 118.3, 151.4]],
  [306.1, [33.8, 60.4, 90.0, 118.5]],
  [340.6, [38.3, 67.1, 100.4, 128.5]],
  [378.4, [38.2, 67.9, 100.4, 129.6]],
  [416.5, [39.5, 66.6, 101.2, 129.4]],
  [454.3, [38.7, 68.0, 100.4, 128.9]],
  [500.1, [39.3, 67.9, 100.0, 127.8]],
  [548.7, [38.4, 67.9, 100.1, 127.8]],
  [591.3, [38.5, 67.1]]
];

const IR_POS = (() => {
  const out = [];
  PR_ROWS.forEach(([y, xs], ri) => {
    for (let i = xs.length - 1; i >= 0; i--) {
      out.push({ lab: out.length + 1, x: xs[i] / PR_W, y: y / PR_H, row: ri + 1 });
    }
  });
  return out;
})();

/* 压力数值的单位由固件的「输出格式」决定，不是写死的：0x10 命令改、0x0D 回读，
   五档为 0 原始 ADC / 1 采样电压 / 2 可变电压 / 3 可变阻值 / 4 重量。本机 10000 封顶、
   空载 100，是重量档的 g 值（12 位 ADC 到不了 10000），所以单位跟着回读结果走；
   没回读到之前按重量显示，并在面板上标明「未回读」，不冒充已确认。 */
const PR_IDLE = 100, PR_MAX = 10000;

      // 重量档：空载偏置 100 g、单点 10000 g 封顶
const PR_SPAN_G = 2200, PR_SPAN_RAW = 4096;

   // 色阶与纵轴跨度：重量档 2.2 kg，其余按满量程计数
const FMT_NAME = ['原始 ADC', '采样电压', '可变电压', '可变阻值', '重量'];

const FMT_UNIT = ['ADC', 'V', 'V', 'Ω', 'g'];

/* 命令帧合同的用户选择：auto = 先试上次探到的那套，没回包再换另一套 */
const irLinkMode = (foot) => ($('dvLink', foot) ? $('dvLink', foot).value : 'auto');

/* 鞋垫外轮廓，同样量自布局图：[y, 左边界 x, 右边界 x]，趾端/跟端取样更密 */
const PR_EDGE = [
  [0.0045, 0.5885, 0.6459], [0.0164, 0.4641, 0.7368], [0.0283, 0.4067, 0.7799],
  [0.0402, 0.3636, 0.8086], [0.0522, 0.3301, 0.8325], [0.0641, 0.3014, 0.8565],
  [0.076, 0.2775, 0.8708], [0.0879, 0.2536, 0.8852], [0.0999, 0.2344, 0.8995],
  [0.1326, 0.1866, 0.9187], [0.1654, 0.1483, 0.933], [0.1982, 0.1196, 0.933],
  [0.231, 0.0957, 0.9282], [0.2638, 0.0766, 0.9234], [0.2966, 0.067, 0.9091],
  [0.3294, 0.0622, 0.89], [0.3621, 0.0574, 0.8612], [0.3949, 0.0622, 0.8325],
  [0.4277, 0.0622, 0.8038], [0.4605, 0.0718, 0.7751], [0.4933, 0.0766, 0.7512],
  [0.5261, 0.0766, 0.7368], [0.5589, 0.0813, 0.7273], [0.5917, 0.0813, 0.7225],
  [0.6244, 0.0813, 0.7177], [0.6572, 0.0813, 0.7177], [0.69, 0.0766, 0.7129],
  [0.7228, 0.0766, 0.7081], [0.7556, 0.0718, 0.7033], [0.7884, 0.067, 0.6986],
  [0.8212, 0.067, 0.689], [0.8539, 0.0718, 0.6794], [0.8867, 0.0861, 0.6603],
  [0.8987, 0.0957, 0.6555], [0.9106, 0.11, 0.6459], [0.9225, 0.1244, 0.6316],
  [0.9344, 0.1435, 0.6172], [0.9463, 0.1627, 0.5981], [0.9583, 0.1914, 0.5742],
  [0.9702, 0.2297, 0.5407], [0.9762, 0.2632, 0.512]
];

/* 固件按 14 行 × 5 列（canonical 行序，行 0 = 脚跟侧）上报 70 个槽位，其中 14 个不接传感器。
   这两张表取自 APK 的 d56_pressure_mapping.g.dart：元素是 70 槽位的下标，顺序与 IR_POS 一一对应。
   v1(legacy) 与 v2(row-mirrored) 取的槽位相同、只是行内顺序相反；v3 在 v2 基础上按脚别翻列。 */
const IR_RAW_V2 = [68, 67, 64, 63, 62, 61, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 34, 33, 32, 31, 29, 28, 27, 26, 24, 23, 22, 21, 19, 18, 17, 16, 14, 13, 12, 11, 9, 8, 7, 6, 2, 1];

const IR_RAW_V1 = [67, 68, 61, 62, 63, 64, 55, 56, 57, 58, 59, 50, 51, 52, 53, 54, 45, 46, 47, 48, 49, 40, 41, 42, 43, 44, 36, 37, 38, 39, 31, 32, 33, 34, 26, 27, 28, 29, 21, 22, 23, 24, 16, 17, 18, 19, 11, 12, 13, 14, 6, 7, 8, 9, 1, 2];

/* 左右脚各一个独立状态对象。每只鞋垫有自己的连接、缓冲区、压力矩阵、
   波形历史与输出格式，互不影响 —— 两只同时连时不能共用一个对象。 */
/* 设备时钟映射的初始态：ofs=null 表示还没锚定，等第一帧带合法日历时锚定 */
const irClkNew = () => ({ ofs: null, n: 0, bad: 0, reanchor: 0, same: 0, coarse: false, last: NaN });

function irNewState(foot) {
  return {
    foot,                                        /* 'l' | 'r' */
    dev: null, chr: null, write: null, listeners: null, linkEpoch: 0,
    buf: new Uint8Array(0), samples: [], rec: [],
    recording: false, t0: 0, frames: 0, bad: 0, rate: 0, fpsT: 0, fpsN: 0,
    timer: 0, ymax: { a: 1, g: 60 }, last: null, info: '',
    ps: new Float32Array(PR_N).fill(PR_IDLE), seen: new Uint8Array(PR_N), prec: [],
    lastSeen: new Float64Array(PR_N).fill(NaN),
    frame: new Float32Array(PR_N), frameAt: 0,
    /* 导出用的 70 槽位快照。口径与 app 的 pressure_raw_values 一致：
       每帧只覆盖本帧上报的槽位，没上报的保持上一次的值 —— 它不是一个帧的
       稀疏集合，而是"截至此刻每个槽位的读数"。显示用的 frame 是另一套。 */
    slots: new Float32Array(70),
    slotOf: new Int8Array(PR_N).fill(-1),         /* 布局点 -> 槽位，导出 canonical 序用 */
    /* 默认自动补偿；连接之间不继承补偿 */
    bias: irBiasNew(),
    lut: new Int8Array(70).fill(-1),              /* 每只脚各自的槽位映射 */
    /* 设备日历对页面单调时钟的偏移（ms）：首帧锚定，校时跳变就重锚。
       coarse = 设备时钟变化太粗（整秒级），这种只能退回用帧的到达时刻 */
    clk: irClkNew(),
    effMs: 0,                                     /* 上一帧的有效帧时间，单调兜底用 */
    capI: -1,                                     /* 本帧属于第几次连接（导出流/段 id 用） */
    sel: -1, hover: -1, hit: [],
    hist: Array.from({ length: PR_N }, () => []),
    pHit: 0, pFrames: 0, pSkip: 0, pIds: '—', tempRaw: null,
    fmt: null, fmtSrc: 'none', state: null, calib: null, wait: null, cmdId: 0, acks: 0, badAck: 0, lastAck: null, lastTx: '',
    /* 默认 144 B：测量帧是 0x09（V2 Bitmap）的设备，其 runtime contract 对应
       control-20261031-v2，命令也只认 144 B。默认成 80 B 会让每次写入都打空。 */
    link: 'v2', rxBytes: 0, rxTail: [], lastRx: '', ffBytes: 0, odd: [], looseHit: false
  };
}

const IR_SIDES = ['l', 'r'];

const irStates = { l: irNewState('l'), r: irNewState('r') };

/* 每次 BLE 连接一条：导出要给每帧标出它来自哪条采集流/段/连接纪元，
   断开重连后旧帧仍要指回旧连接，所以按连接建表、帧上只存下标。 */
const IR_CONNS = [];

function irConnNew() {
  IR_CONNS.push({
    stream: ulid(), seg: ulid(),
    epoch: BigInt(Math.round(performance.now() * 1000)),
  });
  return IR_CONNS.length - 1;
}

let irActive = 'l';

                              /* 面板当前显示哪只脚 */
/* ir 始终指向"当前显示的那只"，所以原有逻辑不用每条都改；
   连接、解帧这类按设备走的流程必须显式传 state，不能用 ir。 */
const ir = new Proxy({}, {
  get(t, k) { return irStates[irActive][k]; },
  set(t, k, v) { irStates[irActive][k] = v; return true; },
  has(t, k) { return k in irStates[irActive]; }
});

const irOf = (st) => st || irStates[irActive];

/* 70 槽位 → 布局点下标（-1 = 该槽位没接传感器）。
   映射按脚各建一份：左脚用 row-mirrored 表，右脚都是同一只鞋镜像，翻列。
   拓扑下拉是全局的（同一批固件），脚别由设备自己决定，不再共用一个数组。 */
const irLut = new Int8Array(70).fill(-1);

        /* = 当前活动脚的映射，只读镜像 */
function irLutOf(foot) { return irStates[foot || irActive].lut; }

function irBuildLut(foot) {
  const both = foot ? [foot] : IR_SIDES;
  for (const f of both) {
    const topo = ($('prTopo', f) && $('prTopo', f).value === 'v1') ? 'v1' : 'v2';
    const base = topo === 'v1' ? IR_RAW_V1 : IR_RAW_V2;
    const dst = irStates[f].lut;
    dst.fill(-1);
    /* v1 表本身就按脚实测，只有 v2 需要右脚行内翻列（同 app 的 rawIndicesFor） */
    const flip = topo !== 'v1' && f === 'r';
    const so = irStates[f].slotOf;
    base.forEach((raw, i) => {
      const slot = flip ? ((raw / 5 | 0) * 5 + 4 - (raw % 5)) : raw;
      dst[slot] = i;
      so[i] = slot;
    });
  }
  irLut.set(irStates[irActive].lut);
}

/* 广播名带 L/R 就直接认：W01-L / W01-R / IMU-L / D56-R。
   名字显式写了 R 才是右脚；写了 L 或看不出（IMU-R、D56-01 这种）一律按左脚 ——
   D56 那台的名字里的 R 是型号后缀，不是脚别，所以只在 -R / _R 结尾时才判右脚。 */
function footFromName(name) {
  const n = String(name || '').toUpperCase();
  if (/-R$|_R$|\bRIGHT\b/.test(n)) return 'r';
  if (/-L$|_L$|\bLEFT\b/.test(n)) return 'l';
  return null;                       /* 认不出 → 由调用方排到空着的那只 */
}

/* 某只脚是否已连接 */
const irOnOf = (foot) => {
  const st = irStates[foot];
  return !!(st.dev && st.dev.gatt && st.dev.gatt.connected);
};

const irAnyOn = () => IR_SIDES.some(irOnOf);

const irOn = () => irOnOf(irActive);

/* 切当前脚：$() 取元素、ir 代理取状态都要跟着换，lut 镜像同步 */
function setCur(f) {
  irCur = f; irActive = f;
  irLut.set(irStates[f].lut);
}

function withFoot(f, fn) {
  const a = irCur, b = irActive;
  setCur(f);
  try { return fn(); } finally { irCur = a; irActive = b; irLut.set(irStates[b].lut); }
}

/* 自研 IMU-R：广播名 IMU-xx，协议与 WT901 完全不同，不能走 connectOne */
/* 自研鞋垫的广播名：IMU-R（早期）/ W01-L、W01-R（左右脚）/ D56-*，都是同一套 5A 00 09 帧 */
function isImurDev(d) { return /^(IMU|W0\d|D56)/i.test((d && d.name) || ''); }

async function irConnect(picked, foot) {
  /* 连哪只脚由广播名决定（W01-L / W01-R / D56-*），认不出就排到空着的那只。
     设备名要等用户在弹窗里选完才知道，所以先选设备、再定脚。 */
  if (!navigator.bluetooth) {
    return log('这个环境没有 Web Bluetooth：用「打开IMU页面.bat」的 http://127.0.0.1:8765 打开，别直接双击 html', 'e');
  }
  $('btnIrOn').disabled = true;
  let dev;
  try {
    dev = picked || await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'IMU' }, { namePrefix: 'W0' }, { namePrefix: 'D56' }],
      optionalServices: [U16('180d'), U16('180a'), U16('180f')]
    });
  } catch (e) {
    $('btnIrOn').disabled = false;
    return log('没有选中设备：' + (e.message || e), 'w');
  }
  const want = foot || footFromName(dev.name) || (irOnOf('l') ? 'r' : 'l');
  const st = irStates[want];
  const target = want;
  if (st.dev && st.dev.gatt && st.dev.gatt.connected) {
    $('btnIrOn').disabled = false;
    return log((want === 'r' ? '右脚' : '左脚') + '已连着 ' + (st.dev.name || '') + '，先断开再连', 'w');
  }
  irDetach(st);
  irDropWait(st, true);
  const generation = ++st.linkEpoch;
  st.dev = dev; st.chr = null; st.write = null;
  st.buf = new Uint8Array(0); st.clk = irClkNew(); st.effMs = 0;
  irBiasReset(st, true);
  const current = () => st.dev === dev && st.linkEpoch === generation;
  const stale = () => {
    if (current()) return false;
    if (st.dev !== dev && dev.gatt && dev.gatt.connected) {
      try { dev.gatt.disconnect(); } catch (e) {}
    }
    return true;
  };
  const listeners = { dev, chr: null, write: null,
    gone: () => { if (current()) irGone(target, dev, generation); }, notify: null, reply: null };
  st.listeners = listeners;
  dev.addEventListener('gattserverdisconnected', listeners.gone);
  try {
    const server = await dev.gatt.connect();
    if (stale()) return;
    const hr = await server.getPrimaryService(U16('180d'));
    if (stale()) return;
    const chr = await hr.getCharacteristic(U16('2a37'));
    if (stale()) return;
    st.chr = chr; listeners.chr = chr;
    listeners.notify = (e) => { if (current() && st.chr === chr) irEvt(e, target); };
    chr.addEventListener('characteristicvaluechanged', listeners.notify);
    await chr.startNotifications();
    if (stale()) return;
    let write = null;
    try { write = await hr.getCharacteristic(U16('ffe1')); }
    catch (e) { if (current()) log('没找到 FFE1 写入通道：输出格式只能看不能改', 'w'); }
    if (stale()) return;
    st.write = write;
    /* 部分固件从写通道回执，监听器同样受连接代次保护。 */
    if (write && write.properties && (write.properties.notify || write.properties.indicate)) {
      try {
        listeners.write = write;
        listeners.reply = (e) => { if (current() && st.write === write) irEvtW(e, target); };
        write.addEventListener('characteristicvaluechanged', listeners.reply);
        await write.startNotifications();
      } catch (e) { if (current()) log('FFE1 订阅失败（不影响采集）：' + (e.message || e), 'w'); }
      if (stale()) return;
    }
  } catch (e) {
    if (!current()) return;
    log('连接失败：' + (e.message || e), 'e');
    irClose(target);
    return;
  }
  await irReadInfo(st, dev, generation);
  if (stale()) return;
  st.capI = irConnNew();
  st.buf = new Uint8Array(0);
  st.samples.length = 0; st.frames = 0; st.bad = 0; st.last = null; st.t0 = 0;
  st.ymax = { a: 1, g: 60 };
  prReset(target);
  clearInterval(st.timer);
  st.timer = setInterval(() => irTick(target), 100);
  log('IMU-R 已连接（' + (st.dev.name || '') + '），订阅 2A37', 'i');
  if (st.info) log('设备信息：' + st.info, 'i');
  irHead();
  withFoot(target, () => { irDraw(); irFmtText(); });
  /* 这版鞋垫固件对 0x0D 不回执，连接时自动试探两套命令可能干扰数据链路。
     状态回读只由用户点击按钮触发；平时按本地保存的最近一次写入格式显示。 */
}

async function irReadInfo(st, expected = st.dev, generation = st.linkEpoch) {
  const parts = [];
  try {
    const di = await expected.gatt.getPrimaryService(U16('180a'));
    for (const [id, name] of [['2a29', '厂商'], ['2a24', '型号'], ['2a26', '固件'], ['2a25', '序列号']]) {
      try {
        const b = await (await di.getCharacteristic(U16(id))).readValue();
        parts.push(name + ' ' + new TextDecoder().decode(b).replace(/\0/g, '').trim());
      } catch (e) { /* 固件没实现某个特征就算了 */ }
    }
  } catch (e) { /* 没有设备信息服务不影响采集 */ }
  try {
    const bs = await expected.gatt.getPrimaryService(U16('180f'));
    const v = await (await bs.getCharacteristic(U16('2a19'))).readValue();
    if (v.byteLength) parts.push('电量 ' + v.getUint8(0) + '%');
  } catch (e) { /* 没有电量服务同理 */ }
  if (st.dev === expected && st.linkEpoch === generation) st.info = parts.join(' · ');
}

function irDetach(st) {
  const l = st.listeners;
  if (!l) return;
  l.dev.removeEventListener('gattserverdisconnected', l.gone);
  if (l.chr && l.notify) l.chr.removeEventListener('characteristicvaluechanged', l.notify);
  if (l.write && l.reply) l.write.removeEventListener('characteristicvaluechanged', l.reply);
  st.listeners = null;
}

function irGone(foot, expected, generation) {
  const st = irStates[foot || irActive];
  if ((expected && st.dev !== expected) || (generation !== undefined && st.linkEpoch !== generation)) return;
  const d = st.dev;
  irDetach(st); st.linkEpoch++;
  clearInterval(st.timer); st.timer = 0;
  irDropWait(st, true);
  st.dev = null; st.chr = null; st.write = null; st.recording = false; st.capI = -1;
  st.buf = new Uint8Array(0); st.clk = irClkNew(); st.effMs = 0;
  irBiasReset(st, true);
  log('鞋垫断开（' + ((d && d.name) || '未连接') + ' · ' + (st.foot === 'r' ? '右脚' : '左脚') + '）', 'w');
  /* 断开后帧时间会重新锚定，旧会话的时钟不再可比 */
  if (typeof actStop === 'function') actStop('鞋垫断开');
  irHead();
  withFoot(st.foot, () => { irPressDraw(); pwDraw(); prNums(); });
}

function irClose(foot) {
  const f = foot || irActive;
  const st = irStates[f];
  const d = st.dev;
  irDetach(st); st.linkEpoch++;
  clearInterval(st.timer); st.timer = 0;
  irDropWait(st, true);
  st.dev = null; st.chr = null; st.write = null; st.recording = false; st.capI = -1;
  st.buf = new Uint8Array(0); st.clk = irClkNew(); st.effMs = 0;
  irBiasReset(st, true);
  if (d) {
    try { if (d.gatt && d.gatt.connected) d.gatt.disconnect(); } catch (e) {}
  }
  log('鞋垫已断开（' + (f === 'r' ? '右脚' : '左脚') + '）', 'i');
  if (typeof actStop === 'function') actStop('鞋垫断开');
  irHead();
  withFoot(f, () => { irPressDraw(); pwDraw(); prNums(); });
}

function irEvt(e, foot) {
  const received = performance.now();
  const v = e.target.value;
  irFeed(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), foot, received);
}

/* FFE1 回执：单独计数，方便判断「设备从写通道回了、只是没走 2A37」 */
function irEvtW(e, foot) {
  const received = performance.now();
  const v = e.target.value;
  const st = irStates[foot || irActive];
  st.ffBytes += v.byteLength;
  irFeed(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), foot, received);
}

/* ---------- 主机命令：读/写设备的压力输出格式 ----------
   固件有两套命令合同，设备只认一套、另一套整包静默丢弃，所以两套都得能发：
   · 144 B（2026-10-31 起的固件）：5A + 命令字 + 包号 u32 + UTC 毫秒 u32 + 负载长 u32 +
     负载(≤128) + CRC，CRC 固定在帧尾 [142..143]、覆盖前 142 B。
   · 80 B（旧固件）：头部同样 14 B、负载上限 64，CRC 紧跟负载（14 + 负载长）覆盖前 76 B，其余补零。
   两套下行 CRC 都是 init 0xFFFF、反射多项式 0xA001（与上行测量帧的 CCITT-FALSE 不同）。
   上行 ACK：新合同 19 + size 紧凑外壳（size ≤ 128）；旧合同 0x05/0x0D 是固定 83 B，
   CRC 走前 81 B 的 CCITT-FALSE。负载首字节是状态，0 = 成功。
   0x0D 状态体 41 B：[0] 工作模式 [1] 频率 [2] 输出格式 [3..4] 最大重量 [5..6] 最小重量
   [7..22] 设备名 [23..24] 噪声基准 [25..26][27..28] 两路温度 [29..30] 电压 [31..32] 电量。 */
const IR_LINK_NAME = { v2: '144 B 帧', v1: '80 B 帧' };

function irCrcIbm(b, n) {
  let crc = 0xffff;
  for (let i = 0; i < n; i++) {
    crc ^= b[i];
    for (let k = 0; k < 8; k++) crc = (crc & 1) ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc & 0xffff;
}

function irCrcAck(f) {
  let crc = 0xffff;
  for (let i = 0; i < 81; i++) {
    crc ^= f[i] << 8;
    for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc === (f[81] | (f[82] << 8));
}

/* 两代下行 CRC 都是 init 0xFFFF、反射多项式 0xA001（与上行测量帧的 CCITT-FALSE 不同）。
   144 B 的 CRC 固定在帧尾 [142..143]、覆盖前 142 B（含补零区），不是紧跟负载 ——
   这一点和 80 B 相反，写错就整包被丢。 */
function irCmd(st, type, payload, link) {
  const p = payload || new Uint8Array(0);
  const v2 = (link || st.link) !== 'v1';
  const b = new Uint8Array(v2 ? 144 : 80), dv = new DataView(b.buffer);
  b[0] = 0x5a; b[1] = type;
  dv.setUint32(2, ++st.cmdId, true);
  dv.setUint32(6, Date.now() & 0xffffffff, true);
  dv.setUint32(10, p.length, true);
  b.set(p, 14);
  /* CRC 字段自身要参与计算且此刻还是 0，与参考实现的 take(142) 一致 */
  const off = v2 ? 142 : 14 + p.length;
  const crc = irCrcIbm(b, v2 ? 142 : 76);
  b[off] = crc & 0xff; b[off + 1] = crc >> 8;
  return b;
}

function irLinkGuard(st) {
  const dev = st.dev, generation = st.linkEpoch;
  return () => {
    if (st.dev === dev && st.linkEpoch === generation) return;
    const e = new Error('连接已变化，命令已取消');
    e.cancelled = true;
    throw e;
  };
}

function irDropWait(st, cancel) {
  const w = st.wait;
  if (!w) return;
  clearTimeout(w.timer); st.wait = null;
  if (cancel) {
    const e = new Error('连接已断开，命令已取消');
    e.cancelled = true;
    w.rej(e);
  }
}

/* 浏览器没有「单次 SDK 操作」这个开关：只要超过 MTU-3，Chrome 会自动拆成多个
   ATT 包（prepare/execute long write）。App 那边显式要求 singleSdkOperation，
   说明固件把「一条命令」当成一包解析，拆包后头部对不上就整包丢弃。
   Web Bluetooth 无法协商 MTU，能做的是：优先用无响应写（单包上限 512 B，
   不受 MTU-3 限制），带响应写次之。都不行就如实报出来，别假装写入成功。 */
async function irWrite(st, pkt) {
  const c = st.write;
  const guard = irLinkGuard(st);
  if (!c) throw new Error('没有写入通道（FFE1）');
  const props = c.properties || {};
  const ways = [];
  /* 无响应写走单包通道，144 B 不会被拆；这是唯一有机会一次写完的路径 */
  if (c.writeValueWithoutResponse) ways.push(['无响应', c.writeValueWithoutResponse.bind(c)]);
  if (c.writeValueWithResponse) ways.push(['带响应', c.writeValueWithResponse.bind(c)]);
  if (!ways.length && c.writeValue) ways.push(['单参数', c.writeValue.bind(c)]);
  if (!ways.length) throw new Error('FFE1 不支持写入');
  let err = null;
  for (const [name, fn] of ways) {
    try {
      guard();
      const r = await fn(pkt);
      guard();
      if (pkt.length > 120 && name === '带响应') {
        log('本次用带响应写发出 ' + pkt.length + ' B，超过 MTU 时会被自动拆包，固件可能不认', 'w');
      }
      return r;
    } catch (e) { guard(); err = err || [name, e]; }
  }
  const m = (err[1] && (err[1].name || err[1].message)) || String(err[1]);
  throw new Error('写入 ' + pkt.length + ' B 失败（' + err[0] + '）：' + m
    + (pkt.length > 120 ? '｜该帧须一次写完，链路单包容量不足时固件不会应答' : ''));
}

/* 一次只放一条命令在途，避免两条响应互相顶掉（设备不回显请求 ID）。
   等回包期间把收到的原始字节记下来：设备一声不响和「回了但没认出来」是两种病，
   超时提示里要能把它们区分开。 */
/* 超时诊断。等回执期间测量帧照常在流动，所以「收到多少字节」本身没有信息量；
   真正要抓的是「不像测量帧的 5A 开头字节」—— 回执若存在，一定在这里。 */
function irRxHint(st) {
  const parts = ['等回执的窗口里仍在收测量帧 ' + st.rxBytes + ' 字节'];
  if (st.ffBytes) parts.push('FFE1 收到 ' + st.ffBytes + ' 字节');
  parts.push(st.odd.length ? '非测量候选 ' + st.odd.join(' ; ') : '未见任何非测量帧');
  return parts.join('｜');
}

async function irSend(st, type, payload, ms, link) {
  if (!irOnOf(st.foot)) throw new Error('未连接');
  if (st.wait) throw new Error('上一条命令还在等回包');
  const ln = link || st.link;
  const pkt = irCmd(st, type, payload, ln);
  st.rxBytes = 0; st.rxTail.length = 0; st.ffBytes = 0; st.odd.length = 0;
  const guard = irLinkGuard(st);
  let pending;
  const p = new Promise((res, rej) => {
    const timer = setTimeout(() => {
      if (st.wait !== pending) return;
      st.wait = null;
      const e = new Error('等不到回执（' + IR_LINK_NAME[ln] + '）：' + irRxHint(st));
      e.sent = true;
      rej(e);
    }, ms || 1200);
    pending = { type, link: ln, res, rej, timer };
    st.wait = pending;
  });
  irWrite(st, pkt).then(() => {
    try { guard(); } catch (e) { pending.rej(e); return; }
    if (st.wait !== pending) return;
    st.lastTx = hexOf(pkt);
  }, (e) => {
    try { guard(); } catch (cancelled) { pending.rej(cancelled); return; }
    if (st.wait !== pending) return;
    irDropWait(st);
    e.sent = false;
    pending.rej(e);
  });
  return p;
}

/* 两套合同各试一次：先按上次探到的发，没回执就换另一套。

   ⚠️ 这台固件（D56V01 / bitmap 0x09）对命令**一律不回执**，所以「有没有回包」判不出
   哪套有效 —— 只要两套都写出去、按压又生效，就无法反推是哪一包起的作用。
   上一版据此加了「确认不回执后只发一包 + 记住上次成功那套」，结果记成了 80 B，
   每次只发 80 B，写入全部失效。**教训：没有回执就不能剪枝，两套必须都发。**
   唯一可靠的判据是 App 的契约配对（0x09 测量 ⇒ 144 B 命令），见 ir.link 的默认值。

   错误带 sent 标记表示「帧写出去了但没回执」，由调用方决定能否当成功。 */
async function irProbe(st, type, payload, ms) {
  const guard = irLinkGuard(st);
  const mode = irLinkMode(st.foot);
  const first = mode === 'auto' ? st.link : mode;
  const order = mode === 'auto' ? [first, first === 'v2' ? 'v1' : 'v2'] : [first];
  let last = null, sentOne = null, writeFail = null;
  for (const ln of order) {
    guard();
    try {
      const r = await irSend(st, type, payload, ms, ln);
      guard();
      if (st.link !== ln) log('命令帧改用 ' + IR_LINK_NAME[ln] + '（这一套有回执）', 'i');
      st.link = ln;
      try { localStorage.setItem('irCmdLink', ln); } catch (e) { /* 隐私模式写不了就算了 */ }
      return r;
    } catch (e) {
      guard();
      if (e.cancelled) throw e;
      if (e.sent) { sentOne = e; e.link = ln; last = e; continue; }
      /* 写就失败的（多半是 144 B 超过本条链路的单包容量）也要换一套再试 */
      writeFail = e; e.link = ln;
    }
  }
  if (sentOne) {
    /* 至少有一包写出去了：这是「没回执」而不是「发不出去」，交给调用方判断 */
    throw sentOne;
  }
  if (writeFail) throw writeFail;
  if (order.length === 1) throw last;
  const err = new Error('两套命令帧都写出去了，都没回执（' + order.map((l) => IR_LINK_NAME[l]).join(' + ') + '）');
  err.sent = true; err.link = order[order.length - 1]; err.cause = last;
  throw err;
}

function irAck(st, f, size, link, loose) {
  const type = f[2];
  const pl = f.subarray(17, 17 + Math.min(size, f.length - 19));
  st.acks++; st.lastAck = { type, status: pl.length ? pl[0] : 0, len: f.length, link };
  st.lastRx = hexOf(f.slice(0, Math.min(f.length, 64)));
  if (loose && !st.looseHit) {
    st.looseHit = true;
    log('回执帧头 witch=0x' + hex2(f[1]) + '（不是 0x00），已按放宽规则认出来', 'w');
  }
  if (st.lastAck.status === 0 && type === 0x0d) irState(pl.subarray(1), st.foot);
  const w = st.wait;
  if (w && w.type === type) { irDropWait(st); w.res(st.lastAck); }
}

/* 41 B 状态体；字段含义取自 APK 的 D56DeviceState，温度是 0.01 ℃ 的 int16 */
function irState(b, foot) {
  const st = irStates[foot || irActive];
  if (b.length < 41) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  st.state = {
    mode: b[0], freq: b[1], fmt: b[2],
    max: dv.getUint16(3, true), min: dv.getUint16(5, true),
    name: new TextDecoder().decode(b.subarray(7, 23)).replace(/\0[\s\S]*$/, ''),
    black: dv.getUint16(23, true),
    t1: dv.getInt16(25, true), t2: dv.getInt16(27, true),
    power: dv.getUint16(29, true), charge: dv.getUint16(31, true)
  };
  /* 77 B 状态体在 44..67 带六个 int32（陀螺 xyz、加计 xyz），全 -1 = 从未标定。
     旧 41 B 体没有这一段，必须当成「未提供」而不是 0。 */
  if (b.length >= 68) {
    st.calib = {
      body: b.length,
      gyro: [dv.getInt32(44, true), dv.getInt32(48, true), dv.getInt32(52, true)],
      acc: [dv.getInt32(56, true), dv.getInt32(60, true), dv.getInt32(64, true)]
    };
  } else {
    st.calib = { body: b.length, none: true };
  }
  st.fmt = st.state.fmt <= 4 ? st.state.fmt : null;
  if (st.fmt != null) st.fmtSrc = 'read';
  withFoot(st.foot, () => {
    if ($('dvFmt') && st.fmt != null) $('dvFmt').value = String(st.fmt);
    irFmtText();
  });
  return true;
}

/* 设备里存的零偏是「固件到底扣不扣」的唯一证据：全 -1 说明从未标定，
   此时测量帧一定带原始零偏，界面上看到的补偿全是本页自己估的。 */
function irCalibBrief(st) {
  const c = st && st.calib;
  if (!c) return '';
  if (c.none) return ' · 校准 未提供（状态体 ' + c.body + ' B）';
  if (c.gyro.concat(c.acc).every((v) => v === -1)) return ' · 校准 未标定';
  return ' · 校准 陀螺(' + c.gyro.join(',') + ') 加计(' + c.acc.join(',') + ') LSB';
}

function irStateText(st0) {
  const s = (st0 || irStates[irActive]).state;
  if (!s) return '未回读';
  return '输出格式 ' + FMT_NAME[s.fmt] + ' · 频率 ' + s.freq + ' · 工作模式 ' + s.mode
    + ' · 最小/最大 ' + s.min + '/' + s.max + ' · 噪声基准 ' + s.black
    + ' · 温度 ' + (s.t1 / 100).toFixed(2) + '/' + (s.t2 / 100).toFixed(2) + ' ℃'
    + ' · 电压原值 ' + s.power + ' · 电量原值 ' + s.charge
    + (s.name ? ' · 名称 ' + s.name : '')
    + irCalibBrief(st0 || irStates[irActive]);
}

async function irQueryState(st, silent) {
  let r;
  try {
    r = await irProbe(st, 0x0d, null, 1200);
  } catch (e) {
    if (e.sent) throw new Error('命令写进去了，但设备不回状态（0x0D 无回执）');
    throw e;
  }
  if (r.status !== 0) throw new Error('设备拒绝，状态 ' + r.status);
  st.fmtSrc = 'read';
  if (!silent) log('设备状态：' + irStateText(st), 'i');
  return r;
}

/* 没回执时靠按压自查口径：这是唯一不依赖设备回话的旁证 */
const FMT_SELF = [
  '按压峰值应 ≤ 4095（12 位 ADC 满量程），空载接近 0',
  '读数是采样电压，空载不再有 100 的固定偏置',
  '读数是可变电压，空载不再有 100 的固定偏置',
  '读数是折算阻值，空载不再有 100 的固定偏置',
  '空载恒 100、按压可到 10000，单位是 g'
];

async function irSetFmt(st, fmt) {
  if (!(fmt >= 0 && fmt <= 4)) throw new Error('格式值越界');
  let r = null, noAck = null;
  try {
    r = await irProbe(st, 0x10, Uint8Array.of(fmt), 1200);
  } catch (e) {
    if (!e.sent) throw e;                 // 根本没写出去才是真失败
    noAck = e;
  }
  if (r && r.status !== 0) throw new Error('设备拒绝，状态 ' + r.status);
  /* 0x10 是单向设置：真机这台设完不回执，但格式确实变了（按压数值可验）。
     没回执就按写入值显示，否则数据口径会和显示口径错开。 */
  st.fmt = fmt;
  st.fmtSrc = 'write';
  irFmtSave(fmt);
  if (!r) st.state = null;              // 没回读就别拿旧状态冒充当前状态
  withFoot(st.foot, () => {
    if ($('dvFmt')) $('dvFmt').value = String(fmt);
    irFmtText();
  });
  if (r) {
    try { await irQueryState(st, true); } catch (e) { /* 回读也不通就维持写入值 */ }
    if (st.state && st.state.fmt !== fmt) throw new Error('回读不一致（设备仍为 ' + FMT_NAME[st.state.fmt] + '）');
  }
  withFoot(st.foot, irRedraw);
  log('输出格式已写入 ' + FMT_NAME[fmt] + (r ? '，设备已确认' : '（设备无回执，按压自查：' + FMT_SELF[fmt] + '）'), r ? 'i' : 'w');
}

/* 同一路通知里既有测量帧（5A 00 09）也有命令回包，按 [2] 的类型字节分流。
   测量帧长 46 + 2×点数、CRC-16/CCITT-FALSE（前 138 字节，不足补零），
   长度或 CRC 不过就把起点前移一字节重找；按固定步长切会在丢包后一直错位。 */
const IR_ACK_TYPES = new Set([0x02, 0x05, 0x07, 0x08, 0x0c, 0x0d, 0x10, 0x11, 0x12, 0x18, 0x19, 0xf9, 0xfa, 0xff]);

/* 放宽匹配（witch≠0 的回执）只接受这些负载长：0x0D 是 1 B 状态 + 41 B 状态体，
   0x10 只有 1 B 状态。其余命令回执长度没实测过，宁可认不出来也不乱认。 */
/* 放宽路径（witch≠0）没有 CRC 可依，靠已知负载长自证。0x0D 有两代状态体：
   旧固件 41 B（size=42），新固件 77 B（size=78），两种都得认，否则新固件整帧被丢。 */
const IR_LOOSE_SIZE = { 0x0d: [42, 78], 0x10: [1], 0x05: [0] };

/* 把「不是 5A 00 09」的帧头抓下来。5A 也可能出现在压力/IMU 载荷里，所以这里只留样本
   给人看，是否认帧由 irFeed 的严格规则决定。 */
function irSniff(chunk, st) {
  st = st || irStates[irActive];
  for (let i = 0; i + 2 < chunk.length; i++) {
    if (chunk[i] !== 0x5a) continue;
    if (chunk[i + 1] === 0x00 && chunk[i + 2] === 0x09) continue;
    if (st.odd.length >= 4) return;
    const end = Math.min(chunk.length, i + 48);
    st.odd.push(hexOf(chunk.slice(i, end)) + (end < chunk.length ? '…' : ''));
  }
}

function irCrcOk(f) {
  const n = Math.min(f.length - 2, 138);
  let crc = 0xffff;
  for (let i = 0; i < 138; i++) {
    crc ^= (i < n ? f[i] : 0) << 8;
    for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc === (f[f.length - 2] | (f[f.length - 1] << 8));
}

function irFeed(chunk, foot, received = performance.now()) {
  const st = irStates[foot || irActive];
  if (st.wait) {
    st.rxBytes += chunk.length;
    for (let k = Math.max(0, chunk.length - 128); k < chunk.length; k++) st.rxTail.push(chunk[k]);
    if (st.rxTail.length > 128) st.rxTail.splice(0, st.rxTail.length - 128);
  }
  if (st.wait) irSniff(chunk, st);                                  /* 不论在不在等回执都记：迟到的回执也有证据 */
  const d = new Uint8Array(st.buf.length + chunk.length);
  d.set(st.buf); d.set(chunk, st.buf.length);
  let i = 0;
  for (;;) {
    let h = -1, loose = false;
    for (let j = i; j + 2 < d.length; j++) {
      if (d[j] !== 0x5a) continue;
      if (d[j + 1] === 0x00 && (d[j + 2] === 0x09 || IR_ACK_TYPES.has(d[j + 2]))) { h = j; break; }
      /* [1] 是语义未定的 witch，固件未必填 0。等回执时只在「类型正好是刚发的那条命令」
         这个强条件下放宽，否则压力载荷里随便一个 0x5A 都可能被当成帧头。 */
      if (st.wait && d[j + 2] === st.wait.type) { h = j; loose = true; break; }
    }
    if (h < 0) { i = Math.max(i, d.length - 2); break; }
    if (d[h + 2] === 0x09) {
      if (d.length - h < 30) { i = h; break; }              // 头部还没收齐
      const need = 46 + 2 * d[h + 29];
      if (d.length - h < need) { i = h; break; }            // 整帧还没收齐
      const f = d.subarray(h, h + need);
      if (!irCrcOk(f)) { st.bad++; i = h + 1; continue; }
      irFrame(f, foot, received);
      i = h + need;
      continue;
    }
    /* 外壳跟着发命令时用的合同走（设备只回自己那套）：旧合同 0x05/0x0D 是固定 83 B，
       新合同一律 19 + size。外壳不符就前移一字节重找，绝不硬解——否则残留字节会被当状态体。 */
    const ln = st.wait ? st.wait.link : st.link;
    /* 放宽路径（witch≠0）没有 CRC 可依，只能靠结构自证：帧尾要么正好是缓冲区末尾，
       要么紧跟一个合法帧头；再加一条「长度必须等于该命令的已知负载长」，
       否则压力载荷里随便一对 5A xx 0D 就能骗过它，代价是丢掉一串测量帧。 */
    /* 判据只留「size 必须正好命中该命令的已知负载长」——没有 CRC 时这是唯一可靠的信号，
       再叠加 size≤128 已经足够严。不再要求帧尾紧跟合法帧头：实测 0x0D 回执后面跟的是
       一段非帧数据（74 00 20 00 … A5 A5 A5 …，像内存/调试信息），硬要求会让它永远被丢。 */
    const fits = (end, sz) => {
      if (!loose) return true;
      const exp = IR_LOOSE_SIZE[st.wait ? st.wait.type : -1];
      return !!exp && exp.includes(sz);
    };
    if (ln !== 'v1' && (d[h + 2] === 0x0d || d[h + 2] === 0x05)) {
      if (d.length - h < 19) { i = h; break; }
      const size = d[h + 15] | (d[h + 16] << 8);
      const need = 19 + size;
      if (size > 128 || need < 19 || !fits(h + need, size)) { i = h + 1; continue; }
      if (d.length - h < need) { i = h; break; }
      irAck(st, d.subarray(h, h + need), size, 'v2', loose);
      i = h + need;
      continue;
    }
    if (d.length - h < 19) { i = h; break; }
    const size = d[h + 15] | (d[h + 16] << 8);
    if (ln === 'v1' && (d[h + 2] === 0x0d || d[h + 2] === 0x05)) {
      if (d.length - h < 83) { i = h; break; }
      const f = d.subarray(h, h + 83);
      if (!irCrcAck(f)) { st.badAck++; i = h + 1; continue; }
      irAck(st, f, size, 'v1', loose);
      i = h + 83;
      continue;
    }
    const need = 19 + size;
    if (need < 19 || need > 300 || !fits(h + need, size)) { i = h + 1; continue; }
    if (d.length - h < need) { i = h; break; }
    irAck(st, d.subarray(h, h + need), size, ln, loose);
    i = h + need;
  }
  st.buf = d.slice(i);
  if (st.buf.length > 8192) st.buf = new Uint8Array(0);   // 长期不同步就丢弃，免得越积越大
}

/* ---------- 设备日历：帧头自带 RTC ---------- */

/* 帧头 11..14 是十进制打包的 YYYYMMDD、7..10 是 HHMMSSmmm（时/分/秒/毫秒各占固定位），
   与 app 的 d56-yyyyMMdd-HHmmssSSS-calendar-ordinal-us-v2 同口径。
   格式不成立返回 null。格式成立但值不对（出厂默认没对时，读出来是 2000-01-04）识别
   不了，所以上层只采信它的增量，从不把它当绝对时间。 */
function irDevClock(dateRaw, timeRaw) {
  const y = Math.floor(dateRaw / 1e4), mo = Math.floor(dateRaw / 100) % 100, d = dateRaw % 100;
  const h = Math.floor(timeRaw / 1e7), mi = Math.floor(timeRaw / 1e5) % 100;
  const s = Math.floor(timeRaw / 1e3) % 100, ms = timeRaw % 1000;
  if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const p2 = (v) => String(v).padStart(2, '0');
  return {
    date: y + '-' + p2(mo) + '-' + p2(d),
    time: p2(h) + ':' + p2(mi) + ':' + p2(s) + '.' + String(ms).padStart(3, '0'),
    epoch: new Date(y, mo - 1, d, h, mi, s, ms).getTime(),
  };
}

/* 把设备时钟放回页面单调时钟轴上，返回这一帧的时刻。
   为什么不用到达时刻：BLE 一包两帧、连接间隔、重传都会把帧间隔揉变形，设备时间每帧
   稳定 +19~20 ms 才是真实采样节奏；页面时钟只负责给出绝对零点。
   零点不取首帧那一次，而取最初几十帧里延迟最小的那次 —— 传输只会让到达偏晚，取最早
   的那次才最接近真实偏移。两只脚各自锚定后，跨脚的相对时标才对齐（否则两脚之间会
   差着各自连接间隔的抖动，做步态相位时就是个固定偏差）。
   两个兜底：设备中途被校时会跳，偏移差超 2 s 就重锚；设备时钟若只按整秒走（连续几帧
   一个值都不变），那就没法当时间基准，退回用到达时刻。 */
const IR_DEV_JUMP_MS = 2000, IR_DEV_COARSE = 3, IR_DEV_ANCHOR = 40;

function irDevSync(st, s, now) {
  const ck = st.clk;
  if (!s.clk || ck.coarse) { if (!s.clk) ck.bad++; s.tSrc = 'host'; return now; }
  const e = s.clk.epoch;
  if (e === ck.last) {
    if (++ck.same >= IR_DEV_COARSE) {
      ck.coarse = true;
      log('设备时钟变化过粗（连续帧同值），帧时间改用页面时钟', 'w');
      s.tSrc = 'host';
      return now;
    }
  } else {
    ck.same = 0;
  }
  const lag = now - e;
  if (ck.ofs === null || Math.abs(e + ck.ofs - now) > IR_DEV_JUMP_MS) {
    if (ck.ofs !== null) {
      ck.reanchor++;
      log('设备时钟跳变 ' + (e + ck.ofs - now).toFixed(0) + ' ms，时间轴已重锚', 'w');
    }
    ck.ofs = lag;
    ck.n = 0;
  } else if (ck.n < IR_DEV_ANCHOR && lag < ck.ofs) {
    ck.ofs = lag;
  }
  ck.n++; ck.last = e;
  s.tSrc = 'device';
  return e + ck.ofs;
}

function irFrame(f, foot, received = performance.now()) {
  const st = irStates[foot || irActive];
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const now = st.remote ? received : performance.now();
  if (!st.t0) st.t0 = now;
  const t = (now - st.t0) / 1000;
  const r1 = dv.getInt16(17, true), r2 = dv.getInt16(19, true), r3 = dv.getInt16(21, true);
  const r4 = dv.getInt16(23, true), r5 = dv.getInt16(25, true), r6 = dv.getInt16(27, true);
  const tempRaw = dv.getInt16(15, true);
  const s = {
    t, len: f.length, pts: f[29], tempRaw, receiptPerf: received,
    desktopReceiveEpochMs: st.remote ? st.remoteReceipt : Date.now(),
    seq: dv.getUint32(3, true), ts: dv.getUint32(7, true), date: dv.getUint32(11, true),
    /* 线序原始 int16，导出 imu_raw_values 用（物理值是它的轴变换结果） */
    raw6: [r1, r2, r3, r4, r5, r6],
    clk: irDevClock(dv.getUint32(11, true), dv.getUint32(7, true)),
    ax: r2 * IR_ACC_G, ay: -r1 * IR_ACC_G, az: r3 * IR_ACC_G,
    gx: r5 * IR_GYR_DPS, gy: -r4 * IR_GYR_DPS, gz: r6 * IR_GYR_DPS
  };
  /* 原始值另存一份：parquet 导出给原始值，显示与波形给扣偏后的值。
     估计逻辑在 irBiasTrack 里，只读原始值 —— 用扣后的值再估会自己吃自己。 */
  s.gx0 = s.gx; s.gy0 = s.gy; s.gz0 = s.gz;
  if (!st.remote) irBiasTrack(st, s);
  s.gx -= st.bias.g[0]; s.gy -= st.bias.g[1]; s.gz -= st.bias.g[2];
  s.perf = irDevSync(st, s, now);
  st.frames++; st.fpsN++; st.last = s; st.tempRaw = tempRaw;
  st.lastRaw = f.slice(0, Math.min(f.length, 60));
  st.samples.push(s);
  /* 推断吃扣过零偏的 gx/gy/gz（上面这行刚扣完），未就绪时由 actFeed 自己挡住 */
  if (typeof actFeed === 'function') actFeed(st, s);

  /* 压力：bitmap 30..43 共 14 字节逐行（bit0..4 对列 0..4，bit5..7 保留为 0），
     值从 44 起按 sourceRow 升序、列升序排列，每点 int16。canonicalRow = 13 − sourceRow，
     与 IR_POS 的行序一致（行 1 = 趾端），所以槽位下标直接 (13−row)*5+col。 */
  const N = f[29];
  st.pHit = N;
  /* 每帧就是一份快照：先整块清零，再把本帧带的点填进去。本帧没带 = 0。
     不做保持、不做过期，界面永远只反映最近这一帧。 */
  st.frame.fill(0);
  const fv = st.frame;
  if (N > 0) {
    const ids = [];
    let k = 0;
    for (let row = 0; row < 14; row++) {
      const bits = f[30 + row];
      for (let col = 0; col < 5; col++) {
        if (!((bits >> col) & 1)) continue;
        if (k >= N) break;
        const g = dv.getInt16(44 + 2 * k, true);
        k++;
        const slot = (13 - row) * 5 + col;
        st.slots[slot] = g;             /* 导出快照，不随本帧没带而清零 */
        const idx = st.lut[slot];
        if (idx < 0) { st.pSkip++; continue; }
        st.ps[idx] = g;
        st.seen[idx] = 1;
        st.lastSeen[idx] = t;
        fv[idx] = g;
        ids.push(idx + 1);
        if (st.recording && (!st.remote || received >= REC_T0)) st.prec.push({ t, ch: idx + 1, g, slot: (13 - row) * 5 + col });
      }
    }
    st.pFrames++;
    st.pIds = ids.join(' ') || '—';
  } else {
    st.pIds = '—';
  }
  /* 波形也逐帧记一次本帧的值：这样曲线上每个采样点都是真实帧，不再靠"保持/过期"拼出来 */
  st.frameAt = t;
  if (st.sel >= 0) pwPush(st.sel, t, fv[st.sel], st.foot);

  /* 录制必须在压力解析之后再存快照，否则存到的是上一帧的槽位 */
  if (st.recording && (!st.remote || received >= REC_T0)) {
    s.slots = Array.from(st.slots);
    /* 原始通知包留摘要不留字节：导出的 raw_packet_sha256 要它，但整包留着
       一次长录制就是几十 MB，摘要 64 字符还够用 */
    s.pkt = sha256Hex(f);
    /* 没走过连接流程就来的帧（重连前残留、自动化灌帧）也要有连接标识，
       否则导出这些行的流/段 id 是空的 */
    if (st.capI < 0) st.capI = irConnNew();
    s.cap = st.capI;
    /* 有效帧时间 = 帧时刻 − 录制起点。设备的 1 ms 分辨率、校时重锚、退回到达时刻
       都可能让这个差原地不动或倒退，兜个单调，免得行序和 effective_elapsed_us 打架。 */
    s.effMs = Math.max(st.effMs, s.perf - REC_T0);
    st.effMs = s.effMs;
    st.rec.push(s);
  }

  if (st.samples.length > 80) {
    const cut = t - IR_KEEP;
    if (st.samples[0].t < cut) {
      let i = 0;
      while (i < st.samples.length && st.samples[i].t < cut) i++;
      st.samples.splice(0, i);
    }
  }
}

/* 两只脚各有一个定时器，但只有活动那只刷新可见面板，省掉一半无谓重绘 */
function irTick(foot) {
  const st = irStates[foot || irActive];
  if (!st.remote) irBiasTrack(st);
  if (!st.samples.length) return;
  const now = performance.now();
  if (now - st.fpsT >= 1000) {
    st.rate = Math.round(st.fpsN * 1000 / (now - st.fpsT));
    st.fpsN = 0; st.fpsT = now;
  }
  withFoot(st.foot, () => {
    irNums(st.last);
    irDraw();
    irPressDraw();
    prNums();
    pwDraw();
  });
}

/* ---------- 网页侧零偏补偿 ----------
   六轴不能区分恒速 yaw 和常量偏置；默认自动学习静止窗，稳定常量（无论大小）
   都可能被当作偏置吸收。以下为工程门限，需要真机验证，不代表精度保证。 */
const IR_BIAS_MS = 3000, IR_BIAS_TIMEOUT = 12000, IR_BIAS_MIN = 30, IR_BIAS_GAP = 250;
const IR_BIAS_GSTD = 1.5, IR_BIAS_GRANGE = 6, IR_BIAS_DRIFT = 0.5;
const IR_BIAS_ASTD = 0.02, IR_BIAS_ARANGE = 0.06, IR_BIAS_AERR = 0.12, IR_BIAS_MAX = 40;

const IR_DYN_INIT_MS = 5000, IR_DYN_MS = 3000, IR_DYN_INIT_MIN = 50, IR_DYN_MIN = 30;
const IR_DYN_ROWS = 16384, IR_DYN_RAW_MAX = 40;
const IR_DYN_GSTD = 0.12, IR_DYN_GRANGE = 0.56, IR_DYN_DRIFT = 0.14;
const IR_DYN_ASTD = 0.01, IR_DYN_ARANGE = 0.04, IR_DYN_AERR = 0.08, IR_DYN_ADIR = 0.02;
const IR_DYN_TAU = 10, IR_DYN_RATE = 0.5;
const IR_DYN_NOTE = '稳定匀速转动也可能误判为静止并被补偿';

function irBiasNew() {
  return { g: [0, 0, 0], ready: false, still: 0, collect: null,
    status: '未就绪 · 等待静止',
    mode: 'dynamic', anchor: null, boundary: false, dynamic: null };
}

function irBiasSetMode(st, mode) {
  if (mode !== 'manual' && mode !== 'dynamic') return;
  const b = st.bias;
  if (b.mode === mode) { irBiasText(st); return; }
  if (b.collect) { clearTimeout(b.collect.timer); b.collect = null; }
  b.mode = mode; b.dynamic = null; b.still = 0;
  b.status = mode === 'manual'
    ? (b.ready ? '手动模式，保留当前补偿' : '手动模式，请点「静止校准」')
    : (b.ready ? '等待静止窗' : '未就绪 · 等待静止');
  irBiasText(st);
}

function irBiasDynamicClear(st, reason) {
  if (st.bias.dynamic) st.bias.dynamic.rows = [];
  st.bias.still = 0;
  st.bias.status = '等待下一段静止：' + reason + (st.bias.ready ? ' · 保留补偿' : ' · 未就绪');
  irBiasText(st);
}

function irBiasDynamicStats(rows, start, end) {
  const mu = Array(6).fill(0), square = Array(6).fill(0), span = end - start;
  // 按时间积分线性插值，不能让密集到达的帧稀释真实运动时长。
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], q = rows[i];
    const lo = Math.max(start, p[6]), hi = Math.min(end, q[6]);
    if (hi <= lo) continue;
    const width = q[6] - p[6], weight = (hi - lo) / span;
    for (let k = 0; k < 6; k++) {
      const a = p[k] + (q[k] - p[k]) * (lo - p[6]) / width;
      const z = p[k] + (q[k] - p[k]) * (hi - p[6]) / width;
      mu[k] += (a + z) * 0.5 * weight;
      square[k] += (a * a + a * z + z * z) / 3 * weight;
    }
  }
  return { mu, std: square.map((v, k) => Math.sqrt(Math.max(0, v - mu[k] ** 2))) };
}

function irBiasDynamic(st, s) {
  const b = st.bias;
  if (!s) return;
  const now = performance.now(), eps = 1e-12;
  if (!Number.isFinite(now) || !Number.isInteger(s.seq) || s.seq < 0 || s.seq > 0xffffffff) {
    irBiasDynamicClear(st, '时间或帧序号无效'); return;
  }
  let c = b.dynamic;
  if (!c) c = b.dynamic = { rows: [], lastSeq: null, lastHost: null, lastEpoch: null, coarse: false };
  if (s.seq === c.lastSeq) return;
  const epoch = s.clk && Number.isFinite(s.clk.epoch) ? s.clk.epoch : null;
  const hostDelta = c.lastHost === null ? null : now - c.lastHost;
  const devDelta = epoch !== null && c.lastEpoch !== null ? epoch - c.lastEpoch : null;
  const gap = (c.lastSeq !== null && s.seq !== ((c.lastSeq + 1) >>> 0))
    || (hostDelta !== null && (hostDelta < 0 || hostDelta > IR_BIAS_GAP))
    || (devDelta !== null && (devDelta < 0
      || (c.coarse ? Math.abs(devDelta - hostDelta) > 1000 : devDelta > IR_BIAS_GAP)));
  c.lastSeq = s.seq; c.lastHost = now; c.lastEpoch = epoch;
  if (gap) { irBiasDynamicClear(st, '数据不连续'); return; }
  if (epoch === null || devDelta === 0) c.coarse = true;
  const q = [s.gx0, s.gy0, s.gz0, s.ax, s.ay, s.az];
  if (!q.every(Number.isFinite) || (s.raw6 && s.raw6.some((v) => !Number.isFinite(v) || Math.abs(v) >= 32767))) {
    irBiasDynamicClear(st, '数据无效或传感器满量程'); return;
  }
  /* 每轴 40 °/s 只是数值保护（与手动校准同上限）；是否运动由窗内变化判，
     不用“离偏置 0 多远”推断。 */
  if (Math.abs(s.gx0) > IR_DYN_RAW_MAX + eps || Math.abs(s.gy0) > IR_DYN_RAW_MAX + eps
    || Math.abs(s.gz0) > IR_DYN_RAW_MAX + eps) {
    irBiasDynamicClear(st, '角速度超出数值保护范围'); return;
  }
  /* 同 host 的重复帧也要先过加速度门，否则异常加速度会被直接吞掉。 */
  if (Math.abs(Math.hypot(s.ax, s.ay, s.az) - 1) > IR_DYN_AERR + eps) {
    irBiasDynamicClear(st, '加速度模长超出静止范围'); return;
  }
  if (hostDelta === 0) return;
  q.push(now, epoch); c.rows.push(q); b.still = c.rows.length;
  if (c.rows.length > IR_DYN_ROWS) { irBiasDynamicClear(st, '候选窗口超长'); return; }
  const rows = c.rows, span = now - rows[0][6], ms = b.ready ? IR_DYN_MS : IR_DYN_INIT_MS;
  const devSpan = !c.coarse && epoch !== null && rows[0][7] !== null ? epoch - rows[0][7] : null;
  const acceptedSpan = devSpan === null ? span : Math.min(span, devSpan);
  b.status = (b.ready ? '采样中 ' : '未就绪 · 等待静止 ')
    + Math.min(acceptedSpan / 1000, ms / 1000).toFixed(1) + '/' + (ms / 1000).toFixed(1) + ' 秒';
  if (acceptedSpan < ms || rows.length < (b.ready ? IR_DYN_MIN : IR_DYN_INIT_MIN)) { irBiasText(st); return; }
  const stats = irBiasDynamicStats(rows, rows[0][6], now), mu = stats.mu;
  for (let k = 0; k < 6; k++) {
    let lo = Infinity, hi = -Infinity;
    for (const row of rows) { lo = Math.min(lo, row[k]); hi = Math.max(hi, row[k]); }
    if (stats.std[k] > (k < 3 ? IR_DYN_GSTD : IR_DYN_ASTD) + eps
      || hi - lo > (k < 3 ? IR_DYN_GRANGE : IR_DYN_ARANGE) + eps) {
      irBiasDynamicClear(st, '窗口变化超限'); return;
    }
  }
  const first = irBiasDynamicStats(rows, rows[0][6], rows[0][6] + span / 3).mu;
  const last = irBiasDynamicStats(rows, rows[0][6] + span * 2 / 3, now).mu;
  const drift = last.map((v, k) => v - first[k]);
  if (Math.hypot(...drift.slice(0, 3)) > IR_DYN_DRIFT + eps || Math.hypot(...drift.slice(3)) > IR_DYN_ADIR + eps) {
    irBiasDynamicClear(st, '首尾角速度或重力方向变化'); return;
  }
  if (Math.abs(Math.hypot(...mu.slice(3)) - 1) > IR_DYN_AERR + eps) {
    irBiasDynamicClear(st, '窗口重力模长超限'); return;
  }
  const obs = mu.slice(0, 3);
  if (!b.ready) {
    b.g = obs; b.ready = true;
    b.status = '已初始化 · 等待下一段静止';
  } else {
    // 不重叠窗只积分一次；累计位移无人工解锁，允许缓慢跟随真实零偏漂移。
    const dt = acceptedSpan / 1000, alpha = -Math.expm1(-dt / IR_DYN_TAU);
    const delta = obs.map((v, k) => v - b.g[k]).map((v) => v * alpha), norm = Math.hypot(...delta);
    const scale = norm > IR_DYN_RATE * dt ? IR_DYN_RATE * dt / norm : 1;
    b.g = b.g.map((v, k) => v + delta[k] * scale);
    b.status = '已更新 · 等待下一段静止';
  }
  c.rows = []; b.still = 0;
  irBiasText(st);
}

function irBiasStart(st) {
  const b = st.bias;
  b.dynamic = null;
  if (b.collect) clearTimeout(b.collect.timer);
  const now = performance.now();
  const c = { start: now, deadline: now + IR_BIAS_TIMEOUT, timer: 0, rows: [],
    lastSeq: null, lastHost: null, lastEpoch: null, hostStart: null, devStart: null,
    devLast: null, coarse: false };
  b.collect = c; b.still = 0; b.status = '等待稳定' + (b.ready ? ' · 保留上次补偿' : ' · 未校准');
  c.timer = setTimeout(() => {
    if (st.bias === b && b.collect === c) irBiasCancel(st, '校准超时');
  }, IR_BIAS_TIMEOUT);
  irBiasText(st);
}

function irBiasCancel(st, reason) {
  const b = st.bias;
  if (b.collect) clearTimeout(b.collect.timer);
  b.collect = null; b.dynamic = null; b.still = 0;
  b.status = (reason || '校准取消') + (b.ready ? ' · 保留上次补偿' : ' · 未校准')
    + (b.mode === 'dynamic' ? ' · 自动学习继续' : '');
  irBiasText(st);
}

function irBiasSegment(st, reason) {
  const b = st.bias, c = b.collect;
  c.rows.length = 0; c.hostStart = null; c.devStart = null; c.devLast = null; c.coarse = false;
  b.still = 0; b.status = '等待稳定：' + reason + (b.ready ? ' · 保留上次补偿' : ' · 未校准');
  irBiasText(st);
}

function irBiasTrack(st, s) {
  const b = st.bias, c = b.collect;
  if (!c) {
    if (b.mode === 'dynamic') irBiasDynamic(st, s);
    return;
  }
  const now = performance.now();
  if (now >= c.deadline) { irBiasCancel(st, '校准超时'); return; }
  if (!s) { irBiasText(st); return; }
  if (!Number.isInteger(s.seq) || s.seq < 0 || s.seq > 0xffffffff) {
    irBiasSegment(st, '帧序号无效'); return;
  }
  if (s.seq === c.lastSeq) return;
  const seqGap = c.lastSeq !== null && s.seq !== ((c.lastSeq + 1) >>> 0);
  const hostGap = c.lastHost !== null && (now < c.lastHost || now - c.lastHost > IR_BIAS_GAP);
  const epoch = s.clk && Number.isFinite(s.clk.epoch) ? s.clk.epoch : null;
  const devDelta = epoch !== null && c.lastEpoch !== null ? epoch - c.lastEpoch : null;
  const hostDelta = c.lastHost !== null ? now - c.lastHost : 0;
  const devGap = devDelta !== null && (devDelta < 0
    || (c.coarse ? Math.abs(devDelta - hostDelta) > 1000 : devDelta > IR_BIAS_GAP));
  c.lastSeq = s.seq; c.lastHost = now; c.lastEpoch = epoch;
  if (seqGap || hostGap || devGap) irBiasSegment(st, '数据不连续，重新采样');
  const row = [s.gx0, s.gy0, s.gz0, s.ax, s.ay, s.az];
  if (!row.every(Number.isFinite) || (s.raw6 && s.raw6.some((v) => !Number.isFinite(v) || Math.abs(v) >= 32767))) {
    irBiasSegment(st, '数据无效或传感器满量程'); return;
  }
  row.push(Math.hypot(s.ax, s.ay, s.az));
  if (Math.abs(row[6] - 1) > IR_BIAS_AERR || row.slice(0, 3).some((v) => Math.abs(v) > IR_BIAS_MAX)) {
    irBiasSegment(st, '加速度或零偏超出校准范围'); return;
  }
  if (c.hostStart === null) c.hostStart = now;
  if (epoch !== null) {
    if (c.devStart === null) c.devStart = epoch;
    if (c.devLast === epoch) c.coarse = true;
    c.devLast = epoch;
  } else c.coarse = true;
  row.push(now);
  c.rows.push(row); b.still = c.rows.length;
  const n = c.rows.length, mu = Array(7).fill(0);
  for (const q of c.rows) for (let k = 0; k < 7; k++) mu[k] += q[k];
  for (let k = 0; k < 7; k++) mu[k] /= n;
  for (let k = 0; k < 6; k++) {
    let variance = 0, lo = Infinity, hi = -Infinity;
    for (const q of c.rows) {
      variance += (q[k] - mu[k]) ** 2;
      lo = Math.min(lo, q[k]); hi = Math.max(hi, q[k]);
    }
    if (Math.sqrt(variance / n) > (k < 3 ? IR_BIAS_GSTD : IR_BIAS_ASTD)
      || hi - lo > (k < 3 ? IR_BIAS_GRANGE : IR_BIAS_ARANGE)) {
      irBiasSegment(st, '检测到变化，重新采样'); return;
    }
  }
  const hostSpan = now - c.hostStart;
  b.status = '校准采样 ' + Math.min(hostSpan / 1000, 3).toFixed(1) + '/3.0 秒 · ' + n + ' 帧';
  if (b.ready) b.status += ' · 保留上次补偿';
  if (hostSpan < IR_BIAS_MS || n < IR_BIAS_MIN
    || (!c.coarse && c.devStart !== null && c.devLast - c.devStart < IR_BIAS_MS)) {
    irBiasText(st); return;
  }
  const firstRows = c.rows.filter((q) => q[7] - c.hostStart <= hostSpan / 3);
  const lastRows = c.rows.filter((q) => q[7] - c.hostStart >= hostSpan * 2 / 3);
  for (let k = 0; k < 3; k++) {
    const first = firstRows.reduce((sum, q) => sum + q[k], 0) / firstRows.length;
    const last = lastRows.reduce((sum, q) => sum + q[k], 0) / lastRows.length;
    if (Math.abs(first - last) > IR_BIAS_DRIFT) {
      irBiasSegment(st, '角速度缓变，重新采样'); return;
    }
  }
  if (Math.abs(mu[6] - 1) > IR_BIAS_AERR || mu.slice(0, 3).some((v) => Math.abs(v) > IR_BIAS_MAX)) {
    irBiasSegment(st, '校准均值超出范围'); return;
  }
  clearTimeout(c.timer);
  b.g = mu.slice(0, 3); b.anchor = b.g.slice(); b.boundary = false;
  b.ready = true; b.collect = null; b.dynamic = null;
  b.status = b.mode === 'dynamic' ? '手动校准成功 · 自动模式继续' : '校准成功，补偿已锁定';
  irBiasText(st);
}

function irBiasReset(st, silent) {
  if (st.bias.collect) clearTimeout(st.bias.collect.timer);
  st.bias = irBiasNew();
  if (!silent && st.foot) log('已清空' + (st.foot === 'r' ? '右' : '左') + '脚的本页零偏补偿，将自动等待静止后重新估计', 'i');
  irBiasText(st);
}

function irBiasText(st) {
  const b = st.bias;
  const el = $('irBias', st.foot);
  if (el) {
    el.textContent = (b.ready ? '(' + b.g.map((v) => v.toFixed(2)).join(', ') + ') °/s · ' : '') + b.status;
    el.title = '仅补偿本页显示与波形，不改设备或导出。网页六轴无法区分恒速转动与常量偏置：' + IR_DYN_NOTE
      + '。未就绪时显示原始角速度，静止后自动生效；初始需静止约5秒，之后每段静止约3秒自动更新。'
      + '重置或重连后重新自动学习；切到手动模式可锁定当前补偿。';
  }
  const mode = $('irBiasMode', st.foot);
  if (mode) mode.value = b.mode;
  const n = $('irStill', st.foot);
  if (n) n.textContent = b.still;
}
