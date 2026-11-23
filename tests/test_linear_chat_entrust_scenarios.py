"""Entrust from chat: real upstream Kanban, the registered chat handler and a synthetic Linear.

A longer outcome asked for in chat gets one native task through the same guarded admission a
Linear assignment uses, this app as delegate, Linear status that follows the work, and native
notifications back to the asking chat. Work already finished in chat is recorded as done with
its evidence and never runs. These backend scenarios do not claim a deployed chat round-trip.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from linear_fake_api import load_plugin

SOURCE = os.environ.get("HERMES_AGENT_SRC", "")
CORE = None
try:
    if not SOURCE:
        raise ImportError("HERMES_AGENT_SRC is not set")
    sys.path.insert(0, SOURCE)
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_notify as kbn
except Exception as exc:
    CORE = str(exc)

plugin = load_plugin()
from hermes_fleet_linear_plugin import chat, native_input
from hermes_fleet_linear_plugin.api import LinearError
from hermes_fleet_linear_plugin.bridge import Bridge, Kanban, _same_work_notice
from hermes_fleet_linear_plugin.store import Store
from hermes_fleet_linear_plugin.transport import NativeContext
from test_linear_specialist_authorization import Authority, ISSUE, TEAM, PROJECT, USER, VIEWER, issue_record

NEW_ISSUE = str(uuid.UUID(int=0x1234, version=4))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ChatAuthority(Authority):
    """Adds issue creation, team projects, delegate writes and recorded effects to the fixture."""

    def __init__(self):
        super().__init__()
        self.activity_records: list[dict] = []
        self.comment_bodies: list[tuple[str, str]] = []
        self.closeout_effects: list[tuple[str, str]] = []
        self.issues[ISSUE]["updatedAt"] = now_iso()

    def transport(self, url, body, headers):
        payload = json.loads(body)
        query, variables = payload["query"], payload.get("variables") or {}
        reply = lambda data: (200, {}, json.dumps({"data": data}).encode())
        if "query TeamProjects(" in query:
            self.requests.append(query)
            return reply({"team": {"id": variables["id"], "projects": {"nodes": [
                {"id": PROJECT, "name": "Fleet Rollout", "completedAt": None, "canceledAt": None, "archivedAt": None}]}}})
        if "query Team(" in query:
            self.requests.append(query)
            return reply({"team": {"id": TEAM, "key": "OPS"}})
        if "query Project(" in query:
            self.requests.append(query)
            return reply({"project": {"id": variables["id"], "archivedAt": None,
                                      "teams": {"nodes": [{"id": TEAM}], "pageInfo": {"hasNextPage": False}}}})
        if "query CreatedIssue(" in query:
            self.requests.append(query)
            return reply({"issue": self.issues.get(variables["id"])})
        if "issueCreate" in query:
            self.requests.append(query)
            self.mutations.append(query)
            fields = variables["input"]
            if fields["id"] not in self.issues:
                self.issues[fields["id"]] = issue_record(
                    id=fields["id"], identifier="OPS-2", title=fields["title"], url="https://linear.example/issue/OPS-2",
                    description=fields.get("description"), project={"id": fields.get("projectId")},
                    updatedAt=now_iso(), parent=None)
            return reply({"issueCreate": {"success": True}})
        if "agentActivityCreate" in query:
            self.activity_records.append(dict(variables["input"]))
            self.closeout_effects.append(("activity", variables["input"]["id"]))
        if "commentCreate" in query:
            self.comment_bodies.append((variables["input"]["issueId"], variables["input"]["body"]))
            self.closeout_effects.append(("comment", variables["input"]["id"]))
        if "issueUpdate" in query and "delegateId" in (variables.get("input") or {}):
            issue = self.issues[variables["id"]]
            before = (issue.get("delegate") or {}).get("id")
            issue["delegate"] = {"id": variables["input"]["delegateId"]}
            issue["updatedAt"] = now_iso()
            self.history.setdefault(issue["id"], []).append({
                "createdAt": issue["updatedAt"], "actorId": VIEWER, "fromStateId": issue["state"]["id"],
                "toStateId": issue["state"]["id"], "fromAssigneeId": None, "toAssigneeId": None,
                "fromDelegate": before and {"id": before}, "toDelegate": {"id": variables["input"]["delegateId"]}})
        if "issueUpdate" in query and "stateId" in (variables.get("input") or {}):
            self.issues[variables["id"]]["updatedAt"] = now_iso()
        return super().transport(url, body, headers)

    def state(self, issue_id: str) -> str:
        return self.issues[issue_id]["state"]["name"]


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class ChatEntrustScenarios(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="linear-chat-entrust-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("HERMES_KANBAN_") and key != "HERMES_DELEGATED_CHILD_CONTEXT"}
        environment.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home / "board"), HERMES_PROFILE="default")
        self.env = patch.dict(os.environ, environment, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.authority = ChatAuthority()
        self.board = Kanban(profile="default", profile_home=self.home)
        if not self.board.guarded_controls:
            self.skipTest("native host predates guarded admission")
        self.bridge = Bridge(Store(self.home / "linear.db"), self.authority.api(scope=None), self.board, profile="default")
        self.bridge.profile_home = self.home
        self.context = NativeContext(home=str(self.home), profile="default", platform="telegram", source="telegram",
                                     session_key="telegram:chat-1:thread-1", session_id="chat-session", user_id="human-1",
                                     chat_id="chat-1", chat_type="group", thread_id="thread-1", scope_id="workspace-1")

    # -- helpers ---------------------------------------------------------
    def ask(self, args, context=None):
        return json.loads(chat.handle(self.bridge, args, context or self.context))

    def create(self, **extra):
        return self.ask({"action": "create_issue", "id": NEW_ISSUE, "title": "Roll out the new proxy",
                         "team": TEAM, "project": "Fleet Rollout", "description": "Ship it and check it live.", **extra})

    def tasks(self):
        with self.board.conn() as conn:
            return [row["id"] for row in conn.execute("SELECT id FROM tasks")]

    def subs(self, task_id):
        with self.board.conn() as conn:
            return [dict(sub) for sub in kbn.list_notify_subs(conn, task_id)]

    def chat_events(self, task_id):
        from gateway.kanban_watchers_notifier import TERMINAL_KINDS
        with self.board.conn() as conn:
            _, events = kbn.unseen_events_for_sub(conn, task_id=task_id, platform="telegram", chat_id="chat-1",
                                                 thread_id="thread-1", kinds=TERMINAL_KINDS)
        return [event.kind for event in events]

    def history(self, task_id):
        return [event.kind for event in self.board.history(task_id, 0)]

    def flush(self):
        self.bridge.pump_kanban()
        self.bridge.flush()

    def session_event(self, issue_id, session_id, creator):
        self.authority.sessions[session_id] = {"id": session_id, "issue": {"id": issue_id},
                                               "creator": creator and {"id": creator}, "appUser": {"id": VIEWER}}
        stamp = time.time()
        session = {"id": session_id, "issue": {"id": issue_id}}
        if creator:
            session["creatorId"] = creator
        return {"type": "AgentSessionEvent", "action": "created",
                "createdAt": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                "webhookTimestamp": int(stamp * 1000), "agentSession": session}

    def echo(self, issue_id, session_id="echo-session"):
        """Linear opens an Agent Session for this app's own delegation: no human creator.

        Native-input mode, as native_input's receiver does it: a creator-null session projects to
        no conversation input and keeps the dispatcher path, which must accept it (True), or the
        provider delivery stays pending.
        """
        event = self.session_event(issue_id, session_id, None)
        self.assertIsNone(native_input.project_input(self.bridge, event))
        accepted = self.bridge.handle_webhook(event, assignment_prompt=native_input.ACTORLESS_COORDINATION)
        self.assertIs(accepted, True)
        return accepted

    def human_delegation(self, issue_id, session_id):
        """A person delegates the issue in Linear (legacy dispatcher path)."""
        return self.bridge.handle_webhook(self.session_event(issue_id, session_id, USER))

    def stop(self, issue_id, session_id="stop-session", activity_id="stop-activity"):
        """A person presses Stop in a Linear Agent Session on this issue."""
        self.authority.sessions[session_id] = {"id": session_id, "issue": {"id": issue_id},
                                               "creator": {"id": USER}, "appUser": {"id": VIEWER}}
        self.authority.activities[activity_id] = {"id": activity_id, "user": {"id": USER},
                                                  "agentSession": {"id": session_id}}
        stamp = time.time() + 1
        return self.bridge.handle_webhook({
            "type": "AgentSessionEvent", "action": "prompted",
            "createdAt": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
            "webhookTimestamp": int(stamp * 1000),
            "agentSession": {"id": session_id, "issue": {"id": issue_id}, "creatorId": USER},
            "agentActivity": {"id": activity_id, "signal": "stop", "user": {"id": USER}}})

    @staticmethod
    def later_iso():
        """A Linear updatedAt newer than any earlier one, as a non-routing edit (a comment) moves it."""
        time.sleep(0.002)
        return now_iso()

    def delegate_rows(self):
        with self.bridge.store._tx() as db:
            return [row[0] for row in db.execute("SELECT state FROM outbox WHERE kind='delegate' ORDER BY rowid")]

    def claim(self, task_id):
        with self.board.conn() as conn:
            self.assertIsNotNone(kb.claim_task(conn, task_id, claimer="native-test-worker"))

    # -- scenarios -------------------------------------------------------
    def test_chat_create_with_start_work_runs_one_task_as_delegate_and_reports_to_the_chat(self):
        reply = self.create(start_work=True)
        self.assertTrue(reply["ok"], reply)
        self.assertIn("Do not also do this work here", reply["message"])
        native = reply["native"]
        self.assertTrue(native["created_from_chat"])
        self.assertTrue(native["admitted"])
        self.assertTrue(native["chat_subscribed"])
        self.assertEqual(native["status"], "ready")  # admitted; the dispatcher claims it
        self.assertEqual(reply["routing"], "queued")
        self.assertEqual(self.tasks(), [native["task_id"]])
        task_id = native["task_id"]

        # The asking chat is a native notify subscriber (wake: one reply per update). The issue is
        # not: the bridge relays to it, and core's notifier cannot reply there without a session.
        subs = {(sub["platform"], sub["chat_id"]): sub for sub in self.subs(task_id)}
        self.assertEqual(subs[("telegram", "chat-1")]["thread_id"], "thread-1")
        self.assertEqual(subs[("telegram", "chat-1")]["delivery_mode"], "wake")
        self.assertEqual(set(subs), {("telegram", "chat-1")})
        self.assertEqual(self.chat_events(task_id), [])  # our own admission is not news for the chat

        # Delegate: this app, the human assignee untouched.
        self.flush()
        issue = self.authority.issues[NEW_ISSUE]
        self.assertEqual(issue["delegate"], {"id": VIEWER})
        self.assertIsNone(issue["assignee"])

        # A worker claims it: Linear shows In Progress.
        with self.board.conn() as conn:
            self.assertIsNotNone(kb.claim_task(conn, task_id, claimer="native-test-worker"))
        self.flush()
        self.assertEqual(self.authority.state(NEW_ISSUE), "In Progress")

        # A checkpoint reaches the asking chat through the native notifier.
        with self.board.conn() as conn:
            if "human_checkpoint" in __import__("inspect").signature(kb.add_comment).parameters:
                kb.add_comment(conn, task_id, "worker", "Proxy deployed to staging.",
                               human_checkpoint=True, request_id=str(uuid.uuid4()))
            else:
                with kb.write_txn(conn):
                    comment = kb.add_comment(conn, task_id, "worker", "Proxy deployed to staging.")
                    kb._append_event(conn, task_id, "checkpoint", {"author": "worker", "body": "Proxy deployed to staging.",
                                                                 "comment_id": comment, "request_id": str(uuid.uuid4())})
        self.assertIn("checkpoint", self.chat_events(task_id))

        # The webhook from our own delegation is the same work: acknowledged, no second task or run.
        before = self.board.get(task_id)
        self.echo(NEW_ISSUE)
        self.flush()
        after = self.board.get(task_id)
        self.assertEqual(self.tasks(), [task_id])
        self.assertEqual((before.status, before.current_run_id), (after.status, after.current_run_id))
        answers = [record for record in self.authority.activity_records if record["agentSessionId"] == "echo-session"]
        # The session now reports the work; the checkpoint is its one issue comment, not a session note.
        self.assertEqual([a["content"]["type"] for a in answers], ["thought"])  # a response would close it
        self.assertIn("Continuing the existing work on this issue, continued from chat", answers[0]["content"]["body"])
        self.assertEqual(self.issue_comments(NEW_ISSUE).count("Proxy deployed to staging."), 1)

    # -- HF-630: chat-started work adopts the Agent Session Linear opens for our delegate write --
    def said(self, session_id):
        return [record for record in self.authority.activity_records if record["agentSessionId"] == session_id]

    def issue_comments(self, issue_id):
        return [body for target, body in self.authority.comment_bodies if target == issue_id]

    def assert_normal_closeout(self, issue_id, task_id, session_id, prior_comments, summary):
        """A full top-level app result precedes the session's sole short pointer."""
        comments = self.issue_comments(issue_id)
        self.assertEqual(comments[:-1], prior_comments, 'No progress noise or duplicate closing comment')
        self.assertEqual(len(comments), len(prior_comments) + 1)
        self.assertIn(summary, comments[-1])
        receipts = [record for record in self.authority.comment_records.values()
                    if record['issue']['id'] == issue_id and record['body'] == comments[-1]]
        self.assertEqual(len(receipts), 1)
        receipt = receipts[0]
        self.assertIsNone(receipt['parent'])
        self.assertEqual(receipt['user']['id'], VIEWER)
        closing = self.bridge.store.outbox_row(receipt['id'])
        self.assertTrue(closing['payload']['native_outcome_comment'])
        self.assertEqual((closing['state'], closing['payload']['applied']), ('sent', 1))
        completion = closing['payload']['native_completion']
        self.assertEqual(completion['task_id'], task_id)
        completed = next(event for event in reversed(self.board.history(task_id, 0)) if event.kind == 'completed')
        self.assertEqual((completion['event_id'], completion['run_id']), (completed.id, completed.run_id))
        responses = [record for record in self.said(session_id) if record['content']['type'] == 'response']
        self.assertEqual(len(responses), 1)
        response = responses[0]
        self.assertEqual(response['content']['body'], 'Completed. The result and checks are in the issue comment.')
        self.assertNotEqual(response['content']['body'], receipt['body'])
        pointer = self.bridge.store.outbox_row(response['id'])
        self.assertTrue(pointer['payload']['native_outcome_pointer'])
        self.assertEqual(pointer['payload']['requires_comment_id'], receipt['id'])
        self.assertEqual(pointer['payload']['native_completion'], completion)
        self.assertEqual((pointer['state'], pointer['payload']['applied']), ('sent', 1))
        self.assertLess(self.authority.closeout_effects.index(('comment', receipt['id'])),
                        self.authority.closeout_effects.index(('activity', response['id'])))

    def native_event(self, task_id, kind, payload):
        with self.board.conn() as conn:
            with kb.write_txn(conn):
                kb._append_event(conn, task_id, kind, payload)

    def checkpoint(self, task_id, body):
        with self.board.conn() as conn:
            if "human_checkpoint" in __import__("inspect").signature(kb.add_comment).parameters:
                kb.add_comment(conn, task_id, "worker", body, human_checkpoint=True, request_id=str(uuid.uuid4()))
            else:
                with kb.write_txn(conn):
                    comment = kb.add_comment(conn, task_id, "worker", body)
                    kb._append_event(conn, task_id, "checkpoint", {"author": "worker", "body": body,
                                                                 "comment_id": comment, "request_id": str(uuid.uuid4())})

    def assert_reports_in_session(self, issue_id, task_id, session_id, *, done=True):
        """Live session activity stays intact; milestones and closeout also reach the issue."""
        comments = list(self.issue_comments(issue_id))
        self.claim(task_id)
        self.native_event(task_id, "spawned", {"pid": 4242})
        self.native_event(task_id, "heartbeat", {"note": "Reading the proxy config"})
        self.checkpoint(task_id, "Proxy deployed to staging.")
        self.flush()
        contents = [record["content"] for record in self.said(session_id)]
        self.assertIn(("action", "Started"), [(c["type"], c.get("action")) for c in contents])
        self.assertIn("Reading the proxy config", [c.get("parameter") for c in contents if c["type"] == "action"])
        self.assertTrue(any(r.get("ephemeral") for r in self.said(session_id) if r["content"].get("action") == "Working"))
        # The checkpoint is one issue comment (checked below), never repeated as a session thought.
        self.assertNotIn("Proxy deployed to staging.", [c.get("body") for c in contents])
        # The keepalive beats Linear's 30-minute stale mark on the adopted session.
        start = time.time()
        self.bridge.clock = lambda: start + 26 * 60
        self.bridge._recheck_row(self.bridge.store.get(issue_id))
        self.bridge.flush()
        self.assertIn("Still on this; nothing is needed from you",
                      [r["content"].get("parameter") for r in self.said(session_id) if r.get("ephemeral")])
        milestones = self.issue_comments(issue_id)[len(comments):]
        self.assertEqual(milestones.count("Proxy deployed to staging."), 1)
        # The start is the session's Started step only; the thread gets no fixed Started comment.
        self.assertFalse(any(c.startswith("Started") for c in milestones))
        self.assertFalse(any("Reading the proxy config" in c for c in milestones))
        comments = list(self.issue_comments(issue_id))  # Completion adds only its own full result.
        self.assertNotIn("response", [c["type"] for c in contents])
        if done:
            with self.board.conn() as conn:
                kb.complete_task(conn, task_id, summary="Proxy rolled out.", result="Proxy rolled out and checked live.")
            for _ in range(3):
                self.bridge.tick()
            responses = [r for r in self.said(session_id) if r["content"]["type"] == "response"]
            self.assertEqual(len(responses), 1)  # Done is the session's only response
            self.assertIs(responses[0], self.said(session_id)[-1])
            self.assertEqual(self.authority.state(issue_id), "Done")
            self.assert_normal_closeout(issue_id, task_id, session_id, comments, "Proxy rolled out.")

    def test_hf630_chat_work_adopts_the_echo_session_and_reports_there(self):
        reply = self.create(start_work=True)
        task_id = reply["native"]["task_id"]
        self.flush()  # our delegate write lands; Linear opens a session for it
        self.assertEqual(self.bridge.store.get(NEW_ISSUE)["owner_ref"], "")
        self.echo(NEW_ISSUE, "echo-session")
        self.flush()
        self.assertEqual(self.bridge.store.get(NEW_ISSUE)["owner_ref"], "echo-session")
        answers = self.said("echo-session")
        self.assertEqual([a["content"]["type"] for a in answers], ["thought"])
        self.assertIn("Continuing the existing work on this issue, continued from chat", answers[0]["content"]["body"])
        self.assertEqual(self.tasks(), [task_id])
        self.assert_reports_in_session(NEW_ISSUE, task_id, "echo-session")

    def test_hf630_linked_board_work_adopts_the_session_on_the_existing_binding_branch(self):
        issue = self.authority.issues[ISSUE]
        existing = self.board.create(title="OPS-1: earlier chat task", created_by="chat",
                                     body=f"Linear issue OPS-1: {issue['url']}\nContinue the rollout.")
        self.assertTrue(self.ask({"action": "work_on", "issue": ISSUE})["ok"])
        self.assertIsNone(self.bridge.store.native_intent(f"create:{ISSUE}"))  # no admission: existing_binding
        self.flush()
        self.echo(ISSUE, "echo-session")
        self.flush()
        self.assertEqual(self.bridge.store.get(ISSUE)["owner_ref"], "echo-session")
        self.assertEqual([a["content"]["type"] for a in self.said("echo-session")], ["thought"])
        # Progress scope: native Done never closes the issue, so only progress is checked here.
        self.assert_reports_in_session(ISSUE, existing.id, "echo-session", done=False)

    def test_adoption_rechecks_pending_old_owner_progress_in_transaction(self):
        self.check_reopened_owner_during_adoption(publication="pending")

    def test_adoption_rechecks_unknown_old_owner_progress_in_transaction(self):
        self.check_reopened_owner_during_adoption(publication="unknown")

    def check_reopened_owner_during_adoption(self, *, publication):
        task_id = self.create(start_work=True)["native"]["task_id"]
        self.flush()
        self.claim(task_id)
        self.echo(NEW_ISSUE, "old-session")
        self.flush()
        self.bridge._decline(NEW_ISSUE, "old-session", "The conversation is answered.")
        self.flush()
        self.assertTrue(self.bridge.store.session_answered(NEW_ISSUE, "old-session"))
        other = Bridge(Store(self.bridge.store.path), self.authority.api(scope=None), self.board, profile="default")
        other.profile_home = self.home
        adopt, raced = self.bridge.store.adopt_session, []
        def reopen_then_adopt(*args, **kwargs):
            # The old owner newly reports session work (its Started step; checkpoints are issue comments).
            self.native_event(task_id, "spawned", {"pid": 4242})
            other.pump_kanban()
            if publication == "sent":
                other.flush()
            elif publication == "unknown":
                checkpoint = next(row for row in other.store.pending(NEW_ISSUE)
                    if row["kind"] == "activity" and row["payload"].get("session_id") == "old-session"
                    and row["payload"].get("content", {}).get("action") == "Started")
                self.assertTrue(other.store.admit_mutation(checkpoint["id"]))
                other.store.mark(checkpoint["id"], "failed", "Unknown publication after durable transport admission")
            raced.append(True)
            return adopt(*args, **kwargs)
        with patch.object(self.bridge.store, "adopt_session", side_effect=reopen_then_adopt):
            self.echo(NEW_ISSUE, "new-session")
        self.assertTrue(raced)
        self.assertEqual(self.bridge.store.get(NEW_ISSUE)["owner_ref"], "old-session")
        self.assertFalse(other.store.session_answered(NEW_ISSUE, "old-session"))
        self.assertEqual(self.tasks(), [task_id])

    def test_later_response_cannot_hide_an_older_unknown_owner_activity(self):
        task_id = self.create(start_work=True)["native"]["task_id"]
        self.flush()
        self.claim(task_id)
        self.echo(NEW_ISSUE, "old-session")
        self.flush()
        self.native_event(task_id, "spawned", {"pid": 4242})  # an older session step, not a checkpoint comment
        self.bridge.pump_kanban()
        checkpoint = next(row for row in self.bridge.store.pending(NEW_ISSUE)
            if row["kind"] == "activity" and row["payload"].get("session_id") == "old-session"
            and row["payload"].get("content", {}).get("action") == "Started")
        self.assertTrue(self.bridge.store.admit_mutation(checkpoint["id"]))
        self.bridge.store.mark(checkpoint["id"], "failed", "Unknown publication after durable transport admission")
        self.bridge._decline(NEW_ISSUE, "old-session", "Later response.")
        final = next(row for row in self.bridge.store.pending(NEW_ISSUE)
            if row["kind"] == "activity" and row["payload"].get("content", {}).get("body") == "Later response.")
        self.bridge.flush(only_id=final["id"])
        self.assertEqual(self.bridge.store.outbox_row(final["id"])["state"], "sent")
        self.assertFalse(self.bridge.store.session_answered(NEW_ISSUE, "old-session"))
        self.echo(NEW_ISSUE, "new-session")
        self.assertEqual(self.bridge.store.get(NEW_ISSUE)["owner_ref"], "old-session")

    def test_an_adopted_session_gets_one_done_response_with_the_prs_state(self):
        # F28: PR work is Done when the task is done; the session's only response carries the PR state.
        from hermes_fleet_linear_plugin import bridge as bridge_module
        for adopt_before_completion in (True, False):
            with self.subTest(adopt_before_completion=adopt_before_completion):
                self.setUp()
                task_id = self.create(start_work=True)["native"]["task_id"]
                self.flush()
                if adopt_before_completion:
                    self.echo(NEW_ISSUE, "echo-session")
                    self.flush()
                self.claim(task_id)
                with patch.object(bridge_module, "pr_state", lambda *a, **k: "open, checks still running"):
                    with self.board.conn() as conn:
                        kb.complete_task(conn, task_id, summary="Implementation finished; checks are running.",
                                         result="https://github.com/example/project/pull/12")
                    if not adopt_before_completion:
                        self.bridge.pump_kanban()  # captured, not yet delivered
                        self.echo(NEW_ISSUE, "echo-session")
                    for _ in range(3):
                        self.bridge.tick()
                self.assertEqual(self.authority.state(NEW_ISSUE), "Done")
                self.assertEqual(self.bridge.store.get(NEW_ISSUE)["owner_ref"], "echo-session")
                responses = [r for r in self.said("echo-session") if r["content"]["type"] == "response"]
                self.assertEqual(len(responses), 1)
                self.assertIs(responses[0], self.said("echo-session")[-1])
                self.assertFalse(any(r["content"].get("action") == "Verifying" for r in self.said("echo-session")))
                closing = [body for issue_id, body in self.authority.comment_bodies if issue_id == NEW_ISSUE]
                self.assertTrue(any("Pull request: https://github.com/example/project/pull/12 "
                                    "(open, checks still running)" in body for body in closing), closing)

    def test_a_second_session_never_takes_over_a_live_adopted_one(self):
        reply = self.create(start_work=True)
        self.flush()
        self.echo(NEW_ISSUE, "session-1")
        self.flush()
        self.echo(NEW_ISSUE, "session-2")  # say, the delegate removed and added again
        self.flush()
        self.assertEqual(self.bridge.store.get(NEW_ISSUE)["owner_ref"], "session-1")
        self.assertEqual([a["content"]["type"] for a in self.said("session-2")], ["thought"])
        self.assertIn("already started from chat", self.said("session-2")[0]["content"]["body"])
        # Once that session has its final response (Linear closed it), a new one may report the work.
        self.bridge._decline(NEW_ISSUE, "session-1", "Answered.")
        self.flush()
        self.echo(NEW_ISSUE, "session-3")
        self.flush()
        self.assertEqual(self.bridge.store.get(NEW_ISSUE)["owner_ref"], "session-3")
        self.assertEqual([a["content"]["type"] for a in self.said("session-3")], ["thought"])
        self.assertEqual(self.tasks(), [reply["native"]["task_id"]])

    def test_finished_chat_work_still_answers_a_new_session_with_a_response(self):
        reply = self.create(start_work=True)
        task_id = reply["native"]["task_id"]
        self.flush()
        self.claim(task_id)
        with self.board.conn() as conn:
            kb.complete_task(conn, task_id, summary="Done.", result="Done and checked.")
        self.flush()
        self.echo(NEW_ISSUE, "late-session")
        self.flush()
        self.assertEqual(self.bridge.store.get(NEW_ISSUE)["owner_ref"], "")
        self.assertEqual([a["content"]["type"] for a in self.said("late-session")], ["response"])

    def test_chat_work_that_never_gets_a_session_still_reports_as_comments(self):
        reply = self.create(start_work=True)
        task_id = reply["native"]["task_id"]
        self.flush()
        self.claim(task_id)
        self.native_event(task_id, "spawned", {"pid": 4242})
        self.checkpoint(task_id, "Proxy deployed to staging.")
        self.flush()
        comments = self.issue_comments(NEW_ISSUE)
        # In Progress shows the start; the thread carries the milestone, not a fixed Started note.
        self.assertFalse(any(body.startswith("Started") for body in comments), comments)
        self.assertIn("Proxy deployed to staging.", comments)
        self.assertFalse(any(r.get("agentSessionId") for r in self.authority.activity_records))

    def test_duplicate_request_and_repeated_echo_never_start_a_second_task(self):
        first = self.create(start_work=True)
        again = self.create(start_work=True)  # a lost reply retried with the same client id
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["native"]["task_id"], first["native"]["task_id"])
        reuse = self.ask({"action": "work_on", "issue": NEW_ISSUE})
        self.assertTrue(reuse["ok"], reuse)
        self.assertEqual(reuse["native"]["task_id"], first["native"]["task_id"])
        task_id = first["native"]["task_id"]
        events = self.history(task_id)
        self.assertEqual(events.count("unblocked"), 1)  # one admission
        self.flush()
        self.echo(NEW_ISSUE)
        self.echo(NEW_ISSUE)
        self.bridge.tick()
        self.assertEqual(self.tasks(), [task_id])
        self.assertEqual(self.history(task_id).count("unblocked"), 1)
        delegates = [query for query in self.authority.mutations if "issueUpdate" in query]
        self.assertTrue(delegates)
        self.assertEqual(len([r for r in self.authority.activity_records if r["agentSessionId"] == "echo-session"]), 1)

    def test_work_on_an_existing_issue_binds_and_starts_it(self):
        self.authority.issues[ISSUE]["assignee"] = {"id": USER}  # a human owns the issue
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(reply["ok"], reply)
        native = reply["native"]
        self.assertTrue(native["created_from_chat"])
        self.assertTrue(native["admitted"])
        self.assertEqual(self.bridge.store.native_binding(ISSUE)["task_id"], native["task_id"])
        self.assertEqual(self.tasks(), [native["task_id"]])
        self.flush()
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})
        self.assertEqual(self.authority.issues[ISSUE]["assignee"], {"id": USER})  # the human assignee is untouched
        writes = [query for query in self.authority.mutations if "issueUpdate" in query]
        self.assertTrue(writes)
        self.assertFalse(any("assigneeId" in query for query in writes), writes)
        status = self.ask({"action": "status", "issue": ISSUE})
        self.assertTrue(status["native"]["linked"])

    def test_work_on_reuses_an_unlinked_task_already_on_the_board(self):
        issue = self.authority.issues[ISSUE]
        existing = self.board.create(title="OPS-1: earlier chat task", created_by="chat",
                                     body=f"Linear issue OPS-1: {issue['url']}\nContinue the rollout.")
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["native"]["task_id"], existing.id)
        self.assertFalse(reply["native"]["created_from_chat"])
        self.assertEqual(self.tasks(), [existing.id])
        self.assertIn(("telegram", "chat-1"), {(s["platform"], s["chat_id"]) for s in self.subs(existing.id)})

    def test_record_done_closes_with_evidence_without_running_anything(self):
        reply = self.create(record_done=True, summary="Proxy rolled out and checked live.",
                            evidence=["https://ci.example/run/42"])
        self.assertTrue(reply["ok"], reply)
        native = reply["native"]
        self.assertTrue(native["recorded_done"])
        self.assertFalse(native["worker_started"])
        self.assertEqual(native["status"], "done")
        task_id = native["task_id"]
        # Created parked and completed: never unblocked, claimed, spawned or run.
        events = self.history(task_id)
        self.assertEqual(events[:2], ["created", "blocked"])
        self.assertNotIn("unblocked", events)
        self.assertNotIn("claimed", events)
        self.assertNotIn("spawned", events)
        self.assertIsNone(self.board.get(task_id).current_run_id)
        self.assertEqual(reply["routing"], "queued")
        for _ in range(3):
            self.bridge.tick()
        self.assertEqual(self.authority.state(NEW_ISSUE), "Done")
        self.assertEqual(self.authority.issues[NEW_ISSUE]["delegate"], {"id": VIEWER})
        closing = [body for issue_id, body in self.authority.comment_bodies if issue_id == NEW_ISSUE]
        self.assertTrue(any("Proxy rolled out and checked live." in body and "https://ci.example/run/42" in body
                            for body in closing), closing)
        self.assertFalse(any("Queued" in body for body in closing), closing)
        # Repeating it, or asking to start it, re-runs nothing; the echo is the same work.
        again = self.ask({"action": "work_on", "issue": NEW_ISSUE, "record_done": True,
                          "summary": "Proxy rolled out and checked live.", "evidence": ["https://ci.example/run/42"]})
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["native"]["task_id"], task_id)
        self.assertEqual(self.ask({"action": "work_on", "issue": NEW_ISSUE})["native"]["status"], "done")
        self.echo(NEW_ISSUE)
        self.bridge.tick()
        self.assertEqual(self.tasks(), [task_id])
        self.assertNotIn("unblocked", self.history(task_id))
        # FM2: the session Linear opens for it gets the result, not "nothing new was started".
        reply_bodies = [r["content"].get("body") or "" for r in self.said("echo-session")]
        self.assertTrue(any("Proxy rolled out and checked live." in body and "https://ci.example/run/42" in body
                            for body in reply_bodies), reply_bodies)
        self.assertFalse(any("nothing new was started" in body for body in reply_bodies), reply_bodies)

    def test_record_done_refuses_an_issue_with_existing_work(self):
        self.ask({"action": "work_on", "issue": ISSUE})
        refused = self.ask({"action": "work_on", "issue": ISSUE, "record_done": True, "summary": "Done."})
        self.assertFalse(refused["ok"])
        self.assertEqual(len(self.tasks()), 1)
        self.assertEqual(self.board.get(self.tasks()[0]).status, "ready")

    def test_plain_issue_and_questions_start_nothing(self):
        reply = self.create()
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["message"], "Created an undelegated issue.")
        status = self.ask({"action": "status", "issue": ISSUE})
        self.assertTrue(status["ok"], status)
        self.assertEqual(self.tasks(), [])
        self.assertIsNone(self.bridge.store.get(NEW_ISSUE))
        self.assertIsNone(self.authority.issues[NEW_ISSUE]["delegate"])

    def test_invalid_requests_write_nothing(self):
        for extra in ({"start_work": "yes"}, {"record_done": True}, {"record_done": True, "summary": "x", "start_work": True},
                      {"record_done": True, "summary": "x", "evidence": "https://ci.example"}):
            with self.subTest(extra=extra):
                reply = self.create(**extra)
                self.assertFalse(reply["ok"])
                self.assertNotIn(NEW_ISSUE, self.authority.issues)
        child = NativeContext(**{**self.context.to_wire(), "delegated_child": True})
        self.assertFalse(self.ask({"action": "work_on", "issue": ISSUE}, child)["ok"])
        self.assertEqual(self.tasks(), [])

    def test_crash_after_create_resumes_admission_without_a_second_task(self):
        with patch.object(self.bridge, "_assignment_activation", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.bridge.entrust(ISSUE, route=None)
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.bridge.tick()  # the existing recovery path finishes the chat admission
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.assertEqual(self.tasks(), [task_id])

    def test_record_done_crash_before_completion_never_runs_on_recovery(self):
        record = {"summary": "Proxy rolled out and checked live.", "evidence": ["https://ci.example/run/42"]}
        with patch.object(self.bridge, "_record_done", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.bridge.entrust(ISSUE, route=None, record_done=record)
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        self.assertEqual(self.board.get(task_id).status, "blocked")
        for _ in range(3):
            self.bridge.tick()  # recovery must not admit work already finished in chat
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertNotIn("unblocked", self.history(task_id))
        # Asking to start it is refused; nothing runs.
        refused = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertFalse(refused["ok"], refused)
        self.assertEqual(self.board.get(task_id).status, "blocked")
        # Repeating the record finishes it as done with the evidence, still without a run.
        again = self.bridge.entrust(ISSUE, route=None, record_done=record)
        self.assertEqual((again["task_id"], again["status"], again["worker_started"]), (task_id, "done", False))
        events = self.history(task_id)
        self.assertNotIn("unblocked", events)
        self.assertNotIn("claimed", events)
        self.assertIsNone(self.board.get(task_id).current_run_id)
        self.assertEqual(self.tasks(), [task_id])

    def test_record_done_crash_mid_completion_never_runs_on_recovery(self):
        # The crash lands after creation and binding, inside record_done before the activation fence.
        original = self.bridge.store.native_intent_prepare

        def crash(key, request):
            if key.startswith("activate:"):
                raise RuntimeError("crash")
            return original(key, request)
        with patch.object(self.bridge.store, "native_intent_prepare", side_effect=crash):
            with self.assertRaises(RuntimeError):
                self.bridge.entrust(ISSUE, route=None, record_done={"summary": "Done.", "evidence": []})
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        self.bridge.tick()
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertNotIn("unblocked", self.history(task_id))

    def test_recovery_of_chat_admission_respects_a_later_delegation_elsewhere(self):
        with patch.object(self.bridge, "_assignment_activation", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.bridge.entrust(ISSUE, route=None)
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        self.authority.issues[ISSUE]["delegate"] = {"id": str(uuid.UUID(int=0x99, version=4))}
        self.authority.issues[ISSUE]["updatedAt"] = now_iso()
        self.bridge.tick()
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertNotIn("unblocked", self.history(task_id))

    def test_work_on_an_issue_delegated_elsewhere_creates_nothing_and_says_so(self):
        other = str(uuid.UUID(int=0x99, version=4))
        self.authority.issues[ISSUE]["delegate"] = {"id": other}
        self.authority.issues[ISSUE]["updatedAt"] = now_iso()
        for args in ({"action": "work_on", "issue": ISSUE},
                     {"action": "work_on", "issue": ISSUE, "record_done": True, "summary": "Done in chat."}):
            reply = self.ask(args)
            self.assertFalse(reply["ok"], reply)
            self.assertIn("delegated to another agent", reply["message"])
            self.assertNotIn("carries out this work", reply["message"])
        self.assertEqual(self.tasks(), [])
        self.assertIsNone(self.bridge.store.get(ISSUE))
        self.assertIsNone(self.bridge.store.native_intent(f"create:{ISSUE}"))
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": other})
        # Nothing was parked, so a later delegation to this agent starts normally.
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.authority.issues[ISSUE]["updatedAt"] = now_iso()
        self.assertTrue(self.human_delegation(ISSUE, "later-session"))
        self.flush()
        tasks = self.tasks()
        self.assertEqual(len(tasks), 1)
        self.assertIn("unblocked", self.history(tasks[0]))
        answers = [r["content"].get("body") or "" for r in self.authority.activity_records
                   if r["agentSessionId"] == "later-session"]
        self.assertFalse(any("waiting to start" in body for body in answers), answers)

    def test_superseded_admission_reports_not_started_instead_of_started(self):
        # A Stop newer than the chat request supersedes admission: the task is parked, not run.
        self.bridge.store.record_unbound_stop(ISSUE, time.time() * 1000 + 60_000, session_id="stop-session",
                                              activity_id="stop-1", actor=USER)
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertFalse(reply["ok"], reply)
        self.assertTrue(reply["native"]["created_from_chat"])
        self.assertFalse(reply["native"]["admitted"])
        self.assertTrue(reply["message"].startswith("Not started:"), reply["message"])
        self.assertIn("someone stopped it in Linear", reply["message"])
        self.assertNotIn("Do not also do this work here", reply["message"])
        task_id = reply["native"]["task_id"]
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertNotIn("unblocked", self.history(task_id))
        again = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertFalse(again["ok"], again)
        self.assertTrue(again["message"].startswith("Not started:"), again["message"])
        self.assertEqual(self.tasks(), [task_id])

    def test_unavailable_guarded_controls_report_not_started(self):
        with patch.object(Kanban, "guarded_controls", False, create=True):
            reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertFalse(reply["ok"], reply)
        self.assertFalse(reply["native"]["admitted"])
        self.assertIn("can't start work safely", reply["message"])
        self.assertNotIn("unblocked", self.history(reply["native"]["task_id"]))

    # -- reviewer follow-ups ------------------------------------------------
    def test_adopted_board_task_with_a_different_definition_of_done_is_declined(self):
        issue = self.authority.issues[ISSUE]
        self.bridge.contracts = {PROJECT: "https://github.com/example/fleet"}
        existing = self.board.create(title="OPS-1: earlier chat task", created_by="chat",
                                     body=f"Linear issue OPS-1: {issue['url']}\nContinue the rollout.")
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertFalse(reply["ok"], reply)
        self.assertIn("different definition of done", reply["message"])
        self.assertIsNone(self.bridge.store.get(ISSUE))
        self.assertEqual(self.tasks(), [existing.id])
        self.assertEqual(self.board.get(existing.id).status, existing.status)  # nothing stopped or started

    def test_adopted_board_task_binds_as_progress_and_never_closes_the_issue(self):
        issue = self.authority.issues[ISSUE]
        existing = self.board.create(title="OPS-1: earlier chat task", created_by="chat",
                                     body=f"Linear issue OPS-1: {issue['url']}\nContinue the rollout.")
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.bridge.store.native_binding(ISSUE)["completion_scope"]["mode"], "progress")
        with self.board.conn() as conn:
            kb.complete_task(conn, existing.id, summary="Stage finished.", result="Stage finished.")
        for _ in range(3):
            self.bridge.tick()
        self.assertNotEqual(self.authority.state(ISSUE), "Done")

    def test_delegate_routing_is_queued_under_the_issue_lock_with_the_version_read_there(self):
        original_entrust, original_queue = self.bridge.entrust, self.bridge.queue_delegate_self
        held = []

        def entrust_after_a_flush(issue_id, **kwargs):
            # A tick flush lands between the chat's issue read and the bridge taking the lock.
            self.authority.issues[issue_id]["updatedAt"] = self.later_iso()
            return original_entrust(issue_id, **kwargs)

        def queue(issue_id, *args, **kwargs):
            held.append(self.bridge.lock(issue_id)._is_owned())
            return original_queue(issue_id, *args, **kwargs)
        with patch.object(self.bridge, "entrust", side_effect=entrust_after_a_flush), \
                patch.object(self.bridge, "queue_delegate_self", side_effect=queue):
            reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["routing"], "queued")
        self.assertEqual(held, [True])
        self.bridge.flush()  # no tick: the chat's own queued routing must land by itself
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})
        self.assertEqual(self.delegate_rows(), ["sent"])

    def test_held_delegate_routing_is_reported_honestly_and_retried(self):
        original = self.bridge._delegate_preflight
        calls = []

        def refuse_once(payload):
            calls.append(payload)
            if len(calls) == 1:
                raise LinearError("Linear changed; read current status before routing work", retryable=False)
            return original(payload)
        with patch.object(self.bridge, "_delegate_preflight", side_effect=refuse_once):
            reply = self.ask({"action": "work_on", "issue": ISSUE})
            self.assertTrue(reply["ok"], reply)
            self.assertTrue(reply["routing"].startswith("held"), reply["routing"])
            self.assertNotIn("Linear shows this agent as delegate", reply["message"])
            self.assertIn("delegate update is still pending and the agent retries it automatically", reply["message"])
            for _ in range(3):
                self.bridge.tick()  # binding recovery re-queues routing for chat-started work
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})
        self.assertEqual(self.delegate_rows(), ["sent"])

    def test_queued_routing_does_not_claim_linear_already_shows_the_delegate(self):
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertEqual(reply["routing"], "queued")
        self.assertNotIn("Linear shows this agent", reply["message"])
        self.assertIn("being updated to show this agent as delegate", reply["message"])

    def test_chat_route_refused_at_send_is_requeued_by_delegate_recovery(self):
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertEqual(reply["routing"], "queued")
        # Linear moves for a non-routing reason (a comment) before the queued delegate goes out.
        self.authority.issues[ISSUE]["updatedAt"] = self.later_iso()
        self.bridge.tick()  # captures the admission; the chat's delegate write is refused at send
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])
        # Asked again from chat: routing for the current binding is queued and refused the same way.
        again = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertEqual(again["routing"], "queued")
        self.authority.issues[ISSUE]["updatedAt"] = self.later_iso()
        self.bridge.flush()
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])
        self.assertEqual(self.delegate_rows(), ["failed", "failed"])
        # No write was ever attempted, so recovery retries once for this binding, under its human fence.
        for _ in range(3):
            self.bridge.tick()
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})
        self.assertEqual(self.delegate_rows(), ["failed", "failed", "sent"])
        self.assertEqual(self.authority.issues[ISSUE]["assignee"], issue_record()["assignee"])

    def test_repeating_the_request_after_a_refused_delegate_write_does_not_claim_it_is_queued(self):
        self.assertEqual(self.ask({"action": "work_on", "issue": ISSUE})["routing"], "queued")
        self.authority.issues[ISSUE]["updatedAt"] = self.later_iso()
        self.bridge.flush()  # refused at send; the binding has not moved
        self.assertEqual(self.delegate_rows(), ["failed"])
        again = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(again["routing"].startswith("held"), again["routing"])
        self.assertNotIn("being updated", again["message"])
        self.assertIn("delegate update is still pending", again["message"])

    def test_chat_route_retry_yields_to_a_person_changing_routing_after_the_request(self):
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        task_id = reply["native"]["task_id"]
        # After the chat request a person assigns the issue; our delegate write is then refused.
        changed = self.later_iso()
        self.authority.issues[ISSUE]["assignee"] = {"id": USER}
        self.authority.issues[ISSUE]["updatedAt"] = changed
        self.authority.history.setdefault(ISSUE, []).append({
            "createdAt": changed, "actorId": USER, "fromStateId": "state-todo", "toStateId": "state-todo",
            "fromAssigneeId": None, "toAssigneeId": USER, "fromDelegate": None, "toDelegate": None})
        self.bridge.flush()
        self.assertEqual(self.delegate_rows(), ["failed"])
        time.sleep(1.1)  # the worker's claim comes clearly after the person's change
        self.claim(task_id)
        for _ in range(3):
            self.bridge.tick()
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])  # the person's newer change wins
        self.assertEqual(self.authority.issues[ISSUE]["assignee"], {"id": USER})

    def undelegate_by_person(self, issue_id):
        changed = self.later_iso()
        self.authority.issues[issue_id]["delegate"] = None
        self.authority.issues[issue_id]["updatedAt"] = changed
        self.authority.history.setdefault(issue_id, []).append({
            "createdAt": changed, "actorId": USER, "fromStateId": "state-todo", "toStateId": "state-todo",
            "fromAssigneeId": None, "toAssigneeId": None, "fromDelegate": {"id": VIEWER}, "toDelegate": None})

    def test_asking_again_after_a_person_removed_the_delegate_says_so_and_does_not_re_add_it(self):
        self.ask({"action": "work_on", "issue": ISSUE})
        self.bridge.flush()
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})
        self.undelegate_by_person(ISSUE)
        again = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertIn("a person removed this agent as delegate in Linear, so it was not re-added", again["message"])
        self.assertNotIn("retries", again["message"])
        for _ in range(4):
            self.bridge.tick()
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])

    def test_recovered_admission_still_yields_to_a_later_reassignment(self):
        with patch.object(self.bridge, "_assignment_activation", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.ask({"action": "work_on", "issue": ISSUE})
        self.assertEqual(self.delegate_rows(), [])  # routing follows admission
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        later = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()
        self.authority.issues[ISSUE]["updatedAt"] = later
        self.authority.issues[ISSUE]["assignee"] = {"id": USER}
        self.authority.history.setdefault(ISSUE, []).append({
            "createdAt": later, "actorId": USER, "fromStateId": "state-todo", "toStateId": "state-todo",
            "fromAssigneeId": None, "toAssigneeId": USER, "fromDelegate": None, "toDelegate": None})
        self.bridge._recover_admissions()
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertNotIn("unblocked", self.history(task_id))
        # The parked task is not shown as worked on: no delegate is queued.
        self.assertEqual(self.delegate_rows(), [])
        for _ in range(4):
            self.bridge.tick()
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_superseded_chat_admission_queues_no_delegate_even_when_asked_again(self):
        self.bridge.store.record_unbound_stop(ISSUE, time.time() * 1000 + 60_000, session_id="stop-session",
                                              activity_id="stop-1", actor=USER)
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(reply["message"].startswith("Not started:"), reply["message"])
        self.assertEqual(reply["routing"], "held: not started")
        for _ in range(3):
            self.bridge.tick()
        again = self.ask({"action": "work_on", "issue": ISSUE})  # after ticks moved the binding revision
        self.assertEqual(again["routing"], "held: not started")
        for _ in range(3):
            self.bridge.tick()
        self.assertEqual(self.delegate_rows(), [])
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])
        self.assertEqual(self.board.get(reply["native"]["task_id"]).status, "blocked")

    def test_work_that_cannot_start_safely_gets_no_delegate(self):
        with patch.object(Kanban, "guarded_controls", False, create=True):
            reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertFalse(reply["native"]["admitted"])
        self.bridge.flush()
        self.assertEqual(self.delegate_rows(), [])
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])

    def test_a_status_only_change_is_not_described_as_reassignment(self):
        self.ask({"action": "work_on", "issue": ISSUE})
        self.bridge.flush()
        self.undelegate_by_person(ISSUE)
        node = self.authority.history[ISSUE][-1]
        node.update(fromDelegate=None, toDelegate=None, fromStateId="state-todo", toStateId="state-progress")
        self.authority.issues[ISSUE]["delegate"] = None
        for _ in range(2):
            self.bridge.tick()
        again = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertIn("changed this issue's status, assignee or delegate", again["message"])
        self.assertNotIn("who works on", again["message"])

    def test_first_chat_route_costs_no_extra_linear_reads(self):
        before = len(self.authority.requests)
        self.ask({"action": "work_on", "issue": ISSUE})
        reads = self.authority.requests[before:]
        self.assertFalse(any("IssueRoutingHistory" in query for query in reads), reads)

    def test_asking_again_after_a_crash_and_a_reassignment_does_not_start_the_work(self):
        with patch.object(self.bridge, "_assignment_activation", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.bridge.entrust(ISSUE, route=None)  # crash before routing was queued
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        later = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()
        self.authority.issues[ISSUE]["updatedAt"] = later
        self.authority.issues[ISSUE]["assignee"] = {"id": USER}
        self.authority.history.setdefault(ISSUE, []).append({
            "createdAt": later, "actorId": USER, "fromStateId": "state-todo", "toStateId": "state-todo",
            "fromAssigneeId": None, "toAssigneeId": USER, "fromDelegate": None, "toDelegate": None})
        again = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertFalse(again["native"]["admitted"], again)
        self.assertTrue(again["message"].startswith("Not started:"), again["message"])
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertEqual(again["routing"], "held: not started")
        self.assertEqual(self.delegate_rows(), [])  # no delegate is queued over the person's change
        for _ in range(3):
            self.bridge.tick()
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])

    def test_parked_chat_work_resumed_later_gets_its_delegate(self):
        self.bridge.store.record_unbound_stop(ISSUE, time.time() * 1000 + 60_000, session_id="stop-session",
                                              activity_id="stop-1", actor=USER)
        task_id = self.ask({"action": "work_on", "issue": ISSUE})["native"]["task_id"]
        for _ in range(2):
            self.bridge.tick()
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])  # parked: not shown as worked on
        with self.board.conn() as conn:
            kb.unblock_task(conn, task_id)  # someone resumes it on the board
        self.claim(task_id)
        for _ in range(4):
            self.bridge.tick()
        self.assertEqual(self.board.get(task_id).status, "running")
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})

    def test_reask_after_resume_keeps_recovery_delegate(self):
        self.bridge.store.record_unbound_stop(ISSUE, time.time() * 1000 + 60_000, session_id="stop-session",
                                              activity_id="stop-1", actor=USER)
        task_id = self.ask({"action": "work_on", "issue": ISSUE})["native"]["task_id"]
        for _ in range(2):
            self.bridge.tick()
        with self.board.conn() as conn:
            kb.unblock_task(conn, task_id)
        self.claim(task_id)
        with patch.object(type(self.bridge), "flush", lambda self, **kw: 0):
            for _ in range(4):
                self.bridge.tick()
        with self.bridge.store._tx() as db:
            rows = db.execute("SELECT id,state,json_extract(payload,'$.recovered_binding') FROM outbox WHERE kind='delegate'").fetchall()
        again = self.ask({"action": "work_on", "issue": ISSUE})
        for _ in range(6):
            self.bridge.tick()
        with self.bridge.store._tx() as db:
            rows = db.execute("SELECT id,state,json_extract(payload,'$.admission_superseded') FROM outbox WHERE kind='delegate'").fetchall()
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})

    def test_work_parked_by_a_person_and_resumed_later_gets_its_delegate(self):
        with patch.object(self.bridge, "_assignment_activation", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.ask({"action": "work_on", "issue": ISSUE})
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        later = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()
        self.authority.issues[ISSUE]["updatedAt"] = later
        self.authority.history.setdefault(ISSUE, []).append({
            "createdAt": later, "actorId": USER, "fromStateId": "state-todo", "toStateId": "state-progress",
            "fromAssigneeId": None, "toAssigneeId": None, "fromDelegate": None, "toDelegate": None})
        self.bridge._recover_admissions()
        self.assertEqual(self.board.get(task_id).status, "blocked")  # the person's change parked it
        time.sleep(2.1)
        with self.board.conn() as conn:
            kb.unblock_task(conn, task_id)  # later someone resumes it
        self.claim(task_id)
        for _ in range(4):
            self.bridge.tick()
        self.assertEqual(self.board.get(task_id).status, "running")
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})

    def test_asking_again_after_ticks_never_re_adds_a_delegate_a_person_removed(self):
        task_id = self.ask({"action": "work_on", "issue": ISSUE})["native"]["task_id"]
        self.bridge.flush()
        self.claim(task_id)
        for _ in range(3):
            self.bridge.tick()
        self.assertEqual(self.authority.issues[ISSUE]["delegate"], {"id": VIEWER})
        self.undelegate_by_person(ISSUE)
        for _ in range(3):
            self.bridge.tick()
        again = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertIn("a person removed this agent as delegate in Linear, so it was not re-added", again["message"])
        for _ in range(3):
            self.bridge.tick()
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])

    def test_native_input_stop_control_reaches_chat_started_work_before_the_delegate_lands(self):
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        task_id = reply["native"]["task_id"]
        self.claim(task_id)
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])
        session, activity = "native-stop-session", "native-stop-activity"
        self.authority.sessions[session] = {"id": session, "issue": {"id": ISSUE},
                                            "creator": {"id": USER}, "appUser": {"id": VIEWER}}
        self.authority.activities[activity] = {"id": activity, "user": {"id": USER}, "agentSession": {"id": session}}
        stamp = time.time() + 1
        event = {"type": "AgentSessionEvent", "action": "prompted",
                 "createdAt": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                 "webhookTimestamp": int(stamp * 1000),
                 "agentSession": {"id": session, "issue": {"id": ISSUE}, "creatorId": USER},
                 "agentActivity": {"id": activity, "signal": "stop", "user": {"id": USER}}}
        projected = native_input.project_input(self.bridge, event)
        self.assertEqual(projected.signal, "stop")
        native_input._handle_control(self.bridge, event, projected)  # raises when the Stop is held
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_linear_stop_reaches_chat_started_work_while_the_delegate_write_is_pending(self):
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        task_id = reply["native"]["task_id"]
        self.claim(task_id)
        self.assertIsNone(self.authority.issues[ISSUE]["delegate"])  # the delegate write has not gone out
        self.assertTrue(self.stop(ISSUE))
        self.assertEqual(self.board.get(task_id).status, "blocked")
        for _ in range(2):
            self.bridge.tick()
        self.assertEqual(self.board.get(task_id).status, "blocked")  # stopped work stays stopped

    def test_linear_stop_on_work_delegated_elsewhere_is_still_refused(self):
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        task_id = reply["native"]["task_id"]
        self.claim(task_id)
        self.authority.issues[ISSUE]["delegate"] = {"id": str(uuid.UUID(int=0x99, version=4))}
        self.assertFalse(self.stop(ISSUE))
        self.assertEqual(self.board.get(task_id).status, "running")

    def test_recovered_chat_admission_yields_to_a_person_undelegating_it(self):
        with patch.object(self.bridge, "_assignment_activation", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.bridge.entrust(ISSUE, route=None)
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        later = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()
        self.authority.issues[ISSUE]["updatedAt"] = later
        self.authority.history.setdefault(ISSUE, []).append({
            "createdAt": later, "actorId": USER, "fromStateId": "state-todo", "toStateId": "state-todo",
            "fromAssigneeId": None, "toAssigneeId": None, "fromDelegate": {"id": VIEWER}, "toDelegate": None})
        self.bridge.tick()
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertNotIn("unblocked", self.history(task_id))

    def test_another_session_on_assignment_work_gets_a_neutral_notice(self):
        self.assertIn("already working on this", _same_work_notice("running", False))
        for status in ("running", "blocked", "done"):
            self.assertNotIn("chat", _same_work_notice(status, False))
        self.assertNotIn("continue here", _same_work_notice("running", True))


class OriginRouteTests(unittest.TestCase):
    """The asking chat's subscription mirrors core kanban_create auto-subscribe, from host context only."""

    def context(self, **fields):
        base = dict(home="/h", profile="default", platform="telegram", source="telegram", session_key="k",
                    session_id="s", chat_id="chat-1", chat_type="group", thread_id="t-1", user_id="u-1")
        return NativeContext(**{**base, **fields})

    def test_messaging_chat_is_woken_in_its_thread(self):
        route = chat._origin_route(self.context())
        self.assertEqual((route["platform"], route["chat_id"], route["thread_id"], route["delivery_mode"],
                          route["notifier_profile"]), ("telegram", "chat-1", "t-1", "wake", "default"))

    def test_desktop_conversation_targets_its_own_local_session(self):
        # An owner-adopted Desktop turn binds the native local route for that conversation (#258).
        route = chat._origin_route(self.context(platform="local", source="desktop", chat_id="sess-1", thread_id="",
                                                chat_type=""))
        self.assertEqual((route["platform"], route["chat_id"], route["delivery_mode"]), ("local", "sess-1", "wake"))

    def test_tui_falls_back_to_the_session_key_and_linear_reports_on_its_issue(self):
        route = chat._origin_route(self.context(platform="", chat_id="", session_key="tui-key"))
        self.assertEqual((route["platform"], route["chat_id"], route["delivery_mode"]), ("tui", "tui-key", None))
        self.assertIsNone(chat._origin_route(self.context(platform="linear")))


if __name__ == "__main__":
    unittest.main()
