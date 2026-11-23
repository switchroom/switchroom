"""Real native admission under the one-owner rule; no fabricated client or approval context.

An assignment creates its one task ready with the ``linear:<issue_id>`` idempotency key after
the admission checks; Stop is upstream's plain block. Nothing here needs the fork's guarded
block/unblock controls."""
from __future__ import annotations

import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import test_linear_native_bridge_scenarios as scenarios


@unittest.skipUnless(os.environ.get("HERMES_AGENT_SRC"), "requires explicit native source")
class GuardedAdmissionScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = scenarios.NativeBridgeScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.board, self.bridge, self.store = self.fixture.board, self.fixture.bridge, self.fixture.store

    def assign(self):
        self.bridge.handle_webhook(self.fixture.event())
        return self.store.get(scenarios.ISSUE)["task_id"]

    def prepared_chat_task(self):
        task = self.board.create(title="Fresh chat-origin outcome", initial_status="blocked")
        self.bridge.track(scenarios.ISSUE, task.id, requester_session=scenarios.SESSION)
        return task.id

    def pending_contents(self):
        return [row["payload"]["content"] for row in self.store.pending()
                if row["kind"] == "activity"]

    def test_pristine_chat_preparation_reports_no_human_input_or_activation(self):
        task_id = self.prepared_chat_task()
        self.bridge.pump_kanban()
        contents = self.pending_contents()
        self.assertFalse(any(content["type"] == "elicitation" for content in contents))
        self.assertTrue(any(content["type"] == "thought" and content["body"].startswith("Queued.")
                            and "nothing is needed from you" in content["body"] for content in contents))
        self.assertFalse(any("admission" in (content.get("body") or "") for content in contents))
        self.assertEqual(self.board.get(task_id).status, "blocked")
        events = self.board.history(task_id, 0)
        self.assertEqual([event.kind for event in events], ["created", "blocked"])
        self.assertEqual(self.store.get(scenarios.ISSUE)["last_event_id"], events[-1].id)
        # A repeated reporting pump advances no work and duplicates no notice.
        before = self.store.pending()
        self.bridge.pump_kanban()
        self.assertEqual(self.store.pending(), before)

    def test_preparation_reporting_does_not_mask_later_operator_stop(self):
        task_id = self.prepared_chat_task()
        self.bridge.pump_kanban()
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.block_task(conn, task_id, reason="operator Stop", kind="needs_input"))
        self.bridge.pump_kanban()
        self.assertTrue(any(content["type"] == "elicitation" and "operator Stop" in content["body"]
                            for content in self.pending_contents()))
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_later_block_cannot_impersonate_creation_by_reusing_initial_reason(self):
        task_id = self.prepared_chat_task()
        self.bridge.pump_kanban()
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.block_task(conn, task_id, reason="initial_status", kind="needs_input"))
        self.bridge.pump_kanban()
        self.assertTrue(any(content["type"] == "elicitation" and "initial_status" in content["body"]
                            for content in self.pending_contents()))

    def test_nonblocked_creation_does_not_prove_initial_preparation(self):
        task = self.board.create(title="Existing running outcome", initial_status="running")
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.block_task(conn, task.id, reason="initial_status", kind="needs_input"))
        self.bridge.track(scenarios.ISSUE, task.id, requester_session=scenarios.SESSION)
        self.bridge.pump_kanban()
        self.assertTrue(any(content["type"] == "elicitation" for content in self.pending_contents()))
        self.assertEqual(self.board.get(task.id).status, "blocked")

    def test_pure_upstream_controls_start_and_stop_an_assignment(self):
        """With only upstream's control keywords (no fork event guards), work starts instead of parking."""
        kb, fork_only = self.board.kb, {"expected_event_id", "request_id", "count_recurrence", "source",
                                         "notify_target", "transient_hold"}
        def upstream(name):
            original = getattr(kb, name)
            def call(conn, *args, **kwargs):
                self.assertFalse(fork_only & set(kwargs), (name, kwargs))
                return original(conn, *args, **kwargs)
            return patch.object(kb, name, call)
        stamp = time.time()
        with upstream("create_task"), upstream("block_task"), upstream("unblock_task"):
            self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
            task_id = self.store.get(scenarios.ISSUE)["task_id"]
            self.assertEqual(self.board.get(task_id).status, "ready")
            self.assertEqual(self.board.get(task_id).idempotency_key, f"linear:{scenarios.ISSUE}")
            self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
            self.assertEqual(len(self.fixture.tasks()), 1)
            self.assertTrue(self.bridge.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 0.01)))
            self.assertEqual(self.board.get(task_id).status, "blocked")
            self.bridge.tick()
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_delayed_preparation_event_does_not_replace_actual_running_progress(self):
        task_id = self.prepared_chat_task()
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.unblock_task(conn, task_id))
            self.assertIsNotNone(scenarios.kb.claim_task(conn, task_id, claimer="current-worker"))
        self.bridge.pump_kanban()
        self.assertFalse(any(content["type"] == "elicitation" or "prepared" in content.get("body", "")
                             for content in self.pending_contents()))
        self.assertEqual(self.board.get(task_id).status, "running")

    def test_assignment_reaches_native_ready_without_manual_activation(self):
        task_id = self.assign()
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.bridge.handle_webhook(self.fixture.event())
        self.assertEqual(len(self.fixture.tasks()), 1)
        self.assertEqual([event.kind for event in self.board.history(task_id, 0)], ["created"])

    def test_assignment_creation_preserves_outcome_snapshot_through_native_completion(self):
        import copy
        task_id = self.assign()
        before = self.board.get(task_id)
        self.assertEqual(before.status, "ready")
        binding = copy.deepcopy(self.store.native_binding(scenarios.ISSUE))
        self.assertEqual(binding["completion_scope"]["mode"], "outcome")
        self.assertFalse(any(event.kind == "specified" for event in self.board.history(task_id, 0)))
        self.assertEqual(sum(event.kind == "unblocked" for event in self.board.history(task_id, 0)), 0)
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.complete_task(conn, task_id,
                result="Verified the assigned outcome and retained the final deliverable."))
        after = self.board.get(task_id)
        self.assertEqual((after.title, after.body, after.completion_contract),
                         (before.title, before.body, before.completion_contract))
        self.bridge.pump_kanban()
        self.assertEqual(self.store.native_binding(scenarios.ISSUE), binding)
        self.assertTrue(any(row["kind"] == "status" and row["payload"].get("state") == "done"
                            for row in self.store.pending()))
        self.assertTrue(any(row["kind"] == "project_update" for row in self.store.pending()))
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_stop_during_creation_is_never_undone(self):
        create = self.board.create
        def stopped(**fields):
            task = create(**fields)
            with self.board.conn() as conn:
                self.assertTrue(scenarios.kb.block_task(conn, task.id, reason="operator Stop", kind="needs_input"))
            return task
        with patch.object(self.board, "create", side_effect=stopped):
            task_id = self.assign()
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertFalse(any(event.kind == "unblocked" for event in self.board.history(task_id, 0)))

    def test_linear_stop_recorded_while_the_task_is_created_wins(self):
        stopper, create, stamp = self.fixture.make_bridge(), self.board.create, time.time()
        def stopped_meanwhile(**fields):
            # Another service instance takes the Stop before this binding commits: it is recorded unbound.
            stopper.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 0.01))
            return create(**fields)
        with patch.object(self.board, "create", side_effect=stopped_meanwhile):
            self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.fixture.make_bridge().recover()
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_crash_after_binding_leaves_one_ready_task(self):
        with patch.object(self.board, "subscribe", side_effect=ConnectionError("crash after binding")):
            with self.assertRaises(ConnectionError):
                self.bridge.handle_webhook(self.fixture.event())
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        self.assertEqual(self.board.get(task_id).status, "ready")
        restarted = self.fixture.make_bridge()
        restarted.recover()
        restarted.handle_webhook(self.fixture.event())
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.assertEqual(len(self.fixture.tasks()), 1)

    def lost_creation_reply(self):
        create = self.board.create
        def lost(**fields):
            create(**fields)
            raise ConnectionError("lost native creation reply")
        with patch.object(self.board, "create", side_effect=lost):
            with self.assertRaises(ConnectionError):
                self.bridge.handle_webhook(self.fixture.event())
        (task_id,) = [row["id"] for row in self.fixture.tasks()]
        self.assertIsNone(self.store.get(scenarios.ISSUE))
        return task_id

    def test_lost_creation_reply_is_reconciled_by_its_key_without_a_second_task(self):
        task_id = self.lost_creation_reply()
        self.fixture.make_bridge().handle_webhook(self.fixture.event())  # the provider redelivers
        self.assertEqual(self.store.get(scenarios.ISSUE)["task_id"], task_id)
        self.assertEqual([event.kind for event in self.board.history(task_id, 0)], ["created"])
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_newer_stop_after_lost_creation_reply_is_never_undone(self):
        task_id = self.lost_creation_reply()
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.block_task(conn, task_id, reason="newer Stop", kind="needs_input"))
        self.fixture.make_bridge().handle_webhook(self.fixture.event())
        self.fixture.make_bridge().recover()
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertEqual(sum(event.kind == "unblocked" for event in self.board.history(task_id, 0)), 0)

    def test_linking_existing_parked_task_does_not_activate_it_on_upgrade(self):
        task = self.board.create(title="Previously parked", initial_status="blocked")
        self.bridge.track(scenarios.ISSUE, task.id)
        self.bridge.recover()
        self.assertEqual(self.board.get(task.id).status, "blocked")

    def test_status_exposes_verified_local_executor_for_chat_origin_creation(self):
        status = self.bridge.native_status(scenarios.ISSUE)
        self.assertFalse(status["linked"])
        self.assertEqual(status["local"], {"profile": "default", "board": "default"})

    def test_current_linear_stop_stops_initial_queued_work_in_same_second(self):
        stamp = time.time()
        event = self.fixture.event(stamp=stamp)
        self.bridge.handle_webhook(event)
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.bridge.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 0.001))
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.fixture.make_bridge().recover()
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_delayed_linear_stop_cannot_override_a_later_native_resume(self):
        stamp = time.time()
        self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.block_task(conn, task_id, reason="native Stop", kind="needs_input"))
            self.assertTrue(scenarios.kb.unblock_task(conn, task_id))
        self.bridge.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 0.001))
        self.assertEqual(self.board.get(task_id).status, "ready")

    def test_no_row_stop_is_carried_into_a_concurrently_committed_native_binding(self):
        stopper = self.fixture.make_bridge()
        saw_none, continue_stop, stop_done = threading.Event(), threading.Event(), threading.Event()
        get, subscribe = stopper.store.get, self.board.subscribe
        def snapshot(issue_id):
            row = get(issue_id)
            if threading.current_thread().name.startswith("stop") and not saw_none.is_set():
                self.assertIsNone(row)
                saw_none.set()
                self.assertTrue(continue_stop.wait(5))
            return row
        def after_stop(*args, **kwargs):  # the binding has committed; the Stop now reads it
            continue_stop.set()
            self.assertTrue(stop_done.wait(5))
            return subscribe(*args, **kwargs)
        stamp = time.time()
        def stop():
            try:
                stopper.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 0.01))
            finally:
                stop_done.set()
        with patch.object(stopper.store, "get", side_effect=snapshot), patch.object(self.board, "subscribe", side_effect=after_stop):
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="stop") as pool:
                request = pool.submit(stop)
                self.assertTrue(saw_none.wait(5))
                self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
                request.result(5)
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        self.fixture.make_bridge().recover()
        self.assertEqual(self.board.get(task_id).status, "blocked")
        with self.board.conn() as conn:
            self.assertIsNone(scenarios.kb.claim_task(conn, task_id, claimer="must-not-start"))

    def test_unavailable_binding_does_not_abort_other_recovery_or_reporting(self):
        from hermes_cli.kanban_db_boards import create_board, remove_board
        create_board("project")
        board = self.board.for_board("project")
        bridge = scenarios.Bridge(self.store, self.fixture.authority.api(scope=None), board, profile="default")
        bridge.handle_webhook(self.fixture.event())
        remove_board("project")
        restarted = self.fixture.make_bridge()
        with patch.object(restarted, "pump_kanban", wraps=restarted.pump_kanban) as pump:
            restarted.recover()
            self.assertEqual(pump.call_count, 1)

    def test_lost_creation_reply_still_accepts_current_same_second_stop(self):
        now = int(time.time()) + 0.1
        create = self.board.create
        def lost(**fields):
            create(**fields)
            raise ConnectionError("lost successful native response")
        with patch("time.time", return_value=now), patch.object(self.board, "create", side_effect=lost):
            with self.assertRaises(ConnectionError):
                self.bridge.handle_webhook(self.fixture.event(stamp=now))
        (task_id,) = [row["id"] for row in self.fixture.tasks()]
        with patch("time.time", return_value=now):
            self.bridge.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=now + 0.1))  # still unbound
            self.fixture.make_bridge().handle_webhook(self.fixture.event(stamp=now))  # the redelivery binds it
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_same_second_linear_followup_reaches_existing_native_run(self):
        now = int(time.time()) + 0.1
        with patch("time.time", return_value=now):
            self.bridge.handle_webhook(self.fixture.event(stamp=now))
            task_id = self.store.get(scenarios.ISSUE)["task_id"]
            with self.board.conn() as conn:
                native = scenarios.kb.claim_task(conn, task_id, claimer="native-test-worker")
            self.bridge.handle_webhook(self.fixture.event("prompted", body="use the v2 endpoint", stamp=now + 0.1))
        self.assertEqual([comment.body for comment in self.fixture.comments(task_id)], ["use the v2 endpoint"])
        self.assertEqual(self.board.get(task_id).current_run_id, native.current_run_id)

    def test_restart_recovers_creation_receipt_lost_after_binding(self):
        settle = self.store.native_intent_settle
        def lost(key, updates):
            if key == f"create:{scenarios.ISSUE}" and updates.get("state") == "applied":
                raise ConnectionError("crash after binding before creation receipt")
            return settle(key, updates)
        with patch.object(self.bridge.store, "native_intent_settle", side_effect=lost):
            with self.assertRaises(ConnectionError):
                self.bridge.handle_webhook(self.fixture.event())
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        self.fixture.make_bridge().recover()
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.assertEqual(len(self.fixture.tasks()), 1)

    def test_transient_failure_carrying_a_recorded_stop_retries_in_existing_service_loop(self):
        stamp = time.time()
        self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        self.store.record_unbound_stop(scenarios.ISSUE, (stamp + 0.01) * 1000, session_id=scenarios.SESSION,
                                       activity_id=scenarios.ACTIVITY, actor=scenarios.USER)
        restarted = self.fixture.make_bridge()
        with patch.object(restarted, "_pending_assignment_stop", side_effect=scenarios.LinearError("temporary read outage")):
            restarted.recover()
        self.assertEqual(self.board.get(task_id).status, "ready")
        restarted.tick()
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_lost_stop_response_cannot_cancel_a_later_native_resume_on_retry(self):
        stamp = time.time()
        self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        event = self.fixture.event("prompted", signal="stop", stamp=stamp + 0.01)
        stop = self.board.stop
        def lost(*args, **kwargs):
            self.assertTrue(stop(*args, **kwargs))
            raise ConnectionError("lost Stop response")
        with patch.object(self.board, "stop", side_effect=lost):
            with self.assertRaises(ConnectionError):
                self.bridge.handle_webhook(event)
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.unblock_task(conn, task_id))
        self.fixture.make_bridge().handle_webhook(event)
        self.assertEqual(self.board.get(task_id).status, "ready")

    def test_recorded_no_row_stop_survives_handler_crash_before_native_control(self):
        stamp = time.time()
        self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        stopper = self.fixture.make_bridge()
        get = stopper.store.get
        reads = []
        def stale(issue_id):
            reads.append(issue_id)
            return None if len(reads) == 1 else get(issue_id)
        with patch.object(stopper.store, "get", side_effect=stale):
            with patch.object(stopper, "_pending_assignment_stop", side_effect=ConnectionError("handler crash")):
                with self.assertRaises(ConnectionError):
                    stopper.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 0.01))
        self.assertEqual(self.board.get(task_id).status, "ready")
        self.fixture.make_bridge().recover()
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_changed_creation_is_reported_once_without_restart_notice_spam(self):
        create = self.board.create
        def stopped(**fields):
            task = create(**fields)
            with self.board.conn() as conn:
                self.assertTrue(scenarios.kb.block_task(conn, task.id, reason="operator Stop", kind="needs_input"))
            return task
        with patch.object(self.board, "create", side_effect=stopped):
            self.assign()
        def notices():
            return [row for row in self.store.pending() if
                    (row["payload"].get("content") or {}).get("body", "").startswith("The task changed right after it was created")]
        before = len(notices())
        self.fixture.make_bridge().recover()
        self.fixture.make_bridge().recover()
        self.assertEqual(len(notices()), before)

    # -- Linear Stop reaches the actual work and stays effective --------------

    def claimed_assignment(self, stamp):
        with patch("time.time", return_value=stamp + 0.5):
            self.bridge.handle_webhook(self.fixture.event(stamp=stamp))
        task_id = self.store.get(scenarios.ISSUE)["task_id"]
        with patch("time.time", return_value=stamp + 2), self.board.conn() as conn:
            # An earlier human pause/resume, so no initial-admission inference
            # applies: only real event ordering decides the later Stop.
            self.assertTrue(scenarios.kb.block_task(conn, task_id, reason="earlier pause"))
            self.assertTrue(scenarios.kb.unblock_task(conn, task_id))
        with self.board.conn() as conn:
            # The dispatcher picks the work up after the human clicked Stop
            # (stamp + 5) but before the Stop webhook was processed.
            self.assertIsNotNone(scenarios.kb.claim_task(conn, task_id, claimer="native-test-worker"))
        return task_id

    def test_dispatcher_pickup_after_linear_stop_click_does_not_override_it(self):
        stamp = int(time.time()) - 20 + 0.1
        task_id = self.claimed_assignment(stamp)
        self.assertTrue(any(event.kind == "claimed" and event.created_at > stamp + 5
                            for event in self.board.history(task_id, 0)))
        self.assertTrue(self.bridge.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 5)))
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.fixture.make_bridge().recover()
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def test_explicit_resume_after_linear_stop_click_still_supersedes_it(self):
        stamp = int(time.time()) - 20 + 0.1
        task_id = self.claimed_assignment(stamp)
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.block_task(conn, task_id, reason="native Stop", kind="needs_input"))
            self.assertTrue(scenarios.kb.unblock_task(conn, task_id))
        self.assertTrue(self.bridge.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 5)))
        self.assertEqual(self.board.get(task_id).status, "ready")

    def test_transient_error_on_first_linear_stop_attempt_is_retried(self):
        stamp = int(time.time()) - 20 + 0.1
        task_id = self.claimed_assignment(stamp)
        event = self.fixture.event("prompted", signal="stop", stamp=stamp + 5)
        with patch.object(self.board, "stop", side_effect=scenarios.LinearError("temporary native outage")):
            self.assertFalse(self.bridge.handle_webhook(event))
        self.assertEqual(self.board.get(task_id).status, "running")
        # Provider redelivery (or a restart) retries the same Stop and applies it.
        self.assertTrue(self.fixture.make_bridge().handle_webhook(event))
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertTrue(self.fixture.make_bridge().handle_webhook(event))
        self.assertEqual(sum(event.kind == "blocked" for event in self.board.history(task_id, 0)), 2)  # pause, Stop

    def test_unverified_stop_recorded_by_input_seam_is_retried(self):
        stamp = int(time.time()) - 20 + 0.1
        task_id = self.claimed_assignment(stamp)
        binding = self.store.native_binding(scenarios.ISSUE)
        # Exactly what native_input._handle_control records when the first
        # attempt failed before the bridge prepared its own Stop request.
        key = f"stop:{scenarios.ISSUE}:{scenarios.ACTIVITY}"
        self.store.native_intent_prepare(key, {"kind": "stop", "issue_id": scenarios.ISSUE,
            "task_id": binding["task_id"], "profile": binding["profile"], "board": binding["board"],
            "stamp": (stamp + 5) * 1000, "control": "native-event-guard-v1",
            "expected_event_id": None, "run_id": None})
        self.store.native_intent_settle(key, {"state": "reconcile", "reason": "Native task Stop was not verified"})
        self.assertTrue(self.bridge.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 5)))
        self.assertEqual(self.board.get(task_id).status, "blocked")

    def started_tasks(self, task_id):
        with self.board.conn() as conn:
            child = scenarios.kb.create_task(conn, title="child", assignee="default", creator_task_id=task_id)
            grandchild = scenarios.kb.create_task(conn, title="grandchild", assignee="default", creator_task_id=child)
            finished = scenarios.kb.create_task(conn, title="finished", assignee="default", creator_task_id=task_id)
            self.assertTrue(scenarios.kb.complete_task(conn, finished, result="done"))
            unrelated = scenarios.kb.create_task(conn, title="unrelated", assignee="default")
            self.assertIsNotNone(scenarios.kb.claim_task(conn, child, claimer="native-test-worker"))
        return child, grandchild, finished, unrelated

    def test_linear_stop_reaches_tasks_the_stopped_worker_started(self):
        stamp = int(time.time()) - 20 + 0.1
        task_id = self.claimed_assignment(stamp)
        child, grandchild, finished, unrelated = self.started_tasks(task_id)
        self.assertTrue(self.bridge.handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 5)))
        status = lambda tid: self.board.get(tid).status
        self.assertEqual([status(task_id), status(child), status(grandchild)], ["blocked"] * 3)
        self.assertEqual(status(finished), "done")
        self.assertEqual(status(unrelated), "ready")
        # A human resuming one started task is final; redelivery never re-stops it.
        with self.board.conn() as conn:
            self.assertTrue(scenarios.kb.unblock_task(conn, grandchild))
        self.assertTrue(self.fixture.make_bridge().handle_webhook(self.fixture.event("prompted", signal="stop", stamp=stamp + 5)))
        self.assertEqual(status(grandchild), "ready")

    def test_started_tasks_are_stopped_on_retry_after_partial_stop(self):
        stamp = int(time.time()) - 20 + 0.1
        task_id = self.claimed_assignment(stamp)
        child, grandchild, _, _ = self.started_tasks(task_id)
        event = self.fixture.event("prompted", signal="stop", stamp=stamp + 5)
        with patch.object(self.board, "stop_started", side_effect=ConnectionError("crash after parent Stop")):
            with self.assertRaises(ConnectionError):
                self.bridge.handle_webhook(event)
        self.assertEqual(self.board.get(task_id).status, "blocked")
        self.assertEqual(self.board.get(child).status, "running")
        self.assertTrue(self.fixture.make_bridge().handle_webhook(event))
        self.assertEqual([self.board.get(tid).status for tid in (task_id, child, grandchild)], ["blocked"] * 3)


if __name__ == "__main__":
    unittest.main()
