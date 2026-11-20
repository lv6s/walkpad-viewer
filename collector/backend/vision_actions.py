from collections import deque
from dataclasses import dataclass, field
from math import acos, degrees, hypot, isfinite
from statistics import median


@dataclass
class Person:
    seen: float
    samples: deque = field(default_factory=lambda: deque(maxlen=160))
    phase: str = ''
    start: float = 0.
    reference: float = 0.
    angle: float = 0.
    bottom: float = 0.
    count: int = 0


def leg(pose, hip, knee, ankle):
    points = [pose[i] for i in (hip, knee, ankle)]
    if any(not all(map(isfinite, p)) or p[2] < .35 for p in points):
        return None
    a, b, c = points
    v = (a[0]-b[0], a[1]-b[1])
    w = (c[0]-b[0], c[1]-b[1])
    length = hypot(*v) + hypot(*w)
    product = hypot(*v) * hypot(*w)
    if length <= .03 or not product:
        return None
    angle = degrees(acos(max(-1., min(1., (v[0]*w[0]+v[1]*w[1])/product))))
    return (c[1]-a[1])/length, angle, c[0], c[1], length


def features(pose):
    sides = [leg(pose, *i) for i in ((11, 13, 15), (12, 14, 16))]
    usable = [v for v in sides if v is not None]
    if not usable:
        return None
    height, angle, _, foot_y, scale = [median(v[i] for v in usable) for i in range(5)]
    slope = (sides[0][3]-sides[1][3])/scale if all(sides) else None
    return height, angle, slope, foot_y, scale


class LiveActions:
    def __init__(self, retention=3.):
        self.people = {}
        self.retention = retention

    def frame(self, now, detections):
        self.people = {i: p for i, p in self.people.items() if now-p.seen <= self.retention}
        output = []
        for identity, box, pose in detections:
            p = self.people.setdefault(identity, Person(now))
            p.seen = now
            f = features(pose)
            if f is None or p.samples and now-p.samples[-1][0] > .6:
                p.samples.clear()
                p.phase = ''
            action, status = '未判定', 'unknown'
            if f is not None:
                action, status = self.update(p, now, f)
            output.append(dict(id=identity, box=box, action=action, status=status, count=p.count))
        return output

    def reset(self, identities):
        for identity in identities:
            person = self.people.get(identity)
            if person is not None:
                person.samples.clear()
                person.phase = ''

    @staticmethod
    def update(p, now, f):
        h, angle, _, _, _ = f
        p.samples.append((now, *f))
        while now-p.samples[0][0] > 2.5:
            p.samples.popleft()
        short = [x for x in p.samples if now-x[0] <= .23]
        h, angle = median(x[1] for x in short), median(x[2] for x in short)
        if p.phase:
            if now-p.start > 8.:
                p.phase = ''
            else:
                p.bottom = min(p.bottom, h)
                if p.reference-p.bottom >= .12 and h-p.bottom >= .04:
                    p.phase = 'up'
                if p.phase == 'up' and p.reference-h <= .07 and p.angle-angle <= 19:
                    p.phase = ''
                    if now-p.start >= .45:
                        p.count += 1
                        return '深蹲完成', 'confirmed'
                elif p.phase:
                    return ('深蹲候选·回升' if p.phase == 'up' else '深蹲候选·下降'), 'candidate'
        # A real preceding upright window is required, not just one tall frame.
        base = [x for x in p.samples if .25 <= now-x[0] <= 1.8 and x[2] >= 150]
        if len(base) >= 3 and base[-1][0]-base[0][0] >= .25:
            ref_h, ref_a = median(x[1] for x in base), median(x[2] for x in base)
            ref_foot = median(x[4] for x in base)
            if ref_h-h >= .10 and ref_a-angle >= 23 and abs(f[3]-ref_foot) <= .12*f[4]:
                p.phase, p.start, p.reference, p.angle, p.bottom = 'down', now, ref_h, ref_a, h
                return '深蹲候选·下降', 'candidate'
        window = [x for x in p.samples if now-x[0] <= 1.65]
        if len(window) >= 5 and now-window[0][0] >= .7:
            switches = []
            last = 0
            for t, _, _, feet, *_ in window:
                if feet is None:
                    continue
                sign = 1 if feet > .045 else -1 if feet < -.045 else 0
                if sign and sign != last and (not switches or t-switches[-1] >= .12):
                    switches.append(t)
                    last = sign
            heights = [x[1] for x in window]
            if len(switches) >= 3:
                step = median(b-a for a, b in zip(switches, switches[1:]))
                if len(switches) >= 4 and step < .34 and max(heights)-min(heights) >= .09:
                    return '跑步候选', 'candidate'
                return ('走路' if len(switches) >= 4 and step >= .34 else '走路候选',
                        'confirmed' if len(switches) >= 4 and step >= .34 else 'candidate')
            if len(switches) >= 2 and window[-1][0]-window[0][0] >= 1.0:
                delta = (window[-1][4]-window[0][4])/f[4]
                if abs(delta) >= .23:
                    return ('上楼梯候选' if delta < 0 else '下楼梯候选'), 'candidate'
            angles = [x[2] for x in window]
            foots = [x[4] for x in window]
            if (min(angles) >= 148 and max(angles)-min(angles) <= 11 and max(heights)-min(heights) <= .05
                    and max(foots)-min(foots) <= .08*f[4]):
                return '站立', 'confirmed'
        return '未判定', 'unknown'
