"""Adversarial coverage for the opt-in specialist authorization boundary.

HF-562 migration: chat claim/Stop/restart-injection tests now exercise native
binding preservation, ordinary unlinked authorization, and current native
follow-up controls. Prior admission/retirement crash tests now exercise durable
native request intents and inspect-before-retry reconciliation. Actor, app,
workspace, target scope, requester provenance, credential-refresh and outbox
transaction tests remain independent of plugin execution ownership.

Authority and FakeKanban are shared synthetic fixtures, not native-runtime proof.
The separate native bridge scenarios exercise the actual upstream boundary.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from linear_fake_api import canonical_uuid4, load_plugin
from linear_ingress_fixture import IngressStore, Route

plugin = load_plugin()
from hermes_fleet_linear_plugin.api import LinearError  # noqa: E402
from hermes_fleet_linear_plugin.bridge import Bridge  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402

VIEWER = "app-allowed"
ORG = "org-allowed"
TEAM = "team-allowed"
PROJECT = "project-allowed"
USER = "user-allowed"
ISSUE = "issue-allowed"
SESSION = "session-allowed"
ACTIVITY = "activity-allowed"
SCOPE = {
    "allowed_team_ids": [TEAM],
    "allowed_project_ids": [PROJECT],
    "allowed_requester_ids": [USER],
}


def issue_record(**changes):
    issue = {
        "id": ISSUE,
        "identifier": "OPS-1",
        "title": "Synthetic issue",
        "description": "Synthetic issue body",
        "url": "https://linear.example/issue/OPS-1",
        "updatedAt": "2026-01-01T00:00:00Z",
        "creator": {"id": USER},
        "delegate": None,
        "assignee": None,
        "state": {"id": "state-todo", "name": "Todo", "type": "unstarted"},
        "project": {"id": PROJECT},
        "team": {"id": TEAM, "key": "OPS", "states": {"nodes": [
            {"id": "state-todo", "name": "Todo", "type": "unstarted"},
            {"id": "state-progress", "name": "In Progress", "type": "started"},
            {"id": "state-blocked", "name": "Blocked", "type": "started"},
            {"id": "state-done", "name": "Done", "type": "completed"},
        ]}},
    }
    issue.update(changes)
    return issue


class Authority:
    """Authoritative API fixture independent from webhook payload fields."""

    def __init__(self):
        self.viewer = VIEWER
        self.organization = ORG
        self.issues = {ISSUE: issue_record()}
        self.sessions = {SESSION: {"id": SESSION, "issue": {"id": ISSUE}, "creator": {"id": USER}, "appUser": {"id": VIEWER}}}
        self.activities = {ACTIVITY: {"id": ACTIVITY, "user": {"id": USER},
                                      "agentSession": {"id": SESSION}}}
        self.requests: list[str] = []
        self.mutations: list[str] = []
        self.comments: dict[str, list] = {}
        self.comment_records: dict[str, dict] = {}
        self.history: dict[str, list] = {}  # IssueHistory, oldest first
        self.fail_session = False
        self.fail_issue = False

    def human_edit(self, issue_id, stamp):
        """A person changes the issue's state: Linear records it in IssueHistory and moves updatedAt."""
        self.issues[issue_id]["updatedAt"] = stamp
        self.history.setdefault(issue_id, []).append({
            "createdAt": stamp, "actorId": USER, "fromStateId": "state-progress", "toStateId": "state-todo",
            "fromAssigneeId": None, "toAssigneeId": None, "fromDelegate": None, "toDelegate": None})

    def transport(self, _url, body, _headers):
        payload = json.loads(body)
        query, variables = payload["query"], payload.get("variables") or {}
        self.requests.append(query)
        if "IdentityBinding" in query:
            data = {"viewer": {"id": self.viewer}, "organization": {"id": self.organization}}
        elif "query AgentSessionAuthorization" in query:
            if self.fail_session:
                return 503, {}, json.dumps({"errors": [{"message": "fixture unavailable"}]}).encode()
            data = {"agentSession": self.sessions.get(variables["id"])}
        elif "query OutboundAgentActivity" in query:
            data = {"agentActivity": self.activities.get(variables["id"])}
        elif "query AgentAnswerChronology" in query:
            data = {name: self.activities.get(variables[name]) for name in ("question", "answer")}
        elif "query AgentActivityAuthorization" in query:
            data = {"agentActivity": self.activities.get(variables["id"])}
        elif "query CommentReadback(" in query or "query CompletionCommentReadback(" in query:
            data = {"comment": self.comment_records.get(variables["id"])}
        elif "query IssueThread(" in query or "query IssueProgress(" in query:
            issue = self.issues.get(variables["id"])
            data = {"issue": {**issue, "comments": {"nodes": self.comments.get(variables["id"], [])}} if issue else None}
        elif "query IssueRoutingHistory(" in query:
            issue = self.issues.get(variables["id"])
            nodes = list(reversed(self.history.get(variables["id"], [])))  # Linear connections are newest first
            data = {"issue": {**issue, "history": {"nodes": nodes, "pageInfo": {"hasNextPage": False}}} if issue else None}
        elif "query Issue(" in query:
            if self.fail_issue:
                return 503, {}, json.dumps({"errors": [{"message": "fixture unavailable"}]}).encode()
            data = {"issue": self.issues.get(variables["id"])}
        elif query.lstrip().startswith("mutation"):
            self.mutations.append(query)
            field = next((name for name in ("issueUpdate", "commentCreate", "agentActivityCreate",
                                            "projectUpdateCreate") if name in query), None)
            client_id = (variables.get("input") or {}).get("id")
            if field and field.endswith("Create") and not canonical_uuid4(client_id):
                return 200, {}, json.dumps({"data": None, "errors": [{"message": "Argument Validation Error",
                    "extensions": {"code": "INPUT_ERROR"}}]}).encode()
            if field == "agentActivityCreate":
                from datetime import datetime, timezone
                fields = variables["input"]
                self.activities.setdefault(fields["id"], {"id": fields["id"], "user": {"id": self.viewer},
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "content": {**fields["content"],
                                "__typename": "AgentActivity" + fields["content"]["type"].capitalize() + "Content"},
                    "agentSession": {"id": fields["agentSessionId"]}})
            if field == "commentCreate":
                fields = variables["input"]
                self.comment_records.setdefault(fields["id"], {"id": fields["id"], "body": fields["body"],
                    "issue": {"id": fields["issueId"]}, "parent": None, "user": {"id": self.viewer}})
            if field == "issueUpdate" and "description" in variables.get("input", {}):
                self.issues[variables["id"]]["description"] = variables["input"]["description"]
            data = {field: {"success": True}} if field else {}
            if field == "issueUpdate":
                issue, fields = self.issues[variables["id"]], variables["input"]
                if "stateId" in fields:
                    issue["state"] = next(dict(state) for state in issue["team"]["states"]["nodes"] if state["id"] == fields["stateId"])
                data[field]["issue"] = json.loads(json.dumps(issue))
        else:
            data = {"organization": {"id": ORG}}
        return 200, {}, json.dumps({"data": data}).encode()

    def api(self, *, scope=SCOPE, identity=None):
        return plugin.BoundLinearAPI(
            lambda: "synthetic", identity=identity or {"viewer_id": VIEWER, "organization_id": ORG},
            specialist_scope=scope, transport=self.transport)


class FakeKanban:
    def __init__(self):
        self.executor_profile = "synthetic"
        self.board = "default"
        self.creates = []
        self.subscriptions = []
        self.tasks = {}
        self.histories = {}
        self.event_calls = []
        self.comments = []
        self._comment_receipts = []

    def create(self, **fields):
        self.creates.append(fields)
        task = SimpleNamespace(id="task-1", status="blocked" if fields.get("initial_status") == "blocked" else "ready", completion_contract=fields.get("completion_contract"),
                               result="", title=fields.get("title", "Synthetic task"),
                               current_run_id=None, assignee=self.executor_profile,
                               body=fields.get("body", ""), created_by=fields.get("created_by", "linear"),
                               idempotency_key=fields.get("idempotency_key"))
        self.tasks[task.id] = task
        if task.status == "blocked":
            self.histories[task.id] = [SimpleNamespace(id=1, kind="blocked", created_at=0, payload={"reason": "initial_status"})]
        return task

    def get(self, task_id):
        return self.tasks.get(task_id)

    def events(self, task_id, issue_id):
        self.event_calls.append((task_id, issue_id))
        return []

    def history(self, task_id, after_id):
        return [event for event in self.histories.get(task_id, []) if event.id > after_id]

    def record_completion(self, task, event_id):
        """Seed an explicit synthetic native completion, independently of status."""
        task.current_run_id = task.current_run_id or 1
        self.histories.setdefault(task.id, []).append(SimpleNamespace(
            id=event_id, kind="completed", created_at=int(time.time()),
            run_id=task.current_run_id, payload={"summary": task.result}))

    def completion_summary(self, task):
        return task.result or ""

    def evidence_text(self, _task):
        return ""

    def subscribe(self, task_id, issue_id, *, issue=None):
        if issue is not None:
            from hermes_fleet_linear_plugin.bridge import require_task_issue_scope
            require_task_issue_scope(self.require_task(task_id), issue)
        self.subscriptions.append((task_id, issue_id))

    def comment(self, task_id, body, *, marker="", issue=None, paused_event_id=None):
        if issue is not None:
            from hermes_fleet_linear_plugin.bridge import require_task_issue_scope
            task = self.require_task(task_id)
            require_task_issue_scope(task, issue)
            if task.status not in (("blocked", "triage") if paused_event_id is not None else ("running", "ready", "review")):
                raise LinearError("Native work stopped or ended before follow-up delivery", retryable=False)
        self.comments.append((task_id, body))
        self._comment_receipts.append((task_id, body.strip(), marker, len(self.comments)))
        return len(self.comments)

    def require_task(self, task_id):
        task = self.get(task_id)
        if task is None:
            raise LinearError("Native task could not be resolved", retryable=False)
        if getattr(task, "assignee", None) != self.executor_profile:
            raise LinearError("Native task belongs to another executor profile", retryable=False)
        return task

    def find_created(self, key):
        return [task for task in self.tasks.values() if getattr(task, "idempotency_key", None) == key]

    def discover(self, issue):
        from hermes_fleet_linear_plugin.bridge import task_issue_match
        return [(self, task) for task in self.tasks.values()
                if task_issue_match(task, issue)]

    def find_comment(self, task_id, body, marker):
        return [SimpleNamespace(id=receipt[3]) for receipt in self._comment_receipts
                if receipt[:3] == (task_id, body.strip(), marker)]

    def unblock(self, task_id):
        self.tasks[task_id].status = "ready"
        return True

    def retirement(self, task_id, prior=None):
        return prior or {"workers": [], "pending": [], "missing": False}
    def await_retirement(self, snapshot):
        pass
    def archive(self, task_id):
        self.tasks[task_id].status = "archived"

    def block(self, task_id, _reason, *, run_id=None, issue=None):
        if issue is not None:
            from hermes_fleet_linear_plugin.bridge import require_task_issue_scope
            require_task_issue_scope(self.require_task(task_id), issue)
        self.tasks[task_id].status = "blocked"


class LinearSpecialistAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.authority = Authority()
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.kanban = FakeKanban()
        self.store = Store(Path(self.tmp.name) / "state.db")
        self.api = self.authority.api()
        self.bridge = Bridge(self.store, self.api, self.kanban, profile="synthetic")
        self.bridge.profile_home = Path(self.tmp.name)

    def context(self):
        from hermes_fleet_linear_plugin.transport import NativeContext
        return NativeContext(home=str(self.bridge.profile_home), profile="synthetic", platform="slack", source="slack", session_key="chat-key", session_id="chat-session")

    def seed_kanban_work(self, issue_id=ISSUE, *, task_status="ready", events=()):
        task_id = f"task-{issue_id}"
        self.kanban.tasks[task_id] = SimpleNamespace(id=task_id, status=task_status,
                                                     completion_contract=None, result="", title="OPS-1: task",
                                                     current_run_id=1 if task_status == "running" else None, assignee="synthetic")
        self.kanban.histories[task_id] = list(events)
        self.store.bind_native(issue_id, task_id, "synthetic", "default", owner_ref=SESSION, project_id=PROJECT, at=0)
        return task_id

    def session_event(self, action="created", *, event_issue=ISSUE, creator=USER,
                      user=USER, event_team=TEAM, event_project=PROJECT, event_user=USER):
        event = {
            "type": "AgentSessionEvent",
            "action": action,
            "createdAt": "2026-01-01T00:00:00Z",
            "agentSession": {
                "id": SESSION,
                "creatorId": creator,
                "issue": {"id": event_issue, "team": {"id": event_team},
                          "project": {"id": event_project}, "creator": {"id": event_user},
                          "title": "Untrusted webhook title"},
            },
            "promptContext": "untrusted webhook context",
        }
        if action == "prompted":
            event["agentActivity"] = {"id": ACTIVITY,
                                      "user": {"id": user},
                                      "content": {"type": "prompt", "body": "untrusted prompt"}}
        return event

    def test_status_send_refuses_second_lookup_redirect(self):
        self.seed_kanban_work()
        other = "issue-other"
        self.authority.issues[other] = issue_record(id=other)
        row_id = self.bridge.status(ISSUE, "in_progress")
        original = self.api.issue
        calls = 0
        def redirected(ref):
            nonlocal calls
            if ref == ISSUE:
                calls += 1
                if calls == 2:
                    return original(other)
            return original(ref)
        self.api.issue = redirected
        self.assertEqual(self.bridge.flush(), 0)
        self.assertEqual(calls, 2)
        self.assertEqual(self.authority.mutations, [])
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertFalse(self.store.scope_fenced(other))
        self.assertEqual(self.store.outbox_row(row_id)["state"], "pending")

    def test_created_scope_denial_fences_authoritative_issue_across_replay(self):
        self.authority.issues[ISSUE] = issue_record(project={"id": "foreign-project"})
        event = self.session_event()
        self.bridge.handle_webhook(event)
        self.assertTrue(self.store.scope_fenced(ISSUE))
        self.authority.issues[ISSUE] = issue_record()
        self.bridge.handle_webhook(event)
        self.assertEqual(self.kanban.creates, [])
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.store.pending(), [])

    def test_project_send_refuses_second_lookup_redirect(self):
        self.seed_kanban_work()
        other = "issue-other"
        self.authority.issues[ISSUE] = issue_record(delegate={"id": VIEWER})
        self.authority.issues[other] = issue_record(id=other, delegate={"id": VIEWER})
        self.bridge.project_update(SESSION, PROJECT, "OPS-1", "result", issue_id=ISSUE, quiet=False)
        before = self.store.pending()
        original = self.api.issue
        calls = 0
        def redirected(ref):
            nonlocal calls
            if ref == ISSUE:
                calls += 1
                if calls == 2:
                    return original(other)
            return original(ref)
        self.api.issue = redirected
        self.assertEqual(self.bridge.flush(), 0)
        self.assertEqual(calls, 2)
        self.assertEqual(self.authority.mutations, [])
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertFalse(self.store.scope_fenced(other))
        self.assertEqual([(r["id"], r["payload"], r["state"]) for r in self.store.pending()],
                         [(r["id"], r["payload"], r["state"]) for r in before])


    def test_fenced_native_stop_preserves_binding_and_task(self):
        task_id = self.seed_kanban_work()
        before = self.store.get(ISSUE)
        self.store.fence_scope(ISSUE, "permanent denial", at=2)
        self.bridge.handle_webhook({**self.session_event("prompted"), "agentActivity": {
            "id": ACTIVITY, "user": {"id": USER}, "signal": "stop"}})
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertIsNone(self.store.native_intent(f"stop:{ISSUE}:{ACTIVITY}"))


    def test_legacy_chat_record_never_uses_a_plugin_stop_controller(self):
        self.store.put(ISSUE, "chat", "legacy-owner")
        before = self.store.get(ISSUE)
        self.bridge.handle_webhook({**self.session_event("prompted"), "agentActivity": {
            "id": ACTIVITY, "user": {"id": USER}, "signal": "stop"}})
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.kanban.comments, [])
        self.assertEqual(self.kanban.creates, [])
        self.assertFalse(hasattr(self.bridge, "inject"))


    def test_identity_mismatch_before_issue_resolution_does_not_fence_work(self):
        task_id = self.seed_kanban_work()
        before = self.store.get(ISSUE)
        self.authority.viewer = "viewer-foreign"
        self.bridge.pump_kanban()
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertEqual(self.authority.mutations, [])
        self.assertEqual(self.store.pending(), [])

    def test_first_lookup_redirect_does_not_fence_or_archive_requested_work(self):
        task_id = self.seed_kanban_work()
        other = "issue-other"
        other_task = self.seed_kanban_work(other)
        self.authority.issues[other] = issue_record(id=other)
        before = self.store.get(ISSUE)
        original = self.api.issue
        self.api.issue = lambda ref: original(other) if ref == ISSUE else original(ref)
        self.bridge.pump_kanban()
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertFalse(self.store.scope_fenced(other))
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertEqual(self.kanban.tasks[other_task].status, "ready")
        self.assertEqual(self.authority.mutations, [])
        self.assertEqual(self.store.pending(ISSUE), [])
        # The correctly resolved issue only gets its native-derived state: queued work shows Todo.
        self.assertEqual([(row["kind"], row["payload"]["state"]) for row in self.store.pending()], [("status", "todo")])

    def test_session_payload_issue_mismatch_preserves_both_existing_tasks(self):
        other = "issue-other"
        first_task = self.seed_kanban_work()
        other_task = self.seed_kanban_work(other)
        self.authority.issues[other] = issue_record(id=other)
        self.authority.sessions[SESSION]["issue"]["id"] = other
        before = (self.store.get(ISSUE), self.store.get(other))
        self.bridge.handle_webhook(self.session_event())
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertFalse(self.store.scope_fenced(other))
        self.assertEqual((self.store.get(ISSUE), self.store.get(other)), before)
        self.assertEqual(self.kanban.tasks[first_task].status, "ready")
        self.assertEqual(self.kanban.tasks[other_task].status, "ready")
        self.assertEqual(self.store.pending(), [])
        self.assertEqual(self.authority.mutations, [])

    def test_unlinked_status_rejects_wrong_resource_without_fencing_either_issue(self):
        from hermes_fleet_linear_plugin import chat
        other = "issue-requested"
        context = self.context()
        original = self.api.issue
        self.api.issue = lambda ref: original(ISSUE)
        reply = json.loads(chat.handle(self.bridge, {"action": "status", "issue": other}, context))
        self.assertFalse(reply["ok"])
        self.assertFalse(self.store.scope_fenced(other))
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertEqual(self.store.active(), [])
        self.assertEqual(self.store.pending(), [])
        self.assertEqual(self.authority.mutations, [])

    def test_unlinked_status_scope_denial_does_not_create_execution(self):
        from hermes_fleet_linear_plugin import chat
        self.authority.issues[ISSUE] = issue_record(project={"id": "foreign-project"})
        reply = json.loads(chat.handle(self.bridge, {"action": "status", "issue": ISSUE}, self.context()))
        self.assertFalse(reply["ok"])
        self.assertEqual(self.store.active(), [])
        self.assertEqual(self.store.pending(), [])
        self.assertEqual(self.kanban.creates, [])


    def test_resolver_redirect_scope_error_cannot_fence_returned_issue(self):
        from hermes_fleet_linear_plugin import chat
        other = "issue-other"
        task_id = self.seed_kanban_work(other)
        self.authority.issues[ISSUE] = issue_record(id=other, project={"id": "foreign-project"})
        context = self.context()
        reply = json.loads(chat.handle(self.bridge, {"action": "status", "issue": ISSUE}, context))
        self.assertFalse(reply["ok"])
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertFalse(self.store.scope_fenced(other))
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertEqual(self.store.pending(), [])

    def test_unlinked_status_identifier_alias_resolves_only_its_own_issue(self):
        from hermes_fleet_linear_plugin import chat
        self.authority.issues["OPS-1"] = issue_record()
        reply = json.loads(chat.handle(self.bridge, {"action": "status", "issue": "OPS-1"}, self.context()))
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["issue"]["id"], ISSUE)
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.kanban.creates, [])


    def test_compact_read_alias_keeps_specialist_requester_and_scope_denials(self):
        from hermes_fleet_linear_plugin import chat
        self.authority.issues["OPS-1"] = issue_record()
        for changes in ({"creator": {"id": "foreign-requester"}},
                        {"project": {"id": "foreign-project"}},
                        {"team": {"id": "foreign-team", "key": "OPS"}},
                        {"identifier": "OTHER-1"}):
            with self.subTest(changes=changes):
                self.authority.issues["OPS-1"] = issue_record(**changes)
                result = json.loads(chat.handle(self.bridge, {"action": "status", "issue": "OPS1"}, self.context()))
                self.assertFalse(result["ok"], result)
                self.assertEqual(self.store.active(), [])
                self.assertEqual(self.store.pending(), [])
                self.assertEqual(self.kanban.creates, [])
                self.assertEqual(self.authority.mutations, [])

    def test_scope_contract_is_complete_and_closed(self):
        for scope in (
            {},
            {"allowed_team_ids": [TEAM], "allowed_project_ids": [PROJECT]},
            {"allowed_team_ids": [TEAM], "allowed_requester_ids": [USER]},
            {"allowed_project_ids": [PROJECT], "allowed_requester_ids": [USER]},
            {**SCOPE, "extra": ["not-accepted"]},
            {**SCOPE, "allowed_team_ids": []},
            {**SCOPE, "allowed_requester_ids": [" "]},
            {"all_teams": True, "all_projects": False, "allowed_requester_ids": [USER]},
            {"all_teams": 1, "all_projects": True, "allowed_requester_ids": [USER]},
            {"all_teams": True, "all_projects": True, "allowed_requester_ids": []},
            {**SCOPE, "all_teams": True, "all_projects": True},
        ):
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                plugin.BoundLinearAPI(lambda: self.fail("credentials must not be read"),
                                      identity={"viewer_id": VIEWER, "organization_id": ORG},
                                      specialist_scope=scope)

    def test_all_teams_and_projects_in_bound_organization_keep_requester_boundary(self):
        api = self.authority.api(scope={"all_teams": True, "all_projects": True,
                                       "allowed_requester_ids": [USER]})
        for project in (None, {"id": "new-project"}):
            self.authority.issues[ISSUE] = issue_record(team={"id": "new-team"}, project=project)
            self.assertEqual(api.issue(ISSUE)["id"], ISSUE)
        self.authority.issues[ISSUE] = issue_record(creator={"id": "foreign-user"}, project=None)
        with self.assertRaises(LinearError):
            api.update_issue(ISSUE, {"title": "must not write"})
        self.assertEqual(self.authority.mutations, [])
        with self.assertRaises(LinearError):
            api.graphql("query Arbitrary { organization { id } }")
        self.authority.organization = "foreign-org"
        with self.assertRaises(LinearError):
            api.issue(ISSUE)

    def test_arbitrary_graphql_is_refused_without_network_access_in_specialist_mode(self):
        before = len(self.authority.requests)
        with self.assertRaises(LinearError):
            self.api.graphql("query Exfiltrate { users { nodes { id } } }")
        self.assertEqual(len(self.authority.requests), before)

    def test_automatic_session_without_creator_requires_own_app_and_authorized_issue(self):
        self.authority.sessions[SESSION] = {"id": SESSION, "issue": {"id": ISSUE},
                                           "creator": None, "appUser": {"id": VIEWER}}
        self.assertEqual(self.api.agent_session(SESSION)["id"], SESSION)
        self.authority.sessions[SESSION]["appUser"] = {"id": "foreign-app"}
        with self.assertRaises(LinearError):
            self.api.agent_session(SESSION)
        self.authority.sessions[SESSION]["appUser"] = {"id": VIEWER}
        self.authority.issues[ISSUE] = issue_record(creator={"id": "foreign-user"})
        with self.assertRaises(LinearError):
            self.api.create_activity("client-id", SESSION, {"type": "thought", "body": "denied"}, issue_id=ISSUE)
        self.assertEqual(self.authority.mutations, [])

    def test_general_mode_keeps_existing_arbitrary_graphql_semantics(self):
        general = self.authority.api(scope=None)
        self.assertEqual(general.graphql("query Generic { organization { id } }")["organization"]["id"], ORG)

    def test_general_session_and_activity_reads_require_this_app_and_verified_human_actor(self):
        general = self.authority.api(scope=None)
        self.assertEqual(general.agent_session(SESSION)["id"], SESSION)
        self.assertEqual(general.agent_activity(ACTIVITY, SESSION)["user"]["id"], USER)
        for app in (None, {"id": "other-app"}):
            with self.subTest(app=app), self.assertRaises(LinearError):
                self.authority.sessions[SESSION]["appUser"] = app
                general.agent_session(SESSION)
        self.authority.sessions[SESSION]["appUser"] = {"id": VIEWER}
        for actor in (None, {"id": VIEWER}, {"id": ""}):
            with self.subTest(actor=actor), self.assertRaises(LinearError):
                self.authority.activities[ACTIVITY]["user"] = actor
                general.agent_activity(ACTIVITY, SESSION)
        self.assertEqual(self.authority.mutations, [])

    def test_general_session_reads_keep_configured_team_and_workspace_boundary(self):
        general = self.authority.api(scope=None, identity={
            "viewer_id": VIEWER, "organization_id": ORG, "teams": [TEAM]})
        self.authority.issues[ISSUE]["team"] = {"id": "foreign-team", "key": "OTHER"}
        with self.assertRaises(LinearError):
            general.agent_session(SESSION)
        self.authority.issues[ISSUE] = issue_record()
        self.authority.organization = "foreign-workspace"
        # A credential cannot change workspace; a different one (or the proof's 10 min expiry) is re-proved.
        general.token = lambda: "synthetic-other-workspace"
        with self.assertRaises(LinearError):
            general.agent_session(SESSION)
        self.assertEqual(self.authority.mutations, [])

    def test_issue_resolver_uses_authoritative_team_project_and_requester(self):
        cases = (
            {"team": {"id": "team-foreign", "key": "NO", "states": {"nodes": []}}},
            {"project": {"id": "project-foreign"}},
            {"creator": {"id": "user-foreign"}},
            {"creator": None},
            {"project": None},
        )
        for changes in cases:
            self.authority.issues[ISSUE] = issue_record(**changes)
            with self.subTest(changes=changes), self.assertRaises(LinearError):
                self.api.issue(ISSUE)
        self.authority.issues[ISSUE] = issue_record()
        self.assertEqual(self.api.issue(ISSUE)["id"], ISSUE)

    def test_mutations_refuse_unverified_issue_resource_ids(self):
        operations = (
            lambda: self.api.update_issue(ISSUE, {"stateId": "state-progress"}),
            lambda: self.api.create_comment("comment-1", ISSUE, "body"),
            lambda: self.api.create_activity("activity-1", SESSION, {"type": "response", "body": "body"}, issue_id=ISSUE),
            lambda: self.api.create_project_update("update-1", PROJECT, "body", issue_ids=[ISSUE]),
        )
        for resolved_id in (None, "", " ", "issue-foreign"):
            for index, operation in enumerate(operations):
                self.authority.issues[ISSUE] = issue_record(id=resolved_id)
                with self.subTest(resolved_id=resolved_id, operation=index), self.assertRaises(LinearError):
                    operation()
                self.assertEqual(self.authority.mutations, [])

    def test_session_ingress_denies_resolver_failure_foreign_issue_user_and_actor_before_task(self):
        probes = (
            ("session resolver", lambda: setattr(self.authority, "fail_session", True), False),
            ("issue resolver", lambda: setattr(self.authority, "fail_issue", True), False),
            ("foreign team", lambda: self.authority.issues.__setitem__(ISSUE, issue_record(
                team={"id": "team-foreign", "key": "NO", "states": {"nodes": []}})), False),
            ("foreign project", lambda: self.authority.issues.__setitem__(ISSUE, issue_record(
                project={"id": "project-foreign"})), False),
            ("foreign issue requester", lambda: self.authority.issues.__setitem__(ISSUE, issue_record(
                creator={"id": "user-foreign"})), False),
            ("foreign authoritative session creator", lambda: self.authority.sessions.__setitem__(SESSION,
                {"id": SESSION, "issue": {"id": ISSUE}, "creator": {"id": "user-foreign"}}), False),
            ("foreign payload actor", lambda: None, True),
        )
        for label, change, foreign_payload_actor in probes:
            self.authority.issues[ISSUE] = issue_record()
            self.authority.sessions[SESSION] = {"id": SESSION, "issue": {"id": ISSUE}, "creator": {"id": USER}, "appUser": {"id": VIEWER}}
            self.authority.fail_session = self.authority.fail_issue = False
            change()
            event = self.session_event(creator=USER if not foreign_payload_actor else "user-spoofed")
            if foreign_payload_actor:
                self.authority.sessions[SESSION] = {"id": SESSION, "issue": {"id": ISSUE},
                                                    "creator": {"id": "user-foreign"}}
            with self.subTest(reason=label):
                if label.endswith("resolver"):
                    with self.assertRaises(LinearError):
                        self.bridge.handle_webhook(event)
                else:
                    self.bridge.handle_webhook(event)
                self.assertEqual(self.kanban.creates, [])
                self.assertIsNone(self.store.get(ISSUE))
                self.assertEqual(self.authority.mutations, [])

    def test_spoofed_payload_cannot_override_authoritative_issue_or_requester(self):
        self.authority.issues[ISSUE] = issue_record(creator={"id": "user-foreign"})
        event = self.session_event(event_team=TEAM, event_project=PROJECT, event_user=USER)
        self.bridge.handle_webhook(event)
        self.assertEqual(self.kanban.creates, [])
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.authority.mutations, [])

    def test_prompted_activity_actor_and_session_issue_are_resolved_authoritatively(self):
        self.authority.activities[ACTIVITY] = {"id": ACTIVITY, "user": {"id": "user-foreign"},
                                              "agentSession": {"id": SESSION}}
        self.bridge.handle_webhook(self.session_event("prompted", user=USER))
        self.assertEqual(self.kanban.creates, [])
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.authority.mutations, [])

        self.authority.activities[ACTIVITY] = {"id": ACTIVITY, "user": {"id": USER},
                                              "agentSession": {"id": "session-foreign"}}
        self.bridge.handle_webhook(self.session_event("prompted", user=USER))
        self.assertEqual(self.kanban.creates, [])
        self.assertIsNone(self.store.get(ISSUE))

    def test_session_issue_id_must_match_authoritative_session(self):
        self.authority.sessions[SESSION] = {"id": SESSION, "issue": {"id": "issue-foreign"},
                                            "creator": {"id": USER}}
        self.bridge.handle_webhook(self.session_event(event_issue=ISSUE))
        self.assertEqual(self.kanban.creates, [])
        self.assertIsNone(self.store.get(ISSUE))

    def test_foreign_session_requester_cannot_poison_issue_or_authorize_forged_target(self):
        forged = "issue-forged"
        self.authority.sessions[SESSION] = {"id": SESSION, "issue": {"id": ISSUE},
            "creator": {"id": "user-foreign"}, "appUser": {"id": VIEWER}}
        self.bridge.handle_webhook(self.session_event(event_issue=forged))
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertFalse(self.store.scope_fenced(forged))
        self.assertEqual(self.kanban.creates, [])
        self.authority.sessions[SESSION]["creator"]["id"] = USER
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(len(self.kanban.creates), 1)


    def test_session_scope_denial_is_distinct_from_untrusted_binding_denials(self):
        forged = "issue-forged"
        cases = (
            ("issue mismatch", self.session_event(event_issue=forged), None),
            ("missing payload issue", self.session_event(event_issue=""), None),
            ("creator mismatch", self.session_event(creator="user-forged"), None),
            ("activity actor", self.session_event("prompted"),
             {"id": ACTIVITY, "user": {"id": "user-foreign"}, "agentSession": {"id": SESSION}}),
            ("activity session", self.session_event("prompted"),
             {"id": ACTIVITY, "user": {"id": USER}, "agentSession": {"id": "session-foreign"}}),
            ("payload activity actor", self.session_event("prompted", user="user-forged"),
             {"id": ACTIVITY, "user": {"id": USER}, "agentSession": {"id": SESSION}}),
            ("missing activity", self.session_event("prompted"), None),
        )
        for index, (name, event, activity) in enumerate(cases):
            with self.subTest(name=name):
                self.store = Store(Path(self.tmp.name) / f"denial-{index}.db")
                self.bridge = Bridge(self.store, self.api, self.kanban, profile="synthetic")
                self.authority.activities[ACTIVITY] = activity
                if name == "missing activity":
                    event["agentActivity"]["id"] = ""
                self.bridge.handle_webhook(event)
                self.assertEqual(self.store.scope_fenced(ISSUE), name == "activity actor")
                self.assertFalse(self.store.scope_fenced(forged))
                self.assertEqual(self.kanban.creates, [])
                self.assertEqual(self.store.pending(), [])

    def test_transient_session_and_activity_failures_do_not_fence(self):
        event = self.session_event("prompted")
        self.authority.fail_session = True
        with self.assertRaises(LinearError): self.bridge.handle_webhook(event)
        self.authority.fail_session = False
        original = self.api.agent_activity
        self.api.agent_activity = lambda *_: (_ for _ in ()).throw(LinearError("temporary activity outage"))
        try:
            with self.assertRaises(LinearError): self.bridge.handle_webhook(event)
        finally:
            self.api.agent_activity = original
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertEqual(self.store.pending(), [])

    def test_unresolved_session_has_no_issue_identity_even_when_error_names_one(self):
        self.authority.sessions[SESSION] = {"id": "session-foreign", "issue": {"id": ISSUE},
                                            "creator": {"id": "user-foreign"}}
        with self.assertRaises(LinearError) as denial:
            self.api.agent_session(SESSION)
        self.assertIsNone(denial.exception.authoritative_issue_id)
        self.bridge.handle_webhook(self.session_event())
        self.assertFalse(self.store.scope_fenced(ISSUE))
        original = self.api.agent_session
        self.api.agent_session = lambda *_: (_ for _ in ()).throw(
            LinearError(f"untrusted error text mentions {ISSUE}", retryable=False))
        try:
            self.bridge.handle_webhook(self.session_event())
        finally:
            self.api.agent_session = original
        self.assertFalse(self.store.scope_fenced(ISSUE))

    def _assert_issue_webhook_redirect_preserves_other(self, second_lookup):
        other = "issue-other"
        self.authority.issues[other] = issue_record(id=other, delegate={"id": "viewer-foreign"})
        self.seed_kanban_work(ISSUE)
        task_id = self.seed_kanban_work(other)
        outbox_id = self.store.enqueue("status", {"issue_id": other, "state": "done", "task_id": task_id}, at=1)
        work, outbox = self.store.get(other), self.store.outbox_row(outbox_id)
        original = self.api.issue
        calls = 0
        def redirect(ref):
            nonlocal calls
            if ref == ISSUE:
                calls += 1
                if calls == (2 if second_lookup else 1): return original(other)
            return original(ref)
        self.api.issue = redirect
        now = [time.time()]
        self.bridge.clock = lambda: now[0]
        for _ in range(2 if second_lookup else 1):
            self.bridge.handle_webhook({"type": "Issue", "updatedFrom": {"delegateId": "other"},
                                        "data": {"id": ISSUE}})
            now[0] += 31  # Issue webhooks for one issue coalesce to one recheck per 30 s
        self.assertEqual(calls, 2 if second_lookup else 1)
        self.assertEqual(self.store.get(other), work)
        self.assertEqual(self.store.outbox_row(outbox_id), outbox)
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertFalse(self.store.scope_fenced(other))
        self.assertEqual(self.authority.mutations, [])

    def test_issue_webhook_first_lookup_redirect_preserves_other(self):
        self._assert_issue_webhook_redirect_preserves_other(False)

    def test_issue_webhook_second_lookup_redirect_preserves_other(self):
        self._assert_issue_webhook_redirect_preserves_other(True)

    def test_issue_webhook_scope_denial_precedes_any_existing_work_effect(self):
        task_id = self.seed_kanban_work()
        self.authority.issues[ISSUE] = issue_record(project={"id": "project-foreign"})
        self.bridge.handle_webhook({"type": "Issue", "updatedFrom": {"delegateId": "other"},
                                    "data": {"id": ISSUE}})
        self.assertEqual(self.kanban.creates, [])
        self.assertEqual(self.store.get(ISSUE)["owner_ref"], SESSION)
        self.assertTrue(self.store.scope_fenced(ISSUE))
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertEqual(self.authority.mutations, [])

    def test_persisted_fence_refuses_created_and_issue_events_even_if_scope_recovers(self):
        self.store.fence_scope(ISSUE, "permanent denial", at=1)
        self.bridge.handle_webhook(self.session_event())
        self.bridge.handle_webhook({"type": "Issue", "updatedFrom": {"delegateId": "other"},
                                    "data": {"id": ISSUE}})
        self.assertEqual(self.kanban.creates, [])
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.store.pending(), [])

        other = "issue-existing"
        self.authority.issues[other] = issue_record(id=other)
        self.seed_kanban_work(other)
        self.kanban.tasks["existing"] = SimpleNamespace(id="existing", status="ready")
        before = self.store.get(other)
        self.store.fence_scope(other, "permanent denial", at=1)
        self.bridge.handle_webhook({"type": "Issue", "updatedFrom": {"delegateId": "other"},
                                    "data": {"id": other}})
        self.assertEqual(self.store.get(other), before)
        self.assertEqual(self.store.pending(), [])

    def test_authorized_created_event_binds_one_native_task_without_claim(self):
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(len(self.kanban.creates), 1)
        self.assertEqual(self.kanban.tasks["task-1"].status, "ready")  # created ready
        self.assertEqual(self.store.get(ISSUE)["task_id"], "task-1")
        self.assertEqual([row["kind"] for row in self.store.pending(ISSUE)], ["activity"])

    def test_replayed_create_keeps_an_existing_human_block(self):
        self.bridge.handle_webhook(self.session_event())
        self.kanban.tasks["task-1"].status = "blocked"
        before = self.store.get(ISSUE)
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(self.kanban.tasks["task-1"].status, "blocked")
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(len(self.kanban.creates), 1)


    def test_fence_during_native_create_retains_task_without_reporting_adoption(self):
        create = self.kanban.create
        def fenced_create(**fields):
            task = create(**fields)
            self.store.fence_scope(ISSUE, "permanent denial", at=1)
            return task
        self.kanban.create = fenced_create
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(self.kanban.tasks["task-1"].status, "blocked")  # unbound: held before it can run
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.store.pending(), [])
        self.assertEqual(self.kanban.subscriptions, [])
        self.assertEqual(self.store.native_intent(f"create:{ISSUE}")["state"], "reconcile")


    def test_fence_at_binding_commit_retains_native_effect_for_reconciliation(self):
        bind = self.store.bind_native
        def fenced_bind(*args, **kwargs):
            self.store.fence_scope(ISSUE, "permanent denial", at=1)
            return bind(*args, **kwargs)
        self.store.bind_native = fenced_bind
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(len(self.kanban.creates), 1)
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.store.native_intent(f"create:{ISSUE}")["task_id"], "task-1")
        self.assertEqual(self.store.pending(), [])


    def test_fence_before_reporting_ack_preserves_native_binding_without_false_ack(self):
        enqueue = self.store.enqueue
        def fenced_enqueue(*args, **kwargs):
            self.store.fence_scope(ISSUE, "permanent denial", at=1)
            return enqueue(*args, **kwargs)
        self.store.enqueue = fenced_enqueue
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(self.kanban.tasks["task-1"].status, "ready")  # created ready
        self.assertIsNotNone(self.store.native_binding(ISSUE, "synthetic", "default"))
        self.assertEqual(self.store.pending(), [])


    def test_lost_native_create_response_reconciles_same_task_without_replay(self):
        create = self.kanban.create
        def lost(**fields):
            create(**fields)
            raise ConnectionError("native response lost")
        self.kanban.create = lost
        with self.assertRaises(ConnectionError):
            self.bridge.handle_webhook(self.session_event())
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.store.native_intent(f"create:{ISSUE}")["state"], "attempting")
        self.kanban.create = lambda **fields: self.fail("must inspect, not create again")
        restarted = Bridge(Store(self.store.path), self.api, self.kanban, profile="synthetic")
        restarted.handle_webhook(self.session_event())
        self.assertEqual(restarted.store.get(ISSUE)["task_id"], "task-1")
        self.assertEqual(len(self.kanban.creates), 1)


    def test_fenced_native_followup_never_unblocks_stopped_task(self):
        task_id = self.seed_kanban_work(task_status="blocked")
        row = self.store.get(ISSUE)
        self.store.fence_scope(ISSUE, "permanent denial", at=1)
        with self.assertRaises(LinearError):
            self.bridge.followup(ISSUE, "continue the investigation", "stable-request")
        self.assertEqual(self.kanban.tasks[task_id].status, "blocked")
        self.assertEqual(self.kanban.comments, [])
        self.assertEqual(self.store.get(ISSUE), row)


    def test_store_refuses_fenced_admissions_without_changing_prior_state(self):
        self.store.put(ISSUE, "chat", "owner", project_id=PROJECT)
        saved = self.store.get(ISSUE)
        pending_id = self.store.enqueue("comment", {"issue_id": ISSUE, "body": "saved"}, at=1)
        pending = self.store.outbox_row(pending_id)
        self.store.fence_scope(ISSUE, "permanent denial", at=2)
        self.assertFalse(self.store.put(ISSUE, "kanban", SESSION, task_id="task", project_id=PROJECT))
        with self.assertRaises(ValueError):
            self.store.update(ISSUE, owner_ref="changed", last_event_id=9)
        self.assertFalse(self.store.enqueue("status", {"issue_id": ISSUE, "state": "done"}, at=3))
        self.assertFalse(self.store.enqueue_once("comment", {"issue_id": ISSUE}, "marker", at=3))
        self.assertEqual(self.store.get(ISSUE), saved)
        self.assertEqual(self.store.outbox_row(pending_id), pending)
        self.assertEqual(len(self.store.pending()), 1)

    def test_batch_ack_refuses_all_rows_if_either_issue_is_fenced(self):
        other = "issue-other"
        self.store.fence_scope(other, "permanent denial", at=1)
        self.assertFalse(self.store.enqueue_many([
            ("activity", {"issue_id": ISSUE, "session_id": SESSION,
                          "content": {"type": "thought", "body": "On it"}}),
            ("status", {"issue_id": other, "state": "in_progress"})], at=2))
        self.assertEqual(self.store.pending(), [])

    def test_native_create_intent_is_durable_before_request_leaves_plugin(self):
        create = self.kanban.create
        def checked_create(**fields):
            intent = Store(self.store.path).native_intent(f"create:{ISSUE}")
            self.assertEqual(intent["state"], "attempting")
            self.assertEqual(intent["payload"]["external_key"], fields["idempotency_key"])
            self.assertIsNone(self.store.get(ISSUE))
            return create(**fields)
        self.kanban.create = checked_create
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(self.store.get(ISSUE)["origin"], "native")


    def test_restart_after_binding_keeps_native_task_and_never_recreates(self):
        settle = self.store.native_intent_settle
        def crash(*args, **kwargs):
            raise SystemExit("after native binding commit")
        self.store.native_intent_settle = crash
        with self.assertRaises(SystemExit):
            self.bridge.handle_webhook(self.session_event())
        self.assertIsNotNone(self.store.get(ISSUE))
        self.store.native_intent_settle = settle
        restarted = Bridge(Store(self.store.path), self.api, self.kanban, profile="synthetic")
        restarted.handle_webhook(self.session_event())
        self.assertEqual(len(self.kanban.creates), 1)
        self.assertEqual(restarted.store.get(ISSUE)["task_id"], "task-1")


    def test_fence_preserves_pending_and_uncertain_outbox_maintenance(self):
        task_id = self.seed_kanban_work()
        pending_id = self.store.enqueue("comment", {"issue_id": ISSUE, "body": "pending", "task_id": task_id}, at=1)
        failed_id = self.store.enqueue("status", {"issue_id": ISSUE, "state": "blocked", "task_id": task_id}, at=1)
        self.store.retry(self.store.outbox_row(failed_id), 2)
        self.store.mark(failed_id, "failed")
        before = {ident: self.store.outbox_row(ident) for ident in (pending_id, failed_id)}
        self.store.fence_scope(ISSUE, "permanent denial", at=3)
        self.store.mark(pending_id, "failed")
        self.store.mark_sent(pending_id, True)
        self.store.defer(pending_id, 20)
        self.store.retry(before[pending_id], 20)
        self.store.report(pending_id)
        self.store.rewrite(pending_id, {"issue_id": ISSUE, "body": "changed"}, 20)
        self.store.drop(pending_id)
        self.assertEqual(self.store.revive_failed(20), 0)
        for ident, row in before.items():
            self.assertEqual(self.store.outbox_row(ident), row)

    def test_bridge_effect_helpers_refuse_fence_between_resolution_and_commit(self):
        for name, invoke, method in (
            ("status", lambda ident: self.bridge.status(ident, "in_progress"), "enqueue"),
            ("comment", lambda ident: self.bridge.comment(ident, "body"), "enqueue"),
            ("activity", lambda ident: self.bridge.activity(ident, SESSION, "response", "body"), "enqueue"),
            ("project", lambda ident: self.bridge.project_update(SESSION, PROJECT, ident, "line", issue_id=ident),
             "queue_project_update"),
        ):
            ident = f"issue-{name}"
            self.authority.issues[ident] = issue_record(id=ident)
            original = getattr(self.store, method)
            def fence_then_write(*args, **kwargs):
                self.store.fence_scope(ident, "permanent denial", at=1)
                return original(*args, **kwargs)
            setattr(self.store, method, fence_then_write)
            try:
                with self.subTest(effect=name):
                    self.assertFalse(invoke(ident))
                    self.assertEqual(self.store.pending(), [])
            finally:
                setattr(self.store, method, original)

    def test_project_update_merge_refuses_fence_on_either_issue(self):
        second = "issue-second"
        first = {"issue_id": "update:session:project", "session_id": SESSION, "project_id": PROJECT,
                 "resolve": ISSUE, "lines": {"OPS-1": "first"}, "line_issues": {"OPS-1": ISSUE}, "task_id": "task-first"}
        next_line = {**first, "resolve": second, "lines": {"OPS-2": "second"},
                     "line_issues": {"OPS-2": second}}
        for fenced in (ISSUE, second):
            with self.subTest(fenced=fenced):
                path = Path(self.tmp.name) / f"{fenced}.db"
                store = Store(path)
                store.bind_native(ISSUE, "task-first", "synthetic", "default", owner_ref=SESSION, at=0)
                store.bind_native(second, "task-second", "synthetic", "default", owner_ref=SESSION, at=0)
                self.assertTrue(store.queue_project_update(first, due=1, quiet=True))
                before = store.project_update(SESSION, PROJECT)
                store.fence_scope(fenced, "permanent denial", at=2)
                self.assertFalse(store.queue_project_update(next_line, due=3, quiet=True))
                self.assertEqual(store.project_update(SESSION, PROJECT), before)

    def test_nonmergeable_fenced_aggregate_does_not_refuse_allowed_noop(self):
        other = "issue-other"
        task_id = self.seed_kanban_work()
        self.seed_kanban_work(other)
        payload = {"issue_id": "update:session:project", "session_id": SESSION,
                   "project_id": PROJECT, "resolve": ISSUE, "lines": {"OPS-1": "prior"},
                   "line_issues": {"OPS-1": ISSUE}, "task_id": task_id}
        self.store.queue_project_update(payload, due=1, quiet=True)
        row = self.store.project_update(SESSION, PROJECT)
        self.store.mark_sent(row["id"], True)
        before = self.store.project_update(SESSION, PROJECT)
        self.store.fence_scope(ISSUE, "permanent denial", at=2)
        next_line = {**payload, "resolve": other, "lines": {"OPS-2": "new"},
                     "line_issues": {"OPS-2": other}}
        self.assertTrue(self.store.queue_project_update(next_line, due=3, quiet=True))
        self.assertEqual(self.store.project_update(SESSION, PROJECT), before)

    def test_failed_alert_does_not_repeat_after_fence(self):
        task_id = self.seed_kanban_work()
        row_id = self.store.enqueue("comment", {"issue_id": ISSUE, "body": "uncertain", "task_id": task_id}, at=1)
        self.store.mark(row_id, "failed")
        before = self.store.outbox_row(row_id)
        self.store.fence_scope(ISSUE, "permanent denial", at=2)
        self.bridge.flush()
        self.bridge.flush()
        self.assertEqual(self.kanban.comments, [])
        self.assertEqual(self.store.outbox_row(row_id), before)

    def test_mismatched_task_report_is_held_without_laundering_current_requester(self):
        task_id = self.seed_kanban_work()
        old = self.store.enqueue("comment", {"issue_id": ISSUE, "body": "Earlier task result",
            "task_id": "unverified-other-task", "requester_sessions": {ISSUE: SESSION}}, at=1)
        before = self.store.outbox_row(old)
        self.assertEqual(self.bridge.flush(), 0)
        held = self.store.outbox_row(old)
        self.assertTrue(held["hold_reason"])
        self.assertEqual({key: value for key, value in held.items() if key != "hold_reason"},
                         {key: value for key, value in before.items() if key != "hold_reason"})
        self.assertEqual(self.authority.mutations, [])
        current = self.bridge.comment(ISSUE, "Current verified native result")
        self.assertEqual(self.store.outbox_row(current)["payload"]["task_id"], task_id)
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.store.outbox_row(current)["state"], "sent")
        self.assertIsNone(self.store.outbox_row(current)["hold_reason"])
        self.assertEqual(self.store.outbox_row(old), held)
        self.assertEqual(len(self.authority.mutations), 1)

    def test_outbox_effect_releases_writer_after_atomic_admission(self):
        row_id = self.store.enqueue("comment", {"issue_id": ISSUE, "body": "saved",
            "content_action": True, "unlinked_content": True}, at=1)
        began, finished = threading.Event(), threading.Event()
        worker = None
        transport = self.api.transport
        def send(url, body, headers):
            nonlocal worker
            if json.loads(body)["query"].lstrip().startswith("mutation"):
                def fence():
                    began.set()
                    self.store.fence_scope(ISSUE, "permanent denial", at=2)
                    finished.set()
                worker = threading.Thread(target=fence)
                worker.start()
                self.assertTrue(began.wait(1))
                self.assertTrue(finished.wait(2), "fence waited for remote transport after admission")
            return transport(url, body, headers)
        self.api.transport = send
        self.bridge.flush()
        worker.join(2)
        self.assertTrue(finished.is_set())
        self.assertEqual(len(self.authority.mutations), 1)
        self.assertIn(self.store.outbox_row(row_id)["state"], ("pending", "sent"))
        self.assertTrue(self.store.scope_fenced(ISSUE))

    def test_outbox_preflight_allows_fence_before_remote_mutation(self):
        task_id = self.seed_kanban_work()
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        row_id = self.store.enqueue("comment", {"issue_id": ISSUE, "body": "saved", "task_id": task_id}, at=1)
        original_issue, reads = self.api.issue, 0
        def issue(ident):
            nonlocal reads
            reads += 1
            if reads == 2:
                worker = threading.Thread(target=lambda: self.store.fence_scope(
                    ISSUE, "permanent denial", at=2))
                worker.start()
                worker.join(2)
                self.assertFalse(worker.is_alive(), "preflight held a write transaction")
            return original_issue(ident)
        self.api.issue = issue
        self.assertEqual(self.bridge.flush(), 0)
        self.assertEqual(self.authority.mutations, [])
        self.assertEqual(self.store.outbox_row(row_id)["state"], "pending")

    def test_project_update_resource_rechecks_do_not_delay_fence(self):
        other = "issue-second"
        task_id = self.seed_kanban_work()
        self.seed_kanban_work(other)
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.authority.issues[other] = issue_record(id=other, identifier="OPS-2", delegate={"id": VIEWER})
        payload = {"issue_id": "update:session:project", "session_id": SESSION,
                   "project_id": PROJECT, "resolve": ISSUE,
                   "lines": {"OPS-1": "first", "OPS-2": "second"},
                   "line_issues": {"OPS-1": ISSUE, "OPS-2": other}, "task_id": task_id}
        self.assertTrue(self.store.queue_project_update(payload, due=1, quiet=False))
        row = self.store.project_update(SESSION, PROJECT)
        original, completed_during_recheck = self.api._mutation_issue, []
        worker = None
        def recheck(ident):
            nonlocal worker
            if worker is None:
                worker = threading.Thread(target=lambda: self.store.fence_scope(
                    other, "permanent denial", at=2))
                worker.start()
                worker.join(0.1)
                completed_during_recheck.append(not worker.is_alive())
            return original(ident)
        self.api._mutation_issue = recheck
        self.bridge.flush()
        worker.join(2)
        self.assertEqual(completed_during_recheck, [True])
        self.assertTrue(self.store.scope_fenced(other))
        self.assertEqual(self.store.outbox_row(row["id"])["state"], "pending")
        self.assertEqual(self.authority.mutations, [])

    def test_stop_refuses_task_block_when_fence_precedes_work_update(self):
        task_id = self.seed_kanban_work()
        row = self.store.get(ISSUE)
        before = self.store.get(ISSUE)
        update = self.store.update
        def fence_then_update(*args, **kwargs):
            self.store.fence_scope(ISSUE, "permanent denial", at=2)
            return update(*args, **kwargs)
        self.store.update = fence_then_update
        self.bridge._stop(row, SESSION, "requester", 3)
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.store.pending(), [])

    def test_recovery_preserves_legacy_records_without_prompt_injection(self):
        self.store.put(ISSUE, "chat", "legacy-owner")
        before = self.store.get(ISSUE)
        self.store.fence_scope(ISSUE, "permanent denial", at=2)
        self.bridge.recover()
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertFalse(hasattr(self.bridge, "inject"))
        self.assertEqual(self.kanban.comments, [])
        self.assertEqual(self.kanban.creates, [])


    def test_fenced_aggregate_blocks_terminal_merge_and_quiet_shift(self):
        other = "issue-prior"
        task_id = self.seed_kanban_work()
        self.seed_kanban_work(other)
        payload = {"issue_id": "update:session:project", "session_id": SESSION,
                   "project_id": PROJECT, "resolve": other, "lines": {"OPS-2": "prior"},
                   "line_issues": {"OPS-2": other}, "task_id": f"task-{other}"}
        self.store.queue_project_update(payload, due=2, quiet=True)
        before_work = self.store.get(ISSUE)
        before_update = self.store.project_update(SESSION, PROJECT)
        self.store.fence_scope(other, "permanent denial", at=3)
        self.assertFalse(self.store.finish(ISSUE, [
            ("status", {"issue_id": ISSUE, "state": "done", "task_id": task_id}),
            ("project_update", {**payload, "resolve": ISSUE, "task_id": task_id, "lines": {"OPS-1": "done"},
                                "line_issues": {"OPS-1": ISSUE}})], at=4))
        self.store.delay_session_updates(SESSION, 50)
        self.assertEqual(self.store.get(ISSUE), before_work)
        self.assertEqual(self.store.project_update(SESSION, PROJECT), before_update)

    def test_fence_between_content_authorization_and_enqueue_preserves_history(self):
        from hermes_fleet_linear_plugin import chat
        self.store.put(ISSUE, "chat", "legacy-owner")
        before = self.store.get(ISSUE)
        enqueue = self.store.enqueue
        def fenced_enqueue(*args, **kwargs):
            self.store.fence_scope(ISSUE, "permanent denial", at=1)
            return enqueue(*args, **kwargs)
        self.store.enqueue = fenced_enqueue
        reply = json.loads(chat.handle(self.bridge, {"action": "add_comment", "issue": ISSUE,
            "id": str(uuid.uuid4()), "body": "reviewed evidence"}, self.context()))
        self.assertFalse(reply["ok"])
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.store.pending(), [])


    def test_chat_action_scope_denial_happens_before_store_or_external_effect(self):
        from hermes_fleet_linear_plugin import chat

        self.authority.issues[ISSUE] = issue_record(creator={"id": "user-foreign"})
        context = self.context()
        result = json.loads(chat.handle(self.bridge, {"action": "status", "issue": ISSUE}, context))
        self.assertFalse(result["ok"])
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.authority.mutations, [])
        self.assertEqual(self.kanban.creates, [])

    def test_persisted_fence_holds_effects_but_authorized_status_preserves_history(self):
        from hermes_fleet_linear_plugin import chat
        context = self.context()
        for action in ("status", "track", "followup", "add_comment", "update_description"):
            with self.subTest(action=action):
                issue_id = f"{ISSUE}-{action}"
                self.authority.issues[issue_id] = issue_record(id=issue_id)
                self.store.put(issue_id, "chat", "legacy-owner", project_id=PROJECT)
                before = self.store.get(issue_id)
                self.store.fence_scope(issue_id, "permanent denial", at=1.0)
                pending = self.store.pending()
                reply = json.loads(chat.handle(self.bridge, {
                    "action": action, "issue": issue_id, "task_id": "existing-task",
                    "id": str(uuid.uuid4()), "body": "Verified finding", "description": "Updated evidence",
                    "expected_description": "Synthetic issue body"}, context))
                if action == "status":
                    self.assertTrue(reply["ok"], reply)
                    self.assertTrue(reply["native"]["effects_held"])
                else:
                    self.assertFalse(reply["ok"])
                self.assertTrue(self.store.scope_fenced(issue_id))
                self.assertEqual(self.store.get(issue_id), before)
                self.assertEqual(self.store.pending(), pending)
                self.assertEqual(self.authority.mutations, [])

    def test_unlinked_content_rechecks_scope_at_delivery_without_worker_claim(self):
        from hermes_fleet_linear_plugin import chat
        reply = json.loads(chat.handle(self.bridge, {"action": "add_comment", "issue": ISSUE,
            "id": str(uuid.uuid4()), "body": "verified result"}, self.context()))
        self.assertTrue(reply["ok"])
        self.authority.issues[ISSUE] = issue_record(project={"id": "foreign-project"})
        self.assertEqual(self.bridge.flush(), 0)
        self.assertTrue(self.store.scope_fenced(ISSUE))
        self.assertIsNone(self.store.get(ISSUE))
        self.assertEqual(self.authority.mutations, [])


    def test_kanban_closeout_rechecks_scope_after_evidence_verification(self):
        # The scope moves while the closing note's evidence is read (PR state, F28): still fenced.
        from hermes_fleet_linear_plugin import bridge as bridge_module
        for accepted in (True, False):
            with self.subTest(evidence_accepted=accepted):
                issue_id = f"{ISSUE}-{accepted}"
                self.authority.issues[issue_id] = issue_record(id=issue_id)
                task = SimpleNamespace(id="task", status="ready", completion_contract="https://docs.example/findings/1", result="Done", title="OPS-1: task", current_run_id=1, assignee="synthetic")
                self.kanban.tasks[task.id] = task
                self.bridge.track(issue_id, task.id, requester_session=SESSION)
                task.status = "done"
                self.kanban.record_completion(task, 1)
                before = self.store.get(issue_id)
                def evidence_checked(_links):
                    self.authority.issues[issue_id] = issue_record(id=issue_id, project={"id": "project-foreign"})
                    return "\n\nPull request: https://github.com/acme/app/pull/1 (merged)" if accepted else ""
                with patch.object(bridge_module, "_pr_lines", evidence_checked):
                    self.bridge._finished(before)
                self.assertTrue(self.store.scope_fenced(issue_id))
                self.assertEqual(self.store.get(issue_id), before)
                self.assertEqual(self.store.pending(issue_id), [])
                self.assertEqual(self.authority.mutations, [])

    def test_history_capture_refuses_persisted_fence_atomically(self):
        issue_id = ISSUE
        self.store.bind_native(issue_id, "task", "synthetic", "default", owner_ref=SESSION, project_id=PROJECT, at=0)
        self.store.enqueue("comment", {"issue_id": issue_id, "body": "preserved", "task_id": "task"}, at=1)
        before, pending = self.store.get(issue_id), self.store.pending(issue_id)
        self.store.fence_scope(issue_id, "permanent denial", at=1.0)
        self.assertFalse(self.store.capture_event(issue_id, 2, [("status", {"issue_id": issue_id, "state": "done"})], at=2.0))
        self.assertEqual(self.store.get(issue_id), before)
        self.assertEqual(self.store.pending(issue_id), pending)

    def test_terminal_capture_refuses_persisted_fence_atomically(self):
        self.store.put(ISSUE, "chat", "owner", project_id=PROJECT)
        before = self.store.get(ISSUE)
        self.store.fence_scope(ISSUE, "permanent denial", at=1.0)
        self.assertFalse(self.store.finish(ISSUE, [("status", {"issue_id": ISSUE, "state": "done"})], at=2.0))
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.store.pending(), [])

    def test_pump_fences_permanently_revoked_authoritative_scope_before_history_admission(self):
        changes = (
            ("team", {"team": {"id": "team-foreign", "key": "NO", "states": {"nodes": []}}}),
            ("project", {"project": {"id": "project-foreign"}}),
            ("requester", {"creator": {"id": "user-foreign"}}),
        )
        for suffix, (field, change) in enumerate(changes, start=1):
            issue_id, task_id = f"{ISSUE}-{suffix}", f"task-{suffix}"
            self.authority.issues[issue_id] = issue_record(id=issue_id, **change)
            self.kanban.tasks[task_id] = SimpleNamespace(id=task_id, status="blocked",
                                                         completion_contract=None, result="", title="OPS-1: task", current_run_id=None, assignee="synthetic")
            self.kanban.histories[task_id] = [SimpleNamespace(id=1, kind="blocked",
                                                              payload={"reason": "needs input"})]
            self.store.bind_native(issue_id, task_id, "synthetic", "default", owner_ref=SESSION, project_id=PROJECT, at=0)

        self.bridge.pump_kanban()

        for suffix, (field, _change) in enumerate(changes, start=1):
            issue_id = f"{ISSUE}-{suffix}"
            with self.subTest(authoritative_field=field):
                self.assertIsNotNone(self.store.get(issue_id), "revoked work and its history must be preserved")
                self.assertEqual(self.store.get(issue_id)["last_event_id"], 0,
                                 "a denied effect must not advance the Kanban cursor")
                self.assertEqual(self.store.pending(issue_id), [], "denied activity/status must not enter the outbox")

    def test_tick_keeps_pending_and_uncertain_writes_untouched_after_revocation_and_restart(self):
        task_id = self.seed_kanban_work(task_status="blocked", events=[SimpleNamespace(
            id=1, kind="blocked", payload={"reason": "needs input"})])
        status_id = self.store.enqueue("status", {"issue_id": ISSUE, "state": "done", "task_id": task_id}, at=1)
        comment_id = self.store.enqueue("comment", {"issue_id": ISSUE, "body": "saved evidence", "task_id": task_id}, at=1)
        activity_id = self.store.enqueue("activity", {"issue_id": ISSUE, "session_id": SESSION, "task_id": task_id,
                                                       "content": {"type": "response", "body": "saved"}}, at=1)
        project_id = self.store.enqueue("project_update", {"issue_id": "update:session:project",
                                                            "resolve": ISSUE, "project_id": PROJECT, "task_id": task_id,
                                                            "lines": {"OPS-1": "Done"},
                                                            "line_issues": {"OPS-1": ISSUE}}, at=1)
        frozen_payload = self.store.outbox_row(project_id)["payload"]
        self.assertTrue(self.store.freeze_project_update(project_id, frozen_payload, self.bridge.clock(),
                                                         "Agent update\n\n- OPS-1: Done", PROJECT))
        original = {row_id: self.store.outbox_row(row_id) for row_id in
                    (status_id, comment_id, activity_id, project_id)}
        self.authority.issues[ISSUE] = issue_record(project={"id": "project-foreign"})

        self.bridge.tick()

        self.assertEqual(self.authority.mutations, [], "revocation must prevent every Linear mutation")
        self.assertIsNotNone(self.store.get(ISSUE), "the active task must not be deleted by recheck")
        self.assertEqual(self.store.get(ISSUE)["last_event_id"], 0)
        self.assertEqual(self.kanban.event_calls, [], "scope must be checked before Kanban event admission")
        for row_id, before in original.items():
            after = self.store.outbox_row(row_id)
            self.assertEqual(after, before, "pending and uncertain outbox rows must remain byte-for-byte intact")

        restarted_store = Store(self.store.path)
        restarted = Bridge(restarted_store, self.api, self.kanban, profile="synthetic")
        self.authority.issues[ISSUE] = issue_record(creator={"id": "user-foreign"})
        restarted.tick()
        self.assertEqual(self.authority.mutations, [])
        self.assertIsNotNone(restarted_store.get(ISSUE))
        self.assertEqual(restarted_store.get(ISSUE)["last_event_id"], 0)
        for row_id, before in original.items():
            self.assertEqual(restarted_store.outbox_row(row_id), before)

    def test_transient_scope_resolution_failure_retries_without_permanent_fence(self):
        self.seed_kanban_work(task_status="blocked", events=[SimpleNamespace(id=1, kind="blocked",
                                                       payload={"reason": "needs input"})])
        self.authority.fail_issue = True

        self.bridge.pump_kanban()

        self.assertIsNotNone(self.store.get(ISSUE))
        self.assertEqual(self.store.get(ISSUE)["last_event_id"], 0)
        self.assertEqual(self.store.pending(ISSUE), [])
        self.authority.fail_issue = False
        self.bridge.pump_kanban()  # the refusal waits on its persisted backoff, not the next 2 s tick
        self.assertEqual(self.store.get(ISSUE)["last_event_id"], 0)
        later = self.bridge.clock() + 60
        self.bridge.clock = lambda: later
        self.bridge.pump_kanban()
        self.assertEqual(self.store.get(ISSUE)["last_event_id"], 1)
        # The blocker sentence is captured with the event; the state is reconciled after the batch
        # and delivered first (the sentence waits on it).
        rows = self.store.pending(ISSUE)
        # The session's elicitation is the blocker's one thread record; no issue comment repeats it.
        self.assertEqual([row["kind"] for row in rows], ["activity", "status"])
        self.assertEqual(rows[0]["payload"]["content"]["type"], "elicitation")
        self.assertEqual(rows[0]["payload"]["requires_status_id"], rows[1]["id"])
        self.assertEqual(rows[0]["payload"]["native_progress_states"], ["blocked"])

    def test_all_specialist_effects_recheck_the_authoritative_resource_before_mutation(self):
        for name, action in (
            ("status", lambda: self.api.update_issue(ISSUE, {"stateId": "state-done"})),
            ("comment", lambda: self.api.create_comment("client-1", ISSUE, "body")),
            ("activity", lambda: self.api.create_activity("client-1", SESSION,
                                                           {"type": "response"}, issue_id=ISSUE)),
            ("project update", lambda: self.api.create_project_update("client-1", PROJECT, "body",
                                                                       issue_ids=[ISSUE])),
        ):
            self.authority.issues[ISSUE] = issue_record(project={"id": "project-foreign"})
            self.authority.sessions[SESSION] = {"id": SESSION, "issue": {"id": ISSUE}, "creator": {"id": USER}, "appUser": {"id": VIEWER}}
            before = len(self.authority.mutations)
            with self.subTest(effect=name), self.assertRaises(LinearError):
                action()
            self.assertEqual(len(self.authority.mutations), before)

    def test_mutations_fail_closed_when_identity_changes(self):
        self.authority.viewer = "viewer-foreign"
        with self.assertRaises(LinearError):
            self.api.create_comment("client-1", ISSUE, "body")
        self.assertEqual(self.authority.mutations, [])
        self.assertEqual(self.store.pending(), [])


