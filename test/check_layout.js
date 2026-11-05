/*
 * 布局回归：摄像头竖画面与单台设备并排时，第二列应收到画面宽度，
 * 画面两侧不再留大片空白，且卡片高度不会随测量反复自增。
 *
 *   node test/check_layout.js [宽] [高]
 *
 * 需要带 --remote-debugging-port=9333 的浏览器打开 ?demo=1 的页面。
 */
const cdp = require('./cdp');

const W = +(process.argv[2] || 1920);
const H = +(process.argv[3] || 1080);
const DEMO = +(process.argv[4] || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 页面里量一遍关键盒子 */
const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const box = (e) => { const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; };
  const dev = q('#devGrid > .dev');
  const card = q('#camCard'), wrap = q('#camVideo').parentNode;
  const ar = camAspect();
  const wr = box(wrap);
  return {
    cols: getComputedStyle(q('#stage')).gridTemplateColumns,
    withcam: q('#stage').classList.contains('withcam'),
    camVar: q('#stage').style.getPropertyValue('--cam-col') || null,
    ar: +ar.toFixed(4),
    card: box(card), wrap: wr,
    /* 画面在 wrap 里 object-fit:contain 后的实际显示尺寸 */
    pic: { w: Math.round(Math.min(wr.w, wr.h * ar)), h: Math.round(Math.min(wr.h, wr.w / ar)) },
    dev: dev ? box(dev) : null,
  };
})()`;

(async () => {
  const c = await cdp.connect();
  const out = [];
  const say = (s) => { out.push(s); console.log(s); };
  try {
    /* 每次都从干净页面起：上一次跑留在页面里的 cam.real 会让开流前的比例判断失真 */
    const base = await c.evalJSON('(() => location.origin + location.pathname)()');
    await c.send('Page.navigate', { url: base + (DEMO ? '?demo=' + DEMO : '') });
    await sleep(2200);

    await c.send('Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await sleep(400);

    /* 有模拟设备就并排看设备 + 摄像头；没有就只开摄像头（测独占整行） */
    await c.evalJSON('(() => { state.views = new Set(' + (DEMO ? "['grid','cam']" : "['cam']")
      + '); syncViewBtns(); applyViews(); return 1; })()');
    await sleep(300);

    let r = await c.evalJSON(MEASURE);
    say('— 开流前：cols=' + r.cols + ' withcam=' + r.withcam + ' dev=' + JSON.stringify(r.dev));

    /* 开摄像头（无头下用 fake device，640×480 横画面） */
    await c.evalJSON("(() => { document.querySelector('#btnCamOn').click(); return 1; })()");
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      const ok = await c.evalJSON("!!(cam.stream && cam.real)");
      if (ok) break;
    }
    r = await c.evalJSON(MEASURE);
    say('— 横画面 ' + r.ar + '：withcam=' + r.withcam + '（应 false）cols=' + r.cols);
    say('  卡 ' + JSON.stringify(r.card) + ' 画面 ' + JSON.stringify(r.pic) + ' 设备 ' + JSON.stringify(r.dev));

    /* 换成竖画面：模组竖装时浏览器报的就是这个形状 */
    await c.evalJSON("cam.real = {w:1080, h:1920}, cam.rot = 0, camFit(), 1");
    await sleep(400);
    r = await c.evalJSON(MEASURE);
    say('— 竖画面 ' + r.ar + '：withcam=' + r.withcam + '（应 true）');
    say('  cols=' + r.cols + ' --cam-col=' + r.camVar);
    say('  卡 ' + JSON.stringify(r.card) + ' 画面 ' + JSON.stringify(r.pic) + ' 设备 ' + JSON.stringify(r.dev));
    const gapL = r.pic.w && r.card ? r.card.w - r.pic.w : 0;
    say('  画面两侧合计留白 ' + gapL + 'px（含卡片内边距 28）');
    const dev = r.dev;
    if (dev) say('  卡片等高：设备下沿 ' + (dev.y + dev.h) + ' / 摄像头下沿 ' + (r.card.y + r.card.h));

    /* 高度漂移：连量三次，卡高与画面必须稳定 */
    const hs = [];
    for (let i = 0; i < 3; i++) {
      /* 触发一次重绘路径，模拟主循环反复 fit */
      await c.evalJSON('(() => { camFit(); return 1; })()');
      await sleep(250);
      const m = await c.evalJSON(MEASURE);
      hs.push(m.card.h + '/' + m.pic.w + '×' + m.pic.h);
    }
    say('— 三次 camFit 后：' + hs.join('  '));

    const errs = c.errors();
    say('— 脚本错误：' + (errs.length ? errs.join(' | ') : '无'));
  } finally {
    c.close();
  }
})();
