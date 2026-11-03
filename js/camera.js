/* 摄像头：取流、画中画、录像、能力探针。 */

async function camList(prefer) {
  const box = $('camDev');
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let list = [];
  try { list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (e) { return; }
  const cur = prefer || box.value || cam.devId;
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<option value="">未发现摄像头</option>'; return; }
  list.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || ('摄像头 ' + (i + 1));   // 未授权时 label 为空，授权后自动补上
    box.append(o);
  });
  if (cur && [...box.options].some((o) => o.value === cur)) box.value = cur;
  syncFpsOptions(true);
}

/* 帧率下拉按实测能力联动：某分辨率探测过，就只留设备真给得出的帧率。
   浏览器不告诉我们合法组合，只能把「测过的」记下来；没测过的档位只按能力上限粗筛。 */
function camCapsAll() {
  try { return JSON.parse(localStorage.getItem('wt901.camcaps') || '{}') || {}; } catch (e) { return {}; }
}

function camCapsKey(id) { return id || 'default'; }

function camCapsGet(id, res) {
  const all = camCapsAll();
  return (all[camCapsKey(id)] || {})[res] || null;
}

function camCapsSet(id, res, val) {
  const all = camCapsAll();
  const k = camCapsKey(id);
  (all[k] = all[k] || {})[res] = val;
  try { localStorage.setItem('wt901.camcaps', JSON.stringify(all)); } catch (e) { /* 存不下就算了 */ }
}

function syncFpsOptions(quiet) {
  const sel = $('camFps');
  const res = $('camRes').value;
  const known = res ? camCapsGet($('camDev').value || cam.devId, res) : null;
  const allow = known && known.fps && known.fps.length ? known.fps : null;
  const capMax = cam.caps && cam.caps.frameRate ? cam.caps.frameRate.max : 0;
  for (const o of sel.options) {
    const v = +o.value;
    if (!v) { o.disabled = false; o.textContent = '帧率自动'; continue; }
    const bad = allow ? allow.indexOf(v) < 0 : (capMax ? v > capMax + 0.5 : false);
    o.disabled = bad;
    o.textContent = v + ' fps' + (bad ? (allow ? '（该分辨率给不出）' : '（超设备上限）')
      : (known && known.exact === false && allow ? '（自报）' : ''));
  }
  const cur = +sel.value;
  const curOpt = [...sel.options].find((o) => +o.value === cur);
  if (cur && curOpt && curOpt.disabled) {
    const nv = allow ? String(Math.max.apply(null, allow)) : '0';
    sel.value = nv;
    if (!quiet) log('该分辨率下 ' + cur + ' fps 设备给不出来，帧率已改成 ' + (nv === '0' ? '自动' : nv + ' fps'), 'i');
  }
  return sel.value;
}

/* 轨道报的尺寸未必等于解码出来的帧：模组竖装、驱动内部旋转都会让两者对不上，比例以帧为准 */
function camFrameCheck(tries) {
  if (!cam.stream) return;
  const vid = $('camVideo');
  const vw = vid.videoWidth, vh = vid.videoHeight;
  if (!vw || !vh) {
    if ((tries || 0) < 40) setTimeout(() => camFrameCheck((tries || 0) + 1), 120);
    return;
  }
  cam.real = { w: vw, h: vh };
  const st = cam.stream.getVideoTracks()[0].getSettings() || {};
  if (st.width && (st.width !== vw || st.height !== vh)) {
    log('实际帧 ' + vw + '×' + vh + '，与轨道上报的 ' + st.width + '×' + st.height
      + ' 不一致（模组竖装或驱动内部做了旋转/裁剪），画面比例与录像尺寸都以实际帧为准', 'w');
  }
  if (vh > vw) {
    const pick = /^(\d+)x(\d+)$/.exec($('camRes').value || '');
    if (pick && +pick[1] < +pick[2]) {
      log('选的就是竖拍档 ' + vw + '×' + vh + '：画面竖是设备原生方向，不是显示错。要横画面请在分辨率里选宽大于高的档（这套设备有 3840×2160 / 1920×1080）', 'i');
    } else {
      log('实际帧是竖的 ' + vw + '×' + vh + '（选的档位是横的，设备却给了竖帧）：点「旋转 90°」摆正，拍照和录像会一起转', 'i');
    }
  }
  camTick();
}