class SessionRequesterTests(unittest.TestCase):
    session_event = LinearSpecialistAuthorizationTests.session_event

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.authority = Authority()
        self.authority.issues[ISSUE] = issue_record(creator={"id": "third-party"}, delegate={"id": VIEWER})
        self.authority.sessions[SESSION]["appUser"] = {"id": VIEWER}
        self.kanban = FakeKanban()
        self.store = Store(Path(self.tmp.name) / "state.db")
        self.api = self.authority.api(scope={**SCOPE, "requester_basis": "agent_session"})
        self.bridge = Bridge(self.store, self.api, self.kanban, profile="synthetic")

    def test_allowed_delegation_of_third_party_issue(self):
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(len(self.kanban.creates), 1)
        self.assertEqual(self.store.get(ISSUE)["owner_ref"], SESSION)
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertEqual(self.api.issue(ISSUE)["id"], ISSUE)

    def test_sessionless_work_never_adopts_a_new_session_in_agent_session_scope(self):
        # The owner session authorizes effects here, so a new session is never bound to work
        # started without one: today's behaviour (a plain response) is kept.
        self.kanban.tasks["task-1"] = SimpleNamespace(id="task-1", status="running", completion_contract=None, result="",
                                                      title="OPS-1: task", current_run_id=1, assignee="synthetic")
        self.kanban.histories["task-1"] = []
        self.store.bind_native(ISSUE, "task-1", "synthetic", "default", owner_ref="", project_id=PROJECT, at=0)
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(self.store.get(ISSUE)["owner_ref"], "")
        self.assertEqual(self.kanban.creates, [])
        kinds = [row["payload"]["content"]["type"] for row in self.store.pending(ISSUE) if row["kind"] == "activity"]
        self.assertNotIn("thought", kinds)
        self.assertEqual(kinds, ["response"])

    def test_recheck_human_takeover_preserves_native_worker_and_requester_binding(self):
        task_id = LinearSpecialistAuthorizationTests.seed_kanban_work(self)
        before = self.store.get(ISSUE)
        self.authority.issues[ISSUE]["delegate"] = {"id": "foreign"}
        self.bridge.recheck(force=True)
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertEqual(self.store.get(ISSUE)["owner_ref"], SESSION)
        self.authority.sessions[SESSION]["creator"] = {"id": "foreign"}
        reopened = Bridge(Store(self.store.path), self.authority.api(scope={**SCOPE, "requester_basis": "agent_session"}),
                          self.kanban, profile="synthetic")
        self.assertFalse(reopened.authorize_specialist_effect(ISSUE))
        self.assertEqual(self.authority.mutations, [])


    def test_assignment_change_before_native_request_prevents_task_creation(self):
        for after, closed in ((None, False), ("foreign", False), (VIEWER, True)):
            with self.subTest(after=after, closed=closed):
                self.setUp()
                original, reads = self.api.issue, []
                def changed(ref):
                    reads.append(ref)
                    if len(reads) == 3:
                        self.authority.issues[ISSUE]["delegate"] = {"id": after} if after else None
                        if closed:
                            self.authority.issues[ISSUE]["state"] = {"type": "completed"}
                    return original(ref)
                self.api.issue = changed
                self.bridge.handle_webhook(self.session_event())
                self.assertEqual(self.kanban.creates, [])
                self.assertIsNone(self.store.get(ISSUE))


    def test_recheck_outage_never_retires_native_worker_or_changes_binding(self):
        task_id = LinearSpecialistAuthorizationTests.seed_kanban_work(self)
        before = self.store.get(ISSUE)
        self.authority.fail_issue = True
        self.bridge.recheck(force=True)
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.kanban.tasks[task_id].status, "ready")
        self.assertEqual(self.store.pending(ISSUE), [])


    def test_later_human_unassignment_preserves_native_worker_without_reclaiming(self):
        self.bridge.handle_webhook(self.session_event())
        before = self.store.get(ISSUE)
        self.authority.issues[ISSUE]["updatedAt"] = "2026-01-01T00:00:02Z"
        self.authority.issues[ISSUE]["delegate"] = None
        self.bridge.flush()
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(self.kanban.tasks["task-1"].status, "ready")  # created ready
        self.assertFalse(any("issueUpdate" in query for query in self.authority.mutations))


    def test_worker_heartbeat_stays_ephemeral_and_only_checkpoint_becomes_human_comment(self):
        from types import SimpleNamespace
        self.bridge.handle_webhook(self.session_event())
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        row = self.store.get(ISSUE)
        setattr(self.kanban, "comment_text", lambda task_id, author, length, event_at: "Checked the Sydney stock file" if length == 29 else "")
        self.bridge._task_event(row, SimpleNamespace(id=9, kind="heartbeat", payload={"note": "Reading the stock report"}), "running", {})
        self.bridge._task_event(self.store.get(ISSUE), SimpleNamespace(id=10, kind="heartbeat", payload={}), "running", {})
        self.bridge._task_event(self.store.get(ISSUE), SimpleNamespace(
            id=11, kind="commented", payload={"author": "worker", "len": 29}, created_at=11), "running", {})
        self.assertFalse(any(item["payload"]["content"].get("body") == "Checked the Sydney stock file"
                             for item in self.store.pending() if item["kind"] == "activity"))
        self.bridge._task_event(self.store.get(ISSUE), SimpleNamespace(
            id=12, kind="checkpoint", payload={"body": "Checked the Sydney stock file",
                                                 "request_id": "stock-checkpoint-1"}, created_at=12),
            "running", {})
        actions = [item["payload"] for item in self.store.pending()
                   if item["kind"] == "activity" and item["payload"]["content"].get("type") == "action"]
        thoughts = [item["payload"]["content"].get("body") for item in self.store.pending()
                    if item["kind"] == "activity" and item["payload"]["content"].get("type") == "thought"]
        self.assertEqual(actions[-1]["content"], {"type": "action", "action": "Working", "parameter": "Reading the stock report"})
        self.assertTrue(actions[-1]["ephemeral"])
        self.assertEqual(len(actions), 1)
        # The checkpoint is one issue comment, not also a session thought.
        self.assertNotIn("Checked the Sydney stock file", thoughts)
        self.assertEqual([item["payload"]["body"] for item in self.store.pending() if item["kind"] == "comment"
                          and item["payload"].get("native_history_event_id") == 12], ["Checked the Sydney stock file"])

    def test_comment_resolver_uses_core_strip_contract_and_skips_bridge_authors(self):
        from types import SimpleNamespace
        from hermes_fleet_linear_plugin.bridge import resolve_comment_body
        stored = SimpleNamespace(author="worker", body="hello", created_at=20)
        earlier = SimpleNamespace(author="worker", body="ok", created_at=10)
        same_len = SimpleNamespace(author="worker", body="abcdef", created_at=10)
        self.assertEqual(resolve_comment_body([earlier, stored], "worker\n", len("hello\n"), event_at=20), "hello")
        self.assertEqual(resolve_comment_body([same_len, stored], "worker", len("hello\n"), event_at=20), "hello")
        self.assertEqual(resolve_comment_body([stored, SimpleNamespace(author="worker", body="hello", created_at=20)], "worker", len("hello"), event_at=20), "")
        self.assertEqual(resolve_comment_body([stored], "linear", len("hello"), event_at=20), "")
        marked = SimpleNamespace(author="linear:abc", body="Keep this instruction", created_at=20)
        self.assertEqual(resolve_comment_body([marked], "linear:abc", len("Keep this instruction"), event_at=20), "")

    def test_foreign_requester_cannot_use_allowed_author_or_poison_issue(self):
        self.authority.issues[ISSUE] = issue_record(delegate={"id": VIEWER})
        self.authority.sessions[SESSION]["creator"] = {"id": "foreign"}
        self.bridge.handle_webhook(self.session_event(creator="foreign"))
        self.assertEqual(self.kanban.creates, [])
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.authority.sessions[SESSION]["creator"] = {"id": USER}
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(len(self.kanban.creates), 1)

    def test_spoofed_creator_and_wrong_app_are_refused(self):
        for changes in ({"creator": {"id": "foreign"}}, {"appUser": {"id": "foreign-app"}},
                        {"creator": None}, {"creator": {"id": VIEWER}}, {"appUser": None}):
            with self.subTest(changes=changes):
                self.authority.sessions[SESSION] = {"id": SESSION, "issue": {"id": ISSUE},
                                                    "creator": {"id": USER}, "appUser": {"id": VIEWER}, **changes}
                self.bridge.handle_webhook(self.session_event())
                self.assertEqual(self.kanban.creates, [])
                self.assertEqual(self.authority.mutations, [])
                self.assertFalse(self.store.scope_fenced(ISSUE))

    def test_foreign_reply_does_not_revoke_allowed_work(self):
        self.bridge.handle_webhook(self.session_event())
        self.authority.activities[ACTIVITY]["user"] = {"id": "foreign"}
        before = self.store.get(ISSUE)
        self.bridge.handle_webhook(self.session_event("prompted", user="foreign"))
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertTrue(self.bridge.authorize_specialist_effect(ISSUE))

    def test_restart_rechecks_session_and_refuses_changed_requester(self):
        self.bridge.handle_webhook(self.session_event())
        self.authority.mutations.clear()
        reopened = Store(Path(self.tmp.name) / "state.db")
        api = self.authority.api(scope={**SCOPE, "requester_basis": "agent_session"})
        bridge = Bridge(reopened, api, self.kanban, profile="synthetic")
        self.assertTrue(bridge.authorize_specialist_effect(ISSUE))
        self.authority.sessions[SESSION]["creator"] = {"id": "foreign"}
        self.assertFalse(bridge.authorize_specialist_effect(ISSUE))
        with self.assertRaises(LinearError):
            api.create_comment("client", ISSUE, "must not send")
        self.assertEqual(self.authority.mutations, [])

    def test_allowed_mention_and_reply(self):
        # A mention-created session follows the same created event path, with no delegate.
        self.bridge.handle_webhook(self.session_event())
        self.kanban.unblock("task-1")  # Explicit native operator activation fixture.
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.bridge.handle_webhook(self.session_event("prompted"))
        self.assertEqual(len(self.kanban.creates), 1)
        self.assertTrue(self.kanban.comments)
        self.assertFalse(self.store.scope_fenced(ISSUE))

    def test_queued_effects_send_and_then_refuse_requester_revocation(self):
        self.bridge.handle_webhook(self.session_event())
        self.assertGreater(self.bridge.flush(), 0)
        self.assertTrue(self.authority.mutations)
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.bridge.comment(ISSUE, "Synthetic result")
        self.authority.sessions[SESSION]["creator"] = {"id": "foreign"}
        before = list(self.authority.mutations)
        self.bridge.flush()
        self.assertEqual(self.authority.mutations, before)
        self.assertTrue(self.store.scope_fenced(ISSUE))

    def test_transient_session_lookup_failure_is_not_permanent_denial(self):
        self.authority.fail_session = True
        with self.assertRaises(LinearError) as caught:
            self.bridge.handle_webhook(self.session_event())
        self.assertTrue(caught.exception.retryable)
        self.assertFalse(self.store.scope_fenced(ISSUE))
        self.authority.fail_session = False
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(len(self.kanban.creates), 1)

    def test_payload_issue_and_prompt_actor_spoofing_are_refused(self):
        self.bridge.handle_webhook(self.session_event(event_issue="foreign-issue"))
        self.assertEqual(self.kanban.creates, [])
        self.bridge.handle_webhook(self.session_event())
        before = list(self.kanban.comments)
        self.bridge.handle_webhook(self.session_event("prompted", user="foreign"))
        self.assertEqual(self.kanban.comments, before)
        self.assertFalse(self.store.scope_fenced(ISSUE))

    def test_all_teams_policy_keeps_requester_guard(self):
        self.api = self.authority.api(scope={"all_teams": True, "all_projects": True,
                                           "allowed_requester_ids": [USER], "requester_basis": "agent_session"})
        self.bridge = Bridge(self.store, self.api, self.kanban, profile="synthetic")
        self.authority.issues[ISSUE] = issue_record(team={"id": "new-team"}, project=None, creator=None, delegate={"id": VIEWER})
        self.bridge.handle_webhook(self.session_event())
        self.assertEqual(len(self.kanban.creates), 1)

    def test_requester_mode_validation_and_default_preservation(self):
        self.assertEqual(self.authority.api().specialist_scope, SCOPE)
        self.assertEqual(self.authority.api(scope={**SCOPE, "requester_basis": "issue_creator"}).specialist_scope, SCOPE)
        for value in (None, False, "user", [], {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.authority.api(scope={**SCOPE, "requester_basis": value})

    def test_terminal_effect_authority_survives_finish_and_restart(self):
        self.bridge.handle_webhook(self.session_event())
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.bridge.flush()
        task = self.kanban.tasks["task-1"]
        task.status, task.result = "done", "Synthetic result"
        self.kanban.evidence_text = lambda task: "https://example.test/findings"
        self.kanban.record_completion(task, 99)
        self.bridge._finished(self.store.get(ISSUE), event_id=99)
        self.assertIsNotNone(self.store.get(ISSUE))
        self.authority.mutations.clear()
        bridge = Bridge(Store(self.store.path), self.authority.api(scope={**SCOPE, "requester_basis": "agent_session"}),
                        self.kanban, profile="synthetic")
        self.assertGreater(bridge.flush(), 0)
        self.assertEqual(len(self.authority.mutations), 4)
        self.assertEqual(sum('commentCreate' in query for query in self.authority.mutations), 1)
        self.assertEqual(sum('agentActivityCreate' in query for query in self.authority.mutations), 1)
        comment = next(iter(self.authority.comment_records.values()))
        self.assertIsNone(comment['parent'])
        self.assertEqual(comment['user']['id'], VIEWER)
        self.assertIn('https://example.test/findings', comment['body'])
        self.assertLess(next(i for i, query in enumerate(self.authority.mutations) if 'commentCreate' in query),
                        next(i for i, query in enumerate(self.authority.mutations) if 'agentActivityCreate' in query))
        self.assertEqual(bridge.store.pending(), [])

    def test_401_retry_rechecks_requester(self):
        self.bridge.handle_webhook(self.session_event())
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.bridge.flush()
        self.authority.mutations.clear()
        original = self.api.transport
        attempts = []
        def provider(): return "synthetic"
        provider.invalidate = lambda: None
        self.api.token = provider
        def transport(url, body, headers):
            if json.loads(body)["query"].lstrip().startswith("mutation"):
                attempts.append(True)
                if len(attempts) == 1:
                    self.authority.sessions[SESSION]["creator"] = {"id": "foreign"}
                    return 401, {}, b"{}"
            return original(url, body, headers)
        self.api.transport = transport
        self.bridge.comment(ISSUE, "must not send after revocation")
        self.bridge.flush()
        self.assertEqual(len(attempts), 1)
        self.assertEqual(self.authority.mutations, [])

    def test_uncertain_followup_rechecks_actor_after_restart_without_blind_delivery(self):
        self.bridge.handle_webhook(self.session_event())
        self.kanban.unblock("task-1")  # Explicit native operator activation fixture.
        original = self.kanban.comment
        self.kanban.comment = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("uncertain delivery"))
        with self.assertRaises(RuntimeError):
            self.bridge.handle_webhook(self.session_event("prompted"))
        key = f"comment:{ISSUE}:{ACTIVITY}"
        self.assertEqual(self.store.native_intent(key)["state"], "attempting")
        self.kanban.comment = original
        self.authority.activities[ACTIVITY]["user"] = {"id": "foreign"}
        bridge = Bridge(Store(self.store.path), self.api, self.kanban, profile="synthetic")
        bridge.handle_webhook(self.session_event("prompted", user="foreign"))
        self.assertEqual(self.kanban.comments, [])
        self.assertEqual(bridge.store.native_intent(key)["state"], "attempting")
        self.assertFalse(bridge.store.scope_fenced(ISSUE))


    def test_direct_mutation_retry_rechecks_requester(self):
        self.bridge.handle_webhook(self.session_event())
        self.authority.mutations.clear()
        original = self.api.transport
        attempts = []
        def provider(): return "synthetic"
        provider.invalidate = lambda: None
        self.api.token = provider
        def transport(url, body, headers):
            if json.loads(body)["query"].lstrip().startswith("mutation"):
                attempts.append(True)
                self.authority.sessions[SESSION]["creator"] = {"id": "foreign"}
                return 401, {}, b"{}"
            return original(url, body, headers)
        self.api.transport = transport
        with self.assertRaises(LinearError):
            self.api.create_comment("direct", ISSUE, "must not send")
        self.assertEqual(len(attempts), 1)
        self.assertEqual(self.authority.mutations, [])

    def test_legacy_effect_cannot_borrow_current_session_authority(self):
        self.bridge.handle_webhook(self.session_event())
        self.bridge.flush()
        self.authority.mutations.clear()
        row_id = self.store.enqueue("comment", {"issue_id": ISSUE, "body": "unbound legacy write"}, at=0)
        self.bridge.flush()
        self.assertEqual(self.authority.mutations, [])
        held = self.store.outbox_row(row_id)
        self.assertEqual((held["state"], held["attempts"]), ("pending", 0))
        self.assertTrue(held["hold_reason"])
        self.assertNotIn("requester_sessions", held["payload"])
        self.assertNotIn("authorization_error", held["payload"])

    def test_terminal_effect_does_not_borrow_successor_session_authority(self):
        self.bridge.handle_webhook(self.session_event())
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.bridge.flush()
        task = self.kanban.tasks["task-1"]
        task.status = "done"
        self.kanban.evidence_text = lambda task: "https://example.test/findings"
        self.kanban.record_completion(task, 99)
        self.bridge._finished(self.store.get(ISSUE), event_id=99)
        self.authority.mutations.clear()
        other = "successor-session"
        self.authority.sessions[other] = {"id": other, "issue": {"id": ISSUE},
                                          "creator": {"id": USER}, "appUser": {"id": VIEWER}}
        self.api.requester_session_for_issue = lambda issue_id: other
        self.authority.sessions[SESSION]["creator"] = {"id": "foreign"}
        self.bridge.flush()
        self.assertEqual(self.authority.mutations, [])

    def test_saved_followups_keep_distinct_request_identities_without_owner_transfer(self):
        self.bridge.handle_webhook(self.session_event())
        self.kanban.unblock("task-1")  # Explicit native operator activation fixture.
        before = self.store.get(ISSUE)
        self.bridge.handle_webhook(self.session_event("prompted"))
        successor = "successor-session"
        self.authority.sessions[successor] = {"id": successor, "issue": {"id": ISSUE}, "creator": {"id": USER}, "appUser": {"id": VIEWER}}
        self.authority.activities["successor-activity"] = {"id": "successor-activity", "user": {"id": USER}, "agentSession": {"id": successor}}
        event = self.session_event("prompted")
        event["agentSession"]["id"], event["agentActivity"]["id"] = successor, "successor-activity"
        self.bridge.handle_webhook(event)
        self.assertEqual(len(self.kanban.comments), 2)
        self.assertEqual(self.store.get(ISSUE), before)
        for request in (ACTIVITY, "successor-activity"):
            self.assertEqual(self.store.native_intent(f"comment:{ISSUE}:{request}")["state"], "applied")


    def test_missing_activity_provenance_never_creates_native_followup(self):
        self.bridge.handle_webhook(self.session_event())
        event = self.session_event("prompted")
        event["agentActivity"].pop("id")
        self.bridge.handle_webhook(event)
        self.assertEqual(self.kanban.comments, [])
        self.assertFalse(self.store.scope_fenced(ISSUE))


    def test_direct_activity_target_retry(self):
        self.bridge.handle_webhook(self.session_event())
        self.authority.mutations.clear()
        other = 'other-session'
        self.authority.sessions[other] = {'id': other, 'issue': {'id': ISSUE}, 'creator': {'id': USER}, 'appUser': {'id': VIEWER}}
        original = self.api.transport
        attempts = []
        def provider(): return 'synthetic'
        provider.invalidate = lambda: None
        self.api.token = provider
        def transport(url, body, headers):
            query = json.loads(body)['query']
            if query.lstrip().startswith('mutation'):
                attempts.append(query)
                if len(attempts) == 1:
                    self.authority.sessions[other]['appUser'] = {'id': 'foreign-app'}
                    return 401, {}, b'{}'
            return original(url, body, headers)
        self.api.transport = transport
        with self.assertRaises(LinearError):
            self.api.create_activity('client', other, {'type': 'response', 'body': 'must not deliver'}, issue_id=ISSUE)
        self.assertEqual(self.authority.mutations, [])
        self.assertEqual(len(attempts), 1, 'must recheck actual target session after credential refresh')

    def test_direct_project_target_retry(self):
        self.api = self.authority.api(scope={'all_teams': True, 'all_projects': True, 'allowed_requester_ids': [USER], 'requester_basis': 'agent_session'})
        self.bridge = Bridge(self.store, self.api, self.kanban, profile='synthetic')
        self.bridge.handle_webhook(self.session_event())
        self.authority.mutations.clear()
        original = self.api.transport
        attempts = []
        def provider(): return 'synthetic'
        provider.invalidate = lambda: None
        self.api.token = provider
        def transport(url, body, headers):
            query = json.loads(body)['query']
            if query.lstrip().startswith('mutation'):
                attempts.append(query)
                if len(attempts) == 1:
                    self.authority.issues[ISSUE]['project'] = {'id': 'other-project'}
                    return 401, {}, b'{}'
            return original(url, body, headers)
        self.api.transport = transport
        with self.assertRaises(LinearError):
            self.api.create_project_update('client', PROJECT, 'must not deliver', issue_ids=[ISSUE])
        self.assertEqual(self.authority.mutations, [])
        self.assertEqual(len(attempts), 1, 'must recheck membership of actual target project after credential refresh')

    def test_native_binding_cannot_be_replaced_during_terminal_credentials(self):
        self.bridge.handle_webhook(self.session_event())
        task = self.kanban.tasks["task-1"]
        task.status, task.result = "done", "Verified synthetic result"
        self.kanban.record_completion(task, 2)
        self.bridge._finished(self.store.get(ISSUE), event_id=2)
        before = self.store.get(ISSUE)
        self.authority.mutations.clear()
        changed = []
        def provider():
            if getattr(self.api._graphql_permit, "issue_targets", ()) and not changed:
                changed.append(self.store.bind_native(ISSUE, "successor-task", "synthetic", "default", owner_ref=SESSION, at=2))
            return "synthetic"
        self.api.token = provider
        self.bridge.flush()
        self.assertEqual(changed, [False])
        self.assertEqual(self.store.get(ISSUE), before)


    def test_coalesced_project_update_cannot_replace_original_requester_binding(self):
        self.bridge.handle_webhook(self.session_event())
        self.bridge.project_update("shared-batch", PROJECT, "OPS-1", "original line", quiet=False, issue_id=ISSUE)
        with self.assertRaises(ValueError):
            self.store.update(ISSUE, owner_ref="successor-session")
        self.bridge.project_update("shared-batch", PROJECT, "OPS-RENAMED", "same worker line", quiet=False, issue_id=ISSUE)
        batches = [r["payload"] for r in self.store.pending() if r["kind"] == "project_update"]
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["requester_sessions"], {ISSUE: SESSION})
        self.authority.sessions[SESSION]["creator"] = {"id": "foreign"}
        self.authority.mutations.clear()
        self.bridge.flush()
        self.assertEqual(self.authority.mutations, [])



    def test_stopped_native_task_followup_never_resumes_or_creates_execution(self):
        self.bridge.handle_webhook(self.session_event())
        task = self.kanban.tasks["task-1"]
        task.status = "blocked"  # a native Stop paused it
        self.kanban.histories["task-1"] = [SimpleNamespace(id=1, kind="blocked", created_at=0,
                                                           payload={"reason": "linear: stopped"})]
        before = self.store.get(ISSUE)
        self.bridge.handle_webhook(self.session_event("prompted"))
        self.assertEqual(task.status, "blocked")
        self.assertEqual(len(self.kanban.comments), 1)
        self.assertEqual(self.store.get(ISSUE), before)
        self.assertEqual(len(self.kanban.creates), 1)


    def test_terminal_takeover_and_cancellation_rechecked_after_credentials_and_401(self):
        for boundary in ("credentials", "401"):
            for change in ("takeover", "cancel"):
                with self.subTest(boundary=boundary, change=change):
                    self.setUp()
                    self.bridge.handle_webhook(self.session_event())
                    self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
                    self.bridge.flush()
                    task = self.kanban.tasks["task-1"]
                    task.status = "done"
                    self.kanban.evidence_text = lambda task: "https://example.test/findings"
                    self.kanban.record_completion(task, 99)
                    self.bridge._finished(self.store.get(ISSUE), event_id=99)
                    self.authority.mutations.clear()
                    changed, attempts = [], []
                    def revoke():
                        changed.append(True)
                        if change == "takeover": self.authority.issues[ISSUE]["delegate"] = {"id": "foreign-human"}
                        else: self.authority.issues[ISSUE]["state"] = {"id": "canceled", "type": "canceled"}
                    def provider():
                        if boundary == "credentials" and getattr(self.api._graphql_permit, "issue_targets", ()) and not changed:
                            revoke()
                        return "synthetic"
                    provider.invalidate = lambda: None
                    original = self.api.transport
                    def transport(url, body, headers):
                        if json.loads(body)["query"].lstrip().startswith("mutation"):
                            attempts.append(True)
                            if boundary == "401" and not changed:
                                revoke()
                                return 401, {}, b"{}"
                        return original(url, body, headers)
                    self.api.token, self.api.transport = provider, transport
                    self.bridge.flush()
                    self.assertEqual(changed, [True])
                    self.assertEqual(len(attempts), int(boundary == "401"))
                    self.assertEqual(self.authority.mutations, [])
                    self.assertTrue(self.store.pending())

    def test_filtered_terminal_project_batch_at_takeover_and_cancel_boundaries(self):
        for boundary in ("before", "credentials", "401"):
            for change in ("takeover", "cancel"):
                with self.subTest(boundary=boundary, change=change):
                    self.setUp()
                    self.bridge.handle_webhook(self.session_event())
                    self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
                    self.bridge.flush()
                    other, session = "issue-second", "session-second"
                    self.authority.issues[other] = issue_record(id=other, identifier="OPS-2", delegate={"id": VIEWER})
                    self.authority.sessions[session] = {"id": session, "issue": {"id": other},
                                                       "creator": {"id": USER}, "appUser": {"id": VIEWER}}
                    self.store.bind_native(other, "second-task", "synthetic", "default", owner_ref=session, project_id=PROJECT, at=0)
                    self.kanban.tasks["second-task"] = SimpleNamespace(id="second-task", status="ready",
                        completion_contract=None, result="", title="OPS-2: second", current_run_id=None, assignee="synthetic")
                    task = self.kanban.tasks["task-1"]
                    task.status = "done"
                    self.kanban.evidence_text = lambda task: "https://example.test/findings"
                    self.kanban.record_completion(task, 99)
                    self.bridge._finished(self.store.get(ISSUE), event_id=99)
                    self.bridge.project_update("task-1", PROJECT, "OPS-2", "Progress", quiet=False, issue_id=other)
                    changed, accepted, attempts = [], [], []
                    def revoke():
                        changed.append(True)
                        if change == "takeover": self.authority.issues[other]["delegate"] = {"id": "foreign-human"}
                        else: self.authority.issues[other]["state"] = {"id": "canceled", "type": "canceled"}
                    def provider():
                        if boundary == "credentials" and getattr(self.api._graphql_permit, "target_project", None) and not changed:
                            revoke()
                        return "synthetic"
                    provider.invalidate = lambda: None
                    original = self.api.transport
                    def transport(url, body, headers):
                        request = json.loads(body)
                        if "projectUpdateCreate" in request["query"]:
                            attempts.append(request["variables"]["input"]["body"])
                            if boundary == "401" and not changed:
                                revoke()
                                return 401, {}, b"{}"
                            accepted.append(attempts[-1])
                        return original(url, body, headers)
                    self.api.token, self.api.transport = provider, transport
                    if boundary == "before": revoke()
                    self.bridge.flush()
                    self.assertEqual(changed, [True])
                    self.assertEqual(len(accepted), 1)
                    self.assertIn("OPS-1", accepted[0])
                    self.assertNotIn("OPS-2", accepted[0])
                    self.assertEqual(len(attempts), 2 if boundary == "401" else 1)
                    self.assertEqual(self.store.pending(), [])

    def test_project_thaw_requires_explicit_unsent_or_definite_rejection(self):
        self.bridge.handle_webhook(self.session_event())
        task_id = self.store.get(ISSUE)["task_id"]
        for marker, allowed in ((False, True), (True, False), (None, False)):
            payload = {"issue_id": "update:synthetic", "session_id": "batch", "project_id": PROJECT,
                       "resolve": ISSUE, "lines": {"OPS-1": "result"}, "line_issues": {"OPS-1": ISSUE}, "task_id": task_id,
                       "frozen": True}
            if marker is not None: payload["write_started"] = marker
            row_id = self.store.enqueue("project_update", payload, at=0)
            self.assertEqual(self.store.project_not_applied(row_id), allowed)
            if allowed:
                self.assertIs(self.store.outbox_row(row_id)["payload"]["frozen"], False)
            else:
                self.assertIs(self.store.outbox_row(row_id)["payload"]["frozen"], True)
        self.assertTrue(self.store.project_not_applied(row_id, known_rejection=True))
        self.assertIs(self.store.outbox_row(row_id)["payload"]["frozen"], True)

    def test_definite_401_refreezes_unsent_body_and_does_not_clear_started_marker(self):
        self.bridge.handle_webhook(self.session_event())
        task_id = self.store.get(ISSUE)["task_id"]
        unsent = {"issue_id": "update:synthetic", "session_id": "batch", "project_id": PROJECT,
                  "resolve": ISSUE, "lines": {"OPS-1": "result"}, "line_issues": {"OPS-1": ISSUE}, "task_id": task_id,
                  "frozen": True, "write_started": False, "send_body": "Agent update\n\n- OPS-1: result",
                  "send_project_id": PROJECT}
        row_id = self.store.enqueue("project_update", unsent, at=0)
        self.assertTrue(self.store.project_not_applied(row_id, known_rejection=True))
        kept = self.store.outbox_row(row_id)["payload"]
        self.assertIs(kept["frozen"], True)
        self.assertIs(kept["write_started"], False)
        self.assertEqual(kept["send_body"], unsent["send_body"])
        started = {**unsent, "write_started": True}
        started_id = self.store.enqueue("project_update", started, at=0)
        self.assertFalse(self.store.project_not_applied(started_id, known_rejection=True))
        still = self.store.outbox_row(started_id)["payload"]
        self.assertIs(still["write_started"], True)
        self.assertIs(still["frozen"], True)
        self.assertEqual(still["send_body"], started["send_body"])
        unfrozen = {**started, "frozen": False}
        open_id = self.store.enqueue("project_update", unfrozen, at=0)
        stored = self.store.outbox_row(open_id)
        self.assertIs(
            self.store.freeze_project_update(open_id, stored["payload"], stored["next_at"], "new body", PROJECT),
            False,
        )
        self.assertIs(self.store.outbox_row(open_id)["payload"]["write_started"], True)
        self.assertNotIn("new body", json.dumps(self.store.outbox_row(open_id)["payload"]))
        retried = {"issue_id": "update:synthetic", "session_id": "retry", "project_id": PROJECT,
                   "resolve": ISSUE, "lines": {"OPS-1": "later"}, "line_issues": {"OPS-1": ISSUE}, "task_id": task_id}
        retry_id = self.store.enqueue("project_update", retried, at=0)
        self.store.retry(self.store.outbox_row(retry_id), 0)
        due = self.store.outbox_row(retry_id)
        self.assertGreater(due["attempts"], 0)
        self.assertNotIn("write_started", due["payload"])
        self.assertTrue(self.store.freeze_project_update(retry_id, due["payload"], due["next_at"], "Agent update", PROJECT))

    def test_unbound_issue_does_not_gain_authority_from_author(self):
        self.authority.issues[ISSUE] = issue_record()
        with self.assertRaises(LinearError):
            self.api.issue(ISSUE)
        self.assertFalse(self.store.scope_fenced(ISSUE))

    def test_stored_session_cannot_redirect_issue(self):
        self.bridge.handle_webhook(self.session_event())
        self.authority.mutations.clear()
        self.authority.sessions[SESSION]["issue"] = {"id": "other-issue"}
        with self.assertRaises(LinearError):
            self.api.update_issue(ISSUE, {"stateId": "state-done"})
        self.assertEqual(self.authority.mutations, [])


