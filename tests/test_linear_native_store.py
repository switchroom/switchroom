"""Durable delivery records do not become a second task ownership system."""
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from linear_fake_api import load_plugin

load_plugin()
from hermes_fleet_linear_plugin import diag
from hermes_fleet_linear_plugin.store import Store


class NativeStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "state.db"
        self.store = Store(self.path)

    def bind(self, issue="issue-1", task="task-1"):
        return self.store.bind_native(issue, task, "alpha", "default", at=100)

    def test_worker_and_foreground_share_durable_atomic_action_cap(self):
        self.bind()
        def step(at, worker=False, store=None):
            return (store or self.store).enqueue("activity", {
                "issue_id": "issue-1", "session_id": "session-1", "task_id": "task-1",
                "ephemeral": True, "write_started": False,
                "content": {"type": "action", "action": "Working", "parameter": "Working on your request."},
                **({"worker_step": {"run_id": 1}} if worker else {})}, at=at)
        first = step(100)
        self.assertTrue(first)
        replacement = Store(self.path)
        self.assertEqual(step(159, True, replacement), "")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda worker: step(160, worker, Store(self.path)), (True, False)))
        self.assertEqual(sum(bool(row) for row in results), 1)
        winner = next(row for row in results if row)
        # A failed attempt still reserves the cap; replacement cannot storm Linear.
        self.store.mark(winner, "failed")
        self.assertEqual(step(161), "")
        self.assertTrue(step(220, True))

    def test_expired_worker_step_retires_only_its_unattempted_content(self):
        self.bind()
        content = {"type": "action", "action": "Working", "parameter": "Working on your request."}
        row = self.store.enqueue("activity", {"issue_id": "issue-1", "session_id": "session-1",
            "task_id": "task-1", "worker_step": {"run_id": 1}, "write_started": False,
            "ephemeral": True, "content": content}, at=100)
        self.assertFalse(self.store.retire_unattempted_action(row, {**content, "parameter": "different"}))
        self.assertTrue(self.store.retire_unattempted_action(row, content))
        self.assertEqual(self.store.outbox_row(row)["state"], "sent")
        self.assertFalse(self.store.outbox_row(row)["payload"]["applied"])

    def test_uncertain_worker_receipt_fences_only_its_session_and_survives_old_retirement(self):
        self.bind()
        content = {"type": "action", "action": "Working", "parameter": "Working on your request."}
        identity = self.store.enqueue('activity', {'issue_id': 'issue-1', 'session_id': 'session-1',
            'task_id': 'task-1', 'worker_step': {'run_id': 1}, 'write_started': True,
            'ephemeral': True, 'content': content}, at=100)
        self.store.retire_advisory(identity, 101)
        self.assertEqual(self.store.outbox_row(identity)['state'], 'pending')
        self.assertTrue(self.store.unsettled_worker_action('issue-1', 'session-1'))
        self.assertFalse(self.store.unsettled_worker_action('issue-1', 'another-session'))
        self.assertFalse(self.store.unsettled_worker_action('another-issue', 'session-1'))
        # Recover the precise old-version disposable retirement for readback only.
        with self.store._tx() as db:
            db.execute("UPDATE outbox SET state='failed' WHERE id=?", (identity,))
        self.assertTrue(any(row['id'] == identity for row in Store(self.path).due(200)))
        self.store.mark_sent(identity, True)
        self.assertFalse(self.store.unsettled_worker_action('issue-1', 'session-1'))

    def test_project_merge_retains_original_activity_and_legacy_evidence_per_member(self):
        self.bind("issue-1", "task-1")
        self.bind("issue-2", "task-2")
        first = {"issue_id": "update:batch:project", "session_id": "batch", "project_id": "project",
            "resolve": "issue-1", "task_id": "task-1",
            "lines": {"OPS-1": "Original outcome"}, "line_issues": {"OPS-1": "issue-1"},
            "requester_sessions": {"issue-1": "session-1"},
            "requester_activities": {"issue-1": "activity-original"}}
        self.assertTrue(self.store.queue_project_update(first, due=0, quiet=False))
        second = {**first, "lines": {"OPS-1": "Updated outcome", "OPS-2": "Independent outcome"},
            "line_issues": {"OPS-1": "issue-1", "OPS-2": "issue-2"},
            "requester_sessions": {"issue-1": "session-1", "issue-2": "session-2"},
            "requester_activities": {"issue-1": "later-activity", "issue-2": "activity-2"}}
        self.assertTrue(self.store.queue_project_update(second, due=0, quiet=False))
        row = self.store.project_update("batch", "project")
        self.assertEqual(row["payload"]["requester_activities"],
            {"issue-1": "activity-original", "issue-2": "activity-2"})
        self.assertTrue(self.store.split_project_update(row["id"], row["payload"], 0, {"OPS-1"}))
        parts = [entry for entry in self.store.pending() if entry["kind"] == "project_update"]
        self.assertEqual(len(parts), 2)
        for part in parts:
            self.assertEqual(part["payload"]["requester_activities"], row["payload"]["requester_activities"])
        # A legacy member cannot gain a later Activity as replacement authority.
        legacy = {**first, "session_id": "legacy-batch"}
        legacy.pop("requester_activities")
        self.assertTrue(self.store.queue_project_update(legacy, due=0, quiet=False))
        self.assertTrue(self.store.queue_project_update({**second, "session_id": "legacy-batch"}, due=0, quiet=False))
        payload = self.store.project_update("legacy-batch", "project")["payload"]
        self.assertEqual(payload["requester_activities"], {"issue-2": "activity-2"})

    def test_concurrent_unbound_stops_preserve_maximum_source_and_its_actor(self):
        barrier = threading.Barrier(4)
        def record(stamp):
            store = Store(self.path)
            barrier.wait(timeout=5)
            return store.record_unbound_stop("issue-1", stamp, session_id="session",
                activity_id=f"activity-{stamp}", actor=f"actor-{stamp}")
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(record, [400, 100, 300, 200]))
        saved = self.store.native_intent("unbound-stop:issue-1")
        self.assertEqual(saved["source_ms"], 400)
        self.assertEqual(saved["activity_id"], "activity-400")
        self.assertEqual(saved["actor"], "actor-400")
        older = self.store.record_unbound_stop("issue-1", 250, session_id="old-session",
            activity_id="old-activity", actor="old-actor")
        self.assertEqual(older, saved)

    def replace(self, task="replacement", *, issue="issue-1", revision=None, request_id=None,
                owner_ref="new-session", project_id="project-1", at=200):
        return self.store.replace_native_binding(
            issue, task, "alpha", "default",
            expected_revision=self.store.binding_revision(issue) if revision is None else revision,
            request_id=request_id or str(uuid.uuid4()), owner_ref=owner_ref, project_id=project_id, at=at)

    def rows(self, table):
        with sqlite3.connect(self.path) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY rowid")]

    def outbox(self, row_id, kind, payload, *, state="pending", attempts=0, next_at=250):
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT INTO outbox(id,kind,payload,attempts,next_at,state) VALUES (?,?,?,?,?,?)",
                       (row_id, kind, json.dumps(payload), attempts, next_at, state))

    def test_binding_is_idempotent_and_cannot_adopt_replace_or_expand_scope(self):
        self.assertTrue(self.bind())
        self.assertTrue(self.bind())
        self.assertFalse(self.bind(task="task-2"))
        self.assertIsNone(self.store.native_binding("issue-1", "beta", "default"))
        self.assertIsNone(self.store.native_binding("issue-1", "alpha", "other-board"))
        self.assertEqual(self.store.native_binding("issue-1")["task_id"], "task-1")
        self.assertTrue(self.store.put("legacy", "chat", "old-conversation"))
        before = self.store.get("legacy")
        self.assertFalse(self.bind("legacy"))
        self.assertEqual(self.store.get("legacy"), before)
        self.assertIsNone(self.store.native_binding("legacy"))

    def test_concurrent_deliveries_reserve_only_one_native_attempt(self):
        payload = {"issue_id": "issue-1", "kind": "create", "key": "stable-key"}
        def prepare(_):
            return Store(self.path).native_intent_prepare("request-1", payload)
        with ThreadPoolExecutor(max_workers=8) as pool:
            attempts = list(pool.map(prepare, range(16)))
        self.assertEqual(sum(fresh for _, fresh in attempts), 1)
        self.assertEqual({saved["state"] for saved, _ in attempts}, {"attempting"})
        # Reopening a process after an uncertain effect cannot grant a new send.
        self.assertFalse(Store(self.path).native_intent_prepare("request-1", payload)[1])
        with self.assertRaises(ValueError):
            self.store.native_intent_prepare("request-1", {**payload, "key": "different"})

    def test_binding_revision_covers_exact_work_binding_and_absence(self):
        absent = self.store.binding_revision("issue-1")
        self.assertEqual(absent, Store(self.path).binding_revision("issue-1"))
        self.assertNotEqual(absent, self.store.binding_revision("other-issue"))
        self.assertTrue(self.bind())
        linked = self.store.binding_revision("issue-1")
        self.assertNotEqual(absent, linked)
        self.store.update("issue-1", last_event_id=4)
        self.assertNotEqual(linked, self.store.binding_revision("issue-1"))
        before = self.store.binding_revision("issue-1")
        with sqlite3.connect(self.path) as db:
            binding = db.execute("SELECT value FROM metadata WHERE key='native-binding:issue-1'").fetchone()[0]
            db.execute("UPDATE metadata SET value=? WHERE key='native-binding:issue-1'", (binding + " ",))
        self.assertNotEqual(before, self.store.binding_revision("issue-1"))

    def test_explicit_replacement_archives_legacy_history_and_preserves_effect_guards(self):
        self.assertTrue(self.store.put("issue-1", "kanban_chat", "old-session", task_id="old-task",
                                       project_id="old-project", last_updated_at=70))
        self.outbox("uncertain", "status", {"issue_id": "issue-1", "task_id": "old-task",
                                            "terminal": True, "write_started": True}, state="failed", attempts=3)
        self.outbox("independent", "comment", {"issue_id": "issue-1", "body": "New discussion",
                                                "content_action": True, "unlinked_content": True})
        original = self.store.get("issue-1")
        uncertain = self.store.issue_reconciliation_blocked("issue-1")
        request_id = str(uuid.uuid4())
        self.assertFalse(self.bind())  # Ordinary tracking still cannot adopt legacy work.
        self.assertEqual(self.replace(request_id=request_id)["task_id"], "replacement")
        receipt = self.store.native_intent(f"track:issue-1:{request_id}")
        self.assertEqual(receipt["payload"]["previous"]["work"], original)
        self.assertIsNone(receipt["payload"]["previous"]["native_binding"])
        self.assertEqual(receipt["state"], "applied")
        self.assertEqual(self.store.issue_reconciliation_blocked("issue-1"), uncertain)
        self.assertTrue(self.store.admit_mutation("independent"))
        self.assertEqual(self.store.get("issue-1")["last_event_id"], 0)

    def test_replacement_holds_old_reports_and_sent_receipts_without_rewriting_history(self):
        self.assertTrue(self.bind(task="old-task"))
        self.assertTrue(self.bind("other-issue", "other-task"))
        self.outbox("old-report", "comment", {"issue_id": "issue-1", "task_id": "old-task"}, attempts=2)
        self.outbox("old-sent", "status", {"issue_id": "issue-1", "task_id": "old-task"}, state="sent", attempts=1)
        self.outbox("old-batch", "project_update", {"issue_id": "update:project-1", "task_id": "old-task",
                                                    "line_issues": {"first": "issue-1", "second": "other-issue"}})
        self.outbox("dependent", "comment", {"issue_id": "other-issue", "task_id": "other-task",
                                               "requires_status_id": "old-sent"})
        self.outbox("independent", "comment", {"issue_id": "issue-1", "content_action": True,
                                                 "unlinked_content": True, "body": "Current discussion"})
        self.outbox("description", "description", {"issue_id": "issue-1", "content_action": True,
                                                     "unlinked_content": True, "write_started": True}, attempts=1)
        self.outbox("unrelated", "comment", {"issue_id": "other-issue", "task_id": "other-task"})
        before = {row["id"]: row for row in self.rows("outbox")}
        self.assertTrue(self.replace())
        after = {row["id"]: row for row in self.rows("outbox")}
        for row_id in ("old-report", "old-sent", "old-batch", "dependent"):
            self.assertTrue(after[row_id]["hold_reason"], row_id)
            self.assertEqual({k: v for k, v in after[row_id].items() if k != "hold_reason"},
                             {k: v for k, v in before[row_id].items() if k != "hold_reason"})
            self.assertFalse(self.store.delivery_allowed(row_id))
        for row_id in ("independent", "description", "unrelated"):
            self.assertEqual(after[row_id], before[row_id])
        self.assertTrue(self.store.delivery_allowed("independent"))
        self.assertTrue(self.store.issue_reconciliation_blocked("issue-1"))

    def test_native_history_is_archived_and_same_target_preserves_cursor(self):
        self.assertTrue(self.bind())
        self.store.update("issue-1", last_event_id=12)
        original = self.store.get("issue-1")
        with sqlite3.connect(self.path) as db:
            raw_binding = db.execute("SELECT value FROM metadata WHERE key='native-binding:issue-1'").fetchone()[0]
        request_id = str(uuid.uuid4())
        self.assertTrue(self.replace(task="task-1", request_id=request_id))
        self.assertEqual(self.store.get("issue-1")["last_event_id"], 12)
        receipt = self.store.native_intent(f"track:issue-1:{request_id}")
        self.assertEqual(receipt["payload"]["previous"], {"work": original, "native_binding": raw_binding})
        self.assertTrue(self.replace(task="new-target"))
        self.assertEqual(self.store.get("issue-1")["last_event_id"], 0)

    def test_same_target_and_reporting_scope_is_a_noop_with_a_retained_receipt(self):
        self.assertTrue(self.bind())
        self.store.update("issue-1", last_event_id=9, last_updated_at=110)
        self.outbox("current-report", "comment", {"issue_id": "issue-1", "task_id": "task-1"})
        before, revision = self.store.get("issue-1"), self.store.binding_revision("issue-1")
        self.assertTrue(self.replace(task="task-1", owner_ref="", project_id=None))
        self.assertEqual(self.store.get("issue-1"), before)
        self.assertEqual(self.store.binding_revision("issue-1"), revision)
        self.assertIsNone(self.store.outbox_row("current-report")["hold_reason"])

    def test_explicit_activity_replacement_preserves_native_control_history_and_old_effect_coordinates(self):
        self.assertTrue(self.store.bind_native("issue-1", "task-1", "alpha", "default",
            owner_ref="provider-session", requester_activity="original-activity", at=100))
        self.store.update("issue-1", last_event_id=9)
        self.outbox("old-activity-report", "comment", {"issue_id": "issue-1", "task_id": "task-1",
            "body": "Frozen original outcome", "requester_sessions": {"issue-1": "provider-session"},
            "requester_activities": {"issue-1": "original-activity"}})
        before = self.store.get("issue-1")
        prior_payload = self.store.outbox_row("old-activity-report")["payload"]
        result = self.store.replace_native_binding("issue-1", "task-1", "alpha", "default",
            owner_ref="provider-session", requester_activity="later-activity", project_id=None,
            expected_revision=self.store.binding_revision("issue-1"), request_id=str(uuid.uuid4()), at=200)
        self.assertTrue(result)
        after = self.store.get("issue-1")
        for field in ("task_id", "last_event_id"):
            self.assertEqual(after[field], before[field])
        self.assertEqual(self.store.native_binding("issue-1")["requester_activity_id"], "later-activity")
        retained = self.store.outbox_row("old-activity-report")
        self.assertEqual(retained["payload"], prior_payload)
        self.assertTrue(retained["hold_reason"])

    def test_superseded_holds_preserve_existing_reasons_and_leave_unrelated_dependencies_alone(self):
        self.assertTrue(self.bind())
        self.outbox("old-report", "comment", {"issue_id": "issue-1", "task_id": "task-1"})
        self.outbox("old-dependent", "comment", {"issue_id": "other-issue", "requires_status_id": "old-report"})
        self.outbox("unrelated-hold", "comment", {"issue_id": "unrelated"})
        self.outbox("unrelated-dependent", "comment", {"issue_id": "unrelated", "requires_status_id": "unrelated-hold"})
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE outbox SET hold_reason='Original reason' WHERE id IN ('old-report','unrelated-hold')")
        before = {row["id"]: row for row in self.rows("outbox")}
        self.assertTrue(self.replace())
        after = {row["id"]: row for row in self.rows("outbox")}
        self.assertEqual(after["old-report"], before["old-report"])
        self.assertTrue(after["old-dependent"]["hold_reason"])
        self.assertEqual(after["unrelated-hold"], before["unrelated-hold"])
        self.assertEqual(after["unrelated-dependent"], before["unrelated-dependent"])

    def test_stale_revision_and_scope_fence_leave_all_records_unchanged(self):
        self.assertTrue(self.bind())
        revision = self.store.binding_revision("issue-1")
        self.store.update("issue-1", last_event_id=1)
        before = {table: self.rows(table) for table in ("work", "metadata", "outbox")}
        self.assertIsNone(self.replace(revision=revision))
        for table, rows in before.items():
            self.assertEqual(self.rows(table), rows)
        self.store.fence_scope("issue-1", "requester no longer allowed", at=101)
        revision = self.store.binding_revision("issue-1")
        self.assertIsNone(self.replace(revision=revision))
        self.assertTrue(self.store.scope_fenced("issue-1"))
        self.assertEqual(self.store.native_binding("issue-1")["task_id"], "task-1")

    def test_concurrent_replacements_have_one_winner(self):
        self.assertTrue(self.bind())
        revision = self.store.binding_revision("issue-1")
        def replace(index):
            return Store(self.path).replace_native_binding(
                "issue-1", f"task-{index}", "alpha", "default", expected_revision=revision,
                request_id=str(uuid.uuid4()), at=200)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(replace, range(2, 10)))
        self.assertEqual(sum(result is not None for result in results), 1)
        winners = [row for row in self.rows("metadata") if row["key"].startswith("native-intent:track:")]
        self.assertEqual(len(winners), 1)

    def test_replacement_retry_is_idempotent_and_cannot_restore_a_superseded_target(self):
        self.assertTrue(self.bind())
        revision, request_id = self.store.binding_revision("issue-1"), str(uuid.uuid4())
        first = self.replace(revision=revision, request_id=request_id)
        before = {table: self.rows(table) for table in ("work", "metadata", "outbox")}
        self.assertEqual(self.replace(revision=revision, request_id=request_id, at=999), first)
        for table, rows in before.items():
            self.assertEqual(self.rows(table), rows)
        with self.assertRaises(ValueError):
            self.replace(task="conflicting", revision=revision, request_id=request_id)
        self.assertTrue(self.replace(task="latest"))
        self.assertIsNone(self.replace(revision=revision, request_id=request_id))
        self.assertEqual(self.store.native_binding("issue-1")["task_id"], "latest")

    def test_replacement_rolls_back_history_holds_and_projection_on_failure(self):
        self.assertTrue(self.bind())
        self.outbox("old", "comment", {"issue_id": "issue-1", "task_id": "task-1"})
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TRIGGER refuse_binding BEFORE UPDATE ON metadata "
                       "WHEN OLD.key='native-binding:issue-1' BEGIN SELECT RAISE(ABORT,'injected failure'); END")
        before = {table: self.rows(table) for table in ("work", "metadata", "outbox")}
        with self.assertRaises(sqlite3.IntegrityError):
            self.replace()
        for table, rows in before.items():
            self.assertEqual(self.rows(table), rows)

    def test_uncertain_native_attempt_requires_readback_never_resets_to_ready(self):
        self.store.native_intent_prepare("request-1", {"kind": "comment", "issue_id": "issue-1"})
        self.store.native_intent_settle("request-1", {"state": "reconcile", "reason": "lost response"})
        saved, fresh = self.store.native_intent_prepare("request-1", {"kind": "comment", "issue_id": "issue-1"})
        self.assertFalse(fresh)
        self.assertEqual(saved["state"], "reconcile")
        self.store.native_intent_settle("request-1", {"state": "applied", "comment_id": 2})
        with self.assertRaises(ValueError):
            self.store.native_intent_settle("request-1", {"state": "attempting"})
        with self.assertRaises(ValueError):
            self.store.native_intent_settle("request-1", {"state": "applied", "comment_id": 3})

    def test_native_event_cursor_and_remote_intents_commit_together_and_keep_binding(self):
        self.assertTrue(self.bind())
        writes = [("comment", {"issue_id": "issue-1", "body": "Verified native result", "task_id": "task-1"})]
        self.assertTrue(self.store.capture_event("issue-1", 4, writes, at=101))
        self.assertIsNotNone(self.store.native_binding("issue-1"))
        self.assertEqual(self.store.get("issue-1")["last_event_id"], 4)
        self.assertFalse(self.store.capture_event("issue-1", 4, writes, at=102))
        self.assertEqual(len(self.store.pending()), 1)
        with self.assertRaises(TypeError):
            self.store.capture_event("issue-1", 5, [("comment", {"issue_id": "issue-1", "body": object()})], at=103)
        self.assertEqual(self.store.get("issue-1")["last_event_id"], 4)
        self.assertEqual(len(self.store.pending()), 1)

    def test_unlinked_content_ignores_chat_claims_but_preserves_uncertain_effects(self):
        self.store.put("legacy", "chat", "original-chat")
        before = self.store.get("legacy")
        row = self.store.enqueue("comment", {"issue_id": "legacy", "body": "Status question", "id": "new-comment",
                                             "content_action": True, "unlinked_content": True}, at=101)
        self.assertTrue(self.store.admit_mutation(row))
        self.assertEqual(self.store.get("legacy"), before)
        self.assertIsNone(self.store.outbox_row(row)["payload"].get("work_owner"))
        description = self.store.enqueue("description", {"issue_id": "unlinked", "body": "New text", "id": "edit-1",
                                                         "expected_description": "Old", "content_action": True, "unlinked_content": True}, at=101)
        self.assertTrue(self.store.admit_mutation(description))
        self.assertTrue(self.store.issue_reconciliation_blocked("unlinked"))
        self.assertEqual(self.store.enqueue("description", {"issue_id": "unlinked", "body": "Retry", "id": "edit-2",
                                                            "content_action": True}, at=102), "")

    def test_opening_drops_empty_retired_tables_and_keeps_one_with_rows(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE retirement (task_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, snapshot TEXT NOT NULL)")
            db.execute("CREATE TABLE chat_admissions (request_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL)")
            db.execute("CREATE TABLE chat_stop (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL)")
            db.execute("INSERT INTO chat_stop VALUES ('stop-1','legacy')")
        diag.reset()
        with self.assertLogs(diag.LOGGER_NAME, "WARNING") as logs:
            Store(self.path)
        self.assertEqual([line for line in logs.output if "retired_table_kept" in line and "fields=chat_stop" in line],
                         logs.output)
        self.assertEqual(len(logs.output), 1)
        with sqlite3.connect(self.path) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(db.execute("SELECT * FROM chat_stop").fetchall(), [("stop-1", "legacy")])
        self.assertIn("chat_stop", tables)
        self.assertFalse({"retirement", "chat_admissions"} & tables)
        self.assertIn("specialist_scope_fence", tables)  # a live safety fence, never retired
        with sqlite3.connect(self.path) as db:
            db.execute("DELETE FROM chat_stop")
        Store(self.path)
        with sqlite3.connect(self.path) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='chat_stop'").fetchone())
        self.assertTrue(self.bind("legacy"))

if __name__ == "__main__":
    unittest.main()
