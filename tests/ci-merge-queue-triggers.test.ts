/**
 * Guard: the merge queue's required checks must actually run, must not
 * be cancellable, and must not publish.
 *
 * Ruleset 16470166 turned on a GitHub merge queue for `main`. A queue
 * pushes a temporary `gh-readonly-queue/main/pr-<n>-<sha>` ref and waits
 * for its seven required contexts to report ON THAT REF via the
 * `merge_group` event. On 2026-07-26 not one of the 14 workflows carried
 * a `merge_group:` trigger, so nothing ever ran there, no context was
 * ever produced, and every enqueued PR sat in `AWAITING_CHECKS` until
 * `check_response_timeout_minutes: 60` ejected it. Nothing could merge.
 *
 * The queue was switched back OFF the same day to unblock `main`, the
 * `merge_group:` triggers were added, and it was RE-ENABLED: as of
 * 2026-07-27 the ruleset carries a live `merge_queue` rule and PRs #3717
 * and #3718 merged through it with all seven contexts reporting on the
 * queue ref. These assertions are therefore a description of LIVE
 * behaviour, not a precondition — breaking one wedges `main` for everyone
 * immediately, rather than merely making it unsafe to re-enable the queue.
 * Do not delete them because "we don't use a merge queue": that is exactly
 * the state in which the next person turns it on and wedges `main` again.
 *
 * Why this test has to exist: EVERY invariant below is invisible on a
 * pull request. A PR run exercises the `pull_request` paths only; the
 * `merge_group` paths are exercised for the first time when the PR is
 * enqueued — i.e. after review, when getting it wrong wedges the queue
 * for everyone. Same reasoning as
 * tests/docker/manifest-jobs-no-buildx.test.ts, which guards the
 * push-only paths of docker-images.yml.
 *
 * See .github/MERGE-QUEUE.md for the full rationale.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const REPO = resolve(import.meta.dirname, '..')

/**
 * workflow file -> the required status-check context it produces.
 * Mirrors ruleset 16470166's `required_status_checks`. If a context is
 * added to or removed from the ruleset, this map must follow.
 */
const REQUIRED_CONTEXTS: Record<string, string> = {
  'ci-lint.yml': 'lint',
  'ci-tests-core.yml': 'vitest',
  'ci-tests-plugin.yml': 'bun-test',
  'ci-tests-python.yml': 'python-ok',
  'ci-uat.yml': 'uat-gate',
  'docker-e2e.yml': 'e2e-ok',
  'docker-images.yml': 'images-ok',
}

const WORKFLOWS = Object.keys(REQUIRED_CONTEXTS)

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: unknown
  with?: Record<string, unknown>
}
interface Job {
  if?: unknown
  needs?: string | string[]
  steps?: Step[]
  strategy?: unknown
}
interface Workflow {
  on?: Record<string, unknown>
  concurrency?: { group?: string; 'cancel-in-progress'?: unknown }
  jobs?: Record<string, Job>
}

function load(file: string): Workflow {
  return parse(readFileSync(join(REPO, '.github/workflows', file), 'utf8')) as Workflow
}

function jobsOf(wf: Workflow): Array<[string, Job]> {
  return Object.entries(wf.jobs ?? {})
}

function stepsOf(job: Job): Step[] {
  return Array.isArray(job.steps) ? job.steps : []
}

/** Everything a step can carry, flattened, so we can scan for expressions. */
function textOf(value: unknown): string {
  return value === undefined || value === null ? '' : JSON.stringify(value)
}

/**
 * True when an `if:` expression provably cannot be satisfied on a
 * `merge_group` event. Only two unambiguous shapes are recognised —
 * anything else is treated as REACHABLE, so the guard fails closed:
 *
 *   1. the expression mentions `merge_group` at all — the author
 *      considered the event explicitly (in this repo always as
 *      `github.event_name != 'merge_group'`);
 *   2. the expression is a positive event allowlist: it contains at
 *      least one `github.event_name == '<x>'` term, contains no
 *      `github.event_name !=` term, and no term names merge_group.
 *      Reachable events are then a subset of the allowlist.
 */
