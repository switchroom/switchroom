"""Native board validation and finished-binding pumps cost nothing until native or reporting state changes.

Real pinned Core Kanban (HERMES_AGENT_SRC). Each check keeps its refusal: a changed, corrupt or
symlinked board is validated again and refused, and any native or reporting change runs the full pump.
"""
from __future__ import annotations

import os
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import patch

import test_linear_native_bridge_scenarios as native
from hermes_fleet_linear_plugin import bridge as bridge_module
from hermes_fleet_linear_plugin.bridge import Kanban

STEPS = ("_worker_progress", "_recheck_acceptance", "_resume_pr_park", "_reconcile_status", "_recover_binding_delegate")


@unittest.skipIf(native.CORE is not None, f"native source unavailable ({native.CORE})")
class BoardValidationScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = native.NativeBridgeScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        with bridge_module._native_validation_lock:
            bridge_module._native_validated.clear()
            bridge_module._native_keys_validated.clear()
        self.board = self.fixture.board
        with self.board.conn() as conn:
            self.task_id = native.kb.create_task(conn, title="native task", assignee="default")
        self.database = native.Path(native.kb.kanban_db_path(board=self.board.board))
        self.checks = []
        original = Kanban.native_integrity_ok
        def counting(conn):
            self.checks.append(1)
            return original(conn)
        patcher = patch.object(Kanban, "native_integrity_ok", staticmethod(counting))
        patcher.start()
        self.addCleanup(patcher.stop)
        # The first read-only open creates the empty WAL, so the board settles on the second read.
        self.read()
        self.read()
        self.checks.clear()

    def read(self):
        return self.board.history(self.task_id, 0)

    def test_unchanged_board_is_not_validated_again(self):
        for _ in range(5):
            self.read()
            self.board.get(self.task_id)
        self.assertEqual(self.checks, [])

    def test_any_write_or_checkpoint_validates_again(self):
        from hermes_cli.sqlite_safe_read import connect_tracked
        # An open reader keeps the write's frames in the WAL (no checkpoint on last close), so the
        # checkpoint below really moves pages into the database file and empties the WAL.
        with closing(connect_tracked(self.database)) as keeper:
            keeper.execute("SELECT count(*) FROM tasks").fetchone()
            with self.board.conn() as conn:
                native.kb.add_comment(conn, self.task_id, "operator", "a later native note")
            self.read()
            self.assertEqual(len(self.checks), 1)
            self.read()
            self.assertEqual(len(self.checks), 1)
            self.assertGreater(os.stat(str(self.database) + "-wal").st_size, 0)
            keeper.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            self.assertEqual(os.stat(str(self.database) + "-wal").st_size, 0)
            self.read()
            self.assertEqual(len(self.checks), 2)
            self.read()
            self.assertEqual(len(self.checks), 2)

    def test_validation_expires(self):
        later = bridge_module.time.monotonic() + bridge_module.NATIVE_VALIDATION_MAX_AGE + 1
        with patch.object(bridge_module.time, "monotonic", return_value=later):
            self.read()
        self.assertEqual(len(self.checks), 1)

    def test_failed_validation_is_refused_and_never_remembered(self):
        with self.board.conn() as conn:
            native.kb.add_comment(conn, self.task_id, "operator", "a later native note")
        with patch.object(Kanban, "native_integrity_ok", staticmethod(lambda conn: self.checks.append(1) or False)):
            for _ in range(2):
                with self.assertRaises(native.LinearError):
                    self.read()
        self.assertEqual(len(self.checks), 2)
        self.read()
        self.assertEqual(len(self.checks), 3)

    def test_corrupted_board_is_refused_after_a_cached_pass(self):
        with self.board.conn() as conn:
            for n in range(40):
                native.kb.add_comment(conn, self.task_id, "operator", f"note {n} " + "x" * 400)
        with closing(sqlite3.connect(self.database)) as conn:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            page = conn.execute("PRAGMA page_size").fetchone()[0]
            root = conn.execute("SELECT rootpage FROM sqlite_master WHERE name='task_comments'").fetchone()[0]
        with open(self.database, "r+b") as handle:  # Overwrite the comment table's root page.
            handle.seek((root - 1) * page + 8)
            handle.write(b"\xff" * 64)
        for _ in range(2):
            with self.assertRaises(native.LinearError):
                self.board.comment_text(self.task_id, "operator", 10, 0)

    def test_symlinked_board_is_refused_even_when_validated(self):
        moved = self.database.with_name("moved.db")
        os.replace(self.database, moved)
        os.symlink(moved, self.database)
        with self.assertRaises(native.LinearError):
            self.read()

    def test_unreadable_keys_written_later_are_refused(self):
        with self.board.conn() as conn:
            other = native.kb.create_task(conn, title="other native task", assignee="default")
        from hermes_cli.sqlite_safe_read import connect_tracked
        with closing(connect_tracked(self.database)) as conn:
            conn.execute("UPDATE task_events SET task_id=? WHERE task_id=?", (b"native-\xff", other))
            conn.commit()
        with self.assertRaises(native.LinearError):
            self.read()


