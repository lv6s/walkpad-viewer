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
const ACT_HIST_N = 60;
/* 单脚最多攒 700 帧（约 13 s）：服务端卡住时不能无限吃内存 */
const ACT_BUF_MAX = 700;
/* 零偏被重新初始化的跳变阈值（°/s）。动态估计就绪后是慢跟随，远低于此值 */
const ACT_BIAS_JUMP = 3;

const ACT_REASON = {
  cold_start: '历史不足 2 秒',
  no_data: '还没有 IMU 数据',
  missing_foot: '缺一只脚的数据',
  stream_gap: '窗口内有断流',
  order: '事件时间倒退',
  bad_values: '出现非有限数值',
  bad_request: '请求格式不对',
  too_many_events: '单次事件过多',
  bad_time: '决策时间非法'
};

const act = {
  on: false, inflight: false, last: null, info: null, err: '',
  hist: [], buf: { l: [], r: [] },
  bias: { l: null, r: null }, waitBias: { l: 0, r: 0 },
  steps: 0, valid: 0, sent: 0, drop: 0,
  fsL: 50, fsR: 50, lastEnd: 0, t0: 0
};

/* 两脚都拿到零偏估计才允许决策：单脚缺估计时窗内会混进带偏数据 */
function actBiasReady() {
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
    body: JSON.stringify(body || {})
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
      act.info.fs_out + ' Hz），每 ' + Math.round(act.info.step_s * 1000) + ' ms 一次决策。';
  } catch (e) {
    act.info = null;
    $('actModel').textContent = '推断服务不可用';
    $('actAxis').textContent = '本地推断服务未就绪：' + e.message +
      '（需要 python 环境里有 onnxruntime，且 activity/ 下的模型文件完整）';
  }
  actRender();
}

