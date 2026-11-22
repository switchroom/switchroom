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
    'scripts/run-runtime-leg.sh',
}
RUNTIME_INPUT_PREFIXES = ('tests/',)
# Defer-CI fast lane (PR only): a change made only of these Linear plugin files, existing test
# modules and prose runs units plus the real-Agent legs of the test files it touches before
# merge; main push CI runs the component's full legs, a red push is auto-reverted, and nothing
# delivers until main is green (scripts/auto-revert.py, plugin-pin-handoff.yml, fleet-image.yml).
# An explicit allowlist of existing files with no sender, permission, identity or credential
# logic. Every other plugin file (most of it is authority code) stays fully gated before merge;
# widening this list is itself a reviewed selector change.
FAST_LANE_FILES = frozenset('plugins/linear/' + name for name in (
    'acceptance.py', 'outcome.py', 'waits.py'))
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


# The real-Agent runtime matrix, as (lane, shard). CI's `runtime` job lists exactly these legs
# (tests/test_source_ci_scope.py holds the two equal) and the Agent repository's
# fleet-integration workflow reads them from `source-ci.py legs`, so both run the same proofs
# through scripts/run-runtime-leg.sh.
RUNTIME_LEGS = (
    ('input', '1/3'), ('input', '2/3'), ('input', '3/3'),
    ('kanban', '1/3'), ('kanban', '2/3'), ('kanban', '3/3'),
    ('origin', '1/3'), ('origin', '2/3'), ('origin', '3/3'),
    ('native', ''),
)
# A pin PR (release/pin-agent-<sha>) changes only these. Its runtime legs can be reused from the
# Agent repository's fleet-integration push run of the pinned revision; see find_pin_reuse.
PIN_MANIFEST = 'release/agent-image-manifest.json'
PIN_UPSTREAM = re.compile(r'^plugins/[^/]+/UPSTREAM\.json$')
AGENT_REPOSITORY = 'switchroom/hermes-agent'
FLEET_WORKFLOW = 'fleet-integration.yml'
FLEET_WORKFLOW_PATH = '.github/workflows/' + FLEET_WORKFLOW
FLEET_PASS_JOB = 'Fleet integration pass'
FLEET_ARTIFACT = 'fleet-integration-result'
FLEET_SCHEMA = 'fleet-integration/v1'


def leg_name(lane, shard):
    return f'{lane} {shard}' if shard else lane


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


def select(paths, full=False, reason='changed paths', event='push', added=()):
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
    deferred = [] if full else deferrable_lanes(paths, lanes, added)
    if event == 'pull_request' and deferred:
        lanes = {lane: lanes[lane] and lane not in deferred for lane in LANES}
        reason = 'fast lane: real-Agent legs ' + ', '.join(deferred) + ' run after merge on main push'
    return {'tests': sorted(tests), **lanes,
            'runtime': any(lanes[k] for k in LANES),
            'full': runtime_full, 'units_full': units_full, 'runtime_full': runtime_full,
            'deferred_on_pr': deferred, 'reason': reason}


def fast_lane_eligible(paths, added=()):
    """Only Linear plugin behaviour, existing test modules and prose may defer real-Agent legs.

    A test module or plugin file added (or renamed/deleted) by the change is not yet proven and
    stays gated, as does every plugin file outside FAST_LANE_FILES and everything else
    (image inputs, the agent pin, workflows, the selector, runners, helpers, other code).
    """
    available = set(inventory()) - set(added)
    def plugin(p):
        # Only an allowlisted file that already existed and still exists.
        return p in FAST_LANE_FILES and p not in added and (ROOT / p).is_file()
    def prose(p):
        return p.endswith('.md') and not is_runtime_input(p)
    return bool(paths) and any(plugin(p) for p in paths) and all(
        plugin(p) or p in available or prose(p) for p in paths)


