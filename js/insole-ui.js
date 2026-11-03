/* 自研鞋垫界面层：双面板渲染、压力图、点位波形、数值与格式。 */

/* ---------- IMU-R：连接、解帧、波形 ---------- */
function irHead() {
  for (const f of IR_SIDES) {
    const on = irOnOf(f);
    const dot = $(f === 'l' ? 'irDotL' : 'irDotR');
    if (dot) {
      dot.textContent = on ? '●' : '·';
      dot.style.color = on ? '#2f9e44' : '#b6c1cf';
    }
    withFoot(f, () => {
      const s0 = irState0();
      $('btnIrOff').disabled = !on;
      $('btnIrCsv').disabled = !(irStates.l.rec.length || irStates.r.rec.length);
      $('btnFmtRead').disabled = !on;
      $('btnFmtSet').disabled = !on || !s0.write;
      $('irDev').textContent = s0.dev ? ((s0.dev.name || '鞋垫') + (on ? '' : ' · 已断开'))
        : '未连接';
      $('irInfo').textContent = s0.info;
      $('pwName').textContent = s0.sel < 0 ? '未选中'
        : '#' + (s0.sel + 1) + ' · 第 ' + IR_POS[s0.sel].row + ' 行 · 槽位 '
          + irLutOf(f).indexOf(s0.sel);
    });
  }
  /* 两只都连上才不再收新设备 */
  $('btnIrOn').disabled = IR_SIDES.every(irOnOf);
  updateBtns();
}

const irState0 = () => irStates[irActive];

function irNums(s) {
  const put = (id, v) => { $(id).textContent = s ? v : '—'; };
  put('irax', s && s.ax.toFixed(2)); put('iray', s && s.ay.toFixed(2)); put('iraz', s && s.az.toFixed(2));
  put('irgx', s && s.gx.toFixed(1)); put('irgy', s && s.gy.toFixed(1)); put('irgz', s && s.gz.toFixed(1));
  irBiasText(irStates[irActive]);
  $('irRate').textContent = ir.rate;
  $('irN').textContent = ir.frames;
  $('irBad').textContent = ir.bad;
  if (s) {
    $('irTs').textContent = s.ts + ' ms';
    $('irAux').textContent = s.tempRaw + ' ≈ ' + (s.tempRaw / 100).toFixed(2) + ' ℃';
    $('irLen').textContent = s.len + ' B / ' + s.pts + ' 点';
    const hex = Array.from(ir.lastRaw || [], (b) => b.toString(16).padStart(2, '0')).join(' ');
    $('irRaw').textContent = '最近一帧：' + hex;
  } else {
    $('irTs').textContent = '—'; $('irAux').textContent = '—'; $('irLen').textContent = '—';
    $('irRaw').textContent = '';
  }
}

