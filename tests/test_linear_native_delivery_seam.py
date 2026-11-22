"""Guarded Core commit/publication boundaries and accepted late Activity repair."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from types import MethodType, SimpleNamespace
import unittest
from unittest.mock import patch

import test_linear_native_input_seam as seam
from linear_core_capabilities import requires_status_metadata


@unittest.skipUnless(seam.SOURCE and seam.GUARDED_ROOT, "requires scripts/run-linear-input-scenarios.py")
class FinalDeliveryAdmissionScenarios(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = seam.NativeInputSeamScenarios.asyncSetUp
    asyncTearDown = seam.NativeInputSeamScenarios.asyncTearDown
    no_model = seam.NativeInputSeamScenarios.no_model
    until = seam.NativeInputSeamScenarios.until
    event = seam.NativeInputSeamScenarios.event
    deliver = seam.NativeInputSeamScenarios.deliver
    inbox_row = seam.NativeInputSeamScenarios.inbox_row
    rows = seam.NativeInputSeamScenarios.rows
    final_reply_sent = seam.NativeInputSeamScenarios.final_reply_sent
    show_approval = seam.NativeInputSeamScenarios.show_approval

    async def test_successful_old_action_during_new_core_commit(self):
        from gateway.session_authority import SessionAuthority
        started, release = asyncio.Event(), asyncio.Event()
        at_commit, allow_commit, committed = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        self.addCleanup(allow_commit.set)
        async def model(event):
            started.set()
            await release.wait()
            return None
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        await self.deliver('first', 'Investigate the first question.')
        await asyncio.wait_for(started.wait(), 10)
        await self.until(lambda: self.inbox_row('first')[2] == 'imported')
        row = self.native_input.queue_reply(self.bridge, self.ISSUE, self.SESSION, 'first',
            'Working on your request.', kind='action', one_try=True)
        original_admit = self.authority._admit_native_write
        original_transport = self.bridge.api.transport
        remote_kinds = []
        def delayed_admit(**kwargs):
            if kwargs['request_id'] == 'second':
                at_commit.set()
                if not allow_commit.wait(15):
                    raise TimeoutError('test did not allow the second commit')
            result = original_admit(**kwargs)
            if kwargs['request_id'] == 'second':
                committed.set()
            return result
        def transport(url, body, headers):
            request = json.loads(body)
            if 'agentActivityCreate' in request['query']:
                fields = request['variables']['input']
                if fields['id'] == row:
                    allow_commit.set()
                    if not committed.wait(15):
                        raise TimeoutError('second Core commit did not finish during transport')
                remote_kinds.append(fields['content']['type'])
            return original_transport(url, body, headers)
        with patch.object(self.authority, '_admit_native_write', side_effect=delayed_admit), \
                patch.object(self.bridge.api, 'transport', side_effect=transport):
            await self.deliver('second', 'Stop investigating; summarize instead.')
            await self.until(at_commit.is_set)
            await asyncio.to_thread(self.bridge.flush, only_id=row)
            await self.until(lambda: self.inbox_row('second')[2] == 'imported')
        self.assertTrue(committed.is_set())
        self.assertEqual([x['status'] for x in self.rows()], ['started', 'queued'])
        self.assertEqual(self.bridge.store.outbox_row(row)['state'], 'sent')
        self.assertEqual(remote_kinds[-1], 'thought', 'A successful stale action must reconcile the current working state')

    async def test_legacy_core_typing_without_anchor_is_safe_with_a_live_admission(self):
        await self.start_live_for_delivery()
        self.assertEqual(self.adapter._inputs[(self.ISSUE, self.SESSION)], "live-input")
        stop = asyncio.Event()
        observed = []
        original = self.adapter.send_typing
        async def typing(*args, **kwargs):
            observed.append(kwargs.get("metadata"))
            return await original(*args, **kwargs)
        with patch.object(self.adapter, "send_typing", side_effect=typing):
            task = asyncio.create_task(self.adapter._keep_typing(self.ISSUE, interval=0.01,
                metadata={"thread_id": self.SESSION}, stop_event=stop))
            try:
                await self.until(lambda: len(observed) >= 2)
            finally:
                stop.set()
                await task
        self.assertTrue(all("_linear_status_source" not in metadata for metadata in observed))
        with self.bridge.store._tx() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM outbox WHERE kind='activity' "
                "AND json_extract(payload,'$.content.type')='action'").fetchone()[0], 0)

    @requires_status_metadata
    async def test_status_phrase_stays_with_its_executing_producer(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        from gateway.run_turn_runner import TurnRunner
        tools = {"first": "read_file", "second": "terminal"}
        started = {name: asyncio.Event() for name in ("first", "second")}
        release = {name: asyncio.Event() for name in started}
        for event in release.values():
            self.addCleanup(event.set)
        captured = {}
        original = type(self.adapter).status_metadata_for_turn
        def capture(adapter, chat, anchor, metadata):
            result = original(adapter, chat, anchor, metadata)
            captured[anchor] = result
            return result
        async def model(event):
            from gateway.platforms.helpers import typing_metadata_for_turn
            name = event.message_id
            # The finite model replaces run_turn_progress; use that path's real Core helper
            # with the executing event, including when the authority drains a queued turn.
            typing_metadata_for_turn(self.adapter, self.ISSUE, name, {"thread_id": self.SESSION})
            runner = object.__new__(TurnRunner)
            runner._ctx = SimpleNamespace(_live_status_adapter=self.adapter, _live_status_mode="full",
                _run_still_current=lambda: True, source=event.source)
            runner._progress_live_status("tool.started", tools[name],
                {"path": "PRIVATE_CANARY", "command": "echo PRIVATE_CANARY"})
            started[name].set()
            await release[name].wait()
            execution_result.get()["result"] = {"completed": True, "final_response": "Finished"}
            return "Finished"
        def actions():
            with self.bridge.store._tx() as db:
                return [json.loads(row[0]) for row in db.execute(
                    "SELECT payload FROM outbox WHERE kind='activity' AND state='sent' "
                    "AND json_extract(payload,'$.content.type')='action'")]
        step_epoch = time.monotonic() + 10000
        wall_epoch = self.bridge.clock()
        async def step(metadata, when):
            self.bridge.clock = lambda: wall_epoch + when
            with patch("hermes_fleet_linear_plugin.native_input.time.monotonic", return_value=step_epoch + when):
                await self.adapter.send_typing(self.ISSUE, metadata=metadata)
            await asyncio.gather(*list(self.adapter._step_tasks.values()))
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        with patch.object(type(self.adapter), "status_metadata_for_turn", capture):
            await self.deliver("first", "Investigate the old issue")
            await asyncio.wait_for(started["first"].wait(), 10)
            await self.until(lambda: self.inbox_row("first")[2] == "imported")
            self.assertEqual(captured["first"]["_linear_status_source"], "first")
            await step(captured["first"], 1000)
            self.assertEqual([(x["source_activity"], x["content"]["parameter"]) for x in actions()],
                             [("first", "on reading")])
            await self.deliver("second", "Summarize instead")
            await self.until(lambda: self.inbox_row("second")[2] == "imported")
            self.assertEqual([row["status"] for row in self.rows()], ["started", "queued"])
            await step(captured["first"], 2000)
            await step({"thread_id": self.SESSION}, 2000)  # Event-less refresh cannot borrow the queue's anchor.
            self.assertEqual(len(actions()), 1)
            release["first"].set()
            await asyncio.wait_for(started["second"].wait(), 10)
            self.assertEqual(captured["second"]["_linear_status_source"], "second")
            # The queued turn can start before the first turn's final reply closes the first
            # producer's steps; that close invalidates any step scheduled before it. Step after it.
            await self.until(lambda: (self.ISSUE, self.SESSION, "first") in self.adapter._step_closed)
            await step(captured["second"], 3000)
            self.assertEqual([(x["source_activity"], x["content"]["parameter"]) for x in actions()],
                             [("first", "on reading"), ("second", "in the terminal")],
                             (self.adapter._inputs, self.adapter._step_closed, self.bridge.store.pending()))

    async def test_committed_input_before_receipt_projection(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        first_started, first_release, second_started, second_release = [asyncio.Event() for _ in range(4)]
        committed, return_commit = threading.Event(), threading.Event()
        self.addCleanup(return_commit.set)
        self.addCleanup(first_release.set)
        self.addCleanup(second_release.set)
        async def model(event):
            started, release = ((first_started, first_release) if event.message_id == 'first'
                                else (second_started, second_release))
            started.set()
            await release.wait()
            body = 'Finished ' + event.message_id
            execution_result.get()['result'] = {'completed': True, 'final_response': body}
            return body
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        await self.deliver('first', 'Do the first task.')
        await asyncio.wait_for(first_started.wait(), 10)
        await self.until(lambda: self.inbox_row('first')[2] == 'imported')
        original = self.authority._admit_native_write
        def delayed_commit(**kwargs):
            result = original(**kwargs)
            if kwargs['request_id'] == 'second':
                committed.set()
                if not return_commit.wait(15):
                    raise TimeoutError('finite commit return delay')
            return result
        with patch.object(self.authority, '_admit_native_write', side_effect=delayed_commit):
            await self.deliver('second', 'Then do the second task.')
            await self.until(committed.is_set)
            self.assertEqual([row['status'] for row in self.rows()], ['started', 'queued'])
            first_release.set()
            try:
                await self.until(lambda: self.final_reply_sent('first'))
                with self.bridge.store._tx() as db:
                    payload = json.loads(db.execute("SELECT payload FROM outbox WHERE "
                        "json_extract(payload,'$.source_activity')='first' "
                        "AND json_extract(payload,'$.turn_final')=1").fetchone()[0])
                self.assertEqual(payload['content']['type'], 'thought',
                    'A final must not finish the session while B is already committed and unfinished')
                await asyncio.wait_for(second_started.wait(), 10)
                second_release.set()
                await self.until(lambda: self.final_reply_sent('second'))
                with self.bridge.store._tx() as db:
                    second = json.loads(db.execute("SELECT payload FROM outbox WHERE "
                        "json_extract(payload,'$.source_activity')='second' "
                        "AND json_extract(payload,'$.turn_final')=1").fetchone()[0])
                self.assertEqual(second['content']['type'], 'response')
                self.assertTrue(second['applied'],
                    "A's older projected anchor must not suppress B's completed response")
            finally:
                return_commit.set()
                second_release.set()
                await self.until(lambda: self.inbox_row('second')[2] == 'imported')

    async def test_timed_out_response_lands_during_newer_running_input(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        first_started, first_release, second_started, second_release = [asyncio.Event() for _ in range(4)]
        self.addCleanup(first_release.set)
        self.addCleanup(second_release.set)
        async def model(event):
            started, release = ((first_started, first_release) if event.message_id == 'first'
                                else (second_started, second_release))
            started.set()
            await release.wait()
            body = 'Finished ' + event.message_id
            execution_result.get()['result'] = {'completed': True, 'final_response': body}
            return body
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        original = self.bridge.api.transport
        late_requests = []
        remote_kinds = []
        def transport(url, body, headers):
            request = json.loads(body)
            if 'agentActivityCreate' in request['query']:
                content = request['variables']['input']['content']
                if content['body'] == 'Finished first':
                    late_requests.append((url, body, headers))
                    raise TimeoutError('response timed out while remote create remains in flight')
                remote_kinds.append(content['type'])
            return original(url, body, headers)
        self.bridge.api.transport = transport
        await self.deliver('first', 'Do the first task.')
        await asyncio.wait_for(first_started.wait(), 10)
        await self.until(lambda: self.inbox_row('first')[2] == 'imported')
        first_release.set()
        await self.until(lambda: bool(late_requests))
        await self.deliver('second', 'Then do the second task.')
        await asyncio.wait_for(second_started.wait(), 10)
        await self.until(lambda: self.inbox_row('second')[2] == 'imported')
        request = json.loads(late_requests[0][1])
        fields = request['variables']['input']
        # The timed-out request now lands at Linear, after B has started.
        original(*late_requests[0])
        remote_kinds.append(fields['content']['type'])
        self.bridge.store.defer(fields['id'], self.bridge.clock() - 1)
        await asyncio.to_thread(self.bridge.flush, only_id=fields['id'])
        row = self.bridge.store.outbox_row(fields['id'])
        self.assertEqual(remote_kinds[-1], 'thought',
            'Settling a late remote response must restore working status for the current running input')

    async def test_timed_out_thought_lands_after_newer_input_finishes(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        first_started, first_release, second_started, second_release = [asyncio.Event() for _ in range(4)]
        self.addCleanup(first_release.set)
        self.addCleanup(second_release.set)
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
        original = self.bridge.api.transport
        late_requests, remote_kinds = [], []
        def transport(url, body, headers):
            request = json.loads(body)
            if "agentActivityCreate" in request["query"]:
                fields = request["variables"]["input"]
                if fields["content"]["body"] == "Finished first":
                    late_requests.append((url, body, headers))
                    raise TimeoutError("fixture holds the accepted mutation in flight")
                remote_kinds.append(fields["content"]["type"])
            return original(url, body, headers)
        self.bridge.api.transport = transport
        await self.deliver("first", "Do the first task.")
        await asyncio.wait_for(first_started.wait(), 10)
        await self.until(lambda: self.inbox_row("first")[2] == "imported")
        await self.deliver("second", "Do the second task.")
        await self.until(lambda: self.inbox_row("second")[2] == "imported")
        first_release.set()
        await self.until(lambda: bool(late_requests))
        await asyncio.wait_for(second_started.wait(), 10)
        second_release.set()
        await self.until(lambda: self.final_reply_sent("second"))
        self.assertEqual(remote_kinds[-1], "response")
        fields = json.loads(late_requests[0][1])["variables"]["input"]
        self.assertEqual(fields["content"]["type"], "thought")
        original(*late_requests[0])
        remote_kinds.append(fields["content"]["type"])
        self.bridge.store.defer(fields["id"], self.bridge.clock() - 1)
        await asyncio.to_thread(self.bridge.flush, only_id=fields["id"])
        self.assertEqual(remote_kinds[-1], "response")
        self.assertEqual(self.bridge.store.outbox_row(fields["id"])["state"], "sent")
        self.assertEqual(self.bridge.store.outbox_row(fields["id"])["payload"]["content"], fields["content"])

    async def test_unreadable_committed_input_state_holds_publication(self):
        from gateway.session_authority import SessionAuthority
        from hermes_fleet_linear_plugin.native_input import queue_reply
        started, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        async def model(event):
            started.set()
            await release.wait()
            return None
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        await self.deliver("first", "Do the first task.")
        await asyncio.wait_for(started.wait(), 10)
        await self.until(lambda: self.inbox_row("first")[2] == "imported")
        final = queue_reply(self.bridge, self.ISSUE, self.SESSION, "first", "Finished first.")
        before = len(self.provider.mutations)
        with patch("hermes_fleet_linear_plugin.native_store.list_admissions", side_effect=OSError("fixture state unavailable")):
            await asyncio.to_thread(self.bridge.flush, only_id=final)
        self.assertEqual(len(self.provider.mutations), before)
        self.assertEqual(self.bridge.store.outbox_row(final)["state"], "pending")
        self.assertIs(self.bridge.store.outbox_row(final)["payload"]["write_started"], False)
        self.bridge.store.defer(final, self.bridge.clock() - 1)
        with patch.object(self.bridge, "native_conversation_state", None):
            await asyncio.to_thread(self.bridge.flush, only_id=final)
        self.assertEqual(len(self.provider.mutations), before)
        self.assertEqual(self.bridge.store.outbox_row(final)["state"], "pending")

    async def test_direct_created_session_reply_uses_verified_creator_route(self):
        from hermes_fleet_linear_plugin.native_input import queue_reply
        self.assertNotIn(self.SESSION, self.provider.activities)
        final = queue_reply(self.bridge, self.ISSUE, self.SESSION, self.SESSION, "Here is the requested update.")
        await asyncio.to_thread(self.bridge.flush, only_id=final)
        self.assertEqual(self.bridge.store.outbox_row(final)["state"], "sent")
        self.assertEqual(len(self.provider.mutations), 1)
        self.assertEqual(self.rows(), [])

    async def test_unfinished_and_unresolved_admissions_cannot_publish_completion(self):
        from gateway.session_authority import SessionAuthority
        from hermes_fleet_linear_plugin.native_input import queue_reply
        from linear_native_db import list_session_admissions
        started, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        async def model(event):
            started.set()
            await release.wait()
            return None
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        await self.deliver("first", "Do the first task.")
        await asyncio.wait_for(started.wait(), 10)
        await self.until(lambda: self.inbox_row("first")[2] == "imported")
        final = queue_reply(self.bridge, self.ISSUE, self.SESSION, "first", "Still processing.")
        await asyncio.to_thread(self.bridge.flush, only_id=final)
        self.assertEqual(self.bridge.store.outbox_row(final)["payload"]["content"]["type"], "thought")
        before = len(self.provider.mutations)
        actual = self.rows()[0]
        for status in ("unknown", "terminal"):
            with self.subTest(status=status):
                held = queue_reply(self.bridge, self.ISSUE, self.SESSION, "first", "A later update " + status)
                unresolved = {**actual, "status": status, "outcome": None}
                with patch("hermes_fleet_linear_plugin.native_store.list_admissions", return_value=[unresolved]):
                    await asyncio.to_thread(self.bridge.flush, only_id=held)
                self.assertEqual(len(self.provider.mutations), before)
                self.assertEqual(self.bridge.store.outbox_row(held)["state"], "pending")
                self.assertIs(self.bridge.store.outbox_row(held)["payload"]["write_started"], False)

    async def test_timed_out_interim_lands_after_real_core_completion(self):
        from gateway.session_authority import SessionAuthority
        from gateway.session_results import execution_result
        started, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        delayed, remote_kinds = [], []
        original = self.bridge.api.transport
        def transport(url, body, headers):
            request = json.loads(body)
            if 'agentActivityCreate' in request['query']:
                fields = request['variables']['input']
                if fields['content']['body'] == 'An interim update.':
                    delayed.append((url, body, headers))
                    raise TimeoutError('finite remote create still in flight')
                remote_kinds.append(fields['content']['type'])
            return original(url, body, headers)
        self.bridge.api.transport = transport
        async def model(event):
            started.set()
            await release.wait()
            await self.adapter.send(self.ISSUE, 'An interim update.',
                metadata={'thread_id': self.SESSION, '_interim_send': True})
            execution_result.get()['result'] = {'completed': True, 'final_response': 'All work finished.'}
            return 'All work finished.'
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        await self.deliver('first', 'Do the bounded work.')
        await asyncio.wait_for(started.wait(), 10)
        await self.until(lambda: self.inbox_row('first')[2] == 'imported')
        release.set()
        await self.until(lambda: self.final_reply_sent('first'))
        self.assertEqual(self.rows()[0]['status'], 'terminal')
        self.assertEqual(remote_kinds[-1], 'response')
        self.assertEqual(len(delayed), 1)
        fields = json.loads(delayed[0][1])['variables']['input']
        original(*delayed[0])
        remote_kinds.append(fields['content']['type'])
        self.bridge.store.defer(fields['id'], self.bridge.clock() - 1)
        await asyncio.to_thread(self.bridge.flush)
        print('LATE_INTERIM_PROOF', json.dumps({'remote_kinds': remote_kinds,
            'outbox_state': self.bridge.store.outbox_row(fields['id'])['state'],
            'core_status': self.rows()[0]['status']}), flush=True)
        self.assertEqual(remote_kinds[-1], 'response', 'Late interim must restore the completed session')

    async def start_live_for_delivery(self):
        from gateway.session_authority import SessionAuthority
        started, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        async def model(event):
            started.set()
            await release.wait()
            return None
        self.model = model
        self.authority._schedule = MethodType(SessionAuthority._schedule, self.authority)
        await self.deliver("live-input", "Keep working until released.")
        await asyncio.wait_for(started.wait(), 10)
        await self.until(lambda: self.inbox_row("live-input")[2] == "imported")
        await self.until(lambda: bool(self.receipts))

    async def test_worker_action_returns_after_genuine_question_with_same_admission_and_phrase(self):
        from tools import clarify_gateway as clarify
        from hermes_fleet_linear_plugin import worker_progress
        await self.start_live_for_delivery()
        self.adapter.set_authorization_check(lambda actor, *_a, **_k: actor == self.USER)
        issue = self.provider.issues[self.ISSUE]
        task = self.board.create(title="Bounded delegated continuation",
            body=f"Linear issue {self.ISSUE}: {issue['url']}", created_by=self.board.executor_profile)
        with self.board.conn() as conn, patch("hermes_cli.kanban_db.time.time", return_value=self.bridge.clock() - 2):
            task = self.board.kb.claim_task(conn, task.id)
        self.assertTrue(self.bridge.store.bind_native(self.ISSUE, task.id, "default", self.board.board,
            owner_ref=self.SESSION, at=self.bridge.clock()))
        binding = self.bridge.store.get(self.ISSUE)
        step = {"worker_session_id": "actual-delegated-owner", "execution_generation": 1,
                "admission_id": "same-native-worker-admission", "run_id": task.current_run_id,
                "phrase": "in the terminal"}
        phase = [step]
        wall = self.bridge.clock()
        async def publish(at):
            self.bridge.clock = lambda: wall + at
            await asyncio.to_thread(worker_progress.queue, self.bridge, binding, self.board)
            await asyncio.to_thread(self.bridge.flush)
        def worker_actions():
            with self.bridge.store._tx() as db:
                return [json.loads(row[0]) for row in db.execute(
                    "SELECT payload FROM outbox WHERE json_type(payload,'$.worker_step')='object' AND state='sent' "
                    "AND COALESCE(json_extract(payload,'$.applied'),1)=1")]
        with patch.object(worker_progress, "current", side_effect=lambda *_a: phase[0]):
            await publish(0)
            self.assertEqual(len(worker_actions()), 1)
            key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
            self.addCleanup(clarify.clear_session, key)
            shown = clarify.register("worker-color-choice", key, "Choose a color.", ["Blue", "Green"])
            phase[0] = None
            self.bridge.clock = lambda: wall + 20
            sent = await self.adapter.send_clarify(self.ISSUE, shown.question, shown.choices,
                shown.clarify_id, key, metadata={"thread_id": self.SESSION})
            self.assertTrue(sent.success, sent.error)
            self.assertFalse(self.bridge.store.latest_session_action(self.ISSUE, self.SESSION)["_presentation_current"])
            self.bridge.clock = lambda: wall + 30
            await self.deliver("worker-color-answer", "Blue")
            await self.until(lambda: self.inbox_row("worker-color-answer")[2] == "imported")
            self.assertEqual(shown.response, "Blue")
            phase[0] = step  # Same native admission resumes another terminal call.
            await publish(59)
            self.assertEqual(len(worker_actions()), 1, "A question cannot widen the one-minute cap")
            await publish(61)
            self.assertEqual(len(worker_actions()), 2, "The question replaced the previous ephemeral action")
            self.assertEqual(worker_actions()[0]["worker_step"], worker_actions()[1]["worker_step"])
            self.assertEqual(self.board.get(task.id).current_run_id, task.current_run_id)

    async def test_definitively_rejected_rate_limit_retries_the_exact_question(self):
        from tools import clarify_gateway as clarify
        await self.start_live_for_delivery()
        key = self.adapter._core_session_keys(self.receipts[0][0].source)[0]
        self.addCleanup(clarify.clear_session, key)
        original = self.bridge.api.transport
        for limited in ("http", "graphql"):
            with self.subTest(limited=limited):
                identity = "limited-question-" + limited
                clarify.register(clarify_id=identity, session_key=key,
                                 question="Which environment?", choices=["staging"])
                creates, reads = [], []
                def transport(url, body, headers):
                    request = json.loads(body)
                    if "agentActivityCreate" in request["query"]:
                        creates.append(request["variables"]["input"])
                        if len(creates) == 1:
                            if limited == "http":
                                return 429, {"Retry-After": "1"}, b"{}"
                            return 200, {}, json.dumps({"errors": [{"message": "rate limited",
                                "extensions": {"code": "RATELIMITED"}}]}).encode()
                    if "query OutboundAgentActivity" in request["query"]:
                        reads.append(request["variables"]["id"])
                    return original(url, body, headers)
                self.bridge.api.transport = transport
                result = await self.adapter.send_clarify(self.ISSUE, "Which environment?", ["staging"],
                    identity, key, metadata={"thread_id": self.SESSION})
                question = result.message_id
                self.assertTrue(question)
                started = self.bridge.store.outbox_row(question)["payload"]["write_started"]
                self.bridge.api.paused_until = 0
                self.bridge.store.defer(question, self.bridge.clock() - 1)
                await asyncio.to_thread(self.bridge.flush, only_id=question)
                self.assertIs(started, False)
                self.assertEqual(self.bridge.store.outbox_row(question)["state"], "sent")
                self.assertEqual(len(creates), 2)
                self.assertEqual(creates[0], creates[1])
                self.assertEqual(reads, [])

    def legacy_response(self, identity="c5cf9a31-7480-4667-bfff-81db6ea4703c"):
        # Exact pre-PR queue_reply shape: no source, final, cursor or attempt metadata.
        self.event("older-input", "Previous task.")
        legacy = {"id": identity, "issue_id": self.ISSUE, "session_id": self.SESSION,
            "content": {"type": "response", "body": "Previous task finished."},
            "content_action": True, "unlinked_content": True, "native_reply_version": 1,
            "requester_sessions": {self.ISSUE: self.SESSION},
            "requester_activities": {self.ISSUE: "older-input"}}
        return self.bridge.store.enqueue("activity", legacy, at=self.bridge.clock())

    async def test_pre_upgrade_response_cannot_finish_new_running_turn(self):
        identity = self.legacy_response()
        await self.start_live_for_delivery()
        before = len(self.provider.mutations)
        await asyncio.to_thread(self.bridge.flush, only_id=identity)
        row = self.bridge.store.outbox_row(identity)
        self.assertEqual(len(self.provider.mutations), before)
        self.assertEqual(row["state"], "pending")
        self.assertEqual(row["payload"]["content"], {"type": "response", "body": "Previous task finished."})

    async def test_accepted_pre_upgrade_response_is_settled_and_repairs_current_work(self):
        identity = self.legacy_response()
        original = self.bridge.store.outbox_row(identity)
        def land():
            with self.bridge._outbox_requester_scope(original):
                self.bridge.api.create_activity(identity, self.SESSION, original["payload"]["content"],
                                                issue_id=self.ISSUE)
        await asyncio.to_thread(land)
        await self.start_live_for_delivery()
        before = len(self.provider.mutations)
        await asyncio.to_thread(self.bridge.flush, only_id=identity)
        settled = self.bridge.store.outbox_row(identity)
        self.assertEqual(settled["state"], "sent")
        self.assertEqual(settled["payload"]["content"], original["payload"]["content"])
        self.assertEqual(settled["payload"]["requester_activities"], original["payload"]["requester_activities"])
        self.assertEqual(len(self.provider.mutations), before + 1)
        with self.bridge.store._tx() as db:
            repair = json.loads(db.execute("SELECT payload FROM outbox WHERE "
                "json_extract(payload,'$.lifecycle_repair_of')=?", (identity,)).fetchone()[0])
        self.assertEqual(repair["content"]["type"], "thought")
        self.assertNotEqual(repair["id"], identity)
        await asyncio.to_thread(self.bridge.flush, only_id=identity)
        self.assertEqual(len(self.provider.mutations), before + 1)

    async def test_legacy_final_thought_retries_when_current_work_is_live(self):
        identity = self.legacy_response()
        old = self.bridge.store.outbox_row(identity)['payload']
        old['content'] = {'type': 'thought', 'body': 'The native remainder is ready.'}
        self.bridge.store.rewrite(identity, old, self.bridge.clock())
        await self.start_live_for_delivery()
        before = len(self.provider.mutations)
        for attempt in range(2):
            self.bridge.store.defer(identity, self.bridge.clock()-1)
            await asyncio.to_thread(self.bridge.flush, only_id=identity)
        row = self.bridge.store.outbox_row(identity)
        self.assertEqual(row['state'], 'sent', 'A pre-upgrade final thought must keep retry delivery under its original ID')

    async def test_late_old_completion_preserves_current_awaiting_question(self):
        from tools import clarify_gateway as clarify
        identity = self.legacy_response()
        old = self.bridge.store.outbox_row(identity)
        await self.start_live_for_delivery()
        key = self.adapter._core_session_keys(self.receipts[0][0].source)[0]
        self.addCleanup(clarify.clear_session, key)
        clarify.register(clarify_id='current-choice', session_key=key,
            question='Which environment?', choices=['staging', 'production'])
        remote = []
        transport = self.bridge.api.transport
        def observe(url, body, headers):
            request = json.loads(body)
            if 'agentActivityCreate' in request['query']:
                remote.append(request['variables']['input'])
            return transport(url, body, headers)
        self.bridge.api.transport = observe
        question = await self.adapter.send_clarify(self.ISSUE, 'Which environment?', ['staging', 'production'],
            'current-choice', key, metadata={'thread_id': self.SESSION})
        self.assertTrue(question.success)
        self.assertEqual(remote[-1]['content']['type'], 'elicitation')
        def land_old_response():
            with self.bridge._outbox_requester_scope(old):
                self.bridge.api.create_activity(identity, self.SESSION, old['payload']['content'], issue_id=self.ISSUE)
        await asyncio.to_thread(land_old_response)
        await asyncio.to_thread(self.bridge.flush, only_id=identity)
        self.assertEqual(remote[-1]['content']['type'], 'elicitation',
            'Settling a stale final while a current question is pending must restore awaiting-input, not working')

    async def test_late_expired_question_does_not_restore_awaiting_input(self):
        from tools import clarify_gateway as clarify
        await self.start_live_for_delivery()
        key = self.adapter._core_session_keys(self.receipts[0][0].source)[0]
        self.addCleanup(clarify.clear_session, key)
        clarify.register(clarify_id='expired-choice', session_key=key,
            question='Which environment?', choices=['staging'])
        delayed, remote = [], []
        transport = self.bridge.api.transport
        def observe(url, body, headers):
            request = json.loads(body)
            if 'agentActivityCreate' in request['query']:
                fields = request['variables']['input']
                if fields['content']['type'] == 'elicitation':
                    delayed.append((url, body, headers))
                    raise TimeoutError('remote Activity remains in flight')
                remote.append(fields)
            return transport(url, body, headers)
        self.bridge.api.transport = observe
        question = await self.adapter.send_clarify(self.ISSUE, 'Which environment?', ['staging'],
            'expired-choice', key, metadata={'thread_id': self.SESSION})
        self.assertTrue(question.message_id)
        self.assertEqual(len(delayed), 1)
        # Real Core removes the request when its wait expires while its turn continues.
        clarify.clear_session(key)
        transport(*delayed[0])
        remote.append(json.loads(delayed[0][1])['variables']['input'])
        self.bridge.store.defer(question.message_id, self.bridge.clock()-1)
        await asyncio.to_thread(self.bridge.flush, only_id=question.message_id)
        row = self.bridge.store.outbox_row(question.message_id)
        self.assertEqual(remote[-1]['content']['type'], 'thought',
            'A late expired question must restore the still-running turn instead of awaiting a nonexistent decision')

    def observe_delivery(self):
        remote = []
        transport = self.bridge.api.transport
        def observe(url, body, headers):
            request = json.loads(body)
            if "agentActivityCreate" in request["query"]:
                remote.append(request["variables"]["input"])
            return transport(url, body, headers)
        self.bridge.api.transport = observe
        return remote

    async def land_legacy_response(self, identity):
        old = self.bridge.store.outbox_row(identity)
        def land():
            with self.bridge._outbox_requester_scope(old):
                self.bridge.api.create_activity(identity, self.SESSION, old["payload"]["content"], issue_id=self.ISSUE)
        await asyncio.to_thread(land)

    def current_delivery_key(self):
        return self.adapter._core_session_keys(self.receipts[0][0].source)[0]

    async def display_delivery_clarify(self, identity="current-question", choices=None):
        from tools import clarify_gateway as clarify
        key = self.current_delivery_key()
        self.addCleanup(clarify.clear_session, key)
        choices = choices or ["staging", "production"]
        clarify.register(identity, key, "Which environment?", choices)
        result = await self.adapter.send_clarify(self.ISSUE, "Which environment?", choices,
            identity, key, metadata={"thread_id": self.SESSION})
        return result

    async def test_repaired_clarification_is_one_decision_across_all_presentations(self):
        from tools import clarify_gateway as clarify
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        identity = self.legacy_response()
        await self.start_live_for_delivery()
        remote = self.observe_delivery()
        shown = await self.display_delivery_clarify()
        self.assertTrue(shown.success)
        original = self.bridge.store.outbox_row(shown.message_id)["payload"]
        await self.land_legacy_response(identity)
        await asyncio.to_thread(self.bridge.flush, only_id=identity)
        repair = self.bridge.store.outbox_row(remote[-1]["id"])["payload"]
        self.assertNotEqual(repair["id"], shown.message_id)
        for key in ("content", "native_prompt", "signal", "signal_metadata", "requester_activities"):
            self.assertEqual(repair[key], original[key])
        self.assertFalse(self.bridge.store.conversation_finished(self.ISSUE, self.SESSION, "live-input"))
        await self.deliver("same-question-answer", "staging")
        await self.until(lambda: self.inbox_row("same-question-answer")[2] == "imported")
        self.assertEqual(clarify.wait_for_response("current-question", .01), "staging")
        for displayed in (shown.message_id, repair["id"]):
            self.assertEqual(self.bridge.store.outbox_row(displayed)["payload"]["answered_by"], "same-question-answer")
        later = await self.display_delivery_clarify("next-question")
        self.assertTrue(later.success)
        await self.deliver("later-answer", "production")
        await self.until(lambda: self.inbox_row("later-answer")[2] == "imported")
        self.assertEqual(clarify.wait_for_response("next-question", .01), "production",
                         "Resolved mirrored cards must not obstruct a later legitimate answer")
        self.assertEqual(len(self.rows()), 1)

    async def test_repaired_approval_preserves_exact_selected_command_without_relocking_core(self):
        from tools import approval
        self.adapter.set_authorization_check(lambda user_id, *_a, **_k: user_id == self.USER)
        from tools.approval_gateway_wait import _ApprovalEntry
        identity = self.legacy_response()
        await self.start_live_for_delivery()
        remote = self.observe_delivery()
        key = self.current_delivery_key()
        entry = _ApprovalEntry({"command": "deploy-staging"})
        with approval._lock:
            approval._gateway_queues[key] = [entry]
        self.addCleanup(approval.unregister_gateway_notify, key)
        shown = await self.show_approval(key, entry)
        self.assertTrue(shown.success)
        original = self.bridge.store.outbox_row(shown.message_id)["payload"]
        await self.land_legacy_response(identity)
        await asyncio.to_thread(self.bridge.flush, only_id=identity)
        repair = self.bridge.store.outbox_row(remote[-1]["id"])["payload"]
        self.assertEqual(repair["content"], original["content"])
        self.assertEqual(repair["native_prompt"], original["native_prompt"])
        self.assertEqual(repair["signal_metadata"], original["signal_metadata"])
        value = repair["signal_metadata"]["options"][0]["value"]
        await self.deliver("approval-choice", value)
        await self.until(lambda: self.inbox_row("approval-choice")[2] == "imported")
        self.assertEqual(entry.result, "once")
        for displayed in (shown.message_id, repair["id"]):
            self.assertEqual(self.bridge.store.outbox_row(displayed)["payload"]["answered_by"], "approval-choice")
        self.assertEqual(len(self.rows()), 1)

    async def test_repair_question_expiring_at_admission_is_replaced_without_stale_publication(self):
        from tools import clarify_gateway as clarify
        identity = self.legacy_response()
        await self.start_live_for_delivery()
        remote = self.observe_delivery()
        shown = await self.display_delivery_clarify()
        await self.land_legacy_response(identity)
        original = self.bridge.store.admit_mutation
        repairs = []
        def admit(row_id, **kwargs):
            result = original(row_id, **kwargs)
            payload = self.bridge.store.outbox_row(row_id)["payload"]
            if payload.get("lifecycle_repair_of") and payload["content"]["type"] == "elicitation":
                repairs.append(row_id)
                clarify.clear_session(self.current_delivery_key())
            return result
        with patch.object(self.bridge.store, "admit_mutation", side_effect=admit):
            await asyncio.to_thread(self.bridge.flush, only_id=identity)
        self.assertEqual(len(repairs), 1)
        repair = self.bridge.store.outbox_row(repairs[0])
        self.assertIs(repair["payload"]["write_started"], False)
        self.assertEqual([row["content"]["type"] for row in remote], ["elicitation", "response"])
        self.bridge.store.defer(repairs[0], self.bridge.clock() - 1)
        await asyncio.to_thread(self.bridge.flush, only_id=repairs[0])
        self.assertEqual(remote[-1]["content"]["type"], "thought")
        self.assertEqual(self.bridge.store.outbox_row(repairs[0])["payload"]["content"], repair["payload"]["content"])
        self.assertFalse(self.bridge.store.conversation_finished(self.ISSUE, self.SESSION, "live-input"))

    async def test_uncertain_question_repair_landing_after_expiry_restores_working(self):
        from tools import clarify_gateway as clarify
        identity = self.legacy_response()
        await self.start_live_for_delivery()
        shown = await self.display_delivery_clarify()
        await self.land_legacy_response(identity)
        transport = self.bridge.api.transport
        delayed, remote = [], []
        def observe(url, body, headers):
            request = json.loads(body)
            if "agentActivityCreate" in request["query"]:
                fields = request["variables"]["input"]
                if fields["content"]["type"] == "elicitation":
                    delayed.append((url, body, headers))
                    raise TimeoutError("repair remains in flight")
                remote.append(fields)
            return transport(url, body, headers)
        self.bridge.api.transport = observe
        await asyncio.to_thread(self.bridge.flush, only_id=identity)
        self.assertEqual(len(delayed), 1)
        fields = json.loads(delayed[0][1])["variables"]["input"]
        clarify.clear_session(self.current_delivery_key())
        self.bridge.store.defer(fields["id"], self.bridge.clock() - 1)
        await asyncio.to_thread(self.bridge.flush, only_id=fields["id"])
        self.assertEqual(len(delayed), 1, "Unknown question repair must stay readback-only")
        self.assertEqual(remote, [])
        transport(*delayed[0])
        remote.append(fields)
        self.bridge.store.defer(fields["id"], self.bridge.clock() - 1)
        await asyncio.to_thread(self.bridge.flush, only_id=fields["id"])
        self.assertEqual([row["content"]["type"] for row in remote], ["elicitation", "thought"])
        self.assertEqual(self.bridge.store.outbox_row(fields["id"])["state"], "sent")
        self.assertEqual(self.bridge.store.outbox_row(fields["id"])["payload"]["content"], fields["content"])

    async def test_another_sender_attempting_question_repair_before_guard_prevents_replay(self):
        identity = self.legacy_response()
        await self.start_live_for_delivery()
        remote = self.observe_delivery()
        shown = await self.display_delivery_clarify()
        self.assertTrue(shown.success)
        await self.land_legacy_response(identity)
        create = self.bridge.api.create_activity
        attempted = []
        def race(activity_id, session_id, content, **kwargs):
            row = self.bridge.store.outbox_row(activity_id)
            if row and row["payload"].get("lifecycle_repair_of"):
                self.assertTrue(self.bridge.store.admit_mutation(activity_id, expected_content=content,
                    conversation_attempt_id="other-sender", require_unattempted=True))
                attempted.append(activity_id)
            return create(activity_id, session_id, content, **kwargs)
        with patch.object(self.bridge.api, "create_activity", side_effect=race):
            await asyncio.to_thread(self.bridge.flush, only_id=identity)
        self.assertEqual(len(attempted), 1)
        self.assertEqual([row["content"]["type"] for row in remote], ["elicitation", "response"])
        repair = self.bridge.store.outbox_row(attempted[0])
        self.assertEqual(repair["state"], "pending")
        self.assertEqual(repair["payload"]["conversation_attempt_id"], "other-sender")
        self.bridge.store.defer(attempted[0], self.bridge.clock() - 1)
        await asyncio.to_thread(self.bridge.flush, only_id=attempted[0])
        self.assertEqual(len(remote), 2)
