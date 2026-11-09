/* 状态推断（walk / run / other）：页面只负责采集、调度和显示。
   模型与预处理都在本地服务里跑（activity/act_imu_v1.onnx + act_engine.py），
   页面不做任何轴变换 —— 口径只留一处，否则两边一起改错还互相对不上。

   送出去的是 ax,ay,az 与 gx,gy,gz，其中角速度用本页零偏估计扣过的值。实测零偏
   可达 18 °/s，叠加后会把 other 大量判成 walk，扣掉才回到训练分布；但估计没就绪
   时 gx 等于原始值，此时送出去等于静默出错，所以未就绪一律不记账。 */

const ACT_CLASSES = ['walk', 'run', 'other'];
const ACT_TEXT = { walk: '步行', run: '跑步', other: '其他' };
const ACT_COLOR = { walk: '#1971c2', run: '#e8590c', other: '#adb5bd' };
const ACT_STEP_MS = 200;
const ACT_BUFFER_MS = 150;
const ACT_HIST_N = 60;
/* 单脚最多攒 700 帧（约 13 s）：服务端卡住时不能无限吃内存 */
const ACT_BUF_MAX = 700;
/* 零偏被重新初始化的跳变阈值（°/s）。动态估计就绪后是慢跟随，远低于此值 */
const ACT_BIAS_JUMP = 3;

const ACT_REASON = {
  cold_start: '历史不足 2 秒',
  no_data: '还没有 IMU 数据',
  missing_foot: '缺一只脚的数据',
  stream_gap: '缺口超过容忍范围，等待窗口恢复',
  loss_budget: '有效采样不足或补点过多，等待恢复',
  suspect_stale: '疑似六轴停更，等待新鲜数据',
  order: '事件时间倒退',
  bad_values: '出现非有限数值',
  bad_request: '请求格式不对',
  too_many_events: '单次事件过多',
  bad_time: '决策时间非法'
};

const act = {
  on: false, inflight: false, last: null, info: null, err: '', source: 'insole',
  wtKeys: { l: '', r: '' }, wtSignature: '',
  hist: [], buf: { l: [], r: [] },
  bias: { l: null, r: null }, waitBias: { l: 0, r: 0 },
  steps: 0, valid: 0, sent: 0, drop: 0,
  fsL: 51.2, fsR: 51.2, lastEnd: null, t0: 0, generation: 0,
  segment: { l: 0, r: 0 }, lastClock: { l: null, r: null }, clockBad: { l: false, r: false }
};

/* 两脚都拿到零偏估计才允许决策：单脚缺估计时窗内会混进带偏数据 */
function actBiasReady() {
  if (act.source === 'wt') return ['l', 'r'].every(f => {
    const d = state.devices.get(act.wtKeys[f]);
    return d && d.connected && !d.demo;
  });
  for (const f of ['l', 'r']) {
    const st = irStates[f];
    if (!st || !st.dev || !st.bias || !st.bias.ready) return false;
  }
  return true;
}

async function actPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ source: act.source }, body || {}))
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new Error((data && (data.detail || data.reason)) || ('HTTP ' + res.status));
  return data;
}

/* 模型信息：启动时读一次，页面就知道服务端到底装的是哪份权重、什么轴向 */
async function actInfo() {
  try {
    act.info = await actPost('/act/info', {});
    const sha = (act.info.onnx_sha256 || '').slice(0, 12);
    $('actModel').textContent = '模型 ' + sha + ' · opset ' + (act.info.opset || '?');
    $('actAxis').textContent = '输入口径：' + act.info.axis_label +
      '；单位 g / °·s⁻¹；' + (act.info.gyro_label || '角速度扣本页零偏估计') +
      '；窗口 2 s（' + act.info.window_samples + ' 点 @ ' +
      act.info.fs_out + ' Hz），每 ' + Math.round(act.info.step_s * 1000) + ' ms 一次决策；' +
      (act.source === 'wt'
        ? 'WT接收时钟：缓冲150 ms，包内分摊；跨度≤80 ms、密度≥80%。无硬件时间戳／缺帧计数，双脚同步为估计。三分类为试用候选。'
        : '在线线性 v2：缓冲150 ms，跨度≤80 ms／连续缺≤3帧，补点覆盖≤30%，有效密度≥80%。');
  } catch (e) {
    act.info = null;
    $('actModel').textContent = '推断服务不可用';
    $('actAxis').textContent = '本地推断服务未就绪：' + e.message +
      '（需要 python 环境里有 onnxruntime，且 activity/ 下的模型文件完整）';
  }
  actRender();
}

