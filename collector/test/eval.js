/*
 * 在调试页面里求值一条表达式，结果按 JSON 打印。
 *
 *   node test/eval.js "window.__wtDebug.irStates.l.bias"
 *   node test/eval.js "document.querySelectorAll('.irpanel').length"
 *
 * 表达式写在页面作用域里，所以能直接读 __wtDebug 和各全局变量。
 */
const cdp = require('./cdp');

(async () => {
  const expr = process.argv.slice(2).join(' ').trim();
  if (!expr) {
    console.error('用法：node test/eval.js "<表达式>"');
    process.exit(2);
  }
  const c = await cdp.connect();
  try {
    const v = await c.evalJSON('(' + expr + ')');
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    const errs = c.errors();
    if (errs.length) console.error('页面错误：\n  ' + errs.join('\n  '));
  } finally {
    c.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
