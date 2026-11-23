"""Completion ownership through real reporting capture, CAS, and the HTTP guard.

Native task rows/history and the remote authority are synthetic; Bridge, Store,
the scoped API and durable outbox are real. These tests grant no execution and
make no deployed/client acceptance claim.
"""
from contextlib import contextmanager
import copy
import datetime
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import uuid

from test_linear_specialist_authorization import (
    Authority, Bridge, FakeKanban, Store, ISSUE, PROJECT, SESSION, USER, VIEWER,
)


class CompletionScopeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.authority = Authority()
        self.authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
        self.authority.issues[ISSUE]['assignee'] = {'id': USER}
        self.store = Store(Path(temporary.name) / 'linear.db')
        self.kanban = FakeKanban()
        self.task = self.kanban.create(title='OPS-1: Deliver the finite outcome',
            body='Deliver the final artifact and verify recovery before completing this outcome.',
            completion_contract='local-only')
        self.kanban.histories[self.task.id] = [SimpleNamespace(
            id=1, kind='created', created_at=1800000000, run_id=None, payload={})]
        self.api = self.authority.api()
        self.bridge = Bridge(self.store, self.api, self.kanban, profile='synthetic', clock=lambda: 1800000000)

    def human_edit(self, at):
        self.authority.human_edit(ISSUE, datetime.datetime.fromtimestamp(at, datetime.timezone.utc).isoformat())

    def event(self, kind, payload=None):
        history = self.kanban.histories[self.task.id]
        event = SimpleNamespace(id=max(row.id for row in history) + 1, kind=kind,
                                created_at=1800000000 + len(history), run_id=1, payload=payload or {})
        history.append(event)
        return event

    def track(self, **kwargs):
        return self.bridge.track(ISSUE, self.task.id, requester_session=SESSION, **kwargs)

    def complete(self):
        self.task.status = 'done'
        self.task.result = 'Verified the finite outcome and its retained final deliverable.'
        completed = self.event('completed', {'summary': self.task.result})
        self.bridge._finished(self.store.get(ISSUE), event_id=completed.id)
        return completed

    def assert_no_outcome_closeout(self):
        pending = self.store.pending(ISSUE)
        self.assertFalse(any(row['kind'] == 'status' and row['payload'].get('state') == 'done'
                             for row in pending), pending)
        for row in self.store.pending():
            if row['kind'] == 'project_update':
                self.assertFalse(any(str(line).startswith('Done')
                                     for line in row['payload'].get('lines', {}).values()), row)
        self.assertNotEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        self.assertEqual(self.authority.issues[ISSUE]['assignee'], {'id': USER})
        self.assertEqual(self.authority.issues[ISSUE]['project'], {'id': PROJECT})

    def test_unchanged_outcome_completion_keeps_normal_done_and_project_delivery(self):
        self.track()
        self.complete()
        pending = self.store.pending()
        self.assertTrue(any(row['kind'] == 'status' and row['payload'].get('state') == 'done'
                            for row in pending))
        self.assertTrue(any(row['kind'] == 'project_update' for row in pending))
        self.bridge.flush()
        self.assertEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        self.assertTrue(any('projectUpdateCreate' in query for query in self.authority.mutations))
        self.assertEqual(self.task.status, 'done')
        self.assertEqual(len(self.kanban.creates), 1)

    def test_explicit_internal_progress_completion_reports_stage_without_done(self):
        self.track(completion_scope='progress')
        self.task.body = 'Read-only preparation was completed; final delivery remains outstanding.'
        # Bind the actual stage before completing it; this is not a spec-drift test.
        revision = self.store.binding_revision(ISSUE)
        self.track(completion_scope='progress', replace=True, expected_revision=revision, request_id=str(uuid.uuid4()))
        self.complete()
        self.assert_no_outcome_closeout()
        reports = self.store.pending()
        self.assertTrue(any(row['kind'] in {'activity', 'comment', 'project_update'} for row in reports))
        self.assertEqual(self.task.status, 'done')

    def test_post_bind_title_body_and_contract_drift_cannot_close_outcome(self):
        for field, value in (('title', 'OPS-1: Approve the read-only hold'),
                             ('body', 'Only verify preparation; never create the final artifact.'),
                             ('completion_contract', 'https://github.com/example/repo/pull/1')):
            with self.subTest(field=field):
                self.setUp()
                self.track()
                setattr(self.task, field, value)
                self.event('specified', {'changed_fields': [field]})
                # Even an otherwise accepted replacement contract cannot grant
                # ownership of the original outcome to a different task scope.
                from unittest.mock import patch
                from hermes_fleet_linear_plugin import bridge as bridge_module
                with patch.object(bridge_module, 'pr_state', return_value=None):
                    self.complete()
                self.assert_no_outcome_closeout()
                self.assertEqual(self.task.status, 'done')

    def test_comment_followup_leaves_outcome_scope_unchanged(self):
        self.track()
        before = copy.deepcopy(self.store.native_binding(ISSUE))
        self.bridge.followup(ISSUE, 'Keep the existing acceptance and verify the remaining checks.',
                             str(uuid.uuid4()), requester_session=SESSION)
        self.event('commented', {'author': 'operator', 'len': 68})
        self.assertEqual(self.store.native_binding(ISSUE), before)
        self.complete()
        self.assertTrue(any(row['kind'] == 'status' and row['payload'].get('state') == 'done'
                            for row in self.store.pending()))
        self.assertEqual(len(self.kanban.creates), 1)

    def test_stale_queued_done_is_rechecked_at_last_http_guard(self):
        self.track()
        self.complete()
        status = next(row for row in self.store.pending() if row['kind'] == 'status'
                      and row['payload'].get('state') == 'done')
        guarded = self.api.guarded_mutation
        reached = []

        @contextmanager
        def changed_at_transport_boundary(guard):
            @contextmanager
            def changed_guard():
                reached.append(True)
                self.task.body = 'A later specification permits only read-only preparation.'
                self.event('specified', {'changed_fields': ['body']})
                with guard():
                    yield
            with guarded(changed_guard):
                yield

        self.api.guarded_mutation = changed_at_transport_boundary
        self.bridge.flush()
        self.assertTrue(reached, 'the fixture must reach the real final mutation guard')
        self.assertFalse(any('issueUpdate' in query for query in self.authority.mutations))
        self.assertFalse(any('projectUpdateCreate' in query for query in self.authority.mutations))
        self.assertNotEqual(self.store.outbox_row(status['id'])['state'], 'sent')
        self.assertEqual(self.task.status, 'done')
        self.assertNotEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')

    def test_legacy_binding_without_completion_snapshot_is_not_outcome_authority(self):
        self.assertTrue(self.store.bind_native(ISSUE, self.task.id, 'synthetic', 'default',
                                              owner_ref=SESSION, project_id=PROJECT, at=1))
        self.complete()
        self.assert_no_outcome_closeout()
        self.assertEqual(self.task.status, 'done')

    def test_same_task_cas_reconciliation_accepts_current_scope_before_completion(self):
        self.track()
        stale = self.store.binding_revision(ISSUE)
        self.task.body = 'Deliver the explicitly reconciled finite outcome and retain its final artifact.'
        self.event('specified', {'changed_fields': ['body']})
        result = self.track(replace=True, expected_revision=stale, request_id=str(uuid.uuid4()))
        self.assertEqual(result['task_id'], self.task.id)
        self.assertTrue(result['reporting_only'])
        current = copy.deepcopy(self.store.native_binding(ISSUE))
        from hermes_fleet_linear_plugin.api import LinearError
        with self.assertRaises(LinearError):
            self.track(replace=True, expected_revision=stale, request_id=str(uuid.uuid4()))
        self.assertEqual(self.store.native_binding(ISSUE), current)
        self.complete()
        self.assertTrue(any(row['kind'] == 'status' and row['payload'].get('state') == 'done'
                            for row in self.store.pending()))
        self.assertEqual(len(self.kanban.creates), 1)

    def test_scope_reconciliation_preserves_consumed_progress_history_without_replay(self):
        self.track(completion_scope='progress')
        completed = self.complete()
        previous = {row['id']: copy.deepcopy(row) for row in self.store.pending()}
        self.track(completion_scope='outcome', replace=True,
                   expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.bridge._finished(self.store.get(ISSUE), event_id=completed.id)
        self.assert_no_outcome_closeout()
        self.assertFalse(set(row['id'] for row in self.store.pending()) - set(previous))
        for row_id, row in previous.items():
            retained = self.store.outbox_row(row_id)
            self.assertEqual({key: value for key, value in retained.items() if key != 'hold_reason'},
                             {key: value for key, value in row.items() if key != 'hold_reason'})
        self.assertEqual(len(self.kanban.creates), 1)

    def test_foreign_task_and_stale_cas_never_replace_original_scope(self):
        self.track()
        original = copy.deepcopy(self.store.native_binding(ISSUE))
        self.task.assignee = 'foreign-executor'
        from hermes_fleet_linear_plugin.api import LinearError
        with self.assertRaises(LinearError):
            self.track(completion_scope='progress', replace=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.assertEqual(self.store.native_binding(ISSUE), original)

    def test_deliberate_finished_outcome_reconciles_only_reporting_once(self):
        self.track(completion_scope='progress')
        completed = self.complete()
        history = copy.deepcopy(self.kanban.histories[self.task.id])
        old = {row['id']: copy.deepcopy(row) for row in self.store.pending()}
        cursor = self.store.get(ISSUE)['last_event_id']
        request = dict(replace=True, completion_scope='outcome', reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        result = self.track(**request)
        self.assertTrue(result['completion_reporting_reconciled'])
        self.assertTrue(result['publication_requires_readback'])
        self.assertEqual(self.store.get(ISSUE)['last_event_id'], cursor)
        queued = {row['id'] for row in self.store.pending()}
        self.assertTrue(any(row['kind'] == 'status' and row['payload'].get('state') == 'done'
                            for row in self.store.pending()))
        self.track(**request)  # response loss reuses the original UUID and CAS preimage
        self.assertEqual({row['id'] for row in self.store.pending()}, queued)
        self.track(replace=True, completion_scope='outcome', reconcile_complete=True,
                   expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.assertEqual({row['id'] for row in self.store.pending()}, queued)
        for row_id, row in old.items():
            retained = self.store.outbox_row(row_id)
            self.assertEqual({key: value for key, value in retained.items() if key != 'hold_reason'},
                             {key: value for key, value in row.items() if key != 'hold_reason'})
        self.assertEqual(self.kanban.histories[self.task.id], history)
        self.assertEqual(len(self.kanban.creates), 1)
        self.assertEqual(self.task.status, 'done')
        intent = self.store.native_intent(f"track:{ISSUE}:{request['request_id']}")
        self.assertEqual(intent['state'], 'applied')
        self.assertTrue(intent['payload']['request']['reconcile_complete'])
        self.assertEqual(self.store.outbox_row(request['request_id'])['payload']['native_completion']['event_id'], completed.id)
        self.bridge.flush()
        self.assertEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        self.assertEqual(sum('issueUpdate' in query for query in self.authority.mutations), 1)
        self.assertEqual(sum('projectUpdateCreate' in query for query in self.authority.mutations), 1)

    def test_finish_only_reconciliation_refuses_unfinished_or_progress_requests(self):
        self.track()
        original = copy.deepcopy(self.store.native_binding(ISSUE))
        from hermes_fleet_linear_plugin.api import LinearError
        for args in ({'replace': False}, {'replace': True, 'completion_scope': 'progress'}, {'replace': True}):
            with self.subTest(args=args), self.assertRaises(LinearError):
                self.track(reconcile_complete=True, expected_revision=self.store.binding_revision(ISSUE),
                           request_id=str(uuid.uuid4()), **args)
        self.assertEqual(self.store.native_binding(ISSUE), original)
        self.assertEqual(len(self.kanban.creates), 1)

    def test_done_without_native_completed_event_cannot_reconcile_reporting(self):
        self.track(completion_scope='progress')
        original = copy.deepcopy(self.store.native_binding(ISSUE))
        self.task.status = 'done'
        from hermes_fleet_linear_plugin.api import LinearError
        with self.assertRaisesRegex(LinearError, 'no completed event'):
            self.track(replace=True, reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.assertEqual(self.store.native_binding(ISSUE), original)
        self.assert_no_outcome_closeout()

    def test_scope_change_during_finish_only_evidence_check_cannot_queue_done(self):
        self.track(completion_scope='progress')
        self.complete()
        def narrow(*args, **kwargs):
            self.task.body = 'Only approve the hold; the human outcome is still incomplete.'
            self.event('specified', {'changed_fields': ['body']})
            return ""
        from hermes_fleet_linear_plugin.api import LinearError
        from hermes_fleet_linear_plugin import bridge as bridge_module
        from unittest.mock import patch
        with patch.object(bridge_module, '_pr_lines', side_effect=narrow), self.assertRaises(LinearError):
            self.track(replace=True, reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.assert_no_outcome_closeout()
        self.assertEqual(len(self.kanban.creates), 1)

    def test_current_reporting_reconciliation_can_follow_an_issue_correction(self):
        self.track(completion_scope='progress')
        self.complete()
        self.human_edit(1800000100)
        self.bridge.clock = lambda: 1800000300
        request = dict(replace=True, reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.track(**request)
        status = self.store.outbox_row(request['request_id'])
        self.assertEqual(status['payload']['source_ms'], 1800000300000)
        self.bridge.flush()
        self.assertEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        self.assertEqual(sum('issueUpdate' in query for query in self.authority.mutations), 1)

    def test_newer_human_change_still_fences_finish_only_retry(self):
        self.track(completion_scope='progress')
        self.complete()
        self.bridge.clock = lambda: 1800000300
        request = dict(replace=True, reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.track(**request)
        self.human_edit(1800000400)
        self.bridge.clock = lambda: 1800000500
        self.track(**request)
        self.assertEqual(self.store.outbox_row(request['request_id'])['payload']['source_ms'], 1800000300000)
        self.bridge.flush()
        self.assertFalse(any('issueUpdate' in query for query in self.authority.mutations))
        self.assertNotEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        self.assertEqual(len(self.kanban.creates), 1)

    def test_reconciliation_uuid_cannot_settle_another_issue_on_the_same_task(self):
        self.track(completion_scope='progress')
        self.complete()
        request_id = str(uuid.uuid4())
        self.track(replace=True, reconcile_complete=True, request_id=request_id,
                   expected_revision=self.store.binding_revision(ISSUE))
        original = copy.deepcopy(self.store.outbox_row(request_id))
        other = 'issue-second-outcome'
        self.authority.issues[other] = {**copy.deepcopy(self.authority.issues[ISSUE]),
                                      'id': other, 'identifier': 'OPS-2'}
        self.bridge.track(other, self.task.id, completion_scope='progress', requester_session=SESSION)
        # Marker-free manual work may report to two authorized issues. Its
        # identical native proof cannot make a foreign outbox UUID ours.
        with self.assertRaisesRegex(ValueError, 'UUID conflicts'):
            self.bridge.track(other, self.task.id, replace=True, reconcile_complete=True,
                              request_id=request_id, expected_revision=self.store.binding_revision(other),
                              requester_session=SESSION)
        self.assertEqual(self.store.outbox_row(request_id), original)
        self.assertFalse(any(row['kind'] == 'status' and row['payload'].get('state') == 'done'
                             for row in self.store.pending(other)))
        self.assertEqual(len(self.kanban.creates), 1)


    def test_known_unapplied_automatic_done_allows_fresh_finish_only_repair(self):
        self.track()
        self.complete()
        original = next(row for row in self.store.pending() if row['kind'] == 'status')
        closing = next(row for row in self.store.pending() if row['payload'].get('native_outcome_comment'))
        self.human_edit(1800000100)
        self.bridge.clock = lambda: 1800000300
        self.bridge.flush()
        obsolete = self.store.outbox_row(original['id'])
        self.assertEqual((obsolete['state'], obsolete['payload'].get('applied')), ('sent', 0))
        self.assertNotEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        native_history = copy.deepcopy(self.kanban.histories[self.task.id])
        cursor = self.store.get(ISSUE)['last_event_id']
        request = dict(replace=True, completion_scope='outcome', reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        result = self.track(**request)
        self.assertTrue(result['completion_reporting_reconciled'])
        repair = self.store.outbox_row(request['request_id'])
        self.assertIsNotNone(repair, 'A known unapplied obsolete report cannot satisfy a fresh repair')
        self.assertEqual(repair['payload']['source_ms'], 1800000300000)
        self.track(**request)
        self.assertEqual(self.store.outbox_row(request['request_id']), repair)
        self.bridge.flush()
        self.assertEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        self.assertEqual(self.store.outbox_row(original['id']), obsolete)
        self.assertEqual(self.store.get(ISSUE)['last_event_id'], cursor)
        self.assertEqual(self.kanban.histories[self.task.id], native_history)
        self.assertEqual(len(self.kanban.creates), 1)
        repaired_comment = self.store.outbox_row(closing['id'])
        self.assertEqual((repaired_comment['state'], repaired_comment['payload']['applied']), ('sent', 1))
        self.assertEqual(repaired_comment['payload']['body'], closing['payload']['body'])
        self.assertEqual(repaired_comment['payload']['requires_status_id'], request['request_id'])
        self.assertEqual(list(self.authority.comment_records), [closing['id']])
        self.assertIsNone(self.authority.comment_records[closing['id']]['parent'])
        self.assertEqual(sum('commentCreate' in query for query in self.authority.mutations), 1)

    def test_fresh_status_repair_preserves_applied_or_uncertain_comment_receipt(self):
        for disposition in ('applied', 'uncertain'):
            with self.subTest(disposition=disposition):
                self.setUp()
                self.track()
                self.complete()
                status = next(row for row in self.store.pending() if row['kind'] == 'status')
                closing = next(row for row in self.store.pending() if row['payload'].get('native_outcome_comment'))
                self.bridge.flush(only_id=status['id'])
                if disposition == 'applied':
                    self.bridge.flush(only_id=closing['id'])
                else:
                    # Crash after mutation admission: transmission may have occurred.
                    self.assertTrue(self.store.admit_mutation(closing['id'], terminal=True))
                receipt = self.store.outbox_row(closing['id'])
                self.human_edit(1800000100)
                self.bridge.clock = lambda: 1800000300
                self.track(replace=True, completion_scope='outcome', reconcile_complete=True,
                           expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
                self.assertEqual(self.store.outbox_row(closing['id']), receipt)
                with self.store._tx() as db:
                    count = db.execute("SELECT COUNT(*) FROM outbox WHERE json_extract(payload,'$.native_outcome_comment')=1").fetchone()[0]
                self.assertEqual(count, 1)
                self.assertEqual(len(self.authority.comment_records), int(disposition == 'applied'))

    def test_repair_rejects_stable_comment_identity_with_conflicting_body(self):
        self.track()
        self.complete()
        closing = next(row for row in self.store.pending() if row['payload'].get('native_outcome_comment'))
        self.human_edit(1800000100)
        self.bridge.clock = lambda: 1800000300
        self.bridge.flush()
        with self.store._tx() as db:
            db.execute("UPDATE outbox SET payload=json_set(payload,'$.body','Conflicting retained result') WHERE id=?", (closing['id'],))
        request_id = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, 'Native outcome comment identity conflicts'):
            self.track(replace=True, completion_scope='outcome', reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=request_id)
        self.assertIsNone(self.store.outbox_row(request_id))
        self.assertEqual(self.authority.comment_records, {})
        self.assertNotEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')

    def test_same_proof_pending_unknown_and_applied_reports_prevent_duplicate_repair(self):
        from hermes_fleet_linear_plugin.api import LinearError
        for disposition in ('pending', 'unknown', 'applied'):
            with self.subTest(disposition=disposition):
                self.setUp()
                self.track()
                self.complete()
                original = next(row for row in self.store.pending() if row['kind'] == 'status')
                if disposition == 'unknown':
                    self.assertTrue(self.store.admit_mutation(original['id'], terminal=True))
                    self.assertTrue(self.store.outbox_row(original['id'])['payload']['write_started'])
                elif disposition == 'applied':
                    self.bridge.flush(only_id=original['id'])
                    applied = self.store.outbox_row(original['id'])
                    self.assertEqual((applied['state'], applied['payload']['applied']), ('sent', 1))
                request_id = str(uuid.uuid4())
                before = self.store.outbox_row(original['id'])
                try:
                    self.track(replace=True, completion_scope='outcome', reconcile_complete=True,
                               expected_revision=self.store.binding_revision(ISSUE), request_id=request_id)
                except LinearError:
                    if disposition != 'unknown':
                        raise
                self.assertIsNone(self.store.outbox_row(request_id))
                self.assertEqual(self.store.outbox_row(original['id']), before)
                self.assertEqual(len(self.kanban.creates), 1)

    def test_newer_human_edit_still_fences_fresh_repair_of_known_unapplied_done(self):
        self.track()
        self.complete()
        self.human_edit(1800000100)
        self.bridge.clock = lambda: 1800000300
        self.bridge.flush()
        request = dict(replace=True, completion_scope='outcome', reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.track(**request)
        self.assertIsNotNone(self.store.outbox_row(request['request_id']))
        self.human_edit(1800000400)
        self.bridge.clock = lambda: 1800000500
        self.track(**request)
        self.authority.mutations.clear()
        self.bridge.flush()
        self.assertNotEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        self.assertFalse(any('issueUpdate' in query for query in self.authority.mutations))
        self.assertEqual(self.store.outbox_row(request['request_id'])['payload']['source_ms'], 1800000300000)

    def test_same_known_unapplied_repair_uuid_never_claims_or_retimes_success(self):
        self.track(completion_scope='progress')
        self.complete()
        self.bridge.clock = lambda: 1800000300
        request = dict(replace=True, completion_scope='outcome', reconcile_complete=True,
                       expected_revision=self.store.binding_revision(ISSUE), request_id=str(uuid.uuid4()))
        self.assertTrue(self.track(**request)['completion_reporting_reconciled'])
        self.human_edit(1800000400)
        self.bridge.clock = lambda: 1800000500
        self.bridge.flush()
        obsolete = self.store.outbox_row(request['request_id'])
        self.assertEqual((obsolete['state'], obsolete['payload'].get('applied')), ('sent', 0))
        cursor = self.store.get(ISSUE)['last_event_id']
        self.authority.mutations.clear()
        result = self.track(**request)
        self.assertFalse(result['completion_reporting_reconciled'])
        self.assertEqual(self.store.outbox_row(request['request_id']), obsolete)
        self.assertEqual(self.store.get(ISSUE)['last_event_id'], cursor)
        self.bridge.flush()
        self.assertEqual(self.authority.mutations, [])
        self.assertNotEqual(self.authority.issues[ISSUE]['state']['type'], 'completed')
        self.assertEqual(len(self.kanban.creates), 1)


if __name__ == '__main__':
    unittest.main()
