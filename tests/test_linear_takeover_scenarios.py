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
from dataclasses import replace
from datetime import datetime, timedelta, timezone
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
from test_linear_specialist_authorization import ISSUE, ORG, USER, VIEWER

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
            if entry.get("toDelegate") == {"id": None}:
                entry["toDelegate"] = None
        for issue in self.issues.values():
            if issue.get("delegate") == {"id": None}:
                issue["delegate"] = None  # Linear reads back no delegate as null
        return result


class TakeoverSettingsTests(unittest.TestCase):
    def test_entries_need_an_a2a_peer_and_command_is_no_longer_read(self):
        raw = {"name": "Nova", "agents": [
            {"name": "Atlas", "delegate_id": OWNER, "a2a": "atlas", "wait_seconds": 30},
            {"name": "Old", "delegate_id": "old", "command": ["host-bridge", "--", "hermes"]},
            {"name": "Slow", "delegate_id": "slow", "a2a": "slow", "wait_seconds": 301},
            {"name": "Bad name!", "delegate_id": "bad", "a2a": "bad"}, "not-an-entry"],
               "allow": [{"name": "Vega", "a2a": "vega"}, {"name": "No peer"}]}
        with self.assertLogs(diag.LOGGER_NAME, level="INFO") as logs:
            parsed = takeover.settings(raw, default_name="default")
        self.assertEqual(parsed, {"name": "Nova", "agents": {
            OWNER: {"name": "Atlas", "a2a": "atlas", "wait_seconds": 30.0}}, "allow": {"Vega": "vega"}})
        self.assertEqual(sum("takeover_unavailable" in line for line in logs.output), 5)
        self.assertEqual(takeover.settings(None, default_name="nova"), {"name": "nova", "agents": {}, "allow": {}})

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
                                self.owner_board, profile="default",
                                settings={"takeover": {"name": "Atlas", "allow": [{"name": "Nova", "a2a": "nova"}]}})
            self.owner.profile_home = self.owner_home
            self.owner_context = NativeContext(home=str(self.owner_home), profile="default", platform="telegram",
                                               source="telegram", session_key="telegram:atlas-chat", session_id="atlas-chat",
                                               user_id="human-2", chat_id="atlas-chat", chat_type="dm")
            started = json.loads(chat.handle(self.owner, {"action": "work_on", "issue": ISSUE}, self.owner_context))
            self.assertTrue(started["ok"], started)
            self.owner.flush()
            self.owner_task = self.owner.store.get(ISSUE)["task_id"]
        # Atlas's work began well before anyone asks Nova to take it over. Linear's record of
        # that (Atlas delegating itself) must not sit inside the whole second Kanban stamps on
        # Nova's new task, which is the fence delegate recovery uses for a receipt-only admission.
        earlier = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        for node in self.linear.history.get(ISSUE, []):
            node["createdAt"] = earlier
        self.linear.issues[ISSUE]["updatedAt"] = earlier
        # Nova's A2A requests reach Atlas authenticated as the peer "nova".
        self.a2a_context = NativeContext(home=str(self.owner_home), profile="default", platform="a2a", source="a2a",
                                         session_key="a2a:nova", session_id="a2a-session", user_id="nova", chat_id="nova")
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
        board = self.board
        def checked_activate(*args, **kwargs):
            accepted = type(board).activate(board, *args, **kwargs)  # whatever a test patched in
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
                    reply = chat.handle(self.owner, args, self.a2a_context)
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
                and "didn't complete" in body]

    def owner_notices(self):
        with self.as_owner():
            self.owner.flush()
        return [body for issue, body in self.linear.comment_bodies if issue == ISSUE and "paused its work" in body]

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
                                                                "id": request}, self.a2a_context))
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

    def hand_off(self, context=None, **args):
        with self.as_owner():
            return json.loads(chat.handle(self.owner, {"action": "hand_off", "issue": "OPS-1", "to": "Nova",
                                                       "id": REQUEST, **args}, context or self.a2a_context))

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
        reply = self.hand_off(issue="OPS-9", id=str(uuid.uuid4()))
        self.assertFalse(reply["ok"])
        self.assertIn("has no tracked work linked to OPS-9", reply["message"])