function camTick() {
  if (!cam.stream) return;
  const t = cam.stream.getVideoTracks()[0].getSettings() || {};
  const r = cam.real;
  let s = '预览 ' + (r ? r.w + '×' + r.h : (t.width || '?') + '×' + (t.height || '?'));
  if (r && (r.w !== t.width || r.h !== t.height)) s += '（轨道 ' + t.width + '×' + t.height + '）';
  s += ' · ' + (cam.fps || 0) + ' fps';
  if (cam.rec) {
    const sec = (Date.now() - cam.t0) / 1000;
    /* mp4 muxer 到停止才吐数据，录中拿不到真实字节；显示体积只会误导，只报时长。
       1.5 GB 保护按设定码率保守估算。 */
    s += ' · 录制 ' + fmtDur(sec);
    if (cam.bps && sec * cam.bps / 8 > 1.5e9) { log('录像按码率估算已超 1.5 GB，自动停止（避免内存耗尽）', 'w'); camStopRec(); }
  }
  $('camStat').textContent = s;
}

function camMeter() {
  const vid = $('camVideo');
  cam.frames = 0; cam.fpsT = performance.now();
  if (vid.requestVideoFrameCallback) {
    const step = () => { cam.frames++; cam.vfc = vid.requestVideoFrameCallback(step); };
    cam.vfc = vid.requestVideoFrameCallback(step);
  }
  clearInterval(cam.timer);
  cam.timer = setInterval(() => {
    const now = performance.now(), dt = (now - cam.fpsT) / 1000;
    if (dt >= 1) { cam.fps = Math.round(cam.frames / dt); cam.frames = 0; cam.fpsT = now; }
    camTick();
  }, 500);
}

/* ---------- 画面旋转：预览/拍照/录像共用一个绘制函数 ---------- */
/* 把 video 当前帧按 cam.rot（顺时针）画进目标 canvas，返回是否画成 */
function camDrawRot(c) {
  const vid = $('camVideo');
  const vw = vid.videoWidth, vh = vid.videoHeight;
  if (!vw || !vh) return false;
  const swap = cam.rot === 90 || cam.rot === 270;
  const cw = swap ? vh : vw, ch = swap ? vw : vh;
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  const g = c.getContext('2d');
  g.save();
  g.translate(cw / 2, ch / 2);
  g.rotate(cam.rot * Math.PI / 180);      // canvas 的 y 轴朝下，正角度即为顺时针
  g.drawImage(vid, -vw / 2, -vh / 2, vw, vh);
  g.restore();
  return true;
}

/* 只有旋转不为 0 时才需要逐帧重绘（旋转 0 直接让 video 自己显示，零开销） */
function camLoopOn() {
  const wrap = $('camVideo').parentNode;
  wrap.classList.toggle('rot', !!cam.rot);
  $('btnCamRot').textContent = '旋转 ' + cam.rot + '°';
  if (!cam.rot) { camLoopOff(); return; }
  if (cam.raf) return;
  const step = () => {
    if (!cam.stream) { cam.raf = 0; return; }
    camDrawRot($('camCanvas'));
    cam.raf = requestAnimationFrame(step);
  };
  cam.raf = requestAnimationFrame(step);
}

function camLoopOff() {
  if (cam.raf) cancelAnimationFrame(cam.raf);
  cam.raf = 0;
}

function camSetRot() {
  cam.rot = (cam.rot + 90) % 360;
  localStorage.setItem('wt901.camrot', String(cam.rot));
  camLoopOn();
  log('画面旋转 ' + cam.rot + '°' + (cam.rec ? '（正在录像：本次录像内部转向会变，建议停掉重录）' : ''), cam.rec ? 'w' : 'i');
}

/* 改设备/分辨率/帧率后自动重开；录像中先拦下来，避免把片子切断 */
/* 摄像头状态。rot 从本地读上次的旋转角，免得每次重设。 */
const cam = {
  stream: null, devId: '', rec: null, chunks: [], bytes: 0, auto: false,
  t0: 0, name: '', mime: '', blob: null, url: '',
  frames: 0, fps: 0, fpsT: 0, vfc: 0, timer: 0,
  rot: +(localStorage.getItem('wt901.camrot') || 0) || 0,
  raf: 0, opening: false, caps: null, srcClose: null, bps: 0, real: null
};

let camCfgTimer = 0;

