# -*- coding: utf-8 -*-
"""把网页导出的 frames_*.csv 转成与 app 同构的 parquet。

用法：
    python csv2parquet.py frames_20261103_141500.csv
    python csv2parquet.py frames_xxx.csv -o my.parquet

CSV 里数组列用分号分隔（网页为了不进 CSV 引号），这里还原成 list<double>，
列名、单位码、契约 id 与 app 导出的 standard_measurement_frames 保持一致；
温度列按 app 5.x 的列名 gyro_temperature_celsius 写出（老 CSV 的 temperature_c 也认）。
"""
import argparse
import datetime as _dt
import os
import uuid

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

SPLIT = ';'
SCHEMA_VERSION = '1.0.0'


def _lists(df, col, cast=float, width=None):
    out = []
    for v in df[col].tolist():
        arr = np.array([cast(x) for x in str(v).split(SPLIT) if x != ''], dtype=np.float64)
        if width is not None and len(arr) != width:
            raise ValueError('%s 有一行长度 %d，期望 %d' % (col, len(arr), width))
        out.append(arr)
    return out


def convert(csv_path, out_path=None):
    df = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
    tcol = ('gyro_temperature_celsius' if 'gyro_temperature_celsius' in df.columns
            else 'temperature_c')
    need = ['assigned_side', 'source_frame_number_raw', 'effective_elapsed_us', tcol,
            'pressure_raw_values', 'pressure_values', 'imu_raw_values', 'imu_physical_values']
    missing = [c for c in need if c not in df.columns]
    if missing:
        raise ValueError('CSV 缺少列：%s（请用新版网页导出）' % ', '.join(missing))

    n = len(df)
    if n == 0:
        raise ValueError('CSV 没有数据行')

    raw = _lists(df, 'pressure_raw_values', float, 70)
    val = _lists(df, 'pressure_values', float, 56)
    ira = _lists(df, 'imu_raw_values', float, 6)
    phy = _lists(df, 'imu_physical_values', float, 6)

    # 按有效时间排序，和 app 的 walkpad.sort_order 一致
    order = np.argsort([int(x) for x in df['effective_elapsed_us']], kind='stable')
    pick = lambda seq: [seq[i] for i in order]

    side = [df['assigned_side'].tolist()[i] for i in order]
    frame_no = [int(df['source_frame_number_raw'].tolist()[i]) for i in order]
    elapsed = [int(df['effective_elapsed_us'].tolist()[i]) for i in order]
    tempc = [float(df[tcol].tolist()[i]) for i in order]
    topo = pick(df['sensor_topology_id'].tolist()) if 'sensor_topology_id' in df.columns else [''] * n

    dataset_id = uuid.uuid4().hex.upper()[:26]
    session_id = uuid.uuid4().hex.upper()[:26]
    created = _dt.datetime.now(_dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')

    table = pa.table({
        'schema_id': pa.array(['standard_measurement_frame'] * n, pa.string()),
        'schema_version': pa.array([SCHEMA_VERSION] * n, pa.string()),
        'dataset_id': pa.array([dataset_id] * n, pa.string()),
        'product_code': pa.array(['lab'] * n, pa.string()),
        'session_id': pa.array([session_id] * n, pa.string()),
        'assigned_side': pa.array(side, pa.string()),
        'source_frame_ordinal': pa.array(list(range(n)), pa.int64()),
        'source_frame_number_raw': pa.array(frame_no, pa.uint32()),
        'measurement_contract_id': pa.array(['d56-measurement-v3'] * n, pa.string()),
        'sensor_topology_id': pa.array(list(topo), pa.string()),
        'effective_elapsed_us': pa.array(elapsed, pa.int64()),
        'gyro_temperature_celsius': pa.array(tempc, pa.float64()),
        'pressure_raw_values': pa.array(pick(raw), pa.list_(pa.float64())),
        'pressure_values': pa.array(pick(val), pa.list_(pa.float64())),
        'pressure_raw_unit_code': pa.array(['raw'] * n, pa.string()),
        'pressure_value_unit_code': pa.array(['raw'] * n, pa.string()),
        'pressure_conversion_id': pa.array(['d56-adc-identity-v2'] * n, pa.string()),
        'imu_raw_values': pa.array(pick(ira), pa.list_(pa.float64())),
        'imu_physical_values': pa.array(pick(phy), pa.list_(pa.float64())),
        'axis_order_code': pa.array(['ax_ay_az_gx_gy_gz'] * n, pa.string()),
        'accel_unit_code': pa.array(['g'] * n, pa.string()),
        'gyro_unit_code': pa.array(['deg_per_s'] * n, pa.string()),
        'imu_unit_status': pa.array(['confirmed'] * n, pa.string()),
        'parse_status': pa.array(['parsed'] * n, pa.string()),
        'frame_status': pa.array(['valid'] * n, pa.string()),
        'pressure_status': pa.array(['available'] * n, pa.string()),
        'imu_status': pa.array(['available'] * n, pa.string()),
    })

    meta = {
        b'walkpad.schema_version': b'standard_measurement_frames.parquet.v1',
        b'walkpad.dataset_id': dataset_id.encode(),
        b'walkpad.session_id': session_id.encode(),
        b'walkpad.writer_name': b'walkpad_imu_tools_csv2parquet',
        b'walkpad.writer_version': b'1.0.0',
        b'walkpad.created_at_utc': created.encode(),
        b'walkpad.source_csv': os.path.basename(csv_path).encode(),
        b'walkpad.sort_order': b'effective_elapsed_us,assigned_side',
    }
    table = table.replace_schema_metadata(meta)

    if out_path is None:
        out_path = os.path.splitext(csv_path)[0] + '.parquet'
    pq.write_table(table, out_path, compression='snappy')
    return out_path, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv')
    ap.add_argument('-o', '--out', default=None)
    a = ap.parse_args()
    path, n = convert(a.csv, a.out)
    print('写出 %s（%d 行）' % (path, n))


if __name__ == '__main__':
    main()