function excludesMergeGroup(gate: unknown): boolean {
  const expr = String(gate ?? '')
  if (expr === '') return false
  if (expr.includes('merge_group')) return true
  const allowlisted = [...expr.matchAll(/github\.event_name\s*==\s*'([^']+)'/g)]
  if (allowlisted.length === 0) return false
  if (/github\.event_name\s*!=/.test(expr)) return false
  return true
}

describe('merge queue — required checks run on the gh-readonly-queue ref', () => {
  it('the guarded set matches the workflows that own a required context', () => {
    // Sanity floor: if a workflow is renamed, every it.each below would
    // silently guard nothing. Pin the job names too, so a sentinel rename
    // that detaches the context from the ruleset is loud here.
    for (const [file, context] of Object.entries(REQUIRED_CONTEXTS)) {
      const jobs = load(file).jobs ?? {}
      expect(
        Object.keys(jobs),
        `${file} must still define the job named '${context}' — that job name IS the ` +
          `required status-check context in ruleset 16470166.`,
      ).toContain(context)
    }
  })

  it.each(WORKFLOWS)('%s has a merge_group trigger', (file) => {
    const on = load(file).on ?? {}
    expect(
      Object.keys(on),
      `${file} produces the required context '${REQUIRED_CONTEXTS[file]}', but has no ` +
        `merge_group trigger. GitHub will never run it on the queue's ` +
        `gh-readonly-queue/main/... ref, the context is never reported, and every ` +
        `enqueued PR is ejected after check_response_timeout_minutes (60). ` +
        `This is the exact 2026-07-26 outage.`,
    ).toContain('merge_group')
  })

  it.each(WORKFLOWS)('%s — the required job always reports (if: always())', (file) => {
    const context = REQUIRED_CONTEXTS[file]
    const job = (load(file).jobs ?? {})[context]
    expect(
      String(job?.if ?? ''),
      `${file}: job '${context}' is a REQUIRED context, so it must run unconditionally ` +
        `(if: always()). A skipped required check is not success — it blocks the queue.`,
    ).toContain('always()')
  })

  it.each(WORKFLOWS)('%s — a merge_group run can never be cancelled', (file) => {
    const wf = load(file)
    const cip = wf.concurrency?.['cancel-in-progress']
    // Literal false is fine (nothing is ever cancelled). Anything else
    // must be an expression that excludes merge_group.
    if (cip === false) return
    expect(
      String(cip ?? ''),
      `${file}: cancel-in-progress must exclude merge_group. Cancelling a queue check ` +
        `reports a non-success required context (the entry is ejected), and cancelling ` +
        `an 'if: always()' sentinel is the #3614 orphan-wedge shape — the sentinel can ` +
        `survive stuck in 'queued', pinning the concurrency group for the whole 60-min ` +
        `window with no self-service recovery.`,
    ).toContain('merge_group')
  })

  it.each(WORKFLOWS)('%s — concurrency is keyed so the queue ref cannot collide', (file) => {
    const group = String(load(file).concurrency?.group ?? '')
    // github.ref on merge_group is refs/heads/gh-readonly-queue/... —
    // distinct from the PR's refs/pull/<n>/merge and from refs/heads/main.
    // Keying on head_ref / the PR number instead would collide.
    expect(group, `${file}: concurrency.group must exist`).not.toBe('')
    expect(
      group,
      `${file}: concurrency.group must key on github.ref. github.head_ref is EMPTY on ` +
        `merge_group (every queue run would share one group and cancel its siblings), ` +
        `and a PR-number key would put the queue run in the PR's group.`,
    ).toContain('github.ref')
    expect(
      group,
      `${file}: concurrency.group must not key on github.head_ref — empty on merge_group.`,
    ).not.toContain('github.head_ref')
  })

  it.each(WORKFLOWS)('%s — the path filter is skipped on merge_group', (file) => {
    // A queue ref has no diff base. dorny/paths-filter must not run
    // there: if it FAILED, every sentinel hard-fails on
    // `changes=failure` by design and the queue is blocked — the exact
    // outage this change fixes, reintroduced one layer down.
    const offenders: string[] = []
    for (const [name, job] of jobsOf(load(file))) {
      // Unreachable either way: the step is if:-skipped, or the whole
      // job is (docker-images.yml gates `changes` at job level).
      if (excludesMergeGroup(job.if)) continue
      for (const step of stepsOf(job)) {
        if (!(step.uses ?? '').includes('dorny/paths-filter')) continue
        if (!excludesMergeGroup(step.if)) offenders.push(`${name}`)
      }
    }
    expect(
      offenders,
      `${file}: paths-filter step(s) in job(s) [${offenders.join(', ')}] are not skipped on ` +
        `merge_group. A queue ref has no PR base to diff against; a filter failure there ` +
        `hard-fails the sentinel and blocks the queue.`,
    ).toEqual([])
  })

  it.each(WORKFLOWS)('%s — no step reads PR-only context unguarded', (file) => {
    // `github.event.pull_request.*` and `github.base_ref` are EMPTY on
    // merge_group. A step that interpolates them there either renders a
    // broken value (e.g. the invalid image reference `IMAGE:pr-`) or
    // silently selects nothing (e.g. `vitest --changed origin/`). Each
    // such step must either be gated to pull_request, or handle
    // merge_group explicitly in its own body.
    const offenders: string[] = []
    for (const [name, job] of jobsOf(load(file))) {
      for (const step of stepsOf(job)) {
        const body = textOf(step)
        if (!body.includes('github.event.pull_request.') && !body.includes('github.base_ref')) {
          continue
        }
        const gatedToPr = String(step.if ?? '').includes("== 'pull_request'")
        if (!gatedToPr && !body.includes('merge_group')) {
          offenders.push(`${name}/${step.name ?? step.uses ?? '<step>'}`)
        }
      }
    }
    expect(
      offenders,
      `${file}: step(s) [${offenders.join(', ')}] interpolate pull-request-only context ` +
        `that is EMPTY on merge_group, without gating to pull_request or handling ` +
        `merge_group. Renders a broken value or silently selects nothing on a queue ref.`,
    ).toEqual([])
  })
})