async function actStart() {
  if (act.on || act.inflight) return;
  const expected = act.source === 'wt' ? 'activity-wt-receipt-v1' : 'activity-online-linear-v2';
  if (!act.info || !act.info.online_policy || act.info.online_policy.version !== expected) {
    act.err = '请关闭旧服务窗口，重新打开IMU页面以加载在线插值v2';
    actRender();
    return;
  }
  const rate = (id, def) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  if (act.source === 'wt') {
    act.wtKeys = { l: $('actWtL').value, r: $('actWtR').value };
    if (!act.wtKeys.l || !act.wtKeys.r || act.wtKeys.l === act.wtKeys.r || !actBiasReady()) {
      act.err = '请先添加并连接两台WT设备，明确选择不同的左脚和右脚';
      actRender(); return;
    }
  }
  act.fsL = rate('actFsL', 51.2);
  act.fsR = rate('actFsR', 51.2);
  $('btnActOn').disabled = true;
  try {
    await actPost('/act/reset', { fs_left: act.fsL, fs_right: act.fsR, mode: 'online-v2' });
    act.generation++;
    act.on = true; act.last = null; act.err = ''; act.hist = [];
    act.steps = 0; act.valid = 0; act.sent = 0; act.drop = 0;
    act.lastEnd = null; act.t0 = performance.now();
    act.segment = { l: 0, r: 0 }; act.lastClock = { l: null, r: null };
    act.clockBad = { l: false, r: false };
    act.buf.l.length = 0; act.buf.r.length = 0;
    act.bias.l = null; act.bias.r = null;
    act.waitBias.l = 0; act.waitBias.r = 0;
    log('状态推断已开始（声明采样率 左 ' + act.fsL + ' / 右 ' + act.fsR + ' Hz）', 'i');
  } catch (e) {
    act.err = e.message;
    log('状态推断启动失败：' + e.message, 'e');
  }
  actRender();
}

function actStop(reason) {
  if (!act.on) return;
  act.on = false;
  act.generation++;
  act.buf.l.length = 0; act.buf.r.length = 0;
  act.bias.l = null; act.bias.r = null;
  if (reason) log('状态推断已停止：' + reason, 'w');
  actRender();
}

/* irFrame 每收一帧调一次；只在推断开着时记账 */
function actFeed(st, s) {
  if (!act.on || act.source !== 'insole' || !s) return;
  const f = st.foot;
  if (!['l', 'r'].includes(f)) return;
  if (!s.clk || !Number.isFinite(s.clk.epoch) || !Number.isInteger(s.seq) ||
      !Number.isFinite(s.receiptPerf)) {
    act.clockBad[f] = true;
    return;
  }
  act.clockBad[f] = false;
  /* 未就绪时 st.bias.g 是 [0,0,0]，gx 就是原始值：送出去等于把实测 -18 °/s 的偏置
     直接喂给模型，会把 other 判成 walk 且不报错。宁可等它收敛（约 5 s 静立）。 */
  const bg = st.bias && st.bias.ready ? st.bias.g : null;
  if (!bg) {
    if (act.bias[f]) {
      act.segment[f]++;
      act.buf[f].length = 0;
      act.bias[f] = null;
    }
    act.waitBias[f]++;
    return;
  }
  const prev = act.bias[f];
  if (prev && Math.hypot(bg[0] - prev[0], bg[1] - prev[1], bg[2] - prev[2]) > ACT_BIAS_JUMP) {
    /* 零偏被重新初始化：窗内前后不属于同一个输入域，整窗作废重攒 */
    act.buf[f].length = 0;
    act.segment[f]++;
    log('零偏估计已重置，重新积累窗口', 'i');
  }
  act.bias[f] = [bg[0], bg[1], bg[2]];
  const prevClock = act.lastClock[f];
  const conn = String(st.capI);
  if (prevClock && (conn !== prevClock.conn ||
      (s.clk.epoch - prevClock.d) - (s.receiptPerf - prevClock.rx) > 2000)) {
    act.segment[f]++;
    act.buf[f].length = 0;
  }
  act.lastClock[f] = { conn, d: s.clk.epoch, rx: s.receiptPerf };
  const b = act.buf[f];
  b.push({ foot: f, device_ms: s.clk.epoch, receipt_ms: s.receiptPerf, seq: s.seq,
    segment: conn + ':' + act.segment[f],
    values: [s.ax, s.ay, s.az, s.gx, s.gy, s.gz], raw: s.raw6 || null });
  if (b.length > ACT_BUF_MAX) {
    const over = b.length - ACT_BUF_MAX;
    b.splice(0, over);
    act.drop += over;
  }
}

