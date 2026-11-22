"""Owner side of a takeover against the pinned native owner, Kanban and receipts.

``handoff.hand_off`` runs in the profile that owns the work. It refuses before stopping
anything when the proof cannot hold, stops with one guarded native Stop, and proves the stopped
work ended with the existing cleanup inspection. It never resumes anything by itself: when the
proof fails the work stays paused and the reply says so; only ``handoff.resume`` (a person's
explicit resume) lifts a handover pause. A stop made outside this flow (a raw CLI block) is only
proven, never changed.
"""
import asyncio
import contextlib
import io
import json
import os
import sqlite3
import subprocess
import unittest
from unittest.mock import patch

import test_linear_origin_native as base
from hermes_fleet_linear_plugin import cleanup, handoff

URL = "https://linear.example/issue/ABC-1"
META = {"id": "issue-one", "identifier": "ABC-1", "url": URL}
MARKER = "Linear issue ABC-1: " + URL
REQUEST = "6f2c9e4a-3b1d-4c7e-9a52-8d0e1f7b4c63"
R2 = "0b8f5a7e-3c1d-4e2f-9a6b-7c8d9e0f1a2b"
R3 = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a"


def native_stop_delivery(delivered):
    """Observe the Stop a card block delivers to the card's running worker, on either Core.

    Fence Core: ``block_task`` asks ``kanban_process_stop.request_native_stop`` for the run it ended.
    Native-Stop Core: no RPC from the block; the worker's run watch
    (``gateway.session_kanban._watch_submitter``) sees its run aborted (a status outside
    running/done/review/scheduled) and sends its ``kanban_stop`` frame for the managed interrupt. The
    fixture has no live worker process, so it applies that watch's exact test right after the block.
    """
    try:
        from hermes_cli import kanban_process_stop
    except ImportError:
        kanban_process_stop = None
    if kanban_process_stop is not None:
        return patch.object(kanban_process_stop, "request_native_stop", delivered)
    import functools
    from hermes_cli import kanban_db as kb
    real = kb.block_task

    @functools.wraps(real)
    def block_task(conn, task_id, *args, **kwargs):
        before = conn.execute("SELECT current_run_id FROM tasks WHERE id=?", (task_id,)).fetchone()
        changed = real(conn, task_id, *args, **kwargs)
        if changed and before is not None and before[0] is not None:
            run = conn.execute("SELECT status FROM task_runs WHERE id=?", (before[0],)).fetchone()
            if run is not None and run[0] not in {"running", "done", "review", "scheduled"}:
                event = conn.execute("SELECT id FROM task_events WHERE task_id=? AND kind='blocked' "
                                     "ORDER BY id DESC LIMIT 1", (task_id,)).fetchone()
                delivered(conn, task_id, event[0])
        return changed
    return patch.object(kb, "block_task", block_task)


def load_tests(loader, tests, pattern):
    # Only this module's scenarios; the base fixture's own tests run from their module.
    return loader.loadTestsFromNames(sorted(
        f"{__name__}.Handoff.{name}" for name in dir(Handoff) if name.startswith("test_handoff_")))


