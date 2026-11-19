"""Real local HTTP service with ONNX and optional isolated headless page test."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from check_online import events

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import serve_page


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", action="store_true")
    args = parser.parse_args()
    server = serve_page.Server(("127.0.0.1", 0), serve_page.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    checks = []

    def post(route, body):
        request = urllib.request.Request(base+route, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    try:
        assert post("/act/info", {})["online_policy"]["version"] == "activity-online-linear-v2"
        post("/act/reset", {})
        source, pos = events(), 0
        result = None
        for end in range(0, 4200, 200):
            now = end+150
            nxt = pos
            while nxt < len(source) and source[nxt]["receipt_ms"] <= now:
                nxt += 1
            result = post("/act/step", dict(events=source[pos:nxt], t_end=end, now_ms=now))
            pos = nxt
        assert result["valid"] and abs(sum(result["probabilities"])-1) < 1e-5
        checks.append("real HTTP + ONNX inference")
        stopped = post("/act/step", dict(events=[], t_end=5000, now_ms=5150))
        assert not stopped["valid"] and stopped["label"] is None
        checks.append("HTTP silence invalidates classification")
        print("HTTP_ONLINE_PASS", json.dumps(dict(checks=checks, policy=post("/act/info", {})["online_policy"])))
        if args.browser:
            executable = next((p for p in (
                Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
                Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe")) if p.exists()), None)
            if executable is None:
                raise FileNotFoundError("Edge headless executable required for --browser")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                debug_port = sock.getsockname()[1]
            profile = tempfile.mkdtemp(prefix="d56-browser-")
            browser = None
            try:
                browser = subprocess.Popen([str(executable), "--headless=new", "--disable-gpu",
                                            f"--remote-debugging-port={debug_port}",
                                            f"--user-data-dir={profile}", base+"/wt901ble_live.html?view=act"],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                deadline = time.monotonic()+20
                while True:
                    try:
                        urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/version", timeout=1).read()
                        break
                    except (OSError, TimeoutError):
                        if time.monotonic() > deadline:
                            raise TimeoutError("Browser CDP startup")
                run = subprocess.run(["node", str(ROOT/"test/check_activity_live.js")],
                                     env=dict(os.environ, CDP_PORT=str(debug_port)),
                                     capture_output=True, text=True, encoding="utf-8", timeout=45)
                print(run.stdout)
                if run.returncode:
                    raise RuntimeError(run.stderr)
            finally:
                if browser is not None:
                    subprocess.run(["taskkill", "/PID", str(browser.pid), "/T", "/F"], capture_output=True)
                    browser.wait(timeout=10)
                try:
                    shutil.rmtree(profile)
                except OSError:
                    print("Temporary browser profile retained:", profile)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
