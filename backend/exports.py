import csv
import json
import os
from datetime import datetime

import pyarrow as pa
import pyarrow.parquet as pq

from .protocol import WT_HEADER, slot_map


def batches(path):
    for file in sorted(path.glob('frames_*.parquet')):
        yield from pq.ParquetFile(file).iter_batches(batch_size=2000)


def export_txt(path):
    target = path/'wt901.txt'
    with target.open('w',encoding='utf-8-sig',newline='') as f:
        writer = csv.writer(f,delimiter='\t',lineterminator='\r\n')
        writer.writerow(WT_HEADER)
        latest = {}
        for batch in batches(path):
            for row in batch.to_pylist():
                if row['profile'] != 'wt':
                    continue
                state = latest.setdefault((row['device_id'],row['connection']),{})
                raw = bytes.fromhex(row['raw_frame_hex'])
                import struct
                kind = row['frame_kind']
                if kind == 0x61:
                    values = list(struct.unpack_from('<9h',raw,2))
                    state['acc'] = [x/2048 for x in values[:3]]
                    state['gyro'] = [x*2000/32768 for x in values[3:6]]
                    state['ang'] = [x*180/32768 for x in values[6:9]]
                elif kind in (0x51,0x52,0x53,0x54):
                    key,scale = {0x51:('acc',1/2048),0x52:('gyro',2000/32768),0x53:('ang',180/32768),0x54:('mag',8000/32768)}[kind]
                    state[key] = [x*scale for x in struct.unpack_from('<3h',raw,2)]
                    state['temperature'] = row['gyro_temperature_celsius']
                if kind == 0x59:
                    state['quat'] = [x/32768 for x in struct.unpack_from('<4h',raw,2)]
                stamp = datetime.fromtimestamp(row['receipt_epoch_ms']/1000).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
                writer.writerow([stamp,row['device_id']]+state.get('acc',['']*3)+state.get('gyro',['']*3)+
                                state.get('ang',['']*3)+state.get('mag',['']*3)+state.get('quat',['']*4)+
                                [state.get('temperature',''),'','','',''])
    return target


def export_standard(path):
    target = path/'standard_measurement_frames.parquet'
    if target.exists():
        return target
    specs = json.loads((__import__('pathlib').Path(__file__).parent/'standard_schema.json').read_text(encoding='utf-8'))
    scalar = {'str':pa.string(),'dbl':pa.float64(),'i32':pa.int32(),'u32':pa.uint32(),'i64':pa.int64(),'u64':pa.uint64()}
    fields = []
    for name,kind in specs:
        key = kind.rstrip('?')
        dtype = pa.list_(scalar[key[5:]]) if key.startswith('list.') else scalar[key]
        fields.append(pa.field(name,dtype,nullable=True))
    schema = pa.schema(fields,metadata={b'walkpad.schema_version':b'standard_measurement_frames.parquet.v1',
                b'walkpad.writer_name':b'walkpad_imu_tools_v2',b'walkpad.writer_version':b'2.0.0',
                b'walkpad.time_sync':b'unverified; effective time unavailable without independent clock synchronization',
                b'walkpad.extra_columns':b'placement_code,gyro_temperature_celsius,device_date,device_time,dropped_frames_before'})
    writer = pq.ParquetWriter(target.with_suffix('.pending'),schema,compression='snappy')
    metadata = json.loads((path/'manifest.json').read_text(encoding='utf-8'))
    origin = metadata.get('started_monotonic_ms',0)
    previous = {}
    ordinal = {}
    try:
        for batch in batches(path):
            rows = []
            for r in batch.to_pylist():
                if r['profile'] != 'insole':
                    continue
                key = (r['device_id'],r['connection'])
                prev = previous.get(key)
                index = ordinal.get(key,0)+1
                ordinal[key] = index
                raw = r['pressure_raw_values']
                slots = slot_map(r['foot'],r['sensor_topology'])
                clock = r['device_calendar_ms']
                observed = max(0,int((r['receipt_monotonic_ms']-origin)*1000))
                side = 'left' if r['foot'] == 'l' else 'right'
                frame = dict(schema_id='standard_measurement_frame',schema_version='1.0.0',dataset_id=r['session_id'],
                    frame_identity=r['raw_packet_sha256']+':'+str(r['event_id'])+':'+str(r['frame_index']),product_code='lab',session_id=r['session_id'],
                    processing_input_snapshot_id=r['session_id'],processing_attempt_id='capture-v2',alignment_revision_id='unaligned-v2',
                    capture_stream_id=r['device_id'],assigned_side=side,capture_period_id=r['session_id'],stream_segment_id=r['connection'],connection_epoch=0,
                    source_frame_ordinal=index,source_frame_number_raw=r['source_frame_number_raw'],source_frame_number_unwrapped=None,
                    measurement_contract_id='d56-measurement-v3',raw_envelope_contract_version='ble_notify_raw.v3',
                    sensor_topology_id='d56-14x5-56-legacy-v1' if r['sensor_topology'] == 'v1' else 'd56-14x5-56-side-mirrored-candidate-v3',
                    pressure_conversion_id='d56-adc-identity-v2',alignment_timestamp_definition_id='unverified-cross-clock-v2',
                    source_time_domain='device_local_calendar' if clock is not None else 'unknown',
                    source_time_value=int(clock) if clock is not None else 0,source_time_unit_code='ms',
                    device_time_raw=None,device_time_unit_code='unknown',observed_session_elapsed_us=observed,
                    aligned_session_elapsed_us=None,effective_time_status='unavailable',effective_elapsed_us=None,
                    pressure_raw_bits=[],pressure_raw_values=raw,pressure_values=[raw[i] for i in slots],
                    pressure_raw_unit_code='raw',pressure_value_unit_code='raw',
                    sensor_layout_version=r['sensor_topology'],conversion_version='d56-adc-identity-v2',
                    imu_raw_bits=[],imu_raw_values=r['imu_raw_values'],imu_physical_values=r['imu_physical_values'],
                    axis_order_code='ax_ay_az_gx_gy_gz',accel_unit_code='g',gyro_unit_code='deg_per_s',imu_unit_status='confirmed',
                    source_asset_ids=[r['device_id']],source_chunk_indices=[0],source_record_indices=[r['event_id']],
                    source_native_sequences=[r['source_frame_number_raw']],source_native_monotonic_ns=[],source_session_elapsed_us=[observed],
                    raw_packet_sha256=r['raw_packet_sha256'],capture_disposition='effective',parse_status='parsed',frame_status='valid',
                    pressure_status='available',imu_status='available',previous_source_frame_ordinal=index-1 if prev else None,
                    source_frame_ordinal_delta=1 if prev else None,effective_elapsed_delta_us=None,
                    continuity_status='boundary_start' if prev is None else 'unverified',
                    quality_flag_codes=['cross_clock_alignment_unverified','sequence_gap_not_equated_to_imu_loss'],
                    placement_code=side+'_instep',gyro_temperature_celsius=r['gyro_temperature_celsius'],device_date='',device_time='',dropped_frames_before=None)
                rows.append(frame)
                previous[key] = r
            if rows:
                writer.write_table(pa.Table.from_pylist(rows,schema=schema))
    finally:
        writer.close()
    os.replace(target.with_suffix('.pending'),target)
    return target
