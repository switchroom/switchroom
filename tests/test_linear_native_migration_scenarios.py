"""Legacy outbox migration crosses the real HTTP producer/restart/consumer boundary."""
from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from linear_fake_api import Clock, SELF, load_plugin
from test_linear_content_actions import ContentRemote

load_plugin()
from hermes_fleet_linear_plugin import chat, ops
from hermes_fleet_linear_plugin.api import LinearAPI
from hermes_fleet_linear_plugin.bridge import Bridge, ProjectUpdateDeferred
from hermes_fleet_linear_plugin.store import Store
from hermes_fleet_linear_plugin.transport import NativeContext

ISSUE = "issue-1"


class SessionRemote(ContentRemote):
    def _apply(self, query, variables):
        if "IdentityBinding" in query:
            return 200, {"data": {"viewer": {"id": SELF}, "organization": {"id": "synthetic-org"}}}
        if "AgentSessionAuthorization" in query:
            session = variables["id"]
            issue = self.sessions.get(session)
            return 200, {"data": {"agentSession": {"id": session, "issue": {"id": issue},
                            "creator": {"id": "human-1"}, "appUser": {"id": SELF}} if issue else None}}
        if "AgentActivityAuthorization" in query:
            return 200, {"data": {"agentActivity": {"id": variables["id"], "user": {"id": "human-1"},
                                                    "agentSession": {"id": "verified-session"}}}}
        return super()._apply(query, variables)


class NativeMigrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="linear-migration-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.path = self.home / "linear.db"
        self.clock = Clock()
        self.remote = ContentRemote(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_issue(ISSUE, "ABC-1", project=None)
        self.remote.set_delegate(ISSUE, {"id": SELF})
        self.store = Store(self.path)
        self.bridge = self.restart()
        self.context = NativeContext(home=str(self.home), session_key="current-slack-chat", session_id="current-session",
                                     profile="default", platform="slack", source="slack")

    def restart(self, *, native=False):
        adapter = SimpleNamespace()
        if native:
            task = SimpleNamespace(id="native-task", assignee="default", current_run_id=7, status="running")
            adapter = SimpleNamespace(executor_profile="default", board="default", require_task=lambda task_id: task)
        bridge = Bridge(Store(self.path), LinearAPI(lambda: "synthetic", endpoint=self.remote.url, clock=self.clock),
                        adapter, profile="default", clock=self.clock)
        bridge.profile_home = self.home
        return bridge

    def stopped_work(self):
        self.assertTrue(self.store.put(ISSUE, "chat", "retained-old-chat"))
        return self.store.get(ISSUE)

    def old_delivery(self, kind="status", *, attempts=0, delivery_state="pending", **fields):
        key = str(uuid.uuid4())
        payload = {"issue_id": ISSUE, "enqueued_at": self.clock(), **fields}
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT INTO outbox(id,kind,payload,attempts,next_at,state) VALUES(?,?,?,?,?,?)",
                       (key, kind, json.dumps(payload), attempts, self.clock(), delivery_state))
        return key

    def history(self, key):
        row = self.store.outbox_row(key)
        return {field: row[field] for field in ("id", "kind", "payload", "attempts", "next_at", "state")}

    def new_comment(self, body="A newly authorized current comment"):
        key = str(uuid.uuid4())
        result = json.loads(chat.handle(self.bridge, {"action": "add_comment", "issue": "ABC-1", "id": key, "body": body}, self.context))
        self.assertTrue(result["ok"], result)
        return key

    def test_cold_review_release_repro_preserves_human_state_delegate_and_stopped_work(self):
        before_work = self.stopped_work()
        key = self.store.enqueue("status", {"issue_id": ISSUE, "state": "blocked", "claim": False,
                                           "terminal": True, "release": True}, at=self.clock())
        before = self.history(key)
        self.clock.now += 5
        self.remote.set_state(ISSUE, "In Progress")
        self.bridge = self.restart()
        self.bridge.recover()
        self.assertEqual(self.bridge.flush(), 0)
        self.assertEqual(self.remote.state(ISSUE), "In Progress")
        self.assertEqual(self.remote.issues[ISSUE]["delegate"], {"id": SELF})
        self.assertEqual(self.store.get(ISSUE), before_work)
        self.assertEqual(self.history(key), before)
        self.assertTrue(self.store.outbox_row(key)["hold_reason"])
        self.assertTrue(any(item["ref"] == key and item["act"] for item in ops.stuck(self.path, self.home / "absent", "default")))

    def test_orphaned_old_finish_and_every_execution_payload_are_held_without_work_row(self):
        examples = [
            ("status", {"state": "blocked", "terminal": True, "release": True, "work_owner": "removed-owner"}),
            ("status", {"state": "in_progress", "claim": True}),
            ("comment", {"body": "old execution closeout", "session_key": "removed-chat"}),
            ("activity", {"session_id": "old-session", "admission_id": "removed-admission", "content": {"type": "thought", "body": "old claim"}}),
            ("status", {"state": "done", "terminal": True, "task_id": "unverified-old-task"}),
            ("status", {"state": "blocked"}),
        ]
        keys = [self.old_delivery(kind, **fields) for kind, fields in examples]
        before = {key: self.history(key) for key in keys}
        self.clock.now += 5
        self.remote.set_state(ISSUE, "In Progress")
        self.bridge = self.restart()
        self.bridge.recover()
        self.assertEqual(self.bridge.flush(), 0)
        self.assertIsNone(self.store.get(ISSUE))
        for key in keys:
            self.assertEqual(self.history(key), before[key])
            self.assertTrue(self.store.outbox_row(key)["hold_reason"])
        self.assertEqual(self.remote.state(ISSUE), "In Progress")
        self.assertEqual(self.remote.comments + self.remote.activities, [])

    def test_direct_send_and_direct_admission_cannot_bypass_a_hold(self):
        key = self.old_delivery("status", delivery_state="pending", terminal=True, release=True)
        before = self.history(key)
        with self.assertRaises(ProjectUpdateDeferred):
            self.bridge._send(self.store.outbox_row(key))
        self.assertFalse(self.store.admit_mutation(key, terminal=True))
        self.assertFalse(self.store.mark_sent(key, True))
        with self.assertRaises(ProjectUpdateDeferred):
            self.bridge._mutate_outbox(key, lambda: self.fail("held delivery attempted an effect"))
        self.assertEqual(self.history(key), before)
        self.assertFalse(any(query.startswith("mutation") for query in self.remote.requests))

    def test_new_unlinked_comment_delivers_behind_stopped_legacy_closeout(self):
        before_work = self.stopped_work()
        old = self.old_delivery("status", delivery_state="pending", terminal=True, release=True, work_owner="old-owner")
        before = self.history(old)
        new = self.new_comment()
        self.bridge = self.restart()
        self.bridge.recover()
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.store.outbox_row(new)["state"], "sent")
        self.assertEqual(self.remote.comments[0]["id"], new)
        self.assertEqual(self.history(old), before)
        self.assertEqual(self.store.get(ISSUE), before_work)
        self.assertEqual(self.remote.issues[ISSUE]["delegate"], {"id": SELF})

    def test_new_comment_does_not_resolve_or_retry_unknown_old_description(self):
        old = self.old_delivery("description", attempts=3, content_action=True, session_key="removed-chat",
                                expected_description="old text", body="unknown old write", write_started=True)
        before = self.history(old)
        new = self.new_comment()
        self.bridge = self.restart()
        self.bridge.recover()
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.remote.issues[ISSUE]["description"], "Synthetic issue body")
        self.assertEqual(self.store.outbox_row(new)["state"], "sent")
        self.assertEqual(self.history(old), before)
        self.assertTrue(self.store.issue_reconciliation_blocked(ISSUE))
        self.assertTrue(ops.needs_resolution(self.store.outbox_row(old), self.store.outbox_row(old)["payload"]))
        edit = json.loads(chat.handle(self.bridge, {"action": "update_description", "issue": "ABC-1", "id": str(uuid.uuid4()),
                                                   "description": "fresh text", "expected_description": "Synthetic issue body"}, self.context))
        self.assertFalse(edit["ok"])
        self.assertTrue(self.store.reconcile_terminal(old, outcome="not_applied", evidence="Checked the exact current description", at=self.clock()))
        self.assertFalse(self.store.issue_reconciliation_blocked(ISSUE))
        self.assertTrue(self.store.outbox_row(old)["hold_reason"])
        self.assertEqual(self.store.revive_failed(self.clock()), 0)

    def test_failed_old_effect_is_not_revived_after_fresh_success(self):
        old = self.old_delivery("status", attempts=4, delivery_state="failed", terminal=True, state="blocked",
                                release=True, work_owner="removed-owner")
        before = self.history(old)
        self.new_comment()
        self.bridge = self.restart()
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.history(old), before)
        self.assertEqual(self.store.revive_failed(self.clock()), 0)
        self.assertEqual(self.history(old), before)

    def test_explicit_release_resolution_preserves_stopped_execution_history(self):
        before_work = self.stopped_work()
        old = self.old_delivery("status", attempts=1, terminal=True, release=True, work_owner="old-owner", write_started=True)
        self.bridge.flush()
        self.assertTrue(self.store.reconcile_terminal(old, outcome="applied", evidence="Verified remote release only", at=self.clock()))
        self.assertEqual(self.store.get(ISSUE), before_work)
        settled = self.store.outbox_row(old)["payload"]["reconciliation"]
        self.assertFalse(self.store.reconcile_terminal(old, outcome="not_applied", evidence="Must not rewrite verified history", at=self.clock()))
        self.assertEqual(self.store.outbox_row(old)["payload"]["reconciliation"], settled)
        self.assertTrue(self.store.outbox_row(old)["hold_reason"])
        self.assertEqual(self.bridge.flush(), 0)
        self.assertEqual(self.remote.issues[ISSUE]["delegate"], {"id": SELF})

    def test_legitimate_native_bound_reporting_still_delivers(self):
        self.assertTrue(self.store.bind_native(ISSUE, "native-task", "default", "default", at=self.clock() * 1000))
        old = self.old_delivery("status", delivery_state="pending", terminal=True, release=True, work_owner="removed-owner")
        before = self.history(old)
        self.clock.now += 5
        self.bridge = self.restart(native=True)
        self.assertTrue(self.store.capture_event(ISSUE, 12, [
            ("status", {"issue_id": ISSUE, "task_id": "native-task", "state": "blocked", "source_ms": self.clock() * 1000}),
            ("comment", {"issue_id": ISSUE, "task_id": "native-task", "body": "Actual native progress"}),
        ], at=self.clock()))
        self.assertEqual(self.bridge.flush(), 2)
        self.assertEqual(self.remote.state(ISSUE), "Blocked")
        self.assertEqual(self.remote.comments[0]["body"], "Actual native progress")
        self.assertEqual(self.history(old), before)
        self.assertEqual(self.store.get(ISSUE)["last_event_id"], 12)

    def test_held_legacy_claim_does_not_block_new_native_project_reporting(self):
        self.assertTrue(self.store.bind_native(ISSUE, "native-task", "default", "default", at=self.clock() * 1000))
        old = self.old_delivery("status", state="in_progress", claim=True)
        before = self.history(old)
        self.remote.set_delegate(ISSUE, None)
        self.bridge = self.restart(native=True)
        self.assertTrue(self.bridge.project_update("native-task", "project-1", "ABC-1", "Verified native progress",
                                                  quiet=False, issue_id=ISSUE))
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(len(self.remote.project_updates), 1)
        self.assertIn("Verified native progress", self.remote.project_updates[0]["body"])
        self.assertEqual(self.history(old), before)
        self.assertFalse(self.store.pending_claim(ISSUE))

    def test_held_rows_are_never_native_progress_or_completion_receipts(self):
        self.assertTrue(self.store.bind_native(ISSUE, "native-task", "default", "default", at=self.clock() * 1000))
        body = "Unverified prior assessment"
        old = [
            self.old_delivery("activity", task_id="native-task", session_id="current-session", work_owner="old-owner",
                              content={"type": "thought", "body": "Not yet delivered"}),
            self.old_delivery("status", task_id="native-task", state="done", terminal=True, work_owner="old-owner"),
            self.old_delivery("comment", task_id="native-task", assessment=True, body=body, work_owner="old-owner"),
        ]
        before = {key: self.history(key) for key in old}
        self.assertFalse(self.store.captured_task_activities(ISSUE, "native-task", "current-session"))
        self.assertFalse(self.store.terminal_captured("native-task"))
        self.assertIsNone(self.store.assessment_comment_id(ISSUE, body))
        self.assertEqual(self.store.last_activity_at(ISSUE, "current-session"), 0)
        for key in old:
            self.assertEqual(self.history(key), before[key])
            self.assertTrue(self.store.outbox_row(key)["hold_reason"])

    def test_archive_without_outcome_leaves_linear_quietly_beside_historical_receipts(self):
        self.assertTrue(self.store.bind_native(ISSUE, "native-task", "default", "default", at=self.clock() * 1000))
        body = "Historical recommendation"
        sent = [
            self.old_delivery("status", delivery_state="sent", task_id="native-task", state="done", terminal=True,
                              applied=True, work_owner="old-owner"),
            self.old_delivery("activity", delivery_state="sent", task_id="native-task", session_id="current-session",
                              session_key="old-chat", content={"type": "thought", "body": "Historical progress"}),
            self.old_delivery("comment", delivery_state="sent", task_id="native-task", assessment=True, body=body,
                              admission_id="old-admission"),
        ]
        before = {key: self.history(key) for key in sent}
        self.assertFalse(self.store.terminal_captured("native-task"))
        self.assertFalse(self.store.captured_task_activities(ISSUE, "native-task", "current-session"))
        self.assertIsNone(self.store.assessment_comment_id(ISSUE, body))
        self.bridge = self.restart(native=True)
        archived = SimpleNamespace(id="native-task", assignee="default", current_run_id=None, status="archived")
        event = SimpleNamespace(id=99, kind="archived", created_at=int(self.clock()), payload={})
        self.bridge.kanban.require_task = lambda task_id: archived
        self.bridge.kanban.history = lambda task_id, after_id: [event] if after_id < event.id else []
        self.bridge.pump_kanban()
        self.assertEqual(self.store.get(ISSUE)["last_event_id"], event.id)
        # Archived with no outcome: no message; only a Todo intent, a no-op on an issue already in Todo.
        self.assertEqual([(row["kind"], row["payload"]["state"]) for row in self.store.pending()], [("status", "todo")])
        self.bridge.flush()
        self.assertEqual(self.remote.state(ISSUE), "Todo")
        self.assertFalse([q for q in self.remote.requests if q.startswith("mutation IssueUpdate")])
        self.assertEqual(self.remote.comments, [])
        for key in sent:
            self.assertEqual(self.history(key), before[key])
            self.assertTrue(self.store.outbox_row(key)["hold_reason"])

    def test_valid_current_native_sent_receipts_keep_their_evidence_and_history(self):
        self.assertTrue(self.store.bind_native(ISSUE, "native-task", "default", "default", at=self.clock() * 1000))
        body = "Verified current native recommendation"
        status = self.old_delivery("status", delivery_state="sent", task_id="native-task", state="done", terminal=True, applied=True)
        activity = self.old_delivery("activity", delivery_state="sent", task_id="native-task", session_id="current-session",
                                     content={"type": "thought", "body": "Verified native progress"})
        assessment = self.old_delivery("comment", delivery_state="sent", task_id="native-task", assessment=True, body=body)
        sent = [status, activity, assessment]
        before = {key: self.history(key) for key in sent}
        self.assertTrue(self.store.terminal_captured("native-task"))
        self.assertEqual(self.store.captured_task_activities(ISSUE, "native-task", "current-session")[("thought", "Verified native progress")], 1)
        self.assertEqual(self.store.assessment_comment_id(ISSUE, body), assessment)
        self.assertTrue(self.store.terminal_status_applied(status))
        for key in sent:
            self.assertEqual(self.history(key), before[key])
            self.assertIsNone(self.store.outbox_row(key)["hold_reason"])

    def test_native_dependency_cannot_launder_a_held_release(self):
        self.assertTrue(self.store.bind_native(ISSUE, "native-task", "default", "default", at=self.clock() * 1000))
        old = self.old_delivery("status", terminal=True, release=True, work_owner="removed-owner")
        dependent = self.old_delivery("comment", task_id="native-task", requires_status_id=old, body="old completion receipt")
        before = self.history(dependent)
        self.bridge = self.restart(native=True)
        self.assertEqual(self.bridge.flush(), 0)
        self.assertTrue(self.store.outbox_row(dependent)["hold_reason"])
        self.assertEqual(self.history(dependent), before)

    def test_new_refusal_notice_is_reporting_only_and_old_advisory_is_held(self):
        old = self.old_delivery("activity", session_id="old-session", content={"type": "thought", "body": "old chat claim"})
        before = self.history(old)
        self.bridge._decline(ISSUE, "new-authorized-session", "No native task linked; no executor started")
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(len(self.remote.activities), 1)
        self.assertEqual(self.remote.activities[0]["agentSessionId"], "new-authorized-session")
        self.assertEqual(self.history(old), before)
        self.assertTrue(any(item["ref"] == old for item in ops.stuck(self.path, self.home / "absent", "default")))

    def test_verified_agent_session_can_discuss_retained_stopped_work_without_borrowing_owner(self):
        from hermes_fleet_linear_plugin import BoundLinearAPI
        self.remote.close()
        self.remote = SessionRemote(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_issue(ISSUE, "ABC-1", project=None)
        self.remote.set_delegate(ISSUE, {"id": SELF})
        before_work = self.stopped_work()
        old = self.old_delivery("activity", session_id="old-session", work_owner="old-owner",
                                content={"type": "thought", "body": "Retained old executor claim"})
        before = self.history(old)
        uncertain = self.old_delivery("status", attempts=1, state="blocked", terminal=True, release=True,
                                      write_started=True, work_owner="old-owner")
        uncertain_before = self.history(uncertain)
        self.bridge = Bridge(Store(self.path), BoundLinearAPI(lambda: "synthetic", endpoint=self.remote.url, clock=self.clock,
                             identity={"viewer_id": SELF, "organization_id": "synthetic-org"}),
                             SimpleNamespace(), profile="default", clock=self.clock)
        event = self.remote.session_event("prompted", ISSUE, "verified-session", body="What is the current state?")
        self.bridge.handle_webhook(event)
        fresh = next(row for row in self.store.pending() if row["payload"].get("reporting_notice_version") == 1)
        self.assertIsNone(fresh["payload"].get("work_owner"))
        self.assertEqual(fresh["payload"]["reporting_notice_version"], 1)
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(len(self.remote.activities), 1)
        self.assertIn("older work from a previous setup", self.remote.activities[0]["content"]["body"])
        self.assertTrue(any("AgentSessionAuthorization" in request for request in self.remote.requests))
        self.assertTrue(any("AgentActivityAuthorization" in request for request in self.remote.requests))
        self.assertEqual(self.store.get(ISSUE), before_work)
        self.assertEqual(self.history(old), before)
        self.assertEqual(self.history(uncertain), uncertain_before)
        self.assertTrue(self.store.issue_reconciliation_blocked(ISSUE))
        self.assertEqual(self.store.active("native"), [])

    def test_read_only_operator_view_sees_orphaned_hold_before_the_consumer_runs(self):
        old = self.old_delivery("status", state="blocked", release=True)
        before = self.history(old)
        self.assertIsNone(self.store.outbox_row(old)["hold_reason"])
        items = ops.stuck(self.path, self.home / "absent", "default")
        self.assertTrue(any(item["ref"] == old and item["act"] and "resolve" in item["action"] for item in items))
        self.assertEqual(self.history(old), before)
        self.assertIsNone(self.store.outbox_row(old)["hold_reason"])

    def test_schema_upgrade_preserves_unknown_description_and_all_delivery_history(self):
        legacy = self.home / "old-schema.db"
        payload = {"issue_id": ISSUE, "body": "old unknown write", "content_action": True, "write_started": True}
        with sqlite3.connect(legacy) as db:
            db.execute("CREATE TABLE outbox(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,attempts INTEGER,next_at REAL,state TEXT)")
            db.execute("INSERT INTO outbox VALUES(?,?,?,?,?,?)", ("old", "description", json.dumps(payload), 2, 19, "pending"))
            before = db.execute("SELECT * FROM outbox").fetchone()
        migrated = Store(legacy)
        self.assertFalse(migrated.delivery_allowed("old"))
        with sqlite3.connect(legacy) as db:
            self.assertEqual(db.execute("SELECT id,kind,payload,attempts,next_at,state FROM outbox").fetchone(), before)
        self.assertTrue(migrated.reconcile_terminal("old", outcome="not_applied", evidence="Checked current remote body", at=self.clock()))
        self.assertTrue(migrated.outbox_row("old")["hold_reason"])


if __name__ == "__main__":
    unittest.main()
