"""Own-app delegate metadata through the registered socket and real native SDK.

The HTTP provider is finite and synthetic. No gateway/model is started, and these
backend cases do not claim Desktop, Slack or Telegram client acceptance.
"""
from __future__ import annotations

import copy
import os
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import test_linear_native_frontdoor_scenarios as frontdoor
from linear_fake_api import OTHER, SELF
from test_linear_content_actions import ContentRemote


class DelegateRemote(ContentRemote):
    """The existing HTTP capture shape, with authoritative session readbacks."""
    def __init__(self, clock):
        super().__init__(clock)
        self.app_id = SELF
        self.session_records = {}
        self.activity_records = {}

    def _apply(self, query, variables):
        if "IdentityBinding" in query:
            return 200, {"data": {"viewer": {"id": self.app_id},
                                  "organization": {"id": "org-1"}}}
        if "AgentSessionAuthorization" in query:
            return 200, {"data": {"agentSession": self.session_records.get(variables["id"])}}
        if "AgentActivityAuthorization" in query:
            return 200, {"data": {"agentActivity": self.activity_records.get(variables["id"])}}
        return super()._apply(query, variables)


@unittest.skipUnless(os.environ.get("HERMES_AGENT_SRC"), "requires explicit native source")
class DelegateRoutingScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = frontdoor.NativeFrontdoorTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.bind_api()
        self.bridge, self.board = self.fixture.bridge, self.fixture.board
        self.remote = DelegateRemote(self.fixture.clock)
        self.addCleanup(self.remote.close)
        self.issue = self.remote.add_issue("issue-1", "ABC-1")
        self.issue["assignee"] = {"id": "human-assignee"}
        self.remote.set_delegate("issue-1", OTHER)
        from hermes_fleet_linear_plugin import BoundLinearAPI
        self.bridge.api = BoundLinearAPI(lambda: "synthetic", endpoint=self.remote.url,
            identity={"viewer_id": SELF, "organization_id": "org-1"},
            specialist_scope={"allowed_team_ids": ["team-1"],
                              "allowed_project_ids": ["proj-1"],
                              "allowed_requester_ids": ["human-1"]})

    def call(self, args):
        return self.fixture.call(args)

    def link(self, *, status="blocked", board=None):
        board = board or self.board
        task = board.create(title="Inspected remaining work", initial_status=status,
                            body="Linear issue issue-1: " + self.issue["url"])
        args = {"action": "track", "issue": "ABC-1", "task_id": task.id}
        if board is not self.board:
            args["board"] = board.board
        result = self.call(args)
        self.assertTrue(result["ok"], result)
        return task

    def request(self):
        status = self.call({"action": "status", "issue": "ABC-1"})
        self.assertTrue(status["ok"], status)
        return {"action": "delegate_self", "issue": "ABC-1", "id": str(uuid.uuid4()),
                "expected_delegate_id": (status["issue"]["delegate"] or {}).get("id"),
                "expected_updated_at": status["issue"]["updatedAt"],
                "expected_binding_revision": status["native"]["binding_revision"]}

    def snapshot(self, board=None):
        """Include task cards, runs, claims, comments, events and subscriptions."""
        with (board or self.board).conn() as db:
            names = [row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            return {name: [tuple(row) for row in db.execute('SELECT * FROM "' + name + '" ORDER BY rowid')]
                    for name in names}

    def deliver(self, request):
        queued = self.call(request)
        self.assertTrue(queued["ok"], queued)
        self.assertEqual(self.bridge.flush(only_id=request["id"]), 1)
        self.assertEqual(self.remote.issues["issue-1"]["delegate"]["id"], SELF)
        return queued

    def mutations(self):
        return [q for q in self.remote.requests if q.startswith("mutation IssueUpdate")]

    def test_chat_running_track_routes_delegate_and_status_then_echo_keeps_same_run(self):
        self.fixture.clock.now = time.time() - 2
        self.remote.set_delegate("issue-1", None)
        with self.board.conn() as db:
            task = self.board.kb.create_task(db, title="Current chat work", board=self.board.board,
                assignee=self.board.executor_profile, created_by="operator",
                body="Linear issue issue-1: " + self.issue["url"])
            running = self.board.kb.claim_task(db, task, claimer="native-worker")
        self.assertEqual(running.status, "running")
        self.fixture.bind_api()
        linked = self.call({"action": "track", "issue": "ABC-1", "task_id": task})
        self.assertTrue(linked["ok"], linked)
        self.bridge.pump_kanban()
        self.fixture.clock.now = time.time() + 2
        self.bridge.flush()
        self.assertEqual(self.issue["delegate"]["id"], SELF)
        self.assertEqual(self.remote.state("issue-1"), "In Progress")
        before = self.snapshot()
        session = "chat-assignment-echo"
        self.remote.session_records[session] = {"id": session, "creator": None,
            "appUser": {"id": SELF}, "issue": {"id": "issue-1"}}
        event = self.remote.session_event("created", "issue-1", session, creator=None)
        event["agentSession"].pop("creatorId")
        self.assertTrue(self.bridge.handle_webhook(event))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.bridge.store.native_binding("issue-1")["task_id"], task)
        self.assertEqual(self.board.get(task).current_run_id, running.current_run_id)
        self.assertIsNone(self.bridge.store.native_intent("create:issue-1"))
        self.bridge.flush()
        # The tracked work adopts the session Linear opened for our delegate write (HF-630).
        self.assertEqual(self.bridge.store.get("issue-1")["owner_ref"], session)
        self.assertTrue(any("Continuing the existing work on this issue." in body
                            for body in self.remote.bodies("issue-1")))
        self.remote.set_delegate("issue-1", OTHER)
        activity = "revoked-stop"
        self.remote.activity_records[activity] = {"id": activity, "user": {"id": "human-1"},
            "agentSession": {"id": session}}
        revoked = self.remote.session_event("prompted", "issue-1", session,
            signal="stop", activity_id=activity, creator=None, at=1)
        self.assertFalse(self.bridge.handle_webhook(revoked))
        self.assertEqual(self.board.get(task).current_run_id, running.current_run_id)
        self.assertEqual(self.snapshot(), before)
        self.remote.set_delegate("issue-1", {"id": SELF})
        activity = "authorized-stop"
        self.remote.activity_records[activity] = {"id": activity, "user": {"id": "human-1"},
            "agentSession": {"id": session}}
        stop = self.remote.session_event("prompted", "issue-1", session,
            signal="stop", activity_id=activity, creator=None, at=4)
        self.assertTrue(self.bridge.handle_webhook(stop))
        self.assertEqual(self.board.get(task).status, "blocked")
        self.assertIsNone(self.bridge.store.native_intent("create:issue-1"))

    def human_assignment(self, session="human-assignment"):
        self.remote.set_delegate("issue-1", {"id": SELF})
        self.remote.session_records[session] = {"id": session,
            "creator": {"id": "human-1"}, "appUser": {"id": SELF}, "issue": {"id": "issue-1"}}
        return self.remote.session_event("created", "issue-1", session)

    def test_human_assignment_creates_one_native_task_and_chat_status_only_reads_it(self):
        event = self.human_assignment()
        self.assertTrue(self.bridge.handle_webhook(event))
        binding = self.bridge.store.native_binding("issue-1")
        self.assertIsNotNone(binding)
        task = self.board.get(binding["task_id"])
        self.assertEqual(task.status, "ready")
        self.assertIsNone(task.current_run_id)
        before = self.snapshot()
        self.fixture.bind_api()
        status = self.call({"action": "status", "issue": "ABC-1"})
        self.assertTrue(status["ok"], status)
        self.assertEqual(status["native"]["task_id"], task.id)
        self.assertTrue(self.bridge.handle_webhook(event))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(self.board.discover(self.issue)), 1)

    def test_human_assignment_discovers_existing_running_executor_without_second_run(self):
        self.remote.set_delegate("issue-1", {"id": SELF})
        with self.board.conn() as db:
            task_id = self.board.kb.create_task(db, title="Already running", board=self.board.board,
                assignee=self.board.executor_profile, created_by="operator",
                body="Linear issue issue-1: " + self.issue["url"],
                idempotency_key="chat-work:issue-1")
            running = self.board.kb.claim_task(db, task_id, claimer="native-worker")
        before = self.snapshot()
        event = self.human_assignment("assignment-existing")
        self.assertTrue(self.bridge.handle_webhook(event))
        self.assertEqual(self.bridge.store.native_binding("issue-1")["task_id"], task_id)
        after = self.snapshot()
        self.assertEqual(after["tasks"], before["tasks"])
        self.assertEqual(after["task_events"], before["task_events"])
        self.assertEqual(self.board.get(task_id).current_run_id, running.current_run_id)
        self.assertIsNone(self.bridge.store.native_intent("create:issue-1"))

    def test_chat_track_delegate_response_loss_restarts_without_resend_or_new_task(self):
        from hermes_fleet_linear_plugin.store import Store
        self.remote.set_delegate("issue-1", None)
        self.fixture.bind_api()
        task = self.link()
        before = self.snapshot()
        route = next(row for row in self.bridge.store.pending() if row["kind"] == "delegate")
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(only_id=route["id"]), 0)
        self.assertEqual(self.issue["delegate"]["id"], SELF)
        self.bridge.store = Store(self.bridge.store.path)
        self.fixture.clock.now += 3601
        self.assertEqual(self.bridge.flush(only_id=route["id"]), 1)
        self.assertEqual(len(self.mutations()), 1)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.bridge.store.native_binding("issue-1")["task_id"], task.id)

    def test_blocked_remainder_delegate_and_authoritative_assignment_echo_reuse_task(self):
        task = self.link()
        before_native = self.snapshot()
        before_issue = copy.deepcopy(self.issue)
        before_binding = self.bridge.store.native_binding("issue-1")
        self.assertFalse(self.bridge._report_delegate_allowed(self.bridge.api.issue("issue-1")))
        self.deliver(self.request())
        self.assertEqual(self.snapshot(), before_native)
        self.assertEqual(self.bridge.store.native_binding("issue-1"), before_binding)
        for key in ("assignee", "title", "description", "state", "project"):
            self.assertEqual(self.issue[key], before_issue[key], key)
        self.assertTrue(self.bridge._report_delegate_allowed(self.bridge.api.issue("issue-1")))
        self.assertEqual(self.fixture.seen[-1].platform, "api_server")
        self.assertEqual(self.fixture.seen[-1].session_id, "durable-1")

        # Provider automatic assignment has no human actor. The real authorized
        # webhook path must retain the stopped linked remainder, without admission.
        session = "assignment-echo"
        self.remote.session_records[session] = {"id": session, "creator": None,
            "appUser": {"id": SELF}, "issue": {"id": "issue-1"}}
        event = self.remote.session_event("created", "issue-1", session, creator=None)
        event["agentSession"].pop("creatorId")
        self.assertTrue(self.bridge.handle_webhook(event))
        self.assertEqual(self.snapshot(), before_native)
        self.assertEqual(self.board.get(task.id).status, "blocked")
        self.assertEqual(self.bridge.store.native_binding("issue-1"), before_binding)
        self.assertIsNone(self.bridge.store.native_intent("create:issue-1"))
        self.assertNotIn("unblocked", [event.kind for event in self.board.history(task.id, 0)])

    def test_running_native_run_and_claim_survive_then_followup_uses_same_task(self):
        task = self.link(status="running")
        with self.board.conn() as db:
            running = self.board.kb.claim_task(db, task.id, claimer="finite-native-controller")
        self.assertIsNotNone(running)
        self.assertTrue(running.current_run_id)
        self.assertTrue(running.claim_lock)
        before = self.snapshot()
        self.deliver(self.request())
        self.assertEqual(self.snapshot(), before)
        result = self.call({"action": "followup", "issue": "ABC-1", "id": str(uuid.uuid4()),
                            "body": "Continue only the inspected remaining work."})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["native"]["task_id"], task.id)
        after = self.board.get(task.id)
        self.assertEqual((after.status, after.current_run_id, after.claim_lock),
                         (running.status, running.current_run_id, running.claim_lock))
        with self.board.conn() as db:
            comments = self.board.kb.list_comments(db, task.id)
        self.assertEqual(len(comments), 1)
        self.assertIn("inspected remaining work", comments[0].body)

    def test_changed_remote_delegate_after_queue_cannot_be_overwritten(self):
        self.link()
        request = self.request()
        self.assertTrue(self.call(request)["ok"])
        before = self.snapshot()
        self.remote.set_delegate("issue-1", {"id": "new-human-selected-agent"})
        self.assertEqual(self.bridge.flush(only_id=request["id"]), 0)
        self.assertEqual(self.remote.issues["issue-1"]["delegate"]["id"], "new-human-selected-agent")
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.snapshot(), before)

    def test_lost_delegate_response_reopens_store_and_settles_by_readback_without_resend(self):
        from hermes_fleet_linear_plugin.store import Store
        self.link()
        request = self.request()
        self.assertTrue(self.call(request)["ok"])
        before = self.snapshot()
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(only_id=request["id"]), 0)
        self.assertEqual(self.issue["delegate"]["id"], SELF)
        self.assertEqual(len(self.mutations()), 1)
        self.bridge.store = Store(self.bridge.store.path)
        self.fixture.clock.now += 3601
        self.assertEqual(self.bridge.flush(only_id=request["id"]), 1)
        self.assertEqual(self.bridge.store.outbox_row(request["id"])["state"], "sent")
        self.assertEqual(len(self.mutations()), 1)
        self.assertEqual(self.snapshot(), before)

    def test_lost_delegate_response_does_not_overwrite_later_human_selected_agent(self):
        from hermes_fleet_linear_plugin.store import Store
        self.link()
        request = self.request()
        self.assertTrue(self.call(request)["ok"])
        before = self.snapshot()
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(only_id=request["id"]), 0)
        self.remote.set_delegate("issue-1", {"id": "later-human-selection"})
        self.bridge.store = Store(self.bridge.store.path)
        self.fixture.clock.now += 3601
        self.assertEqual(self.bridge.flush(only_id=request["id"]), 0)
        self.assertEqual(self.issue["delegate"]["id"], "later-human-selection")
        self.assertEqual(len(self.mutations()), 1)
        self.assertTrue(self.bridge.store.issue_reconciliation_blocked("issue-1"))
        self.assertEqual(self.snapshot(), before)

    def test_changed_local_binding_after_inspection_refuses_without_native_effect(self):
        self.link()
        request = self.request()
        other = self.board.create(title="Newer inspected remainder", initial_status="blocked")
        replacement = self.call({"action": "track", "issue": "ABC-1", "task_id": other.id,
            "replace": True, "id": str(uuid.uuid4()),
            "expected_binding_revision": request["expected_binding_revision"]})
        self.assertTrue(replacement["ok"], replacement)
        before = self.snapshot()
        result = self.call(request)
        self.assertFalse(result["ok"], result)
        self.assertNotEqual(result.get("code"), "unsupported_action", result)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.bridge.store.native_binding("issue-1")["task_id"], other.id)

    def test_worker_board_pin_cannot_delegate_another_boards_link(self):
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin.bridge import Kanban
        other = Kanban("other-project", profile="default", profile_home=self.fixture.home)
        self.link(board=other)
        request = self.request()
        before = self.snapshot(other)
        with patch.dict(os.environ, {"HERMES_KANBAN_BOARD": "default",
                "HERMES_KANBAN_DB": str(kb.kanban_db_path(board="default")),
                "HERMES_KANBAN_TASK": "native-worker"}):
            result = self.call(request)
        self.assertFalse(result["ok"], result)
        self.assertIn("pin", result["message"])
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.snapshot(other), before)

    def test_delegated_child_cannot_change_parent_work_routing(self):
        from agent.delegation_context import delegated_child_context
        self.link()
        request = self.request()
        before = self.snapshot()
        with delegated_child_context("native-child"):
            result = self.call(request)
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "native_scope_refused")
        self.assertTrue(self.fixture.seen[-1].delegated_child)
        self.assertIsNone(self.bridge.store.outbox_row(request["id"]))
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.snapshot(), before)

    def test_retained_task_with_conflicting_issue_scope_cannot_change_delegate(self):
        task = self.link()
        request = self.request()
        with self.board.conn() as db:
            self.assertTrue(self.board.kb.edit_task(db, task.id,
                body="Linear issue issue-other: https://linear.example/issue/ABC-OTHER"))
        before = self.snapshot()
        result = self.call(request)
        self.assertFalse(result["ok"], result)
        self.assertNotEqual(result.get("code"), "unsupported_action", result)
        self.assertIsNone(self.bridge.store.outbox_row(request["id"]))
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.snapshot(), before)

    def test_unlinked_issue_cannot_assign_remote_delegate_or_create_native_work(self):
        request = self.request()
        before = self.snapshot()
        result = self.call(request)
        self.assertFalse(result["ok"], result)
        self.assertNotEqual(result.get("code"), "unsupported_action", result)
        self.assertIsNone(self.bridge.store.outbox_row(request["id"]))
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.snapshot(), before)
        self.assertIsNone(self.bridge.store.get("issue-1"))

    def test_foreign_profile_context_refuses_before_private_rpc(self):
        self.link()
        request = self.request()
        before = self.snapshot()
        observed = len(self.fixture.seen)
        self.fixture.bind_api(profile="foreign")
        result = self.call(request)
        self.assertFalse(result["ok"], result)
        self.assertEqual(len(self.fixture.seen), observed)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.snapshot(), before)

    def scoped_queue(self):
        from gateway.config import Platform
        from gateway.run import GatewayRunner
        from gateway.session import SessionContext, SessionSource
        from hermes_fleet_linear_plugin import BoundLinearAPI
        self.link()
        session, activity = "source-session", "source-activity"
        self.remote.session_records[session] = {"id": session, "creator": None,
            "appUser": {"id": SELF}, "issue": {"id": "issue-1"}}
        self.remote.activity_records[activity] = {"id": activity, "user": {"id": "human-1"},
            "agentSession": {"id": session}}
        self.bridge.api = BoundLinearAPI(lambda: "synthetic", endpoint=self.remote.url,
            identity={"viewer_id": SELF, "organization_id": "org-1"},
            specialist_scope={"allowed_team_ids": ["team-1"],
                "allowed_project_ids": ["proj-1"], "allowed_requester_ids": ["human-1"],
                "requester_basis": "agent_session"})
        # The real messaging producer binds the source coordinates. The
        # authoritative Activity supplies its actor; the session creator stays null.
        runner = object.__new__(GatewayRunner)
        runner.config = SimpleNamespace(multiplex_profiles=False)
        runner.adapters = {}
        runner._configured_runtime_profile_name = "default"
        source = SessionSource(platform=Platform("linear"), chat_id="issue-1", user_id="human-1",
                               scope_id="org-1", thread_id=session, message_id=activity, profile="default")
        context = SessionContext(source=source, connected_platforms=[], home_channels={},
            session_key="linear:issue-1:source-session", session_id="native-turn")
        runner._set_session_env(context)
        request = self.request()
        before = self.snapshot()
        queued = self.call(request)
        self.assertTrue(queued["ok"], queued)
        row = self.bridge.store.outbox_row(request["id"])
        self.assertEqual(row["payload"]["requester_sessions"], {"issue-1": session})
        self.assertEqual(row["payload"]["requester_activities"], {"issue-1": activity})
        captured = self.fixture.seen[-1]
        self.assertEqual((captured.platform, captured.user_id, captured.thread_id, captured.message_id),
                         ("linear", "human-1", session, activity))
        self.fixture.bind_api()
        return request, before, session, activity

    def test_native_linear_activity_requester_survives_restart_and_deferred_delivery(self):
        from hermes_fleet_linear_plugin.store import Store
        request, before, session, activity = self.scoped_queue()
        self.bridge.store = Store(self.bridge.store.path)
        self.remote.requests.clear()
        self.assertEqual(self.bridge.flush(only_id=request["id"]), 1)
        self.assertEqual(self.issue["delegate"]["id"], SELF)
        self.assertIsNone(self.remote.session_records[session]["creator"])
        self.assertIn("query AgentSessionAuthorization", self.remote.requests)
        self.assertIn("query AgentActivityAuthorization", self.remote.requests)
        self.assertEqual(self.snapshot(), before)

    def test_native_linear_activity_requester_change_refuses_deferred_delivery_after_restart(self):
        from hermes_fleet_linear_plugin.store import Store
        request, before, session, activity = self.scoped_queue()
        self.bridge.store = Store(self.bridge.store.path)
        self.remote.activity_records[activity]["user"] = {"id": "outside-requester"}
        self.assertEqual(self.bridge.flush(only_id=request["id"]), 0)
        self.assertEqual(self.issue["delegate"], OTHER)
        self.assertEqual(self.mutations(), [])
        retained = self.bridge.store.outbox_row(request["id"])["payload"]
        self.assertEqual(retained["requester_sessions"], {"issue-1": session})
        self.assertEqual(retained["requester_activities"], {"issue-1": activity})
        self.assertIsNone(self.remote.session_records[session]["creator"])
        self.assertEqual(self.snapshot(), before)

    def test_current_app_and_authoritative_requester_remain_required_after_delegate(self):
        from hermes_fleet_linear_plugin.native_input import project_input
        from hermes_fleet_linear_plugin.api import LinearError
        self.link()
        self.deliver(self.request())
        session, activity = "later-session", "later-activity"
        self.remote.session_records[session] = {"id": session, "creator": {"id": "human-1"},
            "appUser": {"id": SELF}, "issue": {"id": "issue-1"}}
        self.remote.activity_records[activity] = {"id": activity, "user": {"id": "human-1"},
            "agentSession": {"id": session}}
        event = self.remote.session_event("prompted", "issue-1", session,
            activity_id=activity, body="Continue the remaining work.")
        before = self.snapshot()
        projected = project_input(self.bridge, event)
        self.assertEqual((projected.actor_id, projected.session_id, projected.issue_id),
                         ("human-1", session, "issue-1"))
        self.assertEqual(self.snapshot(), before)
        # The old app cannot consume B's authoritative session, even with its
        # own credential/identity binding. No bot is substituted as a human.
        self.remote.app_id = OTHER["id"]
        self.bridge.api.identity = {"viewer_id": OTHER["id"], "organization_id": "org-1"}
        with self.assertRaisesRegex(LinearError, "another app"):
            project_input(self.bridge, event)
        refused = self.call({"action": "followup", "issue": "ABC-1", "id": str(uuid.uuid4()),
                             "body": "A stale owner must not steer B's work."})
        self.assertFalse(refused["ok"], refused)
        self.assertIn("reassigned", refused["message"])
        self.assertFalse(self.bridge._report_delegate_allowed(self.bridge.api.issue("issue-1")))
        self.assertEqual(self.snapshot(), before)
        self.remote.app_id = SELF
        self.bridge.api.identity = {"viewer_id": SELF, "organization_id": "org-1"}
        self.remote.activity_records[activity]["user"] = {"id": "outside-requester"}
        with self.assertRaisesRegex(LinearError, "outside specialist scope"):
            project_input(self.bridge, event)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
