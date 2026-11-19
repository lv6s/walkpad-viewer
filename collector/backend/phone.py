import asyncio
import base64
import collections
import math
import re
import secrets
import socket
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .version import VERSION


def validate(body):
    if not isinstance(body,dict) or body.get('v') != 1:
        raise ValueError('unsupported envelope')
    sid = body.get('session')
    if not isinstance(sid,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}',sid):
        raise ValueError('invalid session')
    profile = body.get('profile')
    now = body.get('phone_now_ms')
    if profile not in ('wt','insole') or isinstance(now,bool) or not isinstance(now,(int,float)) or not math.isfinite(now) or now < 0:
        raise ValueError('invalid profile or time')
    if body.get('ack_mode','durable') not in ('received','durable'):
        raise ValueError('invalid acknowledgment mode')
    events = body.get('events')
    if not isinstance(events,list) or len(events) > 100:
        raise ValueError('at most 100 events')
    previous = -1
    stamp = -math.inf
    for event in events:
        if not isinstance(event,dict) or event.get('v') != 1 or event.get('session') != sid or event.get('profile') != profile:
            raise ValueError('event envelope mismatch')
        eid = event.get('id'); tick = event.get('phone_ms'); data = event.get('data')
        if isinstance(eid,bool) or not isinstance(eid,int) or not previous < eid <= 2**53:
            raise ValueError('invalid event id')
        if isinstance(tick,bool) or not isinstance(tick,(int,float)) or not math.isfinite(tick) or not stamp <= tick <= now:
            raise ValueError('invalid event clock')
        if not isinstance(data,dict) or event.get('type') not in ('start','stop','connect','disconnect','notify','marker'):
            raise ValueError('invalid event')
        if event['type'] in ('connect','disconnect','notify'):
            if data.get('foot') not in ('l','r') or not isinstance(data.get('connection'),str) or len(data['connection']) > 128:
                raise ValueError('invalid connection')
        if event['type'] == 'notify':
            rx = data.get('receipt_ms')
            if isinstance(rx,bool) or not isinstance(rx,(int,float)) or not math.isfinite(rx) or not 0 <= rx <= tick:
                raise ValueError('invalid callback time')
            if not isinstance(data.get('bytes'),str) or len(data['bytes']) > 12000 or len(base64.b64decode(data['bytes'],validate=True)) > 8192:
                raise ValueError('invalid notification')
        stamp = tick; previous = eid
    return body


