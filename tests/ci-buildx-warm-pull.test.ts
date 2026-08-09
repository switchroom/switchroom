/**
 * Guard: every workflow job that boots a BuildKit CONTAINER must go through
 * `.github/actions/setup-buildx`, which warms the builder image with a
 * bounded, transient-only retry first (issue #3815).
 *
 * Why: `docker/setup-buildx-action`'s default `docker-container` driver
 * pulls `moby/buildkit:buildx-stable-1` from DOCKER HUB to boot BuildKit —
 * unauthenticated, un-retried, and before any `docker/login-action` step.
 * Measured over 14,269 completed `docker-images` jobs (2026-07-16 →
 * 2026-07-27), **19 of the 21 failed build/manifest jobs** were that pull
 * timing out. It reds the required `images-ok` sentinel and ejected four
 * PRs (#3693, #3728, #3759, #3813) from the merge queue in two days.
 *
 * This is the sibling of `tests/docker/manifest-jobs-no-buildx.test.ts`,
 * which covers the other half: jobs that never needed a builder at all.
 * That one says "drop the step"; this one says "if you genuinely need the
 * docker-container driver, warm the image first".
 *
 * Two kinds of assertion here, deliberately:
 *
 *   1. Structural — no job may reference `docker/setup-buildx-action`
 *      directly unless it opts out of the container driver with
 *      `driver: docker`.
 *   2. Behavioural — the retry script is EXECUTED against a stub docker
 *      so the tests fail on the bug they guard: a blanket retry that
 *      hammers a permanent error, a retry that never fires, or a
 *      warm-pull that fails the job.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const REPO = resolve(import.meta.dirname, '..')
const WORKFLOW_DIR = join(REPO, '.github/workflows')
const ACTION_DIR = join(REPO, '.github/actions/setup-buildx')
const WARM_SCRIPT = join(ACTION_DIR, 'warm-buildkit-image.sh')

const LOCAL_ACTION = './.github/actions/setup-buildx'
const UPSTREAM_ACTION = 'docker/setup-buildx-action'

const WORKFLOWS = [
  'docker-images.yml',
  'ci-full.yml',
  'docker-e2e.yml',
  'promote.yml',
  'release.yml',
  'npm-publish.yml',
  'ci-lint.yml',
  'ci-tests-core.yml',
  'ci-tests-plugin.yml',
  'ci-tests-python.yml',
  'ci-tests-race-long.yml',
  'ci-uat.yml',
  'ci-evals.yml',
  'ci-infra-watchdog.yml',
  'ci-claude-latest-canary.yml',
]

interface Step {
  uses?: string
  name?: string
  with?: Record<string, unknown>
}
interface Job {
  steps?: Step[]
}

function loadJobs(file: string): Array<[string, Job]> {
  const raw = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
  const doc = parse(raw) as { jobs?: Record<string, Job> }
  return Object.entries(doc.jobs ?? {})
}

const allJobs = WORKFLOWS.filter((f) => existsSync(join(WORKFLOW_DIR, f))).flatMap((file) =>
  loadJobs(file).map(([name, job]) => ({ file, name, job, steps: job.steps ?? [] })),
)

describe('buildx warm-pull guard (#3815)', () => {
  it('the workflow inventory this test scans actually matches the repo', () => {
    // Sanity floor: if a workflow is added and not listed above, this test
    // would silently stop covering it. Cheap to keep honest.
    expect(allJobs.length).toBeGreaterThan(20)
    expect(WORKFLOWS.filter((f) => !existsSync(join(WORKFLOW_DIR, f)))).toEqual([])
  })

  it('no job uses docker/setup-buildx-action directly with the container driver', () => {
    const offenders: string[] = []
    for (const { file, name, steps } of allJobs) {
      for (const step of steps) {
        if (!(step.uses ?? '').startsWith(UPSTREAM_ACTION)) continue
        // `driver: docker` boots no BuildKit container, so it has no
        // docker.io dependency and is legitimately exempt.
        if ((step.with?.driver ?? '') === 'docker') continue
        offenders.push(`${file}:${name}`)
      }
    }
    expect(
      offenders,
      `job(s) [${offenders.join(', ')}] use ${UPSTREAM_ACTION} with the default ` +
        `docker-container driver. That boots BuildKit by pulling moby/buildkit ` +
        `from Docker Hub, un-retried and before any login step — the #3815 flake ` +
        `(19 of 21 image-job failures, 4 merge-queue ejections). Use ` +
        `${LOCAL_ACTION} instead, or pass \`driver: docker\` if this job does ` +
        `not actually need a BuildKit container.`,
    ).toEqual([])
  })

  it('the jobs that build images do go through the warm-pull action', () => {
    // Pins the positive set so the rule above cannot pass vacuously by
    // everyone simply dropping buildx.
    const viaLocal = allJobs
      .filter(({ steps }) => steps.some((s) => (s.uses ?? '') === LOCAL_ACTION))
      .map(({ file, name }) => `${file}:${name}`)
      .sort()
    expect(viaLocal).toEqual([
      'ci-full.yml:docker-images-build',
      'docker-images.yml:build-base',
      'docker-images.yml:build-dependents',
      // PR/merge_group and push legs of the dependents build are separate
      // jobs (GHA has no event-conditional `needs:`); both build images
      // and so both go through the warm-pull action.
      'docker-images.yml:build-dependents-push',
      'docker-images.yml:build-hindsight',
      'docker-images.yml:build-voice',
    ])
  })

  it('the warmed ref and the ref the driver boots are the same string', () => {
    // A warm-pull of a ref the driver does not boot is a silent no-op:
    // `ImageInspect` would miss and the docker.io pull would be fatal
    // again. Pinning `driver-opts: image=` to the same input is what makes
    // the two impossible to drift apart — assert the wiring survives.
    const action = parse(readFileSync(join(ACTION_DIR, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { default?: string }>
      runs: { steps: Step[] }
    }
    const defaultRef = action.inputs['buildkit-image'].default
    expect(defaultRef).toBe('moby/buildkit:buildx-stable-1') // buildx bkimage.DefaultImage

    const buildxStep = action.runs.steps.find((s) => (s.uses ?? '').startsWith(UPSTREAM_ACTION))
    expect(buildxStep, 'the composite must still call setup-buildx-action').toBeTruthy()
    expect(buildxStep!.with?.['driver-opts']).toBe('image=${{ inputs.buildkit-image }}')

    const warmStep = action.runs.steps[0] as Step & { env?: Record<string, string> }
    expect(warmStep.env?.BUILDKIT_IMAGE).toBe('${{ inputs.buildkit-image }}')
  })
})

/**
 * These tests need to EXECUTE a stub `docker`, and this repo's dev hosts
 * (and agent containers) commonly mount /tmp `noexec` — see CLAUDE.md
 * "Local env noise vs real failures". Probe once and fall back to a
 * scratch dir inside the worktree so the suite is honest everywhere
 * instead of failing for an unrelated reason.
 */
