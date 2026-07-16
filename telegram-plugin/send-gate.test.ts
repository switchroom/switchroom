import { describe, expect, it } from 'vitest'
import {
  createSendGate,
  sendGateEnabledFromEnv,
  sendGateConfigFromEnv,
  SEND_GATE_DEFAULTS,
  type Clock,
} from './send-gate.js'

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

  it('sendGateEnabledFromEnv is ON BY DEFAULT (escape hatch, not opt-in)', () => {
    // Unset → enabled. This assertion is load-bearing: it fails if the default
    // is ever flipped back to off.
    expect(sendGateEnabledFromEnv({} as NodeJS.ProcessEnv)).toBe(true)
    expect(
      sendGateEnabledFromEnv({ SWITCHROOM_TELEGRAM_SEND_GATE: undefined } as NodeJS.ProcessEnv),
    ).toBe(true)
  })

  it('sendGateEnabledFromEnv disables only on explicit off values (safety valve)', () => {
    for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off', ' no ', '  0 ']) {
      expect(
        sendGateEnabledFromEnv({
          SWITCHROOM_TELEGRAM_SEND_GATE: off,
        } as unknown as NodeJS.ProcessEnv),
      ).toBe(false)
    }
  })

  it('sendGateEnabledFromEnv stays enabled for any other value', () => {
    for (const on of ['1', 'true', 'on', 'yes', 'enabled', '', 'anything']) {
      expect(
        sendGateEnabledFromEnv({
          SWITCHROOM_TELEGRAM_SEND_GATE: on,
        } as unknown as NodeJS.ProcessEnv),
      ).toBe(true)
    }
  })
})

describe('send-gate: SEND_GATE_DEFAULTS (compile-time default PIN)', () => {
  it('pins the exact default rate limits — a drive-by change fails here', () => {
    // Load-bearing PIN: these are the values createSendGate falls back to when a
    // knob is unset, i.e. today's shipped behaviour. If any of these numbers
    // changes, that is a real behaviour change and must be a deliberate,
    // reviewed edit — not a silent drift. (#3084 send-gate config PR.)
    expect(SEND_GATE_DEFAULTS).toEqual({
      globalPerSec: 25,
      globalBurst: 4,
      perChatPerSec: 1,
      perChatBurst: 3,
      perGroupPerMin: 18,
      perGroupBurst: 2,
      editFloorMs: 1500,
      perMessageEditWindowMs: 300_000,
      perMessageEditMaxPerWindow: 150,
    })
  })
})

