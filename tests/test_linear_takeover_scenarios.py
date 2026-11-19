"""take_over from chat: real upstream Kanban, the registered chat handler and a synthetic Linear.

The requesting agent is never the old owner. It reaches the owner only through the configured
owner command, simulated here by a recorded runner that returns what the owner's
``hermes linear hand-off`` prints. A takeover ends with one task here and this app as delegate
(replacing exactly the old delegate), with nothing changed and a plain reason, or with the owner
left paused and a plain message (in the reply and on the issue) naming the two ways on. Two
agents never run the work: nothing resumes the owner except a person's resume_owner, which is
refused while the work runs here or the issue is delegated elsewhere, and a takeover task is
admitted only by the take_over call that has just proven the handover, never later.
The owner side itself (stop, proof, resume) is proven in test_linear_origin_handoff_native.py.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from linear_fake_api import load_plugin

SOURCE = os.environ.get("HERMES_AGENT_SRC", "")
CORE = None
try:
    if not SOURCE:
        raise ImportError("HERMES_AGENT_SRC is not set")
    sys.path.insert(0, SOURCE)
    from hermes_cli import kanban_db as kb  # noqa: F401
except Exception as exc:
    CORE = str(exc)

plugin = load_plugin()
from hermes_fleet_linear_plugin import chat, guard, handoff
from hermes_fleet_linear_plugin.bridge import Bridge, Kanban
from hermes_fleet_linear_plugin.store import Store
from hermes_fleet_linear_plugin.transport import NativeContext
from test_linear_chat_entrust_scenarios import ChatAuthority, now_iso
from test_linear_specialist_authorization import ISSUE, USER, VIEWER

OWNER = str(uuid.UUID(int=0x99, version=4))
STRANGER = str(uuid.UUID(int=0x77, version=4))
REQUEST = str(uuid.UUID(int=0x5150, version=4))
OWNER_COMMAND = ["host-bridge", "profile", "atlas", "--", "hermes", "--profile", "default"]


class OwnerCommand:
    """Records each owner hand-off call and answers with what the owner would print."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

    def __call__(self, argv, **options):
        self.calls.append((list(argv), options))
        reply = self.replies.pop(0) if self.replies else None
        if isinstance(reply, BaseException):
            raise reply
        stdout = "1Password: applied 3 secrets\n" + (json.dumps(reply) if isinstance(reply, dict) else (reply or ""))
        code = 0 if isinstance(reply, dict) and reply.get("handed_off") else 1
        return subprocess.CompletedProcess(argv, code, stdout, "")


def handed_off(**extra):
    return {"handed_off": True, "state": "handed_off", "issue_id": ISSUE, "task_id": "t_0wner001", "board": "atlas",
            "stop_event_id": 211, "stopped_here": True, "evidence_digest": "a" * 64, "to": "Nova",
            "permission_granted": False, "message": "Atlas's work stopped and is confirmed finished; Nova can continue it.",
            **extra}


def not_handed_off(state, reason, message):
    return {"handed_off": False, "state": state, "reason": reason, "message": message, "permission_granted": False}


PAUSED = {**not_handed_off("paused", "proof_timeout", "Atlas's work is paused for a handover to Nova that didn't "
                           "complete: its run did not finish winding down in time. Nothing was resumed automatically."),
          "why": "its run did not finish winding down in time."}
