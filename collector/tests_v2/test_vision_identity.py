import hashlib
import sys
import types

import numpy as np
import pytest

import backend.vision_identity as identity_module
from backend.vision_actions import LiveActions
from backend.vision_identity import (
    FEATURE_DIM, MODEL_STEM, PersonIdentity, clear, load_encoder,
)

FRAME = np.zeros((540, 960, 3), np.uint8)
BOX = (0.20, 0.10, 0.55, 0.95)
BOX_BACK = (0.21, 0.10, 0.56, 0.95)
BOX_OTHER = (0.60, 0.10, 0.95, 0.95)


def standing():
    pose = [(0., 0., 0.)] * 17
    for x, hip, knee, foot in ((.32, 11, 13, 15), (.52, 12, 14, 16)):
        pose[hip], pose[knee], pose[foot] = (x, .40, .9), (x, .55, .9), (x, .70, .9)
    return pose


def lowered():
    pose = standing()
    for x, hip, knee in ((.32, 11, 13), (.52, 12, 14)):
        pose[hip], pose[knee] = (x, .55, .9), (x+.105, .59, .9)
    return pose


def unit(*values):
    data = np.zeros(FEATURE_DIM, dtype=np.float32)
    data[:len(values)] = values
    return data / np.linalg.norm(data)


class FakeEncoder:
    def __init__(self, table):
        self.table = table

    def embed(self, image, box):
        return self.table.get(tuple(box))


def step(bank, actions, now, detections):
    mapped, recovered = bank.resolve(now, FRAME, detections)
    actions.reset(recovered)
    return actions.frame(now, mapped)


def test_returning_person_keeps_identity_and_confirmed_count():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0), BOX_BACK: unit(1, .05, 0)}))
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(15):
        now += .12
        step(bank, actions, now, [(1, BOX, standing())])
    for _ in range(10):
        now += .12
        step(bank, actions, now, [(1, BOX, lowered())])
    for _ in range(9):
        now += .12
        last = step(bank, actions, now, [(1, BOX, standing())])
    assert last[0]['count'] == 1
    first = last[0]['id']
    now += 5.
    for _ in range(2):
        now += .12
        assert step(bank, actions, now, [(9, BOX_BACK, standing())]) == []
    now += .12
    last = step(bank, actions, now, [(9, BOX_BACK, standing())])
    assert last[0]['id'] == first
    assert last[0]['count'] == 1


def test_recovered_identity_evicts_stale_raw_track():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0), BOX_BACK: unit(1, .05, 0)}))
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        first = step(bank, actions, now, [(1, BOX, standing())])
    known = first[0]['id']
    for _ in range(8):
        now += .12
        step(bank, actions, now, [])
    for _ in range(2):
        now += .12
        assert step(bank, actions, now, [(9, BOX_BACK, standing())]) == []
    now += .12
    assert step(bank, actions, now, [(9, BOX_BACK, standing())])[0]['id'] == known
    now += .12
    people = step(bank, actions, now, [(9, BOX_BACK, standing()), (1, BOX, standing())])
    ids = [person['id'] for person in people]
    assert len(ids) == len(set(ids)) and ids.count(known) == 1


def test_unknown_person_is_reported_without_delay():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0)}))
    actions = LiveActions(bank.ttl)
    people = step(bank, actions, .12, [(1, BOX, standing())])
    assert [person['id'] for person in people] == [1]


def test_unrelated_appearance_is_rejected_absolutely():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0), BOX_BACK: unit(0, 1, 0)}))
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        first = step(bank, actions, now, [(1, BOX, standing())])
    known = first[0]['id']
    now += 5.
    for _ in range(6):
        now += .12
        last = step(bank, actions, now, [(9, BOX_BACK, standing())])
    assert last and last[0]['id'] != known


def test_close_candidates_need_a_margin():
    left, right = unit(1, .1, 0), unit(1, -.1, 0)
    bank = PersonIdentity(FakeEncoder({BOX: left, BOX_OTHER: right, BOX_BACK: unit(1, 0, 0)}))
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        people = step(bank, actions, now, [(1, BOX, standing()), (2, BOX_OTHER, standing())])
    known = {person['id'] for person in people}
    assert len(known) == 2
    now += 5.
    for _ in range(6):
        now += .12
        last = step(bank, actions, now, [(9, BOX_BACK, standing())])
    assert last[0]['id'] not in known