describe('merge queue — ci-tests-core actually runs vitest on a queue ref', () => {
  // The subtlest failure mode found while fixing the outage: adding the
  // merge_group trigger alone is NOT enough here. Both vitest steps were
  // `if:`-gated (`pull_request` for the --changed arm, `push` for the
  // full-suite arm), so on merge_group the shard job would check out,
  // install, download dist/ — and run ZERO tests, then report success
  // under the required `vitest` context. A silent false green on the one
  // check that gates the whole test suite.
  const wf = load('ci-tests-core.yml')
  const shard = (wf.jobs ?? {})['vitest-shard']

  it('the vitest-shard job runs on merge_group', () => {
    expect(String(shard?.if ?? ''), 'vitest-shard must not skip on merge_group').toContain(
      'merge_group',
    )
  })

  it('at least one vitest step executes on merge_group', () => {
    const vitestSteps = stepsOf(shard).filter((s) => (s.run ?? '').includes('vitest run'))
    expect(vitestSteps.length, 'expected vitest run steps in vitest-shard').toBeGreaterThan(0)

    const runsOnMergeGroup = vitestSteps.filter((s) => {
      const gate = String(s.if ?? '')
      // An ungated step runs on every event; a gated one must name merge_group.
      return gate === '' || gate.includes('merge_group')
    })

    expect(
      runsOnMergeGroup.map((s) => s.name ?? '<step>'),
      `ci-tests-core.yml: no vitest step is reachable on merge_group. The job would run ` +
        `checkout + install + artifact download, execute NO tests, and still report ` +
        `success under the REQUIRED 'vitest' context — a silent false green that would ` +
        `let the merge queue land anything.`,
    ).not.toEqual([])
  })
})