function camCfgChanged() {
  clearTimeout(camCfgTimer);
  camCfgTimer = setTimeout(() => {
    if (!cam.stream) return;                        // 没开流：改了就记着，点「开启」时用
    if (cam.rec) return log('正在录像：切换设备/分辨率/帧率会中断录像，请先「停止录像」，之后再改会自动生效', 'w');
    log('配置已改，重新打开摄像头…', 'i');
    camOpen();
  }, 120);
}

/* 权限被「阻止」后浏览器不再弹窗，只能人工改回；这里只提示，改不了 */
async function camPermNote() {
  if (!navigator.permissions || !navigator.permissions.query) return;
  let p;
  try { p = await navigator.permissions.query({ name: 'camera' }); } catch (e) { return; }
  if (p.state !== 'denied' || cam.stream) return;
  $('camStat').textContent = '摄像头权限已被阻止：点地址栏左侧站点图标 → 摄像头「允许」→ F5 刷新';
  log('当前站点（' + location.origin + '）的摄像头权限是「已阻止」，点开启不会再弹窗，需按上面提示手动改回「允许」后刷新', 'e');
}

/* 改下拉会自动重开，可能连发多次；同一时刻只允许一次取流 */
async function camOpen() {
  if (cam.opening) return;
  cam.opening = true;
  try { await camOpenStream(); } finally { cam.opening = false; }
}

async function camOpenStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return log('这个环境没有摄像头接口：请用「打开IMU页面.bat」的 http://127.0.0.1:8765 打开，别直接双击 html', 'e');
  }
  if (cam.stream) camClose(true);
  const id = $('camDev').value;
  const [w, h] = ($('camRes').value || '').split('x').map(Number);
  const f = +$('camFps').value || 0;
  const v = {};
  if (id) v.deviceId = { exact: id };
  if (w && h) { v.width = { ideal: w }; v.height = { ideal: h }; }
  if (f) v.frameRate = { ideal: f };
  let st;
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
  } catch (e) {
    cam.stream = null;
    const nm = (e && e.name) || String(e);
    $('camStat').textContent = '开启失败：' + nm;
    log('摄像头开启失败：' + (e && e.message || e), 'e');
    if (nm === 'NotAllowedError' || nm === 'SecurityError') {
      const org = location.origin;
      log('权限被拦住了。点地址栏左侧的站点图标（' + org + '）→ 把「摄像头」改成「允许」→ 按 F5 刷新再点开启。浏览器不会再自己弹第二次窗。', 'e');
      log('那里找不到摄像头项时：设置 → Cookie 和网站权限 → 摄像头 → 在「不允许使用」列表里删掉 ' + org + '（或加进「允许」）。', 'i');
    } else if (nm === 'NotFoundError' || nm === 'OverconstrainedError') {
      log('没有匹配的设备：分辨率改「自动」，设备下拉选回实际那台。', 'e');
    } else if (nm === 'NotReadableError') {
      log('设备被别的程序占着（官方上位机 / 相机 App / 会议软件），先关掉它们再试。', 'e');
    }
    return;
  }
  const vid = $('camVideo');
  vid.srcObject = cam.stream;
  try { await vid.play(); } catch (e) { /* 自动播放被拦也不影响取流 */ }
  const tr = cam.stream.getVideoTracks()[0];
  st = tr.getSettings() || {};
  cam.caps = (tr.getCapabilities && tr.getCapabilities()) || null;
  cam.devId = st.deviceId || id;
  $('camHint').classList.add('hide');
  $('btnCamOn').disabled = true; $('btnCamOff').disabled = false;
  $('btnCamRec').disabled = false; $('btnCamShot').disabled = false;
  const cap = cam.caps;
  log('摄像头已开启：轨道 ' + (st.width || '?') + '×' + (st.height || '?') + ' @ ' + Math.round(st.frameRate || 0) + ' fps'
    + (cap && cap.width ? '；驱动给的尺寸上限是 W≤' + cap.width.max + '、H≤' + cap.height.max
      + '（两个数各自独立，不代表支持 ' + cap.width.max + '×' + cap.height.max + ' 这种组合）'
      + (cap.frameRate ? '，帧率上限 ' + cap.frameRate.max + ' fps' : '') : '；驱动未上报尺寸上限'), 'i');
  if (w && h && (st.width !== w || st.height !== h)) {
    log('注意：选的是 ' + w + '×' + h + '，设备实际只给 ' + st.width + '×' + st.height + '（约束是 ideal，给不到会自动降级）', 'w');
  }
  if (f && Math.abs((st.frameRate || 0) - f) > 3) {
    log('注意：选的是 ' + f + ' fps，实际 ' + Math.round(st.frameRate || 0) + ' fps（该分辨率下设备多半只支持到这么多）', 'w');
  }
  camMeter();
  camFrameCheck(0);
  camList(cam.devId);
  camLoopOn();
}