def test_gallery_expires_after_ttl():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0), BOX_BACK: unit(1, .05, 0)}), ttl=2.)
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        first = step(bank, actions, now, [(1, BOX, standing())])
    known = first[0]['id']
    now += 3.
    for _ in range(6):
        now += .12
        last = step(bank, actions, now, [(9, BOX_BACK, standing())])
    assert last[0]['id'] != known


def test_simultaneous_tracks_never_share_an_identity():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0), BOX_OTHER: unit(1, 0, 0)}))
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(8):
        now += .12
        people = step(bank, actions, now, [(1, BOX, standing()), (2, BOX_OTHER, standing())])
        assert len({person['id'] for person in people}) == 2


def test_long_lapse_is_not_recovered_from_the_track_id():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0), BOX_BACK: unit(0, 0, 1)}))
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        first = step(bank, actions, now, [(1, BOX, standing())])
    known = first[0]['id']
    now += 2.5
    for _ in range(6):
        now += .12
        last = step(bank, actions, now, [(1, BOX_BACK, standing())])
    assert last[0]['id'] != known


def test_two_samples_are_not_enough_to_join_an_identity():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0), BOX_BACK: unit(1, 0, 0)}))
    actions = LiveActions(bank.ttl)
    now = .12
    first = step(bank, actions, now, [(1, BOX, standing())])
    now += .12
    step(bank, actions, now, [(1, BOX, standing())])
    now += 5.
    for _ in range(6):
        now += .12
        last = step(bank, actions, now, [(9, BOX_BACK, standing())])
    assert last[0]['id'] != first[0]['id']


def test_simultaneous_claims_on_one_identity_are_both_rejected():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0), BOX_OTHER: unit(1, 0, 0)}))
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        first = step(bank, actions, now, [(1, BOX, standing())])
    known = first[0]['id']
    now += 3.
    for _ in range(2):
        now += .12
        assert step(bank, actions, now, [(8, BOX, standing()), (9, BOX_OTHER, standing())]) == []
    now += .12
    people = step(bank, actions, now, [(8, BOX, standing()), (9, BOX_OTHER, standing())])
    ids = {person['id'] for person in people}
    assert len(people) == 2 and len(ids) == 2 and known not in ids


def test_every_sample_must_pass_not_just_the_mean():
    boxes = ((.20, .10, .55, .95), (.21, .10, .56, .95), (.22, .10, .57, .95))
    encoder = FakeEncoder({BOX: unit(1, 0, 0), boxes[0]: unit(1, 0, 0),
                           boxes[1]: unit(1, 0, 0), boxes[2]: unit(0, 0, 1)})
    bank = PersonIdentity(encoder)
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        first = step(bank, actions, now, [(1, BOX, standing())])
    known = first[0]['id']
    now += 5.
    for box in boxes[:2]:
        now += .12
        assert step(bank, actions, now, [(9, box, standing())]) == []
    now += .12
    last = step(bank, actions, now, [(9, boxes[2], standing())])
    assert last[0]['id'] != known


def test_active_identity_blocks_claiming_its_absent_twin():
    encoder = FakeEncoder({BOX: unit(1, .1, 0), BOX_OTHER: unit(1, 0, 0),
                           BOX_BACK: unit(1, 0, 0)})
    bank = PersonIdentity(encoder)
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        people = step(bank, actions, now, [(1, BOX, standing()), (2, BOX_OTHER, standing())])
    known = {person['id'] for person in people}
    assert len(known) == 2
    for _ in range(3):
        now += .12
        step(bank, actions, now, [(2, BOX_OTHER, standing())])
    for _ in range(6):
        now += .12
        last = step(bank, actions, now, [(9, BOX_BACK, standing())])
    assert last[0]['id'] not in known


def test_low_quality_samples_are_released_at_the_wait_cap():
    bank = PersonIdentity(FakeEncoder({BOX: unit(1, 0, 0)}))
    actions = LiveActions(bank.ttl)
    now = 0.
    for _ in range(6):
        now += .12
        first = step(bank, actions, now, [(1, BOX, standing())])
    known = first[0]['id']
    now += 5.
    for _ in range(9):
        now += .12
        assert step(bank, actions, now, [(9, BOX_BACK, standing())]) == []
    now += .12
    last = step(bank, actions, now, [(9, BOX_BACK, standing())])
    assert last[0]['id'] != known


