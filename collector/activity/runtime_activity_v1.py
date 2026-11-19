"""Single causal preprocessing operator, shared by the offline cache build and online inference.

Contract (violating any line changes values silently, it never raises):
  * every native rate is low-pass filtered, one-sided, order 2, cutoff = min(22.5, 0.45*fs_in);
  * a grid point is filled by forward hold from the last event at or before that grid point;
  * filter state is carried across push() calls, so streaming equals batch on any prefix;
  * returned age is grid_t - t_support and is never negative.
"""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, lfilter, lfilter_zi

FS_OUT = 50.0
MAX_GAP_S = 0.06
FILTER_ORDER = 2
MAX_CUTOFF_HZ = 22.5
CUTOFF_FRACTION = 0.45
# Stream keeps only the tail needed for the newest windows (2.0 s window + 0.5 s guard).
# Older grid points are reported ok=False rather than served from a silently wrong hold.
RETAIN_S = 2.5

# Declared here as well as in activity_data_v1; runtime_binding() refuses to bind if
# the two declarations ever drift apart.
PREPROCESS = {
    "version": "activity-preprocess-v1",
    "fs_out": 50.0,
    "max_gap_s": 0.06,
    "hold": "forward_hold_only_samples_at_or_before_grid",
    "filter": "one_sided_butterworth_lowpass",
    "filter_order": 2,
    "cutoff_hz": "min(22.5, 0.45 * fs_in)",
    "applies_to_all_native_rates": True,
    "window_samples": 100,
    "hop_samples": 10,
    "guard_samples": 25,
}


def cutoff_hz(fs_in: float) -> float:
    return float(min(MAX_CUTOFF_HZ, CUTOFF_FRACTION * float(fs_in)))


def _design(fs_in: float):
    fs_in = float(fs_in)
    if not np.isfinite(fs_in) or fs_in <= 0:
        raise ValueError(f"invalid native rate {fs_in}")
    wn = cutoff_hz(fs_in) / (0.5 * fs_in)
    if not 0.0 < wn < 1.0:
        raise ValueError(f"cutoff {cutoff_hz(fs_in)} Hz is not below the Nyquist of {fs_in} Hz")
    return butter(FILTER_ORDER, wn, btype="low")


def _as_values(values) -> np.ndarray:
    v = np.asarray(values, dtype=np.float64)
    if v.ndim == 1:
        v = v[:, None]
    if v.ndim != 2:
        raise ValueError(f"values must be (n, c), got {v.shape}")
    # A NaN would propagate through the filter and still come out ok=True, i.e. it would
    # enter the model as a valid sample. Refuse it at the door instead.
    if not np.isfinite(v).all():
        raise ValueError("values contain non-finite entries")
    return v


def _check_time(t: np.ndarray) -> None:
    # np.diff(t) < 0 is False for NaN, so a NaN timestamp would pass a monotonic-only check.
    if not np.isfinite(t).all():
        raise ValueError("event time contains non-finite entries")
    if np.any(np.diff(t) < 0):
        raise ValueError("event time must be non-decreasing")


def _steady_state(b, a, v0) -> np.ndarray:
    """Start the recurrence at the DC steady state of the first sample, not at zero.

    Zero initial conditions put a startup transient inside the first window; this keeps a
    constant input exactly constant so the guard band is about gaps, not filter settling.
    """
    return lfilter_zi(b, a)[:, None] * v0[None, :]


def infer_native_rate(t: np.ndarray) -> float:
    if t.size < 2:
        raise ValueError("fs_in is required when fewer than two samples are supplied")
    d = np.diff(t)
    d = d[d > 0]
    if d.size == 0:
        raise ValueError("cannot infer a native rate from duplicate timestamps")
    return float(round(1.0 / float(np.median(d)), 6))


def _hold(t: np.ndarray, x: np.ndarray, grid: np.ndarray, max_gap_s: float):
    idx = np.searchsorted(t, grid, side="right") - 1
    has = idx >= 0
    idx_c = np.clip(idx, 0, len(t) - 1)
    age = np.full(grid.shape, np.inf, dtype=np.float64)
    if has.any():
        age[has] = grid[has] - t[idx_c[has]]
    ok = has & (age <= float(max_gap_s))
    return x[idx_c].astype(np.float32), ok, age