function irDraw() {
  const cv = $('irChart');
  if (!cv) return;
  const g = fit(cv);
  if (!g) return;
  const { ctx, w, h } = g;
  ctx.clearRect(0, 0, w, h);
  const PL = 46, PR = 10, PT = 20, PB = 18, GAP = 26;
  const iw = w - PL - PR;
  const ph = (h - PT - PB - GAP) / 2;
  const win = state.window || 10;
  const tEnd = ir.samples.length ? ir.samples[ir.samples.length - 1].t : 0;
  const tStart = Math.max(0, tEnd - win);
  const X = (t) => PL + ((t - tStart) / win) * iw;
  const vis = ir.samples.filter((s) => s.t >= tStart);
  if (!vis.length) {
    ctx.fillStyle = '#98a2b0';
    ctx.font = '12px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(irOn() ? '等第一帧数据…' : '点「连接」选择 IMU-R，之后这里显示 6 通道波形', w / 2, h / 2);
    return;
  }
  const panels = [
    { key: 'a', name: '加速度 g', ks: ['ax', 'ay', 'az'], floor: 0.5 },
    { key: 'g', name: '角速度 °/s', ks: ['gx', 'gy', 'gz'], floor: 20 }
  ];
  panels.forEach((p, idx) => {
    const top = PT + idx * (ph + GAP);
    let peak = 0;
    for (const s of vis) for (const k of p.ks) peak = Math.max(peak, Math.abs(s[k]));
    const raw = Math.max(peak * 1.15, p.floor);
    const up = niceUp(raw);
    const cur = ir.ymax[p.key];
    /* 与主页面同一套滞回：变大立刻换档、跌破 70% 才退档，窗口滑动时曲线不跳 */
    if (up > cur || (up < cur && raw < cur * 0.7)) ir.ymax[p.key] = up;
    const ymax = ir.ymax[p.key];
    const Y = (v) => top + ph / 2 - (v / ymax) * (ph / 2);

    ctx.strokeStyle = '#f1f4f9'; ctx.lineWidth = 1;
    for (let k = 0; k <= 2; k++) {
      const y = top + (ph * k) / 2;
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
    }
    ctx.strokeStyle = '#e9edf4';
    for (let k = 0; k <= 5; k++) {
      const x = PL + (iw * k) / 5;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke();
    }
    ctx.fillStyle = '#eef1f6';
    ctx.fillRect(PL, Y(0) - 0.5, iw, 1);

    const top3 = +ymax.toPrecision(3);
    ctx.font = '9.5px ui-monospace,Consolas,monospace';
    ctx.fillStyle = '#98a2b0'; ctx.textAlign = 'right';
    ctx.fillText(String(top3), PL - 5, top + 9);
    ctx.fillText('0', PL - 5, Y(0) + 3);
    ctx.fillText('-' + top3, PL - 5, top + ph - 1);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#6b7787'; ctx.font = '600 10px ui-monospace,Consolas,monospace';
    ctx.fillText(p.name, PL + 2, top - 6);

    p.ks.forEach((k, ci) => {
      ctx.strokeStyle = IR_COLORS[ci]; ctx.lineWidth = 1.7;
      ctx.beginPath();
      vis.forEach((s, i) => {
        const x = X(s.t), y = Y(s[k]);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
    });
  });
  ctx.fillStyle = '#b6c1cf'; ctx.font = '9.5px ui-monospace,Consolas,monospace';
  ctx.textAlign = 'center';
  for (let k = 0; k <= 5; k++) {
    ctx.fillText((tStart + (win * k) / 5).toFixed(0) + 's', PL + (iw * k) / 5, h - PB + 12);
  }
}

   /* 两只共用一个键：广播名决定连到哪只 */

/* ---------- 数值口径（跟设备输出格式走）+ 选中点波形 ---------- */
const PW_WIN = 10, PW_KEEP = 12;

   // 显示窗口 / 保留秒数
/* 单位不是本地开关：固件的 0x10 改输出格式、0x0D 回读。没回读到之前按重量档显示并注明。 */
const prFmt = () => (ir.fmt == null ? 4 : ir.fmt);

const prU = () => FMT_UNIT[prFmt()];

const prBase = () => (prFmt() === 4 ? PR_IDLE : 0);

     // 重量档空载 100 g 是零点偏置
const prSpan = () => (prFmt() === 4 ? PR_SPAN_G : PR_SPAN_RAW);

/* 色阶跨度按满量程算，不按"日常踩踏的 2 kg"算 —— 用 2200 的话一坐下去半个鞋垫就全红了，
   深浅就没法分辨。纵轴仍用 prSpan()，那是给单点波形看细节用的，两者本来就该不同。 */
const prColorSpan = () => (prFmt() === 4 ? PR_MAX : 4096);

const prCap = () => (prFmt() === 4 ? PR_MAX : 65535);

const fmtV = (v) => Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—';

/* 这台固件不可回读，刷新就丢口径 —— 把「最近一次写成功的格式」记在本地，
   下次连接先按它显示，标签仍写「无回执」，不冒充回读结果。 */
const FMT_KEY = 'ir.fmt.written';

function irFmtLoad(st) {
  try {
    const raw = localStorage.getItem(FMT_KEY);
    if (raw == null || raw === '') return;          // Number(null) 是 0，不判空就会默认成 ADC
    const v = Number(raw);
    if (Number.isInteger(v) && v >= 0 && v <= 4) { st.fmt = v; st.fmtSrc = 'saved'; }
  } catch (e) { /* 隐私模式读不了就算了 */ }
}

function irFmtSave(fmt) {
  try { localStorage.setItem(FMT_KEY, String(fmt)); } catch (e) { /* 同上 */ }
}

function irFmtText() {
  const u = $('dvUnit'), s = $('dvStat');
  /* 下拉是当前口径的唯一入口，任何路径改了 ir.fmt（回读/写入/本地恢复）都要把它拉回来，
     否则会出现「下拉写重量、标签写 ADC」这种自相矛盾 */
  if ($('dvFmt') && ir.fmt != null && $('dvFmt').value !== String(ir.fmt)) $('dvFmt').value = String(ir.fmt);
  if (u) {
    /* 这里的字要短：工具栏一行还要放下两个下拉、两个按钮和下载键，
       长标签会把「下载压力 CSV」挤到第二行，而「无回执」下面状态行已经写了 */
    u.textContent = ir.fmtSrc === 'read' ? '已回读 · ' + FMT_NAME[prFmt()]
      : ir.fmtSrc === 'write' ? '已写入 · ' + FMT_NAME[prFmt()]
      : ir.fmtSrc === 'saved' ? '上次写入 · ' + FMT_NAME[prFmt()]
      : '未回读 · 暂按' + FMT_NAME[prFmt()];
  }
  if (s) {
    /* 不变式：设备不可回读，页面只知道「我发过什么」，不知道「设备现在是什么」。
       用户看到的口径与真值可能不一致，所以必须给出唯一可自查的动作。 */
    s.textContent = ir.state ? irStateText()
      : ir.fmtSrc === 'write' || ir.fmtSrc === 'saved'
        ? '按上次写入的格式显示（设备对 0x0D 无回执，无法核实）：' + FMT_SELF[prFmt()]
        : '设备状态未回读：这台固件对 0x0D 不一定回执。写入后可按压自查 —— ' + FMT_SELF[prFmt()];
  }
}

function irRedraw() { irPressDraw(); prNums(); pwDraw(); irFmtText(); }

/* 固件按点稀疏上报，只有值变了才带这一个点，所以折线的每个拐点都是真实样本，不插值 */
function pwPush(i, t, v, foot) {
  const a = irStates[foot || irActive].hist[i];
  const last = a[a.length - 1];
  if (last && t < last.t) return;
  a.push({ t, v });
  while (a.length > 1 && a[0].t < t - PW_KEEP) a.shift();
  if (a.length > 1500) a.splice(0, a.length - 1500);
}

function pwPick(i) {
  const next = (i === ir.sel) ? -1 : i;
  /* 换点或取消选中就停掉正在进行的记录，免得数据混到别的点上 */
  if (ir.pwRecOn && next !== ir.pwRecPt) {
    ir.pwRecOn = false;
    log('记录已停止（切换了点位），点「下载」仍可导出刚才那段', 'w');
  }
  ir.sel = next;
  pwDraw();
  irPressDraw();
  pwName();
}

function pwName() {
  const i = ir.sel;
  $('pwName').textContent = i < 0 ? '未选中'
    : '#' + (i + 1) + ' · 第 ' + IR_POS[i].row + ' 行 · 槽位 ' + irLut.indexOf(i);
  if (i < 0) {
    $('pwCur').textContent = '—';
    $('pwN').textContent = '0';
  }
  const canRec = i >= 0 && irOn();
  $('btnPwRec').disabled = !canRec;
  $('btnPwCsv').disabled = ir.pwRec.length === 0;
  $('btnPwRec').textContent = ir.pwRecOn ? '■ 停止记录' : '● 记录这个点';
  $('btnPwRec').classList.toggle('on', ir.pwRecOn);
  $('pwRecN').textContent = ir.pwRec.length;
}

/* 纵轴档位比 IMU 那张细：ADC 值域大，用 1/2/5 会把曲线压到半屏高 */
function pwTop(v) {
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => m <= s) * e;
}

function pwDraw() {
  const cv = $('pwChart');
  if (!cv) return;
  const g = fit(cv);
  if (!g) return;
  const { ctx, w, h } = g;
  ctx.clearRect(0, 0, w, h);
  const PL = 56, PR = 10, PT = 16, PB = 18;
  const iw = w - PL - PR, ih = h - PT - PB;
  pwName();
  const i = ir.sel;
  if (i < 0) {
    ctx.fillStyle = '#98a2b0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '12px system-ui,"Microsoft YaHei",sans-serif';
    ctx.fillText('点鞋垫上的点，这里画它自己的压力波形', w / 2, h / 2);
    ctx.textBaseline = 'alphabetic';
    return;
  }
  const tEnd = ir.t0 ? (performance.now() - ir.t0) / 1000 : 0;
  const tStart = Math.max(0, tEnd - PW_WIN);
  const all = ir.hist[i];
  const data = all.filter((p) => p.t >= tStart);
  let peak = 0;
  for (const p of data) if (p.v > peak) peak = p.v;
  const ymax = pwTop(Math.max(peak * 1.15, prSpan() * 0.05));
  const X = (t) => PL + ((t - tStart) / PW_WIN) * iw;
  const Y = (v) => PT + ih - Math.min(Math.max(v, 0) / ymax, 1) * ih;

  /* 直接画本帧值：hist 里存的就是"每帧该点的值"，没带的帧就是 0。
     不做插值、不做保持、不做过期判断 —— 曲线每个点都对应一个真实帧。 */
  const curV = ir.frame[i];

  ctx.strokeStyle = '#f1f4f9'; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const y = PT + (ih * k) / 4;
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
  }
  ctx.strokeStyle = '#e9edf4';
  for (let k = 0; k <= 5; k++) {
    const x = PL + (iw * k) / 5;
    ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, PT + ih); ctx.stroke();
  }
  ctx.font = '9.5px ui-monospace,Consolas,monospace';
  ctx.fillStyle = '#98a2b0'; ctx.textAlign = 'right';
  ctx.fillText(String(+ymax.toPrecision(3)), PL - 6, PT + 8);
  ctx.fillText('0', PL - 6, PT + ih + 3);
  ctx.textAlign = 'right'; ctx.fillStyle = '#6b7787';
  ctx.fillText(prU(), w - PR, PT - 4);

  /* 空载零点偏置画虚线：抬脚/踩下去的差别一眼能看出来（原始计数档没有偏置就不画） */
  if (prBase() > 0) {
    ctx.save();
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#dfe5ee';
    ctx.beginPath(); ctx.moveTo(PL, Y(prBase())); ctx.lineTo(w - PR, Y(prBase())); ctx.stroke();
    ctx.restore();
  }

  if (data.length || ir.seen[i]) {
    /* 面积填充让"有没有载"更容易扫到，折线本身仍是实测点采样出来的阶梯 */
    const grd = ctx.createLinearGradient(0, PT, 0, PT + ih);
    grd.addColorStop(0, 'rgba(25,113,194,.30)');
    grd.addColorStop(1, 'rgba(25,113,194,.04)');
    const pts = data.concat([{ t: tEnd, v: curV }]);
    ctx.beginPath();
    ctx.moveTo(X(pts[0].t), Y(0));
    for (const p of pts) ctx.lineTo(X(p.t), Y(p.v));
    ctx.lineTo(X(tEnd), Y(0));
    ctx.closePath();
    ctx.fillStyle = grd; ctx.fill();

    ctx.strokeStyle = '#1971c2'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
    ctx.stroke();
  } else {
    ctx.fillStyle = '#c2ccd9'; ctx.textAlign = 'center';
    ctx.font = '11.5px system-ui,"Microsoft YaHei",sans-serif';
    ctx.fillText('点一个点位开始看波形', w / 2, h / 2);
  }

  /* 数字直接取曲线末端那个值，不再单独算一遍 —— 两套算法迟早会出现
     "显示 10,000 但曲线已经贴底"这种自相矛盾（截图里就出现过）。 */
  $('pwCur').textContent = fmtV(curV) + ' ' + prU();
  $('pwN').textContent = data.length;

  ctx.fillStyle = '#b6c1cf';
  for (let k = 0; k <= 5; k++) {
    ctx.textAlign = k === 0 ? 'left' : k === 5 ? 'right' : 'center';
    ctx.fillText((tStart + (PW_WIN * k) / 5).toFixed(0) + 's', PL + (iw * k) / 5, h - PB + 12);
  }
}

