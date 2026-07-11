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
    // 2/sec → burst 2, one token every 500ms.
    const gate = createSendGate({ enabled: true, clock, globalPerSec: 2, globalBurst: 2 })

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
      perGroupBurst: 2,
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
    const gate = createSendGate({ enabled: true, clock, globalPerSec: 25, globalBurst: 25 })

    await gate.gate(fn('a'), { chat_id: 'Z' })
    const s = gate.stats()
    expect(s.enabled).toBe(true)
    expect(s.global.sent).toBe(1)
    // One token consumed from a 25-capacity global bucket.
    expect(s.fill.global).toBeCloseTo(24, 5)
    expect(s.fill.perChat['Z']).toBeCloseTo(2, 5) // burst 3, one consumed
  })
})

describe('send-gate: error / rejection path (H1, M1)', () => {
  it('rejects the failing edit and still sends a newer edit that arrived mid-flight (H1)', async () => {
    const clock = new FakeClock()
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 100

    // First edit sends immediately (no prior edit) then suspends on the network
    // await — a controllable deferred stands in for the in-flight send.
    let rejectV1!: (e: unknown) => void
    const v1Fn = () => new Promise<string>((_res, rej) => (rejectV1 = rej))
    const p1 = gate.gate(v1Fn, { messageId: msg, editPayload: 'v1' })
    await flush() // v1 admitted, fn() called, now suspended in-flight

    // A DISTINCT edit arrives while v1 is in-flight → must coalesce, not fire.
    const v2Calls: number[] = []
    const v2Fn = async () => {
      v2Calls.push(clock.now())
      return 'v2-result'
    }
    const p2 = gate.gate(v2Fn, { messageId: msg, editPayload: 'v2' })
    await flush()
    expect(v2Calls.length).toBe(0) // v2 has NOT fired in parallel

    // v1's send rejects — its OWN promise must reject (never orphaned onto v2).
    const err = new Error('boom')
    rejectV1(err)
    await expect(p1).rejects.toBe(err)

    // After the floor, v2 fires exactly once and resolves with v2's own result.
    await clock.advance(1500)
    await expect(p2).resolves.toBe('v2-result')
    expect(v2Calls.length).toBe(1)
    expect(gate.stats().global.sent).toBe(1) // only v2 counted as sent (v1 failed)
  })

  it('retries an identical payload after a FAILED edit (M1)', async () => {
    const clock = new FakeClock()
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 200

    const fail = async () => {
      throw new Error('nope')
    }
    await expect(gate.gate(fail, { messageId: msg, editPayload: 'X' })).rejects.toThrow('nope')

    await clock.advance(1500) // clear the floor

    // Identical payload retry MUST hit the API — a failed send never records
    // lastHash, so it is not dropped as a phantom no-op.
    const sentAt: number[] = []
    const ok = async () => {
      sentAt.push(clock.now())
      return true
    }
    const r = await gate.gate(ok, { messageId: msg, editPayload: 'X' })
    expect(r).toBe(true)
    expect(sentAt.length).toBe(1)
    expect(gate.stats().global.dropped).toBe(0)
  })
})

