"""Source selection and required-check contract, exercised through the real CLI."""
import importlib.util
import json
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
        for lane in ('linear', 'acp', 'origin', 'input', 'journey', 'candidate', 'runtime'):
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
        self.assertTrue(self.select('tests/test_linear_existing_work_scenarios.py')['candidate'])

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

    def test_candidate_fixture_is_not_lost(self):
        plan = self.select('tests/candidate_hf578.py')
        self.assertTrue(plan['candidate'])
        self.assertFalse(plan['runtime'])

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
        for path in ('unknown.file', 'release/agent-image-manifest.json',
                     'release/linear-scenario-requirements.txt', '.github/workflows/ci.yml',
                     'scripts/source-ci.py', 'tests/test_source_ci_scope.py',
                     'tests/unknown_helper.py', 'Dockerfile'):
            with self.subTest(path=path):
                plan = self.select(path)
                self.assertTrue(plan['full'])
                self.assertTrue(plan['candidate'])
                self.assertTrue(plan['runtime'])

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
            self.assertFalse(select('pull_request', base, head)['full'])
            self.assertTrue(select('push', base, head)['full'])
            self.assertTrue(select('push', 'invalid', head)['full'])
            git('mv', 'README.md', 'OTHER.md')
            renamed = commit('rename')
            self.assertTrue(select('push', head, renamed)['full'])
            Path(tmp, 'OTHER.md').unlink()
            deleted = commit('delete')
            self.assertTrue(select('push', renamed, deleted)['full'])


class WorkflowContractTests(unittest.TestCase):
    def test_all_work_is_bound_to_selection_and_aggregate(self):
        text = (ROOT / '.github/workflows/ci.yml').read_text()
        import re
        jobs = dict(re.findall(r'^  ([\w-]+):\n(.*?)(?=^  [\w-]+:\n|\Z)', text.split('jobs:\n', 1)[1], re.M | re.S))
        self.assertEqual(set(jobs), {'selection', 'source-tests', 'runtime', 'candidate-hf578', 'source-checks', 'history-root'})
        self.assertIn('needs: [selection, source-tests, runtime, candidate-hf578]', jobs['source-checks'])
        self.assertIn('if: always()', jobs['source-checks'])
        self.assertIn('source-ci.py gate', jobs['source-checks'])
        self.assertIn('toJSON(needs)', jobs['source-checks'])
        self.assertIn('needs.selection.outputs.plan', jobs['source-checks'])
        for job, flag in [('runtime', 'runtime'), ('candidate-hf578', 'candidate')]:
            self.assertIn('needs: selection', jobs[job])
            self.assertIn("needs.selection.outputs." + flag + " == 'true'", jobs[job])
        self.assertIn('source-ci.py units', jobs['source-tests'])
        self.assertIn('needs.selection.outputs.plan', jobs['source-tests'])
        for flag in ('linear', 'acp', 'origin', 'input', 'journey'):
            self.assertIn("needs.selection.outputs." + flag + " == 'true'", jobs['runtime'])
            self.assertIn(flag + ': ${{ steps.select.outputs.' + flag + ' }}', jobs['selection'])
        self.assertIn('fetch-depth: 0', jobs['selection'])
        self.assertIn('github.event.pull_request.base.sha || github.event.before', jobs['selection'])
        self.assertIn('github.event.pull_request.head.sha || github.sha', jobs['selection'])
        self.assertIn('workflow_dispatch:', text)
        self.assertIn('schedule:', text)


class AggregateTests(unittest.TestCase):
    def test_truth_table_missing_failed_cancelled_skipped(self):
        self.assertTrue(SCRIPT.is_file(), 'source CI aggregate is not implemented')
        spec = importlib.util.spec_from_file_location('source_ci', SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        import itertools
        for selected, candidate in itertools.product((False, True), repeat=2):
            plan = {'runtime': selected, 'candidate': candidate}
            good = {'selection': {'result': 'success'}, 'source-tests': {'result': 'success'},
                    'runtime': {'result': 'success' if selected else 'skipped'},
                    'candidate-hf578': {'result': 'success' if candidate else 'skipped'}}
            self.assertTrue(module.gate(plan, good))
            self.assertFalse(module.gate(plan, {}))
            for job in good:
                for state in ('failure', 'cancelled', 'skipped', None):
                    if state == 'skipped' and ((job == 'runtime' and not selected) or (job == 'candidate-hf578' and not candidate)):
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
