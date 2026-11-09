"""Isolated HTTP and headless Edge integration runner; no BLE hardware emulation claim."""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import serve_page


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--fixture',required=True);ap.add_argument('--out',required=True)
    args=ap.parse_args()
    server=serve_page.Server(('127.0.0.1',0),serve_page.Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}'
    browser=None
    profile=ROOT/'test'/'wt_browser_profile'
    try:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        exe='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
        browser=subprocess.Popen([exe,'--headless=new','--disable-gpu',f'--remote-debugging-port={port}',f'--user-data-dir={profile}',base+'/wt901ble_live.html?view=act'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+20
        while True:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version',timeout=1).read();break
            except OSError:
                if time.monotonic()>deadline:raise TimeoutError('Edge startup')
        env=dict(os.environ,CDP_PORT=str(port),WT_FIXTURE=args.fixture)
        runs=[]
        for script in ['check_activity_live.js','check_wt_live.js']:
            run=subprocess.run(['node',str(ROOT/'test'/script)],env=env,capture_output=True,text=True,encoding='utf-8',timeout=90)
            print(run.stdout,flush=True)
            if run.returncode:raise RuntimeError(run.stderr)
            runs.append(dict(script=script,stdout=run.stdout))
        Path(args.out).write_text(json.dumps(dict(passed=True,runs=runs,hardware_ble_tested=False),indent=2),encoding='utf-8')
    finally:
        if browser is not None:
            subprocess.run(['taskkill','/PID',str(browser.pid),'/T','/F'],capture_output=True)
            browser.wait(timeout=10)
        server.shutdown();server.server_close()
if __name__=='__main__':main()