function camClose(silent) {
  if (cam.rec) camStopRec();
  camLoopOff();
  clearInterval(cam.timer); cam.timer = 0;
  if (cam.vfc) { try { $('camVideo').cancelVideoFrameCallback(cam.vfc); } catch (e) {} cam.vfc = 0; }
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  cam.real = null;
  $('camVideo').srcObject = null;
  const cc = $('camCanvas');
  if (cc.width) cc.getContext('2d').clearRect(0, 0, cc.width, cc.height);
  $('camHint').classList.remove('hide');
  $('btnCamOn').disabled = false; $('btnCamOff').disabled = true;
  $('btnCamRec').disabled = true; $('btnCamShot').disabled = true;
  if (!silent) $('camStat').textContent = '未开启';
}

function camStartRec(auto) {
  if (!cam.stream || cam.rec) return;
  if (!window.MediaRecorder) return log('这个浏览器不支持录像（没有 MediaRecorder）', 'e');
  const mime = CAM_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const st = cam.stream.getVideoTracks()[0].getSettings() || {};
  const bps = Math.round(Math.min(12e6, Math.max(2.5e6, (st.width || 1280) * (st.height || 720) * 5)));
  /* 旋转过就必须录画布通道，否则文件里还是歪的；没旋转直接录原始流，零额外开销 */
  let src = cam.stream, srcClose = null;
  if (cam.rot) {
    const c = $('camCanvas');
    camDrawRot(c);                                   // 先画一帧，避免首帧黑
    src = c.captureStream(Math.max(15, Math.min(60, cam.fps || 30)));
    srcClose = () => src.getTracks().forEach((t) => t.stop());
    log('旋转 ' + cam.rot + '°：录像走画布通道（多占一点 CPU，且页面切到后台时浏览器会暂停重绘）', 'w');
  }
  cam.srcClose = srcClose;
  const tryRec = (mt) => new MediaRecorder(src, mt ? { mimeType: mt, videoBitsPerSecond: bps } : { videoBitsPerSecond: bps });
  try {
    cam.rec = tryRec(mime);
  } catch (e) {
    /* 声明支持却构造不出来（少见：奇数宽高、硬编被占）：退回 WebM，别整个录不了 */
    const fb = CAM_MIMES.filter((m) => m.indexOf('mp4') < 0).find((m) => MediaRecorder.isTypeSupported(m)) || '';
    try {
      cam.rec = tryRec(fb);
      log('MP4 用不了（' + (e.message || e) + '），改用 ' + describeMime(fb), 'w');
    } catch (e2) {
      try { cam.rec = new MediaRecorder(src); }
      catch (e3) { srcClose && srcClose(); log('这个浏览器录不了：' + (e3.message || e3), 'e'); return; }
    }
  }
  cam.mime = cam.rec.mimeType || mime || 'video/webm';
  cam.bps = bps;
  const ext = cam.mime.indexOf('mp4') >= 0 ? '.mp4' : '.webm';
  cam.chunks = []; cam.bytes = 0; cam.t0 = Date.now(); cam.auto = !!auto;
  cam.name = 'cam_' + stampName(new Date()) + ext;
  $('camFile').textContent = '';
  cam.rec.onerror = (e) => {
    const err = (e && e.error) || {};
    log('录像中断：' + (err.name || 'Error') + ' ' + (err.message || '') + '（格式 ' + describeMime(cam.mime) + '，已存下的部分仍可下载）', 'e');
    camStopRec();
  };
  cam.rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    cam.chunks.push(e.data);
    cam.bytes += e.data.size;
    if (cam.bytes > 1.5e9) { log('录像已超 1.5 GB，自动停止（避免内存耗尽）', 'w'); camStopRec(); }
  };
  cam.rec.onstop = async () => {
    const sec = (Date.now() - cam.t0) / 1000;
    let blob = new Blob(cam.chunks, { type: cam.mime });
    cam.chunks = [];
    if (cam.mime.indexOf('mp4') >= 0) {
      try { blob = await fixMp4Duration(blob, sec); }
      catch (e) { log('修正 mp4 时长失败（能播，但播放器可能显示 0 秒）：' + (e.message || e), 'w'); }
    }
    cam.blob = blob;
    if (cam.url) URL.revokeObjectURL(cam.url);
    cam.url = URL.createObjectURL(blob);
    $('btnCamDl').disabled = false;
    $('btnCamRec').textContent = '● 开始录像'; $('btnCamRec').classList.remove('on');
    $('camFile').textContent = cam.name + ' · ' + fmtDur(sec) + ' · ' + fmtSize(blob.size) + '（点「下载录像」保存）';
    log('录像完成 ' + cam.name + '，' + fmtDur(sec) + '，' + fmtSize(blob.size) + '　' + describeMime(cam.mime), 'i');
    if (cam.srcClose) { cam.srcClose(); cam.srcClose = null; }
    cam.rec = null; cam.auto = false;
    camTick();
  };
  cam.rec.start(1000);                     // 每秒切块：便于统计体积、及时触发超限保护
  $('btnCamRec').textContent = '■ 停止录像'; $('btnCamRec').classList.add('on');
  log('开始录像 ' + cam.name + (auto ? '（跟随 IMU 记录）' : ''), 'i');
  camTick();
}

