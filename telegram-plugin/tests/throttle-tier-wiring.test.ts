/**
 * Tests for gateway/throttle-tier-wiring.ts — the 429 throttle tier's
 * side-effect runner, driven with fully injected deps (no gateway import).
 *
 * Pins the OUTCOMES the wiring promises:
 *  - EVERY fire reaches the broker's mark-throttled (the escalation counter),
 *    even when the user-facing notice is cooldown-suppressed;
 *  - ONE notice per account per window, deduped locally AND fleet-wide via
 *    the broker claim verb (denied claim → no send; claim error → fail open);
 *  - the retry nudge is armed at throttled_until + slack + jitter, replaced
 *    (not stacked) by a newer throttle, and at FIRE time:
 *      - restarts when idle and the resume gate says 'resume';
 *      - DEFERS to the turn-complete drain when the in-flight gate is held
 *        by the dead throttled turn (never SIGTERM-now under a live turn);
 *      - SKIPS entirely when a NEWER turn (started after the throttle was
 *        armed) is live — restarting would kill live work and boot-resume
 *        would replay the WRONG turn;
 *  - the escalated outcome posts the corroborated-wall announcement (fleet-
 *    deduped) and nudges the resume immediately through the same guards;
 *  - a broker-unreachable fire degrades to notice-only without throwing.
 */

import { describe, it, expect } from 'vitest'
import {
  createThrottleTierRunner,
  THROTTLE_RETRY_NUDGE_SLACK_MS,
  type ThrottleBrokerClient,
  type ThrottleTierRunnerDeps,
} from '../gateway/throttle-tier-wiring.js'

const NOW = Date.UTC(2026, 6, 12, 8, 0, 0)

interface Harness {
  deps: ThrottleTierRunnerDeps
  calls: {
    markThrottled: number[]
    claims: string[]
    notices: Array<{ chatId: string | number; markdown: string }>
    deferrals: string[]
    restarts: string[]
    logs: string[]
    timers: Array<{ ms: number; fn: () => void; cancelled: boolean }>
  }
  clock: { set(ms: number): void }
  fireTimer(idx: number): void
}

function makeHarness(opts: {
  markThrottledResult?:
    | { account: string; throttled_until: number; escalated: boolean; rolledTo?: string | null }
    | 'unreachable'
    | 'throw'
  claimGranted?: (key: string) => boolean | 'throw'
  resumeVerdict?: 'resume' | 'skip-inflight' | 'skip-stale'
  turnInFlight?: () => boolean
  newestTurnStartedAt?: () => number | null
  jitterMs?: number
} = {}): Harness {
  let nowMs = NOW
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
    async markThrottled(until: number) {
      calls.markThrottled.push(until)
      if (opts.markThrottledResult === 'throw') throw new Error('boom')
      const r = opts.markThrottledResult
      if (r && r !== 'unreachable') return r
      return { account: 'alice', throttled_until: until, escalated: false, rolledTo: null }
    },
    async claimNotification(key: string) {
      calls.claims.push(key)
      const g = opts.claimGranted?.(key) ?? true
      if (g === 'throw') throw new Error('claim boom')
      return { granted: g }
    },
  }
  const deps: ThrottleTierRunnerDeps = {
    agentName: 'carrie',
    getBrokerClient: async () =>
      opts.markThrottledResult === 'unreachable' ? null : client,
    listNoticeChats: () => ['111', '222'],
    sendNotice: (chatId, markdown) => calls.notices.push({ chatId, markdown }),
    resumeDecide: () => opts.resumeVerdict ?? 'resume',
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
    jitterMs: () => opts.jitterMs ?? 0,
  }
  return {
    deps,
    calls,
    clock: { set: (ms) => { nowMs = ms } },
    fireTimer(idx: number) {
      const t = calls.timers[idx]
      if (!t || t.cancelled) throw new Error('no live timer at idx ' + idx)
      t.fn()
    },
  }
}

describe('throttle-tier runner — broker mark + notice dedup', () => {
  it('every fire reaches markThrottled; the notice is sent ONCE per cooldown window', async () => {
    const h = makeHarness()
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)
    h.clock.set(NOW + 30_000) // same window
    await runner.fire('carrie', NOW + 90_000, true)

    // Both hits reached the broker (the escalation counter needs them)…
    expect(h.calls.markThrottled).toEqual([NOW + 60_000, NOW + 90_000])
    // …but only ONE notice per chat went out.
    expect(h.calls.notices).toHaveLength(2) // 2 chats × 1 notice
    expect(h.calls.notices.map((n) => n.chatId)).toEqual(['111', '222'])
    expect(h.calls.notices[0].markdown).toContain('alice')
    expect(h.calls.notices[0].markdown).toContain('Rate-limited, staying put')
  })

  it('fleet-wide claim dedup: a denied claim suppresses that chat, an error fails open', async () => {
    const h = makeHarness({
      claimGranted: (key) => (key.endsWith(':111') ? false : 'throw'),
    })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)

    // chat 111 denied (another gateway won the claim), chat 222 errored → open.
    expect(h.calls.claims).toEqual([
      `throttle-notice:alice:111`,
      `throttle-notice:alice:222`,
    ])
    expect(h.calls.notices.map((n) => n.chatId)).toEqual(['222'])
  })

  it('degrades to notice-only when the broker is unreachable (no throw, no claim)', async () => {
    const h = makeHarness({ markThrottledResult: 'unreachable' })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, false)
    expect(h.calls.markThrottled).toHaveLength(0)
    expect(h.calls.claims).toHaveLength(0) // no account → no claim key
    expect(h.calls.notices).toHaveLength(2)
    expect(h.calls.notices[0].markdown).toContain('the active account')
  })

  it('a markThrottled throw is swallowed and the notice still goes out', async () => {
    const h = makeHarness({ markThrottledResult: 'throw' })
    const runner = createThrottleTierRunner(h.deps)
    await expect(runner.fire('carrie', NOW + 60_000, true)).resolves.toBeUndefined()
    expect(h.calls.notices).toHaveLength(2)
  })
})

