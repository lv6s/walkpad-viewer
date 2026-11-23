import hashlib
import math
import sys
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

MODEL_STEM = 'person-reidentification-retail-0288'
MODEL_HASHES = {
    '.xml': '30f452b2ed2763f7bf429eea23f8f243ad0e7f3cdd7226db6888f1660efb3424',
    '.bin': '6496b8d51741703c9e9c7f6474cb96c60de1856d7b4fd77235e48cea146066a5',
}
INPUT_WIDTH, INPUT_HEIGHT = 128, 256
FEATURE_DIM = 256
MIN_HEIGHT_PX = 64
MIN_WIDTH_PX = 16
EDGE_PX = 2
MAX_OVERLAP = .3
SAMPLE_GAP = .1
MAX_SAMPLES = 16
MIN_SAMPLES = 3
MATCH_SIM = .70
MATCH_MARGIN = .05
GALLERY_BLEND = .15
TRACK_TTL = 2.
WAIT_CAP = 1.
PROTOTYPE_MAX = 4
PROTOTYPE_MERGE = .85
REJECT_SIM = .55
BREAK_GAP = .7


def _unit(vector):
    norm = float(np.linalg.norm(vector))
    return vector / norm if math.isfinite(norm) and norm > 0 else None


def _iou(box, other):
    x0, y0 = max(box[0], other[0]), max(box[1], other[1])
    x1, y1 = min(box[2], other[2]), min(box[3], other[3])
    if x1 <= x0 or y1 <= y0:
        return 0.
    overlap = (x1-x0)*(y1-y0)
    area = (box[2]-box[0])*(box[3]-box[1]) + (other[2]-other[0])*(other[3]-other[1])
    return overlap / (area-overlap)


def clear(height, width, box, others=()):
    if not all(map(math.isfinite, box)):
        return False
    x0, y0, x1, y1 = box[0]*width, box[1]*height, box[2]*width, box[3]*height
    if x0 < EDGE_PX or y0 < EDGE_PX or x1 > width-EDGE_PX or y1 > height-EDGE_PX:
        return False
    if y1-y0 < MIN_HEIGHT_PX or x1-x0 < MIN_WIDTH_PX or x1-x0 > 1.5*(y1-y0):
        return False
    return all(_iou(box, other) < MAX_OVERLAP for other in others)


class ReidEncoder:
    """OMZ person-reidentification-retail-0288: BGR 0..255, NCHW 1x3x256x128."""

    def __init__(self, cv2, net):
        self.cv2, self.net = cv2, net
        probe = np.arange(INPUT_HEIGHT*INPUT_WIDTH*3, dtype=np.int32)
        probe = (probe % 256).astype(np.uint8).reshape(INPUT_HEIGHT, INPUT_WIDTH, 3)
        if self.embed(probe, (0., 0., 1., 1.)) is None:
            raise ValueError('模型未返回有效特征')

    def embed(self, image, box):
        height, width = image.shape[:2]
        x0, y0, x1, y1 = box
        left, top = max(0, int(x0*width)), max(0, int(y0*height))
        right, bottom = min(width, int(round(x1*width))), min(height, int(round(y1*height)))
        if right-left < 2 or bottom-top < 2:
            return None
        crop = self.cv2.resize(image[top:bottom, left:right], (INPUT_WIDTH, INPUT_HEIGHT))
        blob = np.ascontiguousarray(crop.transpose(2, 0, 1)[None], dtype=np.float32)
        vector = np.asarray(self.net([blob])[0], dtype=np.float32).reshape(-1)
        if vector.size != FEATURE_DIM:
            raise ValueError(f'模型输出了 {vector.size} 维特征')
        return _unit(vector)


