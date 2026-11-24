"""Durable delivery regressions using the real bridge and persisted outbox.

HF-562 migration: acknowledgement-first worker admission is replaced by native
request-intent durability; a receipt never owns execution. Human edits and
requester provenance remain guarded while native task/binding history survives.
Comment/description tests prove readback and uncertain-response reconciliation
without requiring an execution binding. These are backend tests, not deployed
Desktop or messaging delivery evidence.
"""
import tempfile
import uuid
import json
import sqlite3
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from linear_fake_api import load_plugin
load_plugin()
from hermes_fleet_linear_plugin.bridge import Kanban
from hermes_fleet_linear_plugin import bridge as bridge_module
import unittest
from pathlib import Path

from test_linear_specialist_authorization import (
    Authority, FakeKanban, Bridge, Store, ISSUE, SESSION, USER, VIEWER,
)


class DurableCloseoutTests(unittest.TestCase):
    def test_human_edit_before_native_request_prevents_worker_provisioning(self):
        for change in ('reassigned', 'completed', 'canceled'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                authority = Authority()
                authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
                store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
                api = authority.api()
                original, reads = api.issue, []
                def changed(ref):
                    reads.append(ref)
                    if len(reads) == 3:
                        if change == 'reassigned':
                            authority.issues[ISSUE]['delegate'] = {'id': 'other-agent'}
                        else:
                            authority.issues[ISSUE]['state'] = {'type': change, 'name': change}
                    return original(ref)
                api.issue = changed
                bridge = Bridge(store, api, kanban, profile='synthetic', clock=lambda: 10)
                self.assertFalse(bridge._start({}, authority.issues[ISSUE], SESSION, 1, 'synthetic-start'))
                self.assertEqual(kanban.creates, [])
                self.assertIsNone(store.get(ISSUE))
                self.assertEqual(authority.mutations, [])


    def test_advisory_receipt_failure_never_restarts_or_blocks_native_work(self):
        legacy = str(uuid.uuid5(uuid.NAMESPACE_URL, f'linear-session-received:{ISSUE}:{SESSION}'))
        for mode in ('rejected', 'unavailable', 'legacy_pending', 'legacy_failed'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                authority = Authority()
                authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
                api = authority.api()
                original = authority.transport
                def transport(url, body, headers):
                    if mode in ('rejected', 'unavailable') and 'agentActivityCreate' in json.loads(body)['query']:
                        if mode == 'unavailable': return 503, {}, b'{}'
                        return 200, {}, json.dumps({'data': None, 'errors': [
                            {'message': 'Argument Validation Error', 'extensions': {'code': 'INPUT_ERROR'}}]}).encode()
                    return original(url, body, headers)
                api.transport = transport
                store = Store(Path(directory) / 'state.db')
                if mode.startswith('legacy'):
                    store.enqueue('activity', {'id': legacy, 'issue_id': ISSUE, 'initial_ack': True,
                        'session_id': SESSION, 'requester_sessions': {ISSUE: SESSION},
                        'content': {'type': 'thought', 'body': 'Received.'}}, at=1)
                    if mode == 'legacy_failed':
                        # Seed a previously failed historical receipt; current consumers must not rewrite it.
                        with sqlite3.connect(store.path) as db:
                            db.execute("UPDATE outbox SET state='failed',attempts=2 WHERE id=?", (legacy,))
                    before_legacy = store.outbox_row(legacy)
                kanban = FakeKanban()
                bridge = Bridge(store, api, kanban, profile='synthetic', clock=lambda: 10)
                self.assertTrue(bridge._start({}, authority.issues[ISSUE], SESSION, 1, 'synthetic-start'))
                before = store.get(ISSUE)
                bridge.flush()
                self.assertEqual(store.get(ISSUE), before)
                self.assertEqual(kanban.tasks['task-1'].status, 'ready')  # created ready, never claimed
                self.assertEqual(len(kanban.creates), 1)
                self.assertFalse(any('issueUpdate' in query for query in authority.mutations))
                self.assertEqual(kanban.comments, [])
                if mode.startswith('legacy'):
                    saved = store.outbox_row(legacy)
                    self.assertTrue(saved['hold_reason'])
                    self.assertEqual({key: value for key, value in saved.items() if key != 'hold_reason'},
                                     {key: value for key, value in before_legacy.items() if key != 'hold_reason'})


    def test_applied_receipt_cannot_revive_stale_closed_issue(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
            authority.issues[ISSUE]['state'] = {'type': 'completed', 'name': 'Done'}
            store = Store(Path(directory) / 'state.db')
            ack_id = str(uuid.uuid5(uuid.NAMESPACE_URL,
                f'linear-session-received:{ISSUE}:{SESSION}'))
            store.enqueue('activity', {'id': ack_id, 'issue_id': ISSUE, 'session_id': SESSION,
                'initial_ack': True, 'requester_sessions': {ISSUE: SESSION},
                'content': {'type': 'thought', 'body': 'Received.'}}, at=1)
            # This is a persisted historical success, not a new delivery of the old row.
            with sqlite3.connect(store.path) as db:
                db.execute("UPDATE outbox SET state='sent',payload=json_set(payload, '$.applied', 1) WHERE id=?", (ack_id,))
            self.assertEqual(store.outbox_row(ack_id)['state'], 'sent')
            kanban = FakeKanban()
            bridge = Bridge(store, authority.api(), kanban, profile='synthetic', clock=lambda: 10)
            # A refusal is a handled delivery (no retry), never a start.
            self.assertTrue(bridge._start({}, authority.issues[ISSUE], SESSION, 1, 'synthetic-start'))
            self.assertIsNone(store.get(ISSUE))
            self.assertEqual(kanban.creates, [])

    def test_unverified_legacy_ack_never_reaches_mutation_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
            store = Store(Path(directory) / 'state.db')
            ack = store.enqueue('activity', {'issue_id': ISSUE, 'session_id': SESSION,
                'initial_ack': True, 'requester_sessions': {ISSUE: SESSION},
                'content': {'type': 'thought', 'body': 'Received.'}}, at=1)
            before = store.outbox_row(ack)
            api, calls = authority.api(), []
            guarded = api.guarded_mutation
            @contextmanager
            def observe(guard):
                calls.append(True)
                with guarded(guard):
                    yield
            api.guarded_mutation = observe
            authority.issues[ISSUE]['delegate'] = {'id': 'human'}
            bridge = Bridge(store, api, FakeKanban(), profile='synthetic', clock=lambda: 10)
            self.assertEqual(bridge.flush(), 0)
            saved = store.outbox_row(ack)
            self.assertTrue(saved['hold_reason'])
            self.assertEqual({k: v for k, v in saved.items() if k != 'hold_reason'},
                             {k: v for k, v in before.items() if k != 'hold_reason'})
            self.assertEqual(calls, [])
            self.assertEqual(authority.mutations, [])


    def test_prior_uncertain_terminal_write_and_legacy_ack_keep_original_history(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
            store = Store(Path(directory) / 'state.db')
            ack = store.enqueue('activity', {'issue_id': ISSUE, 'session_id': SESSION,
                'initial_ack': True, 'requester_sessions': {ISSUE: SESSION},
                'content': {'type': 'thought', 'body': 'Received.'}}, at=2)
            prior = store.enqueue('status', {'issue_id': ISSUE, 'state': 'done', 'terminal': True,
                'write_started': True, 'requester_sessions': {ISSUE: SESSION}}, at=1)
            before = {row_id: store.outbox_row(row_id) for row_id in (prior, ack)}
            self.assertTrue(store.issue_reconciliation_blocked(ISSUE))
            bridge = Bridge(store, authority.api(), FakeKanban(), profile='synthetic', clock=lambda: 10)
            self.assertEqual(bridge.flush(), 0)
            for row_id in (prior, ack):
                saved = store.outbox_row(row_id)
                self.assertTrue(saved['hold_reason'])
                self.assertEqual({k: v for k, v in saved.items() if k != 'hold_reason'},
                                 {k: v for k, v in before[row_id].items() if k != 'hold_reason'})
            self.assertEqual(authority.mutations, [])
            self.assertTrue(store.issue_reconciliation_blocked(ISSUE))


    def test_rate_limited_thought_keeps_its_place_until_the_pause_ends(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
            api = authority.api()
            original, attempts = authority.transport, []
            def transport(url, body, headers):
                if 'agentActivityCreate' in json.loads(body)['query']:
                    attempts.append(True)
                    return 429, {}, b'{}'
                return original(url, body, headers)
            api.transport = transport
            store = Store(Path(directory) / 'state.db')
            kanban = FakeKanban()
            task = kanban.create(title='OPS-1: native task')
            store.bind_native(ISSUE, task.id, 'synthetic', 'default', owner_ref=SESSION, at=0)
            thought = store.enqueue('activity', {'issue_id': ISSUE, 'session_id': SESSION, 'task_id': task.id,
                'requester_sessions': {ISSUE: SESSION}, 'content': {'type': 'thought', 'body': 'Working'}}, at=1)
            bridge = Bridge(store, api, kanban, profile='synthetic', clock=lambda: 10)
            bridge.flush()
            self.assertEqual(attempts, [True])
            self.assertIsNone(store.outbox_row(thought)['hold_reason'])
            self.assertEqual(store.outbox_row(thought)['state'], 'pending')  # nothing is written during the pause

    def test_unbound_authorization_failure_is_durable_and_never_borrows_new_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.sessions[SESSION]['appUser'] = {'id': VIEWER}
            api = authority.api(scope={
                'all_teams': True, 'all_projects': True,
                'allowed_requester_ids': [USER], 'requester_basis': 'agent_session',
            })
            path = Path(directory) / 'state.db'
            store = Store(path)
            old = store.enqueue('comment', {'issue_id': ISSUE, 'body': 'Old retirement', 'takeover': True}, at=1)
            store.put(ISSUE, 'kanban', SESSION, task_id='new-task')
            bridge = Bridge(store, api, FakeKanban(), profile='synthetic', clock=lambda: 10)
            self.assertEqual(bridge.flush(), 0)
            saved = Store(path).outbox_row(old)
            self.assertTrue(saved['hold_reason'])
            self.assertNotIn('authorization_error', saved['payload'])
            self.assertEqual(saved['state'], 'pending')
            self.assertEqual(saved['attempts'], 0)  # auth checks are not remote-send attempts
            self.assertNotIn('requester_sessions', saved['payload'])
            self.assertEqual(authority.mutations, [])

    def test_unbound_historical_row_does_not_block_a_new_authorized_result(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.sessions[SESSION]['appUser'] = {'id': VIEWER}
            api = authority.api(scope={'all_teams': True, 'all_projects': True,
                'allowed_requester_ids': [USER], 'requester_basis': 'agent_session'})
            path = Path(directory) / 'state.db'
            store = Store(path)
            old = store.enqueue('comment', {'issue_id': ISSUE, 'body': 'Unbound historical notice'}, at=1)
            new = store.enqueue('comment', {'issue_id': ISSUE, 'body': 'Saved review result',
                'content_action': True, 'unlinked_content': True,
                'requester_sessions': {ISSUE: SESSION}}, at=2)
            bridge = Bridge(store, api, FakeKanban(), profile='synthetic', clock=lambda: 10)
            self.assertEqual(bridge.flush(), 1)
            reopened = Store(path)
            self.assertEqual(reopened.outbox_row(old)['state'], 'pending')
            self.assertTrue(reopened.outbox_row(old)['hold_reason'])
            self.assertEqual(reopened.outbox_row(old)['attempts'], 0)
            self.assertEqual(reopened.outbox_row(new)['state'], 'sent')
            self.assertEqual(Bridge(reopened, api, FakeKanban(), profile='synthetic',
                clock=lambda: 11).flush(), 0)
            self.assertEqual(len(authority.mutations), 1)

    def test_native_intent_is_durable_before_creation_without_remote_ack_requirement(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
            store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
            backlog = store.enqueue('comment', {'issue_id': ISSUE, 'body': 'Older unrelated update'}, at=1)
            create = kanban.create
            def checked_create(**fields):
                intent = Store(store.path).native_intent(f'create:{ISSUE}')
                self.assertEqual(intent['state'], 'attempting')
                self.assertEqual(authority.mutations, [])
                return create(**fields)
            kanban.create = checked_create
            bridge = Bridge(store, authority.api(), kanban, profile='synthetic')
            self.assertTrue(bridge._start({}, authority.issues[ISSUE], SESSION, 1, 'synthetic-start'))
            self.assertEqual(store.outbox_row(backlog)['state'], 'pending')
            self.assertIsNotNone(store.native_binding(ISSUE, 'synthetic', 'default'))


    def test_native_creation_does_not_borrow_or_wait_for_unbound_reporting_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
            api = authority.api(scope={'all_teams': True, 'all_projects': True,
                'allowed_requester_ids': [USER], 'requester_basis': 'agent_session'})
            store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
            old = store.enqueue('comment', {'issue_id': ISSUE, 'body': 'unbound old notice'}, at=1)
            bridge = Bridge(store, api, kanban, profile='synthetic')
            with api.requester_session(SESSION):
                self.assertTrue(bridge._start({}, authority.issues[ISSUE], SESSION, 1, 'synthetic-start'))
            self.assertEqual(store.outbox_row(old)['state'], 'pending')
            bridge.flush()
            self.assertEqual(store.outbox_row(old)['state'], 'pending')
            self.assertTrue(store.outbox_row(old)['hold_reason'])
            self.assertEqual(store.outbox_row(old)['attempts'], 0)
            self.assertIsNotNone(store.native_binding(ISSUE, 'synthetic', 'default'))
            self.assertFalse(any('commentCreate' in query for query in authority.mutations))


    def test_refused_session_gets_an_answer_instead_of_silence(self):
        for change in ('foreign', 'closed'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                authority = Authority()
                if change == 'foreign':
                    authority.issues[ISSUE]['delegate'] = {'id': 'other-agent', 'name': 'Other Agent'}
                else:
                    authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
                    authority.issues[ISSUE]['state'] = {'type': 'completed', 'name': 'Done'}
                    authority.issues[ISSUE]['completedAt'] = '2026-01-01T00:00:02Z'
                store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
                bridge = Bridge(store, authority.api(), kanban, profile='synthetic', clock=lambda: 10)
                # A refusal is a handled delivery: answered once, never retried, never a start.
                self.assertTrue(bridge._start({}, authority.issues[ISSUE], SESSION, 1, 'synthetic-start'))
                self.assertTrue(bridge._start({}, authority.issues[ISSUE], SESSION, 1, 'synthetic-start'))
                self.assertIsNone(store.get(ISSUE))
                self.assertEqual(kanban.creates, [])
                [reply] = [r for r in store.pending(ISSUE) if r['kind'] == 'activity']
                self.assertEqual(reply['payload']['content']['type'], 'response')
                self.assertIn('assigned elsewhere' if change == 'foreign' else 'closed', reply['payload']['content']['body'])

    def test_running_work_keeps_its_session_alive_but_never_covers_a_question(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [10_000.0]
            store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
            bridge = Bridge(store, Authority().api(), kanban, profile='synthetic', clock=lambda: now[0])
            task = kanban.create(initial_status='running')
            kanban.tasks[task.id].status = 'running'
            store.bind_native(ISSUE, task.id, 'synthetic', 'default', owner_ref=SESSION, at=0)
            row = store.get(ISSUE)
            bridge._keepalive(row)
            [alive] = [r for r in store.pending(ISSUE) if r['kind'] == 'activity']
            self.assertEqual((alive['payload']['content']['action'], alive['payload']['ephemeral']), ('Working', True))
            self.assertEqual(alive['payload']['content']['parameter'], 'Still on this; nothing is needed from you')
            self.assertNotIn('native', str(alive['payload']['content']).lower())
            now[0] += 60
            bridge._keepalive(row)  # recent activity: nothing more
            self.assertEqual(len([r for r in store.pending(ISSUE) if r['kind'] == 'activity']), 1)
            kanban.tasks[task.id].status = 'blocked'
            now[0] += 25 * 60
            bridge._keepalive(row)  # an elicitation is awaiting input: a thought would hide it
            self.assertEqual(len([r for r in store.pending(ISSUE) if r['kind'] == 'activity']), 1)

    def test_started_issue_keeps_its_status_and_a_missing_name_uses_its_type(self):
        team = {'key': 'AUT', 'states': {'nodes': [{'id': 'qa', 'name': 'QA', 'type': 'started', 'position': 3},
                                     {'id': 'doing', 'name': 'Doing', 'type': 'started', 'position': 1},
                                     {'id': 'backlog', 'name': 'Backlog', 'type': 'backlog', 'position': 0},
                                     {'id': 'queued', 'name': 'Queued', 'type': 'unstarted', 'position': 2}]}}
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge(Store(Path(directory) / 'state.db'), None, FakeKanban(), profile='synthetic')
        self.assertEqual(bridge.state_id({'team': team}, 'in_progress'), 'doing')
        self.assertEqual(bridge.state_id({'team': team}, 'todo'), 'queued')
        self.assertIsNone(bridge.state_id({'team': team}, 'blocked'))  # no Blocked: status stays, the sentence still posts
        self.assertIsNone(bridge.state_id({'team': team}, 'in_review'))
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
            authority.issues[ISSUE]['state'] = {'id': 'qa', 'name': 'QA', 'type': 'started'}
            api, sent = authority.api(), []
            original = api.update_issue
            api.update_issue = lambda issue_id, fields: sent.append(fields) or original(issue_id, fields)
            store = Store(Path(directory) / 'state.db')
            kanban = FakeKanban()
            task = kanban.create(title='OPS-1: native task')
            store.bind_native(ISSUE, task.id, 'synthetic', 'default', owner_ref=SESSION, at=0)
            row_id = store.enqueue('status', {'issue_id': ISSUE, 'state': 'in_progress', 'task_id': task.id, 'source_ms': 1767225610000,
                                     'requester_sessions': {ISSUE: SESSION}}, at=1)
            Bridge(store, api, kanban, profile='synthetic', clock=lambda: 1767225610).flush()
            self.assertEqual(store.outbox_row(row_id)['state'], 'sent')
            self.assertIsNone(store.outbox_row(row_id)['hold_reason'])
            self.assertEqual(sent, [])  # preserves the human's started state without claiming a delegate

    def thread_bridge(self, directory, comments=None, *, fail=False):
        from hermes_fleet_linear_plugin.api import LinearError
        authority = Authority()
        authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
        api, calls = authority.api(), []
        def thread(issue_id):
            calls.append(issue_id)
            if fail: raise LinearError('thread read outage')
            return comments or []
        api.issue_thread = thread
        store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
        return Bridge(store, api, kanban, profile='synthetic', clock=lambda: 10), authority, kanban, calls

    def test_new_work_includes_the_linear_thread_the_worker_cannot_read(self):
        comments = [{'at': '2026-01-01T00:00:01Z', 'who': 'Pat Example', 'body': 'Tried the staging fix; it failed on auth.'},
                    {'at': '2026-01-01T00:00:02Z', 'who': 'This Agent', 'body': 'Opened a PR for the token refresh.'}]
        with tempfile.TemporaryDirectory() as directory:
            bridge, authority, kanban, calls = self.thread_bridge(directory, comments)
            delegated_at = 1767225610000  # 2026-01-01T00:00:10Z, after both comments
            self.assertTrue(bridge._start({}, authority.issues[ISSUE], SESSION, delegated_at, 'synthetic-start'))
            body = kanban.creates[0]['body']
            self.assertIn('Linear thread', body)
            self.assertLess(body.index('staging fix'), body.index('token refresh'))  # oldest first
            self.assertIn('untrusted tracker text', body)
        with tempfile.TemporaryDirectory() as directory:  # Webhook promptContext is untrusted; resolve the actual thread
            bridge, authority, kanban, calls = self.thread_bridge(directory, comments)
            bridge._start({'promptContext': 'Issue and its comments'}, authority.issues[ISSUE], SESSION, 1, 'k')
            self.assertEqual(calls, [ISSUE])
            self.assertNotIn('Issue and its comments', kanban.creates[0]['body'])
        with tempfile.TemporaryDirectory() as directory:  # a failed thread read never blocks the work
            bridge, authority, kanban, calls = self.thread_bridge(directory, fail=True)
            self.assertTrue(bridge._start({}, authority.issues[ISSUE], SESSION, 1, 'k'))
            self.assertEqual(len(kanban.creates), 1)

    def test_thread_since_last_update_is_bounded_and_newest_wins(self):
        comments = [{'at': '2026-01-01T00:00:%02dZ' % i, 'who': 'Pat', 'body': f'note {i} ' + 'x' * 1500}
                    for i in range(1, 20)]
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.thread_bridge(directory, comments)[0]
            since = bridge._thread(ISSUE, since_ms=1767225605000)  # after 00:00:05
            self.assertIn('since your last update', since)
            self.assertNotIn('note 5 ', since)
            self.assertIn('note 19 ', since)
            self.assertLessEqual(len(since), 8300)

    def test_specialist_thread_keeps_only_allowed_requesters_and_this_app(self):
        from hermes_fleet_linear_plugin.api import LinearError
        authority = Authority()
        authority.comments[ISSUE] = [
            {'body': 'allowed requester', 'createdAt': '2026-01-01T00:00:01Z', 'user': {'id': USER, 'name': 'Ally'}},
            {'body': 'refused stranger', 'createdAt': '2026-01-01T00:00:02Z', 'user': {'id': 'stranger', 'name': 'S'}},
            {'body': 'this app', 'createdAt': '2026-01-01T00:00:03Z', 'user': {'id': VIEWER, 'name': 'Agent'}},
            {'body': 'some bot', 'createdAt': '2026-01-01T00:00:04Z', 'botActor': {'name': 'Bot'}}]
        api = authority.api()
        self.assertEqual([c['body'] for c in api.issue_thread(ISSUE)], ['allowed requester', 'this app'])
        self.assertEqual(sum('IssueThread' in q for q in authority.requests), 1)  # one read, scoped
        authority.issues[ISSUE]['team'] = {'id': 'team-outside', 'key': 'OUT'}
        with self.assertRaises(LinearError):
            api.issue_thread(ISSUE)

    def test_status_read_does_not_create_native_work_or_reporting_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge, authority, kanban = self.thread_bridge(directory)[:3]
            status = bridge.native_status(ISSUE)
            self.assertFalse(status['linked'])
            self.assertEqual(status['status'], 'unlinked')
            self.assertEqual(kanban.creates, [])
            self.assertEqual(bridge.store.pending(ISSUE), [])
            self.assertEqual(authority.mutations, [])

    def test_decline_gets_one_try_and_never_holds_later_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            authority.issues[ISSUE]['delegate'] = {'id': VIEWER}
            api = authority.api()
            original = authority.transport
            def transport(url, body, headers):
                if 'agentActivityCreate' in json.loads(body)['query']:
                    return 503, {}, b'{}'
                return original(url, body, headers)
            api.transport = transport
            store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
            bridge = Bridge(store, api, kanban, profile='synthetic', clock=lambda: 1767225610)
            task = kanban.create(title='OPS-1: native task')
            store.bind_native(ISSUE, task.id, 'synthetic', 'default', owner_ref=SESSION, at=0)
            bridge._decline(ISSUE, SESSION, 'Not resuming: this issue is closed.')
            progress = store.enqueue('status', {'issue_id': ISSUE, 'state': 'in_progress', 'task_id': task.id, 'source_ms': 1767225610000,
                                             'requester_sessions': {ISSUE: SESSION}}, at=1767225610)
            bridge.flush()
            self.assertEqual(store.outbox_row(progress)['state'], 'sent')  # not held behind the failed reply
            self.assertEqual(store.unreported_failed(), [])  # no endless "gave up" alert
            self.assertEqual(kanban.comments, [])

    def test_keepalive_counts_only_its_own_session(self):
        with tempfile.TemporaryDirectory() as directory:
            store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
            bridge = Bridge(store, Authority().api(), kanban, profile='synthetic', clock=lambda: 10_000)
            task = kanban.create(initial_status='running')
            kanban.tasks[task.id].status = 'running'
            store.bind_native(ISSUE, task.id, 'synthetic', 'default', owner_ref=SESSION, at=0)
            other = store.enqueue('activity', {'issue_id': ISSUE, 'session_id': 'other-session', 'task_id': task.id,
                                               'content': {'type': 'response', 'body': 'elsewhere'}}, at=9_990)
            self.assertTrue(store.mark_sent(other, True))
            bridge._keepalive(store.get(ISSUE))
            self.assertTrue(any(r['payload'].get('session_id') == SESSION for r in store.pending(ISSUE)))

    def test_local_completion_delivers_persisted_run_summary_without_url(self):
        summary = 'Reconciled all rows. The report lacks sale prices.'
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            api = authority.api()
            store = Store(Path(directory) / 'state.db')
            kanban = FakeKanban()
            task = kanban.create(title='OPS-1: review')
            task.result, task.completion_contract = None, 'local-only'
            adapter = object.__new__(Kanban)
            database = sqlite3.connect(':memory:')
            self.addCleanup(database.close)
            database.row_factory = sqlite3.Row
            database.execute('CREATE TABLE task_runs(id INTEGER, task_id TEXT, started_at INTEGER, summary TEXT, metadata TEXT)')
            database.execute('INSERT INTO task_runs VALUES(1, ?, 1, ?, ?)',
                             (task.id, summary, json.dumps({'artifacts': ['/private/findings.md']})))
            @contextmanager
            def connection():
                yield database
            adapter.read_conn = connection
            adapter.kb = SimpleNamespace(Run=SimpleNamespace(from_row=lambda row: SimpleNamespace(
                summary=row['summary'], metadata=None)))
            kanban.evidence_text = adapter.evidence_text
            kanban.completion_summary = adapter.completion_summary
            bridge = Bridge(store, api, kanban, profile='synthetic')
            bridge.track(ISSUE, task.id, requester_session=SESSION)
            task.status = 'done'
            kanban.record_completion(task, 1)
            bridge._finished(store.get(ISSUE), event_id=1)
            responses = [row['payload']['content'] for row in store.pending(ISSUE)
                         if row['kind'] == 'activity']
            self.assertEqual(responses[0]['type'], 'response')
            comments = [row for row in store.pending(ISSUE)
                        if row['kind'] == 'comment' and row['payload'].get('native_outcome_comment')]
            self.assertEqual(len(comments), 1)
            self.assertIn(summary, comments[0]['payload']['body'])
            self.assertNotIn('/private/', comments[0]['payload']['body'])
            pointer = next(row for row in store.pending(ISSUE) if row['kind'] == 'activity')
            self.assertTrue(pointer['payload']['native_outcome_pointer'])
            self.assertEqual(pointer['payload']['requires_comment_id'], comments[0]['id'])
            self.assertEqual(pointer['payload']['native_completion'], comments[0]['payload']['native_completion'])
            self.assertEqual(responses[0]['body'], 'Completed. The result and checks are in the issue comment.')

    def test_local_completion_requires_minimum_safe_summary_or_evidence(self):
        cases = (
            ('path only', '/private/report.md', '', 'local-only', False, ''),
            ('secret only', 'token=synthetic-secret', '', 'local-only', False, ''),
            ('placeholders only', '[local artifact] [redacted]', '', 'local-only', False, ''),
            ('uppercase redaction', '[REDACTED]', '', 'local-only', False, ''),
            ('uppercase artifact', '[LOCAL ARTIFACT]', '', 'local-only', False, ''),
            ('mixed-case redaction', 'Done. [ReDaCtEd]', '', 'local-only', False, ''),
            ('empty', '', '', 'local-only', False, ''),
            ('bare done', 'Done', '', 'local-only', False, ''),
            ('bare complete', 'COMPLETE!', '', 'local-only', False, ''),
            ('bare completed', 'Completed.', '', 'local-only', False, ''),
            ('bare ok', 'ok...', '', 'local-only', False, ''),
            ('bare done with path', 'Done. /private/report.md', '', 'local-only', False, ''),
            ('single letter', 'x', '', 'local-only', False, ''),
            ('single digit', '1', '', 'local-only', False, ''),
            ('short finding', 'Fixed typo.', '', 'local-only', True, 'Fixed typo.'),
            ('non-English finding', '原因を特定。', '', 'local-only', True, '原因を特定。'),
            ('mixed', 'Reviewed rows; found two missing prices. /private/report.md', '',
             'local-only', True, 'found two missing prices'),
            ('url', 'Results at https://example.test/findings', '', 'local-only', True,
             'https://example.test/findings'),
            ('url with generic summary', 'Done', 'https://example.test/findings',
             'local-only', True, 'https://example.test/findings'),
            # F28: a PR contract is reported, not gated: native Done is Linear Done.
            ('strict PR', 'Reviewed rows; found two missing prices.', '',
             'https://github.com/example/repo/pull/1', True, 'found two missing prices'),
        )
        for name, result, evidence_text, contract, done, expected in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                authority = Authority()
                store = Store(Path(directory) / 'state.db')
                kanban = FakeKanban()
                task = kanban.create(title='OPS-1: review')
                task.result, task.completion_contract = result, contract
                kanban.evidence_text = lambda task: evidence_text or task.result
                bridge = Bridge(store, authority.api(), kanban, profile='synthetic')
                bridge.track(ISSUE, task.id, requester_session=SESSION)
                task.status = 'done'
                kanban.record_completion(task, 1)
                with patch.object(bridge_module, 'pr_state', return_value=None):
                    bridge._finished(store.get(ISSUE), event_id=1)
                pending = store.pending()  # Project batches use their own queue; inspect all captured components.
                status = next(row['payload']['state'] for row in pending if row['kind'] == 'status')
                self.assertEqual(status, 'done' if done else 'blocked')
                self.assertEqual(any(row['kind'] == 'project_update' for row in pending), done)
                response = next(row for row in pending if row['kind'] == 'activity')
                comments = [row for row in pending if row['kind'] == 'comment'
                            and row['payload'].get('native_outcome_comment')]
                self.assertEqual(len(comments), int(done))
                if done:
                    body = comments[0]['payload']['body']
                    self.assertTrue(response['payload']['native_outcome_pointer'])
                    self.assertEqual(response['payload']['requires_comment_id'], comments[0]['id'])
                    self.assertEqual(response['payload']['native_completion'], comments[0]['payload']['native_completion'])
                    self.assertEqual(response['payload']['content']['body'],
                                     'Completed. The result and checks are in the issue comment.')
                else:
                    body = response['payload']['content']['body']
                if expected:
                    self.assertIn(expected, body)
                if done and '/private/' in result:  # HF-823: a closing note keeps the paths it names
                    self.assertIn('/private/report.md', body)
                else:
                    self.assertNotIn('/private/', body)
                self.assertNotIn('synthetic-secret', body)

    def test_human_takeover_preserves_native_binding_and_original_reporting_requester(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            api = authority.api(scope={
                'all_teams': True, 'all_projects': True,
                'allowed_requester_ids': [USER], 'requester_basis': 'agent_session'})
            store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
            task = kanban.create(title='OPS-1: review')
            store.bind_native(ISSUE, task.id, 'synthetic', 'default', owner_ref=SESSION, at=0)
            bridge = Bridge(store, api, kanban, profile='synthetic')
            before = store.get(ISSUE)
            with api.requester_session(SESSION):
                row_id = bridge.comment(ISSUE, 'Verified result')
                authority.issues[ISSUE]["delegate"] = {"id": "other-agent"}
                bridge.recheck(force=True)
            pending = Store(store.path).outbox_row(row_id)
            self.assertEqual(store.get(ISSUE), before)
            self.assertEqual(task.status, 'ready')
            self.assertEqual(pending['payload']['requester_sessions'], {ISSUE: SESSION})
            self.assertTrue(bridge._authorize_outbox_effect(pending))
            authority.sessions[SESSION]['creator'] = {'id': 'foreign'}
            self.assertFalse(bridge._authorize_outbox_effect(pending))



    def test_new_refusal_notice_has_requester_provenance_without_legacy_execution_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Authority()
            store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
            store.put(ISSUE, 'chat', 'stopped-legacy-owner')
            before_work = store.get(ISSUE)
            old = store.enqueue('activity', {'issue_id': ISSUE, 'session_id': SESSION,
                'session_key': 'stopped-legacy-owner', 'one_try': True,
                'content': {'type': 'response', 'body': 'Old pending reply'}}, at=1)
            before_old = store.outbox_row(old)
            api = authority.api(scope={'all_teams': True, 'all_projects': True,
                'allowed_requester_ids': [USER], 'requester_basis': 'agent_session'})
            bridge = Bridge(store, api, kanban, profile='synthetic', clock=lambda: 10)
            with api.requester_session(SESSION):
                bridge._decline(ISSUE, SESSION, 'Retained work needs inspection; nothing resumed.')
            notice = next(row for row in store.pending(ISSUE) if row['id'] != old)
            self.assertEqual(notice['payload']['reporting_notice_version'], 1)
            self.assertEqual(notice['payload']['requester_sessions'], {ISSUE: SESSION})
            for key in ('session_key', 'work_owner', 'task_id', 'claim', 'release', 'admission_id'):
                self.assertFalse(notice['payload'].get(key), key)
            self.assertEqual(bridge.flush(), 1)
            self.assertEqual(store.get(ISSUE), before_work)
            saved = store.outbox_row(old)
            self.assertTrue(saved['hold_reason'])
            self.assertEqual({key: value for key, value in saved.items() if key != 'hold_reason'},
                             {key: value for key, value in before_old.items() if key != 'hold_reason'})
            self.assertEqual(store.outbox_row(notice['id'])['state'], 'sent')
            self.assertEqual(kanban.creates, [])
            self.assertEqual(kanban.comments, [])

    def content_bridge(self, directory):
        authority = Authority()
        now = [10.0]
        store, kanban = Store(Path(directory) / 'state.db'), FakeKanban()
        bridge = Bridge(store, authority.api(), kanban, profile='synthetic', clock=lambda: now[0])
        return bridge, authority, now

    def queue_content(self, bridge, kind, body, **fields):
        return bridge.store.enqueue(kind, {'issue_id': ISSUE, 'body': body,
            'content_action': True, 'unlinked_content': True, 'write_started': False,
            **fields}, at=bridge.clock())

    def test_unlinked_comment_requires_exact_target_and_body_readback(self):
        for mismatch in ('target', 'body'):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as directory:
                bridge, authority, now = self.content_bridge(directory)
                row_id = self.queue_content(bridge, 'comment', '**Verified** finding')
                original = authority.transport
                def redirected(url, body, headers):
                    result = original(url, body, headers)
                    if 'commentCreate' in json.loads(body)['query']:
                        if mismatch == 'target':
                            authority.comment_records[row_id]['issue']['id'] = 'foreign-issue'
                        else:
                            authority.comment_records[row_id]['body'] = 'different body'
                    return result
                bridge.api.transport = redirected
                self.assertEqual(bridge.flush(), 0)
                self.assertEqual(bridge.store.outbox_row(row_id)['state'], 'pending')
                self.assertEqual(bridge.store.outbox_row(row_id)['attempts'], 1)
                self.assertIn(row_id, authority.comment_records)
                self.assertIsNone(bridge.store.get(ISSUE))
                self.assertEqual(bridge.kanban.creates, [])

    def test_lost_comment_response_reuses_persisted_id_and_verifies_readback(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge, authority, now = self.content_bridge(directory)
            row_id = self.queue_content(bridge, 'comment', 'Verified finding')
            original, attempts = authority.transport, []
            def lost(url, body, headers):
                request = json.loads(body)
                result = original(url, body, headers)
                if 'commentCreate' in request['query']:
                    attempts.append(request['variables']['input']['id'])
                    if len(attempts) == 1:
                        raise ConnectionError('lost response after comment committed')
                return result
            bridge.api.transport = lost
            self.assertEqual(bridge.flush(), 0)
            self.assertIn(row_id, authority.comment_records)
            restarted = Bridge(Store(bridge.store.path), bridge.api, bridge.kanban,
                               profile='synthetic', clock=lambda: now[0])
            now[0] = 100
            self.assertEqual(restarted.flush(), 1)
            self.assertEqual(attempts, [row_id, row_id])
            self.assertEqual(len(authority.comment_records), 1)
            self.assertEqual(restarted.store.outbox_row(row_id)['state'], 'sent')
            self.assertTrue(any('CommentReadback' in query for query in authority.requests))
            self.assertEqual(restarted.kanban.creates, [])

    def test_lost_description_response_settles_from_readback_without_second_write(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge, authority, now = self.content_bridge(directory)
            expected = authority.issues[ISSUE]['description']
            row_id = self.queue_content(bridge, 'description', '### Verified result\n\n- Evidence saved.',
                                        expected_description=expected)
            original, writes = authority.transport, []
            def lost(url, body, headers):
                request = json.loads(body)
                result = original(url, body, headers)
                if 'issueUpdate' in request['query']:
                    writes.append(request['variables']['input'])
                    raise ConnectionError('lost response after description committed')
                return result
            bridge.api.transport = lost
            self.assertEqual(bridge.flush(), 0)
            self.assertTrue(bridge.store.outbox_row(row_id)['payload']['write_started'])
            now[0] = 100
            restarted = Bridge(Store(bridge.store.path), bridge.api, bridge.kanban,
                               profile='synthetic', clock=lambda: now[0])
            self.assertEqual(restarted.flush(), 1)
            self.assertEqual(len(writes), 1)
            self.assertEqual(restarted.store.outbox_row(row_id)['state'], 'sent')
            self.assertIsNone(restarted.store.get(ISSUE))

    def test_human_description_edit_is_preserved_before_send_and_after_lost_response(self):
        for boundary in ('before', 'lost_response'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as directory:
                bridge, authority, now = self.content_bridge(directory)
                row_id = self.queue_content(bridge, 'description', 'Agent proposed description',
                    expected_description=authority.issues[ISSUE]['description'])
                original, writes = authority.transport, []
                def transport(url, body, headers):
                    request = json.loads(body)
                    result = original(url, body, headers)
                    if 'issueUpdate' in request['query']:
                        writes.append(request['variables']['input'])
                        if boundary == 'lost_response':
                            raise ConnectionError('lost description response')
                    return result
                bridge.api.transport = transport
                if boundary == 'lost_response':
                    bridge.flush()
                authority.issues[ISSUE]['description'] = 'Human acceptance and scope'
                now[0] = 100
                restarted = Bridge(Store(bridge.store.path), bridge.api, bridge.kanban,
                                   profile='synthetic', clock=lambda: now[0])
                self.assertEqual(restarted.flush(), 0)
                self.assertEqual(authority.issues[ISSUE]['description'], 'Human acceptance and scope')
                self.assertEqual(len(writes), int(boundary == 'lost_response'))
                self.assertNotEqual(restarted.store.outbox_row(row_id)['state'], 'sent')
                self.assertEqual(restarted.kanban.creates, [])


if __name__ == '__main__':
    unittest.main()