/* 色阶：0 近白 → 浅橙 → 橙 → 深红，但归一化走 sqrt 而不是线性。
   线性配 10000 满量程时，正常踩踏的 1~3k 全挤在浅色端，深浅根本分不开；
   sqrt 把这段拉开，同时保留"越重越红"的单调性。 */
const PR_STOPS = [[0, 255, 255, 255], [0.04, 226, 232, 240], [0.32, 255, 209, 153],
  [0.62, 246, 134, 46], [1, 190, 30, 30]];

function prColor(v) {
  const norm = Math.max(0, Math.min(1, (v - prBase()) / prColorSpan()));
  const t = Math.sqrt(norm);
  let i = 1;
  while (i < PR_STOPS.length - 1 && t > PR_STOPS[i][0]) i++;
  const a = PR_STOPS[i - 1], b = PR_STOPS[i];
  const k = (t - a[0]) / (b[0] - a[0] || 1);
  const c = (j) => Math.round(a[j] + (b[j] - a[j]) * k);
  return 'rgb(' + c(1) + ',' + c(2) + ',' + c(3) + ')';
}

/* 点内数值：过千压成 k 一位小数，顶到上限用 10k 免得撑破圆圈 */
const prLabel = (v) => {
  if (v >= 9995) return '10k';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
};

