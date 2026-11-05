/*
 * 状态推断页面的接线检查：视图切换、模型信息、事件→推理→显示，
 * 以及「零偏未就绪」「缺一只脚」「时间倒退」三条失败路径。
 *
 * 推断的输入是扣过零偏的角速度，所以喂帧时必须带上已就绪的 bias，
 * 否则页面按设计拒收——那不是 bug，缺了就测不到正常链路。
 *
 * 需要先起服务（python serve_page.py 8799）与带调试端口的浏览器：
 *   msedge --headless=new --remote-debugging-port=9334 \
 *          --user-data-dir=%TEMP%\edge-act "http://127.0.0.1:8799/wt901ble_live.html?view=act"
 *   CDP_PORT=9334 node test/check_activity_live.js
 */
const cdp = require('./cdp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log('PASS ' + name);
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}

/* 2.5 s 的合成步行：不是真数据，只用来打通链路，标签不参与断言。
   直接改页面里的 irStates，不另外造 st：推断的就绪判定和喂帧读的是同一份状态。
   gx 与 gx0 故意不同，用来验证送出去的是扣偏后的那个。 */
function feed(foot, n, phase, ready = true) {
  return `(() => {
    const feet = Array.isArray(${JSON.stringify(foot)}) ? ${JSON.stringify(foot)} : [${JSON.stringify(foot)}];
    const n = ${n}, phase = ${phase}, ready = ${ready};
    for (const foot of feet) {
      const st = __wtDebug.irStates[foot];
      st.dev = st.dev || { fake: 1 };
      st.rate = 50;
      st.bias.ready = ready;
      st.bias.g = [0, 0, 0];
      st.bias.still = ready ? 50 : 0;
      for (let i = 0; i < n; i++) {
        const t = i / 50, w = 2 * Math.PI * 1.8 * t + (feet.length > 1 && foot === 'r' ? Math.PI : phase);
        __wtDebug.actFeed(st, {
          perf: 1000 + i * 20,
          ax: 0.6 * Math.sin(w), ay: 0.15 * Math.sin(2 * w), az: 1 + 0.3 * Math.sin(2 * w),
          gx: 20 * Math.sin(w), gy: 120 * Math.sin(w), gz: 15 * Math.sin(2 * w),
          gx0: 999 * Math.sin(w), gy0: 999 * Math.sin(w), gz0: 999 * Math.sin(2 * w)
        });
      }
    }
    return true;
  })()`;
}