function execCapableBase(): string {
  const candidate = mkdtempSync(join(tmpdir(), 'buildx-warm-'))
  const probe = join(candidate, 'probe.sh')
  writeFileSync(probe, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  chmodSync(probe, 0o755)
  try {
    execFileSync(probe, { stdio: 'ignore' })
    return candidate
  } catch {
    rmSync(candidate, { recursive: true, force: true })
    return mkdtempSync(join(REPO, '.buildx-warm-test-'))
  }
}

describe('warm-buildkit-image.sh behaviour (#3815)', () => {
  const tmp = execCapableBase()
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  /**
   * Runs the real script against a stub `docker` whose `pull` fails
   * `failures` times with `stderr`, then succeeds (unless `alwaysFail`).
   * `image inspect` always misses, i.e. the image is not warm yet.
   */
  function run(opts: {
    stderr: string
    failures: number
    alwaysFail?: boolean
    attempts?: number
    inspectHit?: boolean
  }) {
    const dir = mkdtempSync(join(tmp, 'case-'))
    const counter = join(dir, 'pulls')
    const stub = join(dir, 'docker')
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env bash',
        `if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then exit ${opts.inspectHit ? 0 : 1}; fi`,
        `if [ "$1" = "pull" ]; then`,
        `  echo x >> "${counter}"`,
        `  n=$(wc -l < "${counter}")`,
        `  if [ "${opts.alwaysFail ? 1 : 0}" = "1" ] || [ "$n" -le ${opts.failures} ]; then`,
        `    printf '%s\\n' ${JSON.stringify(opts.stderr)} >&2`,
        '    exit 1',
        '  fi',
        '  echo "Status: Downloaded newer image"',
        '  exit 0',
        'fi',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    )
    chmodSync(stub, 0o755)
    writeFileSync(counter, '')

    const res = execFileSync('bash', [WARM_SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DOCKER_BIN: stub,
        BUILDKIT_IMAGE: 'moby/buildkit:buildx-stable-1',
        BUILDKIT_WARM_ATTEMPTS: String(opts.attempts ?? 4),
        // No sleeping in tests. The script skips the sleep entirely at 0.
        BUILDKIT_WARM_BASE_DELAY: '0',
      },
    })
    const pulls = readFileSync(counter, 'utf8').trim() === '' ? 0 : readFileSync(counter, 'utf8').trim().split('\n').length
    return { out: res, pulls }
  }

  const TIMEOUT_ERR =
    'Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)'

  it('retries the exact production error and succeeds without failing the job', () => {
    // The literal error from run 30261146638 / job 89961204337.
    const { out, pulls } = run({ stderr: TIMEOUT_ERR, failures: 2 })
    expect(pulls).toBe(3)
    expect(out).toContain('BuildKit warm-pull recovered')
  })

  it('retries "context deadline exceeded" too (run 30244997098 shape)', () => {
    const { pulls } = run({
      stderr: 'Error response from daemon: Get "https://registry-1.docker.io/v2/": context deadline exceeded',
      failures: 1,
    })
    expect(pulls).toBe(2)
  })

  it('retries a Docker Hub rate limit — it is not misfiled as permanent', () => {
    // 429 is the other real docker.io failure mode and it clears on its
    // own. It must not be swallowed by an over-broad "denied"/"unauthorized"
    // entry in the fatal list.
    const { pulls } = run({
      stderr:
        'toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating and upgrading',
      failures: 1,
    })
    expect(pulls).toBe(2)
  })

  it('is bounded — it does not retry forever when Docker Hub stays down', () => {
    const { out, pulls } = run({ stderr: TIMEOUT_ERR, failures: 0, alwaysFail: true, attempts: 3 })
    expect(pulls).toBe(3)
    expect(out).toContain('BuildKit warm-pull exhausted')
  })

  it('does NOT retry a permanent error — the retry is transient-only', () => {
    // This is the assertion that fails if someone "simplifies" the script
    // into a blanket retry loop. A bad pin must surface immediately, not
    // after N pointless round trips.
    const { out, pulls } = run({
      stderr: 'Error response from daemon: manifest unknown',
      failures: 0,
      alwaysFail: true,
    })
    expect(pulls).toBe(1)
    expect(out).toContain('not transient')
  })

  it('does NOT retry an unrecognised error', () => {
    const { pulls } = run({ stderr: 'something nobody has ever seen', failures: 0, alwaysFail: true })
    expect(pulls).toBe(1)
  })

  it('never fails the job on any give-up path', () => {
    // execFileSync throws on a non-zero exit, so reaching these lines at
    // all is the assertion: the warm-pull is an optimisation in front of
    // setup-buildx-action and must never become a NEW failure mode.
    expect(() => run({ stderr: TIMEOUT_ERR, failures: 0, alwaysFail: true, attempts: 2 })).not.toThrow()
    expect(() => run({ stderr: 'manifest unknown', failures: 0, alwaysFail: true })).not.toThrow()
  })

  it('skips the pull entirely when the image is already warm', () => {
    const { out, pulls } = run({ stderr: TIMEOUT_ERR, failures: 0, inspectHit: true })
    expect(pulls).toBe(0)
    expect(out).toContain('already in the local image store')
  })
})
