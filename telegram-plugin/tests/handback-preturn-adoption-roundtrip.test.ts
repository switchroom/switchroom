import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHandbackPreturnSignal } from '../gateway/handback-preturn-signal.js'
import { createTurnTypingLoop } from '../gateway/turn-typing-loop.js'
import { buildSubagentHandbackInbound } from '../gateway/subagent-handback-inbound-builder.js'
import { deriveTurnId } from '../gateway/derive-turn-id.js'
import { chatKey } from '../gateway/chat-key.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'
import type { PreTurnCardRecord } from '../gateway/handback-preturn-signal.js'

/**
 * #3268 IDENTITY ROUND-TRIP (the anti-masking integration test).
 *
 * The unit contract test hand-feeds a matching `messageId` to BOTH the seam's
 * release side and the enqueue's adopt side, so it CANNOT catch a builder that
 * fails to round-trip the identity across the bridge. This test closes that gap:
 * it runs the REAL `buildSubagentHandbackInbound` and the REAL `deriveTurnId`,
 * and models the enqueue exactly as the gateway does —
 *
 *   ev.messageId  ← the channel envelope's `message_id` attribute, which is
 *                   rendered ONLY from `meta.message_id` (the top-level
 *                   `messageId` field does NOT survive the bridge; see
 *                   resume-inbound-builder.ts's identical round-trip).
 *   turnId        ← deriveTurnId(ev.chatId, enqThreadId, ev.messageId)
 *                   ?? `${chatKey}#synthetic-${startedAt}`  (gateway.ts enqueue)
 *
 * and asserts the enqueue-derived `turnId` EQUALS the id the seam recorded at
 * release — so `tryAdopt` actually fires end-to-end.
 *
 * This FAILS on a builder that omits `meta.message_id` (ev.messageId → null →
 * deriveTurnId → null → synthetic fallback → adoption never matches → the
 * pre-turn card is orphaned + the false "handback never started" reap message
 * fires on every SUCCESSFUL handback), and PASSES once the builder rounds-trips
 * the identity.
 */

// The gateway's enqueue turn-id, reconstructed with the SAME primitives the
// gateway uses (real deriveTurnId; synthetic fallback for a null message id).
function enqueueTurnIdFor(inbound: InboundMessage, startedAt: number): string {
  // ev.messageId at enqueue comes from meta.message_id (channel-rendered), NOT
  // the top-level messageId field.
  const evMessageId = inbound.meta.message_id ?? null
  // ev.threadId at enqueue comes from meta.message_thread_id.
  const enqThreadId =
    inbound.meta.message_thread_id != null ? Number(inbound.meta.message_thread_id) : null
  return (
    deriveTurnId(inbound.chatId, enqThreadId, evMessageId) ??
    `${chatKey(inbound.chatId, enqThreadId)}#synthetic-${startedAt}`
  )
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function makeScheduler() {
  let seq = 0
  let currentTime = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  return {
    now: () => currentTime,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = ++seq
      timers.set(id, { fn, at: currentTime + ms })
      return id
    },
    clearTimer: (h: unknown): void => {
      timers.delete(h as number)
    },
    async advance(ms: number): Promise<void> {
      const target = currentTime + ms
      for (;;) {
        let nextId: number | null = null
        let nextAt = Infinity
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) {
            nextId = id
            nextAt = t.at
          }
        }
        if (nextId == null) break
        const t = timers.get(nextId)!
        timers.delete(nextId)
        currentTime = t.at
        t.fn()
        await flushMicrotasks()
      }
      currentTime = target
      await flushMicrotasks()
    },
  }
}

function makeSeam(sched: ReturnType<typeof makeScheduler>) {
  const sendChatAction = vi.fn<(c: string, t: number | null) => void>()
  const typing = createTurnTypingLoop({
    sendChatAction,
    chatKey: (c, t) => chatKey(c, t) as string,
    refreshMs: 4000,
  })
  let msgSeq = 5000
  const openCard = vi.fn<(c: string, t: number | null) => Promise<number | null>>(async () => ++msgSeq)
  const records = new Map<string, PreTurnCardRecord>()
  const signal = createHandbackPreturnSignal({
    // The gateway wires these to the SAME real chatKey / deriveTurnId.
    chatKey: (c, t) => chatKey(c, t) as string,
    deriveTurnId,
    startTypingLoop: (c, t) => typing.start(c, t),
    stopTypingLoop: (c, t) => typing.stop(c, t),
    openCard,
    finalizeCard: () => {},
    writeCardRecord: (r) => records.set(r.turnKey, r),
    clearCardRecord: (turnKey, id) => {
      const cur = records.get(turnKey)
      if (cur != null && cur.activityMessageId === id) records.delete(turnKey)
    },
    now: sched.now,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    debounceMs: 700,
    adoptTimeoutMs: 30_000,
  })
  return { signal, typing, openCard, records }
}

