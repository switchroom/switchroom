"""Equivalent remote formatting settles a description; a genuinely uncertain one says how to reconcile it."""
from __future__ import annotations
import json
import re
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from linear_fake_api import load_plugin, Clock, SELF
load_plugin()
from hermes_fleet_linear_plugin import chat, ops
from hermes_fleet_linear_plugin.transport import NativeContext
from hermes_fleet_linear_plugin.api import LinearAPI, markdown_matches
from hermes_fleet_linear_plugin.bridge import Bridge
from hermes_fleet_linear_plugin.store import Store
from test_linear_content_actions import ContentRemote

CHECKED = '### Acceptance\n\n- [x] Hourly collection\n- [x] Forecasts\n- [ ] Follow-up'

class CheckboxRemote(ContentRemote):
    """Linear's editor stores a checked task item as `[X]`."""
    def _apply(self, query, variables):
        fields = (variables or {}).get('input') or {}
        if 'issueUpdate' in query and isinstance(fields.get('description'), str):
            stored = re.sub(r'^(\s*[-*+] )\[x\]', r'\1[X]', fields['description'], flags=re.M)
            variables = {**variables, 'input': {**fields, 'description': stored}}
        return super()._apply(query, variables)

LINEAR_SHAPED = ('### Acceptance\n\n- [x] Hourly collection\n  - nested detail [run](https://example.test/run/1)\n'
                 '- [ ] Follow-up\n\n[Dashboard](https://example.test/dash) and [wiki](https://w.test/Foo_(bar))\n\n```\n- [x] literal (keep)\n[a](b)\n```')

class LinearRemote(ContentRemote):
    """Linear's editor, as observed in production: `*` bullets at any depth, `[X]`, and `<...>` link destinations."""
    def _apply(self, query, variables):
        fields = (variables or {}).get('input') or {}
        if 'issueUpdate' in query and isinstance(fields.get('description'), str):
            prose, fence, out = True, False, []
            for line in fields['description'].split('\n'):
                if line.startswith('```'):
                    fence = not fence
                elif not fence:
                    line = re.sub(r'^(\s*)- ', r'\1* ', line)
                    line = re.sub(r'^(\s*\* )\[x\]', r'\1[X]', line)
                    line = re.sub(r'\]\((https?://(?:[^\s()]|\([^\s()]*\))+)\)', r'](<\1>)', line)
                out.append(line)
            variables = {**variables, 'input': {**fields, 'description': '\n'.join(out)}}
        return super()._apply(query, variables)

