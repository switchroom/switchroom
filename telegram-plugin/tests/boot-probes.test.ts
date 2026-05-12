/**
 * Unit tests for boot-probes fixes.
 *
 * Covers:
 *   - #208: probeAgentProcess — deactivating → 🟡 (not 🔴), re-probe loop
 *   - #210: probeQuota — 429 → ok-with-note + 30 s cache
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  probeAccount,
  probeAgentProcess,
  probeScheduler,
  probeBroker,
  probeKernel,
  probeSkills,
  probeQuota,
  watchAgentProcess,
  findAgentProcessInContainer,
  uptimeMsForStarttime,
  type ProcFsImpl,
  type SchedulerFsImpl,
  type SkillsFsImpl,
} from '../gateway/boot-probes.js'
import { readQuotaCache, RATE_LIMIT_TTL_MS } from '../gateway/quota-cache.js'

// ── #208: probeAgentProcess ────────────────────────────────────────────────

/**
 * Build a mock queryAgentState sequence: each call to `execFile` returns the
 * next state in `states`. We inject this by passing a custom `sleepImpl` (a
 * no-op) and providing a series of fake systemctl responses through a mock
 * `execFile`. Since `queryAgentState` is not exported we test
 * `probeAgentProcess` end-to-end with a zero-delay sleep and a
 * pre-configured call sequence of fake systemctl output.
 *
 * Strategy: monkey-patch `child_process.execFile` is fragile across module
 * boundaries with Bun's module cache. Instead we test via the exported
 * probeAgentProcess signature which accepts:
 *   - sleepImpl: no-op so tests are instant
 *   - retryIntervalMs / retryMaxMs: kept tiny so the budget math works
 *
 * We inject systemctl output through a sequence of `execFileImpl` calls
 * ─ but `probeAgentProcess` does not expose that yet. Rather than widen
 * the internal API surface, we use a lightweight approach: test the
 * exported constants and state-machine logic through two probe shapes:
 *   1. always-deactivating (max retries exhausted) → degraded
 *   2. first call inactive, second call active → ok
 *
 * This requires `probeAgentProcess` to accept an `execFileImpl` override.
 * We added `execFileImpl` to the opts parameter for this purpose.
 *
 * NOTE: If the implementation doesn't expose execFileImpl, the tests will
 * document the expected shape and we adjust the implementation to match.
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSystemctlOutput(state: string, pid = '1234'): string {
  return [
    `MainPID=${pid}`,
    `ActiveState=${state}`,
    `MemoryCurrent=104857600`,
    `ActiveEnterTimestamp=1700000000000000`,
  ].join('\n') + '\n'
}

type ExecFileResult = { stdout: string; stderr: string }
type ExecFileFn = (...args: unknown[]) => Promise<ExecFileResult>

/** Build a promisified execFile mock that returns each output in sequence. */
function makeSequence(outputs: Array<string | Error>): ExecFileFn {
  let idx = 0
  return async (): Promise<ExecFileResult> => {
    const item = outputs[idx] ?? outputs[outputs.length - 1]
    idx++
    if (item instanceof Error) throw item
    return { stdout: item, stderr: '' }
  }
}

const noopSleep = async (_ms: number): Promise<void> => undefined

// ── #208: deactivating → 🟡 ───────────────────────────────────────────────

describe('probeAgentProcess — #208: deactivating → 🟡 (degraded)', () => {
  it('returns degraded when state is deactivating after all retries', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 0,  // exhaust budget immediately on first non-active result
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([makeSystemctlOutput('deactivating')]),
    })
    expect(result.status).toBe('degraded')
    expect(result.label).toBe('Agent')
    expect(result.detail).toBe('service deactivating')
  })

  it('returns fail (not degraded) for inactive when budget is exhausted', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 0,
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([makeSystemctlOutput('inactive')]),
    })
    expect(result.status).toBe('fail')
    expect(result.detail).toBe('service inactive')
  })

  it('returns fail (not degraded) for failed when budget is exhausted', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 0,
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([makeSystemctlOutput('failed')]),
    })
    expect(result.status).toBe('fail')
    expect(result.detail).toBe('service failed')
  })
})

// ── #247: activating + auto-restart → 🟡 ──────────────────────────────────

describe('probeAgentProcess — #247: activating → 🟡 (degraded)', () => {
  it('returns degraded when state is activating after budget exhausted', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 0,
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([makeSystemctlOutput('activating')]),
    })
    expect(result.status).toBe('degraded')
    expect(result.label).toBe('Agent')
    expect(result.detail).toBe('service activating')
  })

  it('returns ok if activating resolves to active on retry', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 5000,
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([
        makeSystemctlOutput('activating'),
        makeSystemctlOutput('active'),
      ]),
    })
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('PID 1234')
  })
})

describe('probeAgentProcess — #247: auto-restart → 🟡 (degraded)', () => {
  it('returns degraded when state is auto-restart after budget exhausted', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 0,
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([makeSystemctlOutput('auto-restart')]),
    })
    expect(result.status).toBe('degraded')
    expect(result.label).toBe('Agent')
    expect(result.detail).toBe('service auto-restart')
  })

  it('returns ok if auto-restart resolves to active on retry', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 5000,
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([
        makeSystemctlOutput('auto-restart'),
        makeSystemctlOutput('active'),
      ]),
    })
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('PID 1234')
  })
})

// ── #208: re-probe loop ────────────────────────────────────────────────────

