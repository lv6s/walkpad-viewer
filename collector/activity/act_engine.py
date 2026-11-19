"""实时 walk/run/other 推断；输入为自研坐标系 g/dps，角速度由调用方扣偏。

ONNX 内含归一化；轴变换只在本引擎执行。online-v2 与 legacy-v1 分开版本。
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

import runtime_activity_v1 as rt
from online_preprocess import OnlineInput, POLICY

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
    def reset(self, fs_left: float = 51.2, fs_right: float = 51.2,
              mode: str = "online-v2") -> dict:
        for fs in (fs_left, fs_right):
            if not np.isfinite(fs) or fs <= 0:
                raise ValueError("declared native rate must be finite and positive")
        if mode not in ("online-v2", "legacy-v1"):
            raise ValueError("unknown preprocessing mode")
        online = OnlineInput(fs_left, fs_right) if mode == "online-v2" else None
        self.mode = mode
        self.online = online
        self.fs = {"l": float(fs_left), "r": float(fs_right)}
        self.streams = {f: rt.Stream(fs_in=self.fs[f]) for f in FEET}
        self.origin = None
        self.last_t = {"l": None, "r": None}
        self.decisions = 0
        self.last_valid_at = None
        return {"ok": True, "fs": self.fs, "mode": self.mode, "policy": POLICY}

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
            "max_gap_s": POLICY["max_span_ms"] / 1000,
            "mode": self.mode,
            "online_policy": POLICY,
            "opset": m["opset"],
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

    def step(self, events, t_end: float, now_ms=None) -> dict:
        """页面用的合并入口；online-v2 明确传入接收可用时刻。"""
        if self.mode == "online-v2":
            if now_ms is None or not np.isfinite([t_end, now_ms]).all():
                return self._invalid("bad_time", "online-v2 requires finite now_ms", t_end)
            if len(events) > MAX_EVENTS_PER_STEP:
                return self._invalid("too_many_events", "too many online events", t_end)
            if now_ms-t_end < POLICY["buffer_ms"]-1e-6:
                return self._invalid("bad_time", "insufficient availability delay", t_end)
            if self.online.last_now is not None and (now_ms < self.online.last_now or t_end <= self.online.last_end):
                return self._invalid("bad_time", "decision clock moved backwards", t_end)
            if self.online.grid_origin is not None:
                phase = (t_end-self.online.grid_origin)/20
                if abs(phase-round(phase)) > 1e-5:
                    return self._invalid("bad_time", "decision is off the established grid", t_end)
            try:
                accepted = self.online.push(events, float(now_ms))
            except (ValueError, TypeError, KeyError) as exc:
                return self._invalid("bad_request", str(exc), t_end)
            feeds, quality, reason = self.online.decide(float(t_end), float(now_ms))
            if reason:
                out = self._invalid(reason, "online input quality gate", t_end)
                out.update(quality=quality, preprocess=POLICY["version"],
                           result_age_ms=float(now_ms-t_end))
                return out
            feeds = np.concatenate([self._rotate(feeds[0, :6].T),
                                    self._rotate(feeds[0, 6:].T)], axis=1).T[None].astype(np.float32)
            out = self._predict(feeds, t_end)
            out.update(quality=quality, preprocess=POLICY["version"],
                       quality_level="degraded" if any(q["repaired_fraction"] > 0 or q["density"] < .95
                                                       for q in quality.values()) else "normal",
                       result_age_ms=float(now_ms-t_end),
                       age_ms=max(q["max_span_ms"] for q in quality.values()),
                       pushed={"ok": True, "accepted": accepted})
            return out
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
        out = self._predict(feeds, t_end)
        out["age_ms"] = age_max * 1000.0
        return out

    def _predict(self, feeds, t_end):
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
            "age_ms": None,
        }
