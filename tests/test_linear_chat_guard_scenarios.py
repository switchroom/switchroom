"""Chat guard through the real pinned core fire-sites, not hand-built hook kwargs.

The plugin registers through the official PluginContext; the turn is driven by core's own
pre_llm_call collector (agent.turn_context), the pre_tool_call dispatcher with the agent loop's
identity kwargs (agent.inline_tool_executors.tool_hook_ids) and core's post_tool_call emitter
(model_tools). This proves the
hook names and keyword contracts the guard relies on. It does not claim a deployed chat round-trip.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from linear_fake_api import load_plugin

SOURCE = os.environ.get("HERMES_AGENT_SRC")
if SOURCE:
    sys.path.insert(0, SOURCE)
plugin = load_plugin()
from hermes_fleet_linear_plugin import guard  # noqa: E402

TAKEOVER_CASE = "Take over QA-9 from Atlas and finish it."


@unittest.skipUnless(SOURCE, "requires explicit official HERMES_AGENT_SRC")
class ChatGuardCoreFireSiteTests(unittest.TestCase):
    def setUp(self) -> None:
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
        from hermes_cli import plugins
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("HERMES_KANBAN_") and key != "HERMES_DELEGATED_CHILD_CONTEXT"}
        environment.update(HERMES_HOME=str(self.home), _HERMES_GATEWAY="")
        env = patch.dict(os.environ, environment, clear=True)
        env.start()
        self.addCleanup(env.stop)
        token = set_hermes_home_override(self.home)
        self.addCleanup(reset_hermes_home_override, token)
        # Slack grants the linear toolset; Telegram does not (core's per-platform toolset resolution).
        (self.home / "config.yaml").write_text(
            "plugins:\n  entries:\n    linear:\n      settings:\n        enabled: true\n"
            "platform_toolsets:\n  slack: [linear, terminal]\n  telegram: [terminal]\n")
        self.manager = PluginManager(scope_key=str(self.home))
        self.addCleanup(self.manager.unload)
        plugin.register(PluginContext(PluginManifest(name="linear"), self.manager))
        delivery = patch.object(plugins, "_delivery_manager", lambda: self.manager)
        delivery.start()
        self.addCleanup(delivery.stop)
        self.agent = SimpleNamespace(session_id="sess-1", model="m", platform="slack", _parent_session_id=None,
                                     _user_id="U1", _persist_disabled=False, _current_turn_id="",
                                     _current_api_request_id="",
                                     # Core's post_llm_call review_signals contract reads these counters.
                                     _iters_since_skill=0, _turns_since_memory=0,
                                     _skill_nudge_interval=0, _memory_nudge_interval=0,
                                     valid_tool_names=set())

    def end_turn(self, message: str, turn_id: str) -> None:
        import logging
        from agent.turn_finalizer import _apply_output_hooks
        _apply_output_hooks(self.agent, "done", logging.getLogger("test"), platform=self.agent.platform,
                            effective_task_id="task-1", turn_id=turn_id, original_user_message=message, messages=[])

    def begin_turn(self, message: str, turn_id: str) -> None:
        import inspect
        from agent.turn_context import _collect_pre_llm_call_context
        self.agent._current_turn_id = turn_id
        # Newer cores also collect pre_llm_call vetoes; the guard never returns one.
        vetoes = {"blocks": []} if "blocks" in inspect.signature(_collect_pre_llm_call_context).parameters else {}
        context = _collect_pre_llm_call_context(
            self.agent, effective_task_id="task-1", turn_id=turn_id, original_user_message=message,
            messages=[], conversation_history=[], **vetoes)
        self.assertEqual(vetoes.get("blocks", []), [])
        self.assertEqual(context, "")  # the guard injects nothing into the prompt

    def gate(self, tool: str, args: dict | None = None) -> str | None:
        # Exactly agent.tool_executor._pre_tool_block's call (that module needs the full Agent
        # dependency set): core identity kwargs from tool_hook_ids into the real dispatcher.
        from agent.inline_tool_executors import tool_hook_ids
        from hermes_cli.plugins import _dispatch_pre_tool_call_hooks
        block, _ = _dispatch_pre_tool_call_hooks(tool, args or {}, **tool_hook_ids(self.agent, "task-1", "call-1"),
                                                 middleware_trace=[])
        return block

    def test_registered_through_core_hook_table(self) -> None:
        from hermes_cli.plugins import VALID_HOOKS
        self.assertTrue({"pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call"} <= VALID_HOOKS)
        self.assertTrue({"pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call"}
                        <= set(self.manager._hooks))

    def test_core_turn_blocks_inline_work_then_releases_on_work_on(self) -> None:
        from model_tools import _emit_post_tool_call_hook
        self.begin_turn(TAKEOVER_CASE, "sess-1:task-1:aaaa1111")
        for _ in range(guard.GRACE_TOOL_CALLS):
            self.assertIsNone(self.gate("terminal", {"command": "sleep 60"}))
        block = self.gate("terminal", {"command": "sleep 60"})
        self.assertIsNotNone(block)
        self.assertIn('"action": "work_on", "issue": "QA-9"', block)
        self.assertIsNone(self.gate("linear", {"action": "status", "issue": "QA-9"}))
        self.assertIsNone(self.gate("kanban_show", {"task_id": "t_1"}))
        from linear_fake_api import work_on_reply
        _emit_post_tool_call_hook(function_name="linear", function_args={"action": "work_on", "issue": "QA-9"},
                                  result=work_on_reply(), task_id="task-1",
                                  session_id="sess-1", tool_call_id="call-2", turn_id="sess-1:task-1:aaaa1111")
        self.assertIsNone(self.gate("terminal", {"command": "true"}))

    def test_reachability_follows_core_platform_toolsets(self) -> None:
        self.assertTrue(guard.linear_reachable("slack"))
        self.assertFalse(guard.linear_reachable("telegram"))

    def test_core_turn_end_releases(self) -> None:
        turn = "sess-1:task-1:eeee5555"
        self.begin_turn(TAKEOVER_CASE, turn)
        for _ in range(guard.GRACE_TOOL_CALLS):
            self.gate("terminal")
        self.assertIsNotNone(self.gate("terminal"))
        self.end_turn(TAKEOVER_CASE, turn)
        self.assertIsNone(self.gate("terminal"))

    def test_platform_without_the_linear_tool_is_never_armed(self) -> None:
        self.agent.platform = "telegram"
        self.begin_turn(TAKEOVER_CASE, "sess-1:task-1:ffff6666")
        for _ in range(guard.GRACE_TOOL_CALLS + 3):
            self.assertIsNone(self.gate("terminal"))

    def test_linear_platform_turn_is_never_armed(self) -> None:
        self.agent.platform = "linear"
        self.begin_turn(TAKEOVER_CASE, "sess-1:task-1:bbbb2222")
        for _ in range(guard.GRACE_TOOL_CALLS + 3):
            self.assertIsNone(self.gate("terminal"))

    def test_next_turn_status_question_is_not_blocked(self) -> None:
        self.begin_turn(TAKEOVER_CASE, "sess-1:task-1:cccc3333")
        for _ in range(guard.GRACE_TOOL_CALLS + 1):
            self.gate("terminal")
        self.begin_turn("what's the status of QA-9?", "sess-1:task-2:dddd4444")
        for _ in range(guard.GRACE_TOOL_CALLS + 3):
            self.assertIsNone(self.gate("terminal"))


if __name__ == "__main__":
    unittest.main()
