import { describe, expect, it } from 'vitest'
import { createSendGate, sendGateEnabledFromEnv, type Clock } from './send-gate.js'

/**
 * Deterministic fake clock. `sleep()` registers a wake at `now + ms`;
 * `advance(ms)` walks time forward, resolving due timers in (time, insertion)
 * order and flushing microtasks between each so continuations can register the
 * next sleep before we advance further. No real timers, no `Date.now()` — the
 * scheduler is fully driven by the test.
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

/** Flush all pending microtasks (real macrotask hop; no fake timers involved). */
function flush(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r))
}

interface Rec {
  label: string
  at: number
}

function recorder(clock: FakeClock) {
  const calls: Rec[] = []
  const fn = (label: string) => async () => {
    calls.push({ label, at: clock.now() })
    return label
  }
  return { calls, fn }
}

describe('send-gate: feature flag', () => {
  it('passes straight through and never delays when disabled', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: false, clock, globalPerSec: 1 })

    // Fire far more than any bucket would allow; all must run immediately.
    await Promise.all([gate.gate(fn('a')), gate.gate(fn('b')), gate.gate(fn('c'))])

    expect(calls.map((c) => c.label).sort()).toEqual(['a', 'b', 'c'])
    expect(calls.every((c) => c.at === 0)).toBe(true)
    // No counters move when the gate is off.
    expect(gate.stats().global.sent).toBe(0)
    expect(gate.stats().enabled).toBe(false)
  })

  it('bypasses the edit floor entirely when disabled', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: false, clock })

    await gate.gate(fn('v1'), { messageId: 7, editPayload: 'v1' })
    await gate.gate(fn('v2'), { messageId: 7, editPayload: 'v2' })

    // Both edits fire at t=0 — no coalescing, no floor.
    expect(calls.map((c) => c.label)).toEqual(['v1', 'v2'])
  })

  it('sendGateEnabledFromEnv follows the SWITCHROOM_*=== "1" convention', () => {
    expect(sendGateEnabledFromEnv({} as NodeJS.ProcessEnv)).toBe(false)
    expect(
      sendGateEnabledFromEnv({ SWITCHROOM_TELEGRAM_SEND_GATE: '0' } as unknown as NodeJS.ProcessEnv),
    ).toBe(false)
    expect(
      sendGateEnabledFromEnv({ SWITCHROOM_TELEGRAM_SEND_GATE: '1' } as unknown as NodeJS.ProcessEnv),
    ).toBe(true)
  })
})

describe('send-gate: global bucket', () => {
  it('admits up to capacity immediately, then paces the rest by refill', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // 2/sec → capacity 2, one token every 500ms.
    const gate = createSendGate({ enabled: true, clock, globalPerSec: 2 })

    const p1 = gate.gate(fn('a'))
    const p2 = gate.gate(fn('b'))
    const p3 = gate.gate(fn('c'))
    await flush()

    // First two consume the burst immediately; third is queued.
    expect(calls.map((c) => c.label)).toEqual(['a', 'b'])
    expect(gate.stats().global.queued).toBe(1)

    await clock.advance(500)
    await Promise.all([p1, p2, p3])

    expect(calls.map((c) => c.label)).toEqual(['a', 'b', 'c'])
    expect(calls.find((c) => c.label === 'c')?.at).toBe(500)
    expect(gate.stats().global.sent).toBe(3)
  })
})

describe('send-gate: per-chat bucket', () => {
  it('allows a burst of 3 per chat then paces at 1/sec; other chats are independent', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      globalPerSec: 1000, // global not the limiter here
      perChatPerSec: 1,
      perChatBurst: 3,
    })

    const chatA = { chat_id: 'A' }
    const chatB = { chat_id: 'B' }

    const ps = [
      gate.gate(fn('a1'), chatA),
      gate.gate(fn('a2'), chatA),
      gate.gate(fn('a3'), chatA),
      gate.gate(fn('a4'), chatA), // 4th on A must wait ~1s
      gate.gate(fn('b1'), chatB), // different chat → immediate
    ]
    await flush()

    const now0 = calls.filter((c) => c.at === 0).map((c) => c.label).sort()
    expect(now0).toEqual(['a1', 'a2', 'a3', 'b1'])
    expect(calls.some((c) => c.label === 'a4')).toBe(false)

    await clock.advance(1000)
    await Promise.all(ps)

    expect(calls.find((c) => c.label === 'a4')?.at).toBe(1000)
  })
})