def test_reset_keeps_confirmed_count_and_drops_partial_action():
    actions = LiveActions(retention=120.)
    now = 0.
    for _ in range(15):
        now += .12
        actions.frame(now, [(1, [0., 0., 1., 1.], standing())])
    for _ in range(10):
        now += .12
        actions.frame(now, [(1, [0., 0., 1., 1.], lowered())])
    for _ in range(9):
        now += .12
        last = actions.frame(now, [(1, [0., 0., 1., 1.], standing())])
    assert last[0]['count'] == 1
    for _ in range(10):
        now += .12
        actions.frame(now, [(1, [0., 0., 1., 1.], lowered())])
    assert actions.people[1].phase
    actions.reset({1})
    assert actions.people[1].count == 1
    assert actions.people[1].phase == '' and not actions.people[1].samples


def test_identity_mode_env(monkeypatch):
    from backend import vision_worker
    monkeypatch.delenv('WALKPAD_VISION_ID_MODEL', raising=False)
    assert vision_worker.identity_mode() == 'bytetrack'
    monkeypatch.setenv('WALKPAD_VISION_ID_MODEL', 'ReID')
    assert vision_worker.identity_mode() == 'reid'
    monkeypatch.setenv('WALKPAD_VISION_ID_MODEL', 'arcface')
    with pytest.raises(ValueError, match='bytetrack'):
        vision_worker.identity_mode()


def test_missing_model_message_is_actionable(tmp_path):
    with pytest.raises(ValueError) as error:
        load_encoder(None, tmp_path)
    assert MODEL_STEM in str(error.value) and 'bytetrack' in str(error.value)


def test_model_hash_mismatch_is_rejected(tmp_path):
    model = tmp_path / f'{MODEL_STEM}.xml'
    model.write_text('<net/>', encoding='utf-8')
    model.with_suffix('.bin').write_bytes(b'')
    with pytest.raises(ValueError, match='哈希'):
        load_encoder(None, tmp_path)


def test_encoder_contract_is_bgr_nchw_raw_pixels(tmp_path, monkeypatch):
    weights = {'.xml': b'<net/>', '.bin': b''}
    for suffix, content in weights.items():
        (tmp_path / f'{MODEL_STEM}{suffix}').write_bytes(content)
    monkeypatch.setattr(identity_module, 'MODEL_HASHES',
                        {suffix: hashlib.sha256(content).hexdigest() for suffix, content in weights.items()})

    class Net:
        outputs = [object()]

        def __call__(self, inputs):
            self.blob = inputs[0]
            return [np.full((1, FEATURE_DIM), .25, dtype=np.float32)]

    net = Net()

    class Core:
        def set_property(self, device, config):
            assert device == 'CPU'
            assert config == {'INFERENCE_NUM_THREADS': 1, 'NUM_STREAMS': 1}

        def read_model(self, path):
            assert path.endswith('.xml')
            return object()

        def compile_model(self, model, device):
            assert device == 'CPU'
            return net

    class FakeCv2:
        @staticmethod
        def resize(image, size):
            width, height = size
            return np.dstack([np.full((height, width), 10, np.uint8),
                              np.full((height, width), 20, np.uint8),
                              np.full((height, width), 30, np.uint8)])

    monkeypatch.setitem(sys.modules, 'openvino', types.SimpleNamespace(Core=Core))
    encoder = load_encoder(FakeCv2, tmp_path)
    vector = encoder.embed(np.zeros((100, 100, 3), np.uint8), (0., 0., 1., 1.))
    blob = net.blob
    assert blob.shape == (1, 3, 256, 128) and blob.dtype == np.float32
    assert blob[0, 0, 0, 0] == 10 and blob[0, 1, 0, 0] == 20 and blob[0, 2, 0, 0] == 30
    assert abs(float(np.linalg.norm(vector))-1.) < 1e-5


def test_clear_rejects_edges_small_boxes_and_overlap():
    assert clear(540, 960, (.2, .1, .5, .9))
    assert not clear(540, 960, (0., .1, .3, .9))
    assert not clear(540, 960, (.2, .1, .5, .18))
    assert not clear(540, 960, (.2, .1, .5, .9), [(.2, .1, .4, .9)])
    assert not clear(540, 960, (float('nan'), .1, .5, .9))