function actWtPacket(d, frames, receipt) {
  if (!act.on || act.source !== 'wt' || !d.connected || d.demo) return;
  const foot = ['l', 'r'].find(f => act.wtKeys[f] === d.key);
  if (!foot) return;
  // Do not forward held accel/gyro from split frame types as simultaneous measurements.
  const values = frames.filter(f => f.acc && f.gyr).map(f => [...f.acc, ...f.gyr]);
  if (!values.length) return;
  act.buf[foot].push({ foot, receipt_ms: receipt, segment: d.key + ':' + (d.actEpoch || 0), values });
  if (act.buf[foot].length > ACT_BUF_MAX) {
    act.drop += act.buf[foot].shift().values.length;
  }
}

function actWtChoices() {
  const signature = [...state.devices.values()].map(d => [d.key, d.label, d.mac, d.connected].join(':')).join('|');
  if (signature === act.wtSignature) return;
  act.wtSignature = signature;
  for (const f of ['l', 'r']) {
    const el = $('actWt' + f.toUpperCase()), prev = el.value;
    el.replaceChildren(new Option('请选择设备', ''));
    for (const d of state.devices.values()) if (!d.demo) {
      el.add(new Option(d.label + (d.mac ? ' ' + d.mac : '') + (d.connected ? '' : '（未连接）'), d.key));
    }
    el.value = prev;
  }
}

function actTick() {
  if (!act.on || act.inflight) return;
  /* 就绪与否看设备侧状态，不看是否喂过帧：缺脚时也要送出去，由服务端判 invalid */
  if (!actBiasReady()) { actRender(); return; }
  const now = performance.now();
  const tEnd = Math.floor((now - ACT_BUFFER_MS) / ACT_STEP_MS) * ACT_STEP_MS;
  if (act.lastEnd !== null && !(tEnd > act.lastEnd)) { actRender(); return; }

  const events = [];
  for (const f of ['l', 'r']) for (const e of act.buf[f]) events.push(e);
  const n = act.source === 'wt' ? events.reduce((sum, e) => sum + e.values.length, 0) : events.length;
  act.buf.l.length = 0; act.buf.r.length = 0;

  act.inflight = true;
  const generation = act.generation;
  return actPost('/act/step', { events, t_end: tEnd, now_ms: now }).then((r) => {
    if (!act.on || generation !== act.generation) return;
    act.steps++;
    act.sent += n;
    act.lastEnd = tEnd;
    act.last = r;
    act.err = '';
    if (r.valid) act.valid++;
    act.hist.push(r.valid ? r.label : '!');
    if (act.hist.length > ACT_HIST_N) act.hist.shift();
    actRender();
  }).catch((e) => {
    if (!act.on || generation !== act.generation) return;
    act.err = e.message;
    if (/engine_unavailable|Failed to fetch|NetworkError/i.test(e.message)) {
      actStop('本地推断服务不可用');
    } else {
      log('推断请求失败：' + e.message, 'w');
    }
    actRender();
  }).finally(() => { act.inflight = false; actRender(); });
}

/* 零偏等待期间给出两只脚各自的进度，避免用户分不清是没连上还是没收敛 */
function actBiasHint() {
  const one = (f) => {
    const st = irStates[f];
    if (!st || !st.dev) return '未连接';
    if (st.bias && st.bias.ready) return '已就绪';
    const still = st.bias && st.bias.still ? ' ' + st.bias.still + ' 帧' : '';
    return '等静止' + still;
  };
  return '（左 ' + one('l') + ' · 右 ' + one('r') + '）';
}