@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class OwnerSafetyScenarios(TwoAgents):
    """Who may pause or resume Atlas, and when a pause counts as handed over."""

    def hand_off(self, context=None, **args):
        with self.as_owner():
            return json.loads(chat.handle(self.owner, {"action": "hand_off", "issue": "OPS-1", "to": "Nova",
                                                       "id": REQUEST, **args}, context or self.a2a_context))

    def test_only_an_allowed_peer_over_a2a_can_pause_the_owner(self):
        for context, args in ((self.owner_context, {}),  # Atlas's own chat (or a Linear prompt) asking
                              (replace(self.a2a_context, user_id="vega"), {}),  # another A2A peer claiming Nova's name
                              (self.a2a_context, {"to": "Nobody"})):  # a name Atlas does not allow
            with self.subTest(platform=context.platform, user=context.user_id, **args):
                reply = self.hand_off(context, **args)
                self.assertEqual((reply["ok"], reply["handed_off"], reply["paused"]), (False, False, False), reply)
                self.assertIn("nothing was changed", reply["message"])
                self.assertIn(self.owner_status(), RUNNABLE)
                self.assertEqual(self.delegate(), OWNER)
                self.assertEqual(self.owner_blocks(), [])

    def test_the_owners_own_chat_can_never_resume_beside_the_requester(self):
        # The reviewer's probe: Nova took over and its delegate write is still in its outbox, so
        # Linear shows no delegate. Atlas's own chat asking hand_off resume is refused.
        self.assertTrue(self.take_over()["ok"])
        self.assertIsNone(self.delegate())
        reply = self.hand_off(self.owner_context, id=str(uuid.uuid4()), resume=True)
        self.assertFalse(reply["ok"], reply)
        self.assertFalse(reply["resumed"])
        self.assertEqual(self.owner_status(), "blocked")
        self.assert_exclusive()
        # And Nova's resume_owner is refused while the work runs here, so Atlas is never asked.
        self.assertEqual(self.resume_owner()["code"], "resume_refused")
        self.assertEqual(len(self.a2a_calls), 1)
        self.assert_exclusive()
        self.assertNotIn("hand_off with resume", chat.SCHEMA["description"])

    def test_every_pause_is_announced_by_the_owner_itself(self):
        self.bridge.takeover["agents"][OWNER]["wait_seconds"] = 0.2
        late = []
        def vanished(agent, message):  # Nova times out; Atlas pauses later and nobody answers.
            late.append(json.loads(re.search(r"arguments: (\{.*?\}) Then", message).group(1)))
            return time.sleep(1) or ""
        with patch.object(takeover, "a2a_call", vanished):
            json.loads(chat.handle(self.bridge, {"action": "take_over", "issue": ISSUE, "id": REQUEST}, self.context))
        reply = self.hand_off(**{k: v for k, v in late[0].items() if k in ("id",)})
        self.assertTrue(reply["handed_off"], reply)
        self.assertEqual(self.owner_notices(), [
            "Atlas paused its work on OPS-1 for a handover to Nova. If Nova doesn't start it, ask Nova to "
            "'resume OPS-1' to let Atlas continue. Nothing resumes it automatically."])
        self.hand_off()  # A retry is not a second pause and posts nothing more.
        self.assertEqual(len(self.owner_notices()), 1)

    def test_open_child_tasks_are_refused_with_nothing_changed(self):
        with self.as_owner(), self.owner_board.conn() as conn:
            self.owner_board.kb.create_task(conn, title="Sub-step", assignee="default", creator_task_id=self.owner_task)
        reply = self.take_over()
        self.assertEqual(reply["code"], "takeover_refused", reply)
        self.assertIn("started other tasks that are still open", reply["message"])
        self.assertIn(self.owner_status(), RUNNABLE)
        self.assertEqual((self.tasks(), self.delegate()), ([], OWNER))

    def test_paused_is_not_handed_over_until_the_worker_has_exited(self):
        import subprocess
        worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(lambda: (worker.kill(), worker.wait()))
        with self.as_owner(), self.owner_board.conn() as conn:
            claimed = self.owner_board.kb.claim_task(conn, self.owner_task, claimer="fixture-host")
            conn.execute("UPDATE task_runs SET worker_pid=? WHERE id=?", (worker.pid, claimed.current_run_id))
        with patch.object(takeover, "EXIT_WAIT_SECONDS", 0.5), patch.object(takeover, "EXIT_POLL_SECONDS", 0.1):
            reply = self.take_over()
        self.assert_paused_message(reply)
        self.assertIn("its run hadn't finished stopping yet", reply["message"])
        self.assertEqual((self.owner_status(), self.delegate()), ("blocked", OWNER))  # still the delegate
        worker.kill()
        worker.wait()
        again = self.take_over(str(uuid.uuid4()))
        self.assertTrue(again["ok"], again)
        self.assertEqual(len(self.owner_blocks()), 1)
        self.assertIsNone(self.delegate())
        self.assert_exclusive()

    def test_a_late_pause_after_a_resume_answered_it_is_refused(self):
        # Nova's take_over times out before Atlas sees it; a person then says resume, which
        # carries the same request id. The late original arriving afterwards changes nothing.
        self.bridge.takeover["agents"][OWNER]["wait_seconds"] = 0.2
        with patch.object(takeover, "a2a_call", lambda agent, message: time.sleep(1) or ""):
            json.loads(chat.handle(self.bridge, {"action": "take_over", "issue": ISSUE, "id": REQUEST}, self.context))
        self.bridge.takeover["agents"][OWNER]["wait_seconds"] = 5
        refused = self.resume_owner()
        self.assertEqual(refused["code"], "resume_refused", refused)
        self.assertEqual(self.a2a_calls[-1][1], {"action": "hand_off", "issue": "OPS-1", "to": "Nova", "id": REQUEST,
                                                 "resume": True})
        late = self.hand_off()
        self.assertFalse(late["ok"], late)
        self.assertIn("already answered", late["message"])
        self.assertIn(self.owner_status(), RUNNABLE)
        self.assertEqual(self.delegate(), OWNER)

    def test_the_remembered_owner_is_cleared_once_the_work_starts_here(self):
        self.assertTrue(self.take_over()["ok"])
        self.assertIsNone(self.bridge.store.takeover_from(ISSUE))


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class TakeoverGuardScenarios(TwoAgents):
    """The bridge guards this change keeps: admission only by the take_over call that has just seen
    the handover, a person's routing change winning, and plain replies whatever fails after it."""

    def assert_nothing_runs_here(self):
        self.assertFalse(any(task["status"] in RUNNABLE for task in self.tasks()), self.tasks())
        self.assert_exclusive()

    def later_request(self, seconds=5):
        self.bridge.clock = lambda: time.time() + seconds

    def _routing_change_at_create(self, actor, to_state="state-todo", assignee=None):
        """A routing change by ``actor`` lands right after Nova's task is created, before admission."""
        real = Kanban.create
        def create(adapter, *args, **kwargs):
            task = real(adapter, *args, **kwargs)
            issue = self.linear.issues[ISSUE]
            moved = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
            issue["updatedAt"] = moved
            self.linear.history.setdefault(ISSUE, []).append({
                "createdAt": moved, "actorId": actor, "fromStateId": issue["state"]["id"], "toStateId": to_state,
                "fromAssigneeId": None, "toAssigneeId": assignee, "fromDelegate": None, "toDelegate": None})
            return task
        return patch.object(Kanban, "create", create)

    def _flaky_activation(self):
        real, failed = Kanban.activate, []
        def flaky(adapter, *a, **k):
            if not failed:
                failed.append(True)
                raise OSError("database is locked")
            return real(adapter, *a, **k)
        return patch.object(Kanban, "activate", flaky)

    def _flaky_admission_read(self):
        import traceback
        real, failed = Bridge._effect_issue, []
        def flaky(bridge, issue_id, *a, **k):
            if not failed and any(frame.name == "_assignment_activation" for frame in traceback.extract_stack()):
                failed.append(True)
                raise LinearError("Linear is answering too slowly to finish this in time")
            return real(bridge, issue_id, *a, **k)
        return patch.object(Bridge, "_effect_issue", flaky)

    def assert_started_once(self, reply):
        self.assertTrue(reply["ok"], reply)
        (task,) = self.tasks()
        self.assertIn(task["status"], RUNNABLE)
        self.assertEqual(len(self.owner_blocks()), 1)  # Atlas was never paused twice
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)
        self.assert_exclusive()

    # -- a person's routing change wins; the old delegate's own handover steps do not ------------
    def test_a_person_moving_the_issue_between_the_handover_and_admission_wins(self):
        with self._routing_change_at_create(USER):
            reply = self.take_over()
        self.assert_paused_message(reply)
        self.assertIn("a person changed this issue's status, assignee or delegate in Linear", reply["message"])
        self.bridge._recover_admissions()  # A person's decision stands: never admitted later either.
        self.assert_nothing_runs_here()

    def test_a_person_changing_the_issue_during_the_a2a_wait_wins(self):
        def moved(tool_json):
            issue = self.linear.issues[ISSUE]
            stamp = now_iso()
            issue.update(updatedAt=stamp, assignee={"id": USER})
            self.linear.history.setdefault(ISSUE, []).append({
                "createdAt": stamp, "actorId": USER, "fromStateId": issue["state"]["id"], "toStateId": issue["state"]["id"],
                "fromAssigneeId": None, "toAssigneeId": USER, "fromDelegate": None, "toDelegate": None})
            return tool_json
        self.bridge.clock = lambda: time.time() - 2  # the request is asked before the person's change
        reply = self.take_over(answer=moved)
        self.assert_paused_message(reply)
        self.assertIn("a person changed this issue's status, assignee or delegate", reply["message"])

    def test_the_old_delegate_pausing_and_stepping_down_is_not_a_person_moving_it(self):
        with self._routing_change_at_create(OWNER, "state-blocked"):
            reply = self.take_over()
        self.assertTrue(reply["ok"], reply)
        self.assertIn(self.tasks()[0]["status"], RUNNABLE)
        self.assertTrue(any(node["actorId"] == OWNER and (node.get("fromDelegate") or {}).get("id") == OWNER
                            and node.get("toDelegate") in (None, {"id": None}) for node in self.linear.history[ISSUE]))

    def test_N1_a_retry_after_a_person_moved_the_issue_starts_the_parked_task(self):
        with self._routing_change_at_create(USER):
            self.assert_paused_message(self.take_over())
        self.later_request()
        self.assert_started_once(self.take_over(str(uuid.uuid4())))

    # -- a start that failed after the handover is never admitted later ------------------------
    def _never_admitted_late(self, patcher):
        with patcher:
            self.assert_paused_message(self.take_over())
        (task,) = self.tasks()
        self.assertEqual(task["status"], "blocked")
        with self.atlas():
            self.bridge._recover_admissions()
            self.bridge.tick()
        self.assertEqual(len(self.a2a_calls), 1)  # Nothing here asks Atlas anything by itself.
        self.assert_nothing_runs_here()
        self.assertEqual(len(self.notices()), 1)  # The one paused message, still true.
        self.later_request()
        self.assert_started_once(self.take_over(str(uuid.uuid4())))

    def test_M1_admission_read_failing_once_is_never_admitted_later(self):
        self._never_admitted_late(self._flaky_admission_read())

    def test_X2_native_activation_failing_once_is_never_admitted_later(self):
        self._never_admitted_late(self._flaky_activation())

    def test_X3_service_stopping_after_create_is_never_admitted_later(self):
        class Stopped(BaseException):
            pass
        def stopped(*a, **k):
            raise Stopped()
        with patch.object(Bridge, "_assignment_activation", stopped), self.assertRaises(Stopped):
            self.take_over()
        self.bridge.tick()
        self.assert_nothing_runs_here()
        self.assert_started_once(self.take_over(str(uuid.uuid4())))

    def test_a_landed_admission_whose_reply_was_lost_is_recognised_not_repeated(self):
        real = Kanban.activate
        def lost(adapter, *a, **k):
            real(adapter, *a, **k)
            raise OSError("reply lost")
        with patch.object(Kanban, "activate", lost):
            reply = self.take_over()
        self.assertTrue(reply["ok"], reply)
        self.bridge._recover_admissions()
        task_id = self.tasks()[0]["id"]
        self.assertTrue(self.bridge.store.native_intent(f"activate:{ISSUE}:{task_id}")["accepted"])
        self.bridge.pump_kanban()
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)
        self.assert_exclusive()

    def test_a_parked_takeover_task_is_never_admitted_beside_a_resumed_owner(self):
        with self._flaky_activation():
            self.assert_paused_message(self.take_over())
        self.assertTrue(self.resume_owner()["ok"])
        self.assertIn(self.owner_status(), RUNNABLE)
        self.bridge._recover_admissions()
        self.bridge.tick()
        self.assert_nothing_runs_here()
        self.later_request()
        reply = self.take_over(str(uuid.uuid4()))  # a new handover; the same task then starts once
        self.assertTrue(reply["ok"], reply)
        (task,) = self.tasks()
        self.assertIn(task["status"], RUNNABLE)
        self.assert_exclusive()

    # -- routing after the start -------------------------------------------------------------
    def test_held_takeover_routing_is_retried_by_recovery(self):
        def unavailable(*args, **kwargs):
            raise LinearError("Linear unreachable (network error)")
        with patch.object(Bridge, "queue_delegate_self", unavailable):
            reply = self.take_over()
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["routing"], "held: will retry automatically")
        self.bridge.flush()
        self.assertIsNone(self.delegate())
        self.bridge.pump_kanban()
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)

    def test_a_failure_after_the_task_started_here_is_a_takeover_with_routing_unfinished(self):
        def subscription_down(*args, **kwargs):
            raise OSError("notify db locked")
        with patch.object(Kanban, "subscribe_origin", subscription_down):
            reply = self.take_over()
        self.assertTrue(reply["ok"], reply)
        self.assertIn("Took over OPS-1 from Atlas", reply["message"])
        self.assertIn("Finishing the setup hit a problem", reply["message"])
        (task,) = self.tasks()
        self.assertIn(task["status"], RUNNABLE)
        retry = self.take_over(str(uuid.uuid4()))  # never reaches Atlas again
        self.assertTrue(retry["ok"], retry)
        self.assertIn("already taken over from Atlas", retry["message"])
        self.assertEqual(len(self.a2a_calls), 1)
        self.bridge.flush()
        self.assertEqual(self.delegate(), VIEWER)

    def test_any_exception_after_the_handover_leaves_the_owner_paused_and_replies(self):
        from hermes_fleet_linear_plugin import transport
        for error in (transport.Uncertain("lost"), KeyError("native"), OSError("disk"), transport.Unavailable("down")):
            with self.subTest(error=type(error).__name__):
                self.setUp()
                def broken(*args, **kwargs):
                    raise error
                with patch.object(Bridge, "entrust", broken):
                    reply = self.take_over()
                self.assert_paused_message(reply)
                self.assertEqual(self.owner_status(), "blocked")

    # -- the paused message names only ways on that will work ------------------------------------
    def _closing_create(self):
        real = Kanban.create
        def create(adapter, *args, **kwargs):
            task = real(adapter, *args, **kwargs)
            self.linear.issues[ISSUE]["state"] = {"id": "state-done", "name": "Done", "type": "completed"}
            return task
        return patch.object(Kanban, "create", create)

    def test_closed_during_the_start_offers_reopening_before_taking_over_again(self):
        with self._closing_create():
            reply = self.take_over()
        self.assertEqual(reply["code"], "takeover_paused", reply)
        self.assertIn("reopen OPS-1, then say 'take over OPS-1' again", reply["message"])
        self.assertNotIn("'take over OPS-1' to try again", reply["message"])

    def test_closed_plus_a_start_that_cant_be_retried_offers_only_resume(self):
        with self._closing_create(), patch.object(Kanban, "initial_activation_event", lambda *a, **k: None):
            reply = self.take_over()
        self.assertEqual(reply["code"], "takeover_paused", reply)
        self.assertIn("OPS-1 is closed.", reply["message"])
        self.assertIn("Say 'resume OPS-1' to let Atlas continue", reply["message"])
        self.assertNotIn("take over OPS-1", reply["message"])

    def test_a_stop_during_the_start_offers_only_resume_and_a_retry_says_so_truthfully(self):
        self.bridge.store.record_unbound_stop(ISSUE, time.time() * 1000 + 60_000, session_id="stop-session",
                                              activity_id="stop-1", actor=USER)
        first = self.take_over()
        self.assertEqual(first["code"], "takeover_paused", first)
        self.assertIn("someone stopped it in Linear", first["message"])
        self.assertTrue(first["message"].endswith("Say 'resume OPS-1' to let Atlas continue."), first["message"])
        retry = self.take_over(str(uuid.uuid4()))
        self.assertEqual(retry["code"], "takeover_refused")
        self.assertEqual(len(self.a2a_calls), 1)
        self.assertNotIn("keeps working", retry["message"])
        self.assertIn("If Atlas is still paused for that earlier handover, say 'resume OPS-1'", retry["message"])
        self.assertTrue(self.resume_owner()["ok"])
        self.assert_nothing_runs_here()

    # -- bounded time ------------------------------------------------------------------------------
    def test_the_start_here_runs_under_a_linear_deadline(self):
        with patch.object(takeover, "START_SECONDS", 1.0):
            reply = self.take_over()  # No Linear request fits in one second: none is started.
        self.assertEqual(reply["code"], "takeover_paused", reply)
        self.assertIn("Linear couldn't be read to confirm it, so nothing was started here", reply["message"])
        self.assert_nothing_runs_here()

    def test_reads_before_the_owner_is_asked_run_under_a_linear_deadline(self):
        with patch.object(takeover, "BEFORE_ASK_SECONDS", 1.0):
            reply = self.take_over()
        self.assertFalse(reply["ok"])
        self.assertIn("too slowly", reply["message"])
        self.assertEqual((self.a2a_calls, self.tasks()), ([], []))


