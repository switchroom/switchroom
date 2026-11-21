"""HF-775: Agent Session steps read as plain words, and a worker's own note is not overwritten.

Linear shows an action activity as "<action> <parameter>". Every live step's action is "Working",
and Core's status phrase ("is running…") is written to follow a bot's name, so sessions read
"Working is running…". Steps now name only the kind of tool in plain words, still never an
argument preview. A worker's kanban_heartbeat note stays visible for a while before a generic
tool step may replace it. The worker template asks for that progress and for same-card review.
"""
from __future__ import annotations

import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

import test_linear_native_bridge_scenarios as native  # puts the pinned Agent (HERMES_AGENT_SRC) on the path
from linear_fake_api import load_plugin

load_plugin()
from hermes_fleet_linear_plugin import native_input, worker_progress  # noqa: E402
from hermes_fleet_linear_plugin.bridge import TASK_BODY, Bridge  # noqa: E402



def build_status_phrase(tool, args):
    """Core's own phrase; scripts/run-linear-scenarios.py puts the pinned Agent on the path."""
    from agent.display import build_status_phrase as core_phrase
    return core_phrase(tool, args)


@unittest.skipIf(native.CORE, f"needs the pinned Agent: {native.CORE}")
class StepPhraseTests(unittest.TestCase):
    def test_every_core_phrase_maps_to_plain_words_after_working(self):
        for tool, parameter in native_input.STEP_PARAMETERS.items():
            with self.subTest(tool=tool):
                self.assertEqual(native_input.step_phrase(build_status_phrase(tool, None)), parameter)
                self.assertFalse(parameter.startswith("is "))
                self.assertNotIn("Working", parameter)
                self.assertNotIn("…", parameter)

    def test_tools_sharing_a_core_phrase_share_one_step(self):
        by_brief: dict[str, set[str]] = {}
        for tool, parameter in native_input.STEP_PARAMETERS.items():
            by_brief.setdefault(build_status_phrase(tool, None), set()).add(parameter)
        self.assertEqual({brief: steps for brief, steps in by_brief.items() if len(steps) > 1}, {})

    def test_a_longer_exact_phrase_beats_a_shorter_prefix(self):
        # "is reading skill…" starts with "is reading ", which belongs to the file and page readers.
        self.assertEqual(native_input.step_phrase(build_status_phrase("skill_view", None)), "from a skill")
        self.assertEqual(native_input.step_phrase(build_status_phrase("read_file", {"path": "a.txt"})), "on reading")

    def test_argument_previews_never_reach_the_step(self):
        phrase = build_status_phrase("terminal", {"command": "echo PRIVATE_CANARY"})
        self.assertIn("PRIVATE_CANARY", phrase)
        self.assertEqual(native_input.step_phrase(phrase), "in the terminal")
        self.assertEqual(native_input.step_phrase("custom tool PRIVATE_CANARY"), native_input.STEP_FALLBACK)
        self.assertEqual(native_input.step_phrase(None), native_input.STEP_FALLBACK)

    def test_known_steps_are_stable_so_the_send_time_guard_accepts_them(self):
        for parameter in (*native_input.STEP_PARAMETERS.values(), native_input.STEP_FALLBACK):
            with self.subTest(parameter=parameter):
                self.assertEqual(native_input.step_phrase(parameter), parameter)
                self.assertTrue(Bridge._conversation_step_safe(
                    {"content": {"type": "action", "action": "Working", "parameter": parameter}}))

    def test_steps_queued_by_an_earlier_build_still_deliver(self):
        for parameter in (build_status_phrase("terminal", None), "Working on your request."):
            with self.subTest(parameter=parameter):
                self.assertTrue(Bridge._conversation_step_safe(
                    {"content": {"type": "action", "action": "Working", "parameter": parameter}}))

    def test_the_guard_still_refuses_free_text_and_other_actions(self):
        for content in ({"type": "action", "action": "Working", "parameter": "is running echo PRIVATE_CANARY…"},
                        {"type": "action", "action": "Working", "parameter": "anything at all"},
                        {"type": "action", "action": "Deleting", "parameter": "in the terminal"}):
            with self.subTest(content=content):
                self.assertFalse(Bridge._conversation_step_safe({"content": content}))