async function actStart() {
  if (act.on) return;
  const rate = (id, def) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  act.fsL = rate('actFsL', 50);
  act.fsR = rate('actFsR', 50);
  $('btnActOn').disabled = true;
  try {
    await actPost('/act/reset', { fs_left: act.fsL, fs_right: act.fsR });
    act.on = true; act.last = null; act.err = ''; act.hist = [];
    act.steps = 0; act.valid = 0; act.sent = 0; act.drop = 0;
    act.lastEnd = 0; act.t0 = performance.now();
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
  act.buf.l.length = 0; act.buf.r.length = 0;
  act.bias.l = null; act.bias.r = null;
  if (reason) log('状态推断已停止：' + reason, 'w');
  actRender();
}

/* irFrame 每收一帧调一次；只在推断开着时记账 */
function actFeed(st, s) {
  if (!act.on || !s) return;
  /* 设备重连会让帧时钟重新锚定，跳回一秒以上就不再是一条可比的时间轴 */
  if (act.lastEnd && s.perf < act.lastEnd - 1000) {
    actStop('帧时间倒退超过 1 秒，请重新开始');
    return;
  }
  const f = st.foot;
  /* 未就绪时 st.bias.g 是 [0,0,0]，gx 就是原始值：送出去等于把实测 -18 °/s 的偏置
     直接喂给模型，会把 other 判成 walk 且不报错。宁可等它收敛（约 5 s 静立）。 */
  const bg = st.bias && st.bias.ready ? st.bias.g : null;
  if (!bg) { act.waitBias[f]++; return; }
  const prev = act.bias[f];
  if (prev && Math.hypot(bg[0] - prev[0], bg[1] - prev[1], bg[2] - prev[2]) > ACT_BIAS_JUMP) {
    /* 零偏被重新初始化：窗内前后不属于同一个输入域，整窗作废重攒 */
    act.buf[f].length = 0;
    log('零偏估计已重置，重新积累窗口', 'i');
  }
  act.bias[f] = [bg[0], bg[1], bg[2]];
  const b = act.buf[f];
  b.push([s.perf, s.ax, s.ay, s.az, s.gx, s.gy, s.gz]);
  if (b.length > ACT_BUF_MAX) {
    const over = b.length - ACT_BUF_MAX;
    b.splice(0, over);
    act.drop += over;
  }
}

function actTick() {
  if (!act.on || act.inflight) return;
  /* 就绪与否看设备侧状态，不看是否喂过帧：缺脚时也要送出去，由服务端判 invalid */
  if (!actBiasReady()) { actRender(); return; }
  if (!act.buf.l.length && !act.buf.r.length) { actRender(); return; }
  let tEnd = 0;
  for (const f of ['l', 'r']) {
    const b = act.buf[f];
    if (b.length && b[b.length - 1][0] > tEnd) tEnd = b[b.length - 1][0];
  }
  /* 还没有比上次决策更新的事件：留着不丢，等下一拍 */
  if (!(tEnd > act.lastEnd)) { actRender(); return; }

  const events = [];
  for (const f of ['l', 'r']) for (const e of act.buf[f]) events.push([f, e]);
  const n = events.length;
  act.buf.l.length = 0; act.buf.r.length = 0;

  act.inflight = true;
  actPost('/act/step', { events, t_end: tEnd }).then((r) => {
    act.steps++;
    act.sent += n;
    act.lastEnd = tEnd;
    act.last = r;
    act.err = '';
    if (r.valid) act.valid++;
    act.hist.push(r.valid ? r.label : '!');
    if (act.hist.length > ACT_HIST_N) act.hist.shift();
    /* 时间倒退说明这段会话的时间轴已经不可信，继续跑只会一直拒收 */
    if (!r.valid && r.reason === 'order') actStop('事件时间倒退，请重新开始');
    actRender();
  }).catch((e) => {
    act.err = e.message;
    if (/engine_unavailable|Failed to fetch|NetworkError/i.test(e.message)) {
      actStop('本地推断服务不可用');
    } else {
      log('推断请求失败：' + e.message, 'w');
    }
    actRender();
  }).finally(() => { act.inflight = false; });
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
  const on = act.on, last = act.last;
  $('btnActOn').disabled = on;
  $('btnActOff').disabled = !on;
  $('actState').textContent = act.err
    ? '异常'
    : (on ? (act.inflight ? '推断中…' : (actBiasReady() ? '运行中' : '等零偏'))
      : (act.steps ? '已停止' : '未开始'));

  const cls = last && last.valid ? last.label : null;
  $('actLabel').textContent = cls ? ACT_TEXT[cls] : '—';
  $('actLabel').style.color = cls ? ACT_COLOR[cls] : 'var(--mute)';

  const probs = last && last.valid ? last.probabilities : null;
  ACT_CLASSES.forEach((c, i) => {
    const p = probs ? probs[i] : 0;
    const bar = $('actBar' + i);
    bar.style.width = (p * 100).toFixed(1) + '%';
    bar.style.background = ACT_COLOR[c];
    $('actPct' + i).textContent = probs ? (p * 100).toFixed(1) + '%' : '—';
  });

  let why;
  if (act.err) why = act.err;
  else if (!on) why = act.steps ? '已停止' : '点「开始推断」，连接鞋垫后自动按 200 ms 出一次结果';
  else if (!actBiasReady()) why = '等待零偏估计，请两脚静立约 5 秒' + actBiasHint();
  else if (!last) why = '等数据…';
  else if (last.valid) why = '窗口有效 · 支撑点最大滞后 ' + (last.age_ms || 0).toFixed(0) + ' ms';
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
    const st = irStates[f];
    const ready = !!(st.bias && st.bias.ready);
    const txt = (st.dev ? (st.rate || 0) + ' Hz' : '未连接') +
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

$('btnActOn').onclick = () => actStart();
$('btnActOff').onclick = () => actStop('手动停止');

/* 固定 200 ms 一拍：与模型训练时的决策步长一致，页面卡顿也只是延后，不会补拍 */
setInterval(actTick, ACT_STEP_MS);
