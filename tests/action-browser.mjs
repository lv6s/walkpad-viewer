/* 动作速度页的浏览器自检：导入三设备维特 TXT，确认默认选动作最大的那台、
   能切出 10 次深蹲、表格与 CSV 一致，且窄屏不溢出。 */

import assert from 'node:assert/strict';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const txt = process.argv[2] || 'C:/Users/35317/Downloads/十个深蹲-刘-正常.txt';
const browser = await chromium.launch({channel: 'msedge', headless: true});
const page = await browser.newPage({viewport: {width: 1280, height: 900}});
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));

try {
  await page.goto(pathToFileURL(fileURLToPath(new URL('../index.html', import.meta.url))).href);
  await page.locator('#file').setInputFiles(txt);
  await page.locator('#busy').waitFor({state: 'hidden'});
  await page.locator('#bar').waitFor({state: 'visible'});
  assert.equal(await page.locator('#err').textContent(), '');
  assert.equal(await page.locator('[data-tab="action"]').isDisabled(), false);

  await page.locator('[data-tab="action"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#actionRows tr').length > 0);

  const opts = await page.locator('#actionSide option').allTextContents();
  assert.equal(opts.length, 3, '三台设备都要能选');
  const chosen = await page.locator('#actionSide').inputValue();
  const chosenText = await page.locator('#actionSide option:checked').textContent();
  assert.match(chosenText, /C2:49/, '默认应落在动作最大的手腕设备');
  console.log('PASS 默认设备 =', chosenText.trim(), `(${chosen})`);

  const rows = await page.locator('#actionRows tr').allTextContents();
  assert.equal(rows.length, 10, `应切出 10 次动作，实际 ${rows.length}`);
  const cells = await page.locator('#actionRows tr').evaluateAll(rs => rs.map(r => [...r.querySelectorAll('td')].map(t => t.textContent)));
  for (const c of cells) {
    assert.equal(c.length, 11);
    const depth = Number(c[4]);
    assert.ok(depth > 0.15 && depth < 0.8, `深度超范围：${c[4]}`);
    const vUp = Number(c[6]);
    assert.ok(vUp > 0.4 && vUp < 2, `起身峰速超范围：${c[6]}`);
  }
  console.log('PASS 10 次动作，深度', cells.map(c => c[4]).join(' '), 'm');

  const status = await page.locator('#actionStatus').textContent();
  assert.match(status, /重采样 200 Hz/);
  assert.match(status, /静止段/);
  const summary = await page.locator('#actionSummary').textContent();
  assert.match(summary, /10 次动作/);
  console.log('PASS 状态行与汇总:', summary.replace(/\s+/g, ' ').trim());

  // 换成脚背设备：那里几乎不动，应该识别不出动作
  await page.locator('#actionSide').selectOption({index: 0});
  await page.waitForTimeout(400);
  const footRows = await page.locator('#actionRows tr').count();
  assert.ok(footRows <= 1, `脚背不应切出多次动作，实际 ${footRows}`);
  assert.equal(await page.locator('#actionCsv').isDisabled(), true, '没有动作时不该能导出');
  console.log('PASS 脚背设备不产生伪动作（行数', footRows, '）');

  await page.locator('#actionSide').selectOption(chosen);
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#actionRows tr').count(), 10, '切回手腕应恢复 10 次');

  const download = page.waitForEvent('download');
  await page.locator('#actionCsv').click();
  const file = await download;
  assert.match(file.suggestedFilename(), /_动作速度_.*\.csv$/);
  console.log('PASS CSV 导出:', file.suggestedFilename());

  await page.setViewportSize({width: 390, height: 844});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '窄屏不应横向溢出');
  console.log('PASS 窄屏布局');

  assert.deepEqual(errors, [], '页面不应有未捕获异常');
  console.log('ALL PASS');
} finally {
  await browser.close();
}
