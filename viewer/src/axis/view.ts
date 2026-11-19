/* 三维轴投影的绘制与视角交互：解剖系 (前, 左, 上) 为参考，传感器三轴叠在上面。 */

import {axisView} from '../core/state';
import {AXES, AX_COL, D2R, R2D, cross, dot, unit} from './math';
import {css} from '../core/util';

// ---------------------------------------------------------------- 画布
// 相机在解剖系里用方位角 / 仰角表示：c 为原点指向相机的单位向量。
// 两脚共用同一视角，左右并排对照时角度一致才有意义；拖动改 yaw/pitch，滚轮改 zoom。
const PITCH_MIN = -55 * D2R, PITCH_MAX = 80 * D2R;
const CAM0 = {yaw: Math.atan2(-0.7, -1), pitch: Math.atan2(0.8, Math.hypot(1, 0.7)), zoom: 1};
const cam = Object.assign({}, CAM0);

// 屏幕右 / 上在解剖系里的分量：r = d × ẑ，u = r × d（d = 视线方向 = −c）
function camBasis() {
  const cp = Math.cos(cam.pitch);
  const d = [-cp * Math.cos(cam.yaw), -cp * Math.sin(cam.yaw), -Math.sin(cam.pitch)];
  const r = unit(cross(d, [0, 0, 1]));
  return {r, u: unit(cross(r, d))};
}

function arrow(g, x0, y0, x1, y1, color, wid, dash?) {
  g.save();
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = wid;
  if (dash && dash.length) g.setLineDash(dash);
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  g.setLineDash([]);
  const a = Math.atan2(y1 - y0, x1 - x0), hl = 5 + wid * 1.5;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x1 - hl * Math.cos(a - 0.4), y1 - hl * Math.sin(a - 0.4));
  g.lineTo(x1 - hl * Math.cos(a + 0.4), y1 - hl * Math.sin(a + 0.4));
  g.closePath(); g.fill();
  g.restore();
}

// 画布宽度跟随卡片，高度按宽度定：铺满屏宽时图也一起变大，不用固定 322 px
const H_OF = w => Math.round(Math.max(340, Math.min(640, w * 0.62)));

function fitCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = Math.max(280, cv.parentElement.clientWidth || 0);
  const H = H_OF(W);
  cv.style.height = H + 'px';
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return {g, W, H, k: Math.max(1, Math.min(1.4, H / 360))};   // k：字号 / 线宽随画布放大
}

// 画布左上角的标题与右上角的操作提示
function caption(g, W, title, hint) {
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillStyle = css('--muted');
  g.fillText(title, 10, 14);
  if (hint) {
    g.textAlign = 'right'; g.fillStyle = css('--faint');
    g.fillText(hint, W - 10, 14);
  }
}

