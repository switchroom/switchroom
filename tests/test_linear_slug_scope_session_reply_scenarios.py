"""A title edit (URL slug) never holds bound native work; live session work keeps its panel open.

HF-627: the native task's link line named the issue URL under its first title. Linear
re-derives the slug when the title changes, and the exact-URL scope check then held the
binding on its `created` event forever. Separately, a chat reply posted as `response`
completed the Agent Session while that session's tracked work was still running.
"""
from __future__ import annotations

import json
import time
import unittest
from unittest.mock import patch

import test_linear_native_bridge_scenarios as native

FIRST_URL = "https://linear.example/ws/issue/OPS-1/a-11-synthetic-issue"
RENAMED_URL = "https://linear.example/ws/issue/OPS-1/qa-11-synthetic-issue"


@unittest.skipIf(native.CORE is not None, f"native source unavailable ({native.CORE})")
class SlugScopeAndSessionReplyScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = native.NativeBridgeScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.board, self.bridge, self.store = self.fixture.board, self.fixture.bridge, self.fixture.store
        self.issue = self.fixture.authority.issues[native.ISSUE]
        self.issue.update(title="A-11 Synthetic issue", url=FIRST_URL)
        self.activities = []
        original = self.bridge.api.transport
        def observe(url, body, headers):
            payload = json.loads(body)
            if "agentActivityCreate" in payload["query"]:
                self.activities.append(payload["variables"]["input"]["content"])
            return original(url, body, headers)
        self.bridge.api.transport = observe

    def session_task(self, *, run=True):
        """Delegated work started by this Agent Session, as the bridge creates it."""
        task_id = self.fixture.create()
        self.assertEqual(self.store.get(native.ISSUE)["owner_ref"], native.SESSION)
        self.assertIn(f"Linear issue {self.issue['identifier']}: {FIRST_URL}", self.board.get(task_id).body)
        if run:
            with self.board.conn() as conn:
                self.assertIsNotNone(native.kb.claim_task(conn, task_id, claimer="slug-scope-worker"))
        return task_id

    def rename(self):
        self.issue.update(title="QA-11 Synthetic issue", url=RENAMED_URL)

    def outbox_bodies(self):
        """Queued session activity and issue comment text (a checkpoint is an issue comment)."""
        with self.store._tx() as db:
            rows = db.execute("SELECT payload FROM outbox WHERE kind IN ('activity','comment')").fetchall()
        return [(json.loads(row[0]).get("content") or {}).get("body") or json.loads(row[0]).get("body") for row in rows]

    def test_title_edit_after_creation_does_not_hold_created_event(self):
        task_id = self.session_task()
        with self.board.conn() as conn:
            self.fixture.checkpoint(conn, task_id, "worker", "Reproduced the slug hold on the bound task.")
        self.rename()
        created = next(event.id for event in self.board.history(task_id, 0) if event.kind == "created")
        self.bridge.pump_kanban()
        self.assertGreater(self.store.get(native.ISSUE)["last_event_id"], created)
        status = self.store.latest_status(native.ISSUE)
        self.assertEqual(status["state"], "in_progress")
        self.assertEqual(self.store.outbox_row(status["id"])["state"], "pending")
        self.assertIn("Reproduced the slug hold on the bound task.", self.outbox_bodies())

    def test_held_binding_recovers_on_next_pump_without_operator_step(self):
        # The shipped exact-URL check held this binding with its cursor at 0; the next
        # tick after upgrade resumes from the retained cursor on its own.
        from hermes_fleet_linear_plugin import bridge as bridge_module
        def exact_url_scope(task, issue):  # The scope rule as shipped before this fix.
            markers = {line.strip() for line in (task.body or "").splitlines()
                       if bridge_module.ISSUE_MARKER.fullmatch(line.strip())}
            url = issue.get("url")
            allowed = ({f"Linear issue {ref}: {url}" for ref in (issue["id"], issue.get("identifier")) if ref}
                       if isinstance(url, str) and url else set())
            return bool(markers & allowed), bool(markers - allowed)
        task_id = self.session_task()
        self.rename()
        with patch.object(bridge_module, "task_issue_scope", exact_url_scope):
            for _ in range(2):
                self.bridge.pump_kanban()
        self.assertEqual(self.store.get(native.ISSUE)["last_event_id"], 0)  # HF-627's held state
        restarted = self.fixture.make_bridge()
        restarted.pump_kanban()
        self.assertGreater(restarted.store.get(native.ISSUE)["last_event_id"], 0)
        self.assertEqual(restarted.store.latest_status(native.ISSUE)["state"], "in_progress")
        self.assertEqual(self.board.get(task_id).status, "running")

    def test_link_line_naming_another_issue_still_conflicts(self):
        from hermes_fleet_linear_plugin.bridge import require_task_issue_scope, task_issue_scope
        task_id = self.session_task()
        task = self.board.get(task_id)
        renamed = {**self.issue, "url": RENAMED_URL}
        self.assertEqual(task_issue_scope(task, renamed), (True, False))
        for line in ("Linear issue OPS-2: https://linear.example/ws/issue/OPS-2/qa-11-synthetic-issue",
                     "Linear issue OPS-1: https://linear.example/ws/issue/OPS-2/qa-11-synthetic-issue",
                     "Linear issue OPS-2: https://linear.example/ws/issue/OPS-1/qa-11-synthetic-issue",
                     "Linear issue OPS-1: https://linear.example/other-ws/issue/OPS-1/qa-11-synthetic-issue",
                     "Linear issue OPS-1: https://elsewhere.example/ws/issue/OPS-1/qa-11-synthetic-issue",
                     "Linear issue OPS-1: https://linear.example/ws/issue/OPS-1/qa-11?redirect=OPS-2"):
            with self.subTest(line=line):
                foreign = type(task)(**{**task.__dict__, "body": task.body + "\n" + line})
                self.assertEqual(task_issue_scope(foreign, renamed), (True, True))
                with self.assertRaises(native.LinearError):
                    require_task_issue_scope(foreign, renamed)

    def test_foreign_link_line_still_holds_pump(self):
        task_id = self.session_task()
        with self.board.conn() as conn:
            self.assertTrue(native.kb.edit_task(conn, task_id,
                body="Linear issue OPS-2: https://linear.example/ws/issue/OPS-2/a-11-synthetic-issue"))
        self.rename()
        self.bridge.pump_kanban()
        self.assertEqual(self.store.get(native.ISSUE)["last_event_id"], 0)

    def reply(self, text):
        from hermes_fleet_linear_plugin.native_input import queue_reply
        row_id = queue_reply(self.bridge, native.ISSUE, native.SESSION, native.ACTIVITY, text)
        self.bridge.flush(only_id=row_id)
        return self.store.outbox_row(row_id)

    def test_reply_while_bound_session_work_runs_is_a_thought(self):
        self.session_task()
        row = self.reply("I started the investigation and will post checkpoints here.")
        self.assertEqual(row["state"], "sent")
        self.assertEqual(row["payload"]["content"],
                         {"type": "thought", "body": "I started the investigation and will post checkpoints here."})
        self.assertIn(row["payload"]["content"], self.activities)
        self.assertNotIn({"type": "response", "body": row["payload"]["content"]["body"]}, self.activities)

    def test_reply_without_bound_work_stays_a_response(self):
        row = self.reply("Nothing is tracked here; this answers the question.")
        self.assertEqual(row["state"], "sent")
        self.assertEqual(row["payload"]["content"]["type"], "response")
        self.assertIn(row["payload"]["content"], self.activities)

    def test_reply_for_another_session_or_settled_finished_work_stays_a_response(self):
        task_id = self.session_task()
        from hermes_fleet_linear_plugin.native_input import _session_work_live
        self.assertFalse(_session_work_live(self.bridge, native.ISSUE, "another-session"))
        with self.board.conn() as conn:
            run = native.kb.get_task(conn, task_id).current_run_id
            self.assertTrue(native.kb.complete_task(conn, task_id, summary="Investigation and local checks finished.",
                                                   result="Local verification succeeded.", expected_run_id=run))
        self.assertEqual(self.board.get(task_id).status, "done")
        self.assertTrue(_session_work_live(self.bridge, native.ISSUE, native.SESSION))
        self.bridge.pump_kanban()
        for _ in range(3):
            self.bridge.flush()
        status = self.store.latest_status(native.ISSUE)
        self.assertTrue(self.store.terminal_status_applied(status["id"]))
        self.assertFalse(_session_work_live(self.bridge, native.ISSUE, native.SESSION))
        visible = len(self.activities)
        row = self.reply("The work already finished; here is the answer.")
        self.assertEqual(row["payload"]["content"]["type"], "response")
        self.assertFalse(row["payload"]["applied"], "Native closeout already supplied the final response")
        self.assertEqual(len(self.activities), visible)

    def test_failed_thought_reply_retries_like_a_reply_not_a_one_try_thought(self):
        from hermes_fleet_linear_plugin.store import advisory
        self.session_task()
        from hermes_fleet_linear_plugin.native_input import queue_reply
        row_id = queue_reply(self.bridge, native.ISSUE, native.SESSION, native.ACTIVITY, "Retried reply text.")
        row = self.store.outbox_row(row_id)
        self.assertEqual(row["payload"]["content"]["type"], "thought")
        self.assertFalse(advisory(row))
        self.assertTrue(self.store.conversation_reply(row["kind"], row["payload"]))


if __name__ == "__main__":
    unittest.main()
