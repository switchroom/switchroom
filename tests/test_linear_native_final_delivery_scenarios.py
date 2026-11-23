"""Completion publication follows the latest admitted turn, including uncertain sends.

Uses the existing real-Core adapter/bridge fixture; only Linear's HTTP boundary is faked.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

import test_linear_native_prompt_scenarios as prompts

native = prompts.native


@unittest.skipIf(native.CORE is not None, f"native source unavailable ({native.CORE})")
class FinalDeliveryScenarios(unittest.IsolatedAsyncioTestCase):
    delivery = prompts.NativePromptScenarios.delivery
    deliver = prompts.NativePromptScenarios.deliver
    route = prompts.NativePromptScenarios.route
    start_turn = prompts.NativePromptScenarios.start_turn

    async def asyncSetUp(self):
        await prompts.NativePromptScenarios.asyncSetUp(self)
        self.remote = {}
        self.lost = set()
        self.absent = set()
        original = self.bridge.api.transport

        def transport(url, body, headers):
            request = json.loads(body)
            if "query OutboundAgentActivity" in request["query"]:
                record = self.remote.get(request["variables"]["id"])
                if record is None:
                    return 200, {}, json.dumps({"errors": [{"message": "Entity not found: AgentActivity",
                        "extensions": {"code": "INPUT_ERROR"}}]}).encode()
                return 200, {}, json.dumps({"data": {"agentActivity": record}}).encode()
            result = original(url, body, headers)
            if "agentActivityCreate" in request["query"]:
                fields = request["variables"]["input"]
                identity = fields["id"]
                if identity not in self.absent:
                    self.remote.setdefault(identity, {"id": identity, "user": {"id": native.VIEWER},
                        "agentSession": {"id": fields["agentSessionId"]},
                        "content": {"__typename": "AgentActivity" + fields["content"]["type"].capitalize() + "Content",
                                    **{key: value for key, value in fields["content"].items() if key != "type"}}})
                if identity in self.lost or identity in self.absent:
                    raise TimeoutError("fixture lost response")
            return result

        self.bridge.api.transport = transport

    def queue_final(self, source, body="Finished."):
        cursor = self.adapter._input_cursors.get((native.ISSUE, native.SESSION, source), 0)
        return self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION, source, body,
                                             source_cursor=cursor)

    async def flush(self, identity):
        return await asyncio.to_thread(self.bridge.flush, only_id=identity)

    def make_due(self, identity):
        self.store.defer(identity, self.bridge.clock() - 1)

    async def test_successful_action_response_after_other_sender_final(self):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Working on your request.", kind="action", one_try=True)
        other = self.fixture.make_bridge()
        other.native_conversation_state = self.bridge.native_conversation_state
        original = self.bridge.api.transport
        other.api.transport = original
        delivered = []
        once = []

        def receive(url, body, headers):
            request = json.loads(body)
            fields = request.get("variables", {}).get("input", {})
            if "agentActivityCreate" in request["query"]:
                if fields["id"] == row and not once:
                    once.append(True)
                    final = self.native_input.queue_reply(other, native.ISSUE, native.SESSION,
                        native.ACTIVITY, "All work finished.")
                    other.flush(only_id=final)
                    self.assertEqual(other.store.outbox_row(final)["state"], "sent")
                    delivered.append("response")
                delivered.append(fields["content"]["type"])
            return original(url, body, headers)

        self.bridge.api.transport = receive
        await asyncio.to_thread(self.bridge.flush, only_id=row)
        self.assertEqual(self.store.outbox_row(row)["state"], "sent")
        print("INDEPENDENT_SUCCESS_RACE", delivered, flush=True)
        self.assertEqual(delivered[-1], "response", "A successful action crossing final must restore completion")

    async def test_successful_action_response_restores_the_exact_pending_question(self):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Working on your request.", kind="action", one_try=True)
        other = self.fixture.make_bridge()
        other.native_conversation_state = self.bridge.native_conversation_state
        original = self.bridge.api.transport
        other.api.transport = original
        displayed = []
        def receive(url, body, headers):
            request = json.loads(body)
            fields = request.get("variables", {}).get("input", {})
            if "agentActivityCreate" in request["query"] and fields["id"] == row:
                question = self.queue_interim("elicitation")
                other.flush(only_id=question)
                displayed.append(self.posted[-1])
            return original(url, body, headers)
        with patch.object(self.bridge.api, "transport", side_effect=receive):
            await self.flush(row)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["elicitation", "action", "elicitation"])
        self.assertEqual(self.posted[-1]["content"], displayed[0]["content"])
        self.assertEqual(self.posted[-1]["signalMetadata"], displayed[0]["signalMetadata"])
        self.assertEqual(sum(p["id"] == row for p in self.posted), 1)
        self.assertEqual(self.store.outbox_row(row)["state"], "sent")

    def action_budget(self, remaining):
        api = self.bridge.api
        api.budget = {"requests": {"limit": 5000, "remaining": remaining,
            "reset": api.clock() + 3600, "at": api.clock()}}

    async def late_action_budget_case(self, *, lost=False, defer_repair=False):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Working on your request.", kind="action", one_try=True)
        initial = self.store.outbox_row(row)["payload"]["content"]
        if lost:
            self.lost.add(row)
        state = {"live": False, "latest_activity": native.ACTIVITY, "turn_live": True}
        original_transport = self.bridge.api.transport
        original_enqueue = self.bridge.store.enqueue
        requests, repairs = [], []
        def enqueue(kind, payload, **kwargs):
            identity = original_enqueue(kind, payload, **kwargs)
            if payload.get("lifecycle_repair_of"):
                repairs.append(identity)
                if defer_repair:
                    self.action_budget(100)
            return identity
        def receive(url, body, headers):
            request = json.loads(body)
            requests.append(request["query"])
            fields = request.get("variables", {}).get("input", {})
            if "agentActivityCreate" in request["query"] and fields["id"] == row:
                state.update(live=True, latest_activity="newer-input")
                try:
                    return original_transport(url, body, headers)
                finally:
                    if not defer_repair:
                        self.action_budget(100)
            return original_transport(url, body, headers)
        with patch.object(self.bridge, "native_conversation_state", side_effect=lambda payload: state), \
                patch.object(self.bridge.api, "transport", side_effect=receive), \
                patch.object(self.bridge.store, "enqueue", side_effect=enqueue):
            await self.flush(row)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["action"])
        self.assertEqual(self.store.outbox_row(row)["payload"]["content"], initial)
        self.assertEqual(self.store.outbox_row(row)["state"], "sent" if repairs else "pending")
        self.assertIs(self.store.outbox_row(row)["payload"]["write_started"], True)
        pending = repairs[0] if repairs else row
        if repairs:
            self.assertIs(self.store.outbox_row(pending)["payload"]["optional_status_repair"], True)
        self.make_due(pending)
        before = len(requests)
        with patch.object(self.bridge.api, "transport", side_effect=receive):
            await self.flush(pending)
        self.assertEqual(len(requests), before, "Deferred optional restoration must not consume reserve")
        self.action_budget(4000)
        self.lost.clear()
        self.make_due(pending)
        with patch.object(self.bridge, "native_conversation_state", side_effect=lambda payload: state):
            await self.flush(pending)
            await self.flush(row)
        self.assertEqual([p["content"]["type"] for p in self.posted], ["action", "thought"])
        self.assertEqual(sum(p["id"] == row for p in self.posted), 1)
        self.assertEqual(self.store.outbox_row(row)["state"], "sent")
        self.assertEqual(self.store.outbox_row(row)["payload"]["content"], initial)

    async def test_successful_action_budget_drop_defers_restoration_until_reserve_recovers(self):
        await self.late_action_budget_case()

    async def test_uncertain_action_budget_drop_stays_readback_only_then_restores_new_work(self):
        await self.late_action_budget_case(lost=True)

    async def test_deferred_action_repair_retains_optional_budget_on_next_flush(self):
        await self.late_action_budget_case(defer_repair=True)

    async def test_lost_ephemeral_action_is_read_back_without_reposting(self):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Checking the result", kind="action", one_try=True)
        self.lost.add(row)
        await self.flush(row)
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(self.store.outbox_row(row)["state"], "pending")
        self.lost.clear()
        self.make_due(row)
        await self.flush(row)
        self.assertEqual(self.store.outbox_row(row)["state"], "sent")
        self.assertEqual(len(self.posted), 1)

    async def test_new_input_at_action_mutation_admission_prevents_transport(self):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Checking the old request", kind="action", one_try=True)
        state = {"live": True, "latest_activity": native.ACTIVITY, "turn_live": True}
        original = self.bridge.store.admit_mutation
        def admit(identity, **kwargs):
            result = original(identity, **kwargs)
            if identity == row:
                state["latest_activity"] = "new-input-before-ack"
            return result
        with patch.object(self.bridge, "native_conversation_state", side_effect=lambda payload: state), \
                patch.object(self.bridge.store, "admit_mutation", side_effect=admit):
            await self.flush(row)
        self.assertEqual(state["latest_activity"], "new-input-before-ack")
        self.assertEqual(self.posted, [])
        self.assertIs(self.store.outbox_row(row)["payload"]["write_started"], False)

    async def test_lost_action_readback_restores_the_exact_pending_question(self):
        from tools import clarify_gateway as clarify
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Checking the result", kind="action", one_try=True)
        self.lost.add(row)
        await self.flush(row)
        key = self.adapter._core_session_keys(self.messages[0].source)[0]
        self.addCleanup(clarify.clear_session, key)
        clarify.register(clarify_id="action-readback-question", session_key=key,
            question="Which environment?", choices=["staging", "production"])
        question = await self.adapter.send_clarify(native.ISSUE, "Which environment?",
            ["staging", "production"], "action-readback-question", key,
            metadata={"thread_id": native.SESSION})
        self.assertTrue(question.success)
        displayed = self.posted[-1]
        self.lost.clear()
        self.make_due(row)
        await self.flush(row)
        self.assertEqual(self.store.outbox_row(row)["state"], "sent")
        self.assertEqual([p["content"]["type"] for p in self.posted], ["action", "elicitation", "elicitation"])
        restored = self.posted[-1]
        self.assertEqual(restored["content"], displayed["content"])
        self.assertEqual(restored["signalMetadata"], displayed["signalMetadata"])
        self.assertNotEqual(restored["id"], displayed["id"])
        self.assertFalse(self.store.conversation_finished(native.ISSUE, native.SESSION, native.ACTIVITY))

    async def test_final_read_failure_after_admission_retries_without_duplicate(self):
        from hermes_fleet_linear_plugin.api import LinearError
        await self.start_turn()
        final = self.queue_final(native.ACTIVITY)
        original, failures = self.bridge._conversation_final_type, []
        def read(payload, **kwargs):
            if self.store.outbox_row(final)["payload"]["write_started"] is True and not failures:
                failures.append(True)
                raise LinearError("Transient final projection unavailable")
            return original(payload, **kwargs)
        before = len(self.posted)
        with patch.object(self.bridge, "_conversation_final_type", side_effect=read):
            await self.flush(final)
        self.assertTrue(failures)
        self.assertEqual(len(self.posted), before)
        self.assertIs(self.store.outbox_row(final)["payload"]["write_started"], False)
        self.make_due(final)
        await self.flush(final)
        await self.flush(final)
        self.assertEqual(sum(p["id"] == final for p in self.posted), 1)

    async def test_pretransport_cleanup_preserves_concurrent_unknown_final(self):
        from hermes_fleet_linear_plugin.api import LinearError
        await self.start_turn()
        final = self.queue_final(native.ACTIVITY)
        original, failures = self.bridge._conversation_final_type, []
        def read(payload, **kwargs):
            if self.store.outbox_row(final)["payload"]["write_started"] is True and not failures:
                failures.append(True)
                # A second Store admits an unknown send after this guard admitted.
                self.assertTrue(self.store.admit_mutation(final, conversation_attempt_id="other-sender"))
                raise LinearError("Transient final projection unavailable")
            return original(payload, **kwargs)
        with patch.object(self.bridge, "_conversation_final_type", side_effect=read):
            await self.flush(final)
        self.assertTrue(failures)
        self.assertIs(self.store.outbox_row(final)["payload"]["write_started"], True)
        self.assertEqual(self.store.outbox_row(final)["payload"]["conversation_attempt_id"], "other-sender")
        await self.deliver("newer-input", "Check the next part.")
        before = len(self.posted)
        self.make_due(final)
        await self.flush(final)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(final)["state"], "pending")

    async def test_prior_unknown_final_keeps_marker_when_retry_fails_before_transport(self):
        from hermes_fleet_linear_plugin.api import LinearError
        await self.start_turn()
        final = self.queue_final(native.ACTIVITY)
        self.absent.add(final)
        await self.flush(final)  # Transport was entered, but no authoritative effect is visible.
        self.assertIs(self.store.outbox_row(final)["payload"]["write_started"], True)
        admit, read = self.bridge.store.admit_mutation, self.bridge._conversation_final_type
        admitted, failures = [], []
        def admission(row_id, **kwargs):
            result = admit(row_id, **kwargs)
            if row_id == final and result:
                admitted.append(True)
            return result
        def projection(payload, **kwargs):
            if admitted:
                failures.append(True)
                raise LinearError("Transient projection read after retry admission")
            return read(payload, **kwargs)
        before = len(self.posted)
        self.make_due(final)
        with patch.object(self.bridge.store, "admit_mutation", side_effect=admission), patch.object(
                self.bridge, "_conversation_final_type", side_effect=projection):
            await self.flush(final)
        self.assertTrue(failures)
        self.assertEqual(len(self.posted), before)
        self.assertIs(self.store.outbox_row(final)["payload"]["write_started"], True)

    async def test_repair_read_failure_after_admission_retries_same_presentation(self):
        from hermes_fleet_linear_plugin.api import LinearError
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        self.lost.add(first)
        await self.flush(first)
        await self.deliver("newer-input", "Check the next part.")
        original, failures = self.bridge._conversation_repair_current, []
        def read(payload):
            row = self.store.outbox_row(payload["id"])
            if row["payload"]["write_started"] is True and not failures:
                failures.append(row["id"])
                raise LinearError("Transient repair projection unavailable")
            return original(payload)
        self.make_due(first)
        with patch.object(self.bridge, "_conversation_repair_current", side_effect=read):
            await self.flush(first)
        self.assertEqual(len(failures), 1)
        repair = failures[0]
        row = self.store.outbox_row(repair)
        self.assertIs(row["payload"]["write_started"], False)
        self.assertFalse(any(p["id"] == repair for p in self.posted))
        self.make_due(repair)
        await self.flush(repair)
        await self.flush(repair)
        self.assertEqual([p["content"] for p in self.posted if p["id"] == repair], [row["payload"]["content"]])

    async def test_question_lock_failure_after_admission_retries_without_transport(self):
        from contextlib import contextmanager
        from hermes_fleet_linear_plugin.api import LinearError
        await self.start_turn()
        question = self.queue_interim("elicitation")
        original, failures = self.bridge._question_publication_guard, []
        @contextmanager
        def lock(payload):
            if self.store.outbox_row(question)["payload"]["write_started"] is True and not failures:
                failures.append(True)
                raise LinearError("Transient question authority read unavailable")
            with original(payload):
                yield
        before = len(self.posted)
        with patch.object(self.bridge, "_question_publication_guard", side_effect=lock):
            await self.flush(question)
        self.assertTrue(failures)
        self.assertEqual(len(self.posted), before)
        self.assertIs(self.store.outbox_row(question)["payload"]["write_started"], False)
        self.make_due(question)
        await self.flush(question)
        self.assertEqual(sum(p["id"] == question for p in self.posted), 1)

    async def test_late_interim_never_adds_a_second_response_to_a_pr_closeout(self):
        # F28: PR checks no longer hold Done at send; the late interim still never closes twice.
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin import bridge as bridge_module
        task_id = self.fixture.create()
        with self.fixture.board.conn() as conn:
            self.assertIsNotNone(kb.claim_task(conn, task_id, claimer='probe-worker'))
        await asyncio.to_thread(self.bridge.pump_kanban)
        await asyncio.to_thread(self.bridge.flush)
        await self.start_turn()
        interim = self.queue_interim()
        self.lost.add(interim)
        await self.flush(interim)
        self.assertTrue(self.store.outbox_row(interim)['payload']['write_started'])
        with patch.object(bridge_module, 'pr_state', lambda *args, **kwargs: 'merged'):
            with self.fixture.board.conn() as conn:
                kb.complete_task(conn, task_id, summary='Implementation and local checks finished.',
                                 result='https://github.com/example/project/pull/12')
            await asyncio.to_thread(self.bridge.pump_kanban)
            status = self.store.latest_status(native.ISSUE)
            self.assertEqual(status['state'], 'done')
            # The lost interim is retried while the Done closeout is captured but not yet sent.
            self.make_due(interim)
            before = len(self.posted)
            await self.flush(interim)
            self.assertNotIn('response', [p['content']['type'] for p in self.posted[before:]])
            self.make_due(status["id"])
            for _ in range(4):
                await asyncio.to_thread(self.bridge.flush)
            finals = [p for p in self.posted if p["content"]["type"] == "response"]
            self.assertEqual(len(finals), 1)
            self.make_due(interim)
            await self.flush(interim)
            self.assertEqual(len([p for p in self.posted if p["content"]["type"] == "response"]), 1)
            self.assertEqual(sum(p["id"] == interim for p in self.posted), 1)

    async def expired_action_at_transport(self, *, after_admission):
        await self.start_turn()
        row = self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION,
            native.ACTIVITY, "Expiring status", kind="action", one_try=True)
        expiry = self.store.outbox_row(row)["payload"]["expires_at"]
        if after_admission:
            current_time = [self.bridge.clock()]
            original = self.bridge.store.admit_mutation
            def delayed(identity, **kwargs):
                result = original(identity, **kwargs)
                if identity == row:
                    current_time[0] = expiry + 1
                return result
            with patch.object(self.bridge, "clock", side_effect=lambda: current_time[0]), \
                    patch.object(self.bridge.store, "admit_mutation", side_effect=delayed):
                await self.flush(row)
            self.assertGreater(current_time[0], expiry)
        else:
            original = self.bridge._mutate_outbox
            def delayed(*args, **kwargs):
                with patch.object(self.bridge, "clock", return_value=expiry + 1):
                    return original(*args, **kwargs)
            with patch.object(self.bridge, "_mutate_outbox", side_effect=delayed):
                await self.flush(row)
        saved = self.store.outbox_row(row)
        self.assertEqual(saved["state"], "failed")  # Definitively retired, never an uncertain HTTP attempt.
        self.assertIs(saved["payload"]["write_started"], False)
        self.assertEqual(self.posted, [])
        await self.flush(row)
        self.assertEqual(self.posted, [])

    async def test_step_expiry_before_transport_admission_is_retired_without_write(self):
        await self.expired_action_at_transport(after_admission=False)

    async def test_step_expiry_after_transport_admission_is_retired_without_write(self):
        await self.expired_action_at_transport(after_admission=True)

    async def test_response_queued_before_new_input_is_thought_when_delivered(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        self.assertEqual(self.store.outbox_row(first)["payload"]["content"]["type"], "response")
        await self.deliver("newer-input", "Check the next part.")
        self.assertEqual(await self.flush(first), 1)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")
        self.assertFalse(self.store.conversation_finished(native.ISSUE, native.SESSION, "newer-input"))
        self.assertTrue(self.store.conversation_finished(native.ISSUE, native.SESSION, native.ACTIVITY))

    async def test_older_thought_does_not_reopen_after_newer_final(self):
        await self.start_turn()
        await self.deliver("newer-input", "Check the next part.")
        first = self.queue_final(native.ACTIVITY)
        self.assertEqual(self.store.outbox_row(first)["payload"]["content"]["type"], "thought")
        second = self.queue_final("newer-input", "Both parts finished.")
        await self.flush(second)
        count = len(self.posted)
        self.assertEqual(self.posted[-1]["content"]["type"], "response")
        await self.flush(first)
        self.assertEqual(len(self.posted), count)
        self.assertFalse(self.store.outbox_row(first)["payload"]["applied"])
        # Suppression is about publication, not permission for A's progress to resume.
        self.assertTrue(self.store.conversation_finished(native.ISSUE, native.SESSION, native.ACTIVITY))

    async def test_admission_between_projection_and_mutation_defers_then_reprojects(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        original = self.bridge.store.admit_mutation
        raced = []
        def admit(row_id, **kwargs):
            result = original(row_id, **kwargs)
            if row_id == first and not raced:
                raced.append(True)
                self.store.remember_conversation_input(native.ISSUE, native.SESSION, "newer-input", "admission-b", 2, False)
            return result
        before = len(self.posted)
        with patch.object(self.bridge.store, "admit_mutation", side_effect=admit):
            await self.flush(first)
        self.assertEqual(len(self.posted), before, repr(self.posted))
        self.assertIs(self.store.outbox_row(first)["payload"]["write_started"], False)
        self.make_due(first)
        await self.flush(first)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")

    async def test_lost_response_is_settled_read_only_after_newer_turn(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        self.lost.add(first)
        await self.flush(first)
        self.assertTrue(self.store.outbox_row(first)["payload"]["write_started"])
        await self.deliver("newer-input", "Check the next part.")
        before = len(self.posted)
        self.make_due(first)
        await self.flush(first)
        self.assertEqual(len(self.posted), before + 1)
        self.assertNotEqual(self.posted[-1]["id"], first)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")
        self.assertEqual(self.store.outbox_row(first)["state"], "sent")
        self.assertEqual(self.store.outbox_row(first)["payload"]["content"]["type"], "response")

    async def test_lost_thought_is_not_reposted_after_newer_turn_finishes(self):
        await self.start_turn()
        await self.deliver("newer-input", "Check the next part.")
        first = self.queue_final(native.ACTIVITY)
        self.lost.add(first)
        await self.flush(first)
        second = self.queue_final("newer-input", "Both parts finished.")
        await self.flush(second)
        before = len(self.posted)
        self.make_due(first)
        await self.flush(first)
        self.assertEqual(len(self.posted), before + 1)
        self.assertNotEqual(self.posted[-1]["id"], first)
        self.assertEqual(self.store.outbox_row(first)["state"], "sent")
        self.assertEqual(self.store.outbox_row(first)["payload"]["content"]["type"], "thought")
        self.assertEqual(self.posted[-1]["content"]["type"], "response")

    async def test_uncertain_absent_activity_cannot_change_immutable_content(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        self.absent.add(first)
        await self.flush(first)
        await self.deliver("newer-input", "Check the next part.")
        before = len(self.posted)
        self.make_due(first)
        await self.flush(first)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(first)["state"], "pending")
        self.assertEqual(self.store.outbox_row(first)["payload"]["content"]["type"], "response")

    async def test_unscoped_native_done_still_fences_completion(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        self.store.enqueue("activity", {"id": "native-done", "issue_id": native.ISSUE,
            "session_id": native.SESSION, "content": {"type": "response", "body": "Done."}})
        before = len(self.posted)
        await self.flush(first)
        self.assertEqual(len(self.posted), before)
        self.assertFalse(self.store.outbox_row(first)["payload"]["applied"])

    async def test_uncertain_activity_from_another_actor_is_not_settled(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        self.lost.add(first)
        await self.flush(first)
        self.remote[first]["user"]["id"] = native.USER
        self.make_due(first)
        before = len(self.posted)
        await self.flush(first)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(first)["state"], "failed")

    async def test_another_sender_cannot_change_the_already_encoded_body(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        original = self.bridge.store.admit_mutation
        raced = []
        def admit(row_id, **kwargs):
            if row_id == first and not raced:
                raced.append(True)
                self.store.remember_conversation_input(native.ISSUE, native.SESSION, "newer-input", "admission-b", 2, False)
                current = self.store.outbox_row(row_id)["payload"]["content"]
                self.assertTrue(self.store.reproject_conversation_final(row_id, current, {**current, "type": "thought"}))
            return original(row_id, **kwargs)
        before = len(self.posted)
        with patch.object(self.bridge.store, "admit_mutation", side_effect=admit):
            await self.flush(first)
        self.assertEqual(len(self.posted), before)
        self.make_due(first)
        await self.flush(first)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")

    async def test_rejected_sender_cannot_unfreeze_another_unknown_attempt(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        content = self.store.outbox_row(first)["payload"]["content"]
        self.assertTrue(self.store.admit_mutation(first, expected_content=content, conversation_attempt_id="sender-a"))
        self.assertTrue(self.bridge.store.admit_mutation(first, expected_content=content, conversation_attempt_id="sender-b"))
        self.store.conversation_not_attempted(first, "sender-a")
        self.assertTrue(self.store.outbox_row(first)["payload"]["write_started"])
        await self.deliver("newer-input", "Check the next part.")
        before = len(self.posted)
        await self.flush(first)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(first)["state"], "pending")

    async def test_earlier_summary_can_still_post_while_native_work_is_live(self):
        self.fixture.create()
        await self.start_turn()
        await self.deliver("newer-input", "Check the next part.")
        first = self.queue_final(native.ACTIVITY, "First summary.")
        second = self.queue_final("newer-input", "Second summary.")
        await self.flush(second)
        await self.flush(first)
        self.assertEqual(self.posted[-1]["content"], {"type": "thought", "body": "First summary."})

    async def test_unreadable_tracked_work_holds_final_without_guessing_finished(self):
        from hermes_fleet_linear_plugin.api import LinearError
        self.fixture.create()
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        before = len(self.posted)
        with patch.object(self.bridge, "_native_task", side_effect=LinearError("fixture unavailable")):
            await self.flush(first)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(first)["state"], "pending")
        self.assertIs(self.store.outbox_row(first)["payload"]["write_started"], False)
        self.make_due(first)
        await self.flush(first)
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")

    async def test_fresh_admission_cannot_replace_another_unknown_attempt(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        original = self.bridge.store.admit_mutation
        raced = []
        def admit(row_id, **kwargs):
            if row_id == first and not raced:
                raced.append(True)
                content = self.store.outbox_row(first)["payload"]["content"]
                self.assertTrue(self.store.admit_mutation(first, expected_content=content,
                                                         conversation_attempt_id="other-sender"))
                self.store.remember_conversation_input(native.ISSUE, native.SESSION,
                                                       "newer-input", "admission-b", 2, False)
            return original(row_id, **kwargs)
        before = len(self.posted)
        with patch.object(self.bridge.store, "admit_mutation", side_effect=admit):
            await self.flush(first)
        self.assertEqual(len(self.posted), before)
        payload = self.store.outbox_row(first)["payload"]
        self.assertIs(payload["write_started"], True)
        self.assertEqual(payload["conversation_attempt_id"], "other-sender")
        self.make_due(first)
        await self.flush(first)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(first)["state"], "pending")
        self.assertEqual(self.store.outbox_row(first)["payload"]["content"]["type"], "response")

    async def test_late_repair_keeps_its_identity_and_repairs_current_completion(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        self.lost.add(first)
        await self.flush(first)
        await self.deliver("newer-input", "Check the next part.")
        original = self.bridge.api.transport
        delayed = []
        def transport(url, body, headers):
            request = json.loads(body)
            if "agentActivityCreate" in request["query"]:
                fields = request["variables"]["input"]
                if fields["content"]["type"] == "thought":
                    delayed.append((url, body, headers))
                    raise TimeoutError("fixture holds lifecycle repair in flight")
            return original(url, body, headers)
        self.bridge.api.transport = transport
        self.make_due(first)
        await self.flush(first)
        self.assertEqual(len(delayed), 1)
        fields = json.loads(delayed[0][1])["variables"]["input"]
        self.assertNotEqual(fields["id"], first)
        second = self.queue_final("newer-input", "Both parts finished.")
        await self.flush(second)
        self.assertEqual(self.posted[-1]["content"]["type"], "response")
        original(*delayed[0])  # The repair thought lands after B's response.
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")
        self.make_due(fields["id"])
        await self.flush(fields["id"])
        self.assertEqual(self.posted[-1]["content"]["type"], "response")
        self.assertNotEqual(self.posted[-1]["id"], fields["id"])
        self.assertEqual(self.store.outbox_row(fields["id"])["payload"]["content"], fields["content"])
        self.assertEqual(self.store.outbox_row(fields["id"])["state"], "sent")

    async def test_repair_rechecks_completion_before_publication(self):
        await self.start_turn()
        first = self.queue_final(native.ACTIVITY)
        self.lost.add(first)
        await self.flush(first)
        await self.deliver("newer-input", "Check the next part.")
        original = self.bridge.store.admit_mutation
        repair_ids = []
        def admit(row_id, **kwargs):
            payload = self.store.outbox_row(row_id)["payload"]
            if payload.get("lifecycle_repair_of") and not repair_ids:
                repair_ids.append(row_id)
                self.queue_final("newer-input", "Both parts finished.")
            return original(row_id, **kwargs)
        self.make_due(first)
        before = len(self.posted)
        with patch.object(self.bridge.store, "admit_mutation", side_effect=admit):
            await self.flush(first)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(len(repair_ids), 1)
        self.make_due(repair_ids[0])
        await self.flush(repair_ids[0])
        self.assertEqual(self.posted[-1]["content"]["type"], "response")

    def queue_interim(self, kind="thought"):
        prompt = None
        if kind == "elicitation":
            from tools import clarify_gateway as clarify
            key = self.adapter._core_session_keys(self.messages[0].source)[0]
            clarify.register(clarify_id="probe", session_key=key, question="Which environment?",
                             choices=["staging", "production"])
            self.addCleanup(clarify.clear_session, key)
            prompt = {"kind": "clarify", "clarify_id": "probe", "session_key": key,
                      "question": "Which environment?", "choices": ["staging", "production"], "multi_select": False}
        return self.native_input.queue_reply(self.bridge, native.ISSUE, native.SESSION, native.ACTIVITY,
            "An interim update." if kind == "thought" else "Which environment?", kind=kind,
            nonce="interim-probe", one_try=kind == "thought", native_prompt=prompt,
            signal="select" if kind == "elicitation" else None,
            signal_metadata={"options": [{"value": "staging"}, {"value": "production"}]}
                            if kind == "elicitation" else None)

    async def test_attempted_interim_absent_readback_never_reposts(self):
        await self.start_turn()
        interim = self.queue_interim()
        self.absent.add(interim)
        await self.flush(interim)
        self.assertEqual(self.store.outbox_row(interim)["state"], "pending")
        before = len(self.posted)
        self.make_due(interim)
        await self.flush(interim)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(interim)["state"], "pending")
        self.assertTrue(self.store.outbox_row(interim)["payload"]["write_started"])

    async def test_attempted_interim_settles_read_only_while_turn_is_live(self):
        await self.start_turn()
        interim = self.queue_interim()
        self.lost.add(interim)
        await self.flush(interim)
        self.assertEqual(self.store.outbox_row(interim)["state"], "pending")
        before = len(self.posted)
        self.make_due(interim)
        await self.flush(interim)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(interim)["state"], "sent")
        self.assertEqual(self.posted[-1]["content"]["type"], "thought")

    async def test_legacy_retired_uncertain_interim_is_recovered_for_readback_only(self):
        await self.start_turn()
        interim = self.queue_interim()
        self.lost.add(interim)
        await self.flush(interim)
        # Previous versions retired the ambiguous one-try row without a rejection verdict.
        with self.store._tx() as db:
            db.execute("UPDATE outbox SET state='failed',attempts=0 WHERE id=?", (interim,))
        final = self.queue_final(native.ACTIVITY)
        await self.flush(final)
        before = len(self.posted)
        self.make_due(interim)
        await self.flush(interim)
        self.assertEqual(len(self.posted), before + 1)
        self.assertEqual(self.posted[-1]["content"]["type"], "response")
        self.assertNotEqual(self.posted[-1]["id"], interim)
        self.assertEqual(self.store.outbox_row(interim)["payload"]["content"]["type"], "thought")
        self.assertEqual(self.store.outbox_row(interim)["state"], "sent")

    async def test_live_question_uncertainty_keeps_awaiting_input_and_exact_content(self):
        await self.start_turn()
        question = self.queue_interim("elicitation")
        self.lost.add(question)
        await self.flush(question)
        saved = self.store.outbox_row(question)["payload"]
        before = len(self.posted)
        self.make_due(question)
        await self.flush(question)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.posted[-1]["content"]["type"], "elicitation")
        self.assertEqual(self.store.outbox_row(question)["state"], "sent")
        self.assertEqual(self.store.outbox_row(question)["payload"]["native_prompt"], saved["native_prompt"])
        self.assertEqual(self.store.outbox_row(question)["payload"]["content"], saved["content"])
        self.assertEqual(self.store.outbox_row(question)["payload"]["signal_metadata"], saved["signal_metadata"])
        self.assertEqual(self.posted[-1]["signalMetadata"], saved["signal_metadata"])

    async def test_late_question_after_completion_repairs_without_replaying_question(self):
        await self.start_turn()
        question = self.queue_interim("elicitation")
        self.lost.add(question)
        await self.flush(question)
        final = self.queue_final(native.ACTIVITY)
        await self.flush(final)
        before = len(self.posted)
        self.make_due(question)
        await self.flush(question)
        self.assertEqual(len(self.posted), before + 1)
        self.assertEqual(self.posted[-1]["content"]["type"], "response")
        self.assertNotEqual(self.posted[-1]["id"], question)
        self.assertEqual(self.store.outbox_row(question)["payload"]["content"]["type"], "elicitation")
        self.assertEqual(self.store.outbox_row(question)["state"], "sent")

    async def test_interim_rechecks_completion_at_mutation_admission(self):
        await self.start_turn()
        interim = self.queue_interim()
        original = self.bridge.store.admit_mutation
        def admit(row_id, **kwargs):
            result = original(row_id, **kwargs)
            if row_id == interim:
                self.queue_final(native.ACTIVITY)
            return result
        before = len(self.posted)
        with patch.object(self.bridge.store, "admit_mutation", side_effect=admit):
            await self.flush(interim)
        self.assertEqual(len(self.posted), before)
        self.assertIs(self.store.outbox_row(interim)["payload"]["write_started"], False)
        self.assertEqual(self.store.outbox_row(interim)["state"], "failed")

    async def test_older_final_reply_without_turn_marker_is_not_an_interim(self):
        await self.start_turn()
        for kind in ("response", "error"):
            with self.subTest(kind=kind):
                final = self.queue_final(native.ACTIVITY, "Legacy " + kind + ".")
                payload = self.store.outbox_row(final)["payload"]
                payload.pop("turn_final")
                payload["content"]["type"] = kind
                self.store.rewrite(final, payload, self.bridge.clock())
                await self.flush(final)
                self.assertEqual(self.store.outbox_row(final)["state"], "sent")
                self.assertEqual(self.posted[-1]["content"], payload["content"])

    async def test_rate_limit_does_not_clear_an_earlier_unknown_final_attempt(self):
        await self.start_turn()
        final = self.queue_final(native.ACTIVITY)
        self.absent.add(final)
        await self.flush(final)
        self.assertTrue(self.store.outbox_row(final)["payload"]["write_started"])
        original = self.bridge.api.transport
        def transport(url, body, headers):
            if "agentActivityCreate" in json.loads(body)["query"]:
                return 429, {"Retry-After": "1"}, b"{}"
            return original(url, body, headers)
        self.bridge.api.transport = transport
        self.make_due(final)
        await self.flush(final)
        self.assertTrue(self.store.outbox_row(final)["payload"]["write_started"])
        self.assertEqual(self.store.outbox_row(final)["state"], "pending")

    async def test_partial_rate_limit_response_preserves_question_uncertainty(self):
        await self.start_turn()
        question = self.queue_interim("elicitation")
        original = self.bridge.api.transport
        creates = []
        def transport(url, body, headers):
            request = json.loads(body)
            if "agentActivityCreate" in request["query"]:
                creates.append(request["variables"]["input"])
                return 200, {}, json.dumps({"data": {"agentActivityCreate": {"success": True}},
                    "errors": [{"message": "partial rate limit", "extensions": {"code": "RATELIMITED"}}]}).encode()
            return original(url, body, headers)
        self.bridge.api.transport = transport
        await self.flush(question)
        self.assertTrue(self.store.outbox_row(question)["payload"]["write_started"])
        self.bridge.api.paused_until = 0
        self.make_due(question)
        await self.flush(question)
        self.assertEqual(len(creates), 1)
        self.assertTrue(self.store.outbox_row(question)["payload"]["write_started"])
        self.assertEqual(self.store.outbox_row(question)["state"], "pending")

    async def test_legacy_error_readback_preserves_immutable_error_content(self):
        await self.start_turn()
        final = self.queue_final(native.ACTIVITY, "The earlier request failed.")
        payload = self.store.outbox_row(final)["payload"]
        payload.pop("turn_final")
        payload.pop("write_started")
        payload.pop("source_activity")
        payload.pop("turn_activity")
        payload.pop("source_cursor")
        payload["content"]["type"] = "error"
        self.store.rewrite(final, payload, self.bridge.clock())
        self.remote[final] = {"id": final, "user": {"id": native.VIEWER},
            "agentSession": {"id": native.SESSION},
            "content": {"__typename": "AgentActivityErrorContent", "body": payload["content"]["body"]}}
        before = len(self.posted)
        await self.flush(final)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(final)["state"], "sent")
        self.assertEqual(self.store.outbox_row(final)["payload"]["content"], payload["content"])

    async def test_legacy_final_thought_readback_restores_completed_session(self):
        await self.start_turn()
        await self.deliver("newer-input", "Finish the current part.")
        old = self.queue_final(native.ACTIVITY, "Previous result is ready.")
        original = self.store.outbox_row(old)["payload"]
        legacy = {key: original[key] for key in ("id", "issue_id", "session_id", "content", "content_action",
                  "unlinked_content", "native_reply_version", "requester_sessions", "requester_activities")}
        self.assertEqual(legacy["content"]["type"], "thought")
        self.store.rewrite(old, legacy, self.bridge.clock())
        self.lost.add(old)
        await self.flush(old)
        final = self.queue_final("newer-input", "Everything is complete.")
        await self.flush(final)
        before = len(self.posted)
        self.make_due(old)
        await self.flush(old)
        self.assertEqual(len(self.posted), before + 1)
        self.assertEqual(self.posted[-1]["content"]["type"], "response")
        self.assertNotEqual(self.posted[-1]["id"], old)
        self.assertEqual(self.store.outbox_row(old)["payload"]["content"], legacy["content"])
        self.assertEqual(self.store.outbox_row(old)["state"], "sent")

    async def test_ambiguous_modern_thought_without_attempt_marker_stays_readback_only(self):
        await self.start_turn()
        interim = self.queue_interim()
        payload = self.store.outbox_row(interim)["payload"]
        payload.pop("write_started")
        payload.pop("turn_final", None)
        self.store.rewrite(interim, payload, self.bridge.clock())
        before = len(self.posted)
        for _ in range(2):
            self.make_due(interim)
            await self.flush(interim)
        self.assertEqual(len(self.posted), before)
        self.assertEqual(self.store.outbox_row(interim)["state"], "pending")
        self.assertNotIn("turn_final", self.store.outbox_row(interim)["payload"])
