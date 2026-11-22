"""Work the open-PR respawn guard parks after a restart (HF-628).

Older Core dispatchers park a ready card whose comments name a GitHub PR from
the last 24 h: status ``blocked`` with a ``blocked`` event ``{kind: needs_input,
source: respawn_guard}``. Nothing is needed from a person, so Linear shows In
Review, not Blocked, and once the PR merges or closes the plugin lets the card
run with one guarded unblock of exactly that park. Real pinned Core tasks, the
plugin Store and the HTTP fake Linear run the current entrypoints; a fake
``gh`` answers at the subprocess boundary.
"""
import inspect
import json
import os
import subprocess
import time
import unittest
import uuid
from unittest.mock import patch

import test_linear_delegate_routing_scenarios as routing
from linear_fake_api import SELF, STATES

IN_REVIEW = {"id": "st-review", "name": "In Review", "type": "started"}
REPO = "acme/app"
PR = f"https://github.com/{REPO}/pull/7"
PARKED = ("Paused after a restart while PR #7 is open. It resumes by itself when the PR merges or closes; "
          "ask the agent to resume if it should continue now.")


def core_guard_wait():
    """Core's respawn guard module, if available."""
    try:
        from hermes_cli import kanban_db_guard_wait
    except ImportError:
        return None
    return kanban_db_guard_wait


class FakeGh:
    """``gh api`` for one pull request: open, merged, closed, refused or not answering."""

    def __init__(self):
        self.calls = []
        self.state, self.merged = "open", False
        self.refuse: int | None = None  # an HTTP status GitHub answers the PR read with
        self.real_run = subprocess.run

    def run(self, command, *args, **kwargs):
        if not (isinstance(command, list) and command[:2] == ["gh", "api"]):
            return self.real_run(command, *args, **kwargs)
        endpoint = command[2]
        self.calls.append(endpoint)
        if endpoint != f"repos/{REPO}/pulls/7":
            reply = 404
        else:
            reply = self.refuse or {"state": self.state, "merged": self.merged, "number": 7}
        if isinstance(reply, int):
            raise subprocess.CalledProcessError(1, command, output="", stderr=(
                f"gh: Resource not accessible by personal access token (HTTP {reply})" if reply < 500
                else f"gh: Bad Gateway (HTTP {reply})"))
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(reply), stderr="")