function camStopRec() {
  if (!cam.rec) return;
  try { cam.rec.stop(); } catch (e) {}
}

function camShot() {
  if (!$('camVideo').videoWidth) return log('还没有画面，等预览出来再拍', 'w');
  const c = document.createElement('canvas');
  if (!camDrawRot(c)) return log('抓不到画面帧，等预览稳定后再试', 'w');
  const name = 'cam_' + stampName(new Date()) + '.png';
  c.toBlob((b) => {
    download([b], 'image/png', name);
    log('已保存照片 ' + name + '（' + c.width + '×' + c.height + '）', 'i');
  }, 'image/png');
}

/* ---------- 能力探测：浏览器只报上限，具体档位只能逐档 exact 试 ---------- */
const CAM_PROBE_RES = [[640, 480], [800, 600], [960, 540], [1280, 720], [1280, 960], [1920, 1080], [2560, 1440], [3840, 2160], [2160, 3840]];

const CAM_PROBE_FPS = [60, 30, 15];

function markResOptions(res) {
  const sel = $('camRes');
  /* 浏览器不枚举合法组合，试通了才知道有；探测到的档位补进下拉 */
  for (const r of res) {
    const v = r.w + 'x' + r.h;
    if ([...sel.options].some((o) => o.value === v)) continue;
    const o = document.createElement('option');
    o.value = v;
    o.textContent = r.w + '×' + r.h;
    const after = [...sel.options].find((x) => {
      const m = /^(\d+)x(\d+)$/.exec(x.value);
      return m && +m[1] * +m[2] > r.w * r.h;
    });
    sel.insertBefore(o, after || null);
  }
  for (const o of sel.options) {
    const m = /^(\d+)x(\d+)$/.exec(o.value);
    if (!m) continue;
    o.textContent = m[1] + '×' + m[2];
    const r = res.find((x) => x.w === +m[1] && x.h === +m[2]);
    if (r) o.textContent += r.ok ? ' ✓' : ' ✗ 会降级';
  }
}

