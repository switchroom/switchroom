import { describe, expect, it } from 'vitest'
import { createSendGate, type Clock } from './send-gate.js'
import { isFloodWaitActiveError } from './retry-api-call.js'

/**
 * Deterministic tests for #3084 PR 2 — priority shedding, degraded mode, and
 * restart-proof flood windows (part3-design §2/§3/§7). Same fake-clock pattern
 * as send-gate.test.ts; every assertion checks an OUTCOME (a send happened /
 * was shed / expired / failed fast; a window survived a round-trip), not a
 * code path.
 */
class FakeClock implements Clock {
  private cur = 0
  private seq = 0
  private timers: { at: number; id: number; resolve: () => void }[] = []

  now(): number {
    return this.cur
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.cur + ms, id: this.seq++, resolve })
    })
  }

  async advance(ms: number): Promise<void> {
    // Flush first so any async chain that hasn't yet registered its next sleep
    // (e.g. a critical send suspended on the serialize mutex's microtask) gets
    // a chance to register before we walk time forward.
    await flush()
    const target = this.cur + ms
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) break
      const t = due[0]
      this.timers = this.timers.filter((x) => x !== t)
      this.cur = t.at
      t.resolve()
      await flush()
    }
    this.cur = target
  }
}

function flush(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r))
}

function recorder(clock: FakeClock) {
  const calls: { label: string; at: number }[] = []
  const fn = (label: string) => async () => {
    calls.push({ label, at: clock.now() })
    return label
  }
  return { calls, fn }
}

// A future window well beyond the fail-fast ceiling.
const HOUR = 3_600_000

describe('send-gate PR2: cosmetic shedding', () => {
  it('sheds a cosmetic send when a flood window covers its scope', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      initialWindows: [{ scopeKey: 'global', untilTs: HOUR }],
    })

    const res = await gate.gate(fn('cosmetic'), { priorityClass: 'cosmetic' })

    // Shed resolves undefined; fn never ran; the shed counter moved.
    expect(res).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(gate.stats().global.shed).toBe(1)
    expect(gate.stats().global.sent).toBe(0)
  })

  it('sheds a cosmetic send when no token is immediately free', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // Per-chat bucket burst 1, so the 2nd immediate cosmetic has no token.
    const gate = createSendGate({
      enabled: true,
      clock,
      perChatBurst: 1,
      perChatPerSec: 1,
    })

    await gate.gate(fn('a'), { chat_id: '5', priorityClass: 'cosmetic' })
    const shed = await gate.gate(fn('b'), { chat_id: '5', priorityClass: 'cosmetic' })

    expect(calls.map((c) => c.label)).toEqual(['a'])
    expect(shed).toBeUndefined()
    expect(gate.stats().global.shed).toBe(1)
  })

  it('does NOT shed a cosmetic send when a token is free and no window is open', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock })

    await gate.gate(fn('a'), { priorityClass: 'cosmetic' })

    expect(calls.map((c) => c.label)).toEqual(['a'])
    expect(gate.stats().global.shed).toBe(0)
    expect(gate.stats().global.sent).toBe(1)
  })

  it('sheds a cosmetic EDIT while the message-edit window is open', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      initialWindows: [{ scopeKey: 'msg-edit:42', untilTs: HOUR }],
    })

    const res = await gate.gate(fn('edit'), {
      messageId: 42,
      editPayload: 'v1',
      priorityClass: 'cosmetic',
    })

    expect(res).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(gate.stats().global.shed).toBe(1)
  })
})

describe('send-gate PR2: useful TTL expiry', () => {
  it('drops a useful send that cannot be admitted before its TTL', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // Global bucket blocked by a 5-minute window; useful TTL is 120s < window.
    const gate = createSendGate({
      enabled: true,
      clock,
      usefulTtlMs: 120_000,
      initialWindows: [{ scopeKey: 'global', untilTs: 300_000 }],
    })

    const p = gate.gate(fn('useful'), { priorityClass: 'useful' })
    // Walk past the TTL but not past the window.
    await clock.advance(130_000)
    const res = await p

    expect(res).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(gate.stats().global.expired).toBe(1)
    expect(gate.stats().global.sent).toBe(0)
  })

  it('admits a useful send that clears before its TTL', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // Window clears at 30s, inside the 120s useful TTL.
    const gate = createSendGate({
      enabled: true,
      clock,
      usefulTtlMs: 120_000,
      initialWindows: [{ scopeKey: 'global', untilTs: 30_000 }],
    })

    const p = gate.gate(fn('useful'), { priorityClass: 'useful' })
    await clock.advance(31_000)
    const res = await p

    expect(res).toBe('useful')
    expect(calls.map((c) => c.label)).toEqual(['useful'])
    expect(gate.stats().global.expired).toBe(0)
    expect(gate.stats().global.sent).toBe(1)
  })
})