@unittest.skipUnless(os.environ.get("HERMES_AGENT_SRC"), "requires explicit native source")
class PrParkScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = routing.DelegateRoutingScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.remote.history.pop("issue-1", None)
        self.clock = self.fixture.fixture.clock
        self.clock.now = time.time() - 5
        self.fixture.remote.set_delegate("issue-1", {"id": SELF}, actor=SELF)
        self.fixture.issue["team"]["states"]["nodes"] = [*STATES, IN_REVIEW]
        self.bridge, self.board, self.remote = self.fixture.bridge, self.fixture.board, self.fixture.remote
        self.gh = FakeGh()
        runner = patch("subprocess.run", self.gh.run)
        runner.start()
        self.addCleanup(runner.stop)

    def native(self, action, *args, **kwargs):
        with self.board.conn() as db:
            return getattr(self.board.kb, action)(db, *args, **kwargs)

    def ticks(self, count=3, *, after=2.0):
        self.clock.now = max(self.clock.now, time.time()) + after
        for _ in range(count):
            self.bridge.pump_kanban()
            self.bridge.flush()

    def state(self):
        return self.remote.state("issue-1")

    def said(self):
        return self.remote.bodies("issue-1")

    def events(self, task, kind=None):
        return [event for event in self.board.history(task, 0) if kind is None or event.kind == kind]

    def task(self):
        """A bound ready card whose worker opened a PR, before the dispatcher looks at it."""
        with self.board.conn() as db:
            task = self.board.kb.create_task(db, title="Native work", board=self.board.board,
                assignee=self.board.executor_profile, created_by="operator",
                body="Linear issue issue-1: " + self.fixture.issue["url"])
        self.bridge.track("issue-1", task, completion_scope="outcome")
        self.ticks()
        self.native("add_comment", task, "worker", f"Opened {PR} for review.")
        return task

    def park(self, task):
        """Create the legacy park state Linear can encounter after an upgrade."""
        guard_wait = core_guard_wait()
        reason = "waiting for PR #7 to merge"
        with self.board.conn() as db:
            if guard_wait is None:  # Core predates the park writer.
                with self.board.kb.write_txn(db):
                    db.execute("UPDATE tasks SET status = 'blocked' WHERE id = ?", (task,))
                    self.board.kb._append_event(db, task, "blocked", {
                        "reason": reason, "kind": "needs_input", "source": "respawn_guard"})
            elif "lane" in inspect.signature(guard_wait.record_respawn_guard).parameters:
                guard_wait.record_respawn_guard(db, task, "active_pr", lane="ready")
            else:
                from hermes_cli.kanban_db_controls import _block_task

                # Recreate the legacy task, event and run via the original park writer's block path.
                last_event_id = db.execute("SELECT MAX(id) FROM task_events WHERE task_id = ?", (task,)).fetchone()[0]
                stop_kwargs = {"stops": []} if "stops" in inspect.signature(_block_task).parameters else {}
                self.assertTrue(_block_task(
                    db, task, reason=reason, kind="needs_input", expected_run_id=None,
                    expected_event_id=last_event_id, count_recurrence=False, source="respawn_guard", **stop_kwargs,
                ))
        park = self.events(task)[-1]
        blocked_task = self.board.get(task)
        self.assertEqual((park.kind, park.payload.get("source"), blocked_task.status),
                         ("blocked", "respawn_guard", "blocked"))
        if guard_wait is not None:
            self.assertEqual((blocked_task.block_kind, blocked_task.block_recurrences), ("needs_input", 0))
            self.assertEqual((park.payload.get("source_status"), park.payload.get("recurrences")), ("ready", 0))
            self.assertIsNotNone(park.run_id)
            run = self.native("get_run", park.run_id)
            self.assertIsNotNone(run)
            self.assertEqual((run.task_id, run.status, run.outcome), (task, "blocked", "blocked"))
            self.assertIsNotNone(run.ended_at)
        return park

    def parked(self):
        task = self.task()
        park = self.park(task)
        self.ticks()
        return task, park

    def own_unblocks(self, task, park):
        request = self.board.activation_request_id(task, park.id)
        return [event for event in self.events(task, "unblocked") if (event.payload or {}).get("request_id") == request]

    def later(self, seconds=3700):
        self.clock.now = max(self.clock.now, time.time()) + seconds
        self.ticks()

    def test_park_shows_in_review_with_one_plain_sentence(self):
        task, _ = self.parked()
        self.assertEqual(self.state(), "In Review")
        self.assertEqual(self.board.get(task).status, "blocked")
        self.assertEqual([body for body in self.said() if "PR #7" in body], [PARKED])
        self.assertFalse(any(body.startswith("Waiting on you") for body in self.said()))
        self.ticks()
        self.assertEqual([body for body in self.said() if "PR #7" in body], [PARKED])

    def test_merged_pr_resumes_the_park_once(self):
        task, park = self.parked()
        self.gh.state, self.gh.merged = "closed", True
        self.later()
        self.assertEqual(len(self.own_unblocks(task, park)), 1)
        self.assertEqual(self.board.get(task).status, "ready")
        reads = len(self.gh.calls)
        self.later()
        self.later()
        self.assertEqual(len(self.events(task, "unblocked")), 1)
        self.assertEqual(len(self.gh.calls), reads)

    def test_pr_closed_without_merging_resumes_the_park_once(self):
        task, park = self.parked()
        self.gh.state, self.gh.merged = "closed", False
        self.later()
        self.assertEqual(len(self.own_unblocks(task, park)), 1)
        self.later()
        self.assertEqual(len(self.events(task, "unblocked")), 1)

    def test_open_pr_stays_parked_and_is_asked_on_a_widening_gap(self):
        task, _ = self.parked()
        self.assertEqual(self.gh.calls, [f"repos/{REPO}/pulls/7"])
        self.ticks()
        self.ticks()
        self.assertEqual(len(self.gh.calls), 1)  # The gap is taken before asking: no read per tick.
        self.later()
        self.assertEqual(len(self.gh.calls), 2)
        self.assertEqual(self.events(task, "unblocked"), [])
        self.assertEqual(self.board.get(task).status, "blocked")
        self.assertEqual(self.state(), "In Review")

    def test_refused_github_stays_parked_until_it_answers(self):
        self.gh.refuse, self.gh.state, self.gh.merged = 403, "closed", True
        task, park = self.parked()
        self.later()
        self.assertGreaterEqual(len(self.gh.calls), 2)
        self.assertEqual(self.events(task, "unblocked"), [])
        self.assertEqual(self.board.get(task).status, "blocked")
        self.assertEqual(self.state(), "In Review")
        self.gh.refuse = None  # Once GitHub answers, the next gap resumes it.
        self.later()
        self.assertEqual(len(self.own_unblocks(task, park)), 1)

    def test_unanswered_github_stays_parked(self):
        self.gh.refuse, self.gh.state, self.gh.merged = 502, "closed", True
        task, _ = self.parked()
        self.later()
        self.assertTrue(self.gh.calls)
        self.assertEqual(self.events(task, "unblocked"), [])
        self.assertEqual(self.board.get(task).status, "blocked")

    def test_a_person_waiting_block_is_never_touched(self):
        task = self.task()
        self.assertTrue(self.native("block_task", task, reason="Need the deploy key from Sam", kind="needs_input"))
        self.gh.state, self.gh.merged = "closed", True
        self.ticks()
        self.later()
        self.assertEqual(self.state(), "Blocked")
        self.assertEqual(self.events(task, "unblocked"), [])
        self.assertEqual(self.gh.calls, [])

    def test_a_handoff_pause_is_never_touched(self):
        task = self.task()
        reason = f"Paused for a handover to Other Agent [handoff:{uuid.uuid4()}]"
        self.assertTrue(self.native("block_task", task, reason=reason, kind="needs_input"))
        self.gh.state, self.gh.merged = "closed", True
        self.ticks()
        self.later()
        self.assertEqual(self.state(), "Blocked")
        self.assertEqual(self.events(task, "unblocked"), [])
        self.assertEqual(self.gh.calls, [])

    def test_park_with_a_newer_event_is_left_alone(self):
        task, _ = self.parked()
        self.native("add_comment", task, "operator", "Holding this until the release window.")
        self.gh.state, self.gh.merged = "closed", True
        reads = len(self.gh.calls)
        self.later()
        self.assertEqual(self.events(task, "unblocked"), [])
        self.assertEqual(self.board.get(task).status, "blocked")
        self.assertEqual(len(self.gh.calls), reads)

    def test_core_self_release_is_not_followed_by_a_second_unblock(self):
        guard_wait = core_guard_wait()
        task, _ = self.parked()
        with self.board.conn() as db:  # The PR comment ages out of core's 24 h window ...
            db.execute("UPDATE task_comments SET created_at = created_at - 3 * 86400 WHERE task_id = ?", (task,))
            if guard_wait:
                self.assertEqual(guard_wait.release_parked(db), 1)  # ... and core releases the park itself.
            else:  # Older Core: the release core would write.
                with self.board.kb.write_txn(db):
                    db.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (task,))
                    self.board.kb._append_event(db, task, "promoted", {"source": "respawn_guard"})
        self.assertEqual(self.events(task)[-1].kind, "promoted")
        self.gh.state, self.gh.merged = "closed", True
        reads = len(self.gh.calls)
        self.later()
        self.later()
        self.assertEqual(self.events(task, "unblocked"), [])
        self.assertEqual(self.board.get(task).status, "ready")
        self.assertEqual(len(self.gh.calls), reads)


if __name__ == "__main__":
    unittest.main()
