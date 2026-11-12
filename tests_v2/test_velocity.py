import asyncio
import json
import math
import struct
import time

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.capture import Capture
from backend.protocol import demo_packet
from backend.velocity import G, VelocityEstimator


def initialized(acc=(0., 0., 1.), gyro=(.3, -.2, .1)):
    tracker = VelocityEstimator()
    tracker.arm()
    for i in range(111):
        state = tracker.push([*acc, *gyro], i*20., 'a', 'device', i)
    assert state['valid'], state
    return tracker


@pytest.mark.parametrize('acc', [(0., 0., 1.), (1., 0., 0.), (0., .6, .8), (0., 0., -1.)])
def test_stationary_any_orientation(acc):
    tracker = initialized(acc)
    for i in range(111, 250):
        state = tracker.push([*acc, .3, -.2, .1], i*20., 'a', 'device', i)
    assert state['speed_mps'] < 1e-9


def test_known_acceleration_and_no_false_zero_velocity():
    tracker = initialized(gyro=(0., 0., 0.))
    for i in range(111, 161):
        state = tracker.push([1/G, 0., 1., 0., 0., 0.], i*20., 'a', 'device', i)
    assert state['velocity_mps'][0] == pytest.approx(.99, abs=.001)
    for i in range(161, 211):
        state = tracker.push([0., 0., 1., 0., 0., 0.], i*20., 'a', 'device', i)
    assert state['velocity_mps'][0] == pytest.approx(1., abs=.001)
    assert state['speed_mps'] > .99


def test_rotation_compensates_gravity():
    tracker = initialized(gyro=(0., 0., 0.))
    for i in range(111, 161):
        angle = (i-110)*.02*math.pi/4
        acc = [0., math.sin(angle), math.cos(angle)]
        state = tracker.push([*acc, 45., 0., 0.], i*20., 'a', 'device', i)
    assert state['speed_mps'] < 1e-8


@pytest.mark.parametrize('change,reason', [
    ({'clock_ms': 2200.}, 'time_gap'),
    ({'clock_ms': 2100.}, 'time_gap'),
    ({'clock_ms': 2700.}, 'time_gap'),
    ({'sequence': 112}, 'sequence_gap'),
    ({'connection': 'b'}, 'connection_changed'),
    ({'domain': 'host'}, 'connection_changed'),
    ({'values': [math.nan, 0., 1., 0., 0., 0.]}, 'invalid_sample'),
    ({'values': [0., 0., 16., 0., 0., 0.]}, 'saturated'),
    ({'clock_ms': None}, 'invalid_sample'),
])
def test_discontinuities_hide_numbers(change, reason):
    tracker = initialized()
    args = dict(values=[0., 0., 1., .3, -.2, .1], clock_ms=2220., connection='a', domain='device', sequence=111)
    args.update(change)
    state = tracker.push(**args)
    assert state['status'] == reason
    assert state['speed_mps'] is None and state['velocity_mps'] is None
    json.dumps(state, allow_nan=False)


def test_horizon_and_reinitialize():
    tracker = initialized()
    for i in range(111, 352):
        state = tracker.push([0., 0., 1., .3, -.2, .1], i*20., 'a', 'device', i)
    assert state['status'] == 'expired' and state['speed_mps'] is None
    assert tracker.arm()['status'] == 'calibrating'
    assert tracker.snapshot()['elapsed_s'] == 0


def test_motion_during_initialization_does_not_initialize():
    tracker = VelocityEstimator()
    tracker.arm()
    for i in range(751):
        state = tracker.push([0., 0., 1., 5., 0., 0.], i*20., 'a', 'device', i)
        assert not state['valid']
    assert tracker.push([0., 0., 1., 5., 0., 0.], 15020., 'a', 'device', 751)['status'] == 'calibration_timeout'


@pytest.mark.parametrize('profile', ['insole', 'wt'])
def test_capture_velocity_on_wrist_and_device_isolation(tmp_path, profile):
    async def run():
        c = Capture(tmp_path)
        try:
            d = c._device('wrist', '腕部', profile, None, placement='rightWrist')
            other = c._device('other', '另一台', profile, None, placement='custom1', label='腰部')
            d['connected'] = True
            d['connection'] = 'one'
            d['velocity_tracker'].arm()
            origin = time.time()*1000
            receipt = time.monotonic()*1000
            for i in range(111):
                if profile == 'insole':
                    packet = demo_packet(profile, i, None, origin+i*20)
                else:
                    packet = b'\x55\x61'+struct.pack('<9h', 0, 0, 2048, 0, 0, 0, 0, 0, 0)
                c._process(d['id'], packet, receipt+i*20, origin+i*20, None, None, False)
            state = c.public(d)['velocity']
            assert state['valid'] and state['speed_mps'] < 1e-9, state
            assert c.history[-1]['velocity']['valid']
            assert c.public(other)['velocity']['status'] == 'idle'
            d['velocity_last_receipt'] = time.monotonic()*1000-1000
            assert c.public(d)['velocity']['status'] == 'stale'
            assert c.public(d)['velocity']['speed_mps'] is None
        finally:
            await c.close()
    asyncio.run(run())


def test_device_profile_change_clears_velocity(tmp_path):
    async def run():
        c = Capture(tmp_path)
        try:
            d = c._device('same', '设备', 'insole', 'l')
            d['velocity_tracker'].arm()
            d2 = c._device('same', '设备', 'wt', 'l')
            assert d2['velocity_tracker'].status == 'idle'
        finally:
            await c.close()
    asyncio.run(run())


def test_wt_batched_notifications_rejected(tmp_path):
    async def run():
        c = Capture(tmp_path)
        try:
            d = c._device('wt', 'WT', 'wt', None)
            d['connected'] = True
            d['velocity_tracker'].arm()
            packet = b'\x55\x61'+struct.pack('<9h', 0, 0, 2048, 0, 0, 0, 0, 0, 0)
            c._process('wt', packet*2, time.monotonic()*1000, time.time()*1000, None, None, False)
            assert d['velocity_tracker'].status == 'time_gap'
        finally:
            await c.close()
    asyncio.run(run())


def test_velocity_api_validation(tmp_path):
    with TestClient(create_app(tmp_path, demo=True)) as client:
        token = client.get('/api/config').json()['control_token']
        headers = {'X-Walkpad-Token': token}
        assert client.post('/api/control', headers=headers, json=dict(action='velocity_start', device_id='missing')).status_code == 400
        client.post('/api/control', headers=headers, json=dict(action='demo', profile='insole'))
        for _ in range(100):
            state = client.get('/api/status').json()
            if state['devices'] and state['devices'][0]['last']:
                break
        response = client.post('/api/control', headers=headers, json=dict(action='velocity_start', device_id='demo:l'))
        assert response.status_code == 200, response.text
        assert response.json()['status'] == 'calibrating'
        response = client.post('/api/control', headers=headers, json=dict(action='velocity_stop', device_id='demo:l'))
        assert response.json()['status'] == 'idle'
