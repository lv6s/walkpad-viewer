'use strict';
function createBiasTracker() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const performance = { now: () => now };
  const setTimeout = (fn, ms) => { const id = ++nextId; timers.set(id, { fn, due: now + ms }); return id; };
  const clearTimeout = id => timers.delete(id);
  const log = () => {};
  const irBiasText = () => {};
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


  const st = { foot: 'l', bias: irBiasNew() };
  function advance(time) {
    if (!Number.isFinite(time) || time < now) throw new Error('processing clock must be monotonic');
    for (;;) {
      const due = [...timers].filter(([, x]) => x.due <= time).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].due; due[1].fn();
    }
    now = time;
  }
  function snapshot() {
    const b = st.bias;
    return { ready: b.ready, gyro_bias_dps: [...b.g], mode: b.mode, status: b.status, candidate_frames: b.still };
  }
  return {
    advance, snapshot,
    reset() { irBiasReset(st, true); },
    setMode(mode) { irBiasSetMode(st, mode); },
    startCalibration() { irBiasStart(st); },
    cancelCalibration() { irBiasCancel(st, 'cancelled'); },
    push(sample, processingMs) {
      advance(processingMs);
      irBiasTrack(st, sample);
      return snapshot();
    }
  };
}
module.exports = { createBiasTracker };
