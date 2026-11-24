"""camoufox-desktop keeps the agent and the human on the same Camoufox tab (HF-826).

camofox-browser registers every popup as a managed tab in the opener's session group, but the
vendored camofox plugin tracks one tab per task and never moves to a popup. These tests drive the
plugin's real middleware, hooks and browser_tabs tool against a stand-in camofox-browser server on
loopback (``GET /tabs``, ``POST /tabs/<id>/evaluate|activate``, ``DELETE /tabs/<id>``) and a stand-in
for the camofox plugin's session map, the shape the real plugin keeps (``camofox_client._sessions``).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("camoufox_desktop_tab_test_helpers",
                                               ROOT / "tests" / "test_camoufox_desktop_plugin.py")
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)

USER, KEY, TASK = "hermes-agent", "task_chat1", "chat1"
PW = "hunter2-pw"
CAMOFOX_TOOLSETS = {name: "camofox" for name in (
    "browser_navigate", "browser_snapshot", "browser_console", "browser_vision", "browser_get_images",
    "browser_click", "browser_type", "browser_press", "browser_tabs")}


class FakeCamofox:
    """camofox-browser stand-in: ordered tabs (tabId, listItemId, url, title), per-tab password-scan
    answers; records evaluates, activations and closes."""

    def __init__(self):
        self.tabs: list[dict] = []
        self.scan: dict[str, list[str]] = {}
        self.evaluated: list[tuple[str, str]] = []
        self.activated: list[str] = []
        self.closed: list[str] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _send(self, code, body):
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                parts = urlsplit(self.path)
                user = parse_qs(parts.query).get("userId", [""])[0]
                if parts.path == "/tabs":
                    return self._send(200, {"running": True, "tabs": [dict(t) for t in fake.tabs
                                                                      if t.get("user", USER) == user]})
                return self._send(404, {"error": "not found"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                _, _, tab, route = self.path.split("/")[:4]
                if not any(t["tabId"] == tab for t in fake.tabs):
                    return self._send(404, {"error": "Tab not found"})
                if route == "activate":
                    fake.activated.append(tab)
                    return self._send(200, {"ok": True, "tabId": tab})
                expression = body.get("expression", "")
                fake.evaluated.append((tab, expression))
                if "password" in expression:
                    return self._send(200, {"ok": True, "result": json.dumps(
                        {"values": fake.scan.get(tab, []), "opaque": False})})
                return self._send(200, {"ok": True, "result": 0})

            def do_DELETE(self):
                tab = urlsplit(self.path).path.split("/")[2]
                fake.closed.append(tab)
                fake.tabs = [t for t in fake.tabs if t["tabId"] != tab]
                return self._send(200, {"ok": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def add(self, tab, key=KEY, url="https://x.test/", title="", user=USER):
        self.tabs.append({"tabId": tab, "listItemId": key, "url": url, "title": title, "user": user})

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def fake_camofox_plugin(sessions: dict, fetch=None):
    client = types.ModuleType("plugins.camofox.camofox_client")
    client._sessions = sessions
    client._session_key = lambda task_id: ("home", task_id or "default")
    client.get_session = lambda task_id: sessions.setdefault(
        ("home", task_id or "default"), {"user_id": USER, "tab_id": None, "session_key": f"task_{task_id}"})
    tools = types.ModuleType("plugins.camofox.camofox_tools")
    tools._fetch_snapshot = fetch or (lambda session: ("", 0))
    return {"plugins.camofox.camofox_client": client, "plugins.camofox.camofox_tools": tools}


class TabTests(unittest.TestCase):
    def setUp(self):
        self.camofox = FakeCamofox()
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"HERMES_HOME": str(self.home), "CAMOFOX_URL": self.camofox.url,
                                                "CAMOFOX_CHECKPOINT_SECONDS": "0", "CAMOFOX_KEEPALIVE_SECONDS": "0",
                                                "CAMOFOX_API_KEY": "k" * 64}, clear=False)
        self.env.start()
        os.environ.pop("CAMOFOX_USER_ID", None)
        self.toolsets = mock.patch.dict(helpers.FakeRegistry.TOOLSETS, CAMOFOX_TOOLSETS)
        self.toolsets.start()
        self.plugin, self.lease, _, self.patcher = helpers.load_plugin(self.home)
        self.tabs = sys.modules[self.plugin.__name__ + ".tabs"]
        self.session = {"user_id": USER, "tab_id": "t1", "session_key": KEY}
        self.sessions = {("home", TASK): self.session}
        self.snapshots: list[tuple[str, int]] = []
        self.front: list[str] = []
        self.front_real = self.tabs.front_window_titles
        self.front_patch = mock.patch.object(self.tabs, "front_window_titles", lambda: list(self.front))
        self.front_patch.start()
        self.modules = mock.patch.dict(sys.modules, fake_camofox_plugin(self.sessions, self._fetch))
        self.modules.start()
        self.camofox.add("t1", url="https://x.test/start", title="Start")

    def tearDown(self):
        self.front_patch.stop()
        self.modules.stop()
        self.patcher.stop()
        self.toolsets.stop()
        self.env.stop()
        self.tmp.cleanup()
        self.camofox.close()

    def _fetch(self, session):
        return self.snapshots.pop(0) if self.snapshots else ("", 0)

    def run_tool(self, tool_name, result, args=None, effect=None, task_id=TASK):
        calls = []

        def next_call(payload=None):
            calls.append(payload)
            if effect:
                effect()
            return result
        out = self.plugin.browser_middleware(tool_name=tool_name, args=args or {}, next_call=next_call,
                                             task_id=task_id)
        self.assertEqual(len(calls), 1, "the tool must run exactly once")
        return out, calls[0]

    # ---- popup follow ----

    def test_a_click_that_opens_a_popup_moves_the_tools_to_it(self):
        out, _ = self.run_tool("browser_click", json.dumps({"success": True, "clicked": "e3", "url": ""}),
                               effect=lambda: self.camofox.add("t2", url="https://x.test/guest"))
        data = json.loads(out)
        self.assertEqual(data["popup_opened"], {"tab_id": "t2", "url": "https://x.test/guest", "opener_tab_id": "t1"})
        self.assertIn("browser_snapshot", data["tab_note"])
        self.assertEqual(self.session["tab_id"], "t2")

    def test_a_popup_registered_just_after_the_click_answers_is_still_followed(self):
        def late():
            threading.Timer(0.15, lambda: self.camofox.add("t2", url="https://x.test/late")).start()
        out, _ = self.run_tool("browser_console", json.dumps({"success": True, "result": None}), effect=late)
        self.assertEqual(json.loads(out)["popup_opened"]["tab_id"], "t2")
        self.assertEqual(self.session["tab_id"], "t2")

    def test_no_popup_leaves_the_result_and_the_tab_alone(self):
        raw = json.dumps({"success": True, "typed": "abc", "element": "e1"})
        out, _ = self.run_tool("browser_type", raw)
        self.assertEqual(out, raw)
        self.assertEqual(self.session["tab_id"], "t1")

    def test_another_sessions_tab_and_a_human_ctrl_t_tab_are_not_followed(self):
        def others():
            self.camofox.add("tX", key="task_otherchat")
            self.camofox.add("tY", key="desktop")
        raw = json.dumps({"success": True, "pressed": "Enter"})
        out, _ = self.run_tool("browser_press", raw, effect=others)
        self.assertEqual(out, raw)
        self.assertEqual(self.session["tab_id"], "t1")

    def test_several_new_tabs_follow_the_newest_and_name_the_rest(self):
        def many():
            self.camofox.add("t2")
            self.camofox.add("t3")
        data = json.loads(self.run_tool("browser_click", json.dumps({"success": True}), effect=many)[0])
        self.assertEqual(data["popup_opened"]["tab_id"], "t3")
        self.assertEqual(data["popup_opened"]["other_new_tab_ids"], ["t2"])

    def test_a_tool_that_cannot_open_tabs_is_not_diffed(self):
        raw = json.dumps({"success": True, "scrolled": "down"})
        self.assertEqual(self.run_tool("browser_scroll", raw, effect=lambda: self.camofox.add("t2"))[0], raw)
        self.assertEqual(self.session["tab_id"], "t1")

    # ---- the password scrub scans only the tracked tab ----

    def test_the_scrub_scans_the_tracked_tab_only_so_orphans_can_idle_out(self):
        self.camofox.add("orphan", url="https://x.test/orphan")
        self.camofox.scan["t1"] = [PW]
        out, _ = self.run_tool("browser_snapshot", json.dumps(
            {"success": True, "snapshot": f"- textbox [e2]: {PW}", "element_count": 1}))
        self.assertNotIn(PW, out)
        scanned = {tab for tab, expr in self.camofox.evaluated if "password" in expr}
        self.assertEqual(scanned, {"t1"})

    def test_a_followed_popup_and_its_opener_are_both_scanned(self):
        self.camofox.scan["t1"] = [PW]
        out, _ = self.run_tool("browser_console", json.dumps({"success": True, "result": PW}),
                               effect=lambda: self.camofox.add("t2"))
        self.assertNotIn(PW, out)
        self.assertEqual({tab for tab, expr in self.camofox.evaluated if "password" in expr}, {"t1", "t2"})

    # ---- empty first snapshot ----

    def test_an_empty_first_snapshot_is_reread_until_the_page_renders(self):
        self.snapshots = [("", 0), ('- button "Book" [e1]', 1)]
        with mock.patch.object(self.tabs, "SNAPSHOT_POLL_SECONDS", 0.01):
            out, _ = self.run_tool("browser_navigate", json.dumps(
                {"success": True, "url": "https://x.test/lwc", "title": "", "snapshot": "", "element_count": 0}))
        data = json.loads(out)
        self.assertEqual(data["element_count"], 1)
        self.assertIn("Book", data["snapshot"])
        self.assertIn("snapshot_wait_ms", data)

    def test_the_wait_is_bounded_and_a_settled_text_page_stops_early(self):
        with mock.patch.object(self.tabs, "SNAPSHOT_POLL_SECONDS", 0.01):
            started = __import__("time").monotonic()
            self.tabs.settle_snapshot(TASK, json.dumps({"success": True, "snapshot": "", "element_count": 0}),
                                      budget=0.3)
            self.assertLess(__import__("time").monotonic() - started, 1.5)
            self.snapshots = [("- paragraph: Closed today", 0)] * 5
            out = self.tabs.settle_snapshot(TASK, json.dumps(
                {"success": True, "snapshot": "- paragraph: Closed today", "element_count": 0}), budget=5)
        self.assertEqual(len(self.snapshots), 3, "two equal reads end the wait")
        self.assertEqual(json.loads(out)["element_count"], 0)

    def test_a_page_with_elements_is_not_polled(self):
        raw = json.dumps({"success": True, "snapshot": "- link [e1]", "element_count": 1})
        self.snapshots = [("x", 0)]
        self.assertEqual(self.tabs.settle_snapshot(TASK, raw), raw)
        self.assertEqual(len(self.snapshots), 1)

    # ---- hand-back ----

    def test_hand_back_adopts_the_tab_the_human_left_focused(self):
        self.camofox.add("t2", url="https://x.test/guest-details", title="Guest details")
        self.front = ["Guest details", "Start"]
        self.lease.take_over()
        self.plugin.pre_tool_call("browser_click", {"ref": "e1"}, session_id="s1", task_id=TASK)
        self.lease.hand_back()
        with mock.patch.object(self.plugin, "_checkpoint_async"):
            note = self.plugin.pre_llm_call(session_id="s1")["context"]
        self.assertIn("now on https://x.test/guest-details", note)
        self.assertIn("no longer apply", note)
        self.assertEqual(self.session["tab_id"], "t2")
        # Told at hand-back: the next action runs normally instead of being refused.
        raw = json.dumps({"success": True})
        self.assertEqual(self.run_tool("browser_click", raw)[0], raw)

    def test_with_no_camoufox_window_of_ours_in_front_the_groups_newest_tab_is_adopted(self):
        self.camofox.add("t2", url="https://x.test/popup", title="Popup")
        self.camofox.add("tX", key="task_other", url="https://x.test/other", title="Other")
        self.front = ["Other", "Somebody's Ctrl+T tab"]
        self.assertEqual(self.tabs.adopt_focused_tab(TASK),
                         {"url": "https://x.test/popup", "tab_id": "t2", "switched": True})

    def test_a_title_shared_by_several_tabs_keeps_the_tracked_one(self):
        self.camofox.tabs[0]["title"] = "Booking"
        self.camofox.add("t2", title="Booking")
        self.front = ["Booking"]
        self.assertEqual(self.tabs.adopt_focused_tab(TASK)["tab_id"], "t1")

    def test_front_windows_come_from_the_window_manager(self):
        # Page JavaScript cannot tell (Playwright emulates focus); the window manager's focused window
        # and stacking order can. The fake xprop answers what a Bot Desktop showed in the HF-826 probe.
        replies = {
            ("-root", "_NET_ACTIVE_WINDOW", "_NET_CLIENT_LIST_STACKING"):
                "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x180024d, 0x0\n"
                "_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x80002c, 0xc00002, 0x180021f, 0x180024d, 0x600003\n",
            ("-id", "0x180024d", "_NET_WM_NAME"): '_NET_WM_NAME(UTF8_STRING) = "Guest \\"form\\" — Camoufox"\n',
            ("-id", "0x180021f", "_NET_WM_NAME"): '_NET_WM_NAME(UTF8_STRING) = "Opener — Camoufox"\n',
            ("-id", "0xc00002", "_NET_WM_NAME"): '_NET_WM_NAME(UTF8_STRING) = "about:blank - Chromium"\n',
            ("-id", "0x80002c", "_NET_WM_NAME"): '_NET_WM_NAME(UTF8_STRING) = "Desktop"\n',
            ("-id", "0x600003", "_NET_WM_NAME"): '_NET_WM_NAME(UTF8_STRING) = "xfce4-panel"\n',
        }
        runtime = sys.modules["tools.bot_desktop"].runtime
        runtime.env = {"DISPLAY": ":20", "XAUTHORITY": "/x/Xauthority"}
        with mock.patch.object(self.tabs, "_xprop", side_effect=lambda env, *a: replies.get(a, "")), \
                mock.patch.object(self.tabs.shutil, "which", return_value="/usr/bin/xprop"):
            self.assertEqual(self.front_real(), ['Guest "form"', "Opener"])
        runtime.env = {}
        self.assertEqual(self.front_real(), [])  # screen down: nothing to read

    def test_hand_back_on_the_same_tab_just_names_it(self):
        self.camofox.add("t2", url="https://x.test/older-popup", title="Older")
        self.front = ["Start", "Older"]
        self.plugin.pre_tool_call("screen_handoff", {"action": "link"}, session_id="s1", task_id=TASK)
        self.lease.take_over()
        self.lease.hand_back()
        with mock.patch.object(self.plugin, "_checkpoint_async"):
            note = self.plugin.pre_llm_call(session_id="s1")["context"]
        self.assertIn("now on https://x.test/start", note)
        self.assertNotIn("no longer apply", note)

    def test_an_unannounced_take_over_is_caught_on_the_next_action(self):
        self.run_tool("browser_snapshot", json.dumps({"success": True, "snapshot": "", "element_count": 0}))
        self.camofox.add("t2", url="https://x.test/where-they-went", title="Where")
        self.front = ["Where"]
        self.lease.take_over()
        self.lease.hand_back()
        calls = []
        out = self.plugin.browser_middleware(tool_name="browser_click", args={"ref": "e5"}, task_id=TASK,
                                             next_call=lambda payload=None: calls.append(1))
        self.assertEqual(calls, [], "an input action with a ref from the old tab must not run")
        self.assertEqual(json.loads(out)["code"], "tab_changed_after_takeover")
        self.assertIn("where-they-went", out)
        self.assertEqual(self.session["tab_id"], "t2")

    # ---- keep-alive and session end ----

    def test_tabs_are_kept_alive_only_while_a_human_holds_the_screen(self):
        self.camofox.add("t2")
        self.camofox.add("tX", key="desktop")
        self.assertEqual(self.tabs.keepalive_once(), "agent")
        self.assertEqual(self.camofox.evaluated, [])
        self.lease.take_over()
        self.assertEqual(self.tabs.keepalive_once(), "kept 2")
        self.assertEqual({tab for tab, _ in self.camofox.evaluated}, {"t1", "t2"})

    def test_session_end_closes_the_groups_untracked_tabs(self):
        self.camofox.add("t2")
        self.camofox.add("t3")
        self.camofox.add("tX", key="task_other")
        self.plugin.pre_tool_call("browser_snapshot", {}, session_id="s1", task_id=TASK)
        self.run_tool("browser_snapshot", json.dumps({"success": True, "snapshot": "x", "element_count": 1}))
        self.sessions.clear()  # the camofox plugin's own finalize hook may run first
        self.plugin.on_session_finalize(session_id="s1")
        self.assertEqual(sorted(self.camofox.closed), ["t2", "t3"])

    def test_turn_end_closes_agent_popups_no_longer_used_but_keeps_the_opener_and_human_tabs(self):
        for new in ("t2", "t3", "t4"):  # each click opens a popup from the tab before it
            self.run_tool("browser_click", json.dumps({"success": True}), effect=lambda new=new: self.camofox.add(new))
        self.camofox.add("tH")  # a tab a human opened from the agent's page (never followed)
        self.assertEqual(self.session["tab_id"], "t4")
        self.plugin.on_session_end(session_id="s1", task_id=TASK)
        self.assertEqual(self.camofox.closed, ["t2"])  # t4 tracked, t3 its opener, t1 and tH not agent popups
        self.plugin.on_session_end(session_id="s1", task_id=TASK)
        self.assertEqual(self.camofox.closed, ["t2"])

    def test_turn_end_keeps_popups_while_waiting_for_a_human(self):
        self.run_tool("browser_click", json.dumps({"success": True}), effect=lambda: self.camofox.add("t2"))
        self.run_tool("browser_click", json.dumps({"success": True}), effect=lambda: self.camofox.add("t3"))
        self.plugin.pre_tool_call("screen_handoff", {"action": "link"}, session_id="s1", task_id=TASK)
        self.plugin.on_session_end(session_id="s1", task_id=TASK)
        self.lease.take_over()
        self.plugin.on_session_end(session_id="other", task_id=TASK)
        self.assertEqual(self.camofox.closed, [])

    def test_session_end_closes_nothing_while_a_human_holds_the_screen(self):
        self.camofox.add("t2")
        self.lease.take_over()
        self.plugin.on_session_finalize(session_id=TASK)
        self.assertEqual(self.camofox.closed, [])

    # ---- browser_tabs ----

    def tabs_tool(self, **args):
        return json.loads(self.plugin.browser_tabs_tool(args, task_id=TASK))

    def test_list_shows_only_this_sessions_tabs(self):
        self.camofox.add("t2", url="https://x.test/popup", title="Popup")
        self.camofox.add("tX", key="task_other")
        self.camofox.add("tZ", user="someone-else")
        listed = self.tabs_tool(action="list")
        self.assertEqual([t["tab_id"] for t in listed["tabs"]], ["t1", "t2"])
        self.assertEqual(listed["current_tab_id"], "t1")
        self.assertTrue(listed["tabs"][0]["current"])

    def test_switch_moves_the_tools_and_brings_the_tab_to_front(self):
        self.camofox.add("t2")
        out = self.tabs_tool(action="switch", tab_id="t2")
        self.assertTrue(out["success"])
        self.assertEqual(self.session["tab_id"], "t2")
        self.assertEqual(self.camofox.activated, ["t2"])
        self.assertFalse(self.tabs_tool(action="switch", tab_id="tX")["success"])  # not ours
        self.camofox.add("tX", key="task_other")
        self.assertFalse(self.tabs_tool(action="switch", tab_id="tX")["success"])
        self.assertEqual(self.session["tab_id"], "t2")

    def test_close_closes_own_tabs_and_falls_back_when_the_current_one_goes(self):
        self.camofox.add("t2")
        self.camofox.add("tX", key="task_other")
        self.assertFalse(self.tabs_tool(action="close", tab_id="tX")["success"])
        self.assertEqual(self.camofox.closed, [])
        out = self.tabs_tool(action="close", tab_id="t1")
        self.assertEqual(self.camofox.closed, ["t1"])
        self.assertEqual(out["current_tab_id"], "t2")
        self.assertEqual(self.session["tab_id"], "t2")

    def test_browser_tabs_output_is_password_scrubbed(self):
        self.camofox.add("t2", title=f"pw is {PW}")
        self.camofox.scan["t2"] = [PW]
        raw = self.plugin.browser_tabs_tool({"action": "list"}, task_id=TASK)
        self.assertNotIn(PW, raw)

    def test_browser_tabs_is_fenced_while_a_human_holds_the_screen(self):
        self.lease.take_over()
        blocked = self.plugin.pre_tool_call("browser_tabs", {"action": "close", "tab_id": "t1"}, session_id="s1")
        self.assertEqual(blocked["action"], "block")

    def test_browser_tabs_is_registered_in_the_camofox_toolset(self):
        class ToolCtx(helpers.Ctx):
            def __init__(self):
                super().__init__()
                self.tools = {}

            def register_tool(self, **kw):
                self.tools[kw["name"]] = kw
        ctx = ToolCtx()
        self.plugin.register(ctx)
        self.assertEqual(ctx.tools["browser_tabs"]["toolset"], "camofox")
        self.assertEqual(ctx.tools["browser_tabs"]["schema"]["parameters"]["properties"]["action"]["enum"],
                         ["list", "switch", "close"])

    # ---- screen handoff naming ----

    def test_handoff_names_camoufox_and_the_live_tab_and_brings_it_to_front(self):
        self.camofox.tabs[0]["url"] = "https://council.example/s/booking?x=1"
        self.run_tool("browser_snapshot", json.dumps({"success": True, "snapshot": "x", "element_count": 1}))
        out, payload = self.run_tool("screen_handoff", json.dumps({"ok": True, "url": "https://b.test/screen/"}),
                                     args={"action": "link", "reason": "pick a booking time"})
        self.assertEqual(payload["reason"], "pick a booking time in Camoufox (council.example/s/booking)")
        self.assertEqual(self.camofox.activated, ["t1"])
        data = json.loads(out)
        self.assertEqual((data["browser"], data["tab_url"]), ("Camoufox", "https://council.example/s/booking?x=1"))

    def test_handoff_after_browser_exec_names_chromium(self):
        self.run_tool("browser_exec", "ok", args={"code": "print(1)"})
        with mock.patch.object(self.tabs, "_chromium_url", return_value="https://accounts.example/signin"):
            _, payload = self.run_tool("screen_handoff", json.dumps({"ok": True}),
                                       args={"action": "link", "reason": "Sign in to Google"})
        self.assertEqual(payload["reason"], "Sign in to Google in Chromium (accounts.example/signin)")
        self.assertEqual(self.camofox.activated, [])

    def test_handoff_without_a_browser_and_status_calls_are_unchanged(self):
        self.sessions.clear()
        with mock.patch.object(self.tabs, "_chromium_url", return_value=""):
            _, payload = self.run_tool("screen_handoff", json.dumps({"ok": True}),
                                       args={"action": "link", "reason": "Approve the payment"}, task_id="t-none")
        self.assertIsNone(payload)
        _, payload = self.run_tool("screen_handoff", json.dumps({"ok": True}), args={"action": "status"})
        self.assertIsNone(payload)

    def test_a_long_reason_keeps_the_browser_and_stays_within_the_shown_length(self):
        reason = self.tabs.handoff_reason("x" * 200, {"browser": "Camoufox", "url": "https://h.example/" + "p" * 300})
        self.assertLessEqual(len(reason), self.tabs.REASON_MAX)
        self.assertIn("in Camoufox (h.example/", reason)

    # ---- guidance ----

    def test_steering_tells_the_agent_how_to_handle_tabs_in_both_browsers(self):
        for phrase in ("popup_opened", "browser_tabs", "list_tabs()", "switch_tab()", "close_tab()"):
            self.assertIn(phrase, self.plugin.STEERING)


class LiveProbeSourceTests(unittest.TestCase):
    PROBE = ROOT / "scripts" / "camoufox-tabs-probe.py"

    def test_live_probe_uses_a_throwaway_identity_the_real_middleware_and_cleans_up(self):
        source = self.PROBE.read_text(encoding="utf-8")
        compile(source, str(self.PROBE), "exec")
        for token in ("run_tool_execution_middleware", "manager._discovered = True", '"tabs-probe-"',
                      "lease.release(VIEWER)", "DELETE", "window.open", "popup_opened", "on_session_finalize",
                      "scrub_leaves_orphans_idle", '"/opt/hermes/plugins/camoufox-desktop"'):
            with self.subTest(token=token):
                self.assertIn(token, source)


if __name__ == "__main__":
    unittest.main()
