#!/usr/bin/env python3
"""Bake-time headed smoke for the image's Camoufox stack (HF-773).

Runs inside the candidate image as the runtime UID, under the fleet seccomp profile and
no-new-privileges (the workflow passes those flags). It proves, without the network:

* the pinned, attested Camoufox build is installed where the lock says;
* the supervised service runner (docker/camofox-browser/service-run) starts camofox-browser on
  loopback with an access key, and refuses unauthenticated requests;
* Camoufox opens HEADED on an X display (a private Xvnc, as the Bot Desktop uses) and renders one
  local page, which is snapshotted and screenshotted; its window is on the X display;
* SIGTERM checkpoints the session's cookies to the persistent profile directory.

Writes evidence (screenshot, service log, summary) to --out.
"""
from __future__ import annotations

import argparse
import http.server
import ipaddress
import json
import os
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

LOCK = Path("/opt/hermes-fleet/release/camoufox.lock.json")
SERVICE = "/usr/local/lib/camofox-browser/service-run"
MARKER = "hermes-fleet-camoufox-smoke"
# The browser identity the service must derive: the image sets LANG=en_AU.UTF-8, the smoke sets TZ.
SMOKE_LANG = "en-AU"
SMOKE_TZ = "Australia/Sydney"
DISPLAY_NUM = 87


def fail(message: str) -> None:
    print(f"verify-camoufox-runtime: FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def request(url: str, method: str = "GET", body: dict | None = None, key: str | None = None,
            timeout: float = 30.0):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, raw


def check_install(lock_path: Path, server: Path) -> dict:
    lock = json.loads(lock_path.read_text())["camoufox"]
    install = Path(os.environ.get("CAMOUFOX_EXECUTABLE") or lock["executable"]).parent
    version = json.loads((install / "version.json").read_text())
    if (version["version"], version["build"]) != (lock["version"], lock["build"]):
        fail(f"installed Camoufox {version} does not match the lock {lock['version']}-{lock['build']}")
    provenance = json.loads((install / ".hermes-fleet-provenance.json").read_text())
    if provenance.get("sha256") != lock["sha256"]:
        fail(f"provenance marker sha256 {provenance.get('sha256')} != lock")
    if lock["attestation"]["required"] and provenance.get("attestation") != "verified":
        fail(f"Camoufox build attestation was not verified at bake time: {provenance}")
    executable = os.environ.get("CAMOUFOX_EXECUTABLE") or lock["executable"]
    if not os.access(executable, os.X_OK):
        fail(f"{executable} is not executable")
    if (server / "node_modules" / "camoufox-js").exists():
        fail("camoufox-js is installed; the patched server must use the official camoufox package")
    pkg = json.loads((server / "node_modules" / "camoufox" / "package.json").read_text())
    return {"camoufox": f"{version['version']}-{version['build']}", "camoufox_npm": pkg["version"],
            "attestation": provenance["attestation"]}


TCP_TABLES = (("/proc/net/tcp", 8), ("/proc/net/tcp6", 32))


def listening_addresses(port: int, tables: tuple[tuple[str, int], ...] = TCP_TABLES) -> set[str]:
    """Local addresses with a TCP listener on `port`, read from /proc (no iproute2 needed)."""
    found: set[str] = set()
    for table, width in tables:
        try:
            rows = Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            fields = row.split()
            local, state = fields[1], fields[3]
            address, port_hex = local.split(":")
            if state != "0A" or int(port_hex, 16) != port:  # 0A = LISTEN
                continue
            raw = bytes.fromhex(address)
            if width == 8:
                found.add(".".join(str(b) for b in raw[::-1]))
            else:
                words = [raw[i:i + 4][::-1] for i in range(0, 16, 4)]
                found.add(str(ipaddress.IPv6Address(b"".join(words))))
    return found


