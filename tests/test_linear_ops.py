"""Operators can see every held item and clear it through a supported command, never a database edit."""
import argparse
import io
import json
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from linear_fake_api import load_plugin
from linear_ingress_fixture import IngressStore, Route

load_plugin()
from hermes_fleet_linear_plugin import ops
from hermes_fleet_linear_plugin.store import Store


class LinearOperatorTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.state, self.inbox = self.home / "state.db", self.home / "ingress.db"
        self.store = Store(self.state)

    def cli(self, *argv):
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        out = io.StringIO()
        with redirect_stdout(out):
            code = ops.run(parser.parse_args(argv), self.state, self.inbox, "default")
        return code, out.getvalue()

    def uncertain(self, kind, issue, *, settled=True, **payload):
        if kind == "status":
            self.store.bind_native(issue, f"native-{issue}", "default", "default", at=0)
            payload["task_id"] = f"native-{issue}"
        elif kind == "description":
            payload.update(content_action=True, unlinked_content=True)
        row = self.store.enqueue(kind, {"issue_id": issue, **payload}, at=100)
        saved = self.store.outbox_row(row)
        self.store.rewrite(row, {**saved["payload"], "write_started": True}, 100)
        if settled:  # the gateway has given up on settling it by itself
            self.store.mark(row, "failed")
        return row

    def test_nothing_held_is_said_plainly(self):
        self.assertEqual(self.cli("status"), (0, "Linear: nothing is held.\n"))

    def test_uncertain_status_and_description_are_listed_and_resolved_by_command(self):
        status = self.uncertain("status", "issue-1", state="done", terminal=True)
        description = self.uncertain("description", "issue-5", id=str(uuid.uuid4()), body="New",
                                     expected_description="Old", content_action=True)
        self.assertTrue(self.store.issue_reconciliation_blocked("issue-1"))
        self.assertTrue(self.store.issue_reconciliation_blocked("issue-5"))
        code, text = self.cli("status")
        self.assertEqual(code, 1)
        for row in (status, description):
            self.assertIn(f"hermes linear resolve {row} applied|not_applied", text)
        self.assertEqual(self.cli("resolve", status, "applied", "--evidence", "Issue shows Done")[0], 0)
        self.assertEqual(self.cli("resolve", description, "not_applied", "--evidence", "Old text in Linear")[0], 0)
        self.assertFalse(self.store.issue_reconciliation_blocked("issue-1"))
        self.assertFalse(self.store.issue_reconciliation_blocked("issue-5"))
        self.assertEqual(self.cli("status")[0], 0)
        self.assertEqual(self.cli("resolve", status, "applied", "--evidence", "again")[0], 1)  # already resolved
        self.assertEqual(self.store.unreported_failed(), [])  # the operator acted: no "held" alert follows

    def test_in_flight_write_is_shown_but_cannot_be_resolved_under_the_sender(self):
        row = self.uncertain("status", "issue-6", settled=False, state="done", terminal=True)
        [item] = ops.stuck(self.state, self.inbox, "default", now=160)
        self.assertFalse(item["act"])
        self.assertIn("being sent", item["why"])
        self.assertEqual(self.cli("resolve", row, "not_applied", "--evidence", "Linear shows Todo")[0], 1)
        self.assertTrue(self.store.issue_reconciliation_blocked("issue-6"))
        [late] = ops.stuck(self.state, self.inbox, "default", now=100 + 3601)
        self.assertTrue(late["act"])  # held unsent for an hour: the health check fires

    def test_locked_state_database_is_an_error_not_an_all_clear(self):
        from unittest.mock import patch
        with patch.object(ops, "_read") as read:
            read.return_value.execute.side_effect = sqlite3.OperationalError("database is locked")
            with self.assertRaises(sqlite3.OperationalError):
                ops.stuck(self.state, self.inbox, "default")

    def test_retried_terminal_comment_never_asks_for_resolve(self):
        self.store.bind_native("issue-7", "native-7", "default", "default", at=0)
        comment = self.store.enqueue("comment", {"issue_id": "issue-7", "task_id": "native-7", "body": "Done", "terminal": True}, at=100)
        self.store.retry(self.store.outbox_row(comment), 100)
        self.store.mark(comment, "failed")
        items = ops.stuck(self.state, self.inbox, "default", now=200)
        self.assertEqual([(i["ref"], i["act"]) for i in items], [(comment, False)])
        self.assertNotIn("resolve", items[0]["action"])
        self.assertEqual(ops.stuck(self.state, self.inbox, "default", now=100 + 8 * 86_400), [])

    def test_parked_delivery_is_listed_and_replayed_once(self):
        route = Route("default", "default", "/webhook/default", self.home / "unused", self.inbox)
        event = {"type": "AgentSessionEvent", "agentSession": {"issue": {"id": "issue-2"}}}
        IngressStore(self.inbox).enqueue(route, "parked-1", json.dumps(event).encode())
        with closing(sqlite3.connect(self.inbox)) as db, db:
            db.execute("UPDATE deliveries SET status = 'failed', attempts = 40")
        items = ops.stuck(self.state, self.inbox, "default")
        self.assertEqual([(i["issue"], i["ref"]) for i in items], [("issue-2", "parked-1")])
        self.assertIn("hermes linear replay parked-1", items[0]["action"])
        self.assertFalse(ops.replay(self.inbox, "worker-a", "parked-1"))  # another profile's inbox row
        self.assertEqual(self.cli("replay", "parked-1")[0], 0)
        with closing(sqlite3.connect(self.inbox)) as db:
            self.assertEqual(db.execute("SELECT status, attempts FROM deliveries").fetchone(), ("pending", 0))
        self.assertEqual(self.cli("replay", "parked-1")[0], 1)

    def park(self, delivery, issue, attempts=104):
        route = Route("default", "default", "/webhook/default", self.home / "unused", self.inbox)
        event = {"type": "AgentSessionEvent", "action": "created", "agentSession": {"issue": {"id": issue}}}
        IngressStore(self.inbox).enqueue(route, delivery, json.dumps(event).encode())
        with closing(sqlite3.connect(self.inbox)) as db, db:
            db.execute("UPDATE deliveries SET status = 'failed', attempts = ? WHERE delivery_id = ?", (attempts, delivery))
        notice = self.store.enqueue_once("comment", {"issue_id": issue, "body": "Set aside; retry it."},
                                         f"default:{delivery}", at=100)
        self.store.delivery_allowed(notice)  # the gateway holds a notice for an issue with no task link
        return notice

    def inbox_rows(self):
        with closing(sqlite3.connect(self.inbox)) as db:
            return db.execute("SELECT delivery_id, payload, status, attempts FROM deliveries ORDER BY delivery_id").fetchall()

    def test_parked_delivery_and_its_held_notice_are_dismissed_by_command_with_history_kept(self):
        notice = self.park("parked-9", "issue-9")
        before = self.inbox_rows()
        items = {i["ref"]: i for i in ops.stuck(self.state, self.inbox, "default", now=200)}
        self.assertTrue(items["parked-9"]["act"] and items[notice]["act"])
        self.assertIn("hermes linear dismiss parked-9", items["parked-9"]["action"])
        with self.assertRaises(SystemExit):  # evidence is required
            self.cli("dismiss", "parked-9")
        code, text = self.cli("dismiss", "parked-9", "--evidence", "Refusal already shown on the issue")
        self.assertEqual(code, 0, text)
        self.assertEqual(self.cli("status")[0], 0)  # nothing needs an operator now
        items = {i["ref"]: i for i in ops.stuck(self.state, self.inbox, "default", now=200)}
        self.assertFalse(items["parked-9"]["act"])
        self.assertFalse(items[notice]["act"])
        self.assertEqual(self.inbox_rows(), before)  # the original delivery is kept untouched
        saved = self.store.outbox_row(notice)
        self.assertNotEqual(saved["state"], "sent")
        self.assertEqual(saved["payload"]["body"], "Set aside; retry it.")
        self.assertEqual(saved["payload"]["reconciliation"]["outcome"], "dismissed")
        self.assertEqual(saved["payload"]["reconciliation"]["evidence"], "Refusal already shown on the issue")
        self.assertEqual(self.store.due(10**12), [])  # the notice never posts
        self.assertEqual(self.cli("replay", "parked-9")[0], 1)  # a dismissed refusal is not replayed
        self.assertEqual(self.inbox_rows(), before)
        self.assertEqual(self.cli("dismiss", "parked-9", "--evidence", "again")[0], 1)  # recorded once

    def test_only_a_parked_delivery_of_this_profile_can_be_dismissed(self):
        self.park("retrying-1", "issue-10", attempts=3)
        with closing(sqlite3.connect(self.inbox)) as db, db:
            db.execute("UPDATE deliveries SET status = 'pending' WHERE delivery_id = 'retrying-1'")
        self.assertEqual(self.cli("dismiss", "retrying-1", "--evidence", "x")[0], 1)
        self.assertEqual(self.cli("dismiss", "missing", "--evidence", "x")[0], 1)
        self.park("parked-11", "issue-11")
        self.assertFalse(ops.dismiss(self.state, self.inbox, "worker-a", "parked-11", "x"))
        self.assertTrue(next(i for i in ops.stuck(self.state, self.inbox, "default") if i["ref"] == "parked-11")["act"])

    def delegate(self, issue, target, *, state, receipt=False):
        self.store.bind_native(issue, f"native-{issue}", "default", "default", at=0)
        row = self.store.enqueue("delegate", {"id": str(uuid.uuid4()), "issue_id": issue, "content_action": True,
                                              "delegate_routing_version": 1, "write_started": False,
                                              "target_delegate_id": target, "task_id": f"native-{issue}"}, at=100)
        if receipt:
            saved = self.store.outbox_row(row)
            self.store.rewrite(row, {**saved["payload"], "delegate_receipt": {"issue_id": issue, "delegate_id": target,
                                                                              "updated_at": "2026-01-01T00:00:00Z"}}, 100)
        self.store.mark(row, state)
        return row

    def test_refused_delegate_write_superseded_by_an_applied_one_needs_no_operator(self):
        stale = self.delegate("issue-12", "app-1", state="failed")
        self.delegate("issue-12", "app-1", state="sent", receipt=True)
        other = self.delegate("issue-13", "app-1", state="failed")
        self.delegate("issue-13", "app-2", state="sent", receipt=True)  # a different delegate does not settle it
        items = {i["ref"]: i for i in ops.stuck(self.state, self.inbox, "default", now=200)}
        self.assertFalse(items[stale]["act"])
        self.assertIn("already", items[stale]["why"])
        self.assertTrue(items[other]["act"])
        self.assertIn("redo the step", items[other]["action"])

    def test_fences_and_undelivered_writes_explain_the_next_step(self):
        self.store.fence_scope("issue-3", "requester outside scope", at=50)
        refused = self.store.enqueue("comment", {"issue_id": "issue-4", "body": "evidence", "content_action": True, "unlinked_content": True}, at=100)
        self.store.mark(refused, "failed")
        self.store.bind_native("issue-4", "native-4", "default", "default", at=0)
        thought = self.store.enqueue("activity", {"issue_id": "issue-4", "task_id": "native-4", "session_id": "s",
                                                  "content": {"type": "thought", "body": "Working"}}, at=100)
        self.store.mark(thought, "failed")
        items = {i["ref"]: i for i in ops.stuck(self.state, self.inbox, "default", now=200)}
        self.assertIn("approved procedure", items["fence"]["action"])
        self.assertIn("redo the step", items[refused]["action"])
        self.assertNotIn(thought, items)  # a dropped thought holds nothing
        self.assertFalse(items["fence"]["act"])  # a policy fence alone is not an alarm
        self.assertNotIn("requester outside scope", ops.report(list(items.values())))  # reasons stay in the database
        self.assertTrue(items[refused]["act"])


    # HF-823: a CI or dependency park the gateway never resumed is an operator item.
    def board(self, *tasks):
        """A native board with core's two tables: (task_id, status, [(kind, payload, created_at), ...])."""
        path = self.home / "board.db"
        with closing(sqlite3.connect(path)) as db:
            db.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
            db.execute("CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, "
                       "payload TEXT, created_at INTEGER)")
            for task_id, status, events in tasks:
                db.execute("INSERT INTO tasks VALUES (?,?)", (task_id, status))
                for kind, payload, at in events:
                    db.execute("INSERT INTO task_events (task_id,kind,payload,created_at) VALUES (?,?,?,?)",
                               (task_id, kind, json.dumps(payload) if payload is not None else None, at))
            db.commit()
        return {"work": path}.get

    @staticmethod
    def parked_on(reason):
        return {"reason": reason, "kind": "needs_input", "requested_kind": "dependency", "rekind_reason": "no_open_parent"}

    def test_park_past_its_window_needs_an_operator(self):
        ci = self.parked_on("CI gate: https://github.com/o/r/pull/7 within 90m")
        tasks = []
        for n, (status, events) in enumerate((
                ("blocked", [("blocked", ci, 0), ("worker_result", {"exit_code": 130}, 1)]),  # stuck: 90 + 15 min passed
                ("blocked", [("blocked", self.parked_on("CI gate: o/r@" + "a" * 40), 0)]),  # default 3 h window: in progress
                ("triage", [("block_loop_detected", ci, 0)]),  # the loop breaker keeps the same wait
                ("blocked", [("blocked", self.parked_on("Waits on ABC-12 closing"), 0)]),  # dependency: 24 h window
                ("blocked", [("blocked", ci, 0), ("unblocked", None, 10), ("blocked", {"reason": "need a decision",
                                                                                     "kind": "needs_input"}, 20)]),
                ("ready", [("blocked", ci, 0), ("unblocked", None, 10)]),  # resumed
                ("blocked", [("blocked", {"reason": "CI gate: https://github.com/o/r/pull/7"}, 0)]))):  # not re-kinded
            self.store.bind_native(f"issue-p{n}", f"t_p{n}", "default", "work", at=0)
            tasks.append((f"t_p{n}", status, events))
        boards = self.board(*tasks)
        now = 90 * 60 + 15 * 60 + 1
        items = {i["ref"]: i for i in ops.stuck(self.state, self.inbox, "default", now=now, boards=boards)}
        self.assertTrue(items["t_p0"]["act"])
        self.assertIn("parked on CI", items["t_p0"]["why"])
        self.assertEqual(items["t_p0"]["issue"], "issue-p0")
        self.assertFalse(items["t_p1"]["act"])
        self.assertTrue(items["t_p2"]["act"])
        self.assertFalse(items["t_p3"]["act"])
        self.assertIn("dependency", items["t_p3"]["why"])
        self.assertNotIn("t_p4", items)  # a later question is a person's, not a park
        self.assertNotIn("t_p5", items)
        self.assertNotIn("t_p6", items)
        # A minute inside the grace the park is still in progress.
        early = {i["ref"]: i for i in ops.stuck(self.state, self.inbox, "default", now=now - 120, boards=boards)}
        self.assertFalse(early["t_p0"]["act"])
        late = {i["ref"]: i for i in ops.stuck(self.state, self.inbox, "default", now=86_400 + 15 * 60 + 1, boards=boards)}
        self.assertTrue(late["t_p1"]["act"] and late["t_p3"]["act"])
        # The CLI (and the container health check that runs it) exits 1 for it.
        with patch.object(ops, "native_boards", boards):
            with patch.object(ops.time, "time", return_value=now):
                code, out = self.cli("status")
        self.assertEqual(code, 1)
        self.assertIn("2 item(s) need an operator, 2 in progress", out.splitlines()[0])
        self.assertIn("ACT issue-p0 [t_p0]", out)
        # Without a readable board the outbox view still works.
        self.assertEqual(ops.stuck(self.state, self.inbox, "default", now=now, boards=lambda board: None), [])


if __name__ == "__main__":
    unittest.main()