class TakeoverWording(unittest.TestCase):
    """What people read in Linear when an agent pauses its work for a handover."""

    def test_the_handover_pause_never_reads_as_waiting_on_you(self):
        from hermes_fleet_linear_plugin.bridge import _block_message
        reason = takeover.HANDOFF_REASON.format(to="Nova", request_id=REQUEST)
        kind, body = _block_message({"kind": "needs_input", "reason": reason}, "blocked")
        self.assertEqual(kind, "response")
        self.assertTrue(body.startswith("Paused for a handover to Nova. Nothing is needed from you"), body)
        self.assertNotIn(REQUEST, body)
        for other in ("Ken requested Nova take over QA-3 (OPS-9). Stopping Atlas run for handoff; Nova owns the remainder.",
                      reason + " please", "Which account should I hand over to?",
                      "Handover to Atlas pending: confirm the region"):
            with self.subTest(reason=other):
                kind, body = _block_message({"kind": "needs_input", "reason": other}, "blocked")
                self.assertEqual(kind, "elicitation")
                self.assertTrue(body.startswith("**Waiting on you**"), body)

    def test_budgets_always_end_inside_the_chat_client_timeout(self):
        from hermes_fleet_linear_plugin import api
        self.assertGreaterEqual(takeover.CLIENT_TIMEOUT_SECONDS, takeover.BEFORE_ASK_SECONDS + takeover.MAX_WAIT_SECONDS
                                + takeover.START_SECONDS)
        self.assertGreater(takeover.BEFORE_ASK_SECONDS, api.REQUEST_TIMEOUT_SECONDS)
        self.assertGreater(takeover.START_SECONDS, api.REQUEST_TIMEOUT_SECONDS)
        self.assertLess(takeover.EXIT_WAIT_SECONDS + 30, takeover.DEFAULT_WAIT_SECONDS)  # the owner answers in time
        self.assertEqual(takeover.settings({"agents": [{"name": "Atlas", "delegate_id": OWNER, "a2a": "atlas"}]},
                                           default_name="nova")["agents"][OWNER]["wait_seconds"], takeover.DEFAULT_WAIT_SECONDS)

    def test_a_linear_deadline_never_starts_a_request_it_cannot_finish(self):
        from hermes_fleet_linear_plugin.api import LinearAPI
        sent = []
        def transport(url, body, headers):
            sent.append(body)
            return 200, {}, b'{"data": {"viewer": {"id": "v"}}}'
        linear = LinearAPI(lambda: "token", transport=transport)
        with linear.deadline(5), self.assertRaisesRegex(LinearError, "too slowly"):
            linear.graphql("query Viewer { viewer { id } }")
        self.assertEqual(sent, [])
        with linear.deadline(60):
            self.assertEqual(linear.graphql("query Viewer { viewer { id } }"), {"viewer": {"id": "v"}})
        self.assertEqual(len(sent), 1)

if __name__ == "__main__":
    unittest.main()
