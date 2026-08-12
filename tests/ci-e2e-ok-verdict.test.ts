/**
 * Behavioural guard for the `e2e-ok` sentinel's verdict script.
 *
 * `e2e-ok` is the single branch-protection-required context for
 * docker-e2e.yml (ruleset 16470166). Because a *skipped* required check
 * hard-blocks (#1343 / #2237), the sentinel must stay green when the path
 * filter skips `e2e-shard` / `hindsight-probe` — but before #4619 it said
 * nothing else, so "green because nothing ran" was indistinguishable from
 * "green because e2e passed". PR #4619 was approved and enqueued on that
 * green and then EJECTED from the merge queue when `hindsight-probe`
 * failed on the `merge_group` ref the PR ref had never exercised.
 *
 * This suite does NOT shape-match the YAML. It extracts the sentinel's
 * actual `run:` script and EXECUTES it under bash with the same `env:`
 * block the workflow supplies, then asserts the observable outcome:
 * exit status, the `::warning::` / `::error::` annotations on stdout, and
 * the job summary written to $GITHUB_STEP_SUMMARY. Every case below fails
 * against the pre-#4619 verdict, which exited 0 silently on a skip and
 * exited 0 on a skip that should never have happened.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const REPO = resolve(import.meta.dirname, '..')

interface Step {
  name?: string
  run?: string
  env?: Record<string, string>
}
interface Job {
  steps?: Step[]
}

const workflow = parse(
  readFileSync(join(REPO, '.github/workflows/docker-e2e.yml'), 'utf8'),
) as { jobs?: Record<string, Job> }

const sentinel = workflow.jobs?.['e2e-ok']
const verdictStep = (sentinel?.steps ?? []).find((s) => s.name === 'Verdict')

/** Env keys the workflow feeds the script (values are `${{ }}` expressions). */
const ENV_KEYS = Object.keys(verdictStep?.env ?? {})

interface RunResult {
  status: number
  stdout: string
  summary: string
}

