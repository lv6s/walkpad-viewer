from math import asin, atan2, cos, isfinite, pi, sin, sqrt


ACC_SCALE = 0.000488
GYRO_SCALE = 0.07


def measured_axes(raw, scale):
    return raw[1] * scale, -raw[0] * scale, raw[2] * scale


def _normalized(q):
    norm = sqrt(sum(v * v for v in q))
    return tuple(v / norm for v in q)


class LabAttitude:
    # Lab d56-acc488ug-gyro70mdps-measured-v6, initialized from the recorded raw segment.
    def __init__(self, scope):
        self.scope = scope
        self.generation = -1
        self._reset()

    def _clear_window(self):
        self.stable_at = None
        self.stable_count = 0
        self.bias = [0., 0., 0.]
        self.window_min = self.window_max = None

    def _reset(self):
        self.generation += 1
        self.q = (1., 0., 0., 0.)
        self.last = None
        self.tracking = False
        self._clear_window()

    def _stable(self, sample, gravity_reliable):
        if not gravity_reliable or any(abs(v) >= .5 for v in sample[3:]):
            return False
        if self.window_min is None:
            self.window_min, self.window_max = list(sample), list(sample)
        stable = True
        for i, v in enumerate(sample):
            self.window_min[i] = min(self.window_min[i], v)
            self.window_max[i] = max(self.window_max[i], v)
            stable &= self.window_max[i] - self.window_min[i] <= (.035 if i < 3 else .025)
        return stable

    def add(self, raw, time_us):
        if len(raw) != 6 or any(v is None or not isfinite(v) or v % 1 or abs(v) >= 32760 for v in raw):
            self._reset()
            return None
        # App skips all-zero acceleration without advancing its hardware clock.
        if time_us is None or not any(raw[:3]):
            return None
        if self.last is not None:
            if time_us <= self.last:
                return None
            if time_us - self.last > 250_000:
                self._reset()
        a = measured_axes(raw[:3], ACC_SCALE)
        g = tuple(v * (pi / 180) for v in measured_axes(raw[3:], GYRO_SCALE))
        norm = sqrt(sum(v * v for v in a))
        gravity_reliable = .85 <= norm <= 1.15
        if self.last is None and not gravity_reliable:
            return None
        if not self.tracking:
            if gravity_reliable:
                x, y, z = (v / norm for v in a)
                self.q = (0., 1., 0., 0.) if z < -.999999 else _normalized((1 + z, y, -x, 0.))
            if self._stable(a + g, gravity_reliable):
                if self.stable_at is None:
                    self.stable_at = time_us
                self.stable_count += 1
                for i, v in enumerate(g):
                    self.bias[i] += (v - self.bias[i]) / self.stable_count
                self.tracking = time_us - self.stable_at >= 2_000_000 and self.stable_count >= 12
            else:
                self._clear_window()
        else:
            w, x, y, z = self.q
            gx, gy, gz = (v - b for v, b in zip(g, self.bias))
            if gravity_reliable:
                px, py, pz = 2 * (x*z - w*y), 2 * (y*z + w*x), 1 - 2 * (x*x + y*y)
                ax, ay, az = (v / norm for v in a)
                gx += 2 * (ay*pz - az*py)
                gy += 2 * (az*px - ax*pz)
                gz += 2 * (ax*py - ay*px)
            speed = sqrt(gx*gx + gy*gy + gz*gz)
            if speed > 1e-12:
                dt = (time_us - self.last) / 1_000_000
                half = speed * dt / 2
                scale = sin(half) / speed
                dw, dx, dy, dz = cos(half), gx*scale, gy*scale, gz*scale
                self.q = _normalized((w*dw - x*dx - y*dy - z*dz, w*dx + x*dw + y*dz - z*dy,
                                      w*dy - x*dz + y*dw + z*dx, w*dz + x*dy - y*dx + z*dw))
        self.last = time_us
        w, x, y, z = self.q
        pitch = atan2(2 * (w*x + y*z), 1 - 2 * (x*x + y*y)) * 180 / pi
        side = asin(max(-1., min(1., 2 * (w*y - z*x)))) * 180 / pi
        heading = atan2(2 * (w*z + x*y), 1 - 2 * (y*y + z*z)) * 180 / pi if self.tracking else None
        return pitch, side, heading, f'{self.scope}:{self.generation}'