class Handoff(base.OriginScenarios):
    async def running_issue(self, *, settle=True, body=MARKER + "\nFinish the remaining checks", issue_id="issue-one",
                            native_stop_getter=False):
        """A claimed, admitted native task bound to issue-one, still running; optionally its
        attempt has already wound down natively (as after the Stop reached it).

        ``native_stop_getter`` keeps core's own ``process_stop_pending`` (the stop lock that
        ``record_process_stop`` writes) instead of the fixture's synthetic getter."""
        from hermes_cli import kanban_db as kb
        from linear_native_db import (register_worker_execution, adopt_worker_execution,
            mutate_worker_execution, settle_session_input)
        from hermes_fleet_linear_plugin.store import Store
        from gateway import session_ancillary
        await self.kanban()
        if settle:
            executor = "admission-worker:" + self.admission
            args = dict(epoch=self.authority.epoch, execution_id=executor, session_id=self.sid,
                        generation=self.row["generation"])
            register_worker_execution(self.db, **args, kind="compute", adoption_secret="fixture-handoff")
            adopt_worker_execution(self.db, **args, adoption_secret="fixture-handoff")
            mutate_worker_execution(self.db, **args, sequence=1, operation="execution.finish", payload={})
            settle_session_input(self.db, epoch=self.authority.epoch, admission_id=self.admission,
                                 generation=self.row["generation"], outcome="interrupted")
        with kb.write_txn(self.board):
            self.board.execute("UPDATE task_events SET payload=? WHERE kind='worker_bound' AND task_id=?",
                (json.dumps({"pid": 99999998, "started_at": self.process_witness(1),
                             "claim_lock": self.work_context["claim_lock"]}), self.task_id))
            kb._append_event(self.board, self.task_id, "spawned", {"pid": 99999999, "started_at": self.process_witness(2)},
                             run_id=self.work_context["run_id"])
            self.board.execute("UPDATE task_runs SET worker_pid=99999999,worker_started_at=? WHERE id=?",
                               (self.process_witness(2), self.work_context["run_id"]))
            self.board.execute("UPDATE tasks SET body=? WHERE id=?", (body, self.task_id))
        self.assertEqual(kb.get_task(self.board, self.task_id).status, "running")
        self.linear_state = self.home / "linear" / "state.db"
        self.linear_store = Store(self.linear_state)
        self.assertTrue(self.linear_store.bind_native(issue_id, self.task_id, "default", "default", at=1))
        if native_stop_getter:
            return
        getter = patch.object(session_ancillary, "process_stop_pending",
            lambda db, sid: db.state_meta.get("fixture.pending.stop." + sid), create=True)
        getter.start()
        self.addCleanup(getter.stop)

    def snapshot(self):
        return {table: [tuple(row) for row in self.board.execute("SELECT * FROM " + table)]
                for table in ("tasks", "task_runs", "task_events")}

    def status(self):
        from hermes_cli import kanban_db as kb
        return kb.get_task(self.board, self.task_id).status

    async def hand_off(self, *, issue="issue-one", metadata=META, request_id=REQUEST, wait_seconds=0, resume=False,
                       to="Nova", **extra):
        from agent import runtime_session_store
        def delivered(conn, task_id, event_id):
            self.delivered.append((task_id, event_id))  # The owner's Stop reaches its worker.
            if getattr(self, "on_stop", None):
                self.on_stop()
        self.delivered = getattr(self, "delivered", [])
        with patch.object(runtime_session_store, "_worker_process", False), native_stop_delivery(delivered):
            if resume:
                return await asyncio.to_thread(handoff.resume, self.linear_state, issue, "default", metadata,
                                               to=to, request_id=request_id, owner_name="Atlas")
            extra.setdefault("sleep", lambda seconds: None)
            return await asyncio.to_thread(handoff.hand_off, self.linear_state, issue, "default", self.settings,
                                           metadata, to=to, request_id=request_id, owner_name="Atlas",
                                           wait_seconds=wait_seconds, **extra)

    async def inspected(self, issue, metadata, stop_id):
        from agent import runtime_session_store
        with patch.object(runtime_session_store, "_worker_process", False):
            return await asyncio.to_thread(cleanup.inspect, self.linear_state, issue, "default", stop_id,
                                           self.settings, metadata)

    # -- (a) a coordinated stop is proven and handed over -----------------------------------
    async def test_handoff_coordinated_stop_is_proven_and_handed_over_once(self):
        from hermes_cli import kanban_db as kb
        await self.running_issue()
        result = await self.hand_off()
        self.assertTrue(result["handed_off"], result)
        self.assertEqual(result["state"], "handed_off")
        self.assertTrue(result["stopped_here"])
        self.assertFalse(result["permission_granted"])
        self.assertEqual(result["issue_id"], "issue-one")
        self.assertIn("Atlas's work stopped and is confirmed finished; Nova can continue it.", result["message"])
        self.assertEqual(self.status(), "blocked")
        stop = kb.list_events(self.board, self.task_id)[-1]
        self.assertEqual((stop.kind, stop.id), ("blocked", result["stop_event_id"]))
        self.assertEqual(stop.payload["reason"], handoff.handoff_reason("Nova", REQUEST))
        self.assertEqual(stop.payload["kind"], "needs_input")
        self.assertEqual(self.delivered, [(self.task_id, stop.id)])
        for private in ("CLAIM_PRIVATE_SENTINEL", "fixture-handoff", str(self.board_path)):
            self.assertNotIn(private, json.dumps(result))
        # A retry after a lost reply proves the same Stop and never stops again.
        before = self.snapshot()
        again = await self.hand_off()
        self.assertTrue(again["handed_off"], again)
        self.assertEqual(again["stop_event_id"], result["stop_event_id"])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(self.delivered), 1)

    async def test_handoff_resume_lifts_only_a_handover_pause_for_that_agent(self):
        from hermes_cli import kanban_db as kb
        await self.running_issue()
        self.assertTrue((await self.hand_off())["handed_off"])
        other = await self.hand_off(to="Vega", resume=True)
        self.assertEqual(other["state"], "unchanged")
        self.assertIn("isn't paused for a handover to Vega", other["message"])
        self.assertEqual(self.status(), "blocked")
        resumed = await self.hand_off(request_id=R2, resume=True)
        self.assertEqual(resumed["state"], "resumed", resumed)
        self.assertEqual(self.status(), "ready")
        event = kb.list_events(self.board, self.task_id)[-1]
        self.assertEqual(event.kind, "unblocked")
        self.assertEqual(event.payload["request_id"], handoff.resume_request_id(R2))
        before = self.snapshot()
        self.assertEqual((await self.hand_off(request_id=R2, resume=True))["state"], "resumed")  # Repeat: same answer.
        self.assertEqual((await self.hand_off(request_id=R3, resume=True))["state"], "unchanged")  # Nothing paused.
        self.assertEqual(self.snapshot(), before)

    async def test_handoff_resume_never_lifts_a_persons_pause(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        kb.edit_task(self.board, self.task_id, body=MARKER)
        before = self.snapshot()
        result = await self.hand_off(resume=True)
        self.assertEqual(result["state"], "unchanged")
        self.assertEqual(self.snapshot(), before)

    # -- (b) the proof fails: the owner stays paused, and says so -------------------------------
    async def test_handoff_failed_proof_leaves_the_owner_paused_and_never_resumes_it(self):
        from hermes_cli import kanban_db as kb
        await self.running_issue(settle=False)  # The attempt's native admission never settles.
        result = await self.hand_off()
        self.assertFalse(result["handed_off"])
        self.assertEqual((result["state"], result["reason"]), ("paused", "proof_timeout"), result)
        self.assertEqual(result["message"], "Atlas's work is paused for a handover to Nova that didn't complete: its "
                                            "run did not finish winding down in time. Nothing was resumed automatically.")
        self.assertEqual(result["why"], "its run did not finish winding down in time.")
        self.assertEqual(self.status(), "blocked")
        # Retries, with the same id or a new one for the same agent, prove the same pause: never a
        # second Stop, never a resume.
        for request_id in (REQUEST, R2):
            again = await self.hand_off(request_id=request_id)
            self.assertEqual(again["state"], "paused", again)
        kinds = [event.kind for event in kb.list_events(self.board, self.task_id)]
        self.assertEqual(kinds.count("blocked"), 1)
        self.assertNotIn("unblocked", kinds)
        self.assertEqual(len(self.delivered), 1)
        self.assertEqual(self.status(), "blocked")

    # -- HF-629: the stopped worker reports back after the gateway gave up on it ------------------
    def adopt_worker(self):
        """The card attempt's managed worker, registered and adopted by core as at spawn."""
        from linear_native_db import register_worker_execution, adopt_worker_execution
        self.executor = "admission-worker:" + self.admission
        args = dict(epoch=self.authority.epoch, execution_id=self.executor, session_id=self.sid,
                    generation=self.row["generation"])
        register_worker_execution(self.db, **args, kind="compute", adoption_secret="fixture-handoff")
        adopt_worker_execution(self.db, **args, adoption_secret="fixture-handoff")

    async def lose_worker(self):
        """Core's own "Managed worker lost: managed_worker_stopped" path once the worker missed
        STOP_ACK_SECONDS: a fence Core's retain_failed_stop records the stop lock (a native-Stop
        Core records nothing), then _settle_lost marks the attempt's admission ``unknown``. Nothing
        in this gateway lifetime settles it after that."""
        from gateway.session_managed_worker import _settle_lost
        if base.core_stop_fence():
            from gateway.session_kanban_stop import retain_failed_stop
            from gateway.session_policy import restore_policy
            from linear_native_db import local_receipt
            policy = restore_policy(local_receipt(self.db, self.sid)["policy"])
            await retain_failed_stop(self.authority, self.ref, self.row, policy)
        await _settle_lost(self.authority, self.row, {"epoch": self.authority.epoch, "generation": self.row["generation"],
                                                      "execution_id": self.executor}, None)

    def lose_on_stop(self):
        """The owner's Stop reaches the worker, which then winds down too slowly: the loss lands
        before the owner's proof reads it."""
        def lose():
            asyncio.run_coroutine_threadsafe(self.lose_worker(), self.loop).result(timeout=30)
        self.on_stop = lose

    def admission_row(self):
        from linear_native_db import get_session_admission
        return get_session_admission(self.db, admission_id=self.admission)

    def stop_lock(self):
        """Core's own process-Stop checkpoint; a native-Stop Core has none to hold."""
        from gateway import session_ancillary
        getter = getattr(session_ancillary, "process_stop_pending", None)
        return getter(self.db, self.sid) if callable(getter) else None

    def assert_lost_stop_lock(self):
        """A lost worker's Stop: a fence Core holds its stop lock; a native-Stop Core persists nothing."""
        if base.core_stop_fence():
            self.assertIsNotNone(self.stop_lock())
        else:
            self.assertIsNone(self.stop_lock())

    def resolves(self):
        return [params for method, params in self.calls if method == "prompt.resolve_unknown"]

    async def lost_attempt_issue(self, **running):
        await self.running_issue(settle=False, native_stop_getter=True, **running)
        self.owner_methods = frozenset({"prompt.receipt", "prompt.resolve_unknown"})
        self.adopt_worker()

    async def test_handoff_settles_its_own_stopped_attempt_left_unknown_and_hands_over(self):
        await self.lost_attempt_issue()
        self.lose_on_stop()
        result = await self.hand_off()
        # Core left it exactly as the live HF-629 gateway did: unknown, stop lock held.
        self.assertTrue(result["handed_off"], result)
        self.assertEqual(result["state"], "handed_off")
        self.assertTrue(result["stopped_here"])
        self.assertEqual(self.resolves(), [{"session_id": self.sid, "admission_id": self.admission,
                                            "execution_generation": self.row["generation"]}])
        row = self.admission_row()
        self.assertEqual((row["status"], row["outcome"]), ("terminal", "interrupted"))
        self.assertIsNone(self.stop_lock())  # Core's resolve re-ran its process-stop cleanup first.
        self.assertEqual(self.status(), "blocked")  # Never resumed here.
        self.assertEqual(len(self.delivered), 1)
        # A retry proves the same settled Stop and resolves nothing more.
        again = await self.hand_off()
        self.assertTrue(again["handed_off"], again)
        self.assertEqual(len(self.resolves()), 1)

    async def test_handoff_without_settling_its_lost_attempt_times_out_paused(self):
        # The live bug, reproduced with core's own loss: without the resolve the unchanged proof
        # holds native_admission_not_settled until the wait ends and the owner stays paused.
        await self.lost_attempt_issue()
        self.lose_on_stop()
        with patch.object(handoff, "_resolve_lost_attempt", lambda *args: None):
            result = await self.hand_off()
        self.assertEqual((result["state"], result["reason"]), ("paused", "proof_timeout"), result)
        self.assertEqual(self.admission_row()["status"], "unknown")
        self.assert_lost_stop_lock()
        held = await self.inspected("issue-one", META, [e for e in self.owner_events() if e.kind == "blocked"][-1].id)
        self.assertEqual(held["reason"], "native_admission_not_settled")
        self.assertEqual(self.resolves(), [])

    async def test_handoff_never_resolves_a_started_attempt(self):
        # The worker has not been lost: its row is still started. Nothing is resolved, and the
        # proof holds until the wait ends.
        await self.lost_attempt_issue()
        result = await self.hand_off()
        self.assertEqual((result["state"], result["reason"]), ("paused", "proof_timeout"), result)
        self.assertEqual(self.resolves(), [])
        self.assertEqual(self.admission_row()["status"], "started")
        self.assertEqual(self.status(), "blocked")

    async def test_handoff_lost_attempt_with_a_live_owned_process_stays_paused(self):
        # A background process the attempt started may still be running (its checkpoint is not
        # provably stopped): a fence Core refuses the resolve (process_stop_unknown); a native-Stop
        # Core settles the row (its kill is best-effort and gates nothing), but the proof's own
        # scoped process checkpoint still holds. Either way nothing is handed over.
        fence = base.core_stop_fence()
        settled = ("unknown",) if fence else ("terminal", "interrupted")
        await self.lost_attempt_issue()
        route = self.authority.sessions[self.sid].route
        (self.home / "processes.json").write_text(json.dumps([{
            "session_id": "proc_fixture", "session_key": route, "owner_task_id": self.sid, "pid": 99999997,
            "host_start_time": 1, "pid_scope": "container", "command": "sleep 600"}]))
        self.lose_on_stop()
        result = await self.hand_off()
        self.assertFalse(result["handed_off"], result)
        self.assertEqual((result["state"], result["reason"]), ("paused", "proof_timeout"), result)
        self.assertEqual(len(self.resolves()), 1)  # Asked once: refused by a fence Core.
        row = self.admission_row()
        self.assertEqual((row["status"], row["outcome"])[:len(settled)], settled)
        self.assert_lost_stop_lock()
        self.assertEqual(self.status(), "blocked")
        if not fence:
            held = await self.inspected("issue-one", META, [e for e in self.owner_events() if e.kind == "blocked"][-1].id)
            self.assertFalse(held["quiescence_proven"])
            self.assertEqual(held["reason"], "scoped_process_cleanup_unknown")
        retry = await self.hand_off()  # Still the same answer; never handed over.
        self.assertEqual(retry["state"], "paused", retry)
        self.assertEqual(self.admission_row()["status"], settled[0])

    async def test_handoff_never_resolves_a_lost_attempt_under_a_persons_pause(self):
        from hermes_cli import kanban_db as kb
        await self.lost_attempt_issue()
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input", reason="A person's Stop",
                                      expected_run_id=self.work_context["run_id"]))
        await self.lose_worker()
        result = await self.hand_off()
        self.assertEqual((result["handed_off"], result["state"]), (False, "unchanged"), result)
        self.assertEqual(self.resolves(), [])
        self.assertEqual(self.admission_row()["status"], "unknown")

    async def test_handoff_never_resolves_a_lost_attempt_paused_for_another_agent(self):
        from hermes_cli import kanban_db as kb
        await self.lost_attempt_issue()
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input",
                                      reason=handoff.handoff_reason("Vega", R2), expected_run_id=self.work_context["run_id"]))
        await self.lose_worker()
        result = await self.hand_off()
        self.assertEqual((result["state"], result["reason"]), ("unchanged", "handover_in_progress"), result)
        self.assertEqual(self.resolves(), [])
        self.assertEqual(self.admission_row()["status"], "unknown")

    async def test_handoff_settles_a_lost_attempt_under_an_earlier_request_for_the_same_agent(self):
        # "Take over again" carries a new id: it proves the earlier pause for the same agent and
        # settles the row the earlier request left unknown, instead of leaving it stuck until a restart.
        await self.lost_attempt_issue()
        self.lose_on_stop()
        with patch.object(handoff, "_resolve_lost_attempt", lambda *args: None):
            first = await self.hand_off()
        self.assertEqual(first["state"], "paused", first)
        self.assertEqual(self.admission_row()["status"], "unknown")
        later = await self.hand_off(request_id=R2)
        self.assertTrue(later["handed_off"], later)
        self.assertEqual(len(self.resolves()), 1)
        self.assertEqual(self.admission_row()["outcome"], "interrupted")
        self.assertEqual(len(self.delivered), 1)  # Never stopped twice.

    async def test_handoff_settles_a_loss_that_lands_after_started_polls(self):
        # Live timing: the row stays started for the gateway's stop ack (~30 s) plus the loss note
        # wait before core marks it unknown. Polls that see it started must not spend the attempt.
        import itertools
        await self.lost_attempt_issue()
        sleeps, ticks = itertools.count(), itertools.count()
        def sleep(_seconds):
            if next(sleeps) == 2:  # Two polls saw it started; the loss lands before the third.
                asyncio.run_coroutine_threadsafe(self.lose_worker(), self.loop).result(timeout=30)
        result = await self.hand_off(wait_seconds=30, sleep=sleep, clock=lambda: float(next(ticks)))
        self.assertTrue(result["handed_off"], result)
        self.assertEqual(len(self.resolves()), 1)
        self.assertEqual((self.admission_row()["status"], self.admission_row()["outcome"]), ("terminal", "interrupted"))
        self.assertIsNone(self.stop_lock())

    async def test_handoff_refuses_before_stopping_when_proof_cannot_hold(self):
        await self.running_issue(body="Linear issue OTHER-2: https://linear.example/issue/OTHER-2")
        before = self.snapshot()
        result = await self.hand_off()
        self.assertEqual((result["handed_off"], result["state"]), (False, "unchanged"))
        self.assertEqual(result["reason"], "native_task_issue_scope_conflict")
        self.assertIn("Nothing was changed", result["message"])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.delivered, [])
        # No reporting link here: nothing to hand over, nothing touched.
        with self.linear_store._tx() as db:
            db.execute("DELETE FROM metadata WHERE key='native-binding:issue-one'")
            db.execute("DELETE FROM work WHERE issue_id='issue-one'")
        refused = await self.hand_off()
        self.assertEqual((refused["state"], refused["reason"]), ("unchanged", "not_bound_here"))
        self.assertEqual(self.snapshot(), before)
        # An incomplete issue reference never selects or stops anything.
        incomplete = await self.hand_off(metadata={"id": "issue-one"})
        self.assertEqual(incomplete["state"], "unchanged")
        self.assertEqual(self.snapshot(), before)

    async def test_handoff_started_open_tasks_are_left_running(self):
        from hermes_cli import kanban_db as kb
        await self.running_issue()
        kb.create_task(self.board, title="sub-step", assignee="default", created_by="fixture-agent",
                       creator_task_id=self.task_id)
        before = self.snapshot()
        result = await self.hand_off()
        self.assertEqual((result["state"], result["reason"]), ("unchanged", "started_other_tasks"))
        self.assertEqual(self.snapshot(), before)

    # -- a stop made outside this flow (raw CLI) ----------------------------------------------
    async def test_handoff_raw_cli_stop_is_proven_without_another_stop(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()  # Blocked directly with kanban block, like an operator CLI call.
        kb.edit_task(self.board, self.task_id, body=MARKER)
        stop_id = self.stop_id
        before = self.snapshot()
        result = await self.hand_off()
        self.assertTrue(result["handed_off"], result)
        self.assertFalse(result["stopped_here"])
        self.assertEqual(result["stop_event_id"], stop_id)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.delivered, [])

    async def test_handoff_raw_cli_stop_that_cannot_be_proven_is_left_as_it_was(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        kb.edit_task(self.board, self.task_id, body=MARKER)
        self.db.set_meta("fixture.pending.stop." + self.sid, "pending")  # Native Stop still in flight.
        before = self.snapshot()
        result = await self.hand_off()
        self.assertEqual((result["handed_off"], result["state"]), (False, "unchanged"))
        self.assertIn("left as it was", result["message"])
        self.assertEqual(self.status(), "blocked")
        self.assertEqual(self.snapshot(), before)

    # -- identifier vs UUID selectors ---------------------------------------------------------
    async def test_handoff_identifier_and_id_select_the_same_work_and_missing_metadata_is_named(self):
        from hermes_cli import kanban_db as kb
        await self.stopped_issue()
        kb.edit_task(self.board, self.task_id, body=MARKER)
        stop_id = self.stop_id
        by_id = await self.inspected("issue-one", META, stop_id)
        by_key = await self.inspected("ABC-1", META, stop_id)
        self.assertTrue(by_id["quiescence_proven"], by_id)
        self.assertTrue(by_key["quiescence_proven"], by_key)
        self.assertEqual(by_key["task_id"], by_id["task_id"])
        self.assertEqual(by_key["issue_id"], "issue-one")
        # Without the issue's link a bridge-written marker is unproved, never a "scope conflict".
        for selector in ("issue-one", "ABC-1"):
            with self.subTest(selector=selector):
                held = await self.inspected(selector, None, stop_id)
                self.assertFalse(held["quiescence_proven"])
                self.assertEqual(held["reason"], "issue_metadata_required")
                self.assertIn("--issue-json", held["needed"])
        # A real conflict with complete metadata is still a conflict.
        kb.edit_task(self.board, self.task_id, body=MARKER + "\nLinear issue OTHER-2: https://linear.example/issue/OTHER-2")
        self.assertEqual((await self.inspected("ABC-1", META, stop_id))["reason"], "native_task_issue_scope_conflict")
        kb.edit_task(self.board, self.task_id, body=MARKER)
        # A key that names a different issue than its metadata is refused before any read.
        wrong = await self.inspected("XYZ-9", META, stop_id)
        self.assertEqual(wrong["reason"], "invalid_issue_discovery_metadata")
        result = await self.hand_off(issue="ABC-1")
        self.assertTrue(result["handed_off"], result)
        self.assertEqual(result["issue_id"], "issue-one")

    async def test_handoff_owner_cli_command(self):
        import argparse
        from agent import runtime_session_store
        from hermes_fleet_linear_plugin import ops
        await self.running_issue()
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        args = parser.parse_args(["hand-off", "ABC-1", "--issue-json", json.dumps(META), "--to", "Nova",
                                  "--from-name", "Atlas", "--request-id", REQUEST, "--wait-seconds", "5"])
        with patch.object(runtime_session_store, "_worker_process", False), \
                native_stop_delivery(lambda *a: None), patch("builtins.print") as printed:
            rc = await asyncio.to_thread(ops.run, args, self.linear_state, self.home / "unused", "default",
                                         origin_settings=self.settings)
        reply = json.loads(printed.call_args.args[0])
        self.assertEqual(rc, 0, reply)
        self.assertTrue(reply["handed_off"])
        self.assertIn("Atlas's work stopped", reply["message"])

    # -- a failure right after the Stop: paused (maybe), never "unchanged" and never resumed ------
    async def test_handoff_unreadable_history_after_the_stop_is_reported_paused(self):
        from hermes_fleet_linear_plugin.bridge import Kanban
        await self.running_issue()
        armed, real_block, real_history = [], handoff._block, Kanban.history
        def block(*args, **kwargs):
            changed = real_block(*args, **kwargs)
            armed.append(True)
            return changed
        def history(adapter, task_id, after):
            if armed:
                armed.clear()
                raise sqlite3.OperationalError("database is locked")  # The read right after the Stop.
            return real_history(adapter, task_id, after)
        with patch.object(handoff, "_block", block), patch.object(Kanban, "history", history):
            result = await self.hand_off()
        self.assertFalse(result["handed_off"])
        self.assertEqual((result["state"], result["reason"]), ("paused", "stop_unverified"), result)
        self.assertIn("couldn't be checked after it was asked to stop", result["message"])
        self.assertEqual(self.status(), "blocked")
        retry = await self.hand_off()  # Its own Stop, found by request id: proven, never stopped twice.
        self.assertTrue(retry["handed_off"], retry)
        self.assertEqual(len(self.delivered), 1)

    # -- should-fix 7: never prove another agent's handover pause for a second agent -----------
    async def test_handoff_pause_for_another_agent_is_never_proven_for_this_one(self):
        from hermes_cli import kanban_db as kb
        await self.running_issue()
        vega = "0b8f5a7e-3c1d-4e2f-9a6b-7c8d9e0f1a2b"
        self.assertTrue(kb.block_task(self.board, self.task_id, kind="needs_input",
                                      reason=handoff.handoff_reason("Vega", vega)))
        before = self.snapshot()
        result = await self.hand_off()
        self.assertEqual((result["handed_off"], result["state"], result["reason"]),
                         (False, "unchanged", "handover_in_progress"))
        self.assertIn("already paused for a handover to another agent", result["message"])
        self.assertEqual(self.snapshot(), before)

    async def test_handoff_busy_issue_lock_changes_nothing(self):
        await self.running_issue()
        before = self.snapshot()
        with patch.object(handoff, "HANDOFF_LOCK_SECONDS", 0), \
                handoff.issue_lock(handoff._handoff_dir(self.linear_state), "issue-one", 0) as held:
            self.assertTrue(held)
            result = await self.hand_off()
        self.assertEqual((result["state"], result["reason"]), ("unchanged", "handoff_busy"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.delivered, [])

    # -- G: a new request never wipes or resumes an earlier one's pause --------------------------
    async def test_handoff_a_new_request_for_the_same_agent_proves_the_earlier_pause(self):
        await self.running_issue()
        first = await self.hand_off()
        self.assertTrue(first["handed_off"], first)
        later = await self.hand_off(request_id=R2)
        self.assertTrue(later["handed_off"], later)
        self.assertEqual(later["stop_event_id"], first["stop_event_id"])
        self.assertEqual(len(self.delivered), 1)  # Never stopped twice.
        self.assertEqual(self.status(), "blocked")  # And nothing resumed it.

    # -- the requester and the real owner hand-off together -------------------------------------
    async def requester(self, **running):
        """Nova, a second agent with its own Kanban home and Linear state, reaching Atlas (this
        fixture's owner) only through the owner command. Here that command runs Atlas's real
        ``linear hand-off`` CLI entry in-process, against Atlas's own native board and receipts."""
        import argparse
        from agent import runtime_session_store
        from hermes_fleet_linear_plugin import chat, ops
        from hermes_fleet_linear_plugin.bridge import Bridge, Kanban
        from hermes_fleet_linear_plugin.store import Store
        from hermes_fleet_linear_plugin.transport import NativeContext
        from test_linear_chat_entrust_scenarios import ChatAuthority, now_iso
        from test_linear_specialist_authorization import ISSUE
        self.ISSUE = ISSUE
        issue_meta = {"id": ISSUE, "identifier": "OPS-1", "url": "https://linear.example/issue/OPS-1"}
        await self.running_issue(body="Linear issue OPS-1: https://linear.example/issue/OPS-1\nFinish the checks",
                                 issue_id=ISSUE, **running)
        self.nova_board = self.home / "nova-board"
        self.nova_kanban = patch.dict(os.environ, {"HERMES_KANBAN_HOME": str(self.nova_board)})
        self.authority_linear = ChatAuthority()
        issue = self.authority_linear.issues[ISSUE]
        issue.update(delegate={"id": "atlas-app", "name": "Atlas"}, updatedAt=now_iso(),
                     state={"id": "state-progress", "name": "In Progress", "type": "started"})
        command = ["host-bridge", "profile", "atlas", "--", "hermes", "--profile", "default"]
        with self.nova_kanban:
            board = Kanban(profile="default", profile_home=self.home)
            self.assertTrue(board.guarded_controls)
            self.nova = Bridge(Store(self.home / "nova" / "linear.db"), self.authority_linear.api(scope=None), board,
                               profile="default", settings={"takeover": {"name": "Nova", "agents": [
                                   {"name": "Atlas", "delegate_id": "atlas-app", "command": command, "wait_seconds": 5}]}})
            self.nova.profile_home = self.home
        self.nova_board_adapter = board
        self.nova_context = NativeContext(home=str(self.home), profile="default", platform="slack", source="slack",
                                          session_key="slack:chat-1:thread-1", session_id="chat-session",
                                          user_id="human-1", chat_id="chat-1", chat_type="dm", thread_id="thread-1",
                                          scope_id="workspace-1")
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        self.owner_calls, self.lose_reply = [], False
        def owner_cli(argv, **options):
            self.assertEqual(argv[:len(command)], command)
            self.assertNotIn("shell", options)
            args = parser.parse_args(argv[len(command) + 1:])
            self.assertEqual(json.loads(args.issue_json), issue_meta)
            self.owner_calls.append(argv[len(command):])
            out = io.StringIO()
            with patch.dict(os.environ, {}), contextlib.redirect_stdout(out):
                os.environ.pop("HERMES_KANBAN_HOME", None)  # Atlas's own home and board.
                rc = ops.run(args, self.linear_state, self.home / "unused", "default", origin_settings=self.settings)
            if self.lose_reply and not args.resume:
                return subprocess.CompletedProcess(argv, 255, "Connection to atlas closed by remote host.\n", "")
            return subprocess.CompletedProcess(argv, rc, "1Password: applied 3 secrets\n" + out.getvalue(), "")
        self.delivered = []
        def delivered(conn, task_id, event_id):
            self.delivered.append((task_id, event_id))
            if getattr(self, "on_stop", None):
                self.on_stop()
        def take_over(request_id=REQUEST, action="take_over"):
            with self.nova_kanban, patch.object(subprocess, "run", owner_cli), \
                    patch.object(runtime_session_store, "_worker_process", False), \
                    native_stop_delivery(delivered):
                return json.loads(chat.handle(self.nova, {"action": action, "issue": ISSUE, "id": request_id},
                                              self.nova_context))
        self.take_over = take_over
        self.resume_owner = lambda request_id=R3: take_over(request_id, "resume_owner")

    def nova_tasks(self):
        with self.nova_kanban, self.nova_board_adapter.conn() as conn:
            return [dict(row) for row in conn.execute("SELECT id, status, body FROM tasks")]

    def owner_events(self):
        from hermes_cli import kanban_db as kb
        return kb.list_events(self.board, self.task_id)

    async def test_handoff_with_requester_real_owner_stops_proves_and_nova_runs_one_task(self):
        await self.requester()
        reply = await asyncio.to_thread(self.take_over)
        self.assertTrue(reply["ok"], reply)
        self.assertIn("Took over OPS-1 from Atlas", reply["message"])
        self.assertEqual(reply["handover"], {"from": "Atlas", "state": "handed_off", "stopped_here": True})
        self.assertEqual([call[:2] for call in self.owner_calls], [["linear", "hand-off"]])
        # Atlas: stopped once by the guarded handover Stop, and still paused (nothing resumed it).
        self.assertEqual(self.status(), "blocked")
        stop = [event for event in self.owner_events() if event.kind == "blocked"][-1]
        self.assertEqual(stop.payload["reason"], handoff.handoff_reason("Nova", REQUEST))
        self.assertEqual(self.delivered, [(self.task_id, stop.id)])
        # Nova: exactly one task, runnable, saying where to continue from; Nova replaces Atlas as delegate.
        tasks = self.nova_tasks()
        self.assertEqual(len(tasks), 1)
        self.assertIn(tasks[0]["status"], ("ready", "running"))
        self.assertIn("Atlas worked on this issue before and stopped", tasks[0]["body"])
        with self.nova_kanban:
            self.nova.flush()
        self.assertEqual(self.authority_linear.issues[self.ISSUE]["delegate"]["id"], self.nova.api.viewer_id())

    async def test_handoff_with_requester_real_owner_settles_its_lost_attempt_and_nova_runs_one_task(self):
        # HF-629 end to end: Nova's take_over runs Atlas's real hand-off; Atlas's worker misses the
        # gateway's stop ack, core leaves the attempt unknown, Atlas settles its own stopped attempt
        # and proves it, and Nova runs the one task.
        await self.requester(settle=False, native_stop_getter=True)
        self.owner_methods = frozenset({"prompt.receipt", "prompt.resolve_unknown"})
        self.adopt_worker()
        self.lose_on_stop()
        reply = await asyncio.to_thread(self.take_over)
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["handover"], {"from": "Atlas", "state": "handed_off", "stopped_here": True})
        self.assertEqual(len(self.resolves()), 1)
        self.assertEqual((self.admission_row()["status"], self.admission_row()["outcome"]), ("terminal", "interrupted"))
        self.assertIsNone(self.stop_lock())
        self.assertEqual(self.status(), "blocked")
        (task,) = self.nova_tasks()
        self.assertIn(task["status"], ("ready", "running"))

    async def test_handoff_with_requester_failure_after_proof_leaves_the_real_owner_paused_until_resumed(self):
        from datetime import datetime, timedelta, timezone
        from hermes_fleet_linear_plugin.bridge import Kanban
        from test_linear_specialist_authorization import USER
        await self.requester()
        real = Kanban.create
        def create(adapter, *args, **kwargs):
            task = real(adapter, *args, **kwargs)
            # A person moves the issue between Atlas's proof and Nova's admission: the person wins.
            issue = self.authority_linear.issues[self.ISSUE]
            moved = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
            issue["updatedAt"] = moved
            self.authority_linear.history.setdefault(self.ISSUE, []).append({
                "createdAt": moved, "actorId": USER, "fromStateId": "state-progress", "toStateId": "state-todo",
                "fromAssigneeId": None, "toAssigneeId": None, "fromDelegate": None, "toDelegate": None})
            return task
        with patch.object(Kanban, "create", create):
            reply = await asyncio.to_thread(self.take_over)
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], "takeover_paused")
        self.assertIn("Atlas's work on OPS-1 is paused for a handover to Nova that didn't complete", reply["message"])
        self.assertIn("Say 'resume OPS-1' to let Atlas continue", reply["message"])
        self.assertEqual([call[:2] for call in self.owner_calls], [["linear", "hand-off"]])
        # Atlas stays paused, Nova runs nothing: never both, and nothing resumes Atlas by itself.
        self.assertEqual(self.status(), "blocked")
        self.assertTrue(all(task["status"] not in ("ready", "running") for task in self.nova_tasks()))
        # The person says "resume OPS-1": Atlas continues, and Nova's task can no longer start.
        resumed = await asyncio.to_thread(self.resume_owner)
        self.assertTrue(resumed["ok"], resumed)
        self.assertEqual(self.owner_calls[-1][-1], "--resume")
        self.assertEqual(self.status(), "ready")
        with self.nova_kanban:
            self.nova._recover_admissions()
        self.assertTrue(all(task["status"] not in ("ready", "running") for task in self.nova_tasks()))

    async def test_handoff_with_requester_lost_owner_reply_leaves_the_real_owner_paused_and_a_retry_finishes(self):
        await self.requester()
        self.lose_reply = True  # Atlas stopped and proved it, but its reply never reached Nova.
        reply = await asyncio.to_thread(self.take_over)
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], "takeover_paused")
        self.assertIn("didn't report back", reply["message"])
        self.assertIn("may be paused", reply["message"])
        self.assertEqual(self.status(), "blocked")
        self.assertEqual(self.nova_tasks(), [])
        # "Take over OPS-1" again (a new id): Atlas proves the same pause, Nova runs the one task.
        self.lose_reply = False
        again = await asyncio.to_thread(self.take_over, R2)
        self.assertTrue(again["ok"], again)
        self.assertEqual(len([event for event in self.owner_events() if event.kind == "blocked"]), 1)
        (task,) = self.nova_tasks()
        self.assertIn(task["status"], ("ready", "running"))
        self.assertEqual(self.status(), "blocked")

    async def test_handoff_with_requester_failure_after_admission_keeps_the_real_owner_paused(self):
        # Nova's task was admitted, then its chat subscription failed. Atlas stays paused (never
        # both running); Nova runs the one task.
        from hermes_fleet_linear_plugin.bridge import Kanban
        await self.requester()
        def boom(*args, **kwargs):
            raise OSError("notify db locked")
        with patch.object(Kanban, "subscribe_origin", boom):
            reply = await asyncio.to_thread(self.take_over)
        self.assertTrue(reply["ok"], reply)
        self.assertEqual([call[:2] for call in self.owner_calls], [["linear", "hand-off"]])
        self.assertEqual(self.status(), "blocked")
        (task,) = self.nova_tasks()
        self.assertIn(task["status"], ("ready", "running"))
        refused = await asyncio.to_thread(self.resume_owner)  # A person's resume can't run Atlas beside it.
        self.assertEqual(refused["code"], "resume_refused")
        self.assertEqual(self.status(), "blocked")

    async def test_handoff_with_requester_running_task_never_reaches_the_real_owner_again(self):
        # After the takeover, retries of the same or another request (Linear still shows Atlas
        # until routing flushes) never reach Atlas.
        await self.requester()
        self.assertTrue((await asyncio.to_thread(self.take_over))["ok"])
        calls = list(self.owner_calls)
        for request in (REQUEST, R2):
            reply = await asyncio.to_thread(self.take_over, request)
            self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.owner_calls, calls)
        self.assertEqual(self.status(), "blocked")
        self.assertEqual(len(self.nova_tasks()), 1)


if __name__ == "__main__":
    unittest.main()
