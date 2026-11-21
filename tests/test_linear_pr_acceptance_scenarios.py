"""Finished work whose PR GitHub would not let the gateway check (live LIFE-584 and peers).

The gateways' fine-grained GitHub token has no checks:read: core's exact-head
verifier is refused at check-runs (HTTP 403) although pull requests and Actions
read fine. Real pinned Core tasks and verifier, the plugin Store and the HTTP
fake Linear run the current entrypoints; one fake ``gh`` answers both Core and
the plugin, at the subprocess boundary.
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
SUMMARY = f"Fixed the receipts drill-down and merged {PR}."
# What plugin f4665ce8 wrote for those issues (only the PR and SHA differ).
LEGACY_BODY = (f"The work finished, but its pull request could not be verified as ready ({PR}: auth: GitHub refused the "
               f"acceptance read (HTTP 403 on repos/{REPO}/commits/{SHA}/check-runs) as the ambient gh login; fix that "
               "profile's GitHub credentials/access to the repository, then retry completion.). The issue stays open "
               "until the PR's required checks pass on its latest commit.")


class FakeGh:
    """``gh api`` for one private repository whose token cannot read the Checks API."""

    def __init__(self):
        self.calls = []
        self.pr_state, self.merged, self.sha, self.head_repo = "closed", True, SHA, REPO
        self.job = ("completed", "success")
        self.actions_refused = False
        self.graphql_refused = False  # an organization token policy refuses GraphQL; REST still answers
        self.fail_jobs_reads: set[int] = set()  # which jobs reads (1-based) GitHub answers with a 502
        self.real_run = subprocess.run

    def run(self, command, *args, **kwargs):
        if not (isinstance(command, list) and command[:2] == ["gh", "api"]):
            return self.real_run(command, *args, **kwargs)
        endpoint = command[2]
        self.calls.append(endpoint)
        if endpoint == "graphql" and self.graphql_refused:
            # The live shape: gh exits 1 with a policy message and no HTTP code, so core reports
            # infra with no head commit and nothing for the Actions fallback to start from.
            raise subprocess.CalledProcessError(1, command, output="", stderr=(
                "gh: The organization forbids access via a fine-grained personal access token "
                "if the token's lifetime is greater than 366 days."))
        reply = self.reply(endpoint)
        if isinstance(reply, int):
            raise subprocess.CalledProcessError(1, command, output="", stderr=(
                f"gh: Resource not accessible by personal access token (HTTP {reply})" if reply < 500
                else f"gh: Bad Gateway (HTTP {reply})"))
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(reply), stderr="")

    def reply(self, endpoint):
        state = "MERGED" if self.merged else ("CLOSED" if self.pr_state == "closed" else "OPEN")
        sha = self.sha
        if endpoint == "graphql":
            return {"data": {"repository": {"pullRequest": {"headRefOid": sha, "baseRefName": "main", "state": state,
                    "baseRef": {"branchProtectionRule": {"requiredStatusChecks": [
                        {"context": "Backend Pytest", "app": {"databaseId": 15368}}]}}}}}}
        if endpoint.startswith(f"repos/{REPO}/rules/branches/main"):
            return [[]]
        if "/check-runs" in endpoint:
            return 403  # the fine-grained token lacks checks:read
        if endpoint == f"repos/{REPO}/pulls/7":
            return {"state": self.pr_state, "merged": self.merged, "base": {"ref": "main"},
                    "head": {"sha": sha, "ref": "fix/receipts", "repo": {"full_name": self.head_repo}}}
        if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha={sha}"):
            if self.actions_refused:
                return 403
            return [{"total_count": 1, "workflow_runs": [{"id": 41, "head_sha": sha, "event": "pull_request",
                     "path": ".github/workflows/backend-tests.yml", "run_attempt": 1, "status": "completed",
                     "head_repository": {"full_name": self.head_repo}}]}]
        if endpoint.startswith(f"repos/{REPO}/contents/.github/workflows/backend-tests.yml?ref=main"):
            return {"type": "file", "path": ".github/workflows/backend-tests.yml"}
        if endpoint.startswith(f"repos/{REPO}/actions/runs/41/jobs"):
            if sum("/actions/runs/41/jobs" in call for call in self.calls) in self.fail_jobs_reads:
                return 502
            status, conclusion = self.job
            return [{"total_count": 1, "jobs": [{"id": 9, "name": "Backend Pytest", "status": status,
                     "conclusion": conclusion, "run_attempt": 1, "head_sha": sha}]}]
        return 404


@unittest.skipUnless(os.environ.get("HERMES_AGENT_SRC"), "requires explicit native source")
class PrAcceptanceFallbackScenarios(unittest.TestCase):
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

    def legacy_closeout(self):
        """What plugin f4665ce8 did: no fallback, and an auth refusal closed out as terminal Blocked."""
        from hermes_fleet_linear_plugin import acceptance, bridge
        self.clock.now = max(self.clock.now, time.time()) + 2
        with patch.object(acceptance, "settle", lambda receipt, url, **_: receipt), \
                patch.object(acceptance, "unverified", lambda receipt: False), \
                patch.object(bridge, "acceptance_refusal", lambda failures, where="chat": LEGACY_BODY):
            self.bridge.pump_kanban()  # the old build captures the completion as Blocked ...
            with self.bridge.store._tx() as db:  # ... without this build's final-answer mark ...
                db.execute("UPDATE outbox SET payload=json_remove(payload,'$.acceptance_final')")
            self.bridge.flush()  # ... and sends it
        self.assertEqual(self.state(), "Blocked")
        self.assertIn(LEGACY_BODY, self.said())

    def status_rows(self):
        with self.bridge.store._tx() as db:
            return [json.loads(row[0]) for row in db.execute(
                "SELECT payload FROM outbox WHERE kind='status' ORDER BY rowid")]

    def said(self):
        return self.remote.bodies("issue-1")

    def test_refused_checks_read_is_proved_from_actions_and_is_done(self):
        self.finish_with_pr()
        self.ticks()
        self.assertEqual(self.state(), "Done")
        self.assertTrue(any("/check-runs" in call for call in self.gh.calls))  # core asked and was refused
        self.assertTrue(any("/actions/runs/41/jobs" in call for call in self.gh.calls))
        self.assertNotIn("blocked", [row["state"] for row in self.status_rows()])
        self.assertFalse(any("could not be verified" in body for body in self.said()))
        self.assertEqual(self.failed(), [])

    def test_undecided_fallback_waits_in_review_then_reaches_done(self):
        task = self.finish_with_pr()
        self.gh.actions_refused = True
        self.ticks()
        self.assertEqual(self.state(), "In Review")
        waiting = [body for body in self.said() if "checks again by itself" in body]
        self.assertEqual(len(waiting), 1, self.said())
        self.assertIn(PR, waiting[0])
        self.assertFalse(self.bridge.store.terminal_captured(task, issue_id="issue-1"))
        # No polling storm: within the gap, ticks make no GitHub reads and no Linear writes.
        calls, writes = len(self.gh.calls), len(self.mutations())
        self.ticks(10, after=60)
        self.assertEqual((len(self.gh.calls), len(self.mutations())), (calls, writes))
        # Still refused after the gap: one more pass, then a longer wait, and nothing new in Linear.
        self.ticks(1, after=600)
        self.assertGreater(len(self.gh.calls), calls)
        self.assertEqual(self.state(), "In Review")
        self.assertEqual(len(self.said()), len(set(self.said())))
        calls = len(self.gh.calls)
        self.ticks(5, after=30)
        self.assertEqual(len(self.gh.calls), calls)
        # GitHub answers again: the next recheck closes it out as Done.
        self.gh.actions_refused = False
        self.ticks(3, after=4000)
        self.assertEqual(self.state(), "Done")
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="done"))
        calls = len(self.gh.calls)
        self.ticks(3, after=4000)
        self.assertEqual(len(self.gh.calls), calls)  # nothing left to recheck
        self.assertEqual(self.failed(), [])

    def test_running_checks_wait_in_review_and_a_later_failure_is_blocked(self):
        task = self.finish_with_pr()
        self.gh.job = ("in_progress", None)
        self.ticks()
        self.assertEqual(self.state(), "In Review")
        self.assertTrue(any("have not finished yet" in body for body in self.said()))
        self.gh.job = ("completed", "failure")
        self.ticks(3, after=4000)
        self.assertEqual(self.state(), "Blocked")
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="blocked"))
        self.assertTrue(any("could not be verified as ready" in body and "Backend Pytest" in body for body in self.said()))
        calls = len(self.gh.calls)
        self.ticks(3, after=4000)
        self.assertEqual(len(self.gh.calls), calls)

    def test_failed_check_stays_blocked_and_is_not_rechecked(self):
        task = self.finish_with_pr()
        self.gh.job = ("completed", "failure")
        self.ticks()
        self.assertEqual(self.state(), "Blocked")
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="blocked"))
        self.assertFalse(any("checks again by itself" in body for body in self.said()))
        calls, writes = len(self.gh.calls), len(self.mutations())
        self.gh.job = ("completed", "success")
        self.ticks(3, after=4000)
        self.assertEqual((len(self.gh.calls), len(self.mutations())), (calls, writes))
        self.assertEqual(self.state(), "Blocked")

    def test_pr_closed_without_merge_stays_blocked(self):
        self.finish_with_pr()
        self.gh.pr_state, self.gh.merged = "closed", False
        self.ticks()
        self.assertEqual(self.state(), "Blocked")
        self.assertTrue(any("closed without being merged" in body for body in self.said()))

    def test_existing_auth_blocked_closeout_heals_to_done(self):
        task = self.finish_with_pr()
        self.legacy_closeout()
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="blocked"))
        # Deployed: the next pump rechecks that closeout once and heals it, without a manual Linear write.
        self.ticks()
        self.assertEqual(self.state(), "Done")
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="done"))
        self.assertEqual(sum("merged" in body and "could not be verified" not in body for body in self.said()), 1)
        calls = len(self.gh.calls)
        self.ticks(3, after=4000)
        self.assertEqual(len(self.gh.calls), calls)
        self.assertEqual(self.failed(), [])

    def test_existing_auth_blocked_closeout_with_a_failed_check_is_left_and_settled(self):
        self.finish_with_pr()
        self.legacy_closeout()
        self.gh.job = ("completed", "failure")
        said, writes = list(self.said()), len(self.mutations())
        self.ticks()
        self.assertEqual((self.state(), self.said(), len(self.mutations())), ("Blocked", said, writes))
        calls = len(self.gh.calls)
        self.ticks(3, after=4000)
        self.assertEqual(len(self.gh.calls), calls)  # settled: asked once, not again

    def test_human_move_after_the_legacy_block_wins(self):
        self.finish_with_pr()
        self.legacy_closeout()
        self.clock.now = max(self.clock.now, time.time()) + 5
        self.set_state("Todo")  # Ken reopened it himself
        self.ticks()
        self.assertEqual(self.state(), "Todo")


    def wait_in_review(self):
        task = self.finish_with_pr()
        self.gh.actions_refused = True
        self.ticks()
        self.assertEqual(self.state(), "In Review")
        self.gh.actions_refused = False
        return task

    def test_transient_github_failure_when_done_is_sent_retries_and_reaches_done(self):
        # Review round 1, probe 1: the recheck passes, then GitHub fails once at the send-time re-verify.
        task = self.wait_in_review()
        reads = sum("/actions/runs/41/jobs" in call for call in self.gh.calls)
        self.gh.fail_jobs_reads = {reads + 2}  # the recheck's read passes, the send-time read gets a 502
        self.ticks(1, after=4000)
        self.assertEqual(self.state(), "In Review")
        self.assertEqual(self.failed(), [])  # retryable, not rejected
        with self.bridge.store._tx() as db:
            retried = db.execute("SELECT attempts FROM outbox WHERE kind='status' AND state='pending' "
                                 "AND json_extract(payload,'$.state')='done'").fetchall()
        self.assertEqual([row[0] for row in retried], [1])
        self.ticks(3, after=4000)
        self.assertEqual(self.state(), "Done")
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="done"))
        self.assertEqual(self.failed(), [])

    def test_done_rejected_at_send_resumes_the_wait_and_reaches_done(self):
        task = self.wait_in_review()
        from hermes_fleet_linear_plugin import bridge
        original, calls = bridge.Bridge.accepted_evidence, []

        def flaky(this, *args, **kwargs):  # one definite-looking refusal at send time only
            calls.append(1)
            if len(calls) == 2:
                kwargs.get("failures", []).append("synthetic refusal")
                return False
            return original(this, *args, **kwargs)
        with patch.object(bridge.Bridge, "accepted_evidence", flaky):
            self.ticks(1, after=4000)
        self.assertEqual(self.state(), "In Review")
        self.assertEqual(len(self.failed()), 1)  # that Done row failed for good ...
        self.ticks(3, after=4000)  # ... and the wait it ended picks up again
        self.assertEqual(self.state(), "Done")
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="done"))

    def test_fork_pr_is_blocked_with_a_plain_reason_and_not_rechecked(self):
        # Review round 1, probe 2: a fork is a definite answer, not "couldn't ask GitHub".
        task = self.finish_with_pr()
        self.gh.head_repo = "mallory/app"
        self.ticks()
        self.assertEqual(self.state(), "Blocked")
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="blocked"))
        said = [body for body in self.said() if "could not be verified as ready" in body]
        self.assertEqual(len(said), 1)
        self.assertIn("comes from a fork", said[0])
        self.assertFalse(any("checks again by itself" in body for body in self.said()))
        calls = len(self.gh.calls)
        for _ in range(6):
            self.ticks(1, after=4000)
        self.assertEqual(len(self.gh.calls), calls)

    def test_no_answer_for_seven_days_goes_to_blocked_and_stops(self):
        task = self.finish_with_pr()
        self.gh.actions_refused = True
        self.ticks()
        self.assertEqual(self.state(), "In Review")
        for _ in range(8 * 24):  # hourly-capped rechecks across eight days
            self.ticks(1, after=3600)
            if self.state() != "In Review":
                break
        self.assertEqual(self.state(), "Blocked")
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="blocked"))
        self.assertTrue(any("could not be confirmed within 7 days" in body for body in self.said()))
        calls = len(self.gh.calls)
        self.ticks(3, after=4000)
        self.assertEqual(len(self.gh.calls), calls)

    def test_head_moved_during_the_wait_is_verified_on_the_new_head_and_said(self):
        task = self.wait_in_review()
        self.gh.sha = "d" * 40  # someone pushed to the PR while it waited
        self.ticks(3, after=4000)
        self.assertEqual(self.state(), "Done")
        done = [body for body in self.said() if "changed after the work finished" in body]
        self.assertEqual(len(done), 1)
        self.assertIn("d" * 12, done[0])
        self.assertTrue(any(f"head_sha={'d' * 40}" in call for call in self.gh.calls))
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1", state="done"))

    def test_delegate_removed_during_the_wait_leaves_the_issue_to_the_person(self):
        self.wait_in_review()
        self.clock.now = max(self.clock.now, time.time()) + 5
        self.remote.set_delegate("issue-1", {"id": "other-agent"}, actor="human-1")
        writes = len(self.mutations())
        self.ticks(3, after=4000)
        self.assertEqual(self.state(), "In Review")
        self.assertEqual(len(self.mutations()), writes)
        self.assertFalse(any("Fixed the receipts" in body for body in self.said()))
        calls = len(self.gh.calls)
        self.ticks(3, after=4000)
        self.assertEqual(len(self.gh.calls), calls)

    # -- review round 2 probes ---------------------------------------------

    def done_rows(self):
        with self.bridge.store._tx() as db:
            return [tuple(row) for row in db.execute(
                "SELECT state, json_extract(payload,'$.failure_kind') FROM outbox WHERE kind='status' "
                "AND json_extract(payload,'$.state')='done' ORDER BY rowid")]

    def test_done_linear_refuses_for_good_ends_the_wait_without_a_storm(self):
        # Blocker: Linear refuses the Done write (non-retryable) -> no re-check / re-write loop.
        self.wait_in_review()
        from hermes_fleet_linear_plugin.api import LinearError
        api, done_state = self.bridge.api, self.bridge.state_id(self.fixture.issue, "done")
        original = api.update_issue

        def refuse(issue_id, fields, *args, **kwargs):
            if fields.get("stateId") == done_state:
                raise LinearError("synthetic Linear refusal", retryable=False)
            return original(issue_id, fields, *args, **kwargs)
        with patch.object(api, "update_issue", refuse):
            self.ticks(1, after=4000)
            self.assertEqual(self.done_rows(), [("failed", "rejected")])
            calls = len(self.gh.calls)
            for _ in range(10):
                self.ticks(1, after=5)
            for _ in range(10):
                self.ticks(1, after=4000)
            self.assertEqual(len(self.gh.calls), calls)  # bounded: not one more GitHub read
        self.assertEqual(self.done_rows(), [("failed", "rejected")])
        self.assertEqual(self.state(), "In Review")

    def test_person_moves_the_wait_to_blocked_and_it_stays_theirs(self):
        self.wait_in_review()
        self.clock.now = max(self.clock.now, time.time()) + 5
        self.set_state("Blocked")
        self.ticks(3, after=4000)
        self.assertEqual(self.state(), "Blocked")
        calls = len(self.gh.calls)
        self.ticks(3, after=4000)
        self.assertEqual(len(self.gh.calls), calls)

    def test_person_moves_a_legacy_block_and_nothing_rechecks(self):
        self.finish_with_pr()
        self.legacy_closeout()
        self.clock.now = max(self.clock.now, time.time()) + 5
        self.set_state("Todo")
        self.ticks()
        calls = len(self.gh.calls)
        for _ in range(6):
            self.ticks(1, after=4000)
        self.assertEqual((self.state(), len(self.gh.calls)), ("Todo", calls))

    def test_open_pr_with_only_untrusted_runs_waits_in_review(self):
        self.gh.pr_state, self.gh.merged = "open", False
        reply = self.gh.reply

        def dispatch_only(endpoint):
            answer = reply(endpoint)
            if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha=") and isinstance(answer, list):
                answer = [{**page, "workflow_runs": [{**run, "event": "workflow_dispatch"}
                                                     for run in page["workflow_runs"]]} for page in answer]
            return answer
        self.gh.reply = dispatch_only
        self.finish_with_pr()
        self.ticks()
        self.assertEqual(self.state(), "In Review")
        self.assertTrue(any("have not finished yet" in body for body in self.said()))

    def test_cancelled_or_skipped_or_failed_check_is_final_and_plain(self):
        for conclusion in ("cancelled", "skipped", "failure"):
            with self.subTest(conclusion=conclusion):
                self.setUp()
                task = self.finish_with_pr()
                self.gh.job = ("completed", conclusion)
                self.ticks()
                self.assertEqual(self.state(), "Blocked")
                said = [body for body in self.said() if "could not be verified as ready" in body]
                self.assertEqual(len(said), 1)
                self.assertIn(f"required check Backend Pytest ended as {conclusion}", said[0])
                for label in ("infra:", "failure:", "source actions", "(conclusion"):
                    self.assertNotIn(label, said[0])
                self.assertIsNone(self.bridge.store.acceptance_recheck("issue-1", task))
                jobs_reads = sum("/jobs" in call for call in self.gh.calls)
                self.gh.job = ("completed", "success")  # someone re-ran it green later
                self.ticks(3, after=4000)
                self.assertEqual(self.state(), "Blocked")
                self.assertEqual(sum("/jobs" in call for call in self.gh.calls), jobs_reads)

    # -- HF-794: a wait whose condition already cleared ---------------------------

    def finish_in_session(self, session="review-session"):
        """Finished work reported in an adopted Agent Session, whose PR checks GitHub will not show."""
        task, run = self.task(claim=True)
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        self.remote.session_records[session] = {"id": session, "creator": None,
                                                "appUser": {"id": SELF}, "issue": {"id": "issue-1"}}
        event = self.remote.session_event("created", "issue-1", session, creator=None)
        event["agentSession"].pop("creatorId")
        self.assertTrue(self.bridge.handle_webhook(event))
        self.bridge.flush()
        self.assertEqual(self.bridge.store.get("issue-1")["owner_ref"], session)
        self.gh.graphql_refused = True
        self.assertTrue(self.native("complete_task", task, summary=SUMMARY, expected_run_id=run))
        self.ticks()
        self.assertEqual(self.state(), "In Review")
        self.assertIsNotNone(self.bridge.store.acceptance_recheck("issue-1", task))
        return task

    def verifying(self):
        return [a for a in self.remote.activities
                if a.get("issueId") == "issue-1" and a["content"].get("action") == "Verifying"]

    def keepalive_pass(self):
        """Half an hour on: the recheck pump, then the full recheck pass that owns keepalives."""
        self.ticks(1, after=30 * 60)
        self.bridge.recheck(force=True)
        self.bridge.flush()

    def test_merged_pr_whose_checks_cannot_be_read_stops_verifying(self):
        task = self.finish_in_session()
        self.keepalive_pass()
        self.assertIsNone(self.bridge.store.acceptance_recheck("issue-1", task))
        for _ in range(4):
            self.keepalive_pass()
        self.assertEqual(self.verifying(), [])
        merged = [body for body in self.said() if "was merged" in body]
        self.assertEqual(len(merged), 1, self.said())
        self.assertIn(PR, merged[0])
        # Settled for good: no further GitHub reads, and no Blocked at the 7-day cap.
        calls = len(self.gh.calls)
        self.ticks(3, after=8 * 86400)
        self.assertEqual(len(self.gh.calls), calls)
        self.assertEqual(self.state(), "In Review")
        self.assertFalse(any("could not be confirmed within 7 days" in body for body in self.said()))
        self.assertEqual(self.failed(), [])

    def test_open_pr_whose_checks_cannot_be_read_still_says_verifying(self):
        self.gh.pr_state, self.gh.merged = "open", False
        task = self.finish_in_session()
        self.keepalive_pass()
        self.assertEqual(self.state(), "In Review")
        self.assertIsNotNone(self.bridge.store.acceptance_recheck("issue-1", task))
        self.assertEqual(len(self.verifying()), 1)
        self.assertFalse(any("was merged" in body for body in self.said()))

    def test_issue_closed_by_a_person_settles_the_wait(self):
        for state, merged in (("Done", False), ("Canceled", False), ("Done", True)):
            with self.subTest(state=state, merged=merged):
                self.setUp()
                self.gh.pr_state, self.gh.merged = ("closed", True) if merged else ("open", False)
                task = self.finish_in_session()
                self.clock.now = max(self.clock.now, time.time()) + 5
                self.set_state(state)
                writes = len(self.mutations())
                self.keepalive_pass()
                self.assertIsNone(self.bridge.store.acceptance_recheck("issue-1", task))
                self.assertEqual(self.verifying(), [])
                calls = len(self.gh.calls)
                for _ in range(3):
                    self.keepalive_pass()
                self.ticks(3, after=8 * 86400)
                self.assertEqual(len(self.gh.calls), calls)
                self.assertEqual((self.state(), len(self.mutations())), (state, writes))
                self.assertEqual(self.verifying(), [])

    def test_a_wait_that_cannot_write_is_settled_at_the_cap(self):
        # A recheck that keeps ending as effect_unresolved still stops after 7 days.
        self.wait_in_review()
        from hermes_fleet_linear_plugin import bridge
        rechecks = []
        original = bridge.Bridge._finished

        def unresolved(this, row, **kwargs):
            if kwargs.get("recheck") is not None:
                rechecks.append(1)
                return None
            return original(this, row, **kwargs)
        with patch.object(bridge.Bridge, "_finished", unresolved):
            for _ in range(8 * 24):
                self.ticks(1, after=3600)
            self.assertEqual(self.state(), "Blocked")
            self.assertTrue(any("could not be confirmed within 7 days" in body for body in self.said()))
            asked = len(rechecks)
            self.assertLess(asked, 8 * 24)
            for _ in range(48):
                self.ticks(1, after=3600)
            self.assertEqual(len(rechecks), asked)


if __name__ == "__main__":
    unittest.main()
