"""Lost delegated status replies retain readback and order the single closeout."""
import asyncio
import json
import inspect
import unittest
import uuid
from unittest.mock import patch

import test_linear_native_delivery_seam as delivery


@unittest.skipUnless(delivery.seam.SOURCE and delivery.seam.GUARDED_ROOT,
                     'requires scripts/run-linear-input-scenarios.py')
class WorkerDeliveryScenarios(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = delivery.FinalDeliveryAdmissionScenarios.asyncSetUp
    asyncTearDown = delivery.FinalDeliveryAdmissionScenarios.asyncTearDown
    no_model = delivery.FinalDeliveryAdmissionScenarios.no_model
    until = delivery.FinalDeliveryAdmissionScenarios.until
    event = delivery.FinalDeliveryAdmissionScenarios.event
    deliver = delivery.FinalDeliveryAdmissionScenarios.deliver
    inbox_row = delivery.FinalDeliveryAdmissionScenarios.inbox_row
    rows = delivery.FinalDeliveryAdmissionScenarios.rows
    final_reply_sent = delivery.FinalDeliveryAdmissionScenarios.final_reply_sent
    start_live_for_delivery = delivery.FinalDeliveryAdmissionScenarios.start_live_for_delivery

    async def held_worker(self, *, before_claim_checkpoint=None):
        await self.start_live_for_delivery()
        self.adapter.set_authorization_check(lambda actor, *_a, **_k: actor == self.USER)
        issue = self.provider.issues[self.ISSUE]
        task = self.board.create(title='Bounded delegated continuation',
            body=f"Linear issue {self.ISSUE}: {issue['url']}", created_by=self.board.executor_profile)
        if before_claim_checkpoint is not None:
            await self.checkpoint(task, before_claim_checkpoint, capture=False)
        with self.board.conn() as conn, patch('hermes_cli.kanban_db.time.time', return_value=self.bridge.clock() - 2):
            task = self.board.kb.claim_task(conn, task.id)
        self.assertTrue(self.bridge.store.bind_native(self.ISSUE, task.id, 'default', self.board.board,
            owner_ref=self.SESSION, completion_scope=self.bridge._completion_scope(self.board, task),
            at=self.bridge.clock()))
        step = {'worker_session_id': 'actual-delegated-owner', 'execution_generation': 1,
                'admission_id': 'same-native-worker-admission', 'run_id': task.current_run_id,
                'phrase': 'in the terminal'}
        return task, self.bridge.store.get(self.ISSUE), step

    async def checkpoint(self, task, body, *, capture=True):
        with self.board.conn() as conn:
            request = str(uuid.uuid4())
            if 'human_checkpoint' in inspect.signature(self.board.kb.add_comment).parameters:
                self.board.kb.add_comment(conn, task.id, 'worker', body,
                    human_checkpoint=True, request_id=request)
            else:  # The retained notification-contract fixture predates the explicit producer.
                with self.board.kb.write_txn(conn):
                    comment = self.board.kb.add_comment(conn, task.id, 'worker', body)
                    self.board.kb._append_event(conn, task.id, 'checkpoint',
                        {'author':'worker', 'body':body, 'comment_id':comment, 'request_id':request})
        if capture:
            await asyncio.to_thread(self.bridge.pump_kanban)

    def checkpoint_row(self, body):
        # A checkpoint is one issue comment; it is never repeated as a session note.
        self.assertFalse(any(row['kind'] == 'activity' and row['payload'].get('content', {}).get('body') == body
                             for row in self.bridge.store.pending(self.ISSUE)))
        return next(row for row in self.bridge.store.pending(self.ISSUE)
            if row['kind'] == 'comment' and row['payload'].get('native_history') is True
            and row['payload'].get('body') == body)

    def observe_effects(self):
        """Record delivered comments and activities in provider order: (type, body)."""
        order, transport = [], self.bridge.api.transport
        def observe(url, body, headers):
            result = transport(url, body, headers)
            request = json.loads(body)
            fields = request.get('variables', {}).get('input', {})
            if 'commentCreate' in request.get('query', ''):
                order.append(('comment', fields.get('body')))
            elif 'agentActivityCreate' in request.get('query', ''):
                content = fields.get('content', {})
                order.append((content.get('type'), content.get('body')))
            return result
        self.bridge.api.transport = observe
        return order

    async def question(self, name):
        from tools import clarify_gateway as clarify
        key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
        self.addCleanup(clarify.clear_session, key)
        shown = clarify.register(name, key, 'Choose a color.', ['Blue', 'Green'])
        sent = await self.adapter.send_clarify(self.ISSUE, shown.question, shown.choices,
            shown.clarify_id, key, metadata={'thread_id': self.SESSION})
        return key, shown, sent

    async def test_direct_question_waits_for_delayed_checkpoint_comment_across_restart(self):
        await self.check_question_history_order(capture=True)

    async def test_direct_question_waits_for_checkpoint_not_yet_captured(self):
        await self.check_question_history_order(capture=False)

    async def test_uncaptured_gate_does_not_replay_pre_binding_historical_checkpoint(self):
        task, _, _ = await self.held_worker(before_claim_checkpoint='Earlier work before this reporting binding.')
        _, shown, sent = await self.question('historical-checkpoint-question')
        self.assertTrue(sent.success, sent.error)
        self.assertEqual(self.bridge.store.get(self.ISSUE)['last_event_id'], 0)
        self.assertEqual(list(self.provider.activities.values())[-1]['content']['type'], 'elicitation')
        self.assertIsNone(shown.response)
        self.assertEqual(self.board.get(task.id).status, 'running')

    async def check_question_history_order(self, *, capture):
        from hermes_fleet_linear_plugin.store import Store
        task, _, _ = await self.held_worker()
        wall = self.bridge.clock()
        body = 'Completed the first bounded check; next is a color decision.'
        await self.checkpoint(task, body, capture=capture)
        if capture:
            self.bridge.store.defer(self.checkpoint_row(body)['id'], wall + 30)
        effects = self.observe_effects()
        _, shown, sent = await self.question('checkpoint-order-' + str(capture))
        self.assertFalse(sent.success)
        self.assertTrue(sent.retryable)
        self.assertTrue(sent.raw_response['ambiguous'], 'Core must retain the real queued question')
        question = self.bridge.store.outbox_row(sent.message_id)
        self.assertEqual(question['state'], 'pending')
        self.assertIs(question['payload']['write_started'], False)
        self.assertFalse(any(a['content']['type'] == 'elicitation'
            for a in self.provider.activities.values() if 'content' in a))
        self.assertIsNone(shown.response)
        self.assertEqual(self.board.get(task.id).status, 'running')
        await asyncio.to_thread(self.bridge.pump_kanban)
        self.bridge.store = Store(self.bridge.store.path)
        self.bridge.clock = lambda: wall + 60
        await asyncio.to_thread(self.bridge.flush)
        self.bridge.clock = lambda: wall + 120
        await asyncio.to_thread(self.bridge.flush)
        # The checkpoint comment still lands before the question, once, and never as a session note.
        checkpoint = effects.index(('comment', body))
        question = next(i for i, (kind, _) in enumerate(effects) if kind == 'elicitation')
        self.assertLess(checkpoint, question)
        activities = [a['content'] for a in self.provider.activities.values() if 'content' in a]
        self.assertEqual(activities[-1]['type'], 'elicitation')
        self.assertFalse(any(a.get('body') == body for a in activities))
        self.assertEqual(sum(c['body'] == body for c in self.provider.comment_records.values()), 1)
        self.assertEqual(self.bridge.store.outbox_row(sent.message_id)['state'], 'sent')
        self.assertIsNone(shown.response)

    async def test_shown_question_does_not_hold_a_late_checkpoint_issue_comment(self):
        from tools import clarify_gateway as clarify
        task, _, _ = await self.held_worker()
        key, shown, sent = await self.question('checkpoint-after-shown-question')
        self.assertTrue(sent.success, sent.error)
        body = 'Retained checkpoint from the earlier work.'
        await self.checkpoint(task, body)
        history = self.checkpoint_row(body)
        await asyncio.to_thread(self.bridge.flush)
        # The checkpoint is only its issue comment: nothing reopens the shown question.
        self.assertEqual(self.bridge.store.outbox_row(history['id'])['state'], 'sent')
        self.assertEqual(sum(c['body'] == body for c in self.provider.comment_records.values()), 1)
        self.assertEqual(list(self.provider.activities.values())[-1]['content']['type'], 'elicitation')
        self.assertFalse(any(a['content'].get('body') == body for a in self.provider.activities.values() if 'content' in a))
        self.assertIsNone(shown.response)
        clarify.clear_session(key)

    async def test_unknown_checkpoint_effect_holds_question_without_replaying_history(self):
        task, _, _ = await self.held_worker()
        body = 'A checkpoint whose publication is uncertain.'
        await self.checkpoint(task, body)
        history = self.checkpoint_row(body)
        self.bridge.store.defer(history['id'], self.bridge.clock() + 30)
        await asyncio.to_thread(self.bridge.flush)  # Confirm its native status prerequisite first.
        self.assertTrue(self.bridge.store.admit_mutation(history['id']))
        self.bridge.store.mark(history['id'], 'failed', 'Unknown remote effect')
        self.bridge.store.report(history['id'])
        _, shown, sent = await self.question('unknown-checkpoint-question')
        self.assertFalse(sent.success)
        self.assertTrue(sent.raw_response['ambiguous'])
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(self.bridge.store.outbox_row(history['id'])['state'], 'failed')
        self.assertIs(self.bridge.store.outbox_row(history['id'])['payload']['write_started'], True)
        self.assertFalse(any(a['content']['type'] == 'elicitation' or a['content'].get('body') == body
            for a in self.provider.activities.values() if 'content' in a))
        # The uncertain checkpoint comment is not replayed under a new identity.
        self.assertFalse(any(c['body'] == body for c in self.provider.comment_records.values()))
        self.assertIsNone(shown.response)

    async def test_native_closing_pointer_follows_retained_checkpoint_comment(self):
        task, _, _ = await self.held_worker()
        wall = self.bridge.clock()
        body = 'The bounded stage is verified.'
        await self.checkpoint(task, body)
        history = self.checkpoint_row(body)
        self.bridge.store.defer(history['id'], wall + 30)
        effects = self.observe_effects()
        summary = 'Completed the bounded verification; no work remains.'
        with self.board.conn() as conn:
            self.assertTrue(self.board.kb.complete_task(conn, task.id, summary=summary,
                expected_run_id=task.current_run_id))
        await asyncio.to_thread(self.bridge.pump_kanban)
        await asyncio.to_thread(self.bridge.flush)
        self.assertFalse(any(a['content']['type'] == 'response'
            for a in self.provider.activities.values() if 'content' in a))
        # The full result follows the retained checkpoint comment in the thread.
        self.assertFalse(any(summary in c['body'] for c in self.provider.comment_records.values()))
        self.bridge.clock = lambda: wall + 60
        await asyncio.to_thread(self.bridge.flush)
        self.bridge.clock = lambda: wall + 120
        await asyncio.to_thread(self.bridge.flush)
        activities = [a['content'] for a in self.provider.activities.values() if 'content' in a]
        self.assertEqual(activities[-1]['type'], 'response')
        self.assertEqual(sum(a['type'] == 'response' for a in activities), 1)
        # Checkpoint comment, then the full result comment, then the session's only response.
        result = next(i for i, (kind, text) in enumerate(effects) if kind == 'comment' and summary in (text or ''))
        self.assertLess(effects.index(('comment', body)), result)
        self.assertLess(result, next(i for i, (kind, _) in enumerate(effects) if kind == 'response'))
        self.assertFalse(any(a.get('body') == body for a in activities))

    async def lose_step(self, binding):
        from hermes_fleet_linear_plugin import worker_progress
        transport, delayed = self.bridge.api.transport, []
        def lose(url, body, headers):
            fields = json.loads(body).get('variables', {}).get('input', {})
            if fields.get('ephemeral') and fields.get('content', {}).get('type') == 'action':
                delayed.append((url, body, headers))
                raise TimeoutError('client timed out; provider still processing')
            return transport(url, body, headers)
        await asyncio.to_thread(worker_progress.queue, self.bridge, binding, self.board)
        with patch.object(self.bridge.api, 'transport', side_effect=lose):
            await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(len(delayed), 1)
        with self.bridge.store._tx() as db:
            identity = db.execute("SELECT id FROM outbox WHERE json_type(payload,'$.worker_step')='object'").fetchone()[0]
        pending = self.bridge.store.outbox_row(identity)
        self.assertEqual(pending['state'], 'pending')
        self.assertIs(pending['payload']['write_started'], True)
        return identity, transport, delayed

    async def test_lost_worker_action_accepted_after_genuine_question_restores_exact_question(self):
        from tools import clarify_gateway as clarify
        from hermes_fleet_linear_plugin import worker_progress
        from hermes_fleet_linear_plugin.store import Store
        _, binding, step = await self.held_worker()
        phase, wall = [step], self.bridge.clock()
        with patch.object(worker_progress, 'current', side_effect=lambda *_a: phase[0]):
            identity, transport, delayed = await self.lose_step(binding)
            key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
            self.addCleanup(clarify.clear_session, key)
            shown = clarify.register('lost-worker-choice', key, 'Choose a color.', ['Blue', 'Green'])
            phase[0] = None
            self.bridge.clock = lambda: wall + 20
            sent = await self.adapter.send_clarify(self.ISSUE, shown.question, shown.choices,
                shown.clarify_id, key, metadata={'thread_id': self.SESSION})
            self.assertTrue(sent.success, sent.error)
            kinds = lambda: [a['content']['type'] for a in self.provider.activities.values() if 'content' in a]
            self.assertEqual(kinds()[-1], 'elicitation')
            await asyncio.to_thread(transport, *delayed[0])
            self.assertEqual(kinds()[-1], 'action')
            self.bridge.store = Store(self.bridge.store.path)  # Reporter replacement retains uncertainty.
            self.bridge.clock = lambda: wall + 120  # Expiry must not discard a possible remote effect.
            await asyncio.to_thread(self.bridge.flush)
            self.assertEqual(kinds()[-1], 'elicitation')
            self.assertEqual(sum(kind == 'action' for kind in kinds()), 1)
            original = self.bridge.store.outbox_row(sent.message_id)['payload']
            repaired = list(self.provider.activities.values())[-1]
            self.assertEqual(repaired['content']['body'], original['content']['body'])
            self.assertEqual(self.bridge.store.outbox_row(identity)['state'], 'sent')
            self.assertIsNone(shown.response)

    async def test_native_completion_stays_done_while_sole_response_waits_for_worker_receipt(self):
        from hermes_fleet_linear_plugin import worker_progress
        task, binding, step = await self.held_worker()
        phase, wall = [step], self.bridge.clock()
        with patch.object(worker_progress, 'current', side_effect=lambda *_a: phase[0]):
            identity, transport, delayed = await self.lose_step(binding)
            summary = 'Completed the bounded check. Evidence: its verification passed. Nothing remains.'
            with self.board.conn() as conn:
                self.assertTrue(self.board.kb.complete_task(conn, task.id, summary=summary,
                    expected_run_id=task.current_run_id))
            phase[0] = None
            self.bridge.clock = lambda: wall + 20
            await asyncio.to_thread(self.bridge.pump_kanban)
            await asyncio.to_thread(self.bridge.flush)
            self.assertEqual(self.board.get(task.id).status, 'done')
            self.assertEqual(self.provider.issues[self.ISSUE]['state']['type'], 'completed')
            self.assertTrue(self.bridge.store.unsettled_worker_action(self.ISSUE, self.SESSION))
            self.assertFalse(any(a.get('content', {}).get('type') == 'response' for a in self.provider.activities.values()))
            await asyncio.to_thread(transport, *delayed[0])
            self.bridge.clock = lambda: wall + 120
            await asyncio.to_thread(self.bridge.flush)
            self.bridge.clock = lambda: wall + 180
            await asyncio.to_thread(self.bridge.flush)
            finals = [a for a in self.provider.activities.values() if a.get('content', {}).get('type') == 'response']
            self.assertEqual(len(finals), 1)
            self.assertEqual(len(self.provider.comment_records), 1)
            self.assertIn(summary, next(iter(self.provider.comment_records.values()))['body'])
            self.assertNotIn(summary, finals[0]['content']['body'])
            self.assertEqual(list(self.provider.activities.values())[-1]['content']['type'], 'response')
            self.assertEqual(self.bridge.store.outbox_row(identity)['state'], 'sent')
            self.assertFalse(self.bridge.store.unsettled_worker_action(self.ISSUE, self.SESSION))

    async def test_uncertain_action_is_read_only_after_expiry_and_native_stop(self):
        from hermes_fleet_linear_plugin import worker_progress
        task, binding, step = await self.held_worker()
        phase, wall = [step], self.bridge.clock()
        with patch.object(worker_progress, 'current', side_effect=lambda *_a: phase[0]):
            identity, _, delayed = await self.lose_step(binding)
            with self.board.conn() as conn:
                self.assertTrue(self.board.kb.block_task(conn, task.id, reason='Stopped by requester',
                    kind='needs_input', expected_run_id=task.current_run_id))
            phase[0] = None
            self.bridge.clock = lambda: wall + 120
            with patch.object(self.bridge.api, 'create_activity', wraps=self.bridge.api.create_activity) as creates:
                await asyncio.to_thread(self.bridge.flush, only_id=identity)
            self.assertEqual(creates.call_count, 0, 'An uncertain expired/stopped action is readback-only')
            self.assertEqual(len(delayed), 1)
            row = self.bridge.store.outbox_row(identity)
            self.assertEqual(row['state'], 'pending')
            self.assertIs(row['payload']['write_started'], True)
            self.assertIsNone(row['payload'].get('applied'))

    async def test_definite_rate_limit_rejection_does_not_fence_session_close(self):
        from hermes_fleet_linear_plugin import worker_progress
        _, binding, step = await self.held_worker()
        original = self.bridge.api.transport
        def reject(url, body, headers):
            fields = json.loads(body).get('variables', {}).get('input', {})
            if fields.get('ephemeral'):
                return 429, {'Retry-After': '1'}, json.dumps({'errors': [{'message': 'limited'}]}).encode()
            return original(url, body, headers)
        with patch.object(worker_progress, 'current', return_value=step):
            await asyncio.to_thread(worker_progress.queue, self.bridge, binding, self.board)
            with patch.object(self.bridge.api, 'transport', side_effect=reject):
                await asyncio.to_thread(self.bridge.flush)
        self.assertFalse(self.bridge.store.unsettled_worker_action(self.ISSUE, self.SESSION))

    async def composed_repair(self, *, uncertain):
        """Real Core prompt and provider receipts, with reserve exhaustion or lost reply."""
        from tools import clarify_gateway as clarify
        from hermes_fleet_linear_plugin import worker_progress
        from hermes_fleet_linear_plugin.store import Store
        task, binding, step = await self.held_worker()
        phase, wall = [step], self.bridge.clock()
        with patch.object(worker_progress, 'current', side_effect=lambda *_a: phase[0]):
            identity, transport, delayed = await self.lose_step(binding)
            key = self.fixture.store._generate_session_key(self.receipts[0][0].source)
            self.addCleanup(clarify.clear_session, key)
            shown = clarify.register('withdrawn-worker-choice', key, 'Choose a color.', ['Blue', 'Green'])
            phase[0] = None
            self.bridge.clock = lambda: wall + 20
            sent = await self.adapter.send_clarify(self.ISSUE, shown.question, shown.choices,
                shown.clarify_id, key, metadata={'thread_id': self.SESSION})
            self.assertTrue(sent.success, sent.error)
            original_question = self.bridge.store.outbox_row(sent.message_id)['payload']
            await asyncio.to_thread(transport, *delayed[0])
            repairs, retained, held = [], [], [False]
            enqueue = self.bridge.store.enqueue
            budget = self.bridge.api.budget_remaining
            def reserve(kind, payload, **kwargs):
                result = enqueue(kind, payload, **kwargs)
                if payload.get('lifecycle_repair_of'):
                    repairs.append(result)
                    held[0] = not uncertain
                return result
            def lose_repair(url, body, headers):
                fields = json.loads(body).get('variables', {}).get('input', {})
                if fields.get('content', {}).get('type') == 'elicitation':
                    retained.append((url, body, headers))
                    raise TimeoutError('provider still processing question repair')
                return transport(url, body, headers)
            self.bridge.clock = lambda: wall + 120
            with patch.object(self.bridge.store, 'enqueue', side_effect=reserve), \
                 patch.object(self.bridge.api, 'budget_remaining', side_effect=lambda: (.1, wall + 3600) if held[0] else budget()), \
                 patch.object(self.bridge.api, 'transport', side_effect=lose_repair):
                await asyncio.to_thread(self.bridge.flush, only_id=identity)
            self.assertEqual(len(repairs), 1)
            repair_id = repairs[0]
            repair = self.bridge.store.outbox_row(repair_id)
            self.assertEqual(repair['state'], 'pending')
            self.assertIs(repair['payload']['write_started'], uncertain)
            for field in ('content', 'native_prompt', 'signal', 'signal_metadata', 'requester_activities'):
                self.assertEqual(repair['payload'].get(field), original_question.get(field))
            self.assertEqual(len(retained), int(uncertain))
            clarify.clear_session(key)  # Withdraw the actual Core question before completion.
            summary = 'Completed the delegated verification. Evidence: bounded check passed. Nothing remains.'
            with self.board.conn() as conn:
                self.assertTrue(self.board.kb.complete_task(conn, task.id, summary=summary,
                    expected_run_id=task.current_run_id))
            self.bridge.store = Store(self.bridge.store.path)  # Restart-safe persisted provenance/fence.
            self.bridge.clock = lambda: wall + 180
            self.bridge.store.defer(repair_id, wall + 179)
            await asyncio.to_thread(self.bridge.pump_kanban)
            await asyncio.to_thread(self.bridge.flush)
            self.assertEqual(self.board.get(task.id).status, 'done')
            self.assertEqual(self.provider.issues[self.ISSUE]['state']['type'], 'completed')
            finals = lambda: [a for a in self.provider.activities.values()
                              if a.get('content', {}).get('type') in ('response', 'error')]
            if uncertain:
                self.assertEqual(finals(), [], 'Only the same closing publication waits for the uncertain repair')
                self.assertTrue(self.bridge.store.unsettled_worker_action(self.ISSUE, self.SESSION))
                await asyncio.to_thread(transport, *retained[0])
                self.assertEqual(list(self.provider.activities.values())[-1]['content']['type'], 'elicitation')
                self.bridge.clock = lambda: wall + 300
                await asyncio.to_thread(self.bridge.flush)
                self.bridge.clock = lambda: wall + 420
                await asyncio.to_thread(self.bridge.flush)
            self.assertEqual(len(finals()), 1, 'Worker-derived repair must never invent a second final publisher')
            self.assertEqual(len(self.provider.comment_records), 1)
            self.assertIn(summary, next(iter(self.provider.comment_records.values()))['body'])
            self.assertNotIn(summary, finals()[0]['content']['body'])
            self.assertEqual(list(self.provider.activities.values())[-1]['content']['type'], 'response')
            settled = self.bridge.store.outbox_row(repair_id)
            self.assertEqual(settled['state'], 'sent')
            self.assertEqual(settled['payload']['applied'], int(uncertain))
            self.assertFalse(self.bridge.store.unsettled_worker_action(self.ISSUE, self.SESSION))
            self.assertEqual(len([r for r in self.bridge.store.pending() if
                                  r['payload'].get('worker_step_repair')]), 0)

    async def test_optional_budget_held_worker_question_repair_withdrawn_then_native_completes(self):
        await self.composed_repair(uncertain=False)

    async def test_uncertain_worker_question_repair_lands_after_withdrawal_before_sole_closeout(self):
        await self.composed_repair(uncertain=True)

    async def capture_completed_outcome(self):
        task, _binding, _step = await self.held_worker()
        summary = ('**Delivered**\n\nCompleted the bounded color check.\n\n'
                   '**Evidence**\n\nBlue and Green fixtures both passed.\n\n'
                   '**Remaining**\n\nMonitor the next scheduled check; no settings were changed.')
        with self.board.conn() as conn:
            self.assertTrue(self.board.kb.complete_task(conn, task.id, summary=summary,
                expected_run_id=task.current_run_id))
        with patch.object(self.bridge, 'flush', return_value=0):
            await asyncio.to_thread(self.bridge.pump_kanban)
        comments = [r for r in self.bridge.store.pending() if r['payload'].get('native_outcome_comment')]
        self.assertEqual(len(comments), 1)
        return task, summary, comments[0]

    async def test_regular_top_level_outcome_comment_precedes_short_session_pointer_and_reporter_retry(self):
        from hermes_fleet_linear_plugin.store import Store
        task, summary, comment = await self.capture_completed_outcome()
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(len(self.provider.comment_records), 1)
        remote = self.provider.comment_records[comment['id']]
        self.assertIsNone(remote['parent'])
        self.assertEqual(remote['user']['id'], self.provider.viewer)
        self.assertEqual(remote['issue']['id'], self.ISSUE)
        self.assertEqual(remote['body'], 'Done.\n\n' + summary)
        for heading in ('**Delivered**', '**Evidence**', '**Remaining**'):
            self.assertEqual(remote['body'].count(heading), 1)
        self.assertNotIn(task.id, remote['body'])
        finals = [a for a in self.provider.activities.values() if a.get('content', {}).get('type') == 'response']
        self.assertEqual(len(finals), 1)
        self.assertNotIn(summary, finals[0]['content']['body'])
        pointer = self.bridge.store.outbox_row(finals[0]['id'])
        self.assertTrue(pointer['payload']['native_outcome_pointer'])
        self.assertEqual(pointer['payload']['requires_comment_id'], comment['id'])
        self.assertTrue(self.bridge.store.outcome_comment_applied(pointer['payload']))
        self.bridge.store = Store(self.bridge.store.path)
        await asyncio.to_thread(self.bridge.pump_kanban)
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(len(self.provider.comment_records), 1)
        self.assertEqual(sum(a.get('content', {}).get('type') == 'response' for a in self.provider.activities.values()), 1)

    async def test_lost_outcome_comment_reply_waits_for_readback_then_closes_without_duplicate(self):
        from hermes_fleet_linear_plugin.store import Store
        task, summary, comment = await self.capture_completed_outcome()
        transport, retained = self.bridge.api.transport, []
        def lose(url, body, headers):
            if 'commentCreate' in json.loads(body)['query']:
                retained.append((url, body, headers))
                raise TimeoutError('provider still processing regular completion comment')
            return transport(url, body, headers)
        with patch.object(self.bridge.api, 'transport', side_effect=lose):
            await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(len(retained), 1)
        self.assertEqual(self.board.get(task.id).status, 'done')
        self.assertEqual(self.provider.comment_records, {})
        self.assertFalse(any(a.get('content', {}).get('type') == 'response' for a in self.provider.activities.values()))
        attempted = self.bridge.store.outbox_row(comment['id'])
        self.assertIs(attempted['payload']['write_started'], True)
        await asyncio.to_thread(transport, *retained[0])
        self.bridge.store = Store(self.bridge.store.path)
        self.bridge.store.defer(comment['id'], self.bridge.clock() - 1)
        with patch.object(self.bridge.api, 'create_comment', wraps=self.bridge.api.create_comment) as creates:
            await asyncio.to_thread(self.bridge.flush)
            # Pointer backoff is independently paced; make only its existing row due.
            for row in self.bridge.store.pending():
                if row['payload'].get('native_outcome_pointer'):
                    self.bridge.store.defer(row['id'], self.bridge.clock() - 1)
            await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(creates.call_count, 0, 'The original comment receipt settles without another create')
        self.assertEqual(len(self.provider.comment_records), 1)
        self.assertIn(summary, self.provider.comment_records[comment['id']]['body'])
        self.assertEqual(sum(a.get('content', {}).get('type') == 'response' for a in self.provider.activities.values()), 1)

    async def test_native_stop_refuses_success_comment_and_pointer(self):
        task, _binding, _step = await self.held_worker()
        with self.board.conn() as conn:
            self.assertTrue(self.board.kb.block_task(conn, task.id, reason='Stopped by requester',
                kind='needs_input', expected_run_id=task.current_run_id))
        await asyncio.to_thread(self.bridge.pump_kanban)
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(self.board.get(task.id).status, 'blocked')
        # The stop note is the session's response, which Linear shows in the issue thread;
        # no top-level comment repeats it.
        stopped_note = 'Stopped by requester. It stays stopped until someone asks the agent to resume.'
        self.assertEqual(self.provider.comment_records, {})
        said = [a['content'] for a in self.provider.activities.values() if a.get('content', {}).get('body') == stopped_note]
        self.assertEqual([c['type'] for c in said], ['response'])
        with self.bridge.store._tx() as db:
            reports = [json.loads(row[0]) for row in db.execute('SELECT payload FROM outbox')]
        self.assertFalse(any(p.get('native_outcome_comment') or p.get('native_outcome_pointer') for p in reports))
        self.assertFalse(any('Completed. The result and checks' in a.get('content', {}).get('body', '')
                             for a in self.provider.activities.values()))
        self.assertFalse(any(r['payload'].get('native_outcome_pointer') for r in self.bridge.store.pending()))

    async def test_revoked_actor_before_outcome_publication_refuses_comment_and_pointer(self):
        _task, _summary, _comment = await self.capture_completed_outcome()
        self.bridge.api.specialist_scope = {'allowed_team_ids': ['team-allowed'],
            'allowed_project_ids': ['project-allowed'], 'allowed_requester_ids': ['revoked-human'],
            'requester_basis': 'agent_session'}
        await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(self.provider.comment_records, {})
        self.assertFalse(any(a.get('content', {}).get('type') == 'response' for a in self.provider.activities.values()))

    async def test_nested_or_foreign_closing_receipt_cannot_close_session(self):
        _task, _summary, comment = await self.capture_completed_outcome()
        transport = self.bridge.api.transport
        def nested(url, body, headers):
            result = transport(url, body, headers)
            if 'commentCreate' in json.loads(body)['query']:
                self.provider.comment_records[comment['id']]['parent'] = {'id': 'nested-activity-mirror'}
            return result
        with patch.object(self.bridge.api, 'transport', side_effect=nested):
            await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(len(self.provider.comment_records), 1)
        self.assertEqual(self.bridge.store.outbox_row(comment['id'])['state'], 'pending')
        self.assertFalse(any(a.get('content', {}).get('type') == 'response' for a in self.provider.activities.values()))
        remote = self.provider.comment_records[comment['id']]
        remote['parent'] = None
        remote['user'] = {'id': 'foreign-app'}
        self.assertFalse(await asyncio.to_thread(self.bridge.api.verify_completion_comment,
            comment['id'], self.ISSUE, comment['payload']['body']))
        remote['user'] = {'id': self.provider.viewer}
        del remote['parent']
        self.assertFalse(await asyncio.to_thread(self.bridge.api.verify_completion_comment,
            comment['id'], self.ISSUE, comment['payload']['body']))
        remote['parent'] = None
        for row in self.bridge.store.pending():
            self.bridge.store.defer(row['id'], self.bridge.clock() - 1)
        with patch.object(self.bridge.api, 'create_comment', wraps=self.bridge.api.create_comment) as creates:
            await asyncio.to_thread(self.bridge.flush)
        self.assertEqual(creates.call_count, 0)
        self.assertEqual(len(self.provider.comment_records), 1)
        self.assertEqual(sum(a.get('content', {}).get('type') == 'response' for a in self.provider.activities.values()), 1)