class CheckboxCanonicalTests(unittest.TestCase):
    def test_checked_task_case_is_equivalent_but_state_and_code_are_not(self):
        self.assertTrue(markdown_matches('- [X] Done', '- [x] Done'))
        self.assertTrue(markdown_matches('* [X] Done', '- [x] Done'))
        self.assertTrue(markdown_matches('  - [X] Nested', '  - [x] Nested'))
        self.assertTrue(markdown_matches('1. [X] Ordered', '1. [x] Ordered'))
        self.assertFalse(markdown_matches('- [ ] Done', '- [x] Done'))
        self.assertFalse(markdown_matches('- [X] Done', '- [ ] Done'))
        self.assertFalse(markdown_matches('```\n- [X] code\n```', '```\n- [x] code\n```'))
        self.assertFalse(markdown_matches('See [X] here', 'See [x] here'))
        self.assertFalse(markdown_matches('- [X] Done', '- [x] Gone'))
        self.assertFalse(markdown_matches('- [X](https://a.test)', '- [x](https://a.test)'))

    def test_checked_task_holding_inline_code_is_equivalent(self):
        # HF-813: Linear stored `- [X] Report ... `plugin.yaml`: `7c104c4b3759``; the readback of the
        # agent's own plan edit then looked like a person's edit and later updates became comments.
        self.assertTrue(markdown_matches('- [X] Report `plugin.yaml`: `7c10`', '- [x] Report `plugin.yaml`: `7c10`'))
        self.assertTrue(markdown_matches('  - [X] read `a` and [b](https://b.test)', '  - [x] read `a` and [b](https://b.test)'))
        self.assertFalse(markdown_matches('- [X] Report `plugin.yaml`', '- [ ] Report `plugin.yaml`'))
        self.assertFalse(markdown_matches('- [ ] Report `plugin.yaml`', '- [x] Report `plugin.yaml`'))
        self.assertFalse(markdown_matches('- `[X]` code', '- `[x]` code'))
        section = ("## Plan and progress (agent)\nStatus: both values read.\n"
                   "- [x] Report the sha256 of `/opt/hermes/plugins/linear/plugin.yaml`: `7c104c4b3759`\n"
                   "- [ ] Post a checkpoint\n  - [x] plan section posted\n  - [ ] complete")
        stored = ("## Plan and progress (agent)\n\nStatus: both values read.\n\n"
                  "- [X] Report the sha256 of `/opt/hermes/plugins/linear/plugin.yaml`: `7c104c4b3759`\n"
                  "- [ ] Post a checkpoint\n  - [X] plan section posted\n  - [ ] complete")
        self.assertTrue(markdown_matches(stored, section))
        self.assertFalse(markdown_matches('- [X]abc', '- [x]abc'))

    def test_linear_bullet_depth_and_link_wrappers_are_equivalent_but_targets_are_not(self):
        self.assertTrue(markdown_matches('  * nested', '  - nested'))
        self.assertTrue(markdown_matches('[Run](<https://a.test/x>)', '[Run](https://a.test/x)'))
        self.assertTrue(markdown_matches('* [X] [Run](<https://a.test/x>)', '- [x] [Run](https://a.test/x)'))
        self.assertTrue(markdown_matches('[w](<https://w.test/Foo_(bar)>)', '[w](https://w.test/Foo_(bar))'))
        self.assertFalse(markdown_matches('[w](<https://w.test/Foo_(bar)>)', '[w](https://w.test/Foo_(baz))'))
        self.assertFalse(markdown_matches('[Run](<https://a.test/x>)', '[Run](https://a.test/y)'))
        self.assertFalse(markdown_matches('[Run](<https://a.test/x>)', '[Walk](https://a.test/x)'))
        self.assertFalse(markdown_matches('```\n[a](<b>)\n```', '```\n[a](b)\n```'))
        self.assertFalse(markdown_matches('```\n  * code\n```', '```\n  - code\n```'))

class DescriptionSettlementTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'state.db'
        self.ingress = Path(tmp.name) / 'ingress.db'
        self.clock = Clock()
        self.remote = CheckboxRemote(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_issue('issue-1', 'ABC-1', project=None)
        self.remote.set_delegate('issue-1', {'id': SELF})
        self.store = Store(self.path)
        self.store.put('issue-1', 'chat', 'chat')
        self.notes: list[tuple[str, str]] = []
        self.api = LinearAPI(lambda: 'synthetic', endpoint=self.remote.url)
        self.bridge = Bridge(self.store, self.api, SimpleNamespace(), profile='alpha', clock=self.clock)
        self.bridge.profile_home = Path(tmp.name)
        self.context = NativeContext(home=tmp.name, session_key='chat', session_id='session', profile='alpha',
                                     platform='slack', source='slack')
        self.request_id = str(uuid.uuid4())

    def invoke(self, action='update_description', *, content=CHECKED, request_id=None, **extra):
        args = {'action': action, 'issue': 'ABC-1', 'id': request_id or self.request_id,
                'description': content, 'body': content, 'expected_description': 'Synthetic issue body', **extra}
        with patch.object(self.bridge, 'flush'):
            return json.loads(chat.handle(self.bridge, args, self.context))

    def row(self, row_id=None):
        return self.store.outbox_row(row_id or self.request_id)

    def mutations(self):
        return [q for q in self.remote.requests if q.startswith('mutation')]

    def wedge(self):
        """A lost response, then a human edit: the remote outcome is genuinely unknown."""
        self.assertTrue(self.invoke()['ok'])
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(), 0)
        self.remote.issues['issue-1']['description'] = 'Human changed this after send'
        self.clock.now += 3601
        self.bridge.flush()
        self.assertTrue(self.store.issue_reconciliation_blocked('issue-1'))

    def test_canonicalised_checkbox_settles_without_alert_or_wedge(self):
        self.assertTrue(self.invoke()['ok'])
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.row()['state'], 'sent')
        self.assertEqual(self.notes, [])
        self.assertFalse(self.store.issue_reconciliation_blocked('issue-1'))
        self.assertTrue(self.invoke('add_comment', request_id=str(uuid.uuid4()))['ok'])

    def test_linear_shaped_rewrite_settles_without_alert_or_wedge(self):
        self.remote.close()
        self.remote = LinearRemote(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_issue('issue-1', 'ABC-1', project=None)
        self.remote.set_delegate('issue-1', {'id': SELF})
        self.bridge.api = self.api = LinearAPI(lambda: 'synthetic', endpoint=self.remote.url)
        self.assertTrue(self.invoke(content=LINEAR_SHAPED)['ok'])
        self.assertEqual(self.bridge.flush(), 1)
        stored = self.remote.issues['issue-1']['description']
        self.assertIn('  * nested', stored)
        self.assertIn('(<https://example.test/dash>)', stored)
        self.assertIn('(<https://w.test/Foo_(bar)>)', stored)
        self.assertIn('- [x] literal (keep)', stored)
        self.assertEqual(self.row()['state'], 'sent')
        self.assertEqual(self.notes, [])
        self.assertFalse(self.store.issue_reconciliation_blocked('issue-1'))

    def test_lost_response_then_canonicalised_readback_settles_once(self):
        self.assertTrue(self.invoke()['ok'])
        self.remote.lose_next_response = True
        self.assertEqual(self.bridge.flush(), 0)
        self.bridge.store = self.store = Store(self.path)
        self.clock.now += 3601
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(self.row()['state'], 'sent')
        self.assertEqual(len(self.mutations()), 1)
        self.assertEqual(self.notes, [])

    def test_uncertain_write_is_visible_without_chat_injection(self):
        self.wedge()
        self.assertEqual(self.notes, [])
        text = ops.report(ops.stuck(self.path, self.ingress, 'alpha'))
        self.assertIn(self.request_id, text)
        self.assertIn('resolve', text)

    def test_held_description_refusal_names_write_and_supported_resolution(self):
        self.wedge()
        reply = self.invoke('update_description', request_id=str(uuid.uuid4()))
        self.assertFalse(reply['ok'])
        self.assertIn(self.request_id, reply['message'])
        self.assertIn(f'hermes linear resolve {self.request_id}', reply['message'])
        self.assertEqual(self.store.get('issue-1')['owner_ref'], 'chat')

    def test_new_comment_delivers_without_resolving_or_repeating_uncertain_description(self):
        self.wedge()
        before = self.row()
        sent = len(self.mutations())
        reply = self.invoke('add_comment', request_id=str(uuid.uuid4()))
        self.assertTrue(reply['ok'])
        self.assertEqual(self.bridge.flush(), 1)
        self.assertEqual(len(self.mutations()), sent + 1)
        self.assertTrue(self.store.issue_reconciliation_blocked('issue-1'))
        self.assertEqual(self.remote.issues['issue-1']['description'], 'Human changed this after send')
        self.assertEqual(self.row()['attempts'], before['attempts'])
        self.assertEqual(self.row()['payload']['body'], before['payload']['body'])
        self.assertEqual(self.store.get('issue-1')['owner_ref'], 'chat')

    def test_operator_resolution_releases_once_without_duplicate_effects(self):
        self.wedge()
        sent = len(self.mutations())
        args = SimpleNamespace(linear_command='resolve', row_id=self.request_id, outcome='not_applied',
                               evidence='Readback shows the human edit, not the queued body')
        self.assertEqual(ops.run(args, self.path, self.ingress, 'alpha'), 0)
        self.assertEqual(ops.run(args, self.path, self.ingress, 'alpha'), 1)
        self.assertFalse(self.store.issue_reconciliation_blocked('issue-1'))
        self.bridge.flush()
        self.assertEqual(len(self.mutations()), sent)
        self.assertEqual(self.remote.issues['issue-1']['description'], 'Human changed this after send')
        self.assertTrue(self.invoke('add_comment', request_id=str(uuid.uuid4()))['ok'])
        self.assertEqual(self.store.get('issue-1')['owner_ref'], 'chat')

if __name__ == '__main__':
    unittest.main()
