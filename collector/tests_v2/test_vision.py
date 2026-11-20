import struct
import sys

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.vision_actions import LiveActions
from backend.vision_bridge import VisionBridge


def standing():
    pose = [(0., 0., 0.)] * 17
    for x, hip, knee, foot in ((.32, 11, 13, 15), (.52, 12, 14, 16)):
        pose[hip], pose[knee], pose[foot] = (x,.40,.9), (x,.55,.9), (x,.70,.9)
    return pose


def lowered():
    pose = standing()
    for x, hip, knee in ((.32, 11, 13), (.52, 12, 14)):
        pose[hip], pose[knee] = (x,.55,.9), (x+.105,.59,.9)
    return pose


def people(actions, t, *poses):
    return actions.frame(t, [(i+1,[0.,0.,1.,1.],pose) for i, pose in enumerate(poses)])


def test_two_tracks_count_only_upright_return():
    a = LiveActions()
    for i in range(15):
        last = people(a,i*.08,standing(), standing())
    assert [p['action'] for p in last] == ['站立','站立']
    for i in range(15,25):
        last = people(a,i*.08,lowered(),standing())
    assert last[0]['status'] == 'candidate' and last[0]['count'] == 0
    assert last[1]['action'] == '站立'
    for i in range(25,34):
        last = people(a,i*.08,standing(),standing())
    assert [p['count'] for p in last] == [1,0]


def test_gap_cannot_complete_repetition():
    a = LiveActions()
    for i in range(15):
        people(a,i*.08,standing())
    for i in range(15,24):
        last = people(a,i*.08,lowered())
    assert last[0]['status'] == 'candidate'
    assert people(a,2.8,standing())[0]['count'] == 0
    assert people(a,6.2,lowered())[0]['status'] == 'unknown'


def test_bridge_auth_frames_and_reconnect(monkeypatch):
    import backend.vision_bridge as bridge_module
    spawn = bridge_module.asyncio.create_subprocess_exec
    stub = ('import json, struct, sys; f=sys.stdin.buffer; '
            'import os; print(json.dumps(dict(type="ready",device=os.environ["WALKPAD_VISION_ID_MODEL"])),flush=True); '
            'exec("while size:=f.read(4):\\n p=f.read(int.from_bytes(size,\'big\')); n,t=struct.unpack_from(\'!Id\',p); print(json.dumps(dict(type=\'result\',seq=n,t=t,people=[])),flush=True)")')

    async def fake_worker(*args, **kwargs):
        return await spawn(sys.executable, '-u', '-c', stub, **kwargs)

    monkeypatch.setattr(bridge_module.asyncio, 'create_subprocess_exec', fake_worker)
    app = FastAPI()
    app.state.token = 'sample-secret'
    bridge = VisionBridge()

    @app.websocket('/ws/vision')
    async def socket(ws: WebSocket):
        await bridge.serve(ws)

    origin = {'origin':'http://testserver'}
    protocols = ['walkpad-vision', 'sample-secret']
    with TestClient(app) as client:
        for headers, sub in [({'origin':'http://elsewhere'}, protocols),(origin,['walkpad-vision','invalid'])]:
            try:
                with client.websocket_connect('/ws/vision', headers=dict(headers), subprotocols=sub):
                    raise AssertionError('unauthorized connection accepted')
            except WebSocketDisconnect as exc:
                assert exc.code == 1008
        with client.websocket_connect('/ws/vision?id_model=invalid', headers=dict(origin), subprotocols=protocols) as ws:
            assert ws.receive_json() == {'type': 'error', 'message': '不支持的 ID 识别模型'}
            try:
                ws.receive_json()
            except WebSocketDisconnect:
                pass
        for seq, query, model in ((11, '', 'bytetrack'), (12, '?id_model=reid', 'reid')):
            with client.websocket_connect('/ws/vision'+query, headers=dict(origin), subprotocols=protocols) as ws:
                assert ws.accepted_subprotocol == 'walkpad-vision'
                assert ws.receive_json() == {'type': 'ready', 'device': model}
                ws.send_bytes(struct.pack('!Id', seq, .5)+b'fake')
                assert ws.receive_json() == {'type':'result','seq':seq,'t':.5,'people':[]}
                ws.send_bytes(b'invalid')
                assert ws.receive_json()['type'] == 'error'
                try:
                    ws.receive_json()
                except WebSocketDisconnect:
                    pass


def test_workstation_bridge_routes_and_reports_disconnect(monkeypatch):
    import asyncio
    import backend.vision_bridge as bridge_module

    async def infer(reader, writer):
        try:
            writer.write(b'{"type":"ready","device":"Workstation GPU"}\n')
            size = int.from_bytes(await reader.readexactly(4), 'big')
            seq, t = struct.unpack_from('!Id', await reader.readexactly(size))
            writer.write(f'{{"type":"result","seq":{seq},"t":{t},"people":[]}}\n'.encode())
            await reader.readexactly(4)
        finally:
            writer.close()
            await writer.wait_closed()

    async def stub_connect(config, id_model):
        assert config.name == 'workstation.json'
        assert id_model == 'reid'
        async with await asyncio.start_server(infer, '127.0.0.1', 0) as server:
            return await asyncio.open_connection(*server.sockets[0].getsockname())

    async def no_local_process(*args, **kwargs):
        raise AssertionError('unexpected local process')

    monkeypatch.setattr(bridge_module, 'connect', stub_connect)
    monkeypatch.setattr(bridge_module.asyncio, 'create_subprocess_exec', no_local_process)
    app = FastAPI()
    app.state.token = 'sample-secret'
    app.websocket('/ws/vision')(VisionBridge().serve)
    with TestClient(app) as client:
        with client.websocket_connect('/ws/vision?target=workstation&id_model=reid', headers={'origin':'http://testserver'},
                                      subprotocols=['walkpad-vision', 'sample-secret']) as ws:
            assert ws.receive_json() == {'type':'ready','device':'Workstation GPU'}
            ws.send_bytes(struct.pack('!Id', 7, .5)+b'fake')
            assert ws.receive_json() == {'type':'result','seq':7,'t':.5,'people':[]}
            ws.send_bytes(struct.pack('!Id', 8, .6)+b'fake')
            assert '工作站识别连接已断开' in ws.receive_json()['message']
