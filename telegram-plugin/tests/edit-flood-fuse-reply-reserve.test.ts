/**
 * The reply reserve must actually reserve — at EVERY tighten level (#3885).
 *
 * ── What broke in production ─────────────────────────────────────────────
 * A 12-agent staggered restart drew three genuine 429s. The chat logged 792
 * fuse events in an hour against a 35-50/hr baseline, shed 221 typing
 * indicators, deferred 18 reactions (the operator noticed his reactions had
 * stopped working), and held real replies long enough that the MCP `reply`
 * tool's 60s timeout fired — so the agent retried and the operator received
 * the same answer twice. One ~1900-character reply was lost entirely.
 *
 * The arithmetic: at `maxTightenLevel: 4` with `tightenFactor: 0.5`, the shared
 * per-chat budget `max(1, floor(20 * 0.5^4))` is **1 call per minute for the
 * whole chat**. `perChatReplyReserve: 8` was a fixed count subtracted from the
 * BASE — `max(1, 20 - 8) = 12`, itself tightened to 1 — so a reply and a
 * progress repaint ended up with the identical budget of 1. The reservation
 * was arithmetically dead in exactly the situation it exists for.
 *
 * ── What these tests pin ─────────────────────────────────────────────────
 * Outcomes on the wire, not code paths. Every case here counts how many calls
 * a fake downstream actually received.
 *
 *   1. A `critical` message gets through at maximum tightening, inside the
 *      window. (This is the case that fails on pre-#3885 code.)
 *   2. Critical strictly out-ranks cosmetic on the shared budget at EVERY
 *      tighten level — the reserve is proportional, not absolute.
 *   3. Cosmetic traffic is still shed under pressure. #3847 built this feature
 *      to stop a repaint surface earning a flood ban; the reserve fix must not
 *      hand that budget back.
 */

import { describe, it, expect } from 'vitest'

import { createEditFloodFuse, EDIT_FLOOD_FUSE_DEFAULTS } from '../edit-flood-fuse.js'
import { withOutboundClass } from '../outbound-class.js'
import type { Clock } from '../send-gate.js'

const CHAT = '1001'

class FakeClock implements Clock {
  private cur = 0
  private seq = 0
  private timers: { at: number; id: number; resolve: () => void }[] = []
  now(): number { return this.cur }
  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.cur + ms, id: this.seq++, resolve })
    })
  }
  async advance(ms: number): Promise<void> {
    const target = this.cur + ms
    for (;;) {
      await flush()
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) break
      const t = due[0]!
      this.timers = this.timers.filter((x) => x !== t)
      this.cur = t.at
      t.resolve()
      await flush()
    }
    this.cur = target
    await flush()
  }
}
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * A fuse pinned at `maxTightenLevel` via a large persisted ban window — the
 * production shape, and the one where `0.5^4` bites.
 */
function tightestFuse(clock: FakeClock, over: Record<string, number> = {}) {
  return createEditFloodFuse({
    clock,
    floodWaitRemainingMs: () => 12_247_000, // a 3.4h ban: maximum tightening
    floodProbeIntervalMs: 0,
    perChatTotalMaxPerWindow: 20,
    perChatReplyReserve: 8,
    perChatSendMaxPerWindow: 25,
    perChatEditMaxPerWindow: 30,
    perMessageMaxPerWindow: 20,
    perChatWindowMs: 60_000,
    perTokenMaxPerWindow: 1_000, // take the per-second tier out of the picture
    maxTightenLevel: 4,
    tightenFactor: 0.5,
    ...over,
  })
}

