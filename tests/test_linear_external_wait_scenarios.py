"""HF-788: blocks that wait on the world clear themselves, and say who they wait on.

Real native task store (Core at HERMES_AGENT_SRC), real bridge, fake Linear over HTTP.
Run with HERMES_AGENT_SRC pointing at the clean manifest-pinned Hermes checkout.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from linear_fake_api import Clock, FakeLinear, load_plugin

SOURCE = os.environ.get("HERMES_AGENT_SRC", "")
CORE = None
try:
    if not SOURCE:
        raise ImportError("HERMES_AGENT_SRC is not set")
    sys.path.insert(0, SOURCE)
    from hermes_cli import kanban_db as kb
except Exception as exc:
    CORE = str(exc)

plugin = load_plugin()
from hermes_fleet_linear_plugin import waits  # noqa: E402
from hermes_fleet_linear_plugin.api import LinearAPI  # noqa: E402
from hermes_fleet_linear_plugin.bridge import Bridge, Kanban, _block_message  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402

ISSUE = "issue-550"
GAP = waits.EXTERNAL_WAIT_GAP + 100  # past the jittered recheck gap


class WaitsParse(unittest.TestCase):
    def rekinded(self, reason, **extra):
        return {"kind": "needs_input", "requested_kind": "dependency", "rekind_reason": "no_open_parent",
                "reason": reason, **extra}

    def test_cross_issue_wait_is_a_dependency_not_a_question(self):
        kind, body = _block_message(self.rekinded("Waiting on LIFE-646 and LIFE-532 to land."), "blocked")
        self.assertEqual(kind, "thought")  # a thought does not put the session in "Waiting on you"
        self.assertIn("Blocked on LIFE-646, LIFE-532", body)
        self.assertNotIn("Waiting on you", body)

    def test_a_real_question_and_an_uncheckable_dependency_still_ask_a_person(self):
        question = {"kind": "needs_input", "reason": "Waiting on LIFE-646? Which region?"}
        self.assertTrue(_block_message(question, "blocked")[1].startswith("**Waiting on you**"))
        vague = self.rekinded("Waiting for the other thing to finish.")
        self.assertTrue(_block_message(vague, "blocked")[1].startswith("**Waiting on you**"))

    def test_gate_lines_parse_and_stay_inside_the_plugins_directory(self):
        wait = waits.parse(self.rekinded("Merged.\nDelivery gate: linear/bridge.py contains _resume_external_wait"))
        self.assertEqual(wait, {"issues": [], "gates": [("linear/bridge.py", "_resume_external_wait")], "ci": []})
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "p").mkdir()
            (Path(root) / "p" / "f.py").write_text("x = 1\n")
            (Path(root) / "secret.txt").write_text("x = 1\n")
            self.assertTrue(waits.gate_met(Path(root), "p/f.py", "x = 1"))
            self.assertFalse(waits.gate_met(Path(root), "p/f.py", "y = 2"))
            self.assertFalse(waits.gate_met(Path(root), "p/missing.py", "x"))
            self.assertFalse(waits.gate_met(Path(root) / "p", "../secret.txt", "x = 1"))


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class ExternalWaitScenarios(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="linear-waits-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        environment = {key: value for key, value in os.environ.items() if not key.startswith("HERMES_KANBAN_") and key != "HERMES_DELEGATED_CHILD_CONTEXT"}
        environment.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home / "board"), HERMES_PROFILE="default")
        env = patch.dict(os.environ, environment, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.board = Kanban(profile="default", profile_home=self.home)
        self.clock = Clock()
        self.remote = FakeLinear(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_issue(ISSUE, "LIFE-550", project=None)
        self.remote.set_state(ISSUE, "Backlog")
        for ident in ("LIFE-646", "LIFE-532"):
            self.remote.add_issue("issue-" + ident[-3:], ident, project=None)
        self.reporter = Bridge(Store(self.home / "linear.db"), LinearAPI(lambda: "synthetic", endpoint=self.remote.url, clock=self.clock),
                               self.board, profile="default", clock=self.clock)
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            self.task_id = kb.create_task(conn, title="Cross-issue work", assignee="default", initial_status="blocked")
        self.reporter.track(ISSUE, self.task_id)
        self.advance(1)
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            kb.unblock_task(conn, self.task_id)
        self.reporter.pump_kanban()

    def advance(self, seconds):
        self.clock.now += seconds

    def block(self, reason):
        self.advance(1)
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            self.assertTrue(kb.block_task(conn, self.task_id, reason=reason, kind="dependency"))
        self.reporter.pump_kanban()
        self.advance(10)
        self.reporter.flush()

    def pump_after_gap(self):
        self.advance(GAP)
        self.reporter.pump_kanban()

    def status(self):
        return self.board.get(self.task_id).status

    def test_cross_issue_blocker_shows_as_a_dependency_and_resumes_when_both_close(self):
        self.block("Waiting on LIFE-646 and LIFE-532 before this can ship.")
        self.assertEqual(self.status(), "blocked")
        bodies = self.remote.bodies(ISSUE)
        self.assertTrue(any("Blocked on LIFE-646, LIFE-532" in body for body in bodies), bodies)
        self.assertFalse(any("Waiting on you" in body for body in bodies), bodies)

        self.remote.set_state("issue-646", "Done")  # one of two: still waiting
        self.pump_after_gap()
        self.assertEqual(self.status(), "blocked")

        self.remote.set_state("issue-532", "Canceled")
        self.pump_after_gap()
        self.assertEqual(self.status(), "ready")
        unblocked = [e for e in self.board.history(self.task_id, 0) if e.kind == "unblocked"]
        self.assertEqual(len(unblocked), 2)  # setup's resume, then this one (upstream's plain unblock)
        events = self.board.history(self.task_id, 0)
        self.assertEqual(events[-1].id, unblocked[-1].id)
        self.assertEqual(events[-2].id, [e for e in events if e.kind == "blocked"][-1].id)  # the wait was newest
        self.reporter.flush()
        self.assertTrue(any("done. The agent continues" in body for body in self.remote.bodies(ISSUE)))

    def test_a_vague_dependency_stays_a_question_and_is_never_resumed(self):
        self.block("Waiting for the other thing to finish.")
        self.assertTrue(any(body.startswith("**Waiting on you**") for body in self.remote.bodies(ISSUE)))
        self.pump_after_gap()
        self.assertEqual(self.status(), "blocked")

    def test_a_newer_event_is_never_overridden(self):
        self.block("Waiting on LIFE-646.")
        self.advance(1)
        with self.board.conn() as conn:
            kb.add_comment(conn, self.task_id, "operator", "Hold on, do not resume yet.")
        self.remote.set_state("issue-646", "Done")
        self.pump_after_gap()
        self.assertEqual(self.status(), "blocked")

    def test_delivery_gated_block_clears_once_the_mounted_file_carries_the_change(self):
        root = self.home / "plugins"
        (root / "demo").mkdir(parents=True)
        (root / "demo" / "mod.py").write_text("OLD = 1\n")
        self.reporter.plugins_root = root
        self.block("Merged; needs bundle delivery.\nDelivery gate: demo/mod.py contains NEW_SYMBOL")
        self.assertFalse(any("Waiting on you" in body for body in self.remote.bodies(ISSUE)))
        self.pump_after_gap()
        self.assertEqual(self.status(), "blocked")

        (root / "demo" / "mod.py").write_text("OLD = 1\nNEW_SYMBOL = 2\n")  # the bundle sync delivered it
        self.pump_after_gap()
        self.assertEqual(self.status(), "ready")


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class HeldDelegateScenarios(ExternalWaitScenarios):
    def held_row(self):
        payload = {"id": str(uuid.uuid4()), "issue_id": ISSUE, "content_action": True, "delegate_routing_version": 1,
                   "write_started": True, "target_delegate_id": "app-self", "expected_delegate_id": None,
                   "native_binding": self.reporter.store.native_binding(ISSUE), "task_id": self.task_id}
        row_id = self.reporter.store.enqueue("delegate", payload, at=self.clock())
        self.assertTrue(row_id)
        self.reporter.store.hold_terminal(row_id)
        self.assertEqual([h["id"] for h in self.reporter.store.issue_reconciliation_blocked(ISSUE)], [row_id])
        return row_id

    def test_held_delegate_write_whose_readback_matches_needs_no_operator(self):
        row_id = self.held_row()
        self.remote.set_delegate(ISSUE, {"id": "app-self", "name": "This Agent"})
        self.advance(GAP)
        self.reporter.pump_kanban()
        self.assertEqual(self.reporter.store.issue_reconciliation_blocked(ISSUE), [])
        saved = self.reporter.store.outbox_row(row_id)
        self.assertEqual(saved["payload"]["reconciliation"]["outcome"], "applied")
        self.assertIn("fresh Linear readback", saved["payload"]["reconciliation"]["evidence"])

    def test_held_delegate_write_stays_held_when_the_delegate_differs(self):
        row_id = self.held_row()
        self.remote.set_delegate(ISSUE, {"id": "app-other", "name": "Other Agent"})
        self.advance(GAP)
        self.reporter.pump_kanban()
        self.assertEqual([h["id"] for h in self.reporter.store.issue_reconciliation_blocked(ISSUE)], [row_id])

    # The parent class's scenarios are not repeated here.
    test_cross_issue_blocker_shows_as_a_dependency_and_resumes_when_both_close = None
    test_a_vague_dependency_stays_a_question_and_is_never_resumed = None
    test_a_newer_event_is_never_overridden = None
    test_delivery_gated_block_clears_once_the_mounted_file_carries_the_change = None


if __name__ == "__main__":
    unittest.main()