RESUMED = not_handed_off("resumed", "handoff_resumed", "Atlas continues its work on this issue.")


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class TakeoverScenarios(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="linear-takeover-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("HERMES_KANBAN_") and key != "HERMES_DELEGATED_CHILD_CONTEXT"}
        environment.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home / "board"), HERMES_PROFILE="default")
        self.env = patch.dict(os.environ, environment, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.authority = ChatAuthority()
        self.authority.issues[ISSUE]["delegate"] = {"id": OWNER, "name": "Atlas"}
        self.authority.issues[ISSUE]["state"] = {"id": "state-progress", "name": "In Progress", "type": "started"}
        self.authority.issues[ISSUE]["updatedAt"] = now_iso()
        self.board = Kanban(profile="default", profile_home=self.home)
        if not self.board.guarded_controls:
            self.skipTest("native host predates guarded admission")
        settings = {"takeover": {"name": "Nova", "agents": [
            {"name": "Atlas", "delegate_id": OWNER, "command": OWNER_COMMAND, "wait_seconds": 30}]}}
        self.bridge = Bridge(Store(self.home / "linear.db"), self.authority.api(scope=None), self.board,
                             profile="default", settings=settings)
        self.bridge.profile_home = self.home
        self.context = NativeContext(home=str(self.home), profile="default", platform="slack", source="slack",
                                     session_key="slack:chat-1:thread-1", session_id="chat-session", user_id="human-1",
                                     chat_id="chat-1", chat_type="dm", thread_id="thread-1", scope_id="workspace-1")

    def take_over(self, owner, **extra):
        with patch.object(subprocess, "run", owner):
            return json.loads(chat.handle(self.bridge, {"action": "take_over", "issue": ISSUE, "id": REQUEST, **extra},
                                          self.context))

    def tasks(self):
        with self.board.conn() as conn:
            return [dict(row) for row in conn.execute("SELECT id, status, body FROM tasks")]

    def delegate(self):
        return (self.authority.issues[ISSUE].get("delegate") or {}).get("id")

    def assert_nothing_changed_here(self):
        self.assertEqual(self.tasks(), [])
        self.assertIsNone(self.bridge.store.get(ISSUE))
        self.bridge.flush()
        self.assertEqual(self.delegate(), OWNER)

    # -- (a) owner stopped, proven, requester continues as one task -------------------------
    def test_requester_is_not_the_owner_and_continues_as_one_task_after_proof(self):
        owner = OwnerCommand(handed_off())
        reply = self.take_over(owner)
        self.assertTrue(reply["ok"], reply)
        self.assertIn("Took over OPS-1 from Atlas", reply["message"])
        self.assertIn("confirmed finished", reply["message"])
        # The owner was reached only through the configured command, with the full issue reference.
        (argv, options), = owner.calls
        self.assertEqual(argv[:len(OWNER_COMMAND)], OWNER_COMMAND)
        tail = argv[len(OWNER_COMMAND):]
        self.assertEqual(tail[:3], ["linear", "hand-off", ISSUE])
        self.assertEqual(json.loads(tail[tail.index("--issue-json") + 1]),
                         {"id": ISSUE, "identifier": "OPS-1", "url": "https://linear.example/issue/OPS-1"})
        self.assertEqual(tail[tail.index("--to") + 1], "Nova")
        self.assertEqual(tail[tail.index("--request-id") + 1], REQUEST)
        self.assertNotIn("--cancel", tail)
        self.assertNotIn("shell", options)
        # One task on this agent's board, admitted, saying where to continue from.
        tasks = self.tasks()
        self.assertEqual(len(tasks), 1)
        self.assertIn(tasks[0]["status"], ("ready", "running"))
        self.assertIn("Atlas worked on this issue before and stopped", tasks[0]["body"])
        self.assertEqual(reply["handover"], {"from": "Atlas", "state": "handed_off", "stopped_here": True})
        # This app replaces exactly the old delegate, guarded on it.
        rows = [row for row in self.bridge.store.pending() if row["kind"] == "delegate"]
        self.assertEqual([row["payload"]["expected_delegate_id"] for row in rows], [OWNER])
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)

    def test_retry_after_success_is_work_on_and_never_asks_the_owner_again(self):
        self.assertTrue(self.take_over(OwnerCommand(handed_off()))["ok"])
        self.bridge.flush()
        again = OwnerCommand()
        reply = self.take_over(again)
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(again.calls, [])
        self.assertEqual(len(self.tasks()), 1)

    # -- the owner paused, nothing runs here: it stays paused, and people are told plainly ---
    def notices(self):
        """What this agent posted on the Linear issue (delivered comments)."""
        self.bridge.flush()
        return [body for issue, body in self.authority.comment_bodies if issue == ISSUE]

    def assert_paused_message(self, reply, *, may=False):
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], "takeover_paused")
        state = "may be paused" if may else "is paused"
        self.assertIn(f"Atlas's work on OPS-1 {state} for a handover to Nova that didn't complete", reply["message"])
        self.assertIn("Say 'resume OPS-1' to let Atlas continue, or 'take over OPS-1' to try again.", reply["message"])
        self.assertNotRegex(reply["message"], r"proof_timeout|native_|handoff:")
        notice, = self.notices()
        self.assertEqual(notice, f"Atlas's work on OPS-1 {state} for a handover to Nova that didn't complete. Nothing "
                                 "resumes it automatically. Ask Nova to 'resume OPS-1' to let Atlas continue, or to "
                                 "'take over OPS-1' to try again.")

    def assert_never_resumed(self, *owners):
        for owner in owners:
            self.assertFalse(any("--resume" in argv for argv, _ in owner.calls), owner.calls)

    def assert_nothing_runs_here(self):
        self.assertTrue(all(task["status"] not in ("ready", "running") for task in self.tasks()), self.tasks())

    def test_failed_proof_leaves_the_owner_paused_with_a_plain_message(self):
        owner = OwnerCommand(PAUSED)
        reply = self.take_over(owner)
        self.assert_paused_message(reply)
        self.assertIn("its run did not finish winding down in time", reply["message"])
        self.assertEqual(reply["handover"]["state"], "paused")
        self.assertEqual(len(owner.calls), 1)  # Asked once; never resumed automatically.
        self.assert_never_resumed(owner)
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.delegate(), OWNER)
        # Service ticks never resume it either: nothing here asks the owner anything.
        later = OwnerCommand()
        with patch.object(subprocess, "run", later):
            self.bridge.tick()
        self.assertEqual(later.calls, [])

    def test_raw_stop_that_cannot_be_proven_is_left_as_it_was(self):
        owner = OwnerCommand(not_handed_off("unchanged", "native_admission_not_settled",
            "The handover couldn't be confirmed safe. Atlas's work was left as it was, and nothing was handed over."))
        reply = self.take_over(owner)
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "takeover_refused")
        self.assertIn("left as it was", reply["message"])
        self.assert_nothing_changed_here()
        self.assertEqual(self.notices(), [])

    def test_unknown_owner_outcome_says_it_may_be_paused_and_starts_nothing(self):
        for outcome in (subprocess.TimeoutExpired(["owner"], 120), OSError("no bridge"), "not json at all",
                        handed_off(issue_id="another-issue")):
            with self.subTest(outcome=type(outcome).__name__):
                self.setUp()
                owner = OwnerCommand(outcome)
                reply = self.take_over(owner)
                self.assert_paused_message(reply, may=True)
                self.assertIn("didn't report back", reply["message"])
                self.assertEqual(len(owner.calls), 1)
                self.assertEqual(self.tasks(), [])
                self.assertEqual(self.delegate(), OWNER)

    def test_retrying_after_an_unknown_outcome_proves_the_same_stop_and_starts_here(self):
        self.take_over(OwnerCommand(subprocess.TimeoutExpired(["owner"], 120)))
        owner = OwnerCommand(handed_off(stopped_here=True))
        self.assertTrue(self.take_over(owner)["ok"])
        argv = owner.calls[0][0]
        self.assertEqual(argv[argv.index("--request-id") + 1], REQUEST)  # The owner finds its own Stop by id.
        self.assertIn(self.tasks()[0]["status"], ("ready", "running"))

    # -- earlier local work that entrust would reuse but that would not run -------------------
    def _own_earlier_task(self, final):
        """This agent worked the issue earlier while it was undelegated; then a person delegated it to Atlas."""
        self.authority.issues[ISSUE]["delegate"] = None
        started = json.loads(chat.handle(self.bridge, {"action": "work_on", "issue": ISSUE}, self.context))
        self.assertTrue(started["ok"], started)
        task_id = self.bridge.store.get(ISSUE)["task_id"]
        with self.board.conn() as conn:
            if final == "done":
                self.board.kb.complete_task(conn, task_id, summary="earlier")
            else:
                self.board.kb.block_task(conn, task_id, reason="paused by a person", kind="needs_input")
        self.bridge.flush()
        self.authority.issues[ISSUE]["delegate"] = {"id": OWNER, "name": "Atlas"}
        self.authority.issues[ISSUE]["updatedAt"] = now_iso()
        return task_id

    def test_earlier_local_work_that_would_not_run_is_refused_before_the_owner_is_asked(self):
        for final, words in (("done", "already finished"), ("paused", "is paused")):
            with self.subTest(final=final):
                self.setUp()
                self._own_earlier_task(final)
                before = self.tasks()
                owner = OwnerCommand(handed_off())
                reply = self.take_over(owner)
                self.assertFalse(reply["ok"], reply)
                self.assertEqual(reply["code"], "takeover_refused")
                self.assertIn(words, reply["message"])
                self.assertIn("Atlas keeps working on OPS-1", reply["message"])
                self.assertEqual(owner.calls, [])  # Atlas was never asked to stop.
                self.assertEqual(self.tasks(), before)
                self.bridge.flush()
                self.assertEqual(self.delegate(), OWNER)

    # -- after the proof, any failure to start here: the owner stays paused --------------------
    def test_nothing_running_here_after_the_proof_leaves_the_owner_paused(self):
        # Local work changes between the preflight and the start (here: the preflight is skipped).
        self._own_earlier_task("done")
        owner = OwnerCommand(handed_off())
        with patch.object(Bridge, "takeover_preflight", lambda *a, **k: ("ask_owner", None)):
            reply = self.take_over(owner)
        self.assert_paused_message(reply)
        self.assertIn("couldn't start here", reply["message"])
        self.assertEqual(len(owner.calls), 1)
        self.assertEqual(self.delegate(), OWNER)

    def test_any_exception_after_the_proof_leaves_the_owner_paused_and_replies(self):
        from hermes_fleet_linear_plugin import transport
        for error in (transport.Uncertain("lost"), KeyError("native"), TypeError("bad"), OSError("disk"),
                      transport.Unavailable("down")):
            with self.subTest(error=type(error).__name__):
                self.setUp()
                owner = OwnerCommand(handed_off())
                def broken(*args, **kwargs):
                    raise error
                with patch.object(Bridge, "entrust", broken):
                    reply = self.take_over(owner)
                self.assert_paused_message(reply)
                self.assertEqual(len(owner.calls), 1)

    def test_a_person_moving_the_issue_between_proof_and_admission_wins(self):
        owner = OwnerCommand(handed_off())
        with self._routing_change_at_create(USER):
            reply = self.take_over(owner)
        self.assert_paused_message(reply)
        self.assertIn("a person changed this issue's status, assignee or delegate in Linear", reply["message"])
        self.assertEqual(len(owner.calls), 1)
        self.assert_nothing_runs_here()
        self.bridge._recover_admissions()  # A person's decision stands: never admitted later either.
        self.assert_nothing_runs_here()

    def later_request(self, seconds=5):
        """Requests from here on happen ``seconds`` later (after the person's change)."""
        self.bridge.clock = lambda: time.time() + seconds

    def assert_taken_over_once(self, reply, owner):
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(len(owner.calls), 1)
        self.assert_never_resumed(owner)
        (task,) = self.tasks()
        self.assertIn(task["status"], ("ready", "running"))
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)  # Routing follows the new request too.

    def test_N1_a_retry_after_a_person_moved_the_issue_re_proves_and_starts(self):
        # The first start lost to a person's change; the user then asks again. That new explicit
        # request is the authority: the owner proves its pause again and the parked task starts.
        with self._routing_change_at_create(USER):
            self.assert_paused_message(self.take_over(OwnerCommand(handed_off())))
        self.later_request()
        again = OwnerCommand(handed_off(stopped_here=False))
        self.assert_taken_over_once(self.take_over(again, id=str(uuid.uuid4())), again)

    def test_N1_a_person_changing_it_after_the_retry_s_proof_still_wins(self):
        with self._routing_change_at_create(USER):
            self.take_over(OwnerCommand(handed_off()))
        self.later_request()
        issue, real = self.authority.issues[ISSUE], Bridge.entrust
        def moved_after_proof(bridge, issue_id, **kw):
            late = datetime.fromtimestamp(bridge.clock() + 1, timezone.utc).isoformat().replace("+00:00", "Z")
            self.authority.history[ISSUE].append({
                "createdAt": late, "actorId": USER, "fromStateId": issue["state"]["id"], "toStateId": "state-todo",
                "fromAssigneeId": None, "toAssigneeId": USER, "fromDelegate": {"id": OWNER}, "toDelegate": {"id": OWNER}})
            issue["updatedAt"] = late
            return real(bridge, issue_id, **kw)
        again = OwnerCommand(handed_off(stopped_here=False))
        with patch.object(Bridge, "entrust", moved_after_proof):
            reply = self.take_over(again, id=str(uuid.uuid4()))
        self.assertEqual(reply["code"], "takeover_paused", reply)
        self.assertIn("a person changed this issue's status, assignee or delegate", reply["message"])
        self.assertIn("Say 'resume OPS-1' to let Atlas continue", reply["message"])
        self.assert_nothing_runs_here()
        self.assertTrue(self.resume_owner(OwnerCommand(RESUMED))["ok"])

    def test_N1_a_retry_whose_routing_is_held_is_routed_by_recovery_from_the_retry_s_proof(self):
        # The person's change before the retry is not a reason for recovery to leave Atlas the delegate.
        from hermes_fleet_linear_plugin.api import LinearError
        with self._routing_change_at_create(USER):
            self.take_over(OwnerCommand(handed_off()))
        self.later_request()
        def unavailable(*args, **kwargs):
            raise LinearError("Linear unreachable (network error)")
        with patch.object(Bridge, "queue_delegate_self", unavailable):
            reply = self.take_over(OwnerCommand(handed_off(stopped_here=False)), id=str(uuid.uuid4()))
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["routing"], "held: will retry automatically")
        self.bridge.flush()
        self.bridge.pump_kanban()
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)

    def test_closed_during_the_start_offers_reopening_before_taking_over_again(self):
        real = Kanban.create
        def create(adapter, *args, **kwargs):
            task = real(adapter, *args, **kwargs)
            self.authority.issues[ISSUE]["state"] = {"id": "state-done", "name": "Done", "type": "completed"}
            return task
        with patch.object(Kanban, "create", create):
            first = self.take_over(OwnerCommand(handed_off()))
        self.assertEqual(first["code"], "takeover_paused", first)
        self.assertIn("reopen OPS-1, then say 'take over OPS-1' again", first["message"])
        self.assertNotIn("'take over OPS-1' to try again", first["message"])

    def test_closed_plus_a_start_that_cant_be_retried_offers_only_resume(self):
        # Closed at the same time as a failure a retry can't recover from ("native work changed
        # after creation"): reopening and taking over again would be refused, so it isn't offered.
        real = Kanban.create
        def create(adapter, *args, **kwargs):
            task = real(adapter, *args, **kwargs)
            self.authority.issues[ISSUE]["state"] = {"id": "state-done", "name": "Done", "type": "completed"}
            return task
        with patch.object(Kanban, "create", create), patch.object(Kanban, "initial_activation_event", lambda *a, **k: None):
            first = self.take_over(OwnerCommand(handed_off()))
        self.assertEqual(first["code"], "takeover_paused", first)
        self.assertIn("OPS-1 is closed.", first["message"])
        self.assertIn("Say 'resume OPS-1' to let", first["message"])
        self.assertNotIn("take over OPS-1", first["message"])

    def test_N3_a_transient_failure_then_a_person_assigning_it_then_a_retry_starts_once(self):
        with self._flaky_activation():
            self.assert_paused_message(self.take_over(OwnerCommand(handed_off())))
        issue = self.authority.issues[ISSUE]
        moved = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
        self.authority.history.setdefault(ISSUE, []).append({
            "createdAt": moved, "actorId": USER, "fromStateId": issue["state"]["id"], "toStateId": issue["state"]["id"],
            "fromAssigneeId": None, "toAssigneeId": USER, "fromDelegate": {"id": OWNER}, "toDelegate": {"id": OWNER}})
        issue["updatedAt"] = moved
        self.later_request()
        again = OwnerCommand(handed_off(stopped_here=False))
        self.assert_taken_over_once(self.take_over(again, id=str(uuid.uuid4())), again)
        later = OwnerCommand()  # A further retry never asks the owner again.
        self.assertTrue(self.take_over(later, id=str(uuid.uuid4()))["ok"])
        self.assertEqual(later.calls, [])

    def test_a_stop_during_the_start_offers_only_resume_and_a_retry_says_so_truthfully(self):
        # A Stop from Linear supersedes admission for good: taking over again can't start that
        # task, so it is not offered, and a retry never claims Atlas keeps working.
        self.bridge.store.record_unbound_stop(ISSUE, time.time() * 1000 + 60_000, session_id="stop-session",
                                              activity_id="stop-1", actor=USER)
        first = self.take_over(OwnerCommand(handed_off()))
        self.assertEqual(first["code"], "takeover_paused", first)
        self.assertIn("someone stopped it in Linear", first["message"])
        self.assertTrue(first["message"].endswith("Say 'resume OPS-1' to let Atlas continue."), first["message"])
        self.assertNotIn("take over OPS-1", " ".join(self.notices()))
        again = OwnerCommand(handed_off(stopped_here=False))
        retry = self.take_over(again, id=str(uuid.uuid4()))
        self.assertEqual(retry["code"], "takeover_refused")
        self.assertEqual(again.calls, [])
        self.assertNotIn("keeps working", retry["message"])
        self.assertIn("If Atlas is still paused for that earlier handover, say 'resume OPS-1'", retry["message"])
        self.assertTrue(self.resume_owner(OwnerCommand(RESUMED))["ok"])
        self.assert_nothing_runs_here()

    def test_delegated_to_this_agent_by_hand_after_a_failed_start_is_told_truthfully(self):
        owner = OwnerCommand(handed_off())
        def broken(*args, **kwargs):
            self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER, "name": "Nova"}
            raise OSError("disk")
        with patch.object(Bridge, "entrust", broken):
            reply = self.take_over(owner)
        self.assertEqual(reply["code"], "takeover_paused")
        self.assertIn("meanwhile OPS-1 was delegated to this agent", reply["message"])
        self.assertIn("To let Atlas continue, delegate OPS-1 back to Atlas and say 'resume OPS-1'.", reply["message"])
        self.assertEqual(self.resume_owner(OwnerCommand(RESUMED))["code"], "resume_refused")  # As the reply says.
        self.authority.issues[ISSUE]["delegate"] = {"id": OWNER, "name": "Atlas"}
        self.assertTrue(self.resume_owner(OwnerCommand(RESUMED))["ok"])

    def test_someone_re_delegating_after_the_proof_wins_and_the_owner_stays_paused(self):
        owner = OwnerCommand(handed_off())
        real = Bridge.entrust_checks
        calls = []
        def moved(bridge, issue_id, **kw):
            calls.append(kw)
            if len(calls) == 2:
                self.authority.issues[ISSUE]["delegate"] = {"id": STRANGER, "name": "Vega"}
                self.authority.issues[ISSUE]["updatedAt"] = now_iso()
            return real(bridge, issue_id, **kw)
        with patch.object(Bridge, "entrust_checks", moved):
            reply = self.take_over(owner)
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "takeover_paused")
        self.assertEqual(len(owner.calls), 1)
        self.assertEqual(self.tasks(), [])
        # M3 (r4): the reply and the issue say so truthfully, and resuming Atlas is not offered.
        self.assertEqual(reply["message"], "Atlas stopped for the handover, but meanwhile OPS-1 was delegated to "
                         "Vega, so nothing was started here. Atlas's work on OPS-1 is paused for a handover to Nova "
                         "that didn't complete. To let Atlas continue, delegate OPS-1 back to Atlas and say "
                         "'resume OPS-1'.")
        self.assertEqual(self.notices(), ["Atlas's work on OPS-1 is paused for a handover to Nova that didn't "
                                          "complete. OPS-1 is now delegated to Vega. Nothing resumes Atlas "
                                          "automatically. To let Atlas continue, delegate OPS-1 back to Atlas and "
                                          "ask Nova to 'resume OPS-1'."])
        # A person asking to resume anyway is refused while Vega is the delegate: Atlas never runs beside it.
        resume = OwnerCommand(RESUMED)
        refused = self.resume_owner(resume)
        self.assertEqual(refused["code"], "resume_refused")
        self.assertIn("OPS-1 is delegated to Vega", refused["message"])
        self.assertEqual(resume.calls, [])
        # Delegated back to Atlas, the resume goes through.
        self.authority.issues[ISSUE]["delegate"] = {"id": OWNER, "name": "Atlas"}
        self.assertTrue(self.resume_owner(OwnerCommand(RESUMED))["ok"])

    def test_the_start_here_runs_under_a_linear_deadline(self):
        owner = OwnerCommand(handed_off())
        with patch.object(handoff, "ENTRUST_BUDGET_SECONDS", 1.0):
            reply = self.take_over(owner)  # No Linear request fits in one second: none is started.
        self.assertEqual(reply["code"], "takeover_paused", reply)
        self.assertIn("too slowly", reply["message"])
        self.assertEqual(len(owner.calls), 1)
        self.assert_nothing_runs_here()

    # -- a start that failed after the proof is never admitted later; take_over again proves anew --
    def _flaky_admission_read(self):
        from hermes_fleet_linear_plugin.api import LinearError
        import traceback
        real, failed = Bridge._effect_issue, []
        def flaky(bridge, issue_id, *a, **k):
            if not failed and any(frame.name == "_assignment_activation" for frame in traceback.extract_stack()):
                failed.append(True)
                raise LinearError("Linear is answering too slowly to finish this in time")
            return real(bridge, issue_id, *a, **k)
        return patch.object(Bridge, "_effect_issue", flaky)

    def _flaky_activation(self):
        real, failed = Kanban.activate, []
        def flaky(adapter, *a, **k):
            if not failed:
                failed.append(True)
                raise OSError("database is locked")
            return real(adapter, *a, **k)
        return patch.object(Kanban, "activate", flaky)

    def _never_admitted_late(self, patcher):
        """M1/M2 (r4): the first admission attempt fails, so take_over reports the owner paused.
        That stays true: no service tick admits the task later. Taking over again re-proves the
        same pause (the owner is asked once more, never resumed) and starts it, subscribed here."""
        owner = OwnerCommand(handed_off())
        with patcher:
            self.assert_paused_message(self.take_over(owner))
        (task,) = self.tasks()
        self.assertEqual(task["status"], "blocked")
        later = OwnerCommand()
        with patch.object(subprocess, "run", later):
            self.bridge._recover_admissions()
            self.bridge.tick()
        self.assert_nothing_runs_here()
        self.assertEqual(self.delegate(), OWNER)
        self.assertEqual(later.calls, [])
        self.assertEqual(len(self.notices()), 1)  # The one paused message, still true.
        subscribed = []
        real = Kanban.subscribe_origin
        def record(adapter, task_id, route):
            subscribed.append(task_id)
            return real(adapter, task_id, route)
        again = OwnerCommand(handed_off(stopped_here=False))
        with patch.object(Kanban, "subscribe_origin", record):
            reply = self.take_over(again, id=str(uuid.uuid4()))
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(len(again.calls), 1)
        (task,) = self.tasks()
        self.assertIn(task["status"], ("ready", "running"))
        self.assertEqual(subscribed, [task["id"]])  # Checkpoints and the result come back to this chat.
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)
        self.assert_never_resumed(owner, later, again)

    def test_M1_admission_read_failing_once_is_never_admitted_later(self):
        self._never_admitted_late(self._flaky_admission_read())

    def test_X2_native_activation_failing_once_is_never_admitted_later(self):
        self._never_admitted_late(self._flaky_activation())

    def test_M2_owner_resumed_on_its_board_without_a_blocked_state_never_runs_beside_this_agent(self):
        # Linear's default workflow has no Blocked state, so the owner's pause and resume reports
        # write no state change. A person then resumes Atlas directly on its board (its app only
        # comments). Nothing here admits the parked takeover task beside it.
        team = self.authority.issues[ISSUE].setdefault("team", {})
        nodes = (team.get("states") or {}).get("nodes") or []
        team["states"] = {"nodes": [node for node in nodes if str(node.get("name")).lower() != "blocked"]}
        self.assertIsNone(self.bridge.state_id(self.authority.issues[ISSUE], "blocked"))
        owner = OwnerCommand(handed_off())
        with self._flaky_activation():
            self.assert_paused_message(self.take_over(owner))
        self.authority.issues[ISSUE]["updatedAt"] = (
            datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat().replace("+00:00", "Z")
        self.bridge._recover_admissions()
        self.bridge.tick()
        self.assert_nothing_runs_here()
        self.assertEqual(self.delegate(), OWNER)
        self.assert_never_resumed(owner)

    def test_X3_service_stopping_after_create_is_never_admitted_later(self):
        class Stopped(BaseException):
            pass
        def stopped(*a, **k):
            raise Stopped()
        owner = OwnerCommand(handed_off())
        with patch.object(Bridge, "_assignment_activation", stopped), self.assertRaises(Stopped):
            self.take_over(owner)
        later = OwnerCommand()
        with patch.object(subprocess, "run", later):
            self.bridge.tick()
        self.assert_nothing_runs_here()
        self.assertEqual(later.calls, [])
        again = OwnerCommand(handed_off(stopped_here=False))
        self.assertTrue(self.take_over(again, id=str(uuid.uuid4()))["ok"])
        self.assertIn(self.tasks()[0]["status"], ("ready", "running"))
        self.assert_never_resumed(owner, later, again)

    def test_a_landed_admission_whose_reply_was_lost_is_recognised_not_repeated(self):
        # The native activation commits, then its reply is lost: the task runs here, so the
        # handover stands. A later tick only records the receipt; it never activates again.
        real = Kanban.activate
        def lost(adapter, *a, **k):
            real(adapter, *a, **k)
            raise OSError("reply lost")
        with patch.object(Kanban, "activate", lost):
            reply = self.take_over(OwnerCommand(handed_off()))
        self.assertTrue(reply["ok"], reply)
        self.assertIn("routing", reply)
        self.bridge._recover_admissions()
        task_id = self.tasks()[0]["id"]
        self.assertTrue(self.bridge.store.native_intent(f"activate:{ISSUE}:{task_id}")["accepted"])
        self.bridge.pump_kanban()
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)

    def test_r3b_a_new_request_after_an_uncertain_one_never_leaves_the_owner_stopped_by_surprise(self):
        # G: R1's reply was lost (Atlas may be paused); R2 with a new id is a plain retry. Whatever
        # R2 gets, nothing is resumed automatically and nothing is wiped: one owner call each.
        r1 = OwnerCommand(subprocess.TimeoutExpired(["owner"], 180))
        self.assert_paused_message(self.take_over(r1), may=True)
        r2 = OwnerCommand(PAUSED)
        reply = self.take_over(r2, id=str(uuid.uuid4()))
        self.assertEqual(reply["code"], "takeover_paused")
        r3 = OwnerCommand(handed_off(stopped_here=False))
        self.assertTrue(self.take_over(r3, id=str(uuid.uuid4()))["ok"])
        self.assertEqual([len(o.calls) for o in (r1, r2, r3)], [1, 1, 1])
        self.assert_never_resumed(r1, r2, r3)
        self.assertEqual(len(self.tasks()), 1)

    # -- a person's explicit resume of the owner -----------------------------------------------
    def resume_owner(self, owner, **extra):
        with patch.object(subprocess, "run", owner):
            return json.loads(chat.handle(self.bridge, {"action": "resume_owner", "issue": ISSUE,
                                                        "id": str(uuid.uuid4()), **extra}, self.context))

    def test_resume_after_a_takeover_that_did_not_complete_lets_the_owner_continue(self):
        self.assert_paused_message(self.take_over(OwnerCommand(PAUSED)))
        owner = OwnerCommand(RESUMED)
        reply = self.resume_owner(owner)
        self.assertTrue(reply["ok"], reply)
        self.assertIn("Atlas continues its work on OPS-1", reply["message"])
        (argv, _), = owner.calls
        self.assertEqual(argv[len(OWNER_COMMAND):len(OWNER_COMMAND) + 3], ["linear", "hand-off", ISSUE])
        self.assertIn("--resume", argv)
        self.assertEqual(argv[argv.index("--to") + 1], "Nova")
        self.assertEqual(self.tasks(), [])

    def test_a_parked_takeover_task_is_never_admitted_beside_a_resumed_owner(self):
        # The start failed after the proof, so this agent's task stays parked. A person resumes
        # Atlas: nothing starts here, until take_over proves a new handover.
        with self._flaky_activation():
            self.assert_paused_message(self.take_over(OwnerCommand(handed_off())))
        self.assertTrue(self.resume_owner(OwnerCommand(RESUMED))["ok"])
        self.bridge._recover_admissions()
        self.bridge.tick()
        self.assert_nothing_runs_here()
        # Taking over again proves a new handover; the same task then starts, exactly once.
        again = OwnerCommand(handed_off())
        reply = self.take_over(again, id=str(uuid.uuid4()))
        self.assertTrue(reply["ok"], reply)
        (task,) = self.tasks()
        self.assertIn(task["status"], ("ready", "running"))

    def test_resume_is_refused_when_this_agent_runs_the_work(self):
        self.assertTrue(self.take_over(OwnerCommand(handed_off()))["ok"])
        owner = OwnerCommand(RESUMED)
        reply = self.resume_owner(owner)
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "resume_refused")
        self.assertIn("Atlas was not resumed: this agent is already running it", reply["message"])
        self.assertEqual(owner.calls, [])
        self.assertIn(self.tasks()[0]["status"], ("ready", "running"))

    def test_an_uncertain_resume_still_keeps_this_agent_from_starting(self):
        with self._flaky_activation():
            self.take_over(OwnerCommand(handed_off()))
        reply = self.resume_owner(OwnerCommand(OSError("bridge gone")))
        self.assertEqual(reply["code"], "resume_uncertain")
        self.bridge._recover_admissions()
        self.assert_nothing_runs_here()

    def test_the_owner_reporting_a_resume_in_linear_never_leads_to_a_late_admission(self):
        # A person resumed Atlas directly on its own board (not the supported resume_owner): Atlas's
        # app moves the issue out of Blocked. Nothing here admits the parked task beside it.
        with self._flaky_activation():
            self.take_over(OwnerCommand(handed_off()))
        issue = self.authority.issues[ISSUE]
        for to_state in ("state-blocked", "state-todo"):  # Atlas's pause report, then its resume report.
            moved = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
            self.authority.history.setdefault(ISSUE, []).append({
                "createdAt": moved, "actorId": OWNER, "fromStateId": issue["state"]["id"], "toStateId": to_state,
                "fromAssigneeId": None, "toAssigneeId": None, "fromDelegate": {"id": OWNER}, "toDelegate": {"id": OWNER}})
            issue.update(updatedAt=moved, state={"id": to_state, "name": to_state, "type": "started"})
        self.bridge._recover_admissions()
        self.assert_nothing_runs_here()

    # -- one take_over per issue at a time -------------------------------------------------------
    def test_a_second_takeover_of_the_same_issue_waits_for_the_first(self):
        owner = OwnerCommand(handed_off())
        with handoff.issue_lock(self.bridge.store.path.parent / "takeover", ISSUE, 0) as held:
            self.assertTrue(held)
            reply = self.take_over(owner)
            resume = OwnerCommand(RESUMED)
            self.assertEqual(self.resume_owner(resume)["code"], "takeover_in_progress")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "takeover_in_progress")
        self.assertEqual(owner.calls + resume.calls, [])
        self.assert_nothing_changed_here()
        self.assertTrue(self.take_over(owner)["ok"])  # Free again once the first one has finished.

    # -- admission after the proof is checked like work_on's -------------------------------------
    def _routing_change_at_create(self, actor, to_state="state-todo"):
        """A routing change by ``actor`` lands right after the task is created, before admission."""
        real = Kanban.create
        def create(adapter, *args, **kwargs):
            task = real(adapter, *args, **kwargs)
            issue = self.authority.issues[ISSUE]
            moved = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
            issue["updatedAt"] = moved
            self.authority.history.setdefault(ISSUE, []).append({
                "createdAt": moved, "actorId": actor, "fromStateId": issue["state"]["id"], "toStateId": to_state,
                "fromAssigneeId": None, "toAssigneeId": None, "fromDelegate": {"id": OWNER}, "toDelegate": {"id": OWNER}})
            return task
        return patch.object(Kanban, "create", create)

    def test_the_old_delegate_reporting_its_pause_is_not_a_person_moving_it(self):
        with self._routing_change_at_create(OWNER, "state-blocked"):
            reply = self.take_over(OwnerCommand(handed_off()))
        self.assertTrue(reply["ok"], reply)
        self.assertIn(self.tasks()[0]["status"], ("ready", "running"))

    def test_unconfigured_owner_is_refused_before_anything_is_asked(self):
        self.authority.issues[ISSUE]["delegate"] = {"id": STRANGER, "name": "Vega"}
        owner = OwnerCommand(handed_off())
        reply = self.take_over(owner)
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "takeover_unavailable")
        self.assertIn("isn't set up", reply["message"])
        self.assertIn("Vega keeps working on it", reply["message"])
        self.assertEqual(self.resume_owner(owner)["code"], "resume_refused")
        self.assertEqual(owner.calls, [])
        self.assertEqual(self.tasks(), [])

    def test_refusals_this_side_would_make_later_are_made_before_the_owner_is_asked(self):
        owner = OwnerCommand(handed_off())
        self.authority.issues[ISSUE]["state"] = {"id": "state-done", "name": "Done", "type": "completed"}
        self.assertEqual(self.take_over(owner)["code"], "takeover_refused")
        self.authority.issues[ISSUE]["state"] = {"id": "state-progress", "name": "In Progress", "type": "started"}
        child = replace(self.context, delegated_child=True)
        with patch.object(subprocess, "run", owner):
            reply = json.loads(chat.handle(self.bridge, {"action": "take_over", "issue": ISSUE, "id": REQUEST}, child))
        self.assertFalse(reply["ok"])
        with patch.object(type(self.board), "guarded_controls", property(lambda self: False)):
            self.assertEqual(self.take_over(owner)["code"], "takeover_refused")
        self.assertEqual(owner.calls, [])
        self.assertEqual(self.tasks(), [])

    def test_no_delegate_is_not_a_takeover(self):
        self.authority.issues[ISSUE]["delegate"] = None
        owner = OwnerCommand(handed_off())
        reply = self.take_over(owner)
        self.assertEqual(reply["code"], "not_delegated")
        self.assertIn("work_on", reply["message"])
        self.assertEqual(owner.calls, [])
        self.assertEqual(self.tasks(), [])

    # -- a failure after the task started here: the handover stands ------------------------------
    def test_a_failure_after_the_task_started_here_is_a_takeover_with_routing_unfinished(self):
        from hermes_fleet_linear_plugin import transport
        def subscription_down(*args, **kwargs):
            raise OSError("notify db locked")
        def outlook_down(*args, **kwargs):
            raise transport.Unavailable("linear down")
        for target, name, broken in ((Kanban, "subscribe_origin", subscription_down),
                                     (Bridge, "chat_route_outlook", outlook_down)):
            with self.subTest(step=name):
                self.setUp()
                owner = OwnerCommand(handed_off())
                with patch.object(target, name, broken):
                    reply = self.take_over(owner)
                self.assertTrue(reply["ok"], reply)
                self.assertIn("Took over OPS-1 from Atlas", reply["message"])
                self.assertIn("Finishing the setup hit a problem", reply["message"])
                self.assertEqual(len(owner.calls), 1)
                (task,) = self.tasks()
                self.assertIn(task["status"], ("ready", "running"))
                # Asking again (any id) never reaches Atlas and finishes the Linear update.
                again = OwnerCommand()
                retry = self.take_over(again, id=str(uuid.uuid4()))
                self.assertTrue(retry["ok"], retry)
                self.assertIn("already taken over from Atlas", retry["message"])
                self.assertEqual(again.calls, [])
                self.bridge.flush()
                self.assertEqual(self.delegate(), VIEWER)
                self.assertEqual(len(self.tasks()), 1)

    def test_unreadable_local_state_after_a_failed_start_reports_the_owner_paused(self):
        owner = OwnerCommand(handed_off())
        def broken(*args, **kwargs):
            raise KeyError("native")
        def unreadable(*args, **kwargs):
            raise OSError("board unreadable")
        with patch.object(Bridge, "entrust", broken), patch.object(Bridge, "takeover_local_status", unreadable):
            reply = self.take_over(owner)
        self.assert_paused_message(reply)
        self.assertEqual(len(owner.calls), 1)
        # The retry with the same id proves the same Stop and starts the work here.
        owner = OwnerCommand(handed_off())
        self.assertTrue(self.take_over(owner)["ok"])
        self.assertIn(self.tasks()[0]["status"], ("ready", "running"))

    def test_while_a_task_runs_here_the_owner_is_never_asked_anything(self):
        # Took over; Linear still shows Atlas (routing not flushed yet). Any retry never reaches Atlas.
        self.assertTrue(self.take_over(OwnerCommand(handed_off()), id=str(uuid.uuid4()))["ok"])
        self.assertEqual(self.delegate(), OWNER)
        for request in (REQUEST, str(uuid.uuid4())):
            with self.subTest(request=request):
                owner = OwnerCommand(PAUSED)
                reply = self.take_over(owner, id=request)
                self.assertTrue(reply["ok"], reply)
                self.assertEqual(owner.calls, [])
                self.assertEqual(len(self.tasks()), 1)
                self.assertIn(self.tasks()[0]["status"], ("ready", "running"))

    def test_other_work_already_running_here_is_refused_before_the_owner_is_asked(self):
        self.authority.issues[ISSUE]["delegate"] = None
        self.assertTrue(json.loads(chat.handle(self.bridge, {"action": "work_on", "issue": ISSUE}, self.context))["ok"])
        self.bridge.flush()
        self.authority.issues[ISSUE]["delegate"] = {"id": OWNER, "name": "Atlas"}
        self.authority.issues[ISSUE]["updatedAt"] = now_iso()
        before = self.tasks()
        owner = OwnerCommand(handed_off())
        reply = self.take_over(owner)
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], "takeover_refused")
        self.assertIn("already has work running on this issue", reply["message"])
        self.assertEqual(owner.calls, [])
        self.assertEqual(self.tasks(), before)

    # -- the old delegate's own writes never hold this agent's routing ------------------------
    def test_the_old_delegate_writing_after_the_read_still_routes_this_agent(self):
        real = Kanban.create
        def create(adapter, *args, **kwargs):
            task = real(adapter, *args, **kwargs)
            self.authority.issues[ISSUE]["updatedAt"] = (
                datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
            return task
        with patch.object(Kanban, "create", create):
            reply = self.take_over(OwnerCommand(handed_off()))
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["routing"], "queued")
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)

    def test_held_takeover_routing_is_retried_by_recovery(self):
        from hermes_fleet_linear_plugin.api import LinearError
        def unavailable(*args, **kwargs):
            raise LinearError("Linear unreachable (network error)")
        with patch.object(Bridge, "queue_delegate_self", unavailable):
            reply = self.take_over(OwnerCommand(handed_off()))
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["routing"], "held: will retry automatically")
        self.bridge.flush()
        self.assertEqual(self.delegate(), OWNER)
        self.bridge.pump_kanban()
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)

    def test_a_person_moving_the_issue_after_the_takeover_still_wins_routing(self):
        self.assertTrue(self.take_over(OwnerCommand(handed_off()))["ok"])
        issue = self.authority.issues[ISSUE]
        moved = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
        issue["updatedAt"] = moved
        issue["assignee"] = {"id": USER}
        self.authority.history.setdefault(ISSUE, []).append({
            "createdAt": moved, "actorId": USER, "fromStateId": issue["state"]["id"], "toStateId": issue["state"]["id"],
            "fromAssigneeId": None, "toAssigneeId": USER, "fromDelegate": {"id": OWNER}, "toDelegate": {"id": OWNER}})
        self.bridge.flush()
        self.assertEqual(self.delegate(), OWNER)

    def test_reads_before_the_owner_is_asked_run_under_a_linear_deadline(self):
        owner = OwnerCommand(handed_off())
        with patch.object(handoff, "BEFORE_OWNER_BUDGET_SECONDS", 1.0):
            reply = self.take_over(owner)
        self.assertFalse(reply["ok"])
        self.assertIn("too slowly", reply["message"])
        self.assertEqual(owner.calls, [])
        self.assertEqual(self.tasks(), [])

    # -- what the agent is told ---------------------------------------------------------------
    def test_work_on_refusal_and_guard_point_to_take_over_and_resume_owner(self):
        reply = json.loads(chat.handle(self.bridge, {"action": "work_on", "issue": ISSUE}, self.context))
        self.assertFalse(reply["ok"])
        self.assertIn("take_over", reply["message"])
        self.assertIn("was not touched", reply["message"])
        message = guard.block_message("QA-3", 6, 69)
        self.assertIn('"action": "take_over", "issue": "QA-3"', message)
        self.assertIn('"action": "resume_owner", "issue": "QA-3"', message)
        self.assertIn("Never stop another agent's task yourself", message)
        for action in ("take_over", "resume_owner"):
            self.assertIn(action, chat.SCHEMA["description"])
            self.assertIn(action, chat.SCHEMA["parameters"]["properties"]["action"]["enum"])
            self.assertTrue(guard._started("linear", {"action": action, "issue": "QA-3"}, json.dumps({"ok": True})))
            self.assertFalse(guard._started("linear", {"action": action, "issue": "QA-3"}, json.dumps({"ok": False})))
        self.assertIn("never kanban unblock", chat.SCHEMA["description"])