class _Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = (f"<!doctype html><title>{MARKER}</title><h1>{MARKER}</h1>"
                "<p id=lang></p><script>document.getElementById('lang').textContent="
                "navigator.language</script>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Set-Cookie", f"{MARKER}=1; Max-Age=3600; Path=/")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--lock", default=str(LOCK), help=argparse.SUPPRESS)
    parser.add_argument("--service", default=SERVICE, help=argparse.SUPPRESS)
    parser.add_argument("--server-dir", default="/opt/camofox-browser", help=argparse.SUPPRESS)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    summary: dict = {"uid": os.getuid()}
    if os.getuid() == 0:
        fail("must run as the runtime UID, not root")
    summary.update(check_install(Path(args.lock), Path(args.server_dir)))

    home = Path(tempfile.mkdtemp(prefix="camoufox-smoke-home-"))
    (home / "bot-desktop").mkdir()
    xauth = home / "bot-desktop" / "Xauthority"
    cookie = subprocess.check_output(["od", "-An", "-N16", "-tx1", "/dev/urandom"], text=True).replace(" ", "").strip()
    subprocess.check_call(["xauth", "-f", str(xauth), "add", f":{DISPLAY_NUM}", ".", cookie])
    xvnc = subprocess.Popen(
        ["Xvnc", f":{DISPLAY_NUM}", "-geometry", "1440x900", "-depth", "24", "-rfbport", "-1",
         "-rfbunixpath", str(home / "bot-desktop" / "rfb.sock"), "-SecurityTypes", "None",
         "-nolisten", "tcp", "-auth", str(xauth)],
        stdout=subprocess.DEVNULL, stderr=open(out / "xvnc.log", "w"))
    sock = Path(f"/tmp/.X11-unix/X{DISPLAY_NUM}")
    for _ in range(100):
        if sock.exists():
            break
        time.sleep(0.1)
    else:
        fail("Xvnc did not start")
    (home / "bot-desktop" / "env").write_text(f"DISPLAY=:{DISPLAY_NUM}\nXAUTHORITY={xauth}\n")

    httpd = socketserver.TCPServer(("127.0.0.1", 0), _Page)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    page = f"http://127.0.0.1:{httpd.server_address[1]}/"

    env = {k: v for k, v in os.environ.items() if not k.startswith("CAMOFOX_")}
    # The service derives the browser's locale and time zone from the container: LANG is the image's
    # en_AU.UTF-8, and TZ is set as a deployment's compose would.
    env.update(HERMES_HOME=str(home), CAMOFOX_PORT="19377", CAMOFOX_SERVER_DIR=args.server_dir,
               TZ=SMOKE_TZ)
    log = open(out / "camofox-browser.log", "w")
    service = subprocess.Popen([args.service], env=env, stdout=log, stderr=subprocess.STDOUT)
    base = "http://127.0.0.1:19377"
    try:
        for _ in range(60):
            try:
                status, raw = request(base + "/health", timeout=2)
                if status == 200 and json.loads(raw).get("ok"):
                    break
            except (OSError, urllib.error.URLError, ValueError):
                pass
            time.sleep(1)
        else:
            fail("camofox-browser did not answer /health")
        key = (home / "camofox-browser" / "access-key").read_text().strip()
        if (home / "camofox-browser" / "access-key").stat().st_mode & 0o077:
            fail("access key file is readable by group or others")
        try:
            request(base + "/tabs?userId=smoke", timeout=5)
            fail("an unauthenticated request was accepted")
        except urllib.error.HTTPError as exc:
            summary["unauthenticated_status"] = exc.code
        listeners = listening_addresses(19377)
        if listeners != {"127.0.0.1"}:
            fail(f"camofox-browser must listen on 127.0.0.1 only, found: {sorted(listeners)}")
        summary["listen"] = sorted(listeners)

        started = time.monotonic()
        _, raw = request(base + "/tabs", "POST", {"userId": "smoke", "sessionKey": "smoke", "url": page},
                         key=key, timeout=180)
        tab = json.loads(raw)
        summary["first_tab_seconds"] = round(time.monotonic() - started, 1)
        tab_id = tab["tabId"]
        _, raw = request(f"{base}/tabs/{tab_id}/snapshot?userId=smoke", key=key, timeout=60)
        snapshot = json.loads(raw).get("snapshot", "")
        if MARKER not in snapshot:
            fail(f"snapshot does not show the test page: {snapshot[:300]}")
        _, png = request(f"{base}/tabs/{tab_id}/screenshot?userId=smoke", key=key, timeout=60)
        if not png.startswith(b"\x89PNG"):
            fail("screenshot is not a PNG")
        (out / "camoufox-page.png").write_bytes(png)
        _, raw = request(f"{base}/tabs/{tab_id}/evaluate", "POST", {
            "userId": "smoke",
            "expression": "JSON.stringify({ua: navigator.userAgent, webdriver: navigator.webdriver, "
                          "lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, "
                          "w: outerWidth, h: outerHeight})",
        }, key=key, timeout=60)
        page_facts = json.loads(json.loads(raw)["result"])
        summary["page"] = page_facts
        if "Firefox/" + summary["camoufox"].split(".")[0] not in page_facts["ua"]:
            fail(f"unexpected user agent {page_facts['ua']}")
        if page_facts["webdriver"]:
            fail("navigator.webdriver is true")
        if (page_facts["lang"], page_facts["tz"]) != (SMOKE_LANG, SMOKE_TZ):
            fail(f"browser identity is {page_facts['lang']} / {page_facts['tz']}, "
                 f"expected {SMOKE_LANG} / {SMOKE_TZ} from the container's LANG and TZ")
        tree = subprocess.run(["xwininfo", "-root", "-tree"], env={**os.environ, "DISPLAY": f":{DISPLAY_NUM}",
                              "XAUTHORITY": str(xauth)}, capture_output=True, text=True, timeout=20).stdout
        (out / "xwininfo.txt").write_text(tree)
        if MARKER not in tree:
            fail("no Camoufox window with the test page title on the X display (not headed?)")
        summary["headed_window"] = True
        _, raw = request(base + "/health", timeout=5)
        summary["health"] = {k: v for k, v in json.loads(raw).items() if k in ("browserConnected", "activeTabs")}
    finally:
        service.send_signal(signal.SIGTERM)
        try:
            summary["service_exit"] = service.wait(timeout=60)
        except subprocess.TimeoutExpired:
            service.kill()
            fail("camofox-browser did not stop within 60 s of SIGTERM")
        httpd.shutdown()
        xvnc.terminate()
    states = list((home / "camofox-browser" / "profiles").glob("*/storage-state.json"))
    if not states or MARKER not in states[0].read_text():
        fail("SIGTERM did not checkpoint the session cookies to the profile directory")
    summary["checkpoint"] = True
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
