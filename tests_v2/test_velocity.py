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
    for i in range(261):
        state = tracker.push([*acc, *gyro], i*20., 'a', 'device', i)
    assert state['valid'], state
    return tracker


@pytest.mark.parametrize('acc', [(0., 0., 1.), (1., 0., 0.), (0., .6, .8), (0., 0., -1.)])
def test_stationary_any_orientation(acc):
    tracker = initialized(acc)
    for i in range(261, 400):
        state = tracker.push([*acc, .3, -.2, .1], i*20., 'a', 'device', i)
    assert state['speed_mps'] < 1e-9


def test_known_acceleration_and_no_false_zero_velocity():
    tracker = initialized(gyro=(0., 0., 0.))
    for i in range(261, 311):
        state = tracker.push([1/G, 0., 1., 0., 0., 0.], i*20., 'a', 'device', i)
    assert state['velocity_mps'][0] == pytest.approx(.99, abs=.001)
    for i in range(311, 361):
        state = tracker.push([0., 0., 1., 0., 0., 0.], i*20., 'a', 'device', i)
    assert state['velocity_mps'][0] == pytest.approx(1., abs=.001)
    assert state['speed_mps'] > .99


def test_rotation_compensates_gravity():
    tracker = initialized(gyro=(0., 0., 0.))
    for i in range(261, 311):
        angle = (i-260)*.02*math.pi/4
        acc = [0., math.sin(angle), math.cos(angle)]
        state = tracker.push([*acc, 45., 0., 0.], i*20., 'a', 'device', i)
    assert state['speed_mps'] < 1e-8


@pytest.mark.parametrize('change,reason', [
    ({'clock_ms': 5200.}, 'time_gap'),
    ({'clock_ms': 5100.}, 'time_gap'),
    ({'clock_ms': 5700.}, 'time_gap'),
    ({'sequence': 262}, 'sequence_gap'),
    ({'connection': 'b'}, 'connection_changed'),
    ({'domain': 'host'}, 'connection_changed'),
    ({'values': [math.nan, 0., 1., 0., 0., 0.]}, 'invalid_sample'),
    ({'values': [0., 0., 16., 0., 0., 0.]}, 'saturated'),
    ({'clock_ms': None}, 'invalid_sample'),
])
def test_discontinuities_hide_numbers(change, reason):
    tracker = initialized()
    args = dict(values=[0., 0., 1., .3, -.2, .1], clock_ms=5220., connection='a', domain='device', sequence=261)
    args.update(change)
    state = tracker.push(**args)
    assert state['status'] == reason
    assert state['speed_mps'] is None and state['velocity_mps'] is None
    json.dumps(state, allow_nan=False)


def test_continuous_estimation_and_reinitialize():
    tracker = initialized()
    for i in range(261, 3261):
        state = tracker.push([0., 0., 1., .3, -.2, .1], i*20., 'a', 'device', i)
    assert state['valid'] and state['elapsed_s'] > 60
    assert state['speed_mps'] < 1e-9
    assert 'remaining_s' not in state and 'horizon_s' not in state
    assert tracker.arm()['status'] == 'calibrating'
    assert tracker.snapshot()['elapsed_s'] == 0


def external_initialized():
    tracker = VelocityEstimator(external_bias=True)
    tracker.arm()
    bias = {'ready':True, 'gyro_bias_dps':[.3, -.2, .1]}
    for i in range(261):
        state = tracker.push([0., 0., 1., .3, -.2, .1], i*20., 'a', 'device', i, bias_state=bias)
    assert state['valid']
    return tracker


def test_online_bias_update_preserves_velocity_and_does_not_double_subtract():
    tracker = external_initialized()
    for i in range(261, 311):
        tracker.push([1/G, 0., 1., .3, -.2, .1], i*20., 'a', 'device', i,
                     bias_state={'ready':True, 'gyro_bias_dps':[.3, -.2, .1]})
    for i in range(311, 3261):
        bias = [.3+(i-310)*.0001, -.2, .1]
        state = tracker.push([0., 0., 1., *bias], i*20., 'a', 'device', i,
                             bias_state={'ready':True, 'gyro_bias_dps':bias})
    assert state['valid'] and state['elapsed_s'] > 60
    assert state['velocity_mps'] == pytest.approx([1., 0., 0.], abs=1e-8)
    assert tracker.q == pytest.approx([1., 0., 0., 0.], abs=1e-10)
    assert state['gyro_bias_dps'] == bias


