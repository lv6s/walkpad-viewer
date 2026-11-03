/* 维特 WT901 多设备：广播协议、连接、MAC 识别、文本导出。 */

const SERVICE = '0000ffe5-0000-1000-8000-00805f9a34fb';

const CHAR_NOTIFY = '0000ffe4-0000-1000-8000-00805f9a34fb';

const CHAR_WRITE = '0000ffe9-0000-1000-8000-00805f9a34fb';

const REG_MAC = 0x66, REG_BATT = 0x64, REG_VER = 0x2E;

const ACC_S = 16 / 32768, GYR_S = 2000 / 32768, ANG_S = 180 / 32768, MAG_S = 8000 / 32768, Q_S = 1 / 32768;

const FRAME_LEN = { 0x50:11, 0x51:11, 0x52:11, 0x53:11, 0x54:11, 0x55:11, 0x56:11, 0x57:20, 0x58:20, 0x59:20, 0x5A:11, 0x5F:11, 0x61:20, 0x71:20 };

const KEEP_SEC = 40;

                   // 每台按时间保留最近 40 s（与采样率无关）
const PANELS = [
  { key: 'acc', title: '加速度', unit: 'g', floor: 0.5, fmt: 2 },
  { key: 'gyr', title: '角速度', unit: '°/s', floor: 20, fmt: 0 },
  { key: 'ang', title: '角度', unit: '°', floor: 30, fmt: 0 }
];

const LBL_KEY = 'wt901.labels.v2';

const DEVTOK = '@@DEV@@';

/* 官方导出表头（与 WitMotion 上位机导出的 23 列一致） */
const OFFICIAL_HEADER = [
  '时间', '设备名称',
  '加速度X(g)', '加速度Y(g)', '加速度Z(g)',
  '角速度X(°/s)', '角速度Y(°/s)', '角速度Z(°/s)',
  '角度X(°)', '角度Y(°)', '角度Z(°)',
  '磁场X(uT)', '磁场Y(uT)', '磁场Z(uT)',
  '四元数0()', '四元数1()', '四元数2()', '四元数3()',
  '温度(°C)', '高度(m)', '气压(kPa)', '版本号()', '电量(%)'
].join('\t');

function makeDevice(opts) {
  const key = opts.key || ('d' + (++state.demoN) + '_' + Math.random().toString(36).slice(2, 7));
  const labels = loadLabels();
  const saved = labels['id:' + key] || labels[key] || {};
  const idx = state.order.length;
  const d = {
    key, device: opts.device || null, char: null, wchar: null, connected: false, demo: !!opts.demo,
    name: opts.name || 'WT901BLE',
    rawName: (opts.name || 'WT901BLE').replace(/[\t\r\n]/g, ' ').trim() || 'WT901BLE',
    mac: macOf(opts.device), macForms: null, macHex: '',
    batt: null, battRaw: null, ver: '',
    label: saved.label || opts.label || opts.name || 'WT901BLE',
    color: saved.color || DEV_COLORS[idx % DEV_COLORS.length],
    buf: [], samples: [], t0: 0, period: 0.02, lastPkt: 0,
    frames: 0, rate: 0, types: {}, pend: new Map(),
    extra: { temp: null, mag: null, quat: null },
    ymax: { acc: 1, gyr: 20, ang: 60 },
    ui: null, reconnTimer: 0, reconnTry: 0, manual: false
  };
  state.devices.set(key, d);
  state.order.push(key);
  syncGrid();
  return d;
}

