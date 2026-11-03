/* 帧导出：把两脚录到的帧写成与 app 同构的 parquet。 */

/* 导出「每帧一行」的帧表，列与 app 导出的 parquet 同构：
   pressure_raw_values 是 70 个槽位（含未接传感器的空位），pressure_values 是
   映射到布局后的 56 个点；两脚合并在同一份里，用 assigned_side 区分。
   数组列用分号分隔，避免 CSV 引号，Python 侧 split(';') 即可还原成 list。 */
const FR_MEASUREMENT_CONTRACT = 'd56-measurement-v3';

/* 录制起点的页面单调时钟（ms），两脚共用，作为 effective_elapsed_us 的零点 */
let REC_T0 = 0;

/* 一次录制的 dataset / session 标识，导出时写进 parquet 元数据与列 */
let FR_DATASET_ID = '', FR_SESSION_ID = '';

/* seq 差得离谱就不当丢帧算（设备重启会让序号归零，那样一次能"丢"出几十万帧） */
const FR_GAP_MAX = 100;

function irFramesRows() {
  const rows = [];
  for (const foot of IR_SIDES) {
    const st = irStates[foot];
    if (!st.rec.length) continue;
    const side = foot === 'r' ? 'right' : 'left';
    const topo = ($('prTopo', foot) && $('prTopo', foot).value === 'v1')
      ? 'd56-14x5-56-legacy-v1' : 'd56-14x5-56-side-mirrored-candidate-v3';
    /* 丢帧标记：正常 seq 差 1；差多了就是中间丢了这么多帧。按到达顺序比，
       不按导出顺序 —— 序号本来就是发送侧递增的。 */
    let prevSeq = -1;
    for (const f of st.rec) {
      const gap = prevSeq < 0 ? 1 : ((f.seq - prevSeq) >>> 0);
      prevSeq = f.seq;
      const raw = Array.from(f.slots, (v) => Math.round(v));
      const vals = new Array(PR_N);
      for (let i = 0; i < PR_N; i++) vals[i] = raw[st.slotOf[i]];
      rows.push({
        side, topo, f,
        raw, vals,
        drop: (gap > 1 && gap <= FR_GAP_MAX) ? gap - 1 : 0,
        phy: [f.ax, f.ay, f.az, f.gx0, f.gy0, f.gz0]
      });
    }
  }
  rows.sort((a, b) => a.f.effMs - b.f.effMs);
  return { rows };
}

/* 导出 parquet，列名/类型/单位码与 app 的 standard_measurement_frames 一致，
   另加 temperature_c（app 目前不写温度）、device_date / device_time（帧头里的设备
   日历原文）与 dropped_frames_before（seq 跳号推出的丢帧数）。
   schema 必须显式给出：交给库自己推断的话，数组会被写成 JSON 字符串而不是 list。 */
const FR_LISTS = new Set(['pressure_raw_values', 'pressure_values',
  'imu_raw_values', 'imu_physical_values']);

const FR_INT64 = new Set(['source_frame_ordinal', 'effective_elapsed_us']);

const FR_INT32 = new Set(['dropped_frames_before']);