class TakeoverWording(unittest.TestCase):
    """What people read in Linear when an agent pauses its work for a handover."""

    def test_the_handover_pause_never_reads_as_waiting_on_you(self):
        from hermes_fleet_linear_plugin.bridge import _block_message
        kind, body = _block_message({"kind": "needs_input", "reason": handoff.handoff_reason("Nova", REQUEST)},
                                    "blocked")
        self.assertEqual(kind, "response")
        self.assertEqual(body, "Paused for a handover to Nova. Nothing is needed from you: Nova continues this "
                               "work once the handover is confirmed. If it doesn't complete, Nova says so here and "
                               "this work stays paused until someone asks Nova to let this agent continue or to "
                               "take it over again.")
        self.assertNotIn(REQUEST, body)
        # Should-fix 8: only the exact guarded pause is relabelled. Any other needs-input pause,
        # even one whose words mention a handover, keeps its ordinary "Waiting on you" wording.
        for reason in ("Ken requested Nova take over QA-3 (OPS-9). Stopping Atlas run for handoff; Nova owns the remainder.",
                       handoff.handoff_reason("Nova", REQUEST) + " please",
                       "Which account should I hand over to?", "Need the staging password before handing off the deploy",
                       "Handover to Atlas pending: confirm the region"):
            with self.subTest(reason=reason):
                kind, body = _block_message({"kind": "needs_input", "reason": reason}, "blocked")
                self.assertEqual(kind, "elicitation")
                self.assertTrue(body.startswith("**Waiting on you**"), body)