/* ---------- 设备卡片 ---------- */
function buildCard(d) {
  const root = document.createElement('div');
  root.className = 'dev';
  root.dataset.k = d.key;
  root.innerHTML =
    '<div class="dh">' +
      '<i class="sw"></i>' +
      '<span class="dn"></span>' +
      '<span class="dx"></span>' +
      '<span class="dm"></span>' +
      '<span class="badge"></span>' +
      '<span class="spacer"></span>' +
      '<button class="mini" data-act="toggle"></button>' +
      '<button class="mini" data-act="info">信息</button>' +
      '<button class="mini" data-act="swapmac" hidden>换序</button>' +
      '<button class="mini" data-act="rename">改名</button>' +
    '</div>' +
    '<div class="dbody">' +
      '<div class="dtop">' +
        '<canvas class="giz"></canvas>' +
        '<div>' +
          '<table class="vals"><thead><tr><th></th><th>X</th><th>Y</th><th>Z</th><th>模</th></tr></thead><tbody>' +
          '<tr><td>加速度 g</td><td data-f="ax">—</td><td data-f="ay">—</td><td data-f="az">—</td><td data-f="am">—</td></tr>' +
          '<tr><td>角速度 °/s</td><td data-f="gx">—</td><td data-f="gy">—</td><td data-f="gz">—</td><td data-f="gm">—</td></tr>' +
          '<tr><td>角度 °</td><td data-f="rx">—</td><td data-f="ry">—</td><td data-f="rz">—</td><td data-f="rm">—</td></tr>' +
          '</tbody></table>' +
          '<div class="sub">' +
            '<span>温度 <b data-f="temp">—</b></span>' +
            '<span>磁场 <b data-f="mag">—</b></span>' +
            '<span>采样率 <b data-f="rate">0</b> Hz</span>' +
            '<span>帧数 <b data-f="nf">0</b></span>' +
            '<span>时长 <b data-f="dur">0.0</b> s</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<canvas class="dchart"></canvas>' +
    '</div>';

  root.querySelector('.sw').style.background = d.color;
  root.querySelector('.dn').textContent = d.label;
  const ui = {
    root,
    meta: root.querySelector('.dm'),
    alias: root.querySelector('.dx'),
    badge: root.querySelector('.badge'),
    tbtn: root.querySelector('[data-act="toggle"]'),
    mbtn: root.querySelector('[data-act="swapmac"]'),
    giz: root.querySelector('.giz'),
    chart: root.querySelector('.dchart'),
    f: {}
  };
  root.querySelectorAll('[data-f]').forEach((el) => { ui.f[el.dataset.f] = el; });
  d.ui = ui;
  updateHead(d);
  return root;
}

function updateHead(d) {
  if (!d.ui) return;
  const on = d.connected || d.demo;
  d.ui.root.classList.toggle('off', !on);
  d.ui.tbtn.textContent = on ? '断开' : '连接';
  d.ui.root.querySelector('.dn').textContent = d.label;
  d.ui.root.querySelector('.sw').style.background = d.color;
  if (d.ui.mbtn) d.ui.mbtn.hidden = !d.macForms;
  const ks = Object.keys(d.types);
  d.ui.badge.textContent = ks.length ? ks.sort().map((k) => k + '×' + d.types[k]).join(' ') : '待数据';
}

function syncGrid() {
  const grid = $('devGrid');
  if (!state.order.length) {
    grid.innerHTML = '<div class="empty">还没有设备。点右上角「添加设备」逐台授权，之后可用「全部重连」一次恢复。</div>';
    return;
  }
  const ph = grid.querySelector('.empty');
  if (ph) ph.remove();
  for (const k of state.order) {
    const d = state.devices.get(k);
    if (!d.ui) grid.append(buildCard(d));
  }
  for (const el of [...grid.children]) {
    if (!state.order.includes(el.dataset.k)) el.remove();
  }
  for (const k of state.order) {
    const d = state.devices.get(k);
    if (d.ui) grid.append(d.ui.root);
  }
  syncNames();
  updateBtns();
}

$('devGrid').onclick = async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const root = e.target.closest('.dev');
  if (!root) return;
  const d = state.devices.get(root.dataset.k);
  if (!d) return;
  const act = btn.dataset.act;
  if (act === 'toggle') {
    if (d.demo) return log('模拟设备不支持手动断开', 'i');
    if (d.connected) { d.manual = true; d.reconnTimer && clearTimeout(d.reconnTimer); d.reconnTimer = 0; d.device && d.device.gatt.connected && d.device.gatt.disconnect(); }
    else { d.manual = false; d.reconnTry = 0; await connectOne(d); }
    return;
  }
  if (act === 'info') {
    if (d.demo) return log('模拟设备没有寄存器可读', 'i');
    if (!d.connected) return log(d.label + ' 未连接，先连上再读信息', 'e');
    probeInfo(d, true);
    return;
  }
  if (act === 'swapmac') {
    d.macOrder = nextMacOrder(d.macOrder);
    setMac(d, d.macBytes);
    log(d.label + ' MAC 字节序改为 ' + d.macOrder + ' → ' + (d.mac || '（无效）') +
      '；要与官方软件显示的一致，直接按「信息」重读也可', 'i');
    return;
  }
  if (act === 'rename') {
    const v = prompt('页面显示名称（只影响这里的卡片和图例；导出文件仍写设备原始广播名 ' + d.rawName + '）', d.label);
    if (v == null) return;
    d.label = v.trim().replace(/[\t\r\n]/g, ' ') || d.label;
    rememberLabel(labelKey(d), d.label);
    updateHead(d);
    syncNames();
    renderLegend();
  }
};

function onlineCount() {
  let n = 0;
  for (const d of state.devices.values()) if (d.connected || d.demo) n++;
  return n;
}

