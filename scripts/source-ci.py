#!/usr/bin/env python3
"""Small, conservative source-CI selector and fail-closed required aggregate.

PRs compare merge-base; pushes compare the exact before/after trees. Unknown
inputs and ambiguous history run everything. Image selection is independent.
"""
import argparse
import fnmatch
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
LANES = ('linear', 'acp', 'origin', 'input', 'journey', 'candidate')
PUBLIC = ('test_public_*.py', 'test_image_scope_and_scans.py')
COMPONENTS = {
    'linear': ('test_linear_*.py', 'test_ci_linear_scenarios.py'),
    'claude': ('test_claude_*.py',),
    'sidecars': ('test_sidecar_packages.py', 'test_browser_*.py',
                 'test_chromium_sandbox_*.py'),
    'perplexity': ('test_perplexity_provider.py',),
    'tooling': ('test_tooling_policy_hook.py',),
}
PREFIXES = {
    'plugins/linear/': 'linear',
    'plugins/model-providers/claude-acp/': 'claude',
    'plugins/claude-account-connectors/': 'claude',
    'plugins/web/perplexity/': 'perplexity',
    # Before 'sidecars/': the receiver's tests are test_linear_receiver.py.
    'sidecars/linear-receiver/': 'linear',
    'sidecars/': 'sidecars',
    'tests/linear_': 'linear',
    'tests/fixtures/claude_': 'claude',
}
EXACT = {'scripts/claude-acp-subscription': 'claude',
         'scripts/tooling-policy-hook': 'tooling',
         'scripts/sidecar_image_ref.py': 'sidecars'}
SELECTOR_INPUTS = {'scripts/source-ci.py', 'tests/test_source_ci_scope.py'}
# A PR that only moves the Agent pin (the release bot's "release: pin Agent" PRs) is
# already proven upstream: the Agent commit passed its own CI before it was published.
# Its PR runs only the pin/provenance contract tests; the full suite and the real-Agent
# runtime lanes run once, on the main push, and that exact-SHA run gates publication
# (fleet-image.yml "Verify exact main CI gate"). Pushes are never narrowed this way.
PIN_FILES = {'release/agent-image-manifest.json'}
PIN_PATTERNS = ('plugins/*/UPSTREAM.json',)
PIN_TESTS = (
    'tests/test_camoufox_runtime.py', 'tests/test_disk_cleanup_plugin.py',
    'tests/test_image_release.py', 'tests/test_image_scope_and_scans.py',
    'tests/test_public_product.py', 'tests/test_source_ci_scope.py',
)
# These test modules also supply fixtures to other modules. Broaden to their
# component rather than maintaining a second, fragile per-test import graph.
SHARED_TESTS = {
    'test_linear_chat_entrust_scenarios.py', 'test_linear_content_actions.py',
    'test_linear_delegate_routing_scenarios.py',
    'test_linear_event_data_scenarios.py',
    'test_linear_existing_work_scenarios.py', 'test_linear_isolation_scenarios.py',
    'test_linear_namespace_dispositions.py', 'test_linear_native_bridge_scenarios.py',
    'test_linear_native_input_seam.py', 'test_linear_native_delivery_seam.py',
    'test_linear_native_prompt_scenarios.py',
    'test_linear_native_frontdoor_scenarios.py', 'test_linear_origin_native.py',
    'test_linear_origin_provider_native.py', 'test_linear_plugin.py',
    'test_linear_scope_effect_scenarios.py', 'test_linear_specialist_authorization.py',
    'test_linear_status_follows_work_scenarios.py',
    'test_claude_acp_connector_hydration.py',
}


def inventory():
    return sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests').glob('test_*.py'))


def is_pin_only(paths):
    return bool(paths) and all(
        p in PIN_FILES or any(fnmatch.fnmatch(p, pat) for pat in PIN_PATTERNS) for p in paths)


