/* 入口：绑事件、按页面分派。
   index.html 是主查看器，axis.html 是只做轴向推断的独立页 —— 两者共用同一份数据层与算法层，
   区别只在渲染与接线，所以打成一个 bundle，按 body[data-page] 分派。 */

import {analyzeActivity, initActivity, onActivityChange} from './activity';
import {initSquat} from './squat';
import {setTab} from './app';
import {drawAxis, syncAxisUi} from './axis';
import {initAxisPage} from './axis/page';
import {copSegBaseRef, jumpSeg, renderCop, setCopTime, togglePlay} from './cop';
import {APP_VER} from './core/constants';
import {el} from './core/dom';
import {state, view} from './core/state';
import {niceMax} from './core/util';
import {closeDetail, idxAt, openDetail, paintDetail} from './detail';
import {bindOverview, clearOvCache, redrawImu, syncImuSegUi, syncImuSrcUi} from './imu';
import {dragRef, endDrag, onDragMove} from './interact';
import {parse} from './parse';
import {bindScrub} from './scrub';
import {redrawWave, resetWin} from './timewin';
import {bindHelp} from './help';
import {bindVideo} from './video';

/* ------------------------------------------------------------------ 纵轴快捷按钮 */
function markY(): void {
  document.querySelectorAll('[data-y="auto"]').forEach((b: HTMLElement) => b.classList.toggle('on', state.auto));
}

function bindYButtons(): void {
  document.querySelectorAll('[data-y]').forEach((b: HTMLElement) => b.addEventListener('click', () => {
    state.auto = true;
    state.ymax = niceMax(state.gmax);
    el.ymax.value = Math.round(state.ymax);
    markY();
    redrawWave();
  }));
}