function updateBtns() {
  const on = onlineCount() + (irOnOf('l') ? 1 : 0) + (irOnOf('r') ? 1 : 0);
  $('btnDropAll').disabled = on === 0;
  $('btnRec').disabled = on === 0 && !state.recording;
  $('btnTxt').disabled = state.rec.length === 0;
  $('btnCsv').disabled = state.rec.length === 0;
  let has = 0;
  for (const d of state.devices.values()) if (d.samples.length || d.frames) has++;
  for (const f of IR_SIDES) if (irStates[f].samples.length || irStates[f].frames || irStates[f].rec.length) has++;
  $('btnClear').disabled = state.recording || (on === 0 && !has);
}

/* 清空实时缓冲：接收阶段（未记录）随时可用；记录中直接禁用，避免误删正在采的数据。
   两只脚一起清；零偏是跟着旧数据估出来的，一并重置，免得污染下一轮 */
function clearData() {
  if (state.recording) return;
  const rows = state.rec.length;
  const nL = irStates.l.rec.length, nR = irStates.r.rec.length;
  const irRows = nL + nR;
  const what = [];
  if (rows) what.push('WT901 ' + rows + ' 行');
  if (irRows) what.push('鞋垫 ' + irRows + ' 帧（左 ' + nL + ' / 右 ' + nR + '）');
  let dropRec = true;
  if (what.length) {
    dropRec = confirm('同时丢弃已录的 ' + what.join('、') + '？\n\n'
      + '确定 = 实时数据和已录数据都清空\n'
      + '取消 = 只清实时数据、波形与零偏，已录数据保留用于导出');
  }
  if (dropRec) {
    state.rec = [];
    for (const f of IR_SIDES) irStates[f].rec = [];
  }
  for (const d of state.devices.values()) {
    d.samples.length = 0;
    d.frames = 0; d.rate = 0; d.types = {};
    d.ymax = { acc: 1, gyr: 20, ang: 60 };
    d.extra = { temp: null, mag: null, quat: null };
    if (!d.ui) continue;
    for (const k of ['ax', 'ay', 'az', 'am', 'gx', 'gy', 'gz', 'gm', 'rx', 'ry', 'rz', 'rm']) {
      if (d.ui.f[k]) d.ui.f[k].textContent = '—';
    }
    if (d.ui.f.temp) d.ui.f.temp.textContent = '—';
    if (d.ui.f.mag) d.ui.f.mag.textContent = '—';
    if (d.ui.f.rate) d.ui.f.rate.textContent = '0';
    if (d.ui.f.nf) d.ui.f.nf.textContent = '0';
    if (d.ui.f.dur) d.ui.f.dur.textContent = '0.0';
    drawGizmo(d.ui.giz, null);
    drawDeviceChart(d);
    updateHead(d);
  }
  state.T0 = 0;                       // 时间零点重建，清空后曲线从 0 s 开始
  state.tEnd = 0;
  for (const f of IR_SIDES) {
    const st = irStates[f];
    st.buf = new Uint8Array(0);
    st.samples.length = 0; st.last = null; st.t0 = 0; st.frames = 0; st.bad = 0; st.rate = 0;
    st.ymax = { a: 1, g: 60 };
    st.slots.fill(0);
    irBiasReset(st, true);
    prReset(f);
    withFoot(f, () => { irNums(null); irDraw(); irPressDraw(); prNums(); pwDraw(); });
  }
  $('recStat').textContent = state.rec.length ? ('上次记录 ' + state.rec.length + ' 行，可导出') : '未记录';
  log('已清空实时数据、波形与零偏估计' + (what.length
    ? '，' + (dropRec ? '丢弃 ' : '保留 ') + what.join('、') + (dropRec ? '' : ' 用于导出')
    : ''), 'i');
  irHead();
}

/* ---------- 解帧（每台独立缓冲） ---------- */
const s16 = (a, i) => { const v = (a[i] | (a[i + 1] << 8)); return v & 0x8000 ? v - 0x10000 : v; };