describe('a reply gets through at maximum tightening (#3885)', () => {
  it('delivers a critical send inside the window when the chat is at its tightest', async () => {
    // THE regression test. On pre-#3885 code the whole chat had an effective
    // budget of 1/min and the reserve could not raise it, so the second and
    // subsequent replies sat until `maxDeferMs` — past the MCP reply tool's
    // own 60s timeout, which is what produced duplicates and one lost answer.
    const clock = new FakeClock()
    const fuse = tightestFuse(clock)
    expect(fuse.stats().tightenLevel).toBe(4)

    let landed = 0
    const replies = Array.from({ length: 3 }, (_, i) =>
      withOutboundClass('critical', () =>
        fuse.apply('sendMessage', { chat_id: CHAT, text: `answer ${i}` }, async () => {
          landed++
          return true
        })))
    // No clock advance at all: the floor must be available immediately, not
    // "eventually, after the window slides".
    await flush()
    expect(landed).toBe(EDIT_FLOOD_FUSE_DEFAULTS.perChatCriticalMinPerWindow)

    await clock.advance(60_000)
    await Promise.all(replies)
  })

  it('delivers a critical EDIT (an approval card, an answer finalisation) too', async () => {
    const clock = new FakeClock()
    const fuse = tightestFuse(clock)
    let landed = 0
    const edits = Array.from({ length: 3 }, (_, i) =>
      withOutboundClass('critical', () =>
        fuse.apply('editMessageText', { chat_id: CHAT, message_id: 100 + i }, async () => {
          landed++
          return true
        })))
    await flush()
    expect(landed).toBe(3)
    await clock.advance(60_000)
    await Promise.all(edits)
  })

  it('delivers a critical reaction — the surface the operator noticed had died', async () => {
    // `setMessageReaction` is neither an edit nor a send: it takes the
    // default-deny path (#3855) straight to the shared per-chat budget, which
    // is where it was being deferred 30s at a time.
    const clock = new FakeClock()
    const fuse = tightestFuse(clock)
    let landed = 0
    const calls = Array.from({ length: 3 }, () =>
      withOutboundClass('critical', () =>
        fuse.apply('setMessageReaction', { chat_id: CHAT, message_id: 7 }, async () => {
          landed++
          return true
        })))
    await flush()
    expect(landed).toBe(3)
    await clock.advance(60_000)
    await Promise.all(calls)
  })

  it('the critical floor is capped by the operator\'s own base ceiling', async () => {
    // A floor that could RAISE a ceiling above what the operator configured
    // would be a second, hidden rate policy. Base 2 means 2, tightened or not.
    const clock = new FakeClock()
    const fuse = tightestFuse(clock, { perChatTotalMaxPerWindow: 2, perChatReplyReserve: 0 })
    expect(fuse.stats().criticalPerChatTotalCeiling).toBe(2)
    let landed = 0
    const calls = Array.from({ length: 5 }, () =>
      withOutboundClass('critical', () =>
        fuse.apply('sendMessage', { chat_id: CHAT, text: 'x' }, async () => { landed++; return true })))
    await flush()
    expect(landed).toBe(2)
    await clock.advance(60_000)
    await Promise.all(calls)
  })
})

describe('the reserve is honoured against the EFFECTIVE ceiling, at every level', () => {
  it('critical strictly out-ranks cosmetic on the shared budget at levels 0..4', () => {
    for (let level = 0; level <= 4; level++) {
      const clock = new FakeClock()
      // `tightenFactor^level` with a per-level persisted window is fiddly to
      // stage; drive the level directly by tightening with graded 429s is
      // equally so. Configure `maxTightenLevel: level` and hold a large
      // persisted window: `levelAt` then reports exactly `level`.
      const fuse = createEditFloodFuse({
        clock,
        floodWaitRemainingMs: () => 12_247_000,
        floodProbeIntervalMs: 0,
        perChatTotalMaxPerWindow: 20,
        perChatReplyReserve: 8,
        maxTightenLevel: level,
        tightenFactor: 0.5,
      })
      const s = fuse.stats()
      expect(s.tightenLevel).toBe(level)
      // The property that failed in production: whatever the effective budget
      // is, a reply always has strictly more of it than a repaint, and never
      // less than the floor.
      expect(s.criticalPerChatTotalCeiling).toBeGreaterThan(s.cosmeticPerChatTotalCeiling)
      expect(s.criticalPerChatTotalCeiling)
        .toBeGreaterThanOrEqual(EDIT_FLOOD_FUSE_DEFAULTS.perChatCriticalMinPerWindow)
    }
  })

  it('level 0 behaviour is unchanged — 8 of 20 reserved, exactly as before', () => {
    const fuse = createEditFloodFuse({
      clock: new FakeClock(),
      perChatTotalMaxPerWindow: 20,
      perChatReplyReserve: 8,
    })
    expect(fuse.stats().tightenLevel).toBe(0)
    expect(fuse.stats().criticalPerChatTotalCeiling).toBe(20)
    expect(fuse.stats().cosmeticPerChatTotalCeiling).toBe(12)
  })

  it('a zero reserve still means zero — the fix does not invent a reservation', () => {
    const fuse = createEditFloodFuse({
      clock: new FakeClock(),
      floodWaitRemainingMs: () => 12_247_000,
      floodProbeIntervalMs: 0,
      perChatTotalMaxPerWindow: 20,
      perChatReplyReserve: 0,
      maxTightenLevel: 4,
      tightenFactor: 0.5,
    })
    expect(fuse.stats().cosmeticPerChatTotalCeiling).toBe(1)
  })

  it('cosmetic reaches 0 at the tightest — every remaining slot is the reply\'s', () => {
    const fuse = createEditFloodFuse({
      clock: new FakeClock(),
      floodWaitRemainingMs: () => 12_247_000,
      floodProbeIntervalMs: 0,
      perChatTotalMaxPerWindow: 20,
      perChatReplyReserve: 8,
      maxTightenLevel: 4,
      tightenFactor: 0.5,
    })
    expect(fuse.stats().cosmeticPerChatTotalCeiling).toBe(0)
  })
})

