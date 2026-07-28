/**
 * Guard: `ci-tests-python.yml`'s path filter must cover every input the
 * python jobs actually read.
 *
 * `ci-tests-python.yml` gates its `unittest` job behind a
 * dorny/paths-filter `relevant` output. That filter is a hand-maintained
 * list, and every path a python step reads but the list omits is a silent
 * hole: the sentinel reports `success` without running the suite, so a PR
 * touching only that path merges green having been tested by nothing.
 *
 * Two holes this file was written for, both live on `main` until #3688:
 *
 *  1. `vendor/hindsight-memory/tests/**` was in NO filter and run by NO
 *     job — the `unittest discover` step runs
 *     `vendor/hindsight-memory/scripts/tests/`, a different directory.
 *     258 assertions gated nothing, and one of them had rotted red.
 *  2. `vendor/hindsight-memory/tests/test_manifest.py` reads
 *     `<integration root>/hooks/hooks.json` and asserts it is strict-valid
 *     JSON with a `hooks` mapping. `vendor/hindsight-memory/hooks/**` was
 *     NOT in the filter, so a PR editing only `hooks/hooks.json` — adding
 *     a hook, renaming a matcher — matched nothing, skipped `unittest`,
 *     and could land a manifest that no longer matched the shipped hooks.
 *
 * This is deliberately a coverage assertion over the SUITE ROOTS the jobs
 * run, not a hard-coded copy of the filter list: a new python suite added
 * to the workflow without a matching filter entry fails here too, which is
 * the general shape of the bug rather than the one instance of it.
 *
 * `ci-full.yml`'s twin `python-full` job is deliberately NOT checked for a
 * filter — it is the nightly UNFILTERED sweep and has no `changes` job at
 * all (see its header comment). Its exposure to this class of bug is nil;
 * the PR-facing workflow is the only one that can skip.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const REPO = resolve(import.meta.dirname, '..')
const WORKFLOW = '.github/workflows/ci-tests-python.yml'

interface Step {
  name?: string
  uses?: string
  run?: string
  'working-directory'?: string
  with?: Record<string, unknown>
}
interface Job {
  steps?: Step[]
  outputs?: Record<string, string>
}
interface Workflow {
  jobs?: Record<string, Job>
}

function loadWorkflow(): Workflow {
  return parse(readFileSync(join(REPO, WORKFLOW), 'utf8')) as Workflow
}

/** The `relevant:` glob list out of the `changes` job's paths-filter step. */
function relevantFilters(wf: Workflow): string[] {
  const step = (wf.jobs?.changes?.steps ?? []).find((s) =>
    (s.uses ?? '').includes('dorny/paths-filter'),
  )
  expect(
    step,
    `${WORKFLOW}: no dorny/paths-filter step in the \`changes\` job`,
  ).toBeTruthy()
  const filters = parse(String(step!.with?.filters ?? '')) as Record<string, string[]>
  return filters.relevant ?? []
}

/** True when `path` is matched by at least one `dir/**`-style filter glob. */
function covered(path: string, globs: string[]): boolean {
  return globs.some((g) => {
    if (g === path) return true
    if (!g.endsWith('/**')) return false
    return path === g.slice(0, -3) || path.startsWith(g.slice(0, -2))
  })
}

/**
 * The repo-relative suite root each python step actually runs, i.e. its
 * `working-directory` joined with the target it hands the runner.
 *
 * Deliberately the TARGET, not the working directory: the pytest step runs
 * from `vendor/hindsight-memory` but only collects `tests/`, and widening
 * the filter to the whole vendor root would re-run the suite on every
 * README edit. The filter is narrow on purpose; this asserts it is not
 * narrower than what runs.
 */
function suiteRoots(wf: Workflow): string[] {
  const roots: string[] = []
  for (const step of wf.jobs?.unittest?.steps ?? []) {
    const wd = step['working-directory']
    const run = step.run ?? ''
    if (!wd || !/\b(unittest|pytest)\b/.test(run)) continue
    // `unittest discover -s <dir>` / `unittest discover <dir>` / `pytest <dir>`
    const m = /discover\s+(?:-s\s+)?(\S+)/.exec(run) ?? /pytest\s+(?!-)(\S+)/.exec(run)
    const target = (m?.[1] ?? '.').replace(/\/+$/, '')
    roots.push(target === '.' ? wd : `${wd}/${target}`)
  }
  return roots
}

describe('ci-tests-python path filter — no test input can slip past the sentinel', () => {
  it('every suite the job runs sits inside a filtered path', () => {
    const wf = loadWorkflow()
    const globs = relevantFilters(wf)
    const roots = suiteRoots(wf)
    expect(roots.length, 'fixture: the unittest job runs python suites').toBeGreaterThan(0)
    const uncovered = roots.filter((d) => !covered(d, globs))
    expect(
      uncovered,
      `${WORKFLOW}: these suites run but no \`relevant\` filter path matches them, so a PR ` +
        `touching only them skips the job: ${uncovered.join(', ')}`,
    ).toEqual([])
  })

  it('the sibling vendored plugin suite is actually RUN by the job', () => {
    // The hole that made this file necessary: the suite existed, was
    // filtered by nothing and executed by nothing. A filter entry with no
    // step behind it would satisfy the coverage test above vacuously.
    const roots = suiteRoots(loadWorkflow())
    expect(
      roots,
      `${WORKFLOW}: no step runs vendor/hindsight-memory/tests — the suite would gate nothing`,
    ).toContain('vendor/hindsight-memory/tests')
  })

  it('the hooks manifest read by test_manifest.py is filtered', () => {
    // `tests/test_manifest.py` resolves INTEGRATION_ROOT / "hooks" /
    // "hooks.json" — an input to the suite that lives outside every
    // suite directory, which is exactly why it was missed.
    const manifest = 'vendor/hindsight-memory/hooks/hooks.json'
    const src = readFileSync(
      join(REPO, 'vendor/hindsight-memory/tests/test_manifest.py'),
      'utf8',
    )
    expect(src, 'fixture: the suite still reads the hooks manifest').toMatch(
      /INTEGRATION_ROOT\s*\/\s*"hooks"\s*\/\s*"hooks\.json"/,
    )
    expect(
      covered(manifest, relevantFilters(loadWorkflow())),
      `${WORKFLOW}: \`${manifest}\` is asserted on by test_manifest.py but matches no ` +
        `\`relevant\` filter path — a PR editing only the manifest would skip the suite`,
    ).toBe(true)
  })

  it('the workflow file itself is filtered, so edits to the gate re-run it', () => {
    expect(covered(WORKFLOW, relevantFilters(loadWorkflow()))).toBe(true)
  })
})