def deferrable_lanes(paths, lanes, added=()):
    """Lanes a fast-lane PR skips: those selected only by the component, not by a touched test."""
    if not fast_lane_eligible(paths, added):
        return []
    touched = _lanes_for(p for p in paths if p in set(inventory()))
    return sorted(lane for lane in LANES if lanes[lane] and not touched[lane])


def changed_paths(repo, event, base, head, added=None):
    """None means uncertain. Renames and copies route by both paths, deletes by the old path.

    `added` (a set) collects paths that did not exist at base: additions and rename/copy targets.
    """
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
            if added is not None and status[:1] in ('A', 'R', 'C'):
                added.add(names[-1])
            paths.extend(names)
        return paths
    except (OSError, UnicodeError, subprocess.CalledProcessError):
        return None


def gate(plan, needs):
    if not isinstance(plan, dict) or type(plan.get('runtime')) is not bool:
        return False
    reused = plan.get('reused_from') is not None
    runtime_reused = plan.get('runtime_reused_from') is not None
    if (reused or runtime_reused) and plan['runtime']:
        return False
    if reused and runtime_reused:
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


def git_out(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True, stderr=subprocess.PIPE, timeout=60).strip()


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
        # Only this repository's branch for this PR: never a fork run, nor another PR that shares
        # the head commit against a different base.
        sharing = [p for p in api(f'repos/{repository}/commits/{head}/pulls') if (p.get('head') or {}).get('sha') == head]
        if [p.get('number') for p in sharing] != [pr['number']]:
            log(f'reuse: head {head} is not unique to PR #{pr["number"]}')
            return None
        branch = (pr.get('head') or {}).get('ref')
        runs = [r for r in api(f'repos/{repository}/actions/workflows/ci.yml/runs'
                               f'?event=pull_request&head_sha={head}&per_page=100')['workflow_runs']
                if r.get('head_sha') == head and r.get('path') == WORKFLOW_PATH
                and r.get('event') == 'pull_request' and branch and r.get('head_branch') == branch
                and (r.get('head_repository') or {}).get('full_name') == repository]
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


def is_pin_only(paths):
    """A pin change set: the Agent manifest plus, optionally, plugin UPSTREAM.json records."""
    return bool(paths) and PIN_MANIFEST in paths and all(
        p == PIN_MANIFEST or PIN_UPSTREAM.match(p) for p in paths)