function actRender() {
  if (!$('actCard')) return;
  actWtChoices();
  $('actSource').disabled = act.on || act.inflight;
  $('actWtL').disabled = $('actWtR').disabled = act.on || act.inflight;
  const on = act.on, last = act.last;
  $('btnActOn').disabled = on || act.inflight;
  $('btnActOff').disabled = !on;
  $('actState').textContent = act.err
    ? '异常'
    : (on ? (act.inflight ? '推断中…' : (actBiasReady() ? '运行中' : (act.source === 'wt' ? '等连接' : '等零偏')))
      : (act.steps ? '已停止' : '未开始'));

  const usable = on && actBiasReady() && !act.clockBad.l && !act.clockBad.r &&
    last && last.valid && performance.now() - last.t_end < 600;
  const cls = usable ? last.label : null;
  $('actLabel').textContent = cls ? ACT_TEXT[cls] : '—';
  $('actLabel').style.color = cls ? ACT_COLOR[cls] : 'var(--mute)';

  const probs = usable ? last.probabilities : null;
  ACT_CLASSES.forEach((c, i) => {
    const p = probs ? probs[i] : 0;
    const bar = $('actBar' + i);
    bar.style.width = (p * 100).toFixed(1) + '%';
    bar.style.background = ACT_COLOR[c];
    $('actPct' + i).textContent = probs ? (p * 100).toFixed(1) + '%' : '—';
  });

  let why;
  if (act.err) why = act.err;
  else if (!on) why = act.steps ? '已停止' : '连接两脚设备并选择输入类型，点「开始推断」，每 200 ms 出一次结果';
  else if (!actBiasReady()) why = act.source === 'wt' ? '等待所选左右WT设备连接；断连不输出类别' : '等待零偏估计，请两脚静立约 5 秒' + actBiasHint();
  else if (act.clockBad.l || act.clockBad.r) why = '缺少有效设备时间戳／序号，不能用写入时间替代';
  else if (!last) why = act.source === 'wt' ? '等待WT同步六轴打包帧（0x61），不支持拼接过期拆分帧' : '等数据…';
  else if (last.valid && !usable) why = '结果已过期，等待新鲜窗口';
  else if (last.valid) {
    const q = last.quality || {};
    const repair = Math.max(...Object.values(q).map(v => v.repaired_fraction || 0), 0);
    const density = Math.min(...Object.values(q).map(v => v.density == null ? 1 : v.density), 1);
    why = (last.quality_level === 'degraded' ? '降级有效' : '窗口正常') +
      ' · 最大跨度 ' + (last.age_ms || 0).toFixed(0) + ' ms · 修复覆盖 ' +
      (repair * 100).toFixed(0) + '% · 密度 ' + (density * 100).toFixed(0) +
      '% · 结果年龄 ' + (last.result_age_ms || 0).toFixed(0) + ' ms';
  }
  else {
    why = ACT_REASON[last.reason] || last.reason;
    if (last.detail) why += '（' + last.detail + '）';
  }
  $('actWhy').textContent = why;
  $('actWhy').title = why;

  $('actSteps').textContent = act.steps;
  $('actValid').textContent = act.valid;
  $('actSent').textContent = act.sent;
  $('actDrop').textContent = act.drop;
  $('actLat').textContent = last && last.valid && last.latency_ms != null
    ? last.latency_ms.toFixed(1) : '—';
  $('actUp').textContent = on || act.steps ? ((performance.now() - act.t0) / 1000).toFixed(0) : '0';

  for (const f of ['l', 'r']) {
    const st = act.source === 'wt' ? (state.devices.get(act.wtKeys[f]) || {}) : irStates[f];
    const ready = act.source === 'wt' ? !!st.connected : !!(st.bias && st.bias.ready);
    const txt = ((act.source === 'wt' ? st.connected : st.dev) ? (st.rate || 0) + ' Hz' : '未连接') +
      (on ? (ready ? ' · ' + act.buf[f].length + ' 待发' : ' · 等零偏') : '');
    $('actFoot' + f.toUpperCase()).textContent = txt;
  }
  actHistDraw();
}

function actHistDraw() {
  const cv = $('actHist');
  if (!cv) return;
  const g = fit(cv);
  if (!g) return;
  const { ctx, w, h } = g;
  ctx.clearRect(0, 0, w, h);
  const gap = 2;
  const bw = (w - gap * (ACT_HIST_N - 1)) / ACT_HIST_N;
  if (bw <= 0) return;
  for (let i = 0; i < ACT_HIST_N; i++) {
    const v = act.hist[i];
    const x = i * (bw + gap);
    ctx.fillStyle = v === undefined ? '#eef1f6' : (v === '!' ? '#f1f3f5' : ACT_COLOR[v]);
    ctx.fillRect(x, 0, bw, h - 3);
    if (v === '!') {
      ctx.fillStyle = '#e03131';
      ctx.fillRect(x, h - 3, bw, 3);
    }
  }
}

$('actSource').onchange = async () => {
  if (act.on || act.inflight) return;
  act.source = $('actSource').value;
  act.info = null; act.last = null; act.err = ''; act.hist = [];
  $('actWtPick').hidden = act.source !== 'wt';
  $('actFsL').value = $('actFsR').value = act.source === 'wt' ? '50' : '51.2';
  actWtChoices();
  await actInfo();
};
$('btnActOn').onclick = () => actStart();
$('btnActOff').onclick = () => actStop('手动停止');

/* 目标窗口每200ms推进；短轮询把发布时刻靠近窗口末+150ms。 */
setInterval(actTick, 25);
