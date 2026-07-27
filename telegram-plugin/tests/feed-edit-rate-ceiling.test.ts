/**
 * Regression suite for the 2026-07-27 activity-feed flood ban.
 *
 * What happened: agent `overlord`'s live activity/worker feed edited its card
 * at a sustained 4-17 `editMessageText`/min on ONE DM chat for hours (326
 * edits against 6 real replies in the final 20 minutes). Telegram answered
 * with a **15908-second** per-chat flood ban, which severed every outbound
 * reply — a cosmetic progress indicator took out the agent's entire ability
 * to communicate.
 *
 * The edit-flood fuse was already installed. It did not bind ONCE, because
 * its ceilings (20 edits/60s per message, 30 edits/60s per chat) sat ABOVE
 * the rate that earned the ban, and because it was class-blind: it could not
 * tell a repaint from a reply, so it could not hold repaints to a low rate
 * without also throttling answers.
 *
 * Every test here asserts an OUTCOME at the transformer seam — how many calls
 * actually reached the API — under a scenario drawn from the incident. Each
 * one fails if the cosmetic ceiling, the reply reservation, the class
 * propagation, or the escalating 429 backoff is removed.
 */
import { describe, it, expect } from 'vitest'
import {
  createEditFloodFuse,
  editFloodFuseConfigFromEnv,
  EDIT_FLOOD_FUSE_DEFAULTS,
} from '../edit-flood-fuse.js'
import { withOutboundClass, currentOutboundClass } from '../outbound-class.js'
import { createSendGate, type Clock } from '../send-gate.js'

const CHAT = '1001'
const CARD = 4242

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

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

describe('feed flood ban — a cosmetic edit stream is held below the banned rate', () => {
  it('replays the incident cadence: ~17 feed edits/min offered for 10 min admit ≤ the cosmetic ceiling', async () => {
    const clock = new FakeClock()
    const landed: number[] = []
    const fuse = createEditFloodFuse({ clock })

    // The incident's peak 10-minute bucket: 174 editMessageText calls against
    // one card in one chat. Offered at a steady ~3.4s spacing, exactly as the
    // feed heartbeat + worker ticks produced them.
    const OFFERED = 174
    const SPAN_MS = 600_000
    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < OFFERED; i++) {
      inflight.push(
        withOutboundClass('cosmetic', () => fuse.apply(
          'editMessageText',
          { chat_id: CHAT, message_id: CARD, text: `frame ${i}` },
          async () => { landed.push(i); return true },
        )),
      )
      await clock.advance(Math.floor(SPAN_MS / OFFERED))
    }
    await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
    await Promise.all(inflight)

    const perMinuteAdmitted = landed.length / (SPAN_MS / 60_000)
    // The ceiling that must hold. 4/min per card is the cosmetic per-message
    // default; a little slack covers window-boundary effects.
    expect(perMinuteAdmitted).toBeLessThanOrEqual(
      EDIT_FLOOD_FUSE_DEFAULTS.cosmeticPerMessageMaxPerWindow + 1)
    // …and it must be a REDUCTION, not a no-op: the offered rate is the rate
    // that earned the ban.
    expect(landed.length).toBeLessThan(OFFERED / 3)
    // The card is still live — throttled, never silenced.
    expect(landed.length).toBeGreaterThan(0)

    // The pre-fix ceilings would not have bound at all. This is the assertion
    // that makes the whole suite non-vacuous: 174/10min = 17.4/min, which is
    // under BOTH old ceilings, which is precisely why the ban happened.
    const offeredPerMin = OFFERED / (SPAN_MS / 60_000)
    expect(offeredPerMin).toBeLessThan(EDIT_FLOOD_FUSE_DEFAULTS.perMessageMaxPerWindow)
    expect(offeredPerMin).toBeLessThan(EDIT_FLOOD_FUSE_DEFAULTS.perChatEditMaxPerWindow)
  })

  it('coalesces rather than loses state: the LAST frame offered is the last frame painted', async () => {
    const clock = new FakeClock()
    const landed: string[] = []
    const fuse = createEditFloodFuse({ clock })

    const inflight: Promise<unknown>[] = []
    for (let i = 1; i <= 60; i++) {
      inflight.push(
        withOutboundClass('cosmetic', () => fuse.apply(
          'editMessageText', { chat_id: CHAT, message_id: CARD, text: `v${i}` },
          async () => { landed.push(`v${i}`); return true },
        )),
      )
      await clock.advance(1_000)
    }
    await clock.advance(120_000)
    await Promise.all(inflight)

    // Backpressure, not dropping-on-the-floor: the operator sees CURRENT state
    // at every permitted edit, just less often. If the newest frame could be
    // shed the card would go stale, which is the failure mode a plain rate
    // limiter would introduce.
    expect(landed[landed.length - 1]).toBe('v60')
  })

  it('N concurrent worker cards in one chat share the cosmetic allowance', async () => {
    const clock = new FakeClock()
    const landed: string[] = []
    const fuse = createEditFloodFuse({ clock })

    // 6 background workers, each with its own card, each individually inside
    // the per-message ceiling. Only a per-CHAT cosmetic ceiling stops their sum.
    const inflight: Promise<unknown>[] = []
    // 9 rounds ⇒ every offer lands inside ONE 60s window, so the snapshot below
    // measures the ceiling and not a window-boundary refill.
    for (let round = 0; round < 9; round++) {
      for (let w = 0; w < 6; w++) {
        inflight.push(
          withOutboundClass('cosmetic', () => fuse.apply(
            'editMessageText', { chat_id: CHAT, message_id: 500 + w, text: `w${w} r${round}` },
            async () => { landed.push(`w${w} r${round}`); return true },
          )),
        )
      }
      await clock.advance(6_000) // the gateway's FEED_HEARTBEAT_TICK_MS
    }
    const inWindow = landed.length
    await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
    await Promise.all(inflight)

    // 54 offers across one 60s window; the chat's cosmetic allowance binds.
    expect(inWindow).toBeLessThanOrEqual(
      EDIT_FLOOD_FUSE_DEFAULTS.cosmeticPerChatMaxPerWindow
      + EDIT_FLOOD_FUSE_DEFAULTS.lateReleaseMaxPerWindow + 1)
  })
})

