"""screen-handoff: the screen_handoff tool and the automatic take-back hook, driven against stand-ins
for Hermes' lease, runtime and config modules (no Hermes checkout needed)."""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "screen-handoff"
CONTRACT = ROOT / "contracts" / "plugins.json"


class FakeLease:
    AGENT, HUMAN = "agent", "human"

    def __init__(self, holder="agent"):
        self.holder, self.epoch, self.since, self.reason = holder, 1, None, None

    def get(self):
        return types.SimpleNamespace(holder=self.holder, epoch=self.epoch, since=self.since, reason=self.reason)

    def release(self, who, unless_human=True):
        if self.holder == self.HUMAN and not unless_human:
            self.holder, self.epoch = self.AGENT, self.epoch + 1
        return self.get()


class FakeRuntime:
    def __init__(self, running=False, fail=None):
        self.running, self.fail, self.starts = running, fail, 0

    def is_running(self):
        return self.running

    def start(self):
        if self.fail:
            raise RuntimeError(self.fail)
        self.starts += 1
        self.running = True


class Ctx:
    def __init__(self):
        self.tools, self.hooks = {}, {}

    def register_tool(self, **kw):
        self.tools[kw["name"]] = kw

    def register_hook(self, name, fn):
        self.hooks[name] = fn


def load():
    spec = importlib.util.spec_from_file_location("screen_handoff_under_test", PLUGIN / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ScreenHandoffTests(unittest.TestCase):
    def setUp(self):
        self.mod = load()
        self.lease, self.runtime = FakeLease(), FakeRuntime()
        pkg = types.ModuleType("tools"); pkg.__path__ = []
        desk = types.ModuleType("tools.bot_desktop"); desk.__path__ = []
        desk.lease, desk.runtime = self.lease, self.runtime
        patcher = mock.patch.dict(sys.modules, {"tools": pkg, "tools.bot_desktop": desk,
                                                "tools.bot_desktop.lease": self.lease,
                                                "tools.bot_desktop.runtime": self.runtime})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cfg = {"webapp": {"public_url": "https://agent.example.com"}}
        p = mock.patch.object(self.mod, "_config", lambda: self.cfg)
        p.start()
        self.addCleanup(p.stop)

    def call(self, **args):
        return json.loads(self.mod.handle_tool(args))

    def test_register_adds_browser_tool_and_hook(self):
        ctx = Ctx()
        self.mod.register(ctx)
        self.assertEqual(ctx.tools["screen_handoff"]["toolset"], "browser")
        self.assertIn("post_gateway_admission", ctx.hooks)

    def test_link_starts_screen_and_returns_url(self):
        out = self.call(action="link", reason="Sign in")
        self.assertTrue(out["ok"])
        self.assertEqual(out["url"], "https://agent.example.com/")
        self.assertTrue(out["started"])
        self.assertEqual(self.runtime.starts, 1)
        self.assertIn("Take over to Sign in", out["instructions"])
        self.assertIn("Bots, then the bot", out["instructions"])

    def test_link_does_not_restart_a_running_screen(self):
        self.runtime.running = True
        out = self.call(action="link")
        self.assertFalse(out["started"])
        self.assertEqual(self.runtime.starts, 0)

    def test_screen_page_url_uses_short_instructions(self):
        self.cfg["plugins"] = {"config": {"screen-handoff": {"url": "https://agent.example.com/screen"}}}
        out = self.call(action="link")
        self.assertEqual(out["url"], "https://agent.example.com/screen/")
        self.assertNotIn("Bots, then", out["instructions"])

    def test_link_without_https_url_fails_cleanly(self):
        for cfg in ({}, {"webapp": {"public_url": "http://agent.example.com"}}):
            self.cfg = cfg
            out = self.call(action="link")
            self.assertFalse(out["ok"])
            self.assertIn("webapp.public_url", out["error"])
        self.assertEqual(self.runtime.starts, 0)

    def test_link_reports_start_failure_but_still_gives_url(self):
        self.runtime.fail = "no display"
        out = self.call(action="link")
        self.assertTrue(out["ok"])
        self.assertFalse(out["running"])
        self.assertEqual(out["start_error"], "no display")
        self.assertIn(out["url"], out["instructions"])

    def test_status_and_unknown_action(self):
        out = self.call(action="status")
        self.assertEqual((out["running"], out["lease"]["holder"]), (False, "agent"))
        self.assertFalse(self.call(action="bogus")["ok"])
        self.assertFalse(self.call()["ok"])

    def test_take_back_only_changes_a_human_lease(self):
        self.assertFalse(self.call(action="take_back")["changed"])
        self.lease.holder = "human"
        out = self.call(action="take_back")
        self.assertTrue(out["changed"])
        self.assertEqual(self.lease.holder, "agent")

    def test_admission_hook_takes_control_back(self):
        self.lease.holder = "human"
        self.assertIsNone(self.mod.on_post_gateway_admission(platform="chat", message_id="1"))
        self.assertEqual(self.lease.holder, "agent")

    def test_admission_hook_respects_opt_out_and_never_raises(self):
        self.cfg["plugins"] = {"config": {"screen-handoff": {"auto_take_back": False}}}
        self.lease.holder = "human"
        self.mod.on_post_gateway_admission()
        self.assertEqual(self.lease.holder, "human")
        self.cfg = {}
        with mock.patch.object(self.mod, "take_back", side_effect=RuntimeError("boom")):
            self.assertIsNone(self.mod.on_post_gateway_admission())


class PublicShapeTests(unittest.TestCase):
    def test_manifest_readme_and_contract(self):
        manifest = (PLUGIN / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn("name: screen-handoff", manifest)
        self.assertIn("author: Hermes Fleet Contributors", manifest)
        self.assertTrue((PLUGIN / "README.md").is_file())
        contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        matches = [c for c in contract["components"] if c["id"] == "screen-handoff"]
        self.assertEqual(len(matches), 1)
        self.assertIs(matches[0]["default_enabled"], False)
        self.assertEqual(matches[0]["default_role"], "off")

    def test_source_carries_no_deployment_identity(self):
        private = re.compile(r"pixsoul|kenthompson|westpac|deploy/screen-edge|sign in with google", re.I)
        for path in PLUGIN.iterdir():
            self.assertIsNone(private.search(path.read_text(encoding="utf-8")), path.name)


if __name__ == "__main__":
    unittest.main()
