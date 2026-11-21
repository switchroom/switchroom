#!/usr/bin/env python3
"""Live smoke: a password a human types in Camoufox never reaches the model (HF-782).

Run inside a Camoufox agent container as the runtime UID, with the Hermes venv, for example

    python3 camoufox-password-smoke.py                    # the mounted camoufox-desktop plugin
    python3 camoufox-password-smoke.py --plugin-b64 <b64>  # a candidate: base64 tar.gz of its files

It never touches the agent's own Camofox identity. A throwaway ``userId`` opens a local login page,
a simulated human types into the password fields with XTest key events on the Bot Desktop, and a
vault-registered value is put in a third field. The mounted camofox plugin's browser_snapshot,
browser_console and browser_vision then run through the real core ``tool_execution`` middleware
chain with the plugin's scrub registered. It passes when no typed password and no vault value is in
any output, and other field values are kept. Then the throwaway session and profile are removed.
Prints one JSON line of booleans; exits 1 on failure.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import http.server
import importlib
import importlib.util
import io
import json
import os
import secrets
import shutil
import sys
import tarfile
import threading
import time
import urllib.request

HOME = os.environ.get("HERMES_HOME", "/opt/data")
CAMOFOX_PLUGIN = "/opt/hermes/plugins/camofox"
DESKTOP_PLUGIN = "/opt/hermes/plugins/camoufox-desktop"
PW, NEW_PW, VAULT = "s3cret-pw", "n3w-pass-42", "vaultfill-77zz"
MASK = "«redacted-password»"
PAGE = b"""<!doctype html><html><head><title>Password smoke</title></head><body>
<h1>Sign in</h1><form onsubmit="return false">
<label>Email <input id="em" type="email" value="someone@example.com"></label>
<label>Password <input id="pw" type="password"></label>
<label>New password <input id="np" type="text" autocomplete="new-password"></label>
<label>Code <input id="vc" type="text"></label>
<button>Sign in</button></form></body></html>"""


class Camofox:
    def __init__(self) -> None:
        self.base = (os.environ.get("CAMOFOX_URL") or "http://127.0.0.1:9377").rstrip("/")
        with open(os.path.join(HOME, "camofox-browser", "access-key"), encoding="utf-8") as handle:
            self.key = handle.read().strip()

    def __call__(self, method: str, path: str, body: dict | None = None, timeout: float = 120):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=None if body is None else json.dumps(body).encode())
        req.add_header("Authorization", "Bearer " + self.key)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout) as resp:
            raw = resp.read()
        return json.loads(raw) if raw else None


def load_package(name: str, directory: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(directory, "__init__.py"),
                                                  submodule_search_locations=[directory])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def start_page_server():
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(PAGE)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/login"


def start_screen(rest: Camofox) -> dict:
    os.environ.pop("DISPLAY", None)  # a set DISPLAY makes auto-start skip
    from tools.bot_desktop import runtime
    runtime.ensure_started_for_tool()
    for _ in range(120):
        published = runtime.published_env()
        try:
            if published.get("DISPLAY") and rest("GET", "/health", timeout=3).get("ok"):
                return published
        except Exception:  # noqa: BLE001 - still starting
            pass
        time.sleep(1)
    raise RuntimeError("the Bot Desktop or camofox-browser did not come up")


def human_typist(published: dict):
    """Type like a person: XTest key events into whatever has keyboard focus on the Bot Desktop."""
    os.environ["XAUTHORITY"] = published.get("XAUTHORITY", "")
    x11, xtst = ctypes.CDLL("libX11.so.6"), ctypes.CDLL("libXtst.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XStringToKeysym.restype = ctypes.c_ulong
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x11.XOpenDisplay(published["DISPLAY"].encode())
    if not display:
        raise RuntimeError("cannot open the Bot Desktop display")

    def type_text(text: str) -> None:
        for char in text:
            code = x11.XKeysymToKeycode(display, x11.XStringToKeysym({"-": "minus"}.get(char, char).encode()))
            xtst.XTestFakeKeyEvent(display, code, 1, 0)
            xtst.XTestFakeKeyEvent(display, code, 0, 0)
            x11.XFlush(display)
            time.sleep(0.05)
    return type_text


def run(plugin_dir: str, workdir: str, user: str, rest: Camofox, report: dict) -> bool:
    server, url = start_page_server()
    try:
        published = start_screen(rest)
        tab = rest("POST", "/tabs", {"userId": user, "sessionKey": "password-smoke", "url": url})["tabId"]
        time.sleep(2)
        rest("POST", f"/tabs/{tab}/activate", {"userId": user})
        time.sleep(1)

        def evaluate(expression: str):
            reply = rest("POST", f"/tabs/{tab}/evaluate", {"userId": user, "expression": expression})
            return reply.get("result") if isinstance(reply, dict) else None  # undefined has no "result"

        type_text = human_typist(published)
        for field, value in (("pw", PW), ("np", NEW_PW)):
            evaluate(f"document.getElementById('{field}').focus()")
            time.sleep(0.3)
            type_text(value)
        time.sleep(0.5)
        report["human_typed"] = json.loads(evaluate(
            f"JSON.stringify(document.getElementById('pw').value === '{PW}' "
            f"&& document.getElementById('np').value === '{NEW_PW}')"))

        # The mounted camofox plugin, bound to the throwaway identity.
        os.environ["CAMOFOX_USER_ID"], os.environ["CAMOFOX_API_KEY"] = user, rest.key
        load_package("camofox_smoke", CAMOFOX_PLUGIN)
        tools = importlib.import_module("camofox_smoke.camofox_tools")
        client = importlib.import_module("camofox_smoke.camofox_client")
        task = "password-smoke"
        session = client.get_session(task)
        session["tab_id"] = tab
        report["isolated_identity"] = session["user_id"] == user

        from agent.redact import register_vault_redaction_value
        register_vault_redaction_value(VAULT)  # what browser_vault does before a fill
        evaluate(f"(() => {{ document.getElementById('vc').value = '{VAULT}'; return true; }})()")

        reply = type("Reply", (), {"text": f"The password box shows {PW}."})()
        llm = type("Llm", (), {"complete": lambda self, *a, **k: reply})()
        calls = {
            "browser_snapshot": lambda: tools.browser_snapshot(task),
            "browser_console": lambda: tools.browser_console("document.getElementById('pw').value", task),
            "browser_vision": lambda: tools.browser_vision("What is in the password box?", task, llm=llm),
        }
        report["unscrubbed_leaks"] = {name: PW in call() for name, call in calls.items()}

        desktop = load_package("camoufox_desktop_smoke", plugin_dir)
        desktop.user_id = lambda: user  # scan the throwaway identity only (and the tracked session)
        from hermes_cli import plugins as core_plugins
        from hermes_cli.middleware import run_tool_execution_middleware
        manager = core_plugins.get_plugin_manager()
        manager._discovered = True  # do not load this profile's plugins into the smoke
        manager._middleware.setdefault("tool_execution", []).append(desktop.scrub_passwords)
        outputs = {name: run_tool_execution_middleware(name, {}, lambda _args, call=call: call(), task_id=task)
                   for name, call in calls.items()}
        report["leaks"] = {name: any(v in out for v in (PW, NEW_PW, VAULT)) for name, out in outputs.items()}
        report["masked"] = {name: MASK in out for name, out in outputs.items()}
        snapshot = json.loads(outputs["browser_snapshot"]).get("snapshot", "")
        report["other_values_kept"] = "someone@example.com" in snapshot
        report["field_rows"] = [line.strip() for line in snapshot.split("\n") if "textbox" in line]
        return (report["human_typed"] and report["isolated_identity"] and not any(report["leaks"].values())
                and all(report["masked"].values()) and report["other_values_kept"])
    finally:
        server.shutdown()


def cleanup(user: str, rest: Camofox, workdir: str, report: dict) -> None:
    try:
        rest("DELETE", f"/sessions/{user}", timeout=30)
        report["session_deleted"] = True
    except Exception as exc:  # noqa: BLE001
        report["session_deleted"] = type(exc).__name__
    removed = 0
    profiles = os.path.join(HOME, "camofox-browser", "profiles")
    for name in os.listdir(profiles) if os.path.isdir(profiles) else []:
        meta = os.path.join(profiles, name, "meta.json")
        try:
            with open(meta, encoding="utf-8") as handle:
                if json.load(handle).get("userId") == user:
                    shutil.rmtree(os.path.join(profiles, name))
                    removed += 1
        except (OSError, ValueError):
            pass
    report["profile_dirs_removed"] = removed
    shutil.rmtree(workdir, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="A human-typed Camoufox password never reaches the model.")
    parser.add_argument("--plugin-b64", help="base64 tar.gz of a candidate camoufox-desktop plugin")
    args = parser.parse_args()
    workdir = os.path.join(HOME, "cache", "scratch", "password-smoke-" + secrets.token_hex(3))
    os.makedirs(workdir)
    plugin_dir = DESKTOP_PLUGIN
    if args.plugin_b64:
        plugin_dir = os.path.join(workdir, "camoufox-desktop")
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(args.plugin_b64)), mode="r:gz") as archive:
            archive.extractall(plugin_dir, filter="data")
    user = "password-smoke-" + secrets.token_hex(4)
    rest, report, ok = Camofox(), {"plugin": "candidate" if args.plugin_b64 else "mounted"}, False
    try:
        ok = run(plugin_dir, workdir, user, rest, report)
    except Exception as exc:  # noqa: BLE001 - report, then clean up
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        cleanup(user, rest, workdir, report)
    report["pass"] = bool(ok)
    print("camoufox-password-smoke " + json.dumps(report, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
