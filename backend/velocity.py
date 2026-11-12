import collections
import math


G = 9.80665


def norm(values):
    return math.sqrt(sum(x*x for x in values))


def multiply(a, b):
    w, x, y, z = a
    v, i, j, k = b
    return [w*v-x*i-y*j-z*k, w*i+x*v+y*k-z*j,
            w*j-x*k+y*v+z*i, w*k+x*j-y*i+z*v]


def rotate(q, vector):
    return multiply(multiply(q, [0, *vector]), [q[0], -q[1], -q[2], -q[3]])[1:]


class VelocityEstimator:
    """不从平稳六轴或陀螺零偏更新推断绝对零速。"""
    def __init__(self, external_bias=False):
        self.external_bias = external_bias
        self.epoch = 0
        self.reset()

    def reset(self, reason='idle'):
        self.epoch += 1
        self.status = reason
        self.samples = collections.deque()
        self.clock = None
        self.sequence = None
        self.connection = None
        self.domain = None
        self.q = [1., 0., 0., 0.]
        self.bias = [0., 0., 0.]
        self.bias_ready = False
        self.gravity = 1.
        self.velocity = [0., 0., 0.]
        self.previous_acc = None
        self.started = None
        self.calibration_started = None
        self.progress = 0.
        self.elapsed = 0.
        self.time_basis = None

    def arm(self):
        self.reset('calibrating')
        return self.snapshot()

    def snapshot(self):
        valid = self.status == 'estimating'
        return dict(status=self.status, valid=valid,
                    speed_mps=norm(self.velocity) if valid else None,
                    velocity_mps=list(self.velocity) if valid else None,
                    elapsed_s=self.elapsed, calibration_progress=self.progress,
                    time_basis=self.time_basis, frame='initial_level_z_up',
                    bias_source='online' if self.external_bias else 'initial',
                    bias_ready=self.bias_ready, gyro_bias_dps=list(self.bias) if self.bias_ready else None)

    def fail(self, reason):
        self.reset(reason)
        return self.snapshot()

    def push(self, values, clock_ms, connection, domain, sequence=None, *, bias_state=None):
        if self.status not in ('calibrating', 'estimating'):
            return self.snapshot()
        if (not isinstance(values, (list, tuple)) or len(values) != 6
                or any(not isinstance(x, (int, float)) or not math.isfinite(x) for x in values)
                or not isinstance(clock_ms, (int, float)) or not math.isfinite(clock_ms)):
            return self.fail('invalid_sample')
        if norm(values[:3]) > 15.5 or max(abs(x) for x in values[3:]) > 1900:
            return self.fail('saturated')
        if self.clock is not None:
            if connection != self.connection or domain != self.domain:
                return self.fail('connection_changed')
            dt = (clock_ms-self.clock)/1000
            if not .001 <= dt <= .2:
                return self.fail('time_gap')
            if sequence is not None and self.sequence is not None and (sequence-self.sequence) % 2**32 != 1:
                return self.fail('sequence_gap')
        else:
            dt = 0.
        self.clock = clock_ms
        self.sequence = sequence
        self.connection = connection
        self.domain = domain
        self.time_basis = domain
        acc, gyro = list(values[:3]), list(values[3:])
        if self.external_bias:
            if bias_state is None:
                return self.fail('bias_unavailable')
            candidate = bias_state.get('gyro_bias_dps')
            ready = (bias_state.get('ready') and isinstance(candidate, (list, tuple)) and len(candidate) == 3
                     and all(isinstance(x, (int, float)) and math.isfinite(x) for x in candidate))
            if self.status == 'estimating' and (not ready or bias_state.get('discontinuity')):
                return self.fail('bias_boundary')
            self.bias_ready = bool(ready)
            if ready:
                self.bias = list(candidate)
        corrected = [x-b for x, b in zip(gyro, self.bias)]
        if self.status == 'calibrating':
            if self.calibration_started is None:
                self.calibration_started = clock_ms
            if clock_ms-self.calibration_started > 30000:
                return self.fail('calibration_timeout')
            if abs(norm(acc)-1.) > .15 or norm(corrected) > 3.:
                self.samples.clear()
                self.progress = 0.
                return self.snapshot()
            self.samples.append((clock_ms, acc, gyro))
            while len(self.samples) > 1 and clock_ms-self.samples[1][0] >= 5000:
                self.samples.popleft()
            span = (clock_ms-self.samples[0][0])/1000
            self.progress = min(1., span/5.)
            if span < 5. or len(self.samples) < 50 or (self.external_bias and not self.bias_ready):
                return self.snapshot()
            weights = [self.samples[i+1][0]-s[0] for i, s in enumerate(list(self.samples)[:-1])]
            total = sum(weights)
            means = [[sum(s[group][axis]*w for s, w in zip(self.samples, weights))/total
                      for axis in range(3)] for group in (1, 2)]
            for group, limit in ((1, .012), (2, .20)):
                if any(math.sqrt(sum(w*(s[group][axis]-means[group-1][axis])**2
                                     for s, w in zip(self.samples, weights))/total) > limit for axis in range(3)):
                    self.samples.clear()
                    self.progress = 0.
                    return self.snapshot()
            a, initial_bias = means
            # 鞋垫仅使用同帧在线偏置，不能再扣一次初始化残余均值。
            if not self.external_bias:
                self.bias = initial_bias
                self.bias_ready = True
            self.gravity = norm(a)
            u = [x/self.gravity for x in a]
            q = [1.+u[2], u[1], -u[0], 0.]
            self.q = [0., 1., 0., 0.] if norm(q) < 1e-8 else [x/norm(q) for x in q]
            self.velocity = [0., 0., 0.]
            self.previous_acc = [0., 0., 0.]
            self.started = clock_ms
            self.elapsed = 0.
            self.status = 'estimating'
            self.samples.clear()
            return self.snapshot()
        self.elapsed = (clock_ms-self.started)/1000
        omega = [x*math.pi/180 for x in corrected]
        angle = norm(omega)*dt
        delta = ([math.cos(angle/2), *[x*math.sin(angle/2)/norm(omega) for x in omega]]
                 if angle > 1e-12 else [1., 0., 0., 0.])
        q = multiply(self.q, delta)
        self.q = [x/norm(q) for x in q]
        world = rotate(self.q, acc)
        linear = [world[0]*G, world[1]*G, (world[2]-self.gravity)*G]
        self.velocity = [v+(a+b)*dt/2 for v, a, b in zip(self.velocity, self.previous_acc, linear)]
        self.previous_acc = linear
        if not all(math.isfinite(x) for x in self.velocity):
            return self.fail('invalid_sample')
        return self.snapshot()
