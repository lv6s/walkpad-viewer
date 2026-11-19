/* PNG / CSV 导出，一律只导当前时间窗。 */

import {GRID} from './core/constants';
import {$} from './core/dom';
import {baseName, downloadCanvas, downloadCsv} from './core/util';
import {srcOf} from './imu';
import {strictRange, winOf} from './timewin';

// 导出当前窗口：图直接取离屏底图（不含悬停游标），表带上时间与全部通道
function exportPng(entry) { downloadCanvas(entry.off, `${baseName()}_${entry.s.side}_wave.png`); }

function exportCsv(entry) {
  const s = entry.s, blk = s.blk, {a: A, b: B} = winOf();
  // 全段视图下手上只有窗口块：导出范围收进块内，别让文件名写着 13 h、表里只有 60 s
  const a0 = Math.max(A, blk.a), b0 = Math.min(B, blk.b);
  if (!(b0 > a0)) return;
  // 导出用严格边界：绘图多带邻帧是为了线闭合，表里多出的行却会和文件名上的起止时间矛盾
  const {i0, i1} = strictRange(blk, a0, b0);
  if (i1 < i0) return;
  const head = ['t_s'];
  for (let j = 0; j < s.nch; j++) head.push(`${s.side}_P${j + 1}`);
  const out = [head.join(',')];
  for (let k = i0; k <= i1; k++) {
    const row = [blk.t[k].toFixed(4)];
    for (let j = 0; j < s.nch; j++) {
      const v = blk.ch[j][k];
      row.push(Number.isFinite(v) ? v : '');
    }
    out.push(row.join(','));
  }
  downloadCsv(out, `${baseName()}_${s.side}_${a0.toFixed(2)}-${b0.toFixed(2)}s.csv`);
}

// IMU 导出跟随页面上选的数据源：物理量列名带 g / dps，原始计数列名带 lsb
function exportImuCsv(entry) {
  const s = entry.s, blk = s.blk, {a: A, b: B} = winOf();
  const a0 = Math.max(A, blk.a), b0 = Math.min(B, blk.b);
  if (!(b0 > a0)) return;
  const {i0, i1} = strictRange(blk, a0, b0);
  if (i1 < i0) return;
  const src = srcOf(s);
  const base = src === 'raw'
    ? 't_s,acc_r1_lsb,acc_r2_lsb,acc_r3_lsb,gyro_r4_lsb,gyro_r5_lsb,gyro_r6_lsb'
    : 't_s,acc_x_g,acc_y_g,acc_z_g,gyro_x_dps,gyro_y_dps,gyro_z_dps';
  const arr = blk.imu[src];
  // 温度是同帧标量，有就跟着一并导出（列名跟 parquet 里的来源列对齐）
  const hasT = !!blk.temp;
  const out = [base + (hasT ? ',temp_c' : '')];
  for (let k = i0; k <= i1; k++) {
    const row = [blk.t[k].toFixed(4)];
    for (let j = 0; j < 6; j++) {
      const v = arr[j][k];
      row.push(Number.isFinite(v) ? v : '');
    }
    if (hasT) row.push(Number.isFinite(blk.temp[k]) ? blk.temp[k].toFixed(2) : '');
    out.push(row.join(','));
  }
  downloadCsv(out, `${baseName()}_${s.side}_imu_${src}_${a0.toFixed(2)}-${b0.toFixed(2)}s.csv`);
}

// 逐帧 COP：只导出有支撑的帧（腾空帧分母趋 0，COP 无定义），带段号便于按步核对
function exportCopCsv(entry) {
  const {s, d} = entry;
  if (!d.segs.length) return;
  const out = ['seg,t_s,cop_x_mm,cop_y_mm,total_adc'];
  d.segs.forEach(([a, b], i) => {
    for (let k = a; k <= b; k++) {
      if (!isFinite(d.cx[k])) continue;
      out.push([i + 1, s.blk.t[k].toFixed(4), d.cx[k].toFixed(2), d.cy[k].toFixed(2), d.tot[k]].join(','));
    }
  });
  downloadCsv(out, `${baseName()}_${s.side}_cop.csv`);
}

// 每通道零值率表：与页面上矩阵同口径，供外部复核
// ⚠ 分母必须是算零值率时用的那一个：全段统计只用有效帧（s.n，已剔掉 validity 非 valid 的边界帧），
// 后台还没扫完就只用窗口块；拿 nAll（全部行）当分母会把被排除的边界帧加回来，与分子对不上。
function exportZeroCsv(entry) {
  const {s, st} = entry;
  const scope = s.zc ? 'full' : 'window';
  const nBase = s.zc ? s.n : (s.blk ? s.blk.n : 0);
  const out = ['channel,side,row,col,zero_ratio,zero_frames,valid_frames,max_adc,scope'];
  for (let j = 0; j < st.nch; j++) {
    const gr = GRID[s.side] && GRID[s.side][j];
    const zr = st.zr[j];
    const valid = nBase - ((s.miss && s.miss[j]) || 0);
    out.push([j + 1, s.side, gr ? gr[0] : '', gr ? gr[1] : '',
      isFinite(zr) ? zr.toFixed(4) : '', (s.zc && s.zc[j]) || 0, valid,
      Math.round((s.mx && s.mx[j]) || 0), scope].join(','));
  }
  downloadCsv(out, `${baseName()}_${s.side}_zero.csv`);
}

export {exportCopCsv, exportCsv, exportImuCsv, exportPng, exportZeroCsv};