describe('feed flood ban — a real reply is never starved by feed edits', () => {
  it('delivers a reply while the cosmetic budget is fully exhausted', async () => {
    const clock = new FakeClock()
    const replies: string[] = []
    const fuse = createEditFloodFuse({ clock })

    // Saturate: 200 cosmetic edits offered as fast as the feed can produce
    // them, spread across several cards so every cosmetic tier is pinned.
    const noise: Promise<unknown>[] = []
    for (let i = 0; i < 200; i++) {
      noise.push(
        withOutboundClass('cosmetic', () => fuse.apply(
          'editMessageText', { chat_id: CHAT, message_id: 700 + (i % 5), text: `n${i}` },
          async () => true,
        )),
      )
    }
    await clock.advance(500)

    // The operator's actual answer, issued mid-flood.
    const reply = withOutboundClass('critical', () => fuse.apply(
      'sendMessage', { chat_id: CHAT, text: 'the answer' },
      async () => { replies.push('the answer'); return { message_id: 1 } },
    ))
    // It must land, and land PROMPTLY — inside the reserve, not after the
    // cosmetic window slides. This is the property the incident violated: the
    // feed consumed the chat's budget and the reply could not go out at all.
    await clock.advance(2_000)
    await reply
    expect(replies).toEqual(['the answer'])

    await clock.advance(300_000)
    await Promise.all(noise)
    // Not one reply was dropped by the fuse.
    expect(fuse.stats().dropped).toBeGreaterThan(0) // cosmetic edits were shed…
    expect(replies).toHaveLength(1)                 // …the answer was not.
  })

  it('does not throttle a non-cosmetic edit with the cosmetic ceiling', async () => {
    const clock = new FakeClock()
    const landed: number[] = []
    const fuse = createEditFloodFuse({ clock })

    // An approval card being re-rendered by operator taps: `useful`, low
    // volume, but above the 4/min cosmetic ceiling. Throttling it would be a
    // regression — the fix must separate classes, not just lower one number.
    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      inflight.push(
        withOutboundClass('useful', () => fuse.apply(
          'editMessageText', { chat_id: CHAT, message_id: 900, text: `tap ${i}` },
          async () => { landed.push(i); return true },
        )),
      )
      await clock.advance(2_000)
    }
    await clock.advance(60_000)
    await Promise.all(inflight)

    expect(landed).toHaveLength(10)
    expect(landed[landed.length - 1]).toBe(9)
  })

  it('treats an UNTAGGED edit as cosmetic — a new unkeyed call site is limited by default', async () => {
    const clock = new FakeClock()
    const landed: number[] = []
    const fuse = createEditFloodFuse({ clock })

    // No `withOutboundClass` wrapper at all: the shape of a future call site
    // that never heard of the send gate. That is exactly how both the
    // 2026-07-25 and 2026-07-27 floods started.
    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < 60; i++) {
      inflight.push(fuse.apply(
        'editMessageText', { chat_id: CHAT, message_id: 950, text: `u${i}` },
        async () => { landed.push(i); return true },
      ))
      await clock.advance(1_000)
    }
    const inWindow = landed.length
    await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
    await Promise.all(inflight)

    expect(inWindow).toBeLessThanOrEqual(
      EDIT_FLOOD_FUSE_DEFAULTS.cosmeticPerMessageMaxPerWindow + 1)
  })

  it('treats an UNTAGGED send as critical — never dropped', async () => {
    const clock = new FakeClock()
    const landed: number[] = []
    const fuse = createEditFloodFuse({ clock })
    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < 40; i++) {
      inflight.push(fuse.apply('sendMessage', { chat_id: CHAT, text: `s${i}` },
        async () => { landed.push(i); return { message_id: i } }))
    }
    await clock.advance(600_000)
    await Promise.all(inflight)
    expect(landed).toHaveLength(40)
  })
})