/* 当前值 = 本帧的。ir.frame 每帧整块重建，本帧没带的点就是 0。 */
const prCur = (i, foot) => irStates[foot || irActive].frame[i];

/* 轮廓按量出来的左右边界画：左边下去、跟底收口、右边回来，顶端直线收口（不做平滑，免得起尖） */
/* 轮廓只用传进来的 X/Y，不自己做镜像 —— 镜像统一在 X 里做，
   两处各翻一次会互相抵消，看起来就是"右脚轮廓没翻"。 */
function prOutline(ctx, X, Y) {
  const pts = PR_EDGE.map(([y, xl]) => [xl, y])
    .concat(PR_EDGE.slice().reverse().map(([y, , xr]) => [xr, y]));
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = X(p[0]), y = Y(p[1]);
    if (!i) return ctx.moveTo(x, y);
    const q = pts[i - 1];
    ctx.quadraticCurveTo(X(q[0]), Y(q[1]), X((q[0] + p[0]) / 2), Y((q[1] + p[1]) / 2));
  });
  ctx.closePath();
  ctx.fillStyle = '#fbfcfe'; ctx.fill();
  ctx.strokeStyle = '#dbe2ec'; ctx.lineWidth = 1.4; ctx.stroke();
}

/* 点位半径 = 任意两点最小距离的一半再留一点缝。
   鞋垫宽高比 0.311，横向最窄处只有 0.119×宽度，按列宽估算会横向叠圈。
   结果按 bw/bh 缓存，重绘时不必每次跑 1540 次点对。 */
