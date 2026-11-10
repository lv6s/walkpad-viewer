import collections
import concurrent.futures
import json
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Algorithm:
    def __init__(self):
        self.queue = queue.Queue(maxsize=1500)
        self.lock = threading.Lock()
        self.state = {'enabled':False,'profile':'insole','result':{'valid':False,'reason':'not_started'},'bias':{},'error':None,'dropped':0}
        self.running = True
        self.thread = threading.Thread(target=self._run,name='algorithm-worker',daemon=True)
        self.thread.start()
        self.on_decision = None

    def offer(self, item):
        try:
            self.queue.put_nowait(item)
        except queue.Full:
            with self.lock:
                self.state['dropped'] += 1
                self.state['result'] = {'valid':False,'reason':'algorithm_queue_overflow'}
            self.overflow = True

    def control(self, kind, **args):
        future = concurrent.futures.Future()
        try:
            if not self.thread.is_alive():
                raise RuntimeError(self.state.get('error') or '算法线程已停止')
            self.queue.put_nowait(dict(control=kind,future=future,**args))
        except (queue.Full,RuntimeError) as exc:
            future.set_exception(RuntimeError('算法队列已满') if isinstance(exc,queue.Full) else exc)
        return future

    def snapshot(self):
        with self.lock:
            state = json.loads(json.dumps(self.state))
        result = state['result']
        if result.get('published_host_ms') is not None and time.monotonic()*1000-result['published_host_ms'] > 600:
            state['result'] = {'valid':False,'reason':'stale_result'}
        return state

    def _run(self):
        bias = None
        engines = {}
        active = {}
        profile = 'insole'
        enabled = False
        pending = []
        last_end = None
        last_clock = None
        self.overflow = False
        try:
            node = shutil.which('node')
            if not node:
                raise RuntimeError('Node.js 不可用，无法运行精确零偏参考')
            bias = subprocess.Popen([node,str(ROOT/'backend/bias_worker.cjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL,text=True,encoding='utf-8',creationflags=0x08000000 if sys.platform == 'win32' else 0)
            def prepare(records=(), reset=False):
                bias.stdin.write(json.dumps({'records':records,'reset':reset},allow_nan=False)+'\n')
                bias.stdin.flush()
                line = bias.stdout.readline()
                if not line:
                    raise RuntimeError('零偏参考进程退出')
                result = json.loads(line)
                if not result['ok']:
                    raise ValueError(result['error'])
                return result
            def engine():
                if profile not in engines:
                    sys.path.insert(0,str(ROOT/'activity'))
                    if profile == 'insole':
                        from act_engine import ActEngine
                        engines[profile] = ActEngine(threads=1)
                    else:
                        from wt_engine import WTEngine
                        engines[profile] = WTEngine(threads=1)
                return engines[profile]
            def reset(reason):
                nonlocal last_end
                pending.clear(); last_end = None
                if profile in engines:
                    fs = 51.2 if profile == 'insole' else 50.
                    engines[profile].reset(fs,fs)
                with self.lock:
                    self.state['result'] = {'valid':False,'reason':reason}
            while self.running:
                try:
                    item = self.queue.get(timeout=.1)
                except queue.Empty:
                    continue
                future = item.get('future')
                try:
                    if self.overflow:
                        reset('algorithm_queue_overflow')
                        prepare(reset=True)
                        active.clear()
                        self.overflow = False
                    control = item.get('control')
                    if control:
                        if control == 'configure':
                            profile = item.get('profile',profile)
                            enabled = item.get('enabled',enabled)
                            last_clock = None
                            prepare(reset=True); active.clear(); reset('warming_up' if enabled else 'not_started')
                            if enabled:
                                info = engine().info()
                                with self.lock:
                                    self.state['model'] = info
                            with self.lock:
                                self.state.update(profile=profile,enabled=enabled,bias={},error=None)
                        elif control == 'boundary':
                            if item.get('foot') in ('l','r'):
                                foot = item['foot']
                                prepare([{'foot':foot,'processing_ms':item['clock_ms'],'action':'reset_bias'}])
                                active.pop(foot,None)
                                with self.lock:
                                    self.state['bias'].pop(foot,None)
                            reset(item.get('reason','device_boundary'))
                        elif control == 'bias':
                            record = {'foot':item['foot'],'processing_ms':item['clock_ms'],'action':item['action']}
                            output = prepare([record])
                            with self.lock:
                                self.state['bias'][item['foot']] = output['states'][-1]
                            reset('bias_boundary')
                        if future:
                            future.set_result(self.snapshot())
                        continue
                    if item['profile'] != profile or item.get('foot') not in ('l','r'):
                        continue
                    foot = item['foot']; clock = item['clock_ms']; frames = item['frames']
                    if last_clock is not None and clock < last_clock:
                        reset('clock_domain_boundary'); prepare(reset=True); active.clear()
                    last_clock = clock
                    if active.get(foot) != item['connection']:
                        prepare([{'foot':foot,'processing_ms':clock,'action':'reset_bias'}])
                        active[foot] = item['connection']
                        reset('device_boundary')
                    if profile == 'insole':
                        records = [dict(foot=foot,connection=item['connection'],processing_ms=clock,
                                        receipt_ms=item['source_receipt_ms'],device_ms=f['device_ms'],seq=f['seq'],raw6=f['raw6'])
                                   for f in frames if f.get('device_ms') is not None and not f.get('clock_coarse')]
                        if len(records) != len(frames):
                            reset('device_clock_unusable')
                            continue
                        output = prepare(records)
                        for state in output['states']:
                            with self.lock:
                                self.state['bias'][foot] = state
                            if state.get('discontinuity'):
                                reset('bias_boundary')
                        events = output['events']
                    else:
                        values = [f['values'] for f in frames if f.get('inference_eligible')]
                        events = [dict(foot=foot,receipt_ms=item['source_receipt_ms'],segment=item['connection'],values=values)] if values else []
                    if not enabled:
                        continue
                    if pending and clock-pending[0]['available'] > 1000:
                        reset('stale_input')
                    pending.extend(dict(event=e,available=clock) for e in events)
                    if last_end is None:
                        last_end = int(clock//200)*200-200
                    if clock-last_end > 1800:
                        reset('network_gap'); last_end = int(clock//200)*200-200
                    target = int((clock-150)//200)*200
                    while last_end+200 <= target:
                        end = last_end+200
                        available = end+150
                        take = [e['event'] for e in pending if e['available'] <= available]
                        pending = [e for e in pending if e['available'] > available]
                        eng = engine()
                        if take:
                            eng.online.push(take,available)
                        with self.lock:
                            ready = profile == 'wt' or all(self.state['bias'].get(f,{}).get('ready') for f in ('l','r'))
                        result = eng.step([],float(end),float(available)) if ready else {'valid':False,'reason':'bias_not_ready','t_end':end}
                        result = dict(result,published_host_ms=time.monotonic()*1000,clock_domain=item['source_time_domain'])
                        with self.lock:
                            self.state['result'] = result
                            self.state['error'] = None
                        if self.on_decision:
                            self.on_decision(result)
                        last_end = end
                except Exception as exc:
                    with self.lock:
                        self.state['error'] = str(exc)
                        self.state['result'] = {'valid':False,'reason':'algorithm_error'}
                    if future and not future.done():
                        future.set_exception(exc)
        except Exception as exc:
            with self.lock:
                self.state['error'] = str(exc)
        finally:
            self.running = False
            while True:
                try:
                    item = self.queue.get_nowait()
                except queue.Empty:
                    break
                future = item.get('future')
                if future and not future.done():
                    future.set_exception(RuntimeError(self.state.get('error') or '算法线程已停止'))
            if bias:
                bias.stdin.close()
                try:
                    bias.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    bias.terminate(); bias.wait(timeout=3)
                bias.stdout.close()

    def close(self):
        self.running = False
        self.thread.join(timeout=5)