class Phone:
    def __init__(self,capture,port=8766):
        self.capture = capture
        self.port = port
        self.token = secrets.token_urlsafe(18)
        self.session = None
        self.retired = collections.deque(maxlen=64)
        self.last_id = 0
        self.received_id = 0
        self.flush_task = None
        self.next_checkpoint = 0.
        self.last_phone = None
        self.last_receive = None
        self.baselines = collections.deque(maxlen=600)
        self.server = None
        self.task = None
        self.lock = asyncio.Lock()
        self.profile = None
        self.paused = False
        self.watchdog = None

    async def enable(self):
        if self.task and not self.task.done():
            return self.config()
        import uvicorn
        sock = socket.socket()
        try:
            sock.bind(('0.0.0.0',self.port))
            sock.listen(128)
            sock.setblocking(False)
        except OSError:
            sock.close()
            raise ValueError(str(self.port)+'端口已被占用。不会停止旧采集；请先在旧工具停止并保存，再关闭旧服务后启用手机来源。')
        app = FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
        @app.middleware('http')
        async def protect(request,call_next):
            if request.url.path != '/api/ingest' or request.method != 'POST' or request.headers.get('origin'):
                return JSONResponse({'error':'only authenticated native ingest is allowed'},status_code=403)
            auth = request.headers.get('authorization','')
            if not secrets.compare_digest(auth,'Bearer '+self.token):
                return JSONResponse({'error':'invalid pairing token'},status_code=403)
            return await call_next(request)
        @app.post('/api/ingest')
        async def ingest(request:Request):
            try:
                raw = bytearray()
                async for chunk in request.stream():
                    raw.extend(chunk)
                    if len(raw) > 1500000:
                        raise ValueError('body too large')
                import json
                body = json.loads(raw)
                return await self.ingest(body)
            except (ValueError,KeyError,TypeError) as exc:
                return JSONResponse({'error':str(exc)},status_code=400)
        self.server = uvicorn.Server(uvicorn.Config(app,log_level='warning',access_log=False))
        self.task = asyncio.create_task(self.server.serve(sockets=[sock]))
        self.capture.phone.update(enabled=True,port=self.port)
        return self.config()

    def config(self):
        try:
            addresses = sorted(set(x for x in socket.gethostbyname_ex(socket.gethostname())[2] if not x.startswith('127.')))
        except OSError:
            addresses = []
        return {'token':self.token,'port':self.port,'addresses':addresses,'version':VERSION,'event_stream_version':1,
                'encrypted':False,'warning':'仅可信局域网；HTTP未加密'}

    async def _persist(self, target, checkpoint=None):
        try:
            if checkpoint is None:
                await asyncio.to_thread(self.capture.recorder.flush)
            else:
                await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(checkpoint)),10)
            self.last_id = max(self.last_id,target)
            self.capture.phone['durable_id'] = self.last_id
        except Exception as exc:
            self.capture.recorder.error = str(exc)
            self.capture.recorder.accepting = False
            self.capture.error = '手机记录持久化失败：'+str(exc)
            self.capture.algorithm.offer(dict(control='boundary',clock_ms=self.last_phone or 0,reason='storage_failure'))
            raise

    async def _checkpoint(self, durable):
        if self.flush_task and self.flush_task.done():
            self.flush_task.result()
            self.flush_task = None
        if durable and self.flush_task:
            await self.flush_task
            self.flush_task = None
        if durable:
            await self._persist(self.received_id)
        elif self.flush_task is None and self.received_id > self.last_id and time.monotonic() >= self.next_checkpoint:
            checkpoint = self.capture.recorder.checkpoint()
            self.next_checkpoint = time.monotonic()+.1
            self.flush_task = asyncio.create_task(self._persist(self.received_id,checkpoint))

    async def ingest(self,body):
        validate(body)
        async with self.lock:
            c = self.capture
            if c.source != 'phone':
                raise ValueError('请先在电脑选择手机来源')
            if self.paused:
                raise ValueError('电脑已停止记录；请先在电脑重新开始记录或释放手机会话')
            if self.watchdog is None:
                self.watchdog = asyncio.create_task(self._watch())
            sid = body['session']; now = body['phone_now_ms']
            if sid in self.retired:
                raise ValueError('retired session; restart capture on phone')
            if self.session is not None and self.session != sid:
                raise ValueError('desktop occupied; release session first')
            if self.profile is not None and self.profile != body['profile']:
                raise ValueError('profile change requires new session')
            if self.last_phone is not None and now < self.last_phone:
                raise ValueError('phone clock regressed')
            if self.session is None:
                self.session = sid; self.profile = body['profile']
                await asyncio.wrap_future(c.algorithm.control('configure',profile=self.profile,enabled=False))
                if not c.recorder.accepting:
                    c.recorder.start({'source':'phone','phone_session':sid,'profile':self.profile})
            if c.recorder.error:
                raise ValueError(c.recorder.error)
            if self.flush_task and self.flush_task.done():
                self.flush_task.result()
                self.flush_task = None
            events = [e for e in body['events'] if e['id'] > self.received_id]
            acknowledged = self.received_id
            receipt = time.monotonic()*1000; epoch = time.time()*1000
            lag = receipt-now
            self.baselines.append(lag)
            if self.last_receive is not None and receipt-self.last_receive > 1500:
                c.algorithm.offer(dict(control='boundary',clock_ms=now,reason='network_gap'))
            if not c.recorder.put('raw',dict(type='phone_batch',source='phone',receipt_monotonic_ms=receipt,
                                           receipt_epoch_ms=epoch,envelope=body)):
                raise ValueError(c.recorder.error or '记录未运行')
            for event in events:
                # 缺口可在批内；先处理前缀再重置所有解码器，禁止跨缺口拼原始帧。
                if event['id'] != acknowledged+1:
                    await c.ingress.join()
                    for device in c.devices.values():
                        if device['source'] == 'phone':
                            device['decoder'] = __import__('backend.protocol',fromlist=['Decoder']).Decoder(self.profile)
                    c.algorithm.offer(dict(control='boundary',clock_ms=event['phone_ms'],reason='network_gap'))
                kind = event['type']; data = event['data']; foot = data.get('foot')
                if foot in ('l','r'):
                    key = 'phone:'+foot
                    d = c._device(key,data.get('name') or '手机'+('左脚' if foot == 'l' else '右脚'),self.profile,foot,data.get('address',''),source='phone')
                    connection = sid+':'+data['connection']
                    if d['connection'] != connection:
                        await c.ingress.join()
                        d['decoder'] = __import__('backend.protocol',fromlist=['Decoder']).Decoder(self.profile)
                        d['connection'] = connection
                    d['connected'] = kind != 'disconnect'
                    if kind == 'notify':
                        c.submit(key,base64.b64decode(data['bytes']),receipt,epoch,data['receipt_ms'],'phone_monotonic')
                    else:
                        await c.ingress.join()
                        c.emit(d,kind,data,receipt,epoch,event['phone_ms'],'phone_monotonic')
                        if kind == 'disconnect':
                            c.algorithm.offer(dict(control='boundary',foot=foot,clock_ms=now,reason='device_boundary'))
                elif kind == 'stop':
                    await c.ingress.join()
                    for d in c.devices.values():
                        if d['source'] == 'phone':
                            d['connected'] = False
                    c.algorithm.offer(dict(control='boundary',clock_ms=now,reason='capture_stopped'))
                elif kind == 'marker':
                    c.recorder.put('raw',{'type':'marker','source':'phone','data':data,'phone_ms':event['phone_ms']})
                acknowledged = event['id']
            await c.ingress.join()
            if c.recorder.error:
                raise ValueError(c.recorder.error)
            self.received_id = acknowledged
            self.last_phone = now; self.last_receive = receipt
            await self._checkpoint(body.get('ack_mode','durable') == 'durable')
            c.phone.update(session=sid,profile=self.profile,last_receive_ms=receipt,stale=False,
                           received_id=self.received_id,durable_id=self.last_id,queue_drops=body.get('queue_drops',0),
                           phone_queue_latest_ms=now-max((e['data']['receipt_ms'] for e in events if e['type'] == 'notify'),default=now),
                           phone_queue_oldest_ms=now-min((e['data']['receipt_ms'] for e in events if e['type'] == 'notify'),default=now),
                           network_excess_ms=lag-min(self.baselines),oneway_ms=None)
            result = c.algorithm.snapshot()['result']
            return {'ok':True,'ack_id':self.last_id,'durable_id':self.last_id,'received_id':self.received_id,
                    'ack_mode':body.get('ack_mode','durable'),'summary':'电脑已接收原始通知','result':result,
                    'as_of_phone_ms':now,'network_oneway_ms':None,'timing':'separate clocks, no one-way-delay claim'}

    async def _watch(self):
        while True:
            await asyncio.sleep(.25)
            if self.last_receive is not None and time.monotonic()*1000-self.last_receive > 1500:
                if not self.capture.phone.get('stale'):
                    self.capture.algorithm.offer(dict(control='boundary',clock_ms=self.last_phone,reason='network_gap'))
                for d in self.capture.devices.values():
                    if d['source'] == 'phone':
                        d['connected'] = False
                self.capture.phone['stale'] = True
            else:
                self.capture.phone['stale'] = False

    async def release(self):
        if self.capture.recorder.accepting:
            raise ValueError('先停止并保存记录，再释放手机会话')
        if self.flush_task:
            await asyncio.gather(self.flush_task,return_exceptions=True)
            self.flush_task = None
        if self.session:
            self.retired.append(self.session)
        self.session = self.profile = self.last_phone = self.last_receive = None
        self.last_id = self.received_id = 0
        self.next_checkpoint = 0.
        self.paused = False
        self.baselines.clear()
        for d in self.capture.devices.values():
            if d['source'] == 'phone':
                d['connected'] = False
        self.capture.phone = {'enabled':bool(self.task and not self.task.done())}
        await asyncio.wrap_future(self.capture.algorithm.control('configure',enabled=False))
        return {'ok':True}

    async def close(self):
        if self.flush_task:
            await asyncio.gather(self.flush_task,return_exceptions=True)
            self.flush_task = None
        if self.watchdog:
            self.watchdog.cancel()
            try:
                await self.watchdog
            except asyncio.CancelledError:
                pass
            self.watchdog = None
        if self.server:
            self.server.should_exit = True
        if self.task:
            await self.task