def load_encoder(cv2, root):
    root = Path(root)
    deps = root / 'reid-deps'
    if deps.is_dir() and str(deps) not in sys.path:
        sys.path.insert(0, str(deps))
    model = next((path for path in (root/'reid'/f'{MODEL_STEM}.xml', root/f'{MODEL_STEM}.xml')
                  if path.is_file()), None)
    if model is None:
        raise ValueError('跨帧身份模型缺失：请将 person-reidentification-retail-0288.xml/.bin '
                         '放在 runtime/vision/reid，或把身份模式改回 bytetrack')
    for suffix, expected in MODEL_HASHES.items():
        path = model.with_suffix(suffix)
        if not path.is_file():
            raise ValueError('跨帧身份模型缺少同名 .bin 权重，或把身份模式改回 bytetrack')
        with path.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
                raise ValueError('跨帧身份模型哈希与已校验版本不一致，请重新部署或把身份模式改回 bytetrack')
    try:
        import openvino
        core = openvino.Core()
        core.set_property('CPU', {'INFERENCE_NUM_THREADS': 1, 'NUM_STREAMS': 1})
        net = core.compile_model(core.read_model(str(model)), 'CPU')
    except ImportError as exc:
        raise ValueError(f'跨帧身份依赖 openvino 不可用：{exc}；可放入 runtime/vision/reid-deps '
                         '或把身份模式改回 bytetrack') from exc
    except Exception as exc:
        raise ValueError(f'跨帧身份模型加载失败：{exc}，可把身份模式改回 bytetrack') from exc
    try:
        return ReidEncoder(cv2, net)
    except Exception as exc:
        raise ValueError(f'跨帧身份模型不可用：{exc}，可把身份模式改回 bytetrack') from exc


@dataclass
class _Known:
    feature: object
    last_seen: float


@dataclass
class _Track:
    identity: int
    seen: float
    deadline: float
    last_sample: float = -1.
    samples: deque = field(default_factory=lambda: deque(maxlen=MAX_SAMPLES))
    adopted: bool = False
    fresh: deque = field(default_factory=lambda: deque(maxlen=MAX_SAMPLES))


class PersonIdentity:
    """Session gallery for out-of-frame returns; without a decision a track is not reported."""

    def __init__(self, encoder, ttl=120., max_identities=128):
        self.encoder, self.ttl, self.max_identities = encoder, ttl, max_identities
        self.gallery, self.tracks, self.next_identity = {}, {}, 1

    def resolve(self, now, image, detections):
        self.tracks = {key: track for key, track in self.tracks.items() if now-track.seen <= TRACK_TTL}
        boxes = [item[1] for item in detections]
        present, created = {}, set()
        for index, (track_id, box, _) in enumerate(detections):
            track = self.tracks.get(track_id)
            if track is None:
                track = self.tracks[track_id] = _Track(0, now, now+WAIT_CAP)
                created.add(track_id)
            track.seen = now
            present[track_id] = track
            self._observe(track, now, image, box, boxes[:index]+boxes[index+1:])
        active = {track.identity for track in present.values() if track.identity}
        self._expire(now, active)
        if not self._absent(active):
            for track_id in created:
                present[track_id].identity = self._allocate()
        recovered = self._recover(present, active)
        for track in present.values():
            if not track.identity and (now >= track.deadline or len(track.samples) >= MIN_SAMPLES):
                track.identity = self._allocate()
            self._publish(track, now)
        return [(present[key].identity, box, pose) for key, box, pose in detections
                if present[key].identity], recovered

    def _allocate(self):
        identity, self.next_identity = self.next_identity, self.next_identity+1
        return identity

    def _absent(self, active):
        return any(identity not in active for identity in self.gallery)

    def _observe(self, track, now, image, box, others):
        height, width = image.shape[:2]
        if (not clear(height, width, box, others)
                or (track.samples and now-track.last_sample < SAMPLE_GAP)):
            return
        vector = self.encoder.embed(image, box)
        if vector is not None:
            track.samples.append(vector)
            track.last_sample = now

    @staticmethod
    def _mean(track):
        return _unit(np.mean(track.samples, axis=0)) if track.samples else None

    def _recover(self, present, active):
        proposals = {}
        for track in present.values():
            if not track.identity and len(track.samples) >= MIN_SAMPLES:
                known = self._match(track, active)
                if known is not None:
                    proposals.setdefault(known, []).append(track)
        recovered = set()
        for known, tracks in proposals.items():
            if len(tracks) == 1:
                tracks[0].identity, tracks[0].adopted = known, True
                recovered.add(known)
                # 旧 raw 轨迹还在 2 s 簿记里时若不摘除，复现后会与新轨迹同帧输出同一 ID。
                self.tracks = {key: item for key, item in self.tracks.items()
                               if key in present or item.identity != known}
        return recovered

    def _match(self, track, active):
        recent = list(track.samples)[-MIN_SAMPLES:]
        if len(recent) < MIN_SAMPLES:
            return None
        best = 0
        for sample in recent:
            scores = sorted(((float(known.feature @ sample), identity)
                             for identity, known in self.gallery.items()), reverse=True)
            if not scores or scores[0][0] < MATCH_SIM:
                return None
            if len(scores) > 1 and scores[0][0]-scores[1][0] < MATCH_MARGIN:
                return None
            if scores[0][1] in active or (best and scores[0][1] != best):
                return None
            best = scores[0][1]
        return best

    def _publish(self, track, now):
        if not track.identity or len(track.samples) < MIN_SAMPLES:
            return
        vector = self._mean(track)
        known = self.gallery.get(track.identity)
        if known is None:
            self.gallery[track.identity] = _Known(vector, now)
        elif track.adopted:
            blended = _unit((1-GALLERY_BLEND)*known.feature + GALLERY_BLEND*vector)
            if blended is not None:
                known.feature = blended
            known.last_seen = now
        else:
            known.feature, known.last_seen = vector, now

    def _expire(self, now, active):
        self.gallery = {identity: known for identity, known in self.gallery.items()
                        if now-known.last_seen <= self.ttl}
        if len(self.gallery) <= self.max_identities:
            return
        for identity, _ in sorted(self.gallery.items(), key=lambda item: item[1].last_seen):
            if identity not in active:
                del self.gallery[identity]
                if len(self.gallery) <= self.max_identities:
                    break


