"""Guarded real Base/authority/SQLite/provider consumer with finite endpoints only.

The provider transport, model decisions and runner settings are explicit test
fixtures. Native input admission, lifecycle, durable receipt, controls, task
storage and scoped outbox are production code. No gateway/model bootstrap.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
from types import MethodType
import unittest
from unittest.mock import patch

SOURCE = os.environ.get("HERMES_AGENT_SRC")
GUARDED_ROOT = os.environ.get("HERMES_LINEAR_INPUT_TEST_ROOT")


@unittest.skipUnless(SOURCE and GUARDED_ROOT, "requires scripts/run-linear-input-scenarios.py")
class NativeInputSeamScenarios(unittest.IsolatedAsyncioTestCase):
    async def show_approval(self, key, entry=None):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        if entry is None:
            entry = _ApprovalEntry({"command": "bounded-command"})
            with approval._lock:
                approval._gateway_queues.setdefault(key, []).append(entry)
            self.addCleanup(approval.unregister_gateway_notify, key)
        return await self.adapter.send_exec_approval(self.ISSUE, entry.data["command"], key,
            request_id=entry.data["request_id"], metadata={"thread_id": self.SESSION})

    async def test_clarify_read_failure_after_admission_retries_exact_question(self):
        await self.check_question_read_failure_after_admission("clarify")

    async def test_approval_read_failure_after_admission_retries_exact_question(self):
        await self.check_question_read_failure_after_admission("approval")

    async def check_question_read_failure_after_admission(self, kind):
        from tools import clarify_gateway as clarify, approval
        from tools.approval_gateway_wait import _ApprovalEntry
        from hermes_fleet_linear_plugin.api import LinearError
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        with patch.object(self.bridge, "flush", return_value=0):
            if kind == "clarify":
                pending = clarify.register("read-outage", key, "Choose an environment.", ["staging", "production"])
                self.addCleanup(clarify.clear_session, key)
                queued = await self.adapter.send_clarify(self.ISSUE, pending.question, pending.choices,
                    pending.clarify_id, key, metadata={"thread_id": self.SESSION})
            else:
                pending = _ApprovalEntry({"command": "bounded-command"})
                with approval._lock:
                    approval._gateway_queues.setdefault(key, []).append(pending)
                self.addCleanup(approval.unregister_gateway_notify, key)
                queued = await self.show_approval(key, pending)
        expected = self.bridge.store.outbox_row(queued.message_id)["payload"]
        original_read, failed = self.bridge.native_conversation_state, []
        def read(payload):
            row = self.bridge.store.outbox_row(queued.message_id)
            if row["payload"]["write_started"] is True and not failed:
                failed.append(True)
                raise LinearError("Transient native authority read failure")
            return original_read(payload)
        with patch.object(self.bridge, "native_conversation_state", side_effect=read):
            await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
        self.assertTrue(failed)
        self.assertNotIn(queued.message_id, self.provider.activities)
        self.assertIs(self.bridge.store.outbox_row(queued.message_id)["payload"]["write_started"], False)
        for _ in range(2):
            self.bridge.store.defer(queued.message_id, self.bridge.clock() - 1)
            await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
        row = self.bridge.store.outbox_row(queued.message_id)
        self.assertIn(queued.message_id, self.provider.activities)
        self.assertEqual(row["state"], "sent")
        self.assertEqual(row["payload"]["content"], expected["content"])
        self.assertEqual(row["payload"]["signal_metadata"], expected["signal_metadata"])
        if kind == "clarify":
            self.assertIs(clarify.get_pending(pending.clarify_id), pending)
        else:
            with approval._lock:
                self.assertIn(pending, approval._gateway_queues[key])

    async def asyncSetUp(self):
        # Our finite settings/agent boundary over Core's runtime, never GatewayRunner.
        from linear_native_runtime_fixture import FiniteAgent, NativeRuntimeFixture
        self.finite_agent_type = FiniteAgent
        self.fixture = NativeRuntimeFixture()
        await self.fixture.asyncSetUp()
        self.addCleanup(self.fixture.doCleanups)
        self.home, self.runner, self.authority = self.fixture.home, self.fixture.runner, self.fixture.authority
        environment = patch.dict(os.environ, HERMES_HOME=str(self.home),
            HERMES_KANBAN_HOME=str(self.home / "board"), HERMES_PROFILE="default")
        environment.start()
        self.addCleanup(environment.stop)
        from linear_fake_api import load_plugin
        plugin = load_plugin()
        from test_linear_specialist_authorization import Authority, USER, VIEWER, ISSUE, SESSION
        from hermes_fleet_linear_plugin.bridge import Bridge, Kanban
        from hermes_fleet_linear_plugin.store import Store
        from hermes_fleet_linear_plugin import native_input
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        from gateway.config import PlatformConfig
        from gateway.platform_registry import platform_registry
        self.native_input, self.USER, self.ISSUE, self.SESSION = native_input, USER, ISSUE, SESSION
        self.provider = Authority()
        self.provider.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.fixture.allowed.add(USER)
        self.board = Kanban(profile="default", profile_home=self.home)
        self.bridge = Bridge(Store(self.home / "linear.db"), self.provider.api(scope=None),
            self.board, profile="default", clock=lambda: 1900000000.0)
        self.bridge.profile_home = self.home
        (self.home / "config.yaml").write_text("platforms:\n  linear:\n    enabled: true\nplugins:\n  entries:\n    linear:\n      settings:\n        enabled: true\n")
        self.manager = PluginManager(scope_key=str(self.home))
        self.addCleanup(self.manager.unload)
        self.context = PluginContext(PluginManifest(name="linear", source="user", kind="standalone"), self.manager)
        registered = {}
        register_platform = native_input.register_platform
        def observe_platform(context, running):
            registered["running"] = running
            register_platform(context, running)
        # Observe the factory's real closure; do not replace its route or create
        # a second reporting service in this finite host.
        with patch.object(native_input, "register_platform", side_effect=observe_platform):
            plugin.register(self.context)
        self.running = registered["running"]
        self.running["bridge"] = self.bridge
        self.addCleanup(platform_registry.unregister, "linear", scope=self.manager.scope_key)
        entry = platform_registry.get("linear")
        self.assertIsNotNone(entry)
        self.assertEqual(entry.allowed_users_env, "LINEAR_ALLOWED_USERS")
        self.assertTrue(entry.check_fn())
        self.adapter = entry.adapter_factory(PlatformConfig(enabled=True, typing_indicator=False))
        # Upstream messaging input only: no fork durable-ACK opt-in or committed-input hook.
        self.assertIsNot(getattr(self.adapter, "requires_durable_input_ack", False), True)
        self.assertNotIn("on_message_admitted", type(self.adapter).__dict__)
        self.assertTrue(await self.adapter.connect())
        self.runner.adapters[self.adapter.platform] = self.adapter
        self.runner._intake_adapter_for = lambda source: self.adapter
        self.runner._delivery_adapter_for = lambda source: self.adapter
        self.runner._is_session_running = lambda key: False
        self.receipts, self.events, self.decisions = [], [], []
        admitted = self.adapter._admitted
        async def receipt(event, value):
            await admitted(event, value)
            self.receipts.append((event, value))
        self.adapter._admitted = receipt
        async def handle(runner, event):
            from gateway.run_inbound import GatewayInboundMixin
            from gateway.session_ingress import executing_admission
            self.events.append(event)
            if event.get_command() == "stop":
                # The runner's own messaging /stop step (``_handle_stop_command``) on its owner turn.
                route = self.fixture.store._generate_session_key(event.source)
                await GatewayInboundMixin._hm_stop_owner_turn(runner, route)
                return "Stopped."
            if executing_admission.get():
                # The finite host binds only the actual restored native source
                # and real owner session, just as a gateway producer does.
                from gateway.session_context import set_session_vars, clear_session_vars
                source = event.source
                route = self.fixture.store._generate_session_key(source)
                entry = self.fixture.store.lookup_by_session_key(route)
                tokens = set_session_vars(platform=source.platform.value, source=source.platform.value,
                    chat_id=source.chat_id, chat_type=source.chat_type, thread_id=source.thread_id or "",
                    user_id=source.user_id or "", user_id_alt=source.user_id_alt or "",
                    scope_id=source.scope_id or "", session_key=route, session_id=entry.session_id,
                    message_id=event.message_id, profile="default")
                try:
                    return await self.model(event)
                finally:
                    clear_session_vars(tokens)
            _, reply = await GatewayInboundMixin._hm_authority_admission(runner, event,
                event.source, self.fixture.store._generate_session_key(event.source), False)
            return reply
        self.runner._handle_message = MethodType(handle, self.runner)
        # Production resolves the producer's profile home through the runner (``producer_scope``);
        # this finite host serves one profile, so its scope is that profile's authority.
        from contextlib import asynccontextmanager
        from gateway.platforms import webhook_ingress
        @asynccontextmanager
        async def finite_producer_scope(adapter, event):
            yield self.authority
        producer_scope = patch.object(webhook_ingress, "producer_scope", finite_producer_scope)
        producer_scope.start()
        self.addCleanup(producer_scope.stop)
        self.adapter.set_message_handler(self.runner._handle_message)
        self.adapter.set_session_store(self.fixture.store)
        self.bridge.native_ingress = lambda delivery: native_input.route_delivery(self.running, delivery)
        from linear_ingress_fixture import IngressStore, Route
        self.inbox = IngressStore(self.home / "inbox.db")
        self.inbox_route = Route("provider-fixture", "default", "/unused", self.home / "unused-secret", self.home)
        self.model = self.no_model

    async def asyncTearDown(self):
        for future in self.authority.waiters.values():
            if not future.done():
                future.cancel()
        for future in list(self.adapter._submitted.values()):
            future.cancel()
        await self.adapter.disconnect()
        tasks = [live.task for live in self.authority.sessions.values() if live.task and not live.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for future in self.authority.waiters.values():
            if not future.done():
                future.cancel()

    async def no_model(self, event):
        self.fail("No finite model was enabled for this case")

    async def until(self, predicate):
        try:
            async with asyncio.timeout(10):
                while not predicate():
                    await asyncio.sleep(0.01)
        except TimeoutError:
            import faulthandler
            print("PENDING_NATIVE_INPUT", [(key, f.done(), repr(f.exception()) if f.done() and not f.cancelled() else None)
                for key, f in self.adapter._submitted.items()], flush=True)
            print("ADMITTED_IDS", [event.message_id for event, _ in self.receipts], flush=True)
            faulthandler.dump_traceback()
            raise

    def event(self, identity, body, *, signal=None, action="prompted"):
        from test_linear_specialist_authorization import USER
        self.provider.activities.setdefault(identity, {"id": identity, "user": {"id": USER},
            "createdAt": datetime.now(timezone.utc).isoformat(), "agentSession": {"id": self.SESSION}})
        activity = {"id": identity, "user": {"id": USER}, "content": {"body": body}}
        if signal:
            activity["signal"] = signal
        return {"type": "AgentSessionEvent", "action": action,
                "createdAt": datetime.fromtimestamp(self.bridge.clock(), timezone.utc).isoformat(),
                "agentSession": {"id": self.SESSION, "issue": {"id": self.ISSUE}, "creatorId": USER},
                "agentActivity": activity}

    async def deliver(self, identity, body, **kwargs):
        raw = json.dumps(self.event(identity, body, **kwargs), separators=(",", ":")).encode()
        with patch("linear_ingress_fixture.time.time", return_value=self.bridge.clock()):
            self.inbox.enqueue(self.inbox_route, identity, raw)
        await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database)
        return raw

    async def deliver_raw(self, identity, event):
        raw = json.dumps(event, separators=(",", ":")).encode()
        with patch("linear_ingress_fixture.time.time", return_value=self.bridge.clock()):
            self.inbox.enqueue(self.inbox_route, identity, raw)
        await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database)
        return raw

    def inbox_row(self, identity):
        with self.inbox._connect() as db:
            return db.execute("SELECT profile,payload,status,attempts FROM deliveries WHERE delivery_id=?", (identity,)).fetchone()

    def rows(self):
        from linear_native_db import list_session_admissions
        return [row for sid in self.authority.sessions
                for row in list_session_admissions(self.authority.persistence, session_id=sid, pending_only=False)]

    def enable_owned_worker(self, task_id):
        """Only the finite model endpoint is fake; claim/drain/steer stay native."""
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from hermes_cli import kanban_db as kb
        from linear_native_db import get_session_admission
        fixture = self
        self.workers = []
        self.worker_started = asyncio.Event()
        self.instruction_consumed = asyncio.Event()
        class Endpoint(self.finite_agent_type):
            def __init__(self):
                super().__init__()
                self.instructions = []
                self.wake, self.release = asyncio.Event(), asyncio.Event()
                self.stopped = False
            def steer(self, text, *, ticket=None):
                accepted = super().steer(text, ticket=ticket)
                self.instructions.append(ticket)
                self.wake.set()
                return accepted
            def interrupt(self, text=None):
                super().interrupt(text)
                self.stopped = True
                self.release.set()
                self.wake.set()
        async def model(event):
            task = self.board.require_task(task_id)
            with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.bridge.clock() - 2):
                if task.status == "blocked":
                    latest = self.board.history(task.id, 0)[-1].id
                    self.assertTrue(kb.unblock_task(conn, task.id, expected_event_id=latest))
                claim = kb.claim_task(conn, task.id)
            self.assertIsNotNone(claim)
            owner = next(row for row in self.rows() if row["request_id"] == event.message_id)
            endpoint = Endpoint()
            endpoint.claim = claim
            self.authority.adopt_agent(owner["target_session_id"], owner["generation"], endpoint)
            self.workers.append(endpoint)
            self.decisions.append((event.message_id, event.text))
            self.worker_started.set()
            while not endpoint.release.is_set():
                await endpoint.wake.wait()
                endpoint.wake.clear()
                while endpoint.instructions:
                    ticket = endpoint.instructions.pop(0)
                    instruction = get_session_admission(self.authority.persistence, admission_id=ticket)
                    timestamp = datetime.fromisoformat(instruction["payload"]["native_text_v1"]["timestamp"]).timestamp() * 1000
                    await asyncio.to_thread(self.bridge.followup, self.ISSUE,
                        instruction["payload"]["text"], instruction["request_id"], source_ms=timestamp)
                    endpoint.pending.discard(ticket)
                    self.instruction_consumed.set()
            if not endpoint.stopped:
                with self.board.conn() as conn:
                    self.assertTrue(kb.complete_task(conn, task.id, expected_run_id=claim.current_run_id,
                        result="Verified bounded native remainder and original follow-up."))
            execution_result.get()["result"] = {"final_response": "Stopped." if endpoint.stopped else "Verified remainder complete.",
                "interrupted": endpoint.stopped, "completed": not endpoint.stopped}
            return "Stopped." if endpoint.stopped else "Verified remainder complete."
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)

    def fixture_task(self):
        issue = self.provider.issues[self.ISSUE]
        task = self.board.create(title="Existing bounded remainder",
            body=f"Linear issue {self.ISSUE}: {issue['url']}", created_by=self.board.executor_profile)
        self.bridge.track(self.ISSUE, task.id)
        return task.id

    def specialist_bridge(self, *, session_requester=False, creator_null=False):
        from hermes_fleet_linear_plugin.bridge import Bridge
        from test_linear_specialist_authorization import SCOPE
        if creator_null:
            self.provider.sessions[self.SESSION]["creator"] = None
        scope = {**SCOPE, **({"requester_basis": "agent_session"} if session_requester else {})}
        self.bridge = Bridge(self.bridge.store, self.provider.api(scope=scope), self.board,
            profile="default", clock=lambda: 1900000000.0)
        self.bridge.profile_home = self.home
        self.running["bridge"] = self.bridge
        self.bridge.native_ingress = lambda delivery: self.native_input.route_delivery(self.running, delivery)
        self.bridge.native_conversation_state = lambda payload: self.native_input.committed_conversation_state(
            self.running.get("native_adapter"), self.bridge, payload)

    async def test_creator_null_current_activity_stop_controls_linked_ready_task_before_ack(self):
        task_id = self.fixture_task()
        self.specialist_bridge(session_requester=True, creator_null=True)
        event = self.event("creator-null-stop", "stop", signal="stop")
        event["agentSession"].pop("creatorId")
        await self.deliver_raw("creator-null-stop", event)
        await self.until(lambda: self.inbox_row("creator-null-stop")[2] == "imported")
        self.assertEqual(self.board.get(task_id).status, "blocked")
        intent = self.bridge.store.native_intent(f"stop:{self.ISSUE}:creator-null-stop")
        self.assertEqual(intent["state"], "applied")
        self.assertIn("expected_event_id", intent["payload"])
        self.assertIsNone(self.provider.sessions[self.SESSION]["creator"])

    async def test_fresh_authorized_discussion_reads_and_replies_without_thawing_old_effect_fence(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from hermes_fleet_linear_plugin import chat, transport
        from hermes_fleet_linear_plugin.api import LinearError
        task_id = self.fixture_task()
        self.specialist_bridge()
        old = self.bridge.comment(self.ISSUE, "Original held native finding")
        old_row = self.bridge.store.outbox_row(old)
        denied = self.event("earlier-denied-actor", "Denied older instruction")
        self.provider.activities["earlier-denied-actor"]["user"] = {"id": "not-allowed"}
        denied["agentActivity"]["user"] = {"id": "not-allowed"}
        with self.assertRaises(LinearError):
            self.native_input.project_input(self.bridge, denied)
        self.assertTrue(self.bridge.store.scope_fenced(self.ISSUE))
        native_events = self.board.history(task_id, 0)
        async def decision(event):
            context = transport.capture_context()
            status = json.loads(chat.handle(self.bridge, {"action": "status", "issue": self.ISSUE}, context))
            self.assertTrue(status["ok"], status)
            self.assertEqual(status["issue"]["description"], self.provider.issues[self.ISSUE]["description"])
            self.assertTrue(status["native"]["effects_held"])
            effect = json.loads(chat.handle(self.bridge, {"action": "followup", "issue": self.ISSUE,
                "id": "00000000-0000-4000-8000-000000000001", "body": "Must stay held"}, context))
            self.assertFalse(effect["ok"], effect)
            execution_result.get()["result"] = {"completed": True,
                "final_response": "Current issue read; prior effects remain held."}
            return "Current issue read; prior effects remain held."
        self.model = decision
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        await self.deliver("current-allowed-discussion", "Read the current issue and discuss its status.")
        await self.until(lambda: self.rows() and self.rows()[0]["status"] == "terminal")
        # HTTP acceptance precedes lifecycle reconciliation and the durable sent receipt.
        await self.until(lambda: self.final_reply_sent("current-allowed-discussion"))
        replies = [row for row in self.bridge.store.pending() if self.bridge.store.conversation_reply(row["kind"], row["payload"])]
        self.assertEqual(replies, [])
        self.assertTrue(self.bridge.store.scope_fenced(self.ISSUE))
        self.assertEqual(self.bridge.store.outbox_row(old), old_row)
        self.assertEqual(self.board.history(task_id, 0), native_events)
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.assertEqual(self.inbox_row("current-allowed-discussion")[2], "imported")
        self.assertEqual(len(self.provider.mutations), 1)

    async def test_fenced_discussion_reply_rechecks_original_actor_and_does_not_starve_new_allowed_reply(self):
        self.specialist_bridge(session_requester=True, creator_null=True)
        self.bridge.store.fence_scope(self.ISSUE, "retained earlier authorization denial", at=1)
        self.event("original-reply-actor", "Original authorized discussion")
        transport = self.bridge.api.transport
        unavailable = [True]
        def endpoint(url, body, headers):
            if unavailable[0] and json.loads(body)["query"].lstrip().startswith("mutation"):
                return 503, {}, json.dumps({"errors": [{"message": "finite reply outage"}]}).encode()
            return transport(url, body, headers)
        self.bridge.api.transport = endpoint
        first = await self.adapter.send(self.ISSUE, "Frozen original discussion response",
            reply_to="original-reply-actor", metadata={"thread_id": self.SESSION})
        self.assertFalse(first.success)
        original = self.bridge.store.outbox_row(first.message_id)["payload"]
        self.provider.activities["original-reply-actor"]["user"] = {"id": "revoked"}
        unavailable[0] = False
        self.bridge.clock = lambda: 1900001000.0
        self.assertEqual(await asyncio.to_thread(self.bridge.flush), 0)
        self.assertEqual(self.provider.mutations, [])
        self.event("new-allowed-reply", "Independent current authorized discussion")
        second = await self.adapter.send(self.ISSUE, "New independently authorized response",
            reply_to="new-allowed-reply", metadata={"thread_id": self.SESSION})
        self.assertTrue(second.success, second)
        held = self.bridge.store.outbox_row(first.message_id)
        self.assertNotEqual(held["state"], "sent")
        self.assertEqual(held["payload"]["content"], original["content"])
        self.assertEqual(held["payload"]["requester_activities"], original["requester_activities"])
        self.assertTrue(self.bridge.store.scope_fenced(self.ISSUE))
        self.assertEqual(len(self.provider.mutations), 1)
        self.assertEqual(self.rows(), [])

    async def test_rejected_task_stop_is_retried_and_stops_work_claimed_after_the_click(self):
        from hermes_cli import kanban_db as kb
        task_id = self.fixture_task()
        with self.board.conn() as conn:
            conn.execute("CREATE TRIGGER fixture_refuse_stop BEFORE UPDATE OF status ON tasks "
                "WHEN NEW.status='blocked' BEGIN SELECT RAISE(ABORT, 'finite native Stop refusal'); END")
        event = self.event("rejected-task-stop", "stop", signal="stop")
        await self.deliver_raw("rejected-task-stop", event)
        key = f"stop:{self.ISSUE}:rejected-task-stop"
        await self.until(lambda: (self.bridge.store.native_intent(key) or {}).get("state") == "reconcile")
        await self.until(lambda: all(future.done() for future in self.adapter._submitted.values()))
        original = self.bridge.store.native_intent(key)
        self.assertEqual(self.inbox_row("rejected-task-stop")[2], "pending")
        self.assertEqual(self.board.get(task_id).status, "ready")
        with self.board.conn() as conn:
            conn.execute("DROP TRIGGER fixture_refuse_stop")
            newer = kb.claim_task(conn, task_id)
        self.assertIsNotNone(newer)
        await self.deliver_raw("rejected-stop-redelivery", event)
        for _ in range(3):
            await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database, retry_now=True)
            await asyncio.sleep(0.02)
        await self.until(lambda: all(future.done() for future in self.adapter._submitted.values()))
        # The dispatcher claiming the work after the click is not a newer human
        # decision, and one refused attempt does not freeze the Stop: the retry
        # stops the run that started in between, from the same Stop request.
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertEqual(self.board.history(task_id, 0)[-1].run_id, newer.current_run_id)
        self.assertEqual(self.bridge.store.native_intent(key)["state"], "applied")
        self.assertEqual(self.bridge.store.native_intent(key)["payload"], original["payload"])
        self.assertEqual(self.inbox_row("rejected-task-stop")[2], "imported")
        self.assertEqual(self.inbox_row("rejected-stop-redelivery")[2], "imported")

    async def test_lost_task_stop_response_reconciles_original_receipt_without_stopping_resumed_run(self):
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin.api import LinearError
        task_id = self.fixture_task()
        stop = self.board.stop
        def lose_response(*args, **kwargs):
            self.assertTrue(stop(*args, **kwargs))
            raise LinearError("finite response loss after native commit")
        event = self.event("lost-task-stop", "stop", signal="stop")
        with patch.object(self.board, "stop", side_effect=lose_response):
            await self.deliver_raw("lost-task-stop", event)
            key = f"stop:{self.ISSUE}:lost-task-stop"
            await self.until(lambda: (self.bridge.store.native_intent(key) or {}).get("state") == "reconcile")
            await self.until(lambda: all(future.done() for future in self.adapter._submitted.values()))
        original = self.bridge.store.native_intent(key)["payload"]
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertEqual(self.inbox_row("lost-task-stop")[2], "pending")
        with self.board.conn() as conn:
            self.assertTrue(kb.unblock_task(conn, task_id, expected_event_id=self.board.history(task_id, 0)[-1].id))
            newer = kb.claim_task(conn, task_id)
        event_id = self.board.history(task_id, 0)[-1].id
        await self.deliver_raw("lost-stop-redelivery", event)
        for _ in range(3):
            await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database, retry_now=True)
            await asyncio.sleep(0.02)
        await self.until(lambda: self.inbox_row("lost-stop-redelivery")[2] == "imported")
        self.assertEqual(self.board.get(task_id).status, "running")
        self.assertEqual(self.board.get(task_id).current_run_id, newer.current_run_id)
        self.assertEqual(self.board.history(task_id, 0)[-1].id, event_id)
        self.assertEqual(self.bridge.store.native_intent(key)["payload"], original)
        self.assertEqual(self.bridge.store.native_intent(key)["state"], "applied")

    async def test_unavailable_first_task_stop_retains_old_binding_and_cannot_control_replacement(self):
        from hermes_cli import kanban_db as kb
        import uuid
        old_task = self.fixture_task()
        database = Path(kb.kanban_db_path(board=self.board.board))
        unavailable = database.with_name("finite-unavailable.db")
        event = self.event("unavailable-task-stop", "stop", signal="stop")
        database.rename(unavailable)
        try:
            await self.deliver_raw("unavailable-task-stop", event)
            key = f"stop:{self.ISSUE}:unavailable-task-stop"
            await self.until(lambda: (self.bridge.store.native_intent(key) or {}).get("state") == "reconcile")
            await self.until(lambda: all(future.done() for future in self.adapter._submitted.values()))
            original = self.bridge.store.native_intent(key)["payload"]
            self.assertEqual(original["task_id"], old_task)
            self.assertIsNone(original["expected_event_id"])
            self.assertEqual(self.inbox_row("unavailable-task-stop")[2], "pending")
        finally:
            unavailable.rename(database)
        issue = self.provider.issues[self.ISSUE]
        replacement = self.board.create(title="Explicitly inspected replacement",
            body=f"Linear issue {self.ISSUE}: {issue['url']}", created_by=self.board.executor_profile)
        self.bridge.track(self.ISSUE, replacement.id, replace=True,
            expected_revision=self.bridge.store.binding_revision(self.ISSUE), request_id=str(uuid.uuid4()))
        with self.board.conn() as conn:
            newer = kb.claim_task(conn, replacement.id)
        event_id = self.board.history(replacement.id, 0)[-1].id
        await self.deliver_raw("unavailable-stop-redelivery", event)
        for _ in range(3):
            await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database, retry_now=True)
            await asyncio.sleep(0.02)
        await self.until(lambda: all(future.done() for future in self.adapter._submitted.values()))
        self.assertEqual(self.board.get(replacement.id).status, "running")
        self.assertEqual(self.board.get(replacement.id).current_run_id, newer.current_run_id)
        self.assertEqual(self.board.history(replacement.id, 0)[-1].id, event_id)
        self.assertEqual(self.bridge.store.native_intent(key)["payload"], original)
        self.assertEqual(self.inbox_row("unavailable-stop-redelivery")[2], "pending")

    async def test_running_worker_followup_queues_as_its_own_turn_without_steering_or_replay(self):
        """Upstream producer ingress: a follow-up never steers the running turn. It commits and
        ACKs as its own queued row, a redelivery resolves to that row, and it runs once, after."""
        from gateway.session_results import execution_result
        task_id = self.fixture_task()
        self.enable_owned_worker(task_id)
        worker_model, followups = self.model, []
        async def model(event):
            if event.message_id != "active-followup":
                return await worker_model(event)
            followups.append(event.text)
            execution_result.get()["result"] = {"completed": True, "final_response": "Noted."}
            return "Noted."
        self.model = model
        await self.deliver("active-opening", "Inspect the existing bounded native remainder.")
        await self.until(lambda: len(self.workers) == 1)
        worker = self.workers[0]
        original_run = worker.claim.current_run_id
        await self.deliver("active-followup", "  Preserve the completed effects; do only the remainder.\n")
        await self.until(lambda: self.inbox_row("active-followup")[2] == "imported")
        followup = next(row for row in self.rows() if row["request_id"] == "active-followup")
        self.assertEqual(followup["status"], "queued")
        self.assertEqual(worker.effects, [])  # never steered into the running worker
        self.assertEqual(self.board.get(task_id).current_run_id, original_run)
        # A distinct webhook delivery can repeat the same immutable Activity.
        await self.deliver_raw("active-followup-redelivery", self.event("active-followup",
            "  Preserve the completed effects; do only the remainder.\n"))
        await self.until(lambda: self.inbox_row("active-followup-redelivery")[2] == "imported")
        self.assertEqual(len([row for row in self.rows() if row["request_id"] == "active-followup"]), 1)
        worker.release.set()
        worker.wake.set()
        await self.until(lambda: all(row["status"] == "terminal" for row in self.rows()))
        self.assertEqual(self.board.get(task_id).status, "done")
        self.assertEqual(followups, ["  Preserve the completed effects; do only the remainder.\n"])
        self.assertEqual(len(self.decisions), 1)

    async def test_busy_followups_commit_their_own_rows_in_steer_and_queue_text_modes(self):
        """A busy chat never steers or merges Linear input: each Activity commits, ACKs, runs once."""
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        started, release, seen = asyncio.Event(), asyncio.Event(), []
        async def model(event):
            seen.append((event.message_id, event.text))
            if event.message_id == "first":
                started.set()
                await release.wait()
            execution_result.get()["result"] = {"completed": True, "final_response": "ok " + event.message_id}
            return "ok " + event.message_id
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        self.addCleanup(release.set)
        self.fixture.mode = "steer"
        self.runner._effective_busy_text_mode = lambda source: "queue"
        self.adapter._busy_text_mode = "queue"
        await self.deliver("first", "Do the first task.")
        await asyncio.wait_for(started.wait(), 10)
        second = await self.deliver("second", "Second note.")
        await self.deliver("third", "Third note.")
        await self.until(lambda: all(self.inbox_row(identity)[2] == "imported" for identity in ("second", "third")))
        texts = {row["request_id"]: row["payload"]["text"] for row in self.rows()}
        self.assertEqual(texts, {"first": "Do the first task.", "second": "Second note.", "third": "Third note."})
        await self.deliver_raw("second-redelivery", json.loads(second))
        await self.until(lambda: self.inbox_row("second-redelivery")[2] == "imported")
        self.assertEqual(len(self.rows()), 3)
        release.set()
        await self.until(lambda: all(row["status"] == "terminal" for row in self.rows()))
        self.assertEqual(sorted(seen), [("first", "Do the first task."), ("second", "Second note."),
                                        ("third", "Third note.")])

    async def test_provider_stop_controls_conversation_and_task_without_late_retry_cancelling_new_work(self):
        from hermes_cli import kanban_db as kb
        task_id = self.fixture_task()
        self.enable_owned_worker(task_id)
        original = self.event("stop-opening", "Execute the bounded native remainder.")
        await self.deliver_raw("stop-opening", original)
        await self.until(lambda: len(self.workers) == 1)
        first = self.workers[0]
        stop = self.event("typed-stop", "stop", signal="stop")
        await self.deliver_raw("typed-stop", stop)
        await self.until(lambda: self.inbox_row("typed-stop")[2] == "imported")
        await self.until(lambda: self.board.get(task_id).status == "blocked")
        await self.until(lambda: next(row for row in self.rows() if row["request_id"] == "stop-opening")["status"] == "terminal")
        self.assertTrue(first.stopped)
        # The provider Stop is Core's own /stop command: it reached the runner as a command,
        # was never admitted as model input, and its reply is the bridge's, not Core's.
        stops = [event for event in self.events if event.message_id == "typed-stop"]
        self.assertTrue(stops)
        self.assertTrue(all(event.get_command() == "stop" for event in stops))
        self.assertNotIn("typed-stop", [row["request_id"] for row in self.rows()])
        self.assertNotIn("typed-stop", [event.message_id for event, _ in self.receipts])
        self.assertNotIn("typed-stop", [identity for identity, _ in self.decisions])
        await self.deliver("after-stop", "Resume only the reconciled native remainder.")
        await self.until(lambda: len(self.workers) == 2)
        second = self.workers[1]
        self.assertNotEqual(first.claim.current_run_id, second.claim.current_run_id)
        await self.deliver_raw("old-stop-redelivery", stop)
        await self.deliver_raw("old-input-redelivery", original)
        await self.until(lambda: all(self.inbox_row(identity)[2] == "imported"
            for identity in ("old-stop-redelivery", "old-input-redelivery")))
        self.assertFalse(second.stopped)
        self.assertEqual(second.effects, [])
        self.assertEqual(self.board.get(task_id).current_run_id, second.claim.current_run_id)
        self.assertEqual(self.board.get(task_id).status, "running")
        self.assertEqual([identity for identity, _ in self.decisions], ["stop-opening", "after-stop"])
        self.assertEqual(len(self.rows()), 2)  # /stop is a command, never an admitted row
        second.release.set()
        second.wake.set()
        await self.until(lambda: all(row["status"] == "terminal" for row in self.rows()))
        self.assertEqual(self.board.get(task_id).status, "done")

    async def test_generic_notifier_retains_authorization_and_deduplicates_replies(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from gateway.kanban_watchers_notifier import _KanbanNotification
        from hermes_cli import kanban_db as kb, kanban_db_notify as notify
        from hermes_cli.kanban_db_connect import connect

        self.event("notice-source", "A verified fixture request")
        for scenario in ("valid", "absent", "foreign", "stale"):
            with self.subTest(scenario=scenario):
                database = self.home / (scenario + "-notifications.db")
                conn = connect(database)
                try:
                    task_id = kb.create_task(conn, title="Bounded notice", assignee="default")
                    key = dict(task_id=task_id, platform="linear", chat_id=self.ISSUE,
                               thread_id=self.SESSION)
                    anchor = {} if scenario == "absent" else {"reply_to": "notice-source"}
                    notify.add_notify_sub(conn, **key, delivery_mode="notify", delivery_metadata=anchor)
                    sub = notify.list_notify_subs(conn)[0]
                    old_cursor = sub["last_event_id"]
                    cursor = old_cursor + 1
                    notify.advance_notify_cursor(conn, **key, new_cursor=cursor)
                finally:
                    conn.close()

                def operation(_board, name, _sub, **kwargs):
                    connection = connect(database)
                    try:
                        getattr(notify, name)(connection, **key, **kwargs)
                    finally:
                        connection.close()

                runner = SimpleNamespace(
                    _kanban_sub_op=operation,
                    _kanban_rewind=lambda sub, claimed, old, board: operation(
                        board, "rewind_notify_cursor", sub, claimed_cursor=claimed, old_cursor=old),
                    _kanban_unsub=lambda sub, board: operation(board, "remove_notify_sub", sub),
                    _deliver_kanban_artifacts=AsyncMock(),
                )
                event = SimpleNamespace(id=cursor, kind="completed", payload={"summary": "Bounded outcome"})
                notice = _KanbanNotification(runner, dict(sub=sub, task=None, events=[event],
                    cursor=cursor, old_cursor=old_cursor, board="default"),
                    platform_cls=None, sub_fail_counts={})
                notice.adapter = self.adapter
                if scenario == "foreign":
                    self.provider.activities["notice-source"]["agentSession"] = {"id": "other-session"}
                elif scenario == "stale":
                    self.provider.activities.pop("notice-source")
                before = len(self.provider.mutations)
                delivered = await notice._send_pings()
                self.assertEqual(delivered, scenario == "valid")
                # Reconstruct the notice as the next poll would. A real outbox
                # must suppress a replay even with a stale local ping snapshot.
                repeat = _KanbanNotification(runner, notice.d, platform_cls=None, sub_fail_counts={})
                repeat.adapter = self.adapter
                self.assertEqual(await repeat._send_pings(), scenario == "valid")
                self.assertEqual(len(self.provider.mutations) - before, int(scenario == "valid"))
                connection = connect(database)
                try:
                    retained = notify.list_notify_subs(connection)
                finally:
                    connection.close()
                self.assertEqual(len(retained), 1)
                self.assertEqual(retained[0]["delivery_mode"], "notify")
                self.assertEqual(retained[0]["last_event_id"], cursor if delivered else old_cursor)
                self.assertEqual(retained[0]["last_ping_event_id"], cursor if delivered else 0)
                self.assertEqual(self.rows(), [])  # Reporting did not admit engineering work.

    async def test_adapter_reply_outage_keeps_same_outbox_identity_until_actual_sent(self):
        self.event("reply-origin", "A verified fixture request")
        original = self.bridge.api.transport
        unavailable = [True]
        def transport(url, body, headers):
            if unavailable[0] and json.loads(body)["query"].lstrip().startswith("mutation"):
                return 503, {}, json.dumps({"errors": [{"message": "finite reply endpoint unavailable"}]}).encode()
            return original(url, body, headers)
        self.bridge.api.transport = transport
        result = await self.adapter.send(self.ISSUE, "Verified finite response", reply_to="reply-origin",
                                         metadata={"thread_id": self.SESSION})
        self.assertFalse(result.success)
        rows = self.bridge.store.pending(self.ISSUE)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["id"], result.message_id)
        self.assertNotEqual(row["state"], "sent")
        self.assertEqual(self.provider.mutations, [])
        unavailable[0] = False
        self.bridge.clock = lambda: 1900001000.0
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(self.bridge.store.outbox_row(row["id"])["state"], "sent")
        retry = await self.adapter.send(self.ISSUE, "Verified finite response", reply_to="reply-origin",
                                        metadata={"thread_id": self.SESSION})
        self.assertTrue(retry.success)
        self.assertEqual(retry.message_id, row["id"])
        self.assertEqual(len(self.provider.mutations), 1)
        self.assertEqual(self.rows(), [])

    async def test_adapter_reply_recovery_rechecks_original_session_scope(self):
        self.event("reply-origin", "A verified fixture request")
        from hermes_fleet_linear_plugin.native_input import queue_reply
        row_id = queue_reply(self.bridge, self.ISSUE, self.SESSION, "reply-origin", "Held original reply")
        before = self.bridge.store.outbox_row(row_id)
        self.provider.sessions[self.SESSION]["appUser"] = {"id": "foreign-app"}
        await asyncio.to_thread(self.bridge.flush)
        after = self.bridge.store.outbox_row(row_id)
        self.assertEqual({key: after["payload"][key] for key in before["payload"]}, before["payload"])
        self.assertNotEqual(after["state"], "sent")
        self.assertEqual(self.provider.mutations, [])
        result = await self.adapter.send(self.ISSUE, "Held original reply", reply_to="reply-origin",
                                         metadata={"thread_id": self.SESSION})
        self.assertFalse(result.success)
        self.assertEqual(self.rows(), [])

    async def test_missing_handler_retains_input_until_receiver_is_actually_bound(self):
        self.adapter.set_message_handler(None)
        raw = await self.deliver("startup-input", "Do not silently consume startup work")
        self.assertEqual(self.inbox_row("startup-input")[:3], ("default", raw, "pending"))
        self.assertEqual(self.rows(), [])
        self.adapter.set_message_handler(self.runner._handle_message)
        await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database, retry_now=True)
        await self.until(lambda: self.inbox_row("startup-input")[2] == "imported")
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.rows()[0]["request_id"], "startup-input")

    async def test_actorless_assignment_scope_fence_retains_original_delivery(self):
        self.provider.sessions[self.SESSION]["creator"] = None
        self.bridge.store.fence_scope(self.ISSUE, "Retained original authorization fence", at=1)
        event = self.event("actorless-fenced", "", action="created")
        event["agentSession"].pop("creatorId")
        raw = await self.deliver_raw("actorless-fenced", event)
        await self.until(lambda: all(f.done() for f in self.adapter._submitted.values()))
        for _ in range(3):
            await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database, retry_now=True)
            await asyncio.sleep(.02)
        self.assertEqual(self.inbox_row("actorless-fenced")[1:3], (raw, "pending"))
        self.assertTrue(self.bridge.store.scope_fenced(self.ISSUE))
        self.assertIsNone(self.bridge.store.get(self.ISSUE))
        self.assertEqual(self.board.discover(self.provider.issues[self.ISSUE]), [])
        self.assertEqual(self.rows(), [])

    async def test_actorless_unknown_creation_retry_cannot_ack_or_repeat_create(self):
        self.provider.sessions[self.SESSION]["creator"] = None
        with self.board.conn() as conn:
            conn.execute("CREATE TRIGGER fixture_refuse_create BEFORE INSERT ON tasks "
                         "BEGIN SELECT RAISE(ABORT, 'finite native create refusal'); END")
        event = self.event("actorless-unknown", "", action="created")
        event["agentSession"].pop("creatorId")
        raw = await self.deliver_raw("actorless-unknown", event)
        await self.until(lambda: all(f.done() for f in self.adapter._submitted.values()))
        self.assertEqual(self.inbox_row("actorless-unknown")[2], "pending")
        with self.board.conn() as conn:
            conn.execute("DROP TRIGGER fixture_refuse_create")
        original = self.bridge.store.native_intent("create:" + self.ISSUE)["payload"]
        for _ in range(5):
            await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database, retry_now=True)
            await asyncio.sleep(.02)
        intent = self.bridge.store.native_intent("create:" + self.ISSUE)
        self.assertEqual(intent["state"], "reconcile")
        self.assertEqual(intent["payload"], original)
        self.assertEqual(self.inbox_row("actorless-unknown")[1:3], (raw, "pending"))
        self.assertIsNone(self.bridge.store.get(self.ISSUE))
        self.assertEqual(self.board.discover(self.provider.issues[self.ISSUE]), [])
        self.assertEqual(self.rows(), [])

    async def test_actorless_committed_create_response_loss_reconciles_before_ack(self):
        self.provider.sessions[self.SESSION]["creator"] = None
        event = self.event("actorless-lost-response", "", action="created")
        event["agentSession"].pop("creatorId")
        create = self.board.create
        created = []
        def lost_response(**kwargs):
            created.append(create(**kwargs))
            raise ConnectionError("finite create response loss")
        with patch.object(self.board, "create", side_effect=lost_response) as request:
            raw = await self.deliver_raw("actorless-lost-response", event)
            await self.until(lambda: all(f.done() for f in self.adapter._submitted.values()))
            self.assertEqual(self.inbox_row("actorless-lost-response")[2], "pending")
            self.assertEqual(request.call_count, 1)
        self.assertIsNone(self.bridge.store.get(self.ISSUE))
        self.assertEqual(self.board.get(created[0].id).status, "blocked")
        with patch.object(self.board, "create", side_effect=AssertionError("must reconcile original create")):
            for _ in range(5):
                await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database, retry_now=True)
                await asyncio.sleep(.02)
            await self.until(lambda: self.inbox_row("actorless-lost-response")[2] == "imported")
        self.assertEqual(self.bridge.store.get(self.ISSUE)["task_id"], created[0].id)
        self.assertEqual(self.bridge.store.native_intent("create:" + self.ISSUE)["state"], "applied")
        self.assertEqual(len(self.board.discover(self.provider.issues[self.ISSUE])), 1)
        self.assertEqual(self.inbox_row("actorless-lost-response")[1], raw)
        self.assertEqual(self.rows(), [])

    async def test_known_pre_cutoff_assignment_is_consumed_without_revival(self):
        self.provider.sessions[self.SESSION]["creator"] = None
        event = self.event("actorless-stale", "", action="created")
        event["agentSession"].pop("creatorId")
        self.bridge.activation_cutoff_ms = 2000000000000
        await self.deliver_raw("actorless-stale", event)
        await self.until(lambda: self.inbox_row("actorless-stale")[2] == "imported")
        self.assertIsNone(self.bridge.store.get(self.ISSUE))
        self.assertIsNone(self.bridge.store.native_intent("create:" + self.ISSUE))
        self.assertEqual(self.rows(), [])

    async def test_ignored_nonwork_webhook_still_acknowledges_without_native_work(self):
        await self.deliver_raw("nonwork-update", {"type": "Issue", "action": "update", "data": {"id": self.ISSUE}})
        await self.until(lambda: self.inbox_row("nonwork-update")[2] == "imported")
        self.assertIsNone(self.bridge.store.get(self.ISSUE))
        self.assertEqual(self.rows(), [])

    async def test_actorless_assignment_uses_one_native_coordination_task_and_unknown_requester(self):
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin.native_input import ACTORLESS_COORDINATION
        self.provider.sessions[self.SESSION]["creator"] = None
        event = self.event("unused", "", action="created")
        event["agentSession"].pop("creatorId")
        event.pop("agentActivity")
        raw = await self.deliver_raw("actorless-delivery", event)
        await self.until(lambda: self.inbox_row("actorless-delivery")[2] == "imported")
        binding = self.bridge.store.native_binding(self.ISSUE)
        self.assertIsNotNone(binding)
        task = self.board.get(binding["task_id"])
        self.assertEqual(task.status, "ready")
        self.assertEqual(task.created_by, "linear")
        self.assertIn(ACTORLESS_COORDINATION, task.body)
        self.assertEqual(self.rows(), [])  # No invented human conversation/principal.
        self.assertEqual(self.receipts, [])
        with self.board.conn() as conn:
            claim = kb.claim_task(conn, task.id)
            context = kb.build_worker_context(conn, task.id)
        # Explicit finite task-model endpoint, fed the actual native worker
        # context and owned run; no spawned worker or local-owner principal.
        def task_model(worker_context, owned_run):
            self.assertIn(ACTORLESS_COORDINATION, worker_context)
            self.assertEqual(owned_run.current_run_id, self.board.get(task.id).current_run_id)
            self.decisions.append((task.id, "coordinate-native-remainder", None))
            artifact = self.home / "verified-remainder.txt"
            artifact.write_text("One bounded remainder, requester unknown.\n")
            return "Verified one bounded remainder; artifact: " + str(artifact)
        outcome = task_model(context, claim)
        with self.board.conn() as conn:
            self.assertTrue(kb.complete_task(conn, task.id,
                expected_run_id=claim.current_run_id,
                result=outcome))
        await self.deliver_raw("actorless-redelivery", event)
        await self.until(lambda: self.inbox_row("actorless-redelivery")[2] == "imported")
        self.assertEqual(self.board.get(task.id).status, "done")
        self.assertEqual(len(self.board.discover(self.provider.issues[self.ISSUE])), 1)
        self.assertEqual(len(self.decisions), 1)
        self.assertEqual(self.inbox_row("actorless-delivery")[1], raw)
        self.assertEqual(self.rows(), [])

    async def test_creator_null_later_activity_reaches_model_track_and_scoped_publication(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from hermes_fleet_linear_plugin import chat, transport
        from hermes_fleet_linear_plugin.bridge import Bridge
        from test_linear_specialist_authorization import SCOPE
        import uuid
        self.provider.sessions[self.SESSION]["creator"] = None
        self.bridge = Bridge(self.bridge.store, self.provider.api(scope={**SCOPE, "requester_basis": "agent_session"}),
            self.board, profile="default", clock=lambda: 1900000000.0)
        self.bridge.profile_home = self.home
        self.running["bridge"] = self.bridge
        self.bridge.native_ingress = lambda delivery: self.native_input.route_delivery(self.running, delivery)
        self.bridge.native_conversation_state = lambda payload: self.native_input.committed_conversation_state(
            self.running.get("native_adapter"), self.bridge, payload)
        request_id = str(uuid.uuid4())
        async def decision(event):
            context = transport.capture_context(track=True)
            self.assertEqual(context.message_id, "later-allowed-activity")
            status = json.loads(chat.handle(self.bridge, {"action": "status", "issue": self.ISSUE}, context))
            self.assertTrue(status["ok"], status)
            issue = self.provider.issues[self.ISSUE]
            task = self.board.create(title="Existing authorized native remainder",
                body=f"Linear issue {self.ISSUE}: {issue['url']}", created_by=self.board.executor_profile,
                initial_status="blocked")
            tracked = json.loads(chat.handle(self.bridge, {"action": "track", "issue": self.ISSUE,
                "task_id": task.id}, context))
            self.assertTrue(tracked["ok"], tracked)
            update = json.loads(chat.handle(self.bridge, {"action": "add_comment", "issue": self.ISSUE,
                "id": request_id, "body": "Verified later Activity, original creator remains unknown."}, context))
            self.assertTrue(update["ok"], update)
            execution_result.get()["result"] = {"completed": True, "final_response": "Native reporting linked."}
            return "Native reporting linked."
        self.model = decision
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        event = self.event("later-allowed-activity", "Inspect and link the authorized remainder.")
        event["agentSession"].pop("creatorId")
        raw = await self.deliver_raw("later-allowed-activity", event)
        await self.until(lambda: self.rows() and self.rows()[0]["status"] == "terminal")
        await asyncio.to_thread(self.bridge.flush)
        binding = self.bridge.store.native_binding(self.ISSUE)
        self.assertEqual((binding["requester_session_id"], binding["requester_activity_id"]),
                         (self.SESSION, "later-allowed-activity"))
        self.assertEqual(self.bridge.store.outbox_row(request_id)["state"], "sent")
        self.assertEqual(self.inbox_row("later-allowed-activity"), ("default", raw, "imported", 1))
        self.assertIsNone(self.provider.sessions[self.SESSION]["creator"])
        # Outside the model's requester context, existing native reporting
        # recovers only the paired coordinates and verifies the Activity again.
        self.assertTrue(self.bridge.authorize_specialist_effect(self.ISSUE))
        self.assertFalse(self.bridge.store.scope_fenced(self.ISSUE))
        self.assertEqual(self.board.get(binding["task_id"]).status, "blocked")

    async def test_native_done_before_pr_acceptance_capture_keeps_session_open(self):
        await self.check_native_completion_capture_gap(with_pr=True)

    async def test_native_done_before_local_completion_capture_keeps_session_open(self):
        await self.check_native_completion_capture_gap(with_pr=False)

    async def check_native_completion_capture_gap(self, *, with_pr):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin import bridge as bridge_module
        await asyncio.to_thread(self.bridge.entrust, self.ISSUE)
        task_id = self.bridge.store.get(self.ISSUE)["task_id"]
        echo = self.event("unused-echo", "", action="created")
        echo.pop("agentActivity")
        echo["agentSession"]["creatorId"] = None
        self.provider.sessions[self.SESSION]["creator"] = None
        self.assertTrue(await asyncio.to_thread(self.bridge.handle_webhook, echo))
        await asyncio.to_thread(self.bridge.pump_kanban)
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(self.bridge.store.get(self.ISSUE)["owner_ref"], self.SESSION)
        with self.board.conn() as conn:
            self.assertIsNotNone(kb.claim_task(conn, task_id, claimer="finite-worker"))
        started, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        async def model(event):
            started.set()
            await release.wait()
            body = "The implementation finished; its closeout is being verified."
            execution_result.get()["result"] = {"completed": True, "final_response": body}
            return body
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        event = self.event("completion-gap", "Summarize the current work.")
        event["agentSession"]["creatorId"] = None
        await self.deliver_raw("completion-gap", event)
        await self.until(started.is_set)
        receipt = {"ok": False, "classification": "pending", "head_sha": "a" * 40, "checks": []}
        self.provider.issues[self.ISSUE]["team"]["states"]["nodes"].append(
            {"id": "state-review", "name": "In Review", "type": "started"})
        with patch.object(bridge_module, "pr_acceptance", lambda *args: receipt):
            with self.board.conn() as conn:
                kb.complete_task(conn, task_id, summary="Implementation and local checks finished.",
                    result="https://github.com/example/project/pull/12" if with_pr else "Local checks passed.")
            self.assertIsNone(self.bridge.store.acceptance_recheck(self.ISSUE, task_id))
            cursor = self.bridge.store.get(self.ISSUE)["last_event_id"]
            release.set()
            await self.until(lambda: self.final_reply_sent("completion-gap"))
            def responses():
                return [value for value in self.provider.activities.values()
                        if value.get("user", {}).get("id") == self.provider.viewer
                        and value.get("content", {}).get("type") == "response"]
            self.assertEqual(responses(), [], "Chat must wait for native completion capture")
            self.assertEqual(self.bridge.store.get(self.ISSUE)["last_event_id"], cursor,
                             "Reply projection must not run the reporting pump")
            await asyncio.to_thread(self.bridge.pump_kanban)
            await asyncio.to_thread(self.bridge.flush)
            if with_pr:
                self.assertTrue(self.bridge._pending_session_acceptance(self.bridge.store.get(self.ISSUE)))
                self.assertEqual(responses(), [])
                receipt.update(ok=True, classification="passed")
                self.bridge.clock = lambda: 1900000000.0 + 3600
                for _ in range(3):
                    await asyncio.to_thread(self.bridge.tick)
            self.assertEqual(len(responses()), 1, "Verified native closeout completes the session exactly once")
            self.assertEqual(len(self.rows()), 1)

    async def test_human_mention_is_acknowledged_first_and_reaches_the_model_as_a_question_with_work_facts(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        task_id = self.fixture_task()
        question = "@agent is the rollout finished, or is anything still waiting?"
        seen = []
        completion_started, replay_receipt_started, completion_finished = (asyncio.Event() for _ in range(3))
        admitted, completed = self.adapter._admitted, self.adapter.on_processing_complete
        receipt_count = 0
        async def overlap_receipt(event, receipt):
            nonlocal receipt_count
            receipt_count += 1
            if receipt_count == 2:
                replay_receipt_started.set()
                await completion_finished.wait()
            await admitted(event, receipt)
        async def overlap_completion(event, outcome):
            if not completion_started.is_set():
                completion_started.set()
                await replay_receipt_started.wait()
                try:
                    await completed(event, outcome)
                finally:
                    completion_finished.set()
            else:
                await completed(event, outcome)
        self.adapter._admitted = overlap_receipt
        self.adapter.on_processing_complete = overlap_completion
        async def answer(event):
            # The acknowledgment is already visible in Linear before any model turn.
            seen.append((event.text, event.channel_context, [query for query in self.provider.mutations
                                                              if "agentActivityCreate" in query]))
            execution_result.get()["result"] = {"completed": True, "final_response": "Still running."}
            return "Still running."
        self.model = answer
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        event = self.event("unused-mention-activity", "", action="created")
        event.pop("agentActivity")
        event["agentSession"]["comment"] = {"id": "mention-comment", "body": question, "userId": self.USER}
        raw = await self.deliver_raw("human-mention", event)
        await self.until(lambda: self.rows() and self.rows()[0]["status"] == "terminal")
        self.assertEqual(len(seen), 1)
        text, context, acknowledged = seen[0]
        self.assertEqual(text, question)
        self.assertIn("@mention", context)
        self.assertIn(f"task {task_id}", context)
        self.assertIn("`linear followup`", context)
        self.assertEqual(len(acknowledged), 1)
        ack = self.bridge.store.outbox_row(self.native_input.stable_uuid4(
            "native-session-ack", "default", self.ISSUE, self.SESSION))
        self.assertEqual((ack["state"], ack["payload"]["content"]["type"]), ("sent", "thought"))
        self.assertEqual(self.inbox_row("human-mention"), ("default", raw, "imported", 1))
        def activity_creates():
            return len([query for query in self.provider.mutations if "agentActivityCreate" in query])
        # The acknowledgment and then the model's own reply; nothing else.
        await self.until(lambda: activity_creates() == 2)
        activities = activity_creates()
        # A redelivered mention neither posts a second acknowledgment nor starts a second model turn.
        await self.until(completion_started.is_set)
        await self.deliver_raw("human-mention-redelivery", event)
        await self.until(completion_finished.is_set)
        # The replay overlapped the original completion; it resolves to the committed row and ACKs.
        await self.until(lambda: self.inbox_row("human-mention-redelivery")[2] == "imported")
        self.assertEqual(len(self.rows()), 1)
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(activity_creates(), activities)
        self.assertEqual(len(seen), 1)
        with self.board.conn() as conn:
            self.assertEqual([row[0] for row in conn.execute("SELECT id FROM tasks")], [task_id])

    async def test_human_delegation_without_prompt_starts_one_tracked_task_before_the_model_turn(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        seen = []
        async def answer(event):
            # Admission already happened: the one task exists and this turn shows In Progress.
            with self.board.conn() as conn:
                tasks = [row[0] for row in conn.execute("SELECT id FROM tasks")]
            seen.append((event.text, event.channel_context, tasks, self.bridge._session_turn_active(self.ISSUE)))
            execution_result.get()["result"] = {"completed": True, "final_response": "Under way."}
            return "Under way."
        self.model = answer
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        event = self.event("unused-delegation-activity", "", action="created")
        event.pop("agentActivity")
        # Linear's own authorless thread root (HF-617): not a mention and not a request.
        event["agentSession"]["comment"] = {"id": "thread-root", "body": "This thread is for an agent session with agent.",
                                            "issueId": self.ISSUE}
        raw = await self.deliver_raw("human-delegation", event)
        await self.until(lambda: self.rows() and self.rows()[0]["status"] == "terminal")
        await self.until(lambda: self.inbox_row("human-delegation")[2] == "imported")
        self.assertEqual(len(seen), 1)
        text, context, tasks, in_turn = seen[0]
        self.assertIn("was delegated to you", text)
        self.assertEqual(len(tasks), 1)
        self.assertIn("Tracked delegated work is staged", context)
        self.assertIn(tasks[0], context)
        self.assertTrue(in_turn)
        self.assertEqual(self.board.require_task(tasks[0]).status, "ready")
        await self.until(lambda: self.inbox_row("human-delegation")[2] == "imported")
        self.assertEqual(self.inbox_row("human-delegation"), ("default", raw, "imported", 1))
        await self.until(lambda: not self.bridge._session_turn_active(self.ISSUE))  # the turn ended
        # A redelivered delegation reuses the same task: no second create or admission.
        await self.deliver_raw("human-delegation-redelivery", event)
        await self.until(lambda: self.inbox_row("human-delegation-redelivery")[2] == "imported")
        with self.board.conn() as conn:
            self.assertEqual([row[0] for row in conn.execute("SELECT id FROM tasks")], tasks)
        self.assertEqual([e.kind for e in self.board.history(tasks[0], 0)].count("unblocked"), 1)
        self.assertEqual(len(seen), 1)  # nor a second model turn

    async def test_distinct_provider_inputs_commit_own_ids_bodies_before_own_inbox_ack(self):
        a = await self.deliver("activity-a", "  First unchanged instruction.\n")
        b = await self.deliver("activity-b", "Second unchanged instruction\nwith detail.")
        await self.until(lambda: {event.message_id for event, _ in self.receipts} >= {"activity-a", "activity-b"})
        expected = [("activity-a", "  First unchanged instruction.\n", a),
                    ("activity-b", "Second unchanged instruction\nwith detail.", b)]
        for identity, text, raw in expected:
            row = next(row for row in self.rows() if row["request_id"] == identity)
            self.assertEqual(row["payload"]["text"], text)
            self.assertEqual(self.inbox_row(identity), ("default", raw, "imported", 1))
            event, receipt = next(pair for pair in self.receipts if pair[0].message_id == identity)
            self.assertEqual(event.source.platform.value, "linear")
            self.assertEqual((event.source.chat_id, event.source.thread_id, event.source.user_id,
                              event.source.scope_id), (self.ISSUE, self.SESSION, self.USER, self.provider.organization))
            self.assertEqual(receipt["admission_id"], row["admission_id"])
        self.assertEqual(self.board.discover(self.provider.issues[self.ISSUE]), [])
        self.assertEqual(self.decisions, [])

    async def replace_input_adapter(self):
        from gateway.config import PlatformConfig
        await self.adapter.disconnect()
        self.adapter = self.native_input.create_adapter(
            PlatformConfig(enabled=True, typing_indicator=False), self.running)
        self.assertTrue(await self.adapter.connect())
        self.adapter.set_message_handler(self.runner._handle_message)
        self.adapter.set_session_store(self.fixture.store)
        self.adapter.set_authorization_check(lambda user_id, *_args, **_kwargs: user_id == self.USER)
        self.runner.adapters[self.adapter.platform] = self.adapter

    def final_reply_sent(self, activity_id):
        with self.bridge.store._tx() as db:
            return db.execute("SELECT 1 FROM outbox WHERE state='sent' AND kind='activity' "
                "AND json_extract(payload,'$.source_activity')=? "
                "AND (json_extract(payload,'$.turn_final')=1 OR json_extract(payload,'$.content.type')='response')",
                (activity_id,)).fetchone() is not None

    async def completed_input_replay_keeps_current_anchor(self, *, recreate=False):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from tools import clarify_gateway as clarify
        started, release = asyncio.Event(), asyncio.Event()
        async def model(event):
            if event.message_id == "current-input":
                started.set()
                await release.wait()
            execution_result.get()["result"] = {"completed": True, "final_response": "Finite check finished."}
            return "Finite check finished."
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        original = self.event("completed-input", "Do the first finite check.")
        await self.deliver_raw("completed-input", original)
        await self.until(lambda: self.rows() and self.rows()[0]["status"] == "terminal"
                         and self.final_reply_sent("completed-input"))
        await self.deliver("current-input", "Do the second finite check.")
        await asyncio.wait_for(started.wait(), 10)
        await self.until(lambda: any(event.message_id == "current-input" for event, _ in self.receipts)
                         and self.inbox_row("current-input")[2] == "imported")
        current = next(event for event, _ in self.receipts if event.message_id == "current-input")
        key = self.fixture.store._generate_session_key(current.source)
        self.addCleanup(clarify.clear_session, key)
        try:
            if recreate:
                await self.replace_input_adapter()
                self.assertEqual(self.adapter._inputs, {})
                # Reconnect restores the active anchor even before another provider delivery.
                result = await self.adapter.send(self.ISSUE, "Restored current progress.",
                    metadata={"thread_id": self.SESSION, "_interim_send": True})
                self.assertTrue(result.success, result.error)
            await self.deliver_raw("old-provider-retry", original)
            await self.until(lambda: self.inbox_row("old-provider-retry")[2] == "imported")
            self.assertEqual(len(self.rows()), 2)
            self.assertEqual(self.adapter._inputs[(self.ISSUE, self.SESSION)], "current-input")
            interim = await self.adapter.send(self.ISSUE, "Current second check is running.",
                metadata={"thread_id": self.SESSION, "_interim_send": True})
            approval = await self.show_approval(key)
            clarify.register(clarify_id="current-question", session_key=key,
                question="Which environment?", choices=["staging", "production"])
            question = await self.adapter.send_clarify(self.ISSUE, "Which environment?",
                choices=["staging", "production"], clarify_id="current-question", session_key=key,
                metadata={"thread_id": self.SESSION})
            for result in (interim, approval, question):
                self.assertTrue(result.success, result.error)
                row = self.bridge.store.outbox_row(result.message_id)
                self.assertEqual(row["payload"]["source_activity"], "current-input")
        finally:
            release.set()
        await self.until(lambda: all(row["status"] == "terminal" for row in self.rows()))
        # Replacement can cancel the old adapter's transport waiter. Reconcile the exact
        # final reply through the same idempotent send path before testing its boundary.
        final = await self.adapter.send(self.ISSUE, "Finite check finished.", reply_to="current-input",
            metadata={"thread_id": self.SESSION})
        self.assertTrue(final.success, final.error)
        self.assertTrue(self.final_reply_sent("current-input"))
        if recreate:
            await self.replace_input_adapter()
        # Reloading the same anchor retains its original cursor; it cannot reopen the final reply.
        for metadata in ({"_interim_send": True}, {"is_approval_prompt": True}):
            late = await self.adapter.send(self.ISSUE, "Late current-turn update.",
                metadata={"thread_id": self.SESSION, **metadata})
            self.assertFalse(late.success)
            self.assertFalse(late.retryable)
        late = await self.adapter.send_clarify(self.ISSUE, "Late question?", choices=None,
            clarify_id="late-question", session_key=key, metadata={"thread_id": self.SESSION})
        self.assertFalse(late.success)
        self.assertFalse(late.retryable)

    async def test_completed_input_replay_preserves_active_turn_reply_anchor(self):
        await self.completed_input_replay_keeps_current_anchor()

    async def test_recreated_adapter_preserves_active_anchor_and_final_reply_cursor(self):
        await self.completed_input_replay_keeps_current_anchor(recreate=True)

    async def test_pending_receipt_replay_cannot_replace_a_newer_input_anchor(self):
        original = self.event("older-queued-input", "First queued instruction.")
        await self.deliver_raw("older-queued-input", original)
        await self.until(lambda: self.inbox_row("older-queued-input")[2] == "imported")
        await self.deliver("newer-queued-input", "Second queued instruction.")
        await self.until(lambda: self.inbox_row("newer-queued-input")[2] == "imported")
        await self.deliver_raw("older-queued-retry", original)
        await self.until(lambda: self.inbox_row("older-queued-retry")[2] == "imported")
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(self.adapter._inputs[(self.ISSUE, self.SESSION)], "newer-queued-input")

    async def queued_input_lifecycle(self, *, recreate=False):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from tools import approval, clarify_gateway as clarify
        from tools.approval_gateway_wait import _ApprovalEntry
        first_started, first_release, second_started, second_release = [asyncio.Event() for _ in range(4)]
        async def model(event):
            started, release = ((first_started, first_release) if event.message_id == "first"
                                else (second_started, second_release))
            started.set()
            await release.wait()
            body = "Finished " + event.message_id
            execution_result.get()["result"] = {"completed": True, "final_response": body}
            return body
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        self.addCleanup(first_release.set)
        self.addCleanup(second_release.set)
        await self.deliver("first", "Do the first task.")
        await asyncio.wait_for(first_started.wait(), 10)
        await self.deliver("second", "Then do the second task.")
        await self.until(lambda: self.inbox_row("second")[2] == "imported" and
                         any(event.message_id == "second" for event, _ in self.receipts))
        self.assertEqual([row["status"] for row in self.rows()], ["started", "queued"])
        first_release.set()
        await asyncio.wait_for(second_started.wait(), 10)
        await self.until(lambda: self.final_reply_sent("first"))
        with self.bridge.store._tx() as db:
            first = json.loads(db.execute("SELECT payload FROM outbox WHERE "
                "json_extract(payload,'$.source_activity')='first' "
                "AND (json_extract(payload,'$.turn_final')=1 OR "
                "json_extract(payload,'$.content.type')='response')").fetchone()[0])
        self.assertEqual(first["content"]["type"], "thought")  # the session remains working for B
        second_event = next(event for event, _ in self.receipts if event.message_id == "second")
        key = self.fixture.store._generate_session_key(second_event.source)
        self.adapter.set_authorization_check(lambda user_id, *_args, **_kwargs: user_id == self.USER)
        entry = _ApprovalEntry({"command": "second-command"})
        with approval._lock:
            approval._gateway_queues[key] = [entry]
        self.addCleanup(approval.unregister_gateway_notify, key)
        self.addCleanup(clarify.clear_session, key)
        clarify.register(clarify_id="second-question", session_key=key, question="Environment?",
                         choices=["staging", "production"])
        for result in (
            await self.adapter.send(self.ISSUE, "Working on the second task.",
                metadata={"thread_id": self.SESSION, "_interim_send": True}),
            await self.show_approval(key, entry),
            await self.adapter.send_clarify(self.ISSUE, "Environment?", choices=["staging", "production"],
                clarify_id="second-question", session_key=key, metadata={"thread_id": self.SESSION}),
        ):
            self.assertTrue(result.success, result.error)
        selected = next(option["value"] for option in self.bridge.store.outbox_row(result.message_id)["payload"]
                        ["signal_metadata"]["options"] if option["label"] == "staging")
        if recreate:
            await self.replace_input_adapter()
        await self.deliver("clarify-answer", selected)
        await self.until(lambda: self.inbox_row("clarify-answer")[2] == "imported")
        self.assertEqual(clarify.wait_for_response("second-question", timeout=0.1), "staging")
        await self.deliver("approval-answer", "approve")
        await self.until(lambda: self.inbox_row("approval-answer")[2] == "imported")
        self.assertEqual(entry.result, "once")
        self.assertEqual(len(self.rows()), 2)
        progress = await self.adapter.send(self.ISSUE, "Second command is still running.",
            metadata={"thread_id": self.SESSION, "_interim_send": True})
        self.assertTrue(progress.success, progress.error)
        # A's final still closes A's own lane, even though its visible activity is a thought.
        late_first = await self.adapter.send(self.ISSUE, "Late first-task progress.", reply_to="first",
            metadata={"thread_id": self.SESSION, "_interim_send": True})
        self.assertFalse(late_first.success)
        second_release.set()
        await self.until(lambda: all(row["status"] == "terminal" for row in self.rows()))
        final = await self.adapter.send(self.ISSUE, "Finished second", reply_to="second",
            metadata={"thread_id": self.SESSION})
        self.assertTrue(final.success, final.error)
        self.assertEqual(self.bridge.store.outbox_row(final.message_id)["payload"]["content"]["type"], "response")
        for metadata in ({"_interim_send": True}, {"is_approval_prompt": True}):
            late = await self.adapter.send(self.ISSUE, "Late second-task update.",
                metadata={"thread_id": self.SESSION, **metadata})
            self.assertFalse(late.success)
        late = await self.adapter.send_clarify(self.ISSUE, "Late question?", choices=None,
            clarify_id="late-second-question", session_key=key, metadata={"thread_id": self.SESSION})
        self.assertFalse(late.success)

    async def test_queued_input_remains_open_when_its_predecessor_finishes(self):
        await self.queued_input_lifecycle()

    async def test_queued_input_and_pending_prompts_survive_adapter_replacement(self):
        await self.queued_input_lifecycle(recreate=True)

    async def pending_prompt_replacement(self, kind, *, closed=False):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from tools import approval, clarify_gateway as clarify
        from tools.approval_gateway_wait import _ApprovalEntry
        started, release = asyncio.Event(), asyncio.Event()
        async def model(event):
            started.set()
            await release.wait()
            execution_result.get()["result"] = {"completed": True, "final_response": "Finished."}
            return "Finished."
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        self.addCleanup(release.set)
        await self.deliver("initial", "Do the finite task.")
        await asyncio.wait_for(started.wait(), 10)
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        self.addCleanup(approval.unregister_gateway_notify, key)
        if kind == "clarify":
            clarify.register(clarify_id="delivered-question", session_key=key,
                question="Environment?", choices=["staging", "production"])
            sent = await self.adapter.send_clarify(self.ISSUE, "Environment?", choices=["staging", "production"],
                clarify_id="delivered-question", session_key=key, metadata={"thread_id": self.SESSION})
            answer = "staging"
        else:
            entry = _ApprovalEntry({"command": "delivered-command"})
            with approval._lock:
                approval._gateway_queues[key] = [entry]
            sent = await self.show_approval(key, entry)
            answer = "approve"
        self.assertTrue(sent.success, sent.error)
        if closed:
            final = await self.adapter.send(self.ISSUE, "The original turn is finished.", reply_to="initial",
                metadata={"thread_id": self.SESSION})
            self.assertTrue(final.success, final.error)
        await self.replace_input_adapter()
        await self.deliver("fresh-answer", answer)
        await self.until(lambda: self.inbox_row("fresh-answer")[2] == "imported")
        if closed:
            if kind == "clarify":
                self.assertIsNotNone(clarify.get_pending("delivered-question"))
            else:
                self.assertIsNone(entry.result)
            self.assertEqual(len(self.rows()), 2)
            return
        if kind == "clarify":
            self.assertEqual(clarify.wait_for_response("delivered-question", timeout=0.1), "staging")
            clarify.register(clarify_id="undelivered-question", session_key=key,
                question="Another environment?", choices=["staging", "production"])
        else:
            self.assertEqual(entry.result, "once")
            undelivered = _ApprovalEntry({"command": "undelivered-command"})
            with approval._lock:
                approval._gateway_queues[key] = [undelivered]
        self.assertEqual(len(self.rows()), 1)
        # The saved association cannot authorize a different prompt that was never delivered.
        await self.deliver("another-fresh-answer", answer)
        await self.until(lambda: self.inbox_row("another-fresh-answer")[2] == "imported")
        if kind == "clarify":
            self.assertIsNotNone(clarify.get_pending("undelivered-question"))
        else:
            self.assertIsNone(undelivered.result)
        self.assertEqual(len(self.rows()), 2)

    async def test_delivered_clarify_routes_after_replacement_without_authorizing_a_new_prompt(self):
        await self.pending_prompt_replacement("clarify")

    async def test_delivered_approval_routes_after_replacement_without_authorizing_a_new_prompt(self):
        await self.pending_prompt_replacement("approval")

    async def test_closed_turn_clarify_cannot_consume_an_answer_after_replacement(self):
        await self.pending_prompt_replacement("clarify", closed=True)

    async def test_closed_turn_approval_cannot_consume_an_answer_after_replacement(self):
        await self.pending_prompt_replacement("approval", closed=True)

    async def ordinary_replay_at_prompt(self, kind, *, recreate=False, unreadable=False):
        """Real authority receipts must win over later prompt interception, including reconnect."""
        from gateway.config import PlatformConfig
        from tools import approval, clarify_gateway as clarify
        from tools.approval_gateway_wait import _ApprovalEntry
        text = "approve" if kind == "approval" else "staging"
        original = self.event("ordinary-before-question", text)
        await self.deliver_raw("ordinary-before-question", original)
        await self.until(lambda: self.receipts and self.inbox_row("ordinary-before-question")[2] == "imported")
        source = self.receipts[0][0].source
        key = self.fixture.store._generate_session_key(source)
        if recreate:
            await self.adapter.disconnect()
            self.adapter = self.native_input.create_adapter(
                PlatformConfig(enabled=True, typing_indicator=False), self.running)
            self.assertTrue(await self.adapter.connect())
            self.adapter.set_message_handler(self.runner._handle_message)
            self.adapter.set_session_store(self.fixture.store)
            self.runner.adapters[self.adapter.platform] = self.adapter
            self.assertEqual(getattr(self.adapter, "_ordinary", set()), set())
        self.adapter.set_authorization_check(lambda user_id, *_args, **_kwargs: user_id == self.USER)
        await self.deliver("current-input", "Continue the bounded check.")
        await self.until(lambda: self.inbox_row("current-input")[2] == "imported")
        if kind == "approval":
            entry = _ApprovalEntry({"command": "later-command"})
            with approval._lock:
                approval._gateway_queues[key] = [entry]
            self.addCleanup(approval.unregister_gateway_notify, key)
            sent = await self.show_approval(key, entry)
        else:
            clarify.register(clarify_id="later-question", session_key=key,
                question="Which environment?", choices=["staging", "production"])
            self.addCleanup(clarify.clear_session, key)
            sent = await self.adapter.send_clarify(self.ISSUE, "Which environment?",
                choices=["staging", "production"], clarify_id="later-question", session_key=key,
                metadata={"thread_id": self.SESSION})
        self.assertTrue(sent.success, sent.error)
        if unreadable:
            with patch.object(type(self.authority.persistence.admissions), "match",
                              side_effect=sqlite3.OperationalError("receipt unavailable")):
                await self.deliver_raw("ordinary-redelivery", original)
                await self.until(lambda: all(f.done() for f in self.adapter._submitted.values()))
            # The plugin's own ledger read is unavailable, but the replay is not consent: its stored
            # disposition is ordinary, and Core's admission resolves it to its committed row.
            self.assertEqual(self.inbox_row("ordinary-redelivery")[2], "imported")
        else:
            await self.deliver_raw("ordinary-redelivery", original)
            await self.until(lambda: self.inbox_row("ordinary-redelivery")[2] == "imported")
        self.assertEqual(len(self.rows()), 2)
        if kind == "approval":
            self.assertIsNone(entry.result)
            self.assertFalse(entry.event.is_set())
        else:
            self.assertIsNotNone(clarify.get_pending("later-question"))
        if unreadable:
            return
        await self.deliver("fresh-answer", text)
        await self.until(lambda: self.inbox_row("fresh-answer")[2] == "imported")
        if kind == "approval":
            self.assertEqual(entry.result, "once")
        else:
            self.assertEqual(clarify.wait_for_response("later-question", timeout=0), "staging")
        self.assertEqual(len(self.rows()), 2)  # only the two ordinary inputs reached the FIFO
        self.assertEqual(self.decisions, [])

    async def test_ordinary_input_replay_cannot_answer_later_approval(self):
        await self.ordinary_replay_at_prompt("approval")

    async def test_ordinary_input_replay_cannot_answer_later_clarify(self):
        await self.ordinary_replay_at_prompt("clarify")

    async def test_recreated_adapter_checks_durable_receipt_before_approval(self):
        await self.ordinary_replay_at_prompt("approval", recreate=True)

    async def test_recreated_adapter_checks_durable_receipt_before_clarify(self):
        await self.ordinary_replay_at_prompt("clarify", recreate=True)

    async def test_unreadable_durable_receipt_cannot_authorize_an_approval(self):
        await self.ordinary_replay_at_prompt("approval", recreate=True, unreadable=True)

    async def test_native_commit_with_failed_inbox_update_retries_receipt_without_duplicate_input(self):
        with sqlite3.connect(self.inbox.database) as db:
            db.execute("CREATE TRIGGER fixture_refuse_ack BEFORE UPDATE OF status ON deliveries "
                "WHEN NEW.status='imported' BEGIN SELECT RAISE(ABORT, 'finite inbox write refusal'); END")
        raw = await self.deliver("ack-outage", "Original committed input, original provider ID.")
        await self.until(lambda: len(self.rows()) == 1)
        await self.until(lambda: all(future.done() for future in self.adapter._submitted.values()))
        self.assertEqual(self.inbox_row("ack-outage")[:3], ("default", raw, "pending"))
        self.assertEqual(self.rows()[0]["request_id"], "ack-outage")
        self.assertEqual(self.rows()[0]["payload"]["text"], "Original committed input, original provider ID.")
        with sqlite3.connect(self.inbox.database) as db:
            db.execute("DROP TRIGGER fixture_refuse_ack")
        # Each retry follows the existing inbox loop; the first can report the
        # prior receiver error, and the next reconciles the committed input.
        for _ in range(3):
            await asyncio.to_thread(self.bridge.drain_ingress, self.inbox.database, retry_now=True)
            await asyncio.sleep(0.02)
        await self.until(lambda: self.inbox_row("ack-outage")[2] == "imported")
        self.assertEqual(self.inbox_row("ack-outage")[:3], ("default", raw, "imported"))
        self.assertGreaterEqual(self.inbox_row("ack-outage")[3], 1)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.decisions, [])

    async def test_inactive_input_reaches_finite_model_and_actual_guarded_native_task_control(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from hermes_cli import kanban_db as kb
        async def decision(event):
            self.decisions.append((event.message_id, event.text))
            issue = self.provider.issues[self.ISSUE]
            self.assertEqual(self.board.discover(issue), [])
            from hermes_fleet_linear_plugin import chat, transport
            context = transport.capture_context()
            self.assertEqual((context.platform, context.thread_id, context.user_id),
                             ("linear", self.SESSION, self.USER))
            status = json.loads(chat.handle(self.bridge, {"action": "status", "issue": self.ISSUE}, context))
            self.assertTrue(status["ok"], status)
            self.assertFalse(status["native"]["linked"])
            task = self.board.create(title="Bounded native remainder", body=f"Linear issue {self.ISSUE}: {issue['url']}",
                created_by=self.board.executor_profile, initial_status="blocked")
            events = self.board.history(task.id, 0)
            with self.board.conn() as conn:
                self.assertTrue(kb.unblock_task(conn, task.id, expected_event_id=events[-1].id))
            self.bridge.track(self.ISSUE, task.id)
            execution_result.get()["result"] = {"final_response": "Native remainder is ready.", "completed": True}
            return "Native remainder is ready."
        self.model = decision
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        raw = await self.deliver("inactive-activity", "Continue the remaining authorized work.")
        await self.until(lambda: self.bridge.store.native_binding(self.ISSUE) is not None)
        await self.until(lambda: self.rows() and self.rows()[0]["status"] == "terminal")
        self.assertEqual(self.decisions, [("inactive-activity", "Continue the remaining authorized work.")])
        binding = self.bridge.store.native_binding(self.ISSUE)
        self.assertEqual(self.board.get(binding["task_id"]).status, "ready")
        self.assertEqual(self.inbox_row("inactive-activity"), ("default", raw, "imported", 1))
        self.assertEqual(len(self.rows()), 1)
        await self.until(lambda: len(self.provider.mutations) == 1 and self.final_reply_sent("inactive-activity"))
        self.assertFalse(self.bridge.store.pending(self.ISSUE))

    async def inflight_ordinary_replacement(self, kind):
        from tools import approval, clarify_gateway as clarify
        from tools.approval_gateway_wait import _ApprovalEntry
        await self.deliver("initial", "Do the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        old = self.adapter
        reached, release = asyncio.Event(), asyncio.Event()
        admit = old._admit
        async def paused(event):
            reached.set()
            await release.wait()
            return await admit(event)
        old._admit = paused
        raw = self.event("ordinary-answer", "approve" if kind == "approval" else "staging")
        await self.deliver_raw("ordinary-first", raw)
        await asyncio.wait_for(reached.wait(), 10)
        self.assertFalse(any(row["request_id"] == "ordinary-answer" for row in self.rows()))
        try:
            await self.replace_input_adapter()
            if kind == "approval":
                entry = _ApprovalEntry({"command": "later-command"})
                with approval._lock:
                    approval._gateway_queues[key] = [entry]
                self.addCleanup(approval.unregister_gateway_notify, key)
                sent = await self.show_approval(key, entry)
            else:
                self.addCleanup(clarify.clear_session, key)
                clarify.register(clarify_id="later-question", session_key=key,
                    question="Environment?", choices=["staging", "production"])
                sent = await self.adapter.send_clarify(self.ISSUE, "Environment?", ["staging", "production"],
                    "later-question", key, metadata={"thread_id": self.SESSION})
            self.assertTrue(sent.success, sent.error)
            await self.deliver_raw("ordinary-replay", raw)
            await self.until(lambda: self.inbox_row("ordinary-replay")[2] == "imported")
            if kind == "approval":
                self.assertIsNone(entry.result)
            else:
                self.assertIsNotNone(clarify.get_pending("later-question"))
            self.assertEqual(sum(row["request_id"] == "ordinary-answer" for row in self.rows()), 1)
        finally:
            release.set()

    async def test_inflight_ordinary_approval_is_not_consent_after_replacement(self):
        await self.inflight_ordinary_replacement("approval")

    async def test_inflight_ordinary_clarify_is_not_an_answer_after_replacement(self):
        await self.inflight_ordinary_replacement("clarify")

    async def clarify_expiry_selection_race(self, *, multi=False):
        """Core's actual timeout competes while parsing the exact displayed entry."""
        import threading
        from tools import clarify_gateway as clarify
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        shown = clarify.register("shown-question", key, "Which environment?", ["staging", "production"],
                                 multi_select=multi)
        sent = await self.adapter.send_clarify(self.ISSUE, shown.question, shown.choices, shown.clarify_id, key,
            metadata={"thread_id": self.SESSION})
        self.assertTrue(sent.success, sent.error)
        hidden = clarify.register("hidden-question", key, "Next task?", ["production", "staging"], multi_select=multi)
        await self.replace_input_adapter()
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        real_lock, real_coerce = clarify._lock, clarify._coerce_text_response_detailed
        competing, finished = threading.Event(), threading.Event()
        results = []
        def expire():
            try:
                results.append(clarify.wait_for_response(shown.clarify_id, .001))
            finally:
                finished.set()
                competing.set()
        worker = threading.Thread(target=expire)
        class ObservedLock:
            # Keep the actual Core RLock; observe when the real timeout either
            # reaches a contended acquisition or finishes. No fabricated expiry.
            def __enter__(self):
                if threading.current_thread() is worker:
                    if not real_lock.acquire(blocking=False):
                        competing.set()
                        real_lock.acquire()
                else:
                    real_lock.acquire()
                return self
            def __exit__(self, *_exc):
                real_lock.release()
        selected = []
        def coerce_while_expiring(entry, response):
            if entry is shown and not selected:
                selected.append(entry)
                worker.start()
                self.assertTrue(competing.wait(5), "Core timeout never reached the exact choice boundary")
            return real_coerce(entry, response)
        original = self.event("selection", "1,2" if multi else "1")
        try:
            with patch.object(clarify, "_lock", ObservedLock()), \
                    patch.object(clarify, "_coerce_text_response_detailed", side_effect=coerce_while_expiring):
                await self.deliver_raw("selection-first", original)
                await self.until(lambda: self.inbox_row("selection-first")[2] == "imported")
                await asyncio.to_thread(worker.join, 5)
            self.assertTrue(finished.is_set())
            self.assertIsNone(hidden.response, "displayed consent was redirected to an unseen successor")
            self.assertFalse(hidden.event.is_set())
            expected = json.dumps(["staging", "production"]) if multi else "staging"
            self.assertEqual(shown.response, expected)
            self.assertEqual(results, [expected])
            self.assertEqual(len(self.rows()), 1)
            sent = await self.adapter.send_clarify(self.ISSUE, hidden.question, hidden.choices,
                hidden.clarify_id, key, metadata={"thread_id": self.SESSION})
            self.assertTrue(sent.success, sent.error)
            await self.deliver_raw("selection-replay", original)
            await self.until(lambda: self.inbox_row("selection-replay")[2] == "imported")
            self.assertIsNone(hidden.response)
            await self.deliver("fresh-selection", "1")
            await self.until(lambda: self.inbox_row("fresh-selection")[2] == "imported")
            expected = json.dumps(["production"]) if multi else "production"
            self.assertEqual(clarify.wait_for_response(hidden.clarify_id, .1), expected)
        finally:
            if worker.ident is not None:
                await asyncio.to_thread(worker.join, 5)

    async def test_clarify_timeout_cannot_redirect_numeric_answer_to_hidden_successor(self):
        await self.clarify_expiry_selection_race()

    async def test_clarify_timeout_keeps_multiselect_bound_to_displayed_choices(self):
        await self.clarify_expiry_selection_race(multi=True)

    async def test_expired_displayed_clarify_cannot_authorize_a_hidden_successor(self):
        from tools import clarify_gateway as clarify
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        shown = clarify.register("shown-question", key, "Which environment?", ["staging", "production"])
        sent = await self.adapter.send_clarify(self.ISSUE, shown.question, shown.choices, shown.clarify_id, key,
            metadata={"thread_id": self.SESSION})
        self.assertTrue(sent.success, sent.error)
        hidden = clarify.register("hidden-question", key, "Next task?", ["production", "staging"])
        self.assertIsNone(await asyncio.to_thread(clarify.wait_for_response, shown.clarify_id, .001))
        await self.replace_input_adapter()
        await self.deliver("late-selection", "1")
        await self.until(lambda: self.inbox_row("late-selection")[2] == "imported")
        self.assertIsNone(hidden.response)
        self.assertFalse(hidden.event.is_set())
        self.assertEqual(len(self.rows()), 2)

    async def test_decision_question_preserves_its_target_before_yes_can_answer(self):
        from tools import clarify_gateway as clarify
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        question = "Do you want me to cancel task t_12345678?"
        pending = clarify.register("cancel-question", key, question, ["Yes", "No"])
        sent = await self.adapter.send_clarify(self.ISSUE, question, pending.choices, pending.clarify_id, key,
            metadata={"thread_id": self.SESSION})
        self.assertTrue(sent.success, sent.error)
        displayed = self.provider.activities[sent.message_id]["content"]["body"]
        await self.replace_input_adapter()
        await self.deliver("decision-answer", "Yes")
        await self.until(lambda: self.inbox_row("decision-answer")[2] == "imported")
        self.assertEqual(clarify.wait_for_response(pending.clarify_id, .1), "Yes")
        self.assertIn(question, displayed, "consent resolved after the decision question was hidden")
        row = self.bridge.store.outbox_row(sent.message_id)
        self.assertEqual([option["label"] for option in row["payload"]["signal_metadata"]["options"]], ["Yes", "No"])
        self.assertTrue(all(option["value"].startswith(self.native_input.CHOICE_VALUE_PREFIX)
                            for option in row["payload"]["signal_metadata"]["options"]))
        self.assertEqual(len(self.rows()), 1)

    async def test_late_expired_question_does_not_replace_visible_active_question(self):
        from tools import clarify_gateway as clarify
        from unittest.mock import patch
        await self.deliver('initial', 'Inspect the bounded task.')
        await self.until(lambda: self.receipts and self.inbox_row('initial')[2] == 'imported')
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        self.addCleanup(clarify.clear_session, key)
        old = clarify.register('old-question', key, 'Which environment for the old operation?', ['staging', 'production'])
        with patch.object(self.bridge, 'flush', return_value=0):
            queued = await self.adapter.send_clarify(self.ISSUE, old.question, old.choices, old.clarify_id, key, metadata={'thread_id': self.SESSION})
        self.assertFalse(queued.success)
        self.assertIs(self.bridge.store.outbox_row(queued.message_id)['payload']['write_started'], False)
        self.assertIsNone(await asyncio.to_thread(clarify.wait_for_response, old.clarify_id, 0.001))
        active = clarify.register('current-question', key, 'Which environment for the new operation?', ['production', 'staging'])
        sent = await self.adapter.send_clarify(self.ISSUE, active.question, active.choices, active.clarify_id, key, metadata={'thread_id': self.SESSION})
        self.assertTrue(sent.success, sent.error)
        await self.replace_input_adapter()
        await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
        late = self.provider.activities.get(queued.message_id)
        await self.deliver('answer', '1')
        await self.until(lambda: self.inbox_row('answer')[2] == 'imported')
        self.assertIsNone(late, 'Expired question was published after a newer displayed question; numeric answer resolved the newer choice order')
        self.assertEqual(active.response, "production")


    async def queued_interim_after_core_completion(self, kind, *, already_displayed=False):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from tools import clarify_gateway as clarify
        started, release, sending_final, permit_final = [asyncio.Event() for _ in range(4)]
        self.addCleanup(release.set)
        self.addCleanup(permit_final.set)
        async def model(event):
            started.set()
            await release.wait()
            execution_result.get()["result"] = {"completed": True, "final_response": "Done."}
            return "Done."
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        await self.deliver("initial", "Do this finite task.")
        await asyncio.wait_for(started.wait(), 10)
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        pending = clarify.register("still-pending", key, "Proceed with the operation?", ["Yes", "No"])
        with patch.object(self.bridge, "flush", return_value=0):
            if kind == "elicitation":
                queued = await self.adapter.send_clarify(self.ISSUE, pending.question, pending.choices,
                    pending.clarify_id, key, metadata={"thread_id": self.SESSION})
            else:
                queued = await self.adapter.send(self.ISSUE, "Checking the operation.",
                    metadata={"thread_id": self.SESSION, "_interim_send": True})
        if already_displayed:
            await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
            self.assertIn(queued.message_id, self.provider.activities)
        original_send = self.adapter.send
        async def delayed_final(chat_id, content, reply_to=None, metadata=None):
            if reply_to == "initial" and content == "Done.":
                sending_final.set()
                await permit_final.wait()
            return await original_send(chat_id, content, reply_to=reply_to, metadata=metadata)
        with patch.object(self.adapter, "send", side_effect=delayed_final):
            release.set()
            await asyncio.wait_for(sending_final.wait(), 10)
            try:
                self.assertTrue(all(row["status"] == "terminal" for row in self.rows()))
                self.assertIs(clarify.get_pending(pending.clarify_id), pending)
                if already_displayed:
                    self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
                    await self.deliver("answer-after-terminal", "Yes")
                    await self.until(lambda: self.inbox_row("answer-after-terminal")[2] == "imported")
                    self.assertIsNone(pending.response, "A completed Core turn accepted a stale displayed decision")
                    self.assertFalse(pending.event.is_set())
                else:
                    await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
                    self.assertNotIn(queued.message_id, self.provider.activities,
                                     "An interim published after its committed Core turn completed")
                    self.assertIs(self.bridge.store.outbox_row(queued.message_id)["payload"]["write_started"], False)
            finally:
                permit_final.set()
                await self.until(lambda: self.final_reply_sent("initial"))

    async def test_queued_question_is_fenced_by_committed_completion_before_final_callback(self):
        await self.queued_interim_after_core_completion("elicitation")

    async def test_queued_thought_is_fenced_by_committed_completion_before_final_callback(self):
        await self.queued_interim_after_core_completion("thought")

    async def test_question_expiry_during_mutation_admission_prevents_publication(self):
        from tools import clarify_gateway as clarify
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        pending = clarify.register("admission-race", key, "Choose an environment.", ["staging", "production"])
        with patch.object(self.bridge, "flush", return_value=0):
            queued = await self.adapter.send_clarify(self.ISSUE, pending.question, pending.choices,
                pending.clarify_id, key, metadata={"thread_id": self.SESSION})
        admit = self.bridge.store.admit_mutation
        def expire_after_admit(identity, **kwargs):
            result = admit(identity, **kwargs)
            if identity == queued.message_id:
                self.assertIsNone(clarify.wait_for_response(pending.clarify_id, .001))
            return result
        with patch.object(self.bridge.store, "admit_mutation", side_effect=expire_after_admit):
            await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
        self.assertNotIn(queued.message_id, self.provider.activities)
        self.assertIs(self.bridge.store.outbox_row(queued.message_id)["payload"]["write_started"], False)

    async def test_question_publication_serializes_with_concurrent_core_expiry(self):
        from tools import clarify_gateway as clarify
        import threading
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        pending = clarify.register("transport-race", key, "Choose an environment.", ["staging", "production"])
        expiry_started, expired = threading.Event(), threading.Event()
        def expire():
            expiry_started.set()
            clarify.wait_for_response(pending.clarify_id, .001)
            expired.set()
        thread = threading.Thread(target=expire)
        original = self.bridge.api.transport
        def transport(url, body, headers):
            request = json.loads(body)
            if "agentActivityCreate" in request["query"] and request["variables"]["input"]["content"]["type"] == "elicitation":
                thread.start()
                self.assertTrue(expiry_started.wait(1))
                self.assertFalse(expired.wait(.02), "Core expired the request during its locked publication")
                self.assertIs(clarify.get_pending(pending.clarify_id), pending)
            return original(url, body, headers)
        self.bridge.api.transport = transport
        sent = await self.adapter.send_clarify(self.ISSUE, pending.question, pending.choices,
            pending.clarify_id, key, metadata={"thread_id": self.SESSION})
        self.assertTrue(sent.success, sent.error)
        await asyncio.to_thread(thread.join, 2)
        self.assertTrue(expired.is_set())
        self.assertIn(sent.message_id, self.provider.activities)

    async def late_uncertain_question_cannot_answer_successor(self, old_kind, current_kind, *, exhausted=False):
        from tools import clarify_gateway as clarify, approval
        from tools.approval_gateway_wait import _ApprovalEntry
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        self.addCleanup(approval.unregister_gateway_notify, key)
        original, delayed = self.bridge.api.transport, []
        def transport(url, body, headers):
            request = json.loads(body)
            if not delayed and "agentActivityCreate" in request["query"] and request["variables"]["input"]["content"]["type"] == "elicitation":
                delayed.append((url, body, headers))
                raise TimeoutError("fixture remote request remains in flight")
            return original(url, body, headers)
        self.bridge.api.transport = transport
        if old_kind == "clarify":
            old_choices = ["staging", "production"] if current_kind == "clarify" else ["Yes", "No"]
            old = clarify.register("late-old", key, "Choose the old operation.", old_choices)
            queued = await self.adapter.send_clarify(self.ISSUE, old.question, old.choices,
                old.clarify_id, key, metadata={"thread_id": self.SESSION})
            self.assertIsNone(await asyncio.to_thread(clarify.wait_for_response, old.clarify_id, .001))
        else:
            old = _ApprovalEntry({"command": "old-command"})
            with approval._lock:
                approval._gateway_queues[key] = [old]
            queued = await self.show_approval(key, old)
            self.assertTrue(approval.withdraw_gateway_approval(key, old.data["request_id"], "expired"))
        self.assertFalse(queued.success)
        self.assertTrue(self.bridge.store.outbox_row(queued.message_id)["payload"]["write_started"])
        if current_kind == "clarify":
            choices = ["production", "staging"] if old_kind == "clarify" else ["Yes", "No"]
            current = clarify.register("current-question", key, "Choose the new operation.", choices)
            sent = await self.adapter.send_clarify(self.ISSUE, current.question, current.choices,
                current.clarify_id, key, metadata={"thread_id": self.SESSION})
        else:
            current = _ApprovalEntry({"command": "new-command"})
            with approval._lock:
                approval._gateway_queues[key] = [current]
            sent = await self.show_approval(key, current)
        self.assertTrue(sent.success, sent.error)
        # The uncertain old HTTP create reaches the provider after the new card.
        original(*delayed[0])
        # The person answers while late A is visible. Its immutable Activity must
        # not become consent to B even if a lifecycle repair displays B before delivery.
        reply = "1" if old_kind == current_kind == "clarify" else "Yes"
        answer = self.event("late-answer", reply)
        if exhausted:
            row = self.bridge.store.outbox_row(queued.message_id)
            self.assertTrue(self.bridge.store.retry(row, self.bridge.clock() + 25 * 3600, "fixture retry exhausted"))
            self.assertEqual(self.bridge.store.outbox_row(queued.message_id)["state"], "failed")
        else:
            self.bridge.store.defer(queued.message_id, self.bridge.clock() - 1)
            await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
            self.assertEqual(self.bridge.store.outbox_row(queued.message_id)["state"], "sent")
        await self.replace_input_adapter()
        await self.deliver_raw("late-answer", answer)
        await self.until(lambda: self.inbox_row("late-answer")[2] == "imported")
        self.assertIsNone(current.response if current_kind == "clarify" else current.result,
                          "A reply to the late expired card authorized its differently displayed successor")
        self.assertFalse(current.event.is_set())
        self.assertEqual(len(self.rows()), 2)

    async def test_late_uncertain_clarify_cannot_redirect_numeric_answer_after_replacement(self):
        await self.late_uncertain_question_cannot_answer_successor("clarify", "clarify")

    async def test_late_uncertain_clarify_cannot_authorize_a_command_approval(self):
        await self.late_uncertain_question_cannot_answer_successor("clarify", "approval")

    async def test_late_uncertain_approval_cannot_answer_a_clarification(self):
        await self.late_uncertain_question_cannot_answer_successor("approval", "clarify")

    async def test_withdrawn_approval_cannot_publish_during_mutation_admission(self):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(approval.unregister_gateway_notify, key)
        pending = _ApprovalEntry({"command": "bounded-command"})
        with approval._lock:
            approval._gateway_queues[key] = [pending]
        with patch.object(self.bridge, "flush", return_value=0):
            queued = await self.show_approval(key, pending)
        admit = self.bridge.store.admit_mutation
        def withdraw_after_admit(identity, **kwargs):
            result = admit(identity, **kwargs)
            if identity == queued.message_id:
                self.assertTrue(approval.withdraw_gateway_approval(key, pending.data["request_id"], "expired"))
            return result
        with patch.object(self.bridge.store, "admit_mutation", side_effect=withdraw_after_admit):
            await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
        self.assertNotIn(queued.message_id, self.provider.activities)
        self.assertIs(self.bridge.store.outbox_row(queued.message_id)["payload"]["write_started"], False)

    async def test_exhausted_uncertain_question_remains_a_visible_consent_barrier(self):
        await self.late_uncertain_question_cannot_answer_successor("clarify", "clarify", exhausted=True)

    async def test_displayed_question_cannot_answer_after_committed_completion_before_final_callback(self):
        await self.queued_interim_after_core_completion("elicitation", already_displayed=True)

    async def displayed_approval_selection(self, selected_index):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        entries = [_ApprovalEntry({"command": command}) for command in ("delete-old-backups", "deploy-staging")]
        with approval._lock:
            approval._gateway_queues[key] = entries.copy()
        self.addCleanup(approval.unregister_gateway_notify, key)
        values = []
        for entry in entries:
            sent = await self.show_approval(key, entry)
            self.assertTrue(sent.success, sent.error)
            payload = self.bridge.store.outbox_row(sent.message_id)["payload"]
            self.assertIn(entry.data["command"], payload["content"]["body"])
            values.append(payload["signal_metadata"]["options"][0]["value"])
        await self.replace_input_adapter()
        await self.deliver("selected-card", values[selected_index])
        await self.until(lambda: self.inbox_row("selected-card")[2] == "imported")
        self.assertEqual(entries[selected_index].result, "once")
        self.assertIsNone(entries[1 - selected_index].result, "The selected card authorized a different command")
        self.assertNotEqual(*values, "Two different commands must not emit the same selected value")
        await self.deliver("selected-card", values[selected_index])
        self.assertIsNone(entries[1 - selected_index].result)
        self.assertEqual(len(self.rows()), 1)

    async def test_newer_approval_card_selection_resolves_only_its_request_after_replacement(self):
        await self.displayed_approval_selection(1)

    async def test_older_approval_card_selection_resolves_only_its_request_after_replacement(self):
        await self.displayed_approval_selection(0)

    async def test_plain_approve_cannot_choose_between_two_displayed_commands(self):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        entries = [_ApprovalEntry({"command": command}) for command in ("delete-old-backups", "deploy-staging")]
        with approval._lock:
            approval._gateway_queues[key] = entries.copy()
        self.addCleanup(approval.unregister_gateway_notify, key)
        for entry in entries:
            self.assertTrue((await self.show_approval(key, entry)).success)
        await self.deliver("ambiguous-answer", "approve")
        await self.until(lambda: self.inbox_row("ambiguous-answer")[2] == "imported")
        self.assertEqual([entry.result for entry in entries], [None, None])
        self.assertEqual(len(self.rows()), 2)

    async def displayed_clarify_selection(self, selected_index):
        from tools import clarify_gateway as clarify
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        self.addCleanup(clarify.clear_session, key)
        entries, values = [], []
        for identity, choices in (("first-card", ["staging", "production"]), ("second-card", ["production", "staging"])):
            entry = clarify.register(identity, key, "Choose " + identity, choices)
            sent = await self.adapter.send_clarify(self.ISSUE, entry.question, entry.choices,
                entry.clarify_id, key, metadata={"thread_id": self.SESSION})
            self.assertTrue(sent.success, sent.error)
            entries.append(entry)
            options = self.bridge.store.outbox_row(sent.message_id)["payload"]["signal_metadata"]["options"]
            # Both cards have a production option; its identity still belongs to its own question.
            values.append(next(option["value"] for option in options if option.get("label", option["value"]) == "production"))
        await self.replace_input_adapter()
        await self.deliver("selected-card", values[selected_index])
        await self.until(lambda: self.inbox_row("selected-card")[2] == "imported")
        self.assertEqual(entries[selected_index].response, "production")
        self.assertIsNone(entries[1 - selected_index].response)
        self.assertNotEqual(*values)
        self.assertFalse(entries[1 - selected_index].event.is_set())
        self.assertEqual(len(self.rows()), 1)

    async def test_newer_clarify_selection_keeps_its_own_choices_after_replacement(self):
        await self.displayed_clarify_selection(1)

    async def test_older_clarify_selection_keeps_its_own_choices_after_replacement(self):
        await self.displayed_clarify_selection(0)

    async def test_expired_native_selection_never_becomes_the_successors_text_answer(self):
        from tools import clarify_gateway as clarify
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        shown = clarify.register("expired-card", key, "Old environment?", ["staging", "production"])
        sent = await self.adapter.send_clarify(self.ISSUE, shown.question, shown.choices, shown.clarify_id, key,
            metadata={"thread_id": self.SESSION})
        value = self.bridge.store.outbox_row(sent.message_id)["payload"]["signal_metadata"]["options"][0]["value"]
        self.assertIsNone(await asyncio.to_thread(clarify.wait_for_response, shown.clarify_id, .001))
        current = clarify.register("current-card", key, "New environment?", ["production", "staging"])
        self.assertTrue((await self.adapter.send_clarify(self.ISSUE, current.question, current.choices,
            current.clarify_id, key, metadata={"thread_id": self.SESSION})).success)
        await self.replace_input_adapter()
        await self.deliver("expired-selection", value)
        await self.until(lambda: self.inbox_row("expired-selection")[2] == "imported")
        self.assertIsNone(current.response)
        self.assertEqual(len(self.rows()), 2)

    async def test_bound_approval_selection_cannot_answer_a_displayed_clarification(self):
        from tools import approval, clarify_gateway as clarify
        from tools.approval_gateway_wait import _ApprovalEntry
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        command = _ApprovalEntry({"command": "deploy-staging"})
        with approval._lock:
            approval._gateway_queues[key] = [command]
        self.addCleanup(approval.unregister_gateway_notify, key)
        self.addCleanup(clarify.clear_session, key)
        card = await self.show_approval(key, command)
        selected = self.bridge.store.outbox_row(card.message_id)["payload"]["signal_metadata"]["options"][0]["value"]
        question = clarify.register("other-kind", key, "Approve the separate plan?", ["approve", "deny"])
        self.assertTrue((await self.adapter.send_clarify(self.ISSUE, question.question, question.choices,
            question.clarify_id, key, metadata={"thread_id": self.SESSION})).success)
        await self.replace_input_adapter()
        await self.deliver("command-selection", selected)
        await self.until(lambda: self.inbox_row("command-selection")[2] == "imported")
        self.assertEqual(command.result, "once")
        self.assertIsNone(question.response)
        self.assertEqual(len(self.rows()), 1)

    async def test_single_displayed_clarify_text_does_not_answer_an_undisplayed_fifo_sibling(self):
        from tools import clarify_gateway as clarify
        await self.deliver("initial", "Inspect the bounded task.")
        await self.until(lambda: self.receipts and self.inbox_row("initial")[2] == "imported")
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        self.addCleanup(clarify.clear_session, key)
        hidden = clarify.register("hidden-earlier", key, "Hidden question?", ["production", "staging"])
        shown = clarify.register("shown-later", key, "Displayed question?", ["staging", "production"])
        sent = await self.adapter.send_clarify(self.ISSUE, shown.question, shown.choices,
            shown.clarify_id, key, metadata={"thread_id": self.SESSION})
        self.assertTrue(sent.success, sent.error)
        await self.deliver("single-text-answer", "staging")
        await self.until(lambda: self.inbox_row("single-text-answer")[2] == "imported")
        self.assertEqual(shown.response, "staging")
        self.assertIsNone(hidden.response)
        self.assertEqual(len(self.rows()), 1)
