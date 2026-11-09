"""Bounded, delayed linear resampling on a shared host-time grid."""
from __future__ import annotations

from bisect import bisect_left
from collections import deque

import numpy as np
from scipy.signal import butter, lfilter, lfilter_zi

VERSION = "activity-online-linear-v2"
POLICY = {
    "version": VERSION, "fs_out": 50., "window_samples": 100,
    "hop_samples": 10, "buffer_ms": 150., "max_span_ms": 80.,
    "max_missing": 3, "max_repaired_fraction": .30, "min_density": .80,
    "filter_hz": 22.5, "filter_order": 2, "filter_guard_ms": 200.,
    "reorder_ms": 150., "retention_ms": 4500.,
}


def seq_delta(new, old):
    return ((new-old+2**31) % 2**32)-2**31


class DeviceStream:
    def __init__(self, fs):
        if not np.isfinite(fs) or not 45 <= fs <= 110:
            raise ValueError("reference native rate must be within 45..110 Hz")
        self.fs = float(fs)
        self.b, self.a = butter(2, POLICY["filter_hz"], fs=50)
        self.retired = deque(maxlen=32)
        self.segment = None
        self.resets = 0
        self.duplicates = 0
        self.late = 0
        self._clear()

    def _clear(self):
        self.events = []
        self.seen = {}
        self.clock_points = deque(maxlen=60)
        self.anchor_d = self.offset = None
        self.slope = 1.
        self.bin = None
        self.bin_best = None
        self.last_rx = None
        self.last_d = self.last_seq = None
        self.finalized_d = -np.inf
        self.finalized_host = -np.inf
        self.clock_dropped = 0
        self.samples = deque(maxlen=170)
        self.zi = None
        self.filter_since = None
        self.segment_start = None
        self.last_raw = None
        self.same_since = None

    def _new_segment(self, segment):
        if self.segment is not None:
            self.resets += 1
        self.segment = segment
        self._clear()

    def _clock(self, device, receipt):
        if self.anchor_d is None:
            self.anchor_d, self.offset = device, receipt
            self.segment_start = receipt
        d = device-self.anchor_d
        index = int(d//1000)
        if self.bin is None or index > self.bin:
            if self.bin_best is not None:
                self.clock_points.append(self.bin_best)
            self.bin, self.bin_best = index, (d, receipt)
            points = list(self.clock_points)
            if len(points) >= 10 and points[-1][0]-points[0][0] >= 8000:
                slopes = [(y2-y1)/(x2-x1) for x1, y1 in points for x2, y2 in points
                          if x2-x1 >= 5000]
                if slopes:
                    proposal = float(np.clip(np.median(slopes), .998, 1.002))
                    step = float(np.clip(proposal-self.slope, -.00002, .00002))
                    self.offset -= step*d
                    self.slope += step
        elif receipt-d < self.bin_best[1]-self.bin_best[0]:
            self.bin_best = (d, receipt)
        lag = receipt-self.slope*d
        if len(self.events) < 40 and not self.samples:
            self.offset = min(self.offset, lag)
        elif self.clock_points:
            target = float(np.percentile([y-self.slope*x for x, y in self.clock_points], 10))
            elapsed = max(0., receipt-(self.last_rx if self.last_rx is not None else receipt))
            self.offset += float(np.clip(target-self.offset, -elapsed*.001, elapsed*.001))
        self.last_rx = receipt

    def mapped(self, device):
        return self.offset+self.slope*(device-self.anchor_d)

    def push(self, event):
        d, rx, seq, segment, values, raw = event
        if self.segment != segment:
            if segment in self.retired:
                self.late += 1
                return
            if self.segment is not None:
                self.retired.append(self.segment)
            self._new_segment(segment)
        if self.last_d is not None:
            delta = seq_delta(seq, self.last_seq)
            residual = (d-self.last_d)-(rx-self.last_rx)
            if delta < 0 and (d >= self.last_d or d < self.last_d-2000):
                self._new_segment(segment)
            elif residual > 2000:
                self._new_segment(segment)
            elif abs(residual) > 2000:
                self.clock_dropped += 1
                return
            elif d < self.last_d-POLICY["reorder_ms"]:
                self.late += 1
                return
        identity = (d, seq)
        if identity in self.seen or d == self.last_d or seq in self.seen.values():
            self.duplicates += 1
            return
        if d <= self.finalized_d or (self.offset is not None and self.mapped(d) <= self.finalized_host):
            self.late += 1
            return
        if self.last_d is None or d > self.last_d:
            self._clock(d, rx)
            if not self.samples:
                self.events = [(*e[:5], self.mapped(e[0])) for e in self.events]
            self.last_d, self.last_seq = d, seq
        idx = bisect_left([e[0] for e in self.events], d)
        mapped = self.mapped(d)
        if (idx > 0 and mapped <= self.events[idx-1][5]) or (idx < len(self.events) and mapped >= self.events[idx][5]):
            self.clock_dropped += 1
            return
        self.events.insert(idx, (d, rx, seq, values, raw, mapped))
        self.seen[identity] = seq
        cutoff = self.last_d-POLICY["retention_ms"]
        while len(self.events) > 2 and self.events[1][0] < cutoff:
            gone = self.events.pop(0)
            self.seen.pop((gone[0], gone[2]), None)

    def advance(self, grids, now):
        if not len(grids):
            return
        available = [e for e in self.events if e[1] <= now]
        if available:
            # Freeze assigned times: later clock updates must not rewrite published support.
            times = np.array([e[5] for e in available])
        else:
            times = np.array([])
        for index, g in grids:
            self.finalized_host = max(self.finalized_host, g)
            ok, repaired, span, stale = False, False, 0., False
            value = np.zeros(6)
            if len(times):
                right = int(np.searchsorted(times, g, side="left"))
                exact = right < len(times) and abs(times[right]-g) < 1e-6
                if exact:
                    left = right
                else:
                    left = right-1
                if left >= 0 and right < len(times):
                    a, b = available[left], available[right]
                    span = times[right]-times[left]
                    count = seq_delta(b[2], a[2]) if right != left else 0
                    missing = max(count-1, 0)
                    repaired = missing > 0 or span > 1.5*1000/self.fs
                    ok = ((right == left or count > 0) and
                          span <= POLICY["max_span_ms"]+1e-6 and missing <= POLICY["max_missing"])
                    if ok:
                        weight = 0. if exact else (g-times[left])/span
                        value = a[3]+weight*(b[3]-a[3])
                    self.finalized_d = max(self.finalized_d, a[0])
                    raw = a[4]
                    if raw is not None:
                        if self.last_raw is None or not np.array_equal(raw, self.last_raw):
                            self.same_since = g
                        stale = self.same_since is not None and g-self.same_since >= 500
                        self.last_raw = raw
                    else:
                        self.last_raw, self.same_since = None, None
            if not ok or stale:
                self.zi, self.filter_since = None, None
                stable = False
            else:
                if self.zi is None:
                    self.zi = lfilter_zi(self.b, self.a)[:, None]*value
                    self.filter_since = g
                value, self.zi = lfilter(self.b, self.a, value[None], axis=0, zi=self.zi)
                value = value[0]
                stable = g-self.filter_since >= POLICY["filter_guard_ms"]-1e-6
            self.samples.append((index, g, value, bool(ok and stable and not stale), repaired, span, stale))

    def window(self, last_index):
        start = last_index-99
        rows = {r[0]: r for r in self.samples if start <= r[0] <= last_index}
        missing = sum(i not in rows or not rows[i][3] for i in range(start, last_index+1))
        present = list(rows.values())
        fraction = sum(r[4] for r in present)/100
        if present and self.offset is not None:
            end = max(r[1] for r in present)+10
            begin = end-2000
            count = sum(begin <= e[5] < end and e[1] <= end+POLICY["buffer_ms"]
                        for e in self.events)
            density = min(1., count/(self.fs*2))
        else:
            density = 0.
        quality = dict(repaired_fraction=float(fraction), density=float(density),
                       effective_hz=float(density*self.fs),
                       max_span_ms=float(max((r[5] for r in present), default=0.)),
                       invalid_points=missing, suspect_stale=any(r[6] for r in present),
                       resets=self.resets, duplicates=self.duplicates, late_dropped=self.late,
                       clock_dropped=self.clock_dropped,
                       clock_slope=self.slope, synchronization="host_mapping_not_hardware_verified")
        if missing:
            return None, quality, "suspect_stale" if quality["suspect_stale"] else "stream_gap"
        if fraction > POLICY["max_repaired_fraction"]+1e-9 or density < POLICY["min_density"]-1e-9:
            return None, quality, "loss_budget"
        return np.stack([rows[i][2] for i in range(start, last_index+1)]), quality, None


class OnlineInput:
    def __init__(self, fs_left, fs_right):
        self.streams = {"l": DeviceStream(fs_left), "r": DeviceStream(fs_right)}
        self.grid_origin = None
        self.next_index = 0
        self.last_end = None
        self.last_now = None

    @staticmethod
    def validate(events):
        batch = []
        for ev in events:
            if not isinstance(ev, dict) or ev.get("foot") not in ("l", "r"):
                raise ValueError("online events require foot/device_ms/receipt_ms/seq/segment/values")
            d, rx = float(ev["device_ms"]), float(ev["receipt_ms"])
            seq = ev["seq"]
            if isinstance(seq, bool) or not isinstance(seq, int) or not 0 <= seq < 2**32:
                raise ValueError("seq must be uint32")
            segment = ev["segment"]
            if not isinstance(segment, str) or not 0 < len(segment) <= 128:
                raise ValueError("segment must be a short nonempty string")
            values = np.asarray(ev["values"], float)
            raw = None if ev.get("raw") is None else np.asarray(ev["raw"], float)
            if (values.shape != (6,) or not np.isfinite(values).all() or not np.isfinite([d, rx]).all()
                    or raw is not None and (raw.shape != (6,) or not np.isfinite(raw).all())):
                raise ValueError("online event has invalid time or six-axis values")
            batch.append((ev["foot"], (d, rx, seq, segment, values, raw)))
        return batch

    def push(self, events, now):
        batch = self.validate(events)
        if any(e[1] > now+1e-6 for _, e in batch):
            raise ValueError("receipt time is later than decision availability time")
        for foot, event in batch:
            self.streams[foot].push(event)
        return len(batch)

    def decide(self, end, now):
        if not np.isfinite([end, now]).all() or now-end < POLICY["buffer_ms"]-1e-6:
            return None, {}, "bad_time"
        if self.last_end is not None and (end <= self.last_end or now < self.last_now):
            return None, {}, "bad_time"
        if self.grid_origin is None:
            self.grid_origin = end
        elapsed = (end-self.grid_origin)/20
        if abs(elapsed-round(elapsed)) > 1e-5:
            return None, {}, "bad_time"
        last_index = int(round(elapsed))-1
        first_index = max(self.next_index, last_index-169)
        if first_index > self.next_index:
            for stream in self.streams.values():
                stream.zi, stream.filter_since = None, None
                stream.samples.clear()
        grids = [(i, self.grid_origin+(i+.5)*20) for i in range(first_index, last_index+1)]
        self.last_end, self.last_now = end, now
        self.next_index = last_index+1
        for stream in self.streams.values():
            stream.advance(grids, now)
        quality, columns, failures = {}, [], []
        for foot, stream in self.streams.items():
            values, q, reason = stream.window(last_index)
            quality[foot] = q
            if not stream.events:
                reason = "missing_foot"
            if reason:
                failures.append(reason)
            else:
                columns.append(values)
        if failures:
            reason = "missing_foot" if "missing_foot" in failures else failures[0]
            if last_index < 109 and reason != "missing_foot":
                reason = "cold_start"
            return None, quality, reason
        return np.concatenate(columns, axis=1).T[None].astype(np.float32), quality, None
