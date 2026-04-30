/**
 * Unit tests for boot-probes fixes.
 *
 * Covers:
 *   - #208: probeAgentProcess — deactivating → 🟡 (not 🔴), re-probe loop
 *   - #210: probeQuota — 429 → ok-with-note + 30 s cache
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  probeAgentProcess,
  probeQuota,
  watchAgentProcess,
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
})
