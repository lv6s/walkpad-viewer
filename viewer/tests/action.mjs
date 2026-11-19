/* 动作速度页的数值自检：直接吃维特 TXT，按设备分组后跑一次分析，打印每次动作。
   用途是把「页面里算出来的数」和离线脚本的结论对齐，不做 UI 断言。 */

import {readFileSync} from 'node:fs';
import {analyzeAction, FS} from '../src/action-core.ts';

const file = process.argv[2] || 'C:/Users/35317/Downloads/十个深蹲-刘-正常.txt';
const txt = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const lines = txt.split(/\r?\n/);
const hi = lines.findIndex(l => /时间|time/i.test(l) && /[XYZ]/.test(l));
if (hi < 0) throw new Error('没找到表头');
const sep = lines[hi].includes('\t') ? '\t' : (lines[hi].includes(';') ? ';' : ',');
const hdr = lines[hi].split(sep).map(s => s.trim());
const idx = re => hdr.findIndex(h => re.test(h));
const iT = idx(/^(时间|time)/i), iDev = idx(/设备名称|device/i);
const iA = ['X', 'Y', 'Z'].map(a => idx(new RegExp(`加速度\\s*${a}`, 'i')));
const iG = ['X', 'Y', 'Z'].map(a => idx(new RegExp(`角速度\\s*${a}`, 'i')));

const groups = new Map();
for (let li = hi + 1; li < lines.length; li++) {
  const c = (lines[li] || '').split(sep);
  if (c.length < hdr.length * 0.5) continue;
  const dev = iDev >= 0 ? (c[iDev] || '').trim() : 'dev';
  const t = Date.parse((c[iT] || '').trim());
  const a = iA.map(i => Number(c[i])), g = iG.map(i => Number(c[i]));
  if (!Number.isFinite(t)) continue;
  if (!groups.has(dev)) groups.set(dev, {t: [], a: [], g: []});
  const grp = groups.get(dev);
  grp.t.push(t); grp.a.push(a); grp.g.push(g);
}

const tmin = Math.min(...[...groups.values()].flatMap(g => g.t));
const report = [];
for (const [dev, grp] of groups) {
  const order = grp.t.map((_, i) => i).sort((x, y) => grp.t[x] - grp.t[y]);
  const n = order.length;
  const t = new Float64Array(n);
  const phys = Array.from({length: 6}, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const k = order[i];
    t[i] = (grp.t[k] - tmin) / 1000;
    for (let j = 0; j < 3; j++) { phys[j][i] = grp.a[k][j]; phys[3 + j][i] = grp.g[k][j]; }
  }
  const side = {
    side: dev, dev, n, nch: 0, t, ch: [], mx: null, mn: null, zc: null, miss: null,
    imu: {nch: 6, phys, raw: null, n, nPart: 0}, fno: null, temp: null,
    tLo: NaN, tHi: NaN, t0: 0, ictoIn: null, nT: 0, dur: t[n - 1],
    fs: (n - 1) / (t[n - 1] - t[0]), blk: null
  };
  const r = analyzeAction(side);
  report.push({dev, ...r});
}

report.sort((a, b) => b.reps.length - a.reps.length);
for (const r of report) {
  console.log(`\n== ${r.dev}  fs(源)=${((r.n - 1) / (r.to - r.from)).toFixed(1)}Hz  静止段=${r.staticSegs}  残差摆动=${r.biasSwing.toFixed(3)}m/s2  零偏=${r.biasG.map(v => v.toFixed(2)).join(',')}`);
  if (!r.reps.length) { console.log('   (无动作)', r.notes.join('; ')); continue; }
  console.log('  # t0    下蹲  起身  深(m) 下深/上深      下峰速 上峰速 上均速 反转ms 底a   不一致');
  for (const x of r.reps) {
    console.log(`  ${String(x.index).padStart(2)} ${x.t0.toFixed(2).padStart(6)} ${x.down.toFixed(2)} ${x.up.toFixed(2)}  ${x.depth.toFixed(3)}  ${x.depthDown.toFixed(3)}/${x.depthUp.toFixed(3)}  ${x.vDown.toFixed(2)}  ${x.vUp.toFixed(2)}  ${x.vUpMean.toFixed(2)}  ${(x.turn * 1000).toFixed(0).padStart(4)}  ${x.aBottom.toFixed(2)}  ${(x.mismatch * 100).toFixed(0)}%`);
  }
  const mean = f => r.reps.reduce((a, x) => a + f(x), 0) / r.reps.length;
  const sd = f => Math.sqrt(mean(x => (f(x) - mean(f)) ** 2));
  console.log(`  平均: 深${mean(x => x.depth).toFixed(3)}±${sd(x => x.depth).toFixed(3)}m  下峰${mean(x => x.vDown).toFixed(2)}  上峰${mean(x => x.vUp).toFixed(2)}  上均${mean(x => x.vUpMean).toFixed(2)}  底a${mean(x => x.aBottom).toFixed(2)}`);
  if (r.notes.length) console.log('  注:', r.notes.join('; '));
}
console.log(`\n(resample ${FS} Hz)`);