(async () => {
  const c = await cdp.connect('wt901ble');
  try {
    /* 每次都重载：页面是启动时加载的，不重载会拿旧 JS 跑出假通过 */
    await c.reload(2500);
    await sleep(1200);
    c.errors();

    const view = await c.evalJSON('(() => ({ on: document.querySelector("#actCard").classList.contains("on"),'
      + ' btn: !!document.querySelector("#btnActOn"), tab: [...document.querySelectorAll("#segMode button")]'
      + '.map(b => b.dataset.m) }))()');
    check('视图与标签就位', view.on && view.btn && view.tab.includes('act'), view);

    /* 视图互斥切换：推断卡不能被其它视图的切换带坏 */
    const sw = await c.evalJSON('(() => { const on = () => ({ act: document.querySelector("#actCard")'
      + '.classList.contains("on"), imur: document.querySelector("#imurCard").classList.contains("on") });'
      + ' __wtDebug.setMode("imur", true); const a = on(); __wtDebug.setMode("act", true);'
      + ' return { imur: a, act: on() }; })()');
    check('视图切换正常', sw.imur.act === false && sw.imur.imur === true && sw.act.act === true, sw);

    const info = await c.evalJSON('(() => { const i = __wtDebug.act.info;'
      + ' return i ? { sha: i.onnx_sha256, axis: i.axis_own_to_train, gyro: i.gyro_source } : null; })()');
    check('模型信息已送达页面', !!info && info.sha.length === 64, info);
    check('轴向为自研→Moticon', JSON.stringify(info.axis) === '[[0,1,0],[-1,0,0],[0,0,1]]', info.axis);
    check('角速度口径为调用方扣偏', /bias-compensated/.test(info.gyro || ''), info.gyro);

    /* 零偏没就绪时必须什么都不做：既不能记账，也不能出一个看似合理的结果 */
    await c.evalJSON('__wtDebug.actStart()');
    await sleep(300);
    await c.evalJSON(feed(['l', 'r'], 150, 0, false));
    await sleep(700);
    const rb = await c.evalJSON('(() => { const a = __wtDebug.act; return { on: a.on, steps: a.steps,'
      + ' buf: a.buf.l.length, why: document.querySelector("#actWhy").textContent }; })()');
    check('零偏未就绪时不记账', rb.on === true && rb.buf === 0, rb);
    check('零偏未就绪时不决策', rb.steps === 0, rb);
    check('零偏未就绪给出等待提示', /等待零偏/.test(rb.why || ''), rb.why);

    await c.evalJSON('(__wtDebug.actStop("test"), true)');
    await c.evalJSON('__wtDebug.actStart()');
    await sleep(300);
    /* 喂一帧就立刻读：跨 evaluate 读会被 200 ms 定时器先把 buffer 发走 */
    const raw = await c.evalJSON('(() => {'
      + ' const st = __wtDebug.irStates.l;'
      + ' st.dev = st.dev || { fake: 1 }; st.rate = 50;'
      + ' st.bias.ready = true; st.bias.g = [0, 0, 0]; st.bias.still = 50;'
      + ' __wtDebug.actFeed(st, { perf: 6000, ax: 0, ay: 0, az: 1,'
      + ' gx: 42, gy: 43, gz: 44, gx0: 999, gy0: 999, gz0: 999 });'
      + ' const b = __wtDebug.act.buf.l;'
      + ' return b.length ? b[b.length - 1].slice(4, 7) : null; })()');
    check('送入的是扣偏后角速度', Array.isArray(raw) && raw[0] === 42 && raw[2] === 44, raw);

    await c.evalJSON('(__wtDebug.actStop("test"), true)');
    await c.evalJSON('__wtDebug.actStart()');
    await sleep(400);
    await c.evalJSON(feed(['l', 'r'], 150, 0));
    await sleep(700);

    const r1 = await c.evalJSON('(() => { const a = __wtDebug.act; return { on: a.on, steps: a.steps,'
      + ' valid: a.valid, last: a.last, hist: a.hist.slice(-4), label: document.querySelector("#actLabel").textContent,'
      + ' why: document.querySelector("#actWhy").textContent }; })()');
    check('推理已出结果', r1.steps >= 1 && r1.last && r1.last.valid === true,
      { steps: r1.steps, last: r1.last });
    check('三类概率归一', r1.last && r1.last.probabilities
      && Math.abs(r1.last.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-4, r1.last);
    check('页面显示类别', ['步行', '跑步', '其他'].includes(r1.label), r1.label);
    /* 一次性灌 150 帧只触发一拍，所以这里只要求至少一条 */
    check('历史色带在累积', Array.isArray(r1.hist) && r1.hist.length >= 1, r1.hist);

    /* 只给左脚：必须是无效而不是猜一个类别 */
    await c.evalJSON('(__wtDebug.actStop("test"), true)');
    await c.evalJSON('__wtDebug.actStart()');
    await sleep(400);
    await c.evalJSON(feed('l', 150, 0));
    await sleep(700);
    const r2 = await c.evalJSON('(() => { const a = __wtDebug.act; return { last: a.last, hist: a.hist.slice(-2) }; })()');
    check('缺脚 -> 无效且无类别', r2.last && r2.last.valid === false
      && (r2.last.label === null || r2.last.label === undefined), r2.last);
    check('缺脚原因正确', r2.last && r2.last.reason === 'missing_foot', r2.last && r2.last.reason);

    /* 时间倒退必须停掉而不是继续跑 */
    await c.evalJSON('(__wtDebug.actStop("test"), true)');
    await c.evalJSON('__wtDebug.actStart()');
    await sleep(300);
    await c.evalJSON(feed(['l', 'r'], 150, 0));
    await sleep(600);
    await c.evalJSON('(__wtDebug.actFeed({foot:"l"}, { perf: 1200, ax: 0, ay: 0, az: 1, gx: 0, gy: 0,'
      + ' gz: 0, gx0: 0, gy0: 0, gz0: 0 }), true)');
    await sleep(600);
    const r3 = await c.evalJSON('(() => { const a = __wtDebug.act; return { on: a.on, err: a.err,'
      + ' last: a.last, state: document.querySelector("#actState").textContent }; })()');
    check('时间倒退后停止会话', r3.on === false, r3);

    const errs = c.errors();
    check('无脚本错误', errs.length === 0, errs.slice(0, 3));
  } finally {
    c.close();
  }
  console.log(failed ? ('FAILED ' + failed) : 'ACTIVITY_LIVE_PASS');
  process.exit(failed ? 1 : 0);
})();
