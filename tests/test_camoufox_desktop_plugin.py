"""camoufox-desktop: the Bot Desktop glue around the official camofox plugin (HF-773).

The plugin is driven through its real hooks against small stand-ins for Hermes' lease, runtime and
registry modules, so these tests need no Hermes checkout: Take over blocks the camofox tools and
vault writes (and nothing else), a camofox call starts the screen and stamps activity, the first
turn after hand-back is told once, steering is registered, and the dock edit is idempotent.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "camoufox-desktop"
CORE_PANEL = """<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <value type="int" value="2"/>
    <property name="panel-2" type="empty">
      <property name="size" type="uint" value="44"/>
      <property name="plugin-ids" type="array"><value type="int" value="21"/><value type="int" value="22"/></property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu"/>
    <property name="plugin-21" type="string" value="launcher"><property name="items" type="array"><value type="string" value="hermes.desktop"/></property></property>
  </property>
</channel>
"""


class FakeLease:
    AGENT = "agent"
    HUMAN = "human"

    class HumanHasControl(RuntimeError):
        pass

    def __init__(self):
        self.holder, self.epoch = self.AGENT, 1

    def get(self):
        return types.SimpleNamespace(holder=self.holder, epoch=self.epoch)

    def take_over(self):
        self.holder, self.epoch = self.HUMAN, self.epoch + 1

    def hand_back(self):
        self.holder, self.epoch = self.AGENT, self.epoch + 1

    def assert_agent_may_act(self):
        if self.holder == self.HUMAN:
            raise self.HumanHasControl("A human has taken over this desktop.")
        return self.get()


class FakeRuntime:
    def __init__(self):
        self.started = 0
        self.touched = 0
        self.env: dict[str, str] = {}

    def ensure_started_for_tool(self):
        self.started += 1

    def touch_activity(self):
        self.touched += 1

    def published_env(self):
        return dict(self.env)


class FakeRegistry:
    TOOLSETS = {"browser_navigate": "camofox", "browser_click": "camofox", "browser_exec": "browser-use",
                "terminal": "terminal", "screen_handoff": "browser", "browser_vault": "browser"}

    def get_toolset_for_tool(self, name):
        return self.TOOLSETS.get(name)


def load_plugin(home: Path):
    lease, runtime = FakeLease(), FakeRuntime()
    bot_desktop = types.ModuleType("tools.bot_desktop")
    bot_desktop.lease, bot_desktop.runtime = lease, runtime
    tools_pkg = types.ModuleType("tools")
    tools_pkg.bot_desktop = bot_desktop
    registry_mod = types.ModuleType("tools.registry")
    registry_mod.registry = FakeRegistry()
    constants = types.ModuleType("hermes_constants")
    constants.get_hermes_home = lambda: str(home)
    modules = {"tools": tools_pkg, "tools.bot_desktop": bot_desktop, "tools.bot_desktop.lease": lease,
               "tools.bot_desktop.runtime": runtime, "tools.registry": registry_mod,
               "hermes_constants": constants}
    patcher = mock.patch.dict(sys.modules, modules)
    patcher.start()
    name = f"camoufox_desktop_under_test_{id(home)}"
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "__init__.py",
                                                  submodule_search_locations=[str(PLUGIN)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module, lease, runtime, patcher


class Ctx:
    def __init__(self):
        self.hooks: dict[str, object] = {}
        self.sections: list[tuple[str, str, str]] = []

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_system_prompt_section(self, id, content, *, position="after_memory", max_chars=4000):  # noqa: A002
        self.sections.append((id, content, position))


class PluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"HERMES_HOME": str(self.home),
                                                "CAMOFOX_URL": "http://127.0.0.1:9377"}, clear=False)
        self.env.start()
        for name in ("CAMOFOX_API_KEY", "CAMOFOX_USER_ID"):
            os.environ.pop(name, None)
        self.plugin, self.lease, self.runtime, self.patcher = load_plugin(self.home)

    def tearDown(self):
        self.patcher.stop()
        self.env.stop()
        self.tmp.cleanup()

    def test_register_wires_hooks_steering_key_and_identity(self):
        ctx = Ctx()
        self.plugin.register(ctx)
        self.assertEqual(set(ctx.hooks), {"pre_tool_call", "pre_llm_call"})
        (section_id, text, position), = ctx.sections
        self.assertEqual(section_id, "camoufox-desktop.browsers")
        self.assertEqual(position, "after_memory")
        for phrase in ("Camoufox is the primary browser", "browser_exec is the backup", "CAPTCHA"):
            self.assertIn(phrase, text)
        key_file = self.home / "camofox-browser" / "access-key"
        self.assertEqual(os.environ["CAMOFOX_API_KEY"], key_file.read_text().strip())
        self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)
        self.assertGreaterEqual(len(os.environ["CAMOFOX_API_KEY"]), 32)
        self.assertEqual(os.environ["CAMOFOX_USER_ID"], "hermes-agent")

    def test_existing_key_and_explicit_identity_are_kept(self):
        key_file = self.home / "camofox-browser" / "access-key"
        key_file.parent.mkdir(parents=True)
        key_file.write_text("k" * 64 + "\n")
        os.environ["CAMOFOX_USER_ID"] = "ops-main"
        self.plugin.configure_environment(self.home)
        self.assertEqual(os.environ["CAMOFOX_API_KEY"], "k" * 64)
        self.assertEqual(os.environ["CAMOFOX_USER_ID"], "ops-main")
        self.assertEqual(self.plugin.user_id(), "ops-main")

    def test_no_local_service_means_no_wiring(self):
        os.environ.pop("CAMOFOX_URL")
        self.plugin.configure_environment(self.home)
        self.assertNotIn("CAMOFOX_API_KEY", os.environ)
        self.assertFalse((self.home / "camofox-browser").exists())

    def test_take_over_blocks_camofox_tools_and_vault_writes_only(self):
        hook = self.plugin.pre_tool_call
        self.assertIsNone(hook("browser_navigate", {"url": "https://example.com"}, session_id="s1"))
        self.assertEqual(self.runtime.started, 1)
        self.assertEqual(self.runtime.touched, 1)
        self.lease.take_over()
        blocked = hook("browser_click", {"ref": "e1"}, session_id="s1")
        self.assertEqual(blocked["action"], "block")
        self.assertEqual(json.loads(blocked["message"])["code"], "human_has_control")
        vault = hook("browser_vault", {"action": "fill"}, session_id="s1")
        self.assertEqual(vault["action"], "block")
        self.assertIsNone(hook("browser_vault", {"action": "list"}, session_id="s1"))
        self.assertIsNone(hook("browser_exec", {"code": "print(1)"}, session_id="s1"))
        self.assertIsNone(hook("terminal", {"command": "ls"}, session_id="s1"))
        self.lease.hand_back()
        self.assertIsNone(hook("browser_click", {"ref": "e1"}, session_id="s1"))

    def test_hand_back_note_is_sent_once_to_the_waiting_session(self):
        self.lease.take_over()
        self.plugin.pre_tool_call("browser_type", {"ref": "e1", "text": "x"}, session_id="s1")
        self.assertIsNone(self.plugin.pre_llm_call(session_id="s1"))  # human still holds it
        self.assertIsNone(self.plugin.pre_llm_call(session_id="other"))
        self.lease.hand_back()
        with mock.patch.object(self.plugin, "_checkpoint_async") as checkpoint:
            note = self.plugin.pre_llm_call(session_id="s1")
        self.assertIn("handed control back", note["context"])
        checkpoint.assert_called_once()
        self.assertIsNone(self.plugin.pre_llm_call(session_id="s1"))

    def test_screen_handoff_link_waits_for_hand_back_too(self):
        self.assertIsNone(self.plugin.pre_tool_call("screen_handoff", {"action": "link"}, session_id="s2"))
        self.lease.take_over()
        self.lease.hand_back()
        with mock.patch.object(self.plugin, "_checkpoint_async"):
            self.assertIn("context", self.plugin.pre_llm_call(session_id="s2"))

    def test_a_broken_runtime_never_takes_the_browser_away(self):
        self.runtime.ensure_started_for_tool = mock.Mock(side_effect=RuntimeError("no display"))
        self.assertIsNone(self.plugin.pre_tool_call("browser_navigate", {}, session_id="s1"))
        self.lease.take_over()
        self.assertEqual(self.plugin.pre_tool_call("browser_navigate", {}, session_id="s1")["action"], "block")


class DockTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("camoufox_dock_under_test", PLUGIN / "dock.py")
        self.dock = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.dock)
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_unseeded_panel_is_left_for_core(self):
        self.assertEqual(self.dock.ensure_dock_icon(self.home, "ops-main"), "not_seeded")

    def test_stopped_screen_panel_gets_one_launcher_idempotently(self):
        xml = self.dock.panel_xml(self.home)
        xml.parent.mkdir(parents=True)
        xml.write_text(CORE_PANEL)
        self.assertEqual(self.dock.ensure_dock_icon(self.home, "ops-main"), "added")
        text = xml.read_text()
        self.assertIn('<value type="int" value="21"/><value type="int" value="22"/><value type="int" value="23"/>', text)
        self.assertEqual(text.count('name="plugin-23"'), 1)
        self.assertIn('value="camoufox.desktop"', text)
        self.assertIn('name="plugin-21"', text)
        self.assertEqual(self.dock.ensure_dock_icon(self.home, "ops-main"), "present")
        self.assertEqual(xml.read_text(), text)
        entry = (self.dock.launcher_dir(self.home) / "camoufox.desktop").read_text()
        self.assertIn("Icon=camoufox", entry)
        self.assertIn("camoufox-open --user ops-main", entry)

    def test_unknown_layout_is_not_rewritten(self):
        xml = self.dock.panel_xml(self.home)
        xml.parent.mkdir(parents=True)
        xml.write_text("<channel/>\n")
        self.assertEqual(self.dock.ensure_dock_icon(self.home, "x"), "unrecognised_layout")
        self.assertEqual(xml.read_text(), "<channel/>\n")


class LauncherTests(unittest.TestCase):
    def test_open_or_raise_reuses_the_newest_tab_then_opens_one(self):
        spec = importlib.util.spec_from_file_location("camoufox_local_under_test", PLUGIN / "camoufox_local.py")
        local = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(local)
        calls = []

        def fake(method, path, body=None, timeout=None):
            calls.append((method, path, body))
            if path.startswith("/tabs?"):
                return {"tabs": tabs}
            if path == "/tabs":
                return {"tabId": "new"}
            return {"ok": True}

        client = local.Client(url="http://127.0.0.1:9377", key="k" * 32)
        client.request = fake
        tabs = [{"tabId": "old"}, {"tabId": "newest"}]
        self.assertEqual(client.open_or_raise("ops-main"), "newest")
        self.assertEqual(calls[-1], ("POST", "/tabs/newest/activate", {"userId": "ops-main"}))
        tabs = []
        calls.clear()
        self.assertEqual(client.open_or_raise("ops-main"), "new")
        self.assertEqual(calls[1][2]["sessionKey"], "desktop")
        self.assertTrue(calls[1][2]["url"].startswith("https://"))
        self.assertEqual(calls[-1][1], "/tabs/new/activate")


if __name__ == "__main__":
    unittest.main()
