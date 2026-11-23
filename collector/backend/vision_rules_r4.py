"""实时动作规则 v4.9.8-r4：在滚动窗口上复用离线规则代码。

离线版按整段视频估计基线，这里只能用最近可见窗口，因此同一动作的候选/确认时机
可能与离线成片不同；判据代码本身与 r4 一致。
"""

import json
from collections import deque
from pathlib import Path

import numpy as np

from .rules_r4 import action_features as features
from .rules_r4 import action_rules as rules
from .rules_r4.action_calibration import calibrate
from .rules_r4.gait_evidence import judge
from .rules_r4.squat_bouts import adaptive_cycle_recovery, normalize_squat_cycles
from .rules_r4.stair_evidence import detect as detect_stairs


CONFIG = json.loads((Path(__file__).resolve().parent / 'rules_r4' / 'action_config.json')
                    .read_text(encoding='utf-8'))
WINDOW_S = 12.
INTERVAL_S = 1.
LAG_S = .7
HOLD_S = .9
MIN_SPAN_S = 5.
MIN_FRAMES = 24
CAMERA_WIDTH = 480
COVERAGE_FLOOR = .5

TEXT = {'standing': '站立', 'walking': '走路', 'gait_walk': '走路', 'running': '跑步',
        'squat': '深蹲', 'split_squat': '深蹲', 'stairs_up': '上楼梯', 'stairs_down': '下楼梯',
        'stepping': '迈步', 'fast_stepping': '快速迈步', 'body_motion': '持续运动',
        'arm_activity': '手部动作', 'bending': '俯身', 'between_reps': '组内回位',
        'unknown': '未判定'}
SURE = frozenset(('standing', 'walking', 'running', 'squat', 'split_squat', 'stairs_up', 'stairs_down'))
FALLBACK = frozenset(('unknown', 'standing', 'walking', 'gait_walk', 'stepping',
                      'fast_stepping', 'body_motion'))
IDENTITY = np.array([[1., 0., 0.], [0., 1., 0.]])


class Camera:
    """逐帧估计镜头运动，供规则做位移补偿。"""

    def __init__(self, cv2):
        self.cv2 = cv2
        self.previous = None
        self.records = deque(maxlen=1200)

    def update(self, index, image, boxes):
        cv2 = self.cv2
        shrink = min(1., CAMERA_WIDTH / image.shape[1])
        small = (cv2.resize(image, None, fx=shrink, fy=shrink, interpolation=cv2.INTER_AREA)
                 if shrink < 1 else image)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        mask = np.full(gray.shape, 255, np.uint8)
        for x0, y0, x1, y1 in boxes:
            pad = max(12., .1 * max(x1 - x0, y1 - y0)) * shrink
            lo = np.maximum(0, np.floor([x0 * shrink - pad, y0 * shrink - pad])).astype(int)
            hi = np.minimum([gray.shape[1] - 1, gray.shape[0] - 1],
                            np.ceil([x1 * shrink + pad, y1 * shrink + pad])).astype(int)
            cv2.rectangle(mask, tuple(lo), tuple(hi), 0, -1)
        matrix, valid = IDENTITY.copy(), False
        if self.previous is not None:
            matrix, valid = self._match(self.previous[0], self.previous[1], gray, mask, shrink)
        self.previous = (gray, mask)
        self.records.append((index, matrix, valid))

    def _match(self, before, before_mask, after, after_mask, shrink):
        cv2 = self.cv2
        corners = cv2.goodFeaturesToTrack(before, maxCorners=350, qualityLevel=.01,
                                         minDistance=8, mask=before_mask, blockSize=7)
        if corners is None or len(corners) < 16:
            return IDENTITY.copy(), False
        moved, status, _ = cv2.calcOpticalFlowPyrLK(before, after, corners, None,
                                                    winSize=(21, 21), maxLevel=3)
        if moved is None or status is None:
            return IDENTITY.copy(), False
        back, backward_status, _ = cv2.calcOpticalFlowPyrLK(after, before, moved, None,
                                                            winSize=(21, 21), maxLevel=3)
        if back is None or backward_status is None:
            return IDENTITY.copy(), False
        p, q = corners[:, 0], moved[:, 0]
        ok = (status[:, 0] > 0) & (backward_status[:, 0] > 0)
        ok &= np.linalg.norm(back[:, 0] - p, axis=1) < 1.5
        ok &= (q[:, 0] >= 0) & (q[:, 0] < after.shape[1]) & (q[:, 1] >= 0) & (q[:, 1] < after.shape[0])
        qint = np.clip(np.round(q).astype(int), [0, 0], [after.shape[1] - 1, after.shape[0] - 1])
        ok &= after_mask[qint[:, 1], qint[:, 0]] > 0
        if ok.sum() < 16:
            return IDENTITY.copy(), False
        fit, flags = cv2.estimateAffinePartial2D(p[ok], q[ok], method=cv2.RANSAC,
                                                 ransacReprojThreshold=2., maxIters=1500,
                                                 confidence=.99, refineIters=10)
        if fit is None or flags is None:
            return IDENTITY.copy(), False
        selected = flags[:, 0] > 0
        scale = float(np.linalg.norm(fit[:, 0]))
        if float(selected.mean()) < CONFIG['camera_min_inliers'] or not .8 <= scale <= 1.25 or selected.sum() < 12:
            return IDENTITY.copy(), False
        matrix = fit.copy()
        matrix[:, 2] /= shrink
        return matrix, True

    def slice(self, indices):
        position = {index: n for n, index in enumerate(indices)}
        picked = [(position[i], m, v) for i, m, v in self.records if i in position]
        if len(picked) < 2:
            return None
        source = np.array([n for n, _, _ in picked])
        matrices = np.array([m for _, m, _ in picked])
        valid = np.array([v for _, _, v in picked])
        if valid.mean() < COVERAGE_FLOOR:
            # 无纹理背景常出现在固定机位；此时按镜头静止补偿，只影响位移口径。
            matrices = np.tile(IDENTITY, (len(source), 1, 1))
            valid = np.ones(len(source), bool)
        return dict(source_indices=source, matrices=matrices, valid=valid)


