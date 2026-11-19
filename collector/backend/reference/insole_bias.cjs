'use strict';
function createBiasTracker(options = {}) {
  const recovery = options.recovery === true ? require('../bias_recovery.cjs').createBiasRecovery() : null;
  const assessNoise = require('../noise_gate.cjs').assessNoise;
  let lastReject = null, diagnostics = null, acceptedWindows = 0, rejectedWindows = 0;
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

/* 自动模式把“这一小段有没有在动”和“这一段跨度够不够稳”分开判：
   穿戴时单帧微动很常见，整窗一票否决会让初始化迟迟不成功。 */
const IR_DYN_INIT_MS = 5000, IR_DYN_INIT_SPAN = 10000, IR_DYN_INIT_RATIO = 0.5;
const IR_DYN_KEEP_MS = 10000, IR_DYN_SHORT_MS = 500, IR_DYN_MIN_FRAMES = 8;
const IR_DYN_TRACK_RUN = 1500;
const IR_DYN_ROWS = 4096, IR_DYN_RAW_MAX = 40;
const IR_DYN_GSTD = 0.35, IR_DYN_GRANGE = 2.0, IR_DYN_ASTD = 0.01, IR_DYN_ARANGE = 0.04;
const IR_DYN_AERR = 0.08, IR_DYN_INIT_DRIFT = 0.5, IR_DYN_SEG = 0.4, IR_DYN_GRAV = 0.02;
const IR_DYN_NRATE = 0.5, IR_DYN_SLOW_TAU = 10;

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
  lastReject = reason; rejectedWindows++;
  if (recovery) recovery.invalidate();
  const b = st.bias;
  if (b.dynamic) { b.dynamic.rows = []; b.dynamic.runStart = null; b.dynamic.learning = false; }
  b.still = 0;
  b.status = '等待下一段静止：' + reason + (b.ready ? ' · 保留补偿' : ' · 未就绪');
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

/* 只累计“本帧通过短窗检查”的时间段，被拒绝的帧不进入均值，避免把运动平均进零偏。 */
function irBiasWeighted(rows, start, end) {
  const sum = Array(6).fill(0);
  let weight = 0;
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], q = rows[i];
    if (!q[8]) continue;
    const lo = Math.max(start, p[6]), hi = Math.min(end, q[6]);
    const width = q[6] - p[6];
    if (!(width > 0) || hi <= lo) continue;
    for (let k = 0; k < 6; k++) {
      const a = p[k] + (q[k] - p[k]) * (lo - p[6]) / width;
      const z = p[k] + (q[k] - p[k]) * (hi - p[6]) / width;
      sum[k] += (a + z) * 0.5 * (hi - lo);
    }
    weight += hi - lo;
  }
  return { mu: weight > 0 ? sum.map(v => v / weight) : null, weight };
}

function irBiasDrift(rows, start, end) {
  const third = (end - start) / 3;
  const first = irBiasWeighted(rows, start, start + third), last = irBiasWeighted(rows, end - third, end);
  if (!first.mu || !last.mu) return { gyro: Infinity, gravity: Infinity };
  return {
    gyro: Math.hypot(...first.mu.slice(0, 3).map((v, k) => v - last.mu[k])),
    gravity: Math.hypot(...first.mu.slice(3).map((v, k) => v - last.mu[k + 3]))
  };
}

function irBiasSegments(rows, start, end) {
  // 逐轴取分段均值的极差，跨轴取最大：轴间本来就不同量级。
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < 5; j++) {
    const part = irBiasWeighted(rows, start + (end - start) * j / 5, start + (end - start) * (j + 1) / 5);
    if (!part.mu) continue;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], part.mu[k]); hi[k] = Math.max(hi[k], part.mu[k]); }
  }
  return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/* 短窗检查：只看“这段时间动没动”，长期稳定性交给跨度检查。 */
