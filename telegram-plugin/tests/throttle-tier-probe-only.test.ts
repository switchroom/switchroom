/**
 * Tests for the generic-transient PROBE-ONLY 429 path (#failover-429-corroborate).
 *
 * This pins the OUTCOMES the gateway promises for a bare `rate_limit_error`
 * (generic-transient) 429 after Ken picked Option A (probe-only):
 *
 *   - generic-transient + HEALTHY probe → the probe's ONLY effect is the
 *     silent broker quota refresh. Account-inert at the runner: NO throttle
 *     notice, NO self-restart nudge, NO `throttled_until` soft-defer, NO second
 *     card. The calm rate-limited card the gateway already emitted stays the
 *     ONLY user-visible output.
 *   - generic-transient + WALL (probe corroborates) → the escalation path runs
 *     exactly like the account-scoped `fire`: the corroborated-wall announcement
 *     posts and the dead turn is resumed. No redundant calm card is emitted from
 *     this branch — the announcement IS the output.
 *   - litellm-local → the runner does NOT fire at all (account-inert by
 *     mechanism, not discipline): the request never reached Anthropic, so
 *     account state must not be touched. `account-scoped` likewise takes its own
 *     `fire` path, not `fireProbeOnly`. Pinned via the pure classification gate
 *     the gateway consults before calling `fireProbeOnly`.
 *
 * The runner side is exercised with fully injected deps (no gateway import),
 * mirroring throttle-tier-wiring.test.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  createThrottleTierRunner,
  type ThrottleBrokerClient,
  type ThrottleTierRunnerDeps,
} from '../gateway/throttle-tier-wiring.js'
import { classification429WarrantsCorroboration } from '../throttle-tier.js'

const NOW = Date.UTC(2026, 6, 12, 8, 0, 0)

interface Harness {
  deps: ThrottleTierRunnerDeps
  calls: {
    markThrottled: Array<{ until: number; probeOnly?: boolean }>
    claims: string[]
    notices: Array<{ chatId: string | number; markdown: string }>
    deferrals: string[]
    restarts: string[]
    logs: string[]
    timers: Array<{ ms: number; fn: () => void; cancelled: boolean }>
  }
}

function makeHarness(opts: {
  markThrottledResult?:
    | { account: string; throttled_until: number; escalated: boolean; rolledTo?: string | null }
    | 'unreachable'
    | 'throw'
  turnInFlight?: () => boolean
  newestTurnStartedAt?: () => number | null
} = {}): Harness {
  const nowMs = NOW
  const calls: Harness['calls'] = {
    markThrottled: [],
    claims: [],
    notices: [],
    deferrals: [],
    restarts: [],
    logs: [],
    timers: [],
  }
  const client: ThrottleBrokerClient = {
    async markThrottled(until: number, probeOnly?: boolean) {
      calls.markThrottled.push({ until, probeOnly })
      if (opts.markThrottledResult === 'throw') throw new Error('boom')
      const r = opts.markThrottledResult
      if (r && r !== 'unreachable') return r
      return { account: 'alice', throttled_until: until, escalated: false, rolledTo: null }
    },
    async claimNotification(key: string) {
      calls.claims.push(key)
      return { granted: true }
    },
  }
  const deps: ThrottleTierRunnerDeps = {
    agentName: 'carrie',
    getBrokerClient: async () =>
      opts.markThrottledResult === 'unreachable' ? null : client,
    listNoticeChats: () => ['111', '222'],
    sendNotice: (chatId, markdown) => calls.notices.push({ chatId, markdown }),
    resumeDecide: () => 'resume',
    newestActiveTurnStartedAtMs: opts.newestTurnStartedAt ?? (() => null),
    turnInFlight: opts.turnInFlight ?? (() => false),
    deferRestartToTurnComplete: (_agent, reason) => calls.deferrals.push(reason),
    restartNow: (_agent, reason) => calls.restarts.push(reason),
    log: (m) => calls.logs.push(m),
    now: () => nowMs,
    schedule: (fn, ms) => {
      const t = { ms, fn, cancelled: false }
      calls.timers.push(t)
      return { cancel: () => { t.cancelled = true } }
    },
    jitterMs: () => 0,
  }
  return { deps, calls }
}

describe('generic-transient probe-only — classification gate (litellm-local never fires)', () => {
  it('fires the corroboration probe ONLY for generic-transient', () => {
    expect(classification429WarrantsCorroboration('generic-transient')).toBe(true)
    // litellm-local: request never reached Anthropic — account-inert by mechanism.
    expect(classification429WarrantsCorroboration('litellm-local')).toBe(false)
    // account-scoped: runs its own throttle tier / failover (fire, not fireProbeOnly).
    expect(classification429WarrantsCorroboration('account-scoped')).toBe(false)
    // null: not a rate-limited event.
    expect(classification429WarrantsCorroboration(null)).toBe(false)
  })
})

describe('generic-transient probe-only — HEALTHY probe is account-inert', () => {
  it('probes the broker but emits NOTHING else (calm card stays the only output)', async () => {
    const h = makeHarness() // default result: escalated:false (healthy)
    const runner = createThrottleTierRunner(h.deps)
    await runner.fireProbeOnly('carrie')

    // The probe reached the broker in probe-only mode…
    expect(h.calls.markThrottled).toHaveLength(1)
    expect(h.calls.markThrottled[0].probeOnly).toBe(true)

    // …but produced NO user-visible or account-mutating side effects:
    expect(h.calls.notices).toHaveLength(0) // no throttle notice, no second card
    expect(h.calls.claims).toHaveLength(0) // no fleet-dedup broadcast at all
    expect(h.calls.restarts).toHaveLength(0) // no self-restart nudge
    expect(h.calls.deferrals).toHaveLength(0)
    expect(h.calls.timers).toHaveLength(0) // no throttled_until soft-defer / retry nudge
    expect(runner.inspect().nudgePending).toBe(false)
  })

  it('a broker-unreachable probe is inert and never throws', async () => {
    const h = makeHarness({ markThrottledResult: 'unreachable' })
    const runner = createThrottleTierRunner(h.deps)
    await expect(runner.fireProbeOnly('carrie')).resolves.toBeUndefined()
    expect(h.calls.markThrottled).toHaveLength(0)
    expect(h.calls.notices).toHaveLength(0)
    expect(h.calls.restarts).toHaveLength(0)
    expect(h.calls.timers).toHaveLength(0)
  })

  it('a markThrottled throw is swallowed and stays inert (no card, no restart)', async () => {
    const h = makeHarness({ markThrottledResult: 'throw' })
    const runner = createThrottleTierRunner(h.deps)
    await expect(runner.fireProbeOnly('carrie')).resolves.toBeUndefined()
    expect(h.calls.notices).toHaveLength(0)
    expect(h.calls.restarts).toHaveLength(0)
    expect(h.calls.timers).toHaveLength(0)
  })
})

describe('generic-transient probe-only — WALL corroborated → escalation', () => {
  it('posts the corroborated-wall announcement and resumes immediately (no calm card, no nudge timer)', async () => {
    const h = makeHarness({
      markThrottledResult: {
        account: 'alice',
        throttled_until: NOW + 60_000,
        escalated: true,
        rolledTo: 'bob',
      },
    })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fireProbeOnly('carrie')

    // Probe ran in probe-only mode, then escalation took over.
    expect(h.calls.markThrottled[0].probeOnly).toBe(true)

    // The escalation announcement (fleet-deduped), NOT the staying-put notice.
    expect(h.calls.claims).toEqual([
      `throttle-escalation:alice:111`,
      `throttle-escalation:alice:222`,
    ])
    expect(h.calls.notices).toHaveLength(2)
    expect(h.calls.notices[0].markdown).toContain('actually a wall')
    expect(h.calls.notices[0].markdown).toContain('bob')

    // Immediate resume via the escalation lever; NO delayed retry nudge armed.
    expect(h.calls.restarts).toEqual(['throttle-escalation-resume'])
    expect(h.calls.timers).toHaveLength(0)
  })

  it('escalated with rolledTo=null (all blocked) announces but does NOT restart', async () => {
    const h = makeHarness({
      markThrottledResult: {
        account: 'alice',
        throttled_until: NOW + 60_000,
        escalated: true,
        rolledTo: null,
      },
    })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fireProbeOnly('carrie')
    expect(h.calls.notices[0].markdown).toContain('all blocked')
    expect(h.calls.restarts).toHaveLength(0)
    expect(h.calls.timers).toHaveLength(0)
  })

  it('escalated resume respects the live-turn guards (defers under the dead turn gate)', async () => {
    const h = makeHarness({
      markThrottledResult: {
        account: 'alice',
        throttled_until: NOW + 60_000,
        escalated: true,
        rolledTo: 'bob',
      },
      turnInFlight: () => true,
      newestTurnStartedAt: () => NOW - 60_000, // the dead turn still holds the gate
    })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fireProbeOnly('carrie')
    expect(h.calls.restarts).toHaveLength(0)
    expect(h.calls.deferrals).toEqual(['throttle-escalation-resume'])
  })
})
