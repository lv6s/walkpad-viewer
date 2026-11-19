from pathlib import Path
import json, zipfile
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

root = Path(__file__).parent / '.activity-fixtures'
root.mkdir(exist_ok=True)

def frame(i, side, gap=False):
    t = i / 50
    k = 0 if side == 'left' else .3
    valid = not (gap and 6 <= t < 7)
    return {'effectiveElapsedUs': int(t * 1e6) if valid else None, 'timeUs': int(t * 1e6), 'validity': 'valid' if valid else 'excluded', 'frameType': 'inertial', 'pressureAdc': [], 'accelerationG': {'x': float(.2 * np.sin(t * 8 + k)), 'y': .1, 'z': 1.}, 'angularVelocityDps': {'x': float(70 * np.sin(t * 8 + k)), 'y': 2., 'z': 1.}, 'deviceSequence': i, 'temperatureCelsius': 25.}

def package(name, count, sides=('left', 'right'), gap=False):
    outputs = []; sources = []
    with zipfile.ZipFile(root / name, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for side in sides:
            path = f'frames/{side}/frame-00001.parquet'
            table = pa.Table.from_pylist([frame(i, side, gap and side == 'right') for i in range(count)])
            sink = pa.BufferOutputStream(); pq.write_table(table, sink, row_group_size=1000)
            z.writestr(path, sink.getvalue().to_pybytes()); sources.append({'sourceId': side, 'placement': side + 'Instep', 'pressureChannelCount': 0}); outputs.append({'sourceId': side, 'path': path})
        z.writestr('manifest.json', json.dumps({'schemaVersion': 'test', 'sources': sources, 'outputs': outputs}))
    print(name, count)

package('dual_gap.zip', 1001, gap=True)
with zipfile.ZipFile(root / 'pressure_dual.zip', 'w', compression=zipfile.ZIP_DEFLATED) as z:
    sources = []; outputs = []
    for side in ('left', 'right'):
        frames = [frame(i, side) for i in range(1001)]
        for i, r in enumerate(frames): r['pressureAdc'] = [int(50 + 40 * np.sin(i / 10 + c / 10)) for c in range(56)]
        sink = pa.BufferOutputStream(); pq.write_table(pa.Table.from_pylist(frames), sink)
        path = f'frames/{side}/frame-00001.parquet'; z.writestr(path, sink.getvalue().to_pybytes())
        sources.append({'sourceId': side, 'placement': side + 'Insole', 'pressureChannelCount': 56}); outputs.append({'sourceId': side, 'path': path})
    z.writestr('manifest.json', json.dumps({'schemaVersion': 'test-pressure', 'sources': sources, 'outputs': outputs}))
package('single.zip', 1001, sides=('left',))
package('long_dual.zip', 30051)

# 真实 WT 包一条 BLE 通知带 2 帧惯性数据，两帧共用同一个「通知完成时刻」；
# 照用同一时刻曾让整段推理退化为 0 有效帧，这里固定住该形态。
def batched(name, count):
    sources = []; outputs = []
    with zipfile.ZipFile(root / name, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for side in ('left', 'right'):
            rows = []
            for i in range(count):
                r = frame(i, side)
                r['effectiveElapsedUs'] = r['timeUs'] = (i // 2) * 40000
                rows.append(r)
            sink = pa.BufferOutputStream(); pq.write_table(pa.Table.from_pylist(rows), sink)
            path = f'frames/{side}/frame-00001.parquet'; z.writestr(path, sink.getvalue().to_pybytes())
            sources.append({'sourceId': side, 'placement': side + 'Instep', 'pressureChannelCount': 0}); outputs.append({'sourceId': side, 'path': path})
        z.writestr('manifest.json', json.dumps({'schemaVersion': 'test-batched', 'sources': sources, 'outputs': outputs}))
    print(name, count)

batched('batched.zip', 1001)
rows = []
for side in ('left', 'right'):
    for i in range(1001):
        f = frame(i, side)
        rows.append({'effective_elapsed_us': f['effectiveElapsedUs'], 'pressure_values': [], 'assigned_side': side, 'imu_physical_values': list(f['accelerationG'].values()) + list(f['angularVelocityDps'].values()), 'imu_unit_status': 'confirmed', 'source_frame_number_unwrapped': i, 'effective_time_status': 'mapped'})
pq.write_table(pa.Table.from_pylist(rows), root / 'dual.parquet')

import base64, struct
journal = [{'type': 'start', 'phone_ms': 100000, 'app_version': '1.1.0', 'preprocess': 'activity-wt-receipt-v1'}]
for i in range(1001):
    for foot in range(2):
        packet = bytes([0x55, 0x61]) + struct.pack('<6h', 0, 0, 2048, int(800 * np.sin(i / 10)), 0, 0) + bytes(6)
        journal.append({'type': 'notify', 'foot': foot, 'connection': 1, 'receipt_ms': 100020 + i * 20, 'bytes': base64.b64encode(packet).decode()})
with zipfile.ZipFile(root / 'wt_local.zip', 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('session.jsonl', '\n'.join(json.dumps(r) for r in journal))