describe('send-gate: per-message serialization (M3, M4)', () => {
  it('serializes two same-tick edits: one now, one after the floor (M3)', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 300

    const pa = gate.gate(fn('a'), { messageId: msg, editPayload: 'a' })
    const pb = gate.gate(fn('b'), { messageId: msg, editPayload: 'b' }) // same tick
    await flush()

    // Only ONE edit fired inside the floor — no same-tick double send.
    expect(calls.map((c) => c.label)).toEqual(['a'])

    await clock.advance(1500)
    await Promise.all([pa, pb])
    expect(calls.map((c) => c.label)).toEqual(['a', 'b'])
    expect(calls.find((c) => c.label === 'b')?.at).toBe(1500)
  })

  it('coalesces edits behind an in-flight send sleeping on retry_after (M4)', async () => {
    const clock = new FakeClock()
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 400

    // The in-flight send simulates robustApiCall sleeping on a 429 retry_after
    // INSIDE the wrapped fn.
    const started: number[] = []
    const v1 = async () => {
      started.push(clock.now())
      await clock.sleep(5000)
      return 'v1'
    }
    const p1 = gate.gate(v1, { messageId: msg, editPayload: 'v1' })
    await flush()
    expect(started.length).toBe(1) // v1 in-flight, sleeping on retry_after

    // Two edits arrive while v1 sleeps → must coalesce into ONE follow-up.
    const seen: string[] = []
    const mk = (label: string) => async () => {
      seen.push(label)
      return label
    }
    const p2 = gate.gate(mk('v2'), { messageId: msg, editPayload: 'v2' })
    const p3 = gate.gate(mk('v3'), { messageId: msg, editPayload: 'v3' })
    await flush()
    expect(seen).toEqual([]) // nothing fired in parallel with the in-flight send

    await clock.advance(5000) // v1's retry_after elapses → v1 resolves
    await p1
    await Promise.all([p2, p3])

    // Exactly ONE follow-up send carrying the LAST payload (v3); v2 coalesced.
    expect(seen).toEqual(['v3'])
    expect(gate.stats().global.coalesced).toBe(1)
  })
})

describe('send-gate: bucket burst math (M2)', () => {
  it('bounds burst to capacity and holds sustained rate at the budget over windows', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // 25/sec sustained, small burst 5 (headroom under Telegram's ~30/s).
    const gate = createSendGate({
      enabled: true,
      clock,
      globalPerSec: 25,
      globalBurst: 5,
      perChatPerSec: 1000,
      perChatBurst: 1000,
    })

    const ps: Promise<unknown>[] = []
    for (let i = 0; i < 120; i++) ps.push(gate.gate(fn(String(i))))
    await flush()

    // Burst: only `globalBurst` admitted at t=0 — NOT a full window's budget.
    expect(calls.filter((c) => c.at === 0).length).toBe(5)

    await clock.advance(6000)
    await Promise.all(ps)

    const times = calls.map((c) => c.at).sort((a, b) => a - b)
    let maxAny = 0
    let maxSustained = 0
    for (const t of times) {
      const inWin = times.filter((x) => x >= t && x < t + 1000).length
      maxAny = Math.max(maxAny, inWin)
      if (t >= 1000) maxSustained = Math.max(maxSustained, inWin) // past the burst
    }
    // Any 1s window ≤ budget + burst (never ~2x the budget); sustained windows
    // hold to the budget (+1 for a fractional token straddling the edge).
    expect(maxAny).toBeLessThanOrEqual(25 + 5)
    expect(maxSustained).toBeLessThanOrEqual(26)
  })

  it('holds a per-group ceiling near budget/min, not ~2x (M2)', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      globalPerSec: 1000,
      globalBurst: 1000,
      perChatPerSec: 1000,
      perChatBurst: 1000,
      perGroupPerMin: 18,
      perGroupBurst: 2,
    })
    const g = { chat_id: 'G', chatType: 'supergroup' as const }

    const ps: Promise<unknown>[] = []
    for (let i = 0; i < 50; i++) ps.push(gate.gate(fn(String(i)), g))
    await flush()

    expect(calls.filter((c) => c.at === 0).length).toBe(2) // burst 2, not 18

    await clock.advance(200_000)
    await Promise.all(ps)

    const times = calls.map((c) => c.at).sort((a, b) => a - b)
    let maxMinute = 0
    for (const t of times) {
      if (t < 60_000) continue // skip the burst-inclusive first minute
      const inWin = times.filter((x) => x >= t && x < t + 60_000).length
      maxMinute = Math.max(maxMinute, inWin)
    }
    expect(maxMinute).toBeLessThanOrEqual(19) // ~18/min sustained, never ~35
  })
})

