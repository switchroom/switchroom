#!/usr/bin/env python3
"""Live probe: the Camoufox browser tools follow popups and the human's tab (HF-826).

Run inside a Camoufox agent container as the runtime UID, with the Hermes venv, for example

    python3 camoufox-tabs-probe.py                    # the mounted camoufox-desktop plugin
    python3 camoufox-tabs-probe.py --plugin-b64 <b64>  # a candidate: base64 tar.gz of its files

It never touches the agent's own Camofox identity: a throwaway ``userId`` opens a local fixture page.
Through the real core ``tool_execution`` middleware chain with the plugin registered, and the mounted
camofox plugin's own tools, it checks that

* a click on a ``window.open`` button moves the tools to the popup (``popup_opened``);
* a page that renders after load does not come back from navigate with an empty snapshot;
* while a (simulated) human holds the Bot Desktop lease the tabs are kept alive, and after the hand
  back the session adopts the tab the human left in front, and the note names its URL;
* a screen handoff names Camoufox and the live tab and brings that tab to front;
* the password scrub leaves untracked tabs idle (their server-side tool-call count does not move,
  so the idle reaper can close them); agent popups the session no longer uses close at the end of a
  turn, keeping the tracked tab, its opener and the tabs a human opened; the session's untracked tabs
  close when it finalizes.

The lease is taken for a few seconds under a probe viewer id and always released. The throwaway
session and profile are removed at the end. Prints one JSON line; exits 1 on failure.
"""
from __future__ import annotations

import argparse
import base64
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
VIEWER = "tabs-probe-viewer"
PAGES = {
    "/opener": b"""<!doctype html><html><head><title>Opener</title></head><body><h1>Opener</h1>
<button id="open" onclick="window.open('/popup?n=' + Date.now(), '_blank', 'width=900,height=700')">Open guest form</button>
</body></html>""",
    "/popup": b"""<!doctype html><html><head><title>Guest form</title></head><body><h1>Guest details</h1>
<label>Guests <input id="guests" type="text"></label><button>Next</button></body></html>""",
    "/late": b"""<!doctype html><html><head><title>Late</title></head><body><div id="root"></div><script>
setTimeout(() => { document.getElementById('root').innerHTML =
  '<h2>Book a time</h2><button>9:00</button><button>9:30</button><a href="/popup">More</a>'; }, 1800);
</script></body></html>""",
}


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

    def tabs(self, user: str) -> list[dict]:
        return self("GET", f"/tabs?userId={user}").get("tabs", [])


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
            body = PAGES.get(self.path.split("?")[0])
            self.send_response(200 if body else 404)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body or b"not found")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def start_screen(rest: Camofox) -> None:
    os.environ.pop("DISPLAY", None)  # a set DISPLAY makes auto-start skip
    from tools.bot_desktop import runtime
    runtime.ensure_started_for_tool()
    for _ in range(120):
        try:
            if runtime.published_env().get("DISPLAY") and rest("GET", "/health", timeout=3).get("ok"):
                return
        except Exception:  # noqa: BLE001 - still starting
            pass
        time.sleep(1)
    raise RuntimeError("the Bot Desktop or camofox-browser did not come up")


def ref_of(snapshot: str, label: str) -> str:
    for line in snapshot.split("\n"):
        if label in line and "[e" in line:
            return "e" + line.split("[e", 1)[1].split("]", 1)[0]
    raise RuntimeError(f"no ref for {label!r} in snapshot")


