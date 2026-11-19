/* 帧导出：把两脚录到的帧写成与 app 同构的 parquet。
   列名、顺序、类型、码值全部照 app 导出的 standard_measurement_frames 抄；
   末尾 5 列（placement_code / gyro_temperature_celsius / device_date / device_time /
   dropped_frames_before）是网页侧写的，app 这一版不写 —— 前两个沿用 app 的列名，
   按列名取值的下游能直接读到；按名单严格比对的会多这 5 列（kvMetadata 里
   walkpad.extra_columns 有登记）。 */

const FR_MEASUREMENT_CONTRACT = 'd56-measurement-v3';
const FR_ENVELOPE_CONTRACT = 'ble_notify_raw.v3';
const FR_CONVERSION = 'd56-adc-identity-v2';
const FR_ALIGN_DEF = 'd56-synchronized-local-calendar-session-v2';

/* 录制起点（页面单调时钟 ms），两脚共用，作为 elapsed_us 的零点 */
let REC_T0 = 0;

/* 一次录制的标识：dataset / session / capture_period 在开始记录时定，
   processing_* 与 alignment_revision 每次导出新生成 —— app 也是每跑一次处理出新值 */
let FR_DATASET_ID = '', FR_SESSION_ID = '', FR_PERIOD_ID = '';
let FR_PROC = { snap: '', attempt: '', align: '' };

/* seq 差得离谱就不当丢帧算（设备重启会让序号归零，那样一次能"丢"出几十万帧） */
const FR_GAP_MAX = 100;

/* 一帧的身份摘要：app 用「排序后的字段表 → sha256」，这里同一口径。
   键按字母序写字面量，等价于它的 SplayTreeMap。 */
function frFrameId(r) {
  return sha256Hex(JSON.stringify({
    assigned_side: r.side,
    dataset_id: FR_DATASET_ID,
    effective_elapsed_us: r.effUs,
    session_id: FR_SESSION_ID,
    source_frame_number_raw: r.f.seq,
    source_frame_ordinal: r.ord,
  }));
}

function irFramesRows() {
  const rows = [];
  for (const foot of IR_SIDES) {
    const st = irStates[foot];
    if (!st.rec.length) continue;
    const side = foot === 'r' ? 'right' : 'left';
    const topo = ($('prTopo', foot) && $('prTopo', foot).value === 'v1')
      ? 'd56-14x5-56-legacy-v1' : 'd56-14x5-56-side-mirrored-candidate-v3';
    const conn = IR_CONNS[st.rec[0].cap] || { stream: '', seg: '', epoch: 0n };
    let prevSeq = -1, prevOrd = null, prevEff = null, ord = 0, unwrap = 0, lastRaw = -1;
    for (let i = 0; i < st.rec.length; i++) {
      const f = st.rec[i];
      /* 序号 32 位，够跑 2 年，绕回只在真绕回时才补 —— 补错比不补更难查 */
      if (lastRaw >= 0 && f.seq < lastRaw && lastRaw - f.seq > 0x80000000) unwrap += 0x100000000;
      lastRaw = f.seq;
      const seqUnw = f.seq + unwrap;
      /* 丢帧数按到达顺序比，不按导出顺序 —— 序号本来就是发送侧递增的 */
      const step = prevSeq < 0 ? 1 : ((f.seq - prevSeq) >>> 0);
      const lost = (step > 1 && step <= FR_GAP_MAX) ? step - 1 : 0;
      prevSeq = f.seq;
      /* source_frame_ordinal 数的是源帧而不是行：丢帧处要跳号，和 app 一样
         （跳到 2/3 而不是 1，下游才能只凭 ordinal 看出中间断过） */
      ord = prevOrd === null ? 1 : prevOrd + (step >= 1 && step <= FR_GAP_MAX ? step : 1);
      const raw = Array.from(f.slots, (v) => Math.round(v));
      const vals = new Array(PR_N);
      for (let k = 0; k < PR_N; k++) vals[k] = raw[st.slotOf[k]];
      const obsUs = Math.max(0, Math.round((f.perf - REC_T0) * 1000));
      /* 设备日历可用才给 effective：不可用时宁可留空并标 unavailable，
         也不要拿到达时刻冒充设备时间（app 的 allowsFallback 也是 false） */
      const effUs = f.tSrc === 'device' ? Math.max(0, Math.round(f.effMs * 1000)) : null;
      rows.push({
        side, topo, f, raw, vals, conn, ord, idx: i, seqUnw, obsUs, effUs,
        prevOrd,
        ordD: prevOrd === null ? null : ord - prevOrd,
        effD: (prevEff === null || effUs === null) ? null : effUs - prevEff,
        cont: prevOrd === null ? 'boundary_start' : (lost ? 'source_gap' : 'continuous'),
        flags: lost ? ['measurement_sequence_gap'] : [],
        drop: lost,
        phy: [f.ax, f.ay, f.az, f.gx0, f.gy0, f.gz0],
      });
      prevOrd = ord;
      prevEff = effUs;
    }
  }
  /* 两脚按同一时间轴重排；没有 effective 的帧退回到达时刻，否则排不到位置 */
  rows.sort((a, b) => (a.effUs === null ? a.obsUs : a.effUs) - (b.effUs === null ? b.obsUs : b.effUs));
  return { rows };
}

