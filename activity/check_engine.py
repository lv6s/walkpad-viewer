"""自检：ONNX 图与 torch 参考一致、真实回放与交付参考逐窗一致。

参考数据由算力侧从同一份权重与同一套预处理生成：
  act_imu_v1_golden.npz  —— 12 个真实窗口的 logits / probs / 类别
  own_insole_ref.npz     —— 三份自研记录的逐窗决策（已套用轴向旋转）
"""
from __future__ import annotations

import itertools
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from act_engine import ActEngine, CLASSES  # noqa: E402

HERE = Path(__file__).resolve().parent
STEP_US = 200_000
COLD_US = 2_000_000


def check_golden(eng: ActEngine) -> None:
    d = np.load(HERE / "act_imu_v1_golden.npz")
    x, logits, probs, label = d["x"], d["logits"], d["probs"], d["label"]
    got = []
    for i in range(len(x)):
        logit = eng.session.run(None, {"x": x[i:i + 1]})[0][0]
        e = np.exp(logit - logit.max())
        got.append(e / e.sum())
    got = np.stack(got)
    dlogit = 0.0
    dprob = float(np.max(np.abs(got - probs)))
    same = bool((got.argmax(1) == label).all())
    print("GOLDEN n=%d max|dprob|=%.2e label_match=%s" % (len(x), dprob, same))
    assert dprob < 1e-4, dprob
    assert same, "golden labels changed"
    assert logits.shape == probs.shape


def replay(eng: ActEngine, npz, key: str) -> list:
    t_us = npz[key + "_t_us"]
    foot = npz[key + "_foot"]
    vals = npz[key + "_values"].astype(np.float64)
    eng.reset(50.0, 50.0)
    out, next_us = [], COLD_US

    def decide(us):
        out.append(eng.decide(us / 1000.0))

    for us, idx in itertools.groupby(range(len(t_us)), key=lambda i: int(t_us[i])):
        while next_us < us:
            decide(next_us)
            next_us += STEP_US
        batch = [["l" if foot[i] == 0 else "r",
                  [t_us[i] / 1000.0, *vals[i].tolist()]] for i in idx]
        pushed = eng.push(batch)
        assert pushed["ok"], pushed
        if next_us == us:
            decide(us)
            next_us += STEP_US
    return out


def check_replays(eng: ActEngine) -> None:
    ref = np.load(HERE / "own_insole_ref.npz")
    for key, name in (("r1", "小刘步行软鞋垫"), ("r2", "新鞋垫01ADC步行"), ("r3", "新鞋垫小刘步行")):
        got = replay(eng, ref, key)
        t_end = ref[key + "_t_end"]
        valid = ref[key + "_valid"]
        label = ref[key + "_label"]
        probs = ref[key + "_probs"]
        assert len(got) == len(t_end), (len(got), len(t_end))
        # 引擎用毫秒，参考用秒
        assert [d["t_end"] / 1000.0 for d in got] == [float(v) for v in t_end], "decision times drifted"
        bad = [i for i, d in enumerate(got) if bool(d["valid"]) != bool(valid[i])]
        assert not bad, "validity mismatch at %s" % bad[:5]
        worst, mism = 0.0, 0
        for i, d in enumerate(got):
            if not valid[i]:
                continue
            worst = max(worst, float(np.max(np.abs(np.array(d["probabilities"]) - probs[i]))))
            if d["index"] != label[i]:
                mism += 1
        counts = {c: sum(1 for i, d in enumerate(got) if d["valid"] and d["index"] == k)
                  for k, c in enumerate(CLASSES)}
        print("REPLAY %-9s decisions=%3d valid=%3d labels=%s max|dprob|=%.2e argmax_diff=%d"
              % (name, len(got), int(valid.sum()), counts, worst, mism))
        assert worst < 1e-4, worst
        assert mism == 0, mism


def check_contract(eng: ActEngine) -> None:
    eng.reset(50.0, 50.0)
    r = eng.decide(1000.0)
    assert not r["valid"] and r["reason"] == "no_data", r
    ok = eng.push([["l", [0.0, 0, 0, 1, 0, 0, 0]] * 1])
    assert ok["ok"], ok
    r = eng.decide(1000.0)
    assert not r["valid"] and r["reason"] == "cold_start", r
    late = eng.push([["l", [-1.0, 0, 0, 1, 0, 0, 0]]])
    assert not late["ok"] and late["reason"] == "order", late
    nan = eng.push([["l", [1.0, float("nan"), 0, 1, 0, 0, 0]]])
    assert not nan["ok"] and nan["reason"] == "bad_values", nan
    wrong = eng.push([["l", [1.0, 0, 0, 1, 0, 0]]])
    assert not wrong["ok"] and wrong["reason"] == "bad_request", wrong
    r = eng.decide(9000.0)
    assert not r["valid"] and r["reason"] == "missing_foot", r
    print("CONTRACT no_data/cold_start/order/bad_values/bad_request/missing_foot ok")


def main() -> int:
    eng = ActEngine(threads=1)
    info = eng.info()
    print("MODEL %s opset=%s axis=%s" % (info["model"], eng.manifest["opset"],
                                         "rz90" if info["axis_own_to_train"][0][1] == 1 else "id"))
    check_contract(eng)
    check_golden(eng)
    check_replays(eng)
    print("ENGINE_SELFCHECK_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
