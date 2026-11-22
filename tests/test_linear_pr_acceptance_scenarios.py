"""Native Done is Linear Done (F28, Ken 23 Nov 2026), on real pinned Core tasks.

A PR named as evidence no longer gates Done: the closing response (which completes the Agent
Session) carries the PR's current state, and nothing waits on its checks. Closeouts an older build
left waiting on PR acceptance (In Review, or Blocked "could not be verified") are closed out again
as Done through the same path. One fake ``gh`` answers at the subprocess boundary.
"""
import json
import os
import subprocess
import time
import unittest
from unittest.mock import patch

import test_linear_delegate_routing_scenarios as routing
from linear_fake_api import SELF, STATES

IN_REVIEW = {"id": "st-review", "name": "In Review", "type": "started"}
REPO = "acme/app"
PR = f"https://github.com/{REPO}/pull/7"
SHA = "c" * 40
SUMMARY = f"Fixed the receipts drill-down in {PR}."
# What an older build wrote for those issues (only the PR and SHA differ).
LEGACY_BODY = (f"The work finished, but its pull request could not be verified as ready ({PR}: auth: GitHub refused the "
               f"acceptance read (HTTP 403 on repos/{REPO}/commits/{SHA}/check-runs) as the ambient gh login; fix that "
               "profile's GitHub credentials/access to the repository, then retry completion.). The issue stays open "
               "until the PR's required checks pass on its latest commit.")


class FakeGh:
    """``gh api`` for one repository: the PR and its exact-head check runs."""

    def __init__(self):
        self.calls = []
        self.pr_state, self.merged = "closed", True
        self.runs = [{"status": "completed", "conclusion": "success"}]
        self.refused = False
        self.real_run = subprocess.run

    def run(self, command, *args, **kwargs):
        if not (isinstance(command, list) and command[:2] == ["gh", "api"]):
            return self.real_run(command, *args, **kwargs)
        endpoint = command[2]
        self.calls.append(endpoint)
        if self.refused:
            raise subprocess.CalledProcessError(1, command, output="", stderr="gh: Forbidden (HTTP 403)")
        if endpoint == f"repos/{REPO}/pulls/7":
            reply = {"state": self.pr_state, "merged": self.merged, "head": {"sha": SHA}}
        elif endpoint.startswith(f"repos/{REPO}/commits/{SHA}/check-runs"):
            reply = {"total_count": len(self.runs), "check_runs": self.runs}
        else:
            raise subprocess.CalledProcessError(1, command, output="", stderr="gh: Not Found (HTTP 404)")
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(reply), stderr="")


