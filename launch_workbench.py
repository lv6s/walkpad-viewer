import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT/'runtime'
STATE = RUNTIME/'server.json'


def probe(port):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/api/config' % port,timeout=.5) as response:
            result = json.load(response)
            return result.get('version') == '2.0.0' and bool(result.get('control_token')) and not result.get('demo_allowed')
    except (OSError,ValueError):
        return False


def interpreter():
    candidates = [ROOT/'runtime/python.txt',ROOT/'python.txt']
    paths = []
    for file in candidates:
        if file.is_file():
            paths.append(file.read_text(encoding='utf-8').strip())
    paths.extend([str(Path(sys.executable).parent/'envs/agent-shared/python.exe'),
                  r'C:\Python\conda\envs\agent-shared\python.exe',sys.executable])
    for path in dict.fromkeys(paths):
        if not Path(path).is_file():
            continue
        check = subprocess.run([path,'-c','import fastapi,uvicorn,bleak,pyarrow,numpy,onnxruntime,websockets'],
                               stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                               creationflags=0x08000000 if os.name == 'nt' else 0)
        if check.returncode == 0:
            return path
    raise RuntimeError('未找到具备工作台依赖的Python环境，请检查 runtime/python.txt')


def legacy(no_open=False):
    import http.client
    def available(port):
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/wt901ble_live.html' % port,timeout=.5) as response:
                return response.status == 200 and 'WT901BLE 多设备实时采集' in response.read(30000).decode('utf-8',errors='replace')
        except (OSError,ValueError,http.client.HTTPException):
            return False
    state = RUNTIME/'legacy.json'
    if state.is_file():
        try:
            port = int(json.loads(state.read_text(encoding='utf-8'))['port'])
            if available(port):
                url = 'http://127.0.0.1:%d/wt901ble_live.html' % port
                print(url)
                if not no_open:
                    webbrowser.open(url)
                return
        except (OSError,ValueError,KeyError):
            pass
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        port = sock.getsockname()[1]
    with (RUNTIME/'legacy.log').open('ab') as log:
        process = subprocess.Popen([interpreter(),str(ROOT/'serve_page.py'),'--legacy',str(port)],cwd=ROOT,
                                   stdin=subprocess.DEVNULL,stdout=log,stderr=log,
                                   creationflags=0x08000000 if os.name == 'nt' else 0)
    deadline = time.monotonic()+20
    while time.monotonic() < deadline:
        if available(port):
            state.write_text(json.dumps({'port':port,'pid':process.pid}),encoding='utf-8')
            url = 'http://127.0.0.1:%d/wt901ble_live.html' % port
            print(url)
            if not no_open:
                webbrowser.open(url)
            return
        if process.poll() is not None:
            break
        time.sleep(.15)
    raise RuntimeError('旧版后台未就绪，请查看 runtime/legacy.log')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--legacy',action='store_true')
    parser.add_argument('--no-open',action='store_true')
    args = parser.parse_args()
    RUNTIME.mkdir(exist_ok=True)
    if args.legacy:
        legacy(args.no_open)
        return
    if not (ROOT/'frontend/dist/index.html').is_file():
        raise RuntimeError('工作台静态文件不存在，请先构建frontend')
    lock = None
    try:
        import msvcrt
        lock = (RUNTIME/'launcher.lock').open('a+b')
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        msvcrt.locking(lock.fileno(),msvcrt.LK_LOCK,1)
    except ImportError:
        pass
    try:
        port = None
        if STATE.exists():
            try:
                candidate = int(json.loads(STATE.read_text(encoding='utf-8'))['port'])
                if probe(candidate):
                    port = candidate
            except (OSError,ValueError,KeyError):
                pass
        if port is None:
            for candidate in range(8875,8895):
                if probe(candidate):
                    port = candidate
                    break
                try:
                    with socket.socket() as sock:
                        sock.bind(('127.0.0.1',candidate))
                    port = candidate
                    break
                except OSError:
                    continue
            if port is None:
                raise RuntimeError('没有可用本地端口')
        if port is not None and not probe(port):
            log = (RUNTIME/'server.log').open('ab')
            process = subprocess.Popen([interpreter(),'-m','backend.app','--port',str(port)],cwd=ROOT,
                                       stdin=subprocess.DEVNULL,stdout=log,stderr=log,
                                       creationflags=0x08000000 if os.name == 'nt' else 0)
            log.close()
            deadline = time.monotonic()+25
            while time.monotonic() < deadline:
                if probe(port):
                    break
                if process.poll() is not None:
                    raise RuntimeError('后台启动失败，请查看 '+str(RUNTIME/'server.log'))
                time.sleep(.15)
            else:
                raise RuntimeError('后台启动尚未就绪，请查看 '+str(RUNTIME/'server.log'))
            STATE.write_text(json.dumps({'port':port,'pid':process.pid,'version':'2.0.0'}),encoding='utf-8')
        url = 'http://127.0.0.1:%d/' % port
        print(url)
        if not args.no_open:
            webbrowser.open(url)
    finally:
        if lock:
            lock.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('启动失败：'+str(exc),file=sys.stderr)
        sys.exit(1)