@unittest.skipIf(native.CORE is not None, f"native source unavailable ({native.CORE})")
class FinishedBindingScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = native.NativeBridgeScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.clock, self.remote, self.reporter, self.task_id = self.fixture.reporting_fixture("finished")
        self.fixture.complete_reported_task(self.clock, self.task_id)
        self.reporter.pump_kanban()
        self.clock.now += 10
        self.reporter.flush()
        self.assertEqual(self.remote.state(native.ISSUE), "Done")
        self.assertFalse(self.reporter.store.pending())

    def pump(self):
        """One pump; returns how many binding steps ran and the outbox afterwards."""
        calls = []
        def counted(name):
            step = getattr(self.reporter, name)
            def run(*args):
                calls.append(name)
                return step(*args)
            run.__name__ = name  # The pump keys its persisted backoff by step name.
            return run
        patches = [patch.object(self.reporter, name, counted(name)) for name in STEPS]
        for item in patches:
            item.start()
        try:
            self.reporter.pump_kanban()
        finally:
            for item in patches:
                item.stop()
        with closing(sqlite3.connect(self.reporter.store.path)) as db:
            return calls, db.execute("SELECT id, state, hold_reason, payload FROM outbox ORDER BY rowid").fetchall()

    def test_reported_finished_work_is_not_pumped_again_until_native_history_changes(self):
        _, before = self.pump()
        for _ in range(3):
            calls, after = self.pump()
            self.assertEqual(calls, [])
            self.assertEqual(after, before)
        self.clock.now += 1
        with self.fixture.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            native.kb.add_comment(conn, self.task_id, "operator", "A later note on finished work")
        newest = max(event.id for event in self.fixture.board.history(self.task_id, 0))
        calls, _ = self.pump()
        self.assertTrue(calls)
        self.assertEqual(self.reporter.store.get(native.ISSUE)["last_event_id"], newest)
        self.assertEqual(self.pump()[0], [])

    def test_reporting_writes_recheck_the_closeout(self):
        self.pump()
        closeouts = []
        original = self.reporter.store.quiescent_closeout
        def counting(*args, **kwargs):
            closeouts.append(1)
            return original(*args, **kwargs)
        with patch.object(self.reporter.store, "quiescent_closeout", side_effect=counting):
            self.pump()
            self.assertEqual(closeouts, [])
            with closing(sqlite3.connect(self.reporter.store.path)) as db:
                db.execute("UPDATE outbox SET attempts=attempts")
                db.commit()
            self.pump()
            self.assertEqual(closeouts, [1])

    def test_held_closeout_is_pumped(self):
        self.pump()
        with closing(sqlite3.connect(self.reporter.store.path)) as db:
            db.execute("UPDATE outbox SET hold_reason='operator hold' WHERE kind='status'")
            db.commit()
        self.assertTrue(self.pump()[0])

    def test_unreadable_board_skips_nothing(self):
        self.pump()
        with patch.object(Kanban, "quiescence_index", side_effect=sqlite3.OperationalError("locked")):
            self.assertTrue(self.pump()[0])


if __name__ == "__main__":
    unittest.main()
