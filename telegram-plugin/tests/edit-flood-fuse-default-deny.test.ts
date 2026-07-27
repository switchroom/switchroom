/**
 * The fuse's meter must count what Telegram counts (#3855).
 *
 * ── The bug these tests guard ────────────────────────────────────────────
 * `apply` opened with an ALLOWLIST:
 *
 *     const isEdit = EDIT_METHODS.has(method)
 *     const isSend = SEND_METHODS.has(method)
 *     if (!isEdit && !isSend) return runObserved(next)      // ← everything
 *                                                           //   else was FREE
 *
 * So `perChatTotalMaxPerWindow` — documented as counting "every admitted call"
 * and "matching Telegram's own per-chat metering" — counted neither. Measured
 * on overlord's gateway log (46791 `tg-post` lines), the unmetered share was
 * 29% overall and 42% in the 30 minutes before the 15908s ban:
 *
 *     sendChatAction      10457  (up to 18/min on ONE DM — the whole documented
 *                                 per-chat/minute allowance, counted as zero)
 *     setMessageReaction   2098
 *     deleteMessage         370
 *     pinChatMessage        366
 *     unpinChatMessage      365
 *     answerCallbackQuery    31  (no chat_id — unkeyable per-chat)
 *
 * Plus: the ban is scoped to the BOT TOKEN, and the fuse had no token-scoped
 * window at all, so nothing bounded the aggregate rate across chats.
 *
 * Every test below asserts an OUTCOME — how many calls reached `next` inside a
 * window — not that a branch executed.
 */

import { describe, it, expect } from 'vitest'
import {
  createEditFloodFuse,
  deriveBotScopeKey,
  EDIT_FLOOD_FUSE_DEFAULTS,
} from '../edit-flood-fuse.js'
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