class TakeoverSettings(unittest.TestCase):
    def test_budgets_always_end_inside_the_chat_client_timeout(self):
        # Every phase of one take_over is bounded, and the bounds add up: one owner call now.
        wait, overhead = handoff.TAKEOVER_MAX_WAIT_SECONDS, handoff.OWNER_CALL_OVERHEAD_SECONDS
        self.assertGreaterEqual(handoff.CLIENT_TIMEOUT_SECONDS, handoff.BEFORE_OWNER_BUDGET_SECONDS
                                + wait + overhead + handoff.ENTRUST_BUDGET_SECONDS)
        # The owner's hand-off (brief lock wait) answers before the requester's subprocess timeout.
        self.assertLess(handoff.HANDOFF_LOCK_SECONDS + 30, overhead)
        # Each Linear phase lets at least one request start and finish.
        from hermes_fleet_linear_plugin import api
        self.assertGreater(handoff.BEFORE_OWNER_BUDGET_SECONDS, api.REQUEST_TIMEOUT_SECONDS)
        self.assertGreater(handoff.ENTRUST_BUDGET_SECONDS, api.REQUEST_TIMEOUT_SECONDS)
        seen = []
        def run(argv, **options):
            seen.append(options["timeout"])
            raise subprocess.TimeoutExpired(argv, options["timeout"])
        peer = {"name": "Atlas", "command": ["owner"], "wait_seconds": 30.0}
        self.assertIsNone(handoff.request(peer, {"id": "i", "identifier": "OPS-1", "url": "u"}, to="Nova",
                                          request_id=str(uuid.uuid4()), run=run))
        self.assertIsNone(handoff.request(peer, {"id": "i", "identifier": "OPS-1", "url": "u"}, to="Nova",
                                          request_id=str(uuid.uuid4()), resume=True, run=run))
        self.assertEqual(seen, [30.0 + overhead, overhead])  # A resume never waits for a proof.

    def test_a_linear_deadline_never_starts_a_request_it_cannot_finish(self):
        from hermes_fleet_linear_plugin.api import LinearAPI, LinearError
        sent = []
        def transport(url, body, headers):
            sent.append(body)
            return 200, {}, b'{"data": {"viewer": {"id": "v"}}}'
        api = LinearAPI(lambda: "token", transport=transport)
        with api.deadline(5), self.assertRaisesRegex(LinearError, "too slowly"):
            api.graphql("query Viewer { viewer { id } }")
        self.assertEqual(sent, [])
        with api.deadline(60):
            self.assertEqual(api.graphql("query Viewer { viewer { id } }"), {"viewer": {"id": "v"}})
        self.assertEqual(api.graphql("query Viewer { viewer { id } }"), {"viewer": {"id": "v"}})  # No deadline outside.
        self.assertEqual(len(sent), 2)

    def test_only_complete_entries_are_usable(self):
        parsed = handoff.takeover_settings({"name": "Nova", "agents": [
            {"name": "Atlas", "delegate_id": OWNER, "command": OWNER_COMMAND},
            {"name": "Bad", "delegate_id": STRANGER, "command": "host-bridge atlas"},
            {"name": "Slow", "delegate_id": "slow", "command": ["x"], "wait_seconds": 9999},
            {"delegate_id": "nameless", "command": ["x"]}]}, default_name="nova")
        self.assertEqual(set(parsed["agents"]), {OWNER})
        self.assertEqual(parsed["name"], "Nova")
        # Should-fix 4: a valid but long wait is capped so one take_over ends inside the client timeout.
        capped = handoff.takeover_settings({"agents": [
            {"name": "Atlas", "delegate_id": OWNER, "command": OWNER_COMMAND, "wait_seconds": 300}]}, default_name="nova")
        self.assertEqual(capped["agents"][OWNER]["wait_seconds"], handoff.TAKEOVER_MAX_WAIT_SECONDS)
        worst = handoff.TAKEOVER_MAX_WAIT_SECONDS + handoff.OWNER_CALL_OVERHEAD_SECONDS + handoff.ENTRUST_BUDGET_SECONDS
        self.assertLess(worst, handoff.CLIENT_TIMEOUT_SECONDS)
        seen = []
        handoff.request(capped["agents"][OWNER], {"id": ISSUE, "identifier": "OPS-1", "url": "u"}, to="Nova",
                        request_id=REQUEST, run=lambda argv, **options: seen.append(options["timeout"]))
        self.assertEqual(seen, [handoff.TAKEOVER_MAX_WAIT_SECONDS + handoff.OWNER_CALL_OVERHEAD_SECONDS])
        self.assertEqual(handoff.takeover_settings(None, default_name="nova"), {"name": "nova", "agents": {}})


if __name__ == "__main__":
    unittest.main()
