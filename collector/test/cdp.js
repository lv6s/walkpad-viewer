/*
 * 调试浏览器（9333 端口）的连接样板，供 test/ 下的探针复用。
 *
 *   const cdp = require('./cdp');
 *   const c = await cdp.connect();              // 挑 wt901ble 页面
 *   const v = await c.evalJSON('({a: 1})');      // 表达式 → JSON 值
 *   const hex = await c.shot('#irPress-l');      // 元素区域截图（base64）
 *   await c.reload();                            // 清缓存重载
 *   c.close();
 *
 * 页面必须由带 --remote-debugging-port=9333 的 Edge 打开；本文件只连接、不启动。
 */
const http = require('http');

const PORT = process.env.CDP_PORT || 9333;

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function connect(match) {
  const list = await getJson('http://127.0.0.1:' + PORT + '/json');
  const want = match || 'wt901ble';
  const page = list.find((t) => t.type === 'page' && (t.url || '').includes(want))
    || list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面，先启动带 --remote-debugging-port=' + PORT + ' 的浏览器');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const wait = new Map();
  let seq = 0;
  /* 页面里的未捕获异常与 console.error，读到就存着，由 errors() 取 */
  const errs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push(((d.exception && (d.exception.description || d.exception.value)) || d.text || '?')
        + ' @' + (d.url || '').split('/').pop() + ':' + d.lineNumber);
    } else if (m.method === 'Log.entryAdded') {
      const d = m.params.entry;
      if (d.level === 'error') errs.push('LOG ' + d.text.slice(0, 200));
    }
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
  };
  const send = (method, params) => new Promise((r) => {
    const i = ++seq;
    wait.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  await new Promise((r) => (ws.onopen = r));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  return {
    page, send, errs,
    errors: () => errs.splice(0),

    /* 求值并把结果当 JSON 解析；页面里抛错会带上原始堆栈 */
    async evalJSON(expr) {
      const r = await send('Runtime.evaluate', {
        expression: '(function(){ try { return JSON.stringify(' + expr + '); }'
          + ' catch (e) { return JSON.stringify({__err: String(e && e.stack || e)}); } })()',
        returnByValue: true, awaitPromise: true,
      });
      const raw = r.result && r.result.result && r.result.result.value;
      if (raw === undefined) throw new Error('无返回值：' + JSON.stringify(r.result).slice(0, 300));
      const v = JSON.parse(raw);
      if (v && v.__err) throw new Error('页面表达式出错：' + v.__err);
      return v;
    },

    /* 元素区域截图，返回 base64（调用方决定落盘还是丢弃） */
    async shot(selector, scale) {
      await send('Emulation.setDeviceMetricsOverride',
        { width: 1680, height: 1600, deviceScaleFactor: 1, mobile: false });
      await new Promise((r) => setTimeout(r, 300));
      const box = await this.evalJSON('(() => { const e = document.querySelector(' + JSON.stringify(selector)
        + '); if (!e) return null; const r = e.getBoundingClientRect();'
        + ' return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
      if (!box) throw new Error('找不到元素：' + selector);
      const s = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: scale || 2 },
      });
      return s.result.data;
    },

    async reload(ms) {
      await send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, ms || 3000));
    },

    close() { try { ws.close(); } catch (e) { /* 已断 */ } },
  };
}

module.exports = { connect, getJson, PORT };