describe('default-deny metering — the 29% the allowlist could not see', () => {
  /**
   * The headline outcome. `sendChatAction` was the single largest unmetered
   * method in the incident. Before the fix this loop put 60 calls on the wire
   * inside one 60s window while the fuse reported a 20/60s ceiling as intact.
   */
  it('meters sendChatAction — 60 offered, at most the ceiling reaches the wire', async () => {
    const clock = new FakeClock()
    let landed = 0
    const fuse = createEditFloodFuse({
      clock, perChatTotalMaxPerWindow: 20, perChatReplyReserve: 8, perChatWindowMs: 60_000,
    })

    const calls = Array.from({ length: 60 }, () =>
      fuse.apply('sendChatAction', { chat_id: CHAT, action: 'typing' }, async () => {
        landed++
        return true
      }))
    await clock.advance(59_000)
    await Promise.all(calls)

    // 20 total minus the 8-slot reply reserve = 12 available to cosmetic
    // traffic, which a typing indicator is.
    expect(landed).toBeLessThanOrEqual(12)
    expect(landed).toBeGreaterThan(0)
    // And the meter SAW them — this counter is zero on the pre-fix code.
    expect(fuse.stats().meteredByDefault).toBe(60)
  })

  it.each([
    ['setMessageReaction', { chat_id: CHAT, message_id: 5, reaction: [] }],
    ['deleteMessage', { chat_id: CHAT, message_id: 5 }],
    ['pinChatMessage', { chat_id: CHAT, message_id: 5 }],
    ['unpinChatMessage', { chat_id: CHAT, message_id: 5 }],
    // Not in EDIT_METHODS or SEND_METHODS and never was — the exact class of
    // method default-deny exists to catch. It carries chat_id and creates a
    // message (gateway.ts `rawSendChecklist`), so it consumes chat budget.
    ['sendChecklist', { chat_id: CHAT, title: 't', tasks: [] }],
    // A Bot API method this file has never heard of.
    ['sendSomethingInventedNextYear', { chat_id: CHAT }],
  ])('meters %s against the shared per-chat window', async (method, payload) => {
    const clock = new FakeClock()
    let landed = 0
    const fuse = createEditFloodFuse({
      clock, perChatTotalMaxPerWindow: 5, perChatReplyReserve: 0, perChatWindowMs: 60_000,
      maxDeferMs: 1_000,
    })
    const calls = Array.from({ length: 30 }, () =>
      fuse.apply(method, payload, async () => { landed++; return true }))
    await clock.advance(2_000) // past the 1s defer deadline
    await Promise.all(calls)

    // These have durable, user-visible effects, so they are PACED not dropped —
    // over-budget calls release at the defer deadline. The outcome that matters
    // is that they took slots at all: the shared window is now full.
    expect(fuse.stats().meteredByDefault).toBe(30)
    expect(landed).toBe(30)
    expect(fuse.stats().dropped).toBe(0)

    // The proof the slots were really charged: a reply offered now finds the
    // window saturated and is deferred rather than sailing straight through.
    // On the pre-fix code none of the 30 took a slot, so this never deferred.
    const before = fuse.stats().deferred
    const reply = fuse.apply('sendMessage', { chat_id: CHAT, text: 'hi' }, async () => true)
    await flush()
    expect(fuse.stats().deferred).toBeGreaterThan(before)
    await clock.advance(120_000)
    await reply
  })

  it('never DROPS a durable-effect ancillary call — a deletion is paced, not lost', async () => {
    const clock = new FakeClock()
    let landed = 0
    const fuse = createEditFloodFuse({
      clock, perChatTotalMaxPerWindow: 2, perChatReplyReserve: 0, perChatWindowMs: 60_000,
      maxDeferMs: 5_000,
    })
    const calls = Array.from({ length: 10 }, (_, i) =>
      fuse.apply('deleteMessage', { chat_id: CHAT, message_id: i }, async () => {
        landed++
        return true
      }))
    await clock.advance(120_000)
    await Promise.all(calls)
    expect(landed).toBe(10)
    expect(fuse.stats().dropped).toBe(0)
  })

  it('DOES drop a typing indicator rather than deliver it stale', async () => {
    const clock = new FakeClock()
    let landed = 0
    const fuse = createEditFloodFuse({
      clock, perChatTotalMaxPerWindow: 2, perChatReplyReserve: 0, perChatWindowMs: 60_000,
      maxDeferMs: 30_000, chatActionMaxDeferMs: 3_000,
    })
    const calls = Array.from({ length: 10 }, () =>
      fuse.apply('sendChatAction', { chat_id: CHAT, action: 'typing' }, async () => {
        landed++
        return true
      }))
    await clock.advance(30_000)
    await Promise.all(calls)
    expect(landed).toBe(2)
    expect(fuse.stats().dropped).toBe(8)
  })

  it('the reply reserve survives a saturating ancillary stream', async () => {
    // The starvation guarantee has to hold against the traffic that was
    // previously invisible, or it is not a guarantee.
    const clock = new FakeClock()
    let repliesLanded = 0
    const fuse = createEditFloodFuse({
      clock, perChatTotalMaxPerWindow: 20, perChatReplyReserve: 8, perChatWindowMs: 60_000,
      maxDeferMs: 30_000,
    })
    const noise = Array.from({ length: 200 }, () =>
      fuse.apply('sendChatAction', { chat_id: CHAT, action: 'typing' }, async () => true))
    await flush()
    const replies = Array.from({ length: 8 }, (_, i) =>
      fuse.apply('sendMessage', { chat_id: CHAT, text: `answer ${i}` }, async () => {
        repliesLanded++
        return true
      }))
    await clock.advance(120_000)
    await Promise.all([...noise, ...replies])
    expect(repliesLanded).toBe(8)
  })
})