describe('merge queue — docker-images never publishes from an unmerged ref', () => {
  // docker-images.yml spelled "is this a publishing event?" as
  // `github.event_name != 'pull_request'`, which is TRUE on merge_group.
  // Left alone, a queue run would log in to GHCR, push images, write
  // registry build cache, and move :latest / :sha-<short> — from a ref
  // that has NOT been merged and may never be. None of this is
  // observable on a PR.
  const wf = load('docker-images.yml')
  const jobs = jobsOf(wf)

  it('no GHCR login step is reachable on merge_group', () => {
    const offenders: string[] = []
    for (const [name, job] of jobs) {
      if (excludesMergeGroup(job.if)) continue
      for (const step of stepsOf(job)) {
        if (!(step.uses ?? '').includes('docker/login-action')) continue
        if (!excludesMergeGroup(step.if)) offenders.push(`${name}/${step.name ?? '<login>'}`)
      }
    }
    expect(
      offenders,
      `docker-images.yml: GHCR login reachable on merge_group in [${offenders.join(', ')}]. ` +
        `A queue run publishes nothing and must not take a registry credential.`,
    ).toEqual([])
  })

  it('no image build pushes or writes registry cache on merge_group', () => {
    const pushOffenders: string[] = []
    const cacheOffenders: string[] = []
    for (const [name, job] of jobs) {
      for (const step of stepsOf(job)) {
        if (!(step.uses ?? '').includes('docker/build-push-action')) continue
        const push = String(step.with?.push ?? '')
        const cacheTo = String(step.with?.['cache-to'] ?? '')
        if (push !== 'false' && !push.includes('merge_group')) pushOffenders.push(name)
        if (cacheTo !== '' && !cacheTo.includes('merge_group')) cacheOffenders.push(name)
      }
    }
    expect(
      pushOffenders,
      `docker-images.yml: build step(s) in [${pushOffenders.join(', ')}] would PUSH on ` +
        `merge_group. \`push: github.event_name != 'pull_request'\` is TRUE on a queue ` +
        `ref — images from an unmerged commit would land in GHCR.`,
    ).toEqual([])
    expect(
      cacheOffenders,
      `docker-images.yml: build step(s) in [${cacheOffenders.join(', ')}] would write ` +
        `registry build cache on merge_group.`,
    ).toEqual([])
  })

  it('no manifest job moves a user-facing tag on merge_group', () => {
    // merge-base / merge-dependents / merge-hindsight / promote-to-dev /
    // retag-unchanged / retag-release assign :latest / :sha-<short> /
    // :dev / :vX.Y.Z with `imagetools create`.
    const manifestJobs = jobs.filter(([, job]) =>
      stepsOf(job).some((s) => (s.run ?? '').includes('imagetools create')),
    )
    expect(
      manifestJobs.map(([n]) => n).sort(),
      'the rule must still match the publishing jobs it guards',
    ).toEqual([
      'merge-base',
      'merge-dependents',
      'merge-hindsight',
      'promote-to-dev',
      // Release-tag twin of retag-unchanged: assigns :vX.Y.Z from the
      // previous release's manifest when tag-retag-plan proved the
      // image's inputs identical to that release.
      'retag-release',
      'retag-unchanged',
    ])

    const offenders = manifestJobs.filter(([, job]) => !excludesMergeGroup(job.if)).map(([n]) => n)

    expect(
      offenders,
      `docker-images.yml: manifest job(s) [${offenders.join(', ')}] are reachable on ` +
        `merge_group. They move user-facing tags (:latest / :sha-<short> / :dev) and must ` +
        `only ever run on a real push to main — publication follows the merge, it does ` +
        `not precede it.`,
    ).toEqual([])
  })

  it("every `!= 'pull_request'` publish gate also excludes merge_group", () => {
    // The GENERAL form of the three rules above, so a NEW publish step
    // can't reintroduce the bug those rules were written for. This file
    // uses `github.event_name != 'pull_request'` as shorthand for "this
    // is a publishing event" — a shorthand that is silently WRONG on a
    // queue ref. Every occurrence must therefore also exclude
    // merge_group, except the deliberate JOB-LEVEL gate below, which
    // means "actually compile the base image" and MUST run on
    // merge_group or `images-ok` becomes a rubber stamp.
    //
    // The exemption is deliberately narrow: it is keyed on the job-level
    // `if:` (4-space indent) and NOT on the job as a whole, because the
    // exempt job also contains `push:` / `cache-to:` / step-level `if:`
    // occurrences of the same shorthand that must still be caught. A
    // job-wide exemption would wave those through — which is exactly the
    // bug this file exists to prevent.
    //
    // Two jobs are exempt: `build-base` and `build-dist`. Both mean
    // "actually produce the build input" — build-base compiles the base
    // image, build-dist bundles dist/ once for the dependent legs — and
    // both MUST run on merge_group so the validation legs have something
    // to build (else `images-ok` is a rubber stamp). Crucially, NEITHER
    // pushes anything: build-base's push/cache-to are step-level and gated
    // separately, and build-dist only uploads an in-run artifact. So the
    // bare `!= 'pull_request'` job gate is safe on the queue ref for both.
    //
    // `build-dependents` used to be exempt too (its old bare
    // `!= 'pull_request'` gate also meant "compile on merge_group"), but
    // the build-base decoupling split the dependents build into two jobs:
    // the PR/merge_group leg (`build-dependents`) now uses a POSITIVE event
    // allowlist with no `!= 'pull_request'` shorthand, and the push leg
    // (`build-dependents-push`) spells out `&& github.event_name !=
    // 'merge_group'` — so neither needs the exemption. See the "build-base
    // decoupling" describe block below.
    const ALLOWED_JOB_LEVEL_GATES = ['build-base', 'build-dist']

    const lines = readFileSync(join(REPO, '.github/workflows/docker-images.yml'), 'utf8').split('\n')
    let job = '<workflow-level>'
    const offenders: string[] = []
    let seenAllowed = 0
    lines.forEach((line, i) => {
      const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
      if (header) job = header[1]
      if (line.trimStart().startsWith('#')) return
      if (!line.includes("!= 'pull_request'")) return
      if (line.includes('merge_group')) return
      if (/^ {4}if:/.test(line) && ALLOWED_JOB_LEVEL_GATES.includes(job)) {
        seenAllowed += 1
        return
      }
      offenders.push(`${job} (line ${i + 1}): ${line.trim()}`)
    })

    expect(
      seenAllowed,
      'expected the deliberate build-base gate to still be present — if this drops to 0 the ' +
        'rule below is passing vacuously and no longer guards anything',
    ).toBe(ALLOWED_JOB_LEVEL_GATES.length)

    expect(
      offenders,
      `docker-images.yml treats \`github.event_name != 'pull_request'\` as "this is a publish", ` +
        `but that expression is TRUE on a merge_group ref. These occurrences do not exclude ` +
        `merge_group, so a queue run would perform them against an UNMERGED commit:\n  ` +
        `${offenders.join('\n  ')}\nAdd \`&& github.event_name != 'merge_group'\`, or — if the ` +
        `step genuinely must run on the queue ref — add the job to ` +
        `ALLOWED_JOB_LEVEL_GATES in this test with the reason why.`,
    ).toEqual([])
  })

  it('per-arch matrices stay amd64-only on merge_group', () => {
    const matrices = jobs
      .map(([name, job]) => [name, textOf(job.strategy)] as const)
      .filter(([, s]) => s.includes('arm64') && s.includes("event_name == 'pull_request'"))
    expect(matrices.length, 'expected the PR-gated per-arch matrices').toBeGreaterThan(0)
    for (const [name, s] of matrices) {
      expect(
        s,
        `docker-images.yml: job '${name}' would build the arm64 leg on merge_group. A ` +
          `queue run validates buildability and pushes nothing; the arm64 artifact is ` +
          `only ever consumed from a main/tag push.`,
      ).toContain('merge_group')
    }
  })
})

