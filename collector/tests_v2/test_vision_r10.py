import numpy as np
import pytest

from backend import vision_rules_r10 as r10


def row(activity='unknown', annotation='其他', status='other', **kw):
    base = dict(activity=activity, annotation=annotation, activity_status=status)
    base.update(kw)
    return base


@pytest.mark.parametrize('activity, annotation, status, expected', [
    ('standing', '站立', 'supported', ('站立', 'confirmed')),
    ('walking', '走路', 'supported', ('走路', 'confirmed')),
    ('running', '跑步', 'supported', ('跑步', 'confirmed')),
    ('walking', '走路候选', 'candidate', ('走路候选', 'candidate')),
    ('stairs_up', '上楼梯候选', 'candidate', ('上楼梯候选', 'candidate')),
    ('running_turn', '跑步转向（过渡）', 'transition', ('跑步转向（过渡）', 'candidate')),
    ('unknown', '其他', 'other', ('其他', 'unknown')),
])
def test_label_mapping(activity, annotation, status, expected):
    assert r10.R10Actions._describe_row(row(activity, annotation, status)) == expected


def test_squat_label_is_in_progress():
    assert r10.R10Actions._describe_row(row('squat', '深蹲候选', 'candidate')) == ('深蹲中', 'candidate')


def test_split_squat_counts_as_squat():
    assert r10.R10Actions._describe_row(row('split_squat', '深蹲候选', 'candidate')) == ('深蹲中', 'candidate')


def test_camera_slice_without_matches_assumes_static_mount():
    camera = r10.Camera(None)
    camera.records.extend([(1, r10.IDENTITY, False), (2, r10.IDENTITY, False)])
    sliced = camera.slice([1, 2])
    assert sliced['source_indices'].tolist() == [0, 1]
    assert sliced['valid'].all()


def test_camera_slice_maps_person_observations_to_window_positions():
    camera = r10.Camera(None)
    camera.records.extend([(1, r10.IDENTITY, True), (2, r10.IDENTITY, True), (3, r10.IDENTITY, True)])
    assert camera.slice([2, 3])['source_indices'].tolist() == [0, 1]
    assert camera.slice([9]) is None


def test_repeated_window_recomputations_count_once():
    track = r10.Track()
    events = [dict(activity='squat', start_video_s=1.0, end_video_s=2.4),
              dict(activity='squat', start_video_s=1.02, end_video_s=2.45),
              dict(activity='squat', start_video_s=4.0, end_video_s=5.2)]
    r10.R10Actions._count(None, track, events, now=6.0)
    assert track.count == 2


def test_unfinished_cycle_is_not_counted():
    track = r10.Track()
    r10.R10Actions._count(None, track, [dict(activity='squat', start_video_s=1.0, end_video_s=5.95)], now=6.0)
    assert track.count == 0


def test_unknown_holds_previous_label_as_candidate():
    track = r10.Track()
    track.held = (10.0, ('走路', 'confirmed'))
    track.label = ('其他', 'unknown')
    assert r10.R10Actions._describe(track, 10.5) == ('走路', 'candidate')
    assert r10.R10Actions._describe(track, 12.0) == ('其他', 'unknown')


def test_finished_squat_is_reported_once():
    track = r10.Track()
    track.count = 3
    track.completed = 20.0
    assert r10.R10Actions._describe(track, 20.5)[0] == '深蹲完成'


def standing_pose(height=480, width=640, hip_y=.45, knee_y=.58, foot_y=.72):
    pose = np.zeros((17, 3), np.float32)
    pose[:, 2] = .95
    for side, x in ((0, .44), (1, .56)):
        pose[5 + side] = (x * width, hip_y * .45 * height, .95)
        pose[11 + side] = (x * width, hip_y * height, .95)
        pose[13 + side] = (x * width, knee_y * height, .95)
        pose[15 + side] = (x * width, foot_y * height, .95)
    pose[0] = (.5 * width, .30 * height, .95)
    return pose


def test_rules_run_on_still_person():
    engine = r10.R10Actions(None)
    engine.size = (640, 480)
    count = 60
    camera = dict(source_indices=np.arange(count),
                  matrices=np.tile(r10.IDENTITY, (count, 1, 1)), valid=np.ones(count, bool))
    times = np.arange(count) / 15.
    pose = np.stack([standing_pose() for _ in times])
    track = r10.Track()
    engine._run(track, times[-1], times, pose, camera, 640, 480,
                np.tile([.2, .1, .6, .9], (count, 1)), np.full(count, .9))
    assert track.label[0] in ('站立', '其他')
    assert track.count == 0


class StaticCv2:
    COLOR_BGR2GRAY = 6

    @staticmethod
    def cvtColor(image, code):
        return image[:, :, 0]

    @staticmethod
    def rectangle(*args):
        pass

    @staticmethod
    def goodFeaturesToTrack(*args, **kwargs):
        return None


BOX = [.2, .1, .6, .9]


def test_window_scales_coordinates_but_not_joint_confidence():
    engine = r10.R10Actions(StaticCv2)
    pose = standing_pose()
    pose[:, :2] /= 480
    pose[15, 2] = .05
    engine.frame(.1, np.zeros((480, 480, 3), np.uint8), [(1, BOX, pose)])
    recorded = engine.tracks[1].samples[0][1]
    np.testing.assert_allclose(recorded[:, :2], pose[:, :2] * 480)
    np.testing.assert_array_equal(recorded[:, 2], pose[:, 2])


def test_reset_keeps_count_and_rebuilds_the_window():
    engine = r10.R10Actions(StaticCv2)
    image = np.zeros((480, 480, 3), np.uint8)
    now = 0.
    for _ in range(6):
        now += .1
        engine.frame(now, image, [(1, BOX, standing_pose())])
    track = engine.tracks[1]
    track.count = 2
    track.counted.append((1.0, 2.0))
    track.held = (now, ('走路', 'confirmed'))
    track.label = ('走路', 'confirmed')
    engine.reset({1})
    assert not track.samples
    assert track.label == ('其他', 'unknown') and track.held[0] == -1e9
    assert track.count == 2 and list(track.counted) == [(1.0, 2.0)]
    now += .1
    engine.frame(now, image, [(1, BOX, standing_pose())])
    assert len(track.samples) == 1 and track.count == 2


def test_reset_then_absence_expires_without_error():
    engine = r10.R10Actions(StaticCv2, retention=1.)
    image = np.zeros((480, 480, 3), np.uint8)
    engine.frame(.1, image, [(1, BOX, standing_pose())])
    engine.reset({1})
    engine.frame(1.5, image, [])
    assert 1 not in engine.tracks