class ActivityRequesterContextTests(unittest.TestCase):
    def setUp(self):
        self.authority = Authority()
        self.authority.sessions[SESSION]['creator'] = None
        self.authority.issues[ISSUE]['creator'] = {'id': 'unrelated-original-creator'}
        self.api = self.authority.api(scope={**SCOPE, 'requester_basis': 'agent_session'})

    def test_exact_activity_supports_reads_effects_and_fresh_revocation_without_rewriting_creator(self):
        with self.assertRaises(LinearError):
            self.api.agent_session(SESSION)
        with self.api.requester_session(SESSION, activity_id=ACTIVITY):
            self.assertIsNone(self.api.agent_session(SESSION)['creator'])
            self.assertEqual(self.api.issue(ISSUE)['id'], ISSUE)
            self.api.update_issue(ISSUE, {'stateId': 'state-progress'})
            self.authority.activities[ACTIVITY]['user'] = {'id': 'revoked'}
            self.authority.mutations.clear()
            with self.assertRaises(LinearError):
                self.api.update_issue(ISSUE, {'stateId': 'state-done'})
            self.assertEqual(self.authority.mutations, [])
        with self.assertRaises(LinearError):
            self.api.agent_session(SESSION)
        self.assertIsNone(self.authority.sessions[SESSION]['creator'])

    def test_issue_maps_pair_only_the_authoritative_session_issue_and_restore_outer_context(self):
        with self.api.requester_session({ISSUE: SESSION}, activity_id={ISSUE: ACTIVITY}):
            self.assertEqual(self.api.issue(ISSUE)['id'], ISSUE)
            with self.api.requester_session(SESSION):
                with self.assertRaises(LinearError):
                    self.api.agent_session(SESSION)
            self.assertEqual(self.api.issue(ISSUE)['id'], ISSUE)
        for sessions, activities in [({ISSUE: SESSION}, {'other': ACTIVITY}),
                                     (SESSION, ACTIVITY), ({ISSUE: SESSION}, {ISSUE: SESSION})]:
            if isinstance(sessions, str):
                with self.api.requester_session(sessions, activity_id=activities):
                    self.assertEqual(self.api.agent_session(SESSION)['id'], SESSION)
            else:
                with self.assertRaises(ValueError):
                    self.api.requester_session(sessions, activity_id=activities)
        with self.api.requester_session({'other': SESSION}, activity_id={'other': ACTIVITY}):
            with self.assertRaises(LinearError):
                self.api.agent_session(SESSION)

    def test_reporting_fallback_reuses_exact_activity_and_never_replaces_explicit_context(self):
        calls = []
        self.api.requester_session_for_issue = lambda issue: calls.append(("session", issue)) or SESSION
        self.api.requester_activity_for_issue = lambda issue: calls.append(("activity", issue)) or ACTIVITY
        self.assertEqual(self.api.issue(ISSUE)["id"], ISSUE)
        self.assertEqual(calls, [("session", ISSUE), ("activity", ISSUE)])
        calls.clear()
        for bound in ({}, {"other": SESSION}, SESSION, None):
            with self.subTest(bound=bound), self.api.requester_session(bound):
                with self.assertRaises(LinearError):
                    self.api.issue(ISSUE)
                self.assertEqual(calls, [])
        self.authority.activities[ACTIVITY]["user"] = {"id": "revoked"}
        with self.assertRaises(LinearError):
            self.api.update_issue(ISSUE, {"stateId": "state-done"})
        self.assertEqual(self.authority.mutations, [])
        self.assertIsNone(self.authority.sessions[SESSION]["creator"])

    def test_foreign_activity_session_bot_app_org_issue_and_scope_fail_without_mutations(self):
        changes = [lambda: self.authority.activities[ACTIVITY].update(user={'id': VIEWER}),
                   lambda: self.authority.activities[ACTIVITY].update(agentSession={'id': 'foreign'}),
                   lambda: self.authority.sessions[SESSION].update(appUser={'id': 'foreign'}),
                   lambda: setattr(self.authority, 'organization', 'foreign'),
                   lambda: self.authority.sessions[SESSION].update(issue={'id': 'foreign'}),
                   lambda: self.authority.issues[ISSUE].update(team={'id': 'foreign'})]
        for change in changes:
            self.setUp()
            change()
            with self.subTest(change=change), self.api.requester_session(SESSION, activity_id=ACTIVITY):
                with self.assertRaises(LinearError):
                    self.api.update_issue(ISSUE, {'stateId': 'state-done'})
                self.assertEqual(self.authority.mutations, [])


if __name__ == "__main__":
    unittest.main()