@dataclass
class _SessionKnown:
    prototypes: list
    last_seen: float


class SessionIdentity:
    """单摄像机采集会话内的匿名编号；外观特征由调用方提供，不跨会话保留身份。

    features 与 detections 等长且同序，元素为向量或 None；内部做 L2 归一化。
    有 gallery 身份缺席时新轨迹先待定：只有证据明确不像任何已知身份才发新号，
    强候选但分差不足、多人竞争、特征缺失都长期待定，不进入动作输出。
    同一 raw 轨迹跨过 BREAK_GAP 空白后复现时，把原编号放进 recovered 让动作窗口断开。
    """

    def __init__(self, ttl=120., max_identities=128):
        self.ttl, self.max_identities = ttl, max_identities
        self.gallery, self.tracks, self.next_identity = {}, {}, 1
        self.dimension = 0
        self.pending = []

    def resolve(self, now, image, detections, features):
        if len(features) != len(detections):
            raise ValueError('身份特征数量与检测数量不一致')
        self.pending = []
        self.tracks = {key: track for key, track in self.tracks.items() if now-track.seen <= TRACK_TTL}
        boxes = [item[1] for item in detections]
        present, created, broken = {}, set(), set()
        for index, (track_id, box, _) in enumerate(detections):
            track = self.tracks.get(track_id)
            if track is None:
                track = self.tracks[track_id] = _Track(0, now, now+WAIT_CAP)
                created.add(track_id)
            elif track.identity and now-track.seen > BREAK_GAP:
                broken.add(track.identity)
            track.seen = now
            present[track_id] = track
            self._observe(track, now, image, box, boxes[:index]+boxes[index+1:], features[index])
        active = {track.identity for track in present.values() if track.identity}
        self._expire(now, active)
        if not self._absent(active):
            for track_id in created:
                present[track_id].identity = self._allocate()
        recovered = self._recover(present, active)
        for track in present.values():
            if (not track.identity and len(track.samples) >= MIN_SAMPLES
                    and (not self.gallery or self._unfamiliar(track))):
                track.identity = self._allocate()
            self._publish(track, now)
        output = []
        for track_id, box, pose in detections:
            identity = present[track_id].identity
            if identity:
                output.append((identity, box, pose))
            else:
                self.pending.append(dict(track_id=track_id, box=[float(value) for value in box],
                                         samples=len(present[track_id].samples)))
        return output, recovered | broken

    def _allocate(self):
        identity, self.next_identity = self.next_identity, self.next_identity+1
        return identity

    def _absent(self, active):
        return any(identity not in active for identity in self.gallery)

    def _vector(self, value):
        if value is None:
            return None
        try:
            array = np.asarray(value, dtype=np.float32).reshape(-1)
        except (TypeError, ValueError):
            return None
        vector = _unit(array)
        if vector is None or (self.dimension and vector.size != self.dimension):
            return None
        self.dimension = vector.size
        return vector

    def _observe(self, track, now, image, box, others, feature):
        height, width = image.shape[:2]
        if (not clear(height, width, box, others)
                or (track.samples and now-track.last_sample < SAMPLE_GAP)):
            return
        vector = self._vector(feature)
        if vector is not None:
            track.samples.append(vector)
            track.fresh.append(vector)
            track.last_sample = now

    @staticmethod
    def _mean(track):
        return _unit(np.mean(track.samples, axis=0)) if track.samples else None

    def _recover(self, present, active):
        proposals = {}
        for track in present.values():
            if not track.identity and len(track.samples) >= MIN_SAMPLES:
                known = self._match(track, active)
                if known is not None:
                    proposals.setdefault(known, []).append(track)
        recovered = set()
        for known, tracks in proposals.items():
            if len(tracks) == 1:
                tracks[0].identity = known
                recovered.add(known)
                self.tracks = {key: item for key, item in self.tracks.items()
                               if key in present or item.identity != known}
        return recovered

    def _profile(self, track):
        """最近样本对各身份的聚合分、单帧下限与逐帧归属票；样本不足或 gallery 空时返回 None。"""
        recent = list(track.samples)[-MIN_SAMPLES:]
        if len(recent) < MIN_SAMPLES or not self.gallery:
            return None
        totals, floors, votes = {}, {}, set()
        for sample in recent:
            scores = [(max(float(prototype @ sample) for prototype in known.prototypes), identity)
                      for identity, known in self.gallery.items()]
            _, vote = max(scores)
            votes.add(vote)
            for value, identifier in scores:
                totals[identifier] = totals.get(identifier, 0.) + value
                floors[identifier] = min(floors.get(identifier, 1.), value)
        ranked = sorted(((total/len(recent), identity) for identity, total in totals.items()), reverse=True)
        return ranked, floors, votes

    def _match(self, track, active):
        """多帧聚合：最近样本必须一致指向同一身份，均值过阈值且与次优拉开分值，单帧也不得塌陷。"""
        profile = self._profile(track)
        if profile is None:
            return None
        ranked, floors, votes = profile
        if len(votes) != 1:
            return None
        aggregate, best = ranked[0]
        if aggregate < MATCH_SIM or floors[best] < MATCH_SIM:
            return None
        if len(ranked) > 1 and aggregate-ranked[1][0] < MATCH_MARGIN:
            return None
        if best in active:
            return None
        return best

    def _unfamiliar(self, track):
        profile = self._profile(track)
        return profile is not None and profile[0][0][0] < REJECT_SIM

    @staticmethod
    def _absorb(known, vector):
        scores = [float(prototype @ vector) for prototype in known.prototypes]
        best = max(range(len(scores)), key=scores.__getitem__)
        if scores[best] >= PROTOTYPE_MERGE:
            merged = _unit((1-GALLERY_BLEND)*known.prototypes[best] + GALLERY_BLEND*vector)
            if merged is not None:
                known.prototypes[best] = merged
            return
        if len(known.prototypes) < PROTOTYPE_MAX:
            known.prototypes.append(vector)
        # 满额后不替换：离群样本不能挤掉已确认的视角。

    def _publish(self, track, now):
        if not track.identity or len(track.samples) < MIN_SAMPLES:
            return
        known = self.gallery.get(track.identity)
        if known is None:
            vector = self._mean(track)
            if vector is None:
                return
            self.gallery[track.identity] = _SessionKnown([vector], now)
            track.fresh.clear()
            return
        # 只吸收新观测：同一批样本每帧重复混合会把 gallery 反复洗向窗口均值。
        while track.fresh:
            self._absorb(known, track.fresh.popleft())
        known.last_seen = now

    def _expire(self, now, active):
        self.gallery = {identity: known for identity, known in self.gallery.items()
                        if now-known.last_seen <= self.ttl}
        if len(self.gallery) <= self.max_identities:
            return
        for identity, _ in sorted(self.gallery.items(), key=lambda item: item[1].last_seen):
            if identity not in active:
                del self.gallery[identity]
                if len(self.gallery) <= self.max_identities:
                    break
