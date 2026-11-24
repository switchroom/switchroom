"""Native issue discovery before assignment admission; no client-UAT claim."""
import hashlib
import json
import os
import select
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_linear_native_bridge_scenarios as native


@unittest.skipIf(native.CORE is not None, f"native source unavailable ({native.CORE})")
class ExistingWorkScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = native.NativeBridgeScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.board, self.bridge, self.store = self.fixture.board, self.fixture.bridge, self.fixture.store
        self.issue = self.fixture.authority.issues[native.ISSUE]

    def existing(self, *, board=None, key=None, assignee="default", body=None, contract=None):
        adapter = self.board if board is None else native.Kanban(board, profile="default", profile_home=self.fixture.home)
        with adapter.conn() as conn:
            task_id = native.kb.create_task(conn, board=adapter.board, assignee=assignee,
                title=f"{self.issue['identifier']}: existing work", created_by="operator",
                body=body if body is not None else f"Linear issue {native.ISSUE}: {self.issue['url']}",
                idempotency_key=key or f"chat-work:{native.ISSUE}", completion_contract=contract)
        return adapter, task_id

    def assign(self):
        self.bridge.handle_webhook(self.fixture.event())

    def edit_issue_marker(self, adapter, task_id):
        with adapter.conn() as conn:
            self.assertTrue(native.kb.edit_task(conn, task_id,
                body="Linear issue OTHER-2: https://linear.example/issue/OTHER-2"))

    def mixed_issue_markers(self):
        return (f"Linear issue {native.ISSUE}: {self.issue['url']}\n"
                "Linear issue OTHER-2: https://linear.example/issue/OTHER-2")

    def test_mixed_explicit_markers_hold_automatic_binding_without_replacement(self):
        adapter, task_id = self.existing(body=self.mixed_issue_markers())
        with adapter.conn() as conn:
            run = native.kb.claim_task(conn, task_id)
        self.assign()
        self.assertIsNone(self.store.native_binding(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertEqual(len(self.fixture.tasks()), 1)
        self.assertEqual(self.fixture.comments(task_id), [])
        self.assertEqual(adapter.get(task_id).current_run_id, run.current_run_id)

    def test_conflicting_explicit_marker_holds_manual_tracking(self):
        _, task_id = self.existing(body="Linear issue OTHER-2: https://linear.example/issue/OTHER-2")
        with self.assertRaises(native.LinearError):
            self.bridge.track(native.ISSUE, task_id)
        self.assertIsNone(self.store.native_binding(native.ISSUE))
        self.assertEqual(self.fixture.comments(task_id), [])

    def test_mixed_explicit_markers_hold_manual_tracking(self):
        _, task_id = self.existing(body=self.mixed_issue_markers())
        with self.assertRaises(native.LinearError):
            self.bridge.track(native.ISSUE, task_id)
        self.assertIsNone(self.store.native_binding(native.ISSUE))

    def test_conflicting_manual_replacement_preserves_previous_chat_binding(self):
        self.store.put(native.ISSUE, "chat", "previous-conversation")
        previous = self.store.get(native.ISSUE)
        revision = self.store.binding_revision(native.ISSUE)
        _, task_id = self.existing(body="Linear issue OTHER-2: https://linear.example/issue/OTHER-2")
        with self.assertRaises(native.LinearError):
            self.bridge.track(native.ISSUE, task_id, replace=True, expected_revision=revision,
                              request_id="b9e5907c-801d-42f8-924f-eb9c738ac1a7")
        self.assertEqual(self.store.get(native.ISSUE), previous)
        self.assertEqual(self.store.binding_revision(native.ISSUE), revision)

    def test_mixed_manual_replacement_preserves_previous_native_binding(self):
        _, original = self.existing()
        self.bridge.track(native.ISSUE, original)
        previous = self.store.get(native.ISSUE)
        binding = self.store.native_binding(native.ISSUE)
        revision = self.store.binding_revision(native.ISSUE)
        _, task_id = self.existing(body=self.mixed_issue_markers(), key="chat:distinct-mixed-task")
        with self.assertRaises(native.LinearError):
            self.bridge.track(native.ISSUE, task_id, replace=True, expected_revision=revision,
                              request_id="b9e5907c-801d-42f8-924f-eb9c738ac1a7")
        self.assertEqual(self.store.get(native.ISSUE), previous)
        self.assertEqual(self.store.native_binding(native.ISSUE), binding)
        self.assertEqual(self.store.binding_revision(native.ISSUE), revision)

    def test_mixed_markers_at_final_native_comment_read_hold_delivery(self):
        adapter, task_id = self.existing()
        self.assign()
        comment = adapter.comment
        def changed(*args, **kwargs):
            with adapter.conn() as conn:
                native.kb.edit_task(conn, task_id, body=self.mixed_issue_markers())
            return comment(*args, **kwargs)
        with patch.object(adapter, "comment", side_effect=changed), self.assertRaises(native.LinearError):
            self.bridge.followup(native.ISSUE, "Original instruction", "mixed-at-delivery")
        self.assertEqual(self.fixture.comments(task_id), [])
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)

    def test_duplicate_matching_markers_and_canonical_aliases_reuse_same_run(self):
        marker = f"Linear issue {native.ISSUE}: {self.issue['url']}"
        adapter, task_id = self.existing(body=f"{marker}\n{marker}\nLinear issue {self.issue['identifier']}: {self.issue['url']}")
        with adapter.conn() as conn:
            run = native.kb.claim_task(conn, task_id)
        self.assign()
        self.bridge.followup(native.ISSUE, "Same issue instruction", "matching-aliases")
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        self.assertEqual(adapter.get(task_id).current_run_id, run.current_run_id)
        self.assertEqual(self.fixture.comments(task_id)[-1].body, "Same issue instruction")
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_incidental_foreign_references_do_not_override_explicit_issue_link(self):
        body = (f"Linear issue {native.ISSUE}: {self.issue['url']}\n"
                "Discuss Linear issue OTHER-2: https://linear.example/issue/OTHER-2\n"
                "See OTHER-2 for background only.")
        _, task_id = self.existing(body=body)
        self.assign()
        self.bridge.followup(native.ISSUE, "Authorized instruction", "incidental-ref")
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        self.assertEqual(self.fixture.comments(task_id)[-1].body, "Authorized instruction")

    def test_marker_free_manual_replacement_keeps_authorized_followup(self):
        self.store.put(native.ISSUE, "chat", "previous-conversation")
        _, task_id = self.existing(body="Native work with ordinary issue discussion")
        self.bridge.track(native.ISSUE, task_id, replace=True,
                          expected_revision=self.store.binding_revision(native.ISSUE),
                          request_id="b9e5907c-801d-42f8-924f-eb9c738ac1a7")
        self.bridge.followup(native.ISSUE, "Authorized manual instruction", "manual-replacement")
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        self.assertEqual(self.fixture.comments(task_id)[-1].body, "Authorized manual instruction")

    def test_native_issue_marker_change_after_discovery_holds_binding_without_replacement(self):
        adapter, task_id = self.existing()
        discover = self.board.discover
        def changed(issue):
            found = discover(issue)
            self.edit_issue_marker(adapter, task_id)
            return found
        with patch.object(self.board, "discover", side_effect=changed):
            self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertEqual(len(self.fixture.tasks()), 1)
        self.assertEqual(self.fixture.comments(task_id), [])
        self.assertIn("OTHER-2", adapter.get(task_id).body)

    def test_bound_native_issue_marker_change_holds_followup_and_preserves_identity_and_run(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            run = native.kb.claim_task(conn, task_id)
        self.assign()
        binding = self.store.native_binding(native.ISSUE)
        self.edit_issue_marker(adapter, task_id)
        events = [(event.id, event.kind) for event in adapter.history(task_id, 0)]
        with self.assertRaises(native.LinearError):
            self.bridge.followup(native.ISSUE, "Instruction for original issue", "changed-after-binding")
        self.assertEqual(self.store.native_binding(native.ISSUE), binding)
        self.assertEqual([(event.id, event.kind) for event in adapter.history(task_id, 0)], events)
        self.assertEqual(self.fixture.comments(task_id), [])
        current = adapter.get(task_id)
        self.assertEqual((current.current_run_id, current.claim_lock), (run.current_run_id, run.claim_lock))
        self.assertTrue(self.bridge.native_status(native.ISSUE)["linked"])

    def test_conflicting_marker_at_final_native_comment_read_holds_delivery(self):
        adapter, task_id = self.existing()
        self.assign()
        comment = adapter.comment
        def changed(*args, **kwargs):
            self.edit_issue_marker(adapter, task_id)
            return comment(*args, **kwargs)
        with patch.object(adapter, "comment", side_effect=changed), self.assertRaises(native.LinearError):
            self.bridge.followup(native.ISSUE, "Instruction for original issue", "changed-at-delivery")
        self.assertEqual(self.fixture.comments(task_id), [])
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        self.assertNotEqual(self.store.native_intent(f"comment:{native.ISSUE}:changed-at-delivery")["state"], "applied")

    def test_newer_stop_at_final_native_comment_read_holds_instruction(self):
        adapter, task_id = self.existing()
        self.assign()
        comment = adapter.comment
        def stopped(*args, **kwargs):
            with adapter.conn() as conn:
                native.kb.block_task(conn, task_id, reason="newer operator Stop", kind="needs_input")
            return comment(*args, **kwargs)
        with patch.object(adapter, "comment", side_effect=stopped), self.assertRaises(native.LinearError):
            self.bridge.followup(native.ISSUE, "Late instruction", "stop-at-delivery")
        self.assertEqual(adapter.get(task_id).status, "blocked")
        self.assertEqual(self.fixture.comments(task_id), [])
        self.assertFalse(any(event.kind == "unblocked" for event in adapter.history(task_id, 0)))

    def test_marker_free_manual_binding_followup_keeps_existing_native_run(self):
        adapter, task_id = self.existing(body="Ordinary native work without an explicit issue marker")
        with adapter.conn() as conn:
            run = native.kb.claim_task(conn, task_id)
        self.bridge.track(native.ISSUE, task_id)
        self.bridge.followup(native.ISSUE, "Authorized manual instruction", "manual-no-marker")
        self.assertEqual(self.fixture.comments(task_id)[-1].body, "Authorized manual instruction")
        current = adapter.get(task_id)
        self.assertEqual((current.current_run_id, current.claim_lock), (run.current_run_id, run.claim_lock))
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_conflicting_issue_does_not_hold_unrelated_matching_native_followup(self):
        from test_linear_specialist_authorization import issue_record
        adapter, task_id = self.existing()
        self.assign()
        self.edit_issue_marker(adapter, task_id)
        other = issue_record(id="issue-valid", identifier="OPS-2", url="https://linear.example/issue/OPS-2")
        self.fixture.authority.issues[other["id"]] = other
        valid = native.Kanban("valid-project", profile="default", profile_home=self.fixture.home)
        task = valid.create(title="Valid unrelated native task", body=f"Linear issue {other['id']}: {other['url']}")
        with valid.conn() as conn:
            run = native.kb.claim_task(conn, task.id)
        self.bridge.track(other["id"], task.id, board="valid-project")
        with self.assertRaises(native.LinearError):
            self.bridge.followup(native.ISSUE, "Wrong scoped instruction", "wrong-issue")
        self.bridge.followup(other["id"], "Valid matching instruction", "valid-issue")
        with valid.read_conn() as conn:
            self.assertEqual(native.kb.list_comments(conn, task.id)[-1].body, "Valid matching instruction")
        current = valid.get(task.id)
        self.assertEqual((current.current_run_id, current.claim_lock), (run.current_run_id, run.claim_lock))
        self.assertEqual(self.fixture.comments(task_id), [])

    def test_native_creation_body_change_is_checked_on_fresh_task_before_binding(self):
        create, tasks = self.board.create, []
        def changed(**kwargs):
            task = create(**kwargs)
            tasks.append(task.id)
            self.edit_issue_marker(self.board, task.id)
            return task
        with patch.object(self.board, "create", side_effect=changed), self.assertRaises(native.LinearError):
            self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(len(tasks), 1)
        self.assertEqual(self.board.get(tasks[0]).status, "blocked")
        self.assertFalse(any(event.kind == "unblocked" for event in self.board.history(tasks[0], 0)))

    def competing_writer(self, database):
        result = subprocess.run([sys.executable, "-c", """
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1], timeout=0.1, isolation_level=None)
try:
    connection.execute('BEGIN IMMEDIATE')
except sqlite3.OperationalError as exc:
    if 'locked' not in str(exc):
        raise
    print('locked')
else:
    print('acquired')
    connection.rollback()
finally:
    connection.close()
""", str(database)], capture_output=True, text=True, timeout=3, check=True)
        return result.stdout.strip()

    @contextmanager
    def dirty_spill_writer(self, database, task_id):
        """Separate SQLite writer flushes uncommitted pages, then waits for rollback."""
        from hermes_cli.sqlite_safe_read import connect_tracked
        with closing(connect_tracked(database)) as seed:
            self.assertEqual(seed.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
            seed.execute("CREATE TABLE spill(value TEXT)")
            seed.executemany("INSERT INTO spill VALUES (?)", [("s" * 10000,)] * 200)
            seed.commit()
        script = """
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1], isolation_level=None)
connection.execute('PRAGMA cache_size=1')
connection.execute('PRAGMA cache_spill=1')
connection.execute('BEGIN EXCLUSIVE')
connection.execute("UPDATE tasks SET body=?, title='UNCOMMITTED' WHERE id=?", ('x'*62, sys.argv[2]))
connection.execute('UPDATE spill SET value=?', ('z'*10000,))
print('ready', flush=True)
input()
connection.rollback()
connection.close()
"""
        child = subprocess.Popen([sys.executable, "-u", "-c", script, str(database), task_id],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 30)[0], "spill writer did not become ready")
            self.assertEqual(child.stdout.readline().strip(), "ready")
            yield child
        finally:
            if child.poll() is None:
                child.communicate("\n", timeout=5)
            self.assertEqual(child.returncode, 0)

    def test_other_process_dirty_spill_is_not_visible_to_history_read(self):
        adapter, task_id = self.existing()
        original = adapter.get(task_id)
        database = Path(native.kb.kanban_db_path(board="default"))
        with self.dirty_spill_writer(database, task_id):
            self.assertEqual(self.competing_writer(database), "locked")
            started = time.monotonic()
            with self.assertRaises(native.LinearError):
                with adapter.history_conn(database, snapshot=True) as conn:
                    self.fail(f"Read uncommitted source: {native.kb.get_task(conn, task_id).title}")
            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual(self.competing_writer(database), "locked")
        restored = adapter.get(task_id)
        self.assertEqual((restored.title, restored.body), (original.title, original.body))

    def test_dirty_spill_discovery_holds_replacement_then_rollback_reuses_original_run(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            original = native.kb.claim_task(conn, task_id)
        database = Path(native.kb.kanban_db_path(board="default"))
        discover = self.board.discover
        with self.dirty_spill_writer(database, task_id) as child:
            def inspect_then_rollback(issue):
                try:
                    return discover(issue)
                finally:
                    child.communicate("\n", timeout=5)
            with patch.object(self.board, "discover", side_effect=inspect_then_rollback):
                self.assign()
            self.assertIsNone(self.store.get(native.ISSUE))
            self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertEqual(len(self.fixture.tasks()), 1)
        self.assign()
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        current = adapter.get(task_id)
        self.assertEqual((current.current_run_id, current.claim_lock), (original.current_run_id, original.claim_lock))

    def test_live_delete_transaction_keeps_competing_writer_excluded_after_inspection_and_reader_close(self):
        _, task_id = self.existing()
        database = Path(native.kb.kanban_db_path(board="default"))
        from hermes_cli.sqlite_safe_read import has_live_connection
        with closing(self.board.kc.connect(board="default")) as writer:
            self.assertTrue(has_live_connection(database))
            self.assertEqual(writer.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
            writer.execute("BEGIN IMMEDIATE")
            before = self.competing_writer(database)
            with self.board.history_conn(database, snapshot=True) as reader:
                self.assertEqual(native.kb.get_task(reader, task_id).id, task_id)
                during = self.competing_writer(database)
            after = self.competing_writer(database)
            self.assertTrue(writer.in_transaction)
            self.assertEqual((before, during, after), ("locked", "locked", "locked"))
            writer.rollback()
        self.assertEqual(self.competing_writer(database), "acquired")

    def test_live_exclusive_transaction_refuses_bounded_native_inspection_but_keeps_issue_content(self):
        self.existing()
        self.assign()
        database = Path(native.kb.kanban_db_path(board="default"))
        from hermes_fleet_linear_plugin import chat
        self.bridge.profile_home = self.fixture.home
        context = SimpleNamespace(profile="default", home=self.fixture.home, pinned_db_path="")
        with closing(self.board.kc.connect(board="default")) as writer:
            self.assertEqual(writer.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
            writer.execute("BEGIN EXCLUSIVE")
            self.assertEqual(self.competing_writer(database), "locked")
            started = time.monotonic()
            with self.assertRaises(native.LinearError):
                with self.board.history_conn(database, snapshot=True):
                    self.fail("EXCLUSIVE native lock must refuse inspection")
            self.assertLess(time.monotonic() - started, 1)
            result = json.loads(chat.handle(self.bridge, {"action": "status", "issue": native.ISSUE}, context))
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["issue"]["id"], native.ISSUE)
            self.assertFalse(result["native"]["linked"])
            self.assertTrue(writer.in_transaction)
            self.assertEqual(self.competing_writer(database), "locked")
            writer.rollback()
        self.assertEqual(self.competing_writer(database), "acquired")

    def test_source_reader_is_tracked_against_native_raw_file_access(self):
        self.existing()
        database = Path(native.kb.kanban_db_path(board="default"))
        from hermes_cli.sqlite_safe_read import offline_file_access, LiveConnectionError, has_live_connection
        self.assertFalse(has_live_connection(database))
        with self.board.history_conn(database) as reader:
            self.assertTrue(has_live_connection(database))
            self.assertEqual(reader.execute("PRAGMA query_only").fetchone()[0], 1)
            with self.assertRaises(LiveConnectionError):
                with offline_file_access(database):
                    self.fail("plugin source reader must fence raw file access")
        self.assertFalse(has_live_connection(database))

    def test_reporting_native_reads_preserve_database_journal_mode_and_committed_bytes(self):
        adapter, task_id = self.existing()
        from hermes_cli.sqlite_safe_read import connect_tracked
        database = Path(native.kb.kanban_db_path(board="default"))
        with closing(connect_tracked(database)) as conn:
            self.assertEqual(conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
        before = self.archive_bytes(database.parent)
        task = adapter.get(task_id)
        adapter.history(task_id, 0)
        adapter.evidence_text(task)
        adapter.completion_summary(task)
        adapter.issue_comment(task)
        adapter.comment_text(task_id, "operator", 1, 0)
        adapter.find_comment(task_id, "unrelated", "marker")
        adapter.find_created(f"chat-work:{native.ISSUE}")
        self.assertEqual(self.archive_bytes(database.parent), before)
        with closing(connect_tracked(database.as_uri() + "?mode=ro", uri=True)) as conn:
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "delete")

    def test_missing_required_native_column_is_scoped_and_authorized_linked_issue_stays_readable(self):
        adapter, task_id = self.existing()
        self.assign()
        database = Path(native.kb.kanban_db_path(board="default"))
        from hermes_cli.sqlite_safe_read import connect_tracked
        with closing(connect_tracked(database)) as conn:
            conn.execute("ALTER TABLE tasks DROP COLUMN body")
            conn.commit()
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        before = self.archive_bytes(database.parent)
        from hermes_fleet_linear_plugin import chat
        self.bridge.profile_home = self.fixture.home
        context = SimpleNamespace(profile="default", home=self.fixture.home, pinned_db_path="")
        result = json.loads(chat.handle(self.bridge, {"action": "status", "issue": native.ISSUE}, context))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["issue"]["id"], native.ISSUE)
        self.assertFalse(result["native"]["linked"])
        self.assertEqual(result["native"]["status"], "reconciliation")
        with self.assertRaises(native.LinearError):
            adapter.get(task_id)
        self.assertEqual(self.archive_bytes(database.parent), before)

    def test_missing_required_column_holds_new_admission_without_repair(self):
        self.existing()
        database = Path(native.kb.kanban_db_path(board="default"))
        from hermes_cli.sqlite_safe_read import connect_tracked
        with closing(connect_tracked(database)) as conn:
            conn.execute("ALTER TABLE tasks DROP COLUMN body")
            conn.commit()
        before = self.archive_bytes(database.parent)
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertEqual(self.archive_bytes(database.parent), before)

    def test_malformed_task_numeric_matrix_keeps_status_and_discovery_errors_scoped(self):
        adapter, task_id = self.existing()
        self.assign()
        from hermes_cli.sqlite_safe_read import connect_tracked
        from hermes_fleet_linear_plugin import chat
        database = Path(native.kb.kanban_db_path(board="default"))
        self.bridge.profile_home = self.fixture.home
        context = SimpleNamespace(profile="default", home=self.fixture.home, pinned_db_path="")
        cases = [(column, value) for column in ("created_at", "started_at", "completed_at", "claim_expires", "last_heartbeat_at")
                 for value in (float("inf"), float("-inf"))]
        cases += [("block_recurrences", float("inf")), ("block_recurrences", "not-an-integer")]
        for column, value in cases:
            with self.subTest(column=column, value=value):
                with closing(connect_tracked(database)) as conn:
                    original = conn.execute(f"SELECT {column} FROM tasks WHERE id=?", (task_id,)).fetchone()[0]
                    conn.execute(f"UPDATE tasks SET {column}=? WHERE id=?", (value, task_id))
                    conn.commit()
                    self.assertEqual([row[0] for row in conn.execute("PRAGMA integrity_check")], ["ok"])
                before = self.archive_bytes(database.parent)
                try:
                    result = json.loads(chat.handle(self.bridge, {"action": "status", "issue": native.ISSUE}, context))
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(result["issue"]["id"], native.ISSUE)
                    self.assertFalse(result["native"]["linked"])
                    with self.assertRaises(native.LinearError):
                        adapter.get(task_id)
                    with self.assertRaises(native.LinearError):
                        adapter.discover(self.issue)
                    self.assertEqual(self.archive_bytes(database.parent), before)
                    self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
                finally:
                    with closing(connect_tracked(database)) as conn:
                        conn.execute(f"UPDATE tasks SET {column}=? WHERE id=?", (original, task_id))
                        conn.commit()

    def test_malformed_history_numeric_matrix_does_not_repair_native_rows(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            native.kb.claim_task(conn, task_id)
            native.kb.add_comment(conn, task_id, "operator", "Native comment")
        task = adapter.get(task_id)
        from hermes_cli.sqlite_safe_read import connect_tracked
        database = Path(native.kb.kanban_db_path(board="default"))
        cases = [("task_runs", "started_at", float("inf"), lambda: adapter.evidence_text(task)),
                 ("task_runs", "ended_at", float("-inf"), lambda: adapter.completion_summary(task)),
                 ("task_comments", "created_at", float("inf"), lambda: adapter.comment_text(task_id, "operator", 14, 0)),
                 ("task_events", "created_at", float("inf"), lambda: adapter.history(task_id, 0)),
                 ("task_events", "run_id", float("inf"), lambda: adapter.history(task_id, 0)),
                 ("task_events", "run_id", "not-an-integer", lambda: adapter.history(task_id, 0))]
        for table, column, value, read in cases:
            with self.subTest(table=table, column=column, value=value):
                with closing(connect_tracked(database)) as conn:
                    original = conn.execute(f"SELECT id,{column} FROM {table} WHERE task_id=?", (task_id,)).fetchall()
                    conn.execute(f"UPDATE {table} SET {column}=? WHERE task_id=?", (value, task_id))
                    conn.commit()
                    self.assertEqual([row[0] for row in conn.execute("PRAGMA integrity_check")], ["ok"])
                before = self.archive_bytes(database.parent)
                try:
                    with self.assertRaises(native.LinearError):
                        read()
                    self.assertEqual(self.archive_bytes(database.parent), before)
                finally:
                    with closing(connect_tracked(database)) as conn:
                        conn.executemany(f"UPDATE {table} SET {column}=? WHERE id=?", [(row[1], row[0]) for row in original])
                        conn.commit()

    def test_malformed_nullable_run_identifier_type_error_is_scoped(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            native.kb.claim_task(conn, task_id)
        task = adapter.get(task_id)
        from hermes_cli.sqlite_safe_read import connect_tracked
        database = Path(native.kb.kanban_db_path(board="default"))
        with closing(connect_tracked(database)) as conn:
            conn.execute("ALTER TABLE task_runs RENAME TO original_task_runs")
            conn.execute("CREATE TABLE task_runs AS SELECT * FROM original_task_runs")
            conn.execute("UPDATE task_runs SET id=NULL")
            conn.commit()
            self.assertEqual([row[0] for row in conn.execute("PRAGMA integrity_check")], ["ok"])
        before = self.archive_bytes(database.parent)
        for read in (adapter.evidence_text, adapter.completion_summary, adapter.issue_comment):
            with self.subTest(reader=read.__name__), self.assertRaises(native.LinearError):
                read(task)
        self.assertEqual(self.archive_bytes(database.parent), before)

    def test_nonfinite_task_timestamp_holds_new_admission_without_replacement(self):
        _, task_id = self.existing()
        from hermes_cli.sqlite_safe_read import connect_tracked
        database = Path(native.kb.kanban_db_path(board="default"))
        with closing(connect_tracked(database)) as conn:
            conn.execute("UPDATE tasks SET created_at=? WHERE id=?", (float("inf"), task_id))
            conn.commit()
        before = self.archive_bytes(database.parent)
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertEqual(self.archive_bytes(database.parent), before)

    def test_native_tolerated_timestamp_fallback_remains_readable(self):
        adapter, task_id = self.existing()
        self.assign()
        from hermes_cli.sqlite_safe_read import connect_tracked
        database = Path(native.kb.kanban_db_path(board="default"))
        with closing(connect_tracked(database)) as conn:
            conn.execute("UPDATE tasks SET created_at='not-a-timestamp', started_at=NULL WHERE id=?", (task_id,))
            conn.commit()
        before = self.archive_bytes(database.parent)
        self.assertIsNone(adapter.get(task_id).created_at)
        self.assertEqual(adapter.discover(self.issue)[0][1].id, task_id)
        self.assertTrue(self.bridge.native_status(native.ISSUE)["linked"])
        self.assertEqual(self.archive_bytes(database.parent), before)

    def test_unrelated_valid_binding_remains_readable_with_nonfinite_task_timestamp(self):
        from test_linear_specialist_authorization import issue_record
        from hermes_cli.sqlite_safe_read import connect_tracked
        other = issue_record(id="issue-other", identifier="OPS-2", url="https://linear.example/issue/OPS-2")
        self.fixture.authority.issues[other["id"]] = other
        valid = native.Kanban("valid-project", profile="default", profile_home=self.fixture.home)
        task = valid.create(title="Unrelated valid task")
        self.bridge.track(other["id"], task.id, board="valid-project")
        _, broken = self.existing()
        database = Path(native.kb.kanban_db_path(board="default"))
        with closing(connect_tracked(database)) as conn:
            conn.execute("UPDATE tasks SET created_at=? WHERE id=?", (float("inf"), broken))
            conn.commit()
        before = self.archive_bytes(database.parent)
        self.assertEqual(self.bridge.native_status(other["id"])["task_id"], task.id)
        self.assertEqual(self.archive_bytes(database.parent), before)

    def corrupt_status_index(self):
        adapter, task_id = self.existing()
        database = Path(native.kb.kanban_db_path(board="default"))
        from hermes_cli.sqlite_safe_read import connect_tracked, offline_file_access
        with closing(connect_tracked(database)) as conn:
            self.assertEqual(conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
            page = conn.execute("SELECT rootpage FROM sqlite_master WHERE name='idx_tasks_status'").fetchone()[0]
            size = conn.execute("PRAGMA page_size").fetchone()[0]
        with offline_file_access(database, what="damage disposable index fixture"):
            data = bytearray(database.read_bytes())
            offset = (page - 1) * size
            self.assertEqual(data[offset], 0x0a)  # A single-row index leaf.
            position = data.index(b"ready", offset, offset + size)
            data[position:position + 5] = b"xxxxx"
            database.write_bytes(data)
        with closing(connect_tracked(database.as_uri() + "?mode=ro", uri=True)) as conn:
            self.assertEqual(conn.execute("PRAGMA quick_check").fetchone()[0], "ok")
            self.assertNotEqual([row[0] for row in conn.execute("PRAGMA integrity_check")], ["ok"])
        adapter.kc._INITIALIZED_PATHS.discard(str(database.resolve()))
        return adapter, task_id, database

    def test_index_mismatch_holds_assignment_before_native_connect_can_reindex_source(self):
        _, _, database = self.corrupt_status_index()
        before = self.archive_bytes(database.parent)
        self.assign()
        self.assertEqual(self.archive_bytes(database.parent), before)
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))

    def test_unrelated_valid_native_binding_stays_readable_when_default_index_is_damaged(self):
        from test_linear_specialist_authorization import issue_record
        other = issue_record(id="issue-other", identifier="OPS-2", url="https://linear.example/issue/OPS-2")
        self.fixture.authority.issues[other["id"]] = other
        valid = native.Kanban("valid-project", profile="default", profile_home=self.fixture.home)
        task = valid.create(title="Unrelated valid work", body=f"Linear issue {other['id']}: {other['url']}")
        self.bridge.track(other["id"], task.id, board="valid-project")
        self.corrupt_status_index()
        from hermes_fleet_linear_plugin import chat
        self.bridge.profile_home = self.fixture.home
        context = SimpleNamespace(profile="default", home=self.fixture.home, pinned_db_path="")
        result = json.loads(chat.handle(self.bridge, {"action": "status", "issue": other["id"]}, context))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["issue"]["id"], other["id"])
        self.assertTrue(result["native"]["linked"])
        self.assertEqual(result["native"]["task_id"], task.id)

    def test_running_unlinked_chat_task_is_reused_and_followup_keeps_its_run(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            original = native.kb.claim_task(conn, task_id)
        self.assign()
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.bridge.followup(native.ISSUE, "Current authorized steering", "existing-followup")
        current = adapter.get(task_id)
        self.assertEqual((current.current_run_id, current.claim_lock), (original.current_run_id, original.claim_lock))
        self.assertEqual(self.fixture.comments(task_id)[-1].body, "Current authorized steering")
        self.assign()
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_exact_native_key_reuses_task_without_requiring_identical_creation_prose(self):
        _, task_id = self.existing(key=f"linear:{native.ISSUE}",
            body=f"Linear issue {native.ISSUE}: {self.issue['url']}\nOriginal approved objective")
        self.assign()
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_key_only_collision_on_an_alternate_board_is_not_adopted_or_duplicated(self):
        adapter, task_id = self.existing(board="project-work", key=f"linear:{native.ISSUE}",
                                        body="Manual work with a colliding retry key")
        with self.assertRaises(native.LinearError):
            self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertEqual(self.fixture.tasks(), [])
        self.assertEqual(adapter.get(task_id).status, "ready")

    def test_alternate_existing_board_remains_the_execution_and_followup_board(self):
        adapter, task_id = self.existing(board="project-work")
        self.assign()
        self.assertEqual(self.store.native_binding(native.ISSUE)["board"], "project-work")
        self.assertEqual(self.fixture.tasks(), [])
        self.bridge.followup(native.ISSUE, "Steer existing project work", "project-followup")
        with adapter.conn() as conn:
            self.assertEqual(len(native.kb.list_tasks(conn)), 1)
            self.assertEqual(native.kb.list_comments_after(conn, task_id)[-1].body, "Steer existing project work")

    def test_stopped_work_is_linked_without_activation_even_after_restart(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            native.kb.block_task(conn, task_id, reason="operator Stop", kind="needs_input")
        history = [(event.id, event.kind) for event in adapter.history(task_id, 0)]
        self.assign()
        self.fixture.make_bridge().recover()
        self.assertEqual(adapter.get(task_id).status, "blocked")
        self.assertEqual([(e.id, e.kind) for e in adapter.history(task_id, 0)], history)
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_new_stop_during_discovery_is_not_undone(self):
        adapter, task_id = self.existing()
        discover = self.board.discover
        def stop_after_inspection(issue):
            found = discover(issue)
            with adapter.conn() as conn:
                native.kb.block_task(conn, task_id, reason="new Stop", kind="needs_input")
            return found
        with patch.object(self.board, "discover", side_effect=stop_after_inspection):
            self.assign()
        self.assertEqual(adapter.get(task_id).status, "blocked")
        self.assertFalse(any(e.kind == "unblocked" for e in adapter.history(task_id, 0)))

    def test_foreign_executor_does_not_trigger_replacement_or_implicit_transfer(self):
        adapter, task_id = self.existing(assignee="different-local-profile")
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(len(self.fixture.tasks()), 1)
        self.assertEqual(adapter.get(task_id).assignee, "different-local-profile")

    def test_ambiguous_existing_work_is_not_selected_or_duplicated(self):
        self.existing()
        self.existing(board="other-project")
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))

    def test_incidental_issue_mentions_are_not_implicit_task_links(self):
        _, old_id = self.existing(body=f"Research notes refer to {self.issue['identifier']} and {self.issue['url']}")
        self.assign()
        self.assertEqual(len(self.fixture.tasks()), 2)
        self.assertNotEqual(self.store.get(native.ISSUE)["task_id"], old_id)

    def test_completed_existing_work_stays_history_without_new_execution(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            native.kb.complete_task(conn, task_id, result="Verified original approved outcome")
        self.assign()
        self.assertEqual(adapter.get(task_id).status, "done")
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_identifier_marker_is_accepted_without_a_machine_creation_key(self):
        _, task_id = self.existing(body=f"Linear issue {self.issue['identifier']}: {self.issue['url']}")
        self.assign()
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)

    def test_reassignment_during_discovery_prevents_binding_or_creation(self):
        self.existing()
        discover = self.board.discover
        def changed(issue):
            found = discover(issue)
            self.issue["delegate"] = {"id": "another-app"}
            return found
        with patch.object(self.board, "discover", side_effect=changed):
            self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_unreadable_existing_board_is_not_treated_as_empty(self):
        self.existing(board="project-work")
        original = self.board.for_board
        def denied(board):
            if board == "project-work":
                raise native.LinearError("Existing native target unavailable", retryable=False)
            return original(board)
        with patch.object(self.board, "for_board", side_effect=denied):
            self.assign()
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertIsNone(self.store.get(native.ISSUE))

    def test_configured_project_acceptance_is_not_downgraded_by_reuse(self):
        adapter, task_id = self.existing()
        self.bridge.contracts[self.issue["project"]["id"]] = "example/repository"
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(adapter.get(task_id).status, "ready")
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_matching_project_acceptance_reuses_existing_task(self):
        _, task_id = self.existing(contract="example/repository")
        self.bridge.contracts[self.issue["project"]["id"]] = "example/repository"
        self.assign()
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        self.assertEqual(len(self.fixture.tasks()), 1)

    def archive_board(self, *, assignee="default", body=None):
        adapter, task_id = self.existing(board="project-work", assignee=assignee, body=body)
        with adapter.conn() as conn:
            native.kb.complete_task(conn, task_id, result="Original completed outcome")
        result = native.kb.remove_board("project-work", archive=True)
        return Path(result["new_path"]), task_id

    def archive_bytes(self, path):
        # SQLite owns its WAL-index cache and empty WAL bookkeeping; neither
        # contains committed native data. Retain exact hashes of DB/WAL data.
        return {str(item.relative_to(path)): hashlib.sha256(item.read_bytes()).hexdigest()
                for item in path.rglob("*") if item.is_file() and not item.name.endswith("-shm")
                and not (item.name.endswith("-wal") and item.stat().st_size == 0)}

    def test_completed_archived_task_is_history_without_replacement_or_false_unfinished_report(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            native.kb.complete_task(conn, task_id, result="Original completed outcome")
            native.kb.archive_task(conn, task_id)
        before = [(event.id, event.kind) for event in adapter.history(task_id, 0)]
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertEqual(adapter.get(task_id).status, "archived")
        self.assertEqual([(event.id, event.kind) for event in adapter.history(task_id, 0)], before)
        self.assertTrue(any("Earlier work on this issue already finished" in row["payload"]["content"]["body"]
                            for row in self.store.pending(native.ISSUE)))

    def test_archived_board_history_is_read_without_reopening_linking_or_file_changes(self):
        path, _ = self.archive_board()
        before = self.archive_bytes(path)
        connect = self.board.kc.connect
        def no_archive_connect(*args, **kwargs):
            self.assertNotEqual(kwargs.get("board"), "project-work")
            return connect(*args, **kwargs)
        with patch.object(self.board.kc, "connect", side_effect=no_archive_connect):
            self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        self.assertEqual(self.fixture.tasks(), [])
        self.assertEqual(self.archive_bytes(path), before)
        self.assertTrue(native.kb.read_board_metadata("project-work")["archived"])
        self.assertFalse(Path(native.kb.kanban_db_path(board="project-work")).exists())

    def test_archived_read_transaction_includes_committed_wal_without_changing_native_data(self):
        adapter, task_id = self.existing(board="project-work")
        database = Path(native.kb.kanban_db_path(board="project-work"))
        # Native runtime safety may deliberately choose DELETE on older SQLite.
        # Craft WAL only in this disposable single-writer fixture, with every
        # native connection closed; no runtime safety function is patched.
        with closing(sqlite3.connect(database, isolation_level=None)) as conn:
            conn.row_factory = sqlite3.Row
            self.assertEqual(conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
            self.assertEqual(conn.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            conn.execute("PRAGMA wal_autocheckpoint=0")
            native.kb.complete_task(conn, task_id, result="Completed result committed in WAL")
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)) as main_only:
                main_only.row_factory = sqlite3.Row
                self.assertEqual(native.kb.get_task(main_only, task_id).status, "ready")
            path = Path(native.kb.remove_board("project-work", archive=True)["new_path"])
            self.assertGreater((path / "kanban.db-wal").stat().st_size, 0)
            before = self.archive_bytes(path)
            self.assign()
            self.assertIsNone(self.store.get(native.ISSUE))
            self.assertEqual(self.fixture.tasks(), [])
            self.assertEqual(self.archive_bytes(path), before)
            self.assertTrue(any("Earlier work on this issue already finished" in row["payload"]["content"]["body"]
                                for row in self.store.pending(native.ISSUE)))

    def test_archive_reader_enforces_query_only(self):
        path, _ = self.archive_board()
        before = self.archive_bytes(path)
        [(adapter, _)] = self.board.discover(self.issue)
        with adapter.conn() as conn:
            self.assertEqual(conn.execute("PRAGMA query_only").fetchone()[0], 1)
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("DELETE FROM tasks")
        self.assertEqual(self.archive_bytes(path), before)

    def test_archived_exclusive_spill_holds_replacement_and_rollback_restores_history(self):
        path, task_id = self.archive_board()
        with self.dirty_spill_writer(path / "kanban.db", task_id):
            self.assign()
            self.assertIsNone(self.store.get(native.ISSUE))
            self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
            self.assertEqual(self.fixture.tasks(), [])
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(self.fixture.tasks(), [])
        self.assertTrue(any("Earlier work on this issue already finished" in row["payload"]["content"]["body"]
                            for row in self.store.pending(native.ISSUE)))

    def test_unrelated_intact_archived_board_does_not_block_new_authorized_assignment(self):
        path, _ = self.archive_board(body="Linear issue OTHER-1: https://linear.example/issue/OTHER-1")
        before = self.archive_bytes(path)
        self.assign()
        self.assertEqual(len(self.fixture.tasks()), 1)
        self.assertIsNotNone(self.store.get(native.ISSUE))
        self.assertEqual(self.archive_bytes(path), before)

    def test_archive_metadata_wrong_slug_is_not_trusted_or_treated_as_empty(self):
        path, _ = self.archive_board()
        metadata = path / "board.json"
        raw = json.loads(metadata.read_text())
        raw["slug"] = "another-board"
        metadata.write_text(json.dumps(raw))
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(self.fixture.tasks(), [])

    def test_archive_database_symlink_is_not_followed(self):
        path, _ = self.archive_board()
        database = path / "kanban.db"
        saved = database.with_name("saved.db")
        database.rename(saved)
        database.symlink_to(saved)
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(self.fixture.tasks(), [])

    def test_foreign_executor_archive_is_read_as_history_without_implicit_transfer(self):
        path, _ = self.archive_board(assignee="different-local-profile")
        before = self.archive_bytes(path)
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(self.fixture.tasks(), [])
        self.assertEqual(self.archive_bytes(path), before)

    def test_unavailable_registered_database_holds_only_replacement_and_is_not_recreated(self):
        adapter, task_id = self.existing(board="project-work")
        with adapter.conn() as conn:
            original = native.kb.claim_task(conn, task_id)
        database = Path(native.kb.kanban_db_path(board="project-work"))
        saved = database.with_name("temporarily-unavailable.db")
        database.rename(saved)
        try:
            self.assign()
            self.assertFalse(database.exists())
            self.assertIsNone(self.store.get(native.ISSUE))
            self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
            self.assertEqual(self.bridge.native_status(native.ISSUE)["status"], "unlinked")
            self.assertEqual(self.fixture.tasks(), [])
            # Inspection failure does not install a global native execution gate.
            self.board.create(title="Unrelated approved work")
        finally:
            saved.rename(database)
        current = adapter.get(task_id)
        self.assertEqual((current.status, current.current_run_id, current.claim_lock),
                         (original.status, original.current_run_id, original.claim_lock))

    def test_unavailable_archived_database_is_not_treated_as_empty(self):
        path, _ = self.archive_board()
        (path / "kanban.db").rename(path / "temporarily-unavailable.db")
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(self.fixture.tasks(), [])

    def test_discovery_does_not_truncate_older_archived_linked_work(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            native.kb.complete_task(conn, task_id, result="Original completed outcome")
            native.kb.archive_task(conn, task_id)
            for index in range(205):
                native.kb.create_task(conn, title=f"Unrelated {index}", priority=10, assignee="default")
        self.assign()
        self.assertIsNone(self.store.get(native.ISSUE))
        self.assertEqual(len(self.fixture.tasks()), 206)

    def test_synthesized_absent_default_in_fresh_named_board_home_allows_assignment(self):
        home = self.fixture.home / "fresh-home"
        home.mkdir()
        with patch.dict(os.environ, {"HERMES_HOME": str(home), "HERMES_KANBAN_HOME": str(home), "HERMES_PROFILE": "default"}):
            board = native.Kanban("linear-inbox", profile="default", profile_home=home)
            store = native.Store(home / "linear.db")
            bridge = native.Bridge(store, self.fixture.authority.api(scope=None), board, profile="default")
            default = Path(native.kb.kanban_db_path(board="default"))
            self.assertFalse(default.exists())
            bridge.handle_webhook(self.fixture.event())
            self.assertIsNotNone(store.get(native.ISSUE))
            self.assertFalse(default.exists())

    def test_genuinely_fresh_default_initializes_and_allows_assignment(self):
        home = self.fixture.home / "fresh-home"
        home.mkdir()
        with patch.dict(os.environ, {"HERMES_HOME": str(home), "HERMES_KANBAN_HOME": str(home), "HERMES_PROFILE": "default"}):
            database = Path(native.kb.kanban_db_path(board="default"))
            self.assertFalse(database.exists())
            board = native.Kanban(profile="default", profile_home=home)
            self.assertTrue(database.is_file())
            store = native.Store(home / "linear.db")
            bridge = native.Bridge(store, self.fixture.authority.api(scope=None), board, profile="default")
            bridge.handle_webhook(self.fixture.event())
            self.assertIsNotNone(store.get(native.ISSUE))

    def test_existing_wal_history_read_preserves_committed_data_with_native_sqlite_cache_files(self):
        self.existing()
        database = Path(native.kb.kanban_db_path(board="default"))
        # Native SQLite may create its standard WAL-index cache; committed
        # database and WAL data must remain unchanged.
        with closing(sqlite3.connect(database)) as conn:
            self.assertEqual(conn.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        before = self.archive_bytes(database.parent)
        restarted = native.Kanban(profile="default", profile_home=self.fixture.home)
        with restarted.history_conn(database, snapshot=True) as conn:
            self.assertEqual(len(native.kb.list_tasks(conn)), 1)
        restarted.discover(self.issue)
        self.assertEqual(self.archive_bytes(database.parent), before)

    def test_wal_read_transaction_keeps_committed_view_across_another_process_commit(self):
        adapter, task_id = self.existing()
        database = Path(native.kb.kanban_db_path(board="default"))
        from hermes_cli.sqlite_safe_read import connect_tracked
        with closing(connect_tracked(database)) as conn:
            self.assertEqual(conn.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        with adapter.history_conn(database) as reader:
            original = native.kb.get_task(reader, task_id)
            script = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE tasks SET title=? WHERE id=?', ('New committed title',sys.argv[2])); c.commit(); c.close()"
            subprocess.run([sys.executable, "-c", script, str(database), task_id], timeout=3, check=True)
            self.assertEqual(native.kb.get_task(reader, task_id).title, original.title)
        with adapter.history_conn(database) as reader:
            self.assertEqual(native.kb.get_task(reader, task_id).title, "New committed title")

    def test_missing_previously_configured_default_is_not_fresh_setup(self):
        database = Path(native.kb.kanban_db_path(board="default"))
        saved = database.with_name("temporarily-unavailable.db")
        database.rename(saved)
        try:
            self.assign()
            self.assertFalse(database.exists())
            self.assertIsNone(self.store.get(native.ISSUE))
        finally:
            saved.rename(database)

    def invalid_startup(self, kind, *, board="default"):
        adapter, task_id = self.existing(board=None if board == "default" else board)
        with adapter.conn() as conn:
            original = native.kb.claim_task(conn, task_id)
        database = Path(native.kb.kanban_db_path(board=board))
        saved = database.with_name("prior-unavailable.db")
        database.rename(saved)
        if kind == "schema-less":
            with closing(sqlite3.connect(database)) as conn:
                conn.execute("CREATE TABLE unrelated (value TEXT)")
                conn.commit()
        else:
            content = {"empty": b"", "truncated": saved.read_bytes()[:100],
                       "corrupt": b"not a SQLite database", "read-refused": saved.read_bytes()}[kind]
            database.write_bytes(content)
        before = database.read_bytes()
        def data_names():
            return {item for item in database.parent.iterdir() if item.name != database.name + "-shm"
                    and not (item.name == database.name + "-wal" and item.stat().st_size == 0)}
        names = data_names()
        if kind == "read-refused":
            database.chmod(0)
        adapter.kc._INITIALIZED_PATHS.discard(str(database.resolve()))
        try:
            restarted = native.Kanban(board, profile="default", profile_home=self.fixture.home)
            bridge = native.Bridge(self.store, self.fixture.authority.api(scope=None), restarted, profile="default")
            bridge.profile_home = self.fixture.home
            from hermes_fleet_linear_plugin import chat
            context = SimpleNamespace(profile="default", home=self.fixture.home, pinned_db_path="")
            result = json.loads(chat.handle(bridge, {"action": "status", "issue": native.ISSUE}, context))
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["issue"]["id"], native.ISSUE)
            bridge.handle_webhook(self.fixture.event())
            self.assertIsNone(self.store.get(native.ISSUE))
            self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
            with self.assertRaises(native.LinearError):
                restarted.get(task_id)
            self.assertEqual(data_names(), names)
        finally:
            database.chmod(0o600)
            after = database.read_bytes()
            database.unlink()
            saved.rename(database)
        self.assertEqual(after, before)
        bridge.handle_webhook(self.fixture.event())
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        current = restarted.get(task_id)
        self.assertEqual((current.current_run_id, current.claim_lock), (original.current_run_id, original.claim_lock))

    def test_restart_preserves_empty_existing_database_without_reinitializing(self):
        self.invalid_startup("empty")

    def test_restart_preserves_truncated_existing_database_without_repair(self):
        self.invalid_startup("truncated")

    def test_restart_preserves_schema_less_existing_database_without_adoption(self):
        self.invalid_startup("schema-less")

    def test_restart_preserves_corrupt_existing_database_without_crashing_reporting(self):
        self.invalid_startup("corrupt")

    def test_restart_preserves_read_refused_existing_database_without_crashing_reporting(self):
        self.invalid_startup("read-refused")

    def test_restart_preserves_empty_named_database_without_reinitializing(self):
        self.invalid_startup("empty", board="project-work")

    def test_restart_preserves_corrupt_named_database_without_crashing_reporting(self):
        self.invalid_startup("corrupt", board="project-work")

    def test_linked_issue_read_survives_corrupt_native_storage(self):
        self.existing()
        self.assign()
        database = Path(native.kb.kanban_db_path(board="default"))
        saved = database.with_name("prior-unavailable.db")
        database.rename(saved)
        database.write_bytes(b"corrupt native storage")
        try:
            from hermes_fleet_linear_plugin import chat
            self.bridge.profile_home = self.fixture.home
            context = SimpleNamespace(profile="default", home=self.fixture.home, pinned_db_path="")
            result = json.loads(chat.handle(self.bridge, {"action": "status", "issue": native.ISSUE}, context))
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["issue"]["id"], native.ISSUE)
            self.assertFalse(result["native"]["linked"])
            self.assertEqual(result["native"]["status"], "reconciliation")
            with patch.object(self.bridge.api, "issue", side_effect=native.LinearError("Current issue authorization refused", retryable=False)):
                refused = json.loads(chat.handle(self.bridge, {"action": "status", "issue": native.ISSUE}, context))
            self.assertFalse(refused["ok"])
            self.assertNotIn("issue", refused)
        finally:
            database.unlink()
            saved.rename(database)

    def test_plugin_restart_does_not_recreate_missing_default_and_issue_reads_still_work(self):
        adapter, task_id = self.existing()
        with adapter.conn() as conn:
            original = native.kb.claim_task(conn, task_id)
        database = Path(native.kb.kanban_db_path(board="default"))
        self.assertFalse(native.kb.board_metadata_path("default").exists())  # Metadata is synthesized.
        saved = database.with_name("missing-saved.db")
        database.rename(saved)
        try:
            restarted = native.Kanban(profile="default", profile_home=self.fixture.home)
            self.assertFalse(database.exists())
            bridge = native.Bridge(self.store, self.fixture.authority.api(scope=None), restarted, profile="default")
            bridge.profile_home = self.fixture.home
            from hermes_fleet_linear_plugin import chat
            # Isolated handler fixture; transport identity producer paths have
            # separate real-native frontdoor coverage, not a client-UAT claim.
            context = SimpleNamespace(profile="default", home=self.fixture.home, pinned_db_path="")
            result = json.loads(chat.handle(bridge, {"action": "status", "issue": native.ISSUE}, context))
            self.assertTrue(result["ok"])
            self.assertEqual(result["issue"]["id"], native.ISSUE)
            bridge.handle_webhook(self.fixture.event())
            self.assertFalse(database.exists())
            self.assertIsNone(self.store.get(native.ISSUE))
            self.assertIsNone(self.store.native_intent(f"create:{native.ISSUE}"))
        finally:
            saved.rename(database)
        # Restoring native data is sufficient; no plugin marker/reset is needed.
        bridge.handle_webhook(self.fixture.event())
        self.assertEqual(self.store.get(native.ISSUE)["task_id"], task_id)
        current = restarted.get(task_id)
        self.assertEqual((current.current_run_id, current.claim_lock), (original.current_run_id, original.claim_lock))

    def test_plugin_restart_does_not_recreate_missing_registered_named_database(self):
        adapter, task_id = self.existing(board="project-work")
        database = Path(native.kb.kanban_db_path(board="project-work"))
        saved = database.with_name("missing-saved.db")
        database.rename(saved)
        try:
            restarted = native.Kanban("project-work", profile="default", profile_home=self.fixture.home)
            self.assertFalse(database.exists())
            bridge = native.Bridge(self.store, self.fixture.authority.api(scope=None), restarted, profile="default")
            bridge.handle_webhook(self.fixture.event())
            self.assertFalse(database.exists())
            self.assertIsNone(self.store.get(native.ISSUE))
        finally:
            saved.rename(database)
        self.assertEqual(adapter.get(task_id).status, "ready")

    def test_missing_default_with_native_workspace_evidence_is_not_initialized_even_without_lock(self):
        adapter, task_id = self.existing()
        from hermes_cli.kanban_db_workspace import resolve_workspace
        workspace = Path(resolve_workspace(adapter.get(task_id), board="default"))
        self.assertTrue(workspace.is_dir())
        database = Path(native.kb.kanban_db_path(board="default"))
        saved = database.with_name("missing-saved.db")
        database.rename(saved)
        Path(str(database) + ".init.lock").unlink()
        try:
            native.Kanban(profile="default", profile_home=self.fixture.home)
            self.assertFalse(database.exists())
            self.assign()
            self.assertFalse(database.exists())
            self.assertIsNone(self.store.get(native.ISSUE))
        finally:
            saved.rename(database)

    def test_named_service_does_not_ignore_missing_default_with_prior_initialization_evidence(self):
        self.existing()
        creation = native.Kanban("linear-inbox", profile="default", profile_home=self.fixture.home)
        database = Path(native.kb.kanban_db_path(board="default"))
        saved = database.with_name("missing-saved.db")
        database.rename(saved)
        try:
            bridge = native.Bridge(self.store, self.fixture.authority.api(scope=None), creation, profile="default")
            bridge.handle_webhook(self.fixture.event())
            self.assertFalse(database.exists())
            self.assertIsNone(self.store.get(native.ISSUE))
            with creation.conn() as conn:
                self.assertEqual(native.kb.list_tasks(conn), [])
        finally:
            saved.rename(database)


if __name__ == "__main__":
    unittest.main()