/* 列表列在 parquet 里是三层结构，element 的具体类型得逐列给 ——
   全按 DOUBLE 写会让 UINT_32/UINT_64/UTF8 的元素类型全错。 */
function frSch(name, kind) {
  const opt = kind.endsWith('?');
  const base = opt ? kind.slice(0, -1) : kind;
  const rep = opt ? 'OPTIONAL' : 'REQUIRED';
  const scalar = {
    str: { type: 'BYTE_ARRAY', converted_type: 'UTF8' },
    dbl: { type: 'DOUBLE' },
    i32: { type: 'INT32' },
    u32: { type: 'INT32', converted_type: 'UINT_32' },
    i64: { type: 'INT64' },
    u64: { type: 'INT64', converted_type: 'UINT_64' },
  };
  if (scalar[base]) return [Object.assign({ name, repetition_type: rep }, scalar[base])];
  return [
    { name, repetition_type: rep, converted_type: 'LIST', num_children: 1 },
    { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
    { name: 'element', repetition_type: 'OPTIONAL', ...scalar[base.slice(5)] },
  ];
}

function irParquetColumns() {
  const { rows } = irFramesRows();
  if (!rows.length) return null;
  const n = rows.length;
  const one = (v) => new Array(n).fill(v);
  FR_PROC = { snap: ulid(), attempt: ulid(), align: ulid() };
  const cols = [], schema = [{ name: 'root' }];
  const put = (name, kind, data) => { cols.push({ name, data }); schema.push(...frSch(name, kind)); };
  const effOrNull = (r) => (r.effUs === null ? null : BigInt(r.effUs));

  put('schema_id', 'str', one('standard_measurement_frame'));
  put('schema_version', 'str', one('1.0.0'));
  put('dataset_id', 'str', one(FR_DATASET_ID));
  put('frame_identity', 'str', rows.map(frFrameId));
  put('product_code', 'str', one('lab'));
  put('session_id', 'str', one(FR_SESSION_ID));
  put('processing_input_snapshot_id', 'str', one(FR_PROC.snap));
  put('processing_attempt_id', 'str', one(FR_PROC.attempt));
  put('alignment_revision_id', 'str', one(FR_PROC.align));
  put('capture_stream_id', 'str', rows.map((r) => r.conn.stream));
  put('assigned_side', 'str', rows.map((r) => r.side));
  put('capture_period_id', 'str?', one(FR_PERIOD_ID));
  put('stream_segment_id', 'str', rows.map((r) => r.conn.seg));
  put('connection_epoch', 'u64', rows.map((r) => r.conn.epoch));
  put('source_frame_ordinal', 'i64', rows.map((r) => BigInt(r.ord)));
  put('source_frame_number_raw', 'u32?', rows.map((r) => r.f.seq));
  put('source_frame_number_unwrapped', 'i64?', rows.map((r) => BigInt(r.seqUnw)));
  put('measurement_contract_id', 'str', one(FR_MEASUREMENT_CONTRACT));
  put('raw_envelope_contract_version', 'str', one(FR_ENVELOPE_CONTRACT));
  put('sensor_topology_id', 'str', rows.map((r) => r.topo));
  put('pressure_conversion_id', 'str', one(FR_CONVERSION));
  put('alignment_timestamp_definition_id', 'str', one(FR_ALIGN_DEF));
  /* 设备日历格式不成立（极少）时域标 unknown：值仍旧给，但不能谎称是设备日历 */
  put('source_time_domain', 'str', rows.map((r) => (r.f.clk ? 'device_local_calendar' : 'unknown')));
  put('source_time_value', 'i64',
    rows.map((r) => BigInt(r.f.clk ? r.f.clk.epoch : Math.round(performance.timeOrigin + r.f.perf))));
  put('source_time_unit_code', 'str', one('ms'));
  put('device_time_raw', 'u32?', rows.map((r) => (r.f.clk ? r.f.ts : null)));
  put('device_time_unit_code', 'str', one('unknown'));
  put('observed_session_elapsed_us', 'i64', rows.map((r) => BigInt(r.obsUs)));
  put('aligned_session_elapsed_us', 'i64?', rows.map(effOrNull));
  put('effective_time_status', 'str', rows.map((r) => (r.effUs === null ? 'unavailable' : 'mapped')));
  put('effective_elapsed_us', 'i64?', rows.map(effOrNull));
  put('pressure_raw_bits', 'list.u32?', rows.map(() => []));
  put('pressure_raw_values', 'list.dbl', rows.map((r) => r.raw));
  put('pressure_values', 'list.dbl', rows.map((r) => r.vals));
  put('pressure_raw_unit_code', 'str', one('raw'));
  put('pressure_value_unit_code', 'str', one('raw'));
  put('sensor_layout_version', 'str', rows.map((r) => r.topo));
  put('conversion_version', 'str', one(FR_CONVERSION));
  put('imu_raw_bits', 'list.u32?', rows.map(() => []));
  put('imu_raw_values', 'list.dbl', rows.map((r) => r.f.raw6));
  put('imu_physical_values', 'list.dbl?', rows.map((r) => r.phy));
  put('axis_order_code', 'str', one('ax_ay_az_gx_gy_gz'));
  put('accel_unit_code', 'str', one('g'));
  put('gyro_unit_code', 'str', one('deg_per_s'));
  put('imu_unit_status', 'str', one('confirmed'));
  put('source_asset_ids', 'list.str', rows.map((r) => [r.conn.stream]));
  put('source_chunk_indices', 'list.i32', rows.map(() => [0]));
  put('source_record_indices', 'list.i64', rows.map((r) => [BigInt(r.idx)]));
  put('source_native_sequences', 'list.u64', rows.map((r) => [BigInt(r.seqUnw)]));
  put('source_native_monotonic_ns', 'list.i64',
    rows.map((r) => [BigInt(Math.round(r.f.perf * 1e6))]));
  put('source_session_elapsed_us', 'list.i64', rows.map((r) => [BigInt(r.obsUs)]));
  put('raw_packet_sha256', 'str?', rows.map((r) => r.f.pkt || null));
  put('capture_disposition', 'str', one('effective'));
  put('parse_status', 'str', one('parsed'));
  put('frame_status', 'str', one('valid'));
  put('pressure_status', 'str', one('available'));
  put('imu_status', 'str', one('available'));
  put('previous_source_frame_ordinal', 'i64?',
    rows.map((r) => (r.prevOrd === null ? null : BigInt(r.prevOrd))));
  put('source_frame_ordinal_delta', 'i64?',
    rows.map((r) => (r.ordD === null ? null : BigInt(r.ordD))));
  put('effective_elapsed_delta_us', 'i64?',
    rows.map((r) => (r.effD === null ? null : BigInt(r.effD))));
  put('continuity_status', 'str', rows.map((r) => r.cont));
  put('quality_flag_codes', 'list.str', rows.map((r) => r.flags));

  /* app 5.x 把侧别从 assigned_side 挪到了 placement_code；两列都给，只看其中一列的下游都能取到 */
  put('placement_code', 'str', rows.map((r) => (r.side === 'left' ? 'left_instep' : 'right_instep')));

  /* 网页侧写的，app 这一版没有；列名照 app 5.x 用 gyro_temperature_celsius（0.01 ℃ 量化） */
  put('gyro_temperature_celsius', 'dbl', rows.map((r) => r.f.tempRaw / 100));
  put('device_date', 'str', rows.map((r) => (r.f.clk ? r.f.clk.date : '')));
  put('device_time', 'str', rows.map((r) => (r.f.clk ? r.f.clk.time : '')));
  put('dropped_frames_before', 'i32?', rows.map((r) => r.drop));

  schema[0].num_children = cols.length;
  const devN = rows.filter((r) => r.effUs !== null).length;
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
      { key: 'walkpad.processing_input_snapshot_id', value: FR_PROC.snap },
      { key: 'walkpad.processing_attempt_id', value: FR_PROC.attempt },
      { key: 'walkpad.alignment_revision_id', value: FR_PROC.align },
      { key: 'walkpad.writer_name', value: 'walkpad_imu_tools_web' },
      { key: 'walkpad.writer_version', value: '1.1.0' },
      { key: 'walkpad.extra_columns',
        value: 'placement_code,gyro_temperature_celsius,device_date,device_time,dropped_frames_before' },
      { key: 'walkpad.created_at_utc', value: new Date().toISOString() },
      { key: 'walkpad.sort_order', value: 'effective_elapsed_us,assigned_side' },
      { key: 'walkpad.frame_time_basis', value: c.clk },
      { key: 'walkpad.dropped_frames', value: String(c.drop) },
    ],
    createdBy: 'walkpad_imu_tools_web 1.1.0',
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