describe('throttle-tier runner — retry nudge scheduling + turn safety', () => {
  it('arms the nudge at reset + slack + jitter and restarts when idle', async () => {
    const h = makeHarness({ jitterMs: 7_000 })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)

    expect(h.calls.timers).toHaveLength(1)
    expect(h.calls.timers[0].ms).toBe(60_000 + THROTTLE_RETRY_NUDGE_SLACK_MS + 7_000)
    expect(runner.inspect().nudgePending).toBe(true)

    h.fireTimer(0)
    expect(h.calls.restarts).toEqual(['throttle-retry-resume'])
    expect(h.calls.deferrals).toHaveLength(0)
    expect(runner.inspect().nudgePending).toBe(false)
  })

  it('a newer throttle REPLACES the pending nudge instead of stacking restarts', async () => {
    const h = makeHarness()
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)
    await runner.fire('carrie', NOW + 120_000, true)
    expect(h.calls.timers).toHaveLength(2)
    expect(h.calls.timers[0].cancelled).toBe(true)
    expect(h.calls.timers[1].cancelled).toBe(false)
  })

  it('DEFERS to the turn-complete drain when the dead throttled turn still holds the gate', async () => {
    const h = makeHarness({
      turnInFlight: () => true,
      // The in-flight turn started BEFORE the throttle was armed — it IS the
      // dead turn (a 429-killed turn never writes its turn-end marker).
      newestTurnStartedAt: () => NOW - 60_000,
    })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)
    h.fireTimer(0)
    expect(h.calls.restarts).toHaveLength(0) // never SIGTERM-now under a live gate
    expect(h.calls.deferrals).toEqual(['throttle-retry-resume'])
  })

  it('SKIPS entirely when a NEWER live turn supersedes the dead one', async () => {
    let nowAtNudge = NOW
    const h = makeHarness({
      turnInFlight: () => true,
      // Started AFTER the throttle was armed — live user work.
      newestTurnStartedAt: () => nowAtNudge + 30_000,
    })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)
    nowAtNudge = NOW // armedAt == NOW; newest = NOW+30s > armedAt
    h.fireTimer(0)
    expect(h.calls.restarts).toHaveLength(0)
    expect(h.calls.deferrals).toHaveLength(0)
    expect(h.calls.logs.some((l) => l.includes('superseded'))).toBe(true)
  })

  it('honours the shared resume gate verdict (skip-inflight → no restart)', async () => {
    const h = makeHarness({ resumeVerdict: 'skip-inflight' })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)
    h.fireTimer(0)
    expect(h.calls.restarts).toHaveLength(0)
    expect(h.calls.logs.some((l) => l.includes('skip-inflight'))).toBe(true)
  })
})

describe('throttle-tier runner — escalated outcome (corroborated wall)', () => {
  it('posts the fleet-deduped escalation announcement and resumes immediately', async () => {
    const h = makeHarness({
      markThrottledResult: {
        account: 'alice',
        throttled_until: NOW + 60_000,
        escalated: true,
        rolledTo: 'bob',
      },
    })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)

    // Announcement (not the staying-put notice), per chat, claim-deduped.
    expect(h.calls.claims).toEqual([
      `throttle-escalation:alice:111`,
      `throttle-escalation:alice:222`,
    ])
    expect(h.calls.notices).toHaveLength(2)
    expect(h.calls.notices[0].markdown).toContain('actually a wall')
    expect(h.calls.notices[0].markdown).toContain('bob')

    // Immediate resume (fleet just swapped accounts) — no delayed nudge armed.
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
    await runner.fire('carrie', NOW + 60_000, true)
    expect(h.calls.notices[0].markdown).toContain('all blocked')
    expect(h.calls.restarts).toHaveLength(0)
  })

  it('escalated resume respects the live-turn guards too', async () => {
    const h = makeHarness({
      markThrottledResult: {
        account: 'alice',
        throttled_until: NOW + 60_000,
        escalated: true,
        rolledTo: 'bob',
      },
      turnInFlight: () => true,
      newestTurnStartedAt: () => NOW - 60_000, // the dead turn holds the gate
    })
    const runner = createThrottleTierRunner(h.deps)
    await runner.fire('carrie', NOW + 60_000, true)
    expect(h.calls.restarts).toHaveLength(0)
    expect(h.calls.deferrals).toEqual(['throttle-escalation-resume'])
  })
})
