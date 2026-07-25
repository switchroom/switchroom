/**
 * Outcome tests for `scripts/ci/infra-watchdog.sh` — the classifier
 * behind `.github/workflows/ci-infra-watchdog.yml`.
 *
 * The watchdog's whole job is to tell an infra force-fail (no job ever
 * reported "failure") apart from a genuine red, and to alert ONLY on the
 * former. The logic used to live inline in the workflow yaml with no
 * test, and it shipped a bug: the classification `gh api` read had no
 * retry, so a transient `HTTP 503` from GitHub's REST API killed the step
 * under `set -euo pipefail` and painted main red. That happened three
 * times on 2026-07-20 (runs 29709703593, 29710301287, 29710576955) — and
 * in every one the underlying workflow was a genuine red, i.e. the
 * correct outcome was a silent exit 0.
 *
 * Each test drives the real script with a stub `gh` on PATH that records
 * its argv and replays scripted responses, then asserts on OUTCOMES:
 * exit status, and whether an issue/comment was actually created.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const SCRIPT = join(REPO, 'scripts/ci/infra-watchdog.sh')

// The stub `gh` must be EXECUTABLE (it is resolved off PATH). Some
// sandboxes/containers mount the system temp dir `noexec`, which would
// silently fall through to the real `gh` and make every assertion here
// test GitHub instead of the script. Stage under node_modules/ (git-
// ignored, same filesystem as the checkout) so the exec bit is honoured.
const SANDBOX_ROOT = join(REPO, 'node_modules', '.tmp-tests')

let sandbox: string

beforeEach(() => {
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  sandbox = mkdtempSync(join(SANDBOX_ROOT, 'infra-watchdog-'))
})
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * Install a stub `gh` that:
 *  - appends every invocation's argv to `$GH_CALLS` (one line per call);
 *  - for `gh api ...`, fails with a 503 for the first `apiFailures`
 *    calls, then prints `apiJobsJson`;
 *  - for `gh issue list`, prints `issueListOut` (empty = no dedupe hit);
 *  - succeeds silently for everything else.
 */
function installGhStub(opts: {
  apiFailures?: number
  apiJobsJson?: string
  issueListOut?: string
  /** Benign diagnostic written to stderr while STILL exiting 0. */
  apiStderrOnSuccess?: string
}): { bin: string; calls: () => string[] } {
  const bin = join(sandbox, 'bin')
  const callLog = join(sandbox, 'gh-calls.log')
  const counter = join(sandbox, 'api-attempts')
  mkdirSync(bin, { recursive: true })

  const gh = join(bin, 'gh')
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}
if [ "\$1" = "api" ]; then
  n=0
  [ -f ${JSON.stringify(counter)} ] && n=\$(cat ${JSON.stringify(counter)})
  n=\$((n + 1)); echo "\$n" > ${JSON.stringify(counter)}
  if [ "\$n" -le ${opts.apiFailures ?? 0} ]; then
    echo "gh: No server is currently available to service your request. (HTTP 503)" >&2
    exit 1
  fi
  if [ -n ${JSON.stringify(opts.apiStderrOnSuccess ?? '')} ]; then
    printf '%s\n' ${JSON.stringify(opts.apiStderrOnSuccess ?? '')} >&2
  fi
  cat <<'JSONEOF'
${opts.apiJobsJson ?? '[{"jobs":[]}]'}
JSONEOF
  exit 0
fi
if [ "\$1" = "issue" ] && [ "\$2" = "list" ]; then
  printf '%s' ${JSON.stringify(opts.issueListOut ?? '')}
  exit 0
