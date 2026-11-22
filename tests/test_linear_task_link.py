"""Kanban chat pings name a Linear-tracked task as linked text (Core's ``kanban_task_link`` hook).

The plugin answers only for a task its own native binding tracks, with the issue URL from
the task's own ``Linear issue <KEY>: <url>`` line. Anything else gets no answer, so Core
keeps the plain title. These checks need no Agent source; the Core round trip is in
tests/test_linear_core_contract_scenarios.py.
"""
from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from linear_fake_api import load_plugin

plugin = load_plugin()
from hermes_fleet_linear_plugin import chat  # noqa: E402
from hermes_fleet_linear_plugin.bridge import TASK_BODY  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402

URL = "https://linear.app/acme/issue/HF-123/fix-the-thing"
TITLE = "HF-123: Fix the thing"


def body(ident="HF-123", url=URL):
    return TASK_BODY.format(ident=ident, url=url, context="context")


class TaskLinkAnswerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "state.db"
        Store(self.path).bind_native("issue-uuid-1", "t_tracked", "alpha", "default", at=100)

    def link(self, task_id="t_tracked", board="default", title=TITLE, text=None, path=None):
        return chat.task_link(path or self.path, task_id=task_id, board=board, title=title,
                              body=body() if text is None else text)

    def test_tracked_task_is_named_as_issue_key_and_title(self):
        self.assertEqual(self.link(), {"url": URL, "text": "HF-123 Fix the thing"})

    def test_title_without_the_key_prefix_keeps_the_whole_title(self):
        self.assertEqual(self.link(title="Fix the thing"), {"url": URL, "text": "HF-123 Fix the thing"})

    def test_untracked_task_gets_no_answer(self):
        self.assertIsNone(self.link(task_id="t_other"))

    def test_binding_on_another_board_gets_no_answer(self):
        self.assertIsNone(self.link(board="ops"))

    def test_missing_state_database_gets_no_answer_and_is_not_created(self):
        missing = self.path.with_name("absent.db")
        self.assertIsNone(self.link(path=missing))
        self.assertFalse(missing.exists())

    def test_task_without_one_consistent_issue_line_gets_no_answer(self):
        self.assertIsNone(self.link(text="no issue line here"))
        self.assertIsNone(self.link(text=body() + "\n" + body("HF-124", URL.replace("HF-123", "HF-124"))))
        self.assertIsNone(self.link(text=body(url="http://linear.app/acme/issue/HF-123/x")))
        self.assertIsNone(self.link(text=body(url="https://linear.app/acme/issue/HF-999/x")))

    def test_finished_binding_still_names_its_task(self):
        """A completed ping arrives after Done; the reporting binding stays until retirement."""
        store = Store(self.path)
        store.finish("issue-uuid-1", [("status", {"issue_id": "issue-uuid-1", "task_id": "t_tracked",
                                                   "state": "done"})], at=200)
        self.assertEqual(self.link()["url"], URL)


class FakeContext:
    def __init__(self, settings):
        self.settings, self.hooks = settings, {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)

    def __getattr__(self, name):
        if name.startswith("register_") or name == "on_unload":
            return lambda *a, **k: None
        raise AttributeError(name)


def core_hooks(*names):
    package, plugins = types.ModuleType("hermes_cli"), types.ModuleType("hermes_cli.plugins")
    plugins.VALID_HOOKS = set(names)
    package.plugins = plugins
    return patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.plugins": plugins})


class TaskLinkRegistrationTests(unittest.TestCase):
    def test_registers_only_when_core_has_the_hook(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp) / "state.db"
            Store(state).bind_native("issue-uuid-1", "t_tracked", "alpha", "default", at=100)
            settings = {"enabled": True, "state_database": str(state)}
            with core_hooks("kanban_task_completed"):
                older = FakeContext(settings)
                chat.register_task_link(older, lambda: state)
            self.assertNotIn("kanban_task_link", older.hooks)
            with core_hooks("kanban_task_link"):
                current = FakeContext(settings)
                chat.register_task_link(current, lambda: state)
            [callback] = current.hooks["kanban_task_link"]
            self.assertEqual(callback(task_id="t_tracked", board="default", title=TITLE, body=body()),
                             {"url": URL, "text": "HF-123 Fix the thing"})
            self.assertIsNone(callback(task_id="t_other", board="default", title=TITLE, body=body()))

    def test_core_without_plugin_api_registers_nothing(self):
        current = FakeContext({})
        with patch.dict(sys.modules, {"hermes_cli": None, "hermes_cli.plugins": None}):
            chat.register_task_link(current, lambda: Path("unused"))
        self.assertEqual(current.hooks, {})


if __name__ == "__main__":
    unittest.main()