const teardown: Array<() => void> = []
afterEach(() => {
  for (const fn of teardown.splice(0)) fn()
})

describe('#3268 handback identity round-trip — adoption fires end-to-end', () => {
  it('the REAL builder + REAL deriveTurnId yield the SAME turnId at release and enqueue (DM)', async () => {
    const sched = makeScheduler()
    const seam = makeSeam(sched)
    teardown.push(() => seam.typing.stopAll())

    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '12345',
        taskDescription: 'Refactor the auth module',
        resultText: 'Done.',
        outcome: 'completed',
      },
      nowMs: 1_700_000_000_000,
    })

    // Release-side identity, computed exactly as the seam does internally.
    const releaseTurnId = deriveTurnId('12345', null, inbound.messageId)
    // Enqueue-side identity, computed exactly as the gateway does.
    const enqueueTurnId = enqueueTurnIdFor(inbound, /* startedAt */ 1_700_000_000_500)

    // THE round-trip: the two independently-derived ids must be equal AND
    // non-null (a synthetic fallback would be non-equal).
    expect(releaseTurnId).not.toBeNull()
    expect(enqueueTurnId).toBe(releaseTurnId)

    // And end-to-end: release into the real seam, then adopt with the
    // enqueue-derived id — adoption must fire (card seeded).
    seam.signal.noteHandbackRelease(inbound)
    await sched.advance(700)
    expect(seam.openCard).toHaveBeenCalledTimes(1)
    const adoption = seam.signal.tryAdopt(enqueueTurnId)
    expect(adoption).not.toBeNull()
    expect(adoption!.activityMessageId).not.toBeNull()
    expect(seam.signal.pendingCount()).toBe(0)
  })

  it('round-trips identity through a supergroup topic (threadId survives via meta.message_thread_id)', async () => {
    const sched = makeScheduler()
    const seam = makeSeam(sched)
    teardown.push(() => seam.typing.stopAll())

    const inbound = buildSubagentHandbackInbound({
      ctx: {
        chatId: '-100999',
        threadId: 42,
        taskDescription: 'Migrate DB',
        resultText: 'Done.',
        outcome: 'completed',
      },
      nowMs: 1_700_000_111_111,
    })

    const releaseTurnId = deriveTurnId('-100999', 42, inbound.messageId)
    const enqueueTurnId = enqueueTurnIdFor(inbound, 1_700_000_111_500)
    expect(releaseTurnId).not.toBeNull()
    expect(enqueueTurnId).toBe(releaseTurnId)

    seam.signal.noteHandbackRelease(inbound)
    await sched.advance(700)
    const adoption = seam.signal.tryAdopt(enqueueTurnId)
    expect(adoption).not.toBeNull()
    expect(adoption!.statusKey).toBe(chatKey('-100999', 42) as string)
  })

  it('the enqueue message id comes from meta.message_id, not the top-level messageId field', () => {
    // Guards the exact bridge-survival fact the bug hinged on: the identity must
    // live in meta (channel-rendered), not only on the top-level field.
    const inbound = buildSubagentHandbackInbound({
      ctx: { chatId: '7', taskDescription: 't', resultText: 'r', outcome: 'completed' },
      nowMs: 1_700_000_222_222,
    })
    expect(inbound.meta.message_id).toBe(String(1_700_000_222_222))
    // The synthetic fallback (what enqueue would use if meta.message_id were
    // absent) must NOT equal the real release id — proving the round-trip is
    // load-bearing.
    const releaseTurnId = deriveTurnId('7', null, inbound.messageId)
    const syntheticFallback = `${chatKey('7', null)}#synthetic-999`
    expect(syntheticFallback).not.toBe(releaseTurnId)
  })
})