function parse(d, dv) {
  for (let i = 0; i < dv.byteLength; i++) d.buf.push(dv.getUint8(i));
  const out = [];
  for (;;) {
    const i0 = d.buf.indexOf(0x55);
    if (i0 < 0) { d.buf.length = 0; return out; }
    if (i0 > 0) d.buf.splice(0, i0);
    if (d.buf.length < 2) return out;
    const len = FRAME_LEN[d.buf[1]];
    if (!len) { d.buf.shift(); continue; }          // 未知帧型：只丢帧头重新同步
    if (d.buf.length < len) return out;
    const f = d.buf.slice(0, len), t = f[1];
    /* 读寄存器的回包：正常是 55 71，个别固件回 55 61（与打包数据帧同长度、同帧头），
       只在刚发过读取、且第二字节对得上时才当回包，避免误吃数据帧 */
    if ((t === 0x71 || t === 0x61) && len === 20) {
      const reg = f[2] | (f[3] << 8);
      const t0 = d.pend.get(reg);
      if (t === 0x71 || (t0 && performance.now() - t0 < 1500)) {
        d.pend.delete(reg);
        d.buf.splice(0, len);
        regReply(d, reg, f, 4);
        continue;
      }
    }
    const tk = '0x' + t.toString(16).padStart(2, '0');
    d.types[tk] = (d.types[tk] || 0) + 1;
    if (t === 0x61 && len === 20) {
      out.push({
        acc: [s16(f, 2) * ACC_S, s16(f, 4) * ACC_S, s16(f, 6) * ACC_S],
        gyr: [s16(f, 8) * GYR_S, s16(f, 10) * GYR_S, s16(f, 12) * GYR_S],
        ang: [s16(f, 14) * ANG_S, s16(f, 16) * ANG_S, s16(f, 18) * ANG_S]
      });
    } else if (t === 0x51) {
      d.extra.temp = s16(f, 8) / 100;
      out.push({ acc: [s16(f, 2) * ACC_S, s16(f, 4) * ACC_S, s16(f, 6) * ACC_S] });
    } else if (t === 0x52) {
      d.extra.temp = s16(f, 8) / 100;
      out.push({ gyr: [s16(f, 2) * GYR_S, s16(f, 4) * GYR_S, s16(f, 6) * GYR_S] });
    } else if (t === 0x53) {
      out.push({ ang: [s16(f, 2) * ANG_S, s16(f, 4) * ANG_S, s16(f, 6) * ANG_S] });
    } else if (t === 0x54) {
      d.extra.mag = [s16(f, 2) * MAG_S, s16(f, 4) * MAG_S, s16(f, 6) * MAG_S];
    } else if (t === 0x59 && len === 20) {
      const q = [s16(f, 2) * Q_S, s16(f, 4) * Q_S, s16(f, 6) * Q_S, s16(f, 8) * Q_S];
      if (q.some((v) => v !== 0)) d.extra.quat = q;
    }
    d.buf.splice(0, len);
  }
}

/* 一个 BLE 包常含 2 帧，按估计周期把包内各帧时间摊开，避免两条记录时间戳完全相同 */
function onPacket(d, dv) {
  const tArr = performance.now() / 1000;
  const frames = parse(d, dv);
  if (!frames.length) return;
  if (!state.T0) state.T0 = tArr;          // 全局零点：全场第一帧
  if (d.lastPkt) {
    const gap = tArr - d.lastPkt;
    if (gap > 0 && gap < 0.5) {
      d.period = Math.min(0.1, Math.max(0.002, 0.8 * d.period + 0.2 * gap / frames.length));
    }
  }
  d.lastPkt = tArr;
  frames.forEach((f, i) => push(d, tArr - (frames.length - 1 - i) * d.period, f));
}

function officialLine(d, tAbsPerf, s) {
  const a = s.acc || [null, null, null], g = s.gyr || [null, null, null], n = s.ang || [null, null, null];
  const m = d.extra.mag || [null, null, null], q = d.extra.quat;
  const wall = CLOCK.wall0 + (tAbsPerf * 1000 - CLOCK.perf0);
  return isoLocal(wall) + '\t' + DEVTOK + '\t' +
    num(a[0], 3) + '\t' + num(a[1], 3) + '\t' + num(a[2], 3) + '\t' +
    num(g[0], 3) + '\t' + num(g[1], 3) + '\t' + num(g[2], 3) + '\t' +
    num(n[0], 2) + '\t' + num(n[1], 2) + '\t' + num(n[2], 2) + '\t' +
    num(m[0], 2) + '\t' + num(m[1], 2) + '\t' + num(m[2], 2) + '\t' +
    num(q && q[0], 5) + '\t' + num(q && q[1], 5) + '\t' + num(q && q[2], 5) + '\t' + num(q && q[3], 5) + '\t' +
    num(d.extra.temp, 2) + '\t' + 'null' + '\t' + 'null' + '\t' +
    (d.ver || 'null') + '\t' + (d.batt == null ? 'null' : d.batt);
}

function push(d, tAbs, f) {
  const prev = d.samples[d.samples.length - 1];
  let t = tAbs - state.T0;
  if (prev && t <= prev.t) t = prev.t + 0.0005;
  const s = prev ? Object.assign({}, prev, { t }) : { t, acc: null, gyr: null, ang: null };
  if (f.acc) s.acc = f.acc;
  if (f.gyr) s.gyr = f.gyr;
  if (f.ang) s.ang = f.ang;
  d.samples.push(s);
  d.frames++;
  if (state.recording) state.rec.push({ t, k: d.key, line: officialLine(d, tAbs, s) });
  /* 按时间裁缓冲：一次丢掉 2 s 以上的陈旧头部，避免每帧搬数组；
     用时间而不是固定条数，150 Hz 下也能撑满 30 s 窗口 */
  if (d.samples[0] && t - d.samples[0].t > KEEP_SEC + 2) {
    let cut = 0;
    while (cut < d.samples.length - 1 && t - d.samples[cut].t > KEEP_SEC) cut++;
    if (cut > 0) d.samples.splice(0, cut);
  }
}

