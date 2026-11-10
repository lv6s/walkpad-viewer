"""本地静态服务 + 鞋垫状态推断接口。

静态服务与 python -m http.server 等价，但禁止浏览器缓存：python 自带的
http.server 不发 Cache-Control，Chrome 会按启发式缓存直接吃旧 JS，
改了 js 页面还在跑旧代码（报错行号对不上就是这么来的）。

推断接口（POST，JSON）：
  /act/info    读模型与契约信息
  /act/reset   新建会话（fs_left / fs_right / mode，默认 online-v2）
  /act/step    online-v2 事件含设备时间、接收时间、序号和分段；另传 t_end / now_ms

改成多线程是必须的：推断占住一个连接时，静态文件和下一次决策不能被堵住。
"""

import http.server
import json
import socket
import socketserver
import sys
import threading
import traceback
import urllib.request
import urllib.error
import subprocess
import atexit
import time

from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent.parent / 'walkpad_repo' / 'android_algorithm_lab' / 'desktop'

HERE = Path(__file__).resolve().parent
PORT_FILE = HERE / '_port.txt'
ACT_DIR = HERE / 'activity'
MAX_BODY = 2 << 20

_engine = None
_engine_err = None
_wt_engine = None
_lock = threading.Lock()


def engine(source='insole'):
    """按需装载：静态页面不该因为 onnxruntime 缺失而打不开。"""
    global _engine, _engine_err, _wt_engine
    if source not in ('insole', 'wt'):
        raise ValueError('unknown activity source')
    if source == 'wt':
        if str(ACT_DIR) not in sys.path:
            sys.path.insert(0, str(ACT_DIR))
        if _wt_engine is None:
            from wt_engine import WTEngine
            _wt_engine = WTEngine(threads=1)
        return _wt_engine
    if _engine is not None:
        return _engine
    if _engine_err is not None:
        raise RuntimeError(_engine_err)
    try:
        if str(ACT_DIR) not in sys.path:
            sys.path.insert(0, str(ACT_DIR))
        from act_engine import ActEngine
        _engine = ActEngine(threads=1)
        print('activity engine ready: %s' % _engine.info()['onnx_sha256'][:16], flush=True)
    except Exception as exc:
        _engine_err = '%s: %s' % (type(exc).__name__, exc)
        raise RuntimeError(_engine_err)
    return _engine


BRIDGE_URL = 'http://127.0.0.1:8766'
_bridge_process = None
_bridge_guard = threading.Lock()


def ensure_bridge():
    global _bridge_process
    with _bridge_guard:
        try:
            with urllib.request.urlopen(BRIDGE_URL + '/api/config', timeout=1) as r:
                config = json.load(r)
                if config.get('event_stream_version') == 1:
                    return
                if config.get('version'):
                    raise RuntimeError('8766正在运行旧版工作台：先停止并导出手机记录，关闭旧工作台控制台后再重开IMU入口')
        except (OSError, ValueError):
            pass
        if _bridge_process is None or _bridge_process.poll() is not None:
            import importlib.util
            interpreter = sys.executable
            if importlib.util.find_spec('onnxruntime') is None:
                candidate = Path(sys.executable).parent / 'envs' / 'agent-shared' / 'python.exe'
                if candidate.is_file():
                    interpreter = str(candidate)
            _bridge_process = subprocess.Popen([interpreter, str(BRIDGE_DIR / 'server.py')],
                                              cwd=str(BRIDGE_DIR))
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(BRIDGE_URL + '/api/config', timeout=.5):
                    return
            except OSError:
                if _bridge_process.poll() is not None:
                    break
                time.sleep(.1)
        raise RuntimeError('手机桥接服务未就绪，请检查8766端口和运行环境')


def close_owned_bridge():
    if _bridge_process is not None and _bridge_process.poll() is None:
        _bridge_process.terminate()