/* 26 位大写十六进制，够当一次采集的 dataset / session 标识 */
function frUid() {
  const b = new Uint8Array(13);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function irParquetColumns() {
  const { rows } = irFramesRows();
  if (!rows.length) return null;
  const n = rows.length;
  const one = (v) => new Array(n).fill(v);
  const cols = [
    { name: 'schema_id', data: one('standard_measurement_frame') },
    { name: 'schema_version', data: one('1.0.0') },
    { name: 'dataset_id', data: one(FR_DATASET_ID) },
    { name: 'product_code', data: one('lab') },
    { name: 'session_id', data: one(FR_SESSION_ID) },
    { name: 'assigned_side', data: rows.map((r) => r.side) },
    { name: 'source_frame_ordinal', data: rows.map((r, i) => BigInt(i)) },
    { name: 'source_frame_number_raw', data: rows.map((r) => r.f.seq) },
    { name: 'device_date', data: rows.map((r) => (r.f.clk ? r.f.clk.date : '')) },
    { name: 'device_time', data: rows.map((r) => (r.f.clk ? r.f.clk.time : '')) },
    { name: 'dropped_frames_before', data: rows.map((r) => r.drop) },
    { name: 'measurement_contract_id', data: one(FR_MEASUREMENT_CONTRACT) },
    { name: 'sensor_topology_id', data: rows.map((r) => r.topo) },
    { name: 'effective_elapsed_us',
      data: rows.map((r) => BigInt(Math.max(0, Math.round(r.f.effMs * 1000)))) },
    { name: 'temperature_c', data: rows.map((r) => r.f.tempRaw / 100) },
    { name: 'pressure_raw_values', data: rows.map((r) => r.raw) },
    { name: 'pressure_values', data: rows.map((r) => r.vals) },
    { name: 'pressure_raw_unit_code', data: one('raw') },
    { name: 'pressure_value_unit_code', data: one('raw') },
    { name: 'pressure_conversion_id', data: one('d56-adc-identity-v2') },
    { name: 'imu_raw_values', data: rows.map((r) => r.f.raw6) },
    { name: 'imu_physical_values', data: rows.map((r) => r.phy) },
    { name: 'axis_order_code', data: one('ax_ay_az_gx_gy_gz') },
    { name: 'accel_unit_code', data: one('g') },
    { name: 'gyro_unit_code', data: one('deg_per_s') },
    { name: 'imu_unit_status', data: one('confirmed') },
    { name: 'parse_status', data: one('parsed') },
    { name: 'frame_status', data: one('valid') },
    { name: 'pressure_status', data: one('available') },
    { name: 'imu_status', data: one('available') },
  ];
  const schema = [{ name: 'root', num_children: cols.length }];
  for (const c of cols) {
    const nm = c.name;
    if (FR_INT64.has(nm)) {
      schema.push({ name: nm, type: 'INT64', repetition_type: 'REQUIRED' });
    } else if (FR_INT32.has(nm)) {
      schema.push({ name: nm, type: 'INT32', repetition_type: 'REQUIRED' });
    } else if (nm === 'source_frame_number_raw') {
      schema.push({ name: nm, type: 'INT32', converted_type: 'UINT_32', repetition_type: 'REQUIRED' });
    } else if (nm === 'temperature_c') {
      schema.push({ name: nm, type: 'DOUBLE', repetition_type: 'REQUIRED' });
    } else if (FR_LISTS.has(nm)) {
      schema.push(
        { name: nm, repetition_type: 'REQUIRED', converted_type: 'LIST', num_children: 1 },
        { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
        { name: 'element', type: 'DOUBLE', repetition_type: 'OPTIONAL' });
    } else {
      schema.push({ name: nm, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' });
    }
  }
  /* 帧时间来源写进元数据：device-rtc 全用设备日历增量，host-fallback 全用到达时刻，
     mixed 是录到一半设备时钟不可用了 —— 看数据前先知道是哪一种 */
  const devN = rows.filter((r) => r.f.tSrc === 'device').length;
  return {
    cols, schema, n,
    nl: rows.filter((r) => r.side === 'left').length,
    drop: rows.reduce((a, r) => a + r.drop, 0),
    clk: devN === n ? 'device-rtc' : (devN ? 'mixed' : 'host-fallback'),
  };
}

function irParquetBuffer() {
  const c = irParquetColumns();
  if (!c) return null;
  if (!window.ParquetW) throw new Error('parquet_writer.js 没加载');
  const buf = window.ParquetW.parquetWriteBuffer({
    columnData: c.cols, schema: c.schema, codec: 'SNAPPY',
    kvMetadata: [
      { key: 'walkpad.schema_version', value: 'standard_measurement_frames.parquet.v1' },
      { key: 'walkpad.dataset_id', value: FR_DATASET_ID },
      { key: 'walkpad.session_id', value: FR_SESSION_ID },
      { key: 'walkpad.writer_name', value: 'walkpad_imu_tools_web' },
      { key: 'walkpad.writer_version', value: '1.0.0' },
      { key: 'walkpad.sort_order', value: 'effective_elapsed_us,assigned_side' },
      { key: 'walkpad.frame_time_basis', value: c.clk },
      { key: 'walkpad.dropped_frames', value: String(c.drop) },
    ],
    createdBy: 'walkpad_imu_tools_web 1.0.0',
  });
  return { buf, n: c.n, nl: c.nl, drop: c.drop };
}

function irParquet() {
  let out = null;
  try {
    out = irParquetBuffer();
  } catch (e) {
    log('导出失败：' + ((e && e.message) || e), 'e');
    return;
  }
  if (!out) {
    log('没有录到帧：先点「开始记录」，跑完再导出', 'w');
    return;
  }
  download([out.buf], 'application/octet-stream',
    'frames_' + stampName(new Date()) + '.parquet');
  log('已导出 ' + out.n + ' 帧（左 ' + out.nl + ' / 右 ' + (out.n - out.nl) + '）parquet'
    + (out.drop ? '，其中 seq 跳号合计缺 ' + out.drop + ' 帧（见 dropped_frames_before）' : ''), 'i');
}