/* ---------- 连接 ---------- */
function bindDisc(d) {
  if (d._discBound || !d.device) return;
  d._discBound = true;
  d.device.addEventListener('gattserverdisconnected', () => onDisc(d));
}

async function connectOne(d) {
  if (!d.device || d.demo) return;
  try {
    if (d.device.gatt.connected) return;
    const server = await d.device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    const ch = await svc.getCharacteristic(CHAR_NOTIFY);
    ch.addEventListener('characteristicvaluechanged', (ev) => onPacket(d, ev.target.value));
    await ch.startNotifications();
    d.char = ch;
    try { d.wchar = await svc.getCharacteristic(CHAR_WRITE); } catch (e) { d.wchar = null; }
    d.connected = true;
    d.manual = false;
    d.buf.length = 0;
    d.reconnTry = 0;
    updateHead(d);
    updateBtns();
    log('已连接 ' + d.label + '，正在读设备信息…', 'i');
    readGapName(d);
    probeInfo(d, false);
  } catch (e) {
    d.connected = false;
    updateHead(d);
    log(d.label + ' 连接失败：' + (e.message || e), 'e');
  }
}

$('btnAdd').onclick = async () => {
  if (!navigator.bluetooth) return log('此浏览器不支持 Web Bluetooth，请用 Chrome 或 Edge', 'e');
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'WT' }, { namePrefix: 'JY' }, { namePrefix: 'BWT' },
        { namePrefix: 'IMU' }, { namePrefix: 'W0' }, { namePrefix: 'D56' }],
      optionalServices: [SERVICE, U16('180d'), U16('180a'), U16('180f')]
    });
  } catch (e) {
    if (e.name !== 'NotFoundError') log('添加设备未完成：' + (e.message || e), 'e');
    return;
  }
  if (isImurDev(device)) {                      // 自研 IMU-R 走另一条协议，切到它自己的页
    setMode('imur', true);
    return irConnect(device);
  }
  try {
    let d = null;
    for (const x of state.devices.values()) if (x.device && x.device.id === device.id) d = x;
    if (!d) d = makeDevice({ key: device.id, device, name: device.name || 'WT901BLE' });
    bindDisc(d);
    await connectOne(d);
  } catch (e) {
    if (e.name !== 'NotFoundError') log('添加设备未完成：' + (e.message || e), 'e');
  }
};

$('btnReconn').onclick = async () => {
  const list = [];
  for (const k of state.order) {
    const d = state.devices.get(k);
    if (d && d.device && !d.connected) { d.manual = false; list.push(d); }
  }
  if (!list.length) {
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return log('未连接设备，且此浏览器不支持记忆设备，请用「添加设备」', 'e');
    let known = [];
    try { known = await navigator.bluetooth.getDevices(); } catch (e) { return log('读取已授权设备失败：' + (e.message || e), 'e'); }
    let skipImur = 0;
    for (const device of known) {
      if (isImurDev(device)) { skipImur++; continue; }   // 自研设备不按 WT901 协议连
      let d = null;
      for (const x of state.devices.values()) if (x.device && x.device.id === device.id) d = x;
      if (!d) d = makeDevice({ key: device.id, device, name: device.name || 'WT901BLE' });
      bindDisc(d);
      d.manual = false;
      list.push(d);
    }
    if (!list.length) {
      return log(skipImur
        ? '只记忆到 IMU-R（它不按 WT901 协议连）：切到「IMU-R」页点「连接」'
        : '没有记忆到已授权设备，请先「添加设备」授权一次', 'i');
    }
    if (skipImur && !irOn()) log('IMU-R 不参与这里重连：切到「IMU-R」页点「连接」，或在「添加设备」里直接选它', 'i');
  }
  log('正在重连 ' + list.length + ' 台…', 'i');
  await Promise.all(list.map((d) => connectOne(d)));
};

$('btnClear').onclick = clearData;

$('btnDropAll').onclick = () => {
  for (const d of state.devices.values()) {
    d.manual = true;
    if (d.reconnTimer) { clearTimeout(d.reconnTimer); d.reconnTimer = 0; }
    if (d.device && d.device.gatt.connected) d.device.gatt.disconnect();
  }
};

function onDisc(d) {
  d.connected = false;
  updateHead(d);
  updateBtns();
  log(d.label + ' 断开（超范围 / 休眠 / 手动）', 'e');
  if (state.recording) log('注意：' + d.label + ' 断开期间该设备的记录会出现空档', 'w');
  if (state.recording && onlineCount() === 0) stopRec();
  if (d.manual || d.demo || !d.device) return;
  autoReconnect(d);
}

