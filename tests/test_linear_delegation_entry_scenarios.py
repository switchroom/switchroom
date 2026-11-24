"""Entrust from Linear: a delegation starts one tracked native task before the model turn.

Real upstream Kanban and the registered native Linear adapter's ingest path; the model turn
is a recording stub and Linear is a synthetic authority. Live failures these pin down
(3 Nov 2026 acceptance run): delegations reached the model as a conversation, so the work was
done inline while Linear stayed Backlog (HF-612/614/615), and Linear's own authorless
thread-root comment was read as an @mention with no request in it (HF-617 refusal).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timezone
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
    from gateway.config import PlatformConfig
except Exception as exc:
    CORE = str(exc)

plugin = load_plugin()
from hermes_fleet_linear_plugin import chat, diag, native_input
from hermes_fleet_linear_plugin.api import RateLimited
from hermes_fleet_linear_plugin.bridge import Bridge, Kanban, stable_uuid4
from hermes_fleet_linear_plugin.outcome import POINTER_BODY
from hermes_fleet_linear_plugin.store import Store
from hermes_fleet_linear_plugin.transport import NativeContext
from linear_ingress_fixture import IngressStore, Route
from test_linear_specialist_authorization import Authority, ISSUE, USER, VIEWER

THREAD_ROOT = "This thread is for an agent session with agent."  # Linear writes this; it has no author


class EntryAuthority(Authority):
    """Records Agent Activities by session and tracks delegate writes."""

    def __init__(self):
        super().__init__()
        self.activity_records: list[dict] = []
        self.issues[ISSUE].update(delegate={"id": VIEWER}, description=None, title="Count lines of code per directory",
                                  updatedAt="2026-01-01T00:00:00Z")

    def transport(self, url, body, headers):
        payload = json.loads(body)
        query, variables = payload["query"], payload.get("variables") or {}
        if "agentActivityCreate" in query:
            self.activity_records.append(dict(variables["input"]))
        if "issueUpdate" in query and "delegateId" in (variables.get("input") or {}):
            self.issues[variables["id"]]["delegate"] = {"id": variables["input"]["delegateId"]}
        return super().transport(url, body, headers)

    def said(self, session_id: str) -> list[str]:
        return [record["content"]["body"] for record in self.activity_records if record["agentSessionId"] == session_id]

    def state(self) -> str:
        return self.issues[ISSUE]["state"]["name"]


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class DelegationEntryScenarios(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory(prefix="linear-delegation-entry-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("HERMES_KANBAN_") and key != "HERMES_DELEGATED_CHILD_CONTEXT"}
        environment.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home / "board"), HERMES_PROFILE="default")
        self.env = patch.dict(os.environ, environment, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        diag.reset()  # the hourly line cap and repeat limiter are process-wide; these cases read lines
        self.addCleanup(diag.reset)
        self.authority = EntryAuthority()
        self.board = Kanban(profile="default", profile_home=self.home)
        self.bridge = Bridge(Store(self.home / "linear.db"), self.authority.api(scope=None), self.board, profile="default")
        self.bridge.profile_home = self.home
        # The production registration: the plugin registers the native Linear platform and its adapter.
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        from gateway.platform_registry import platform_registry
        (self.home / "config.yaml").write_text("platforms:\n  linear:\n    enabled: true\nplugins:\n  entries:\n"
                                               "    linear:\n      settings:\n        enabled: true\n")
        manager = PluginManager(scope_key=str(self.home))
        self.addCleanup(manager.unload)
        registered = {}
        register_platform = native_input.register_platform
        def observe_platform(context, running):
            registered["running"] = running
            register_platform(context, running)
        with patch.object(native_input, "register_platform", side_effect=observe_platform):
            plugin.register(PluginContext(PluginManifest(name="linear", source="user", kind="standalone"), manager))
        self.addCleanup(platform_registry.unregister, "linear", scope=manager.scope_key)
        self.running = registered["running"]
        self.running["bridge"] = self.bridge
        self.adapter = platform_registry.get("linear").adapter_factory(PlatformConfig(enabled=True, typing_indicator=False))
        self.turns = []

        async def model_turn(event):  # finite endpoint; real-ledger qualification is in worker_questions
            self.turns.append(event)
            return {"admission_id": event.message_id, "seq": len(self.turns), "status": "queued"}
        self.adapter._admit = model_turn
        self.inbox = IngressStore(self.home / "inbox.db")
        self.route = Route("agent", "default", "/unused", self.home / "unused-secret", self.home)

    # -- helpers ---------------------------------------------------------
    def session_event(self, session_id, *, creator: str | None = USER, comment=None, action="created"):
        self.authority.sessions[session_id] = {"id": session_id, "issue": {"id": ISSUE},
                                               "creator": creator and {"id": creator}, "appUser": {"id": VIEWER}}
        stamp = time.time()
        session = {"id": session_id, "issue": {"id": ISSUE}}
        if creator:
            session["creatorId"] = creator
        if comment is not None:
            session["comment"] = comment
        return {"type": "AgentSessionEvent", "action": action,
                "createdAt": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                "webhookTimestamp": int(stamp * 1000), "agentSession": session}

    def delegation(self, session_id="session-1"):
        """What Linear sent for HF-617: a person delegated, no prompt, an authorless thread root."""
        return self.session_event(session_id, comment={"id": f"root-{session_id}", "body": THREAD_ROOT, "issueId": ISSUE})

    async def ingest(self, event, delivery_id=None):
        raw = json.dumps(event, separators=(",", ":")).encode()
        delivery_id = delivery_id or str(uuid.uuid4())
        self.inbox.enqueue(self.route, delivery_id, raw)
        delivery = native_input.InboxDelivery(self.inbox.database, "default", "agent", delivery_id, raw)
        await self.adapter._ingest(delivery)
        return delivery_id

    def inbox_status(self, delivery_id):
        with self.inbox._connect() as db:
            return db.execute("SELECT status FROM deliveries WHERE delivery_id=?", (delivery_id,)).fetchone()[0]

    def said(self, session_id):
        self.bridge.flush()  # the reporting tick (every 2 s) publishes queued activities
        return self.authority.said(session_id)

    def tasks(self):
        with self.board.conn() as conn:
            return [row["id"] for row in conn.execute("SELECT id FROM tasks")]

    def history(self, task_id):
        return [event.kind for event in self.board.history(task_id, 0)]

    def assert_one_owner(self):
        """Exactly one task carries this issue's idempotency key, and no two of its runs overlap."""
        with self.board.conn() as conn:
            keyed = [row["id"] for row in conn.execute("SELECT id FROM tasks WHERE idempotency_key=?", (f"linear:{ISSUE}",))]
            self.assertEqual(len(keyed), 1, keyed)
            runs = [(row["started_at"], row["ended_at"]) for row in conn.execute(
                "SELECT started_at, ended_at FROM task_runs WHERE task_id=? ORDER BY started_at, id", (keyed[0],))]
        for (_, ended), (started, _) in zip(runs, runs[1:]):
            self.assertIsNotNone(ended, runs)
            self.assertLessEqual(ended, started, runs)
        self.assertEqual(self.tasks(), keyed)
        return keyed[0]

    def chat_context(self):
        return NativeContext(home=str(self.home), profile="default", platform="telegram", source="telegram",
                             session_key="telegram:chat-1:thread-1", session_id="chat-session", user_id="human-1",
                             chat_id="chat-1", chat_type="group", thread_id="thread-1", scope_id="workspace-1")

    def work_on(self, **args):
        reply = json.loads(chat.handle(self.bridge, {"action": "work_on", "issue": ISSUE, **args}, self.chat_context()))
        self.assertTrue(reply["ok"], reply)
        return reply["native"]["task_id"]

    def reconcile(self):
        for _ in range(2):
            self.bridge.pump_kanban()
            self.bridge.flush()

    # -- scenarios -------------------------------------------------------
    async def test_a_person_in_an_agent_session_never_gets_the_set_home_channel_prompt(self):
        # HF-839: Core's one-time "No home channel is set for Linear... Type /sethome" nudge reached a
        # person's Agent Session as a thought. The registered Linear platform declares it has no home
        # channel, so Core's real first-contact path sends nothing there; a chat platform still gets it.
        from unittest.mock import AsyncMock
        from gateway.config import GatewayConfig, Platform
        from gateway.platform_registry import platform_registry
        from gateway.run import GatewayRunner
        from gateway.session import SessionSource, SessionStore
        self.assertIs(platform_registry.get("linear").has_home_channel, False)
        def first_contact(platform):
            runner = GatewayRunner.__new__(GatewayRunner)
            runner.config = GatewayConfig()
            runner.session_store = SessionStore(sessions_dir=self.home / "sessions", config=runner.config)
            runner._deliver_platform_notice = AsyncMock()
            source = SessionSource(platform=platform, chat_id=ISSUE, user_id=USER, chat_type="dm")
            return runner, runner._hmwa_first_contact_notes(source, [], [])
        runner, turn = first_contact(Platform("linear"))
        await turn
        self.assertEqual(runner._deliver_platform_notice.await_args_list, [])
        with patch.dict(os.environ, {"TELEGRAM_HOME_CHANNEL": ""}):  # counterexample: the check is live
            runner, turn = first_contact(Platform.TELEGRAM)
            await turn
        notices = runner._deliver_platform_notice.await_args_list
        self.assertEqual(len(notices), 1)
        self.assertIn("/sethome", notices[0].args[1])

    async def test_delegation_without_prompt_starts_one_tracked_task_before_the_model_turn(self):
        remember, parked = self.bridge.store.remember_conversation_input, []
        def at_commit(*args, **kwargs):  # no worker can start before this session's input commits
            task_id = self.bridge.store.get(ISSUE)["task_id"]
            with self.board.conn() as conn:
                parked.append((self.board.get(task_id).status, kb.claim_task(conn, task_id)))
            return remember(*args, **kwargs)
        with patch.object(self.bridge.store, "remember_conversation_input", side_effect=at_commit):
            await self.ingest(self.delegation())
        self.assertEqual(parked, [("blocked", None)])
        self.assertEqual(len(self.tasks()), 1)
        task = self.board.get(self.tasks()[0])
        self.assertEqual(task.status, "ready")  # released once the session input committed; the dispatcher claims it
        self.assertEqual(self.history(task.id), ["created", "blocked", "unblocked"])  # parked until then: plain upstream block/unblock
        self.assertEqual(task.idempotency_key, f"linear:{ISSUE}")
        # No prompt: the issue title is the request the worker receives.
        self.assertIn("Requested outcome (the issue title): Count lines of code per directory", task.body)
        # The model turn runs once, after admission, told the work is already running as that task.
        self.assertEqual(len(self.turns), 1)
        context = self.turns[0].channel_context
        self.assertIn("Tracked delegated work is staged", context)
        self.assertIn(task.id, context)
        self.assertIn("Do not perform the issue work in this conversation", context)
        self.assertNotIn("@mention", context)
        said = self.said("session-1")
        self.assertIn("Got it. Checking the issue and any existing work now; updates will appear here.", said)
        self.assertIn("On it: this is queued for the next free worker and shows In Progress once one picks it up; "
                      "updates appear here.", said)

        # While the session turn runs, Linear shows In Progress: the agent is on it now.
        self.reconcile()
        self.assertEqual(self.authority.state(), "In Progress")
        # The turn ends before the dispatcher's first claim: our own just-admitted work keeps
        # In Progress (HF-629, no In Progress -> Todo -> In Progress flicker).
        await self.adapter.on_processing_complete(self.turns[0], None)
        self.reconcile()
        self.assertEqual(self.authority.state(), "In Progress")
        # A worker picks it up: In Progress follows the work.
        with self.board.conn() as conn:
            self.assertIsNotNone(kb.claim_task(conn, task.id, claimer="native-test-worker"))
        self.reconcile()
        self.assertEqual(self.authority.state(), "In Progress")
        self.assertEqual(self.tasks(), [task.id])

    async def test_redelivery_echo_and_second_delegation_never_start_a_second_task(self):
        event = self.delegation()
        await self.ingest(event, "first")
        task_id = self.tasks()[0]
        self.assertEqual(len(self.turns), 1)
        # The same provider input redelivered (a lost ack, a reconnect): the same task, no second admission.
        await self.ingest(event, "redelivered")
        self.assertEqual(self.tasks(), [task_id])
        self.assertEqual(self.history(task_id), ["created", "blocked", "unblocked"])
        self.assertIn(task_id, self.turns[-1].channel_context)
        turns = len(self.turns)
        # This app's own delegation echo (no creator) keeps the dispatcher path: the same work.
        echo = await self.ingest(self.session_event("echo-session", creator=None), "echo")
        self.assertEqual(self.inbox_status(echo), "imported")
        # A second person-made delegation of the same issue is answered as the same work, without a turn.
        second = await self.ingest(self.delegation("session-2"), "second")
        self.assertEqual(self.inbox_status(second), "imported")
        self.assertEqual(len(self.turns), turns)
        self.assertEqual(self.tasks(), [task_id])
        self.assertEqual(self.history(task_id), ["created", "blocked", "unblocked"])
        self.assertEqual(self.said("session-2")[-1],
                         "The agent is already working on this, so nothing new was started.")
        # One owner throughout: the first session still owns it, and only one model turn ran on it.
        self.assertEqual(self.bridge.store.get(ISSUE)["owner_ref"], "session-1")
        self.assertEqual({turn.message_id for turn in self.turns}, {self.turns[0].message_id})
        self.assertEqual(self.assert_one_owner(), task_id)

    async def test_chat_started_work_then_human_delegation_is_one_task(self):
        task_id = self.work_on()
        delivery = await self.ingest(self.delegation(), "delegated-after-chat")
        self.assertEqual(self.assert_one_owner(), task_id)
        self.assertEqual(self.history(task_id), ["created", "blocked", "unblocked"])
        self.assertEqual(self.turns, [])  # answered as the same work; no model turn redoes it
        self.assertEqual(self.inbox_status(delivery), "imported")
        # The session Linear opened now reports the chat-started work: a thought, never a closing response.
        self.assertIn("Continuing the existing work on this issue, continued from chat", self.said("session-1")[-1])
        kinds = [r["content"]["type"] for r in self.authority.activity_records
                 if r["agentSessionId"] == "session-1"]
        self.assertTrue(kinds)
        self.assertEqual(set(kinds), {"thought"})  # admission ACK and adoption both keep it open
        self.assertEqual(self.bridge.store.get(ISSUE)["owner_ref"], "session-1")

    # -- one owner, no double run, through the adapter's ingest -------------------------------
    async def test_chat_work_then_own_echo_adopts_the_echo_session_through_ingest(self):
        task_id = self.work_on()
        # This app delegated the issue to itself from chat; Linear opens a creator-less session for it.
        echo = await self.ingest(self.session_event("echo-session", creator=None), "own-echo")
        self.assertEqual(self.inbox_status(echo), "imported")
        self.assertEqual(self.assert_one_owner(), task_id)
        self.assertEqual(self.turns, [])  # nothing redoes the work
        self.assertEqual(self.bridge.store.get(ISSUE)["owner_ref"], "echo-session")
        said = self.said("echo-session")
        self.assertIn("Continuing the existing work on this issue, continued from chat", said[-1])
        self.assertEqual({r["content"]["type"] for r in self.authority.activity_records
                          if r["agentSessionId"] == "echo-session"}, {"thought"})  # adoption keeps it open
        # The session reports the work from now on: a worker picking it up shows there.
        with self.board.conn() as conn:
            self.assertIsNotNone(kb.claim_task(conn, task_id, claimer="native-test-worker"))
            with kb.write_txn(conn):
                kb._append_event(conn, task_id, "spawned", {"pid": 4242})
        self.reconcile()
        self.assertIn(("action", "Started"), [(r["content"]["type"], r["content"].get("action"))
                                              for r in self.authority.activity_records
                                              if r["agentSessionId"] == "echo-session"])
        self.assertEqual(self.authority.state(), "In Progress")
        self.assertEqual(self.assert_one_owner(), task_id)

    def interrupted_chat_start(self):
        """work_on crashes after binding, before its task's park is lifted: bound, never started."""
        with patch.object(Bridge, "release_parked", side_effect=RuntimeError("service stopped")):
            try:
                chat.handle(self.bridge, {"action": "work_on", "issue": ISSUE}, self.chat_context())
            except RuntimeError:
                pass
        task_id = self.assert_one_owner()
        self.assertEqual(self.history(task_id), ["created", "blocked"])
        self.reconcile()  # the service loop never starts a chat start by itself
        self.assertEqual(self.history(task_id), ["created", "blocked"])
        return task_id

    async def test_person_delegation_starts_an_interrupted_chat_start_through_ingest(self):
        task_id = self.interrupted_chat_start()
        delivery = await self.ingest(self.delegation(), "delegated-after-crash")
        self.assertEqual(self.inbox_status(delivery), "imported")
        self.assertEqual(self.assert_one_owner(), task_id)  # the same task, now released: never a second
        self.assertEqual(self.history(task_id), ["created", "blocked", "unblocked"])
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.assertEqual(self.turns, [])
        said = self.said("session-1")
        self.assertIn("Continuing the existing work on this issue, continued from chat. It is queued", said[-1])
        self.assertFalse(any("paused" in body or "nothing is needed" in body for body in said), said)

    async def test_own_echo_on_an_interrupted_chat_start_says_plainly_it_has_not_started(self):
        task_id = self.interrupted_chat_start()
        await self.ingest(self.session_event("echo-session", creator=None), "own-echo")
        self.assertEqual(self.history(task_id), ["created", "blocked"])  # an echo is no new authority
        said = self.said("echo-session")
        self.assertIn("This work hasn't started yet: its setup was interrupted", said[-1])
        self.assertFalse(any("paused" in body or "nothing is needed" in body for body in said), said)
        # Asking again in chat starts the one task, and says so.
        reply = json.loads(chat.handle(self.bridge, {"action": "work_on", "issue": ISSUE}, self.chat_context()))
        self.assertTrue(reply["ok"], reply)
        self.assertTrue(reply["native"]["admitted"], reply)
        self.assertEqual(self.assert_one_owner(), task_id)
        self.assertEqual(self.board.get(task_id).status, "ready")

    async def test_a_repeated_request_on_a_stopped_parked_chat_start_says_the_stop_holds_it(self):
        task_id = self.interrupted_chat_start()
        with self.board.conn() as conn:
            self.assertTrue(kb.block_task(conn, task_id, reason="linear: stopped by a person", kind="needs_input"))
        reply = json.loads(chat.handle(self.bridge, {"action": "work_on", "issue": ISSUE}, self.chat_context()))
        self.assertFalse(reply["native"]["admitted"], reply)
        self.assertIn("Not started: someone stopped it", reply["message"])
        self.assertEqual(reply["routing"], "held: not started")
        self.assertEqual(self.board.get(task_id).status, "blocked")

    async def test_a_second_session_never_takes_over_a_live_adopted_one_through_ingest(self):
        task_id = self.work_on()
        await self.ingest(self.session_event("echo-session", creator=None), "own-echo")
        self.assertEqual(self.bridge.store.get(ISSUE)["owner_ref"], "echo-session")
        await self.ingest(self.session_event("echo-again", creator=None), "own-echo-again")
        await self.ingest(self.delegation("person-session"), "person")
        self.assertEqual(self.bridge.store.get(ISSUE)["owner_ref"], "echo-session")
        self.assertEqual(self.turns, [])
        self.assertEqual(self.assert_one_owner(), task_id)
        for session in ("echo-again", "person-session"):
            self.assertIn("nothing new was started", self.said(session)[-1])
            self.assertEqual({r["content"]["type"] for r in self.authority.activity_records
                              if r["agentSessionId"] == session}, {"thought"})

    async def test_recorded_done_work_then_own_echo_starts_nothing_through_ingest(self):
        task_id = self.work_on(record_done=True, summary="Counted every directory in the chat.",
                               evidence=["https://example.invalid/report"])
        self.assertEqual(self.board.get(task_id).status, "done")
        echo = await self.ingest(self.session_event("echo-session", creator=None), "own-echo")
        self.assertEqual(self.inbox_status(echo), "imported")
        self.assertEqual(self.turns, [])
        self.assertEqual(self.assert_one_owner(), task_id)
        self.assertEqual(self.board.get(task_id).status, "done")
        self.assertFalse({"claimed", "spawned", "unblocked"} & set(self.history(task_id)))  # never runnable
        answer = self.said("echo-session")[-1]  # points at the finished work's result, not a dead end (FM2)
        self.assertEqual(answer, POINTER_BODY)  # HF-809: the issue comment alone carries the result
        self.assertFalse(any("Counted every directory in the chat." in body for body in self.said("echo-session")))
        self.reconcile()
        self.assertEqual(self.board.get(task_id).status, "done")
        self.assertFalse({"claimed", "spawned", "unblocked"} & set(self.history(task_id)))

    async def test_concurrent_ingests_of_two_sessions_for_one_issue_make_one_task(self):
        create, entered = self.board.create, asyncio.Event()
        loop = asyncio.get_running_loop()
        def slow_create(**fields):  # widen the window: the second ingest arrives while the first creates
            loop.call_soon_threadsafe(entered.set)
            time.sleep(0.5)
            return create(**fields)
        with patch.object(self.board, "create", side_effect=slow_create):
            first = asyncio.ensure_future(self.ingest(self.delegation("session-a"), "a"))
            await asyncio.wait_for(entered.wait(), 10)
            await asyncio.gather(first, self.ingest(self.session_event("session-b", creator=None), "b"))
        task_id = self.assert_one_owner()
        self.assertEqual(self.history(task_id), ["created", "blocked", "unblocked"])
        self.assertEqual(self.bridge.store.get(ISSUE)["owner_ref"], "session-a")
        self.assertEqual(len(self.turns), 1)  # only the session that started it gets a model turn
        self.assertIn("nothing new was started", self.said("session-b")[-1])

    async def test_mention_question_stays_a_conversation_and_starts_nothing(self):
        question = "@agent how many directories does hermes-fleet have?"
        with self.assertLogs("hermes_plugins.linear", logging.INFO) as logs:
            await self.ingest(self.session_event("mention-session",
                                                 comment={"id": "c1", "body": question, "userId": USER, "issueId": ISSUE}))
        self.assertEqual(self.tasks(), [])
        self.assertEqual(len(self.turns), 1)
        self.assertEqual(self.turns[0].text, question)
        self.assertIn("@mention", self.turns[0].channel_context)
        self.assertNotIn("Tracked work already started", self.turns[0].channel_context)
        self.assertEqual(self.said("mention-session"),
                         ["Got it. Reading your comment now; the reply will appear here."])
        self.assertTrue(any("reason=mention_conversation" in line for line in logs.output), logs.output)
        self.reconcile()
        self.assertEqual(self.authority.state(), "Todo")  # nobody is working on it

    async def test_start_failure_explains_the_wait_once_and_the_retry_starts_one_task(self):
        event = self.delegation()
        with patch.object(self.board, "discover", side_effect=OSError("board is locked")), \
                self.assertLogs("hermes_plugins.linear", logging.WARNING) as logs:
            with self.assertRaises(native_input.LinearError):
                await self.ingest(event, "held")
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.turns, [])
        self.assertEqual(self.inbox_status("held"), "pending")  # retried by the inbox, never dropped
        said = self.said("session-1")
        self.assertEqual(said, ["Got it. Checking the issue and any existing work now; updates will appear here.",
                                "This work couldn't start yet. The agent retries on its own and updates appear here; "
                                "nothing is running yet."])
        self.assertTrue(any("action=session.admit outcome=held reason=admission_failed" in line for line in logs.output),
                        logs.output)
        # The retry starts the one task; neither the acknowledgment nor the wait is repeated.
        await self.ingest(event, "held")
        self.assertEqual(len(self.tasks()), 1)
        self.assertEqual(len(self.turns), 1)
        said = self.said("session-1")
        self.assertEqual(sum("couldn't start yet" in body for body in said), 1)
        self.assertEqual(sum(body.startswith("Got it.") for body in said), 1)
        wait = self.bridge.store.outbox_row(stable_uuid4("native-delegation-wait", "default", ISSUE, "session-1"))
        self.assertEqual(wait["state"], "sent")

    async def test_redelegation_after_finished_work_reaches_the_agent_instead_of_a_dead_end(self):
        await self.ingest(self.delegation())
        task_id = self.tasks()[0]
        with self.board.conn() as conn:
            claim = kb.claim_task(conn, task_id, claimer="native-test-worker")
            self.assertTrue(kb.complete_task(conn, task_id, expected_run_id=claim.current_run_id,
                                             result="Counted every directory."))
        self.reconcile()
        delivery = await self.ingest(self.delegation("session-2"), "redelegated")
        # The person is answered by the agent with the finished work in context; nothing restarts on its own.
        self.assertEqual(len(self.turns), 2)
        context = self.turns[-1].channel_context
        self.assertNotIn("Tracked work already started", context)
        self.assertIn("It is history now", context)
        self.assertEqual(self.tasks(), [task_id])
        self.assertEqual(self.history(task_id).count("unblocked"), 1)  # its staged park, lifted once
        self.assertEqual(self.inbox_status(delivery), "imported")  # the finite endpoint invoked the committed-input hook

    async def test_retried_session_linked_to_existing_board_work_answers_once(self):
        issue = self.authority.issues[ISSUE]
        existing = self.board.create(title="OPS-1: earlier task", created_by="chat",
                                     body=f"Linear issue OPS-1: {issue['url']}\nCount the directories.")
        event = self.delegation()
        for delivery in ("first", "retry-1", "retry-2"):
            await self.ingest(event, delivery)
        self.assertEqual(self.tasks(), [existing.id])
        self.assertIn("Existing native work", self.turns[0].channel_context)
        said = self.said("session-1")
        self.assertEqual(sum(body.startswith("Linked to the agent's existing task") for body in said), 1, said)
        self.assertFalse(any("nothing new was started." in body and not body.startswith("Linked") for body in said), said)

    async def test_rate_limit_wait_says_so_in_plain_words(self):
        # Linear answers the session reads, then rate-limits the admission's own reads.
        with patch.object(self.bridge, "_start", side_effect=RateLimited(time.time() + 60)):
            with self.assertRaises(native_input.LinearError):
                await self.ingest(self.delegation(), "limited")
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.turns, [])
        wait = self.bridge.store.outbox_row(stable_uuid4("native-delegation-wait", "default", ISSUE, "session-1"))
        self.assertEqual(wait["payload"]["content"]["body"],
                         "Linear is limiting requests right now, so this work hasn't started yet. The agent retries on "
                         "its own and updates appear here; nothing is running yet.")
        # Once Linear answers again the queued wait is published with the rest of the outbox.
        self.assertIn(wait["payload"]["content"]["body"], self.said("session-1"))

    async def test_closed_or_reassigned_delegation_is_answered_without_a_model_turn(self):
        self.authority.issues[ISSUE]["delegate"] = {"id": "another-agent"}
        delivery = await self.ingest(self.delegation(), "reassigned")
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.turns, [])
        self.assertEqual(self.inbox_status(delivery), "imported")
        self.assertEqual(self.said("session-1")[-1], "Not starting: this issue is closed or assigned elsewhere.")

    async def test_refused_creatorless_delegation_is_answered_once_and_not_retried(self):
        # A refusal is a final answer: the delivery is consumed, not retried every 15 minutes
        # for a day with another refusal each time.
        self.authority.issues[ISSUE]["delegate"] = {"id": "another-agent"}
        delivery = await self.ingest(self.session_event("session-2", creator=None), "refused-creatorless")
        self.assertEqual(self.inbox_status(delivery), "imported")
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.turns, [])
        self.assertEqual(self.said("session-2"), ["Not starting: this issue is closed or assigned elsewhere."])

    async def test_failure_after_a_refusal_retries_without_posting_it_again(self):
        self.authority.issues[ISSUE]["delegate"] = {"id": "another-agent"}
        event = self.session_event("session-2", creator=None)
        with patch.object(native_input.InboxDelivery, "acknowledge",
                          side_effect=native_input.LinearError("finite inbox write failure")):
            for _ in range(3):  # the same delivery, retried after a later step failed
                with self.assertRaises(native_input.LinearError):
                    await self.ingest(event, "refused-then-failed")
                self.bridge.flush()
        await self.ingest(event, "refused-then-failed")
        self.assertEqual(self.inbox_status("refused-then-failed"), "imported")
        self.assertEqual(self.said("session-2"), ["Not starting: this issue is closed or assigned elsewhere."])

    async def test_issue_delegated_to_this_app_logs_that_a_session_is_awaited(self):
        # HF-613: Linear sent the Issue create (delegate = this app) but never the Agent Session.
        event = {"type": "Issue", "action": "create", "createdAt": datetime.now(timezone.utc).isoformat(),
                 "webhookTimestamp": int(time.time() * 1000), "actor": {"id": USER},
                 "data": {"id": ISSUE, "delegateId": VIEWER}}
        with self.assertLogs("hermes_plugins.linear", logging.INFO) as logs:
            self.bridge.handle_webhook(event)
        self.assertTrue(any("reason=delegated_awaiting_session" in line for line in logs.output), logs.output)
        self.assertEqual(self.tasks(), [])


if __name__ == "__main__":
    unittest.main()
