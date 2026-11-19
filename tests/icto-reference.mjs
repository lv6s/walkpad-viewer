/* IC/TO 对拍闸门：用交付包自带的示例流跑 src/icto/core.ts，与 examples/expected_candidates.csv 逐条比对。
   移植正确性的唯一证据 —— 改 core.ts 之后先跑它，不一致就别谈别的问题。
   用法：node tests/icto-reference.mjs <imu_ic_to_v4_handoff_20261109 目录>
   通过：左 14 IC / 14 TO、右 14 IC / 14 TO，共 56 条，事件时间、原始行号、检测路径零差异。 */
import fs from 'node:fs';
import path from 'node:path';
import {ictoDetectRows} from '../src/icto/core.ts';

const pkg = process.argv[2];
if (!pkg) {
  console.error('用法：node tests/icto-reference.mjs <imu_ic_to_v4_handoff_20261109 目录>');
  process.exit(2);
}
const AXES = ['ax_g', 'ay_g', 'az_g', 'gx_dps', 'gy_dps', 'gz_dps'];

function readCsv(file) {
  let txt = fs.readFileSync(file, 'utf8');
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  const hdr = lines[0].split(',');
  return lines.slice(1).map(l => {
    const c = l.split(','), o = {};
    hdr.forEach((h, i) => { o[h.trim()] = (c[i] == null ? '' : c[i]).trim(); });
    return o;
  });
}

// 与 ic_to.normalize_rows 同口径：mapped 行的 effective 必须等于 aligned，六轴必须有限
function build(rows, side) {
  const n = rows.length;
  const inp = {
    n, tUs: new Float64Array(n), seq: new Float64Array(n), ord: new Float64Array(n),
    ok: new Uint8Array(n), ax: new Float64Array(n * 6), row: new Int32Array(n), sfo: new Float64Array(n)
  };
  rows.forEach((r, i) => {
    const place = r.placement_code;
    if (place && place !== side + '_instep') throw new Error('第 ' + i + ' 行不是 ' + side);
    inp.tUs[i] = Number(r.aligned_session_elapsed_us);
    inp.seq[i] = Number(r.native_sequence);
    inp.ord[i] = Number(r.source_frame_ordinal);
    inp.sfo[i] = Number(r.source_frame_ordinal);
    inp.row[i] = i;
    if (r.effective_time_status === 'mapped') {
      if (Number(r.effective_elapsed_us) !== inp.tUs[i]) throw new Error('第 ' + i + ' 行时间冲突');
      inp.ok[i] = 1;
    } else if (r.effective_time_status !== 'excluded') throw new Error('第 ' + i + ' 行状态非法');
    AXES.forEach((k, j) => { inp.ax[i * 6 + j] = Number(r[k]); });
  });
  return inp;
}

const fmt = v => (v == null ? '—' : Number(v).toFixed(3));
const expected = readCsv(path.join(pkg, 'examples/expected_candidates.csv'));
const lines = [];
let total = 0, bad = 0;

for (const side of ['left', 'right']) {
  const out = ictoDetectRows(build(readCsv(path.join(pkg, 'examples/' + side + '_imu.csv')), side), side, 'steps14');
  const want = expected.filter(r => r.side === side)
    .sort((a, b) => (Number(a.imu_packet_time_s) - Number(b.imu_packet_time_s))
      || (Number(a.source_frame_ordinal) - Number(b.source_frame_ordinal)));
  const mine = out.events;
  const diff = [];
  if (mine.length !== want.length) diff.push(`事件数 ${mine.length}≠${want.length}`);
  for (let i = 0; i < Math.min(mine.length, want.length); i++) {
    const a = want[i], b = mine[i];
    const dt = Math.abs(Number(a.imu_packet_time_s) - b.imu_packet_time_s);
    if (a.event !== b.event || String(a.source_frame_ordinal) !== String(b.source_frame_ordinal)
      || dt > 5e-7
      || Math.abs(Number(a.pitch_proxy_dps) - b.pitch_proxy_dps) > 1e-4
      || a.detection_path !== b.detection_path) {
      diff.push(`#${i} ${a.event}@${a.imu_packet_time_s}(行${a.source_frame_ordinal},${a.detection_path})`
        + ` / ${b.event}@${b.imu_packet_time_s.toFixed(6)}(行${b.source_frame_ordinal},${b.detection_path})`
        + ` Δt=${dt.toExponential(2)}`);
    }
  }
  total += mine.length;
  bad += diff.length;
  const d = out.diagnostics;
  const pol = d.polarity_selection;
  lines.push(`${side}  事件 ${mine.length}/${want.length}  分段 ${out.cycles.length}`
    + `  轴 ${d.gyro_axis}${d.sign > 0 ? '+' : '-'}  门限 ${d.swing_lobe_threshold_dps.toFixed(3)}`
    + `  方向 ${pol.status}（+ ${fmt(pol.options[0].median_support_G_dps)} / − ${fmt(pol.options[1].median_support_G_dps)}）`
    + `  内部 ${d.interior_events.IC || 0}/${d.interior_events.TO || 0}`
    + `  首尾 ${d.boundary_events.IC || 0}/${d.boundary_events.TO || 0}`
    + `  弱起步 ${d.startup_events.IC || 0}/${d.startup_events.TO || 0}`
    + (diff.length ? '  ✗ ' + diff.slice(0, 3).join('; ') : '  ✓'));
}

console.log(lines.join('\n'));
console.log(`\n合计 ${total} 个事件，不一致 ${bad} 处`);
process.exit(bad ? 1 : 0);
