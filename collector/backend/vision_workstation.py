import argparse
import asyncio
import json
import os
import ssl
import sys
from contextlib import suppress
from ipaddress import IPv4Address, IPv4Network, ip_address
from pathlib import Path

from .version import VERSION
from .vision_worker import (
    ACTION_RULES, COLLECTION_ID_MODE, HEADER, IDENTITY_MODES as ID_MODELS, MAX_FRAME, VISION,
)

DEFAULT_ENDPOINT = ('192.168.100.29', 18843)
LAN_CA = Path(__file__).with_name('vision_lan_ca.crt')
REID_ALPN = 'walkpad-vision-reid/1'
R4_ALPN = 'walkpad-vision-r4/1'
REID_R4_ALPN = 'walkpad-vision-reid-r4/1'
TRACKTRACK_ALPN = 'walkpad-vision-tracktrack-reid/1'
TRACKTRACK_R4_ALPN = 'walkpad-vision-tracktrack-reid-r4/1'
PROTOCOLS = {('bytetrack', 'v1'): None, ('reid', 'v1'): REID_ALPN,
             ('bytetrack', 'r4'): R4_ALPN, ('reid', 'r4'): REID_R4_ALPN,
             ('tracktrack-reid', 'v1'): TRACKTRACK_ALPN,
             ('tracktrack-reid', 'r4'): TRACKTRACK_R4_ALPN,
             ('bytetrack', 'r5'): 'walkpad-vision-r5/1',
             ('reid', 'r5'): 'walkpad-vision-reid-r5/1',
             ('tracktrack-reid', 'r5'): 'walkpad-vision-tracktrack-reid-r5/1',
             (COLLECTION_ID_MODE, 'r5'): 'walkpad-vision-collection-reid-r5/1'}


class WorkstationError(ValueError):
    pass


def selection(protocol):
    """把协商出的 ALPN 还原成 (ID 模型, 动作规则)。"""
    for pair, name in PROTOCOLS.items():
        if name == protocol:
            return pair
    return ('bytetrack', 'v1')


async def connect(config_path, id_model='bytetrack', action_rules='v1'):
    if id_model not in ID_MODELS:
        raise WorkstationError('不支持的 ID 识别模型')
    if (id_model, action_rules) not in PROTOCOLS:
        raise WorkstationError('该 ID 模型不支持所选动作规则')
    protocol = PROTOCOLS[(id_model, action_rules)]
    try:
        try:
            config = json.loads(config_path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            host, port = DEFAULT_ENDPOINT
            mutual_tls = False
        else:
            host, port = config['host'], config['port']
            mutual_tls = config.get('client_auth', (host, port) != DEFAULT_ENDPOINT)
        if (not isinstance(host, str) or not host or type(port) is not int
                or not 0 < port < 65536 or type(mutual_tls) is not bool):
            raise ValueError('invalid endpoint')
        tls = config_path.parent / 'tls'
        ca = tls / 'ca.crt' if mutual_tls or (host, port) != DEFAULT_ENDPOINT else LAN_CA
        context = ssl.create_default_context(cafile=str(ca))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if protocol:
            context.set_alpn_protocols([protocol])
        if mutual_tls:
            context.load_cert_chain(tls / 'client.crt', tls / 'client.key')
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise WorkstationError('工作站地址或证书配置无效') from exc
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port, ssl=context), 5.)
    except ssl.SSLError as exc:
        raise WorkstationError('工作站证书验证失败，未发送识别画面') from exc
    except (OSError, TimeoutError) as exc:
        raise WorkstationError('无法连接工作站，请检查公司局域网或切换到本机') from exc
    if protocol and writer.get_extra_info('ssl_object').selected_alpn_protocol() != protocol:
        await close(writer)
        raise WorkstationError('工作站尚未支持所选识别选项，请更新工作站服务或切换选项')
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


def service_context(tls, *, require_client_cert=True):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.set_alpn_protocols([name for name in PROTOCOLS.values() if name])
    context.load_cert_chain(tls / 'server.crt', tls / 'server.key')
    if require_client_cert:
        context.load_verify_locations(cafile=str(tls / 'ca.crt'))
        context.verify_mode = ssl.CERT_REQUIRED
    return context


def lan_network(host, cidr):
    network = IPv4Network(cidr)
    private = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
    if IPv4Address(host) not in network or not any(network.subnet_of(IPv4Network(n)) for n in private):
        raise ValueError('免凭证接入必须绑定到指定私有 IPv4 网段内的地址')
    return network


class VisionService:
    def __init__(self, network=None):
        self.active = False
        self.network = network

    async def serve(self, reader, writer):
        if self.network is not None:
            peer = writer.get_extra_info('peername')
            if not peer or ip_address(peer[0]) not in self.network:
                try:
                    await encode(writer, {'type': 'error', 'message': '不在允许的采集局域网网段'})
                finally:
                    await close(writer)
                return
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
            id_model, action_rules = selection(protocol)
            proc = await asyncio.create_subprocess_exec(
                sys.executable, '-u', '-m', 'backend.vision_worker',
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                env={**os.environ, 'CUDA_VISIBLE_DEVICES': str(gpu), 'WALKPAD_VISION_REQUIRE_GPU': '1',
                     'WALKPAD_VISION_ID_MODEL': id_model, 'WALKPAD_VISION_ACTION_RULES': action_rules},
            )
            ready = await message(proc.stdout, 55.)
            if ready.get('type') == 'ready':
                ready['device'] = f'工作站 GPU {gpu}'
                ready['server_version'] = VERSION
            await encode(writer, ready)
            if ready.get('type') != 'ready':
                return
            while True:
                length = int.from_bytes(await asyncio.wait_for(reader.readexactly(4), 30.), 'big')
                if length == 0 and id_model == COLLECTION_ID_MODE:
                    await send(proc.stdin, bytes(4))
                    await encode(writer, await message(proc.stdout, 10.))
                    return
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


async def run(host, port, network=None):
    service = VisionService(network)
    context = service_context(VISION / 'tls', require_client_cert=network is None)
    server = await asyncio.start_server(service.serve, host, port, ssl=context,
                                        ssl_handshake_timeout=5., ssl_shutdown_timeout=2.)
    mode = f'LAN TLS, {network}' if network is not None else 'mutual TLS'
    print(f'Walkpad Vision listening on {host}:{port} ({mode})', flush=True)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=DEFAULT_ENDPOINT[1])
    parser.add_argument('--allow-lan', metavar='CIDR', help='该私有 IPv4 网段无需客户端证书')
    args = parser.parse_args()
    try:
        network = lan_network(args.host, args.allow_lan) if args.allow_lan else None
    except ValueError as exc:
        parser.error(str(exc))
    asyncio.run(run(args.host, args.port, network))
