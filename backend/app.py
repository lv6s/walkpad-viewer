import argparse
import asyncio
import json
import os
import secrets
import socket
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from .capture import Capture
from .exports import export_standard, export_txt
from .phone import Phone

ROOT = Path(__file__).resolve().parents[1]


class Command(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: str
    device_id: str | None = None
    profile: str | None = None
    kind: str | None = None
    foot: str | None = None
    placement: str | None = None
    placement_label: str | None = None
    address: str | None = None
    source: str | None = None
    session_id: str | None = None
    enabled: bool | None = None
    value: int | None = None
    link: str = 'v2'
    topology: str | None = None
    bias_action: str | None = None
    bias_key: str | None = None
    speed: float = 1.


def create_app(root=ROOT,demo=False,phone_port=8766,debug=False,idle_exit=8):
    root = Path(root)

    def forget_state():
        state = ROOT/'runtime/server.json'
        try:
            if state.is_file() and json.loads(state.read_text(encoding='utf-8')).get('pid') == os.getpid():
                state.unlink()
        except (OSError,ValueError,AttributeError):
            pass

    def request_stop(delay=.4):
        server = getattr(app.state,'uvicorn',None)
        if server is None:
            return {'ok':True,'pid':os.getpid(),'graceful':False}
        asyncio.get_running_loop().call_later(delay,setattr,server,'should_exit',True)
        def watchdog():
            time.sleep(30)
            os._exit(0)
        threading.Thread(target=watchdog,daemon=True).start()
        return {'ok':True,'pid':os.getpid(),'graceful':True}

    def cancel_idle():
        task = app.state.idle_task
        app.state.idle_task = None
        if task and not task.done():
            task.cancel()

    async def wait_idle_exit():
        try:
            await asyncio.sleep(idle_exit)
        except asyncio.CancelledError:
            return
        app.state.idle_task = None
        if app.state.clients:
            return
        if app.state.capture.recorder.accepting:
            return
        request_stop(.2)

    def schedule_idle():
        if not idle_exit or not app.state.idle_armed or app.state.clients:
            return
        cancel_idle()
        app.state.idle_task = asyncio.create_task(wait_idle_exit())

    @asynccontextmanager
    async def lifespan(app):
        capture = Capture(root,demo)
        capture.debug = debug
        app.state.capture = capture
        app.state.phone = Phone(capture,phone_port)
        app.state.token = secrets.token_urlsafe(32)
        app.state.clients = 0
        app.state.idle_armed = False
        app.state.idle_task = None
        await capture.start()
        try:
            yield
        finally:
            cancel_idle()
            await app.state.phone.close()
            await capture.close()
            forget_state()
    app = FastAPI(lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
    @app.middleware('http')
    async def security(request,call_next):
        host = request.headers.get('host','').split(':')[0]
        if host not in ('127.0.0.1','localhost','testserver'):
            return JSONResponse({'error':'invalid host'},status_code=403)
        if request.method not in ('GET','HEAD','OPTIONS'):
            origin = request.headers.get('origin')
            if origin and urlsplit(origin).netloc != request.headers.get('host'):
                return JSONResponse({'error':'cross-origin control denied'},status_code=403)
            if not secrets.compare_digest(request.headers.get('x-walkpad-token',''),app.state.token):
                return JSONResponse({'error':'control token required'},status_code=403)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    @app.get('/api/config')
    async def config():
        return {'version':'2.0.0','control_token':app.state.token,'demo_allowed':demo,'phone_port':phone_port,'idle_exit':idle_exit}

    @app.get('/api/status')
    async def status():
        return app.state.capture.snapshot()

    @app.post('/api/control')
    async def control(body:Command):
        async with app.state.phone.lock:
            return await apply_control(body)

    async def apply_control(body:Command):
        c = app.state.capture
        try:
            action = body.action
            if action == 'scan':
                return {'devices':await c.scan()}
            if action == 'connect':
                if not body.address or body.profile not in ('wt','insole'):
                    raise ValueError('请选择设备与协议')
                return await c.connect(body.address,body.profile,body.placement or body.foot,label=body.placement_label,kind=body.kind)
            if action == 'disconnect':
                return await c.disconnect(body.device_id)
            if action == 'forget':
                if not body.device_id:
                    raise ValueError('未指定要移除的设备')
                return c.forget(body.device_id)
            if action == 'disconnect_all':
                for key in list(c.devices):
                    await c.disconnect(key)
                await c.stop_virtual()
                return {'ok':True}
            if action == 'reconnect':
                result = []
                for d in list(c.devices.values()):
                    if d['source'] == 'direct' and not d['connected']:
                        try:
                            result.append(await c.connect(d['address'],d['profile'],d['placement'],d['id'],d['placement_label']))
                        except Exception as exc:
                            c.log(str(exc),'warning')
                return {'devices':result}
            if action == 'source':
                if c.source == 'phone' and body.source != 'phone' and app.state.phone.session:
                    raise ValueError('先停止记录并释放手机会话，再切换来源')
                if body.source == 'phone':
                    if c.recorder.accepting:
                        raise ValueError('先停止记录再切换来源')
                    await app.state.phone.enable()
                return await c.source_change(body.source)
            if action == 'record_start':
                result = await c.record_start()
                if c.source == 'phone':
                    app.state.phone.paused = False
                return result
            if action == 'record_stop':
                if c.source == 'phone':
                    app.state.phone.paused = True
                return await c.record_stop()
            if action == 'algorithm':
                if body.profile not in ('wt','insole') or body.enabled is None:
                    raise ValueError('invalid algorithm configuration')
                return await asyncio.wrap_future(c.algorithm.control('configure',profile=body.profile,enabled=body.enabled))
            if action in ('velocity_start','velocity_stop'):
                return c.velocity_control(body.device_id, action == 'velocity_start')
            if action == 'bias':
                key = body.bias_key or body.foot
                device = next((d for d in c.devices.values() if d['bias_key'] == key and d['profile'] == 'insole'), None)
                if device is None or body.bias_action not in ('manual', 'dynamic', 'reset_bias', 'start_calibration', 'cancel_calibration'):
                    raise ValueError('invalid bias action')
                if c.source == 'phone' and app.state.phone.last_phone is not None:
                    clock = app.state.phone.last_phone
                else:
                    clock = time.monotonic()*1000
                return await asyncio.wrap_future(c.algorithm.control('bias', bias_key=key, foot=device['foot'], action=body.bias_action, clock_ms=clock))
            if action == 'topology':
                if body.topology not in ('v1','v2') or c.recorder.accepting:
                    raise ValueError('拓扑只能在未记录时切换')
                c.devices[body.device_id]['topology'] = body.topology
                return {'ok':True}
            if action in ('read_state','set_format','info','battery','version'):
                return await c.device_command(body.device_id,action,body.value,body.link)
            if action == 'phone_config':
                return app.state.phone.config()
            if action == 'phone_release':
                return await app.state.phone.release()
            if action == 'demo':
                return await c.demo(body.profile or 'insole')
            if action == 'replay':
                return await c.replay(body.session_id,body.speed)
            if action == 'clear_display':
                c.history.clear()
                for d in c.devices.values():
                    d['samples'].clear()
                return {'ok':True}
            if action == 'shutdown':
                if c.recorder.accepting:
                    await c.record_stop()
                return request_stop()
            raise ValueError('unknown action')
        except (ValueError,KeyError) as exc:
            raise HTTPException(400,str(exc))
        except Exception as exc:
            c.log(str(exc),'error')
            raise HTTPException(503,str(exc))

    @app.get('/api/sessions')
    async def sessions():
        return app.state.capture.recorder.sessions()

    def finished_directory(sid):
        recorder = app.state.capture.recorder
        if sid == recorder.session_id and (recorder.accepting or recorder.thread and recorder.thread.is_alive()):
            raise ValueError('先停止记录并等待写盘完成')
        return recorder.directory(sid)

    @app.get('/api/sessions/{sid}/export')
    async def export(sid:str,format:str='zip'):
        try:
            path = finished_directory(sid)
            if format == 'txt':
                target = await asyncio.to_thread(export_txt,path)
            elif format == 'parquet':
                target = await asyncio.to_thread(export_standard,path)
            elif format == 'zip':
                target = await asyncio.to_thread(app.state.capture.recorder.export,sid)
            else:
                raise ValueError('unknown export format')
            return FileResponse(target,filename=target.name)
        except ValueError as exc:
            raise HTTPException(400,str(exc))

    @app.post('/api/sessions/{sid}/video/{video_id}/{index}')
    async def video(sid:str,video_id:str,index:int,request:Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 24*1024*1024:
                raise HTTPException(413,'录像块过大')
        try:
            return await asyncio.to_thread(app.state.capture.recorder.append_video,sid,video_id,index,
                                            request.headers.get('content-type','video/webm'),bytes(raw))
        except ValueError as exc:
            raise HTTPException(400,str(exc))

    @app.websocket('/ws')
    async def websocket(ws:WebSocket):
        host = ws.headers.get('host','')
        origin = ws.headers.get('origin')
        if host.split(':')[0] not in ('127.0.0.1','localhost','testserver') or origin and urlsplit(origin).netloc != host:
            await ws.close(code=1008)
            return
        if not secrets.compare_digest(ws.query_params.get('token',''),app.state.token):
            await ws.close(code=1008)
            return
        await ws.accept()
        app.state.clients += 1
        app.state.idle_armed = True
        cancel_idle()
        cursor = 0
        try:
            while True:
                update = app.state.capture.stream(cursor)
                cursor = update['cursor']
                await asyncio.wait_for(ws.send_json(update),3)
                await asyncio.sleep(.05)
        except (WebSocketDisconnect,asyncio.TimeoutError,RuntimeError):
            pass
        finally:
            app.state.clients -= 1
            schedule_idle()

    @app.get('/wt901ble_live.html')
    async def old_entry():
        return RedirectResponse('/')

    @app.get('/legacy')
    async def legacy():
        return JSONResponse({'message':'完整旧版请运行工具目录 launch_workbench.py --legacy；先停止保存并断开新版设备。'},status_code=409)

    for directory in ('js','css','activity'):
        app.mount('/'+directory,StaticFiles(directory=ROOT/directory),name='legacy-'+directory)

    @app.get('/parquet_writer.js')
    async def legacy_writer():
        return FileResponse(ROOT/'parquet_writer.js')

    @app.get('/favicon.ico')
    async def icon():
        from fastapi import Response
        return Response(status_code=204)

    dist = ROOT/'frontend/dist'
    if (dist/'assets').is_dir():
        app.mount('/assets',StaticFiles(directory=dist/'assets'),name='assets')

    @app.get('/')
    async def index():
        if not (dist/'index.html').is_file():
            raise HTTPException(503,'前端尚未构建')
        return FileResponse(dist/'index.html')
    return app


def main():
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8875)
    parser.add_argument('--phone-port',type=int,default=8766)
    parser.add_argument('--demo',action='store_true')
    parser.add_argument('--debug',action='store_true')
    parser.add_argument('--data-root',type=Path,default=ROOT)
    parser.add_argument('--idle-exit',type=int,default=8,help='浏览器全部断开后退出后台的宽限秒数，0 表示不自动退出')
    args = parser.parse_args()
    app = create_app(args.data_root,args.demo,args.phone_port,args.debug,args.idle_exit)
    config = uvicorn.Config(app,host='127.0.0.1',port=args.port,log_level='info',access_log=not args.debug,
                            timeout_graceful_shutdown=15)
    app.state.uvicorn = uvicorn.Server(config)
    app.state.uvicorn.run()


if __name__ == '__main__':
    main()
