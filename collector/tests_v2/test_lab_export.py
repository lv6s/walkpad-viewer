import io
import json
import zipfile
from datetime import datetime, timezone

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.exports import export_package
from backend.lab_attitude import LabAttitude
from backend.storage import FRAME_SCHEMA


STILL = (0, 0, 2049, 5, -8, 15)


def test_attitude_restarts_without_integrating_invalid_samples():
    fusion = LabAttitude('a')
    assert fusion.add((0, 0, 1000, 0, 0, 0), 0) is None
    for i in range(100):
        assert fusion.add(STILL, i * 20_000)[2:] == (None, 'a:0')
    assert fusion.add(STILL, 2_000_000)[2:] == (0, 'a:0')
    turn = STILL[:5] + (1015,)
    assert fusion.add(turn, 2_000_000) is None
    assert fusion.add(turn, 1_900_000) is None
    assert fusion.add(turn, None) is None
    assert fusion.add((0, 0, 0, 0, 0, 0), 2_010_000) is None
    assert fusion.add(turn, 2_020_000)[2:] == (pytest.approx(1.4), 'a:0')
    assert fusion.add(STILL, 2_270_000)[2:] == (pytest.approx(1.4), 'a:0')
    assert fusion.add(STILL, 2_520_001)[2:] == (None, 'a:1')
    assert fusion.add((32760,) + STILL[1:], 2_540_001) is None
    assert fusion.add(STILL, 2_560_001)[2:] == (None, 'a:2')


def make_record(path, *, long=False):
    path.mkdir()
    (path/'manifest.json').write_text(json.dumps({'session_id':path.name,'status':'complete'}), encoding='utf-8')
    epoch_ms = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc).timestamp() * 1000
    rows = []

    def add(device, segment, i, raw, kind='imu', profile='insole'):
        timestamp = None if i is None else epoch_ms + i * 20
        rows.append(dict(profile=profile,device_kind=kind,device_id=device,connection=segment,
                         foot='l' if kind == 'insole' else '',placement='rightAnkle' if kind == 'imu' else None,
                         device_calendar_ms=timestamp,source_frame_number_raw=i,receipt_monotonic_ms=1000+len(rows),
                         pressure_raw_values=[0]*70,imu_raw_values=raw,imu_physical_values=[42.]*6,
                         sensor_topology='v2',imu_bias_ready=True,imu_bias_dps=[1.,2.,3.],imu_bias_revision=1))

    for i in range(20_002 if long else 110):
        add('left', 'left1', i, STILL if i < 101 else STILL[:5] + (1015,), kind='insole')
        if i < 102:
            add('ankle', 'ankle1', i, STILL)
    add('ankle', 'ankle2', 103, (0, 205, 2038, 0, 0, 0))
    add('ankle', 'ankle2', None, STILL)
    add('wit', 'wit1', 0, STILL, profile='wt')
    pq.write_table(pa.Table.from_pylist(rows[:205],schema=FRAME_SCHEMA),path/'frames_000001.parquet')
    pq.write_table(pa.Table.from_pylist(rows[205:],schema=FRAME_SCHEMA),path/'frames_000002.parquet')
    return path


def test_http_lab_package_v25(tmp_path):
    with TestClient(create_app(tmp_path,demo=True)) as client:
        make_record(tmp_path/'records'/'20260102_030405_1234567890')
        response = client.get('/api/sessions/20260102_030405_1234567890/export?format=package')
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as z:
        manifest = json.loads(z.read('manifest.json'))
        assert manifest['schemaVersion'] == 'lab_measurement_package.v2.5'
        assert len(manifest['sources']) == 2
        tables = {}
        by_id = {s['sourceId']:s['deviceFamily'] for s in manifest['sources']}
        for output in manifest['outputs']:
            if output['path'].startswith('frames/'):
                table = pq.read_table(io.BytesIO(z.read(output['path'])))
                assert table.column_names == list(manifest['physicalSchemas']['frame'])
                assert table.column_names[14:19] == ['pitchDeg','sideTiltDeg','relativeHeadingDeg','referenceId','pressureAdc']
                assert len(table.column_names) == 30
                tables[by_id[output['sourceId']]] = table.to_pylist()
    left, ankle = tables['d56'], tables['walkpadImu']
    assert left[0]['deviceTimeRaw'] == '20260102030405000'
    assert left[0]['accelerationG']['z'] == pytest.approx(2049 * .000488)
    assert left[0]['angularVelocityDps'] == pytest.approx({'x':-.56,'y':-.35,'z':1.05})
    assert left[0]['imuCalibration']['angularVelocityCompensatedDps'] == pytest.approx({'x':-1.56,'y':-2.35,'z':-1.95})
    assert len(left[0]['pressureAdc']) == 56 and ankle[0]['pressureAdc'] is None
    assert left[99]['relativeHeadingDeg'] is None and left[100]['relativeHeadingDeg'] == 0
    assert left[101]['relativeHeadingDeg'] == pytest.approx(1.4)
    assert left[101]['referenceId'] == left[99]['referenceId'] != ankle[100]['referenceId']
    assert ankle[101]['relativeHeadingDeg'] == 0
    assert ankle[102]['sideTiltDeg'] < 0 and ankle[102]['relativeHeadingDeg'] is None
    assert ankle[102]['referenceId'] != ankle[101]['referenceId']
    assert all(ankle[103][column] is None for column in ('pitchDeg','sideTiltDeg','relativeHeadingDeg','referenceId'))


def test_attitude_survives_package_part_boundary(tmp_path):
    target = export_package(make_record(tmp_path/'capture',long=True))
    with zipfile.ZipFile(target) as archive:
        paths = [p for p in archive.namelist() if p.startswith('frames/d56_')]
        assert len(paths) == 2
        columns = ['index','referenceId','relativeHeadingDeg']
        prev = pq.read_table(io.BytesIO(archive.read(paths[0])),columns=columns).to_pylist()[-1]
        curr = pq.read_table(io.BytesIO(archive.read(paths[1])),columns=columns).to_pylist()[0]
    assert (prev['index'],curr['index']) == (19999,20000)
    assert prev['referenceId'] == curr['referenceId']
    assert (curr['relativeHeadingDeg']-prev['relativeHeadingDeg']) % 360 == pytest.approx(1.4)
