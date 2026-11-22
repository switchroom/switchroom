"""take_over over A2A: real upstream Kanban on both agents, the registered chat handler, a synthetic Linear.

The requesting agent (Nova) reaches the owner (Atlas) only through core's ``a2a_call``, simulated
by a recorded dispatch that runs Atlas's own ``linear`` ``hand_off`` (its own Bridge, board, store
and Linear app identity) and answers as ``a2a_call`` does. Two rules hold throughout:

1. Never both agents running the issue's work: Nova starts only after Atlas confirmed it paused its
   card AND a fresh Linear read shows Atlas is no longer the delegate. ``assert_exclusive`` checks
   both boards at Nova's admission and after every step.
2. Never nobody running without a plain message: whenever Atlas may be paused and nothing runs on
   Nova, the reply and a Linear comment say so, and nothing resumes Atlas automatically.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
import re
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
from hermes_fleet_linear_plugin import chat, diag, takeover
from hermes_fleet_linear_plugin.api import LinearError
from hermes_fleet_linear_plugin.bridge import Bridge, Kanban
from hermes_fleet_linear_plugin.store import Store
from hermes_fleet_linear_plugin.transport import NativeContext
from test_linear_chat_entrust_scenarios import ChatAuthority, now_iso
from test_linear_specialist_authorization import ISSUE, ORG, VIEWER

OWNER = str(uuid.UUID(int=0x99, version=4))
REQUEST = str(uuid.UUID(int=0x5150, version=4))
RUNNABLE = ("ready", "running")


class SharedLinear(ChatAuthority):
    """One synthetic Linear workspace seen by two app identities: issue, history and comments are shared,
    and each app's own delegate writes are recorded under its own actor id."""

    def __init__(self, viewer=VIEWER, shared=None):
        super().__init__()
        self.viewer = viewer
        if shared is not None:
            for name in ("issues", "history", "comment_bodies", "comments", "comment_records", "sessions", "activities"):
                setattr(self, name, getattr(shared, name))

    def transport(self, url, body, headers):
        payload = json.loads(body)
        ident = (payload.get("variables") or {}).get("id")
        if "query Issue(" in payload["query"] and ident not in self.issues:
            # Linear resolves an issue key as well as its id.
            match = next((key for key, issue in self.issues.items() if issue.get("identifier") == ident), None)
            if match:
                payload["variables"]["id"] = match
                body = json.dumps(payload)
        before = len(self.history.get(ISSUE, []))
        result = super().transport(url, body, headers)
        for entry in self.history.get(ISSUE, [])[before:]:
            entry["actorId"] = self.viewer
        return result