// 三维轴投影：解剖系 (前, 左, 上) 为参考，传感器三轴叠在上面
function paint3d(cv, res) {
  const {g, W, H, k} = fitCanvas(cv);
  const cInk = css('--ink'), cMuted = css('--muted'), cFaint = css('--faint'), cGrid = css('--grid'), cCard = css('--card');
  const basis = camBasis();
  // 缩放取 W/H 两个上限的较小者：画布宽扁时不能只看 min(W,H)，否则箭头缩在中间一小块
  const ox = W / 2, oy = H / 2 + 8, sc = Math.min(W * 0.30, H * 0.38) * cam.zoom;
  const pr = v => ({x: ox + sc * dot(v, basis.r), y: oy - sc * dot(v, basis.u)});

  g.font = `${11 * k}px system-ui,"Microsoft YaHei",sans-serif`;
  caption(g, W, '三维轴投影（灰=解剖轴，彩=传感器轴）', '拖动旋转 · 滚轮缩放 · 双击复位');

  // 地面网格：只作深度参照
  g.strokeStyle = cGrid; g.lineWidth = 1; g.globalAlpha = .9;
  for (const u of [-1, -0.5, 0, 0.5, 1]) {
    let p = pr([-1.15, u, 0]), q = pr([1.15, u, 0]);
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    p = pr([u, -1.15, 0]); q = pr([u, 1.15, 0]);
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
  }
  g.globalAlpha = 1;

  // 解剖轴
  const anat: [number[], string][] = [[[1, 0, 0], '前'], [[0, 1, 0], '左'], [[0, 0, 1], '上']];
  g.font = `${11.5 * k}px system-ui,"Microsoft YaHei",sans-serif`;
  for (const [v, nm] of anat) {
    const q = pr(v);
    arrow(g, ox, oy, q.x, q.y, cFaint, 1.1, [4, 3]);
    const lab = pr([v[0] * 1.16, v[1] * 1.16, v[2] * 1.16]);
    g.fillStyle = cMuted; g.textAlign = 'center';
    g.fillText(nm, lab.x, lab.y);
  }

  // 传感器轴
  for (let i = 0; i < 3; i++) {
    const v = [res.R[0][i], res.R[1][i], res.R[2][i]];
    const q = pr(v);
    arrow(g, ox, oy, q.x, q.y, AX_COL[AXES[i]], 2.1 * k);
    const row = res.rows[i];
    const lab = pr([v[0] * 1.2, v[1] * 1.2, v[2] * 1.2]);
    g.fillStyle = AX_COL[AXES[i]];
    g.textAlign = q.x >= ox - 2 ? 'left' : 'right';
    g.fillText(`${AXES[i]} ${row.desc}`, lab.x + (q.x >= ox - 2 ? 3 : -3), lab.y);
  }

  // 原点
  g.fillStyle = cInk;
  g.beginPath(); g.arc(ox, oy, 2.2 * k, 0, Math.PI * 2); g.fill();

  // 结论角标：贴在左下角，导出 PNG 后仍能自解释
  g.fillStyle = cCard; g.globalAlpha = .86;
  g.fillRect(6, H - 40 * k, Math.min(W - 12, 220 * k), 34 * k); g.globalAlpha = 1;
  g.fillStyle = cMuted; g.textAlign = 'left'; g.font = `${10.5 * k}px system-ui,sans-serif`;
  g.fillText('地面网格间距 = 1 个单位长度', 11, H - 28 * k);
  const az = ((cam.yaw * R2D) % 360 + 360) % 360;
  g.fillText(`视角 方位 ${az.toFixed(0)}° / 仰角 ${(cam.pitch * R2D).toFixed(0)}°`, 11, H - 15 * k);
}

// ---------------------------------------------------------------- 交互
function redraw3d() {
  for (const e of axisView.values()) if (e.res && !e.res.err && !e.res.partial) paint3d(e.cv3, e.res);
}

// 拖动转视角（两脚联动），滚轮缩放，双击复位
function bindOrbit(cv) {
  let from = null;
  cv.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    from = {x: ev.clientX, y: ev.clientY};
    try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* 合成事件没有活跃指针 */ }
    ev.preventDefault();
  });
  cv.addEventListener('pointermove', ev => {
    if (!from) return;
    const dx = ev.clientX - from.x, dy = ev.clientY - from.y;
    from = {x: ev.clientX, y: ev.clientY};
    // 拖动方向与物体转动方向一致：向右拖 → 物体右转，向下拖 → 顶面朝自己
    cam.yaw -= dx * 0.009;
    cam.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cam.pitch + dy * 0.006));
    redraw3d();
  });
  const end = ev => {
    if (!from) return;
    from = null;
    if (cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    cam.zoom = Math.max(0.45, Math.min(3, cam.zoom * Math.exp(-ev.deltaY * 0.0014)));
    redraw3d();
  }, {passive: false});
  cv.addEventListener('dblclick', () => { Object.assign(cam, CAM0); redraw3d(); });
}

export {bindOrbit, cam, paint3d, redraw3d};
