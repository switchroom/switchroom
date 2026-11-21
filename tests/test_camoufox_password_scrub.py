"""camoufox-desktop keeps password-field values out of what the camofox tools return (HF-782).

camofox-browser's snapshot prints every input's value, so a password a human types during Take over
reached the model on the next browser_snapshot. These tests drive the plugin's real middleware and
hook against a small stand-in camofox-browser server on loopback (``GET /tabs``,
``POST /tabs/<id>/evaluate``) that answers the page scan the way a page holding a human-typed
password does.
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
_spec = importlib.util.spec_from_file_location("camoufox_desktop_test_helpers",
                                               ROOT / "tests" / "test_camoufox_desktop_plugin.py")
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)

HUMAN_PW = "s3cret-pw"
MASK = "«redacted-password»"
CAMOFOX_TOOLSETS = {name: "camofox" for name in (
    "browser_navigate", "browser_snapshot", "browser_console", "browser_vision", "browser_get_images",
    "browser_click", "browser_type")}


class FakeCamofox:
    """camofox-browser stand-in: tabs per userId and a canned answer to the password scan."""

    def __init__(self):
        self.tabs = {"hermes-agent": ["t1"]}
        self.scan = {"t1": {"values": [HUMAN_PW], "opaque": False}}
        self.fail_evaluate = False
        self.evaluated: list[tuple[str, str, str]] = []
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
                    return self._send(200, {"running": True,
                                            "tabs": [{"tabId": t} for t in fake.tabs.get(user, [])]})
                return self._send(404, {"error": "not found"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                tab = self.path.split("/")[2]
                fake.evaluated.append((body.get("userId"), tab, body.get("expression", "")))
                if fake.fail_evaluate:
                    return self._send(500, {"error": "boom"})
                if tab not in fake.scan:
                    return self._send(404, {"error": "Tab not found"})
                return self._send(200, {"ok": True, "result": json.dumps(fake.scan[tab])})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def snapshot_result(snapshot: str) -> str:
    return json.dumps({"success": True, "snapshot": snapshot, "element_count": 3}, ensure_ascii=False)


LOGIN_SNAPSHOT = "\n".join([
    '- heading "Sign in" [level=1]',
    '- textbox "Email" [e1]: someone@example.com',
    f'- textbox [e2]: {HUMAN_PW}',
    '- button "Sign in" [e3]',
])


class PasswordScrubTests(unittest.TestCase):
    def setUp(self):
        self.camofox = FakeCamofox()
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"HERMES_HOME": str(self.home), "CAMOFOX_URL": self.camofox.url,
                                                "CAMOFOX_CHECKPOINT_SECONDS": "0",
                                                "CAMOFOX_API_KEY": "k" * 64}, clear=False)
        self.env.start()
        os.environ.pop("CAMOFOX_USER_ID", None)
        self.toolsets = mock.patch.dict(helpers.FakeRegistry.TOOLSETS, CAMOFOX_TOOLSETS)
        self.toolsets.start()
        self.plugin, _, _, self.patcher = helpers.load_plugin(self.home)
        self.scrub = sys.modules[self.plugin.__name__ + ".password_scrub"]

    def tearDown(self):
        self.patcher.stop()
        self.toolsets.stop()
        self.env.stop()
        self.tmp.cleanup()
        self.camofox.close()

    def run_tool(self, tool_name: str, result):
        calls = []

        def next_call(payload=None):
            calls.append(payload)
            return result
        out = self.plugin.scrub_passwords(tool_name=tool_name, args={}, next_call=next_call, task_id="t")
        self.assertEqual(len(calls), 1, "the tool must run exactly once")
        return out

    # ---- the reported case ----

    def test_human_typed_password_never_reaches_the_snapshot(self):
        out = self.run_tool("browser_snapshot", snapshot_result(LOGIN_SNAPSHOT))
        self.assertNotIn(HUMAN_PW, out)
        snapshot = json.loads(out)["snapshot"]
        self.assertIn(f"- textbox [e2]: {MASK}", snapshot)
        self.assertIn("someone@example.com", snapshot)  # other fields are left alone
        self.assertIn('- button "Sign in" [e3]', snapshot)
        user, tab, expression = self.camofox.evaluated[0]
        self.assertEqual((user, tab), ("hermes-agent", "t1"))
        for selector in ("password", "current|new", "autocomplete", "shadowRoot", "contentDocument"):
            self.assertIn(selector, expression)

    def test_navigate_console_vision_and_images_are_scrubbed_too(self):
        nav = self.run_tool("browser_navigate", json.dumps({"success": True, "url": "https://x.test/login",
                                                            "title": "Login", "snapshot": LOGIN_SNAPSHOT}))
        self.assertNotIn(HUMAN_PW, nav)
        console_whole = self.run_tool("browser_console", json.dumps({"success": True, "result": HUMAN_PW}))
        self.assertEqual(json.loads(console_whole)["result"], MASK)
        console_nested = self.run_tool("browser_console", json.dumps(
            {"success": True, "result": {"fields": [f"pw={HUMAN_PW};"]}}))
        self.assertNotIn(HUMAN_PW, console_nested)
        vision = self.run_tool("browser_vision", json.dumps(
            {"success": True, "analysis": f"The password box reads {HUMAN_PW}.", "screenshot_path": "/tmp/s.png"}))
        self.assertNotIn(HUMAN_PW, vision)
        self.assertIn("/tmp/s.png", vision)
        images = self.run_tool("browser_get_images", json.dumps(
            {"success": True, "images": [{"src": "https://x.test/a.png", "alt": HUMAN_PW}], "count": 1}))
        self.assertNotIn(HUMAN_PW, images)

    def test_quoted_and_escaped_values_are_found(self):
        tricky = 'p"a\\ss: w0rd'
        self.camofox.scan["t1"] = {"values": [tricky], "opaque": False}
        line = f'- textbox "Password" [e2]: {json.dumps(tricky)}'
        out = self.run_tool("browser_snapshot", snapshot_result(line))
        self.assertNotIn("w0rd", out)
        self.assertIn(MASK, json.loads(out)["snapshot"])

    def test_short_password_is_masked_where_it_is_a_field_value_only(self):
        self.camofox.scan["t1"] = {"values": ["ab"], "opaque": False}
        out = json.loads(self.run_tool("browser_snapshot", snapshot_result(
            '- textbox "Password" [e2]: ab\n- link "about tabs" [e4]')))["snapshot"]
        self.assertIn(f'- textbox "Password" [e2]: {MASK}', out)
        self.assertIn('link "about tabs"', out)

    def test_autocomplete_new_password_values_come_from_the_scan(self):
        # The page decides which fields are password fields (type or autocomplete); every value the
        # scan returns is removed, here one from a field with autocomplete=new-password.
        self.camofox.scan["t1"] = {"values": [HUMAN_PW, "N3w-passw0rd!"], "opaque": False}
        out = self.run_tool("browser_snapshot", snapshot_result(
            LOGIN_SNAPSHOT + '\n- textbox "New password" [e5]: N3w-passw0rd!'))
        self.assertNotIn(HUMAN_PW, out)
        self.assertNotIn("N3w-passw0rd!", out)

    def test_every_agent_tab_and_tracked_session_is_scanned(self):
        self.camofox.tabs["hermes-agent"] = ["t1", "t2"]
        self.camofox.scan["t2"] = {"values": ["other-tab-pw"], "opaque": False}
        tracked = types.ModuleType("plugins.camofox.camofox_client")
        tracked._sessions = {("home", "task"): {"user_id": "task-user", "tab_id": "t3"}}
        self.camofox.scan["t3"] = {"values": ["task-tab-pw"], "opaque": False}
        with mock.patch.dict(sys.modules, {"plugins.camofox.camofox_client": tracked}):
            out = self.run_tool("browser_console", json.dumps(
                {"success": True, "result": "other-tab-pw task-tab-pw"}))
        self.assertNotIn("other-tab-pw", out)
        self.assertNotIn("task-tab-pw", out)
        self.assertEqual({tab for _, tab, _ in self.camofox.evaluated}, {"t1", "t2", "t3"})

    # ---- fail closed ----

    def test_a_failed_scan_masks_every_textbox_and_withholds_console(self):
        self.camofox.fail_evaluate = True
        out = json.loads(self.run_tool("browser_snapshot", snapshot_result(LOGIN_SNAPSHOT)))["snapshot"]
        self.assertNotIn(HUMAN_PW, out)
        self.assertNotIn("someone@example.com", out)
        self.assertIn('- button "Sign in" [e3]', out)
        console = json.loads(self.run_tool("browser_console", json.dumps({"success": True, "result": HUMAN_PW})))
        self.assertEqual(console["code"], "password_scan_failed")
        self.assertNotIn(HUMAN_PW, json.dumps(console))

    def test_an_unreachable_service_fails_closed(self):
        os.environ["CAMOFOX_URL"] = "http://127.0.0.1:9"
        out = self.run_tool("browser_snapshot", snapshot_result(LOGIN_SNAPSHOT))
        self.assertNotIn(HUMAN_PW, out)

    def test_a_failed_tool_keeps_its_error_when_the_scan_also_fails(self):
        self.camofox.fail_evaluate = True
        error = json.dumps({"success": False, "error": "Camofox is not running"})
        self.assertEqual(self.run_tool("browser_snapshot", error), error)

    def test_frames_the_scan_cannot_read_mask_textboxes_in_iframe_sections(self):
        self.camofox.scan["t1"] = {"values": [], "opaque": True}
        snap = "\n".join(['- textbox "Search" [e1]: shoes', '- iframe "login.example":',
                          '  - textbox "Password" [e7]: framed-secret', '- button "Go" [e9]'])
        out = json.loads(self.run_tool("browser_snapshot", snapshot_result(snap)))["snapshot"]
        self.assertNotIn("framed-secret", out)
        self.assertIn('- textbox "Search" [e1]: shoes', out)
        self.assertIn('- button "Go" [e9]', out)

    def test_a_scrub_bug_withholds_the_output(self):
        with mock.patch.object(self.scrub, "_walk", side_effect=RuntimeError("bug")):
            out = json.loads(self.run_tool("browser_snapshot", snapshot_result(LOGIN_SNAPSHOT)))
        self.assertEqual(out["code"], "password_scrub_failed")

    def test_too_many_tabs_fails_closed(self):
        self.camofox.tabs["hermes-agent"] = [f"t{i}" for i in range(self.scrub.MAX_TABS + 1)]
        out = json.loads(self.run_tool("browser_snapshot", snapshot_result(LOGIN_SNAPSHOT)))["snapshot"]
        self.assertNotIn(HUMAN_PW, out)

    # ---- the stored full snapshot ----

    def test_the_stored_full_snapshot_file_is_scrubbed(self):
        cache = self.home / "cache" / "web"
        cache.mkdir(parents=True)
        stored = cache / "camofox-snapshot-abc123.txt"
        stored.write_text(LOGIN_SNAPSHOT * 3, encoding="utf-8")
        outside = self.home / "config.yaml"
        outside.write_text(f"x: {HUMAN_PW}\n")
        note = f'\n[... 9 more lines truncated — full snapshot: read_file path="{stored}" offset=5 limit=200]'
        self.run_tool("browser_snapshot", snapshot_result(LOGIN_SNAPSHOT + note))
        self.assertNotIn(HUMAN_PW, stored.read_text(encoding="utf-8"))
        self.assertIn(MASK, stored.read_text(encoding="utf-8"))
        # A path in page-adjacent text never points the scrub outside the snapshot cache.
        note = f'\n[... 9 more lines truncated — full snapshot: read_file path="{outside}" offset=5 limit=200]'
        self.run_tool("browser_snapshot", snapshot_result(LOGIN_SNAPSHOT + note))
        self.assertEqual(outside.read_text(), f"x: {HUMAN_PW}\n")

    # ---- scope ----

    def test_other_tools_and_chromium_are_untouched(self):
        raw = json.dumps({"success": True, "output": HUMAN_PW})
        self.assertEqual(self.run_tool("browser_exec", raw), raw)
        self.assertEqual(self.run_tool("browser_click", raw), raw)
        with mock.patch.dict(helpers.FakeRegistry.TOOLSETS, {"browser_snapshot": "browser"}):
            self.assertEqual(self.run_tool("browser_snapshot", raw), raw)  # Chromium's snapshot tool
        self.assertEqual(self.camofox.evaluated, [])

    def test_a_tool_exception_propagates(self):
        def next_call(payload=None):
            raise ValueError("tool broke")
        with self.assertRaises(ValueError):
            self.plugin.scrub_passwords(tool_name="browser_snapshot", next_call=next_call)

    def test_clean_output_is_returned_byte_for_byte(self):
        self.camofox.scan["t1"] = {"values": [], "opaque": False}
        raw = snapshot_result(LOGIN_SNAPSHOT.replace(HUMAN_PW, "").replace("[e2]: ", "[e2]"))
        self.assertEqual(self.run_tool("browser_snapshot", raw), raw)

    # ---- registration ----

    def test_middleware_is_used_when_core_has_it_else_the_hook(self):
        class MiddlewareCtx(helpers.Ctx):
            def __init__(self):
                super().__init__()
                self.middleware = {}

            def register_middleware(self, kind, fn):
                self.middleware[kind] = fn

        core = types.ModuleType("hermes_cli.middleware")
        core.VALID_MIDDLEWARE = {"tool_request", "tool_execution"}
        with mock.patch.dict(sys.modules, {"hermes_cli": types.ModuleType("hermes_cli"),
                                           "hermes_cli.middleware": core}):
            ctx = MiddlewareCtx()
            self.plugin.register(ctx)
        self.assertIs(ctx.middleware["tool_execution"], self.plugin.scrub_passwords)
        self.assertNotIn("transform_tool_result", ctx.hooks)
        with mock.patch.dict(sys.modules, {"hermes_cli.middleware": None}):
            ctx = MiddlewareCtx()
            self.plugin.register(ctx)
        self.assertEqual(ctx.middleware, {})
        out = ctx.hooks["transform_tool_result"](tool_name="browser_snapshot",
                                                 result=snapshot_result(LOGIN_SNAPSHOT))
        self.assertNotIn(HUMAN_PW, out)
        self.assertIsNone(ctx.hooks["transform_tool_result"](tool_name="terminal", result="x"))


class LiveSmokeSourceTests(unittest.TestCase):
    SMOKE = ROOT / "scripts" / "camoufox-password-smoke.py"

    def test_live_smoke_types_like_a_human_and_uses_the_real_middleware_chain(self):
        source = self.SMOKE.read_text(encoding="utf-8")
        compile(source, str(self.SMOKE), "exec")
        for token in ("XTestFakeKeyEvent", "run_tool_execution_middleware", "register_vault_redaction_value",
                      '"/opt/hermes/plugins/camoufox-desktop"', "password-smoke-", "DELETE",
                      "manager._discovered = True"):
            with self.subTest(token=token):
                self.assertIn(token, source)


if __name__ == "__main__":
    unittest.main()
