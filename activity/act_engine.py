"""实时 walk/run/other 推断引擎：事件进，决策出。

ONNX 图是「原始 g/dps → logits」，归一化在图内；本文件只负责因果重采样、
窗口网格、缺口门控与轴向映射，重采样算子直接复用交付包里的同一份实现。

两条改错不报错、只是变差的约束：
  * 送进来的是**未扣零偏**的原始角速度（页面的 gx0/gy0/gz0），不是显示值；
  * 送进来的是自研鞋垫自身坐标系的物理量，必须经 AXIS_OWN_TO_TRAIN 转到训练域。
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

import runtime_activity_v1 as rt

HERE = Path(__file__).resolve().parent
CLASSES = ("walk", "run", "other")
FEET = ("l", "r")
WINDOW = rt.PREPROCESS["window_samples"]
STEP_S = rt.PREPROCESS["hop_samples"] / rt.PREPROCESS["fs_out"]
MAX_EVENTS_PER_STEP = 2000


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class InvalidEvent(ValueError):
    def __init__(self, reason: str, detail: str):
        super().__init__(reason + ": " + detail)
        self.reason = reason
        self.detail = detail


class ActEngine:
    def __init__(self, model_path=None, manifest_path=None, threads: int = 1):
        self.model_path = Path(model_path or HERE / "act_imu_v1.onnx")
        self.manifest_path = Path(manifest_path or HERE / "act_imu_v1.json")
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        digest = sha256_file(self.model_path)
        if digest != self.manifest["onnx_sha256"]:
            raise ValueError("模型文件与清单不一致：%s != %s"
                             % (digest, self.manifest["onnx_sha256"]))
        opts = ort.SessionOptions()
        # 采集机上蓝牙、摄像头、页面都要跑，不让推断吃掉多核
        opts.intra_op_num_threads = int(threads)
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(self.model_path), opts,
                                            providers=["CPUExecutionProvider"])
        self.axis = np.asarray(self.manifest["axis_own_to_train"], dtype=np.float64)
        self.reset()

    # ---------------------------------------------------------------- state
    def reset(self, fs_left: float = 50.0, fs_right: float = 50.0) -> dict:
        for fs in (fs_left, fs_right):
            if not np.isfinite(fs) or fs <= 0:
                raise ValueError("declared native rate must be finite and positive")
        self.fs = {"l": float(fs_left), "r": float(fs_right)}
        self.streams = {f: rt.Stream(fs_in=self.fs[f]) for f in FEET}
        self.origin = None
        self.last_t = {"l": None, "r": None}
        self.decisions = 0
        self.last_valid_at = None
        return {"ok": True, "fs": self.fs}

    def info(self) -> dict:
        m = self.manifest
        return {
            "ok": True,
            "model": m["format"],
            "onnx_sha256": m["onnx_sha256"],
            "classes": [m["class_map"][str(i)] for i in range(len(m["class_map"]))],
            "window_samples": WINDOW,
            "fs_out": rt.PREPROCESS["fs_out"],
            "step_s": STEP_S,
            "max_gap_s": rt.PREPROCESS["max_gap_s"],
            "axis_own_to_train": self.axis.tolist(),
            "axis_label": "自研鞋垫 → Moticon 约定（绕 z 轴 +90°）",
            "units": {"acc": "g", "gyro": "dps"},
            "gyro_source": "caller-supplied, expected bias-compensated",
            "gyro_label": "角速度需由调用方扣掉本机零偏估计（未就绪不得送入）",
            "onnxruntime": ort.__version__,
            "source_student_sha256": m["source_student_sha256"],
        }

    # ----------------------------------------------------------- event path
    def _coerce(self, events):
        """校验整批后返回 {foot: (t, values)}，不合法整批拒绝，避免半推半就。"""
        if not isinstance(events, (list, tuple)):
            raise InvalidEvent("bad_request", "events must be a list")
        if len(events) > MAX_EVENTS_PER_STEP:
            raise InvalidEvent("too_many_events", "at most %d events per step"
                               % MAX_EVENTS_PER_STEP)
        picked = {f: ([], []) for f in FEET}
        for i, ev in enumerate(events):
            if not isinstance(ev, (list, tuple)) or len(ev) != 2:
                raise InvalidEvent("bad_request", "event %d must be [foot, values]" % i)
            foot, val = ev
            if foot not in FEET:
                raise InvalidEvent("bad_request", "event %d has unknown foot %r" % (i, foot))
            arr = np.asarray(val, dtype=np.float64).reshape(-1)
            if arr.shape != (7,):
                raise InvalidEvent("bad_request",
                                   "event %d needs [t, ax, ay, az, gx, gy, gz]" % i)
            if not np.isfinite(arr).all():
                raise InvalidEvent("bad_values", "event %d contains non-finite numbers" % i)
            picked[foot][0].append(arr[0])
            picked[foot][1].append(arr[1:])
        out = {}
        for f in FEET:
            ts, vs = picked[f]
            if not ts:
                continue
            t = np.asarray(ts, dtype=np.float64)
            if np.any(np.diff(t) < 0):
                raise InvalidEvent("order", "foot %s events are not time-ordered" % f)
            if self.last_t[f] is not None and t[0] < self.last_t[f]:
                raise InvalidEvent("order", "foot %s event older than the last accepted one" % f)
            out[f] = (t, np.asarray(vs, dtype=np.float64))
        return out

    def _rotate(self, v: np.ndarray) -> np.ndarray:
        acc = v[:, :3] @ self.axis.T
        gyr = v[:, 3:] @ self.axis.T
        return np.concatenate([acc, gyr], axis=1)

    def push(self, events) -> dict:
        """只入流不决策；校验不过整批拒绝，流状态保持不变。"""
        try:
            batch = self._coerce(events or [])
        except InvalidEvent as exc:
            return {"ok": False, "reason": exc.reason, "detail": exc.detail, "accepted": 0}
        if self.origin is None:
            first = [b[0][0] for b in batch.values()]
            if not first:
                return {"ok": True, "accepted": 0}
            self.origin = float(min(first))
        n = 0
        for f, (t, vs) in batch.items():
            self.streams[f].push((t - self.origin) / 1000.0, self._rotate(vs))
            self.last_t[f] = float(t[-1])
            n += len(t)
        return {"ok": True, "accepted": n}

    def step(self, events, t_end: float) -> dict:
        """页面用的合并入口：先入流，再在 t_end 处出一次决策。"""
        pushed = self.push(events)
        if not pushed["ok"]:
            t = float(t_end) if np.isfinite(t_end) else None
            return dict(self._invalid(pushed["reason"], pushed["detail"], t), pushed=pushed)
        out = self.decide(t_end)
        out["pushed"] = pushed
        return out

    def _invalid(self, reason: str, detail: str, t_end=None) -> dict:
        self.decisions += 1
        return {"valid": False, "reason": reason, "detail": detail,
                "label": None, "probabilities": None, "t_end": t_end}

    def decide(self, t_end: float) -> dict:
        t_end = float(t_end)
        if not np.isfinite(t_end):
            return self._invalid("bad_time", "t_end must be finite")
        if self.origin is None:
            return self._invalid("no_data", "no IMU event has arrived yet", t_end)
        t_rel = (t_end - self.origin) / 1000.0
        if t_rel < 2.0:
            return self._invalid("cold_start",
                                 "need two seconds of history, have %.2f s" % t_rel, t_end)
        missing = [f for f in FEET if self.last_t[f] is None]
        if missing:
            return self._invalid("missing_foot", "no IMU from %s" % ",".join(missing), t_end)

        grid = t_rel - 2.0 + (np.arange(WINDOW) + 0.5) / rt.PREPROCESS["fs_out"]
        cols, age_max = [], 0.0
        for f in FEET:
            x, ok, age = self.streams[f].query(grid)
            if not ok.all():
                return self._invalid(
                    "stream_gap",
                    "foot %s has %d of %d grid points without an event within %.0f ms"
                    % (f, int((~ok).sum()), WINDOW, rt.PREPROCESS["max_gap_s"] * 1000), t_end)
            age_max = max(age_max, float(np.max(age)))
            cols.append(x)

        feeds = np.concatenate(cols, axis=1).T[None].astype(np.float32)
        t0 = time.perf_counter()
        logits = self.session.run(None, {"x": feeds})[0][0]
        latency = (time.perf_counter() - t0) * 1000.0
        e = np.exp(logits - logits.max())
        prob = e / e.sum()
        idx = int(np.argmax(prob))
        self.decisions += 1
        self.last_valid_at = t_end
        return {
            "valid": True, "reason": None, "detail": None,
            "label": self.manifest["class_map"][str(idx)],
            "index": idx,
            "probabilities": [float(v) for v in prob],
            "t_end": t_end,
            "latency_ms": latency,
            "age_ms": age_max * 1000.0,
        }
