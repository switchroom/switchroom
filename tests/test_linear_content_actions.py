"""Human-readable content through the real handler, SQLite and fake HTTP."""
from __future__ import annotations
import json
from dataclasses import replace
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from linear_fake_api import load_plugin, Clock, FakeLinear, SELF, OTHER
load_plugin()
from hermes_fleet_linear_plugin import chat
from hermes_fleet_linear_plugin.transport import NativeContext
from hermes_fleet_linear_plugin.api import LinearAPI, LinearError
from hermes_fleet_linear_plugin.bridge import Bridge, ProjectUpdateDeferred
from hermes_fleet_linear_plugin.store import Store

BODY = '### Current status\n\n- Setup verified.\n\n### Remaining\n\n- [ ] Await replies.\n\n```sh\nprintf "a  b"\n```\n[Evidence](https://example.test/proof)'

# LIFE-584 as Finn sent it and as Linear stored it (2026-11-02): an escaped tilde, and * bullets on
# plain lists (including lines with inline code) while task-list items keep -.
LIFE_584_AUTHORED = """## Plan

- **PR A — backend:** `kept_hero.window_totals` for earned / spent / loan_interest / kept / invested / cash_kept; invariants `earned − spent − loan_interest == kept` and `invested + cash_kept == kept`, per month and window.
- **PR B — Kept card 50a:** frontend per README §1–§4, Playwright height test, 1280/390 screenshots beside the reference.

## Acceptance (handoff §6)

- [ ] Chart in shared frame, empty gutter; `.home-sel` centre x within 1px of the other cards
- [ ] Merged, deployed via Coolify pin, live bundle verified

## Deliberate deviations (flagged to Ken)

- Selected-month Cash bar keeps the tested `--home-cash-bar` (#5a9f8c) rather than #2f7a66: #2f7a66 is ~1.5:1 against Invested and fails the audit #8 ≥2:1 gate.
- Avg label keeps decision #9 (no background box).
"""
LIFE_584_STORED = LIFE_584_AUTHORED.rstrip('\n').replace('\n- **', '\n* **').replace(
    '\n- Selected', '\n* Selected').replace('\n- Avg', '\n* Avg').replace('~1.5:1', '\\~1.5:1')

class ContentRemote(FakeLinear):
    def _apply(self, query, variables):
        if 'CommentReadback' in query:
            found = next((c for c in self.comments if c['id'] == variables['id']), None)
            return 200, {'data': {'comment': ({'id': found['id'], 'body': found['body'],
                'issue': {'id': found['issueId']}, 'parent': None, 'user': {'id': SELF}} if found else None)}}
        if 'projectCreate' in query:
            self.created_project = dict(variables['input'])
            return 200, {'data': {'projectCreate': {'success': True}}}
        if 'CreatedProject' in query:
            data = self.created_project
            return 200, {'data': {'project': {'id': data['id'], 'name': data['name'],
                'lead': None, 'teams': {'nodes': [{'id': team} for team in data['teamIds']]}}}}
        if 'issueCreate' in query:
            data = variables['input']
            self.created_issue = dict(data)
            issue = self.add_issue(data['id'], 'ABC-2', project=data.get('projectId'))
            issue.update(title=data['title'], description=data.get('description'), assignee=None,
                         parent={'id': data['parentId']} if data.get('parentId') else None)
            return 200, {'data': {'issueCreate': {'success': True}}}
        if 'TeamProjects' in query:
            nodes = [{'id': 'proj-rollout', 'name': 'Fleet Rollout', 'completedAt': None, 'canceledAt': None, 'archivedAt': None},
                     {'id': 'proj-done', 'name': 'Old Work', 'completedAt': '2026-10-01T00:00:00Z', 'canceledAt': None, 'archivedAt': None},
                     {'id': 'proj-linear', 'name': 'Linear UX', 'completedAt': None, 'canceledAt': None, 'archivedAt': None}]
            return 200, {'data': {'team': {'id': variables['id'], 'projects': {'nodes': nodes}}}}
        if 'issueUpdate' in query and 'description' in variables['input']:
            self.issues[variables['id']]['description'] = variables['input']['description']
        return super()._apply(query, variables)

class ContentActionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'state.db'
        self.clock = Clock()
        self.remote = ContentRemote(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_issue('issue-1', 'ABC-1', project=None)
        self.remote.set_delegate('issue-1', {'id': SELF})
        self.store = Store(self.path)
        self.store.put('issue-1', 'chat', 'chat')
        self.api = LinearAPI(lambda: 'synthetic', endpoint=self.remote.url)
        self.bridge = Bridge(self.store, self.api, SimpleNamespace(), profile='alpha', clock=self.clock)
        self.bridge.profile_home = Path(tmp.name)
        self.context = NativeContext(home=tmp.name, session_key='chat', session_id='session', profile='alpha',
                                     platform='slack', source='slack')
        self.request_id = str(uuid.uuid4())

    def invoke(self, action='update_description', *, content=BODY, request_id=None, context=None):
        args = {'action': action, 'issue': 'ABC-1', 'id': request_id or self.request_id,
                'description': content, 'body': content, 'expected_description': 'Synthetic issue body'}
        # Capture durably first so tests can introduce a race before real send.
        with patch.object(self.bridge, 'flush'):
            return json.loads(chat.handle(self.bridge, args, context or self.context))

    def row(self):
        return self.store.outbox_row(self.request_id)

    def mutations(self):
        return [q for q in self.remote.requests if q.startswith('mutation')]

    def test_multiline_description_preserves_payload_and_other_fields(self):
        before = json.loads(json.dumps(self.remote.issues['issue-1']))
        self.assertTrue(self.invoke()['ok'])
        self.assertTrue(self.bridge._send(self.row()))
        self.assertEqual(self.remote.issues['issue-1']['description'], BODY)
        for key in ('title', 'delegate', 'state'):
            self.assertEqual(self.remote.issues['issue-1'][key], before[key])

    def test_multiline_comment_reads_exact_target_and_is_idempotent(self):
        self.assertTrue(self.invoke('add_comment')['ok'])
        self.assertTrue(self.bridge._send(self.row()))
        self.assertTrue(self.invoke('add_comment')['ok'])
        self.assertTrue(self.bridge._send(self.row()))
        self.assertEqual(len(self.remote.comments), 1)
        self.assertEqual(self.remote.comments[0]['body'], BODY)

    def test_create_multiline_description_is_read_back(self):
        created = self.api.create_issue(str(uuid.uuid4()), 'team-1', 'Human outcome', description=BODY)
        self.assertEqual(created['description'], BODY)
        self.assertTrue(any(q == 'query CreatedIssue' for q in self.remote.requests))

    def test_create_accepts_bare_host_editor_autolink(self):
        body = '### Outcome\n\nClick **Sign in** on example.com to continue.'
        stored = body.replace('example.com', '[example.com](<http://example.com>)')
        original = self.remote._apply
        def canonicalized(query, variables):
            status, payload = original(query, variables)
            if 'issueCreate' in query:
                self.remote.issues[variables['input']['id']]['description'] = stored
            return status, payload
        self.remote._apply = canonicalized
        created = self.api.create_issue(self.request_id, 'team-1', 'Outcome', description=body)
        self.assertEqual(created['id'], self.request_id)
        self.assertEqual(created['description'], stored)
        self.assertIsNone(created['delegate'])
        self.assertIsNone(created['assignee'])

    def test_bare_host_readback_is_directional_and_preserves_other_content(self):
        from hermes_fleet_linear_plugin.api import markdown_matches
        host = 'example.com'
        link = '[example.com](<http://example.com>)'
        for body in (host, f'Click **Sign in** on {host}.', f'Visit ({host}).',
                     f'- [ ] Visit {host}', f'Use {host} or docs.example.org'):
            stored = body.replace(host, link)
            with self.subTest(body=body):
                self.assertTrue(markdown_matches(stored, body))
                self.assertFalse(markdown_matches(body, stored))
        for stored in ('[other.com](<http://other.com>)',
                       '[example.com](<http://other.com>)',
                       '[example.com](<https://example.com>)',
                       '[example.com](<http://example.com/>)',
                       '[example.com](<http://example.com/path>)',
                       '[example.com](<http://example.com?x=1>)',
                       '[example.com](<http://example.com#section>)',
                       '[example.com](<http://example.com:80>)',
                       'example.org'):
            with self.subTest(stored=stored):
                self.assertFalse(markdown_matches(stored, host))
        for body in ('`example.com`', '``example.com``', '    example.com', '\texample.com',
                     '`start\nexample.com\nend`', '[label\nexample.com\n](https://a.test)',
                     '```text\nexample.com\n```', '~~~\nexample.com\n~~~',
                     '[example.com](https://example.com)', '![example.com](image.png)',
                     '[example.com][ref]', '[ref]: example.com', r'\example.com',
                     'http://example.com', 'https://example.com', 'user@example.com',
                     'example.com/path', 'example.com?x=1', 'example.com#section',
                     'example.com:80', 'prefix-example.com/path'):
            with self.subTest(body=body):
                self.assertFalse(markdown_matches(body.replace(host, link), body))
        body = f'- [ ] Visit {host} today.'
        for stored in (body.replace(host, link).replace('[ ]', '[x]'),
                       body.replace(host, link).replace('today', 'tomorrow'),
                       body.replace(host, link) + '\nExtra line'):
            self.assertFalse(markdown_matches(stored, body))

    def test_editor_rewrites_do_not_change_code_or_ambiguous_contexts(self):
        from hermes_fleet_linear_plugin.api import markdown_matches
        for expected, actual in (
            ('`[x](<https://example.com>)`', '`[x](https://example.com)`'),
            ('``[x](<https://example.com>)``', '``[x](https://example.com)``'),
            ('`start\n[x](<https://example.com>)\nend`', '`start\n[x](https://example.com)\nend`'),
            ('    [x](<https://example.com>)', '    [x](https://example.com)'),
            ('  \texample.com', '  \t[example.com](<http://example.com>)'),
            ('<pre>\nexample.com\n</pre>', '<pre>\n[example.com](<http://example.com>)\n</pre>'),
            ('<!--\nexample.com\n-->', '<!--\n[example.com](<http://example.com>)\n-->'),
        ):
            with self.subTest(expected=expected):
                self.assertFalse(markdown_matches(actual, expected))

    def test_same_id_duplicate_create_reconciles_autolink_without_another_issue(self):
        body = 'Visit example.com'
        stored = 'Visit [example.com](<http://example.com>)'
        self.remote.add_issue(self.request_id, 'ABC-2', project=None).update(
            title='Outcome', description=stored, assignee=None, parent=None)
        seen = []
        original = self.remote._apply
        def duplicate(query, variables):
            if 'issueCreate' in query:
                seen.append(variables['input']['id'])
                return 200, {'data': None, 'errors': [{
                    'message': 'conflict on insert of Issue', 'extensions': {
                        'code': 'INPUT_ERROR',
                        'userPresentableMessage': f'Issue {self.request_id} already exists.'}}]}
            return original(query, variables)
        self.remote._apply = duplicate
        for _ in range(2):
            created = self.api.create_issue(self.request_id, 'team-1', 'Outcome', description=body)
            self.assertEqual(created['id'], self.request_id)
        self.assertEqual(seen, [self.request_id, self.request_id])
        self.assertEqual(set(self.remote.issues), {'issue-1', self.request_id})
        self.remote.issues[self.request_id]['description'] = 'Visit other.com'
        replay = self.api.create_issue(self.request_id, 'team-1', 'Outcome', description=body)
        self.assertEqual((replay['id'], replay['readback_differences']), (self.request_id, ['description']))
        self.assertEqual(set(self.remote.issues), {'issue-1', self.request_id})
        # A reused id whose existing issue has another title is not the issue asked for.
        with self.assertLogs('hermes_plugins.linear', 'WARNING') as logs, self.assertRaises(LinearError) as caught:
            self.api.create_issue(self.request_id, 'team-1', 'A different outcome', description=body)
        self.assertFalse(caught.exception.retryable)
        self.assertIn('already belongs to an existing issue ABC-2', str(caught.exception))
        self.assertIn('new id', str(caught.exception))
        self.assertIn('outcome=refused reason=id_reused', logs.output[-1])
        self.assertEqual(set(self.remote.issues), {'issue-1', self.request_id})

    def test_same_id_replay_expects_this_app_as_delegate_only(self):
        # The first create's start_work made this app the delegate; replaying that create is not a rewrite.
        body = 'Visit the board'
        self.remote.add_issue(self.request_id, 'ABC-2', project=None).update(
            title='Outcome', description=body, assignee=None, parent=None)
        original = self.remote._apply
        def duplicate(query, variables):
            if 'issueCreate' in query:
                return 200, {'data': None, 'errors': [{
                    'message': 'conflict on insert of Issue', 'extensions': {
                        'code': 'INPUT_ERROR',
                        'userPresentableMessage': f'Issue {self.request_id} already exists.'}}]}
            return original(query, variables)
        self.remote._apply = duplicate
        self.api._viewer = SELF
        self.remote.set_delegate(self.request_id, {'id': SELF})
        replay = self.api.create_issue(self.request_id, 'team-1', 'Outcome', description=body)
        self.assertNotIn('readback_differences', replay)
        # Another delegate on a replay still differs, and so does an unknown viewer.
        self.remote.set_delegate(self.request_id, {'id': 'someone-else'})
        with self.assertLogs('hermes_plugins.linear', 'WARNING') as logs:
            replay = self.api.create_issue(self.request_id, 'team-1', 'Outcome', description=body)
        self.assertEqual(replay['readback_differences'], ['delegate'])
        self.assertIn('fields=delegate', logs.output[-1])
        self.api._viewer = None
        self.remote.set_delegate(self.request_id, {'id': SELF})
        self.assertEqual(self.api.create_issue(self.request_id, 'team-1', 'Outcome',
                                               description=body)['readback_differences'], ['delegate'])

    def test_first_create_found_delegated_still_differs(self):
        # A create that was not a replay must come back undelegated, even to this app.
        original = self.remote._apply
        def delegated(query, variables):
            status, payload = original(query, variables)
            if 'issueCreate' in query:
                self.remote.issues[variables['input']['id']]['delegate'] = {'id': SELF}
            return status, payload
        self.remote._apply = delegated
        self.api._viewer = SELF
        with self.assertLogs('hermes_plugins.linear', 'WARNING') as logs:
            created = self.api.create_issue(self.request_id, 'team-1', 'Outcome', description='Body')
        self.assertEqual(created['readback_differences'], ['delegate'])
        self.assertIn('fields=delegate', logs.output[-1])

    def test_autolink_description_response_loss_restart_settles_without_resend(self):
        body = '### Outcome\n\nVisit example.com'
        original = self.remote._apply
        def canonicalized(query, variables):
            status, payload = original(query, variables)
            if 'issueUpdate' in query and 'description' in variables['input']:
                self.remote.issues['issue-1']['description'] = body.replace(
                    'example.com', '[example.com](<http://example.com>)')
            return status, payload
        self.remote._apply = canonicalized
        self.assertTrue(self.invoke(content=body)['ok'])
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(), 0)
        self.bridge.store = self.store = Store(self.path)
        self.clock.now += 3601
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.row()['state'], 'sent')
        self.assertEqual(len(self.mutations()), 1)
        self.assertFalse(self.store.issue_reconciliation_blocked('issue-1'))

    def test_autolink_comment_readback_settles_durable_action(self):
        body = '### Progress\n\nVisit example.com'
        original = self.remote._apply
        def canonicalized(query, variables):
            status, payload = original(query, variables)
            if 'commentCreate' in query and payload.get('data'):
                self.remote.comments[-1]['body'] = body.replace(
                    'example.com', '[example.com](<http://example.com>)')
            return status, payload
        self.remote._apply = canonicalized
        self.assertTrue(self.invoke('add_comment', content=body)['ok'])
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.row()['state'], 'sent')
        self.assertTrue(self.api.verify_comment(self.request_id, 'issue-1', body))
        self.assertEqual(len(self.remote.comments), 1)
        self.remote.comments[0]['body'] = '### Progress\n\nVisit other.com'
        self.assertFalse(self.api.verify_comment(self.request_id, 'issue-1', body))

    def test_create_with_a_genuine_difference_is_created_with_a_warning(self):
        original = self.remote._apply
        def changed(query, variables):
            status, payload = original(query, variables)
            if 'CreatedIssue' in query:
                payload['data']['issue']['description'] = 'lost all formatting'
            return status, payload
        self.remote._apply = changed
        client_id = str(uuid.uuid4())
        with self.assertLogs('hermes_plugins.linear', 'WARNING') as logs:
            created = self.api.create_issue(client_id, 'team-1', 'Outcome', description=BODY)
        self.assertEqual((created['id'], created['readback_differences']), (client_id, ['description']))
        self.assertIn('action=content.write outcome=applied reason=readback_differs', logs.output[0])
        self.assertIn(f'iss={client_id[:8]} kind=issue_create', logs.output[0])
        self.assertNotIn('formatting', '\n'.join(logs.output))

    def test_create_readback_missing_is_retryable_under_the_same_id(self):
        original = self.remote._apply
        def missing(query, variables):
            if 'CreatedIssue' in query:
                return 200, {'data': {'issue': None}}
            return original(query, variables)
        self.remote._apply = missing
        with self.assertRaises(LinearError) as caught:
            self.api.create_issue(self.request_id, 'team-1', 'Outcome', description=BODY)
        self.assertTrue(caught.exception.retryable)
        self.assertIn('same id', str(caught.exception))

    def test_create_readback_error_is_retryable_under_the_same_id(self):
        original = self.remote._apply
        def failing(query, variables):
            if 'CreatedIssue' in query:
                return 200, {'data': None, 'errors': [{'message': 'Entity not found', 'extensions': {'code': 'INVALID_INPUT'}}]}
            return original(query, variables)
        self.remote._apply = failing
        with self.assertRaises(LinearError) as caught:
            self.api.create_issue(self.request_id, 'team-1', 'Outcome', description=BODY)
        self.assertTrue(caught.exception.retryable)
        self.assertIn('same id', str(caught.exception))
        self.remote._apply = original
        created = self.api.create_issue(self.request_id, 'team-1', 'Outcome', description=BODY)
        self.assertEqual(created['id'], self.request_id)
        self.assertEqual(self.remote.requests.count('mutation Create'), 2)
        self.assertEqual(set(self.remote.issues), {'issue-1', self.request_id})

    def test_project_create_reports_a_renamed_project_as_created(self):
        original = self.remote._apply
        def renamed(query, variables):
            status, payload = original(query, variables)
            if 'CreatedProject' in query:
                payload['data']['project']['name'] = 'Renamed by a rule'
            return status, payload
        self.remote._apply = renamed
        created = self.api.create_project(self.request_id, 'Fleet rollout', ['team-1'])
        self.assertEqual((created['id'], created['readback_differences']), (self.request_id, ['name']))

    def test_life_584_editor_rewrite_is_a_successful_create(self):
        """Linear escaped a tilde and rewrote - bullets to * (LIFE-584, 2026-11-02)."""
        authored = LIFE_584_AUTHORED
        stored = LIFE_584_STORED
        original = self.remote._apply
        def editor(query, variables):
            status, payload = original(query, variables)
            if 'issueCreate' in query:
                self.remote.issues[variables['input']['id']]['description'] = stored
            return status, payload
        self.remote._apply = editor
        args = {'action': 'create_issue', 'id': self.request_id, 'title': 'Home Kept card 50a',
                'team': 'team-1', 'project': 'none', 'description': authored}
        reply = json.loads(chat.handle(self.bridge, args, self.context))
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['message'], 'Created an undelegated issue.')
        self.assertNotIn('readback_differences', reply['issue'])
        self.assertEqual(reply['issue']['description'], stored)
        self.assertEqual(self.remote.requests.count('mutation Create'), 1)

    def test_chat_create_with_a_remaining_difference_says_it_exists(self):
        original = self.remote._apply
        def editor(query, variables):
            status, payload = original(query, variables)
            if 'issueCreate' in query:
                self.remote.issues[variables['input']['id']]['description'] = 'rewritten'
            return status, payload
        self.remote._apply = editor
        args = {'action': 'create_issue', 'id': self.request_id, 'title': 'Outcome',
                'team': 'team-1', 'project': 'none', 'description': BODY}
        reply = json.loads(chat.handle(self.bridge, args, self.context))
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['issue']['id'], self.request_id)
        self.assertEqual(reply['issue']['readback_differences'], ['description'])
        self.assertIn('It exists under this id', reply['message'])
        self.assertIn('Do not create it again', reply['message'])
        again = json.loads(chat.handle(self.bridge, args, self.context))
        self.assertTrue(again['ok'])
        self.assertEqual(set(self.remote.issues), {'issue-1', self.request_id})

    def test_editor_escapes_bullets_and_whitespace_match_outside_code(self):
        from hermes_fleet_linear_plugin.api import markdown_matches
        for expected, actual in (
            ('Ratio ~1.5:1', 'Ratio \\~1.5:1'),
            ('- Keeps `--home-cash-bar` at ~1.5:1', '* Keeps `--home-cash-bar` at \\~1.5:1'),
            ('- a\n- b', '* a\n* b'),
            ('loan_interest and 5 * 3 | 2 # x!', 'loan\\_interest and 5 \\* 3 \\| 2 \\# x\\!'),
            ('Line \t\nNext', 'Line\nNext'),
            ('Line   \nNext', 'Line  \nNext'),
            ('    code\n\n\n    more', '    code\n\n\n    more'),
            ('Para\n\n\n\nNext\n\n', 'Para\n\nNext'),
            ('\n\nLead', 'Lead'),
            ('- [ ] Check `a`', '- [ ] Check `a`'),
        ):
            with self.subTest(expected=expected):
                self.assertTrue(markdown_matches(actual, expected))
        for expected, actual in (
            ('`a~b`', '`a\\~b`'),                     # escapes inside inline code are literal
            ('```\n~1\n```', '```\n\\~1\n```'),      # and inside fenced code
            ('    ~1', '    \\~1'),                     # and indented code
            ('```\na\n\n\nb\n```', '```\na\n\nb\n```'),  # code keeps its blank lines
            ('Ratio ~1.5:1', 'Ratio \\~1.6:1'),          # a real text change still differs
            ('- [ ] Done', '- [x] Done'),
            ('Visit example.com', 'Visit \\[example.com](<http://example.com>)'),
            ('Line  \nNext', 'Line\nNext'),               # a hard line break is kept
            ('`code`', '\\`code\\`'),                     # code versus literal ticks
            ('[a](http://x.test)', '\\[a\\](http://x.test)'),  # a link versus literal brackets
            ('<b>x</b>', '\\<b>x\\</b>'),                 # HTML versus literal text
            ('# H', '\\# H'), ('- item', '\\- item'), ('1. a', '1\\. a'), ('> q', '\\> q'),
            ('- # not a heading', '- \\# not a heading'),
            ('    code\n\n\n    more', '    code\n\n    more'),  # indented code keeps blank lines
        ):
            with self.subTest(expected=expected):
                self.assertFalse(markdown_matches(actual, expected))

    def test_readback_wrong_or_missing_comment_target_and_body_is_refused(self):
        for changed in (None, {'id': self.request_id, 'body': BODY, 'issue': {'id': 'other'}},
                        {'id': 'wrong', 'body': BODY, 'issue': {'id': 'issue-1'}},
                        {'id': self.request_id, 'body': 'changed', 'issue': {'id': 'issue-1'}}):
            with self.subTest(changed=changed):
                with patch.object(self.api, 'graphql', return_value={'comment': changed}):
                    self.assertFalse(self.api.verify_comment(self.request_id, 'issue-1', BODY))

    def test_other_chat_does_not_gate_content_but_foreign_profile_does(self):
        prior = self.store.get('issue-1')
        self.assertTrue(self.invoke(context=replace(self.context, session_key='another-chat'))['ok'])
        self.assertEqual(self.store.get('issue-1'), prior)
        foreign = replace(self.context, profile='foreign')
        self.assertFalse(self.invoke(request_id=str(uuid.uuid4()), context=foreign)['ok'])
        self.assertEqual(self.mutations(), [])

    def test_scope_denial_has_zero_content_mutations(self):
        with patch.object(self.bridge, 'authorize_specialist_effect', return_value=False):
            self.assertFalse(self.invoke()['ok'])
        self.assertIsNone(self.row())
        self.assertEqual(self.mutations(), [])

    def test_chat_owner_replacement_does_not_gate_ordinary_content(self):
        for action in ('update_description', 'add_comment'):
            with self.subTest(action=action):
                self.request_id = str(uuid.uuid4())
                self.assertTrue(self.invoke(action)['ok'])
                with sqlite3.connect(self.path) as db:
                    db.execute("UPDATE work SET owner_ref='successor' WHERE issue_id='issue-1'")
                self.assertTrue(self.bridge._send(self.row()))
                self.store.mark_sent(self.request_id, True)
                self.assertEqual(self.store.get('issue-1')['owner_ref'], 'successor')
        self.assertEqual(len(self.mutations()), 2)

    def test_remote_delegate_and_closed_state_do_not_gate_content(self):
        self.assertTrue(self.invoke()['ok'])
        self.remote.set_delegate('issue-1', OTHER)
        self.remote.set_state('issue-1', 'Done')
        self.assertTrue(self.bridge._send(self.row()))
        self.assertEqual(self.remote.issues['issue-1']['delegate'], OTHER)
        self.assertEqual(self.remote.state('issue-1'), 'Done')

    def test_chat_owner_change_during_credentials_preserves_content_authorization(self):
        for action in ('update_description', 'add_comment'):
            with self.subTest(action=action):
                self.request_id = str(uuid.uuid4())
                self.assertTrue(self.invoke(action)['ok'])
                def token():
                    if getattr(self.api._mutation_guard, 'callback', None):
                        with sqlite3.connect(self.path) as db:
                            db.execute("UPDATE work SET owner_ref='successor' WHERE issue_id='issue-1'")
                    return 'synthetic'
                self.api.token = token
                self.assertTrue(self.bridge._send(self.row()))
                self.store.mark_sent(self.request_id, True)
                self.api.token = lambda: 'synthetic'
        self.assertEqual(len(self.mutations()), 2)

    def test_remote_delegate_change_during_credentials_preserves_content_authorization(self):
        self.assertTrue(self.invoke()['ok'])
        def token():
            if getattr(self.api._mutation_guard, 'callback', None):
                self.remote.set_delegate('issue-1', OTHER)
            return 'synthetic'
        self.api.token = token
        self.assertTrue(self.bridge._send(self.row()))
        self.assertEqual(self.remote.issues['issue-1']['delegate'], OTHER)

    def test_description_response_loss_restart_reconciles_without_resend(self):
        self.assertTrue(self.invoke()['ok'])
        self.remote.lose_next_response = True
        with self.assertRaises(LinearError):
            self.bridge._send(self.row())
        self.assertTrue(self.row()['payload']['write_started'])
        self.store = Store(self.path)
        self.bridge.store = self.store
        # A crash before retry accounting leaves attempts zero, but send marker survives.
        self.assertEqual(self.row()['attempts'], 0)
        self.assertTrue(self.bridge._send(self.row()))
        self.assertEqual(len(self.mutations()), 1)

    def test_uncertain_description_never_overwrites_later_human_edit(self):
        self.assertTrue(self.invoke()['ok'])
        self.remote.lose_next_response = True
        with self.assertRaises(LinearError):
            self.bridge._send(self.row())
        self.remote.issues['issue-1']['description'] = 'Human changed this after send'
        self.bridge.store = Store(self.path)
        with self.assertRaises(LinearError):
            self.bridge._send(self.row())
        self.assertEqual(len(self.mutations()), 1)
        self.assertEqual(self.remote.issues['issue-1']['description'], 'Human changed this after send')

    def test_expected_description_mismatch_is_known_unsent(self):
        self.assertTrue(self.invoke()['ok'])
        self.remote.issues['issue-1']['description'] = 'Human edit before send'
        with self.assertRaises(LinearError):
            self.bridge._send(self.row())
        self.assertFalse(self.row()['payload'].get('write_started', False))
        self.assertEqual(self.mutations(), [])

    def test_id_reuse_conflict_is_controlled_and_not_reenqueued(self):
        self.assertTrue(self.invoke('add_comment')['ok'])
        reply = self.invoke('add_comment', content='Different request')
        self.assertFalse(reply['ok'])
        self.assertIn('conflict', reply['message'])
        self.assertEqual(self.row()['payload']['body'], BODY)
        self.assertFalse(self.invoke(request_id='not-a-uuid')['ok'])
        self.assertEqual(self.mutations(), [])

    def test_flush_restart_after_response_loss_reconciles_exact_request(self):
        self.assertTrue(self.invoke()['ok'])
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(), 0)
        self.assertEqual(self.row()['attempts'], 1)
        self.assertTrue(self.row()['payload']['write_started'])
        self.bridge.store = self.store = Store(self.path)
        self.clock.now += 3601
        self.assertTrue(self.invoke()['ok'])
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.row()['state'], 'sent')
        self.assertEqual(len(self.mutations()), 1)

    def test_unknown_description_fences_new_request_but_allows_same_id_readback(self):
        self.assertTrue(self.invoke()['ok'])
        self.remote.lose_next_response = True
        with self.assertRaises(LinearError):
            self.bridge._send(self.row())
        self.assertFalse(self.invoke(request_id=str(uuid.uuid4()))['ok'])
        self.assertTrue(self.invoke()['ok'])
        self.assertEqual(len(self.mutations()), 1)

    def test_markdown_canonicalization_preserves_code_links_and_checklist_state(self):
        from hermes_fleet_linear_plugin.api import markdown_matches
        canonical = BODY.replace('### Current status\n\n', '### Current status\n').replace('- Setup', '* Setup')
        self.assertTrue(markdown_matches(canonical, BODY))
        self.assertFalse(markdown_matches(BODY.replace('[ ]', '[x]'), BODY))
        self.assertFalse(markdown_matches(BODY.replace('a  b', 'a b'), BODY))
        self.assertFalse(markdown_matches(BODY.replace('/proof', '/wrong'), BODY))
        self.assertFalse(markdown_matches(BODY.replace('### Remaining', 'Remaining'), BODY))
        self.assertFalse(markdown_matches(None, BODY))

    def test_description_wrong_missing_id_and_wrong_body_readback_refused(self):
        for value in ({'id': 'other', 'description': BODY}, {'description': BODY},
                      {'id': 'issue-1', 'description': 'wrong'}):
            with self.subTest(value=value):
                with patch.object(self.api, 'issue', side_effect=[{'id': 'issue-1', 'description': 'old'}, value]), \
                        patch.object(self.api, 'update_issue'):
                    with self.assertRaises(LinearError):
                        self.api.replace_description('issue-1', 'old', BODY)

    def test_create_long_paragraph_warns_without_rewriting(self):
        long = 'Human prose. ' * 60
        args = {'action': 'create_issue', 'id': str(uuid.uuid4()), 'title': 'Outcome',
                'team': 'team-1', 'description': long, 'project': 'Fleet Rollout'}
        reply = json.loads(chat.handle(self.bridge, args, self.context))
        self.assertTrue(reply['ok'])
        self.assertIn('Formatting tip', reply['message'])
        created = self.remote.issues[args['id']]
        self.assertEqual(created['description'], long)
        self.assertIsNone(self.store.get(args['id']))

    def create(self, **fields):
        args = {'action': 'create_issue', 'id': str(uuid.uuid4()), 'title': 'Outcome', 'team': 'team-1', **fields}
        return args['id'], json.loads(chat.handle(self.bridge, args, self.context))

    def test_create_without_a_project_lists_active_projects_and_creates_nothing(self):
        request_id, reply = self.create()
        self.assertFalse(reply['ok'])
        self.assertEqual(reply['code'], 'project_required')
        self.assertEqual(reply['projects'], [{'id': 'proj-rollout', 'name': 'Fleet Rollout'},
                                             {'id': 'proj-linear', 'name': 'Linear UX'}])
        self.assertIn('do not ask the user', reply['message'])
        self.assertNotIn(request_id, self.remote.issues)
        self.assertEqual(self.mutations(), [])

    def test_create_resolves_a_project_by_exact_name_or_id(self):
        for project, expected in (('linear ux', 'proj-linear'), ('proj-rollout', 'proj-rollout')):
            with self.subTest(project=project):
                request_id, reply = self.create(project=project)
                self.assertTrue(reply['ok'], reply)
                self.assertEqual(self.remote.issues[request_id]['project'], {'id': expected})

    def test_create_refuses_an_unknown_or_finished_project_name(self):
        for project in ('Old Work', 'Linear'):
            with self.subTest(project=project):
                request_id, reply = self.create(project=project)
                self.assertEqual(reply['code'], 'project_required')
                self.assertNotIn(request_id, self.remote.issues)

    def test_create_inherits_the_parent_issue_project(self):
        self.remote.add_issue('parent-1', 'ABC-7', project='proj-linear')
        request_id, reply = self.create(parent='ABC-7')
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(self.remote.created_issue['projectId'], 'proj-linear')
        self.assertEqual(self.remote.created_issue['parentId'], 'ABC-7')

    def test_explicit_none_creates_without_a_project(self):
        request_id, reply = self.create(project='none')
        self.assertTrue(reply['ok'], reply)
        self.assertIsNone(self.remote.issues[request_id]['project'])
        self.assertNotIn('projectId', self.remote.created_issue)

    def test_project_long_paragraph_warns_without_rewriting(self):
        body = 'Project prose. ' * 60
        args = {'action': 'create_project', 'id': self.request_id, 'name': 'Outcome',
                'team': 'team-1', 'description': body}
        reply = json.loads(chat.handle(self.bridge, args, self.context))
        self.assertTrue(reply['ok'], reply)
        self.assertIn('Formatting tip', reply['message'])
        self.assertEqual(self.remote.created_project['description'], body)
        self.assertIsNone(self.remote.created_project['leadId'])

    def test_handler_content_preserves_bytes_and_warning_boundary(self):
        # Coverage of existing behavior, including create through the exposed handler.
        bodies = (('  Setup verified.  ', False), ('x' * 500, False),
                  ('x' * 501, True), ('  ' + BODY * 5 + '\n\n', False))
        for action in ('create_issue', 'create_project', 'update_description', 'add_comment'):
            for body, warns in bodies:
                with self.subTest(action=action, body_length=len(body)):
                    request_id = str(uuid.uuid4())
                    args = {'action': action, 'id': request_id, 'issue': 'ABC-1',
                            'team': 'team-1', 'title': 'Outcome', 'name': 'Outcome', 'project': 'none',
                            'description': body, 'body': body,
                            'expected_description': self.remote.issues['issue-1']['description']}
                    reply = json.loads(chat.handle(self.bridge, args, self.context))
                    self.assertTrue(reply['ok'], reply)
                    self.assertEqual('Formatting tip' in reply['message'], warns)
                    if action == 'create_issue':
                        self.assertEqual(self.remote.issues[request_id]['description'], body)
                        self.assertIsNone(self.store.get(request_id))
                    elif action == 'create_project':
                        self.assertEqual(self.remote.created_project['description'], body)
                    else:
                        row = self.store.outbox_row(request_id)
                        self.assertEqual(row['payload']['body'], body)
                        self.assertTrue(self.bridge._send(row))
                        self.store.mark_sent(request_id, True)
                        if action == 'update_description':
                            self.assertEqual(self.remote.issues['issue-1']['description'], body)
                        else:
                            comment = next(c for c in self.remote.comments if c['id'] == request_id)
                            self.assertEqual(comment['body'], body)

    def test_bound_specialist_allows_content_on_scope_and_refuses_foreign_scope(self):
        from hermes_fleet_linear_plugin import BoundLinearAPI
        original = self.remote._apply
        def identity(query, variables):
            if 'IdentityBinding' in query:
                return 200, {'data': {'viewer': {'id': SELF}, 'organization': {'id': 'org-1'}}}
            return original(query, variables)
        self.remote._apply = identity
        self.remote.issues['issue-1']['creator'] = {'id': 'requester-1'}
        self.remote.issues['issue-1']['project'] = {'id': 'project-1'}
        self.api = BoundLinearAPI(lambda: 'synthetic', endpoint=self.remote.url,
            identity={'viewer_id': SELF, 'organization_id': 'org-1'}, specialist_scope={
                'allowed_team_ids': ['team-1'], 'allowed_project_ids': ['project-1'],
                'allowed_requester_ids': ['requester-1']})
        self.bridge.api = self.api
        self.assertTrue(self.invoke('add_comment')['ok'])
        self.assertTrue(self.bridge._send(self.row()))
        self.request_id = str(uuid.uuid4())
        self.assertTrue(self.invoke()['ok'])
        self.assertTrue(self.bridge._send(self.row()))
        before = len(self.mutations())
        self.remote.issues['issue-1']['creator'] = {'id': 'foreign-requester'}
        self.assertFalse(self.invoke(request_id=str(uuid.uuid4()))['ok'])
        self.assertEqual(len(self.mutations()), before)

    def test_comment_response_loss_restart_does_not_duplicate(self):
        self.assertTrue(self.invoke('add_comment')['ok'])
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(), 0)
        self.bridge.store = self.store = Store(self.path)
        self.clock.now += 3601
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.row()['state'], 'sent')
        self.assertEqual(len(self.remote.comments), 1)
        self.assertTrue(self.api.verify_comment(self.request_id, 'issue-1', BODY))

    def test_takeover_does_not_erase_unknown_description_receipt(self):
        self.assertTrue(self.invoke()['ok'])
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(), 0)
        self.remote.issues['issue-1']['description'] = 'Human edit'
        self.remote.set_delegate('issue-1', OTHER)
        self.store.put('issue-1', 'chat', 'successor')
        self.clock.now += 3601
        self.assertEqual(self.bridge.flush(), 0)
        self.assertEqual(self.row()['state'], 'failed')
        self.assertTrue(self.store.issue_reconciliation_blocked('issue-1'))
        self.assertEqual(len(self.mutations()), 1)

    def test_warning_does_not_transform_long_content(self):
        for action in ('update_description', 'add_comment'):
            self.request_id = str(uuid.uuid4())
            long = 'Long prose. ' * 60
            reply = self.invoke(action, content=long)
            self.assertTrue(reply['ok'])
            self.assertIn('Formatting tip', reply['message'])
            self.assertEqual(self.row()['payload']['body'], long)

if __name__ == '__main__':
    unittest.main()