@pytest.mark.parametrize('state,reason', [
    (None, 'bias_unavailable'),
    ({'ready':False}, 'bias_boundary'),
    ({'ready':True, 'gyro_bias_dps':[0., 0., 0.], 'discontinuity':True}, 'bias_boundary'),
    ({'ready':True, 'gyro_bias_dps':[math.nan, 0., 0.]}, 'bias_boundary'),
])
def test_online_bias_unavailable_does_not_fall_back_to_raw(state, reason):
    tracker = external_initialized()
    result = tracker.push([0., 0., 1., .3, -.2, .1], 5220., 'a', 'device', 261, bias_state=state)
    assert result['status'] == reason and result['speed_mps'] is None


def test_initialization_waits_for_online_bias():
    tracker = VelocityEstimator(external_bias=True)
    tracker.arm()
    for i in range(300):
        state = tracker.push([0., 0., 1., 0., 0., 0.], i*20., 'a', 'device', i,
                             bias_state={'ready':False})
    assert state['status'] == 'calibrating' and state['calibration_progress'] == 1
    state = tracker.push([0., 0., 1., 0., 0., 0.], 6000., 'a', 'device', 300,
                         bias_state={'ready':True, 'gyro_bias_dps':[0., 0., 0.]})
    assert state['valid']


def test_motion_during_initialization_does_not_initialize():
    tracker = VelocityEstimator()
    tracker.arm()
    for i in range(1501):
        state = tracker.push([0., 0., 1., 5., 0., 0.], i*20., 'a', 'device', i)
        assert not state['valid']
    assert tracker.push([0., 0., 1., 5., 0., 0.], 30020., 'a', 'device', 1501)['status'] == 'calibration_timeout'


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
            for i in range(261):
                if profile == 'insole':
                    packet = demo_packet(profile, i, None, origin+i*20)
                else:
                    packet = b'\x55\x61'+struct.pack('<9h', 0, 0, 2048, 0, 0, 0, 0, 0, 0)
                await c._process(d['id'], packet, receipt+i*20, origin+i*20, None, None, False)
            state = c.public(d)['velocity']
            assert state['valid'] and state['speed_mps'] < 1e-9, state
            assert c.history[-1]['velocity']['valid']
            assert state['bias_source'] == ('online' if profile == 'insole' else 'initial')
            if profile == 'insole':
                assert c.history[-1]['bias_used'] == state['gyro_bias_dps']
                shared = c.algorithm.snapshot()['bias'][d['bias_key']]
                assert shared['gyro_bias_dps'] == state['gyro_bias_dps']
                assert shared['ready']
            assert c.public(other)['velocity']['status'] == 'idle'
            d['velocity_last_receipt'] = time.monotonic()*1000-1000
            assert c.public(d)['velocity']['status'] == 'stale'
            assert c.public(d)['velocity']['speed_mps'] is None
        finally:
            await c.close()
    asyncio.run(run())


def test_insole_continues_with_online_updates_when_activity_profile_is_wt(tmp_path):
    async def run():
        c = Capture(tmp_path)
        try:
            await asyncio.wrap_future(c.algorithm.control('configure', profile='wt', enabled=False))
            d = c._device('shoe', '鞋垫', 'insole', None, placement='rightWrist')
            d['connected'] = True
            d['connection'] = 'one'
            d['velocity_tracker'].arm()
            origin = time.time()*1000
            receipt = time.monotonic()*1000
            for i in range(1101):
                packet = demo_packet('insole', i, None, origin+i*20)
                await c._process('shoe', packet, receipt+i*20, origin+i*20, None, None, False)
            state = c.public(d)['velocity']
            bias = c.algorithm.snapshot()['bias'][d['bias_key']]
            assert state['valid'] and state['elapsed_s'] > 15
            assert state['speed_mps'] < 1e-9
            assert bias['accepted_windows'] >= 3
            assert c.history[-1]['bias_used'] == bias['gyro_bias_dps']
            assert c.history[-1]['values'][3:] == pytest.approx([-.14, -.21, .07])
        finally:
            await c.close()
    asyncio.run(run())


def test_waiting_for_bias_cannot_reuse_frame_after_user_stop(tmp_path):
    async def run():
        c = Capture(tmp_path)
        try:
            d = c._device('shoe', '鞋垫', 'insole', None, placement='rightWrist')
            d['connected'] = True
            d['connection'] = 'one'
            d['velocity_tracker'].arm()
            original = c.algorithm.control
            def control(kind, **args):
                future = original(kind, **args)
                if kind == 'prepare_frames':
                    d['velocity_tracker'].reset()
                return future
            c.algorithm.control = control
            now = time.time()*1000
            await c._process('shoe', demo_packet('insole', 0, None, now), time.monotonic()*1000, now, None, None, False)
            assert c.history[-1]['velocity']['status'] == 'idle'
            assert d['velocity_tracker'].clock is None
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
            await c._process('wt', packet*2, time.monotonic()*1000, time.time()*1000, None, None, False)
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
