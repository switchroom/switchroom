"""The reporting loop stays cheap without changing what it holds, binds, compares or shows.

Covers the hold-scan memo (store), the busy-listener handoff (transport and service loop), the
create-readback comparator (api) and the operator status text (ops). Board validation caching
and the finished-binding pump skip need native Kanban and live in
test_linear_tick_cost_scenarios.py.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import random
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import closing, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from linear_fake_api import load_plugin

plugin = load_plugin()
from hermes_fleet_linear_plugin import api, ops, store as store_module, transport
from hermes_fleet_linear_plugin.store import Store


def holds(path: Path) -> dict[str, str | None]:
    with closing(sqlite3.connect(path)) as db:
        return dict(db.execute("SELECT id, hold_reason FROM outbox ORDER BY rowid"))


class HoldMemoTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "state.db"
        self.store = Store(self.path)

    def raw(self, sql: str, *args) -> None:
        """Another writer (operator CLI, older build, second process) changes the database."""
        with closing(sqlite3.connect(self.path)) as db:
            db.execute(sql, args)
            db.commit()

    def bind(self, issue: str, task: str) -> None:
        self.raw("INSERT INTO work(issue_id, origin, owner_ref, task_id) VALUES (?, 'native', '', ?) "
                 "ON CONFLICT(issue_id) DO UPDATE SET origin='native', task_id=excluded.task_id", issue, task)
        self.raw("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 f"native-binding:{issue}", json.dumps({"issue_id": issue, "task_id": task,
                                                        "profile": "default", "board": "default"}))

    def report(self, issue: str, task: str | None, **extra) -> str:
        row_id = str(uuid.uuid4())
        payload = {"issue_id": issue, "state": "in_progress", **({"task_id": task} if task else {}), **extra}
        self.raw("INSERT INTO outbox(id, kind, payload, next_at) VALUES (?, 'status', ?, 0)", row_id, json.dumps(payload))
        return row_id

    def forced(self) -> dict[str, str | None]:
        """What an unmemoised scan holds now, on a copy so the memo under test is not touched."""
        copy = self.path.with_name("forced.db")
        with closing(sqlite3.connect(self.path)) as source, closing(sqlite3.connect(copy)) as target:
            source.backup(target)
            target.row_factory = sqlite3.Row
            Store._hold_scan(target)
            target.commit()
        try:
            return holds(copy)
        finally:
            copy.unlink()

    def test_memoised_holds_equal_a_full_scan_after_any_mix_of_writes(self):
        rng = random.Random(744)
        issues, rows, unheld = [f"issue-{n}" for n in range(4)], [], 0
        for step in range(160):
            issue, task = rng.choice(issues), f"task-{rng.randrange(3)}"
            action = rng.randrange(10)
            if action == 0:
                self.bind(issue, task)
            elif action == 1:
                self.raw("DELETE FROM metadata WHERE key=?", f"native-binding:{issue}")
            elif action == 2:
                self.raw("UPDATE work SET task_id=? WHERE issue_id=?", task, issue)
            elif action == 3:
                self.raw("DELETE FROM work WHERE issue_id=?", issue)
            elif action in (4, 5):
                rows.append(self.report(issue, task if rng.random() < .9 else None))
            elif action == 6 and rows:
                dependency = rng.choice(rows)
                rows.append(self.report(issue, task, requires_status_id=dependency))
            elif action == 7 and rows:
                self.raw("UPDATE outbox SET payload=json_set(payload, '$.task_id', ?) WHERE id=?", task, rng.choice(rows))
            elif action == 8 and rows:
                # Send bookkeeping only: the memo may skip, and must still agree with a full scan.
                self.raw("UPDATE outbox SET payload=json_set(payload, '$.write_started', json('true')), "
                         "attempts=attempts+1 WHERE id=?", rng.choice(rows))
            elif action == 9 and rows:
                self.raw("UPDATE outbox SET state=? WHERE id=?", rng.choice(("pending", "sent", "failed")), rng.choice(rows))
            if rows:
                self.store.delivery_allowed(rows[-1])
                with self.subTest(step=step):
                    self.assertEqual(holds(self.path), self.forced())
                unheld += sum(reason is None for reason in holds(self.path).values())
        self.assertTrue(any(holds(self.path).values()))
        self.assertGreater(unheld, 0)  # The sequence exercised deliverable rows, not only holds.

    def test_replaced_binding_from_another_writer_holds_the_old_report(self):
        self.bind("issue-1", "task-1")
        row = self.report("issue-1", "task-1")
        self.assertTrue(self.store.delivery_allowed(row))
        self.assertTrue(self.store.delivery_allowed(row))
        self.bind("issue-1", "task-2")  # A binding replaced outside this Store object.
        self.assertFalse(self.store.delivery_allowed(row))
        self.assertIn("binding", holds(self.path)[row] or "")

    def test_unchanged_inputs_scan_once_and_any_input_change_scans_again(self):
        self.bind("issue-1", "task-1")
        row = self.report("issue-1", "task-1")
        original = Store._hold_scan.__func__
        scans = []
        def counting(cls, db):
            scans.append(1)
            return original(cls, db)
        with patch.object(Store, "_hold_scan", classmethod(counting)):
            for _ in range(20):
                self.assertTrue(self.store.delivery_allowed(row))
            self.assertEqual(len(scans), 1)
            self.raw("UPDATE outbox SET payload=json_set(payload, '$.write_started', json('false')) WHERE id=?", row)
            self.store.delivery_allowed(row)
            self.assertEqual(len(scans), 1)  # Send bookkeeping is not a hold input.
            self.report("issue-1", "task-1")
            self.store.delivery_allowed(row)
            self.assertEqual(len(scans), 2)
            self.raw("UPDATE work SET last_event_id=last_event_id+1")
            self.store.delivery_allowed(row)
            self.assertEqual(len(scans), 2)  # The pump cursor is not a hold input.
            self.raw("UPDATE work SET task_id='task-9'")
            self.store.delivery_allowed(row)
            self.assertEqual(len(scans), 3)
            with patch.object(store_module, "HOLD_RULES_VERSION", store_module.HOLD_RULES_VERSION + 1):
                self.store.delivery_allowed(row)
            self.assertEqual(len(scans), 4)
            self.raw("DELETE FROM metadata WHERE key=?", store_module.HOLD_INPUTS)
            self.store.delivery_allowed(row)
            self.store.delivery_allowed(row)
            self.assertEqual(len(scans), 5)  # A missing counter scans, then counts again.

    def test_a_rolled_back_scan_leaves_no_marker(self):
        self.bind("issue-1", "task-1")
        row = self.report("issue-1", "task-9")  # Mismatched task: the scan holds it.
        with self.assertRaises(RuntimeError):
            with self.store._tx() as db:
                Store._hold_legacy_outbox(db)
                raise RuntimeError("abort")
        self.assertIsNone(holds(self.path)[row])
        self.assertFalse(self.store.delivery_allowed(row))
        self.assertIsNotNone(holds(self.path)[row])

    def test_reporting_writes_move_the_quiet_version_and_reads_do_not(self):
        self.bind("issue-1", "task-1")
        row = self.report("issue-1", "task-1")
        before = self.store.quiet_version()
        self.assertIsNotNone(before)
        self.store.delivery_allowed(row)
        self.store.terminal_captured("task-1", issue_id="issue-1")
        self.store.backoff_fail("unrelated", time.time())
        self.assertEqual(self.store.quiet_version(), before)
        for sql in ("UPDATE outbox SET attempts=attempts+1", "UPDATE work SET last_event_id=7",
                    "INSERT INTO metadata(key, value) VALUES ('acceptance-recheck-settled:x', '1')"):
            self.raw(sql)
            after = self.store.quiet_version()
            self.assertNotEqual(after, before, sql)
            before = after

    def test_payload_lookups_use_the_indexes(self):
        with closing(sqlite3.connect(self.path)) as db:
            for field in ("issue_id", "task_id"):
                plan = " ".join(row[-1] for row in db.execute(
                    f"EXPLAIN QUERY PLAN SELECT id FROM outbox WHERE json_extract(payload, '$.{field}')=?", ("x",)))
                self.assertIn(f"outbox_payload_{field.split('_')[0]}", plan)


class StoreConnectionTests(unittest.TestCase):
    """The store reuses one connection per thread, and a transaction still leaves no lock behind."""
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "state.db"
        self.store = Store(self.path)
        self.other = sqlite3.connect(self.path, isolation_level=None, timeout=0, check_same_thread=False)
        self.addCleanup(self.other.close)
        self.addCleanup(self.store._drop_thread_connection)

    def unlocked(self) -> bool:
        """Another process can take the write lock right now, without waiting."""
        try:
            self.other.execute("BEGIN EXCLUSIVE")
        except sqlite3.OperationalError:
            return False
        self.other.execute("COMMIT")
        return True

    def seed(self, rows: int = 50) -> None:
        with self.store._tx() as db:
            db.executemany("INSERT INTO metadata(key, value) VALUES (?, '1')", [(f"k{n}",) for n in range(rows)])

    def test_transactions_on_one_thread_share_a_connection(self):
        with self.store._tx() as first:
            pass
        with self.store._tx() as second:
            pass
        self.assertIs(first, second)
        self.assertIsNone(getattr(self.store._local, "db", None))
        self.assertTrue(self.unlocked())

    def test_each_thread_has_its_own_connection(self):
        with self.store._tx() as mine:
            pass
        theirs = []
        def other_thread():
            with self.store._tx() as db:
                theirs.append(db)
            self.store._drop_thread_connection()
        worker = threading.Thread(target=other_thread)
        worker.start()
        worker.join(5)
        self.assertEqual(len(theirs), 1)
        self.assertIsNot(theirs[0], mine)

    def test_a_part_read_cursor_holds_no_lock_after_its_transaction(self):
        self.seed()
        with self.store._tx() as db:
            cursor = db.execute("SELECT key FROM metadata")
            cursor.fetchone()  # left part-read, and still referenced below
        self.assertTrue(self.unlocked())
        with self.assertRaises(sqlite3.ProgrammingError):
            cursor.fetchone()  # as with a closed connection, a cursor never outlives its transaction

    def test_a_part_read_generator_holds_no_lock_after_its_transaction(self):
        self.seed()
        def keys():
            with self.store._tx() as db:
                rows = db.execute("SELECT key FROM metadata")
            yield from rows
        reader = keys()
        with self.assertRaises(sqlite3.ProgrammingError):
            next(reader)
        self.assertTrue(self.unlocked())

    def test_a_failed_transaction_rolls_back_and_reconnects(self):
        with self.store._tx() as before:
            pass
        with self.assertRaises(RuntimeError):
            with self.store._tx() as db:
                db.execute("INSERT INTO metadata(key, value) VALUES ('lost', '1')")
                raise RuntimeError("boom")
        self.assertTrue(self.unlocked())
        with self.store._tx() as after:
            self.assertIsNone(after.execute("SELECT 1 FROM metadata WHERE key='lost'").fetchone())
        self.assertIsNot(after, before)

    def test_a_replaced_database_file_gets_a_new_connection(self):
        with self.store._tx() as before:
            before.execute("INSERT INTO metadata(key, value) VALUES ('old', '1')")
        replacement = self.path.with_name("restored.db")
        with closing(sqlite3.connect(self.path)) as source, closing(sqlite3.connect(replacement)) as target:
            source.backup(target)
            target.execute("INSERT INTO metadata(key, value) VALUES ('restored', '1')")
            target.commit()
        replacement.replace(self.path)  # an operator restores a backup over the live file
        with self.store._tx() as after:
            self.assertIsNotNone(after.execute("SELECT 1 FROM metadata WHERE key='restored'").fetchone())
        self.assertIsNot(after, before)

    def test_writes_from_another_process_are_seen_on_the_reused_connection(self):
        with self.store._tx() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM metadata WHERE key='theirs'").fetchone())
        self.other.execute("INSERT INTO metadata(key, value) VALUES ('theirs', '1')")
        with self.store._tx() as db:
            self.assertIsNotNone(db.execute("SELECT 1 FROM metadata WHERE key='theirs'").fetchone())


class BusyListenerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.path = transport._private_parent(self.home, create=True) / "chat.sock"

    def busy_listener(self):
        """A live owner that never accepts, with its accept backlog full (a starved gateway)."""
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.path))
        listener.listen(0)
        clients = []
        for _ in range(64):
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.setblocking(False)
            clients.append(client)
            try:
                client.connect(str(self.path))
            except BlockingIOError:
                break
        else:
            self.fail("backlog never filled")
        def close():
            for item in clients:
                item.close()
            listener.close()
        return close

    def test_full_backlog_is_an_owner_not_a_crash(self):
        close = self.busy_listener()
        self.addCleanup(close)
        with self.assertRaises(transport.Unavailable) as raised:
            transport.Server(self.home, "alpha", lambda *args: None)
        self.assertEqual(str(raised.exception), transport.OWNED)
        self.assertTrue(self.path.is_socket())  # The live owner keeps its socket.

    def test_probe_timeout_is_an_owner(self):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.path))
        self.addCleanup(listener.close)
        with patch.object(socket.socket, "connect", side_effect=TimeoutError("timed out")):
            with self.assertRaises(transport.Unavailable) as raised:
                transport.Server(self.home, "alpha", lambda *args: None)
        self.assertEqual(str(raised.exception), transport.OWNED)

    def test_other_probe_errors_surface(self):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.path))
        self.addCleanup(listener.close)
        with patch.object(socket.socket, "connect", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                transport.Server(self.home, "alpha", lambda *args: None)
        self.assertTrue(self.path.is_socket())

    def test_stale_socket_file_is_replaced(self):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.path))
        listener.close()  # Nobody listens; the file remains.
        server = transport.Server(self.home, "alpha", lambda *args: None)
        self.addCleanup(server.close)
        self.assertTrue(self.path.is_socket())

    def run_loop(self, stop: threading.Event, *, on_server=None):
        """The real service loop with stub identity, store, board and bridge, and the real socket."""
        values = {"enabled": True, "identity": {"viewer_id": "app-a", "organization_id": "org-a"}, "tick_seconds": 0.05}
        context = SimpleNamespace(get_config=lambda key, default=None: values.get(key, default))
        apis = SimpleNamespace(viewer_id=lambda: "app-a", clock=lambda: 0, paused_until=0, token=None)
        bridge = Mock(recheck_every=60)
        def tick(_ingress):
            if on_server:
                on_server()
            stop.set()
        bridge.tick.side_effect = tick
        async def run():
            with patch.object(plugin, "BoundLinearAPI", return_value=apis), \
                    patch.object(plugin, "token_provider", return_value=lambda: "synthetic"), \
                    patch.object(plugin, "Store"), patch.object(plugin, "Kanban") as kanban, \
                    patch.object(plugin, "Bridge", return_value=bridge), \
                    patch.object(plugin.diag, "service_start"), \
                    patch.dict(__import__("sys").modules, {"hermes_cli.profiles": SimpleNamespace(
                        get_active_profile_name=lambda: "default")}):
                kanban.resolve_executor_profile.return_value = "default"
                await asyncio.wait_for(plugin._reporting_loop(context, self.home, stop, {}), 10)
        asyncio.run(run())
        return bridge

    def test_service_waits_visibly_for_a_busy_owner_then_binds_when_it_exits(self):
        close = self.busy_listener()
        stop, bound = threading.Event(), []
        threading.Timer(0.6, close).start()
        with self.assertLogs(plugin.diag.LOGGER_NAME, level=logging.WARNING) as logs:
            bridge = self.run_loop(stop, on_server=lambda: bound.append(self.path.is_socket()))
        self.assertEqual(bound, [True])
        self.assertTrue(bridge.tick.called)
        waits = [line for line in logs.output if "reason=socket_owned" in line]
        self.assertEqual(len(waits), 1)
        self.assertIn("waited_s=0", waits[0])

    def test_stop_ends_the_wait_for_an_owner(self):
        close = self.busy_listener()
        self.addCleanup(close)
        stop = threading.Event()
        threading.Timer(0.5, stop.set).start()
        bridge = self.run_loop(stop)
        bridge.tick.assert_not_called()


class CreateReadbackTests(unittest.TestCase):
    ACCEPTED = {
        "full_url": ("PR: https://github.com/a/b/pull/1",
                     "PR: [https://github.com/a/b/pull/1](<https://github.com/a/b/pull/1>)"),
        "url_then_period": ("See https://a.example/x.", "See [https://a.example/x](<https://a.example/x>)."),
        "bare_host_path": ("under ghcr.io/switchroom yet", "under [ghcr.io/switchroom](<http://ghcr.io/switchroom>) yet"),
        "bold_split_around_code": ("**site (`repo`, branch `main`):** x", "**site (**`repo`**, branch** `main`**):** x"),
        "all_together": ("## Work\n- **A.** see `x` at https://a.example/y and ghcr.io/s\n```\nhttps://raw\n```",
                         "## Work\n\n* **A.** see `x` at [https://a.example/y](<https://a.example/y>) and "
                         "[ghcr.io/s](<http://ghcr.io/s>)\n```\nhttps://raw\n```"),
        # Linear closes bold before a link that ends the bold run (synthetic reduction of a live create).
        "bold_closed_before_link": ("5. **Wait for [OPS-9](https://a.example/i/OPS-9)** (the other job): then go.",
                                    "5. **Wait for** [OPS-9](https://a.example/i/OPS-9) (the other job): then go."),
        "bold_opened_after_link": ("**[OPS-9](https://a.example/i/OPS-9) is done**",
                                   "[OPS-9](https://a.example/i/OPS-9) **is done**"),
        "bold_link_angle_target": ("**see [OPS-9](<https://a.example/i/OPS-9>)** now",
                                   "**see** [OPS-9](<https://a.example/i/OPS-9>) now"),
        # Linear stores bold code alone as plain code (seen live; accepted before this change too).
        "bold_only_code_dropped": ("- **`org/repo`**: has notes.", "* `org/repo`: has notes."),
        # The other live create: a blank line added between a paragraph and the checklist under it.
        "blank_line_before_list": ("## Phase\nDo this first.\n- [ ] one\n- [ ] two",
                                   "## Phase\n\nDo this first.\n\n- [ ] one\n- [ ] two"),
    }
    REJECTED = {
        "bold_removed": ("**NOT** this", "NOT this"),
        "bold_added": ("NOT this", "**NOT** this"),
        "literal_kwargs": ("call f(**kwargs)", "call f(kwargs)"),
        "https_for_http_host": ("under ghcr.io/switchroom", "under [ghcr.io/switchroom](<https://ghcr.io/switchroom>)"),
        "http_for_https_url": ("PR https://a.example/x", "PR [https://a.example/x](<http://a.example/x>)"),
        "trailing_dot_inside_url": ("PR https://a.example/x", "PR [https://a.example/x.](<https://a.example/x.>)"),
        "changed_path": ("PR https://a.example/x", "PR [https://a.example/y](<https://a.example/y>)"),
        "added_query": ("PR https://a.example/x", "PR [https://a.example/x?q=1](<https://a.example/x?q=1>)"),
        "added_port": ("see a.example/x", "see [a.example:8080/x](<http://a.example:8080/x>)"),
        "label_and_target_differ": ("see https://a.example/x", "see [https://a.example/x](<https://other.example/x>)"),
        "checklist_state": ("- [x] done", "- [ ] done"),
        "changed_link_target": ("[docs](https://a.example/x)", "[docs](https://a.example/y)"),
        "changed_code": ("run `make test` now", "run `make tests` now"),
        "changed_word": ("**site (`repo`):** ship", "**site (**`repo`**):** skip"),
        "link_inside_code": ("run `curl https://a.example/x`", "run `curl [https://a.example/x](<https://a.example/x>)`"),
        "link_inside_fence": ("```\nhttps://a.example/x\n```", "```\n[https://a.example/x](<https://a.example/x>)\n```"),
        "authored_link_removed": ("[https://a.example/x](https://a.example/x)", "https://a.example/x"),
        # Bold moved off a link is tolerated; a changed link, word or bold prose is not.
        "bold_link_target_changed": ("**Wait for [OPS-9](https://a.example/i/OPS-9)** now",
                                     "**Wait for** [OPS-9](https://a.example/i/OPS-8) now"),
        "bold_link_label_changed": ("**Wait for [OPS-9](https://a.example/i/OPS-9)** now",
                                    "**Wait for** [OPS-8](https://a.example/i/OPS-9) now"),
        "bold_link_dropped": ("**Wait for [OPS-9](https://a.example/i/OPS-9)** now", "**Wait for** OPS-9 now"),
        "bold_link_word_changed": ("**Wait for [OPS-9](https://a.example/i/OPS-9)** now",
                                   "**Wait on** [OPS-9](https://a.example/i/OPS-9) now"),
        "bold_prose_lost_beside_link": ("**NOT** [OPS-9](https://a.example/i/OPS-9) yet",
                                        "NOT [OPS-9](https://a.example/i/OPS-9) yet"),
        "bold_prose_grew_beside_link": ("**Wait** for [OPS-9](https://a.example/i/OPS-9)",
                                        "**Wait for** [OPS-9](https://a.example/i/OPS-9)"),
        # A bold run that holds only a link or code is that link's or code's own bold.
        "bold_only_link_dropped": ("**[OPS-9](https://a.example/i/OPS-9)**", "[OPS-9](https://a.example/i/OPS-9)"),
        "bold_only_link_dropped_mid_line": ("a **[OPS-9](https://a.example/i/OPS-9)** b",
                                            "a [OPS-9](https://a.example/i/OPS-9) b"),
        "bold_only_link_added": ("a [OPS-9](https://a.example/i/OPS-9) b",
                                 "a **[OPS-9](https://a.example/i/OPS-9)** b"),
        "bold_only_link_beside_code_dropped": ("**`v1` [OPS-9](https://a.example/i/OPS-9)**",
                                               "`v1` [OPS-9](https://a.example/i/OPS-9)"),
    }

    def test_linear_rewrites_on_create_compare_equal(self):
        for name, (authored, stored) in self.ACCEPTED.items():
            with self.subTest(name):
                self.assertTrue(api.created_markdown_matches(stored, authored))

    def test_substantive_changes_still_differ(self):
        for name, (authored, stored) in self.REJECTED.items():
            with self.subTest(name):
                self.assertFalse(api.created_markdown_matches(stored, authored))
                self.assertFalse(api.markdown_matches(stored, authored))

    def test_settlement_comparator_stays_strict(self):
        for name in ("full_url", "bare_host_path", "bold_split_around_code", "bold_closed_before_link",
                     "bold_opened_after_link"):
            authored, stored = self.ACCEPTED[name]
            with self.subTest(name):
                self.assertFalse(api.markdown_matches(stored, authored))

    def test_create_readback_names_the_differing_fields(self):
        with self.assertLogs(plugin.diag.LOGGER_NAME, level=logging.WARNING) as logs:
            created = api._created({"id": "0123456789ab", "identifier": "OPS-1"}, "issue", False,
                                   {"description": True, "title": False, "project": True})
        self.assertEqual(created["readback_differences"], ["description", "project"])
        self.assertIn("reason=readback_differs", logs.output[0])
        self.assertIn("fields=description,project", logs.output[0])


class StatusTextTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.items = [
            {"issue": "i-old", "ref": "r-old", "age_s": 3_000_000, "why": "Reconciled delivery history is retained",
             "action": ops.RETAINED, "act": False},
            {"issue": "i-act", "ref": "r-act", "age_s": 900_000, "why": "status write may or may not have reached Linear",
             "action": "Check the issue", "act": True},
            {"issue": "i-done", "ref": "r-done", "age_s": 80_000, "why": "delegate write was not delivered",
             "action": ops.NOTHING, "act": False},
            {"issue": "i-moving", "ref": "r-moving", "age_s": 40, "why": "status write is being sent",
             "action": "Settles on its next send.", "act": False},
        ]

    def test_operator_items_then_in_flight_then_one_history_count(self):
        text = ops.report(self.items, aged=2)
        lines = text.splitlines()
        self.assertEqual(lines[0], "Linear: 1 item(s) need an operator, 1 in progress.")
        self.assertTrue(lines[1].startswith("- ACT i-act [r-act]"))
        self.assertTrue(lines[3].startswith("- i-moving [r-moving]"))
        self.assertEqual(lines[5], "2 retained record(s), no action needed (hermes linear status --all lists them).")
        self.assertIn("2 write(s) that failed more than 7 days ago", lines[6])
        self.assertNotIn("r-old", text)
        self.assertNotIn("r-done", text)

    def test_all_lists_every_record(self):
        text = ops.report(self.items, show_all=True)
        self.assertTrue(text.startswith("Linear: 4 item(s) held, 1 need an operator."))
        for item in self.items:
            self.assertIn(item["ref"], text)

    def cli(self, *argv):
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        out = io.StringIO()
        with redirect_stdout(out):
            code = ops.run(parser.parse_args(argv), self.home / "state.db", self.home / "ingress.db", "default")
        return code, out.getvalue()

    def test_json_and_exit_codes_are_unchanged(self):
        store = Store(self.home / "state.db")
        store.bind_native("issue-1", "native-issue-1", "default", "default", at=0)
        row = store.enqueue("status", {"issue_id": "issue-1", "state": "done", "terminal": True,
                                       "task_id": "native-issue-1", "reconcile_required": True}, at=0)
        with closing(sqlite3.connect(self.home / "state.db")) as db:
            db.execute("UPDATE outbox SET attempts=1, payload=json_set(payload,'$.write_started',json('true'))")
            db.commit()
        code, text = self.cli("status", "--json")
        items = json.loads(text)
        self.assertEqual(code, 1)
        self.assertEqual(set(items[0]), {"issue", "ref", "age_s", "why", "action", "act"})
        self.assertTrue(any(item["act"] for item in items))
        self.assertEqual(self.cli("status")[0], 1)
        self.assertEqual(self.cli("status", "--all")[0], 1)
        self.assertIn(str(row), self.cli("status")[1])


class IdleTickTests(unittest.TestCase):
    """F21 (turn-waste RCA 22 Nov 2026): one serial loop walked every binding every 2 s inside the gateway
    (about 15% of a core on the busiest agent) and a webhook waited out a whole pass (p90 12 s, max 30 s)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.inbox = self.home / "ingress.db"

    def test_idle_ticks_back_off_and_busy_ticks_keep_the_short_tick(self):
        self.assertEqual(plugin.idle_wait(2.0, 0), 2.0)
        self.assertEqual([plugin.idle_wait(2.0, n) for n in (1, 2, 3, 30)], [4.0, 8.0, plugin.IDLE_TICK_MAX_S,
                                                                             plugin.IDLE_TICK_MAX_S])
        self.assertEqual(plugin.idle_wait(20.0, 5), 20.0)  # a longer configured tick is never shortened

    def wait(self, timeout, watched, baseline, *, wake_after=None, board_gap=0.0):
        async def run():
            wake = asyncio.Event()
            if wake_after is not None:
                asyncio.get_running_loop().call_later(wake_after, wake.set)
            started = time.monotonic()
            await plugin._wait_for_change(wake, timeout, watched, baseline, board_gap=board_gap)
            return time.monotonic() - started
        return asyncio.run(run())

    def test_a_webhook_written_to_the_inbox_ends_the_wait_at_once(self):
        board = self.home / "kanban.db"
        watched = lambda: (plugin.file_signature(self.inbox), (plugin.file_signature(board),))
        baseline = watched()
        threading.Timer(0.1, lambda: self.inbox.write_bytes(b"delivery")).start()
        self.assertLess(self.wait(10.0, watched, baseline, board_gap=5.0), 2.0)

    def test_a_board_write_wakes_the_loop_no_sooner_than_the_tick(self):
        board = self.home / "kanban.db"
        watched = lambda: (plugin.file_signature(self.inbox), (plugin.file_signature(board),))
        baseline = watched()
        threading.Timer(0.05, lambda: board.write_bytes(b"heartbeat")).start()
        waited = self.wait(10.0, watched, baseline, board_gap=1.0)
        self.assertGreaterEqual(waited, 1.0)
        self.assertLess(waited, 3.0)

    def test_a_native_hint_ends_the_wait_and_nothing_waits_the_full_timeout(self):
        self.assertLess(self.wait(10.0, lambda: ((), ()), ((), ()), wake_after=0.1), 2.0)
        self.assertGreaterEqual(self.wait(0.3, lambda: ((), ()), ((), ())), 0.29)
        self.assertGreaterEqual(self.wait(0.3, lambda: None, None), 0.29)  # no watch: timed tick only

    def bridge(self):
        from hermes_fleet_linear_plugin.bridge import Bridge
        bridge = Bridge.__new__(Bridge)
        bridge.api = SimpleNamespace()  # not a LinearAPI: no request priorities
        bridge.drain_ingress = Mock()
        return bridge

    def test_a_webhook_arriving_mid_pass_is_drained_between_bindings(self):
        from hermes_fleet_linear_plugin import bridge as bridge_module
        bridge = self.bridge()
        bridge._ingress_path, bridge._ingress_seen = self.inbox, bridge_module.file_signature(self.inbox)
        with patch.object(bridge_module, "INGRESS_CHECK_S", 0):
            bridge._ingress_between()
            bridge.drain_ingress.assert_not_called()  # nothing new: one stat, no inbox read
            self.inbox.write_bytes(b"delivery")
            bridge._ingress_between()
            bridge.drain_ingress.assert_called_once_with(self.inbox)
            bridge._ingress_between()
            bridge.drain_ingress.assert_called_once()
        bridge._ingress_path = None  # outside a tick nothing is drained
        self.inbox.write_bytes(b"another")
        bridge._ingress_between()
        bridge.drain_ingress.assert_called_once()

    def test_a_recheck_inside_a_drain_never_starts_a_second_drain(self):
        # Review of F21: an Issue webhook's recheck ran the mid-pass check while the drain that
        # delivered it still held unmarked rows, so later deliveries were handled twice.
        from linear_ingress_fixture import IngressStore, Route
        from hermes_fleet_linear_plugin import bridge as bridge_module
        from hermes_fleet_linear_plugin.bridge import Bridge
        producer, store = IngressStore(self.inbox), Store(self.home / "state.db")
        store.put("iss-1", "chat", "owner")
        route = Route("default", "default", "/webhook/default", self.home / "unused", self.inbox)
        for tag, event in (("d1", {"type": "unused"}), ("d2", {"type": "Issue", "action": "update",
                           "data": {"id": "iss-1"}, "actor": {"id": "human"}}), ("d3", {"type": "unused"})):
            producer.enqueue(route, f"{tag}-delivery", json.dumps({**event, "tag": tag}).encode())
        bridge = Bridge(store, SimpleNamespace(), SimpleNamespace(executor_profile="default"), profile="default")
        bridge._own_viewer = lambda: "app"
        handled, real = [], bridge.handle_webhook
        def handle(event, **kwargs):
            handled.append(event.get("tag"))
            return real(event, **kwargs) if event.get("type") == "Issue" else None
        bridge.handle_webhook = handle
        bridge._recheck_row = lambda row: None
        bridge.sweep_unbound = lambda: None
        bridge._last_recheck = time.time()  # only the dirty issue is rechecked
        bridge._ingress_path, bridge._ingress_seen = self.inbox, bridge_module.file_signature(self.inbox)
        with patch.object(bridge_module, "INGRESS_CHECK_S", 0):
            bridge.drain_ingress(self.inbox)
        self.assertEqual(handled, ["d1", "d2", "d3"])

    def test_a_tool_call_wakes_the_loop_for_its_queued_writes(self):
        async def run():
            wake = asyncio.Event()
            running = {"loop": asyncio.get_running_loop(), "wake": wake}
            reply = await asyncio.to_thread(plugin._handled, running, "reply")
            await asyncio.wait_for(wake.wait(), 1)
            return reply
        self.assertEqual(asyncio.run(run()), "reply")
        self.assertEqual(plugin._handled({}, "reply"), "reply")  # before the loop runs: nothing to wake

    def test_a_mid_pass_drain_runs_at_normal_priority_inside_an_optional_pass(self):
        from hermes_fleet_linear_plugin import bridge as bridge_module
        bridge = self.bridge()
        bridge.api = api.LinearAPI(lambda: "synthetic")
        seen = []
        bridge.drain_ingress = Mock(side_effect=lambda _path: seen.append(bridge.api._priority.level))
        bridge._ingress_path, bridge._ingress_seen = self.inbox, ()
        with patch.object(bridge_module, "INGRESS_CHECK_S", 0), bridge._priority("optional"):
            bridge._ingress_between()
        self.assertEqual(seen, ["normal"])

    def test_a_tick_that_did_nothing_reports_idle(self):
        from hermes_fleet_linear_plugin import diag
        bridge = self.bridge()
        bridge._recover_admissions = bridge.pump_kanban = bridge.recheck = bridge.flush = Mock()
        bridge.store = Mock()
        self.assertFalse(bridge.tick(self.inbox))
        bridge.pump_kanban = Mock(side_effect=lambda: diag.count("events"))
        self.assertTrue(bridge.tick(self.inbox))
        bridge.pump_kanban = Mock(side_effect=diag.api_sent)
        self.assertTrue(bridge.tick(None))


if __name__ == "__main__":
    unittest.main()