@unittest.skipUnless(os.environ.get("HERMES_AGENT_SRC"), "requires explicit native source")
class NativeDoneIsLinearDoneScenarios(unittest.TestCase):
    def setUp(self):
        # The fixture of test_linear_status_follows_work_scenarios: a team with In Review and Blocked.
        self.fixture = routing.DelegateRoutingScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.remote.history.pop("issue-1", None)
        self.clock = self.fixture.fixture.clock
        self.clock.now = time.time() - 5
        self.fixture.remote.set_delegate("issue-1", {"id": SELF}, actor=SELF)
        self.states = [*STATES, IN_REVIEW]
        self.fixture.issue["team"]["states"]["nodes"] = self.states
        self.bridge, self.board, self.remote = self.fixture.bridge, self.fixture.board, self.fixture.remote
        self.gh = FakeGh()
        runner = patch("subprocess.run", self.gh.run)
        runner.start()
        self.addCleanup(runner.stop)

    def task(self, *, claim=False):
        with self.board.conn() as db:
            task = self.board.kb.create_task(db, title="Native work", board=self.board.board,
                assignee=self.board.executor_profile, created_by="operator",
                body="Linear issue issue-1: " + self.fixture.issue["url"])
            run = self.board.kb.claim_task(db, task, claimer="native-worker").current_run_id if claim else None
        self.bridge.track("issue-1", task, completion_scope="outcome")
        return task, run

    def native(self, action, *args, **kwargs):
        with self.board.conn() as db:
            return getattr(self.board.kb, action)(db, *args, **kwargs)

    def set_state(self, name, actor="human-1"):
        before = dict(self.fixture.issue)
        self.fixture.issue["state"] = dict(next(s for s in self.states if s["name"] == name))
        self.fixture.issue["updatedAt"] = self.clock.iso()
        self.remote.record_history("issue-1", actor, before, self.fixture.issue)

    def state(self):
        return self.remote.state("issue-1")

    def mutations(self):
        return self.fixture.mutations()

    def failed(self):
        with self.bridge.store._tx() as db:
            return db.execute("SELECT kind, payload FROM outbox WHERE state='failed'").fetchall()

    def ticks(self, count=3, *, after=2.0):
        self.clock.now = max(self.clock.now, time.time()) + after
        for _ in range(count):
            self.bridge.pump_kanban()
            self.bridge.flush()

    def finish_with_pr(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        self.assertTrue(self.native("complete_task", task, summary=SUMMARY, expected_run_id=run))
        return task

    def status_rows(self):
        with self.bridge.store._tx() as db:
            return [json.loads(row[0]) for row in db.execute(
                "SELECT payload FROM outbox WHERE kind='status' ORDER BY rowid")]

    def said(self):
        return self.remote.bodies("issue-1")

    def responses(self):
        return [a["content"].get("body") or "" for a in self.remote.activities
                if a.get("issueId") == "issue-1" and a["content"].get("type") == "response"]

    def completed_event(self, task):
        return max(event.id for event in self.board.history(task, 0) if event.kind == "completed")

    def legacy_closeout(self, task, kind, *, final=False):
        """Write and send what an older build wrote for this completion: its In Review acceptance
        wait (with a queued "Verifying" keepalive), or its Blocked "could not be verified" closeout."""
        row = self.bridge.store.get("issue-1")
        event = self.completed_event(task)
        if kind == "in_review":
            writes = [("status", {"issue_id": "issue-1", "state": "in_review", "task_id": task,
                                  "acceptance_wait": {"event_id": event, "classification": "infra", "url": PR,
                                                      "head_sha": "", "since": self.clock()}}),
                      ("activity", {"issue_id": "issue-1", "session_id": row["owner_ref"], "task_id": task,
                                    "content": {"type": "thought", "body": "The work is finished, but GitHub did not answer."}})]
        else:
            writes = [("status", {"issue_id": "issue-1", "state": "blocked", "task_id": task, "terminal": True,
                                  "owner_issue_id": "issue-1", **({"acceptance_final": True} if final else {})}),
                      ("activity", {"issue_id": "issue-1", "session_id": row["owner_ref"], "task_id": task,
                                    "terminal": True, "owner_issue_id": "issue-1",
                                    "content": {"type": "error", "body": LEGACY_BODY}})]
        self.clock.now = max(self.clock.now, time.time()) + 2
        self.assertTrue(self.bridge._finish_work("issue-1", writes, at=self.clock(), event_id=event))
        if kind == "in_review":
            self.bridge.store.enqueue("activity", {"issue_id": "issue-1", "session_id": row["owner_ref"], "task_id": task,
                                                   "native_progress": True, "write_started": False, "ephemeral": True,
                                                   "acceptance_status_id": self.bridge.store.legacy_closeout("issue-1", task)["status_id"],
                                                   "content": {"type": "action", "action": "Verifying",
                                                               "parameter": "Waiting for pull request checks"}},
                                      at=self.clock() + 60)
        else:
            self.bridge.flush()
            self.assertEqual(self.state(), "Blocked")

    def test_finished_pr_work_is_done_with_the_prs_state(self):
        cases = (("closed", True, [], "merged"),
                 ("open", False, [{"status": "completed", "conclusion": "success"}], "open, checks passed"),
                 ("open", False, [{"status": "in_progress", "conclusion": None}], "open, checks still running"),
                 ("open", False, [{"status": "completed", "conclusion": "failure"}], "open, a check failed"))
        for pr_state, merged, runs, said in cases:
            with self.subTest(said=said):
                self.setUp()
                self.gh.pr_state, self.gh.merged, self.gh.runs = pr_state, merged, runs
                self.finish_with_pr()
                self.ticks()
                self.assertEqual(self.state(), "Done")
                self.assertTrue(any(f"Pull request: {PR} ({said})" in body for body in self.said()), self.said())
                self.assertFalse(any("could not be verified" in body for body in self.said()))
                self.assertEqual(self.failed(), [])
                calls = len(self.gh.calls)
                self.ticks(3, after=4000)
                self.assertEqual(len(self.gh.calls), calls)  # nothing is rechecked

    def test_github_refusing_only_drops_the_state_line(self):
        self.gh.refused = True
        self.finish_with_pr()
        self.ticks()
        self.assertEqual(self.state(), "Done")
        self.assertTrue(any(f"Pull request: {PR}" in body and f"{PR} (" not in body for body in self.said()))
        self.assertEqual(self.failed(), [])

    def test_an_older_builds_in_review_wait_settles_as_done_once(self):
        task = self.finish_with_pr()
        self.legacy_closeout(task, "in_review")
        self.ticks()
        self.assertEqual(self.state(), "Done")
        self.assertIsNone(self.bridge.store.legacy_closeout("issue-1", task))
        self.assertFalse(any(a["content"].get("action") == "Verifying" for a in self.remote.activities))
        done = [row for row in self.status_rows() if row["state"] == "done"]
        self.ticks(3, after=4000)
        self.assertEqual([row for row in self.status_rows() if row["state"] == "done"], done)
        self.assertEqual(self.failed(), [])

    def test_an_older_builds_blocked_could_not_be_verified_closeout_settles_as_done(self):
        for final in (False, True):
            with self.subTest(final=final):
                self.setUp()
                task = self.finish_with_pr()
                self.legacy_closeout(task, "blocked", final=final)
                self.ticks()
                self.assertEqual(self.state(), "Done")
                self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="done"))
                self.assertEqual(self.failed(), [])

    def test_a_person_who_moved_the_legacy_block_keeps_their_state(self):
        task = self.finish_with_pr()
        self.legacy_closeout(task, "blocked")
        self.clock.now = max(self.clock.now, time.time()) + 5
        self.set_state("Todo")  # reopened by a person after the old Blocked
        self.ticks()
        self.assertEqual(self.state(), "Todo")
        self.ticks(3, after=4000)
        self.assertEqual(self.state(), "Todo")


    def test_a_legacy_wait_whose_done_the_older_build_refused_at_send_settles_with_the_same_comment(self):
        # Review of #424: the outcome comment's identity includes its text; a retry must not re-read
        # the PR state into a different body ("Native outcome comment identity conflicts").
        for note in ("", f"\n\nThe pull request changed after the work finished; its required checks passed on its "
                         f"latest commit {SHA[:12]}."):
            with self.subTest(head_moved_note=bool(note)):
                self.setUp()
                self.check_refused_at_send(note)

    def check_refused_at_send(self, note):
        from hermes_fleet_linear_plugin import bridge as bridge_module
        from hermes_fleet_linear_plugin.store import Store
        task = self.finish_with_pr()
        self.legacy_closeout(task, "in_review")
        wait = self.bridge.store.legacy_closeout("issue-1", task)
        with patch.object(bridge_module, "_pr_lines", lambda *a, **k: note):  # the older build's text
            self.assertTrue(self.bridge._finished(self.bridge.store.get("issue-1"),
                                                  event_id=self.completed_event(task), recheck=wait))
        with self.bridge.store._tx() as db:  # ... whose send-time PR re-verify refused that Done
            db.execute("UPDATE outbox SET state='failed', attempts=3, payload=json_set(json_set(payload,"
                       "'$.failure_kind','rejected'), '$.last_error', ?) WHERE kind='status' "
                       "AND json_extract(payload,'$.state')='done'", (Store.DELIVERY_REFUSAL + " (x)",))
        comment = next(row for row in self.bridge.store.pending("issue-1")
                       if row["payload"].get("native_outcome_comment"))
        self.assertIsNotNone(self.bridge.store.legacy_closeout("issue-1", task))
        self.gh.pr_state, self.gh.merged = "closed", True  # GitHub's answer has changed since
        self.ticks()
        self.assertEqual(self.state(), "Done")
        self.assertEqual(self.bridge.store.outbox_row(comment["id"])["payload"]["body"], comment["payload"]["body"])
        self.assertIsNone(self.bridge.store.legacy_closeout("issue-1", task))
        self.assertEqual([row for row in self.failed() if json.loads(row[1]).get("state") != "done"], [])

    def test_a_wait_the_older_build_settled_is_still_closed_out_as_done(self):
        # An older build settled a merged PR's wait and left the issue In Review for a person.
        task = self.finish_with_pr()
        self.legacy_closeout(task, "in_review")
        wait = self.bridge.store.legacy_closeout("issue-1", task)
        with self.bridge.store._tx() as db:
            db.execute("INSERT INTO metadata(key, value) VALUES (?, ?)",
                       (f"acceptance-recheck-settled:{wait['status_id']}", json.dumps({"settled": True})))
        self.ticks()
        self.assertEqual(self.state(), "Done")

    def test_a_person_who_moved_a_legacy_in_review_keeps_their_state(self):
        task = self.finish_with_pr()
        self.legacy_closeout(task, "in_review")
        self.bridge.flush()
        self.clock.now = max(self.clock.now, time.time()) + 5
        self.set_state("Todo")
        self.ticks()
        self.assertEqual(self.state(), "Todo")
        self.ticks(3, after=4000)
        self.assertEqual(self.state(), "Todo")


if __name__ == "__main__":
    unittest.main()