fi
exit 0
`,
    'utf8',
  )
  chmodSync(gh, 0o755)

  return {
    bin,
    calls: () =>
      existsSync(callLog)
        ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean)
        : [],
  }
}

function runWatchdog(bin: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: 'stub',
        REPO: 'switchroom/switchroom',
        RUN_ID: '29710576955',
        WF_NAME: 'ci-tests-core',
        HEAD_SHA: '7cdf5428a27701996ba962a546871bfffd90d53e',
        RUN_URL: 'https://github.com/switchroom/switchroom/actions/runs/29710505937',
        RUN_CONCLUSION: 'failure',
        // Keep the retry backoff sub-second so the suite doesn't sleep.
        WATCHDOG_MAX_ATTEMPTS: '3',
        WATCHDOG_BASE_DELAY: '0',
      },
    })
    return { code: 0, out }
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      code: e.status ?? 1,
      out: `${e.stdout?.toString?.() ?? ''}${e.stderr?.toString?.() ?? ''}`,
    }
  }
}

/**
 * Guard: if the stub were ever bypassed (PATH not honoured, `noexec`
 * temp, etc.) the negative assertions below would all trivially pass
 * against a real `gh`. Every test proves the stub actually ran.
 */
function assertStubUsed(calls: string[]): void {
  expect(calls.length).toBeGreaterThan(0)
  expect(calls[0].startsWith('api ')).toBe(true)
}

const GENUINE_RED = '[{"jobs":[{"conclusion":"success"},{"conclusion":"failure"}]}]'
const INFRA_SIGNATURE = '[{"jobs":[{"conclusion":"skipped"},{"conclusion":"cancelled"}]}]'
// Failure lands on page 2 — the --paginate --slurp flattening must see it.
const GENUINE_RED_PAGE_2 =
  '[{"jobs":[{"conclusion":"success"}]},{"jobs":[{"conclusion":"failure"}]}]'

describe('scripts/ci/infra-watchdog.sh', () => {
  it('genuine red (a job reported failure) → exit 0 and NO issue is opened', () => {
    const stub = installGhStub({ apiJobsJson: GENUINE_RED })
    const { code, out } = runWatchdog(stub.bin)
    assertStubUsed(stub.calls())
    expect(code).toBe(0)
    expect(out).toMatch(/genuine red/)
    expect(stub.calls().some((c) => c.startsWith('issue create'))).toBe(false)
    expect(stub.calls().some((c) => c.startsWith('issue comment'))).toBe(false)
  })

  it('counts failures on page 2+ as a genuine red (pagination flattening)', () => {
    const stub = installGhStub({ apiJobsJson: GENUINE_RED_PAGE_2 })
    const { code, out } = runWatchdog(stub.bin)
    assertStubUsed(stub.calls())
    expect(code).toBe(0)
    expect(out).toMatch(/1 job\(s\) reported failure/)
    expect(stub.calls().some((c) => c.startsWith('issue create'))).toBe(false)
  })

  it('infra signature (zero failing jobs) → opens an alert issue', () => {
    const stub = installGhStub({ apiJobsJson: INFRA_SIGNATURE })
    const { code, out } = runWatchdog(stub.bin)
    assertStubUsed(stub.calls())
    expect(code).toBe(0)
    expect(out).toMatch(/Infra signature/)
    const created = stub.calls().filter((c) => c.startsWith('issue create'))
    expect(created).toHaveLength(1)
    expect(created[0]).toContain('CI infra: main red without job execution @ 7cdf5428')
  })

  it('infra signature with an existing open issue → comments, does not re-create', () => {
    const stub = installGhStub({ apiJobsJson: INFRA_SIGNATURE, issueListOut: '4242' })
    const { code, out } = runWatchdog(stub.bin)
    assertStubUsed(stub.calls())
    expect(code).toBe(0)
    expect(out).toMatch(/Commented on existing issue #4242/)
    expect(stub.calls().some((c) => c.startsWith('issue create'))).toBe(false)
    expect(stub.calls().some((c) => c.startsWith('issue comment 4242'))).toBe(true)
  })

  it('transient 503s on the classification read are retried, then classified correctly', () => {
    // This is the 2026-07-20 regression: without a retry the first 503
    // killed the step and reddened main.
    const stub = installGhStub({ apiFailures: 2, apiJobsJson: GENUINE_RED })
    const { code, out } = runWatchdog(stub.bin)
    assertStubUsed(stub.calls())
    expect(code).toBe(0)
    expect(out).toMatch(/genuine red/)
    // 3 api attempts: two 503s + the success.
    expect(stub.calls().filter((c) => c.startsWith('api ')).length).toBe(3)
    expect(stub.calls().some((c) => c.startsWith('issue create'))).toBe(false)
  })

  it('benign stderr on a SUCCESSFUL read never reaches the JSON (no 2>&1 stream merge)', () => {
    // Regression pin for the review finding on this PR's first cut: the
    // retry loop captured `2>&1`, which merges stderr into stdout on the
    // SUCCESS path too. `gh` can exit 0 while writing an OAuth-scope
    // warning / deprecation notice / pagination progress to stderr; that
    // text lands in front of the JSON, `jq` dies with `parse error:
    // Invalid numeric literal`, and `set -euo pipefail` reddens main —
    // reintroducing the exact bug this script exists to prevent.
    const stub = installGhStub({
      apiJobsJson: GENUINE_RED,
      apiStderrOnSuccess:
        'Warning: your authentication token is missing required scopes [read:org]',
    })
    const { code, out } = runWatchdog(stub.bin)
    assertStubUsed(stub.calls())
    expect(code).toBe(0)
    expect(out).not.toMatch(/parse error|Invalid numeric literal/)
    expect(out).toMatch(/genuine red/)
    expect(stub.calls().some((c) => c.startsWith('issue create'))).toBe(false)
  })

  it('a sustained API outage warns and exits 0 — it never guesses a classification', () => {
    const stub = installGhStub({ apiFailures: 99 })
    const { code, out } = runWatchdog(stub.bin)
    assertStubUsed(stub.calls())
    expect(code).toBe(0)
    expect(out).toMatch(/::warning title=ci-infra-watchdog could not classify::/)
    // Bounded: exactly WATCHDOG_MAX_ATTEMPTS reads, not an unbounded loop.
    expect(stub.calls().filter((c) => c.startsWith('api ')).length).toBe(3)
    // Critically: no alert is fabricated from an unread classification.
    expect(stub.calls().some((c) => c.startsWith('issue create'))).toBe(false)
    expect(stub.calls().some((c) => c.startsWith('issue comment'))).toBe(false)
  })
})