let prRKey = '', prRVal = 10;

function prRadius(bw, bh) {
  const key = bw.toFixed(1) + 'x' + bh.toFixed(1);
  if (key === prRKey) return prRVal;
  let min = Infinity;
  for (let i = 0; i < IR_POS.length; i++) {
    for (let j = i + 1; j < IR_POS.length; j++) {
      const dx = (IR_POS[i].x - IR_POS[j].x) * bw;
      const dy = (IR_POS[i].y - IR_POS[j].y) * bh;
      const d = dx * dx + dy * dy;
      if (d < min) min = d;
    }
  }
  prRKey = key;
  prRVal = Math.max(7, Math.sqrt(min) / 2 - 1.2);
  return prRVal;
}

function irPressDraw() {
  const cv = $('irPress');
  if (!cv) return;
  const g = fit(cv);
  if (!g) return;
  const { ctx, w, h } = g;
  ctx.clearRect(0, 0, w, h);
  /* 保持原图长宽比，居中放，避免点被横向拉扁 */
  const asp = PR_W / PR_H;
  let bw = w, bh = w / asp;
  if (bh > h) { bh = h; bw = h * asp; }
  const ox = (w - bw) / 2, oy = (h - bh) / 2;
  /* 右脚整只镜像：点位与轮廓一起翻，两只摆在一起才分得出左右 */
  const mir = irActive === 'r';
  const X = (nx) => ox + (mir ? 1 - nx : nx) * bw, Y = (ny) => oy + ny * bh;
  prOutline(ctx, X, Y);
  const r = prRadius(bw, bh);
  ir.hit.length = 0;
  for (const p of IR_POS) {
    const i = p.lab - 1;
    const v = prCur(i);                 /* 没上报过就是 0，颜色跟着 0 走 */
    const x = X(p.x), y = Y(p.y);
    ir.hit.push({ x, y, r, i });
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = prColor(v); ctx.fill();
    /* 每个点都要有轮廓，否则 0 值点在白底上直接消失，鞋垫看着像空的 */
    if (v > prBase()) {
      ctx.strokeStyle = 'rgba(120,60,10,.55)'; ctx.lineWidth = 1.4;
    } else {
      ctx.strokeStyle = '#d5dde7'; ctx.lineWidth = 1.2;
    }
    ctx.stroke();
    if (v >= prCap() * 0.999) { ctx.strokeStyle = '#7a1616'; ctx.lineWidth = 2.2; ctx.stroke(); }
    /* 点内写数值：颜色看大小，数字看具体值 */
    const lum0 = (v - prBase()) / prColorSpan();
    ctx.fillStyle = lum0 > 0.34 ? '#fff' : '#5b6a7d';
    const fs = Math.min(r * 0.95, (2 * r * 0.88) / (0.62 * Math.max(1, prLabel(v).length)));
    ctx.font = '700 ' + fs.toFixed(1) + 'px ui-monospace,Consolas,monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(prLabel(v), x, y + 0.5);
    if (i === ir.sel) {
      ctx.beginPath(); ctx.arc(x, y, r + 4.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#1971c2'; ctx.lineWidth = 2.4; ctx.stroke();
    } else if (i === ir.hover) {
      ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#94a3b3'; ctx.lineWidth = 1.6; ctx.stroke();
    }
  }
  ctx.textBaseline = 'alphabetic';
}

/* 只刷新色阶标注：统计与列表已去掉，界面只留鞋垫着色 + 实时波形 */
function prNums() {
  /* 色阶条按 prColor 逐段填色：用 CSS 渐变必然和 sqrt 归一化对不上，
     用户会看到"条上橙、图上黄"。20 段足够平滑，且永远和点位颜色同源。 */
function prScaleBar() {
  const el = $('prScaleBar');
  if (!el) return;
  const n = 20, stops = [];
  const span = prColorSpan(), base = prBase();
  for (let k = 0; k <= n; k++) stops.push(prColor(base + (span * k) / n) + ' ' + (k * 100 / n).toFixed(1) + '%');
  el.style.background = 'linear-gradient(90deg,' + stops.join(',') + ')';
}

/* 上限就是满量程本身：重量档 10000、ADC 档 4096。以前写成 base+span 会在重量档
     显示成 10,100 g -那个 100 是零点偏置，不属于量程。 */
  $('prScaleMax').textContent = fmtV(prColorSpan()) + ' ' + prU();
  prScaleBar();
  pwName();
}

function prReset(foot) {
  const st = irStates[foot || irActive];
  st.ps.fill(0);
  st.frame.fill(0);
  st.seen.fill(0);
  st.lastSeen.fill(NaN);
  st.prec.length = 0;
  for (const a of st.hist) a.length = 0;
  st.pHit = 0; st.pFrames = 0; st.pSkip = 0; st.pIds = '—'; st.tempRaw = null;
}

/* 记录只针对选中的这一个点：只导出它的时间序列，不做全 56 点的大表 */
function pwCsv() {
  if (!ir.pwRec.length) return;
  const pt = ir.pwRec[0].pt;
  const lines = ['time_s,point,row,slot,value_' + prU()];
  for (const r of ir.pwRec) {
    lines.push([r.t.toFixed(4), pt, r.row, r.slot, r.v].join(','));
  }
  download([lines.join('\r\n')], 'text/csv;charset=utf-8',
    (ir.foot === 'r' ? 'R' : 'L') + '_point' + pt + '_' + stampName(new Date()) + '.csv');
  log('已导出点 ' + pt + ' 的 ' + ir.pwRec.length + ' 行', 'i');
}

/* 点位命中：点内写了数字，但点很密，移上去还要能报出是哪个点 */
function irHitAt(e) {
  const box = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - box.left, y = e.clientY - box.top;
  let best = -1, bd = Infinity;
  for (const p of ir.hit) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= p.r * 1.9 && d < bd) { bd = d; best = p.i; }
  }
  return best;
}