async function camProbe() {
  const btn = $('btnCamProbe');
  if (btn.disabled) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return log('这个环境没有摄像头接口', 'e');
  if (cam.rec) return log('正在录像，先停止再测', 'w');
  btn.disabled = true;
  const wasOpen = !!cam.stream;
  const id = $('camDev').value || cam.devId;
  if (cam.stream) camClose(true);
  const base = id ? { deviceId: { exact: id } } : {};
  const open = (extra) => navigator.mediaDevices.getUserMedia({ video: Object.assign({}, base, extra), audio: false });
  /* 个别驱动/虚拟设备对不支持的 exact 组合既不 resolve 也不 reject，会一直挂着；超时就放弃并释放迟到的流 */
  const openTimed = (extra, ms) => new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('TIMEOUT')); } }, ms || 3000);
    open(extra).then((s) => {
      if (done) { setTimeout(() => s.getTracks().forEach((t) => t.stop()), 0); return; }
      done = true; clearTimeout(timer); resolve(s);
    }, (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
  const stop = (s) => s && s.getTracks().forEach((t) => t.stop());
  const gap = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let caps = null, def = null;
    try {
      const s = await openTimed({});
      const t = s.getVideoTracks()[0];
      caps = (t.getCapabilities && t.getCapabilities()) || null;
      def = t.getSettings();
      stop(s);
    } catch (e) {
      log('探测开头就开不了流：' + (e.message || e), 'e');
      return;
    }
    await gap(180);                                  // 等驱动释放，紧接着再开会报 NotReadableError
    const maxW = caps && caps.width ? caps.width.max : 1920;
    const maxH = caps && caps.height ? caps.height.max : 1080;
    const maxF = caps && caps.frameRate ? caps.frameRate.max : 30;
    log('上报能力：默认 ' + def.width + '×' + def.height + ' @ ' + Math.round(def.frameRate || 0) + ' fps；'
      + '驱动只给了宽高各自的上限 W≤' + maxW + '、H≤' + maxH + '，合法组合要逐档试', 'i');
    const res = [];
    let strikes = 0;
    for (const [w, h] of CAM_PROBE_RES) {
      if (w > maxW || h > maxH) continue;
      if (strikes >= 2) { log('设备连续不应答，探测中断（剩下的档位没测）', 'w'); break; }
      $('camStat').textContent = '探测中… ' + w + '×' + h + '（会反复开关摄像头，别切走页面）';
      let ok = false, tout = false;
      const fps = [];
      for (const f of CAM_PROBE_FPS) {
        if (f > maxF + 0.5) continue;
        try {
          const s = await openTimed({ width: { exact: w }, height: { exact: h }, frameRate: { exact: f } });
          stop(s); ok = true; fps.push(f);
          await gap(120);
        } catch (e) {
          if (e && e.message === 'TIMEOUT') { tout = true; break; }   // 驱动不应答，同档剩下的组合也别等了
        }
      }
      if (!ok && !tout) {                            // 有的驱动不吃 exact 帧率，放开帧率再试一次分辨率
        try {
          const s = await openTimed({ width: { exact: w }, height: { exact: h } });
          const t = s.getVideoTracks()[0].getSettings();
          stop(s); ok = true;
          fps.push('~' + Math.round(t.frameRate || 0));
          await gap(120);
        } catch (e) {
          if (e && e.message === 'TIMEOUT') tout = true;
        }
      }
      strikes = tout ? strikes + 1 : 0;
      const nums = fps.map((x) => (typeof x === 'number' ? x : +String(x).replace('~', ''))).filter((x) => x > 0);
      if (ok && nums.length) camCapsSet(id, w + 'x' + h, { fps: nums, exact: !fps.some((x) => typeof x === 'string') });
      res.push({ w, h, ok, fps: nums });
      log('　' + (ok ? '✓ ' : '✗ ') + w + '×' + h + (ok && fps.length ? '：' + fps.join(' / ') + ' fps' : (tout ? '：设备无应答' : '')), ok ? 'i' : 'w');
    }
    markResOptions(res);
    syncFpsOptions();
    log('探测结束。下拉里带「✗ 会降级」的档位设备给不出原尺寸，选它只会拿到别的分辨率；带「~」的帧率是设备自报，不是精确匹配到的', 'i');
    if (res.length && res.every((r) => !r.ok)) log('一档都没测到：摄像头可能被别的程序独占，先关掉官方上位机/相机 App', 'e');
  } finally {
    btn.disabled = false;
    $('camStat').textContent = wasOpen ? '探测完成，正在恢复预览…' : '探测完成';
    if (wasOpen) camOpen();
  }
}

$('btnCamOn').onclick = camOpen;

$('btnCamOff').onclick = () => camClose(false);

$('btnCamRec').onclick = () => (cam.rec ? camStopRec() : camStartRec(false));

$('btnCamShot').onclick = camShot;

$('btnCamProbe').onclick = camProbe;

$('btnCamRot').onclick = camSetRot;

['camRes', 'camDev'].forEach((id) => { $(id).onchange = () => { syncFpsOptions(); camCfgChanged(); }; });

$('camFps').onchange = camCfgChanged;

$('btnCamDl').onclick = () => {
  if (!cam.blob) return;
  download([cam.blob], cam.mime, cam.name);
  $('camFile').textContent = cam.name + ' · ' + fmtSize(cam.blob.size) + '（已保存到下载目录）';
};