def resample_to_grid(t_event, values, grid_t, *, fs_in=None, fs_out=FS_OUT, max_gap_s=MAX_GAP_S):
    """Event-time samples -> values at grid_t. Returns (x (m, c) float32, ok (m,) bool, age (m,))."""
    t = np.asarray(t_event, dtype=np.float64).reshape(-1)
    v = _as_values(values)
    g = np.asarray(grid_t, dtype=np.float64).reshape(-1)
    if t.shape[0] != v.shape[0]:
        raise ValueError(f"event time / values length mismatch: {t.shape[0]} vs {v.shape[0]}")
    if t.size == 0:
        raise ValueError("empty input")
    _check_time(t)
    fs = float(fs_in) if fs_in is not None else infer_native_rate(t)
    b, a = _design(fs)
    filtered, _ = lfilter(b, a, v, axis=0, zi=_steady_state(b, a, v[0]))
    return _hold(t, filtered, g, max_gap_s)


class Stream:
    """Incremental form of resample_to_grid; push() may be called in arbitrary chunk sizes.

    Only grids within RETAIN_S of the newest event are served; older ones come back ok=False
    so a caller can never mistake a pruned-history hold for a real one.
    """

    def __init__(self, fs_out=FS_OUT, max_gap_s=MAX_GAP_S, fs_in=None):
        self.fs_out = float(fs_out)
        self.max_gap_s = float(max_gap_s)
        self.fs_in = None if fs_in is None else float(fs_in)
        self.n_ch = None
        self._b = None
        self._a = None
        self._zi = None
        self._t: list[np.ndarray] = []
        self._x: list[np.ndarray] = []
        self._last_t = None

    @property
    def last_event_time(self):
        return self._last_t

    def push(self, t, values) -> None:
        t = np.asarray(t, dtype=np.float64).reshape(-1)
        v = _as_values(values)
        if t.shape[0] != v.shape[0]:
            raise ValueError(f"event time / values length mismatch: {t.shape[0]} vs {v.shape[0]}")
        if t.size == 0:
            return
        _check_time(t)
        if self._last_t is not None and t[0] < self._last_t:
            raise ValueError("push() received an event older than the previous batch")
        if self.n_ch is None:
            self.n_ch = v.shape[1]
        elif v.shape[1] != self.n_ch:
            raise ValueError(f"channel count changed: {v.shape[1]} vs {self.n_ch}")
        if self._b is None:
            fs = self.fs_in if self.fs_in is not None else infer_native_rate(t)
            self._b, self._a = _design(fs)
            self._zi = _steady_state(self._b, self._a, v[0])
        filtered, self._zi = lfilter(self._b, self._a, v, axis=0, zi=self._zi)
        self._t.append(t)
        self._x.append(filtered)
        self._last_t = float(t[-1])
        self._prune()

    def _prune(self) -> None:
        """Drop samples older than RETAIN_S behind the newest event; keeps memory flat."""
        cut = self._last_t - RETAIN_S
        while len(self._t) > 1 and float(self._t[0][-1]) < cut:
            self._t.pop(0)
            self._x.pop(0)
        if float(self._t[0][0]) < cut:
            keep = self._t[0] >= cut
            if not keep.any():
                self._t.pop(0)
                self._x.pop(0)
            else:
                self._t[0] = self._t[0][keep]
                self._x[0] = self._x[0][keep]

    @property
    def retained_events(self) -> int:
        return int(sum(len(a) for a in self._t))

    def query(self, grid_t):
        if not self._t:
            raise RuntimeError("query() before any push()")
        g = np.asarray(grid_t, dtype=np.float64).reshape(-1)
        return _hold(np.concatenate(self._t), np.concatenate(self._x, axis=0), g, self.max_gap_s)


__all__ = ["resample_to_grid", "Stream", "cutoff_hz", "infer_native_rate", "PREPROCESS",
           "FS_OUT", "MAX_GAP_S", "FILTER_ORDER", "RETAIN_S"]