class WorkerNoteHoldTests(unittest.TestCase):
    """worker_progress.queue leaves a fresh heartbeat note showing; a stale one may be replaced."""

    def run_queue(self, last, now=10_000.0):
        enqueued = []
        task = SimpleNamespace(id="t_1", status="running", current_run_id=3, claim_lock="lock")
        store = SimpleNamespace(
            backoff_ready=lambda key, at: True, effect_admitted=lambda issue: True,
            latest_session_action=lambda issue, session: last,
            unsettled_worker_action=lambda issue, session: False,
            enqueue=lambda kind, payload, at: enqueued.append((kind, payload)))
        bridge = SimpleNamespace(
            store=store, clock=lambda: now, api=SimpleNamespace(optional_work=nullcontext),
            _native_effect_task=lambda issue: task, _alert_route=lambda row: {},
            _progress_activity=lambda row, route, action, parameter, ephemeral=False: (
                "activity", {"content": {"type": "action", "action": action, "parameter": parameter}}))
        row = {"issue_id": "issue-1", "owner_ref": "session-1", "task_id": "t_1"}
        adapter = SimpleNamespace(get=lambda task_id: task)
        step = {"worker_session_id": "w", "execution_generation": 1, "admission_id": "a", "run_id": 3,
                "phrase": "in the terminal"}
        with patch.object(worker_progress, "current", lambda adapter, task: step):
            worker_progress.queue(bridge, row, adapter)
        return enqueued

    def test_a_fresh_heartbeat_note_is_not_replaced_by_a_tool_step(self):
        note = {"heartbeat_note": True, "enqueued_at": 10_000.0 - 300, "_presentation_current": True}
        self.assertEqual(self.run_queue(note), [])

    def test_an_old_heartbeat_note_gives_way_to_the_current_step(self):
        note = {"heartbeat_note": True, "enqueued_at": 10_000.0 - worker_progress.NOTE_HOLD_SECONDS - 1,
                "_presentation_current": True}
        queued = self.run_queue(note)
        self.assertEqual([payload["content"]["parameter"] for _, payload in queued], ["in the terminal"])

    def test_an_earlier_tool_step_is_still_replaced_after_a_minute(self):
        step = {"enqueued_at": 10_000.0 - 120, "_presentation_current": True, "worker_step": {"phrase": "on a file"}}
        self.assertEqual(len(self.run_queue(step)), 1)


class HeartbeatNoteStoreTests(unittest.TestCase):
    def test_the_note_marker_survives_the_real_outbox(self):
        import tempfile
        from pathlib import Path
        from hermes_fleet_linear_plugin.store import Store
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "linear.db")
            note = {"issue_id": "issue-1", "session_id": "session-1", "ephemeral": True, "heartbeat_note": True,
                    "content": {"type": "action", "action": "Working", "parameter": "checking the rollout plan"}}
            self.assertTrue(store.enqueue_many([("activity", note)], at=500.0))
            latest = store.latest_session_action("issue-1", "session-1")
            self.assertIs(latest["heartbeat_note"], True)
            self.assertEqual(latest["enqueued_at"], 500.0)


class WorkerTemplateTests(unittest.TestCase):
    def test_workers_are_told_to_show_progress_between_milestones(self):
        for phrase in ("Status line says what is happening now", "indented sub-steps",
                       "at least every 15 minutes of work", "kanban_heartbeat with a one-line plain note",
                       "never becomes a comment"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, TASK_BODY)

    def test_code_changes_use_same_card_review(self):
        for phrase in ("kanban_request_review", "exact head SHA", "fresh reviewer run on this same task",
                       "required checks pass on that head", "Never create a separate review task"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, TASK_BODY)

    def test_workers_are_told_to_wait_without_sleep_loops(self):
        for phrase in ("Wait without sleep loops", "gh run watch", "--auto --match-head-commit",
                       "process_manage wait", "cronjob"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, TASK_BODY)
        TASK_BODY.format(ident="ABC-1", url="https://linear.app/x/issue/ABC-1", context="")


if __name__ == "__main__":
    unittest.main()