/* 掉线自动重连：1.5 s 起，逐次拉长，最多 6 次 */
function autoReconnect(d) {
  if (d.reconnTimer || d.reconnTry >= 6) return;
  const wait = Math.min(15000, 1500 * Math.pow(1.7, d.reconnTry));
  d.reconnTry++;
  d.reconnTimer = setTimeout(async () => {
    d.reconnTimer = 0;
    if (d.connected || d.manual) return;
    log('重连 ' + d.label + '（第 ' + d.reconnTry + ' 次）…', 'w');
    await connectOne(d);
    if (!d.connected) autoReconnect(d);
    else log(d.label + ' 已恢复', 'i');
  }, wait);
}

/* ---------- 记录 ---------- */
async function toggleRec() {
  if (state.recording) return stopRec();
  state.recording = true;
  REC_T0 = performance.now();
  FR_DATASET_ID = frUid();
  FR_SESSION_ID = frUid();
  for (const f of IR_SIDES) irStates[f].slots.fill(0);
  state.rec = [];
  /* 两脚各自录一份：只录当前活动脚会漏掉另一只，合并导出就缺一半 */
  let recAny = false;
  for (const f of IR_SIDES) {
    irStates[f].rec = [];
    irStates[f].recording = irOnOf(f);
    if (irStates[f].recording) recAny = true;
  }
  state.recT0Wall = Date.now();
  $('btnRec').textContent = '■ 停止记录';
  $('btnRec').classList.add('on');
  $('btnTxt').disabled = true;
  $('btnCsv').disabled = true;
  irHead();   // 「下载 parquet」的可用态只在 irHead 里算，记录状态一变就要来刷
  requestWake(true);
  const recFeet = IR_SIDES.filter((f) => irStates[f].recording)
    .map((f) => (f === 'r' ? '右' : '左')).join('+');
  log('开始记录（统一时间轴，' + onlineCount() + ' 台'
    + (recAny ? ' + 鞋垫 ' + recFeet : '') + '）', 'i');
  if ($('camLink').checked && cam.stream && !cam.rec) camStartRec(true);
}

function stopRec() {
  if (!state.recording) return;
  state.recording = false;
  $('btnRec').textContent = '● 开始记录';
  $('btnRec').classList.remove('on');
  updateBtns();
  requestWake(false);
  if (cam.auto && cam.rec) camStopRec();      // 只停跟随记录起的那次录像，手动开的视频不动
  for (const f of IR_SIDES) irStates[f].recording = false;
  irHead();   // 停止后立刻让「下载 parquet」变可点，与下面的提示同时成立
  log('停止记录，共 ' + state.rec.length + ' 行，时长 ' + ((Date.now() - state.recT0Wall) / 1000).toFixed(1) + ' s', 'i');
  const nL = irStates.l.rec.length, nR = irStates.r.rec.length;
  if (nL || nR) log('鞋垫帧：左 ' + nL + ' / 右 ' + nR + '，点「下载 parquet」导出（两脚合一份）', 'i');
  updateBtns();
}

$('btnRec').onclick = toggleRec;

