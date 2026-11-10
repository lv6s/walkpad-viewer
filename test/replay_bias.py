import collections
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]


def replay(sid):
    rows = []
    for p in sorted((ROOT / 'records' / sid).glob('frames_*.parquet')):
        rows.extend(pq.read_table(p, columns=['foot', 'connection', 'source_receipt_ms', 'receipt_monotonic_ms',
                    'device_calendar_ms', 'source_frame_number_raw', 'imu_raw_values']).to_pylist())
    rows.sort(key=lambda r: r['source_receipt_ms'])
    records = [dict(foot=r['foot'], connection=r['connection'], processing_ms=r['source_receipt_ms'],
                    receipt_ms=r['source_receipt_ms'], device_ms=r['device_calendar_ms'],
                    seq=r['source_frame_number_raw'], raw6=r['imu_raw_values']) for r in rows
               if r['foot'] in ('l', 'r') and r['imu_raw_values'] and r['device_calendar_ms'] is not None]
    result = {'session': sid, 'rows': len(records), 'modes': {}, 'source_sha256': {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
        ['backend/reference/insole_bias.cjs', 'backend/noise_gate.cjs', 'backend/bias_worker.cjs']}}
    for mode in ('legacy', 'bounded'):
        env = dict(os.environ, WALKPAD_BIAS_GATE='legacy' if mode == 'legacy' else 'bounded')
        p = subprocess.run(['node', str(ROOT / 'backend' / 'bias_worker.cjs')],
                           input=json.dumps({'records': records}) + '\n', capture_output=True,
                           text=True, encoding='utf-8', env=env,
                           creationflags=0x08000000 if sys.platform == 'win32' else 0)
        if p.returncode:
            raise RuntimeError(p.stderr[-2000:])
        output = json.loads(p.stdout)
        if not output['ok']:
            raise RuntimeError(output['error'])
        feet = {}
        for foot in ('l', 'r'):
            tr = [r for r in output['trace'] if r['foot'] == foot]
            t0 = tr[0]['processing_ms']
            ready = [r for r in tr if r['ready']]
            changes, before = [], None
            for r in ready:
                g = r['gyro_bias_dps']
                if g != before:
                    changes.append({'t': round((r['processing_ms'] - t0) / 1000, 3), 'bias': g,
                                    'diagnostics': r.get('diagnostics')})
                    before = g
            rejected = collections.Counter(r['status'].split('：', 1)[-1].split(' · ')[0]
                                           for r in tr if r['status'].startswith('等待下一段静止：'))
            feet[foot] = dict(frames=len(tr), span_s=round((tr[-1]['processing_ms'] - t0) / 1000, 3),
                              first_ready_s=round((ready[0]['processing_ms'] - t0) / 1000, 3) if ready else None,
                              final_bias=ready[-1]['gyro_bias_dps'] if ready else None,
                              updates=len(changes), reject_counts=dict(rejected),
                              accepted_windows=tr[-1].get('accepted_windows'),
                              last_reject=tr[-1].get('last_reject'), changes=changes)
            # 只报告跨窗一致性；没有外部静止标签，不称真实误差。
            if changes:
                b = np.array([c['bias'] for c in changes])
                feet[foot]['accepted_bias_std'] = b.std(0).tolist()
        result['modes'][mode] = feet
    return result


if __name__ == '__main__':
    out = [replay(s) for s in sys.argv[1:]]
    target = ROOT / 'runtime' / 'debug' / 'bias_replay_bounded.json'
    target.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    for item in out:
        print(item['session'], item['rows'])
        for mode, feet in item['modes'].items():
            for foot, result in feet.items():
                print(mode, foot, json.dumps({k: v for k, v in result.items() if k != 'changes'}, ensure_ascii=False))
