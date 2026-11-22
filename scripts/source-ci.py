#!/usr/bin/env python3
"""Small, conservative source-CI selector and fail-closed required aggregate.

PRs compare merge-base; pushes compare the exact before/after trees. Unknown
inputs run every unit module; runtime inputs and ambiguous history run
everything. Image selection is independent.
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
LANES = ('linear', 'acp', 'origin', 'input', 'journey')
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
# Unmapped paths the real-Agent legs read: the pinned Core, its environments, the runners and
# any shared test helper or fixture. Only these (or an unknown change set) widen runtime.
RUNTIME_INPUTS = {
    'release/agent-image-manifest.json', 'release/linear-scenario-requirements.txt',
    'tests/native-input-requirements.txt', 'scripts/read-agent-image-manifest.py',
    'scripts/run-linear-scenarios.py', 'scripts/run-linear-input-scenarios.py',
    'scripts/run-linear-origin-scenarios.py', 'scripts/check-linear-origin-guard.py',
}
RUNTIME_INPUT_PREFIXES = ('tests/',)
# Defer-CI fast lane (PR only): a change made only of these, existing test modules and prose
# runs units plus the real-Agent legs of the test files it touches before merge; main push CI
# runs the component's full legs, a red push is auto-reverted, and nothing delivers until
# main is green (scripts/auto-revert.py, plugin-pin-handoff.yml, fleet-image.yml).
FAST_LANE_PREFIXES = ('plugins/linear/',)
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


def _lanes_for(tests):
    lanes = {lane: False for lane in LANES}
    for path in tests:
        name = Path(path).name
        if fnmatch.fnmatch(name, 'test_linear_*scenarios.py'):
            lanes['linear'] = True
        if fnmatch.fnmatch(name, 'test_linear_origin*_native.py'):
            lanes['origin'] = True
        if name == 'test_claude_acp_context.py':
            lanes['acp'] = True
        if fnmatch.fnmatch(name, 'test_linear_native_*seam.py'):
            lanes['input'] = True
        if name in {'test_linear_native_work_journey.py', 'test_linear_worker_questions.py'}:
            lanes['journey'] = True
    return lanes


def is_runtime_input(path):
    """Positive allowlist of inputs the real-Agent legs consume outside a mapped component."""
    return path in RUNTIME_INPUTS or path.startswith(RUNTIME_INPUT_PREFIXES)


def select(paths, full=False, reason='changed paths', event='push'):
    """`units_full` runs every unit module; `runtime_full` also runs every real-Agent leg.

    An unmapped path broadens units only. Runtime broadens only for a listed runtime input,
    a selector or workflow input, or an unknown change set (`full`).
    """
    available = inventory()
    tests = set()
    units_full = runtime_full = full
    for path in paths:
        if path in SELECTOR_INPUTS or path.startswith('.github/'):
            units_full = runtime_full = True
        elif path in available:
            tests.add(path)
            if Path(path).name in SHARED_TESTS:
                group = 'linear' if Path(path).name.startswith('test_linear_') else 'claude'
                tests.update(p for p in available if any(fnmatch.fnmatch(Path(p).name, pat) for pat in COMPONENTS[group]))
        elif path.endswith('.md') and not is_runtime_input(path):
            continue
        else:
            component = EXACT.get(path)
            for prefix, name in PREFIXES.items():
                if path.startswith(prefix):
                    component = name
                    break
            if component is not None:
                patterns = COMPONENTS[component] + PUBLIC
                tests.update(p for p in available if any(fnmatch.fnmatch(Path(p).name, pat) for pat in patterns))
            elif is_runtime_input(path):
                units_full = runtime_full = True
            else:
                units_full = True
    lanes = {lane: True for lane in LANES} if runtime_full else _lanes_for(tests)
    if units_full:
        tests = set(available)
    if runtime_full:
        reason = 'full: requested, uncertain or runtime input'
    elif units_full:
        reason = 'units_full: unmapped non-runtime input; real-Agent legs scoped'
    deferred = [] if full else deferrable_lanes(paths, lanes)
    if event == 'pull_request' and deferred:
        lanes = {lane: lanes[lane] and lane not in deferred for lane in LANES}
        reason = 'fast lane: real-Agent legs ' + ', '.join(deferred) + ' run after merge on main push'
    return {'tests': sorted(tests), **lanes,
            'runtime': any(lanes[k] for k in LANES),
            'full': runtime_full, 'units_full': units_full, 'runtime_full': runtime_full,
            'deferred_on_pr': deferred, 'reason': reason}


def fast_lane_eligible(paths):
    """Only Linear plugin source, existing test modules and prose may defer real-Agent legs.

    Everything else (image inputs, the agent pin, workflows, the selector, runners, helpers,
    other code) stays fully gated before merge.
    """
    available = set(inventory())
    return bool(paths) and any(p.startswith(FAST_LANE_PREFIXES) for p in paths) and all(
        p.startswith(FAST_LANE_PREFIXES) or p in available or p.endswith('.md') for p in paths)


def deferrable_lanes(paths, lanes):
    """Lanes a fast-lane PR skips: those selected only by the component, not by a touched test."""
    if not fast_lane_eligible(paths):
        return []
    touched = _lanes_for(p for p in paths if p in set(inventory()))
    return sorted(lane for lane in LANES if lanes[lane] and not touched[lane])


def changed_paths(repo, event, base, head):
    """None means uncertain. Renames and copies route by both paths, deletes by the old path."""
    if event not in ('push', 'pull_request'):
        return None
    if not all(re.fullmatch(r'[0-9a-f]{40}', value or '') and value != '0' * 40 for value in (base, head)):
        return None
    args = [base + '...' + head] if event == 'pull_request' else [base, head]
    try:
        raw = subprocess.check_output(['git', '-C', str(repo), 'diff', '--name-status',
                                       '-z', '--find-renames', *args, '--'], stderr=subprocess.PIPE)
        fields = raw.decode('utf-8').split('\0')
        if fields.pop() != '':
            return None
        paths = []
        while fields:
            status = fields.pop(0)
            width = 2 if status[:1] in ('R', 'C') else 1
            if status[:1] not in ('A', 'M', 'D', 'T', 'R', 'C') or len(fields) < width:
                return None
            names = [fields.pop(0) for _ in range(width)]
            if not all(names):
                return None
            paths.extend(names)
        return paths
    except (OSError, UnicodeError, subprocess.CalledProcessError):
        return None


def gate(plan, needs):
    if not isinstance(plan, dict) or type(plan.get('runtime')) is not bool:
        return False
    reused = plan.get('reused_from') is not None
    if reused and plan['runtime']:
        return False
    required = {'selection': True, 'source-tests': not reused, 'runtime': plan['runtime']}
    if set(needs) != set(required):
        return False
    for job, selected in required.items():
        state = needs[job].get('result')
        if state != ('success' if selected else 'skipped'):
            return False
    return True


WORKFLOW_PATH = '.github/workflows/ci.yml'


def gh_api(path):
    return json.loads(subprocess.check_output(['gh', 'api', path], text=True, stderr=subprocess.PIPE, timeout=30))


def find_reuse(repository, sha, before, api=gh_api, log=lambda m: print(m, file=sys.stderr)):
    """URL of a green PR CI run that already proved this push's exact tree, else None.

    All three must hold: tree(sha) == tree(pr.head); `before` is an ancestor of (or equal
    to) pr.head, so the PR was current with main; and the newest CI pull_request run for
    pr.head concluded success with its `source-checks` aggregate green. Any doubt or API
    error answers None, which runs the normal selection.
    """
    sha_re = r'[0-9a-f]{40}'
    if not all(re.fullmatch(sha_re, v or '') and v != '0' * 40 for v in (sha, before)):
        log('reuse: no exact before/after range')
        return None
    try:
        merged = [pr for pr in api(f'repos/{repository}/commits/{sha}/pulls')
                  if pr.get('merged_at') and pr.get('merge_commit_sha') == sha
                  and (pr.get('base') or {}).get('ref') == 'main']
        if len(merged) != 1:
            log(f'reuse: {len(merged)} merged PRs for {sha}')
            return None
        pr = merged[0]
        head = (pr.get('head') or {}).get('sha') or ''
        if not re.fullmatch(sha_re, head):
            return None
        trees = [api(f'repos/{repository}/git/commits/{c}')['tree']['sha'] for c in (sha, head)]
        if trees[0] != trees[1]:
            log(f'reuse: tree of {sha} differs from PR #{pr["number"]} head {head}')
            return None
        status = api(f'repos/{repository}/compare/{before}...{head}').get('status')
        if status not in ('ahead', 'identical'):
            log(f'reuse: {before} is not an ancestor of PR head {head} ({status})')
            return None
        runs = [r for r in api(f'repos/{repository}/actions/workflows/ci.yml/runs'
                               f'?event=pull_request&head_sha={head}&per_page=100')['workflow_runs']
                if r.get('head_sha') == head and r.get('path') == WORKFLOW_PATH
                and r.get('event') == 'pull_request']
        if not runs:
            log(f'reuse: no PR CI run for {head}')
            return None
        run = max(runs, key=lambda r: (str(r.get('created_at', '')), int(r.get('id', 0))))
        if run.get('status') != 'completed' or run.get('conclusion') != 'success':
            log(f'reuse: newest PR CI run {run.get("html_url")} is {run.get("status")}/{run.get("conclusion")}')
            return None
        # The run must have tested this PR against main, not a stacked parent branch the PR was
        # later retargeted from (GitHub clears run.pull_requests once a PR merges, so read the
        # PR's own retarget events). Any retarget at or after the run's creation: no reuse.
        events = api(f'repos/{repository}/issues/{int(pr["number"])}/events?per_page=100')
        if not isinstance(events, list) or len(events) >= 100:
            log(f'reuse: cannot read every event of PR #{pr["number"]}')
            return None
        retargets = [str(e.get('created_at', '')) for e in events if e.get('event') == 'base_ref_changed']
        if any(when >= str(run.get('created_at', '')) for when in retargets):
            log(f'reuse: PR #{pr["number"]} was retargeted after {run.get("html_url")} started')
            return None
        jobs = api(f'repos/{repository}/actions/runs/{int(run["id"])}/jobs?filter=latest&per_page=100')['jobs']
        aggregate = [j for j in jobs if j.get('name') == 'source-checks']
        if len(aggregate) != 1 or aggregate[0].get('conclusion') != 'success':
            log(f'reuse: source-checks of {run.get("html_url")} is not a single success')
            return None
        log(f'reuse: tree {trees[0]} already proved by PR #{pr["number"]} run {run.get("html_url")}')
        return run.get('html_url') or str(run['id'])
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as exc:
        log(f'reuse: lookup failed ({type(exc).__name__}); running the normal selection')
        return None


def reused_plan(url):
    return {'tests': [], **{lane: False for lane in LANES}, 'runtime': False, 'full': False,
            'units_full': False, 'runtime_full': False, 'deferred_on_pr': [], 'reused_from': url,
            'reason': 'reused: identical tree already green in ' + url}


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
    choose.add_argument('--reuse-repository', default='',
                        help='push only: owner/repo to look up a green PR run of the identical tree')
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
        # A fast-lane PR deferred legs to this push, so its run cannot stand in for it.
        if (args.event == 'push' and args.reuse_repository and args.files is None
                and not plan['deferred_on_pr']):
            reuse = find_reuse(args.reuse_repository, args.head, args.base)
            if reuse is not None:
                plan = reused_plan(reuse)
        encoded = json.dumps(plan, separators=(',', ':'))
        print(encoded)
        if args.github_output:
            with args.github_output.open('a') as stream:
                stream.write('plan=' + encoded + '\n')
                for key in (*LANES, 'runtime'):
                    stream.write(f'{key}={str(plan[key]).lower()}\n')
                stream.write(f"reused={str(plan.get('reused_from') is not None).lower()}\n")
        return 0
    plan = json.loads(args.plan)
    if args.command == 'units':
        return run_units(plan)
    passed = gate(plan, json.loads(args.needs))
    print('Source CI aggregate: ' + ('PASS' if passed else 'FAIL'))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