function irBiasShortCheck(rows, start, end) {
  const stats = irBiasDynamicStats(rows, start, end);
  diagnostics = assessNoise(rows, start, end);
  if (diagnostics.reject) return { ok: false, reason: diagnostics.reject, stats };
  const lo = Array(6).fill(Infinity), hi = Array(6).fill(-Infinity);
  let normErr = 0, frames = 0;
  for (const r of rows) {
    if (r[6] < start) continue;
    frames++;
    for (let k = 0; k < 6; k++) { lo[k] = Math.min(lo[k], r[k]); hi[k] = Math.max(hi[k], r[k]); }
    normErr = Math.max(normErr, Math.abs(Math.hypot(r[3], r[4], r[5]) - 1));
  }
  const eps = 1e-12;
  if (frames < IR_DYN_MIN_FRAMES) return { ok: false, reason: null, stats };
  if (normErr > IR_DYN_AERR + eps) return { ok: false, reason: '加速度模长超出静止范围', stats };
  for (let k = 0; k < 3; k++) {
    if (stats.std[k] > IR_DYN_GSTD + eps || hi[k] - lo[k] > IR_DYN_GRANGE + eps)
      return { ok: false, reason: '检测到转动，重新等待', stats };
  }
  for (let k = 3; k < 6; k++) {
    if (stats.std[k] > IR_DYN_ASTD + eps || hi[k] - lo[k] > IR_DYN_ARANGE + eps)
      return { ok: false, reason: '加速度变化超限，重新等待', stats };
  }
  return { ok: true, reason: null, stats };
}