def run(plugin_dir: str, user: str, rest: Camofox, report: dict) -> bool:
    server, base = start_page_server()
    from tools.bot_desktop import lease
    try:
        start_screen(rest)
        os.environ["CAMOFOX_USER_ID"], os.environ["CAMOFOX_API_KEY"] = user, rest.key
        os.environ["CAMOFOX_SESSION_KEY"] = "tabs-probe"
        load_package("camofox_tabs_probe", CAMOFOX_PLUGIN)
        tools = importlib.import_module("camofox_tabs_probe.camofox_tools")
        client = importlib.import_module("camofox_tabs_probe.camofox_client")
        desktop = load_package("camoufox_desktop_tabs_probe", plugin_dir)
        desktop.user_id = lambda: user
        from hermes_cli import plugins as core_plugins
        from hermes_cli.middleware import run_tool_execution_middleware
        manager = core_plugins.get_plugin_manager()
        manager._discovered = True  # do not load this profile's plugins into the probe
        manager._middleware.setdefault("tool_execution", []).append(desktop.browser_middleware)
        task = session_id = "tabs-probe-" + secrets.token_hex(3)

        def call(name, fn, args=None):
            return run_tool_execution_middleware(name, args or {}, lambda _a: fn(), task_id=task)

        # 1. Empty first snapshot: the vendored tool alone, then through the plugin.
        raw = json.loads(tools.browser_navigate(base + "/late", task))
        report["late_page_raw_elements"] = raw.get("element_count")
        out = json.loads(call("browser_navigate", lambda: tools.browser_navigate(base + "/late?again=1", task)))
        report["late_page_elements"] = out.get("element_count")
        report["late_page_wait_ms"] = out.get("snapshot_wait_ms")
        session = client.get_session(task)
        report["isolated_identity"] = session["user_id"] == user

        # 2. Popup follow.
        out = json.loads(call("browser_navigate", lambda: tools.browser_navigate(base + "/opener", task)))
        opener = session["tab_id"]
        clicked = json.loads(call("browser_click", lambda: tools.browser_click(
            ref_of(out["snapshot"], "Open guest form"), task)))
        popup = clicked.get("popup_opened") or {}
        report["popup_followed"] = (popup.get("opener_tab_id") == opener and session["tab_id"] == popup.get("tab_id")
                                    and "/popup" in popup.get("url", ""))
        snap = json.loads(call("browser_snapshot", lambda: tools.browser_snapshot(task)))
        report["popup_snapshot_is_popup"] = "Guest details" in snap.get("snapshot", "")

        # 3. Take over: the agent waits; the human opens another popup from the opener and leaves it in
        #    front; hand back.
        listed = json.loads(desktop.browser_tabs_tool({"action": "switch", "tab_id": opener}, task_id=task))
        report["tabs_switch"] = listed.get("current_tab_id") == opener
        desktop.pre_tool_call("screen_handoff", {"action": "link"}, session_id=session_id, task_id=task)
        handoff = json.loads(run_tool_execution_middleware(
            "screen_handoff", {"action": "link", "reason": "fill in the guest form"},
            lambda a: json.dumps({"ok": True, "echo_reason": a.get("reason")}), task_id=task))
        report["handoff_reason"] = handoff.get("echo_reason")
        report["handoff_names_camoufox"] = handoff.get("browser") == "Camoufox" and "/opener" in handoff.get(
            "tab_url", "")
        lease.acquire(VIEWER, reason="tabs probe")
        try:
            report["fenced_during_takeover"] = (desktop.pre_tool_call(
                "browser_tabs", {"action": "list"}, session_id=session_id, task_id=task) or {}).get("action") == "block"
            before = {t["tabId"] for t in rest.tabs(user)}
            rest("POST", f"/tabs/{opener}/evaluate", {"userId": user,
                                                      "expression": "document.getElementById('open').click()"})
            human_tab = None
            for _ in range(30):
                fresh = [t for t in rest.tabs(user) if t["tabId"] not in before]
                if fresh:
                    human_tab = fresh[-1]["tabId"]
                    break
                time.sleep(0.2)
            if human_tab:
                rest("POST", f"/tabs/{human_tab}/activate", {"userId": user})
            time.sleep(1)
            report["keepalive"] = desktop.tabs.keepalive_once()
        finally:
            lease.release(VIEWER)
        with_note = desktop.pre_llm_call(session_id=session_id) or {}
        note = with_note.get("context", "")
        report["handback_note"] = note[-220:]
        report["human_tab_opened"] = bool(human_tab)
        report["handback_adopted_human_tab"] = bool(human_tab) and session["tab_id"] == human_tab
        report["handback_note_names_url"] = "now on http" in note and "/popup" in note

        # 4. Orphans. The idle reaper counts tool calls per tab, so the scrub must leave orphans alone:
        #    an orphan's toolCalls stay put while the agent reads its tracked tab. Agent popups it no
        #    longer uses close at the end of the turn (keeping the tracked tab and its opener); the
        #    session's other untracked tabs close when it finalizes.
        def tool_calls(tab: str) -> int:
            return int(rest("GET", f"/tabs/{tab}/stats?userId={user}").get("toolCalls", -1))

        human_kept = session["tab_id"]  # the human's popup, now tracked
        chain = []
        for n in (1, 2, 3):
            call("browser_console", lambda n=n: tools.browser_console(
                f"window.open('/popup?agent={n}', '_blank', 'width=600,height=400'); true", task))
            chain.append(session["tab_id"])
        report["agent_popups_followed"] = len({human_kept, *chain}) == 4
        before_calls = {tab: tool_calls(tab) for tab in (opener, human_kept, chain[0])}
        for _ in range(3):
            call("browser_snapshot", lambda: tools.browser_snapshot(task))
        report["scrub_leaves_orphans_idle"] = {tab: tool_calls(tab) for tab in before_calls} == before_calls
        desktop.on_session_end(session_id=session_id, task_id=task)
        live = {t["tabId"] for t in rest.tabs(user)}
        report["turn_end_kept_tracked_and_opener"] = {chain[2], chain[1]} <= live
        report["turn_end_closed_unused_agent_popup"] = chain[0] not in live
        report["turn_end_left_human_tabs"] = {opener, human_kept} <= live
        group_before = len(rest.tabs(user))
        tracked = session["tab_id"]
        desktop.on_session_finalize(session_id=session_id)
        left = rest.tabs(user)
        report["finalize_closed"] = group_before - len(left)
        report["finalize_kept_only_tracked"] = [t["tabId"] for t in left] == [tracked]
        checks = ["isolated_identity", "popup_followed", "popup_snapshot_is_popup", "tabs_switch",
                  "handoff_names_camoufox", "fenced_during_takeover", "handback_adopted_human_tab",
                  "handback_note_names_url", "agent_popups_followed", "scrub_leaves_orphans_idle",
                  "turn_end_kept_tracked_and_opener", "turn_end_closed_unused_agent_popup",
                  "turn_end_left_human_tabs", "finalize_kept_only_tracked"]
        ok = all(report.get(c) is True for c in checks) and (report.get("late_page_elements") or 0) > 0
        report["failed_checks"] = [c for c in checks if report.get(c) is not True]
        return ok
    finally:
        try:
            lease.release(VIEWER)
        except Exception:  # noqa: BLE001
            pass
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
    parser = argparse.ArgumentParser(description="Camoufox tools follow popups and the human's tab.")
    parser.add_argument("--plugin-b64", help="base64 tar.gz of a candidate camoufox-desktop plugin")
    args = parser.parse_args()
    os.environ.setdefault("CAMOFOX_URL", "http://127.0.0.1:9377")
    os.environ["CAMOFOX_KEEPALIVE_SECONDS"] = "0"  # the probe drives one keep-alive tick itself
    os.environ["CAMOFOX_CHECKPOINT_SECONDS"] = "0"
    workdir = os.path.join(HOME, "cache", "scratch", "tabs-probe-" + secrets.token_hex(3))
    os.makedirs(workdir)
    plugin_dir = DESKTOP_PLUGIN
    if args.plugin_b64:
        plugin_dir = os.path.join(workdir, "camoufox-desktop")
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(args.plugin_b64)), mode="r:gz") as archive:
            archive.extractall(plugin_dir, filter="data")
    user = "tabs-probe-" + secrets.token_hex(4)
    rest, report, ok = Camofox(), {"plugin": "candidate" if args.plugin_b64 else "mounted"}, False
    try:
        ok = run(plugin_dir, user, rest, report)
    except Exception as exc:  # noqa: BLE001 - report, then clean up
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        cleanup(user, rest, workdir, report)
    report["pass"] = bool(ok)
    print("camoufox-tabs-probe " + json.dumps(report, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
