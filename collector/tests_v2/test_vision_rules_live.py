import numpy as np
import pytest

from backend import vision_rules_live as live
from backend.vision_workstation import ID_MODELS, PROTOCOLS, selection


class StaticCamera:
    def update(self, index, image, boxes):
        pass

    def slice(self, indices):
        return dict(source_indices=np.arange(len(indices)),
                    matrices=np.tile([[1., 0., 0.], [0., 1., 0.]], (len(indices), 1, 1)),
                    valid=np.ones(len(indices), bool))


IMAGE = np.zeros((480, 640, 3), np.uint8)
BOX = [.20, .08, .72, .94]


def pose(depth=0., confidence=.95, drift=0.):
    result = np.zeros((17, 3), np.float32)
    for side, x in enumerate((245, 315)):
        for joint, px, py in ((5, x+6*depth, 128+48*depth), (11, x, 208+48*depth),
                              (13, x+55*depth, 267+20*depth), (15, x, 335)):
            result[joint + side] = ((px+drift)/640., py/640., confidence)
    return result


def rig():
    engine = live.LiveRules(None)
    engine.camera = StaticCamera()
    t, rows = 0., []

    def feed(depths, *, confidence=.95, gap=0., drift=0.):
        nonlocal t
        t += gap
        for depth in depths:
            t += .067
            rows.append(engine.frame(t, IMAGE, [(1, BOX, pose(depth, confidence, drift)), (2, BOX, pose())]))
        return rows[-1]

    return engine, feed, rows


CYCLE_DOWN = np.linspace(0., 1., 13)
CYCLE_UP = np.linspace(1., 0., 13)


def test_fast_standing_and_independent_completed_repetitions():
    _, feed, rows = rig()
    first = feed([0.] * 12)
    assert all(r['action'] == '站立' for r in first)
    mid = feed(CYCLE_DOWN)
    assert mid[0]['action'] == '深蹲中' and mid[0]['count'] == 0
    done = feed([*CYCLE_UP, 0., 0., 0., 0.])
    assert [r['count'] for r in done] == [1, 0]
    assert any(frame[0]['action'] == '深蹲完成' for frame in rows)
    assert feed([*CYCLE_DOWN, *CYCLE_UP, *([0.] * 12)])[0]['count'] == 2
    assert feed([0.] * 12)[0]['action'] == '站立'


@pytest.mark.parametrize('break_type', ['time_gap', 'pose_gap', 'id_reset', 'moving_feet'])
def test_break_never_completes_an_open_repetition(break_type):
    engine, feed, _ = rig()
    assert feed([0.] * 12)[0]['count'] == 0
    assert feed([*CYCLE_DOWN, *CYCLE_UP, *([0.] * 10)])[0]['count'] == 1
    assert feed(CYCLE_DOWN)[0]['action'] == '深蹲中'
    if break_type == 'time_gap':
        feed([1.], gap=.4)
    elif break_type == 'pose_gap':
        assert feed([1.] * 8, confidence=0.)[0]['status'] == 'unknown'
        feed([1.])
        assert len(engine.tracks[1].samples) == 1
    elif break_type == 'id_reset':
        engine.reset({1})
    else:
        feed([1.] * 4, drift=50.)
    assert feed([*CYCLE_UP, *([0.] * 12)])[0]['count'] == 1


def test_non_target_pose_is_not_missing_evidence_or_a_squat():
    _, feed, _ = rig()
    low = feed([1.] * 20)
    assert low[0]['action'] == '其他' and low[0]['count'] == 0
    assert feed([1.], confidence=0.)[0]['action'] == '未判定'
    assert feed([*CYCLE_UP, *([0.] * 12)])[0]['count'] == 0


def test_shallow_or_unfinished_motion_is_not_counted():
    _, feed, _ = rig()
    feed([0.] * 12)
    assert feed([*(CYCLE_DOWN * .30), *(CYCLE_UP * .30), *([0.] * 10)])[0]['count'] == 0
    assert feed([*CYCLE_DOWN, *([1.] * 20)])[0]['count'] == 0


@pytest.mark.parametrize('label, text', [('gait_walk', '步行'), ('running', '跑步'),
                                        ('stairs_up', '上楼梯'), ('stairs_down', '下楼梯')])
def test_gait_requires_consistent_observed_support(label, text):
    rows = [dict(activity=label)] * 8 + [dict(activity='unknown')] * 2
    assert live.summarize(rows, [True] * 10, [True] * 10) == (text, 'confirmed')
    assert live.summarize(rows, [True] * 10, [False] * 6 + [True] * 4) == live.UNDECIDED
    if label.startswith('stairs'):
        assert live.summarize(rows, [False] * 10, [True] * 10) == live.UNDECIDED
    else:
        ambiguous = [dict(row, action_hypotheses=('walking', 'running')) for row in rows]
        assert live.summarize(ambiguous, [True] * 10, [True] * 10) == live.UNDECIDED


def test_live_negotiation_is_unchanged():
    for mode in ID_MODELS:
        assert PROTOCOLS[mode, 'live'] == f'walkpad-vision-{mode}-live/1'
        assert selection(PROTOCOLS[mode, 'live']) == (mode, 'live')
