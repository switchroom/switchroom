"""HF-850: a CI or issue wait the plugin resumes by itself is quiet board state.

Every park on CI pinged "blocked; needs attention", and the second park on one task tripped
core's block-loop breaker into triage, though the plugin resumes those waits itself. Where Core
has ``kanban_wait_claim`` the plugin claims such a wait as the worker writes it: Core marks it
``source: external_wait`` (a board hold: no ping, no wake) and does not count it toward the loop.
On a Core without the hook nothing changes: these scenarios then prove the old behaviour holds.

Real native task store (Core at HERMES_AGENT_SRC), real bridge, fake Linear and fake GitHub.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from linear_fake_api import Clock, FakeLinear, load_plugin

SOURCE = os.environ.get("HERMES_AGENT_SRC", "")
CORE = None
try:
    if not SOURCE:
        raise ImportError("HERMES_AGENT_SRC is not set")
    sys.path.insert(0, SOURCE)
    from hermes_cli import kanban_db as kb
    from hermes_cli.plugins import VALID_HOOKS, get_plugin_manager
except Exception as exc:
    CORE = str(exc)

plugin = load_plugin()
from hermes_fleet_linear_plugin import acceptance, waits  # noqa: E402
from hermes_fleet_linear_plugin.api import LinearAPI  # noqa: E402
from hermes_fleet_linear_plugin.bridge import Bridge, Kanban  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402
from test_linear_ci_wait_scenarios import FakeGitHub, HEAD, PR_URL, REPO, GAP  # noqa: E402

ISSUE = "issue-850"
CI_PARK = f"Pushed the fix; waiting for CI.\nCI gate: {PR_URL}"


def hook_in_core() -> bool:
    return CORE is None and waits.WAIT_CLAIM_HOOK in VALID_HOOKS


def board_hold(event) -> bool:
    """What the gateway notifier and the Desktop toast read: a board hold neither pings nor wakes."""
    from hermes_cli.kanban_db_guard_wait import is_board_hold_event
    return is_board_hold_event(event.kind, event.payload)


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class QuietWaitScenarios(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="linear-quiet-wait-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("HERMES_KANBAN_") and key != "HERMES_DELEGATED_CHILD_CONTEXT"}
        environment.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home / "board"), HERMES_PROFILE="default")
        env = patch.dict(os.environ, environment, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.github = FakeGitHub()
        gh = patch.object(acceptance, "gh_api", self.github)
        gh.start()
        self.addCleanup(gh.stop)
        hooks = get_plugin_manager()._hooks
        saved = {name: list(callbacks) for name, callbacks in hooks.items()}
        self.addCleanup(lambda: (hooks.clear(), hooks.update(saved)))
        hooks.pop(waits.WAIT_CLAIM_HOOK, None)
        # The plugin's own registration, on the real plugin manager Core asks.
        waits.register_wait_claim(SimpleNamespace(
            get_config=lambda key, default=None: None,
            register_hook=lambda name, callback: hooks.setdefault(name, []).append(callback)))
        self.board = Kanban(profile="default", profile_home=self.home)
        self.clock = Clock()
        self.remote = FakeLinear(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_issue(ISSUE, "HF-850", project=None)
        team = self.remote.issues[ISSUE]["team"]
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

    def claim(self, review=False):
        self.advance(1)
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            claimed = kb.claim_review_task(conn, self.task_id) if review else kb.claim_task(conn, self.task_id)
            self.assertIsNotNone(claimed)

    def park(self, reason=CI_PARK, kind="dependency", review=False):
        """The worker's kanban_block, as Core's tool runs it: ask the claim hook, then block."""
        self.claim(review=review)
        self.advance(1)
        run_id = self.board.get(self.task_id).current_run_id
        claimed = False
        if kind == "dependency" and hook_in_core():
            from hermes_cli.kanban_db_guard_wait import external_wait_claimed
            claimed = external_wait_claimed(self.task_id, kb.get_current_board(), reason)
        extra = {"external_wait": True} if claimed else {}
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.clock()):
            self.assertTrue(kb.block_task(conn, self.task_id, reason=reason, kind=kind, expected_run_id=run_id, **extra))
            kb._append_event(conn, self.task_id, "worker_result",
                             {"pid": 4242, "claim_lock": "host:1", "exit_code": 130, "last_output": ""}, run_id=run_id)
        self.reporter.pump_kanban()
        self.advance(10)
        self.reporter.flush()
        return claimed

    def park_event(self):
        return [e for e in self.board.history(self.task_id, 0) if e.kind in ("blocked", "block_loop_detected")][-1]

    def pump_after_gap(self):
        self.advance(GAP)
        self.reporter.pump_kanban()
        self.reporter.flush()

    def verdicts(self):
        with self.board.read_conn() as conn:
            return [c.body for c in self.board.comments(conn, self.task_id) if c.body.startswith("CI verdict:")]

    def test_repeated_ci_parks_are_quiet_and_each_resumes_with_its_verdict(self):
        heads = ["c" * 40, "d" * 40, "e" * 40]
        for number, head in enumerate(heads, start=1):
            self.github.pr = {"state": "open", "merged": False, "head": {"sha": head}}
            claimed = self.park()
            park = self.park_event()
            if hook_in_core():
                self.assertTrue(claimed)
                self.assertEqual((park.kind, park.payload["source"]), ("blocked", "external_wait"))
                self.assertTrue(board_hold(park))  # no "blocked; needs attention" ping, no wake
                self.assertEqual(self.board.get(self.task_id).status, "blocked")  # never triage
            else:  # an older Core: unchanged, the second park reaches triage and still resumes
                self.assertFalse(board_hold(park))
                # Leaving block-loop triage resets the count, so the third park starts it again.
                self.assertEqual(park.kind, "block_loop_detected" if number == 2 else "blocked")
            self.github.run(number, "CI", sha=head)
            self.pump_after_gap()
            self.assertEqual(self.board.get(self.task_id).status, "ready")
            self.assertEqual(len(self.verdicts()), number)
            self.assertIn(f"at {head}: passed", self.verdicts()[-1])
        events = self.board.history(self.task_id, 0)
        if hook_in_core():
            self.assertFalse([e for e in events if e.kind == "block_loop_detected"])
        # Linear still gets the milestones: the wait and each verdict.
        bodies = self.remote.bodies(ISSUE)
        self.assertTrue(any(f"Waiting for CI on {REPO} PR #7" in body for body in bodies), bodies)
        self.assertEqual(sum(f"CI passed on {REPO} PR #7" in body for body in bodies), len(heads), bodies)
        self.assertFalse(any("Waiting on you" in body for body in bodies), bodies)

    def test_a_failed_and_a_timed_out_verdict_still_reach_the_worker_and_linear(self):
        self.park()
        self.github.run(1, "CI", conclusion="failure")
        self.pump_after_gap()
        self.assertEqual(self.board.get(self.task_id).status, "ready")
        self.assertTrue(self.verdicts()[-1].startswith("CI verdict: failed"))
        self.assertTrue(any(f"CI failed on {REPO} PR #7" in body for body in self.remote.bodies(ISSUE)))

        self.github.pr = {"state": "open", "merged": False, "head": {"sha": "f" * 40}}
        self.park(reason=f"CI gate: {PR_URL} within 5m")
        self.github.run(2, "CI", status="in_progress", conclusion=None, sha="f" * 40)
        self.advance(6 * 60)
        self.pump_after_gap()
        self.assertEqual(self.board.get(self.task_id).status, "ready")
        self.assertTrue(self.verdicts()[-1].startswith("CI verdict: timed out"))
        self.assertTrue(any(f"CI timed out on {REPO} PR #7" in body for body in self.remote.bodies(ISSUE)))

    def test_a_real_question_and_an_uncheckable_wait_still_alert(self):
        self.park(reason="Which account should this deploy to?", kind="needs_input")
        self.assertFalse(board_hold(self.park_event()))
        self.advance(1)
        with self.board.conn() as conn:
            kb.unblock_task(conn, self.task_id)
        self.park(reason="Waiting on the vendor to reply")  # a dependency naming nothing checkable
        event = self.park_event()
        self.assertFalse(board_hold(event))
        self.assertNotIn("source", event.payload)

    def test_a_park_from_review_resumes_into_review(self):
        self.claim()
        with self.board.conn() as conn:
            self.assertTrue(kb.request_review(conn, self.task_id, summary="ready",
                                              expected_run_id=self.board.get(self.task_id).current_run_id))
        self.park(review=True)
        park = self.park_event()
        self.assertEqual(park.payload["source_status"], "review")
        self.assertEqual(board_hold(park), hook_in_core())
        self.github.run(1, "CI")
        self.pump_after_gap()
        self.assertEqual(self.board.get(self.task_id).status, "review")
        self.assertEqual(len(self.verdicts()), 1)

    def test_stop_during_a_quiet_park_wins(self):
        self.park()
        park = self.park_event()
        self.advance(1)
        self.assertTrue(self.board.stop(self.task_id, "linear:Stop requested"))
        self.github.run(1, "CI")
        self.pump_after_gap()
        self.pump_after_gap()
        self.assertEqual(self.board.get(self.task_id).status, "blocked")
        self.assertEqual(self.verdicts(), [])
        self.assertFalse([e for e in self.board.history(self.task_id, 0) if e.kind == "unblocked" and e.id > park.id])


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class WaitClaimRules(unittest.TestCase):
    """``waits.claim_wait`` answers only for waits this profile's bridge resumes by itself."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="linear-wait-claim-")
        self.addCleanup(temp.cleanup)
        environment = {key: value for key, value in os.environ.items() if not key.startswith("HERMES_KANBAN_")}
        environment.update(HERMES_HOME=temp.name, HERMES_KANBAN_HOME=str(Path(temp.name) / "board"), HERMES_PROFILE="default")
        env = patch.dict(os.environ, environment, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.board = Kanban(profile="default", profile_home=Path(temp.name))
        with self.board.conn() as conn:
            self.task_id = kb.create_task(conn, title="t", assignee="default")
            self.other = kb.create_task(conn, title="t", assignee="someone-else")

    def claim(self, reason, task_id=None):
        return waits.claim_wait(task_id=task_id or self.task_id, board=kb.get_current_board(), reason=reason,
                                profile_name="default")

    def earlier_ci_parks(self, count):
        with self.board.conn() as conn, kb.write_txn(conn):
            for _ in range(count):
                kb._append_event(conn, self.task_id, "blocked", {
                    "kind": "needs_input", "requested_kind": "dependency", "rekind_reason": "no_open_parent",
                    "reason": f"CI gate: {REPO}@{HEAD}", "source": "external_wait"})

    def test_ci_delivery_and_issue_waits_on_its_own_task_are_claimed(self):
        for reason in (CI_PARK, f"CI gate: {REPO}@{HEAD} within 90m", "Blocked on HF-123 shipping first",
                       "Delivery gate: linear/waits.py contains WAIT_CLAIM_HOOK"):
            self.assertEqual(self.claim(reason), {"resumes": True}, reason)

    def test_nothing_checkable_or_another_profiles_task_is_not_claimed(self):
        self.assertIsNone(self.claim("Waiting on the vendor"))
        self.assertIsNone(self.claim("CI gate: the main branch"))
        self.assertIsNone(self.claim(CI_PARK, task_id=self.other))
        self.assertIsNone(self.claim(CI_PARK, task_id="t_missing"))

    def test_the_park_past_the_ci_limit_is_left_for_a_person(self):
        self.earlier_ci_parks(waits.CI_MAX_PARKS - 1)
        self.assertEqual(self.claim(CI_PARK), {"resumes": True})  # the 20th park still resumes by itself
        self.earlier_ci_parks(1)
        self.assertIsNone(self.claim(CI_PARK))  # the 21st alerts
        self.assertEqual(self.claim("Blocked on HF-123"), {"resumes": True})  # an issue wait has no park limit

    def test_registration_follows_core_and_specialist_scope(self):
        registered = []
        ctx = SimpleNamespace(get_config=lambda key, default=None: None,
                              register_hook=lambda name, callback: registered.append(name))
        waits.register_wait_claim(ctx)
        self.assertEqual(registered, [waits.WAIT_CLAIM_HOOK] if waits.WAIT_CLAIM_HOOK in VALID_HOOKS else [])
        registered.clear()
        scoped = SimpleNamespace(get_config=lambda key, default=None: {"all_teams": True} if key == "specialist_scope" else None,
                                 register_hook=lambda name, callback: registered.append(name))
        waits.register_wait_claim(scoped)
        self.assertEqual(registered, [])  # a specialist may not read or resume: every wait alerts
        with patch.dict(sys.modules, {"hermes_cli.plugins": None}):
            waits.register_wait_claim(ctx)  # a Core without the plugin API registers nothing
        self.assertEqual(registered, [])


if __name__ == "__main__":
    unittest.main()