/* 记录时保持屏幕常亮，避免系统休眠把 BLE 掐断 */
async function requestWake(on) {
  try {
    if (on) {
      if (!state.wakeLock && navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen');
    } else if (state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch (e) { /* 不支持或被拒绝都不影响采集 */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.recording) requestWake(true);
});

/* 浏览器给的 device.id 是匿名化标识（Chromium 默认每次会话重新生成），不是蓝牙地址；
   某些平台/旧版本恰好给的是 MAC，能认出来就用，否则靠下面读寄存器 0x66。 */
function macOf(dev) {
  if (!dev || !dev.id) return '';
  let s = String(dev.id).toUpperCase();
  const m = s.match(/([0-9A-F]{2}[:-]){5}[0-9A-F]{2}/);
  if (m) return m[0].replace(/-/g, ':');
  s = s.replace(/[{}]/g, '').trim();
  if (/^[0-9A-F]{12}$/.test(s)) return s.match(/.{2}/g).join(':');
  return '';
}

/* ---------- 设备信息：MAC / 电量 / 固件 ---------- */
const MAC_ORDERS = ['asis', 'swap', 'rev'];

const MAC_ORDER_KEY = 'wt901.macorder';

function macOrder() {
  try { return localStorage.getItem(MAC_ORDER_KEY) || 'asis'; } catch { return 'asis'; }
}

function nextMacOrder(cur) {
  const i = MAC_ORDERS.indexOf(cur || macOrder());
  const o = MAC_ORDERS[(i + 1) % MAC_ORDERS.length];
  try { localStorage.setItem(MAC_ORDER_KEY, o); } catch {}
  return o;
}

/* 寄存器回传是 8 个 uint16（低字节在前）；MAC 取前 6 字节，本机固件按字节数组顺序直出，
   个别固件按 16 位字打包（成对交换），所以留一个换序开关兜底。 */
function setMac(d, bytes) {
  if (!bytes || bytes.length < 6) return;
  d.macBytes = bytes.slice(0, 16);
  if (d.macBytes.slice(0, 6).every((v) => v === 0)) {
    d.macForms = null;
    if (d.macManual) return;                 // 手工填过就不让空回包冲掉
    d.mac = '';
    d.macHex = hexOf(d.macBytes);
    return;
  }
  const pick = (o) => o.map((i) => hex2(bytes[i])).join(':');
  d.macForms = { asis: pick([0, 1, 2, 3, 4, 5]), swap: pick([1, 0, 3, 2, 5, 4]), rev: pick([5, 4, 3, 2, 1, 0]) };
  d.macOrder = d.macOrder || macOrder();
  d.mac = d.macForms[d.macOrder] || d.macForms.asis;
  d.macHex = hexOf(d.macBytes);
  const dup = [...state.devices.values()].filter((x) => x !== d && x.mac === d.mac);
  if (dup.length) log(d.label + ' 和 ' + dup.map((x) => x.label).join('、') + ' 是同一台设备（MAC 相同），留一张卡就够', 'e');
  d.ui && updateHead(d);
  applySavedLabel(d);
  syncNames();
}

/* 改过的显示名按 MAC 记住，换一台电脑/换一次浏览器授权也能认回来 */
function applySavedLabel(d) {
  if (!d.mac) return;
  const sv = loadLabels()['mac:' + d.mac];
  if (sv && sv.label && sv.label !== d.label) {
    d.label = sv.label;
    d.ui && updateHead(d);
    renderLegend();
  }
}

/* 兜底：固件不回 0x66 时，从官方软件抄一个填进来，导出照样带 MAC */
function setMacManual(d, text) {
  const s = String(text || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (s.length !== 12) return false;
  d.mac = s.match(/.{2}/g).join(':');
  d.macManual = true;
  d.macForms = null;
  d.macHex = '';
  d.ui && updateHead(d);
  applySavedLabel(d);
  syncNames();
  return true;
}

function battPct(raw) {
  if (raw > 800) return 100;                     // 高量程固件（如 840）
  const T = [[396, 100], [393, 90], [387, 75], [382, 60], [379, 50], [377, 40], [373, 30], [370, 20], [368, 15], [350, 10], [340, 5]];
  for (const [th, p] of T) if (raw >= th) return p;
  return 0;
}

/* 55 71（部分固件回 55 61）+ 寄存器号 + 16 字节 */
function regReply(d, reg, f, off) {
  const b = [];
  for (let i = 0; i < 16 && off + i < f.length; i++) b.push(f[off + i]);
  const w = (i) => b[i] | (b[i + 1] << 8);
  if (reg === REG_MAC) setMac(d, b);
  else if (reg === REG_BATT) { d.battRaw = w(0); d.batt = battPct(d.battRaw); syncNames(); }
  else if (reg === REG_VER) { d.ver = [w(0), w(2), w(4)].join('.'); syncNames(); }
  d.lastReg = '0x' + reg.toString(16) + ' ← ' + hexOf(b);
}

async function readReg(d, reg) {
  if (!d.wchar) return false;
  d.pend.set(reg, performance.now());
  const cmd = new Uint8Array([0xFF, 0xAA, 0x27, reg, 0x00]);
  try {
    await d.wchar.writeValueWithoutResponse(cmd);
    return true;
  } catch (e1) {
    try { await d.wchar.writeValue(cmd); return true; }
    catch (e2) { d.pend.delete(reg); return false; }
  }
}

/* 广播包放不下完整名字时 Windows 只报 8 个字符（WT901BLE），官方软件用的是连上后读的
   GAP 设备名（WT901BLE67）；浏览器若屏蔽 generic_access 就读不到，沿用广播名。 */
async function readGapName(d) {
  try {
    const svc = await d.device.gatt.getPrimaryService('generic_access');
    const ch = await svc.getCharacteristic('gap.device_name');
    const v = await ch.readValue();
    const n = new TextDecoder().decode(v).replace(/[\t\r\n\0]/g, ' ').trim();
    if (!n || n === d.rawName) return;
    log(d.label + ' 设备名（GAP）= ' + n + '；广播名是 ' + d.rawName + '，导出用 GAP 的', 'i');
    d.rawName = n;
    syncNames();
  } catch (e) { /* 拿不到就用广播名 */ }
}

/* 连上后读一次：MAC / 电量 / 固件版本（官方导出就是这三项非空） */
async function probeInfo(d, manual) {
  if (d.demo || !d.connected) return;
  if (!d.wchar) return manual && log(d.label + ' 没拿到写入通道，读不了设备信息', 'e');
  d.pend.clear();
  const sent = [];
  for (const reg of [REG_MAC, REG_BATT, REG_VER]) {
    if (await readReg(d, reg)) sent.push('0x' + reg.toString(16));
    await new Promise((r) => setTimeout(r, 170));
  }
  if (!sent.length) return manual && log(d.label + ' 读寄存器指令发送失败', 'e');
  setTimeout(() => {
    const bits = [];
    bits.push(d.mac ? 'MAC=' + d.mac : 'MAC 未返回');
    if (d.batt != null) bits.push('电量=' + d.batt + '%');
    if (d.ver) bits.push('固件=' + d.ver);
    if (d.lastReg) bits.push('末条 ' + d.lastReg);
    log(d.label + ' ' + bits.join('　'), d.mac ? 'i' : 'e');
    if (!d.mac) log('　设备没回 MAC（0x66 全 0 或回包不是 55 71/55 61）：点卡片「信息」重试', 'e');
    updateHead(d); syncNames();
    if (manual && !d.mac) {
      const v = prompt('设备没返回 MAC。可从官方软件里抄一个填进来（如 C2:49:5B:5E:C6:79），留空跳过：', '');
      if (v && setMacManual(d, v)) log(d.label + ' 已手工填入 MAC=' + d.mac, 'i');
      else if (v) log('MAC 格式不对（要 12 位十六进制）', 'e');
    }
  }, 900);
}

/* 导出用设备名：设备原始广播名 + (MAC)，与官方格式一致；页面上的自定义名只用于显示 */
function exportNames() {
  const map = new Map(), seen = new Map();
  for (const k of state.order) {
    const d = state.devices.get(k);
    const raw = ((d && d.rawName) || 'WT901BLE').replace(/[\t\r\n]/g, ' ').trim() || 'WT901BLE';
    const mac = (d && d.mac) || '';
    const base = mac ? raw + '(' + mac + ')' : raw;
    const c = (seen.get(base) || 0) + 1;
    seen.set(base, c);
    map.set(k, c > 1 ? base + '#' + c : base);
  }
  return map;
}

function labelKey(d) {
  if (d.mac) return 'mac:' + d.mac;
  return d.device && d.device.id ? 'id:' + d.device.id : 'key:' + d.key;
}

/* 卡片副标题：MAC · 电量（就是导出文件「设备名称」列里的那个 MAC） */
function syncNames() {
  const names = exportNames();
  for (const k of state.order) {
    const d = state.devices.get(k);
    if (!d || !d.ui || !d.ui.alias) continue;
    const n = names.get(k) || d.rawName;
    const bits = [];
    if (d.mac) bits.push(d.mac);
    if (d.batt != null) bits.push(d.batt + '%');
    if (d.ver) bits.push('v' + d.ver);
    d.ui.alias.textContent = bits.length ? bits.join(' · ') : (n === d.label ? '' : n);
    d.ui.alias.title = '导出文件「设备名称」列写：' + n;
  }
}

function buildTxt() {
  const names = exportNames();
  const rows = state.rec.slice().sort((a, b) => a.t - b.t);
  const parts = [OFFICIAL_HEADER + '\r\n'];
  let buf = [];
  for (const r of rows) {
    buf.push(r.line.replace(DEVTOK, names.get(r.k) || 'WT901BLE'));
    if (buf.length >= 20000) { parts.push(buf.join('\r\n') + '\r\n'); buf = []; }
  }
  if (buf.length) parts.push(buf.join('\r\n') + '\r\n');
  return parts;
}

$('btnTxt').onclick = () => {
  const rows = state.rec.length;
  download(buildTxt(), 'text/plain;charset=utf-8', stampName(new Date()) + '.txt');
  const names = [...exportNames().values()].join('、');
  log('已导出官方格式 ' + rows + ' 行（' + state.devices.size + ' 台合并）设备名：' + names, 'i');
};

$('btnCsv').onclick = () => {
  const names = exportNames();
  const f = (v, dec) => (v === null || v === undefined || !isFinite(v)) ? '' : v.toFixed(dec === undefined ? 4 : dec);
  const rows = state.rec.slice().sort((a, b) => a.t - b.t);
  const head = 'device,time_iso,t_s,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,roll_deg,pitch_deg,yaw_deg';
  const lines = ['\ufeff' + head];
  for (const r of rows) {
    const c = r.line.split('\t');
    lines.push([names.get(r.k) || 'WT901BLE', c[0], r.t.toFixed(4), c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10]].join(','));
  }
  download([lines.join('\r\n')], 'text/csv;charset=utf-8', stampName(new Date()) + '.csv');
  log('已导出 ' + rows.length + ' 行 CSV', 'i');
};