/* ------------------------------------------------------------------ 主查看器 */
function bindViewer(): void {
  initActivity();
  initSquat();
  el.tabs.addEventListener('click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest('.tab') as HTMLElement | null;
    if (b && !(b as HTMLButtonElement).disabled && b.dataset.tab !== state.tab) setTab(b.dataset.tab);
  });

  // 页签聚焦时 ←/→ 换页（跳过被禁用的页）
  el.tabs.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const btns = [...el.tabs.querySelectorAll('.tab')] as HTMLButtonElement[];
    const avail = btns.filter(b => !b.disabled);
    const i = avail.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    ev.preventDefault();
    const nb = avail[(i + (ev.key === 'ArrowRight' ? 1 : -1) + avail.length) % avail.length];
    nb.focus();
    setTab(nb.dataset.tab);
  });

  // IMU 页的轴 / 物理量开关：至少留一个轴、一个物理量，全关就画不出东西
  el.viewImu.addEventListener('click', (e: MouseEvent) => {
    const sb = (e.target as HTMLElement).closest('button[data-src]') as HTMLElement | null;
    if (sb) {
      if (sb.dataset.src !== state.imuSrc) {
        state.imuSrc = sb.dataset.src;
        clearOvCache();                       // 包络按数据源缓存，切换即作废
        syncImuSrcUi();
        if (state.tab === 'imu') redrawImu();
      }
      return;
    }
    const db = (e.target as HTMLElement).closest('button[data-draw]') as HTMLElement | null;
    if (db) {
      if (db.dataset.draw !== state.imuDraw) {
        state.imuDraw = db.dataset.draw;
        el.viewImu.querySelectorAll('button[data-draw]')
          .forEach(x => x.classList.toggle('on', x.dataset.draw === state.imuDraw));
        if (state.tab === 'imu') redrawImu();
      }
      return;
    }
    if ((e.target as HTMLElement).closest('#imuGap')) {
      state.imuGap = !state.imuGap;
      el.imuGap.classList.toggle('on', state.imuGap);
      if (state.tab === 'imu') redrawImu();
      return;
    }
    const b = (e.target as HTMLElement).closest('button[data-ax],button[data-kind]') as HTMLElement | null;
    if (!b) return;
    const isAx = b.dataset.ax != null;
    const set = isAx ? state.imuAxes : state.imuKinds;
    const key = isAx ? b.dataset.ax : b.dataset.kind;
    if (set.has(key)) {
      if (set.size === 1) return;
      set.delete(key);
    } else set.add(key);
    b.classList.toggle('on', set.has(key));
    clearOvCache();                           // 包络的栏与线跟着轴/物理量走
    if (state.tab === 'imu') redrawImu();
  });

  // IMU 纵轴：留空 = 自动（全段或按窗口），填了就用填的 ± 值
  const markImuY = () => {
    const cur = state.imuY[state.imuSrc];
    const manual = cur.acc != null || cur.gyro != null;
    el.imuYauto.classList.toggle('on', !manual && !state.imuFit);
    el.imuYfit.classList.toggle('on', !manual && state.imuFit);
  };
  const setImuY = (k: 'acc' | 'gyro', raw: string) => {
    const v = parseFloat(raw);
    state.imuY[state.imuSrc][k] = Number.isFinite(v) && v > 0 ? v : null;
    markImuY();
    if (state.tab === 'imu') redrawImu();
  };
  el.imuYa.addEventListener('input', () => setImuY('acc', el.imuYa.value));
  el.imuYg.addEventListener('input', () => setImuY('gyro', el.imuYg.value));
  // 丢帧阈值：清空或填 0 时退回 40 ms，不把输入框改回去（改回去会打断输入）
  el.imuGapMs.addEventListener('input', () => {
    const v = parseFloat(el.imuGapMs.value);
    state.imuGapMs = Number.isFinite(v) && v > 0 ? v : 40;
    if (state.tab === 'imu') redrawImu();
  });
  // 两个自动档互斥：全段最大 |值| / 当前时间窗内最大 |值|
  const imuAuto = (fit: boolean) => {
    el.imuYa.value = '';
    el.imuYg.value = '';
    state.imuY = {phys: {acc: null, gyro: null}, raw: {acc: null, gyro: null}};
    state.imuFit = fit;
    markImuY();
    if (state.tab === 'imu') redrawImu();
  };
  el.imuYauto.addEventListener('click', () => imuAuto(false));
  el.imuYfit.addEventListener('click', () => imuAuto(true));

  // 窄带开关：温度、设备角度各一条，关掉只是不画（数据仍在，CSV 导出不受影响）
  for (const [btn, key] of [[el.imuTempOn, 'imuTemp'], [el.imuAngOn, 'imuAng']] as const) {
    btn.addEventListener('click', () => {
      state[key] = !state[key];
      btn.classList.toggle('on', state[key]);
      if (state.tab === 'imu') redrawImu();
    });
  }

  // IMU 页的状态底色：分析整段走分段页同一份结果，只在这里铺色；关掉即回到原始波形
  el.imuRun.addEventListener('click', () => { void analyzeActivity(); });
  el.imuSegOn.addEventListener('click', () => {
    state.imuSeg = !state.imuSeg;
    syncImuSegUi();
    if (state.tab === 'imu') redrawImu();
  });
  // 进度只改按钮文案；分段结果换了才重画波形（数组换引用即换结果）
  let lastSegList: any[] | null = null;
  onActivityChange(() => {
    syncImuSegUi();
    const list = state.seg?.list ?? null;
    if (list === lastSegList) return;
    lastSegList = list;
    if (state.tab === 'imu' && state.sides.length) redrawImu();
    if (state.tab === 'cop' && state.sides.length) void renderCop();
  });
  el.scrub.after(el.imuOvBar);
  bindOverview();
  bindScrub();
  bindVideo();

  // 轴向推断页：区间与静止判据都只影响本页，改完就地重算
  el.axisTools.addEventListener('click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest('button[data-range],button[data-sens]') as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    if (b.dataset.range) state.axisRange = b.dataset.range;
    if (b.dataset.sens) state.axisSens = b.dataset.sens;
    syncAxisUi();
    drawAxis();
  });
  el.axisTools.querySelector('#axisRe').addEventListener('click', () => drawAxis());

  ['dragenter', 'dragover'].forEach(t => el.drop.addEventListener(t, (e: DragEvent) => {
    e.preventDefault(); el.drop.classList.add('hot');
  }));
  el.drop.addEventListener('dragleave', () => el.drop.classList.remove('hot'));
  // 一次拖两个：第一个当主数据，第二个当参考数据（同一次录制的另一台设备）
  const takeFiles = async (fs: FileList) => {
    if (!fs || !fs.length) return;
    await parse(fs[0]);
    if (fs.length > 1) await parse(fs[1], {asRef: true});
  };
  el.drop.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault(); el.drop.classList.remove('hot');
    takeFiles(e.dataTransfer.files);
  });
  el.pick.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); el.file.click(); });
  el.file.addEventListener('change', () => { if (el.file.files[0]) parse(el.file.files[0]); });

  if (el.axisRef) el.axisRef.addEventListener('click', () => el.axisRefFile.click());
  if (el.axisRefFile) el.axisRefFile.addEventListener('change', () => {
    const f = el.axisRefFile.files[0];
    if (f) parse(f, {asRef: true});
    el.axisRefFile.value = '';
  });

  // 整个窗口都能接住拖入（结果出来之后）
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest('#drop')) return;
    takeFiles(e.dataTransfer && e.dataTransfer.files);
  });

  el.again.addEventListener('click', () => {
    el.file.value = ''; el.file.click();
  });

  // 纵轴只影响波形与详情图，不必连带重算 COP / 零值率
  el.ymax.addEventListener('change', () => {
    const v = +el.ymax.value;
    if (v > 0) { state.auto = false; state.ymax = v; markY(); redrawWave(); }
  });
  bindYButtons();

  el.dClose.addEventListener('click', closeDetail);

  // 拖动/平移跨出画布也要跟得住，所以挂在 window 上（画布内只在没拖动时处理悬停）
  window.addEventListener('mousemove', ev => { if (dragRef()) onDragMove(ev); });
  window.addEventListener('mouseup', ev => { if (dragRef()) endDrag(ev); });
  el.winReset.addEventListener('click', resetWin);
  // 显示采样率：全段视图每隔多久取一帧。缩放后屏幕装不下那么多点，自动按像素取，不会更粗
  el.rateSel.addEventListener('change', () => {
    const v = el.rateSel.value;
    state.drawHz = v === 'auto' ? null : +v;
    if (state.sides.length) setTab(state.tab);
  });

  document.addEventListener('keydown', (ev: KeyboardEvent) => {
    const tag = (ev.target && (ev.target as HTMLElement).tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A|VIDEO)$/.test(tag) || (ev.target as HTMLElement)?.isContentEditable) return;
    if (ev.key === 'Escape') { if (state.detail) closeDetail(); return; }
    if (ev.key === '0') { resetWin(); return; }
    // COP 页：空格播放/暂停，[ ] 换段，←/→ 逐帧（Shift 十帧）
    if (state.tab === 'cop') {
      if (ev.key === ' ') { ev.preventDefault(); togglePlay(); return; }
      if (ev.key === '[') { jumpSeg(-1); return; }
      if (ev.key === ']') { jumpSeg(1); return; }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        const base = copSegBaseRef();
        const s0 = base && base.s;
        const fps = s0 && isFinite(s0.fs) ? s0.fs : 50;
        const step = (ev.shiftKey ? 10 : 1) / fps;
        setCopTime(state.copT + (ev.key === 'ArrowLeft' ? -step : step));
        ev.preventDefault();
        return;
      }
    }
    if (!state.detail) return;
    const s = state.sides.find(x => x.side === state.detail.side);
    if (!s) return;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      const d = ev.key === 'ArrowLeft' ? -1 : 1;
      openDetail(state.detail.side, (state.detail.j + d + s.nch) % s.nch);
      ev.preventDefault();
    }
  });

  // 详情图悬停读数
  el.dCanvas.addEventListener('mousemove', (ev: MouseEvent) => {
    const geo = state.dGeo;
    if (!geo || !geo.hasWave) return;
    const r = el.dCanvas.getBoundingClientRect();
    const frac = (ev.clientX - r.left - (geo.padL as number)) / (geo.pw as number);
    if (frac < -.01 || frac > 1.01) { paintDetail(null); return; }
    paintDetail(idxAt((geo.a as number) + Math.max(0, Math.min(1, frac)) * (geo.span as number), geo.blk));
  });
  el.dCanvas.addEventListener('mouseleave', () => paintDetail(null));

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => {
      if (!state.sides.length) return;
      // 隐藏页的 canvas 宽度为 0，重绘整页会把它画坏，只重画当前页
      for (const e of view.values()) e.geo = null;
      setTab(state.tab);
    }, 140);
  });
}

/* ------------------------------------------------------------------ 启动 */
function boot(): void {
  if (el.ver) el.ver.textContent = 'v' + APP_VER;
  bindHelp();
  if (document.body.dataset.page === 'axis') initAxisPage();
  else bindViewer();
}

boot();