describe('feed flood ban — a 429 reduces the subsequent feed edit rate', () => {
  it('escalates: each 429 compounds the tightening rather than re-applying one step', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({ clock })
    const base = EDIT_FLOOD_FUSE_DEFAULTS.cosmeticPerChatMaxPerWindow

    expect(fuse.stats().tightenLevel).toBe(0)
    expect(fuse.stats().cosmeticPerChatCeiling).toBe(base)

    const flood = (): unknown => Object.assign(
      new Error('Too Many Requests: retry after 3'),
      { error_code: 429, parameters: { retry_after: 3 } },
    )
    const takeOne429 = async (): Promise<void> => {
      await expect(fuse.apply('sendMessage', { chat_id: CHAT, text: 'x' },
        async () => { throw flood() })).rejects.toThrow(/Too Many Requests/)
    }

    await takeOne429()
    const after1 = fuse.stats().cosmeticPerChatCeiling
    await clock.advance(1_000)
    await takeOne429()
    const after2 = fuse.stats().cosmeticPerChatCeiling

    // Pre-fix a second 429 changed nothing: the tightening was a single flat
    // 0.5× re-armed for another 10 minutes, so a stream taking repeated small
    // 429s held the SAME rate and walked into the long ban.
    expect(after1).toBeLessThan(base)
    expect(after2).toBeLessThan(after1)
    expect(fuse.stats().tightenLevel).toBe(2)
  })

  it('a 429 actually reduces how many feed edits get through afterwards', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({ clock })

    const offerBurst = async (tag: string): Promise<number> => {
      const landed: number[] = []
      const inflight: Promise<unknown>[] = []
      for (let i = 0; i < 40; i++) {
        inflight.push(
          withOutboundClass('cosmetic', () => fuse.apply(
            'editMessageText', { chat_id: CHAT, message_id: 1234, text: `${tag}${i}` },
            async () => { landed.push(i); return true },
          )),
        )
        await clock.advance(500)
      }
      const n = landed.length
      await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
      await Promise.all(inflight)
      return n
    }

    const before = await offerBurst('a')
    // Let every window fully drain so the comparison isolates the tightening.
    await clock.advance(120_000)

    await expect(fuse.apply('sendMessage', { chat_id: CHAT, text: 'x' }, async () => {
      throw Object.assign(new Error('Too Many Requests: retry after 3'),
        { error_code: 429, parameters: { retry_after: 3 } })
    })).rejects.toThrow(/Too Many Requests/)
    await clock.advance(120_000)

    const after = await offerBurst('b')

    expect(before).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
  })

  it('decays one level at a time rather than restoring full rate in one step', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({ clock, tightenMs: 60_000 })
    const base = EDIT_FLOOD_FUSE_DEFAULTS.cosmeticPerMessageMaxPerWindow

    for (let i = 0; i < 3; i++) {
      await expect(fuse.apply('sendMessage', { chat_id: CHAT, text: 'x' }, async () => {
        throw Object.assign(new Error('Too Many Requests: retry after 3'),
          { error_code: 429, parameters: { retry_after: 3 } })
      })).rejects.toThrow(/Too Many Requests/)
    }
    expect(fuse.stats().tightenLevel).toBe(3)

    await clock.advance(60_001)
    expect(fuse.stats().tightenLevel).toBe(2)
    await clock.advance(60_001)
    expect(fuse.stats().tightenLevel).toBe(1)
    await clock.advance(60_001)
    expect(fuse.stats().tightenLevel).toBe(0)
    expect(fuse.stats().cosmeticPerMessageCeiling).toBe(base)
  })
})

