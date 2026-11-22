"""Source selection and required-check contract, exercised through the real CLI."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/source-ci.py'


class SourceSelectionTests(unittest.TestCase):
    def select(self, *paths, extra=()):
        result = subprocess.run([sys.executable, str(SCRIPT), 'select', '--files', *paths, *extra],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_docs_do_not_select_runtime_or_units(self):
        plan = self.select('security/README.md', 'docs/image-release.md', 'README.md',
                           'plugins/linear/README.md', 'plugins/claude-account-connectors/README.md')
        self.assertEqual(plan['tests'], [])
        for lane in ('linear', 'acp', 'origin', 'input', 'journey', 'runtime'):
            self.assertFalse(plan[lane], lane)

    def test_test_only_selects_exact_module_and_required_runner(self):
        for name, lane in [('test_perplexity_provider.py', None),
                           ('test_linear_active_recovery_scenarios.py', 'linear'),
                           ('test_claude_acp_context.py', 'acp'),
                           ('test_linear_origin_mapping_native.py', 'origin'),
                           ('test_linear_native_worker_delivery_seam.py', 'input')]:
            with self.subTest(name=name):
                plan = self.select('tests/' + name)
                self.assertEqual(plan['tests'], ['tests/' + name])
                self.assertEqual(plan['runtime'], lane is not None)
                if lane:
                    self.assertTrue(plan[lane])
        self.assertTrue(self.select('tests/test_linear_existing_work_scenarios.py')['linear'])

    def test_shared_test_modules_select_transitive_consumers(self):
        for path, consumer in (
            ('tests/test_linear_specialist_authorization.py', 'tests/test_linear_native_input_seam.py'),
            ('tests/test_linear_native_input_seam.py', 'tests/test_linear_native_delivery_seam.py'),
            ('tests/test_linear_native_delivery_seam.py', 'tests/test_linear_native_worker_delivery_seam.py'),
            ('tests/test_linear_status_follows_work_scenarios.py', 'tests/test_linear_worker_progress_scenarios.py'),
            ('tests/test_linear_content_actions.py', 'tests/test_linear_native_frontdoor_scenarios.py'),
            ('tests/test_claude_acp_connector_hydration.py', 'tests/test_claude_acp_wire.py'),
        ):
            self.assertIn(consumer, self.select(path)['tests'])

    def test_native_journey_requires_non_skipping_runtime_proof(self):
        self.assertTrue(self.select('tests/test_linear_native_work_journey.py')['runtime'])
        self.assertTrue(self.select('tests/test_linear_native_work_journey.py')['journey'])
        self.assertTrue(self.select('tests/test_linear_worker_questions.py')['runtime'])
        self.assertTrue(self.select('tests/test_linear_worker_questions.py')['journey'])

    def test_components_and_transitive_contracts(self):
        cases = {
            'plugins/linear/api.py': ('tests/test_linear_plugin.py', 'linear'),
            'plugins/model-providers/claude-acp/client.py': ('tests/test_claude_acp_wire.py', 'acp'),
            'plugins/claude-account-connectors/plugin.py': ('tests/test_claude_acp_connector_hydration.py', 'acp'),
            'plugins/web/perplexity/provider.py': ('tests/test_perplexity_provider.py', None),
            'sidecars/browser-broker/server.py': ('tests/test_browser_broker_group_admit.py', None),
            'scripts/tooling-policy-hook': ('tests/test_tooling_policy_hook.py', None),
        }
        for path, (test, lane) in cases.items():
            with self.subTest(path=path):
                plan = self.select(path)
                self.assertFalse(plan['full'])
                self.assertIn(test, plan['tests'])
                self.assertIn('tests/test_public_product.py', plan['tests'])
                if lane:
                    self.assertTrue(plan[lane])
                else:
                    self.assertFalse(plan['runtime'])

    def test_shared_helpers_select_consumers(self):
        for path in ('tests/linear_fake_api.py', 'tests/linear_origin_guard.py',
                     'tests/fixtures/claude_acp_wire_peer.py'):
            plan = self.select(path)
            self.assertTrue(plan['runtime'])
            self.assertGreater(len(plan['tests']), 1)

    def test_uncertainty_and_selection_changes_broaden(self):
        for path in ('release/agent-image-manifest.json',
                     'release/linear-scenario-requirements.txt', 'tests/native-input-requirements.txt',
                     '.github/workflows/ci.yml', '.github/workflows/fleet-image.yml',
                     'scripts/source-ci.py', 'tests/test_source_ci_scope.py',
                     'scripts/run-linear-input-scenarios.py', 'scripts/read-agent-image-manifest.py',
                     'tests/unknown_helper.py', 'tests/fixtures/anything.json', 'tests/fixtures/reply.md'):
            with self.subTest(path=path):
                plan = self.select(path)
                self.assertTrue(plan['full'])
                self.assertTrue(plan['units_full'])
                self.assertTrue(plan['runtime_full'])
                self.assertTrue(plan['runtime'])

    def test_unmapped_non_runtime_inputs_run_every_unit_but_no_real_agent_leg(self):
        inventory = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests').glob('test_*.py'))
        for path in ('unknown.file', 'Dockerfile', 'docker/entrypoint.sh', 'plugins/disk-cleanup/plugin.py',
                     'scripts/scan-fleet-image.py', 'skills/example/SKILL.yaml'):
            with self.subTest(path=path):
                plan = self.select(path)
                self.assertTrue(plan['units_full'])
                self.assertFalse(plan['runtime_full'])
                self.assertFalse(plan['full'])
                self.assertFalse(plan['runtime'])
                self.assertEqual(plan['tests'], inventory)
        # A mapped Linear change alongside still selects exactly its own real-Agent legs.
        plan = self.select('Dockerfile', 'tests/test_linear_active_recovery_scenarios.py')
        self.assertTrue(plan['units_full'])
        self.assertTrue(plan['linear'])
        self.assertFalse(plan['input'])

    def test_manual_and_schedule_are_full_inventory(self):
        inventory = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests').glob('test_*.py'))
        for event in ('workflow_dispatch', 'schedule'):
            plan = self.select('README.md', extra=('--event', event))
            self.assertTrue(plan['full'])
            self.assertEqual(plan['tests'], inventory)

    def test_every_existing_test_has_a_route(self):
        for test in (ROOT / 'tests').glob('test_*.py'):
            path = str(test.relative_to(ROOT))
            self.assertIn(path, self.select(path)['tests'])

    def test_inventory_of_shared_test_fixtures_is_complete(self):
        import ast
        spec = importlib.util.spec_from_file_location('source_ci_inventory', SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        names = {p.stem for p in (ROOT / 'tests').glob('test_*.py')}
        for path in (ROOT / 'tests').glob('*.py'):
            for node in ast.walk(ast.parse(path.read_text())):
                imports = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ''] if isinstance(node, ast.ImportFrom) else []
                for imported in imports:
                    name = imported.split('.')[-1]
                    if name in names and name != path.stem:
                        self.assertIn(name + '.py', module.SHARED_TESTS, (path.name, name))

    def test_units_cli_executes_selected_module_and_rejects_invalid_inventory(self):
        plan = self.select('tests/test_perplexity_provider.py')
        result = subprocess.run([sys.executable, str(SCRIPT), 'units', '--plan', json.dumps(plan)],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Selected unit module: tests/test_perplexity_provider.py', result.stdout)
        self.assertIn('Ran ', result.stderr)
        self.assertNotIn('skipped=', result.stderr)
        plan['tests'] = ['tests/nonexistent.py']
        result = subprocess.run([sys.executable, str(SCRIPT), 'units', '--plan', json.dumps(plan)],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_units_preserve_repository_root_imports(self):
        plan = self.select('tests/test_claude_acp_model_spellings.py')
        result = subprocess.run([sys.executable, str(SCRIPT), 'units', '--plan', json.dumps(plan)],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('skipped=', result.stderr)

    def test_missing_range_is_full(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'select', '--event', 'push'],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['full'])

    def test_real_git_pr_merge_base_push_delete_rename_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.check_output(['git', '-C', tmp, *args], text=True).strip()
            def commit(name):
                git('add', '-A')
                git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', name)
                return git('rev-parse', 'HEAD')
            git('init', '-q')
            Path(tmp, 'README.md').write_text('base')
            root = commit('base')
            Path(tmp, 'unknown.file').write_text('base-only')
            base = commit('base advanced')
            git('checkout', '-q', '--detach', root)
            Path(tmp, 'README.md').write_text('PR docs')
            head = commit('PR')
            def select(event, before, after):
                result = subprocess.run([sys.executable, str(SCRIPT), 'select', '--event', event,
                                         '--base', before, '--head', after, '--repo', tmp],
                                        capture_output=True, text=True, cwd=ROOT)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)
            self.assertFalse(select('pull_request', base, head)['units_full'])
            # base..head on push removes unknown.file: a delete routes by its old path.
            pushed = select('push', base, head)
            self.assertTrue(pushed['units_full'])
            self.assertFalse(pushed['runtime_full'])
            self.assertTrue(select('push', 'invalid', head)['full'])
            git('mv', 'README.md', 'OTHER.md')
            renamed = commit('rename')
            self.assertFalse(select('push', head, renamed)['units_full'])
            Path(tmp, 'OTHER.md').unlink()
            deleted = commit('delete')
            self.assertFalse(select('push', renamed, deleted)['units_full'])
            Path(tmp, 'tests').mkdir()
            Path(tmp, 'notes.md').write_text('x' * 200)
            moved_from = commit('notes')
            git('mv', 'notes.md', 'tests/helper.md.py')
            moved = commit('rename into a runtime input')
            self.assertTrue(select('push', moved_from, moved)['runtime_full'])
            Path(tmp, 'tests/helper.md.py').unlink()
            gone = commit('delete runtime input')
            self.assertTrue(select('push', moved, gone)['runtime_full'])


class FastLaneTests(unittest.TestCase):
    def select(self, *paths, event='pull_request', added=()):
        result = subprocess.run([sys.executable, str(SCRIPT), 'select', '--event', event, '--files', *paths,
                                 '--added', *added], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_linear_plugin_pr_defers_component_legs_to_push(self):
        pr = self.select('plugins/linear/waits.py', 'plugins/linear/README.md')
        push = self.select('plugins/linear/waits.py', 'plugins/linear/README.md', event='push')
        self.assertFalse(pr['runtime'])
        self.assertEqual(pr['tests'], push['tests'])
        self.assertTrue(push['runtime'])
        deferred = [lane for lane in ('linear', 'acp', 'origin', 'input', 'journey') if push[lane]]
        self.assertEqual(pr['deferred_on_pr'], sorted(deferred))
        self.assertEqual(push['deferred_on_pr'], sorted(deferred))
        self.assertIn('fast lane', pr['reason'])

    def test_touched_scenario_files_keep_their_legs_before_merge(self):
        pr = self.select('plugins/linear/waits.py', 'tests/test_linear_native_input_seam.py')
        self.assertTrue(pr['input'])
        self.assertFalse(pr['linear'])
        self.assertNotIn('input', pr['deferred_on_pr'])
        pr = self.select('plugins/linear/waits.py', 'tests/test_linear_active_recovery_scenarios.py')
        self.assertTrue(pr['linear'])
        self.assertFalse(pr['input'])

    def test_gated_inputs_never_defer(self):
        for other in ('release/agent-image-manifest.json', 'Dockerfile', '.github/workflows/ci.yml',
                      'scripts/source-ci.py', 'scripts/run-linear-scenarios.py', 'tests/linear_fake_api.py',
                      'sidecars/linear-receiver/server.py', 'plugins/disk-cleanup/plugin.py', 'unknown.file'):
            with self.subTest(other=other):
                plan = self.select('plugins/linear/waits.py', other)
                self.assertEqual(plan['deferred_on_pr'], [])
                self.assertNotIn('fast lane', plan['reason'])
        # Tests-only and docs-only changes have nothing to defer: they already run exactly theirs.
        self.assertEqual(self.select('tests/test_linear_ci_wait_scenarios.py')['deferred_on_pr'], [])
        self.assertEqual(self.select('README.md')['deferred_on_pr'], [])
        for event in ('workflow_dispatch', 'schedule'):
            plan = self.select('plugins/linear/waits.py', event=event)
            self.assertTrue(plan['full'])
            self.assertEqual(plan['deferred_on_pr'], [])

    def test_the_plugin_class_is_an_explicit_allowlist_of_non_authority_files(self):
        module = load_selector()
        self.assertEqual(module.FAST_LANE_FILES, frozenset(
            'plugins/linear/' + name for name in ('acceptance.py', 'outcome.py', 'waits.py')))
        for path in sorted(module.FAST_LANE_FILES):
            with self.subTest(path=path):
                self.assertTrue((ROOT / path).is_file())
                self.assertNotEqual(self.select(path)['deferred_on_pr'], [])
        # Sender, permission, identity, credential, manifest and registration code stays gated,
        # alone or mixed with an allowlisted file; so does any file not on the list.
        for name in ('__init__.py', 'plugin.yaml', 'oauth.py', 'guard.py', 'transport.py', 'api.py', 'bridge.py',
                     'handoff.py', 'origin.py', 'origin_provider.py', 'origin_state.py', 'native_store.py',
                     'native_input.py', 'chat.py', 'cleanup.py', 'worker_progress.py', 'work.py', 'store.py',
                     'ops.py', 'diag.py', 'credentials2.py'):
            with self.subTest(name=name):
                self.assertEqual(self.select('plugins/linear/' + name)['deferred_on_pr'], [])
                self.assertEqual(self.select('plugins/linear/waits.py', 'plugins/linear/' + name)['deferred_on_pr'], [])

    def test_added_or_moved_files_stay_gated(self):
        new_test = 'tests/test_linear_active_recovery_scenarios.py'
        self.assertEqual(self.select('plugins/linear/waits.py', new_test, added=[new_test])['deferred_on_pr'], [])
        self.assertNotEqual(self.select('plugins/linear/waits.py', new_test)['deferred_on_pr'], [])
        self.assertEqual(self.select('plugins/linear/waits.py', added=['plugins/linear/waits.py'])['deferred_on_pr'], [])
        self.assertEqual(self.select('plugins/linear/waits.py', 'tests/fixtures/reply.md')['deferred_on_pr'], [])
        self.assertNotEqual(self.select('plugins/linear/waits.py', 'plugins/linear/README.md')['deferred_on_pr'], [])

    def test_git_range_marks_added_and_renamed_tests_as_new(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.check_output(['git', '-C', tmp, *args], text=True).strip()
            def commit(name):
                git('add', '-A'); git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', name)
                return git('rev-parse', 'HEAD')
            git('init', '-q')
            Path(tmp, 'plugins/linear').mkdir(parents=True)
            Path(tmp, 'tests').mkdir()
            Path(tmp, 'plugins/linear/waits.py').write_text('a')
            Path(tmp, 'tests/test_linear_plugin.py').write_text('x = 1\n' * 20)
            base = commit('base')
            Path(tmp, 'plugins/linear/waits.py').write_text('b')
            Path(tmp, 'tests/test_linear_status_progress.py').write_text('new')
            head = commit('add a test')
            def select(before, after):
                result = subprocess.run([sys.executable, str(SCRIPT), 'select', '--event', 'pull_request', '--repo', tmp,
                                         '--base', before, '--head', after], cwd=ROOT, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)
            self.assertEqual(select(base, head)['deferred_on_pr'], [])
            git('rm', '-q', 'tests/test_linear_status_progress.py')
            git('mv', 'tests/test_linear_plugin.py', 'tests/test_linear_task_link.py')
            renamed = commit('rename into another existing name')
            self.assertEqual(select(head, renamed)['deferred_on_pr'], [])
            Path(tmp, 'plugins/linear/waits.py').write_text('c')
            Path(tmp, 'tests/test_linear_task_link.py').write_text('edited ' * 20)
            edited = commit('edit existing')
            self.assertNotEqual(select(renamed, edited)['deferred_on_pr'], [])

    def test_deferred_push_never_consults_reuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.check_output(['git', '-C', tmp, *args], text=True).strip()
            git('init', '-q')
            Path(tmp, 'plugins/linear').mkdir(parents=True)
            Path(tmp, 'plugins/linear/waits.py').write_text('a')
            git('add', '-A'); git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a')
            before = git('rev-parse', 'HEAD')
            Path(tmp, 'plugins/linear/waits.py').write_text('b')
            git('add', '-A'); git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'b')
            after = git('rev-parse', 'HEAD')
            result = subprocess.run([sys.executable, str(SCRIPT), 'select', '--event', 'push', '--repo', tmp,
                                     '--base', before, '--head', after, '--reuse-repository', 'example/none'],
                                    cwd=ROOT, capture_output=True, text=True, env={'PATH': '/usr/bin:/bin'})
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertTrue(plan['runtime'])
            self.assertNotIn('reused_from', plan)
            self.assertNotIn('reuse:', result.stderr)


class WorkflowContractTests(unittest.TestCase):
    def test_all_work_is_bound_to_selection_and_aggregate(self):
        text = (ROOT / '.github/workflows/ci.yml').read_text()
        import re
        jobs = dict(re.findall(r'^  ([\w-]+):\n(.*?)(?=^  [\w-]+:\n|\Z)', text.split('jobs:\n', 1)[1], re.M | re.S))
        self.assertEqual(set(jobs), {'selection', 'source-tests', 'runtime', 'source-checks', 'history-root'})
        self.assertIn('needs: [selection, source-tests, runtime]', jobs['source-checks'])
        self.assertIn('if: always()', jobs['source-checks'])
        self.assertIn('source-ci.py gate', jobs['source-checks'])
        self.assertIn('--record-pr-proof', jobs['source-checks'])
        self.assertIn('fetch-depth: 2', jobs['source-checks'])
        self.assertIn('toJSON(needs)', jobs['source-checks'])
        self.assertIn('needs.selection.outputs.plan', jobs['source-checks'])
        self.assertIn('needs: selection', jobs['runtime'])
        self.assertIn("needs.selection.outputs.runtime == 'true'", jobs['runtime'])
        self.assertNotIn('candidate-hf578', text)
        self.assertIn('source-ci.py units', jobs['source-tests'])
        self.assertIn('needs.selection.outputs.plan', jobs['source-tests'])
        for flag in ('linear', 'acp', 'origin', 'input', 'journey'):
            self.assertIn("needs.selection.outputs." + flag + " == 'true'", jobs['runtime'])
            self.assertIn(flag + ': ${{ steps.select.outputs.' + flag + ' }}', jobs['selection'])
        self.assertIn('fetch-depth: 0', jobs['selection'])
        self.assertIn('github.event.pull_request.base.sha || github.event.before', jobs['selection'])
        self.assertIn('github.event.pull_request.head.sha || github.sha', jobs['selection'])
        self.assertIn('workflow_dispatch:', text)
        self.assertIn("    - cron: '23 4 * * *'", text)
        self.assertIn("reused: ${{ steps.select.outputs.reused }}", jobs['selection'])
        self.assertIn('--reuse-repository "$GITHUB_REPOSITORY"', jobs['selection'])
        self.assertIn("GH_TOKEN: ${{ github.event_name == 'push' && github.token || '' }}", jobs['selection'])
        for grant in ('contents: read', 'pull-requests: read', 'actions: read', 'checks: read'):
            self.assertIn(grant, jobs['selection'])
        self.assertIn("if: needs.selection.outputs.reused != 'true'", jobs['source-tests'])


def load_selector():
    spec = importlib.util.spec_from_file_location('source_ci_reuse', SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PushReuseTests(unittest.TestCase):
    SHA, BEFORE, HEAD = 'a' * 40, 'b' * 40, 'c' * 40
    TESTED, TREE = 'd' * 40, 'e' * 40
    REPO = 'switchroom/switchroom'
    JOBS = f'repos/{REPO}/actions/runs/2/attempts/1/jobs?per_page=100'
    NOTES = f'repos/{REPO}/check-runs/202/annotations?per_page=100'

    def setUp(self):
        self.module = load_selector()
        self.plan = self.module.select(['tests/test_perplexity_provider.py'])

    def proof(self, **override):
        proof = self.module.source_proof(self.plan, repository=self.REPO, pr='7', base=self.BEFORE, head=self.HEAD,
                                         tested=self.TESTED, tree=self.TREE, run_id='2', attempt='1')
        return dict(proof, **override)

    def notice(self, **override):
        return {'title': 'source-ci-reuse-proof', 'annotation_level': 'notice', 'path': 'scripts/source-ci.py',
                'message': json.dumps(self.proof(**override))}

    def responses(self, **override):
        r = {
            f'repos/{self.REPO}/commits/{self.SHA}/pulls?per_page=100': [
                {'number': 7, 'merged_at': '2026-11-22T00:00:00Z', 'merge_commit_sha': self.SHA,
                 'base': {'ref': 'main'}, 'head': {'sha': self.HEAD, 'ref': 'feature'}}],
            f'repos/{self.REPO}/pulls?state=all&head=switchroom:feature&per_page=100': [{'number': 7}],
            f'repos/{self.REPO}/git/commits/{self.SHA}': {'tree': {'sha': self.TREE}},
            f'repos/{self.REPO}/git/commits/{self.HEAD}': {'tree': {'sha': self.TREE}},
            f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'ahead'},
            f'repos/{self.REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.HEAD}&per_page=100': {
                'total_count': 2,
                'workflow_runs': [
                    {'id': 1, 'head_branch': 'feature', 'head_repository': {'full_name': self.REPO}, 'created_at': '2026-11-21T00:00:00Z', 'head_sha': self.HEAD, 'event': 'pull_request',
                     'path': '.github/workflows/ci.yml', 'status': 'completed', 'conclusion': 'failure', 'pull_requests': [],
                     'html_url': 'https://x/runs/1'},
                    {'id': 2, 'head_branch': 'feature', 'head_repository': {'full_name': self.REPO}, 'created_at': '2026-11-22T00:00:00Z', 'head_sha': self.HEAD, 'event': 'pull_request',
                     'path': '.github/workflows/ci.yml', 'status': 'completed', 'conclusion': 'success', 'pull_requests': [],
                     'run_attempt': 1, 'html_url': 'https://x/runs/2'}]},
            f'repos/{self.REPO}/issues/7/events?per_page=100': [
                {'event': 'base_ref_changed', 'created_at': '2026-11-21T12:00:00Z'},
                {'event': 'labeled', 'created_at': '2026-11-22T00:30:00Z'}],
            self.JOBS: {
                'total_count': 2,
                'jobs': [{'id': 202, 'name': 'source-checks', 'status': 'completed', 'conclusion': 'success'},
                         {'name': 'runtime (input 1/3)', 'conclusion': 'success'}]},
            self.NOTES: [{'title': 'unrelated notice'}, self.notice()],
        }
        r.update(override)
        return r

    def find(self, responses, sha=None, before=None, plan=None):
        before = self.BEFORE if before is None else before
        plan = self.plan if plan is None else plan
        def api(path):
            if path not in responses:
                raise subprocess.CalledProcessError(1, ['gh', 'api', path])
            return responses[path]
        logs = []
        return self.module.find_reuse(self.REPO, sha or self.SHA, before, plan, api=api, log=logs.append), logs

    def test_covered_push_reuses_the_newest_green_run(self):
        url, _ = self.find(self.responses())
        self.assertEqual(url, 'https://x/runs/2')
        url, _ = self.find(self.responses(**{
            f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'identical'}}))
        self.assertEqual(url, 'https://x/runs/2')

    def test_any_failed_condition_or_doubt_falls_back(self):
        base = self.responses()
        runs_key = f'repos/{self.REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.HEAD}&per_page=100'
        jobs_key = self.JOBS
        branch_prs_key = f'repos/{self.REPO}/pulls?state=all&head=switchroom:feature&per_page=100'

        def run_page(*runs):
            return {'total_count': len(runs), 'workflow_runs': list(runs)}

        green = base[runs_key]['workflow_runs'][1]
        newest_red = run_page(dict(green, id=3, conclusion='failure', created_at='2026-11-23T00:00:00Z'),
                              *base[runs_key]['workflow_runs'])
        cases = {
            'tree differs': {f'repos/{self.REPO}/git/commits/{self.HEAD}': {'tree': {'sha': 'f' * 40}}},
            'not current with main': {f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'diverged'}},
            'behind': {f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'behind'}},
            'newest run red': {runs_key: newest_red},
            'cannot order matching runs': {runs_key: run_page(green, dict(green, id=3, created_at=None))},
            'incomplete run page': {runs_key: dict(base[runs_key], total_count=101)},
            'incomplete job page': {jobs_key: dict(base[jobs_key], total_count=101)},
            'run count missing': {runs_key: {'workflow_runs': [green]}},
            'no run': {runs_key: run_page()},
            'other workflow': {runs_key: run_page(dict(green, path='.github/workflows/x.yml'))},
            'in progress': {runs_key: run_page(dict(green, status='in_progress', conclusion=None))},
            'aggregate red': {jobs_key: {'total_count': 1,
                                          'jobs': [{'name': 'source-checks', 'conclusion': 'failure'}]}},
            'aggregate missing': {jobs_key: {'total_count': 0, 'jobs': []}},
            'no merged PR': {f'repos/{self.REPO}/commits/{self.SHA}/pulls?per_page=100': []},
            'fork run': {runs_key: run_page(dict(green, head_repository={'full_name': 'someone/fork'}))},
            'run of another branch': {runs_key: run_page(dict(green, head_branch='other'))},
            'run of another PR': {runs_key: run_page(dict(green, pull_requests=[{'number': 9, 'base': {'ref': 'main'}}]))},
            'run against another base': {runs_key: run_page(dict(green, pull_requests=[{'number': 7, 'base': {'ref': 'stacked'}}]))},
            'branch has another historical PR': {branch_prs_key: [
                {'number': 7}, {'number': 9, 'state': 'closed', 'head': {'sha': 'e' * 40}}]},
            # A stacked PR's run against its parent branch, retargeted to main and merged unrun.
            'retargeted after the run': {f'repos/{self.REPO}/issues/7/events?per_page=100': [
                {'event': 'base_ref_changed', 'created_at': '2026-11-22T00:10:00Z'}]},
            'events unreadable in one page': {f'repos/{self.REPO}/issues/7/events?per_page=100':
                [{'event': 'labeled', 'created_at': '2026-11-20T00:00:00Z'}] * 100},
            'PR merged elsewhere': {f'repos/{self.REPO}/commits/{self.SHA}/pulls?per_page=100': [
                dict(base[f'repos/{self.REPO}/commits/{self.SHA}/pulls?per_page=100'][0], merge_commit_sha='d' * 40)]},
            'malformed': {f'repos/{self.REPO}/git/commits/{self.SHA}': {}},
            'full page of PRs on the branch': {branch_prs_key:
                [{'number': 7}] + [{'number': 100 + i} for i in range(99)]},
            'full page of PRs on the merge': {f'repos/{self.REPO}/commits/{self.SHA}/pulls?per_page=100':
                base[f'repos/{self.REPO}/commits/{self.SHA}/pulls?per_page=100'] * 100},
            'PR list not a list': {f'repos/{self.REPO}/commits/{self.SHA}/pulls?per_page=100': {'message': 'x'}},
        }
        for name, override in cases.items():
            with self.subTest(name=name):
                url, logs = self.find(self.responses(**override))
                self.assertIsNone(url)
                self.assertTrue(logs)
        missing = self.responses()
        del missing[f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}']
        self.assertIsNone(self.find(missing)[0])
        self.assertIsNone(self.find(self.responses(), before='0' * 40)[0])
        self.assertIsNone(self.find(self.responses(), before='')[0])

    def test_run_proof_must_cover_this_push(self):
        for proof_change in ({'base': '0' * 40}, {'head': self.BEFORE}, {'tree': self.HEAD}, {'pr': '8'},
                             {'tested': ''}, {'repository': 'other/repo'}, {'run_id': '1'}, {'attempt': '2'}):
            with self.subTest(proof_change=proof_change):
                self.assertIsNone(self.find(self.responses(**{self.NOTES: [self.notice(**proof_change)]}))[0])
        for plan in (dict(self.plan, tests=[]), dict(self.plan, linear=True, runtime=True)):
            with self.subTest(plan=plan):
                self.assertIsNone(self.find(self.responses(), plan=plan)[0])

    def test_run_proof_must_be_a_single_complete_notice_on_the_green_attempt(self):
        valid = self.notice()
        for notes in ([], [valid, valid], [valid] + [{'title': 'other'}] * 99, {'wrong': valid},
                      [dict(valid, path='README.md')], [dict(valid, annotation_level='warning')],
                      [dict(valid, message='x' * 1025)], [dict(valid, message='bad JSON')]):
            with self.subTest(count=len(notes)):
                self.assertIsNone(self.find(self.responses(**{self.NOTES: notes}))[0])
        responses = self.responses()
        runs_key = f'repos/{self.REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.HEAD}&per_page=100'
        responses[runs_key]['workflow_runs'][-1]['run_attempt'] = 2
        self.assertIsNone(self.find(responses)[0])  # Attempt 1's success is insufficient.

    def test_missing_push_diff_keeps_full_plan_without_reuse(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'select', '--event', 'push',
                                 '--base', self.BEFORE, '--head', self.SHA, '--reuse-repository', self.REPO],
                                cwd=ROOT, capture_output=True, text=True, env={'PATH': '/nonexistent'})
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertTrue(plan['full'])
        self.assertNotIn('reused_from', plan)
        self.assertNotIn('reuse:', result.stderr)

    def test_selector_reuses_the_covered_push_plan(self):
        import contextlib
        import functools
        import io
        from unittest import mock

        lookup = functools.partial(self.module.find_reuse, api=self.responses().__getitem__)
        argv = [str(SCRIPT), 'select', '--event', 'push', '--base', self.BEFORE, '--head', self.SHA,
                '--reuse-repository', self.REPO]
        out = io.StringIO()
        with mock.patch.object(sys, 'argv', argv), \
                mock.patch.object(self.module, 'changed_paths', return_value=['tests/test_perplexity_provider.py']), \
                mock.patch.object(self.module, 'find_reuse', side_effect=lookup), contextlib.redirect_stdout(out):
            self.assertEqual(self.module.main(), 0)
        self.assertEqual(json.loads(out.getvalue())['reused_from'], 'https://x/runs/2')

    def test_unexpected_exception_in_lookup_falls_back(self):
        module = load_selector()
        for error in (RuntimeError('boom'), LookupError('x'), ZeroDivisionError()):
            with self.subTest(error=type(error).__name__):
                def api(path, error=error):
                    raise error
                logs = []
                self.assertIsNone(module.find_reuse(self.REPO, self.SHA, self.BEFORE, self.plan, api=api, log=logs.append))
                self.assertIn(type(error).__name__, logs[-1])

    def test_reused_plan_passes_gate_only_with_tests_and_runtime_skipped(self):
        module = load_selector()
        plan = module.reused_plan('https://x/runs/2')
        skipped = {'selection': {'result': 'success'}, 'source-tests': {'result': 'skipped'},
                   'runtime': {'result': 'skipped'}}
        self.assertTrue(module.gate(plan, skipped))
        self.assertFalse(module.gate(plan, {**skipped, 'selection': {'result': 'failure'}}))
        self.assertFalse(module.gate(dict(plan, runtime=True), skipped))
        self.assertFalse(module.gate({k: v for k, v in plan.items() if k != 'reused_from'}, skipped))

    def test_reuse_is_never_consulted_for_pr_dispatch_or_explicit_files(self):
        for extra in (('--event', 'pull_request'), ('--event', 'workflow_dispatch'), ('--files', 'README.md')):
            result = subprocess.run([sys.executable, str(SCRIPT), 'select', '--reuse-repository', 'example/none',
                                     '--base', self.BEFORE, '--head', self.SHA, *extra],
                                    cwd=ROOT, capture_output=True, text=True, env={'PATH': '/nonexistent'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('reused_from', json.loads(result.stdout))


class AggregateTests(unittest.TestCase):
    def test_records_the_pr_event_and_the_checked_out_merge_result_only_after_a_green_gate(self):
        module = load_selector()
        plan = module.select(['README.md'], event='pull_request')
        needs = {'selection': {'result': 'success'}, 'source-tests': {'result': 'success'},
                 'runtime': {'result': 'skipped'}}
        repository = 'switchroom/switchroom'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            origin, checkout = root / 'origin', root / 'checkout'
            origin.mkdir()

            def git(*args):
                return subprocess.check_output(
                    ['git', '-C', str(origin), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', *args],
                    text=True,
                ).strip()

            git('init', '-q', '-b', 'main')
            (origin / 'scripts').mkdir()
            (origin / 'scripts/source-ci.py').write_bytes(SCRIPT.read_bytes())
            git('add', '-A')
            git('commit', '-qm', 'base')
            base = git('rev-parse', 'HEAD')
            git('checkout', '-qb', 'feature')
            (origin / 'README.md').write_text('PR docs')
            git('add', '-A')
            git('commit', '-qm', 'PR head')
            head = git('rev-parse', 'HEAD')
            git('checkout', '-q', 'main')
            git('merge', '-q', '--no-ff', '-m', 'PR test merge', 'feature')
            tested = git('rev-parse', 'HEAD')
            tree = git('rev-parse', 'HEAD^{tree}')
            git('clone', '-q', '--depth=2', origin.as_uri(), str(checkout))
            event_path = root / 'event.json'
            event = {'pull_request': {'number': 7,
                                      'base': {'ref': 'main', 'sha': base, 'repo': {'full_name': repository}},
                                      'head': {'sha': head, 'repo': {'full_name': repository}}}}
            event_path.write_text(json.dumps(event))
            env = dict(os.environ, GITHUB_EVENT_NAME='pull_request', GITHUB_EVENT_PATH=str(event_path),
                       GITHUB_REPOSITORY=repository, GITHUB_SHA=tested, GITHUB_RUN_ID='2', GITHUB_RUN_ATTEMPT='1')

            def gate(results):
                return subprocess.run([sys.executable, str(checkout / 'scripts/source-ci.py'), 'gate',
                                       '--plan', json.dumps(plan), '--needs', json.dumps(results), '--record-pr-proof'],
                                      env=env, capture_output=True, text=True)

            green = gate(needs)
            self.assertEqual(green.returncode, 0, green.stderr)
            proof_text = green.stdout.split('title=source-ci-reuse-proof::', 1)[1]
            self.assertEqual(json.loads(proof_text), module.source_proof(
                plan, repository=repository, pr='7', base=base, head=head,
                tested=tested, tree=tree, run_id='2', attempt='1',
            ))
            failed = gate(dict(needs, selection={'result': 'failure'}))
            self.assertEqual(failed.returncode, 1, failed.stderr)
            self.assertNotIn('source-ci-reuse-proof', failed.stdout)
            event['pull_request']['base']['sha'] = 'b' * 40
            event_path.write_text(json.dumps(event))
            mismatched = gate(needs)
            self.assertEqual(mismatched.returncode, 0, mismatched.stderr)
            self.assertNotIn('source-ci-reuse-proof', mismatched.stdout)

    def test_truth_table_missing_failed_cancelled_skipped(self):
        self.assertTrue(SCRIPT.is_file(), 'source CI aggregate is not implemented')
        spec = importlib.util.spec_from_file_location('source_ci', SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for selected in (False, True):
            plan = {'runtime': selected}
            good = {'selection': {'result': 'success'}, 'source-tests': {'result': 'success'},
                    'runtime': {'result': 'success' if selected else 'skipped'}}
            self.assertTrue(module.gate(plan, good))
            self.assertFalse(module.gate(plan, {}))
            self.assertFalse(module.gate(plan, {**good, 'candidate-hf578': {'result': 'success'}}))
            for job in good:
                for state in ('failure', 'cancelled', 'skipped', None):
                    if state == 'skipped' and job == 'runtime' and not selected:
                        continue
                    broken = {k: dict(v) for k, v in good.items()}
                    if state is None:
                        del broken[job]
                    else:
                        broken[job]['result'] = state
                    self.assertFalse(module.gate(plan, broken), (selected, job, state))
            self.assertFalse(module.gate({}, good))


if __name__ == '__main__':
    unittest.main()