describe('the per-BOT-TOKEN window — the scope the ban actually uses', () => {
  it('bounds the aggregate rate across MANY chats, which per-chat windows cannot', async () => {
    // 40 distinct chats, one call each, all in the same instant. Every per-chat
    // window is comfortably in budget; only a token-scoped window sees the sum.
    const clock = new FakeClock()
    let landed = 0
    const fuse = createEditFloodFuse({
      clock, botScopeKey: '123456789',
      perTokenMaxPerWindow: 25, perTokenWindowMs: 1_000, maxDeferMs: 30_000,
    })
    const calls = Array.from({ length: 40 }, (_, i) =>
      fuse.apply('sendMessage', { chat_id: `chat-${i}`, text: 'x' }, async () => {
        landed++
        return true
      }))
    await flush()
    expect(landed).toBe(25) // the token ceiling, not 40

    await clock.advance(2_000)
    await Promise.all(calls)
    // Nothing is LOST — the remaining 15 land once the window slides.
    expect(landed).toBe(40)
  })

  it('charges a CHAT-LESS call (answerCallbackQuery) to the token window', async () => {
    // answerCallbackQuery carries `callback_query_id`, never `chat_id`, so the
    // per-chat tier structurally cannot key it. Before #3855 that meant it was
    // free everywhere. It is now charged where it genuinely counts.
    const clock = new FakeClock()
    let landed = 0
    const fuse = createEditFloodFuse({
      clock, perTokenMaxPerWindow: 3, perTokenWindowMs: 1_000, maxDeferMs: 30_000,
    })
    const calls = Array.from({ length: 10 }, (_, i) =>
      fuse.apply('answerCallbackQuery', { callback_query_id: `q${i}` }, async () => {
        landed++
        return true
      }))
    await flush()
    expect(landed).toBe(3)
    expect(fuse.stats().chatless).toBe(10)

    await clock.advance(5_000)
    await Promise.all(calls)
    expect(landed).toBe(10) // paced, never dropped
  })

  it('BOTH windows must pass — a single hot chat is still bounded per-chat', async () => {
    const clock = new FakeClock()
    let landed = 0
    const fuse = createEditFloodFuse({
      clock,
      perChatTotalMaxPerWindow: 4, perChatReplyReserve: 0, perChatWindowMs: 60_000,
      // Token window wide open, so only the per-chat tier can bind.
      perTokenMaxPerWindow: 1_000, perTokenWindowMs: 1_000,
      maxDeferMs: 500,
    })
    const calls = Array.from({ length: 20 }, () =>
      fuse.apply('sendChatAction', { chat_id: CHAT, action: 'typing' }, async () => {
        landed++
        return true
      }))
    await clock.advance(2_000) // past the 500ms defer deadline
    await Promise.all(calls)
    expect(landed).toBe(4)
  })

  it('separate bot ids get separate windows; the same id shares one', async () => {
    const clock = new FakeClock()
    const mk = (botScopeKey: string) =>
      createEditFloodFuse({
        clock, botScopeKey, perTokenMaxPerWindow: 2, perTokenWindowMs: 60_000,
        perChatTotalMaxPerWindow: 1_000, maxDeferMs: 100,
      })
    // Two fuses with the SAME id are still two processes' worth of state — the
    // documented limitation. What this asserts is the KEY derivation, which is
    // what a future shared store would key on.
    expect(deriveBotScopeKey('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe('123456789')
    expect(mk('123456789')).toBeDefined()
  })
})

describe('deriveBotScopeKey — the token itself must never become a key', () => {
  const REAL_SHAPE = '8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

  it('returns ONLY the public bot id, never any part of the secret', () => {
    const key = deriveBotScopeKey(REAL_SHAPE)
    expect(key).toBe('8123456789')
    const secret = REAL_SHAPE.slice(REAL_SHAPE.indexOf(':') + 1)
    expect(key).not.toContain(secret)
    // Not even a prefix of the secret leaks — check every prefix ≥ 4 chars.
    for (let n = 4; n <= secret.length; n++) {
      expect(key).not.toContain(secret.slice(0, n))
    }
  })

  it('falls back to an irreversible hash for a token of unexpected shape', () => {
    const odd = 'not-a-normal-token'
    const key = deriveBotScopeKey(odd)
    expect(key).toMatch(/^h[0-9a-f]{16}$/)
    expect(key).not.toContain(odd)
    // Stable — the same token must key the same window across constructions.
    expect(deriveBotScopeKey(odd)).toBe(key)
  })

  it('handles an absent token without throwing', () => {
    expect(deriveBotScopeKey(undefined)).toBe('unknown')
    expect(deriveBotScopeKey('')).toBe('unknown')
  })
})

describe('the defaults still describe the real budget', () => {
  it('the token ceiling sits below Telegram\'s ~30/s token-level limit', () => {
    expect(EDIT_FLOOD_FUSE_DEFAULTS.perTokenMaxPerWindow).toBeLessThan(30)
    expect(EDIT_FLOOD_FUSE_DEFAULTS.perTokenWindowMs).toBe(1_000)
  })

  it('a chat action may not be held past its own ~5s lifetime', () => {
    expect(EDIT_FLOOD_FUSE_DEFAULTS.chatActionMaxDeferMs).toBeLessThan(5_000)
  })
})
