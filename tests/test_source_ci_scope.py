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
        self.assertIn("GH_TOKEN: ${{ (github.event_name == 'push' || github.event_name == 'pull_request') && github.token || '' }}", jobs['selection'])
        self.assertIn('--tested "$TESTED"', jobs['selection'])
        self.assertIn('TESTED: ${{ github.sha }}', jobs['selection'])
        self.assertIn('scripts/run-runtime-leg.sh "$LANE" "$SHARD"', jobs['runtime'])
        self.assertNotIn('run-linear-', jobs['runtime'], 'runtime proofs live in run-runtime-leg.sh only')
        for grant in ('contents: read', 'pull-requests: read', 'actions: read', 'checks: read'):
            self.assertIn(grant, jobs['selection'])
        self.assertIn("if: needs.selection.outputs.reused != 'true'", jobs['source-tests'])

    def test_runtime_matrix_is_the_shared_leg_list(self):
        import re
        text = (ROOT / '.github/workflows/ci.yml').read_text()
        listed = re.findall(r"- \{lane: (\w+), shard: ([^}]*)\}", text)
        legs = tuple((lane, shard.strip().strip("'")) for lane, shard in listed)
        self.assertEqual(legs, load_selector().RUNTIME_LEGS)
        out = subprocess.run([sys.executable, str(SCRIPT), 'legs'], capture_output=True, text=True, check=True).stdout
        self.assertEqual([(x['lane'], x['shard'], x['name']) for x in json.loads(out)],
                         [(l, s, f'{l} {s}' if s else l) for l, s in legs])

    def test_leg_script_rejects_unknown_lanes_and_proofs(self):
        leg = ROOT / 'scripts/run-runtime-leg.sh'
        for args in (('bogus', '', '/'), ('kanban', '1/3', '/', 'input'), ('native', '', 'relative'), ('input',)):
            result = subprocess.run(['bash', str(leg), *args], capture_output=True, text=True,
                                    env={'PATH': '/usr/bin:/bin', 'RUNNER_TEMP': '/nonexistent'})
            self.assertEqual(result.returncode, 2, (args, result.stderr))


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
    API_REPO = f'https://api.github.com/repos/{REPO}'
    RUNS = f'repos/{REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={HEAD}&per_page=100'
    JOBS = f'repos/{REPO}/actions/runs/2/attempts/1/jobs?per_page=100'
    NOTES = f'repos/{REPO}/check-runs/202/annotations?per_page=100'
    MERGE = f'repos/{REPO}/git/commits/{TESTED}'

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
        repo = {'full_name': self.REPO}
        run = {'head_branch': 'feature', 'repository': repo, 'head_repository': repo,
               'head_sha': self.HEAD, 'event': 'pull_request', 'path': '.github/workflows/ci.yml',
               'status': 'completed', 'pull_requests': [], 'run_attempt': 1}
        r = {
            f'repos/{self.REPO}/commits/{self.SHA}/pulls?per_page=100': [
                {'number': 7, 'merged_at': '2026-11-22T00:00:00Z', 'merge_commit_sha': self.SHA,
                 'base': {'ref': 'main', 'repo': repo},
                 'head': {'sha': self.HEAD, 'ref': 'feature', 'repo': repo}}],
            f'repos/{self.REPO}/pulls?state=all&head=switchroom:feature&per_page=100': [{'number': 7}],
            f'repos/{self.REPO}/git/commits/{self.SHA}': {'tree': {'sha': self.TREE}},
            f'repos/{self.REPO}/git/commits/{self.HEAD}': {'tree': {'sha': self.TREE}},
            self.MERGE: {'sha': self.TESTED, 'tree': {'sha': self.TREE},
                         'parents': [{'sha': self.BEFORE}, {'sha': self.HEAD}]},
            f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'ahead'},
            self.RUNS: {
                'total_count': 2,
                'workflow_runs': [
                    dict(run, id=1, created_at='2026-11-21T00:00:00Z', conclusion='failure',
                         html_url='https://x/runs/1'),
                    dict(run, id=2, created_at='2026-11-22T00:00:00Z', conclusion='success',
                         html_url='https://x/runs/2')]},
            f'repos/{self.REPO}/issues/7/events?per_page=100': [
                {'event': 'base_ref_changed', 'created_at': '2026-11-21T12:00:00Z'},
                {'event': 'labeled', 'created_at': '2026-11-22T00:30:00Z'}],
            self.JOBS: {
                'total_count': 2,
                'jobs': [{'id': 202, 'name': 'source-checks', 'status': 'completed', 'conclusion': 'success',
                          'run_id': 2, 'run_attempt': 1, 'head_sha': self.HEAD,
                          'run_url': f'{self.API_REPO}/actions/runs/2',
                          'check_run_url': f'{self.API_REPO}/check-runs/202'},
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
        runs_key = self.RUNS
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
            'retarget has no timestamp': {f'repos/{self.REPO}/issues/7/events?per_page=100': [
                {'event': 'base_ref_changed'}]},
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

    def test_incomplete_newer_run_cannot_be_discarded(self):
        base = self.responses()[self.RUNS]['workflow_runs']
        red = dict(base[-1], id=3, created_at='2026-11-23T00:00:00Z', conclusion='failure')
        for field in ('repository', 'head_repository', 'head_sha', 'path', 'event', 'head_branch'):
            with self.subTest(field=field):
                incomplete = dict(red)
                del incomplete[field]
                page = {'total_count': 3, 'workflow_runs': [*base, incomplete]}
                self.assertIsNone(self.find(self.responses(**{self.RUNS: page}))[0])
        fork = dict(red, head_repository={'full_name': 'other/fork'})
        page = {'total_count': 3, 'workflow_runs': [*base, fork]}
        self.assertEqual(self.find(self.responses(**{self.RUNS: page}))[0], 'https://x/runs/2')

    def test_source_job_identity_must_match_the_selected_run(self):
        fields = {
            'id': 303,
            'run_id': 99,
            'run_attempt': 2,
            'head_sha': self.BEFORE,
            'run_url': f'{self.API_REPO}/actions/runs/99',
            'check_run_url': 'https://api.github.com/repos/other/repo/check-runs/202',
        }
        for field, value in fields.items():
            for missing in (False, True):
                with self.subTest(field=field, missing=missing):
                    responses = self.responses()
                    job = responses[self.JOBS]['jobs'][0]
                    if missing:
                        del job[field]
                    else:
                        job[field] = value
                    self.assertIsNone(self.find(responses)[0])

    def test_run_proof_must_cover_this_push(self):
        for proof_change in ({'base': '0' * 40}, {'head': self.BEFORE}, {'tree': self.HEAD}, {'pr': '8'},
                             {'tested': ''}, {'repository': 'other/repo'}, {'run_id': '1'}, {'attempt': '2'}):
            with self.subTest(proof_change=proof_change):
                self.assertIsNone(self.find(self.responses(**{self.NOTES: [self.notice(**proof_change)]}))[0])
        for plan in (dict(self.plan, tests=[]), dict(self.plan, linear=True, runtime=True)):
            with self.subTest(plan=plan):
                self.assertIsNone(self.find(self.responses(), plan=plan)[0])

    def test_proof_needs_independently_verified_merge_tree_and_ordered_parents(self):
        responses = self.responses()
        merge = responses[self.MERGE]
        for change in ({'tree': {'sha': self.HEAD}}, {'parents': list(reversed(merge['parents']))},
                       {'parents': [{'sha': self.HEAD}]}, {'sha': self.SHA}):
            with self.subTest(change=change):
                self.assertIsNone(self.find(self.responses(**{self.MERGE: dict(merge, **change)}))[0])
        wrong = self.SHA
        responses = self.responses(**{
            self.NOTES: [self.notice(tested=wrong)],
            f'repos/{self.REPO}/git/commits/{wrong}': {
                'sha': wrong, 'tree': {'sha': self.TREE}, 'parents': [{'sha': self.BEFORE}],
            },
        })
        self.assertIsNone(self.find(responses)[0])
        responses = self.responses()
        del responses[self.MERGE]
        self.assertIsNone(self.find(responses)[0])

    def test_run_proof_must_be_a_single_complete_notice_on_the_green_attempt(self):
        valid = self.notice()
        for notes in ([], [valid, valid], [valid] + [{'title': 'other'}] * 99, {'wrong': valid},
                      [dict(valid, path='README.md')], [dict(valid, annotation_level='warning')],
                      [dict(valid, message='x' * 1025)], [dict(valid, message='bad JSON')]):
            with self.subTest(count=len(notes)):
                self.assertIsNone(self.find(self.responses(**{self.NOTES: notes}))[0])
        responses = self.responses()
        responses[self.RUNS]['workflow_runs'][-1]['run_attempt'] = 2
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

    def test_selector_reuses_only_the_covered_push_plan_and_attempt(self):
        import contextlib
        import functools
        import io
        from unittest import mock

        argv = [str(SCRIPT), 'select', '--event', 'push', '--base', self.BEFORE, '--head', self.SHA,
                '--reuse-repository', self.REPO]
        for job_attempt in (1, 2):
            with self.subTest(job_attempt=job_attempt):
                responses = self.responses()
                responses[self.JOBS]['jobs'][0]['run_attempt'] = job_attempt
                lookup = functools.partial(self.module.find_reuse, api=responses.__getitem__)
                out = io.StringIO()
                with mock.patch.object(sys, 'argv', argv), \
                        mock.patch.object(self.module, 'changed_paths', return_value=['tests/test_perplexity_provider.py']), \
                        mock.patch.object(self.module, 'find_reuse', side_effect=lookup), contextlib.redirect_stdout(out):
                    self.assertEqual(self.module.main(), 0)
                plan = json.loads(out.getvalue())
                if job_attempt == 1:
                    self.assertEqual(plan['reused_from'], 'https://x/runs/2')
                else:
                    self.assertEqual(plan, self.plan)

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


class PinReuseTests(unittest.TestCase):
    """A pin-only PR reuses the Agent repository's fleet-integration push run, or runs everything."""
    AGENT = 'switchroom/hermes-agent'
    REPO = 'switchroom/switchroom'
    REV = 'e' * 40
    AGENT_TREE = 'f' * 40
    RUNS = f'repos/{AGENT}/actions/workflows/fleet-integration.yml/runs?event=push&branch=main&head_sha={REV}&per_page=100'
    JOBS = f'repos/{AGENT}/actions/runs/50/attempts/1/jobs?per_page=100'
    AGENT_COMMIT = f'repos/{AGENT}/git/commits/{REV}'

    def setUp(self):
        self.module = load_selector()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.git('init', '-q', '-b', 'main')
        for name in ('README.md', 'release/agent-image-manifest.json', 'plugins/disk-cleanup/UPSTREAM.json',
                     'plugins/linear/acceptance.py', 'tests/test_linear_x_scenarios.py'):
            self.write(name, '{"revision": "' + 'a' * 40 + '"}' if name.endswith('manifest.json') else 'x\n')
        self.switchroom = self.commit('switchroom main the Agent run used')
        self.base = self.switchroom
        self.tested = self.pin(self.base)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), '-c', 'user.name=t', '-c', 'user.email=t@t',
                                        *args], text=True).strip()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-q', '--allow-empty', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def pin(self, base, extra=None, revision=None):
        self.git('checkout', '-q', '--detach', base)
        self.write('release/agent-image-manifest.json', '{"revision": "' + (revision or self.REV) + '"}')
        self.write('plugins/disk-cleanup/UPSTREAM.json', 'pinned\n')
        if extra:
            self.write(extra, 'changed\n')
        tested = self.commit('pin')
        self.git('checkout', '-q', 'main')
        return tested

    def advance_main(self, name):
        self.git('checkout', '-q', 'main')
        self.write(name, 'moved\n')
        return self.commit('main moved: ' + name)

    def result(self, **override):
        r = {'schema': 'fleet-integration/v1', 'result': 'success', 'event': 'push', 'ref': 'refs/heads/main',
             'agent_repository': self.AGENT, 'agent_commit': self.REV, 'agent_tree': self.AGENT_TREE,
             'run_id': 50, 'run_attempt': 1, 'ran_legs': True, 'scope': 'success',
             'workflow': '.github/workflows/fleet-integration.yml', 'switchroom_repository': self.REPO,
             'switchroom_commit': self.switchroom, 'switchroom_tree': self.git('rev-parse', self.switchroom + '^{tree}'),
             'legs': {self.module.leg_name(*leg): 'success' for leg in self.module.RUNTIME_LEGS}}
        r.update(override)
        return r

    def run_entry(self, **override):
        r = {'id': 50, 'head_sha': self.REV, 'path': '.github/workflows/fleet-integration.yml', 'event': 'push',
             'head_branch': 'main', 'head_repository': {'full_name': self.AGENT},
             'repository': {'full_name': self.AGENT}, 'status': 'completed', 'conclusion': 'success', 'run_attempt': 1,
             'created_at': '2026-11-22T05:00:00Z', 'html_url': 'https://github.com/x/runs/50'}
        r.update(override)
        return r

    NOTES = 'repos/switchroom/hermes-agent/check-runs/900/annotations?per_page=100'

    def note(self, result=None, **override):
        n = {'title': 'fleet-integration-result', 'annotation_level': 'notice',
             'message': json.dumps(self.result() if result is None else result)}
        n.update(override)
        return n

    @staticmethod
    def run_page(*runs):
        return {'total_count': len(runs), 'workflow_runs': list(runs)}

    @staticmethod
    def jobs_page(*jobs):
        return {'total_count': len(jobs), 'jobs': list(jobs)}

    def responses(self, **override):
        job_names = ['Fleet integration pass'] + [
            f'fleet leg ({self.module.leg_name(*leg)})' for leg in self.module.RUNTIME_LEGS]
        api_repo = f'https://api.github.com/repos/{self.AGENT}'
        jobs = [dict(id=job_id, name=name, status='completed', conclusion='success', run_id=50, run_attempt=1,
                     head_sha=self.REV, run_url=f'{api_repo}/actions/runs/50', check_run_url=f'{api_repo}/check-runs/{job_id}')
                for job_id, name in enumerate(job_names, start=900)]
        r = {
            self.RUNS: self.run_page(self.run_entry(id=49, conclusion='failure', created_at='2026-11-22T04:00:00Z'),
                                     self.run_entry()),
            self.JOBS: self.jobs_page(*jobs),
            self.AGENT_COMMIT: {'sha': self.REV, 'tree': {'sha': self.AGENT_TREE}},
            self.NOTES: [{'title': 'other', 'annotation_level': 'notice', 'message': 'x'}, self.note()],
        }
        r.update(override)
        return r

    def find(self, responses=None, result=None, base=None, tested=None):
        responses = self.responses() if responses is None else responses
        if result is not None:
            responses = dict(responses, **{self.NOTES: [self.note(result)]})
        def api(path):
            if path not in responses:
                raise subprocess.CalledProcessError(1, ['gh', 'api', path])
            return responses[path]
        logs = []
        url = self.module.find_pin_reuse(self.root, self.REPO, self.base if base is None else base,
                                         self.tested if tested is None else tested,
                                         api=api, log=logs.append)
        return url, logs

    def test_pin_only_paths(self):
        pin = self.module.is_pin_only
        self.assertTrue(pin(['release/agent-image-manifest.json']))
        self.assertTrue(pin(['release/agent-image-manifest.json', 'plugins/disk-cleanup/UPSTREAM.json']))
        self.assertFalse(pin(['plugins/disk-cleanup/UPSTREAM.json']))
        self.assertFalse(pin([]))
        for other in ('plugins/a/b/UPSTREAM.json', 'plugins/disk-cleanup/UPSTREAM_LICENSE', 'README.md',
                      'plugins/disk-cleanup/UPSTREAM.json.bak', 'xplugins/a/UPSTREAM.json'):
            self.assertFalse(pin(['release/agent-image-manifest.json', other]), other)

    def test_green_run_of_the_same_switchroom_tree_is_reused(self):
        proof, logs = self.find()
        self.assertEqual(proof, ('https://github.com/x/runs/50', 50, 1), logs)

    def test_main_moved_only_in_non_runtime_paths_is_still_reused(self):
        self.base = self.advance_main('docs/notes.md')
        proof, logs = self.find(tested=self.pin(self.base))
        self.assertEqual(proof, ('https://github.com/x/runs/50', 50, 1), logs)

    def test_earlier_pin_merged_since_the_agent_run_is_still_reused(self):
        # The previous pin PR merged after the Agent run checked out switchroom: main moved only
        # in the manifest and an existing UPSTREAM.json, which this pin PR rewrites.
        self.base = self.pin(self.base, revision='d' * 40)
        self.git('checkout', '-q', 'main')
        self.git('merge', '-q', '--ff-only', self.base)
        proof, logs = self.find(tested=self.pin(self.base))
        self.assertEqual(proof, ('https://github.com/x/runs/50', 50, 1), logs)

    def test_earlier_pin_plus_a_runtime_input_runs_everything(self):
        self.git('checkout', '-q', '--detach', self.base)
        self.write('release/agent-image-manifest.json', '{"revision": "' + 'd' * 40 + '"}')
        self.write('plugins/linear/acceptance.py', 'moved\n')
        base = self.commit('pin plus runtime change')
        self.git('checkout', '-q', 'main')
        self.assertIsNone(self.find(base=base, tested=self.pin(base))[0])

    def test_stale_switchroom_tree_runs_everything(self):
        for moved in ('plugins/linear/acceptance.py', 'tests/test_linear_x_scenarios.py',
                      'scripts/run-runtime-leg.sh', '.github/workflows/ci.yml', 'scripts/source-ci.py',
                      'release/linear-scenario-requirements.txt', 'plugins/new-plugin/UPSTREAM.json'):
            with self.subTest(moved=moved):
                base = self.advance_main(moved)
                url, logs = self.find(base=base, tested=self.pin(base))
                self.assertIsNone(url)
                self.assertTrue(logs)

    def test_switchroom_commit_not_in_history_or_not_an_ancestor(self):
        side = self.pin(self.base, extra='README.md')  # a commit that is not an ancestor of base
        cases = {'unknown commit': {'switchroom_commit': '9' * 40},
                 'tree mismatch': {'switchroom_tree': '9' * 40},
                 'not an ancestor': {'switchroom_commit': side, 'switchroom_tree': self.git('rev-parse', side + '^{tree}')}}
        for name, override in cases.items():
            with self.subTest(name=name):
                self.assertIsNone(self.find(result=self.result(**override))[0])

    def test_any_failed_condition_or_doubt_runs_everything(self):
        base = self.responses()
        runs, jobs = self.RUNS, self.JOBS
        good_jobs = base[self.JOBS]['jobs']
        good_run = self.run_entry()
        incomplete_newer = self.run_entry(id=51, created_at='2026-11-22T06:00:00Z', status='queued', conclusion=None)
        del incomplete_newer['head_repository']
        response_cases = {
            'no run': {runs: self.run_page()},
            'incomplete run page': {runs: dict(base[runs], total_count=3)},
            'unidentifiable newer run': {runs: self.run_page(incomplete_newer, good_run)},
            'newest run red': {runs: self.run_page(good_run, self.run_entry(id=51, conclusion='failure',
                                                                          created_at='2026-11-22T06:00:00Z'))},
            'in progress': {runs: self.run_page(self.run_entry(status='in_progress', conclusion=None))},
            'fork run': {runs: self.run_page(self.run_entry(head_repository={'full_name': 'someone/hermes-agent'}))},
            'pull_request run': {runs: self.run_page(self.run_entry(event='pull_request'))},
            'other branch': {runs: self.run_page(self.run_entry(head_branch='feature'))},
            'other workflow': {runs: self.run_page(self.run_entry(path='.github/workflows/ci.yaml'))},
            'different agent sha': {runs: self.run_page(self.run_entry(head_sha='d' * 40))},
            'aggregate red': {jobs: self.jobs_page(dict(good_jobs[0], conclusion='failure'), *good_jobs[1:])},
            'missing leg': {jobs: self.jobs_page(*good_jobs[:-1])},
            'incomplete job page': {jobs: dict(base[jobs], total_count=len(good_jobs) + 1)},
            'failed leg': {jobs: self.jobs_page(*good_jobs[:-1], dict(good_jobs[-1], conclusion='failure'))},
            'skipped leg': {jobs: self.jobs_page(*good_jobs[:-1], dict(good_jobs[-1], conclusion='skipped'))},
            'duplicate leg': {jobs: self.jobs_page(*good_jobs, dict(good_jobs[-1], conclusion='failure'))},
            'stale attempt': {jobs: self.jobs_page(*good_jobs[:-1], dict(good_jobs[-1], run_attempt=2))},
            'other job revision': {jobs: self.jobs_page(*good_jobs[:-1], dict(good_jobs[-1], head_sha='d' * 40))},
            'other job run': {jobs: self.jobs_page(*good_jobs[:-1], dict(good_jobs[-1], run_id=49))},
            'aggregate check belongs elsewhere': {jobs: self.jobs_page(
                dict(good_jobs[0], check_run_url='https://api.github.com/repos/elsewhere/check-runs/900'), *good_jobs[1:])},
            'duplicate check identity': {jobs: self.jobs_page(
                *good_jobs[:-1], dict(good_jobs[-1], id=900, check_run_url=good_jobs[0]['check_run_url']))},
            'missing Agent tree': {self.AGENT_COMMIT: {'sha': self.REV}},
            'wrong Agent tree': {self.AGENT_COMMIT: {'sha': self.REV, 'tree': {'sha': 'a' * 40}}},
            'no record': {self.NOTES: []},
            'annotation page full': {self.NOTES: [self.note()] + [{'title': 'unrelated'}] * 99},
            'record not a notice': {self.NOTES: [self.note(annotation_level='warning')]},
            'two records': {self.NOTES: [self.note(), self.note()]},
            'record not json': {self.NOTES: [self.note(message='not json')]},
            'record not an object': {self.NOTES: [self.note(message='[1]')]},
            'annotations unreadable': {self.NOTES: None},
            'api error': {runs: None},
        }
        for name, override in response_cases.items():
            with self.subTest(name=name):
                responses = self.responses(**override)
                for key in (runs, self.NOTES):
                    if key in override and override[key] is None:
                        del responses[key]
                url, logs = self.find(responses)
                self.assertIsNone(url)
                self.assertTrue(logs)
        legs = self.result()['legs']
        result_cases = {
            'different agent commit': {'agent_commit': 'd' * 40},
            'different agent tree': {'agent_tree': 'd' * 40},
            'other run': {'run_id': 49},
            'other attempt': {'run_attempt': 2},
            'not actually ran': {'ran_legs': False},
            'scope failure': {'scope': 'failure'},
            'other switchroom repository': {'switchroom_repository': 'someone/switchroom'},
            'pull_request record': {'event': 'pull_request'},
            'failed leg': {'legs': dict(legs, native='failure')},
            'missing leg': {'legs': {k: v for k, v in legs.items() if k != 'native'}},
            'extra leg': {'legs': dict(legs, bonus='success')},
            'aggregate failed': {'result': 'failure'},
            'old schema': {'schema': 'fleet-integration/v0'},
            'no switchroom tree': {'switchroom_tree': None},
        }
        for name, override in result_cases.items():
            with self.subTest(name=name):
                self.assertIsNone(self.find(result=self.result(**override))[0])

    def test_full_re_run_requires_its_own_jobs_and_result(self):
        responses = self.responses()
        prior_jobs = responses.pop(self.JOBS)['jobs']
        current_jobs_key = self.JOBS.replace('/attempts/1/', '/attempts/2/')
        responses[self.RUNS] = self.run_page(self.run_entry(run_attempt=2))
        responses[current_jobs_key] = self.jobs_page(*(dict(job, run_attempt=2) for job in prior_jobs))
        self.assertIsNone(self.find(responses=responses)[0])
        proof, logs = self.find(responses=responses, result=self.result(run_attempt=2))
        self.assertEqual(proof, ('https://github.com/x/runs/50', 50, 2), logs)
        responses[current_jobs_key] = self.jobs_page(dict(prior_jobs[0], run_attempt=2))
        self.assertIsNone(self.find(responses=responses, result=self.result(run_attempt=2))[0])

    def test_merge_commit_must_change_only_pin_files_to_an_exact_revision(self):
        self.assertIsNone(self.find(tested=self.pin(self.base, extra='README.md'))[0])
        self.assertIsNone(self.find(tested=self.pin(self.base, revision='main'))[0])
        self.assertIsNone(self.find(tested=self.pin(self.base, revision='d' * 40))[0])  # no run for that sha
        self.assertIsNone(self.find(tested=self.base)[0])
        self.assertIsNone(self.find(base='', tested=self.tested)[0])

    def test_non_pin_file_renamed_to_a_pin_path_is_rejected(self):
        self.git('checkout', '-q', '--detach', self.tested)
        (self.root / 'plugins' / 'local').mkdir()
        self.git('mv', 'README.md', 'plugins/local/UPSTREAM.json')
        self.assertIsNone(self.find(tested=self.commit('rename README into pin path'))[0])

    def test_plan_skips_runtime_runs_units_and_gate_requires_tests(self):
        selected = self.module.select(['release/agent-image-manifest.json', 'plugins/disk-cleanup/UPSTREAM.json'],
                                      event='pull_request')
        self.assertTrue(selected['runtime'])
        plan = self.module.pin_reused_plan(selected, ('https://x/runs/50', 50, 1))
        self.assertFalse(plan['runtime'])
        self.assertEqual(plan['tests'], selected['tests'])
        self.assertEqual(plan['runtime_proof'], '50/1')
        self.assertIn('tests/test_disk_cleanup_plugin.py', plan['tests'])
        self.assertIn('tests/test_image_release.py', plan['tests'])
        ok = {'selection': {'result': 'success'}, 'source-tests': {'result': 'success'}, 'runtime': {'result': 'skipped'}}
        self.assertTrue(self.module.gate(plan, ok))
        self.assertFalse(self.module.gate(plan, {**ok, 'source-tests': {'result': 'skipped'}}))
        self.assertFalse(self.module.gate(dict(plan, runtime=True), {**ok, 'runtime': {'result': 'success'}}))
        self.assertFalse(self.module.gate(dict(plan, reused_from='https://x/runs/2'), ok))

    def test_cli_consults_pin_reuse_only_for_a_pin_only_pull_request(self):
        def run(event, tested):
            return subprocess.run([sys.executable, str(SCRIPT), 'select', '--event', event, '--repo', str(self.root),
                                   '--base', self.base, '--head', tested, '--tested', tested,
                                   '--reuse-repository', self.REPO],
                                  capture_output=True, text=True,
                                  env={'PATH': '/usr/bin:/bin', 'GH_TOKEN': '', 'HOME': str(self.root / 'home'),
                                       'XDG_CONFIG_HOME': str(self.root / 'home'), 'XDG_STATE_HOME': str(self.root / 'home')})
        pin = run('pull_request', self.tested)
        self.assertEqual(pin.returncode, 0, pin.stderr)
        self.assertIn('pin reuse:', pin.stderr)  # consulted, and with no API it runs everything
        self.assertTrue(json.loads(pin.stdout)['runtime'])
        self.assertNotIn('runtime_reused_from', json.loads(pin.stdout))
        other = run('pull_request', self.pin(self.base, extra='README.md'))
        self.assertNotIn('pin reuse:', other.stderr)

    def test_pin_pr_proof_and_exact_squash_push_reuse_the_same_agent_attempt(self):
        # A GitHub-style PR merge checkout and eventual squash have different commits but the same tree.
        self.write('scripts/source-ci.py', SCRIPT.read_text())
        self.write('tests/test_disk_cleanup_plugin.py', '')
        self.write('tests/test_image_release.py', '')
        self.base = self.commit('install CI in test repository')
        head = self.pin(self.base)
        self.git('checkout', '-q', '--detach', self.base)
        self.git('merge', '-q', '--no-ff', '-m', 'synthetic PR merge', head)
        tested = self.git('rev-parse', 'HEAD')
        tree = self.git('rev-parse', 'HEAD^{tree}')
        self.git('checkout', '-q', 'main')
        self.git('merge', '-q', '--squash', head)
        pushed = self.commit('squash pin onto main')
        self.assertNotEqual(tested, pushed)
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), tree)

        # Only the transport is substituted. The CLI plans, gates and writes its real annotation.
        self.write('bin/gh', '#!/usr/bin/env python3\nimport json, os, sys\n'
                   'with open(os.environ["ACTION_RESPONSES"]) as f: responses = json.load(f)\n'
                   'assert sys.argv[1] == "api"\n'
                   'path = sys.argv[2]\n'
                   'if path not in responses: sys.exit(1)\n'
                   'print(json.dumps(responses[path]))\n')
        (self.root / 'bin' / 'gh').chmod(0o755)
        responses_path = self.root / 'action-responses.json'
        event_path = self.root / 'event.json'
        api_repo = f'https://api.github.com/repos/{self.REPO}'
        scoped_agent_result = self.result(switchroom_commit=self.base,
                                          switchroom_tree=self.git('rev-parse', f'{self.base}^{{tree}}'))
        agent = self.responses(**{self.NOTES: [self.note(scoped_agent_result)]})
        executable = self.root / 'scripts' / 'source-ci.py'
        env = dict(os.environ, PATH=f'{self.root / "bin"}:{os.defpath}', ACTION_RESPONSES=str(responses_path),
                   GITHUB_API_URL='https://api.github.com')

        def select(event, after, checked, responses):
            responses_path.write_text(json.dumps(responses))
            result = subprocess.run([sys.executable, str(executable), 'select', '--event', event,
                                     '--base', self.base, '--head', after, '--tested', checked,
                                     '--reuse-repository', self.REPO], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout), result.stderr

        repo = {'full_name': self.REPO}
        pr = {'number': 7, 'base': {'ref': 'main', 'sha': self.base, 'repo': repo},
              'head': {'ref': 'release/pin-agent', 'sha': head, 'repo': repo}}
        event_path.write_text(json.dumps({'pull_request': pr}))
        self.git('checkout', '-q', '--detach', tested)
        pr_plan, _ = select('pull_request', head, tested, agent)
        self.assertEqual(pr_plan['tests'], ['tests/test_disk_cleanup_plugin.py', 'tests/test_image_release.py',
                                            'tests/test_linear_x_scenarios.py'])
        self.assertEqual(pr_plan['runtime_proof'], '50/1')
        self.assertFalse(pr_plan['runtime'])

        def emit(plan):
            needs = {job: {'result': result} for job, result in (
                ('selection', 'success'), ('source-tests', 'success'),
                ('runtime', 'success' if plan['runtime'] else 'skipped'))}
            gate_env = dict(env, GITHUB_EVENT_NAME='pull_request', GITHUB_EVENT_PATH=str(event_path),
                            GITHUB_REPOSITORY=self.REPO, GITHUB_SHA=tested, GITHUB_RUN_ID='60', GITHUB_RUN_ATTEMPT='1')
            gate = subprocess.run([sys.executable, str(executable), 'gate', '--plan', json.dumps(plan),
                                   '--needs', json.dumps(needs), '--record-pr-proof'],
                                  capture_output=True, text=True, env=gate_env)
            self.assertEqual(gate.returncode, 0, gate.stderr)
            return {'title': 'source-ci-reuse-proof', 'path': 'scripts/source-ci.py', 'annotation_level': 'notice',
                    'message': gate.stdout.split('title=source-ci-reuse-proof::')[1].strip()}

        note = emit(pr_plan)
        local_pr_plan, _ = select('pull_request', head, tested, {})
        self.assertTrue(local_pr_plan['runtime'])
        local_note = emit(local_pr_plan)
        self.git('checkout', '-q', 'main')

        source_notes = f'repos/{self.REPO}/check-runs/901/annotations?per_page=100'
        source_url = 'https://github.com/switchroom/switchroom/actions/runs/60'
        source = {
            f'repos/{self.REPO}/commits/{pushed}/pulls?per_page=100':
                [dict(pr, merged_at='2026-11-22T05:30:00Z', merge_commit_sha=pushed)],
            f'repos/{self.REPO}/git/commits/{pushed}': {'tree': {'sha': tree}},
            f'repos/{self.REPO}/git/commits/{head}': {'tree': {'sha': tree}},
            f'repos/{self.REPO}/git/commits/{tested}':
                {'sha': tested, 'tree': {'sha': tree}, 'parents': [{'sha': self.base}, {'sha': head}]},
            f'repos/{self.REPO}/compare/{self.base}...{head}': {'status': 'ahead'},
            f'repos/{self.REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={head}&per_page=100':
                self.run_page(self.run_entry(id=60, head_sha=head, path='.github/workflows/ci.yml',
                                             event='pull_request', head_branch=pr['head']['ref'],
                                             head_repository=repo, repository=repo, pull_requests=[pr], html_url=source_url)),
            f'repos/{self.REPO}/issues/7/events?per_page=100': [],
            f'repos/{self.REPO}/actions/runs/60/attempts/1/jobs?per_page=100':
                self.jobs_page(dict(id=901, name='source-checks', status='completed', conclusion='success',
                                    run_id=60, run_attempt=1, head_sha=head, run_url=f'{api_repo}/actions/runs/60',
                                    check_run_url=f'{api_repo}/check-runs/901')),
            source_notes: [note],
        }
        push, logs = select('push', pushed, pushed, {**source, **agent})
        self.assertEqual(push.get('reused_from'), source_url, logs)
        self.assertFalse(push['runtime'])
        self.assertEqual(push['tests'], [])

        new_agent = dict(agent, **{self.RUNS: self.run_page(self.run_entry(run_attempt=2))})
        old_jobs = new_agent.pop(self.JOBS)['jobs']
        new_agent[self.JOBS.replace('/attempts/1/', '/attempts/2/')] = self.jobs_page(
            *(dict(job, run_attempt=2) for job in old_jobs))
        new_agent[self.NOTES] = [self.note(dict(scoped_agent_result, run_attempt=2))]
        for reason, responses in {'Agent evidence missing': source, 'PR evidence missing': agent,
                                  'Agent attempt replaced': {**source, **new_agent},
                                  'PR notice changed': {**source, **agent, source_notes: []}}.items():
            with self.subTest(reason=reason):
                full, _ = select('push', pushed, pushed, responses)
                self.assertTrue(full['runtime_full'])
                self.assertTrue(all(full[lane] for lane in self.module.LANES))
                self.assertEqual(full['tests'], pr_plan['tests'])
                self.assertNotIn('reused_from', full)

        local_push, logs = select('push', pushed, pushed, dict(source, **{source_notes: [local_note]}))
        self.assertEqual(local_push.get('reused_from'), source_url, logs)
        self.assertNotIn('pin reuse:', logs)


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