describe('docker-images — build-dependents is decoupled from build-base on PR/merge_group', () => {
  // The dependents build was split into two jobs because GitHub Actions
  // has no event-conditional `needs:` (a job always waits for every job
  // it needs, even skipped ones, before its own `if` is evaluated):
  //
  //   - `build-dependents`      — PR / merge_group VALIDATION leg. Builds
  //     FROM the PUBLISHED switchroom-base:latest, so it has NO data
  //     dependency on build-base and must NOT `needs:` it — that is the
  //     whole point (build-base's ~31s comes off the PR critical path).
  //   - `build-dependents-push` — push / tag / dispatch leg. Consumes the
  //     freshly-built per-arch scratch base tag, so it MUST wait on
  //     build-base.
  //
  // Every assertion here is invisible on a PR run (the push leg never
  // executes there), so a test is the only thing that stops a future edit
  // from re-coupling the PR path — reintroducing the serialisation this
  // change removed — or, worse, from dropping the push-path base
  // dependency and racing build-base (a `FROM …:sha-<short>-<arch>` pull
  // of a tag that does not exist yet).
  const wf = load('docker-images.yml')
  const jobs = wf.jobs ?? {}
  const needsOf = (j?: Job): string[] => {
    const n = j?.needs
    return Array.isArray(n) ? n : n ? [String(n)] : []
  }

  it('both dependent legs exist', () => {
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining(['build-dependents', 'build-dependents-push']),
    )
  })

  it('the PR/merge_group leg does NOT depend on build-base', () => {
    expect(
      needsOf(jobs['build-dependents']),
      'build-dependents must not `needs: build-base` — that edge would serialise the ' +
        'base build ahead of dependents on every PR, which is exactly the wait this split ' +
        'removes. It builds FROM the published :latest and has no data dependency on the run.',
    ).not.toContain('build-base')
  })

  it('the push leg DOES depend on build-base (keeps the scratch-tag dependency)', () => {
    expect(
      needsOf(jobs['build-dependents-push']),
      'build-dependents-push consumes switchroom-base:sha-<short>-<arch>, which build-base ' +
        'pushes — without `needs: build-base` it would race the base build and fail the FROM.',
    ).toContain('build-base')
  })

  it('the PR/merge_group leg runs on merge_group and never on push', () => {
    const gate = String(jobs['build-dependents']?.if ?? '')
    expect(gate, 'build-dependents must still compile on the queue ref (images-ok signal)').toContain(
      'merge_group',
    )
    // Positive allowlist form — must not carry the `!= 'pull_request'`
    // "this is a publish" shorthand (that is the push leg's spelling).
    expect(
      gate,
      "the PR/merge_group leg must use a positive event allowlist, not the `!= 'pull_request'` " +
        'publish shorthand',
    ).not.toContain("!= 'pull_request'")
  })

  it('the push leg is fenced off PR and merge_group', () => {
    const gate = String(jobs['build-dependents-push']?.if ?? '')
    expect(gate).toContain("github.event_name != 'pull_request'")
    expect(gate).toContain("github.event_name != 'merge_group'")
    expect(
      gate,
      'the push leg must not publish past a failed base — keep the explicit success check ' +
        'that replaces the default all-needs-succeeded semantics `!cancelled()` discards.',
    ).toContain("needs.build-base.result == 'success'")
  })

  it('merge-dependents publishes from the PUSH leg, not the PR/merge_group leg', () => {
    // On a real push the PR/merge_group leg is skipped; if merge-dependents
    // needed it, the publish job would be skipped and NOTHING would land in
    // GHCR. It must consume the push leg's per-arch scratch tags.
    expect(needsOf(jobs['merge-dependents'])).toContain('build-dependents-push')
    expect(needsOf(jobs['merge-dependents'])).not.toContain('build-dependents')
    expect(String(jobs['merge-dependents']?.if ?? '')).toContain(
      "needs.build-dependents-push.result == 'success'",
    )
  })

  it('images-ok aggregates BOTH dependent legs', () => {
    // A failure of either leg (PR-leg on a PR, push-leg on a push) must
    // block the required sentinel — neither may drop out of coverage.
    const needs = needsOf(jobs['images-ok'])
    expect(needs).toContain('build-dependents')
    expect(needs).toContain('build-dependents-push')
    const verdict = JSON.stringify(jobs['images-ok']?.steps ?? [])
    expect(verdict).toContain('build-dependents=')
    expect(verdict).toContain('build-dependents-push=')
  })

  it('the two legs build the identical image set (drift guard)', () => {
    // The legs are byte-identical except for `needs`/`if`. If a future
    // edit adds an image to one matrix and forgets the other, PR
    // validation and the published set would silently diverge.
    expect(JSON.stringify(jobs['build-dependents']?.strategy)).toEqual(
      JSON.stringify(jobs['build-dependents-push']?.strategy),
    )
    expect(JSON.stringify(jobs['build-dependents']?.steps)).toEqual(
      JSON.stringify(jobs['build-dependents-push']?.steps),
    )
  })
})