function irBiasDynamic(st, s) {
  const b = st.bias;
  if (!s) return;
  const now = performance.now(), eps = 1e-12;
  if (!Number.isFinite(now) || !Number.isInteger(s.seq) || s.seq < 0 || s.seq > 0xffffffff) {
    irBiasDynamicClear(st, '时间或帧序号无效'); return;
  }
  let c = b.dynamic;
  if (!c) c = b.dynamic = { rows: [], lastSeq: null, lastHost: null, lastEpoch: null,
    coarse: false, runStart: null, learning: false };
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
  /* 每轴 40 °/s 只是数值保护；是否运动由窗内变化判，不用“离偏置 0 多远”推断。 */
  if (Math.abs(s.gx0) > IR_DYN_RAW_MAX + eps || Math.abs(s.gy0) > IR_DYN_RAW_MAX + eps
    || Math.abs(s.gz0) > IR_DYN_RAW_MAX + eps) {
    irBiasDynamicClear(st, '角速度超出数值保护范围'); return;
  }
  /* 同 host 的重复帧也要先过加速度门，否则异常加速度会被直接吞掉。 */
  if (Math.abs(Math.hypot(s.ax, s.ay, s.az) - 1) > IR_DYN_AERR + eps) {
    irBiasDynamicClear(st, '加速度模长超出静止范围'); return;
  }
  if (hostDelta === 0) return;
  q.push(now, epoch, false);
  c.rows.push(q);
  if (c.rows.length > IR_DYN_ROWS) { irBiasDynamicClear(st, '候选窗口超长'); return; }
  const keep = now - IR_DYN_KEEP_MS;
  while (c.rows.length > 1 && c.rows[0][6] < keep) c.rows.shift();
  const rows = c.rows;
  b.still = rows.length;

  const start = Math.max(rows[0][6], now - IR_DYN_SHORT_MS);
  if (now - start < IR_DYN_SHORT_MS - 1e-9) {
    b.status = (b.ready ? '在线跟踪 · 采样中 ' : '未就绪 · 等待静止 ')
      + Math.min((now - rows[0][6]) / 1000, IR_DYN_SHORT_MS / 1000).toFixed(1)
      + '/' + (IR_DYN_SHORT_MS / 1000).toFixed(1) + ' 秒';
    irBiasText(st); return;
  }
  const short = irBiasShortCheck(rows, start, now);
  rows[rows.length - 1][8] = short.ok;
  if (!short.ok) {
    c.runStart = null; c.learning = false;
    if (recovery) recovery.invalidate();
    b.status = '等待下一段静止：' + short.reason + (b.ready ? ' · 保留补偿' : ' · 未就绪');
    irBiasText(st); return;
  }
  if (c.runStart === null) c.runStart = now;
  const runMs = now - c.runStart;

  if (!b.ready) {
    let acc = 0, firstOk = -1;
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i][8]) continue;
      if (firstOk < 0) firstOk = i;
      acc += rows[i][6] - rows[i - 1][6];
    }
    b.status = '未就绪 · 合格 ' + (Math.min(acc, IR_DYN_INIT_MS) / 1000).toFixed(1)
      + '/' + (IR_DYN_INIT_MS / 1000).toFixed(1) + ' 秒';
    // 跨度与均值都只算合格段：被拒绝的帧不能既充时长又拉均值。
    const qStart = firstOk < 0 ? now : rows[firstOk][6];
    const span = now - qStart;
    if (acc < IR_DYN_INIT_MS || span > IR_DYN_INIT_SPAN || acc < span * IR_DYN_INIT_RATIO) {
      irBiasText(st); return;
    }
    const whole = irBiasWeighted(rows, qStart, now);
    const drift = irBiasDrift(rows, qStart, now), seg = irBiasSegments(rows, qStart, now);
    if (!whole.mu || drift.gyro > IR_DYN_INIT_DRIFT || drift.gravity > IR_DYN_GRAV || seg > IR_DYN_SEG) {
      c.rows = rows.slice(Math.floor(rows.length / 2)); c.runStart = null;
      b.still = c.rows.length;
      b.status = '候选跨度内仍在变化，重新积累';
      irBiasText(st); return;
    }
    b.g = whole.mu.slice(0, 3); b.ready = true;
    if (recovery) recovery.initialized();
    acceptedWindows++; lastReject = null; c.learning = true;
    b.status = '已初始化 · 在线跟踪中';
    irBiasText(st); return;
  }

  if (runMs < IR_DYN_TRACK_RUN) {
    b.status = '在线跟踪 · 连续静止 ' + (runMs / 1000).toFixed(1) + '/' + (IR_DYN_TRACK_RUN / 1000).toFixed(1) + ' 秒';
    irBiasText(st); return;
  }
  const obs = short.stats.mu.slice(0, 3);
  let tau = IR_DYN_SLOW_TAU, fast = false;
  if (recovery) {
    const decision = recovery.assess({ bias: b.g, gyro: obs, runMs, measureStability(confirmMs) {
      // 复核只看最近一段完整静止窗，不能引用已淘汰的静止起点。
      const from = now - confirmMs;
      return from >= c.runStart && from >= rows[0][6] ? irBiasDrift(rows, from, now) : null;
    } });
    if (decision.hold) {
      c.learning = false; lastReject = decision.reason;
      b.status = decision.reason;
      irBiasText(st); return;
    }
    tau = decision.tau;
    fast = decision.fast;
  } else if (Math.hypot(...obs.map((v, k) => v - b.g[k])) > 0.8) {
    c.learning = false;
    b.status = '候选偏移过大，保留补偿；需静止校准或重新佩戴确认';
    irBiasText(st); return;
  }
  const dt = Math.min(Math.max(now - rows[rows.length - 2][6], 0), 250) / 1000;
  const alpha = -Math.expm1(-dt / tau);
  const delta = obs.map((v, k) => (v - b.g[k]) * alpha);
  const norm = Math.hypot(...delta);
  const scale = norm > IR_DYN_NRATE * dt ? IR_DYN_NRATE * dt / norm : 1;
  b.g = b.g.map((v, k) => v + delta[k] * scale);
  if (!c.learning) { c.learning = true; acceptedWindows++; }
  lastReject = null;
  b.status = fast ? '静止确认通过 · 快速跟随中' : '在线跟踪 · 已更新';
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
  if (recovery) recovery.initialized();
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
    return { ready: b.ready, gyro_bias_dps: [...b.g], mode: b.mode, status: b.status, candidate_frames: b.still,
      gate_version: recovery ? 'confirmed-rest-v4' : 'bounded-noise-v2', last_reject: lastReject,
      accepted_windows: acceptedWindows, rejected_windows: rejectedWindows, diagnostics,
      ...(recovery ? { recovery: recovery.snapshot() } : {}) };
  }
  return {
    advance, snapshot,
    reset() { irBiasReset(st, true); lastReject = null; diagnostics = null; acceptedWindows = 0; rejectedWindows = 0; if (recovery) recovery.reset(); },
    setMode(mode) {
      if (mode !== st.bias.mode && (mode === 'manual' || mode === 'dynamic')) { if (recovery) recovery.invalidate(); }
      irBiasSetMode(st, mode);
    },
    startCalibration() { if (recovery) recovery.invalidate(); irBiasStart(st); },
    cancelCalibration() { if (recovery) recovery.invalidate(); irBiasCancel(st, 'cancelled'); },
    push(sample, processingMs) {
      advance(processingMs);
      irBiasTrack(st, sample);
      return snapshot();
    }
  };
}
module.exports = { createBiasTracker };