def find_pin_reuse(repo, repository, base, tested, agent_repository=AGENT_REPOSITORY, api=gh_api,
                   git=git_out, log=lambda m: print(m, file=sys.stderr)):
    """URL of the Agent repository's green fleet-integration run that already proved this pin PR.

    `base` is the PR base commit and `tested` the merge commit CI checked out. Every one must hold:
    tested differs from base only in pin files; the newest fleet-integration run (that workflow
    file, push event, main branch of the Agent repository itself, newest attempt) for exactly the
    pinned revision completed green with its aggregate and every RUNTIME_LEGS leg job green; its
    one result record (a notice annotation on the aggregate's check run, mirroring the
    `fleet-integration-result` artifact) names that run, that revision, this repository, and every leg a success;
    and the switchroom commit it ran is in this history with the recorded tree, and that tree is
    the base tree, or an ancestor of base whose diff to base selects no real-Agent leg at all.
    Any doubt or API error answers None, which runs the full matrix.
    """
    sha_re = r'[0-9a-f]{40}'
    if not all(re.fullmatch(sha_re, v or '') and v != '0' * 40 for v in (base, tested)):
        log('pin reuse: no exact base/merge commits')
        return None
    try:
        tested_paths = [p for p in git(repo, 'diff', '--name-only', '-z', base, tested, '--').split('\0') if p]
        if not is_pin_only(tested_paths):
            log(f'pin reuse: merge commit changes more than pin files: {tested_paths}')
            return None
        revision = json.loads(git(repo, 'show', f'{tested}:{PIN_MANIFEST}'))['revision']
        if not (isinstance(revision, str) and re.fullmatch(sha_re, revision)):
            log('pin reuse: pinned revision is not an exact commit')
            return None
        runs = [r for r in api(f'repos/{agent_repository}/actions/workflows/{FLEET_WORKFLOW}/runs'
                               f'?event=push&branch=main&head_sha={revision}&per_page=100')['workflow_runs']
                if r.get('head_sha') == revision and r.get('path') == FLEET_WORKFLOW_PATH
                and r.get('event') == 'push' and r.get('head_branch') == 'main'
                and (r.get('head_repository') or {}).get('full_name') == agent_repository
                and (r.get('repository') or {}).get('full_name') == agent_repository]
        if not runs:
            log(f'pin reuse: no fleet-integration push run for Agent {revision}')
            return None
        run = max(runs, key=lambda r: (str(r.get('created_at', '')), int(r.get('id', 0))))
        url = run.get('html_url') or ''
        if run.get('status') != 'completed' or run.get('conclusion') != 'success':
            log(f'pin reuse: newest fleet-integration run {url} is {run.get("status")}/{run.get("conclusion")}')
            return None
        run_id = int(run['id'])
        jobs = api(f'repos/{agent_repository}/actions/runs/{run_id}/jobs?filter=latest&per_page=100')['jobs']
        want = [FLEET_PASS_JOB] + [f'fleet leg ({leg_name(*leg)})' for leg in RUNTIME_LEGS]
        for name in want:
            found = [j for j in jobs if j.get('name') == name]
            if len(found) != 1 or found[0].get('conclusion') != 'success':
                log(f'pin reuse: job {name!r} of {url} is not a single success')
                return None
        # The pass job also publishes its result record as one notice annotation on its own check
        # run. Annotations of a public repository read with any token; another repository's
        # artifact downloads do not accept this repository's workflow token.
        passing = [j for j in jobs if j.get('name') == FLEET_PASS_JOB][0]
        notes = [n for n in api(f'repos/{agent_repository}/check-runs/{int(passing["id"])}/annotations?per_page=100')
                 if n.get('title') == FLEET_ARTIFACT]
        if len(notes) != 1 or notes[0].get('annotation_level') != 'notice' or len(str(notes[0].get('message', ''))) > 65536:
            log(f'pin reuse: {url} has no single result record')
            return None
        result = json.loads(notes[0]['message'])
        if not isinstance(result, dict):
            raise ValueError('fleet result is not an object')
        legs = {leg_name(*leg): 'success' for leg in RUNTIME_LEGS}
        expected = {'schema': FLEET_SCHEMA, 'result': 'success', 'event': 'push', 'ref': 'refs/heads/main',
                    'agent_repository': agent_repository, 'agent_commit': revision, 'run_id': run_id,
                    'workflow': FLEET_WORKFLOW_PATH, 'switchroom_repository': repository, 'legs': legs}
        wrong = sorted(k for k, v in expected.items() if result.get(k) != v)
        if wrong:
            log(f'pin reuse: result artifact of {url} disagrees on {wrong}')
            return None
        commit, tree = result.get('switchroom_commit'), result.get('switchroom_tree')
        if not all(isinstance(v, str) and re.fullmatch(sha_re, v) for v in (commit, tree)):
            log(f'pin reuse: result artifact of {url} has no exact switchroom commit and tree')
            return None
        if git(repo, 'rev-parse', '--verify', '--quiet', f'{commit}^{{tree}}') != tree:
            log(f'pin reuse: switchroom {commit} is unknown here or its tree is not {tree}')
            return None
        if git(repo, 'rev-parse', f'{base}^{{tree}}') != tree:
            # Main moved since the Agent run. Still proven only if that switchroom commit is an
            # ancestor of base and nothing since then is a real-Agent input by the same rules
            # that scope PR runtime legs (the pin PR still runs every unit module).
            if subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', commit, base],
                              capture_output=True, timeout=60).returncode != 0:
                log(f'pin reuse: switchroom {commit} of {url} is not an ancestor of base {base}')
                return None
            since = changed_paths(repo, 'push', commit, base)
            moved = select(since or [], full=since is None, event='push')
            if since is None or moved['runtime'] or moved['runtime_full']:
                log(f'pin reuse: switchroom changed real-Agent inputs since {commit}: {since}')
                return None
            log(f'pin reuse: switchroom moved since {commit} only in non-runtime paths {since}')
        log(f'pin reuse: Agent {revision} with switchroom tree {tree} already proved by {url}')
        return url or str(run_id)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError,
            subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        log(f'pin reuse: lookup failed ({type(exc).__name__}); running the full matrix')
        return None


