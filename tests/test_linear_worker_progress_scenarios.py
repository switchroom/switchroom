"""Delegate-to-issue -> real native claim -> live step before the worker finishes.

The existing finite provider and native board run the production entrypoints.
Only Core's read-only current-execution projection is supplied at its boundary;
no model, process launcher or live account is used.
"""
import os
import unittest
from unittest.mock import patch

import test_linear_status_follows_work_scenarios as status


@unittest.skipUnless(os.environ.get("HERMES_AGENT_SRC"), "requires explicit native source")
class WorkerProgressScenarios(unittest.TestCase):
    def setUp(self):
        self.fixture = status.StatusFollowsWorkScenarios()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.bridge, self.board, self.remote = self.fixture.bridge, self.fixture.board, self.fixture.remote

    def delegated(self):
        task = self.fixture.admitted_by_delegation(turn=False)
        claimed = self.fixture.native("claim_task", task, claimer="actual-native-worker")
        self.assertIsNotNone(claimed)
        self.bridge.flush()
        return claimed

    def projection(self, task):
        return {"worker_session_id": "kanbanCore-worker", "execution_generation": 1,
                "admission_id": "worker-admission", "run_id": task.current_run_id,
                "phrase": "in the terminal"}

    def worker_rows(self):
        with self.bridge.store._tx() as db:
            ids = [row[0] for row in db.execute("SELECT id FROM outbox WHERE json_extract(payload,'$.worker_step') IS NOT NULL")]
        return [self.bridge.store.outbox_row(row) for row in ids]

    def test_actual_delegation_claim_reports_open_tool_during_long_foreground_command(self):
        from hermes_fleet_linear_plugin import worker_progress
        task = self.delegated()
        before = self.fixture.fixture.snapshot()
        with patch.object(worker_progress, "current", side_effect=lambda adapter, actual:
                self.projection(actual) if actual.status == "running" else None):
            self.bridge.pump_kanban()
            self.bridge.flush()
            rows = self.worker_rows()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["state"], "sent")
            self.assertTrue(rows[0]["payload"].get("applied", True))
            self.assertTrue(any(activity.get("id") == rows[0]["id"] for activity in self.remote.activities))
            step = rows[0]["payload"]
            self.assertEqual(step["session_id"], "human-assignment")
            self.assertEqual(step["task_id"], task.id)
            self.assertEqual(step["content"], {"type": "action", "action": "Working", "parameter": self.projection(task)["phrase"]})
            self.assertTrue(step["ephemeral"])
            # The foreground command is still running seventy seconds later. A
            # changed tool is eligible after sixty seconds, unchanged after 600.
            self.fixture.fixture.fixture.clock.now += 70
            self.bridge.pump_kanban()
            self.bridge.flush()
            self.assertEqual(len(self.worker_rows()), 1)
        self.assertEqual(self.board.get(task.id).current_run_id, task.current_run_id)
        self.assertEqual(self.fixture.fixture.snapshot(), before, "reporting must not create, adopt or alter another worker")

    def test_queued_worker_step_yields_to_native_stop_before_transport(self):
        from hermes_fleet_linear_plugin import worker_progress
        task = self.delegated()
        with patch.object(worker_progress, "current", side_effect=lambda adapter, actual:
                self.projection(actual) if actual.status == "running" else None):
            self.bridge.pump_kanban()
            self.assertEqual(len(self.worker_rows()), 1)
            self.fixture.native("block_task", task.id, reason="Stopped by the requester", kind="needs_input",
                                expected_run_id=task.current_run_id)
            self.bridge.pump_kanban()
            self.bridge.flush()
        row = self.worker_rows()[0]
        self.assertEqual(row["state"], "sent")
        self.assertFalse(row["payload"].get("applied"))
        self.assertFalse(any(activity.get("id") == row["id"] for activity in self.remote.activities))

    def test_completion_during_step_uses_existing_readable_closeout_once(self):
        from hermes_fleet_linear_plugin import worker_progress
        task = self.delegated()
        original = self.bridge.api.create_activity
        finished = []
        summary = "Checked the delegated command successfully. Evidence: its bounded verification passed. Nothing remains."
        def publish(*args, **kwargs):
            result = original(*args, **kwargs)
            if kwargs.get("ephemeral") and not finished:
                finished.append(self.fixture.native("complete_task", task.id, summary=summary,
                    expected_run_id=task.current_run_id))
            return result
        with patch.object(worker_progress, "current", side_effect=lambda adapter, actual:
                self.projection(actual) if actual.status == "running" else None), \
                patch.object(self.bridge.api, "create_activity", side_effect=publish):
            self.bridge.pump_kanban()
            self.bridge.flush()
            self.bridge.pump_kanban()
            self.bridge.flush()
        self.assertEqual(finished, [True])
        finals = [activity for activity in self.remote.activities if activity["content"]["type"] == "response"]
        self.assertEqual(len(finals), 1, "Only the existing outcome projector completes the session")
        self.assertEqual(len(self.remote.comments), 1)
        self.assertIn(summary, self.remote.comments[0]["body"])
        self.assertNotIn(summary, finals[0]["content"]["body"])
        self.assertNotIn(task.id, finals[0]["content"]["body"])