describe('send-gate PR2: critical degraded mode', () => {
  it('fails fast with a structured FLOOD_WAIT_ACTIVE when the window exceeds the ceiling', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      criticalFailFastMs: 60_000,
      // 10-minute window >> 60s ceiling.
      initialWindows: [{ scopeKey: 'global', untilTs: 600_000 }],
    })

    let caught: unknown
    try {
      await gate.gate(fn('critical'), { priorityClass: 'critical' })
    } catch (err) {
      caught = err
    }

    expect(isFloodWaitActiveError(caught)).toBe(true)
    const e = caught as { untilTs: number; retryAfterSec: number; error_code: number }
    expect(e.error_code).toBe(429)
    expect(e.untilTs).toBe(600_000)
    expect(e.retryAfterSec).toBe(600)
    expect(calls).toHaveLength(0) // never probed the API
    expect(gate.stats().global.failedFast).toBe(1)
  })

  it('waits out a SHORT window (<= ceiling) then sends the critical, single in-flight with jitter', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      criticalFailFastMs: 60_000,
      criticalJitterMaxMs: 100,
      jitter: () => 0.5, // deterministic 50ms jitter
      // 30s window, under the 60s fail-fast ceiling.
      initialWindows: [{ scopeKey: 'global', untilTs: 30_000 }],
    })

    const p = gate.gate(fn('critical'), { priorityClass: 'critical' })
    await clock.advance(31_000)
    const res = await p

    expect(res).toBe('critical')
    expect(calls).toHaveLength(1)
    // Sent AFTER the window cleared (>= 30s), never during it.
    expect(calls[0]!.at).toBeGreaterThanOrEqual(30_000)
    expect(gate.stats().global.failedFast).toBe(0)
    expect(gate.stats().global.sent).toBe(1)
  })

  it('never sheds a critical send under mere token pressure (no window)', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      perChatBurst: 1,
      perChatPerSec: 1,
    })

    await gate.gate(fn('a'), { chat_id: '9', priorityClass: 'critical' })
    const p = gate.gate(fn('b'), { chat_id: '9', priorityClass: 'critical' })
    await clock.advance(1000) // one token refills
    const res = await p

    expect(res).toBe('b')
    expect(calls.map((c) => c.label)).toEqual(['a', 'b'])
    expect(gate.stats().global.shed).toBe(0)
  })
})

describe('send-gate PR2: flag-off passthrough of the new machinery', () => {
  it('never sheds / expires / fails fast when disabled, even with an open window', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: false,
      clock,
      initialWindows: [{ scopeKey: 'global', untilTs: HOUR }],
    })

    // Cosmetic (would shed), useful (would risk TTL), critical (would fail fast)
    // — all must run immediately at t=0 with zero counter movement.
    const c = await gate.gate(fn('cosmetic'), { priorityClass: 'cosmetic' })
    const u = await gate.gate(fn('useful'), { priorityClass: 'useful' })
    const cr = await gate.gate(fn('critical'), { priorityClass: 'critical' })

    expect([c, u, cr]).toEqual(['cosmetic', 'useful', 'critical'])
    expect(calls.every((x) => x.at === 0)).toBe(true)
    const s = gate.stats().global
    expect([s.shed, s.expired, s.failedFast, s.sent]).toEqual([0, 0, 0, 0])
  })
})

describe('send-gate PR2: edit call-site wiring (progress/answer-stream shape)', () => {
  it('coalesces rapid cosmetic edits to one message into a single last-write-wins send', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // Buckets ample; behaviour driven by the per-message edit floor.
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })

    // v1 sends immediately (cold message). v2, v3 arrive within the floor and
    // coalesce — only the LAST (v3) is sent when the floor clears. This is the
    // exact shape the wired progress-card / answer-stream edit sites produce:
    // messageId + editPayload + priorityClass:'cosmetic'.
    const p1 = gate.gate(fn('v1'), { messageId: 99, editPayload: 'v1', priorityClass: 'cosmetic' })
    await flush()
    const p2 = gate.gate(fn('v2'), { messageId: 99, editPayload: 'v2', priorityClass: 'cosmetic' })
    const p3 = gate.gate(fn('v3'), { messageId: 99, editPayload: 'v3', priorityClass: 'cosmetic' })
    await clock.advance(1600)
    await Promise.all([p1, p2, p3])

    // Two API calls total: v1 (cold) and v3 (coalesced winner). v2 dropped.
    expect(calls.map((c) => c.label)).toEqual(['v1', 'v3'])
    expect(gate.stats().global.coalesced).toBe(1)
    expect(gate.stats().global.sent).toBe(2)
  })
})

describe('send-gate PR2: opening a window from a 429, and persistence hook', () => {
  it('opens scope windows via onWindowOpen when a non-edit send throws FLOOD_WAIT_ACTIVE', async () => {
    const clock = new FakeClock()
    const opened: { scopeKey: string; untilTs: number }[] = []
    const gate = createSendGate({
      enabled: true,
      clock,
      onWindowOpen: (scopeKey, untilTs) => opened.push({ scopeKey, untilTs }),
    })

    const floodErr = Object.assign(new Error('FLOOD_WAIT_ACTIVE'), {
      retryAfterSec: 100,
      untilTs: 100_000,
      error_code: 429 as const,
      parameters: { retry_after: 100 },
      original: null,
    })

    await expect(
      gate.gate(
        async () => {
          throw floodErr
        },
        { chat_id: '7', chatType: 'supergroup', messageId: 3, priorityClass: 'critical' },
      ),
    ).rejects.toBe(floodErr)

    const scopes = opened.map((o) => o.scopeKey).sort()
    expect(scopes).toEqual(['chat:7', 'global', 'group:7', 'msg-edit:3'])
    // After the window opens, a later cosmetic on the same chat sheds.
    const shed = await gate.gate(async () => 'x', { chat_id: '7', priorityClass: 'cosmetic' })
    expect(shed).toBeUndefined()
    expect(gate.stats().global.shed).toBe(1)
  })
})