describe('CI parallelism — docker-e2e sharded 3-way, ci-tests-core 8-way', () => {
  // Guards the free-runner parallelism split. Each assertion fails on the
  // exact regression it protects: a shard count reverted, the required
  // sentinel losing a shard's coverage, or the shard parameter never
  // reaching the test runner (which would run the whole suite N times over
  // — no speedup and wasted runners). None of this is observable on a
  // green run; only a shape test pins it.

  const shardsOf = (job: Job | undefined): unknown[] => {
    const matrix = (job?.strategy as { matrix?: { shard?: unknown[] } } | undefined)?.matrix?.shard
    return Array.isArray(matrix) ? matrix : []
  }
  const needsOf = (job: Job | undefined): string[] => {
    const n = job?.needs
    return Array.isArray(n) ? n : n ? [String(n)] : []
  }

  it('docker-e2e: e2e-shard is a 3-way matrix', () => {
    const job = (load('docker-e2e.yml').jobs ?? {})['e2e-shard']
    expect(job, 'docker-e2e.yml must define the sharded e2e-shard job').toBeTruthy()
    expect(shardsOf(job)).toEqual([1, 2, 3])
  })

  it('docker-e2e: every e2e shard threads its shard index into the snapshot gate', () => {
    const job = (load('docker-e2e.yml').jobs ?? {})['e2e-shard']
    const gateStep = stepsOf(job).find((s) => (s.run ?? '').includes('docker-snapshot-gate.sh')) as
      | (Step & { env?: Record<string, string> })
      | undefined
    expect(gateStep, 'the e2e-shard job must still run docker-snapshot-gate.sh').toBeTruthy()
    // The gate slices tests/docker by VITEST_SHARD; without this env each
    // leg runs the WHOLE suite, three times over — the exact anti-speedup.
    expect(gateStep!.env?.VITEST_SHARD, 'VITEST_SHARD must pin this leg to /3').toBe(
      '${{ matrix.shard }}/3',
    )
  })

  it('docker-e2e: the e2e-ok sentinel aggregates every e2e shard + hindsight-probe', () => {
    const sentinel = (load('docker-e2e.yml').jobs ?? {})['e2e-ok']
    const needs = needsOf(sentinel)
    // `needs: e2e-shard` aggregates ALL matrix legs — success only if
    // every shard passed; failure/cancel if any did. Dropping it (or a
    // stale `needs: e2e`) would let a failing shard slip past the one
    // required context for this workflow.
    expect(needs, 'e2e-ok must need the sharded e2e job').toContain('e2e-shard')
    expect(needs, 'e2e-ok must still need hindsight-probe').toContain('hindsight-probe')
    expect(needs, 'e2e-ok must not reference the pre-shard job name').not.toContain('e2e')
    const verdict = JSON.stringify(sentinel?.steps ?? [])
    expect(verdict, 'the verdict must fail the sentinel on a shard failure').toContain(
      'needs.e2e-shard.result',
    )
    expect(verdict, 'the verdict must not read the stale e2e.result').not.toContain(
      'needs.e2e.result',
    )
  })

  it('ci-tests-core: vitest-shard is an 8-way matrix and both arms shard /8', () => {
    const job = (load('ci-tests-core.yml').jobs ?? {})['vitest-shard']
    expect(shardsOf(job)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const shardCmds = stepsOf(job)
      .map((s) => s.run ?? '')
      .filter((r) => r.includes('vitest run'))
    expect(
      shardCmds.length,
      'expected both vitest arms (PR --changed + full suite)',
    ).toBeGreaterThanOrEqual(2)
    for (const cmd of shardCmds) {
      expect(cmd, 'every vitest arm must shard /8, not a stale /4').toContain('${{ matrix.shard }}/8')
      expect(cmd, 'no stale /4 denominator may remain').not.toContain('/4')
    }
  })
})