class Track:
    def __init__(self):
        self.samples = deque(maxlen=600)
        self.counted = deque(maxlen=40)
        self.count = 0
        self.label = ('未判定', 'unknown')
        self.held = (-1e9, ('未判定', 'unknown'))
        self.completed = -1e9
        self.analysed = -1e9
        self.failed = 0


class R4Actions:
    def __init__(self, cv2, retention=3., window=WINDOW_S, interval=INTERVAL_S):
        self.camera = Camera(cv2)
        self.tracks = {}
        self.retention = retention
        self.window = window
        self.interval = interval
        self.size = (0, 0)
        self.index = 0

    def frame(self, now, image, detections):
        self.index += 1
        height, width = image.shape[:2]
        self.size = (width, height)
        self.camera.update(self.index, image, [box for _, box, _ in detections])
        self.tracks = {i: p for i, p in self.tracks.items()
                       if now - p.samples[-1][0] <= self.retention}
        output = []
        for identity, box, pose in detections:
            track = self.tracks.setdefault(identity, Track())
            track.samples.append((now, pose * max(width, height), self.index))
            while now - track.samples[0][0] > self.window:
                track.samples.popleft()
            if now - track.analysed >= self.interval:
                track.analysed = now
                self._analyze(track, now)
            text, status = self._describe(track, now)
            output.append(dict(id=identity, box=box, action=text, status=status, count=track.count))
        return output

    def reset(self, identities):
        for identity in identities:
            track = self.tracks.get(identity)
            if track is not None:
                track.samples.clear()
                track.held = (-1e9, ('未判定', 'unknown'))
                track.label = ('未判定', 'unknown')

    def _analyze(self, track, now):
        samples = list(track.samples)
        if len(samples) < MIN_FRAMES or samples[-1][0] - samples[0][0] < MIN_SPAN_S:
            return
        times = np.array([s[0] for s in samples], float)
        pose = np.stack([s[1] for s in samples]).astype(np.float32)
        camera = self.camera.slice([s[2] for s in samples])
        if camera is None:
            return
        width, height = self.size
        try:
            self._run(track, now, times, pose, camera, width, height)
        except (ValueError, IndexError, KeyError, TypeError, np.linalg.LinAlgError):
            track.failed += 1
            if track.failed == 1:
                track.label = ('未判定', 'unknown')

    def _run(self, track, now, times, pose, camera, width, height):
        f = features.pose_features(dict(time_s=times, keypoints=pose), CONFIG)
        f = features.camera_features(f, camera, CONFIG, width, height)
        rules.period_features(f, CONFIG)
        local, _ = calibrate(f, CONFIG)
        _, frames, events, _, _ = rules.classify_raw(f, local, arm_semantics=False)
        events, _ = adaptive_cycle_recovery(f, events, frames, local)
        assessments, _ = judge(f, camera, pose, frames, local)
        rows = [{**row, **evidence} for row, evidence in zip(frames, assessments)]
        normalize_squat_cycles(f, np.ones(len(times), bool), events, rows, local)
        calm = np.isfinite(f['camera_speed']) & (f['camera_speed'] <= .16)
        blocked = np.array([row['action_event_id'] > 0 for row in rows])
        stairs, _, _ = detect_stairs(times, pose, f['raw_valid'], f['torso_px'], calm, blocked, height)
        for row, tag in zip(rows, stairs):
            if tag and row['activity'] in FALLBACK:
                row['activity'] = str(tag)
                row['action_hypotheses'] = ()
        self._count(track, events, now)
        index = max(0, min(int(np.searchsorted(times, now - LAG_S, side='right')) - 1, len(rows) - 1))
        track.label = self._describe_row(rows[index])
        if track.label[1] != 'unknown':
            track.held = (now, track.label)

    def _count(self, track, events, now):
        for event in events:
            if event.get('activity') != 'squat' or event['end_video_s'] > now - .15:
                continue
            start, stop = event['start_video_s'], event['end_video_s']
            if stop - start > CONFIG['cycle_max_s']:
                continue
            if any(start < old[1] - .2 and stop > old[0] + .2 for old in track.counted):
                continue
            track.counted.append((start, stop))
            track.count += 1
            track.completed = now

    @staticmethod
    def _describe_row(row):
        label = str(row['activity'])
        if label in ('squat', 'split_squat'):
            return '深蹲中', 'candidate'
        text = TEXT.get(label, '未判定')
        if label == 'unknown':
            return text, 'unknown'
        weak = (bool(row.get('action_hypotheses')) or bool(row.get('ambiguous_gait'))
                or bool(row.get('gait_inferred')) or bool(row.get('locomotion_partial')))
        if label.startswith('stairs_') and not row.get('stair_sequence_supported'):
            weak = True
        return (text, 'confirmed') if label in SURE and not weak else (text + '候选', 'candidate')

    @staticmethod
    def _describe(track, now):
        if now - track.completed <= 1.2:
            return '深蹲完成', 'confirmed'
        text, status = track.label
        if status == 'unknown' and now - track.held[0] <= HOLD_S:
            # 动作之间的空档不立刻改回未判定，沿用上一结论但降为候选。
            return track.held[1][0], 'candidate'
        return text, status