describe('feed flood ban — the send gate publishes the class the fuse depends on', () => {
  it('a cosmetic gated EDIT is visible as cosmetic at the transformer seam', async () => {
    const gate = createSendGate({ enabled: true })
    let seen: string | undefined
    await gate.gate(
      async () => { seen = currentOutboundClass(); return true },
      { chat_id: CHAT, messageId: CARD, editPayload: 'body', priorityClass: 'cosmetic' },
    )
    // Without this propagation the fuse's class awareness is decorative: every
    // edit would fall back to the untagged default and the classes would never
    // actually separate.
    expect(seen).toBe('cosmetic')
  })

  it('a critical gated SEND is visible as critical at the transformer seam', async () => {
    const gate = createSendGate({ enabled: true })
    let seen: string | undefined
    await gate.gate(
      async () => { seen = currentOutboundClass(); return true },
      { chat_id: CHAT, priorityClass: 'critical' },
    )
    expect(seen).toBe('critical')
  })

  it('an untagged gated send reports the gate\'s own UNTAGGED_SEND_CLASS', async () => {
    const gate = createSendGate({ enabled: true })
    let seen: string | undefined
    await gate.gate(async () => { seen = currentOutboundClass(); return true }, { chat_id: CHAT })
    expect(seen).toBe('critical')
  })
})

describe('feed flood ban — the ceilings are operator-configurable', () => {
  it('reads every ceiling from env, and keeps defaults when unset', () => {
    // Pre-fix the ONLY knob was SWITCHROOM_EDIT_FUSE=0, which turns the whole
    // failsafe off — an operator being flooded had no way to tighten it.
    const cfg = editFloodFuseConfigFromEnv({
      SWITCHROOM_FEED_EDIT_MAX_PER_MSG_PER_MIN: '2',
      SWITCHROOM_FEED_EDIT_MAX_PER_CHAT_PER_MIN: '3',
      SWITCHROOM_CHAT_TOTAL_MAX_PER_MIN: '15',
      SWITCHROOM_CHAT_REPLY_RESERVE: '9',
    })
    expect(cfg).toMatchObject({
      enabled: true,
      cosmeticPerMessageMaxPerWindow: 2,
      cosmeticPerChatMaxPerWindow: 3,
      perChatTotalMaxPerWindow: 15,
      perChatReplyReserve: 9,
    })

    const bare = editFloodFuseConfigFromEnv({})
    expect(bare.cosmeticPerMessageMaxPerWindow).toBeUndefined()
    expect(bare.enabled).toBe(true)
    expect(editFloodFuseConfigFromEnv({ SWITCHROOM_EDIT_FUSE: '0' }).enabled).toBe(false)
    // Garbage must not silently become 0 (which would deadlock every card).
    expect(editFloodFuseConfigFromEnv({ SWITCHROOM_FEED_EDIT_MAX_PER_MSG_PER_MIN: 'lots' })
      .cosmeticPerMessageMaxPerWindow).toBeUndefined()
  })

  it('an env-tightened ceiling actually binds', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({
      clock, ...editFloodFuseConfigFromEnv({ SWITCHROOM_FEED_EDIT_MAX_PER_MSG_PER_MIN: '1' }),
    })
    const landed: number[] = []
    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < 30; i++) {
      inflight.push(
        withOutboundClass('cosmetic', () => fuse.apply(
          'editMessageText', { chat_id: CHAT, message_id: 4321, text: `e${i}` },
          async () => { landed.push(i); return true },
        )),
      )
      await clock.advance(1_000)
    }
    const inWindow = landed.length
    await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
    await Promise.all(inflight)
    expect(inWindow).toBeLessThanOrEqual(2)
  })

  it('a reserve larger than the total budget cannot deadlock cosmetic traffic', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({
      clock, perChatTotalMaxPerWindow: 5, perChatReplyReserve: 99,
    })
    const landed: number[] = []
    await withOutboundClass('cosmetic', () => fuse.apply(
      'editMessageText', { chat_id: CHAT, message_id: 8888, text: 'x' },
      async () => { landed.push(1); return true },
    ))
    expect(landed).toHaveLength(1)
  })
})