/** Execute the real verdict script with a synthetic `needs` context. */
function runVerdict(env: Record<string, string>): RunResult {
  const script = verdictStep?.run
  if (!script) throw new Error('e2e-ok has no "Verdict" step with a run: script')
  // The script must be self-contained: every input arrives via env, so no
  // `${{ }}` expression may survive into the body (an unsubstituted one
  // would be a shell syntax error here and an injection seam in CI).
  expect(script, 'the verdict body must read its inputs from env:, not inline ${{ }}').not.toMatch(
    /\$\{\{/,
  )

  const dir = mkdtempSync(join(tmpdir(), 'e2e-ok-verdict-'))
  const scriptPath = join(dir, 'verdict.sh')
  const summaryPath = join(dir, 'summary.md')
  writeFileSync(scriptPath, script)
  writeFileSync(summaryPath, '')

  let status = 0
  let stdout = ''
  try {
    stdout = execFileSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, ...env, GITHUB_STEP_SUMMARY: summaryPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    status = err.status ?? -1
    stdout = (err.stdout ?? '') + (err.stderr ?? '')
  }
  return { status, stdout, summary: readFileSync(summaryPath, 'utf8') }
}

/** A PR ref where the path filter matched and every job really ran. */
const RAN_AND_PASSED = {
  EVENT: 'pull_request',
  CHANGES: 'success',
  E2E_SHARD: 'success',
  HINDSIGHT_PROBE: 'success',
  HINDSIGHT_WATCH_PG_PROBE: 'success',
  WANT_E2E_SHARD: 'true',
  WANT_HINDSIGHT_PROBE: 'true',
  WANT_HINDSIGHT_WATCH_PG_PROBE: 'true',
}

/** A docs-only PR: the filter said no, every job legitimately skipped. */
const PATH_SKIPPED = {
  EVENT: 'pull_request',
  CHANGES: 'success',
  E2E_SHARD: 'skipped',
  HINDSIGHT_PROBE: 'skipped',
  HINDSIGHT_WATCH_PG_PROBE: 'skipped',
  WANT_E2E_SHARD: 'false',
  WANT_HINDSIGHT_PROBE: 'false',
  WANT_HINDSIGHT_WATCH_PG_PROBE: 'false',
}

describe('e2e-ok verdict — the three states are distinguishable', () => {
  it('the sentinel feeds the script through env:, not string-interpolated shell', () => {
    expect(verdictStep, 'e2e-ok must keep a step named "Verdict"').toBeTruthy()
    for (const key of [
      'EVENT',
      'CHANGES',
      'E2E_SHARD',
      'HINDSIGHT_PROBE',
      'HINDSIGHT_WATCH_PG_PROBE',
      'WANT_E2E_SHARD',
      'WANT_HINDSIGHT_PROBE',
      'WANT_HINDSIGHT_WATCH_PG_PROBE',
    ]) {
      expect(ENV_KEYS, `the verdict needs ${key} in its env: block`).toContain(key)
    }
  })

  it('shards ran and passed → exit 0, VERIFIED, and no "not verified" warning', () => {
    const r = runVerdict(RAN_AND_PASSED)
    expect(r.status).toBe(0)
    expect(r.summary).toContain('VERIFIED on this ref')
    expect(r.summary).not.toContain('not verified')
    expect(r.stdout).not.toContain('::warning')
  })

  it('a shard failed → exit 1 with an error annotation', () => {
    const r = runVerdict({ ...RAN_AND_PASSED, E2E_SHARD: 'failure' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error::e2e-shard=failure')
  })

  it('a shard was cancelled → exit 1 (a cancel is not a pass)', () => {
    const r = runVerdict({ ...RAN_AND_PASSED, HINDSIGHT_PROBE: 'cancelled' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error::hindsight-probe=cancelled')
  })

  it('hindsight-watch-pg-probe failing blocks too (it is in the aggregation)', () => {
    // #4623 added this job to `needs:`; the verdict must actually read it,
    // otherwise a real pg-probe failure would be aggregated away as green.
    const r = runVerdict({ ...RAN_AND_PASSED, HINDSIGHT_WATCH_PG_PROBE: 'failure' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error::hindsight-watch-pg-probe=failure')
  })

  it('path-skipped → still exit 0 (required context must not block docs PRs)', () => {
    // This is the constraint, not a nicety: `e2e-ok` is required, so a
    // non-zero here would hard-block every PR that misses the filter.
    expect(runVerdict(PATH_SKIPPED).status).toBe(0)
  })

  it('path-skipped → green, but annotated NOT VERIFIED rather than read as a pass', () => {
    const r = runVerdict(PATH_SKIPPED)
    expect(r.stdout, 'a path-skip must raise a visible warning annotation').toContain(
      '::warning title=e2e NOT verified on this ref::',
    )
    expect(r.stdout).toContain('e2e-shard was path-skipped')
    expect(r.stdout).toContain('hindsight-probe was path-skipped')
    expect(r.summary, 'the job summary must not claim verification').toContain('NOT VERIFIED')
    expect(r.summary, 'and must name where it will really run').toContain('merge_group')
  })

  it('one ran, one path-skipped → PARTIALLY VERIFIED, not a clean green', () => {
    const r = runVerdict({
      ...PATH_SKIPPED,
      E2E_SHARD: 'success',
      WANT_E2E_SHARD: 'true',
    })
    expect(r.status).toBe(0)
    expect(r.summary).toContain('PARTIALLY VERIFIED')
    expect(r.stdout).toContain('hindsight-probe was path-skipped')
  })
})

describe('e2e-ok verdict — a skip that should not have happened is a failure', () => {
  // The false-green with teeth: a skip is only trustworthy when the path
  // filter asked for it. Anywhere else it means the gate did not run.

  for (const event of ['push', 'merge_group', 'workflow_dispatch']) {
    it(`${event}: the work jobs are unconditional, so a skip fails the gate`, () => {
      const r = runVerdict({
        EVENT: event,
        CHANGES: event === 'merge_group' ? 'skipped' : 'success',
        E2E_SHARD: 'skipped',
        HINDSIGHT_PROBE: 'skipped',
        HINDSIGHT_WATCH_PG_PROBE: 'skipped',
        // Empty exactly as GitHub renders them on these events.
        WANT_E2E_SHARD: '',
        WANT_HINDSIGHT_PROBE: '',
        WANT_HINDSIGHT_WATCH_PG_PROBE: '',
      })
      expect(r.status, `a skip on ${event} must not report success`).toBe(1)
      expect(r.stdout).toContain('::error title=e2e gate broken::e2e-shard was SKIPPED')
      expect(r.stdout).toContain('::error title=e2e gate broken::hindsight-probe was SKIPPED')

      // Since #4638 all three work jobs carry the same must-run terms, so
      // a skip on ANY of these events — workflow_dispatch included — is a
      // broken gate for the pg probe too. Before #4638 it was excused on
      // dispatch by a separate, weaker `must_run_pg`.
      expect(
        r.stdout,
        `hindsight-watch-pg-probe skip on ${event} must fail the gate`,
      ).toContain('::error title=e2e gate broken::hindsight-watch-pg-probe was SKIPPED')
    })
  }

  it('PR ref: the filter said relevant, so a skip is a broken gate too', () => {
    const r = runVerdict({ ...PATH_SKIPPED, WANT_E2E_SHARD: 'true' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error title=e2e gate broken::e2e-shard was SKIPPED')
    // …while the genuinely-irrelevant sibling still only warns.
    expect(r.stdout).toContain('::warning title=e2e NOT verified on this ref::')
  })

  it('the path-filter job itself failing still blocks (unchanged)', () => {
    const r = runVerdict({ ...PATH_SKIPPED, CHANGES: 'failure' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error::changes=failure')
  })

  it('an unrecognised result is never treated as a pass', () => {
    const r = runVerdict({ ...RAN_AND_PASSED, E2E_SHARD: 'neutral' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('refusing to call it a pass')
  })
})

describe('docker-e2e — the workflow_dispatch recovery lever actually runs the suite', () => {
  // Run 31131064381 (2026-08-06): a manual `gh workflow run
  // docker-e2e.yml` reported `e2e-ok` success in 3 seconds with e2e and
  // hindsight-probe both `skipped` — `changes` has no diff base on a
  // dispatch, so `relevant` came back false. The advertised recovery
  // lever recovered nothing and said it had.
  //
  // hindsight-watch-pg-probe kept that exact gap after #4628 (#4638): its
  // `if:` carried push and merge_group only, so a manual dispatch never
  // exercised the streak-retention-floor probe against a real PostgreSQL.
  const jobs = (workflow.jobs ?? {}) as Record<string, { if?: string }>

  for (const name of ['e2e-shard', 'hindsight-probe', 'hindsight-watch-pg-probe']) {
    it(`${name} runs on workflow_dispatch`, () => {
      const cond = jobs[name]?.if ?? ''
      expect(cond, `${name} must have a gating if:`).toBeTruthy()
      expect(cond, `${name} must run on the dispatch recovery lever`).toContain(
        "github.event_name == 'workflow_dispatch'",
      )
    })
  }
})
