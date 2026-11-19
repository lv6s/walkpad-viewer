/* 手机原始通知复用既有解码与记录；分类和零偏以后台为准。 */
(() => {
  const bridge = window.phoneBridge = {
    enabled: false, session: null, cursor: 0, busy: false, snapshot: null,
    offset: null, devices: {}, clocks: {}, lastPoll: 0,
    renderActivity() {
      if (!this.enabled) return;
      const s = this.snapshot, r = s && s.result;
      const fresh = performance.now() - this.lastPoll < 1000;
      const valid = fresh && r && r.valid;
      $('btnActOn').disabled = $('btnActOff').disabled = true;
      $('actSource').disabled = $('actFsL').disabled = $('actFsR').disabled = true;
      if (s) $('actSource').value = s.profile;
      $('actWtPick').hidden = true;
      $('actSteps').textContent = s && s.decisions ? s.decisions.length : 0;
      $('actValid').textContent = s && s.decisions ? s.decisions.filter(d => d.valid).length : 0;
      $('actSent').textContent = s && s.diagnostics ? s.diagnostics.frames || 0 : 0;
      $('actDrop').textContent = s && s.diagnostics ? s.diagnostics.stale_network_events || 0 : 0;
      $('actState').textContent = fresh ? '手机后台推断' : '手机链路停更';
      $('actLabel').textContent = valid ? ACT_TEXT[r.label] : '—';
      $('actLabel').style.color = valid ? ACT_COLOR[r.label] : 'var(--mute)';
      $('actWhy').textContent = valid ? '手机采集 → 桌面推断 · ' + (r.quality_level || '有效') :
        (!fresh ? '等待手机新鲜数据' : ((ACT_REASON[r && r.reason] || (r && r.reason)) || '等待手机连接'));
      ACT_CLASSES.forEach((c, i) => {
        const p = valid && r.probabilities ? r.probabilities[i] : null;
        $('actBar' + i).style.width = p === null ? '0%' : (p * 100).toFixed(1) + '%';
        $('actBar' + i).style.background = ACT_COLOR[c];
        $('actPct' + i).textContent = p === null ? '—' : (p * 100).toFixed(1) + '%';
      });
      $('actSteps').title = $('actValid').title = '最近60次后台决策';
      $('actModel').textContent = '手机 ' + (s && s.profile === 'wt' ? 'WT · R1' : '自研鞋垫') + ' · 桌面模型';
      $('actAxis').textContent = '原始手机通知在电脑解码；零偏与在线处理只在后台计算，页面不重复估计。断流不沿用旧类别。';
      $('actLat').textContent = valid && Number.isFinite(r.latency_ms) ? r.latency_ms.toFixed(1) : '—';
      for (const f of ['l', 'r']) $('actFoot' + f.toUpperCase()).textContent = !s ? '等待手机' :
        (s.ready && s.ready[f] ? '零偏就绪' : (s.profile === 'wt' ? 'WT 接收时轴' : '等待零偏'));
      const hist = s && s.decisions;
      if (hist) act.hist = hist.slice(-ACT_HIST_N).map(d => d.valid ? d.label : '!');
      actHistDraw();
    }
  };
  const api = async path => {
    const r = await fetch('/phone/api/' + path, { cache: 'no-store', signal: AbortSignal.timeout(18000) });
    const v = await r.json();
    if (!r.ok) throw new Error(v.error || ('HTTP ' + r.status));
    return v;
  };
  const ms = n => Number.isFinite(n) ? n.toFixed(1) + ' ms' : '—';
  function resetViews() {
    bridge.devices = {}; bridge.clocks = {};
    for (const f of IR_SIDES) {
      const st = irStates[f];
      if (!st.remote) continue;
      clearInterval(st.timer); st.timer = 0; st.dev = null; st.remote = false;
      st.buf = new Uint8Array(); st.samples.length = 0; st.last = null;
    }
    for (const d of state.devices.values()) if (d.remote) d.connected = false;
    bridge.offset = null;
    irHead();
  }
  function syncBias(s) {
    for (const f of IR_SIDES) {
      const st = irStates[f], b = s.bias && s.bias[f];
      st.bias.ready = !!(b && b.ready);
      st.bias.g = b && b.gyro_bias_dps ? b.gyro_bias_dps.slice() : [0, 0, 0];
      st.bias.status = b ? b.status : '等待后台零偏';
      st.bias.still = b && b.candidate_frames || 0;
      irBiasText(st);
    }
  }
  function feed(e, meta) {
    const x = e.data, f = x.foot;
    if (e.type === 'stop') {
      if (state.recording) stopRec();
      resetViews(); return;
    }
    if (!IR_SIDES.includes(f)) return;
    if (e.type === 'connect') {
      bridge.devices['identity:' + f] = { connection: x.connection, name: x.name || '', address: x.address || '' };
      return;
    }
    if (e.type === 'disconnect') {
      if (meta.profile === 'insole') { irStates[f].dev = null; irStates[f].buf = new Uint8Array(); }
      else if (bridge.devices[f]) bridge.devices[f].connected = false;
      delete bridge.devices[f]; delete bridge.devices['identity:' + f]; delete bridge.clocks[f]; return;
    }
    if (e.type !== 'notify') return;
    const received = x.receipt_ms + bridge.offset;
    const raw = Uint8Array.from(atob(x.bytes), c => c.charCodeAt(0));
    if (meta.profile === 'insole') {
      const st = irStates[f];
      if (!st.remote || st.remoteConnection !== x.connection) {
        st.remote = true; st.remoteConnection = x.connection;
        const identity = bridge.devices['identity:' + f] || {};
        st.dev = { name: identity.name || ('手机 · ' + (f === 'l' ? '左脚' : '右脚')), id: identity.address || '', gatt: { connected: true } };
        st.buf = new Uint8Array(); st.samples.length = 0; st.frames = 0; st.last = null;
        st.t0 = 0; st.clk = irClkNew(); st.capI = irConnNew();
        st.info = '手机BLE原始通知 · 不支持网页发设备命令';
        prReset(f); clearInterval(st.timer); st.timer = setInterval(() => irTick(f), 100);
      }
      st.dev.gatt.connected = true;
      st.remoteReceipt = meta.desktop_receive_epoch_ms;
      const before = st.frames;
      irFeed(raw, f, received);
      if (st.frames > before && st.last && st.last.clk) {
        const diff = st.remoteReceipt - st.last.clk.epoch;
        const prev = bridge.clocks[f] && bridge.clocks[f].connection === x.connection ? bridge.clocks[f] : null;
        const jump = prev && (Math.abs((st.last.clk.epoch - prev.dev) - (received - prev.rx)) > 2000 ||
          Math.abs((st.remoteReceipt - prev.wall) - (received - prev.rx)) > 2000);
        const base = !prev || jump ? diff : Math.min(prev.base, diff);
        bridge.clocks[f] = { connection: x.connection, dev: st.last.clk.epoch, rx: received, base, apparent: diff,
          extra: diff - base, valid: !st.clk.coarse, wall: meta.desktop_receive_epoch_ms };
      }
    } else {
      let d = bridge.devices[f];
      if (!d || d.remoteConnection !== x.connection) {
        if (d) d.connected = false;
        const identity = bridge.devices['identity:' + f] || {};
        d = makeDevice({ key: 'phone:' + bridge.session + ':' + f + ':' + x.connection,
          name: identity.name || ('手机 WT ' + (f === 'l' ? '左脚' : '右脚')), device: { id: identity.address || '' } });
        d.remote = true; d.remoteConnection = x.connection; d.connected = true; bridge.devices[f] = d;
      }
      d.connected = true;
      onPacket(d, new DataView(raw.buffer), received);
    }
  }
  function lockControls() {
    const on = bridge.enabled;
    for (const id of ['btnAdd', 'btnReconn', 'btnDropAll', 'btnIrOn']) $(id).disabled = on;
    for (const d of state.devices.values()) if (d.remote && d.ui) {
      d.ui.tbtn.disabled = true;
      for (const b of d.ui.root.querySelectorAll('[data-act="info"], [data-act="swapmac"]')) b.disabled = true;
    }
    for (const f of IR_SIDES) for (const id of ['btnIrOff', 'btnFmtRead', 'btnFmtSet', 'btnBiasCal', 'btnBiasReset', 'irBiasMode']) {
      const el = $(id, f); if (el && on) el.disabled = true;
    }
  }
  function renderTiming(meta) {
    const t = meta.timing || {}, lines = [];
    lines.push('手机内转发等待（本批最新通知）：' + ms(t.phone_queue_latest_ms) + '；网络额外滞后（相对基线）：' + ms(t.network_excess_ms));
    if (meta.profile === 'insole') for (const f of IR_SIDES) {
      const c = bridge.clocks[f];
      lines.push((f === 'l' ? '左脚' : '右脚') + '：设备时间→电脑收包表观差 ' + (c && c.valid ? ms(c.apparent) : '不可用') +
        '；相对最低路径增加 ' + (c && c.valid ? ms(c.extra) : '—') +
        (c ? '；电脑收包 ' + new Date(c.wall).toLocaleTimeString('zh-CN', { hour12: false }) : ''));
    } else lines.push('WT：数据帧无设备发送时间戳，设备→电脑延迟不可测。');
    $('phoneTiming').textContent = lines.join(' ｜ ');
  }
  async function poll() {
    if (!bridge.enabled || bridge.busy) return;
    bridge.busy = true;
    try {
      const [meta, s] = await Promise.all([api('events?after=' + bridge.cursor + '&session=' + encodeURIComponent(bridge.session || '')), api('status?compact=1')]);
      if (!bridge.enabled) return;
      if (meta.session !== bridge.session || meta.gap) {
        if (state.recording) stopRec();
        resetViews(); bridge.session = meta.session; bridge.cursor = 0;
        log(meta.gap ? '手机显示缓存出现缺口；后台原始记录独立保存' : '手机采集会话切换', 'w');
      }
      if (meta.session !== s.session) return;
      bridge.snapshot = s; bridge.lastPoll = performance.now();
      if (Number.isFinite(meta.phone_now_ms) && bridge.offset === null) bridge.offset = performance.now() - meta.phone_now_ms;
      syncBias(s);
      for (const item of meta.events || []) {
        const e = item.event || item;
        if (e.id <= bridge.cursor) continue;
        feed(e, Object.assign({}, meta, item)); bridge.cursor = e.id;
      }
      if (meta.profile === 'insole' && !state.views.has('imur')) toggleView('imur');
      if (meta.profile === 'wt' && !state.views.has('grid')) toggleView('grid');
      if (!state.views.has('act')) toggleView('act');
      $('phoneStatus').textContent = s.session ? '手机已接入 · ' + (s.desktop_silence_ms || 0) + ' ms 未收新批次' : '等待手机开始采集';
      if (s.desktop_silence_ms === null || s.desktop_silence_ms > 1500) {
        for (const f of IR_SIDES) if (irStates[f].remote && irStates[f].dev) irStates[f].dev.gatt.connected = false;
        for (const d of state.devices.values()) if (d.remote) d.connected = false;
      }
      renderTiming(meta); irHead(); bridge.renderActivity(); lockControls();
    } catch (e) {
      $('phoneStatus').textContent = '手机桥接：' + e.message;
      for (const f of IR_SIDES) if (irStates[f].remote && irStates[f].dev) irStates[f].dev.gatt.connected = false;
      for (const d of state.devices.values()) if (d.remote) d.connected = false;
      bridge.snapshot = null; bridge.renderActivity();
    } finally { bridge.busy = false; }
  }
  $('captureSource').onchange = async () => {
    const on = $('captureSource').value === 'phone';
    if (state.recording) { $('captureSource').value = bridge.enabled ? 'phone' : 'direct'; return log('先停止记录再切换采集来源', 'w'); }
    const localConnected = [...state.devices.values()].some(d => d.connected && !d.remote) || IR_SIDES.some(f => irOnOf(f) && !irStates[f].remote);
    if (on && localConnected) { $('captureSource').value = 'direct'; return log('请先断开电脑直连设备，再选择手机来源', 'w'); }
    actStop('切换采集来源'); bridge.enabled = on;
    $('phonePanel').hidden = !on;
    if (!on) {
      resetViews();
      $('actFsL').disabled = $('actFsR').disabled = false;
      $('btnAdd').disabled = $('btnReconn').disabled = false;
      $('actSource').value = act.source;
      $('actWtPick').hidden = act.source !== 'wt';
      act.hist = []; actRender(); actInfo(); irHead(); return;
    }
    bridge.session = null; bridge.cursor = 0; bridge.snapshot = null;
    lockControls();
    try {
      const c = await api('config');
      $('phoneAddress').textContent = (c.addresses || []).map(ip => 'http://' + ip + ':' + c.port).join(' 或 ');
      $('phoneToken').textContent = c.token;
      await poll();
    } catch (e) { $('phoneStatus').textContent = e.message; }
  };
  $('phoneRelease').onclick = async () => {
    if (state.recording) return log('先停止记录再释放会话', 'w');
    if (!confirm('结束电脑对当前手机会话的接收？手机需要停止后重新开始采集。')) return;
    await fetch('/phone/api/release', { method: 'POST', headers: { 'X-Walkpad-Control': '1' } });
    resetViews(); bridge.session = null; bridge.cursor = 0; bridge.snapshot = null;
  };
  $('phoneExport').onclick = () => { location.href = '/phone/api/export'; };
  setInterval(() => { if (bridge.enabled) { poll(); lockControls(); bridge.renderActivity(); } }, 200);
})();
