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
        for grant in ('contents: read', 'pull-requests: read', 'actions: read'):
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
    REPO = 'switchroom/switchroom'

    def responses(self, **override):
        r = {
            f'repos/{self.REPO}/commits/{self.SHA}/pulls': [
                {'number': 7, 'merged_at': '2026-11-22T00:00:00Z', 'merge_commit_sha': self.SHA,
                 'base': {'ref': 'main'}, 'head': {'sha': self.HEAD, 'ref': 'feature'}}],
            f'repos/{self.REPO}/commits/{self.HEAD}/pulls': [
                {'number': 7, 'head': {'sha': self.HEAD, 'ref': 'feature'}}],
            f'repos/{self.REPO}/git/commits/{self.SHA}': {'tree': {'sha': 't' * 40}},
            f'repos/{self.REPO}/git/commits/{self.HEAD}': {'tree': {'sha': 't' * 40}},
            f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'ahead'},
            f'repos/{self.REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.HEAD}&per_page=100': {
                'workflow_runs': [
                    {'id': 1, 'head_branch': 'feature', 'head_repository': {'full_name': self.REPO}, 'created_at': '2026-11-21T00:00:00Z', 'head_sha': self.HEAD, 'event': 'pull_request',
                     'path': '.github/workflows/ci.yml', 'status': 'completed', 'conclusion': 'failure',
                     'html_url': 'https://x/runs/1'},
                    {'id': 2, 'head_branch': 'feature', 'head_repository': {'full_name': self.REPO}, 'created_at': '2026-11-22T00:00:00Z', 'head_sha': self.HEAD, 'event': 'pull_request',
                     'path': '.github/workflows/ci.yml', 'status': 'completed', 'conclusion': 'success',
                     'html_url': 'https://x/runs/2'}]},
            f'repos/{self.REPO}/issues/7/events?per_page=100': [
                {'event': 'base_ref_changed', 'created_at': '2026-11-21T12:00:00Z'},
                {'event': 'labeled', 'created_at': '2026-11-22T00:30:00Z'}],
            f'repos/{self.REPO}/actions/runs/2/jobs?filter=latest&per_page=100': {
                'jobs': [{'name': 'source-checks', 'conclusion': 'success'},
                         {'name': 'runtime (input 1/3)', 'conclusion': 'success'}]},
        }
        r.update(override)
        return r

    def find(self, responses, sha=None, before=None):
        before = self.BEFORE if before is None else before
        module = load_selector()
        def api(path):
            if path not in responses:
                raise subprocess.CalledProcessError(1, ['gh', 'api', path])
            return responses[path]
        logs = []
        return module.find_reuse(self.REPO, sha or self.SHA, before, api=api, log=logs.append), logs

    def test_all_three_conditions_reuse_the_newest_green_run(self):
        url, _ = self.find(self.responses())
        self.assertEqual(url, 'https://x/runs/2')
        url, _ = self.find(self.responses(**{
            f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'identical'}}))
        self.assertEqual(url, 'https://x/runs/2')

    def test_any_failed_condition_or_doubt_falls_back(self):
        base = self.responses()
        runs_key = f'repos/{self.REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.HEAD}&per_page=100'
        newest_red = {'workflow_runs': [dict(base[runs_key]['workflow_runs'][1], id=3, conclusion='failure',
                                             created_at='2026-11-23T00:00:00Z')] + base[runs_key]['workflow_runs']}
        cases = {
            'tree differs': {f'repos/{self.REPO}/git/commits/{self.HEAD}': {'tree': {'sha': 'u' * 40}}},
            'not current with main': {f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'diverged'}},
            'behind': {f'repos/{self.REPO}/compare/{self.BEFORE}...{self.HEAD}': {'status': 'behind'}},
            'newest run red': {runs_key: newest_red},
            'no run': {runs_key: {'workflow_runs': []}},
            'other workflow': {runs_key: {'workflow_runs': [dict(base[runs_key]['workflow_runs'][1], path='.github/workflows/x.yml')]}},
            'in progress': {runs_key: {'workflow_runs': [dict(base[runs_key]['workflow_runs'][1], status='in_progress', conclusion=None)]}},
            'aggregate red': {f'repos/{self.REPO}/actions/runs/2/jobs?filter=latest&per_page=100': {
                'jobs': [{'name': 'source-checks', 'conclusion': 'failure'}]}},
            'aggregate missing': {f'repos/{self.REPO}/actions/runs/2/jobs?filter=latest&per_page=100': {'jobs': []}},
            'no merged PR': {f'repos/{self.REPO}/commits/{self.SHA}/pulls': []},
            'fork run': {runs_key: {'workflow_runs': [dict(base[runs_key]['workflow_runs'][1],
                head_repository={'full_name': 'someone/fork'})]}},
            'run of another branch': {runs_key: {'workflow_runs': [dict(base[runs_key]['workflow_runs'][1],
                head_branch='other')]}},
            'head shared with another PR': {f'repos/{self.REPO}/commits/{self.HEAD}/pulls': [
                {'number': 7, 'head': {'sha': self.HEAD}}, {'number': 9, 'head': {'sha': self.HEAD}}]},
            # A stacked PR's run against its parent branch, retargeted to main and merged unrun.
            'retargeted after the run': {f'repos/{self.REPO}/issues/7/events?per_page=100': [
                {'event': 'base_ref_changed', 'created_at': '2026-11-22T00:10:00Z'}]},
            'events unreadable in one page': {f'repos/{self.REPO}/issues/7/events?per_page=100':
                [{'event': 'labeled', 'created_at': '2026-11-20T00:00:00Z'}] * 100},
            'PR merged elsewhere': {f'repos/{self.REPO}/commits/{self.SHA}/pulls': [
                dict(base[f'repos/{self.REPO}/commits/{self.SHA}/pulls'][0], merge_commit_sha='d' * 40)]},
            'malformed': {f'repos/{self.REPO}/git/commits/{self.SHA}': {}},
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
             'agent_repository': self.AGENT, 'agent_commit': self.REV, 'agent_tree': 'f' * 40, 'run_id': 50,
             'workflow': '.github/workflows/fleet-integration.yml', 'switchroom_repository': self.REPO,
             'switchroom_commit': self.switchroom, 'switchroom_tree': self.git('rev-parse', self.switchroom + '^{tree}'),
             'legs': {self.module.leg_name(*leg): 'success' for leg in self.module.RUNTIME_LEGS}}
        r.update(override)
        return r

    def run_entry(self, **override):
        r = {'id': 50, 'head_sha': self.REV, 'path': '.github/workflows/fleet-integration.yml', 'event': 'push',
             'head_branch': 'main', 'head_repository': {'full_name': self.AGENT},
             'repository': {'full_name': self.AGENT}, 'status': 'completed', 'conclusion': 'success',
             'created_at': '2026-11-22T05:00:00Z', 'html_url': 'https://github.com/x/runs/50'}
        r.update(override)
        return r

    NOTES = 'repos/switchroom/hermes-agent/check-runs/900/annotations?per_page=100'

    def note(self, result=None, **override):
        n = {'title': 'fleet-integration-result', 'annotation_level': 'notice',
             'message': json.dumps(self.result() if result is None else result)}
        n.update(override)
        return n

    def responses(self, **override):
        jobs = [{'name': 'Fleet integration pass', 'conclusion': 'success', 'id': 900}] + [
            {'name': f'fleet leg ({self.module.leg_name(*leg)})', 'conclusion': 'success'} for leg in self.module.RUNTIME_LEGS]
        r = {
            f'repos/{self.AGENT}/actions/workflows/fleet-integration.yml/runs?event=push&branch=main&head_sha={self.REV}&per_page=100':
                {'workflow_runs': [self.run_entry(id=49, conclusion='failure', created_at='2026-11-22T04:00:00Z'),
                                   self.run_entry()]},
            f'repos/{self.AGENT}/actions/runs/50/jobs?filter=latest&per_page=100': {'jobs': jobs},
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
        url, logs = self.find()
        self.assertEqual(url, 'https://github.com/x/runs/50', logs)

    def test_main_moved_only_in_non_runtime_paths_is_still_reused(self):
        self.base = self.advance_main('docs/notes.md')
        url, logs = self.find(tested=self.pin(self.base))
        self.assertEqual(url, 'https://github.com/x/runs/50', logs)

    def test_stale_switchroom_tree_runs_everything(self):
        for moved in ('plugins/linear/acceptance.py', 'tests/test_linear_x_scenarios.py',
                      'scripts/run-runtime-leg.sh', '.github/workflows/ci.yml', 'scripts/source-ci.py',
                      'release/agent-image-manifest.json'):
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
        runs = f'repos/{self.AGENT}/actions/workflows/fleet-integration.yml/runs?event=push&branch=main&head_sha={self.REV}&per_page=100'
        jobs = f'repos/{self.AGENT}/actions/runs/50/jobs?filter=latest&per_page=100'
        good_jobs = base[jobs]['jobs']
        response_cases = {
            'no run': {runs: {'workflow_runs': []}},
            'newest run red': {runs: {'workflow_runs': [self.run_entry(), self.run_entry(id=51, conclusion='failure',
                                                                                      created_at='2026-11-22T06:00:00Z')]}},
            'in progress': {runs: {'workflow_runs': [self.run_entry(status='in_progress', conclusion=None)]}},
            'fork run': {runs: {'workflow_runs': [self.run_entry(head_repository={'full_name': 'someone/hermes-agent'})]}},
            'pull_request run': {runs: {'workflow_runs': [self.run_entry(event='pull_request')]}},
            'other branch': {runs: {'workflow_runs': [self.run_entry(head_branch='feature')]}},
            'other workflow': {runs: {'workflow_runs': [self.run_entry(path='.github/workflows/ci.yaml')]}},
            'different agent sha': {runs: {'workflow_runs': [self.run_entry(head_sha='d' * 40)]}},
            'aggregate red': {jobs: {'jobs': [dict(good_jobs[0], conclusion='failure')] + good_jobs[1:]}},
            'missing leg': {jobs: {'jobs': good_jobs[:-1]}},
            'failed leg': {jobs: {'jobs': good_jobs[:-1] + [dict(good_jobs[-1], conclusion='failure')]}},
            'skipped leg': {jobs: {'jobs': good_jobs[:-1] + [dict(good_jobs[-1], conclusion='skipped')]}},
            'duplicate leg': {jobs: {'jobs': good_jobs + [dict(good_jobs[-1], conclusion='failure')]}},
            'no record': {self.NOTES: []},
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
            'other run': {'run_id': 49},
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

    def test_merge_commit_must_change_only_pin_files_to_an_exact_revision(self):
        self.assertIsNone(self.find(tested=self.pin(self.base, extra='README.md'))[0])
        self.assertIsNone(self.find(tested=self.pin(self.base, revision='main'))[0])
        self.assertIsNone(self.find(tested=self.pin(self.base, revision='d' * 40))[0])  # no run for that sha
        self.assertIsNone(self.find(tested=self.base)[0])
        self.assertIsNone(self.find(base='', tested=self.tested)[0])

    def test_plan_skips_runtime_runs_units_and_gate_requires_tests(self):
        selected = self.module.select(['release/agent-image-manifest.json', 'plugins/disk-cleanup/UPSTREAM.json'],
                                      event='pull_request')
        self.assertTrue(selected['runtime'])
        plan = self.module.pin_reused_plan(selected, 'https://x/runs/50')
        self.assertFalse(plan['runtime'])
        self.assertEqual(plan['tests'], selected['tests'])
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


class AggregateTests(unittest.TestCase):
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