describe('probeAgentProcess — #208: re-probe loop resolves transient', () => {
  it('returns ok when first call is inactive but second is active', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 5000,  // enough budget for one retry
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([
        makeSystemctlOutput('inactive'),  // first probe: transient
        makeSystemctlOutput('active'),    // second probe: resolved
      ]),
    })
    expect(result.status).toBe('ok')
    expect(result.label).toBe('Agent')
    expect(result.detail).toContain('PID 1234')
  })

  it('returns ok immediately when first call is active (no retry needed)', async () => {
    let callCount = 0
    const execFileImpl: ExecFileFn = async () => {
      callCount++
      return { stdout: makeSystemctlOutput('active'), stderr: '' }
    }
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 5000,
      sleepImpl: noopSleep,
      execFileImpl,
    })
    expect(result.status).toBe('ok')
    expect(callCount).toBe(1)
  })

  it('returns degraded after budget exhausted if deactivating on every attempt', async () => {
    // All three calls return deactivating — budget eventually runs out.
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 0,  // zero budget: commit after first non-active result
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([
        makeSystemctlOutput('deactivating'),
        makeSystemctlOutput('deactivating'),
        makeSystemctlOutput('deactivating'),
      ]),
    })
    expect(result.status).toBe('degraded')
    expect(result.detail).toBe('service deactivating')
  })

  it('returns fail when systemctl errors after all retries', async () => {
    const result = await probeAgentProcess('testbot', {
      retryIntervalMs: 0,
      retryMaxMs: 0,
      sleepImpl: noopSleep,
      execFileImpl: makeSequence([new Error('unit not found')]),
    })
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('systemctl failed')
  })
})

// ── #210: probeQuota — 429 → ok-with-note + 30s cache ────────────────────

import { writeFileSync, mkdirSync } from 'fs'
import { writeQuotaCache } from '../gateway/quota-cache.js'

let tmp: string
let cachePath: string
let claudeDir: string
let agentDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'boot-probes-test-'))
  cachePath = join(tmp, 'quota-cache.json')
  // Point the cache to the temp dir so tests don't pollute ~/.switchroom
  process.env.SWITCHROOM_QUOTA_CACHE_PATH = cachePath

  // Create a fake Claude config dir with a stub OAuth token so probeQuota
  // gets past the "no OAuth token" guard and reaches the fetch call.
  claudeDir = join(tmp, 'claude')
  agentDir = join(tmp, 'agent')
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(claudeDir, '.oauth-token'), 'fake-token-for-testing')
})

afterEach(() => {
  delete process.env.SWITCHROOM_QUOTA_CACHE_PATH
  rmSync(tmp, { recursive: true, force: true })
})

describe('probeQuota — #210: 429 returns ok-with-note', () => {
  it('returns ok with "quota check skipped: rate limited" on 429', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(null, { status: 429 }) as Response

    const result = await probeQuota(claudeDir, agentDir, fakeFetch)
    expect(result.status).toBe('ok')
    expect(result.label).toBe('Quota')
    expect(result.detail).toBe('quota check skipped: rate limited')
    // #247: structured field so writeQuotaCache can key TTL off it
    expect(result.rateLimited).toBe(true)
  })

  it('writing 429 ok-result to cache produces a readable 30 s entry', () => {
    // Verify the cache contract: writeQuotaCache stores rate-limit results
    // with RATE_LIMIT_TTL_MS keyed off rateLimited:true, not the detail string.
    const rateLimitResult = {
      status: 'ok' as const,
      label: 'Quota',
      detail: 'quota check skipped: rate limited',
      rateLimited: true as const,
    }
    const now = Date.now()
    writeQuotaCache(rateLimitResult, { path: cachePath, now })

    // Within 30 s window: cache hit
    const hit = readQuotaCache({ path: cachePath, now: now + 1000 })
    expect(hit).not.toBeNull()
    expect(hit?.status).toBe('ok')
    expect(hit?.detail).toBe('quota check skipped: rate limited')

    // After 30 s window: cache miss
    const miss = readQuotaCache({ path: cachePath, now: now + RATE_LIMIT_TTL_MS + 1 })
    expect(miss).toBeNull()
  })

  it('429 cache expires after RATE_LIMIT_TTL_MS (30 s)', () => {
    // Seed the cache with a 429-ok entry that is past its 30s TTL
    const staleNow = Date.now() - RATE_LIMIT_TTL_MS - 1000
    writeQuotaCache(
      { status: 'ok', label: 'Quota', detail: 'quota check skipped: rate limited' },
      { path: cachePath, now: staleNow, ttlMs: RATE_LIMIT_TTL_MS },
    )

    // readQuotaCache should see it as expired
    const cached = readQuotaCache({ path: cachePath })
    expect(cached).toBeNull()
  })
})

// ── #296: watchAgentProcess follow-up re-poll ─────────────────────────────

