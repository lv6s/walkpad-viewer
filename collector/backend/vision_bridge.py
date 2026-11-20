import asyncio
import os
import secrets
import sys
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import WebSocket, WebSocketDisconnect

from .vision_worker import HEADER, MAX_FRAME, VISION
from .vision_workstation import ID_MODELS, close, connect, message, send


async def receive(ws, frames):
    while True:
        packet = await ws.receive_bytes()
        if not HEADER.size < len(packet) <= MAX_FRAME:
            raise ValueError('识别帧大小无效')
        if frames.full():
            frames.get_nowait()
        frames.put_nowait(packet)


async def exchange(ws, frames, reader, writer, local=False):
    try:
        ready = await message(reader, 60.)
        await ws.send_json(ready)
        if ready['type'] != 'ready':
            return
        while True:
            packet = await frames.get()
            await send(writer, len(packet).to_bytes(4, 'big') + packet)
            result = await message(reader, 12.)
            await ws.send_json(result)
            if result['type'] != 'result':
                return
    except EOFError as exc:
        raise ValueError('本机视觉进程已退出' if local else '工作站识别连接已断开，可重新开启或切换到本机') from exc


class VisionBridge:
    def __init__(self):
        self.active = False

    async def serve(self, ws: WebSocket):
        host = ws.headers.get('host', '')
        origin = ws.headers.get('origin')
        offered = [item.strip() for item in ws.headers.get('sec-websocket-protocol', '').split(',')]
        if (host.split(':')[0] not in ('localhost', '127.0.0.1', 'testserver')
                or not origin or urlsplit(origin).netloc != host
                or len(offered) != 2 or offered[0] != 'walkpad-vision'
                or not secrets.compare_digest(offered[1], ws.app.state.token)):
            await ws.close(code=1008)
            return
        if self.active:
            await ws.accept(subprotocol='walkpad-vision')
            await ws.send_json({'type': 'error', 'message': '另一页面正在使用实时识别'})
            await ws.close()
            return
        self.active = True
        target = ws.query_params.get('target', 'local')
        id_model = ws.query_params.get('id_model', 'bytetrack')
        label = '工作站' if target == 'workstation' else '本机'
        try:
            await ws.accept(subprotocol='walkpad-vision')
            if target not in ('local', 'workstation'):
                raise ValueError('不支持的识别位置')
            if id_model not in ID_MODELS:
                raise ValueError('不支持的 ID 识别模型')
            frames = asyncio.Queue(maxsize=1)
            tasks = [asyncio.create_task(receive(ws, frames)),
                     asyncio.create_task(self.run(ws, frames, target, id_model))]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except (WebSocketDisconnect, RuntimeError):
            pass
        except (OSError, ValueError) as exc:
            error = f'{label}识别等待超时，请重新开启' if isinstance(exc, TimeoutError) else str(exc)
            with suppress(WebSocketDisconnect, RuntimeError, OSError):
                await ws.send_json({'type': 'error', 'message': error[:300]})
        finally:
            try:
                with suppress(WebSocketDisconnect, RuntimeError, OSError):
                    await ws.close()
            finally:
                self.active = False

    async def run(self, ws, frames, target, id_model):
        if target == 'workstation':
            reader, writer = await connect(VISION / 'workstation.json', id_model)
            try:
                await exchange(ws, frames, reader, writer)
            finally:
                await close(writer)
            return
        proc = await asyncio.create_subprocess_exec(
            sys.executable, '-u', '-m', 'backend.vision_worker',
            cwd=Path(__file__).resolve().parents[1],
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            env={**os.environ, 'WALKPAD_VISION_ID_MODEL': id_model},
        )
        try:
            await exchange(ws, frames, proc.stdout, proc.stdin, local=True)
        finally:
            if proc.returncode is None:
                with suppress(ProcessLookupError):
                    proc.kill()
            await proc.wait()
