"""Isolated HTTP/browser integration; never interrupts a live collector."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT.parent / 'walkpad_repo/android_algorithm_lab/desktop'
sys.path.insert(0, str(BRIDGE))
from server import Server, Handler, Workbench

spec = importlib.util.spec_from_file_location('imu_serve_test', ROOT/'serve_page.py')
imu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imu)


def run():
    with tempfile.TemporaryDirectory(prefix='imu_phone_test_') as tmp:
        bench = Workbench(directory=tmp)
        receiver = Server(('127.0.0.1', 0), Handler)
        receiver.workbench = bench
        imu.BRIDGE_URL = 'http://127.0.0.1:' + str(receiver.server_port)
        page = imu.Server(('127.0.0.1', 0), imu.Handler)
        threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (receiver, page)]
        for t in threads:
            t.start()
        try:
            env = dict(os.environ)
            env.setdefault('PLAYWRIGHT_CORE_PATH', str(ROOT.parent/'walkpad_repo/squat_pressure/web/node_modules/playwright-core/index.mjs'))
            result = subprocess.run(['node', str(ROOT/'test/check_phone_bridge.mjs'),
                                     'http://127.0.0.1:' + str(page.server_port) + '/wt901ble_live.html', imu.BRIDGE_URL],
                                    capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=100)
            print(result.stdout)
            if result.returncode:
                raise RuntimeError(result.stderr)
        finally:
            for s in (receiver, page):
                s.shutdown()
                s.server_close()
            bench.close()


if __name__ == '__main__':
    run()