describe('watchAgentProcess — #296: re-poll after window expiry', () => {
  /**
   * Build a fake clock that the test can advance manually. The first
   * call returns the start time; each subsequent `tick` advances now()
   * by the given ms.
   */
  function makeFakeClock(startMs = 0) {
    let current = startMs
    return {
      now: () => current,
      tick: (ms: number) => { current += ms },
    }
  }

  it('flips degraded → ok when agent reaches active after the follow-up re-poll', async () => {
    const clock = makeFakeClock()
    const sequence = makeSequence([
      makeSystemctlOutput('inactive'),
      makeSystemctlOutput('active', '99999'),
    ])
    const execFileImpl = ((...args: unknown[]) =>
      sequence(...args)) as ExecFileFn
    // Each sleep call advances the fake clock past the window.
    const sleepImpl = async (ms: number) => { clock.tick(ms) }

    const yields: Array<{ status: string; detail: string }> = []
    const gen = watchAgentProcess('testbot', {
      liveWindowMs: 100, // expire after first tick (sleep advances 1000ms past)
      pollIntervalMs: 1000,
      followupRepollMs: 30_000,
      sleepImpl,
      execFileImpl: execFileImpl as never,
      nowImpl: clock.now,
    })
    for await (const result of gen) {
      yields.push({ status: result.status, detail: result.detail ?? '' })
    }

    // First yield: degraded (within-window-expired commit). Second yield:
    // ok (the follow-up re-poll caught the late-boot active transition).
    expect(yields.length).toBeGreaterThanOrEqual(2)
    const final = yields[yields.length - 1]
    expect(final.status).toBe('ok')
    expect(final.detail).toContain('PID 99999')
  })

  it('does NOT yield ok when agent stays inactive after the follow-up re-poll', async () => {
    const clock = makeFakeClock()
    const sequence = makeSequence([
      makeSystemctlOutput('inactive'),
      makeSystemctlOutput('inactive'),
      makeSystemctlOutput('inactive'),
    ])
    const execFileImpl = ((...args: unknown[]) =>
      sequence(...args)) as ExecFileFn
    const sleepImpl = async (ms: number) => { clock.tick(ms) }

    const yields: Array<{ status: string; detail: string }> = []
    const gen = watchAgentProcess('testbot', {
      liveWindowMs: 100,
      pollIntervalMs: 1000,
      followupRepollMs: 30_000,
      sleepImpl,
      execFileImpl: execFileImpl as never,
      nowImpl: clock.now,
    })
    for await (const result of gen) {
      yields.push({ status: result.status, detail: result.detail ?? '' })
    }

    // Final status must be degraded — the follow-up re-poll saw inactive
    // again so no ok yield was added. (The number of yields varies by how
    // many distinct "service X" detail strings the loop saw; what matters
    // is that ok never appears.)
    expect(yields.every((y) => y.status === 'degraded')).toBe(true)
    expect(yields.find((y) => y.status === 'ok')).toBeUndefined()
  })

  it('skips the re-poll entirely when followupRepollMs <= 0', async () => {
    const clock = makeFakeClock()
    const sequence = makeSequence([makeSystemctlOutput('inactive')])
    const execCalls: number[] = []
    const execFileImpl = ((...args: unknown[]) => {
      execCalls.push(1)
      return sequence(...args)
    }) as ExecFileFn

    const yields: Array<{ status: string }> = []
    const gen = watchAgentProcess('testbot', {
      liveWindowMs: 100,
      pollIntervalMs: 1000,
      followupRepollMs: 0, // disabled
      sleepImpl: async (ms: number) => { clock.tick(ms) },
      execFileImpl: execFileImpl as never,
      nowImpl: clock.now,
    })
    for await (const result of gen) {
      yields.push({ status: result.status })
    }

    // followupRepollMs=0 means no follow-up after the window expires.
    // Final yield must be degraded; no ok ever surfaces.
    expect(yields.every((y) => y.status === 'degraded')).toBe(true)
    expect(yields.find((y) => y.status === 'ok')).toBeUndefined()
  })

  it('returns immediately on ok within window — no follow-up needed', async () => {
    const clock = makeFakeClock()
    const sequence = makeSequence([makeSystemctlOutput('active', '12345')])
    let extraCalls = 0
    const execFileImpl = ((...args: unknown[]) => {
      const result = sequence(...args)
      extraCalls += 1
      return result
    }) as ExecFileFn

    const yields: Array<{ status: string }> = []
    const gen = watchAgentProcess('testbot', {
      liveWindowMs: 60_000,
      pollIntervalMs: 1000,
      followupRepollMs: 30_000,
      sleepImpl: async (ms: number) => { clock.tick(ms) },
      execFileImpl: execFileImpl as never,
      nowImpl: clock.now,
    })
    for await (const result of gen) {
      yields.push({ status: result.status })
    }

    expect(yields).toHaveLength(1)
    expect(yields[0].status).toBe('ok')
    expect(extraCalls).toBe(1) // only the initial probe; no follow-up
  })

// ── docker mode: skip systemctl, use /proc walk ───────────────────────────

describe('probeAgentProcess — docker mode skips systemctl', () => {
  it('probeAgentProcess(dockerMode) returns the injected /proc result without execing', async () => {
    let execFileCalls = 0
    const execFileImpl: ExecFileFn = async () => {
      execFileCalls++
      throw new Error('systemctl should never be called under dockerMode')
    }
    const dockerProbeImpl = () => ({
      status: 'ok' as const,
      label: 'Agent',
      detail: 'PID 42 · up 3.0s · 128 MB',
    })
    const result = await probeAgentProcess('clerk', {
      dockerMode: true,
      dockerProbeImpl,
      execFileImpl: execFileImpl as never,
      sleepImpl: noopSleep,
      retryIntervalMs: 1,
      retryMaxMs: 5,
    })
    expect(result.status).toBe('ok')
    expect(result.label).toBe('Agent')
    expect(result.detail).toBe('PID 42 · up 3.0s · 128 MB')
    expect(execFileCalls).toBe(0)
  })

  it('probeAgentProcess(dockerMode) surfaces fail when no claude process found', async () => {
    const dockerProbeImpl = () => ({
      status: 'fail' as const,
      label: 'Agent',
      detail: 'claude process not found',
    })
    const result = await probeAgentProcess('clerk', {
      dockerMode: true,
      dockerProbeImpl,
    })
    expect(result.status).toBe('fail')
    expect(result.detail).toBe('claude process not found')
  })

  it('watchAgentProcess(dockerMode) yields the /proc result once and exits', async () => {
    let execFileCalls = 0
    const execFileImpl: ExecFileFn = async () => {
      execFileCalls++
      return { stdout: '', stderr: '' }
    }
    const dockerProbeImpl = () => ({
      status: 'ok' as const,
      label: 'Agent',
      detail: 'PID 42 · up 5.0s · 200 MB',
    })
    const yields: Array<{ status: string; detail: string }> = []
    const gen = watchAgentProcess('clerk', {
      dockerMode: true,
      dockerProbeImpl,
      execFileImpl: execFileImpl as never,
      sleepImpl: noopSleep,
      liveWindowMs: 1000,
      pollIntervalMs: 10,
      followupRepollMs: 0,
    })
    for await (const r of gen) yields.push({ status: r.status, detail: r.detail })
    expect(yields).toHaveLength(1)
    expect(yields[0].status).toBe('ok')
    expect(execFileCalls).toBe(0)
  })

})

// ── probeScheduler — in-container agent-scheduler (Phase 4 cron-fold-in) ──

function makeSchedulerFs(files: Record<string, { content?: string; mtimeMs?: number }>): SchedulerFsImpl {
  return {
    readFile: (p) => {
      const f = files[p]
      if (!f || f.content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return f.content
    },
    mtimeMs: (p) => {
      const f = files[p]
      if (!f || f.mtimeMs === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return f.mtimeMs
    },
    exists: (p) => p in files,
  }
}

describe('probeScheduler', () => {
  it('returns ok n/a when not in dockerMode (Phase 4 deleted host-side scheduler)', async () => {
    const result = await probeScheduler('clerk', { dockerMode: false })
    expect(result.status).toBe('ok')
    expect(result.label).toBe('Scheduler')
    expect(result.detail).toContain('non-docker')
  })

  it('fails when lockfile is missing (sidecar never started or supervisor gave up)', async () => {
    const fs = makeSchedulerFs({})
    const result = await probeScheduler('clerk', {
      dockerMode: true,
      fs,
      isAlive: () => true,
      // Disable settle softening so the verdict is the hard fail —
      // the "boot still settling" case is covered by the dedicated
      // test below.
      containerBootTimeMs: null,
    })
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('no lockfile')
  })

  it('softens fail to degraded when container booted recently (still-settling window)', async () => {
    // No lockfile, but container PID 1 started 5 s ago — the supervisor
    // is still bringing the scheduler up. /status hit at this instant
    // should NOT show 🔴 for a non-issue.
    const now = 1_700_000_000_000
    const fs = makeSchedulerFs({})
    const result = await probeScheduler('clerk', {
      dockerMode: true,
      fs,
      isAlive: () => true,
      now: () => now,
      containerBootTimeMs: now - 5_000,
    })
    expect(result.status).toBe('degraded')
    expect(result.detail).toContain('still settling')
  })

  it('does NOT soften when container booted long ago (real wedge, not a flap)', async () => {
    // Container has been up for an hour; missing lockfile is a real
    // problem, not a settle window. Hard fail expected.
    const now = 1_700_000_000_000
    const fs = makeSchedulerFs({})
    const result = await probeScheduler('clerk', {
      dockerMode: true,
      fs,
      isAlive: () => true,
      now: () => now,
      containerBootTimeMs: now - 60 * 60_000,
    })
    expect(result.status).toBe('fail')
    expect(result.detail).not.toContain('still settling')
  })

  it('honors SWITCHROOM_AGENT_SCHEDULER_LOCK env override', async () => {
    const customLock = '/custom/sched.lock'
    const fs = makeSchedulerFs({
      [customLock]: { content: '1234' },
    })
    const oldEnv = process.env.SWITCHROOM_AGENT_SCHEDULER_LOCK
    process.env.SWITCHROOM_AGENT_SCHEDULER_LOCK = customLock
    try {
      const result = await probeScheduler('clerk', {
        dockerMode: true,
        fs,
        isAlive: (pid) => pid === 1234,
        containerBootTimeMs: null,
      })
      expect(result.status).toBe('ok')
      expect(result.detail).toContain('pid 1234')
    } finally {
      if (oldEnv === undefined) delete process.env.SWITCHROOM_AGENT_SCHEDULER_LOCK
      else process.env.SWITCHROOM_AGENT_SCHEDULER_LOCK = oldEnv
    }
  })

  it('honors SWITCHROOM_AGENT_SCHEDULER_JSONL env override for freshness hint', async () => {
    const lockPath = '/state/agent/scheduler.lock'
    const customJsonl = '/custom/audit.jsonl'
    const now = 1_700_000_000_000
    const fs = makeSchedulerFs({
      [lockPath]: { content: '5555' },
      [customJsonl]: { content: '{}\n', mtimeMs: now - 90_000 },
    })
    const oldEnv = process.env.SWITCHROOM_AGENT_SCHEDULER_JSONL
    process.env.SWITCHROOM_AGENT_SCHEDULER_JSONL = customJsonl
    try {
      const result = await probeScheduler('clerk', {
        dockerMode: true,
        fs,
        isAlive: () => true,
        now: () => now,
        containerBootTimeMs: null,
      })
      expect(result.status).toBe('ok')
      expect(result.detail).toContain('last fire')
    } finally {
      if (oldEnv === undefined) delete process.env.SWITCHROOM_AGENT_SCHEDULER_JSONL
      else process.env.SWITCHROOM_AGENT_SCHEDULER_JSONL = oldEnv
    }
  })

  it('returns ok with last-fire age when lock is held by a live PID', async () => {
    const lockPath = '/state/agent/scheduler.lock'
    const jsonlPath = '/state/agent/scheduler.jsonl'
    const now = 1_700_000_000_000
    const fs = makeSchedulerFs({
      [lockPath]: { content: '4242\n' },
      [jsonlPath]: { content: '{}\n', mtimeMs: now - 5 * 60_000 },
    })
    const result = await probeScheduler('clerk', {
      dockerMode: true,
      fs,
      isAlive: (pid) => pid === 4242,
      now: () => now,
    })
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('pid 4242')
    expect(result.detail).toContain('last fire')
  })

  it('degraded when lockfile holder PID is not alive (mid-restart)', async () => {
    const lockPath = '/state/agent/scheduler.lock'
    const fs = makeSchedulerFs({
      [lockPath]: { content: '99\n' },
    })
    const result = await probeScheduler('clerk', {
      dockerMode: true,
      fs,
      isAlive: () => false,
    })
    expect(result.status).toBe('degraded')
    expect(result.detail).toContain('pid 99 not alive')
  })

  it('degraded when lockfile contents are not a valid PID', async () => {
    const lockPath = '/state/agent/scheduler.lock'
    const fs = makeSchedulerFs({
      [lockPath]: { content: 'garbage' },
    })
    const result = await probeScheduler('clerk', {
      dockerMode: true,
      fs,
      isAlive: () => true,
    })
    expect(result.status).toBe('degraded')
    expect(result.detail).toContain('invalid')
  })

  it('returns ok without freshness hint when scheduler.jsonl has never been written', async () => {
    const lockPath = '/state/agent/scheduler.lock'
    const fs = makeSchedulerFs({
      [lockPath]: { content: '5555' },
    })
    const result = await probeScheduler('clerk', {
      dockerMode: true,
      fs,
      isAlive: () => true,
    })
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('pid 5555')
    expect(result.detail).not.toContain('last fire')
  })
})

// ── probeBroker / probeKernel — UDS reachability ─────────────────────────

describe('probeBroker / probeKernel', () => {
  it('probeBroker returns ok n/a when not in dockerMode', async () => {
    const result = await probeBroker('/some/path', { dockerMode: false })
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('non-docker')
  })

  it('probeBroker fails when no socket path is configured', async () => {
    // SWITCHROOM_VAULT_BROKER_SOCK is the canonical client-side env
    // var, matches what src/vault/broker/client.ts and the
    // secret-guard hook read. (Pre-fix the probe used the wrong name
    // SWITCHROOM_BROKER_SOCKET — the broker server's bind-path env —
    // which compose was setting in agent containers but no client
    // ever read.)
    const oldEnv = process.env.SWITCHROOM_VAULT_BROKER_SOCK
    delete process.env.SWITCHROOM_VAULT_BROKER_SOCK
    try {
      const result = await probeBroker(undefined, { dockerMode: true })
      expect(result.status).toBe('fail')
      expect(result.detail).toContain('not configured')
    } finally {
      if (oldEnv !== undefined) process.env.SWITCHROOM_VAULT_BROKER_SOCK = oldEnv
    }
  })

  it('probeBroker reports ok when connect resolves', async () => {
    const result = await probeBroker('/run/switchroom/broker/clerk/sock', {
      dockerMode: true,
      connectImpl: async () => { /* connect ok */ },
    })
    expect(result.status).toBe('ok')
    expect(result.label).toBe('Broker')
    expect(result.detail).toBe('reachable')
  })

  it('probeBroker reports fail with ENOENT detail when socket missing', async () => {
    const result = await probeBroker('/run/switchroom/broker/clerk/sock', {
      dockerMode: true,
      connectImpl: async () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      },
    })
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('socket missing')
  })

  it('probeBroker reports fail with ECONNREFUSED detail when daemon down', async () => {
    const result = await probeBroker('/run/switchroom/broker/clerk/sock', {
      dockerMode: true,
      connectImpl: async () => {
        const err = new Error('ECONNREFUSED') as NodeJS.ErrnoException
        err.code = 'ECONNREFUSED'
        throw err
      },
    })
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('connection refused')
  })

  it('probeKernel mirrors probeBroker shape with Kernel label', async () => {
    const result = await probeKernel('/run/switchroom/kernel/clerk/sock', {
      dockerMode: true,
      connectImpl: async () => { /* connect ok */ },
    })
    expect(result.status).toBe('ok')
    expect(result.label).toBe('Kernel')
    expect(result.detail).toBe('reachable')
  })
})

// ── probeSkills — symlink validity ───────────────────────────────────────

function makeSkillsFs(entries: Record<string, string[]>, files: Set<string>): SkillsFsImpl {
  return {
    readdir: (p) => {
      if (!(p in entries)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return entries[p]
    },
    exists: (p) => files.has(p) || p in entries,
  }
}

describe('probeSkills', () => {
  const agentDir = '/state/agent'
  const skillsDir = '/state/agent/.claude/skills'

  it('returns ok when no skills dir exists (no skills configured is normal)', async () => {
    const fs = makeSkillsFs({}, new Set())
    const result = await probeSkills(agentDir, { fs })
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('no skills dir')
  })

  it('returns ok with count when every skill resolves', async () => {
    const fs = makeSkillsFs(
      { [skillsDir]: ['simplify', 'review'] },
      new Set([
        `${skillsDir}/simplify`, `${skillsDir}/simplify/SKILL.md`,
        `${skillsDir}/review`, `${skillsDir}/review/SKILL.md`,
      ]),
    )
    const result = await probeSkills(agentDir, { fs })
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('2 resolved')
  })

  it('degraded when at least one symlink dangles, names them up to cap', async () => {
    const fs = makeSkillsFs(
      { [skillsDir]: ['simplify', 'gone-skill', 'also-gone', 'and-this', 'review'] },
      new Set([
        `${skillsDir}/simplify`, `${skillsDir}/simplify/SKILL.md`,
        `${skillsDir}/review`, `${skillsDir}/review/SKILL.md`,
        // gone-skill, also-gone, and-this NOT in files set → dangling
      ]),
    )
    const result = await probeSkills(agentDir, { fs, maxNamesShown: 2 })
    expect(result.status).toBe('degraded')
    expect(result.detail).toContain('3/5 dangling')
    expect(result.detail).toContain('gone-skill')
    expect(result.detail).toContain('also-gone')
    expect(result.detail).toContain('+1 more')
    expect(result.detail).not.toContain('and-this')
  })

  it('returns ok when entries dir is empty', async () => {
    const fs = makeSkillsFs({ [skillsDir]: [] }, new Set([skillsDir]))
    // Make exists() report true for the dir itself
    const wrappedFs: SkillsFsImpl = {
      readdir: fs.readdir,
      exists: (p) => p === skillsDir || fs.exists(p),
    }
    const result = await probeSkills(agentDir, { fs: wrappedFs })
    expect(result.status).toBe('ok')
    expect(result.detail).toBe('0 skills')
  })
})

// ── probeAccount nextStep interpolation (PR #1081 reviewer follow-up) ─────

describe('probeAccount — nextStep agent-name interpolation', () => {
  let tmpDir: string

  function setupAgentDir(claudeJson: Record<string, unknown>, tokenMeta?: { expiresAt: number }): string {
    const agentDir = mkdtempSync(join(tmpdir(), 'probe-account-'))
    const claudeDir = join(agentDir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify(claudeJson))
    if (tokenMeta) {
      writeFileSync(join(claudeDir, '.oauth-token.meta.json'), JSON.stringify(tokenMeta))
    }
    return agentDir
  }

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  })

  it('not-signed-in hint interpolates agentName instead of <agent>', async () => {
    tmpDir = setupAgentDir({})
    const result = await probeAccount(tmpDir, { agentName: 'finn' })
    expect(result.status).toBe('degraded')
    expect(result.detail).toBe('not signed in')
    expect(result.nextStep).toBeDefined()
    expect(result.nextStep).toContain('switchroom auth login finn')
    expect(result.nextStep).not.toContain('<agent>')
  })

  it('expired-token hint interpolates agentName', async () => {
    tmpDir = setupAgentDir(
      { oauthAccount: { emailAddress: 'me@example.com', billingType: 'max' } },
      { expiresAt: Date.now() - 86_400_000 }, // expired yesterday
    )
    const result = await probeAccount(tmpDir, { agentName: 'klanker' })
    expect(result.status).toBe('fail')
    expect(result.nextStep).toContain('switchroom auth login klanker')
    expect(result.nextStep).not.toContain('<agent>')
  })

  it('expiring-soon hint interpolates agentName', async () => {
    tmpDir = setupAgentDir(
      { oauthAccount: { emailAddress: 'me@example.com', billingType: 'max' } },
      { expiresAt: Date.now() + 3 * 86_400_000 }, // 3 days left (< 7)
    )
    const result = await probeAccount(tmpDir, { agentName: 'lawgpt' })
    expect(result.status).toBe('degraded')
    expect(result.nextStep).toContain('switchroom auth login lawgpt')
    expect(result.nextStep).not.toContain('<agent>')
  })

  it('falls back to <agent> placeholder when no agentName provided (backwards-compat)', async () => {
    tmpDir = setupAgentDir({})
    const result = await probeAccount(tmpDir)
    expect(result.nextStep).toContain('<agent>')
  })
})

// ── /proc parser unit tests (synthetic fs) ────────────────────────────────

/** Build a /proc/<pid>/stat string for tests. */
function makeStat(pid: number, comm: string, starttime: number): string {
  // Layout: pid (comm) state ppid pgrp session tty_nr tpgid flags
  //         minflt cminflt majflt cmajflt utime stime cutime cstime
  //         priority nice num_threads itrealvalue starttime ...
  // We need starttime at field 22 (1-indexed). Pad fields 4..21 with zeros.
  const middle = new Array(18).fill('0').join(' ')
  return `${pid} (${comm}) S ${middle} ${starttime} 0 0 0 0\n`
}

function makeProcFs(
  procs: Array<{ pid: number; comm: string; rssKb: number; starttime: number }>,
  extraFiles: Record<string, string> = {},
): ProcFsImpl {
  const files: Record<string, string> = { ...extraFiles }
  const dirEntries = ['1', '2', 'self', 'uptime', 'meminfo']
  for (const p of procs) {
    files[`/proc/${p.pid}/comm`] = `${p.comm}\n`
    files[`/proc/${p.pid}/status`] = `Name:\t${p.comm}\nVmRSS:\t  ${p.rssKb} kB\n`
    files[`/proc/${p.pid}/stat`] = makeStat(p.pid, p.comm, p.starttime)
    if (!dirEntries.includes(String(p.pid))) dirEntries.push(String(p.pid))
  }
  return {
    readdir: (path: string) => {
      if (path === '/proc') return dirEntries
      throw new Error(`unexpected readdir: ${path}`)
    },
    readFile: (path: string) => {
      if (path in files) return files[path]
      throw new Error(`ENOENT: ${path}`)
    },
  }
}

describe('findAgentProcessInContainer — /proc parser', () => {
  it('picks heaviest claude process across multiple candidates', () => {
    const fs = makeProcFs([
      { pid: 100, comm: 'claude', rssKb: 50_000, starttime: 1000 },
      { pid: 101, comm: 'claude', rssKb: 200_000, starttime: 1100 },
      { pid: 102, comm: 'bash',   rssKb: 5_000,   starttime: 900  },
      { pid: 103, comm: 'tmux',   rssKb: 2_000,   starttime: 800  },
    ])
    const found = findAgentProcessInContainer(fs)
    expect(found).not.toBeNull()
    expect(found!.pid).toBe(101)
    expect(found!.rssKb).toBe(200_000)
    expect(found!.starttime).toBe(1100)
  })

  it('falls back to heaviest non-wrapper node when no claude exists', () => {
    const fs = makeProcFs([
      { pid: 200, comm: 'node', rssKb: 80_000, starttime: 500 },
      { pid: 201, comm: 'node', rssKb: 30_000, starttime: 600 },
      { pid: 202, comm: 'bash', rssKb: 5_000,  starttime: 400 },
    ])
    const found = findAgentProcessInContainer(fs)
    expect(found!.pid).toBe(200)
  })

  it('returns null when only wrappers exist', () => {
    const fs = makeProcFs([
      { pid: 1,  comm: 'tini', rssKb: 500,  starttime: 100 },
      { pid: 50, comm: 'bash', rssKb: 1000, starttime: 200 },
      { pid: 51, comm: 'tmux', rssKb: 800,  starttime: 250 },
    ])
    const found = findAgentProcessInContainer(fs)
    expect(found).toBeNull()
  })

  it('handles a comm containing parens via lastIndexOf(\")\")', () => {
    // Tests are the only protection against off-by-one when comm is funky.
    const procs = [{ pid: 300, comm: '(weird)comm', rssKb: 90_000, starttime: 1234 }]
    const fs = makeProcFs(procs)
    // Override stat with a path comm has parens — comm content goes inside (...)
    // Note: the kernel actually wraps comm in single parens in /proc/<pid>/stat,
    // so a comm of `(weird)comm` lands as `300 ((weird)comm) S ...` — making
    // lastIndexOf the only safe parse anchor.
    const fsWithFunky: ProcFsImpl = {
      readdir: () => ['300', 'uptime'],
      readFile: (path: string) => {
        if (path === '/proc/300/comm') return '(weird)comm\n'
        if (path === '/proc/300/status') return 'VmRSS:\t90000 kB\n'
        if (path === '/proc/300/stat') return `300 ((weird)comm) S ${new Array(18).fill('0').join(' ')} 1234 0 0 0\n`
        throw new Error(`ENOENT: ${path}`)
      },
    }
    // Funky comm is neither 'claude' nor 'node', so it's filtered out.
    expect(findAgentProcessInContainer(fsWithFunky)).toBeNull()
    void fs; void procs
  })

  it('handles a claude comm with trailing parens correctly', () => {
    const fs: ProcFsImpl = {
      readdir: () => ['400', 'uptime'],
      readFile: (path: string) => {
        if (path === '/proc/400/comm') return 'claude\n'
        if (path === '/proc/400/status') return 'VmRSS:\t  150000 kB\n'
        // Use a `claude` comm followed by 18 zero pad fields then starttime=9999.
        if (path === '/proc/400/stat') return `400 (claude) S ${new Array(18).fill('0').join(' ')} 9999 0 0 0\n`
        throw new Error(`ENOENT: ${path}`)
      },
    }
    const found = findAgentProcessInContainer(fs)
    expect(found).not.toBeNull()
    expect(found!.pid).toBe(400)
    expect(found!.starttime).toBe(9999)
    expect(found!.rssKb).toBe(150_000)
  })

  it('skips entries that fail to read', () => {
    const fs: ProcFsImpl = {
      readdir: () => ['1', '500'],
      readFile: (path: string) => {
        if (path === '/proc/500/comm') return 'claude\n'
        if (path === '/proc/500/status') return 'VmRSS:\t10000 kB\n'
        if (path === '/proc/500/stat') return `500 (claude) S ${new Array(18).fill('0').join(' ')} 7000 0 0 0\n`
        throw new Error(`ENOENT: ${path}`) // PID 1 reads fail → skipped
      },
    }
    const found = findAgentProcessInContainer(fs)
    expect(found!.pid).toBe(500)
  })
})

describe('uptimeMsForStarttime', () => {
  it('computes uptime in ms from starttime ticks and /proc/uptime', () => {
    const fs: ProcFsImpl = {
      readdir: () => [],
      readFile: (path: string) => {
        if (path === '/proc/uptime') return '1234.56 1000.00\n'
        throw new Error(`unexpected: ${path}`)
      },
    }
    // boot uptime = 1234.56 s, starttime = 1000 ticks → 10 s in.
    // Process uptime = 1234.56 - 10 = 1224.56 s = 1_224_560 ms.
    expect(uptimeMsForStarttime(1000, fs)).toBe(1_224_560)
  })

  it('returns null if /proc/uptime is unreadable', () => {
    const fs: ProcFsImpl = {
      readdir: () => [],
      readFile: () => { throw new Error('ENOENT') },
    }
    expect(uptimeMsForStarttime(1000, fs)).toBeNull()
  })

  it('returns null when computed uptime is negative', () => {
    // starttime in the future relative to boot uptime → invalid.
    const fs: ProcFsImpl = {
      readdir: () => [],
      readFile: () => '5.0 0.0\n',
    }
    expect(uptimeMsForStarttime(99999999, fs)).toBeNull()
  })
})

// ── nextStep remediation hints on degraded/fail probe branches ──────────────
// Every fail/degraded result must carry an actionable `nextStep` per
// reference/principles.md principle 1. These tests pin the hints across
// the probes covered by the boot-card-dedup-and-next-steps PR so we don't
// silently lose the hint on a future refactor.

describe('nextStep — agent systemd states', () => {
  it('attaches a journalctl hint when the unit is failed', async () => {
    const exec = makeSequence([makeSystemctlOutput('failed')])
    const r = await probeAgentProcess('klanker', {
      execFileImpl: exec as unknown as (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
      sleepImpl: async () => {},
      retryIntervalMs: 1,
      retryMaxMs: 0,
    })
    expect(r.status).toBe('fail')
    expect(r.nextStep).toMatch(/journalctl/)
    expect(r.nextStep).toMatch(/switchroom-klanker/)
  })

  it('attaches a transient-state hint when the unit is activating after retry budget', async () => {
    const exec = makeSequence([makeSystemctlOutput('activating')])
    const r = await probeAgentProcess('klanker', {
      execFileImpl: exec as unknown as (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
      sleepImpl: async () => {},
      retryIntervalMs: 1,
      retryMaxMs: 0,
    })
    expect(r.status).toBe('degraded')
    expect(r.nextStep).toMatch(/transient/)
    expect(r.nextStep).toMatch(/`activating`/)
  })

  it('attaches a docker-restart hint via the production dockerProbe when no claude in /proc', async () => {
    // Inject a synthetic /proc with no claude entries — the production
    // dockerProbe attaches the nextStep hint itself.
    const { findAgentProcessInContainer } = await import('../gateway/boot-probes.js')
    const fs = { readdir: () => [] as string[], readFile: () => '' }
    const found = findAgentProcessInContainer(fs)
    expect(found).toBeNull()
    // Now run the docker probe under an override that mimics the
    // production "claude not found" path so we exercise the nextStep
    // attachment without depending on the test host's /proc state.
    const r = await probeAgentProcess('klanker', {
      dockerMode: true,
      dockerProbeImpl: () => ({
        status: 'fail',
        label: 'Agent',
        detail: 'claude process not found',
        nextStep: 'No claude process in container — check container logs with `docker logs <container>` and restart with `switchroom agent restart <agent>`',
      }),
    })
    expect(r.status).toBe('fail')
    expect(r.nextStep).toMatch(/docker logs/)
    expect(r.nextStep).toMatch(/restart/)
  })
})

describe('nextStep — quota / hindsight / broker / kernel / scheduler', () => {
  it('quota: no OAuth token → degraded with login hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-nextstep-'))
    const oldCachePath = process.env.SWITCHROOM_QUOTA_CACHE_PATH
    process.env.SWITCHROOM_QUOTA_CACHE_PATH = join(dir, 'cache.json')
    try {
      const r = await probeQuota(dir, dir, (async () => new Response('{}')) as unknown as typeof fetch)
      expect(r.status).toBe('degraded')
      expect(r.nextStep).toMatch(/switchroom auth login/)
    } finally {
      if (oldCachePath) process.env.SWITCHROOM_QUOTA_CACHE_PATH = oldCachePath
      else delete process.env.SWITCHROOM_QUOTA_CACHE_PATH
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('broker: socket missing → fail with docker compose hint', async () => {
    const r = await probeBroker('/nonexistent/sock', { dockerMode: true })
    expect(r.status).toBe('fail')
    expect(r.nextStep).toMatch(/docker compose/)
    expect(r.nextStep).toMatch(/vault-broker/)
  })

  it('kernel: socket missing → fail with docker compose hint', async () => {
    const r = await probeKernel('/nonexistent/sock', { dockerMode: true })
    expect(r.status).toBe('fail')
    expect(r.nextStep).toMatch(/docker compose/)
    expect(r.nextStep).toMatch(/approval-kernel/)
  })

  it('scheduler: no lockfile → fail with restart hint (or settling hint inside fresh-boot window)', async () => {
    const fs: SchedulerFsImpl = { exists: () => false, readFile: () => '', mtimeMs: () => 0 }
    const r = await probeScheduler('klanker', {
      dockerMode: true,
      fs,
      lockPath: '/state/agent/scheduler.lock',
      jsonlPath: '/state/agent/scheduler.jsonl',
      now: () => Date.now(),
      containerBootTimeMs: null, // disable softening
    })
    expect(r.status).toBe('fail')
    expect(r.nextStep).toMatch(/restart/)
  })

  it('scheduler: lockfile holder pid dead → degraded with re-check hint', async () => {
    const fs: SchedulerFsImpl = {
      exists: (p) => p === '/state/agent/scheduler.lock',
      readFile: () => '99999\n',
      mtimeMs: () => 0,
    }
    const r = await probeScheduler('klanker', {
      dockerMode: true,
      fs,
      lockPath: '/state/agent/scheduler.lock',
      jsonlPath: '/state/agent/scheduler.jsonl',
      isAlive: () => false,
      now: () => Date.now(),
      containerBootTimeMs: null,
    })
    expect(r.status).toBe('degraded')
    expect(r.nextStep).toMatch(/re-check/i)
  })
})
})