describe('cosmetic traffic is still shed under pressure (#3847 must not regress)', () => {
  it('sheds typing indicators while the chat is at maximum tightening', async () => {
    const clock = new FakeClock()
    const fuse = tightestFuse(clock)
    let landed = 0
    const actions = Array.from({ length: 12 }, () =>
      withOutboundClass('cosmetic', () =>
        fuse.apply('sendChatAction', { chat_id: CHAT, action: 'typing' }, async () => {
          landed++
          return true
        })))
    await clock.advance(31_000)
    await Promise.all(actions)
    // A typing bubble expires by itself in ~5s; delivering it late is worse
    // than not delivering it. Under maximum tightening none should reach the
    // wire — the budget belongs to the answer.
    expect(landed).toBe(0)
    expect(fuse.stats().dropped).toBeGreaterThan(0)
  })

  it('holds a hot cosmetic card far below the cosmetic ceiling when tightened', async () => {
    const clock = new FakeClock()
    const fuse = tightestFuse(clock, { cosmeticPerMessageMaxPerWindow: 4, cosmeticPerChatMaxPerWindow: 6 })
    let landed = 0
    const frames = Array.from({ length: 40 }, () =>
      withOutboundClass('cosmetic', () =>
        fuse.apply('editMessageText', { chat_id: CHAT, message_id: 7 }, async () => {
          landed++
          return true
        })))
    await clock.advance(31_000)
    await Promise.all(frames)
    // 0.5^4 of 4 floors at 1 repaint per window; the late-release budget can
    // add at most `lateReleaseMaxPerWindow` tightened to 1 on top.
    expect(landed).toBeLessThanOrEqual(2)
  })

  it('a saturated cosmetic surface cannot starve a reply', async () => {
    // The starvation guarantee stated as an outcome: repaints run flat out for
    // a whole window, and the answer still lands.
    const clock = new FakeClock()
    const fuse = tightestFuse(clock)
    const frames = Array.from({ length: 60 }, (_, i) =>
      withOutboundClass('cosmetic', () =>
        fuse.apply('editMessageText', { chat_id: CHAT, message_id: 200 + (i % 6) }, async () => true)))
    await flush()

    let replied = 0
    const reply = withOutboundClass('critical', () =>
      fuse.apply('sendMessage', { chat_id: CHAT, text: 'the answer' }, async () => {
        replied++
        return true
      }))
    await flush()
    expect(replied).toBe(1)

    await clock.advance(61_000)
    await Promise.all([...frames, reply])
  })
})

describe('operator knobs for the tightening curve (#3885)', () => {
  it('SWITCHROOM_EDIT_FUSE_MAX_TIGHTEN_LEVEL and _TIGHTEN_FACTOR reach the fuse', async () => {
    const { editFloodFuseConfigFromEnv } = await import('../edit-flood-fuse.js')
    const cfg = editFloodFuseConfigFromEnv({
      SWITCHROOM_EDIT_FUSE_MAX_TIGHTEN_LEVEL: '2',
      SWITCHROOM_EDIT_FUSE_TIGHTEN_FACTOR: '0.75',
      SWITCHROOM_CHAT_CRITICAL_MIN_PER_MIN: '5',
    })
    expect(cfg.maxTightenLevel).toBe(2)
    expect(cfg.tightenFactor).toBe(0.75)
    expect(cfg.perChatCriticalMinPerWindow).toBe(5)

    // And they BIND: 0.75^2 of 20 is 11, not 0.5^4's 1.
    const fuse = createEditFloodFuse({
      ...cfg, clock: new FakeClock(), floodProbeIntervalMs: 0,
      floodWaitRemainingMs: () => 12_247_000, perChatTotalMaxPerWindow: 20,
    })
    expect(fuse.stats().criticalPerChatTotalCeiling).toBe(11)
  })

  it('maxTightenLevel=0 disables tightening even with a ban marker on disk', async () => {
    // `tightenStepFor` returns a fixed 1..3 for the smaller severity bands, so
    // the persisted path had to be clamped by `maxTightenLevel` too — otherwise
    // an operator who turned tightening OFF would find the fuse tightening
    // anyway the moment a marker existed.
    const fuse = createEditFloodFuse({
      clock: new FakeClock(),
      floodWaitRemainingMs: () => 12_247_000,
      floodProbeIntervalMs: 0,
      maxTightenLevel: 0,
      perChatTotalMaxPerWindow: 20,
    })
    expect(fuse.stats().persistedFloodOpen).toBe(true)
    expect(fuse.stats().tightenLevel).toBe(0)
    expect(fuse.stats().criticalPerChatTotalCeiling).toBe(20)
  })

  it('rejects an out-of-range tighten factor rather than silently clamping it', async () => {
    const { editFloodFuseConfigFromEnv } = await import('../edit-flood-fuse.js')
    for (const bad of ['0', '-1', '1.5', 'half', '']) {
      expect(editFloodFuseConfigFromEnv({ SWITCHROOM_EDIT_FUSE_TIGHTEN_FACTOR: bad }).tightenFactor)
        .toBeUndefined()
    }
    expect(editFloodFuseConfigFromEnv({ SWITCHROOM_EDIT_FUSE_TIGHTEN_FACTOR: '1' }).tightenFactor).toBe(1)
  })
})