describe('send-gate: sendGateConfigFromEnv (yaml → env → createSendGate)', () => {
  const E = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv

  it('maps every SWITCHROOM_TG_SEND_GATE_* env to the exact createSendGate field', () => {
    // The gateway spreads this object straight into createSendGate({...}), so
    // asserting the returned slice IS asserting what createSendGate receives.
    const cfg = sendGateConfigFromEnv(
      E({
        SWITCHROOM_TG_SEND_GATE_ENABLED: '1',
        SWITCHROOM_TG_SEND_GATE_GLOBAL_PER_SEC: '40',
        SWITCHROOM_TG_SEND_GATE_GLOBAL_BURST: '6',
        SWITCHROOM_TG_SEND_GATE_PER_CHAT_PER_SEC: '2',
        SWITCHROOM_TG_SEND_GATE_PER_CHAT_BURST: '5',
        SWITCHROOM_TG_SEND_GATE_PER_GROUP_PER_MIN: '30',
        SWITCHROOM_TG_SEND_GATE_PER_GROUP_BURST: '4',
        SWITCHROOM_TG_SEND_GATE_EDIT_FLOOR_MS: '2000',
        SWITCHROOM_TG_SEND_GATE_PER_MSG_EDIT_WINDOW_MS: '30000',
        SWITCHROOM_TG_SEND_GATE_PER_MSG_EDIT_MAX: '8',
      }),
    )
    expect(cfg).toEqual({
      enabled: true,
      globalPerSec: 40,
      globalBurst: 6,
      perChatPerSec: 2,
      perChatBurst: 5,
      perGroupPerMin: 30,
      perGroupBurst: 4,
      editFloorMs: 2000,
      perMessageEditWindowMs: 30000,
      perMessageEditMaxPerWindow: 8,
    })
  })

  it('per-message edit budget: MAX accepts 0 (disables the backstop); WINDOW must be positive', () => {
    expect(
      sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_PER_MSG_EDIT_MAX: '0' }))
        .perMessageEditMaxPerWindow,
    ).toBe(0)
    // A zero/negative window is malformed → dropped so createSendGate's default applies.
    expect(
      sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_PER_MSG_EDIT_WINDOW_MS: '0' }))
        .perMessageEditWindowMs,
    ).toBeUndefined()
  })

  it('accepts a fractional per-sec rate (rates are not integers)', () => {
    const cfg = sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_PER_CHAT_PER_SEC: '0.5' }))
    expect(cfg.perChatPerSec).toBe(0.5)
  })

  it('unset knobs are ABSENT so createSendGate applies SEND_GATE_DEFAULTS (no behaviour change)', () => {
    const cfg = sendGateConfigFromEnv(E({}))
    // Only enabled is present; every rate field is omitted → default fallback.
    expect(cfg).toEqual({ enabled: true })
    // And the gate built from it actually pours in the pinned defaults.
    const gate = createSendGate({ ...cfg, clock: new FakeClock() })
    // enabled default is ON (escape hatch, not opt-in).
    expect(gate.stats().enabled).toBe(true)
  })

  it('drops malformed / wedge-inducing env values back to the default (defensive net)', () => {
    // The LOUD rejection lives in the Zod config schema; a hand-set bad env must
    // never wedge sends, so it falls back to undefined → compile-time default.
    const cfg = sendGateConfigFromEnv(
      E({
        SWITCHROOM_TG_SEND_GATE_GLOBAL_PER_SEC: '0', // ≤0 → dropped
        SWITCHROOM_TG_SEND_GATE_PER_CHAT_BURST: '-3', // negative → dropped
        SWITCHROOM_TG_SEND_GATE_PER_GROUP_BURST: '2.5', // non-int → dropped
        SWITCHROOM_TG_SEND_GATE_GLOBAL_BURST: 'nonsense', // NaN → dropped
      }),
    )
    expect(cfg).toEqual({ enabled: true })
  })

  it('edit_floor_ms accepts 0 (disables the floor) but not negatives', () => {
    expect(sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_EDIT_FLOOR_MS: '0' })).editFloorMs).toBe(0)
    expect(
      sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_EDIT_FLOOR_MS: '-1' })).editFloorMs,
    ).toBeUndefined()
  })

  it('maps the #3111 conservative-global flood-scope break-glass flag', () => {
    // Unset ⇒ absent (scope-precise default; createSendGate falls back to false).
    expect(
      sendGateConfigFromEnv(E({})).conservativeGlobalFloodScope,
    ).toBeUndefined()
    // On-values ⇒ true (restore pre-#3111 always-open-global posture).
    for (const on of ['1', 'true', 'on', 'yes']) {
      expect(
        sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_CONSERVATIVE_GLOBAL: on }))
          .conservativeGlobalFloodScope,
      ).toBe(true)
    }
    // Off-values ⇒ explicit false.
    expect(
      sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_CONSERVATIVE_GLOBAL: '0' }))
        .conservativeGlobalFloodScope,
    ).toBe(false)
    // Unrecognised ⇒ absent (defensive net).
    expect(
      sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_CONSERVATIVE_GLOBAL: 'nonsense' }))
        .conservativeGlobalFloodScope,
    ).toBeUndefined()
  })

  describe('enabled precedence: break-glass valve > config > default-on', () => {
    it('config send_gate.enabled decides when the env valve is unset', () => {
      expect(sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_ENABLED: '0' })).enabled).toBe(false)
      expect(sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_ENABLED: '1' })).enabled).toBe(true)
      expect(sendGateConfigFromEnv(E({ SWITCHROOM_TG_SEND_GATE_ENABLED: 'off' })).enabled).toBe(false)
    })

    it('the SWITCHROOM_TELEGRAM_SEND_GATE valve ALWAYS wins when explicitly set', () => {
      // valve off beats config on
      expect(
        sendGateConfigFromEnv(
          E({ SWITCHROOM_TELEGRAM_SEND_GATE: '0', SWITCHROOM_TG_SEND_GATE_ENABLED: '1' }),
        ).enabled,
      ).toBe(false)
      // valve on beats config off
      expect(
        sendGateConfigFromEnv(
          E({ SWITCHROOM_TELEGRAM_SEND_GATE: '1', SWITCHROOM_TG_SEND_GATE_ENABLED: '0' }),
        ).enabled,
      ).toBe(true)
    })

    it('both unset ⇒ enabled (ON by default, unchanged)', () => {
      expect(sendGateConfigFromEnv(E({})).enabled).toBe(true)
    })
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

  it('last write reverting to the on-screen payload wins over a queued distinct edit (N1)', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 11

    await gate.gate(fn('A'), { messageId: msg, editPayload: 'A' }) // sends A (on screen)
    const p2 = gate.gate(fn('B'), { messageId: msg, editPayload: 'B' }) // queued within floor
    // The genuinely-LAST write reverts to the on-screen payload (A). Under
    // last-write-wins it must REPLACE the queued distinct edit (B), not be
    // dropped as a no-op while B still renders. The driver's own no-op re-check
    // then drops the coalesced revert, so nothing needless hits the API and the
    // final screen stays A — B never renders.
    const p3 = gate.gate(fn('A2'), { messageId: msg, editPayload: 'A' })

    await clock.advance(1500)
    await Promise.all([p2, p3])
    expect(await p2).toBeUndefined()
    expect(await p3).toBeUndefined()

    // Only A ever hit the API; B was superseded by the A-revert and dropped.
    expect(calls.map((c) => c.label)).toEqual(['A'])
    expect(gate.stats().global.sent).toBe(1)
    expect(gate.stats().global.dropped).toBe(1)
    expect(gate.stats().global.coalesced).toBe(1)
  })

  it('a plain repeat with NO queued edit is dropped immediately as a no-op', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({ enabled: true, clock, editFloorMs: 1500 })
    const msg = 12

    await gate.gate(fn('A'), { messageId: msg, editPayload: 'A' })
    await clock.advance(1500) // floor cleared, nothing queued

    const r = await gate.gate(fn('A2'), { messageId: msg, editPayload: 'A' })
    expect(r).toBeUndefined()
    expect(calls.map((c) => c.label)).toEqual(['A'])
    expect(gate.stats().global.dropped).toBe(1)
    expect(gate.stats().global.sent).toBe(1)
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

describe('send-gate: non-edit send stats (N4)', () => {
  it('does NOT count a throwing non-edit send as sent', async () => {
    const clock = new FakeClock()
    const gate = createSendGate({ enabled: true, clock })

    await expect(
      gate.gate(async () => {
        throw new Error('send failed')
      }),
    ).rejects.toThrow('send failed')

    // The send threw → it must not pollute the `sent` counter.
    expect(gate.stats().global.sent).toBe(0)

    // A subsequent SUCCESSFUL send is counted normally.
    await gate.gate(async () => 'ok')
    expect(gate.stats().global.sent).toBe(1)
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
    // 25/sec sustained, small burst 4 (real headroom under Telegram's ~30/s:
    // worst-case window = 4 + 25 = 29 < 30).
    const gate = createSendGate({
      enabled: true,
      clock,
      globalPerSec: 25,
      globalBurst: 4,
      perChatPerSec: 1000,
      perChatBurst: 1000,
    })

    const ps: Promise<unknown>[] = []
    for (let i = 0; i < 120; i++) ps.push(gate.gate(fn(String(i))))
    await flush()

    // Burst: only `globalBurst` admitted at t=0 — NOT a full window's budget.
    expect(calls.filter((c) => c.at === 0).length).toBe(4)

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
    // Any 1s window ≤ budget + burst = 29 (never ~2x the budget, and strictly
    // UNDER Telegram's ~30/s ceiling); sustained windows hold to the budget
    // (+1 for a fractional token straddling the edge).
    expect(maxAny).toBeLessThanOrEqual(25 + 4)
    expect(maxAny).toBeLessThan(30)
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

  it('opening per-message flood windows honours the LRU cap (N2)', async () => {
    const clock = new FakeClock()
    const gate = createSendGate({ enabled: true, clock, maxMessageStates: 3 })

    // Each openFloodWindow for a distinct msg-edit scope creates a per-message
    // state; it must go through the same eviction accounting so the map never
    // grows past the cap. Windows are in the past so the states stay evictable.
    for (let i = 0; i < 10; i++) gate.openFloodWindow('msg-edit:' + i, -1)

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

describe('send-gate: long-horizon per-message edit budget (backstop)', () => {
  it('paces + coalesces a sustained same-message cosmetic edit stream under the rolling cap', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // Tight, fast budget for a deterministic test: 2 cosmetic edits / 5s window,
    // 1s edit floor. A distinct edit every 1s would sail through the floor
    // forever (this is exactly the sub-1/s flood the backstop exists to stop).
    const gate = createSendGate({
      enabled: true,
      clock,
      editFloorMs: 1000,
      perMessageEditWindowMs: 5000,
      perMessageEditMaxPerWindow: 2,
    })
    const msg = 77
    const attempts = 20
    const promises: Promise<unknown>[] = []
    for (let i = 0; i < attempts; i++) {
      promises.push(
        gate.gate(fn(`v${i}`), { messageId: msg, editPayload: `v${i}`, priorityClass: 'cosmetic' }),
      )
      await flush()
      await clock.advance(1000)
    }
    // Drain any final budget-deferred send (a full window is enough).
    await clock.advance(5000)
    await flush()
    await Promise.allSettled(promises)

    const stats = gate.stats().global
    // The sustained ~1/s stream is paced FAR below the attempt count — bounded
    // by ~2 sends per 5s over the ~25s simulated span, not 20 one-per-second.
    expect(stats.sent).toBeLessThan(attempts)
    expect(stats.sent).toBeLessThanOrEqual(10)
    // The backstop actively deferred at least one edit (not just the 1s floor).
    expect(stats.budgetDeferred).toBeGreaterThan(0)
    // Coalescing collapsed the deferred edits (last-write-wins), so the FINAL
    // send carries the newest payload — no stale body is shown.
    expect(calls[calls.length - 1].label).toBe(`v${attempts - 1}`)
  })

  it('does NOT throttle distinct message_ids — each message gets its own budget', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      editFloorMs: 1000,
      perMessageEditWindowMs: 5000,
      perMessageEditMaxPerWindow: 1,
    })
    // One cosmetic edit to each of two distinct messages at t=0. A per-message
    // budget of 1 must NOT make message B's first edit wait on message A's.
    const pA = gate.gate(fn('A'), { messageId: 1, editPayload: 'A', priorityClass: 'cosmetic' })
    const pB = gate.gate(fn('B'), { messageId: 2, editPayload: 'B', priorityClass: 'cosmetic' })
    await flush()
    await Promise.all([pA, pB])
    expect(calls.map((c) => c.label).sort()).toEqual(['A', 'B'])
    expect(calls.every((c) => c.at === 0)).toBe(true)
    expect(gate.stats().global.budgetDeferred).toBe(0)
  })

  it('does NOT throttle non-cosmetic (useful/untagged) edits of the same message', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    // Budget so tight it would allow only ONE cosmetic edit ever in the span —
    // yet untagged edits default to `useful` and must bypass the budget entirely
    // (only the 1s floor applies). Legitimate stream/draft edits are untouched.
    const gate = createSendGate({
      enabled: true,
      clock,
      editFloorMs: 1000,
      perMessageEditWindowMs: 100_000,
      perMessageEditMaxPerWindow: 1,
    })
    const msg = 9
    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 5; i++) {
      promises.push(gate.gate(fn(`u${i}`), { messageId: msg, editPayload: `u${i}` }))
      await flush()
      await clock.advance(1000)
    }
    await clock.advance(1000)
    await flush()
    await Promise.allSettled(promises)
    // All five distinct useful edits landed (floor-spaced), none budget-deferred.
    expect(gate.stats().global.sent).toBe(5)
    expect(gate.stats().global.budgetDeferred).toBe(0)
    expect(calls.map((c) => c.label)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4'])
  })

  it('disables the backstop when perMessageEditMaxPerWindow is 0', async () => {
    const clock = new FakeClock()
    const { calls, fn } = recorder(clock)
    const gate = createSendGate({
      enabled: true,
      clock,
      editFloorMs: 1000,
      perMessageEditMaxPerWindow: 0,
    })
    const msg = 55
    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 6; i++) {
      promises.push(
        gate.gate(fn(`c${i}`), { messageId: msg, editPayload: `c${i}`, priorityClass: 'cosmetic' }),
      )
      await flush()
      await clock.advance(1000)
    }
    await clock.advance(1000)
    await flush()
    await Promise.allSettled(promises)
    // With the budget off, only the 1s floor gates: every floor-spaced distinct
    // edit lands and nothing is budget-deferred.
    expect(gate.stats().global.sent).toBe(6)
    expect(gate.stats().global.budgetDeferred).toBe(0)
    expect(calls.map((c) => c.label)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5'])
  })
})