def select(paths, full=False, reason='changed paths', event='push'):
    available = inventory()
    if not full and event == 'pull_request' and is_pin_only(paths):
        lanes = {lane: False for lane in LANES}
        return {'tests': sorted(t for t in PIN_TESTS if t in available), **lanes, 'runtime': False,
                'full': False, 'reason': 'pin-only PR: full suite runs on the main push that gates publication'}
    tests = set()
    lanes = {lane: False for lane in LANES}
    for path in paths:
        if path in SELECTOR_INPUTS or path.startswith('.github/'):
            full = True
        elif path == 'tests/candidate_hf578.py':
            lanes['candidate'] = True
        elif path in available:
            tests.add(path)
            if Path(path).name in SHARED_TESTS:
                group = 'linear' if Path(path).name.startswith('test_linear_') else 'claude'
                tests.update(p for p in available if any(fnmatch.fnmatch(Path(p).name, pat) for pat in COMPONENTS[group]))
        elif path.endswith('.md'):
            continue
        else:
            component = EXACT.get(path)
            for prefix, name in PREFIXES.items():
                if path.startswith(prefix):
                    component = name
                    break
            if component is None:
                full = True
            else:
                patterns = COMPONENTS[component] + PUBLIC
                tests.update(p for p in available if any(fnmatch.fnmatch(Path(p).name, pat) for pat in patterns))
    if full:
        tests = set(available)
        lanes = {lane: True for lane in LANES}
        reason = 'full: requested or uncertain input'
    else:
        for path in tests:
            name = Path(path).name
            if fnmatch.fnmatch(name, 'test_linear_*scenarios.py'):
                lanes['linear'] = lanes['candidate'] = True
            if fnmatch.fnmatch(name, 'test_linear_origin*_native.py'):
                lanes['origin'] = True
            if name == 'test_claude_acp_context.py':
                lanes['acp'] = True
            if fnmatch.fnmatch(name, 'test_linear_native_*seam.py'):
                lanes['input'] = True
            if name in {'test_linear_native_work_journey.py', 'test_linear_worker_questions.py'}:
                lanes['journey'] = True
    return {'tests': sorted(tests), **lanes,
            'runtime': any(lanes[k] for k in ('linear', 'acp', 'origin', 'input', 'journey')),
            'full': full, 'reason': reason}


def changed_paths(repo, event, base, head):
    """None means uncertain: preserve status and refuse rename/delete narrowing."""
    if event not in ('push', 'pull_request'):
        return None
    if not all(re.fullmatch(r'[0-9a-f]{40}', value or '') and value != '0' * 40 for value in (base, head)):
        return None
    args = [base + '...' + head] if event == 'pull_request' else [base, head]
    try:
        raw = subprocess.check_output(['git', '-C', str(repo), 'diff', '--name-status',
                                       '-z', '--find-renames', *args, '--'], stderr=subprocess.PIPE)
        fields = raw.decode('utf-8').split('\0')
        if fields.pop() != '' or len(fields) % 2:
            return None
        paths = []
        for status, path in zip(fields[::2], fields[1::2]):
            if status not in ('A', 'M') or not path:
                return None
            paths.append(path)
        return paths
    except (OSError, UnicodeError, subprocess.CalledProcessError):
        return None


def gate(plan, needs):
    if not isinstance(plan, dict) or any(type(plan.get(k)) is not bool for k in ('runtime', 'candidate')):
        return False
    required = {'selection': True, 'source-tests': True,
                'runtime': plan['runtime'], 'candidate-hf578': plan['candidate']}
    if set(needs) != set(required):
        return False
    for job, selected in required.items():
        state = needs[job].get('result')
        if state != ('success' if selected else 'skipped'):
            return False
    return True


def run_units(plan):
    # Match `python -m unittest` import semantics for tests.* shared fixtures.
    sys.path.insert(0, str(ROOT))
    paths = plan['tests']
    if not isinstance(paths, list) or len(paths) != len(set(paths)) or any(p not in inventory() for p in paths):
        raise ValueError('invalid selected test inventory')
    if not paths:
        print('No source unit modules applicable; global policy checks still run.')
        return 0
    suite = unittest.TestSuite()
    for path in paths:
        print('Selected unit module: ' + path, flush=True)
        suite.addTests(unittest.defaultTestLoader.discover(str(ROOT / 'tests'), pattern=Path(path).name))
    if not suite.countTestCases():
        raise ValueError('selected inventory collected zero tests')
    # Real-Agent proofs run separately with their existing non-skipping runners.
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    choose = sub.add_parser('select')
    choose.add_argument('--files', nargs='*', default=None, help='explicit paths for local routing proof')
    choose.add_argument('--event', default='push')
    choose.add_argument('--base', default='')
    choose.add_argument('--head', default='')
    choose.add_argument('--repo', type=Path, default=ROOT)
    choose.add_argument('--github-output', type=Path)
    for command in ('gate', 'units'):
        runner = sub.add_parser(command)
        runner.add_argument('--plan', required=True)
        if command == 'gate':
            runner.add_argument('--needs', required=True)
    args = parser.parse_args()
    if args.command == 'select':
        paths = args.files if args.files is not None else changed_paths(args.repo, args.event, args.base, args.head)
        plan = select(paths or [], full=paths is None or args.event not in ('push', 'pull_request'),
                      event=args.event)
        encoded = json.dumps(plan, separators=(',', ':'))
        print(encoded)
        if args.github_output:
            with args.github_output.open('a') as stream:
                stream.write('plan=' + encoded + '\n')
                for key in (*LANES, 'runtime'):
                    stream.write(f'{key}={str(plan[key]).lower()}\n')
        return 0
    plan = json.loads(args.plan)
    if args.command == 'units':
        return run_units(plan)
    passed = gate(plan, json.loads(args.needs))
    print('Source CI aggregate: ' + ('PASS' if passed else 'FAIL'))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