class TakeoverSettingsTests(unittest.TestCase):
    def test_entries_need_an_a2a_peer_and_command_is_no_longer_read(self):
        raw = {"name": "Nova", "agents": [
            {"name": "Atlas", "delegate_id": OWNER, "a2a": "atlas", "wait_seconds": 30},
            {"name": "Old", "delegate_id": "old", "command": ["host-bridge", "--", "hermes"]},
            {"name": "Slow", "delegate_id": "slow", "a2a": "slow", "wait_seconds": 301},
            {"name": "Bad name!", "delegate_id": "bad", "a2a": "bad"}, "not-an-entry"]}
        with self.assertLogs(diag.LOGGER_NAME, level="INFO") as logs:
            parsed = takeover.settings(raw, default_name="default")
        self.assertEqual(parsed, {"name": "Nova", "agents": {
            OWNER: {"name": "Atlas", "a2a": "atlas", "wait_seconds": 30.0}}})
        self.assertEqual(sum("takeover_unavailable" in line for line in logs.output), 4)
        self.assertEqual(takeover.settings(None, default_name="nova"), {"name": "nova", "agents": {}})

    def test_reply_parsing_is_strict(self):
        good = {"ok": True, "handed_off": True, "paused": True, "resumed": False, "issue_id": ISSUE,
                "request_id": REQUEST, "message": "Atlas's work is paused."}
        header = "[atlas · context c1 · completed]\n"
        for text in (header + json.dumps(good), header + "```json\n" + json.dumps(good) + "\n```", json.dumps(good)):
            self.assertEqual(takeover.parse(text, issue_id=ISSUE, request_id=REQUEST), good)
        for bad in ("Done! I handed it over.", header + "(no text reply)", header + json.dumps([good]),
                    header + json.dumps({**good, "issue_id": "another"}), header + json.dumps({**good, "request_id": "x"}),
                    header + json.dumps({**good, "handed_off": "yes"}), header + "Sure: " + json.dumps(good)):
            self.assertIsNone(takeover.parse(bad, issue_id=ISSUE, request_id=REQUEST), bad)

    def test_ask_tells_unsent_from_unknown_and_honours_the_wait(self):
        peer = {"name": "Atlas", "a2a": "atlas", "wait_seconds": 0.2}
        issue = {"id": ISSUE, "identifier": "OPS-1"}
        for unsent in ("Error: unknown agent 'atlas'. Configure it under 'a2a_agents' in config.yaml or pass a full http(s):// URL.",
                       "Error: peer 'atlas' rejected auth (HTTP 401). Check the configured token.",
                       {"error": "Unknown tool: a2a_call"}):
            self.assertEqual(takeover.ask(peer, issue, to="Nova", request_id=REQUEST, dispatch=lambda a, m: unsent),
                             {"sent": False})
        for unknown in ("Error: call to 'atlas' failed — timed out.", "I paused it."):
            self.assertEqual(takeover.ask(peer, issue, to="Nova", request_id=REQUEST, dispatch=lambda a, m: unknown),
                             {"sent": True, "reply": None})
        started = time.monotonic()
        self.assertEqual(takeover.ask(peer, issue, to="Nova", request_id=REQUEST,
                                      dispatch=lambda a, m: time.sleep(2) or "late"), {"sent": True, "reply": None})
        self.assertLess(time.monotonic() - started, 1.5)
        seen = []
        takeover.ask(peer, issue, to="Nova", request_id=REQUEST, resume=True,
                     dispatch=lambda agent, message: seen.append((agent, message)) or "")
        (agent, message), = seen
        self.assertEqual(agent, "atlas")
        args = json.loads(re.search(r"arguments: (\{.*?\}) Then", message).group(1))
        self.assertEqual(args, {"action": "hand_off", "issue": "OPS-1", "to": "Nova", "id": REQUEST, "resume": True})


