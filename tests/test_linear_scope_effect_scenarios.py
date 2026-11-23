"""Current native issue scope fences controls, capture and real HTTP reporting."""
from contextlib import nullcontext
import json
import time
import unittest
from unittest.mock import patch

import test_linear_existing_work_scenarios as existing
import test_linear_native_bridge_scenarios as native


@unittest.skipIf(native.CORE is not None, f"native source unavailable ({native.CORE})")
class ScopeEffectScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = existing.ExistingWorkScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.board, self.bridge, self.store = self.fixture.board, self.fixture.bridge, self.fixture.store

    def conflicting_body(self, mixed=False):
        return (self.fixture.mixed_issue_markers() if mixed else
                "Linear issue OTHER-2: https://linear.example/issue/OTHER-2")

    def edit_scope(self, task_id, *, mixed=False):
        with self.board.conn() as conn:
            self.assertTrue(native.kb.edit_task(conn, task_id, body=self.conflicting_body(mixed)))

    def check_stop(self, *, late=False, mixed=False, marker_free=False):
        _, task_id = self.fixture.existing()
        with self.board.conn() as conn:
            native.kb.claim_task(conn, task_id)
        self.fixture.assign()
        binding = self.store.native_binding(native.ISSUE)
        before = self.board.get(task_id)
        if marker_free:
            with self.board.conn() as conn:
                native.kb.edit_task(conn, task_id, body="Ordinary authorized manual work")
        elif not late:
            self.edit_scope(task_id, mixed=mixed)
        control = self.board.stop  # the one Stop path: upstream's plain block
        changed_scope = False
        def changed(*args, **kwargs):
            nonlocal changed_scope
            if not changed_scope:
                self.edit_scope(task_id, mixed=mixed)
                changed_scope = True
            return control(*args, **kwargs)
        with patch.object(self.board, "stop", side_effect=changed) if late else nullcontext():
            self.bridge.handle_webhook(self.fixture.fixture.event("prompted", signal="stop",
                                                                 stamp=time.time() + 5))
        after = self.board.get(task_id)
        self.assertEqual(after.status, "blocked" if marker_free else before.status)
        if not marker_free:
            self.assertEqual(after.current_run_id, before.current_run_id)
            self.assertEqual(after.claim_lock, before.claim_lock)
            self.assertFalse(any(event.kind == "blocked" for event in self.board.history(task_id, 0)))
        self.assertEqual(self.store.native_binding(native.ISSUE), binding)

    def test_foreign_current_scope_holds_guarded_stop(self):
        self.check_stop()

    def test_mixed_current_scope_holds_guarded_stop(self):
        self.check_stop(mixed=True)

    def test_final_native_guarded_stop_read_holds_scope_change(self):
        self.check_stop(late=True, mixed=True)

    def test_marker_free_authorized_guarded_stop_remains_usable(self):
        self.check_stop(marker_free=True)

    def test_lost_stop_response_and_later_scope_change_never_restop_resumed_work(self):
        _, task_id = self.fixture.existing()
        with self.board.conn() as conn:
            native.kb.claim_task(conn, task_id)
        self.fixture.assign()
        event = self.fixture.fixture.event("prompted", signal="stop", stamp=time.time() + 5)
        stop = self.board.stop
        def lost(*args, **kwargs):
            self.assertTrue(stop(*args, **kwargs))
            raise ConnectionError("lost native Stop reply")
        with patch.object(self.board, "stop", side_effect=lost), self.assertRaises(ConnectionError):
            self.bridge.handle_webhook(event)
        with self.board.conn() as conn:
            native.kb.unblock_task(conn, task_id)
        self.edit_scope(task_id)
        before = [(event.id, event.kind) for event in self.board.history(task_id, 0)]
        self.fixture.fixture.make_bridge().handle_webhook(event)
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.assertEqual([(event.id, event.kind) for event in self.board.history(task_id, 0)], before)

    def test_final_native_subscription_read_holds_repurposed_task_without_erasing_binding(self):
        _, task_id = self.fixture.existing()
        subscribe = self.board.subscribe
        def changed(*args, **kwargs):
            self.edit_scope(task_id)
            return subscribe(*args, **kwargs)
        with patch.object(self.board, "subscribe", side_effect=changed):
            try:
                self.fixture.assign()
            except native.LinearError:
                pass
        self.assertEqual(self.store.native_binding(native.ISSUE)["task_id"], task_id)
        with self.board.read_conn() as conn:
            self.assertEqual(self.board.kn.list_notify_subs(conn, task_id), [])

    def test_reassignment_notice_shows_scope_hold_instead_of_foreign_native_progress(self):
        _, task_id = self.fixture.existing()
        self.fixture.assign()
        binding = self.store.native_binding(native.ISSUE)
        self.edit_scope(task_id)
        self.fixture.assign()
        notices = [row for row in self.store.pending() if row["payload"].get("reporting_notice_version") == 1]
        self.assertTrue(notices)
        self.assertIn("couldn't safely act on this", notices[-1]["payload"]["content"]["body"])
        self.assertNotIn("native", notices[-1]["payload"]["content"]["body"].lower())
        self.assertNotIn("Existing work:", notices[-1]["payload"]["content"]["body"])
        self.assertEqual(self.store.native_binding(native.ISSUE), binding)

    def reporting(self, name):
        return self.fixture.fixture.reporting_fixture(name)

    def test_conflicting_completion_capture_holds_cursor_and_other_binding_still_reports(self):
        clock, remote, reporter, task_id = self.reporting("scope-capture")
        reporter.flush()
        previous = reporter.store.get(native.ISSUE)
        binding = reporter.store.native_binding(native.ISSUE)
        self.edit_scope(task_id, mixed=True)
        self.fixture.fixture.complete_reported_task(clock, task_id)
        reporter.pump_kanban()
        self.assertEqual(reporter.store.get(native.ISSUE), previous)
        self.assertFalse(reporter.store.pending(native.ISSUE))
        remote.add_issue("unaffected", "OPS-2", project=None)
        with self.board.conn() as conn:
            other = native.kb.create_task(conn, title="Unrelated native work", assignee="default")
        reporter.track("unaffected", other)
        clock.now += 1
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=clock()):
            native.kb.complete_task(conn, other, result="Verified separate authorized native outcome")
        reporter.pump_kanban()
        reporter.flush()
        self.assertEqual(remote.state("unaffected"), "Done")
        self.assertNotEqual(remote.state(native.ISSUE), "Done")
        self.assertEqual(reporter.store.native_binding(native.ISSUE), binding)
        status = reporter.native_status(native.ISSUE)
        self.assertTrue(status["linked"])
        self.assertTrue(status["reconciliation_required"])
        self.assertEqual(status["task_id"], task_id)

    def test_scope_change_during_completion_summary_holds_final_capture(self):
        clock, _, reporter, task_id = self.reporting("scope-final-capture")
        reporter.flush()
        before = reporter.store.get(native.ISSUE)["last_event_id"]
        self.fixture.fixture.complete_reported_task(clock, task_id)
        summary = self.board.completion_summary
        def changed(task):
            result = summary(task)
            self.edit_scope(task_id)
            return result
        with patch.object(self.board, "completion_summary", side_effect=changed):
            reporter.pump_kanban()
        self.assertEqual(reporter.store.get(native.ISSUE)["last_event_id"], before)
        self.assertFalse(reporter.store.pending(native.ISSUE))

    def test_conflicting_archived_and_comment_events_do_not_capture_new_issue_progress(self):
        _, _, reporter, task_id = self.reporting("scope-archive-capture")
        reporter.flush()
        before = reporter.store.get(native.ISSUE)["last_event_id"]
        self.edit_scope(task_id)
        with self.board.conn() as conn:
            native.kb.add_comment(conn, task_id, "operator", "Sensitive progress for the other issue")
            native.kb.archive_task(conn, task_id)
        reporter.pump_kanban()
        self.assertEqual(reporter.store.get(native.ISSUE)["last_event_id"], before)
        self.assertFalse(reporter.store.pending(native.ISSUE))
        self.assertEqual(self.board.get(task_id).status, "archived")

    def delivery(self, kind, *, late=False):
        clock, remote, reporter, task_id = self.reporting("scope-delivery-" + kind)
        if kind != "status":
            reporter.flush()
            if kind == "comment":
                reporter.comment(native.ISSUE, "Sensitive task report")
            elif kind == "activity":
                remote.sessions["scope-session"] = native.ISSUE
                reporter.activity(native.ISSUE, "scope-session", "response", "Sensitive task activity")
            else:
                reporter.project_update("scope-batch", "proj-1", "OPS-1", "Sensitive project progress",
                                        quiet=False, issue_id=native.ISSUE)
        pending = reporter.store.pending()
        target = next(row for row in pending if row["kind"] == kind)
        previous_state = remote.state(native.ISSUE)
        previous_bodies = remote.bodies(native.ISSUE)
        previous_projects = list(remote.project_updates)
        mutate = reporter._mutate_outbox
        def changed(*args, **kwargs):
            self.edit_scope(task_id)
            return mutate(*args, **kwargs)
        if not late:
            self.edit_scope(task_id, mixed=True)
        clock.now += 10
        with patch.object(reporter, "_mutate_outbox", side_effect=changed) if late else nullcontext():
            reporter.flush()
        self.assertEqual(remote.state(native.ISSUE), previous_state)
        self.assertEqual(remote.bodies(native.ISSUE), previous_bodies)
        self.assertEqual(remote.project_updates, previous_projects)
        retained = reporter.store.outbox_row(target["id"])
        self.assertIsNotNone(retained)
        self.assertNotEqual(retained["state"], "sent")
        for key in ("task_id", "body", "content", "lines"):
            self.assertEqual(retained["payload"].get(key), target["payload"].get(key))

    def test_captured_status_is_held_when_task_scope_changes_before_flush(self):
        self.delivery("status")

    def test_captured_comment_is_held_when_task_scope_changes_before_flush(self):
        self.delivery("comment")

    def test_captured_activity_is_held_when_task_scope_changes_before_flush(self):
        self.delivery("activity")

    def test_captured_project_line_is_held_when_task_scope_changes_before_flush(self):
        self.delivery("project_update")

    def test_final_http_status_guard_holds_scope_change(self):
        self.delivery("status", late=True)

    def test_final_http_comment_guard_holds_scope_change(self):
        self.delivery("comment", late=True)

    def test_final_http_activity_guard_holds_scope_change(self):
        self.delivery("activity", late=True)

    def test_final_http_project_guard_holds_scope_change(self):
        self.delivery("project_update", late=True)

    def check_project_split(self, *, late=False):
        _, remote, reporter, task_id = self.reporting("scope-mixed-project")
        reporter.flush()
        remote.add_issue("unaffected", "OPS-2")
        with self.board.conn() as conn:
            other = native.kb.create_task(conn, title="Other project work", assignee="default")
        reporter.track("unaffected", other)
        reporter.project_update("shared-batch", "proj-1", "OPS-1", "Held native issue detail",
                                quiet=False, issue_id=native.ISSUE)
        reporter.project_update("shared-batch", "proj-1", "OPS-2", "Valid independent progress",
                                quiet=False, issue_id="unaffected")
        mutate = reporter._mutate_outbox
        changed_scope = False
        def changed(*args, **kwargs):
            nonlocal changed_scope
            if not changed_scope:
                self.edit_scope(task_id)
                changed_scope = True
            return mutate(*args, **kwargs)
        if not late:
            self.edit_scope(task_id)
        with patch.object(reporter, "_mutate_outbox", side_effect=changed) if late else nullcontext():
            reporter.flush()
        bodies = [row["body"] for row in remote.project_updates]
        self.assertEqual(len(bodies), 1)
        self.assertIn("Valid independent progress", bodies[0])
        self.assertNotIn("Held native issue detail", bodies[0])
        held = next(row for row in reporter.store.pending() if row["kind"] == "project_update")
        self.assertEqual(held["payload"]["lines"], {"OPS-1": "Held native issue detail"})
        self.assertEqual(held["payload"]["task_id"], task_id)

    def test_aggregated_project_update_publishes_valid_line_and_preserves_conflicting_line(self):
        self.check_project_split()

    def test_final_http_scope_hold_splits_unstarted_project_batch_without_holding_valid_line(self):
        self.check_project_split(late=True)

    def test_conflicting_scope_holds_new_native_queue_and_keepalive_but_preserves_status_read(self):
        _, task_id = self.fixture.existing()
        self.fixture.assign()
        self.edit_scope(task_id)
        before = self.store.pending()
        calls = [lambda: self.bridge.status(native.ISSUE, "in_progress"),
                 lambda: self.bridge.comment(native.ISSUE, "Wrong task report"),
                 lambda: self.bridge.activity(native.ISSUE, native.SESSION, "response", "Wrong task report"),
                 lambda: self.bridge.project_update("scope", "proj-1", "OPS-1", "Wrong task progress",
                                                    quiet=False, issue_id=native.ISSUE)]
        for call in calls:
            with self.subTest(effect=call), self.assertRaises(native.LinearError):
                call()
        with patch.object(self.bridge, "clock", return_value=time.time() + 2000):
            self.bridge.recheck(force=True)
        self.assertEqual(self.store.pending(), before)
        status = self.bridge.native_status(native.ISSUE)
        self.assertTrue(status["linked"])
        self.assertTrue(status["reconciliation_required"])

    def test_conflicting_native_scope_keeps_authorized_chat_issue_read_and_independent_content(self):
        from hermes_fleet_linear_plugin import chat, transport
        from test_linear_content_actions import ContentRemote
        with patch("linear_fake_api.FakeLinear", ContentRemote):
            _, remote, reporter, task_id = self.reporting("scope-independent-content")
        reporter.flush()
        self.edit_scope(task_id)
        reporter.profile_home = self.fixture.fixture.home  # The real service host supplies this field.
        context = transport.NativeContext(home=str(self.fixture.fixture.home), profile="default",
            platform="api", source="api", session_key="synthetic-content", session_id="synthetic-session")
        status = json.loads(chat.handle(reporter, {"action": "status", "issue": native.ISSUE}, context))
        self.assertTrue(status["ok"])
        self.assertEqual(status["issue"]["id"], native.ISSUE)
        self.assertTrue(status["native"]["linked"])
        comment_id = "b9e5907c-801d-42f8-924f-eb9c738ac1a7"
        comment = json.loads(chat.handle(reporter, {"action": "add_comment", "issue": native.ISSUE,
            "id": comment_id, "body": "Authorized independent issue discussion"}, context))
        self.assertTrue(comment["ok"])
        reporter.flush()
        self.assertIn("Authorized independent issue discussion", remote.bodies(native.ISSUE))
        self.assertEqual(reporter.store.outbox_row(comment_id)["state"], "sent")
        queued = json.loads(chat.handle(reporter, {"action": "update_description", "issue": native.ISSUE,
            "id": "a9e5907c-801d-42f8-924f-eb9c738ac1a7",
            "expected_description": remote.issues[native.ISSUE]["description"],
            "description": "Authorized independent issue discussion"}, context))
        self.assertTrue(queued["ok"])
        reporter.flush()
        self.assertEqual(remote.issues[native.ISSUE]["description"], "Authorized independent issue discussion")
        self.assertEqual(reporter.store.outbox_row(queued["outbox_id"])["state"], "sent")


if __name__ == "__main__":
    unittest.main()
