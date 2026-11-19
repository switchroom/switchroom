"""Linear status follows native execution (job spec: "Linear status follows the work").

One mapping from the bound task's native status to the team's workflow state,
applied after each pump and on the reporting recheck. Real pinned Core tasks,
the plugin Store and the HTTP fake API exercise the current entrypoints.
"""
import json
import os
import time
import unittest

import test_linear_delegate_routing_scenarios as routing
from linear_fake_api import SELF, STATES

IN_REVIEW = {"id": "st-review", "name": "In Review", "type": "started"}


@unittest.skipUnless(os.environ.get("HERMES_AGENT_SRC"), "requires explicit native source")
class StatusFollowsWorkScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = routing.DelegateRoutingScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        f.remote.history.pop("issue-1", None)  # setUp stamps history on its fixed 2030 clock
        f.fixture.clock.now = time.time() - 5
        f.remote.set_delegate("issue-1", {"id": SELF}, actor=SELF)
        self.states = [*STATES, IN_REVIEW]
        f.issue["team"]["states"]["nodes"] = self.states
        self.remote, self.board, self.bridge = f.remote, f.board, f.bridge

    def set_state(self, name, actor="human-1"):
        """Linear records who moved the issue and when."""
        before = dict(self.fixture.issue)
        self.fixture.issue["state"] = dict(next(s for s in self.states if s["name"] == name))
        self.fixture.issue["updatedAt"] = self.fixture.fixture.clock.iso()
        self.remote.record_history("issue-1", actor, before, self.fixture.issue)

    def task(self, *, scope="outcome", claim=False, **fields):
        with self.board.conn() as db:
            task = self.board.kb.create_task(db, title="Native work", board=self.board.board,
                assignee=self.board.executor_profile, created_by="operator",
                body="Linear issue issue-1: " + self.fixture.issue["url"], **fields)
            run = self.board.kb.claim_task(db, task, claimer="native-worker").current_run_id if claim else None
        self.bridge.track("issue-1", task, completion_scope=scope)
        return task, run

    def native(self, action, *args, **kwargs):
        with self.board.conn() as db:
            return getattr(self.board.kb, action)(db, *args, **kwargs)

    def ticks(self, count=3, *, after=2):
        self.fixture.fixture.clock.now = time.time() + after  # Linear reads after the native facts
        for _ in range(count):
            self.bridge.pump_kanban()
            self.bridge.flush()

    def state(self):
        return self.remote.state("issue-1")

    def mutations(self):
        return self.fixture.mutations()

    def admitted_by_delegation(self, *, turn):
        """A person delegates the issue: our own admission unblocks one task that awaits its first claim."""
        if turn:
            self.bridge.session_turn("issue-1", True)  # the Linear session turn starts as work_on routes it
        self.assertTrue(self.bridge.handle_webhook(self.fixture.human_assignment()))
        task = self.bridge.store.native_binding("issue-1")["task_id"]
        self.assertEqual(self.board.get(task).status, "ready")
        self.assertEqual([e.kind for e in self.board.history(task, 0)][-1], "unblocked")
        return task

    def written_states(self):
        """Every state this app wrote to Linear, in order."""
        names = {state["id"]: state["name"] for state in self.states}
        return [names[entry["toStateId"]] for entry in self.remote.history.get("issue-1", [])
                if entry["actorId"] == SELF and entry["fromStateId"] != entry["toStateId"]]

    def failed(self):
        with self.bridge.store._tx() as db:
            return db.execute("SELECT kind, payload FROM outbox WHERE state='failed'").fetchall()

    # -- one row of the spec table each ----------------------------------

    def test_queued_work_shows_todo_not_in_progress(self):
        self.set_state("In Progress", actor=SELF)  # a phantom In Progress from an older build
        task, _ = self.task()
        self.assertEqual(self.board.get(task).status, "ready")
        self.ticks()
        self.assertEqual(self.state(), "Todo")

    def test_unblocked_or_promoted_but_only_queued_is_todo(self):
        task, _ = self.task(initial_status="blocked")
        self.ticks()
        self.native("unblock_task", task)
        self.assertEqual(self.board.get(task).status, "ready")
        self.ticks()
        self.assertEqual(self.state(), "Todo")  # was In Progress before this change
        self.assertNotIn("In Progress", [self.remote.state("issue-1")])

    def test_own_admission_waiting_for_its_first_claim_never_flickers_to_todo(self):
        # HF-629: route + session turn + unblock, turn ends, the 60 s dispatcher claims later.
        # Linear went Backlog -> In Progress -> Todo -> In Progress within 40 s.
        task = self.admitted_by_delegation(turn=True)
        self.ticks()
        self.assertEqual(self.state(), "In Progress")  # the session turn is on it
        self.bridge.session_turn("issue-1", False)  # the turn ends before the dispatcher's tick
        self.ticks(after=20)
        self.assertEqual(self.state(), "In Progress")
        self.ticks(after=45)
        self.assertEqual(self.state(), "In Progress")
        self.native("claim_task", task, claimer="native-worker")
        self.ticks(after=50)
        self.assertEqual(self.state(), "In Progress")
        self.assertEqual(self.written_states(), ["In Progress"])  # never Todo in between
        self.assertEqual(self.failed(), [])

    def test_own_admission_never_claimed_falls_back_to_todo_after_the_bound(self):
        # A stuck dispatcher: In Progress must not be claimed forever.
        self.admitted_by_delegation(turn=True)
        self.ticks()
        self.bridge.session_turn("issue-1", False)
        self.ticks(after=self.bridge.FIRST_CLAIM_HOLD - 10)
        self.assertEqual(self.state(), "In Progress")
        self.ticks(after=self.bridge.FIRST_CLAIM_HOLD + 5)
        self.assertEqual(self.state(), "Todo")
        self.assertEqual(self.written_states(), ["In Progress", "Todo"])

    def test_own_admission_never_shown_in_progress_still_shows_todo(self):
        self.admitted_by_delegation(turn=False)
        self.ticks()
        self.assertEqual(self.state(), "Todo")
        self.assertNotIn("In Progress", self.written_states())

    def test_own_admission_back_in_ready_after_it_ran_shows_todo(self):
        # Back in the queue after a run (released, reclaimed): nobody is on it, so Todo as before.
        task = self.admitted_by_delegation(turn=False)
        self.native("claim_task", task, claimer="native-worker")
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        self.native("reclaim_task", task, reason="operator released it")
        self.assertEqual(self.board.get(task).status, "ready")
        self.ticks(after=10)
        self.assertEqual(self.state(), "Todo")

    def test_running_work_shows_in_progress(self):
        self.task(claim=True)
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        self.assertEqual(self.fixture.issue["delegate"]["id"], SELF)
        self.assertEqual(self.fixture.issue["assignee"], {"id": "human-assignee"})

    def test_waiting_on_a_person_is_blocked_with_one_plain_sentence(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.native("block_task", task, reason="Pick the staging or production database", kind="needs_input",
                    expected_run_id=run)
        self.ticks()
        self.assertEqual(self.state(), "Blocked")
        said = [body for body in self.remote.bodies("issue-1") if body.startswith("**Waiting on you**")]
        self.assertEqual(said, ["**Waiting on you**\n\nPick the staging or production database.\n\n**Next:** once this "
                                "is answered, ask the agent to resume and it continues the same task."])

    def test_team_without_blocked_keeps_its_state_and_still_posts_the_sentence(self):
        self.states[:] = [s for s in self.states if s["name"] not in ("Blocked", "In Review")]
        task, run = self.task(claim=True)
        self.ticks()
        self.native("block_task", task, reason="Grant read access to the billing repo", kind="needs_input",
                    expected_run_id=run)
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        self.assertTrue(any("Grant read access to the billing repo" in body for body in self.remote.bodies("issue-1")))
        self.assertEqual(self.failed(), [])  # a missing state is not a delivery failure

    def test_finished_stage_awaiting_review_is_in_review(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.assertTrue(self.native("request_review", task, summary="PR is up for review", expected_run_id=run))
        self.assertEqual(self.board.get(task).status, "review")
        self.ticks()
        self.assertEqual(self.state(), "In Review")

    def test_work_held_by_the_open_pr_guard_is_in_review(self):
        task, _ = self.task()
        self.ticks()
        self.assertEqual(self.state(), "Todo")
        with self.board.conn() as db, self.board.kb.write_txn(db):
            self.board.kb._append_event(db, task, "respawn_guarded", {"reason": "active_pr"})
        self.ticks()
        self.assertEqual(self.state(), "In Review")

    def stage_done(self, summary):
        task, run = self.task(scope="progress", claim=True)
        self.ticks()
        self.assertTrue(self.native("complete_task", task, summary=summary, expected_run_id=run))
        self.ticks()
        self.assertTrue(any("This stage is finished" in body for body in self.remote.bodies("issue-1")))
        return self.state()

    def test_internal_stage_done_awaits_review_never_todo_or_done(self):
        # Finished work whose outcome is not verified awaits review, CI or merge (live: HF-182, HF-576, HF-585).
        self.assertEqual(self.stage_done("Drafted the migration plan."), "In Review")

    def test_internal_stage_done_with_a_pr_awaits_review(self):
        self.assertEqual(self.stage_done("Opened https://github.com/example/repo/pull/12 for review."), "In Review")

    def test_verified_outcome_is_done(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.assertTrue(self.native("complete_task", task, summary="Rotated the staging certificate and checked it live.",
                                    expected_run_id=run))
        self.ticks()
        self.assertEqual(self.state(), "Done")

    def test_archived_without_outcome_moves_in_progress_to_todo_quietly(self):
        task, _ = self.task(claim=True)
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        said, writes = list(self.remote.bodies("issue-1")), len(self.mutations())
        self.native("archive_task", task)
        self.ticks()
        self.assertEqual(self.state(), "Todo")  # In Progress means an agent is working on it now
        self.assertEqual(self.remote.bodies("issue-1"), said)
        self.assertEqual(len(self.mutations()), writes + 1)  # Todo, once
        self.ticks()
        self.assertEqual(len(self.mutations()), writes + 1)
        self.assertEqual(self.failed(), [])

    def test_archived_without_outcome_from_blocked_moves_to_todo(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.native("block_task", task, reason="Need the API key", kind="needs_input", expected_run_id=run)
        self.ticks()
        self.assertEqual(self.state(), "Blocked")
        self.native("archive_task", task)
        self.ticks()
        self.assertEqual(self.state(), "Todo")

    def test_archived_after_an_older_builds_blocked_closeout_moves_to_todo(self):
        # Live HF-546/HF-575: an older build closed archived work out as Blocked (a terminal row);
        # only a Done closeout is a verified outcome, so the Blocked this app set still parks at Todo.
        task, run = self.task(claim=True)
        self.ticks()
        self.native("block_task", task, reason="Need the API key", kind="needs_input", expected_run_id=run)
        self.ticks()
        self.assertEqual(self.state(), "Blocked")
        self.native("archive_task", task)
        self.bridge.pump_kanban()  # consume the archive before the legacy closeout lands
        with self.bridge.store._tx() as db:
            db.execute("DELETE FROM outbox WHERE kind='status' AND state='pending'")
        self.bridge.store.enqueue("status", {"issue_id": "issue-1", "state": "blocked", "task_id": task,
                                             "terminal": True, "owner_issue_id": "issue-1"}, at=self.bridge.clock())
        self.bridge.flush()
        self.assertTrue(self.bridge.store.terminal_captured(task, issue_id="issue-1"))
        writes = len(self.mutations())
        self.ticks()
        self.assertEqual(self.state(), "Todo")
        self.assertEqual(len(self.mutations()), writes + 1)
        self.ticks()
        self.assertEqual(len(self.mutations()), writes + 1)

    def test_archived_after_a_done_closeout_leaves_done(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.assertTrue(self.native("complete_task", task, summary="Rotated the staging certificate and checked it live.",
                                    expected_run_id=run))
        self.ticks()
        self.assertEqual(self.state(), "Done")
        self.native("archive_task", task)
        writes = len(self.mutations())
        self.ticks()
        self.assertEqual(self.state(), "Done")
        self.assertEqual(len(self.mutations()), writes)

    def test_archived_without_outcome_leaves_a_later_human_move_alone(self):
        task, _ = self.task(claim=True)
        self.ticks()
        self.fixture.fixture.clock.now = time.time() + 2
        self.set_state("Blocked")  # Ken moved it himself after the agent started
        self.native("archive_task", task)
        writes = len(self.mutations())
        self.ticks()
        self.assertEqual(self.state(), "Blocked")
        self.assertEqual(len(self.mutations()), writes)

    def test_archived_without_outcome_leaves_a_later_human_reassignment_alone(self):
        task, _ = self.task(claim=True)
        self.ticks()
        self.fixture.fixture.clock.now = time.time() + 2
        before = dict(self.fixture.issue)
        self.fixture.issue["assignee"] = {"id": "human-2"}
        self.fixture.issue["updatedAt"] = self.fixture.fixture.clock.iso()
        self.remote.record_history("issue-1", "human-1", before, self.fixture.issue)
        self.native("archive_task", task)
        writes = len(self.mutations())
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        self.assertEqual(len(self.mutations()), writes)

    def archived_from(self, name):
        """The issue shows ``name`` (set by this app) when its native task is archived without an outcome."""
        task, _ = self.task(claim=True)
        self.ticks()
        self.fixture.fixture.clock.now = time.time() + 2
        self.set_state(name, actor=SELF)
        self.native("archive_task", task)
        writes = len(self.mutations())
        self.ticks()
        return self.state(), len(self.mutations()) - writes

    def test_archived_without_outcome_leaves_done_alone(self):
        self.assertEqual(self.archived_from("Done"), ("Done", 0))

    def test_archived_without_outcome_leaves_canceled_alone(self):
        self.assertEqual(self.archived_from("Canceled"), ("Canceled", 0))

    def test_archived_without_outcome_leaves_backlog_alone(self):
        self.assertEqual(self.archived_from("Backlog"), ("Backlog", 0))

    def test_archived_without_outcome_leaves_todo_alone(self):
        self.assertEqual(self.archived_from("Todo"), ("Todo", 0))

    # -- the newer human edit wins (#254's routing-history fence) --------

    def test_human_state_move_after_the_native_change_wins(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.native("block_task", task, reason="Need the API key", kind="needs_input", expected_run_id=run)
        self.fixture.fixture.clock.now = time.time() + 2
        self.set_state("Todo")  # Ken parks it himself after the block
        writes = len(self.mutations())
        self.ticks()
        self.assertEqual(self.state(), "Todo")
        self.assertEqual(len(self.mutations()), writes)

    def test_a_later_comment_does_not_stop_the_status_from_following_the_work(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.native("block_task", task, reason="Need the API key", kind="needs_input", expected_run_id=run)
        self.fixture.fixture.clock.now = time.time() + 2
        self.remote.touch("issue-1")  # a comment moves updatedAt; nobody changed routing
        self.ticks()
        self.assertEqual(self.state(), "Blocked")

    def pump_then_comment_then_send(self):
        """The native closeout is queued, then someone comments, then the status is sent."""
        self.fixture.fixture.clock.now = time.time() + 2
        self.bridge.pump_kanban()
        self.fixture.fixture.clock.now += 2
        self.remote.touch("issue-1")  # a comment moves updatedAt; nobody changed routing
        for _ in range(3):
            self.bridge.flush()
            self.bridge.pump_kanban()

    def test_a_comment_before_the_done_send_still_shows_done(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.assertTrue(self.native("complete_task", task, summary="Rotated the staging certificate and checked it live.",
                                    expected_run_id=run))
        self.pump_then_comment_then_send()
        self.assertEqual(self.state(), "Done")

    def test_a_comment_before_the_closeout_blocked_send_still_shows_blocked(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.assertTrue(self.native("complete_task", task, summary="ok", expected_run_id=run))  # no evidence
        self.pump_then_comment_then_send()
        self.assertEqual(self.state(), "Blocked")
        self.assertTrue(any("without evidence" in body for body in self.remote.bodies("issue-1")))

    def test_a_human_move_before_the_done_send_still_wins(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.assertTrue(self.native("complete_task", task, summary="Rotated the staging certificate and checked it live.",
                                    expected_run_id=run))
        self.fixture.fixture.clock.now = time.time() + 2
        self.bridge.pump_kanban()
        self.fixture.fixture.clock.now += 2
        self.set_state("Todo")  # Ken reopens it before Linear shows Done
        self.ticks()
        self.assertEqual(self.state(), "Todo")

    # -- IssueHistory longer than one page (50 entries) -------------------

    def history_entries(self, count, actor):
        """Label, title or estimate edits: IssueHistory grows, routing does not."""
        for _ in range(count):
            self.fixture.fixture.clock.now += 0.01
            self.remote.record_history("issue-1", actor, self.fixture.issue, self.fixture.issue)

    def test_long_agent_only_history_still_shows_done(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.history_entries(60, SELF)  # a long-lived issue the agent has edited many times
        self.assertTrue(self.native("complete_task", task, summary="Rotated the staging certificate and checked it live.",
                                    expected_run_id=run))
        self.pump_then_comment_then_send()
        self.assertEqual(self.state(), "Done")

    def test_long_agent_only_history_still_moves_archived_work_to_todo(self):
        task, _ = self.task(claim=True)
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        self.fixture.fixture.clock.now = time.time() + 2
        self.history_entries(60, SELF)  # the In Progress move is now on history page 2
        self.native("archive_task", task)
        self.ticks()
        self.assertEqual(self.state(), "Todo")

    def test_a_human_move_on_history_page_two_still_wins(self):
        task, run = self.task(claim=True)
        self.ticks()
        self.native("block_task", task, reason="Need the API key", kind="needs_input", expected_run_id=run)
        self.fixture.fixture.clock.now = time.time() + 2
        self.set_state("Todo")  # Ken parks it himself after the block ...
        self.history_entries(60, "human-1")  # ... then edits labels and the title many times
        writes = len(self.mutations())
        self.ticks()
        self.assertEqual(self.state(), "Todo")
        self.assertEqual(len(self.mutations()), writes)

    def test_a_human_move_on_history_page_two_leaves_archived_work_alone(self):
        task, _ = self.task(claim=True)
        self.ticks()
        self.fixture.fixture.clock.now = time.time() + 2
        self.set_state("Blocked")  # Ken moved it himself after the agent started ...
        self.history_entries(60, SELF)  # ... and the agent's later edits push that to page 2
        self.native("archive_task", task)
        writes = len(self.mutations())
        self.ticks()
        self.assertEqual(self.state(), "Blocked")
        self.assertEqual(len(self.mutations()), writes)

    def test_history_paging_is_bounded_and_an_unproven_answer_counts_as_changed(self):
        since = self.fixture.fixture.clock.now * 1000
        self.history_entries(10 * 50 + 1, SELF)  # newer than the fence, beyond the page bound
        self.assertTrue(self.bridge._human_routing_changed("issue-1", since))
        self.assertFalse(self.bridge._human_routing_changed("issue-1", self.fixture.fixture.clock.now * 1000))

    def test_steady_state_is_idempotent_across_restarts(self):
        self.task(claim=True)
        self.ticks()
        writes = len(self.mutations())
        from hermes_fleet_linear_plugin.store import Store
        for _ in range(3):
            self.bridge.store = Store(self.bridge.store.path)
            self.bridge.recover()
            self.ticks(1)
        self.assertEqual(self.state(), "In Progress")
        self.assertEqual(len(self.mutations()), writes)

    # -- stale and legacy records: reconcile once, then stop tracking ----

    def test_binding_whose_native_task_is_gone_is_parked_once_and_untracked(self):
        task, _ = self.task(claim=True)
        with self.board.conn() as db:  # other work on the same board
            self.board.kb.create_task(db, title="Unrelated work", board=self.board.board, created_by="operator")
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        writes = len(self.mutations())
        self.native("delete_task", task)
        for _ in range(3):
            self.bridge.recheck(force=True)
            self.bridge.flush()
        self.assertEqual(self.state(), "Todo")
        self.assertIsNone(self.bridge.store.get("issue-1"))
        self.assertIsNone(self.bridge.store.native_binding("issue-1"))
        self.assertEqual(len(self.mutations()), writes + 1)  # Todo, once

    def test_an_emptied_board_is_not_evidence_that_bound_work_is_gone(self):
        task, _ = self.task(claim=True)
        self.ticks()
        self.native("delete_task", task)  # the board now has no tasks at all
        self.bridge.recheck(force=True)
        self.assertEqual(self.state(), "In Progress")
        self.assertIsNotNone(self.bridge.store.native_binding("issue-1"))

    def legacy(self):
        self.assertTrue(self.bridge.store.put("issue-1", "chat", "agent:main:slack:dm:legacy"))

    def test_pre_rebuild_chat_record_moves_to_todo_once_and_is_retired(self):
        self.set_state("In Progress", actor=SELF)
        self.legacy()
        self.fixture.fixture.clock.now = time.time() + 2
        self.bridge.recheck(force=True)
        self.assertEqual(self.state(), "Todo")
        self.assertIsNone(self.bridge.store.get("issue-1"))
        writes = len(self.mutations())
        self.legacy()  # rerun safety: an already-parked issue is not written again
        self.bridge.recheck(force=True)
        self.assertEqual(len(self.mutations()), writes)
        self.assertIsNone(self.bridge.store.get("issue-1"))

    def test_pre_rebuild_record_leaves_a_human_choice_alone(self):
        self.set_state("In Progress", actor=SELF)
        self.fixture.fixture.clock.now += 1
        self.set_state("Blocked")  # Ken moved it himself
        self.legacy()
        self.bridge.recheck(force=True)
        self.assertEqual(self.state(), "Blocked")
        self.assertEqual(self.mutations(), [])
        self.assertIsNone(self.bridge.store.get("issue-1"))


    # -- the working agent stays visible while work waits (delegate) ------

    def undelegated(self):
        """An older build or restart left the issue without this app as delegate."""
        self.remote.set_delegate("issue-1", None, actor=SELF)

    def delegate_writes(self):
        return [q for q in self.remote.requests if q.startswith("mutation IssueUpdate")]

    def test_blocked_work_gets_its_agent_back_as_delegate_assignee_unchanged(self):
        self.undelegated()
        task, run = self.task(claim=True)
        self.native("block_task", task, reason="Need the API key", kind="needs_input", expected_run_id=run)
        self.ticks()
        self.assertEqual(self.board.get(task).status, "blocked")
        self.assertEqual((self.fixture.issue["delegate"] or {}).get("id"), SELF)
        self.assertEqual(self.fixture.issue["assignee"], {"id": "human-assignee"})

    def test_queued_work_gets_its_agent_back_as_delegate(self):
        self.undelegated()
        task, _ = self.task()
        self.assertEqual(self.board.get(task).status, "ready")
        self.ticks()
        self.assertEqual((self.fixture.issue["delegate"] or {}).get("id"), SELF)
        self.assertEqual(self.state(), "Todo")

    def test_triage_work_gets_its_agent_back_as_delegate(self):
        self.undelegated()
        task, _ = self.task(triage=True)
        self.assertEqual(self.board.get(task).status, "triage")
        self.ticks()
        self.assertEqual((self.fixture.issue["delegate"] or {}).get("id"), SELF)

    def test_work_in_review_gets_its_agent_back_as_delegate(self):
        self.undelegated()
        task, run = self.task(claim=True)
        self.assertTrue(self.native("request_review", task, summary="PR is up for review", expected_run_id=run))
        self.ticks()
        self.assertEqual(self.state(), "In Review")
        self.assertEqual((self.fixture.issue["delegate"] or {}).get("id"), SELF)

    def test_delegate_recovery_is_idempotent(self):
        self.undelegated()
        self.task(triage=True)
        self.ticks()
        writes = len(self.delegate_writes())
        from hermes_fleet_linear_plugin.store import Store
        for _ in range(3):
            self.bridge.store = Store(self.bridge.store.path)
            self.bridge.recover()
            self.ticks(1)
        self.assertEqual(len(self.delegate_writes()), writes)
        self.assertEqual((self.fixture.issue["delegate"] or {}).get("id"), SELF)

    def test_a_human_who_removed_the_delegate_from_waiting_work_wins(self):
        task, _ = self.task(triage=True)
        self.fixture.fixture.clock.now = time.time() + 2
        self.remote.set_delegate("issue-1", None, actor="human-1")  # Ken took the agent off it
        writes = len(self.delegate_writes())
        self.ticks()
        self.assertIsNone(self.fixture.issue["delegate"])
        self.assertEqual(len(self.delegate_writes()), writes)

    def test_finished_work_awaiting_review_gets_its_agent_back_as_delegate(self):
        # Live HF-576, HF-585: a finished stage shows In Review and the agent stays visible on it.
        self.undelegated()
        task, run = self.task(scope="progress", claim=True)
        self.ticks()
        self.assertTrue(self.native("complete_task", task, summary="Drafted the plan.", expected_run_id=run))
        self.ticks()
        self.assertEqual(self.board.get(task).status, "done")
        self.assertEqual(self.state(), "In Review")
        self.assertEqual((self.fixture.issue["delegate"] or {}).get("id"), SELF)
        self.assertEqual(self.fixture.issue["assignee"], {"id": "human-assignee"})

    def test_verified_finished_work_does_not_get_a_delegate_back(self):
        self.undelegated()
        task, run = self.task(claim=True)
        self.native("complete_task", task, summary="Rotated the staging certificate and checked it live.",
                    expected_run_id=run)
        self.ticks()
        self.assertEqual(self.state(), "Done")
        self.assertIsNone(self.fixture.issue["delegate"])

    # -- legacy In Progress with no link and no native task (unbound) -----

    def unbound(self, ident, *, state="In Progress", delegate=SELF, age=7200.0):
        """A pre-native issue this app delegated and moved to ``state``, last touched ``age`` seconds ago."""
        clock = self.fixture.fixture.clock
        clock.now = time.time() - age
        issue = self.remote.add_issue(f"id-{ident}", ident)
        issue["team"] = {**issue["team"], "states": {"nodes": self.states}}
        issue["assignee"] = {"id": "human-assignee"}
        self.remote.set_delegate(issue["id"], delegate and {"id": delegate, "name": "This Agent"}, actor=SELF)
        self.remote.set_state(issue["id"], state, actor=SELF)
        clock.now = time.time()
        return issue

    def sweep(self):
        self.fixture.fixture.clock.now = time.time()
        return self.bridge.sweep_unbound(force=True)

    def test_unbound_in_progress_this_app_set_goes_to_todo_once(self):
        issue = self.unbound("ABC-506")
        self.assertEqual(self.sweep(), 1)
        self.assertEqual(self.remote.state(issue["id"]), "Todo")
        self.assertEqual(issue["delegate"]["id"], SELF)  # delegate and assignee unchanged
        self.assertEqual(issue["assignee"], {"id": "human-assignee"})
        writes = len(self.mutations())
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(len(self.mutations()), writes)

    def created_in_progress(self, ident, creator):
        """Live HF-506..HF-564: created already In Progress and delegated, so no state move is on record."""
        self.fixture.fixture.clock.now = time.time() - 7200
        issue = self.remote.add_issue(f"id-{ident}", ident)
        issue.update(creator={"id": creator}, delegate={"id": SELF, "name": "This Agent"},
                     state=dict(next(s for s in self.states if s["name"] == "In Progress")))
        return issue

    def test_unbound_issue_this_app_created_in_progress_goes_to_todo(self):
        self.bridge.api.specialist_scope = None  # this fixture's scope admits only human-1's issues
        issue = self.created_in_progress("ABC-564", SELF)
        self.assertEqual(self.sweep(), 1)
        self.assertEqual(self.remote.state(issue["id"]), "Todo")

    def test_unbound_issue_a_person_created_in_progress_is_left(self):
        self.bridge.api.specialist_scope = None
        issue = self.created_in_progress("ABC-565", "human-1")
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(self.remote.state(issue["id"]), "In Progress")

    def test_unbound_blocked_and_in_review_are_left(self):
        # Only In Progress claims active work; Blocked and In Review already say what is true.
        blocked = self.unbound("ABC-507", state="Blocked")
        review = self.unbound("ABC-517", state="In Review")
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(self.remote.state(blocked["id"]), "Blocked")
        self.assertEqual(self.remote.state(review["id"]), "In Review")
        self.assertEqual(self.mutations(), [])

    def test_unbound_issue_a_human_moved_is_left(self):
        issue = self.unbound("ABC-508")
        self.fixture.fixture.clock.now = time.time() - 3600 * 1.5
        self.remote.set_state(issue["id"], "Blocked", actor="human-1")
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(self.remote.state(issue["id"]), "Blocked")
        self.assertEqual(self.mutations(), [])

    def test_unbound_issue_a_human_reassigned_is_left(self):
        issue = self.unbound("ABC-509")
        self.fixture.fixture.clock.now = time.time() - 3600 * 1.5
        self.remote.set_assignee(issue["id"], {"id": "human-2"}, actor="human-1")
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(self.remote.state(issue["id"]), "In Progress")
        self.assertEqual(self.mutations(), [])

    def test_unbound_issue_with_a_native_task_is_left(self):
        issue = self.unbound("ABC-510")
        with self.board.conn() as db:
            self.board.kb.create_task(db, title="Unlinked native work", board=self.board.board,
                                      assignee=self.board.executor_profile, created_by="operator",
                                      body=f"Linear issue {issue['id']}: {issue['url']}")
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(self.remote.state(issue["id"]), "In Progress")
        self.assertEqual(self.mutations(), [])

    def test_bound_running_work_is_not_touched_by_the_sweep(self):
        self.task(claim=True)
        self.ticks()
        self.assertEqual(self.state(), "In Progress")
        writes = len(self.mutations())
        self.fixture.fixture.clock.now = time.time() + 7200
        self.assertEqual(self.bridge.sweep_unbound(force=True), 0)
        self.assertEqual(self.state(), "In Progress")
        self.assertEqual(len(self.mutations()), writes)

    def test_recently_touched_unbound_issue_waits_then_moves(self):
        issue = self.unbound("ABC-511", age=60)
        self.assertEqual(self.sweep(), 0)  # it may be getting linked right now
        self.assertEqual(self.remote.state(issue["id"]), "In Progress")
        self.fixture.fixture.clock.now = time.time() + 3600
        self.assertEqual(self.bridge.sweep_unbound(force=True), 1)
        self.assertEqual(self.remote.state(issue["id"]), "Todo")

    def test_another_apps_issue_is_not_listed(self):
        issue = self.unbound("ABC-512", delegate="app-other")
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(self.remote.state(issue["id"]), "In Progress")

    def test_sweep_is_bounded_and_pages(self):
        issues = [self.unbound(f"ABC-{600 + n}") for n in range(53)]
        self.bridge.UNBOUND_SWEEP_MOVES = 100
        self.assertEqual(self.sweep(), 53)  # two pages of the listing
        self.assertTrue(all(self.remote.state(issue["id"]) == "Todo" for issue in issues))
        more = [self.unbound(f"ABC-{700 + n}") for n in range(3)]
        self.bridge.UNBOUND_SWEEP_MOVES = 2
        self.assertEqual(self.sweep(), 2)
        self.assertEqual(self.sweep(), 1)
        self.assertTrue(all(self.remote.state(issue["id"]) == "Todo" for issue in more))

    def test_sweep_runs_at_most_hourly_from_the_recheck(self):
        issue = self.unbound("ABC-513")
        self.bridge.recheck(force=True)
        self.assertEqual(self.remote.state(issue["id"]), "Todo")
        later = self.unbound("ABC-514")
        self.bridge.recheck(force=True)
        self.assertEqual(self.remote.state(later["id"]), "In Progress")  # next pass is an hour later
        self.fixture.fixture.clock.now = time.time() + 3601
        self.bridge.recheck(force=True)
        self.assertEqual(self.remote.state(later["id"]), "Todo")


if __name__ == "__main__":
    unittest.main()