atexit.register(close_owned_bridge)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    # ------------------------------------------------------------- helpers
    def _json(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            raise ValueError('bad Content-Length')
        if n < 0 or n > MAX_BODY:
            raise ValueError('body too large')
        if n == 0:
            return {}
        return json.loads(self.rfile.read(n) or b'{}')

    def _bridge(self):
        route = self.path[len('/phone'):]
        allowed = ('/api/config', '/api/status', '/api/events', '/api/export', '/api/release')
        if route.split('?')[0] not in allowed:
            self._json(404, {'error': 'not_found'})
            return
        if self.command == 'POST' and route != '/api/release':
            self._json(405, {'error': 'method_not_allowed'})
            return
        if self.command == 'POST' and self.headers.get('X-Walkpad-Control') != '1':
            self._json(403, {'error': 'control_header_required'})
            return
        try:
            ensure_bridge()
            req = urllib.request.Request(BRIDGE_URL + route,
                                         method=self.command,
                                         headers={'X-Walkpad-Control': '1'})
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read()
                self.send_response(200)
                self.send_header('Content-Type', r.headers.get('Content-Type', 'application/json'))
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        except urllib.error.HTTPError as exc:
            self._json(exc.code, {'error': exc.read().decode('utf-8', 'replace')[:300]})
        except (OSError, RuntimeError) as exc:
            self._json(503, {'error': str(exc)})

    def do_GET(self):
        if self.path.startswith('/phone/'):
            return self._bridge()
        super().do_GET()

    # --------------------------------------------------------------- routes
    def do_POST(self):
        if self.path.startswith('/phone/'):
            return self._bridge()
        route = self.path.split('?')[0]
        if route not in ('/act/info', '/act/reset', '/act/step'):
            self._json(404, {'ok': False, 'reason': 'not_found'})
            return
        try:
            body = self._body()
        except Exception as exc:
            self._json(400, {'ok': False, 'reason': 'bad_body', 'detail': str(exc)})
            return
        try:
            with _lock:
                eng = engine(body.get('source', 'insole'))
                if route == '/act/info':
                    out = eng.info()
                elif route == '/act/reset':
                    default_fs = 50.0 if body.get('source') == 'wt' else 51.2
                    out = eng.reset(float(body.get('fs_left', default_fs)),
                                    float(body.get('fs_right', default_fs)),
                                    mode=body.get('mode', 'online-v2'))
                else:
                    if 't_end' not in body:
                        raise ValueError('t_end is required')
                    out = eng.step(body.get('events') or [], float(body['t_end']),
                                   now_ms=body.get('now_ms'))
        except RuntimeError as exc:            # 引擎装不上（缺 onnxruntime / 模型损坏）
            self._json(503, {'ok': False, 'reason': 'engine_unavailable', 'detail': str(exc)})
            return
        except Exception as exc:
            traceback.print_exc()
            self._json(400, {'ok': False, 'reason': 'bad_request', 'detail': str(exc)})
            return
        self._json(200, out)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def pick_port(start=8765):
    for p in range(start, start + 20):
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if s.connect_ex(('127.0.0.1', p)) != 0:
                return p
    return start


def main():
    if '--legacy' not in sys.argv:
        result = subprocess.run([sys.executable,str(HERE/'launch_workbench.py'),'--no-open'],
                                cwd=HERE,capture_output=True,text=True,encoding='utf-8')
        if result.returncode:
            print(result.stderr or result.stdout,flush=True)
            raise SystemExit(result.returncode)
        from urllib.parse import urlsplit
        port = urlsplit(result.stdout.strip().splitlines()[-1]).port
        PORT_FILE.write_text(str(port),encoding='ascii')
        print(result.stdout.strip(),flush=True)
        return
    positional = [x for x in sys.argv[1:] if x != '--legacy']
    port = pick_port(int(positional[0]) if positional else 8765)
    with Server(('127.0.0.1', port), Handler) as httpd:
        PORT_FILE.write_text(str(port), encoding='ascii')
        print('http://127.0.0.1:%d/wt901ble_live.html' % port, flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()