class TwoAgents(unittest.TestCase):
    """Nova (this agent) and Atlas (the owner, working the issue from its own chat)."""

    def setUp(self):
        self.temps = []
        self.home = self.tempdir("linear-takeover-nova-")
        self.owner_home = self.tempdir("linear-takeover-atlas-")
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("HERMES_KANBAN_") and key != "HERMES_DELEGATED_CHILD_CONTEXT"}
        environment.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home / "board"), HERMES_PROFILE="default")
        self.env = patch.dict(os.environ, environment, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.linear = SharedLinear()
        self.linear.issues[ISSUE]["state"] = {"id": "state-progress", "name": "In Progress", "type": "started"}
        self.linear.issues[ISSUE]["updatedAt"] = now_iso()
        self.owner_linear = SharedLinear(OWNER, shared=self.linear)
        # Atlas: its own home, board, store and Linear app. It starts the work from its own chat.
        with self.as_owner():
            self.owner_board = Kanban(profile="default", profile_home=self.owner_home)
            if not self.owner_board.guarded_controls:
                self.skipTest("native host predates guarded admission")
            self.owner = Bridge(Store(self.owner_home / "linear.db"),
                                self.owner_linear.api(scope=None, identity={"viewer_id": OWNER, "organization_id": ORG}),
                                self.owner_board, profile="default", settings={"takeover": {"name": "Atlas"}})
            self.owner.profile_home = self.owner_home
            self.owner_context = NativeContext(home=str(self.owner_home), profile="default", platform="telegram",
                                               source="telegram", session_key="telegram:atlas-chat", session_id="atlas-chat",
                                               user_id="human-2", chat_id="atlas-chat", chat_type="dm")
            started = json.loads(chat.handle(self.owner, {"action": "work_on", "issue": ISSUE}, self.owner_context))
            self.assertTrue(started["ok"], started)
            self.owner.flush()
            self.owner_task = self.owner.store.get(ISSUE)["task_id"]
        self.assertEqual(self.delegate(), OWNER)
        self.assertIn(self.owner_status(), RUNNABLE)
        # Nova: this agent.
        self.board = Kanban(profile="default", profile_home=self.home)
        settings = {"takeover": {"name": "Nova", "agents": [
            {"name": "Atlas", "delegate_id": OWNER, "a2a": "atlas", "wait_seconds": 5}]}}
        self.bridge = Bridge(Store(self.home / "linear.db"), self.linear.api(scope=None), self.board,
                             profile="default", settings=settings)
        self.bridge.profile_home = self.home
        self.context = NativeContext(home=str(self.home), profile="default", platform="slack", source="slack",
                                     session_key="slack:chat-1:thread-1", session_id="chat-session", user_id="human-1",
                                     chat_id="chat-1", chat_type="dm", thread_id="thread-1", scope_id="workspace-1")
        self.a2a_calls = []
        # Every admission on Nova's board is checked against Atlas's board at that instant.
        activate = self.board.activate
        def checked_activate(*args, **kwargs):
            accepted = activate(*args, **kwargs)
            self.assert_exclusive()
            return accepted
        self.board.activate = checked_activate

    def tempdir(self, prefix):
        temp = tempfile.TemporaryDirectory(prefix=prefix)
        self.addCleanup(temp.cleanup)
        return Path(temp.name).resolve()

    @contextmanager
    def as_owner(self):
        """Atlas's process: its own Hermes home and Kanban home (both read from the environment per call)."""
        with patch.dict(os.environ, {"HERMES_HOME": str(self.owner_home),
                                     "HERMES_KANBAN_HOME": str(self.owner_home / "board")}):
            yield

    # -- the A2A peer ---------------------------------------------------------------------------
    def atlas(self, *, answer=None, call_tool=True):
        """a2a_call to Atlas: run its real hand_off, then answer with that JSON (or ``answer(reply)``)."""
        def dispatch(agent, message):
            args = json.loads(re.search(r"arguments: (\{.*?\}) Then", message).group(1))
            self.a2a_calls.append((agent, args))
            reply = ""
            if call_tool:
                with self.as_owner():
                    reply = chat.handle(self.owner, args, NativeContext(
                        home=str(self.owner_home), profile="default", platform="a2a", source="a2a",
                        session_key="a2a:nova", session_id="a2a-session", chat_id="nova"))
                self.assert_exclusive()
            body = answer(reply) if answer else reply
            return f"[{agent} · context ctx-1 · completed]\n{body}"
        return patch.object(takeover, "a2a_call", dispatch)

    def take_over(self, request=REQUEST, **atlas):
        with self.atlas(**atlas):
            return json.loads(chat.handle(self.bridge, {"action": "take_over", "issue": ISSUE, "id": request},
                                          self.context))

    def resume_owner(self, request=None, **atlas):
        with self.atlas(**atlas):
            return json.loads(chat.handle(self.bridge, {"action": "resume_owner", "issue": ISSUE,
                                                         "id": request or str(uuid.uuid4())}, self.context))

    # -- observations ---------------------------------------------------------------------------
    def delegate(self):
        return (self.linear.issues[ISSUE].get("delegate") or {}).get("id")

    def tasks(self):
        with self.board.conn() as conn:
            return [dict(row) for row in conn.execute("SELECT id, status, body FROM tasks")]

    def owner_status(self):
        with self.as_owner(), self.owner_board.conn() as conn:
            return conn.execute("SELECT status FROM tasks WHERE id=?", (self.owner_task,)).fetchone()["status"]

    def owner_blocks(self):
        with self.as_owner():
            return [event for event in self.owner_board.history(self.owner_task, 0)
                    if event.kind in ("blocked", "block_loop_detected")
                    and (event.payload or {}).get("reason") != "initial_status"]  # not the creation's own parking

    def assert_exclusive(self):
        ours = [task["status"] for task in self.tasks()]
        self.assertFalse(self.owner_status() in RUNNABLE and any(status in RUNNABLE for status in ours),
                         f"both agents runnable: Atlas {self.owner_status()}, Nova {ours}")

    def notices(self):
        self.bridge.flush()
        return [body for issue, body in self.linear.comment_bodies if issue == ISSUE
                and "handover" in body]

    def assert_paused_message(self, reply, *, may=False):
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], "takeover_paused")
        state = "may be paused" if may else "is paused"
        self.assertIn(f"Atlas's work on OPS-1 {state} for a handover to Nova that didn't complete", reply["message"])
        self.assertIn("Say 'resume OPS-1' to let Atlas continue, or 'take over OPS-1' to try again.", reply["message"])
        self.assertNotRegex(reply["message"], r"handoff:|native_|\{")
        self.assertEqual(self.notices(), [
            f"Atlas's work on OPS-1 {state} for a handover to Nova that didn't complete. Nothing resumes it "
            "automatically. Ask Nova to 'resume OPS-1' to let Atlas continue, or to 'take over OPS-1' to try again."])
        self.assertFalse(any(task["status"] in RUNNABLE for task in self.tasks()), self.tasks())
        self.assert_exclusive()

    def assert_owner_paused_for_nova(self):
        self.assertEqual(self.owner_status(), "blocked")
        pause, = self.owner_blocks()
        self.assertRegex(pause.payload["reason"], r"^Paused for a handover to Nova \[handoff:[0-9a-f-]{36}\]$")
        self.assertEqual(pause.payload["kind"], "needs_input")


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class TakeoverScenarios(TwoAgents):
    # -- success ------------------------------------------------------------------------------
    def test_owner_pauses_and_undelegates_then_one_task_runs_here(self):
        reply = self.take_over()
        self.assertTrue(reply["ok"], reply)
        self.assertIn("Took over OPS-1 from Atlas: Atlas paused its work and is no longer the delegate", reply["message"])
        self.assertEqual(self.a2a_calls, [("atlas", {"action": "hand_off", "issue": "OPS-1", "to": "Nova", "id": REQUEST})])
        self.assert_owner_paused_for_nova()
        self.assertEqual(self.owner_blocks()[0].payload["reason"], f"Paused for a handover to Nova [handoff:{REQUEST}]")
        (task,) = self.tasks()
        self.assertIn(task["status"], RUNNABLE)
        self.assertIn("Atlas worked on this issue before and paused", task["body"])
        self.assert_exclusive()
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)
        # Atlas never re-adds itself as delegate, and none of its later ticks resumes its work.
        with self.as_owner():
            self.owner.tick()
            self.owner.flush()
        self.assertEqual(self.delegate(), VIEWER)
        self.assertEqual(self.owner_status(), "blocked")
        self.assert_exclusive()
        # Asking again is plain reuse: Atlas is not asked again and no second task starts.
        again = self.take_over(str(uuid.uuid4()))
        self.assertTrue(again["ok"], again)
        self.assertEqual(len(self.a2a_calls), 1)
        self.assertEqual(len(self.tasks()), 1)

    # -- refusals: nothing changes, nobody is paused ------------------------------------------------
    def test_owner_refuses_and_nothing_changes(self):
        with self.as_owner(), self.owner_board.conn() as conn:
            self.owner_board.kb.block_task(conn, self.owner_task, reason="Waiting for the design review", kind="needs_input")
        reply = self.take_over()
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], "takeover_refused")
        self.assertIn("Not taken over. Atlas's work on OPS-1 is paused, so it was left as it is", reply["message"])
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.delegate(), OWNER)
        self.assertEqual([e.payload["reason"] for e in self.owner_blocks()], ["Waiting for the design review"])
        self.assertEqual(self.notices(), [])

    def test_a2a_not_reaching_the_owner_changes_nothing(self):
        with patch.object(takeover, "a2a_call", lambda agent, message: f"Error: unknown agent '{agent}'. Configure it."):
            reply = json.loads(chat.handle(self.bridge, {"action": "take_over", "issue": ISSUE, "id": REQUEST}, self.context))
        self.assertEqual(reply["code"], "takeover_unavailable", reply)
        self.assertIn("Atlas keeps working on OPS-1", reply["message"])
        self.assertIn(self.owner_status(), RUNNABLE)
        self.assertEqual((self.tasks(), self.delegate(), self.notices()), ([], OWNER, []))

    # -- the owner may be paused and nothing runs here: a plain message, never a silent gap --------
    def test_unconfirmed_answer_starts_nothing_and_says_the_owner_may_be_paused(self):
        reply = self.take_over(answer=lambda tool_json: "Done, I've handed OPS-1 over to Nova.")
        self.assert_paused_message(reply, may=True)
        self.assertIn("Atlas didn't confirm the handover", reply["message"])
        self.assert_owner_paused_for_nova()  # It did pause; the requester could not know.
        self.assertIsNone(self.delegate())
        self.assertEqual(self.tasks(), [])

    def test_silent_owner_starts_nothing_and_says_the_owner_may_be_paused(self):
        self.bridge.takeover["agents"][OWNER]["wait_seconds"] = 0.2
        with patch.object(takeover, "a2a_call", lambda agent, message: time.sleep(1) or ""):
            reply = json.loads(chat.handle(self.bridge, {"action": "take_over", "issue": ISSUE, "id": REQUEST}, self.context))
        self.assert_paused_message(reply, may=True)
        self.assertIn(self.owner_status(), RUNNABLE)
        self.assertEqual(self.tasks(), [])

    def test_confirmation_while_linear_still_shows_the_owner_starts_nothing(self):
        claimed = {"ok": True, "handed_off": True, "paused": True, "resumed": False, "issue_id": ISSUE,
                   "request_id": REQUEST, "message": "Atlas's work on OPS-1 is paused; Nova can continue it."}
        reply = self.take_over(call_tool=False, answer=lambda _: json.dumps(claimed))
        self.assert_paused_message(reply)
        self.assertIn("Linear still shows Atlas as the delegate", reply["message"])
        self.assertEqual((self.tasks(), self.delegate()), ([], OWNER))

    def test_a_failed_start_after_the_pause_leaves_the_owner_paused_with_a_plain_message(self):
        with patch.object(Bridge, "entrust", side_effect=LinearError("Linear is answering too slowly to finish this in time")):
            reply = self.take_over()
        self.assert_paused_message(reply)
        self.assertIn("Atlas paused for the handover, but the work couldn't start here "
                      "(Linear is answering too slowly to finish this in time)", reply["message"])
        self.assert_owner_paused_for_nova()
        self.assertIsNone(self.delegate())
        # Nothing resumes Atlas by itself: Nova's ticks ask nobody anything.
        with self.atlas():
            self.bridge.tick()
        self.assertEqual(len(self.a2a_calls), 1)
        self.assertEqual(self.owner_status(), "blocked")

    # -- the two ways on ------------------------------------------------------------------------
    def test_retry_after_a_failed_start_never_pauses_twice_and_starts_here(self):
        with patch.object(Bridge, "entrust", side_effect=LinearError("Linear is answering too slowly to finish this in time")):
            self.take_over()
        for request in (REQUEST, str(uuid.uuid4())):  # the same id, then a new take_over
            with self.subTest(request=request):
                with self.as_owner():  # Atlas's own hand_off is idempotent for the same agent.
                    retry = json.loads(chat.handle(self.owner, {"action": "hand_off", "issue": "OPS-1", "to": "Nova",
                                                                "id": request}, self.owner_context))
                self.assertTrue(retry["handed_off"], retry)
                self.assertEqual(len(self.owner_blocks()), 1)
        reply = self.take_over(str(uuid.uuid4()))
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(len(self.owner_blocks()), 1)
        (task,) = self.tasks()
        self.assertIn(task["status"], RUNNABLE)
        self.assert_exclusive()

    def test_resume_lets_the_owner_continue_and_redelegates_it(self):
        with patch.object(Bridge, "entrust", side_effect=LinearError("Linear is answering too slowly to finish this in time")):
            self.take_over()
        self.assertIsNone(self.delegate())
        reply = self.resume_owner()
        self.assertTrue(reply["ok"], reply)
        self.assertIn("Atlas continues its work on OPS-1", reply["message"])
        self.assertEqual(self.a2a_calls[-1][1]["resume"], True)
        self.assertIn(self.owner_status(), RUNNABLE)
        self.assertEqual(self.delegate(), OWNER)
        self.assertEqual(self.tasks(), [])
        self.assert_exclusive()
        # A second resume finds no handover pause and changes nothing.
        again = self.resume_owner()
        self.assertEqual(again["code"], "resume_refused", again)
        self.assertIn(self.owner_status(), RUNNABLE)

    def test_resume_is_refused_while_the_work_runs_here(self):
        self.assertTrue(self.take_over()["ok"])
        self.bridge.flush()
        reply = self.resume_owner()
        self.assertEqual(reply["code"], "resume_refused", reply)
        self.assertEqual(len(self.a2a_calls), 1)
        self.assertEqual(self.owner_status(), "blocked")
        self.assert_exclusive()


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class OwnerHandOffScenarios(TwoAgents):
    """Atlas's hand_off on its own: plain upstream block_task / unblock_task on a real board."""

    def hand_off(self, **args):
        with self.as_owner():
            return json.loads(chat.handle(self.owner, {"action": "hand_off", "issue": "OPS-1", "to": "Nova",
                                                       "id": REQUEST, **args}, self.owner_context))

    def test_running_task_is_paused_plainly_and_the_owner_stops_being_delegate(self):
        with self.as_owner(), self.owner_board.conn() as conn:
            self.assertIsNotNone(self.owner_board.kb.claim_task(conn, self.owner_task, claimer="fixture-host"))
        self.assertEqual(self.owner_status(), "running")
        reply = self.hand_off()
        self.assertEqual({k: reply[k] for k in ("ok", "handed_off", "paused", "resumed", "issue_id", "request_id")},
                         {"ok": True, "handed_off": True, "paused": True, "resumed": False, "issue_id": ISSUE,
                          "request_id": REQUEST})
        self.assertEqual(reply["message"], "Atlas's work on OPS-1 is paused and Atlas is no longer its delegate; "
                                           "Nova can continue it.")
        self.assert_owner_paused_for_nova()
        self.assertIsNone(self.delegate())
        with self.as_owner(), self.owner_board.read_conn() as conn:
            runs = [dict(r) for r in conn.execute("SELECT status, ended_at FROM task_runs WHERE task_id=?",
                                                  (self.owner_task,))]
        self.assertTrue(runs and all(run["ended_at"] for run in runs), runs)  # the run ended with the block
        with self.as_owner():
            key = f"delegate-recovery:{ISSUE}:{self.owner.store.binding_revision(ISSUE)}"
            self.assertEqual(self.owner.store.native_intent(key)["reason"], "handed_off")

    def test_retry_is_idempotent_and_resume_lifts_only_a_handover_pause(self):
        self.assertTrue(self.hand_off()["handed_off"])
        self.assertTrue(self.hand_off()["handed_off"])
        self.assertEqual(len(self.owner_blocks()), 1)
        refused = self.hand_off(to="Vega", resume=True)
        self.assertEqual((refused["ok"], refused["resumed"]), (False, False))
        self.assertEqual(self.owner_status(), "blocked")
        resumed = self.hand_off(id=str(uuid.uuid4()), resume=True)
        self.assertTrue(resumed["resumed"], resumed)
        self.assertIn(self.owner_status(), RUNNABLE)
        self.assertEqual(self.delegate(), OWNER)

    def test_resume_never_lifts_a_persons_pause(self):
        with self.as_owner(), self.owner_board.conn() as conn:
            self.owner_board.kb.block_task(conn, self.owner_task, reason="Stopped by Sam", kind="needs_input")
        reply = self.hand_off(resume=True)
        self.assertFalse(reply["ok"])
        self.assertIn("isn't paused for a handover to Nova", reply["message"])
        self.assertEqual(self.owner_status(), "blocked")

    def test_resume_is_refused_while_another_agent_is_delegate(self):
        self.assertTrue(self.hand_off()["handed_off"])
        self.linear.issues[ISSUE]["delegate"] = {"id": "vega-app", "name": "Vega"}
        reply = self.hand_off(resume=True)
        self.assertFalse(reply["ok"])
        self.assertIn("delegated to Vega", reply["message"])
        self.assertEqual(self.owner_status(), "blocked")

    def test_finished_or_unbound_work_is_refused_with_nothing_changed(self):
        with self.as_owner(), self.owner_board.conn() as conn:
            self.owner_board.kb.complete_task(conn, self.owner_task, summary="done")
        reply = self.hand_off()
        self.assertFalse(reply["ok"])
        self.assertIn("has already finished", reply["message"])
        self.assertEqual(self.delegate(), OWNER)
        other = str(uuid.UUID(int=0x1234, version=4))
        self.linear.issues[other] = {**self.linear.issues[ISSUE], "id": other, "identifier": "OPS-9",
                                     "url": "https://linear.example/issue/OPS-9"}
        reply = self.hand_off(issue="OPS-9")
        self.assertFalse(reply["ok"])
        self.assertIn("has no tracked work linked to OPS-9", reply["message"])


if __name__ == "__main__":
    unittest.main()