def pin_reused_plan(plan, url):
    """Units as selected; every real-Agent leg reused from the Agent repository's run."""
    return {**plan, **{lane: False for lane in LANES}, 'runtime': False, 'deferred_on_pr': [],
            'full': False, 'runtime_full': False, 'runtime_reused_from': url,
            'reason': 'pin: real-Agent legs reused from fleet integration ' + url + '; units run'}


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
    choose.add_argument('--added', nargs='*', default=[], help='with --files: which of them are new files')
    choose.add_argument('--event', default='push')
    choose.add_argument('--base', default='')
    choose.add_argument('--head', default='')
    choose.add_argument('--repo', type=Path, default=ROOT)
    choose.add_argument('--github-output', type=Path)
    choose.add_argument('--reuse-repository', default='',
                        help='owner/repo: on push, look up a green PR run of the identical tree; on a '
                             'pin-only PR, the Agent fleet-integration run of the pinned revision')
    choose.add_argument('--tested', default='', help='pull_request: the merge commit CI checked out')
    choose.add_argument('--agent-repository', default=AGENT_REPOSITORY)
    sub.add_parser('legs', help='the runtime matrix as JSON, for the Agent fleet-integration workflow')
    for command in ('gate', 'units'):
        runner = sub.add_parser(command)
        runner.add_argument('--plan', required=True)
        if command == 'gate':
            runner.add_argument('--needs', required=True)
    args = parser.parse_args()
    if args.command == 'select':
        added = set(args.added)
        paths = args.files if args.files is not None else changed_paths(args.repo, args.event, args.base, args.head, added)
        plan = select(paths or [], full=paths is None or args.event not in ('push', 'pull_request'),
                      event=args.event, added=added)
        # A fast-lane PR deferred legs to this push, so its run cannot stand in for it.
        if (args.event == 'push' and args.reuse_repository and args.files is None
                and not plan['deferred_on_pr']):
            reuse = find_reuse(args.reuse_repository, args.head, args.base)
            if reuse is not None:
                plan = reused_plan(reuse)
        if (args.event == 'pull_request' and args.reuse_repository and args.files is None
                and is_pin_only(paths or [])):
            reuse = find_pin_reuse(args.repo, args.reuse_repository, args.base, args.tested,
                                   args.agent_repository)
            if reuse is not None:
                plan = pin_reused_plan(plan, reuse)
        encoded = json.dumps(plan, separators=(',', ':'))
        print(encoded)
        if args.github_output:
            with args.github_output.open('a') as stream:
                stream.write('plan=' + encoded + '\n')
                for key in (*LANES, 'runtime'):
                    stream.write(f'{key}={str(plan[key]).lower()}\n')
                stream.write(f"reused={str(plan.get('reused_from') is not None).lower()}\n")
                stream.write(f"runtime_reused={str(plan.get('runtime_reused_from') is not None).lower()}\n")
        return 0
    if args.command == 'legs':
        print(json.dumps([{'lane': lane, 'shard': shard, 'name': leg_name(lane, shard)}
                          for lane, shard in RUNTIME_LEGS], separators=(',', ':')))
        return 0
    plan = json.loads(args.plan)
    if args.command == 'units':
        return run_units(plan)
    passed = gate(plan, json.loads(args.needs))
    print('Source CI aggregate: ' + ('PASS' if passed else 'FAIL'))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
