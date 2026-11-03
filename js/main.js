/* 入口：事件绑定、主循环、启动引导、调试出口。 */

$('btnIrOn').onclick = () => irConnect(null);

/* ---------- 启动：先渲染两套面板，再各自建映射、绑定、初画 ---------- */
irRenderPanels();

for (const f of IR_SIDES) {
  irBuildLut(f);
  irFmtLoad(irStates[f]);
  irBindPanel(f);
}

/* 命令帧首选 144 B。早期版本在「无回执」时把 irCmdLink 记成 v1（80 B），但 80 B
   在这台设备上从未被证实有效 —— 那次「按压生效」其实是 144 B 那包起的作用，
   记忆值只是把无效的一套钉成了首选。所以这两个键作废并清掉，不按旧记忆走。 */
try {
  localStorage.removeItem('irCmdLink');
  localStorage.removeItem('ir.noAck');
  localStorage.removeItem('ir.fmt.written');   // 旧口径是 80 B 没生效时的假象，别沿用
} catch (e) { /* 忽略 */ }

for (const f of IR_SIDES) {
  irStates[f].link = 'v2';
  withFoot(f, () => {
    irPressDraw();
    prNums();
    pwName();
    pwDraw();
    irNums(null);
    irFmtText();
  });
}

irHead();

/* ---------- 主循环 ---------- */
let lastStat = 0, lastDraw = 0;

function loop() {
  const now = performance.now();

  let tEnd = 0;
  for (const d of state.devices.values()) {
    const a = d.samples;
    if (a.length && a[a.length - 1].t > tEnd) tEnd = a[a.length - 1].t;
  }
  state.tEnd = tEnd;

  if (now - lastDraw > 32) {           // 约 30 fps：跑动时曲线是平滑滑动，不是一格一格跳
    lastDraw = now;
    for (const k of state.order) {
      const d = state.devices.get(k);
      if (!d.ui) continue;
      const last = d.samples[d.samples.length - 1];
      drawGizmo(d.ui.giz, last && last.ang);
      drawDeviceChart(d);
    }
    if (state.mode === 'compare') drawCompare();
  }

  if (now - lastStat > 200) {
    lastStat = now;
    for (const d of state.devices.values()) {
      const arr = d.samples;
      const lt = arr.length ? arr[arr.length - 1].t : 0;
      const cut = lt - 1.0;
      let cnt = 0, alt = 0;
      for (let i = arr.length - 1; i >= 0 && arr[i].t >= cut; i--) { alt++; if (arr[i].acc) cnt++; }
      d.rate = cnt || alt;
      if (d.ui) {
        d.ui.meta.textContent = (d.connected || d.demo)
          ? d.rate + ' Hz · ' + d.frames + ' 帧 · ' + (lt ? lt.toFixed(1) + ' s' : '等数据')
          : (d.device ? '已断开' : '未连接');
        updateReadout(d);
        updateHead(d);
      }
    }
    const on = onlineCount();
    $('status').textContent = on ? ('采集中 · ' + on + ' 台') : '未连接';
    $('dot').classList.toggle('on', on > 0 && !state.recording);
    $('dot').classList.toggle('rec', state.recording);
    if (state.recording) $('status').textContent = '记录中 · ' + on + ' 台 · ' + state.rec.length + ' 行';
    updateBtns();
    if (state.recording) {
      $('recStat').textContent = '已录 ' + state.rec.length + ' 行 · ' +
        ((Date.now() - state.recT0Wall) / 1000).toFixed(0) + ' s · ' +
        (state.rec.length ? (state.rec.length / Math.max(1, (Date.now() - state.recT0Wall) / 1000)).toFixed(0) + ' 行/s' : '');
    } else {
      $('recStat').textContent = state.rec.length ? ('上次记录 ' + state.rec.length + ' 行，可导出') : '未记录';
    }
    if (state.mode === 'compare') renderLegend();
    const tk = new Set();
    for (const d of state.devices.values()) Object.keys(d.types).forEach((k) => tk.add(k));
    $('ftypes').textContent = tk.size ? [...tk].sort().join(' ') : '—';
  }

  requestAnimationFrame(loop);
}

window.addEventListener('resize', () => { lastDraw = 0; irDraw(); irPressDraw(); });

/* 启动 */
(async function boot() {
  syncGrid();
  requestAnimationFrame(loop);
  const qs = new URLSearchParams(location.search);
  const view = qs.get('view');
  if (view) {
    const b = document.querySelector('#segMode [data-m="' + view + '"]');
    if (b) b.click();
  }
  const demo = qs.get('demo');
  if (demo) return startDemo(+demo);
  log('页面已就绪。点「添加设备」逐台授权；下次可点「全部重连」直接恢复。', 'i');
  $('btnCamRot').textContent = '旋转 ' + cam.rot + '°';
  camList();
  if (navigator.bluetooth && navigator.bluetooth.getDevices) {
    try {
      const known = await navigator.bluetooth.getDevices();
      if (known.length) {
        log('检测到 ' + known.length + ' 台已授权设备，点「全部重连」即可连接', 'i');
        for (const dv of known) {
          log('　· ' + (dv.name || '?') + (macOf(dv) ? '(' + macOf(dv) + ')' : '') + '　连上后读 MAC', 'i');
        }
      }
    } catch {}
  }
})();

/* 调试钩子：供自动化核对导出格式 */
window.__wtDebug = { state, header: OFFICIAL_HEADER, build: buildTxt, names: exportNames, syncNames, macOf,
  parse, probe: probeInfo, readReg, regReply, setMac, line: officialLine,
  draw: drawDeviceChart, clear: clearData, toggleRec, stopRec, nice: niceUp,
  cam, camOpen, camClose, camProbe, camSetRot, camShot, camDrawRot, syncFps: syncFpsOptions,
  ir, irOn, irOnOf, irFeed, irFrame, irDraw, irNums, irParquet, irHead, irGone, irClose, isImurDev, setMode,
  irStates, irActive, setCur, withFoot, irRenderPanels, irBindPanel, irNewState, IR_SIDES, footFromName,
  irFramesRows, irParquetBuffer, irParquetColumns,
  irTick, irRedraw, irBiasTrack, irBiasReset, irBiasText,
  IR_POS, prColor, prCur, prLabel, irPressDraw, prNums, prReset, irLut, irBuildLut, IR_RAW_V1, IR_RAW_V2, irCrcOk,
  pwDraw, pwPush, pwPick, prFmt, prBase, prSpan, prU, pwName, PR_IDLE,
  irCmd, irCrcAck, irCrcIbm, irAck, irState, irStateText, irQueryState, irSetFmt, irSend, irWrite, irFmtText,
  irProbe, irLinkMode, hexOf, IR_LINK_NAME, IR_LOOSE_SIZE, FMT_KEY, irFmtLoad, irFmtSave, irSniff, irRxHint,
  FMT_NAME, FMT_UNIT,
  REG: { MAC: REG_MAC, BATT: REG_BATT, VER: REG_VER } };