describe('send-gate: editPayload undefined (L2)', () => {
  it('does not throw when editPayload is undefined; treats a repeat as a no-op', async () => {
    const clock = new FakeClock()
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const sent: number[] = []
    const fn = async () => {
      sent.push(1)
      return 'ok'
    }

    const r = await gate.gate(fn, { messageId: 7, editPayload: undefined })
    expect(r).toBe('ok')
    expect(sent.length).toBe(1)

    await clock.advance(1500)
    const r2 = await gate.gate(fn, { messageId: 7, editPayload: undefined })
    expect(r2).toBeUndefined() // identical (undefined) payload → no-op skip
    expect(gate.stats().global.dropped).toBe(1)
  })
})

describe('send-gate: perMessage eviction (H2)', () => {
  it('evicts idle message states after the TTL', async () => {
    const clock = new FakeClock()
    const { fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500, messageStateTtlMs: 10_000 })

    await gate.gate(fn('a'), { messageId: 1, editPayload: 'a' })
    expect(gate.stats().messageStates).toBe(1)

    // Past the TTL, a touch on a DIFFERENT message triggers the sweep.
    await clock.advance(20_000)
    await gate.gate(fn('b'), { messageId: 2, editPayload: 'b' })

    // msg 1 is idle + older than the TTL → swept; only msg 2 remains.
    expect(gate.stats().messageStates).toBe(1)
  })

  it('enforces a hard LRU cap on live message states', async () => {
    const clock = new FakeClock()
    const { fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      editFloorMs: 1,
      globalPerSec: 1000, // global bucket not the limiter here
      globalBurst: 1000,
      maxMessageStates: 3,
    })

    for (let i = 0; i < 10; i++) {
      await gate.gate(fn('m' + i), { messageId: i, editPayload: 'p' + i })
      await clock.advance(2) // clear the tiny floor so each state is idle/evictable
    }
    expect(gate.stats().messageStates).toBeLessThanOrEqual(3)
  })
})

describe('send-gate: flood windows + boot ramp (L3 / §7 hook)', () => {
  it('an open flood window blocks admission until untilTs (openFloodWindow)', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock })

    gate.openFloodWindow('global', 5000)

    const p = gate.gate(fn('a'))
    await flush()
    expect(calls.length).toBe(0) // suppressed despite a full token bucket

    await clock.advance(5000)
    await p
    expect(calls.map((c) => c.at)).toEqual([5000]) // fires exactly when the window clears
  })

  it('re-opens flood windows passed at construction (initialWindows)', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      initialWindows: [{ scopeKey: 'chat:C', untilTs: 3000 }],
    })

    const p = gate.gate(fn('a'), { chat_id: 'C' })
    await flush()
    expect(calls.length).toBe(0) // chat:C suppressed

    // A different chat is unaffected by C's window.
    await gate.gate(fn('other'), { chat_id: 'D' })
    expect(calls.map((c) => c.label)).toEqual(['other'])

    await clock.advance(3000)
    await p
    expect(calls.find((c) => c.label === 'a')?.at).toBe(3000)
  })

  it('starts the global bucket at a fraction of capacity during the boot ramp', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // Burst 10, but ramped to 50% (=5) for the first 10s.
    const gate = createSendGate({
      enabled: true,
      clock,
      globalPerSec: 1000, // rate not the limiter; isolate the ramped burst
      globalBurst: 10,
      bootRamp: { fraction: 0.5, durationMs: 10_000 },
    })

    const ps: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) ps.push(gate.gate(fn(String(i))))
    await flush()
    // Only the ramped burst (5 = 50% of 10) admits immediately at boot.
    expect(calls.filter((c) => c.at === 0).length).toBe(5)

    await clock.advance(11_000)
    await Promise.all(ps)

    // After the ramp window, the full burst capacity is available again.
    const gate2 = createSendGate({
      enabled: true,
      clock,
      globalPerSec: 1000,
      globalBurst: 10,
      // ramp already elapsed relative to this clock's now (11_000 > 10_000)
      bootRamp: { fraction: 0.5, durationMs: 0 },
    })
    const { calls: c2, fn: fn2 } = recorder(clock)
    const ps2: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) ps2.push(gate2.gate(fn2(String(i))))
    await flush()
    await Promise.all(ps2)
    expect(c2.filter((c) => c.at === 11_000).length).toBe(10) // full burst, no ramp
  })
})
