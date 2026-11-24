"""HF-800: a worker parks on CI and the same task resumes once with the verdict.

Real native task store (Core at HERMES_AGENT_SRC), real bridge, fake Linear over HTTP and a
fake GitHub REST reader in place of ``gh api``. Run with HERMES_AGENT_SRC pointing at the clean
manifest-pinned Hermes checkout.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from linear_fake_api import Clock, FakeLinear, load_plugin

SOURCE = os.environ.get("HERMES_AGENT_SRC", "")
CORE = None
try:
    if not SOURCE:
        raise ImportError("HERMES_AGENT_SRC is not set")
    sys.path.insert(0, SOURCE)
    from hermes_cli import kanban_db as kb
except Exception as exc:
    CORE = str(exc)

plugin = load_plugin()
from hermes_fleet_linear_plugin import acceptance, waits  # noqa: E402
from hermes_fleet_linear_plugin.api import LinearAPI  # noqa: E402
from hermes_fleet_linear_plugin.bridge import Bridge, Kanban, _block_message  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402

ISSUE = "issue-800"
REPO = "switchroom/switchroom"
PR_URL = f"https://github.com/{REPO}/pull/7"
HEAD = "a" * 40
GAP = waits.CI_WAIT_GAP * 2 + 10  # past the jittered recheck gap


def rekinded(reason):
    return {"kind": "needs_input", "requested_kind": "dependency", "rekind_reason": "no_open_parent", "reason": reason}


class FakeGitHub:
    """The REST reads ``waits.ci_state`` makes, answered from settable state; every endpoint is recorded."""

    def __init__(self):
        self.calls, self.runs, self.statuses = [], [], []
        self.pr = {"state": "open", "merged": False, "head": {"sha": HEAD}}
        self.refuse = False

    def __call__(self, endpoint, *, paginate=False):
        self.calls.append(endpoint)
        if self.refuse:
            raise acceptance.Denied(f"HTTP 403 on {endpoint.split('?')[0]}", "403")
        if endpoint == f"repos/{REPO}/pulls/7":
            return self.pr
        if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha="):
            return [{"total_count": len(self.runs), "workflow_runs": self.runs}]
        if endpoint.startswith(f"repos/{REPO}/commits/") and endpoint.endswith("/status"):
            return {"state": "pending", "statuses": self.statuses}
        raise acceptance.Unavailable(f"unexpected endpoint {endpoint}")

    def run(self, run_id, name, status="completed", conclusion="success", sha=HEAD):
        self.runs = [r for r in self.runs if r["id"] != run_id] + [
            {"id": run_id, "name": name, "status": status, "conclusion": conclusion, "head_sha": sha}]


class CiGateParse(unittest.TestCase):
    def test_pr_and_commit_gates_parse_with_windows(self):
        wait = waits.parse(rekinded(f"Pushed the fix.\nCI gate: {PR_URL} within 90m\n"
                                    f"CI gate: switchroom/hermes-agent@{HEAD}."))
        self.assertEqual(wait["issues"], [])
        self.assertEqual(wait["ci"], [{"repo": REPO, "pr": 7, "sha": None, "window": 5400},
                                      {"repo": "switchroom/hermes-agent", "pr": None, "sha": HEAD,
                                       "window": waits.CI_DEFAULT_WINDOW}])
        capped = waits.parse(rekinded(f"CI gate: https://github.com/{REPO}/commit/{HEAD} within 72h"))
        self.assertEqual(capped["ci"][0]["window"], waits.CI_MAX_WINDOW)

    def test_a_ci_gate_is_a_wait_not_a_question_and_names_no_issue(self):
        kind, body = _block_message(rekinded(f"CI gate: https://github.com/acme/HF-800/pull/7"), "blocked")
        self.assertEqual(kind, "thought")
        self.assertIn("Waiting for CI on acme/HF-800 PR #7", body)
        self.assertEqual(waits.parse(rekinded("CI gate: https://github.com/acme/HF-800/pull/7"))["issues"], [])
        # A repeated wait lands in triage through the block-loop breaker; it still reads as a wait.
        self.assertEqual(_block_message(rekinded(f"CI gate: {PR_URL}"), "triage")[0], "thought")

    def test_an_unparseable_target_is_not_a_ci_wait(self):
        self.assertIsNone(waits.parse(rekinded("CI gate: the main branch")))
        self.assertIsNone(waits.parse(rekinded(f"CI gate: {REPO}@abc123")))

    def test_ci_state_classifies_runs_and_statuses_on_the_exact_head(self):
        gh, gate = FakeGitHub(), waits.parse(rekinded(f"CI gate: {PR_URL}"))["ci"][0]
        self.assertEqual(waits.ci_state(gate, gh)["state"], "pending")  # CI has not started
        gh.run(1, "CI", status="in_progress", conclusion=None)
        gh.run(2, "Old", conclusion="failure", sha="b" * 40)  # another head: ignored
        self.assertEqual(waits.ci_state(gate, gh)["state"], "pending")
        gh.run(1, "CI")
        gh.run(3, "Fleet Image", conclusion="skipped")
        self.assertEqual(waits.ci_state(gate, gh), {"state": "passed", "head": HEAD,
                                                    "lines": ["CI: success", "Fleet Image: skipped"]})
        gh.statuses = [{"context": "external", "state": "error"}]
        self.assertEqual(waits.ci_state(gate, gh)["state"], "failed")
        gh.pr = {"state": "closed", "merged": False, "head": {"sha": HEAD}}
        self.assertEqual(waits.ci_state(gate, gh)["state"], "failed")
        # Every read names the repository, so the host's per-owner gh token routing applies.
        self.assertTrue(all(call.startswith(f"repos/{REPO}/") for call in gh.calls), gh.calls)


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class CiWaitScenarios(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="linear-ci-wait-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        environment = {key: value for key, value in os.environ.items() if not key.startswith("HERMES_KANBAN_") and key != "HERMES_DELEGATED_CHILD_CONTEXT"}
        environment.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home / "board"), HERMES_PROFILE="default")
        env = patch.dict(os.environ, environment, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.github = FakeGitHub()
        gh = patch.object(acceptance, "gh_api", self.github)
        gh.start()
        self.addCleanup(gh.stop)
        self.board = Kanban(profile="default", profile_home=self.home)
        self.clock = Clock()
        self.remote = FakeLinear(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_issue(ISSUE, "HF-800", project=None)
        team = self.remote.issues[ISSUE]["team"]  # a copy: the fake's state list is shared by every test
        team["states"] = {"nodes": [*team["states"]["nodes"], {"id": "st-review", "name": "In Review", "type": "started"}]}
        self.remote.set_state(ISSUE, "Backlog")
        self.reporter = Bridge(Store(self.home / "linear.db"), LinearAPI(lambda: "synthetic", endpoint=self.remote.url, clock=self.clock),
                               self.board, profile="default", clock=self.clock)
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            self.task_id = kb.create_task(conn, title="Ship a fix", assignee="default", initial_status="blocked")
        self.reporter.track(ISSUE, self.task_id)
        self.advance(1)
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            kb.unblock_task(conn, self.task_id)
        self.reporter.pump_kanban()

    def advance(self, seconds):
        self.clock.now += seconds

    def claim(self):
        """A worker run starts, as the dispatcher would claim the ready card."""
        self.advance(1)
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            self.assertIsNotNone(kb.claim_task(conn, self.task_id))

    def park(self, reason=f"Pushed the fix; waiting for CI.\nCI gate: {PR_URL}", trail=("worker_result",)):
        """The worker's own kanban_block: its run ends and the card parks on CI.

        As in production, the worker's interpreter then exits and core records that run's
        ``worker_result`` after the park (``gateway.session_kanban._record_worker_result``)."""
        self.claim()
        self.advance(1)
        run_id = self.board.get(self.task_id).current_run_id
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            self.assertTrue(kb.block_task(conn, self.task_id, reason=reason, kind="dependency", expected_run_id=run_id))
        self.run_events(run_id, *trail)
        self.reporter.pump_kanban()
        self.advance(10)
        self.reporter.flush()

    def run_events(self, run_id, *kinds):
        """Events of one worker run, written the way core writes them."""
        with self.board.conn() as conn, kb.write_txn(conn):
            for kind in kinds:
                payload = {"pid": 4242, "claim_lock": "host:1", "exit_code": 130, "last_output": ""} if kind == "worker_result" else None
                kb._append_event(conn, self.task_id, kind, payload, run_id=run_id)

    def park_event(self):
        return [e for e in self.events() if e.kind in ("blocked", "block_loop_detected")][-1]

    def pump_after_gap(self, gap=GAP):
        self.advance(gap)
        self.reporter.pump_kanban()

    def task(self):
        return self.board.get(self.task_id)

    def events(self):
        return self.board.history(self.task_id, 0)

    def verdicts(self):
        with self.board.read_conn() as conn:
            return [c.body for c in self.board.comments(conn, self.task_id) if c.body.startswith("CI verdict:")]

    def assert_parked(self):
        task = self.task()
        self.assertIn(task.status, ("blocked", "triage"))
        self.assertIsNone(task.current_run_id)  # no worker run and no slot while parked
        self.assertIsNone(task.claim_lock)
        self.assertEqual(self.verdicts(), [])

    def assert_resumed_once_with(self, overall):
        self.assertEqual(self.task().status, "ready")
        verdicts = self.verdicts()
        self.assertEqual(len(verdicts), 1, verdicts)
        self.assertTrue(verdicts[0].startswith(f"CI verdict: {overall}"), verdicts[0])
        events = self.events()
        resume = events[-1]
        self.assertEqual(resume.kind, "unblocked")
        park = self.park_event()
        between = [e for e in events if park.id < e.id < resume.id]
        news = [e for e in between if not (e.kind in ("worker_result", "heartbeat") and e.run_id == park.run_id)]
        # The verdict was the only new event since the park, beside the parking run winding down.
        self.assertEqual([e.kind for e in news], ["commented"])
        self.assertIn("worker_result", [e.kind for e in between])
        self.pump_after_gap()  # decided once: nothing more happens
        self.assertEqual(self.events()[-1].id, resume.id)
        return verdicts[0]

    def test_park_holds_no_worker_and_reads_github_once_per_gap(self):
        self.park()
        self.assert_parked()
        self.assertEqual(self.remote.state(ISSUE), "In Review")  # waits on CI, not on a person
        bodies = self.remote.bodies(ISSUE)
        self.assertTrue(any(f"Waiting for CI on {REPO} PR #7" in body for body in bodies), bodies)
        self.assertFalse(any("Waiting on you" in body for body in bodies), bodies)
        self.github.run(1, "CI", status="in_progress", conclusion=None)
        for _ in range(3):
            self.pump_after_gap()
        reads = len(self.github.calls)
        self.assertGreater(reads, 0)
        for _ in range(5):  # pumps inside one gap ask GitHub nothing
            self.advance(5)
            self.reporter.pump_kanban()
        self.assertEqual(len(self.github.calls), reads)
        self.assert_parked()
        self.assertFalse([e for e in self.events() if e.kind in ("claimed", "spawned")
                          and e.id > [b for b in self.events() if b.kind == "blocked"][-1].id])

    def test_resumes_once_with_a_passing_verdict(self):
        self.park()
        self.github.run(1, "CI", status="in_progress", conclusion=None)
        self.pump_after_gap()
        self.assert_parked()
        self.github.run(1, "CI")
        self.github.run(2, "Fleet Image", conclusion="skipped")
        self.pump_after_gap()
        verdict = self.assert_resumed_once_with("passed")
        self.assertIn(f"{REPO} PR #7 at {HEAD}: passed", verdict)
        self.assertIn("- CI: success", verdict)
        self.reporter.flush()
        self.assertTrue(any(f"CI passed on {REPO} PR #7" in body for body in self.remote.bodies(ISSUE)))

    def test_resumes_once_with_a_failing_verdict(self):
        self.park()
        self.github.run(1, "CI", conclusion="failure")
        self.github.run(2, "Lint")
        self.pump_after_gap()
        verdict = self.assert_resumed_once_with("failed")
        self.assertIn("- CI: failure", verdict)
        self.assertIn("- Lint: success", verdict)

    def test_resumes_with_timed_out_once_the_window_passes(self):
        self.park(f"CI gate: {PR_URL} within 10m")
        self.github.run(1, "CI", status="queued", conclusion=None)
        self.pump_after_gap()
        self.pump_after_gap()
        self.assert_parked()
        self.pump_after_gap(600)
        verdict = self.assert_resumed_once_with("timed out")
        self.assertIn("pending after 10 min", verdict)
        self.assertIn("- CI: queued", verdict)

    def test_an_unreadable_github_waits_and_times_out_instead_of_guessing(self):
        self.park(f"CI gate: {PR_URL} within 5m")
        self.github.refuse = True
        self.pump_after_gap()
        self.assert_parked()
        self.pump_after_gap(400)
        verdict = self.assert_resumed_once_with("timed out")
        self.assertIn("GitHub could not be read", verdict)

    def test_stop_while_parked_wins(self):
        self.park()
        blocked = self.park_event()
        self.assertEqual(self.events()[-1].kind, "worker_result")  # the Stop lands after the run's result
        self.advance(1)
        self.assertTrue(self.board.stop(self.task_id, "linear:Stop requested"))
        self.github.run(1, "CI")
        self.pump_after_gap()
        self.pump_after_gap()
        self.assertEqual(self.task().status, "blocked")
        self.assertEqual(self.verdicts(), [])
        self.assertFalse([e for e in self.events() if e.kind == "unblocked" and e.id > blocked.id])

    def test_stop_between_the_verdict_and_the_resume_wins(self):
        self.park()
        self.github.run(1, "CI")
        original = Kanban.comment

        def comment_then_stop(adapter, task_id, body, **kwargs):
            comment_id = original(adapter, task_id, body, **kwargs)
            latest = adapter.history(task_id, 0)[-1]
            self.assertTrue(adapter.stop(task_id, "linear:Stop requested"))
            return comment_id

        with patch.object(Kanban, "comment", comment_then_stop):
            self.pump_after_gap()
        self.assertEqual(self.task().status, "blocked")
        self.assertEqual(len(self.verdicts()), 1)  # the verdict is information; the Stop still holds
        self.assertEqual(self.events()[-1].kind, "commented")  # parked work: the Stop is its newest event
        self.pump_after_gap()
        self.assertEqual(self.task().status, "blocked")

    def test_stop_between_the_read_and_the_plain_unblock_is_blocked_again(self):
        from hermes_cli import kanban_db
        self.park()
        self.github.run(1, "CI")
        original = kanban_db.unblock_task

        def stop_then_unblock(conn, task_id, *args, **kwargs):
            # A Linear Stop lands after the resume read the wait as newest, before upstream's plain unblock.
            self.assertTrue(self.board.stop(task_id, "linear:Stop requested"))
            return original(conn, task_id, *args, **kwargs)

        with patch.object(kanban_db, "unblock_task", stop_then_unblock):
            self.pump_after_gap()
        # Blocked again with the Stop's own reason (core's block-loop breaker may route that to triage).
        self.assertIn(self.task().status, ("blocked", "triage"))
        self.assertIn(self.events()[-1].kind, ("blocked", "block_loop_detected"))
        self.assertEqual(self.events()[-1].payload["reason"], "linear:Stop requested")
        self.pump_after_gap()
        self.assertIn(self.task().status, ("blocked", "triage"))
        self.assertNotEqual(self.events()[-1].kind, "unblocked")  # nothing resumed it again

    def test_revoked_scope_leaves_the_wait_for_a_person(self):
        self.park()
        self.github.run(1, "CI")
        self.github.calls.clear()  # the park itself was checked once while still authorized
        with patch.object(Bridge, "authorize_specialist_effect", return_value=False):
            self.pump_after_gap()
        self.assertEqual(self.task().status, "blocked")
        self.assertEqual(self.github.calls, [])

    def test_a_second_park_on_the_same_task_resumes_through_the_loop_breaker(self):
        self.park()
        self.github.run(1, "CI", conclusion="failure")
        self.pump_after_gap()
        self.assert_resumed_once_with("failed")
        self.github.pr = {"state": "open", "merged": False, "head": {"sha": "c" * 40}}  # the fix is pushed
        self.park()
        self.assertEqual(self.task().status, "triage")  # core's block-loop breaker
        self.assertEqual(self.park_event().kind, "block_loop_detected")
        self.assertEqual(self.events()[-1].kind, "worker_result")
        self.assertEqual(self.remote.state(ISSUE), "In Review")
        self.github.run(2, "CI", sha="c" * 40)
        self.pump_after_gap()
        self.assertEqual(self.task().status, "ready")
        verdicts = self.verdicts()
        self.assertEqual(len(verdicts), 2)
        self.assertIn(f"at {'c' * 40}: passed", verdicts[-1])

    def test_resumes_with_the_parking_runs_heartbeat_and_result_after_the_park(self):
        # HF-822: core records the worker's late heartbeat and its exit after the block; neither is new.
        self.park(trail=("heartbeat", "worker_result"))
        self.assertEqual([e.kind for e in self.events()[-3:]], ["blocked", "heartbeat", "worker_result"])
        self.github.run(1, "CI")
        self.pump_after_gap()
        self.assert_resumed_once_with("passed")

    def test_a_comment_after_the_worker_result_still_holds_the_park(self):
        self.park()
        self.advance(1)
        with self.board.conn() as conn:
            kb.add_comment(conn, self.task_id, "operator", "Hold on, do not resume yet.")
        self.github.run(1, "CI")
        self.pump_after_gap()
        self.pump_after_gap()
        self.assert_parked()
        self.assertEqual(self.events()[-1].kind, "commented")

    def test_an_event_outside_the_parking_run_still_holds_the_park(self):
        self.park()
        self.run_events(None, "heartbeat")  # not the parking run's own wind-down
        self.github.run(1, "CI")
        self.pump_after_gap()
        self.pump_after_gap()
        self.assert_parked()

    def test_a_late_worker_result_beside_the_verdict_still_resumes(self):
        # The run's result lands after the verdict comment, before the guarded resume.
        self.park(trail=())
        park_run = self.park_event().run_id
        self.github.run(1, "CI")
        original = Kanban.comment

        def comment_then_exit(adapter, task_id, body, **kwargs):
            comment_id = original(adapter, task_id, body, **kwargs)
            self.run_events(park_run, "worker_result")
            return comment_id

        with patch.object(Kanban, "comment", comment_then_exit):
            self.pump_after_gap()
        self.assertEqual(self.task().status, "ready")
        self.assertEqual([e.kind for e in self.events()[-4:]], ["blocked", "commented", "worker_result", "unblocked"])
        self.assertEqual(len(self.verdicts()), 1)

    def test_issue_and_ci_conditions_must_both_hold(self):
        self.remote.add_issue("issue-646", "LIFE-646", project=None)
        self.park(f"Waiting on LIFE-646 and CI.\nCI gate: {PR_URL}")
        self.github.run(1, "CI")
        self.pump_after_gap()
        self.assert_parked()
        self.remote.set_state("issue-646", "Done")
        self.pump_after_gap()
        self.assert_resumed_once_with("passed")


if __name__ == "__main__":
    unittest.main()
