import assert from 'node:assert/strict';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {clampRange} from '../src/core/window-range.ts';

assert.deepEqual(clampRange(-10, 50, 100), {a: 0, b: 60});
assert.deepEqual(clampRange(90, 150, 100), {a: 40, b: 100});
assert.equal(clampRange(5, 4, 100), null);
assert.equal(clampRange(NaN, 4, 100), null);
assert.deepEqual(clampRange(0, 1, 0.01), {a: 0, b: 0.01});

const browser = await chromium.launch({
  channel: process.env.VIEWER_BROWSER || 'msedge',
  headless: true,
  args: ['--allow-file-access-from-files']
});
const page = await browser.newPage({viewport: {width: 1280, height: 900}});
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const entry = pathToFileURL(fileURLToPath(new URL('../index.html', import.meta.url))).href;
const range = () => page.evaluate(() => ({
  a: Number(document.querySelector('#tA').value),
  b: Number(document.querySelector('#tB').value)
}));
const settle = () => page.waitForFunction(() => !document.querySelector('#winText').hasAttribute('aria-busy'));
async function jump(a, b) {
  await page.locator('#tA').fill(String(a));
  await page.locator('#tB').fill(String(b));
  await page.locator('#tGo').click();
  await page.waitForFunction(() => !document.querySelector('#winText').hasAttribute('aria-busy'));
}
async function dragOverview(from, to) {
  const cv = page.locator('#imuOv');
  await cv.scrollIntoViewIfNeeded();
  const box = await cv.boundingBox();
  await page.mouse.move(box.x + 2 + from * (box.width - 4), box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 2 + to * (box.width - 4), box.y + 20, {steps: 8});
  await page.mouse.up();
}
async function checkImu() {
  await page.locator('[data-tab="imu"]').click();
  assert.equal(await page.locator('#scrub').isVisible(), false);
  assert.equal(await page.locator('#imuOvBar').isVisible(), true);
  assert.equal(await page.evaluate(() => document.querySelector('#imuOvBar').previousElementSibling.id), 'scrub');
  await jump(2, 4);
  assert.deepEqual(await range(), {a: 2, b: 4});
  await page.locator('#tB').fill('1');
  await page.locator('#tGo').click();
  assert.equal(await page.locator('#tB').getAttribute('aria-invalid'), 'true');
  await page.locator('#tB').press('Escape');
  assert.deepEqual(await range(), {a: 2, b: 4});
  const canvas = page.locator('#imuPanels canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  await page.mouse.wheel(0, 80);
  assert.deepEqual(await range(), {a: 2, b: 4});
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  const zoomed = await range();
  assert.ok(zoomed.b - zoomed.a < 2);
  await page.locator('#tA').fill('5');
  await page.locator('#tB').fill('7');
  await page.locator('#tB').press('Enter');
  assert.deepEqual(await range(), {a: 5, b: 7});
  for (const tab of ['gap', 'axis', 'imu']) {
    const button = page.locator(`[data-tab="${tab}"]`);
    if (await button.isEnabled()) await button.click();
    assert.equal(await page.locator('#tabs .tab[tabindex="0"]').count(), 1);
    if (tab === 'gap') assert.equal(await page.locator('#winBar').isVisible(), false);
  }
}
try {
  await page.goto(entry);
  assert.equal(await page.locator('#waveTools').isVisible(), false);
  const rows = ['时间\t设备名称\t加速度X(g)\t加速度Y(g)\t加速度Z(g)\t角速度X(°/s)\t角速度Y(°/s)\t角速度Z(°/s)'];
  for (let i = 0; i < 1000; i++) rows.push(`${new Date(Date.UTC(2026, 10, 9) + i * 20).toISOString()}\tIMU\t${Math.sin(i / 10)}\t0\t1\t${Math.cos(i / 10) * 30}\t0\t0`);
  await page.locator('#file').setInputFiles({name: 'interaction.txt', mimeType: 'text/plain', buffer: Buffer.from(rows.join('\n'))});
  await page.locator('#bar').waitFor({state: 'visible'});
  await checkImu();
  await page.setViewportSize({width: 390, height: 844});
  await page.waitForFunction(() => document.querySelector('#imuOv').width <= 1200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.setViewportSize({width: 1280, height: 900});
  await page.locator('#winReset').click();
  await dragOverview(0.2, 0.4);
  const selected = await range();
  assert.ok(selected.b > selected.a && selected.b - selected.a < 6, JSON.stringify(selected));
  await jump(2, 4);
  await dragOverview(3 / 19.98, 0);
  const atStart = await range();
  assert.ok(Math.abs(atStart.a) < 0.01 && Math.abs(atStart.b - 2) < 0.02);
  await dragOverview(1 / 19.98, 1);
  const atEnd = await range();
  assert.ok(Math.abs(atEnd.b - atEnd.a - 2) < 0.02 && atEnd.b > 19.9);
  console.log('PASS synthetic IMU: one preview, input/Enter/Escape/validation, normal wheel scroll, overview selection, fixed-span edge drag, tab focus');

  for (const file of process.argv.slice(2)) {
    await page.goto(entry);
    await page.locator('#file').setInputFiles(file);
    await page.locator('#bar').waitFor({state: 'visible'});
    await page.locator('#busy').waitFor({state: 'hidden'});
    await checkImu();
    if (await page.locator('[data-tab="wave"]').isEnabled()) {
      await page.locator('[data-tab="wave"]').click();
      await jump(2, 4);
      const grid = page.locator('#panels canvas').first();
      await grid.scrollIntoViewIfNeeded();
      const box = await grid.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 70);
      await page.mouse.wheel(0, 80);
      assert.deepEqual(await range(), {a: 2, b: 4});
      await page.locator('[data-tab="imu"]').click();
      assert.deepEqual(await range(), {a: 2, b: 4});
    }
    const lazy = (await page.locator('#winReset').textContent()) === '回到开头';
    if (lazy) {
      await jump(3000, 3060);
      await page.waitForFunction(() => document.querySelector('#imuOvLbl').textContent.includes('3000.00'));
      await settle();
      const cv = page.locator('#imuPanels canvas').first();
      await cv.scrollIntoViewIfNeeded();
      const box = await cv.boundingBox();
      await page.waitForFunction(({x, y}) => {
        const canvas = document.querySelector('#imuPanels canvas');
        canvas.dispatchEvent(new MouseEvent('mousemove', {clientX: x, clientY: y, bubbles: true}));
        return /t = 30[0-5][0-9]/.test(document.querySelector('#tip').textContent);
      }, {x: box.x + box.width / 2, y: box.y + 80});
      assert.deepEqual(await range(), {a: 3000, b: 3060});
      assert.match(await page.locator('#imuOvLbl').textContent(), /仅含已载入段/);
    }
    for (const tab of ['wave', 'cop', 'zero', 'gap', 'imu', 'axis']) {
      const button = page.locator(`[data-tab="${tab}"]`);
      if (!(await button.isEnabled())) continue;
      await button.click();
      assert.equal(await page.locator('#scrub').isVisible(), tab === 'wave');
      assert.equal(await page.locator('#imuOvBar').isVisible(), tab === 'imu');
      assert.equal(await page.locator('#winBar').isVisible(), ['wave', 'imu', 'axis'].includes(tab));
    }
    assert.equal(await page.locator('#err').textContent(), '');
    console.log('PASS real file:', file, '|', await page.locator('#chips').innerText());
  }
  await page.goto(new URL('axis.html', entry).href);
  assert.equal(await page.locator('#err').textContent(), '');
  assert.deepEqual(errors, []);
  console.log('PASS standalone page and zero browser errors');
} finally {
  await browser.close();
}
