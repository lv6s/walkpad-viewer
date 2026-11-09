"""Executable online-v2 contract tests, including real ONNX inference."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from act_engine import ActEngine
from online_preprocess import OnlineInput, POLICY


def events(duration=7., fs=51.2, drop=None, constant=False, start=0., segment="a"):
    out = []
    for foot in ("l", "r"):
        for i in range(int(duration*fs)):
            t = i/fs
            if drop and drop(i, t, foot):
                continue
            phase = 2*np.pi*1.8*t+(np.pi if foot == "r" else 0)
            values = [np.sin(phase)*.4, .1*np.sin(phase*2), 1+.2*np.cos(phase*2),
                      20*np.sin(phase), 100*np.cos(phase), 10*np.sin(phase*2)]
            raw = list(np.round(np.array(values)*1000))
            if constant:
                values = [0, 0, 1, 0, 0, 0]
                raw = [0, 0, 2048, 0, 0, 0]
            d = start+round(t*1000)
            receipt = round(t*1000/25)*25+35
            out.append(dict(foot=foot, device_ms=d, receipt_ms=receipt,
                            seq=i, segment=segment, values=values, raw=raw))
    return sorted(out, key=lambda e: e["receipt_ms"])


def replay(eng, source, last_end=6000., fs=51.2):
    eng.reset(fs, fs)
    outputs, pos = [], 0
    for end in np.arange(0., last_end+.1, 200.):
        now = end+150
        nxt = pos
        while nxt < len(source) and source[nxt]["receipt_ms"] <= now:
            nxt += 1
        r = eng.step(source[pos:nxt], float(end), float(now))
        assert r.get("preprocess") == POLICY["version"], r
        if r["valid"]:
            assert np.isclose(sum(r["probabilities"]), 1)
        outputs.append(r)
        pos = nxt
    return outputs


def main():
    eng = ActEngine()
    checks = []
    def check(name, condition):
        assert condition, name
        checks.append(name)
        print("PASS", name)

    baseline = replay(eng, events())
    check("full-rate real ONNX probabilities", all(r["valid"] for r in baseline[13:]))
    check("normal quality", all(r.get("quality_level") == "normal" for r in baseline[13:]))
    check("fixed result age", all(r["result_age_ms"] == 150 for r in baseline))
    short = replay(eng, events(drop=lambda i, t, f: 150 <= i <= 152))
    check("3 missing frames within 80ms accepted", all(r["valid"] for r in short[13:]))
    check("short gap labeled degraded", any(r.get("quality_level") == "degraded" for r in short))
    long = replay(eng, events(drop=lambda i, t, f: 150 <= i <= 153))
    check("4 missing frames refused", any(r["reason"] == "stream_gap" for r in long[13:]))
    check("long gap auto recovers", long[-1]["valid"])
    low = replay(eng, events(drop=lambda i, t, f: i % 3 == 0))
    check("persistent 34Hz refused", not any(r["valid"] for r in low[13:]))
    moderate = replay(eng, events(drop=lambda i, t, f: i % 10 == 0))
    check("periodic 10 percent loss accepted", all(r["valid"] for r in moderate[13:]))
    check("declared density uses native reference", .87 < moderate[-1]["quality"]["l"]["density"] < .93)
    stopped = [e for e in events() if e["receipt_ms"] < 3200]
    silence = replay(eng, stopped)
    check("no fresh packets is invalid, never stale class", not silence[-1]["valid"] and silence[-1]["label"] is None)
    absent = replay(eng, [e for e in events() if e["foot"] == "l"])
    check("missing foot", absent[-1]["reason"] == "missing_foot")
    repeated = replay(eng, events(constant=True))
    check("suspect stale is not other", repeated[-1]["reason"] == "suspect_stale" and repeated[-1]["label"] is None)
    source = events()
    duplicate = sorted(source+[dict(e) for e in source[::9]], key=lambda e: e["receipt_ms"])
    dup = replay(eng, duplicate)
    check("duplicate events do not change model inputs", all(a["valid"] == b["valid"] and
          (not a["valid"] or np.allclose(a["probabilities"], b["probabilities"], atol=1e-7))
          for a, b in zip(baseline, dup)))
    check("duplicates counted", dup[-1]["quality"]["l"]["duplicates"] > 0)
    switched = events()
    for e in switched:
        if e["device_ms"] >= 3000:
            e["segment"] = "b"
            e["device_ms"] -= 3000
            e["seq"] -= 153
    reconnect = replay(eng, switched)
    check("connection boundary invalidates old window", any(not r["valid"] for r in reconnect[16:23]))
    check("connection boundary recovers", reconnect[-1]["valid"])
    check("connection reset tracked", reconnect[-1]["quality"]["l"]["resets"] == 1)
    bias = events()
    for e in bias:
        if e["device_ms"] >= 3000:
            e["segment"] = "bias2"
    bias_result = replay(eng, bias)
    check("bias segment recovers", bias_result[-1]["valid"])

    p = OnlineInput(51.2, 51.2)
    batch = events(duration=.4)
    p.push(batch, 1000)
    before = sum(len(s.events) for s in p.streams.values())
    invalid = dict(batch[0], values=[float("nan")]*6)
    try:
        p.push([dict(batch[0], device_ms=1000, seq=100), invalid], 2000)
        raise AssertionError("NaN accepted")
    except ValueError:
        pass
    check("batch validation is atomic", before == sum(len(s.events) for s in p.streams.values()))
    try:
        p.push([dict(batch[0], receipt_ms=3000)], 2000)
        raise AssertionError("future receipt accepted")
    except ValueError:
        pass
    checks.append("future receipts rejected")
    ordered = OnlineInput(51.2, 51.2)
    ordered.push(batch, 1000)
    delayed = OnlineInput(51.2, 51.2)
    shuffled = batch.copy()
    for i in range(0, len(shuffled)-4, 4):
        shuffled[i:i+4] = reversed(shuffled[i:i+4])
    delayed.push(shuffled, 1000)
    check("bounded reorder retains every unique frame", len(delayed.streams["l"].events) == len(ordered.streams["l"].events))
    np.testing.assert_allclose([e[0] for e in ordered.streams["l"].events],
                               [e[0] for e in delayed.streams["l"].events])
    huge = events()
    for e in huge:
        if e["device_ms"] >= 3000:
            e["receipt_ms"] += 3000
    paused = replay(eng, huge, last_end=8000)
    check("3s transport pause not erased by clock reanchor", not any(r["valid"] for r in paused[22:]))
    only = OnlineInput(51.2, 51.2)
    only.push(batch, 1000)
    only.decide(0, 150)
    only.decide(800, 1000)
    foot = only.streams["l"]
    frozen_count = len(foot.events)
    late = dict(batch[0], device_ms=650, seq=50, receipt_ms=1200)
    only.push([late], 1200)
    check("late support cannot rewrite finalized grid", len(foot.events) == frozen_count and foot.late > 0)
    future = OnlineInput(51.2, 51.2)
    try:
        future.push([dict(batch[0], receipt_ms=1001)], 1000)
        raise AssertionError("future accepted")
    except ValueError:
        pass
    check("decision rejects future support", len(future.streams["l"].events) == 0)
    eng.reset()
    bad = eng.step([], 0, 149)
    check("insufficient waiting rejected", bad["reason"] == "bad_time")
    fs45 = replay(eng, events(fs=45), fs=45)
    check("45Hz configured native cadence supported", all(r["valid"] for r in fs45[13:]))
    fs100 = replay(eng, events(fs=102.4), fs=102.4)
    check("102Hz cadence supported numerically", all(r["valid"] for r in fs100[13:]))
    fs42 = replay(eng, events(fs=42), fs=51.2)
    check("42Hz source cadence retains bounded support", all(r["valid"] for r in fs42[13:]))
    fs40 = replay(eng, events(fs=40), fs=51.2)
    check("40Hz source cadence fails reference density", not any(r["valid"] for r in fs40[13:]))
    alternating = events()
    for e in alternating:
        if e["seq"] % 7 == 2:
            e["receipt_ms"] += 45
    reordered = replay(eng, sorted(alternating, key=lambda e: e["receipt_ms"]))
    check("bounded transport reordering recovers", all(r["valid"] for r in reordered[13:]))
    check("bounded reordering cannot reset stream", reordered[-1]["quality"]["l"]["resets"] == 0)
    wrap = events()
    for e in wrap:
        e["seq"] = (e["seq"]+2**32-160) % 2**32
    wrapped = replay(eng, wrap)
    check("uint32 sequence wrap does not reset", wrapped[-1]["valid"] and wrapped[-1]["quality"]["l"]["resets"] == 0)
    jump = events()
    for e in jump:
        if e["device_ms"] >= 3000:
            e["device_ms"] += 5000
    jumped = replay(eng, jump)
    check("device clock jump rebuilds and recovers", jumped[-1]["valid"] and jumped[-1]["quality"]["l"]["resets"] == 1)
    p = OnlineInput(51.2, 51.2)
    p.push(events(duration=.3), 1000)
    p.decide(0, 150)
    p.decide(200, 350)
    history = [(r[0], r[2].copy()) for r in p.streams["l"].samples]
    p.push([dict(events(duration=.3)[2], device_ms=10, seq=100, receipt_ms=400)], 400)
    check("published values immutable after late arrival", all(i == r[0] and np.array_equal(v, r[2])
          for (i, v), r in zip(history, p.streams["l"].samples)))
    result = dict(checks=checks, count=len(checks), policy=POLICY,
                  onnx_sha256=eng.manifest["onnx_sha256"],
                  caveat="Synthetic transport and signals validate contracts, not hardware or classifier accuracy")
    print(json.dumps(result, ensure_ascii=False))
    print("ONLINE_SELFCHECK_PASS", len(checks))
    return result


if __name__ == "__main__":
    main()