describe('send-gate: per-group bucket', () => {
  it('keys a per-group ceiling on chat type and paces group traffic by the minute', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      globalPerSec: 1000,
      perChatPerSec: 1000,
      perChatBurst: 1000, // neither global nor per-chat is the limiter
      perGroupPerMin: 2, // 2/min → one token every 30s
    })

    const group = { chat_id: 'G', chatType: 'supergroup' as const }

    const ps = [
      gate.gate(fn('g1'), group),
      gate.gate(fn('g2'), group),
      gate.gate(fn('g3'), group), // 3rd waits 30s
    ]
    await flush()

    expect(calls.map((c) => c.label).sort()).toEqual(['g1', 'g2'])

    await clock.advance(30_000)
    await Promise.all(ps)

    expect(calls.find((c) => c.label === 'g3')?.at).toBe(30_000)
  })

  it('does NOT apply the per-group bucket to private chats', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      globalPerSec: 1000,
      perChatPerSec: 1000,
      perChatBurst: 1000,
      perGroupPerMin: 1, // would block the 2nd if it applied
    })

    const dm = { chat_id: 'P', chatType: 'private' as const }
    await Promise.all([gate.gate(fn('p1'), dm), gate.gate(fn('p2'), dm)])

    // Both private-chat sends land at t=0 — the group bucket never engages.
    expect(calls.map((c) => c.at)).toEqual([0, 0])
  })
})

describe('send-gate: same-message edit floor + coalescing', () => {
  it('coalesces edits within the floor and sends ONLY the last payload', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 42

    // First edit fires immediately (no prior edit).
    await gate.gate(fn('v1'), { messageId: msg, editPayload: 'v1' })
    expect(calls.map((c) => c.label)).toEqual(['v1'])

    // Two more edits arrive within the 1.5s floor → the second replaces the
    // first pending payload (last-write-wins), never queues behind it.
    const p2 = gate.gate(fn('v2'), { messageId: msg, editPayload: 'v2' })
    const p3 = gate.gate(fn('v3'), { messageId: msg, editPayload: 'v3' })
    await flush()

    // Nothing new has hit the API yet — still inside the floor.
    expect(calls.map((c) => c.label)).toEqual(['v1'])
    expect(gate.stats().global.coalesced).toBe(1)

    await clock.advance(1500)
    await Promise.all([p2, p3])

    // Exactly ONE additional send, carrying the LAST payload (v3); v2 dropped.
    expect(calls.map((c) => c.label)).toEqual(['v1', 'v3'])
    expect(calls.find((c) => c.label === 'v3')?.at).toBe(1500)
    expect(gate.stats().global.sent).toBe(2)
  })

  it('spaces sequential distinct edits at least the floor apart', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 5

    await gate.gate(fn('a'), { messageId: msg, editPayload: 'a' })
    const p = gate.gate(fn('b'), { messageId: msg, editPayload: 'b' })
    await flush()
    expect(calls.map((c) => c.label)).toEqual(['a']) // b waits for the floor

    await clock.advance(1500)
    await p
    expect(calls.find((c) => c.label === 'b')?.at).toBe(1500)
  })
})

describe('send-gate: no-op edit skip', () => {
  it('drops an identical repeat payload without calling the API', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 9

    await gate.gate(fn('x1'), { messageId: msg, editPayload: { text: 'same' } })
    await clock.advance(1500) // clear the floor

    // Identical rendered payload → dropped before the API.
    const r = await gate.gate(fn('x2'), { messageId: msg, editPayload: { text: 'same' } })
    expect(r).toBeUndefined()
    expect(calls.map((c) => c.label)).toEqual(['x1'])
    expect(gate.stats().global.dropped).toBe(1)
    expect(gate.stats().global.sent).toBe(1)
  })

  it('drops a repeat of the on-screen payload even while another edit is queued', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 11

    await gate.gate(fn('A'), { messageId: msg, editPayload: 'A' }) // sends A (on screen)
    const p2 = gate.gate(fn('B'), { messageId: msg, editPayload: 'B' }) // queued within floor
    // A repeat of the on-screen payload (A) is a no-op → dropped immediately,
    // and must NOT clobber the genuinely-different queued edit (B).
    const p3 = await gate.gate(fn('A2'), { messageId: msg, editPayload: 'A' })
    expect(p3).toBeUndefined()

    await clock.advance(1500)
    await p2

    // A ran, the no-op repeat dropped, B still sends after the floor.
    expect(calls.map((c) => c.label)).toEqual(['A', 'B'])
    expect(gate.stats().global.sent).toBe(2)
    expect(gate.stats().global.dropped).toBe(1)
  })
})

describe('send-gate: stats getter', () => {
  it('exposes counters and live bucket fill', async () => {
    const clock = new FakeClock()
    const { fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, globalPerSec: 25 })

    await gate.gate(fn('a'), { chat_id: 'Z' })
    const s = gate.stats()
    expect(s.enabled).toBe(true)
    expect(s.global.sent).toBe(1)
    // One token consumed from a 25-capacity global bucket.
    expect(s.fill.global).toBeCloseTo(24, 5)
    expect(s.fill.perChat['Z']).toBeCloseTo(2, 5) // burst 3, one consumed
  })
})
