import argparse
import asyncio
import json
import os
import ssl
import sys
from contextlib import suppress
from pathlib import Path

from .vision_worker import HEADER, MAX_FRAME, VISION


ID_MODELS = ('bytetrack', 'reid')
REID_ALPN = 'walkpad-vision-reid/1'


class WorkstationError(ValueError):
    pass


async def connect(config_path, id_model='bytetrack'):
    if id_model not in ID_MODELS:
        raise WorkstationError('不支持的 ID 识别模型')
    try:
        config = json.loads(config_path.read_text(encoding='utf-8'))
        context = ssl.create_default_context(cafile=str(config_path.parent / 'tls' / 'ca.crt'))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if id_model == 'reid':
            context.set_alpn_protocols([REID_ALPN])
        tls = config_path.parent / 'tls'
        context.load_cert_chain(tls / 'client.crt', tls / 'client.key')
        host, port = config['host'], config['port']
        if not isinstance(host, str) or not host or type(port) is not int or not 0 < port < 65536:
            raise ValueError('invalid endpoint')
    except FileNotFoundError as exc:
        raise WorkstationError('尚未配置工作站识别；可切换到本机') from exc
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise WorkstationError('工作站地址或证书配置无效') from exc
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port, ssl=context), 5.)
    except ssl.SSLError as exc:
        raise WorkstationError('工作站证书验证失败，未发送识别画面') from exc
    except (OSError, TimeoutError) as exc:
        raise WorkstationError('无法连接工作站，请检查公司局域网或切换到本机') from exc
    if id_model == 'reid' and writer.get_extra_info('ssl_object').selected_alpn_protocol() != REID_ALPN:
        await close(writer)
        raise WorkstationError('工作站尚未支持人体重识别，请切换到原版或本机')
    return reader, writer


async def message(reader, timeout):
    line = await asyncio.wait_for(reader.readline(), timeout)
    if not line:
        raise EOFError
    return json.loads(line)


async def send(writer, data):
    writer.write(data)
    await asyncio.wait_for(writer.drain(), 5.)


async def close(writer):
    writer.close()
    with suppress(OSError, TimeoutError):
        await asyncio.wait_for(writer.wait_closed(), 2.)


async def encode(writer, payload):
    await send(writer, (json.dumps(payload, ensure_ascii=True, allow_nan=False) + '\n').encode('ascii'))


async def available_gpu():
    proc = await asyncio.create_subprocess_exec(
        'nvidia-smi', '--query-gpu=index,memory.used,utilization.gpu', '--format=csv,noheader,nounits',
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), 3.)
    finally:
        if proc.returncode is None:
            with suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
    if proc.returncode:
        raise OSError('nvidia-smi failed')
    cards = [tuple(map(int, line.split(','))) for line in out.decode('ascii').splitlines()]
    idle = [(used, index) for index, used, utilization in cards if used < 512 and utilization < 10]
    return min(idle)[1] if idle else None


def service_context(tls):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.set_alpn_protocols([REID_ALPN])
    context.load_cert_chain(tls / 'server.crt', tls / 'server.key')
    context.load_verify_locations(cafile=str(tls / 'ca.crt'))
    context.verify_mode = ssl.CERT_REQUIRED
    return context


class VisionService:
    def __init__(self):
        self.active = False

    async def serve(self, reader, writer):
        if self.active:
            try:
                await encode(writer, {'type': 'error', 'message': '工作站已有一个实时识别会话'})
            finally:
                await close(writer)
            return
        self.active = True
        proc = None
        try:
            gpu = await available_gpu()
            if gpu is None:
                await encode(writer, {'type': 'error', 'message': '工作站暂无空闲 GPU，请稍后重试或切换到本机'})
                return
            protocol = writer.get_extra_info('ssl_object').selected_alpn_protocol()
            proc = await asyncio.create_subprocess_exec(
                sys.executable, '-u', '-m', 'backend.vision_worker',
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                env={**os.environ, 'CUDA_VISIBLE_DEVICES': str(gpu), 'WALKPAD_VISION_REQUIRE_GPU': '1',
                     'WALKPAD_VISION_ID_MODEL': 'reid' if protocol == REID_ALPN else 'bytetrack'},
            )
            ready = await message(proc.stdout, 55.)
            if ready.get('type') == 'ready':
                ready['device'] = f'工作站 GPU {gpu}'
            await encode(writer, ready)
            if ready.get('type') != 'ready':
                return
            while True:
                length = int.from_bytes(await asyncio.wait_for(reader.readexactly(4), 30.), 'big')
                if not HEADER.size < length <= MAX_FRAME:
                    raise ValueError('识别帧大小无效')
                packet = await asyncio.wait_for(reader.readexactly(length), 5.)
                await send(proc.stdin, length.to_bytes(4, 'big') + packet)
                result = await message(proc.stdout, 10.)
                await encode(writer, result)
                if result.get('type') != 'result':
                    return
        except (EOFError, OSError, ValueError) as exc:
            if not isinstance(exc, asyncio.IncompleteReadError):
                if not isinstance(exc, ConnectionError):
                    print(f'Vision session: {type(exc).__name__}: {exc}', file=sys.stderr, flush=True)
                with suppress(OSError):
                    await encode(writer, {'type': 'error', 'message': '工作站识别会话中断，请重新开启'})
        finally:
            if proc is not None:
                if proc.returncode is None:
                    with suppress(ProcessLookupError):
                        proc.kill()
                await proc.wait()
            self.active = False
            await close(writer)


async def run(host, port):
    service = VisionService()
    server = await asyncio.start_server(service.serve, host, port, ssl=service_context(VISION / 'tls'),
                                        ssl_handshake_timeout=5., ssl_shutdown_timeout=2.)
    print(f'Walkpad Vision listening on {host}:{port} (mutual TLS)', flush=True)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=18843)
    args = parser.parse_args()
    asyncio.run(run(args.host, args.port))
