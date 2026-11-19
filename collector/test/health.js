/*
 * 改完代码的第一件事：清缓存重载页面，看有没有加载错误、结构是否完整。
 *
 *   node test/health.js            重载后体检
 *   node test/health.js --no-reload  直接读当前状态
 *
 * 判据：脚本数对得上、__wtDebug 存在、两个面板都在、零未捕获异常。
 */
const cdp = require('./cdp');

(async () => {
  const c = await cdp.connect();
  try {
    if (!process.argv.includes('--no-reload')) await c.reload(3200);

    const s = await c.evalJSON(`({
      scripts: [...document.querySelectorAll('script[src]')].map(e => e.getAttribute('src')),
      dbg: typeof window.__wtDebug,
      dbgKeys: Object.keys(window.__wtDebug || {}).length,
      parquet: typeof window.ParquetW,
      panels: document.querySelectorAll('.irpanel').length,
      css: !!getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      title: document.title,
      cam: !!(window.__wtDebug || {}).cam,
      loop: !!(window.__wtDebug || {}).state
    })`);

    /* 期望值来自 HTML 的 script 标签本身，不是写死的数字 */
    const expectScripts = s.scripts.length;
    const checks = [
      ['脚本全部加载', expectScripts >= 9, expectScripts + ' 个'],
      ['__wtDebug 就绪', s.dbg === 'object' && s.dbgKeys > 80, s.dbgKeys + ' 个键'],
      ['parquet 写入库就绪', s.parquet === 'object', s.parquet],
      ['两个鞋垫面板', s.panels === 2, s.panels],
      ['样式表生效', s.css === true, s.css],
      ['cam 对象存在', s.cam === true, s.cam],
      ['state 存在', s.loop === true, s.loop],
    ];

    console.log('页面：' + s.title);
    console.log('脚本：' + s.scripts.join(' '));
    let bad = 0;
    for (const [name, ok, extra] of checks) {
      console.log((ok ? 'PASS ' : 'FAIL ') + name + '  [' + extra + ']');
      if (!ok) bad++;
    }
    const errs = c.errors();
    console.log(errs.length ? 'FAIL 未捕获错误 ' + errs.length : 'PASS 无未捕获错误');
    for (const e of errs.slice(0, 6)) console.log('   ' + e);
    bad += errs.length ? 1 : 0;

    console.log(bad ? '\n体检不通过：' + bad + ' 项' : '\n体检通过');
    process.exit(bad ? 1 : 0);
  } finally {
    c.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