/* 每套面板的控件各自绑定到各自那只脚：F 把事件处理切到这只脚再跑，
   命令直接传 st，另一只脚在途的命令不会被顶掉。 */
function irBindPanel(f) {
  const F = (fn) => (...a) => withFoot(f, () => fn(...a));
  const st = irStates[f];

  $('btnIrOff', f).onclick = () => irClose(f);
  $('btnIrCsv', f).onclick = F(irParquet);
  $('btnPwCsv', f).onclick = F(pwCsv);
  $('btnPwRec', f).onclick = F(() => {
    const i = ir.sel;
    if (i < 0) return log('先点一个点位再记录', 'w');
    ir.pwRecOn = !ir.pwRecOn;
    if (ir.pwRecOn) {
      ir.pwRec.length = 0;
      ir.pwRecPt = i;
      log('开始记录点 #' + (i + 1) + '（第 ' + IR_POS[i].row + ' 行）', 'i');
    } else {
      log('停止记录点 #' + (i + 1) + '，共 ' + ir.pwRec.length + ' 行，点「下载」导出', 'i');
    }
    pwName();
  });
  $('btnFmtRead', f).onclick = F(() => {
    const m = irLinkMode(f);
    log('回读设备状态（0x0D，' + (m === 'auto' ? '自动' : IR_LINK_NAME[m]) + '）…', 'i');
    irQueryState(st, false).catch((e) => log('回读不成功：' + (e.message || e)
      + (st.lastTx ? '｜TX ' + st.lastTx : ''), 'w'));
  });
  $('btnFmtSet', f).onclick = F(() => {
    const v = +$('dvFmt').value;
    log('写入输出格式：' + FMT_NAME[v] + '（0x10）…', 'i');
    irSetFmt(st, v).catch((e) => log('写入失败：' + (e.message || e) + (st.lastTx ? '｜TX ' + st.lastTx : ''), 'e'));
  });
  $('btnBiasReset', f).onclick = F(() => irBiasReset(st));
  $('dvLink', f).onchange = F(() => {
    const m = irLinkMode(f);
    if (m !== 'auto') st.link = m;
    log('命令帧：' + (m === 'auto' ? '自动（先 144 B，再试 80 B；两套都发，不靠回执剪枝）' : IR_LINK_NAME[m]), 'i');
  });
  $('prTopo', f).onchange = () => withFoot(f, () => {
    irBuildLut(f);
    prReset(f);
    irPressDraw(); prNums(); pwDraw();
  });

  $('irPress', f).addEventListener('click', F((e) => {
    const best = irHitAt(e);
    if (best >= 0) pwPick(best);
  }));
  $('irPress', f).addEventListener('mousemove', F((e) => {
    const i = irHitAt(e);
    ir.hover = i;
    $('irPress').style.cursor = i >= 0 ? 'pointer' : 'default';
    if (i >= 0) {
      $('prHover').hidden = false;
      $('prHover').textContent = '#' + (i + 1) + ' · ' + fmtV(prCur(i)) + ' ' + prU()
        + ' · 第 ' + IR_POS[i].row + ' 行';
    } else {
      $('prHover').hidden = true;
    }
    irPressDraw();
  }));
  $('irPress', f).addEventListener('mouseleave', F(() => {
    ir.hover = -1;
    $('prHover').hidden = true;
    irPressDraw();
  }));
}

/* 左右脚各渲染一份面板：模板里 id 的 -FT 后缀换成 -l / -r */
function irRenderPanels() {
  const tpl = $('irPanelTpl');
  const box = $('irPanels');
  if (!tpl || !box) return;
  for (const f of IR_SIDES) {
    const div = document.createElement('div');
    div.className = 'irpanel';
    div.dataset.f = f;
    div.innerHTML = tpl.innerHTML.replace(/-FT/g, '-' + f).replace(/\{FTNAME\}/g, f === 'r' ? '右脚' : '左脚');
    box.appendChild(div);
  }
}
