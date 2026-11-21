"""Mid-turn Linear sends: interim notes, clarify questions and approval prompts.

Core sends these without ``reply_to``. The adapter used to refuse every one of them, so
a clarify was "[clarify prompt could not be delivered]", a text approval waited out
``approvals.timeout`` and denied, and heartbeats vanished. Here they post into the turn's
own Agent Session: interim notes as a ``thought``, questions as an ``elicitation`` (with
Linear's ``select`` signal for one pick), and the person's next prompt answers them
through Core's own clarify and approval resolution. The turn's reply is unchanged.

The Linear provider is the fixture; Core's adapter base, clarify and approval modules,
and the plugin's outbox are the real ones.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_linear_native_bridge_scenarios as native
from linear_core_capabilities import requires_status_metadata

QUESTION = "Which environment should the migration run against?"
CHOICES = ["staging", "production"]


class Delivery:
    """One provider input as the reporting thread hands it to the adapter."""

    def __init__(self, event):
        self.profile, self.logical_agent = "default", "default"
        self.delivery_id = event["agentActivity"]["id"]
        self.payload = json.dumps(event)
        self.acknowledged = 0

    def event(self):
        return json.loads(self.payload)

    def acknowledge(self):
        self.acknowledged += 1


@unittest.skipIf(native.CORE is not None, f"native source unavailable ({native.CORE})")
class NativePromptScenarios(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = native.NativeBridgeScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.bridge, self.store, self.authority = self.fixture.bridge, self.fixture.store, self.fixture.authority
        self._wall_origin = self.bridge.clock()
        self.posted = []
        original = self.bridge.api.transport
        def observe(url, body, headers):
            payload = json.loads(body)
            if "agentActivityCreate" in payload["query"]:
                self.posted.append(payload["variables"]["input"])
            return original(url, body, headers)
        self.bridge.api.transport = observe
        from gateway.config import Platform, PlatformConfig
        from gateway.platform_registry import platform_registry
        with patch.object(platform_registry, "is_registered", return_value=True):
            Platform("linear")
        from hermes_fleet_linear_plugin import native_input
        self.native_input = native_input
        # This finite prompt fixture projects receipts itself; guarded seam tests own the real Core ledger.
        committed = patch.object(native_input, "committed_conversation_state",
                                 return_value={"live": False, "latest_activity": None, "turn_live": True})
        committed.start()
        self.addCleanup(committed.stop)
        self.running = {"bridge": self.bridge}
        self.adapter = native_input.create_adapter(PlatformConfig(enabled=True), self.running)
        self.assertTrue(await self.adapter.connect())
        self.addAsyncCleanup(self.adapter.disconnect)
        # The runner's allowlist check: only the issue's person may answer.
        self.adapter.set_authorization_check(lambda user_id, *_args, **_kwargs: user_id == native.USER)
        self.messages = []
        async def admit(event):
            # Core commits the input, then calls the committed-input hook.
            self.messages.append(event)
            await self.adapter.on_message_admitted(event, SimpleNamespace(control=None,
                admission_id=event.message_id, sequence=len(self.messages), status="queued"))
        self.adapter.set_message_handler(lambda event: None)
        self.adapter.handle_message = admit
        self.loop = asyncio.get_running_loop()

    def delivery(self, identity, body, *, user=native.USER, delivery_id=None):
        from datetime import datetime, timezone
        self.authority.activities.setdefault(identity, {"id": identity, "user": {"id": user},
            "createdAt": datetime.now(timezone.utc).isoformat(), "agentSession": {"id": native.SESSION}})
        event = self.fixture.event("prompted", body=body)
        event["agentActivity"].update(id=identity, user={"id": user})
        delivery = Delivery(event)
        delivery.delivery_id = delivery_id or identity
        return delivery

    async def deliver(self, identity, body, *, user=native.USER, delivery_id=None):
        delivery = self.delivery(identity, body, user=user, delivery_id=delivery_id)
        await self.route(delivery)
        return delivery

    async def route(self, delivery):
        self.assertTrue(self.adapter.route(delivery))
        future = self.adapter._submitted.get(self.adapter._delivery_key(delivery))
        if future is not None:
            await asyncio.wait_for(asyncio.wrap_future(future), 10)

    async def start_turn(self):
        delivery = await self.deliver(native.ACTIVITY, "Run the schema migration for this issue.")
        self.assertEqual(delivery.acknowledged, 1)
        self.assertEqual(len(self.messages), 1)
        return self.messages[0]

    def session_key(self, event):
        return self.adapter._core_session_keys(event.source)[0] if hasattr(self.adapter, "_core_session_keys") \
            else self.adapter._source_session_key(event.source)

    async def until_posted(self, count):
        async with asyncio.timeout(10):
            while len(self.posted) < count:
                await asyncio.sleep(0.01)

    def ask(self, session_key, clarify_id, choices):
        """Core's clarify path: register, send the card, plain-text fallback, bounded wait."""
        from gateway.run_turn_runner_clarify_delivery import _clarify_send_then_wait, text_fallback_coro
        from tools import clarify_gateway as clarify
        send = dict(chat_id=native.ISSUE, question=QUESTION, choices=choices, clarify_id=clarify_id,
                    session_key=session_key, metadata={"thread_id": native.SESSION})
        clarify.register(clarify_id=clarify_id, session_key=session_key, question=QUESTION, choices=choices)
        future = asyncio.run_coroutine_threadsafe(self.adapter.send_clarify(**send), self.loop)
        def fallback():
            coro = text_fallback_coro(self.adapter, **send)
            return None if coro is None else asyncio.run_coroutine_threadsafe(coro, self.loop)
        return _clarify_send_then_wait(future, clarify_id=clarify_id, session_key=session_key,
                                       clarify_mod=clarify, fallback=fallback)

    def render_approval(self, session_key, data):
        """Exercise Core's real card routing and delivery-outcome fallback logic."""
        from gateway.run_turn_runner import TurnRunner
        runner = SimpleNamespace(
            _ctx=SimpleNamespace(_status_adapter=self.adapter, _status_chat_id=native.ISSUE,
                session_key=session_key, _status_thread_metadata={"thread_id": native.SESSION}),
            _schedule=lambda coro, _label: asyncio.run_coroutine_threadsafe(coro, self.loop),
            _close_native_stream_boundary=lambda _label: None)
        return TurnRunner._render_approval_sync(runner, data)

    def turn_runner(self, session_key):
        """Real Core prompt renderers, with only the absent stream and scheduling supplied."""
        from gateway.run_turn_runner import TurnRunner
        runner = object.__new__(TurnRunner)
        runner._ctx = SimpleNamespace(_status_adapter=self.adapter, _status_chat_id=native.ISSUE,
            _status_thread_metadata={"thread_id": native.SESSION}, session_key=session_key)
        runner._approval_owner = None
        runner._close_native_stream_boundary = lambda *_args, **_kwargs: None
        runner._stream_consumer = lambda: None
        runner._schedule = lambda coro, _why: asyncio.run_coroutine_threadsafe(coro, self.loop)
        return runner

    def request_approval(self, session_key, command="rm -rf build/"):
        """Core renders and pauses typing, then waits for a Linear reply to resolve it."""
        from tools.approval_gateway_wait import _await_gateway_decision
        return _await_gateway_decision(session_key, lambda data: self.render_approval(session_key, data), {
            "command": command, "description": "recursive delete", "pattern_key": "recursive delete"})

    def request_clarify(self, session_key):
        return self.turn_runner(session_key)._ask_clarify_question(QUESTION, CHOICES, False)

    def owned_status(self, phrase, event=None, callback=None):
        from contextvars import copy_context
        from gateway.session_context import set_session_vars
        event = event or self.messages[-1]
        source = event.source
        def write():
            set_session_vars(platform="linear", chat_id=source.chat_id, thread_id=source.thread_id,
                message_id=event.message_id, scope_id=source.scope_id)
            if callback:
                callback()
            else:
                self.adapter.set_status_text(source.chat_id, phrase)
        copy_context().run(write)

    def status_metadata(self):
        from gateway.platforms.helpers import typing_metadata_for_turn
        source = self.adapter._inputs.get((native.ISSUE, native.SESSION))
        return typing_metadata_for_turn(self.adapter, native.ISSUE, source, {"thread_id": native.SESSION})

    async def start_typing_refresh(self):
        stop = asyncio.Event()
        task = asyncio.create_task(self.adapter._keep_typing(native.ISSUE, interval=0.05,
            metadata=self.status_metadata(), stop_event=stop))
        async def finish():
            stop.set()
            await task
        self.addAsyncCleanup(finish)
        return task

    async def display_approval(self, entry, **flags):
        key = self.session_key(self.messages[0])
        return await self.adapter.send_exec_approval(native.ISSUE, entry.data["command"], key,
            request_id=entry.data["request_id"], metadata={"thread_id": native.SESSION}, **flags)

    async def answer_later(self, key, waiter, cleanup):
        try:
            return await asyncio.wait_for(waiter, 10)
        finally:
            if not waiter.done():
                cleanup(key)

    @contextmanager
    def elapsed_time(self, at, *, bridge=None):
        """Advance adapter monotonic time and the outbox's persisted wall time together."""
        self._wall_now = self._wall_origin + at - 1000
        self.bridge.clock = lambda: self._wall_now
        self.bridge.api.clock = self.bridge.clock
        if bridge is not None:
            bridge.clock = self.bridge.clock
        with patch.object(self.native_input.time, "monotonic", return_value=at):
            yield

    async def step(self, phrase=None, *, at=1000):
        self.owned_status(phrase)
        with self.elapsed_time(at):
            await self.adapter.send_typing(native.ISSUE, metadata=self.status_metadata())
        tasks = list(self.adapter._step_tasks.values())
        if tasks:
            await asyncio.gather(*tasks)

    async def test_legacy_typing_without_producer_anchor_cannot_borrow_admitted_input(self):
        await self.start_turn()
        self.assertEqual(self.adapter._inputs[(native.ISSUE, native.SESSION)], native.ACTIVITY)
        stop = asyncio.Event()
        observed = []
        original = self.adapter.send_typing
        async def typing(*args, **kwargs):
            observed.append(kwargs.get("metadata"))
            return await original(*args, **kwargs)
        with patch.object(self.adapter, "send_typing", side_effect=typing):
            task = asyncio.create_task(self.adapter._keep_typing(native.ISSUE, interval=0.01,
                metadata={"thread_id": native.SESSION}, stop_event=stop))
            try:
                await self.wait_for_step_condition(lambda: len(observed) >= 2)
            finally:
                stop.set()
                await task
        self.assertEqual(self.posted, [])
        self.assertEqual(self.adapter._step_tasks, {})
        self.assertTrue(all("_linear_status_source" not in metadata for metadata in observed))

    @requires_status_metadata
    async def test_approval_withdrawal_after_remote_accept_before_ack_restores_live_turn(self):
        from tools import approval
        release = threading.Event()
        self.addCleanup(release.set)
        mutate = self.bridge._mutate_outbox
        withdraw = approval.withdraw_gateway_approval
        held = []
        def accepted(row_id, *args, **kwargs):
            result = mutate(row_id, *args, **kwargs)
            row = self.bridge.store.outbox_row(row_id)
            if row["payload"]["content"]["type"] == "elicitation":
                held.append(True)
                if not release.wait(10):
                    raise TimeoutError("test did not withdraw the accepted question")
            return result
        def settle(*args, **kwargs):
            try:
                return withdraw(*args, **kwargs)
            finally:
                release.set()
        with patch.object(self.bridge, "_mutate_outbox", side_effect=accepted), \
                patch.object(approval, "withdraw_gateway_approval", side_effect=settle):
            await self.test_real_approval_withdrawal_resumes_without_a_timeout_notice()
        self.assertEqual(held, [True])
        self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation", "thought", "action"])

    @requires_status_metadata
    async def test_private_argument_not_published(self):
        from gateway.run_turn_runner import TurnRunner
        event = await self.start_turn()
        runner = object.__new__(TurnRunner)
        runner._ctx = SimpleNamespace(_live_status_adapter=self.adapter, _live_status_mode='full',
            _run_still_current=lambda: True, source=event.source)
        self.owned_status(None, event, lambda: runner._progress_live_status(
            'tool.started', 'terminal', {'command': 'echo PRIVATE_CANARY'}))
        await self.adapter.send_typing(native.ISSUE, metadata=self.status_metadata())
        await asyncio.gather(*list(self.adapter._step_tasks.values()))
        published = json.dumps(self.posted)
        print('PROBE private argument reached action:', 'PRIVATE_CANARY' in published)
        self.assertNotIn('PRIVATE_CANARY', published)

    @requires_status_metadata
    async def test_optional_status_obeys_reserve(self):
        await self.start_turn()
        api = self.bridge.api
        api.budget = {'requests': {'limit': 5000, 'remaining': 500,
            'reset': api.clock() + 3600, 'at': api.clock()}}
        queries = []
        original = api.transport
        def count(url, body, headers):
            queries.append(json.loads(body)['query'].split('(')[0])
            return original(url, body, headers)
        with patch.object(api, 'transport', side_effect=count):
            await self.step('Checking status')
        print('PROBE requests at 10 percent reserve:', len(queries), 'actions:', len(self.posted))
        self.assertEqual(len(queries), 0)

    async def test_queued_status_obeys_essential_reserve(self):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, 'Checking status', kind='action', one_try=True)
        api = self.bridge.api
        api.budget = {'requests': {'limit': 5000, 'remaining': 100,
            'reset': api.clock() + 3600, 'at': api.clock()}}
        queries = []
        original = api.transport
        def count(url, body, headers):
            queries.append(json.loads(body)['query'].split('(')[0])
            return original(url, body, headers)
        with patch.object(api, 'transport', side_effect=count):
            await asyncio.to_thread(self.bridge.flush, only_id=row)
        print('PROBE queued requests at 2 percent reserve:', len(queries), 'actions:', len(self.posted))
        self.assertEqual(len(queries), 0)

    def budget(self, remaining):
        api=self.bridge.api
        api.budget={'requests':{'limit':5000,'remaining':remaining,'reset':api.clock()+3600,'at':api.clock()}}

    @requires_status_metadata
    async def test_every_read_and_mutation_is_optional(self):
        from agent.display import build_status_phrase
        await self.start_turn(); self.budget(4000); observed=[]; original=self.bridge.api.transport
        def transport(url,body,headers):
            observed.append((getattr(self.bridge.api._priority,'optional_work',False),json.loads(body)['query'].split('(')[0]))
            return original(url,body,headers)
        with patch.object(self.bridge.api,'transport',side_effect=transport):
            await self.step(build_status_phrase('read_file',{'path':'PRIVATE_CANARY'}))
        self.assertTrue(observed); self.assertTrue(all(flag for flag,_ in observed))
        self.assertEqual(self.posted[-1]['content']['parameter'],'on reading')  # HF-775 plain step
        print('FULL_ACTION_REQUESTS',len(observed),'all capped optional',flush=True)

    async def test_budget_drop_during_transport_admission_sends_nothing(self):
        from agent.display import build_status_phrase
        await self.start_turn(); self.budget(4000)
        row=self.native_input.queue_reply(self.bridge,native.ISSUE,native.SESSION,native.ACTIVITY,
            build_status_phrase('read_file',None),kind='action',one_try=True)
        original=self.bridge.store.admit_mutation; entered=[]
        def admit(identity,**kwargs):
            result=original(identity,**kwargs)
            if identity==row: entered.append(True); self.budget(100)
            return result
        with patch.object(self.bridge.store,'admit_mutation',side_effect=admit):
            await asyncio.to_thread(self.bridge.flush,only_id=row)
        self.assertTrue(entered);self.assertEqual(self.posted,[])
        self.assertIs(self.store.outbox_row(row)['payload']['write_started'],False)

    async def test_essential_final_still_delivers_when_optional_action_waits(self):
        from agent.display import build_status_phrase
        await self.start_turn(); self.budget(4000)
        action=self.native_input.queue_reply(self.bridge,native.ISSUE,native.SESSION,native.ACTIVITY,
            build_status_phrase('read_file',None),kind='action',one_try=True)
        final=self.native_input.queue_reply(self.bridge,native.ISSUE,native.SESSION,native.ACTIVITY,'Finished')
        self.budget(100)
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual([p['content']['type'] for p in self.posted],['response'])
        self.assertEqual(self.store.outbox_row(final)['state'],'sent')

    async def test_old_unattempted_argument_status_retires_without_http(self):
        from agent.display import build_status_phrase
        await self.start_turn()
        row=self.native_input.queue_reply(self.bridge,native.ISSUE,native.SESSION,native.ACTIVITY,
            build_status_phrase('terminal',None),kind='action',one_try=True)
        payload=self.store.outbox_row(row)['payload'];payload['content']['parameter']='is running echo PRIVATE_CANARY…'
        self.store.rewrite(row,payload,self.bridge.clock()); requests=[]; original=self.bridge.api.transport
        def transport(*args):requests.append(True);return original(*args)
        with patch.object(self.bridge.api,'transport',side_effect=transport):
            await asyncio.to_thread(self.bridge.flush,only_id=row)
        self.assertEqual(requests,[]);self.assertEqual(self.posted,[])
        self.assertFalse(self.store.outbox_row(row)['payload']['applied'])

    async def test_midflight_optional_budget_drop_does_not_hold_final_in_same_batch(self):
        await self.start_turn()
        session, activity = "session-second", "activity-second"
        self.authority.sessions[session] = {**self.authority.sessions[native.SESSION], "id": session}
        delivery = self.delivery(activity, "A separate turn ready to finish")
        data = delivery.event()
        data["agentSession"]["id"] = session
        self.authority.activities[activity]["agentSession"]["id"] = session
        await self.route(Delivery(data))
        self.budget(4000)
        action = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Working on your request.", kind="action", one_try=True)
        final = self.native_input.queue_reply(self.bridge, native.ISSUE, session, activity, "Finished")
        original = self.bridge.store.admit_mutation
        admitted = []
        def admit(identity, **kwargs):
            result = original(identity, **kwargs)
            if identity == action:
                admitted.append(result)
                self.budget(100)
            return result
        with patch.object(self.bridge.store, "admit_mutation", side_effect=admit):
            await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(admitted, [True])
        self.assertEqual([p["content"]["type"] for p in self.posted], ["response"])
        self.assertEqual(self.store.outbox_row(final)["state"], "sent")
        self.assertIs(self.store.outbox_row(action)["payload"]["write_started"], False)

    @requires_status_metadata
    async def test_status_arguments_and_unknown_tool_labels_never_leave_core_callback(self):
        from gateway.run_turn_runner import TurnRunner
        from agent.display import build_status_phrase
        event = await self.start_turn()
        runner = object.__new__(TurnRunner)
        runner._ctx = SimpleNamespace(_live_status_adapter=self.adapter, _live_status_mode="full",
            _run_still_current=lambda: True, source=event.source)
        for index, tool in enumerate(("terminal", "read_file", "PRIVATE_CANARY_TOOL")):
            self.owned_status(None, event, lambda: runner._progress_live_status("tool.started", tool,
                {"command": "echo PRIVATE_CANARY", "path": "PRIVATE_CANARY"}))
            with self.elapsed_time(1000 + index * 60):
                await self.adapter.send_typing(native.ISSUE, metadata=self.status_metadata())
            await asyncio.gather(*list(self.adapter._step_tasks.values()))
            expected = "on your request" if index == 2 else {"read_file": "on reading", "terminal": "in the terminal"}.get(tool, tool)
            self.assertEqual(self.posted[-1]["content"]["parameter"], expected)
        self.assertNotIn("PRIVATE_CANARY", json.dumps(self.posted))

    @requires_status_metadata
    async def test_session_scoped_step_caps_every_request_and_yields_before_auth(self):
        from test_linear_specialist_authorization import SCOPE
        from agent.display import build_status_phrase
        self.bridge.api.specialist_scope = {**SCOPE, "requester_basis": "agent_session"}
        await self.start_turn()
        self.budget(4000)
        observed = []
        original = self.bridge.api.transport
        def transport(*args):
            observed.append(getattr(self.bridge.api._priority, "optional_work", False))
            return original(*args)
        with patch.object(self.bridge.api, "transport", side_effect=transport):
            await self.step(build_status_phrase("read_file", None))
            self.assertTrue(observed)
            self.assertTrue(all(observed))
            self.assertEqual(len(self.posted), 1)
            print("SCOPED_ACTION_REQUESTS", len(observed), flush=True)
            observed.clear()
            self.budget(500)
            await self.step(build_status_phrase("terminal", None), at=1060)
            self.assertEqual(observed, [])
            self.assertEqual(len(self.posted), 1)
            self.budget(4000)
            with self.elapsed_time(1120):
                row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION, native.ACTIVITY,
                    build_status_phrase("terminal", None), kind="action", one_try=True)
            self.assertTrue(row)
            self.budget(100)
            observed.clear()
            await asyncio.to_thread(self.bridge.flush, only_id=row)
            self.assertEqual(observed, [])
            self.assertEqual(len(self.posted), 1)

    async def test_retiring_stale_status_snapshot_preserves_a_concurrent_attempt(self):
        from agent.display import build_status_phrase
        from hermes_fleet_linear_plugin.store import Store
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION, native.ACTIVITY,
            build_status_phrase("terminal", None), kind="action", one_try=True)
        payload = self.store.outbox_row(row)["payload"]
        payload["content"]["parameter"] = "is running echo PRIVATE_CANARY…"
        self.store.rewrite(row, payload, self.bridge.clock())
        other = Store(self.store.path)
        original = self.bridge.store.retire_unattempted_action
        def retire(identity, content):
            self.assertTrue(other.admit_mutation(identity, expected_content=content,
                mutation_attempt_id="concurrent-attempt", conversation_attempt_id="concurrent-attempt"))
            return original(identity, content)
        with patch.object(self.bridge.store, "retire_unattempted_action", side_effect=retire):
            await asyncio.to_thread(self.bridge.flush, only_id=row)
        current = self.store.outbox_row(row)
        self.assertEqual(current["state"], "pending")
        self.assertIs(current["payload"]["write_started"], True)
        self.assertNotIn("applied", current["payload"])
        self.assertEqual(self.posted, [])

    async def held_step_then_new_input(self, *, restart=False):
        await self.start_turn()
        entered, release = threading.Event(), threading.Event()
        original = self.bridge.flush
        def held(**kwargs):
            entered.set()
            if not release.wait(10):
                raise RuntimeError("test did not release optional status flush")
            return 0 if restart else original(**kwargs)
        with patch.object(self.bridge, "flush", side_effect=held):
            self.owned_status("Old investigation")
            await self.adapter.send_typing(native.ISSUE, metadata=self.status_metadata())
            task = self.adapter._step_tasks[(native.ISSUE, native.SESSION)]
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                await self.deliver("new-steering-input", "Stop investigating and summarize instead.")
            finally:
                release.set()
                await task
        if restart:
            # New Store and Bridge instances must enforce the admission fence without adapter memory.
            restarted = self.fixture.make_bridge()
            restarted.api = self.bridge.api
            await asyncio.to_thread(restarted.flush)
        self.assertEqual(self.posted, [])

    @requires_status_metadata
    async def test_queued_step_cannot_follow_a_newly_admitted_input(self):
        await self.held_step_then_new_input()

    @requires_status_metadata
    async def test_new_input_supersedes_queued_step_after_store_and_bridge_restart(self):
        await self.held_step_then_new_input(restart=True)

    async def test_committed_input_before_provider_ack_fences_queued_step(self):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Old investigation", kind="action", one_try=True)
        # Core's receipt commits before the adapter's ACK hook updates the durable anchor.
        self.assertEqual(self.store.conversation_input(native.ISSUE, native.SESSION)["activity_id"], native.ACTIVITY)
        with patch.object(self.bridge, "native_conversation_state", return_value={
                "live": True, "latest_activity": "new-steering-input", "turn_live": True}):
            await asyncio.to_thread(self.bridge.flush, only_id=row)
        self.assertEqual(self.posted, [])

    async def test_committed_terminal_outcome_fences_step_before_completion_post(self):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Old investigation", kind="action", one_try=True)
        with patch.object(self.bridge, "native_conversation_state", return_value={
                "live": False, "latest_activity": native.ACTIVITY, "turn_live": False}):
            await asyncio.to_thread(self.bridge.flush, only_id=row)
        self.assertEqual(self.posted, [])

    async def test_late_step_enqueue_and_old_input_replay_cannot_cross_new_input_fence(self):
        from hermes_fleet_linear_plugin.native_input import queue_reply
        await self.start_turn()
        await self.deliver("new-steering-input", "Summarize instead.")
        restarted = self.fixture.make_bridge()
        restarted.api = self.bridge.api
        old_cursor = self.adapter._input_cursors[(native.ISSUE, native.SESSION, native.ACTIVITY)]
        anchor = restarted.store.remember_conversation_input(native.ISSUE, native.SESSION, native.ACTIVITY,
            native.ACTIVITY, 1, False, [])
        self.assertEqual(anchor["activity_id"], "new-steering-input")  # Original Core sequence cannot promote old input.
        with self.elapsed_time(1000, bridge=restarted):
            late = queue_reply(restarted, native.ISSUE, native.SESSION, native.ACTIVITY,
                               "Old investigation", kind="action", one_try=True, source_cursor=old_cursor)
        await asyncio.to_thread(restarted.flush, only_id=late)
        self.assertEqual(self.posted, [])
        anchor = restarted.store.remember_conversation_input(native.ISSUE, native.SESSION, "new-steering-input",
            "new-steering-input", 2, False)
        self.assertEqual(anchor["activity_id"], "new-steering-input")
        cursor = anchor["cursor"]
        with self.elapsed_time(1060, bridge=restarted):
            fresh = queue_reply(restarted, native.ISSUE, native.SESSION, "new-steering-input",
                                "Working on your request.", kind="action", one_try=True, source_cursor=cursor)
        self.assertTrue(fresh)
        await asyncio.to_thread(restarted.flush, only_id=fresh)
        self.assertEqual([p["content"].get("parameter") for p in self.posted], ["on your request"])

    @requires_status_metadata
    async def test_real_approval_timeout_does_not_resume_over_a_different_pending_approval(self):
        from tools import approval
        key = self.session_key(await self.start_turn())
        self.addCleanup(approval.unregister_gateway_notify, key)
        first = asyncio.create_task(asyncio.to_thread(self.request_approval, key))
        await self.until_posted(1)
        with patch("tools.approval_context._get_approval_timeout", return_value=0):
            expired = await asyncio.to_thread(self.request_approval, key, "rm -rf dist/")
        self.assertFalse(expired["resolved"])
        await self.until_posted(3)
        self.assertTrue(approval.has_blocking_approval(key))
        self.assertIn(native.ISSUE, self.adapter._typing_paused)
        self.assertIn((native.ISSUE, native.SESSION), self.adapter._step_paused)
        await self.start_typing_refresh()
        await asyncio.sleep(0.15)
        self.assertNotIn("action", [p["content"]["type"] for p in self.posted])
        # The expired newer card cannot redirect a plain answer to this older request.
        # Settle the exact remaining request through Core's supported withdrawal hook.
        remaining = approval.list_gateway_approvals(key)[0]["request_id"]
        self.assertTrue(approval.withdraw_gateway_approval(key, remaining, "Remaining request withdrawn"))
        self.assertEqual((await self.answer_later(key, first, approval.unregister_gateway_notify))["cancelled"],
                         "Remaining request withdrawn")
        await self.until_posted(5)  # The timeout notice restored the still-pending first card.
        self.assertEqual(self.posted[-1]["content"]["type"], "action")

    @requires_status_metadata
    async def test_real_approval_withdrawal_resumes_without_a_timeout_notice(self):
        from tools import approval
        key = self.session_key(await self.start_turn())
        self.addCleanup(approval.unregister_gateway_notify, key)
        # Model the real still-running Core admission. The fixture's default final-reply
        # projection excludes live work and cannot describe this pre-ack withdrawal race.
        with patch.object(self.bridge, "native_conversation_state", return_value={
                "live": True, "latest_activity": native.ACTIVITY, "turn_live": True}):
            waiter = asyncio.create_task(asyncio.to_thread(self.request_approval, key))
            await self.until_posted(1)
            request_id = approval.list_gateway_approvals(key)[0]["request_id"]
            self.assertTrue(approval.withdraw_gateway_approval(key, request_id, "Prompt withdrawn"))
            result = await self.answer_later(key, waiter, approval.unregister_gateway_notify)
            self.assertEqual(result["cancelled"], "Prompt withdrawn")
            self.assertIsNone(result["choice"])
            self.assertNotIn(native.ISSUE, self.adapter._typing_paused)
            self.assertNotIn((native.ISSUE, native.SESSION), self.adapter._step_paused)
            await self.start_typing_refresh()
            await self.wait_for_step_condition(lambda: any(p["content"]["type"] == "action" for p in self.posted))
            kinds = [p["content"]["type"] for p in self.posted]
            self.assertEqual(kinds[0], "elicitation")
            self.assertEqual(kinds[-1], "action")
            self.assertTrue(all(kind in ("elicitation", "thought", "action") for kind in kinds))

    @requires_status_metadata
    async def test_real_approval_timeout_resumes_core_typing_without_a_human_answer(self):
        from tools import approval
        key = self.session_key(await self.start_turn())
        self.addCleanup(approval.unregister_gateway_notify, key)
        with patch("tools.approval_context._get_approval_timeout", return_value=0):
            result = await asyncio.to_thread(self.request_approval, key)
        self.assertFalse(result["resolved"])
        self.assertFalse(approval.has_blocking_approval(key))
        await self.until_posted(2)  # Core's timeout notice still posts.
        await self.start_typing_refresh()
        await asyncio.sleep(0.2)
        self.assertNotIn(native.ISSUE, self.adapter._typing_paused)
        self.assertNotIn((native.ISSUE, native.SESSION), self.adapter._step_paused)
        self.assertIn("action", [p["content"]["type"] for p in self.posted])

    @requires_status_metadata
    async def test_real_approval_answer_resumes_core_typing_and_posts_a_live_step(self):
        from tools import approval
        key = self.session_key(await self.start_turn())
        self.addCleanup(approval.unregister_gateway_notify, key)
        waiter = asyncio.create_task(asyncio.to_thread(self.request_approval, key))
        await self.until_posted(1)
        self.assertIn(native.ISSUE, self.adapter._typing_paused)
        await self.deliver("approval-answer", "approve")
        result = await self.answer_later(key, waiter, approval.unregister_gateway_notify)
        self.assertTrue(result["resolved"])
        self.assertNotIn(native.ISSUE, self.adapter._typing_paused)
        await self.start_typing_refresh()
        await self.until_posted(3)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation", "thought", "action"])

    @requires_status_metadata
    async def test_real_approval_answer_keeps_typing_paused_for_the_next_approval(self):
        from tools import approval
        key = self.session_key(await self.start_turn())
        self.addCleanup(approval.unregister_gateway_notify, key)
        first = asyncio.create_task(asyncio.to_thread(self.request_approval, key))
        await self.until_posted(1)
        second = asyncio.create_task(asyncio.to_thread(self.request_approval, key, "rm -rf dist/"))
        await self.until_posted(2)
        selected = next(option["value"] for option in self.posted[0]["signalMetadata"]["options"]
                        if option["label"] == "approve")
        await self.deliver("first-approval-answer", selected)
        self.assertTrue((await self.answer_later(key, first, approval.unregister_gateway_notify))["resolved"])
        self.assertTrue(approval.has_blocking_approval(key))
        self.assertIn(native.ISSUE, self.adapter._typing_paused)
        self.assertIn((native.ISSUE, native.SESSION), self.adapter._step_paused)
        await self.start_typing_refresh()
        await asyncio.sleep(0.15)
        self.assertNotIn("action", [p["content"]["type"] for p in self.posted])
        await self.deliver("second-approval-answer", "deny")
        self.assertTrue((await self.answer_later(key, second, approval.unregister_gateway_notify))["resolved"])
        await self.until_posted(6)  # Confirmation restores the still-pending second card.
        self.assertEqual(self.posted[-1]["content"]["type"], "action")

    @requires_status_metadata
    async def test_real_clarify_resume_preserves_a_pending_approval(self):
        from tools import approval, clarify_gateway as clarify
        key = self.session_key(await self.start_turn())
        self.addCleanup(approval.unregister_gateway_notify, key)
        self.addCleanup(clarify.clear_session, key)
        approval_waiter = asyncio.create_task(asyncio.to_thread(self.request_approval, key))
        await self.until_posted(1)
        question_waiter = asyncio.create_task(asyncio.to_thread(self.request_clarify, key))
        await self.until_posted(2)
        selected = next(option["value"] for option in self.posted[1]["signalMetadata"]["options"]
                        if option["label"] == "staging")
        await self.deliver("clarify-answer", selected)
        self.assertEqual(await self.answer_later(key, question_waiter, clarify.clear_session), ("staging", True))
        self.assertIn(native.ISSUE, self.adapter._typing_paused)
        self.assertIn((native.ISSUE, native.SESSION), self.adapter._step_paused)
        await self.deliver("remaining-approval-answer", "approve")
        self.assertTrue((await self.answer_later(key, approval_waiter, approval.unregister_gateway_notify))["resolved"])
        await self.start_typing_refresh()
        await self.until_posted(4)
        self.assertEqual(self.posted[-1]["content"]["type"], "action")

    async def wait_for_step_condition(self, predicate):
        async with asyncio.timeout(10):
            while not predicate():
                await asyncio.sleep(0.01)

    @requires_status_metadata
    async def test_real_clarify_timeout_retires_pause_and_restarts_owned_status(self):
        from tools import clarify_gateway as clarify
        from agent.display import build_status_phrase
        key = self.session_key(await self.start_turn())
        phrase = build_status_phrase("read_file", None)
        self.owned_status(phrase)
        with patch.object(clarify, "get_clarify_timeout", return_value=0.01):
            result = await asyncio.to_thread(self.request_clarify, key)
        self.assertFalse(result[1])
        self.assertFalse(clarify.has_pending(key))
        await self.until_posted(2)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation", "thought"])
        await self.start_typing_refresh()
        await self.until_posted(3)
        self.assertNotIn(native.ISSUE, self.adapter._typing_paused)
        self.assertNotIn((native.ISSUE, native.SESSION), self.adapter._step_paused)
        self.assertEqual(self.posted[-1]["content"]["parameter"], "on reading")

    @requires_status_metadata
    async def test_real_clarify_withdrawal_retires_pause_and_restores_work(self):
        from tools import clarify_gateway as clarify
        key = self.session_key(await self.start_turn())
        waiter = asyncio.create_task(asyncio.to_thread(self.request_clarify, key))
        await self.until_posted(1)
        self.assertEqual(clarify.clear_session(key), 1)
        self.assertFalse((await self.answer_later(key, waiter, clarify.clear_session))[1])
        await self.until_posted(2)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")
        await self.start_typing_refresh()
        await self.until_posted(3)
        self.assertEqual(self.posted[-1]["content"]["type"], "action")

    @requires_status_metadata
    async def test_clarify_timeout_preserves_another_live_question(self):
        from tools import clarify_gateway as clarify
        key = self.session_key(await self.start_turn())
        self.addCleanup(clarify.clear_session, key)
        waiting = threading.Event()
        def long_timeout():
            waiting.set()
            return 3600
        with patch.object(clarify, "get_clarify_timeout", side_effect=long_timeout):
            first = asyncio.create_task(asyncio.to_thread(self.request_clarify, key))
            await self.until_posted(1)
            self.assertTrue(await asyncio.to_thread(waiting.wait, 5))
        original = self.posted[0]
        with patch.object(clarify, "get_clarify_timeout", return_value=0.01):
            result = await asyncio.to_thread(self.request_clarify, key)
        self.assertFalse(result[1])
        await self.until_posted(3)
        self.assertTrue(clarify.has_pending(key))
        self.assertEqual(self.posted[-1]["content"], original["content"])
        self.assertEqual(self.posted[-1]["signalMetadata"], original["signalMetadata"])
        await self.start_typing_refresh()
        await asyncio.sleep(0.15)
        self.assertIn(native.ISSUE, self.adapter._typing_paused)
        self.assertNotIn("action", [p["content"]["type"] for p in self.posted])
        pending = clarify.get_pending_for_session(key, include_choice_prompts=True)
        self.assertTrue(clarify.resolve_gateway_clarify(pending.clarify_id, "staging"))
        self.assertEqual(await self.answer_later(key, first, clarify.clear_session), ("staging", True))
        await self.wait_for_step_condition(lambda: any(p["content"]["type"] == "action" for p in self.posted))

    @requires_status_metadata
    async def test_clarify_timeout_preserves_a_live_approval(self):
        from tools import clarify_gateway as clarify, approval
        key = self.session_key(await self.start_turn())
        self.addCleanup(approval.unregister_gateway_notify, key)
        first = asyncio.create_task(asyncio.to_thread(self.request_approval, key))
        await self.until_posted(1)
        original = self.posted[0]
        with patch.object(clarify, "get_clarify_timeout", return_value=0.01):
            result = await asyncio.to_thread(self.request_clarify, key)
        self.assertFalse(result[1])
        await self.until_posted(3)
        self.assertEqual(self.posted[-1]["content"], original["content"])
        self.assertEqual(self.posted[-1]["signalMetadata"], original["signalMetadata"])
        await self.start_typing_refresh()
        await asyncio.sleep(0.15)
        self.assertIn(native.ISSUE, self.adapter._typing_paused)
        self.assertNotIn("action", [p["content"]["type"] for p in self.posted])
        pending = approval.list_gateway_approvals(key)[0]["request_id"]
        self.assertTrue(approval.withdraw_gateway_approval(key, pending, "Request withdrawn"))
        self.assertEqual((await self.answer_later(key, first, approval.unregister_gateway_notify))["cancelled"], "Request withdrawn")
        await self.wait_for_step_condition(lambda: any(p["content"]["type"] == "action" for p in self.posted))

    async def test_clarify_retirement_queues_repair_before_provider_failure(self):
        from tools import clarify_gateway as clarify
        from hermes_fleet_linear_plugin.api import LinearError
        key = self.session_key(await self.start_turn())
        entered, release, done = asyncio.Event(), asyncio.Event(), asyncio.Event()
        original = self.adapter.retire_clarify_card
        errors = []
        async def retire(_adapter, *args):
            entered.set()
            await release.wait()
            try:
                await original(*args)
            except LinearError as exc:
                errors.append(exc)
            finally:
                done.set()
        with patch.object(type(self.adapter), "retire_clarify_card", retire):
            with patch.object(clarify, "get_clarify_timeout", return_value=0.01):
                self.assertFalse((await asyncio.to_thread(self.request_clarify, key))[1])
            await asyncio.wait_for(entered.wait(), 10)
            with patch.object(self.bridge, "flush", side_effect=LinearError("provider unavailable")):
                release.set()
                await asyncio.wait_for(done.wait(), 10)
        self.assertTrue(errors)
        repairs = [r for r in self.bridge.store.pending() if r["payload"].get("lifecycle_repair_of")]
        self.assertEqual(len(repairs), 1)
        self.assertIs(repairs[0]["payload"]["write_started"], False)
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation", "thought"])

    @requires_status_metadata
    async def test_clarify_retirement_uses_completed_core_turn_without_reopening_status(self):
        from tools import clarify_gateway as clarify
        key = self.session_key(await self.start_turn())
        entered, release, done = asyncio.Event(), asyncio.Event(), asyncio.Event()
        original = self.adapter.retire_clarify_card
        async def retire(_adapter, *args):
            entered.set()
            await release.wait()
            try:
                await original(*args)
            finally:
                done.set()
        with patch.object(type(self.adapter), "retire_clarify_card", retire):
            with patch.object(clarify, "get_clarify_timeout", return_value=0.01):
                self.assertFalse((await asyncio.to_thread(self.request_clarify, key))[1])
            await asyncio.wait_for(entered.wait(), 10)
            with patch.object(self.bridge, "native_conversation_state", return_value={
                    "live": False, "latest_activity": native.ACTIVITY, "turn_live": False}):
                release.set()
                await asyncio.wait_for(done.wait(), 10)
                await self.start_typing_refresh()
                await asyncio.sleep(0.15)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation", "response"])
        self.assertNotIn(native.ISSUE, self.adapter._typing_paused)

    @requires_status_metadata
    async def test_clarify_timeout_does_not_unpause_another_agent_session_question(self):
        from tools import clarify_gateway as clarify
        first_event = await self.start_turn()
        first_key = self.session_key(first_event)
        self.addCleanup(clarify.clear_session, first_key)
        waiting = threading.Event()
        def long_timeout():
            waiting.set()
            return 3600
        with patch.object(clarify, "get_clarify_timeout", side_effect=long_timeout):
            first = asyncio.create_task(asyncio.to_thread(self.request_clarify, first_key))
            await self.until_posted(1)
            self.assertTrue(await asyncio.to_thread(waiting.wait, 5))
        session, activity = "session-second", "activity-second"
        self.authority.sessions[session] = {**self.authority.sessions[native.SESSION], "id": session}
        delivery = self.delivery(activity, "A separate request")
        data = delivery.event()
        data["agentSession"]["id"] = session
        self.authority.activities[activity]["agentSession"]["id"] = session
        await self.route(Delivery(data))
        key = self.session_key(self.messages[-1])
        runner = self.turn_runner(key)
        runner._ctx._status_thread_metadata = {"thread_id": session}
        # Publication is earlier than retirement completion. Hold that exact CI window.
        release = threading.Event()
        self.addCleanup(release.set)
        original = self.bridge._queue_conversation_lifecycle_repair
        def held(*args, **kwargs):
            result = original(*args, **kwargs)
            if kwargs.get("retire_clarify") and not release.wait(10):
                raise TimeoutError("test did not release completed retirement publication")
            return result
        with patch.object(self.bridge, "_queue_conversation_lifecycle_repair", side_effect=held):
            with patch.object(clarify, "get_clarify_timeout", return_value=0.01):
                self.assertFalse((await asyncio.to_thread(runner._ask_clarify_question, QUESTION, CHOICES, False))[1])
            await self.until_posted(3)
            self.assertIn((native.ISSUE, session), self.adapter._step_paused)
            release.set()
            await self.wait_for_step_condition(lambda: (native.ISSUE, session) not in self.adapter._step_paused)
        self.assertFalse(clarify.has_pending(key))
        self.assertTrue(clarify.has_pending(first_key))
        self.assertIn(native.ISSUE, self.adapter._typing_paused)
        self.assertIn((native.ISSUE, native.SESSION), self.adapter._step_paused)
        self.assertNotIn((native.ISSUE, session), self.adapter._step_paused)
        await self.start_typing_refresh()
        await asyncio.sleep(0.15)
        self.assertNotIn("action", [p["content"]["type"] for p in self.posted])
        pending = clarify.get_pending_for_session(first_key, include_choice_prompts=True)
        self.assertTrue(clarify.resolve_gateway_clarify(pending.clarify_id, "staging"))
        self.assertEqual(await self.answer_later(first_key, first, clarify.clear_session), ("staging", True))
        await self.wait_for_step_condition(lambda: any(p["content"]["type"] == "action" for p in self.posted))

    @requires_status_metadata
    async def test_clarify_retirement_precedes_the_first_resumed_typing_action(self):
        from tools import clarify_gateway as clarify
        key = self.session_key(await self.start_turn())
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = self.bridge.store.enqueue
        def enqueue(kind, payload, **kwargs):
            if payload.get("retired_clarify_of"):
                entered.set()
                if not release.wait(10):
                    raise TimeoutError("test did not release retirement enqueue")
            return original(kind, payload, **kwargs)
        with patch.object(self.bridge.store, "enqueue", side_effect=enqueue):
            with patch.object(clarify, "get_clarify_timeout", return_value=0.01):
                self.assertFalse((await asyncio.to_thread(self.request_clarify, key))[1])
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            await self.start_typing_refresh()
            await asyncio.sleep(0.15)
            self.assertIn(native.ISSUE, self.adapter._typing_paused)
            self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation"])
            release.set()
            await self.until_posted(3)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation", "thought", "action"])

    @requires_status_metadata
    async def test_real_clarify_resume_preserves_another_question(self):
        from tools import clarify_gateway as clarify
        key = self.session_key(await self.start_turn())
        self.addCleanup(clarify.clear_session, key)
        first = asyncio.create_task(asyncio.to_thread(self.request_clarify, key))
        await self.until_posted(1)
        second = asyncio.create_task(asyncio.to_thread(self.request_clarify, key))
        await self.until_posted(2)
        # Two simultaneous cards have ambiguous plain-text routing. Settle the exact
        # older request through Core, then answer the still-visible newest question.
        older = clarify.get_pending_for_session(key, include_choice_prompts=True)
        self.assertTrue(clarify.resolve_gateway_clarify(older.clarify_id, "staging"))
        self.assertEqual(await self.answer_later(key, first, clarify.clear_session), ("staging", True))
        self.assertIn(native.ISSUE, self.adapter._typing_paused)
        self.assertIn((native.ISSUE, native.SESSION), self.adapter._step_paused)
        await self.deliver("second-clarify-answer", "production")
        self.assertEqual(await self.answer_later(key, second, clarify.clear_session), ("production", True))
        await self.start_typing_refresh()
        await self.until_posted(3)
        self.assertEqual(self.posted[-1]["content"]["type"], "action")

    @requires_status_metadata
    async def test_real_callbacks_keep_status_phrases_with_independent_agent_sessions(self):
        from gateway.run_turn_runner import TurnRunner
        from gateway.platforms.helpers import typing_metadata_for_turn
        from agent.display import build_status_phrase
        first = await self.start_turn()
        first_meta = self.status_metadata()
        session, activity = "session-second", "activity-second"
        self.authority.sessions[session] = {**self.authority.sessions[native.SESSION], "id": session}
        delivery = self.delivery(activity, "Another task in the same issue")
        data = delivery.event()
        data["agentSession"]["id"] = session
        self.authority.activities[activity]["agentSession"]["id"] = session
        await self.route(Delivery(data))
        second = self.messages[-1]
        second_meta = typing_metadata_for_turn(self.adapter, native.ISSUE, activity, {"thread_id": session})
        runners = []
        for event in (first, second):
            runner = object.__new__(TurnRunner)
            runner._ctx = SimpleNamespace(_live_status_adapter=self.adapter, _live_status_mode="full",
                _run_still_current=lambda: True, source=event.source)
            runners.append(runner)
        await asyncio.gather(*(asyncio.to_thread(self.owned_status, None, event,
            lambda runner=runner, tool=tool: runner._progress_live_status(
                "tool.started", tool, {"command": "echo PRIVATE_CANARY", "path": "PRIVATE_CANARY"}))
            for runner, event, tool in zip(runners, (first, second), ("read_file", "terminal"))))
        with self.elapsed_time(1000):
            await self.adapter.send_typing(native.ISSUE, metadata=first_meta)
            await self.adapter.send_typing(native.ISSUE, metadata=second_meta)
        await asyncio.gather(*list(self.adapter._step_tasks.values()))
        self.assertEqual({p["agentSessionId"]: p["content"]["parameter"] for p in self.posted}, {
            native.SESSION: "on reading",
            session: "in the terminal"})
        self.owned_status(None, first, lambda: runners[0]._progress_live_status("tool.completed", "read_file", {}))
        self.assertEqual(self.adapter._step_phrases[(native.ISSUE, session, activity)], "in the terminal")
        with self.elapsed_time(2000):
            await self.adapter.send_typing(native.ISSUE, metadata=first_meta)
        await asyncio.gather(*list(self.adapter._step_tasks.values()))
        self.assertEqual(self.posted[-1]["content"]["parameter"], "on your request")

    @requires_status_metadata
    async def test_unowned_core_callback_cannot_borrow_environment_identity(self):
        import os
        from gateway.run_turn_runner import TurnRunner
        event = await self.start_turn()
        runner = object.__new__(TurnRunner)
        runner._ctx = SimpleNamespace(_live_status_adapter=self.adapter, _live_status_mode="full",
            _run_still_current=lambda: True, source=event.source)
        with patch.dict(os.environ, {"HERMES_SESSION_PLATFORM": "linear", "HERMES_SESSION_CHAT_ID": native.ISSUE,
                "HERMES_SESSION_THREAD_ID": native.SESSION, "HERMES_SESSION_MESSAGE_ID": native.ACTIVITY,
                "HERMES_SESSION_SCOPE_ID": event.source.scope_id}):
            runner._progress_live_status("tool.started", "terminal", {"command": "echo unproven"})
        await self.adapter.send_typing(native.ISSUE, metadata=self.status_metadata())
        await asyncio.gather(*list(self.adapter._step_tasks.values()))
        self.assertEqual(self.posted[-1]["content"]["parameter"], "on your request")

    @requires_status_metadata
    async def test_live_step_throttles_changed_phrases_and_keeps_chat_alive(self):
        from agent.display import build_status_phrase
        first, second = build_status_phrase("read_file", None), build_status_phrase("terminal", None)
        await self.start_turn()  # No native task exists: ordinary chat needs its own keepalive.
        await self.step(first)
        self.assertEqual(self.posted[-1]["content"], {
            "type": "action", "action": "Working", "parameter": "on reading"})
        self.assertIs(self.posted[-1]["ephemeral"], True)
        await self.step(second, at=1059)
        self.assertEqual(len(self.posted), 1)
        await self.step(second, at=1060)
        self.assertEqual(len(self.posted), 2)
        await self.step(second, at=1659)
        self.assertEqual(len(self.posted), 2)
        await self.step(second, at=1660)
        self.assertEqual(len(self.posted), 3)
        self.assertEqual(len({row["id"] for row in self.posted}), 3)

    @requires_status_metadata
    async def test_new_turn_gets_same_generic_step_without_waiting_ten_minutes(self):
        await self.start_turn()
        await self.step(at=1000)
        old_metadata = self.status_metadata()
        result = await self.adapter.send(native.ISSUE, "First turn complete.",
            reply_to=native.ACTIVITY, metadata={"thread_id": native.SESSION})
        self.assertTrue(result.success, result.error)
        await self.deliver("next-generic-step", "Do the next read-only check.")
        await self.step(at=1059)
        self.assertEqual(len(self.posted), 2)  # Keep the session-wide one-minute cap.
        await self.step(at=1060)
        self.assertEqual([p["content"]["type"] for p in self.posted],
                         ["action", "response", "action"])
        self.assertEqual(self.posted[-1]["content"]["parameter"], "on your request")
        await self.step(at=1659)
        self.assertEqual(len(self.posted), 3)  # Same turn still has the ten-minute keepalive.
        with self.elapsed_time(1660):
            await self.adapter.send_typing(native.ISSUE, metadata=old_metadata)
        self.assertEqual(len(self.posted), 3)  # An old producer cannot borrow the new turn.
        await self.step(at=1660)
        self.assertEqual(len(self.posted), 4)

    @requires_status_metadata
    async def test_live_step_hook_does_not_wait_for_network_and_only_one_is_in_flight(self):
        await self.start_turn()
        entered, release = asyncio.Event(), asyncio.Event()
        original = self.adapter._post_reply
        async def delayed(*args, **kwargs):
            entered.set()
            await release.wait()
            return await original(*args, **kwargs)
        with patch.object(self.adapter, "_post_reply", side_effect=delayed):
            await asyncio.wait_for(self.adapter.send_typing(native.ISSUE,
                metadata=self.status_metadata()), 0.1)
            await entered.wait()
            await self.adapter.send_typing(native.ISSUE, metadata=self.status_metadata())
            self.assertEqual(len(self.adapter._step_tasks), 1)
            release.set()
            await asyncio.gather(*list(self.adapter._step_tasks.values()))
        self.assertEqual(len(self.posted), 1)

    @requires_status_metadata
    async def test_live_step_stops_at_final_and_reopens_only_for_new_input(self):
        await self.start_turn()
        await self.step()
        final = await self.adapter.send(native.ISSUE, "Finished.", reply_to=native.ACTIVITY,
                                        metadata={"thread_id": native.SESSION})
        self.assertTrue(final.success, final.error)
        await self.step("Late step", at=2000)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["action", "response"])
        await self.deliver("new-step-input", "Check again.")
        await self.step("Checking again.", at=2000)
        self.assertEqual(self.posted[-1]["content"]["type"], "action")

    async def test_queued_live_step_cannot_follow_native_final_or_expire_into_a_later_turn(self):
        from hermes_fleet_linear_plugin.native_input import queue_reply
        await self.start_turn()
        with self.elapsed_time(1000):
            pending = queue_reply(self.bridge, native.ISSUE, native.SESSION, native.ACTIVITY,
                                  "Checking.", kind="action", one_try=True)
        self.assertTrue(pending)
        result = await self.adapter.send(native.ISSUE, "Finished.", reply_to=native.ACTIVITY,
                                         metadata={"thread_id": native.SESSION})
        self.assertTrue(result.success)
        await asyncio.to_thread(self.bridge.flush, only_id=pending)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["response"])
        await self.deliver("fresh-step-input", "Check the next issue.")
        cursor = self.store.conversation_cursor(native.ISSUE, native.SESSION)
        with self.elapsed_time(1060):
            expired = queue_reply(self.bridge, native.ISSUE, native.SESSION, "fresh-step-input",
                                  "Old phrase", kind="action", one_try=True, source_cursor=cursor)
        self.assertTrue(expired)
        row = self.store.outbox_row(expired)
        self.store.rewrite(expired, {**row["payload"], "expires_at": self.bridge.clock() - 1}, self.bridge.clock())
        await asyncio.to_thread(self.bridge.flush, only_id=expired)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["response"])

    async def test_held_live_step_cannot_replace_a_newer_question(self):
        from hermes_fleet_linear_plugin.native_input import queue_reply
        await self.start_turn()
        pending = queue_reply(self.bridge, native.ISSUE, native.SESSION, native.ACTIVITY,
                              "Checking.", kind="action", one_try=True)
        from tools import clarify_gateway as clarify
        key = self.session_key(self.messages[0])
        self.addCleanup(clarify.clear_session, key)
        waiter = asyncio.create_task(asyncio.to_thread(self.request_clarify, key))
        await self.until_posted(1)
        await asyncio.to_thread(self.bridge.flush, only_id=pending)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation"])
        await self.deliver("question-answer", "staging")
        await self.answer_later(key, waiter, clarify.clear_session)

    @requires_status_metadata
    async def test_question_invalidates_scheduled_live_step(self):
        await self.start_turn()
        key = (native.ISSUE, native.SESSION)
        lock = self.adapter._reply_locks.setdefault(key, asyncio.Lock())
        await lock.acquire()
        await self.adapter.send_typing(native.ISSUE, metadata=self.status_metadata())
        task = self.adapter._step_tasks[key]
        self.adapter._pause_steps(*key)
        lock.release()
        await task
        await self.step("Must remain waiting.", at=2000)
        self.assertEqual(self.posted, [])

    async def test_interim_send_posts_a_thought_into_the_turns_session(self):
        from gateway.run import _interim_metadata
        await self.start_turn()
        result = await self.adapter.send(native.ISSUE, "Still checking the migration plan.",
                                         metadata=_interim_metadata({"thread_id": native.SESSION}))
        self.assertTrue(result.success, result.error)
        self.assertEqual(self.posted[-1]["agentSessionId"], native.SESSION)
        self.assertEqual(self.posted[-1]["content"], {"type": "thought", "body": "Still checking the migration plan."})
        self.assertNotIn("signal", self.posted[-1])

    async def test_clarify_with_choices_is_a_select_elicitation_and_the_reply_answers_it(self):
        from tools import clarify_gateway as clarify
        turn = await self.start_turn()
        key = self.session_key(turn)
        waiter = asyncio.create_task(asyncio.to_thread(self.ask, key, "clarify-env", CHOICES))
        await self.until_posted(1)
        question = self.posted[-1]
        self.assertEqual(question["agentSessionId"], native.SESSION)
        self.assertEqual(question["content"]["type"], "elicitation")
        self.assertIn(QUESTION, question["content"]["body"])
        self.assertEqual(question["signal"], "select")
        self.assertEqual([option["label"] for option in question["signalMetadata"]["options"]], CHOICES)
        self.assertTrue(all(option["value"].startswith(self.native_input.CHOICE_VALUE_PREFIX)
                            for option in question["signalMetadata"]["options"]))
        answer = await self.deliver("answer-activity", "production")
        response, answered = await self.answer_later(key, waiter, clarify.clear_session)
        self.assertEqual((response, answered), ("production", True))
        self.assertEqual(answer.acknowledged, 1)
        self.assertEqual(len(self.messages), 1)  # the answer went to the clarify, not a new turn

    async def test_open_clarify_takes_free_text_and_a_stranger_cannot_answer(self):
        from tools import clarify_gateway as clarify
        turn = await self.start_turn()
        key = self.session_key(turn)
        waiter = asyncio.create_task(asyncio.to_thread(self.ask, key, "clarify-open", None))
        await self.until_posted(1)
        self.assertEqual(self.posted[-1]["content"]["type"], "elicitation")
        self.assertNotIn("signal", self.posted[-1])
        await self.deliver("stranger-activity", "use production", user="someone-else")
        self.assertIsNotNone(clarify.get_pending("clarify-open"))
        await self.deliver("answer-activity", "Use staging first, please.")
        response, answered = await self.answer_later(key, waiter, clarify.clear_session)
        self.assertEqual((response, answered), ("Use staging first, please.", True))

    async def test_clarify_without_a_verified_session_is_a_definitive_failure(self):
        from gateway.run_turn_runner_clarify_delivery import UNDELIVERED
        response, answered = await asyncio.to_thread(self.ask, "agent:main:linear:dm:none", "clarify-none", CHOICES)
        self.assertEqual((response, answered), (UNDELIVERED, False))
        self.assertEqual(self.posted, [])

    async def test_text_approval_is_an_elicitation_and_approve_resolves_it(self):
        await self.check_approval("approve", "once")

    async def test_text_approval_deny_resolves_it(self):
        await self.check_approval("/deny not on the shared host", "deny")

    async def test_approval_confirmation_survives_a_previous_turns_final_response(self):
        await self.check_approval("approve", "once", reopened=True)

    async def check_approval(self, reply, choice, *, reopened=False):
        from tools import approval
        turn = await self.start_turn()
        if reopened:
            result = await self.adapter.send(native.ISSUE, "First check finished.", reply_to=native.ACTIVITY,
                                             metadata={"thread_id": native.SESSION})
            self.assertTrue(result.success, result.error)
            await self.deliver("next-activity", "Now run the migration.")
            turn = self.messages[-1]
        key = self.session_key(turn)
        expected = len(self.posted) + 1
        waiter = asyncio.create_task(asyncio.to_thread(self.request_approval, key))
        await self.until_posted(expected)
        prompt = self.posted[-1]
        self.assertEqual(prompt["agentSessionId"], native.SESSION)
        self.assertEqual(prompt["content"]["type"], "elicitation")
        self.assertIn("rm -rf build/", prompt["content"]["body"])
        answer = await self.deliver("answer-activity", reply)
        result = await self.answer_later(key, waiter, approval.unregister_gateway_notify)
        self.assertTrue(result["resolved"], result)
        self.assertEqual(result["choice"], choice)
        if choice == "deny":
            self.assertEqual(result["reason"], "not on the shared host")
        self.assertEqual(answer.acknowledged, 1)
        self.assertEqual(len(self.messages), 2 if reopened else 1)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")  # the confirmation

    def approval_value(self, entry, label="approve"):
        question = next(row for row in self.store.conversation_questions(native.ISSUE, native.SESSION)
                        if row["native_prompt"].get("request_id") == entry.data["request_id"])
        return next(option["value"] for option in question["signal_metadata"]["options"] if option["label"] == label)

    async def pending_approvals(self, *, display_sibling=True):
        """Real core FIFO entries, with no blocking command threads to leak on failure."""
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        turn = await self.start_turn()
        key = self.session_key(turn)
        entries = [_ApprovalEntry({"command": command}) for command in ("first", "second")]
        with approval._lock:
            approval._gateway_queues[key] = entries.copy()
        self.addCleanup(approval.unregister_gateway_notify, key)
        result = await self.display_approval(entries[0])
        self.assertTrue(result.success, result.error)
        if display_sibling:
            result = await self.display_approval(entries[1])
            self.assertTrue(result.success, result.error)
        return entries

    async def test_concurrent_deliveries_of_one_approval_activity_resolve_only_one_entry(self):
        first, second = await self.pending_approvals()
        first_value = self.approval_value(first)
        publishing, release = asyncio.Event(), asyncio.Event()
        original = self.adapter._post
        async def delayed(*args, **kwargs):
            publishing.set()
            await release.wait()
            return await original(*args, **kwargs)
        answer = self.delivery("answer-activity", first_value, delivery_id="first-delivery")
        duplicate = self.delivery("answer-activity", first_value, delivery_id="duplicate-delivery")
        with patch.object(self.adapter, "_post", side_effect=delayed):
            task = asyncio.create_task(self.route(answer))
            await asyncio.wait_for(publishing.wait(), 10)
            replay = asyncio.create_task(self.route(duplicate))
            try:
                async with asyncio.timeout(10):
                    while not replay.done() and second.result is None:
                        await asyncio.sleep(0.01)
                self.assertEqual([first.result, second.result], ["once", None])
                self.assertTrue(first.event.is_set())
                self.assertFalse(second.event.is_set())
            finally:
                release.set()
                await asyncio.gather(task, replay)
        self.assertEqual([answer.acknowledged, duplicate.acknowledged], [1, 1])
        self.assertEqual(len(self.messages), 1)
        self.assertEqual([p["content"]["type"] for p in self.posted],
                         ["elicitation", "elicitation", "thought", "elicitation"])
        restored = self.store.outbox_row(self.posted[-1]["id"])["payload"]
        self.assertEqual(restored["native_prompt"]["request_id"], second.data["request_id"])
        self.assertEqual(self.posted[-1]["content"], self.posted[1]["content"])
        self.assertEqual(self.posted[-1]["signalMetadata"], self.posted[1]["signalMetadata"])
        await self.deliver("new-answer-activity", "approve")
        self.assertEqual(second.result, "once")

    async def test_confirmation_failure_cannot_replay_an_approval_on_inbox_retry(self):
        first, second = await self.pending_approvals()
        first_value = self.approval_value(first)
        answer = self.delivery("answer-activity", first_value, delivery_id="failed-delivery")
        with patch.object(self.bridge, "flush", side_effect=RuntimeError("publication interrupted")):
            with self.assertRaisesRegex(RuntimeError, "publication interrupted"):
                await self.route(answer)
        self.assertEqual([first.result, second.result], ["once", None])
        self.assertEqual(answer.acknowledged, 0)
        retry = await self.deliver("answer-activity", first_value, delivery_id="retry-delivery")
        self.assertEqual(retry.acknowledged, 1)
        self.assertEqual([first.result, second.result], ["once", None])
        self.assertFalse(second.event.is_set())
        # The already-queued confirmation can still publish independently of inbox retry.
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual([p["content"]["type"] for p in self.posted],
                         ["elicitation", "elicitation", "thought", "elicitation"])
        restored = self.store.outbox_row(self.posted[-1]["id"])["payload"]
        self.assertEqual(restored["native_prompt"]["request_id"], second.data["request_id"])
        self.assertEqual(self.posted[-1]["content"], self.posted[1]["content"])
        self.assertEqual(self.posted[-1]["signalMetadata"], self.posted[1]["signalMetadata"])
        self.assertEqual(len(self.messages), 1)
        await self.deliver("new-answer-activity", "approve")
        self.assertEqual(second.result, "once")

    async def test_clarify_activity_replay_cannot_answer_the_next_question(self):
        from tools import clarify_gateway as clarify
        key = self.session_key(await self.start_turn())
        self.addCleanup(clarify.clear_session, key)
        for identity in ("first-question", "second-question"):
            clarify.register(clarify_id=identity, session_key=key, question=QUESTION, choices=CHOICES)
            result = await self.adapter.send_clarify(native.ISSUE, QUESTION, choices=CHOICES,
                clarify_id=identity, session_key=key, metadata={"thread_id": native.SESSION})
            self.assertTrue(result.success, result.error)
            if identity == "first-question":
                await self.deliver("answer-activity", "staging")
                self.assertEqual(clarify.wait_for_response(identity, timeout=0), "staging")
        duplicate = await self.deliver("answer-activity", "staging", delivery_id="duplicate-delivery")
        self.assertEqual(duplicate.acknowledged, 1)
        self.assertIsNotNone(clarify.get_pending("second-question"))
        await self.deliver("new-answer-activity", "production")
        self.assertEqual(clarify.wait_for_response("second-question", timeout=0), "production")
        self.assertEqual(len(self.messages), 1)

    async def replacement_adapter(self):
        """A separate adapter and Store connection, sharing only persisted provider state."""
        from copy import copy
        from gateway.config import PlatformConfig
        from hermes_fleet_linear_plugin.store import Store
        bridge = copy(self.bridge)
        bridge.store = Store(self.store.path)
        replacement = self.native_input.create_adapter(PlatformConfig(enabled=True), {"bridge": bridge})
        self.assertTrue(await replacement.connect())
        self.addAsyncCleanup(replacement.disconnect)
        replacement.set_message_handler(lambda event: None)
        replacement.set_authorization_check(lambda user_id, *_args, **_kwargs: user_id == native.USER)
        return replacement

    async def test_consumed_approval_activity_survives_adapter_replacement(self):
        first, second = await self.pending_approvals()
        first_value = self.approval_value(first)
        await self.deliver("answer-activity", first_value)
        self.assertEqual([first.result, second.result], ["once", None])
        self.adapter = await self.replacement_adapter()
        replay = await self.deliver("answer-activity", first_value, delivery_id="after-reconnect")
        self.assertEqual(replay.acknowledged, 1)
        self.assertEqual([first.result, second.result], ["once", None])
        await self.deliver("new-answer-activity", "approve")
        self.assertEqual(second.result, "once")

    async def test_two_adapters_cannot_consume_the_same_approval_activity(self):
        first, second = await self.pending_approvals()
        first_value = self.approval_value(first)
        other = await self.replacement_adapter()
        publishing, release = asyncio.Event(), asyncio.Event()
        original = self.adapter._post
        async def delayed(*args, **kwargs):
            publishing.set()
            await release.wait()
            return await original(*args, **kwargs)
        with patch.object(self.adapter, "_post", side_effect=delayed):
            task = asyncio.create_task(self.deliver("answer-activity", first_value))
            await asyncio.wait_for(publishing.wait(), 10)
            duplicate = self.delivery("answer-activity", first_value, delivery_id="other-adapter")
            try:
                self.assertTrue(other.route(duplicate))
                future = other._submitted.get(other._delivery_key(duplicate))
                if future is not None:
                    await asyncio.wait_for(asyncio.wrap_future(future), 10)
                self.assertEqual([first.result, second.result], ["once", None])
                self.assertEqual(duplicate.acknowledged, 1)
            finally:
                release.set()
                await task

    async def test_final_reply_is_unchanged_and_nothing_posts_after_it(self):
        from gateway.run import _interim_metadata
        from hermes_fleet_linear_plugin.bridge import stable_uuid4
        import hashlib
        await self.start_turn()
        body = "The migration ran on staging; production is next."
        result = await self.adapter.send(native.ISSUE, body, reply_to=native.ACTIVITY,
                                         metadata={"thread_id": native.SESSION})
        self.assertTrue(result.success, result.error)
        self.assertEqual(self.posted[-1]["content"], {"type": "response", "body": body})
        digest = hashlib.sha256(body.encode()).hexdigest()
        self.assertEqual(result.message_id, stable_uuid4("native-reply", self.bridge.profile, native.ISSUE,
                                                         native.SESSION, native.ACTIVITY, digest))
        late = await self.adapter.send(native.ISSUE, "Still working.",
                                       metadata=_interim_metadata({"thread_id": native.SESSION}))
        self.assertFalse(late.success)
        self.assertFalse(late.retryable)
        self.assertEqual(len(self.posted), 1)
        # A new prompt reopens the session: its interim notes post again.
        await self.deliver("next-activity", "Now production, please.")
        again = await self.adapter.send(native.ISSUE, "Starting production.",
                                        metadata=_interim_metadata({"thread_id": native.SESSION}))
        self.assertTrue(again.success, again.error)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")

    async def test_send_without_reply_to_and_no_verified_session_is_still_refused(self):
        result = await self.adapter.send(native.ISSUE, "Orphan note.", metadata={"thread_id": native.SESSION})
        self.assertFalse(result.success)
        self.assertEqual(self.posted, [])

    async def test_queued_interim_is_not_delivered_after_the_final_reply(self):
        from hermes_fleet_linear_plugin.native_input import queue_reply
        await self.start_turn()
        pending = queue_reply(self.bridge, native.ISSUE, native.SESSION, native.ACTIVITY,
                              "Late progress", kind="thought")
        result = await self.adapter.send(native.ISSUE, "Finished.", reply_to=native.ACTIVITY,
                                         metadata={"thread_id": native.SESSION})
        self.assertTrue(result.success, result.error)
        self.bridge.flush(only_id=pending)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["response"])
        self.assertEqual(self.bridge.store.outbox_row(pending)["state"], "failed")

    async def test_native_done_also_closes_the_turns_progress_lane(self):
        await self.start_turn()
        self.bridge._decline(native.ISSUE, native.SESSION, "Done.", activity_id="native-done")
        self.bridge.flush()
        result = await self.adapter.send(native.ISSUE, "Late note.",
            metadata={"thread_id": native.SESSION, "_interim_send": True})
        self.assertFalse(result.success)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["response"])
        await self.deliver("next-activity", "Start the next check.")
        result = await self.adapter.send(native.ISSUE, "Checking.",
            metadata={"thread_id": native.SESSION, "_interim_send": True})
        self.assertTrue(result.success, result.error)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")


    async def test_displayed_request_does_not_authorize_an_undisplayed_sibling_after_replacement(self):
        from tools import approval
        first, second = await self.pending_approvals(display_sibling=False)
        key = self.session_key(self.messages[0])
        self.assertEqual(approval.resolve_gateway_approval(key, "deny", request_id=first.data["request_id"]), 1)
        self.adapter = await self.replacement_adapter()
        # Ordinary fallback in this fixture must remain visible without a fake admission receipt.
        ordinary = []
        async def receive(event):
            ordinary.append(event)
        self.adapter.handle_message = receive
        await self.deliver("sibling-answer", "approve")
        self.assertIsNone(second.result)
        self.assertEqual([event.message_id for event in ordinary], ["sibling-answer"])

    async def test_exact_card_preserves_offered_approval_capabilities(self):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        key = self.session_key(await self.start_turn())
        entry = _ApprovalEntry({"command": "bounded-command"})
        with approval._lock:
            approval._gateway_queues[key] = [entry]
        self.addCleanup(approval.unregister_gateway_notify, key)
        result = await self.display_approval(entry, allow_session=False, allow_permanent=False)
        self.assertTrue(result.success, result.error)
        await self.deliver("overbroad-answer", "/approve always")
        self.assertIsNone(entry.result)
        await self.deliver("exact-answer", "approve")
        self.assertEqual(entry.result, "once")

    async def test_core_renderer_declines_missing_identity_without_text_fallback(self):
        from gateway.run_turn_runner import _ExecApprovalDeclined
        key = self.session_key(await self.start_turn())
        with patch.object(self.adapter, "send", wraps=self.adapter.send) as fallback:
            with self.assertRaises(_ExecApprovalDeclined):
                await asyncio.to_thread(self.render_approval, key, {"command": "unbound-command"})
        fallback.assert_not_called()
        self.assertEqual(self.posted, [])

    async def test_core_renderer_preserves_ambiguous_exact_card_without_text_fallback(self):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        key = self.session_key(await self.start_turn())
        entry = _ApprovalEntry({"command": "bounded-command"})
        with approval._lock:
            approval._gateway_queues[key] = [entry]
        self.addCleanup(approval.unregister_gateway_notify, key)
        with patch.object(self.bridge, "flush", return_value=0), \
                patch.object(self.adapter, "send", wraps=self.adapter.send) as fallback:
            await asyncio.to_thread(self.render_approval, key, entry.data)
        fallback.assert_not_called()
        await self.deliver("undelivered-answer", "approve")
        self.assertIsNone(entry.result)  # queued but unattempted is not a displayed card

    async def test_core_renderer_failed_card_cannot_fall_back_to_broad_consent(self):
        from gateway.platforms.base import SendResult
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        key = self.session_key(await self.start_turn())
        entry = _ApprovalEntry({"command": "bounded-command"})
        with approval._lock:
            approval._gateway_queues[key] = [entry]
        self.addCleanup(approval.unregister_gateway_notify, key)
        with patch.object(self.adapter, "_send_exec_approval_prompt", return_value=SendResult(False, error="failed")), \
                patch.object(self.adapter, "send", wraps=self.adapter.send) as fallback:
            await asyncio.to_thread(self.render_approval, key, entry.data)
        fallback.assert_called_once()
        self.assertEqual(self.posted, [])
        await self.deliver("unbound-answer", "approve")
        self.assertIsNone(entry.result)

    async def old_first_delivery(self, kind):
        from tools import approval, clarify_gateway as clarify
        from tools.approval_gateway_wait import _ApprovalEntry
        key = self.session_key(await self.start_turn())
        old = self.delivery("old-unseen-answer", "approve" if kind == "approval" else "staging")
        self.assertEqual(len(self.messages), 1)
        if kind == "approval":
            entry = _ApprovalEntry({"command": "new-command"})
            with approval._lock:
                approval._gateway_queues[key] = [entry]
            self.addCleanup(approval.unregister_gateway_notify, key)
            result = await self.display_approval(entry)
        else:
            clarify.register(clarify_id="new-question", session_key=key, question=QUESTION, choices=CHOICES)
            self.addCleanup(clarify.clear_session, key)
            result = await self.adapter.send_clarify(native.ISSUE, QUESTION, CHOICES, "new-question", key,
                metadata={"thread_id": native.SESSION})
        self.assertTrue(result.success, result.error)
        handle = self.adapter.handle_message
        self.adapter = await self.replacement_adapter()
        self.adapter.handle_message = handle
        await self.route(old)
        self.assertEqual(old.acknowledged, 1)
        self.assertEqual(len(self.messages), 2)  # first delivery remains ordinary input
        if kind == "approval":
            self.assertIsNone(entry.result)
        else:
            self.assertIsNotNone(clarify.get_pending("new-question"))
        await self.deliver("fresh-answer", "approve" if kind == "approval" else "production")
        if kind == "approval":
            self.assertEqual(entry.result, "once")
        else:
            self.assertEqual(clarify.wait_for_response("new-question", timeout=0.1), "production")

    async def test_first_delivery_created_before_approval_is_not_consent(self):
        await self.old_first_delivery("approval")

    async def test_first_delivery_created_before_clarify_is_not_an_answer(self):
        await self.old_first_delivery("clarify")

    async def test_missing_authoritative_question_time_cannot_grant_consent(self):
        from hermes_fleet_linear_plugin.api import LinearError
        first, second = await self.pending_approvals(display_sibling=False)
        question = self.authority.activities[self.posted[-1]["id"]]
        stamp = question.pop("createdAt")
        answer = self.delivery("answer-activity", "approve")
        with self.assertRaises(LinearError):
            await self.route(answer)
        self.assertIsNone(first.result)
        self.assertIsNone(second.result)
        self.assertEqual(answer.acknowledged, 0)
        question["createdAt"] = stamp
        await self.deliver("answer-activity", "approve", delivery_id="chronology-restored")
        self.assertEqual(first.result, "once")

    async def test_approval_keeps_the_operation_context_that_core_rendered(self):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        key = self.session_key(await self.start_turn())
        description = "Cancel task t_12345678 only after its logs are saved."
        entry = _ApprovalEntry({"command": "rm -rf build/", "description": description})
        with approval._lock:
            approval._gateway_queues[key] = [entry]
        self.addCleanup(approval.unregister_gateway_notify, key)
        await asyncio.to_thread(self.render_approval, key, entry.data)
        displayed = self.posted[-1]["content"]["body"]
        await self.deliver("answer-activity", "approve")
        self.assertEqual(entry.result, "once")
        self.assertIn(description, displayed)
        self.assertIn(entry.data["command"], displayed)

    async def altered_question_cannot_answer(self, *, legacy=False):
        from tools import clarify_gateway as clarify
        from hermes_fleet_linear_plugin.bridge import INTERNAL_ONLY_REPLY
        key = self.session_key(await self.start_turn())
        question = "Do you want me to cancel task t_12345678?"
        pending = clarify.register("stored-question", key, question, ["Yes", "No"])
        self.addCleanup(clarify.clear_session, key)
        sent = await self.adapter.send_clarify(native.ISSUE, question, pending.choices, pending.clarify_id, key,
            metadata={"thread_id": native.SESSION})
        self.assertTrue(sent.success, sent.error)
        payload = self.store.outbox_row(sent.message_id)["payload"]
        if legacy:
            # Exact prior-version shape: a substituted notice retains the Core
            # identity and select options, but has no faithful-display evidence.
            payload["native_prompt"].pop("display", None)
            payload["content"]["body"] = INTERNAL_ONLY_REPLY
            self.authority.activities[sent.message_id]["content"]["body"] = INTERNAL_ONLY_REPLY
        else:
            payload["signal_metadata"] = {"options": [{"value": "No"}, {"value": "Yes"}]}
        with self.store._tx() as db:
            db.execute("UPDATE outbox SET payload=? WHERE id=?", (json.dumps(payload), sent.message_id))
        retry = await self.adapter.send_clarify(native.ISSUE, question, pending.choices, pending.clarify_id, key,
            metadata={"thread_id": native.SESSION})
        handle = self.adapter.handle_message
        self.adapter = await self.replacement_adapter()
        self.adapter.handle_message = handle
        await self.deliver("answer-activity", "Yes")
        self.assertIsNone(pending.response, "altered decision content retained consent routing")
        self.assertEqual(len(self.messages), 2)
        self.assertFalse(retry.success, "stored substituted content was reported as a faithful delivery")

    async def test_legacy_substituted_notice_cannot_answer_after_replacement(self):
        await self.altered_question_cannot_answer(legacy=True)

    async def test_changed_visible_options_cannot_answer_after_replacement(self):
        await self.altered_question_cannot_answer()

    async def test_empty_clarification_question_is_refused_without_consent_routing(self):
        from tools import clarify_gateway as clarify
        key = self.session_key(await self.start_turn())
        pending = clarify.register("empty-question", key, " ", ["Yes", "No"])
        self.addCleanup(clarify.clear_session, key)
        sent = await self.adapter.send_clarify(native.ISSUE, " ", pending.choices, pending.clarify_id, key,
            metadata={"thread_id": native.SESSION})
        self.assertFalse(sent.success)
        self.assertEqual(self.posted, [])
        await self.deliver("answer-activity", "Yes")
        self.assertIsNone(pending.response)
        self.assertEqual(len(self.messages), 2)


    async def test_legacy_approval_option_cannot_impersonate_new_request_text_consent(self):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        key = self.session_key(await self.start_turn())
        first, second = [_ApprovalEntry({"command": command}) for command in ("old-command", "new-command")]
        with approval._lock:
            approval._gateway_queues[key] = [first, second]
        self.addCleanup(approval.unregister_gateway_notify, key)
        with patch.object(self.bridge, "flush", return_value=0):
            queued = await self.display_approval(first)
        payload = self.store.outbox_row(queued.message_id)["payload"]
        # Exact pre-upgrade select protocol: the emitted value contains no request identity.
        payload["signal_metadata"] = {"options": [{"value": word} for word in ("approve", "approve session", "approve always", "deny")]}
        payload["native_prompt"].pop("request_identity", None)
        payload["native_prompt"].pop("selection_answers", None)
        payload["native_prompt"]["display"]["signal_metadata"] = payload["signal_metadata"]
        self.store.rewrite(queued.message_id, payload, self.bridge.clock())
        await asyncio.to_thread(self.bridge.flush, only_id=queued.message_id)
        self.assertEqual(self.store.outbox_row(queued.message_id)["state"], "sent")
        await self.deliver("old-request-answer", "approve")
        self.assertEqual(first.result, "once")
        self.assertEqual(self.store.outbox_row(queued.message_id)["payload"]["answered_by"], "old-request-answer")
        self.assertTrue((await self.display_approval(second)).success)
        selected = self.approval_value(second)
        await self.deliver("old-card-click", "approve")
        self.assertIsNone(second.result, "An old unbound card selected the new command")
        await self.deliver("new-card-click", selected)
        self.assertEqual(second.result, "once")

    async def answer_marks_every_presentation(self, *, legacy=False):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        from hermes_fleet_linear_plugin.bridge import stable_uuid4
        key = self.session_key(await self.start_turn())
        entry = _ApprovalEntry({"command": "bounded-command"})
        with approval._lock:
            approval._gateway_queues[key] = [entry]
        self.addCleanup(approval.unregister_gateway_notify, key)
        with patch.object(self.bridge, "flush", return_value=0):
            first = await self.display_approval(entry)
        payload = self.store.outbox_row(first.message_id)["payload"]
        if legacy:
            options = payload["signal_metadata"]["options"]
            payload["signal_metadata"] = {"options": [{"value": option["label"]} for option in options]}
            payload["native_prompt"].pop("request_identity", None)
            payload["native_prompt"].pop("selection_answers", None)
            payload["native_prompt"]["display"]["signal_metadata"] = payload["signal_metadata"]
            self.store.rewrite(first.message_id, payload, self.bridge.clock())
        await asyncio.to_thread(self.bridge.flush, only_id=first.message_id)
        second_id = stable_uuid4("fixture-question-redisplay", first.message_id)
        repeated = {**payload, "id": second_id, "write_started": False}
        repeated.pop("applied", None)
        repeated.pop("conversation_attempt_id", None)
        self.assertEqual(self.store.enqueue("activity", repeated, at=self.bridge.clock()), second_id)
        await asyncio.to_thread(self.bridge.flush, only_id=second_id)
        self.assertEqual(self.store.outbox_row(second_id)["state"], "sent")
        value = payload["signal_metadata"]["options"][0]["value"]
        await self.deliver("same-request-answer", value)
        self.assertEqual(entry.result, "once")
        for identity in (first.message_id, second_id):
            self.assertEqual(self.store.outbox_row(identity)["payload"]["answered_by"], "same-request-answer")
        # A later unrelated question still has the normal single-question text path.
        next_entry = _ApprovalEntry({"command": "next-command"})
        with approval._lock:
            approval._gateway_queues[key] = [next_entry]
        self.assertTrue((await self.display_approval(next_entry)).success)
        await self.deliver("next-request-answer", self.approval_value(next_entry) if legacy else "approve")
        self.assertEqual(next_entry.result, "once")

    async def test_one_answer_marks_every_presentation_of_its_exact_request(self):
        await self.answer_marks_every_presentation()

    async def test_one_answer_marks_legacy_redisplays_by_exact_core_identity(self):
        await self.answer_marks_every_presentation(legacy=True)

    async def test_tampered_native_answer_mapping_cannot_change_a_displayed_capability(self):
        first, _ = await self.pending_approvals(display_sibling=False)
        question = next(row for row in self.store.conversation_questions(native.ISSUE, native.SESSION)
                        if row["native_prompt"].get("request_id") == first.data["request_id"])
        selected = question["signal_metadata"]["options"][0]["value"]
        question["native_prompt"]["selection_answers"][selected] = "approve always"
        with self.store._tx() as db:
            db.execute("UPDATE outbox SET payload=? WHERE id=?", (json.dumps(question), question["id"]))
        await self.deliver("altered-native-value", selected)
        self.assertIsNone(first.result)

    async def test_late_consumed_redisplay_cannot_impersonate_text_consent_to_a_new_request(self):
        from tools import approval
        from tools.approval_gateway_wait import _ApprovalEntry
        from hermes_fleet_linear_plugin.bridge import stable_uuid4
        key = self.session_key(await self.start_turn())
        first, second = [_ApprovalEntry({"command": command}) for command in ("old-command", "new-command")]
        with approval._lock:
            approval._gateway_queues[key] = [first, second]
        self.addCleanup(approval.unregister_gateway_notify, key)
        original = await self.display_approval(first)
        payload = self.store.outbox_row(original.message_id)["payload"]
        repeated_id = stable_uuid4("fixture-late-answered-question", original.message_id)
        repeated = {**payload, "id": repeated_id, "write_started": False}
        repeated.pop("applied", None)
        repeated.pop("conversation_attempt_id", None)
        self.store.enqueue("activity", repeated, at=self.bridge.clock())
        transport, delayed = self.bridge.api.transport, []
        def hold_redisplay(url, body, headers):
            request = json.loads(body)
            if "agentActivityCreate" in request["query"] and request["variables"]["input"]["id"] == repeated_id:
                delayed.append((url, body, headers))
                raise TimeoutError("fixture redisplay remains remotely in flight")
            return transport(url, body, headers)
        self.bridge.api.transport = hold_redisplay
        await asyncio.to_thread(self.bridge.flush, only_id=repeated_id)
        self.assertTrue(self.store.outbox_row(repeated_id)["payload"]["write_started"])
        await self.deliver("old-request-answer", self.approval_value(first))
        self.assertEqual(first.result, "once")
        self.assertEqual(self.store.outbox_row(repeated_id)["payload"]["answered_by"], "old-request-answer")
        self.assertTrue((await self.display_approval(second)).success)
        selected = self.approval_value(second)
        transport(*delayed[0])  # A appears after both its own answer and B's display.
        await self.deliver("ambiguous-after-redisplay", "approve")
        self.assertIsNone(second.result, "An already-consumed but late-visible card was wrongly skipped")
        await self.deliver("exact-new-card-selection", selected)
        self.assertEqual(second.result, "once")

if __name__ == "__main__":
    unittest.main()
