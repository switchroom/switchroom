import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createHandbackPreturnSignal,
  isHandbackInbound,
  PRETURN_TURNKEY_PREFIX,
  type HandbackPreturnSignalDeps,
  type PreTurnCardRecord,
} from '../gateway/handback-preturn-signal.js'
import { createTurnTypingLoop } from '../gateway/turn-typing-loop.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

/**
 * Contract test for the sub-agent-handback dead-air fix (the extracted
 * emit→adopt→reap seam). Drives the pure seam through an INJECTED clock +
 * INJECTED scheduler (NOT vitest's `vi.useFakeTimers` / `advanceTimersByTimeAsync`,
 * which bun's test runner does not implement) so it passes identically under
 * BOTH runners (the telegram-plugin dual-run rule). Asserts the whole card
 * lifecycle without the gateway or the Telegram bot API:
 *
 *   - drain-site emit within the debounce window (typing action + card)
 *   - adoption across the enqueue boundary is an EDIT (no second card send)
 *     and the typing loop never samples zero
 *   - turn-end hands off cleanly (record migrated, typing stopped once)
 *   - a never-adopted handback self-reaps its frozen card past the TTL
 *   - an identity race (user inbound adopts first) never mis-adopts the
 *     handback and never double-sends
 *
 * The first two assertions describe behaviour that DOES NOT EXIST on
 * pre-feature `main` (no pre-turn emit at all, and a handback turn never even
 * got a turn-long typing loop) — the seam is what makes them true.
 */

// Mirror the gateway's chatKey (null/0/undefined thread → '_').
const chatKey = (chatId: string, threadId: number | null) =>
  `${chatId}:${threadId == null || threadId === 0 ? '_' : threadId}`

// Mirror the gateway's deriveTurnId (`${chatKey}#${messageId}`, null for no id).
const deriveTurnId = (
  chatId: string,
  threadId: number | null,
  messageId: string | number | null | undefined,
): string | null => {
  if (messageId == null || messageId === '' || String(messageId) === '0') return null
  return `${chatKey(chatId, threadId)}#${messageId}`
}

function handbackInbound(opts: {
  chatId: string
  threadId?: number
  messageId: number
}): InboundMessage {
  return {
    type: 'inbound',
    chatId: opts.chatId,
    ...(opts.threadId != null ? { threadId: opts.threadId } : {}),
    messageId: opts.messageId,
    user: 'subagent-watcher',
    userId: 0,
    ts: opts.messageId,
    text: '🤝 A background worker you dispatched has finished.',
    meta: { source: 'subagent_handback', outcome: 'completed' },
  }
}

function userInbound(opts: {
  chatId: string
  threadId?: number
  messageId: number
}): InboundMessage {
  return {
    type: 'inbound',
    chatId: opts.chatId,
    ...(opts.threadId != null ? { threadId: opts.threadId } : {}),
    messageId: opts.messageId,
    user: 'ken',
    userId: 42,
    ts: opts.messageId,
    text: 'hi',
    meta: {},
  }
}

/** Flush the microtask queue so the seam's async openCard promise chain settles
 *  between scheduler ticks. Runner-agnostic (no fake-timer API): a handful of
 *  `await` turns drains the fixed-depth chain the seam builds. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** Manual injected scheduler + clock — the runner-agnostic replacement for
 *  vitest fake timers. Fires due timers in chronological order, allowing a
 *  fired timer to schedule another, and flushes microtasks after each fire so
 *  the async card-open chain completes deterministically. */
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
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number)
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

interface Harness {
  signal: ReturnType<typeof createHandbackPreturnSignal>
  typing: ReturnType<typeof createTurnTypingLoop>
  sched: ReturnType<typeof makeScheduler>
  sendChatAction: ReturnType<typeof vi.fn>
  openCard: ReturnType<typeof vi.fn>
  finalizeCard: ReturnType<typeof vi.fn>
  records: Map<string, PreTurnCardRecord>
  finalizedIds: number[]
}

const harnesses: Harness[] = []

function makeHarness(overrides: Partial<HandbackPreturnSignalDeps> = {}): Harness {
  const sched = makeScheduler()
  const sendChatAction = vi.fn<(c: string, t: number | null) => void>()
  const typing = createTurnTypingLoop({
    sendChatAction,
    chatKey: (c, t) => chatKey(c, t),
    refreshMs: 4000,
  })

  let msgSeq = 1000
  const openCard = vi.fn<(c: string, t: number | null) => Promise<number | null>>(
    async () => ++msgSeq,
  )

  // In-memory durable record store keyed by turnKey (mirrors the activity card
  // store's per-turnKey upsert semantics).
  const records = new Map<string, PreTurnCardRecord>()
  const writeCardRecord = (r: PreTurnCardRecord) => {
    records.set(r.turnKey, r)
  }
  const clearCardRecord = (turnKey: string, activityMessageId: number) => {
    const cur = records.get(turnKey)
    if (cur != null && cur.activityMessageId === activityMessageId) records.delete(turnKey)
  }

  const finalizedIds: number[] = []
  const finalizeCard = vi.fn<(r: PreTurnCardRecord) => void>((r) => {
    finalizedIds.push(r.activityMessageId)
  })

  const signal = createHandbackPreturnSignal({
    chatKey: (c, t) => chatKey(c, t),
    deriveTurnId,
    startTypingLoop: (c, t) => typing.start(c, t),
    stopTypingLoop: (c, t) => typing.stop(c, t),
    openCard,
    finalizeCard,
    writeCardRecord,
    clearCardRecord,
    now: sched.now,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    debounceMs: 700,
    adoptTimeoutMs: 30_000,
    ...overrides,
  })

  const h: Harness = { signal, typing, sched, sendChatAction, openCard, finalizeCard, records, finalizedIds }
  harnesses.push(h)
  return h
}

describe('handback-preturn-signal — dead-air pre-turn emit→adopt→reap', () => {
  afterEach(() => {
    // Real setInterval-backed typing loops in the harnesses are unref'd, but
    // clear them so no interval leaks across the runner's test files.
    for (const h of harnesses.splice(0)) h.typing.stopAll()
  })

  it('isHandbackInbound only matches the load-bearing source string', () => {
    expect(isHandbackInbound(handbackInbound({ chatId: 'c', messageId: 1 }))).toBe(true)
    expect(isHandbackInbound(userInbound({ chatId: 'c', messageId: 1 }))).toBe(false)
  })

  it('emits a typing action + a pre-turn card within the debounce window on drain release', async () => {
    const h = makeHarness()
    h.signal.noteHandbackRelease(handbackInbound({ chatId: 'chatA', threadId: 7, messageId: 555 }))

    // Nothing paints before the debounce elapses (flicker guard).
    await h.sched.advance(699)
    expect(h.sendChatAction).not.toHaveBeenCalled()
    expect(h.openCard).not.toHaveBeenCalled()

    // At the debounce boundary: typing loop lights up AND the card opens.
    await h.sched.advance(1)
    expect(h.sendChatAction).toHaveBeenCalledWith('chatA', 7)
    expect(h.typing.activeCount()).toBe(1)
    expect(h.openCard).toHaveBeenCalledTimes(1)
    expect(h.openCard).toHaveBeenCalledWith('chatA', 7)

    // A COMPLETE durable record was persisted under a synthetic pre-turn key.
    expect(h.records.size).toBe(1)
    const rec = [...h.records.values()][0]!
    expect(rec.turnKey.startsWith(PRETURN_TURNKEY_PREFIX)).toBe(true)
    expect(rec.chatId).toBe('chatA')
    expect(rec.threadId).toBe(7)
    expect(typeof rec.activityMessageId).toBe('number')
    expect(typeof rec.startedAt).toBe('number')
  })

  it('adoption across the enqueue boundary edits (no second card) and keeps typing ≥1 continuously', async () => {
    const h = makeHarness()
    h.signal.noteHandbackRelease(handbackInbound({ chatId: 'chatB', messageId: 900 }))
    await h.sched.advance(700)
    expect(h.openCard).toHaveBeenCalledTimes(1)
    const resolvedId = await h.openCard.mock.results[0]!.value

    // Typing is already lit before the turn mints — sample it: never zero.
    expect(h.typing.activeCount()).toBe(1)

    // The enqueue seam mints the SAME turnId deriveTurnId would compute.
    const turnId = deriveTurnId('chatB', null, 900)!
    const adoption = h.signal.tryAdopt(turnId)
    expect(adoption).not.toBeNull()
    expect(adoption!.activityMessageId).toBe(resolvedId)
    expect(adoption!.statusKey).toBe('chatB:_')

    // Adoption is an EDIT: no second card send across the boundary.
    expect(h.openCard).toHaveBeenCalledTimes(1)
    // Typing loop never sampled zero across the seam.
    expect(h.typing.activeCount()).toBe(1)

    // Durable record migrated from the synthetic key to the real topic key so
    // the turn's own end-of-turn clearActivitySummary owns the teardown.
    expect([...h.records.keys()]).toEqual(['chatB:_'])
    expect(h.records.get('chatB:_')!.activityMessageId).toBe(resolvedId)

    // Entry consumed — no lingering pre-turn state.
    expect(h.signal.pendingCount()).toBe(0)
  })

  it('turn-end hands off cleanly: typing stops exactly once, durable record cleared, map empty', async () => {
    const h = makeHarness()
    h.signal.noteHandbackRelease(handbackInbound({ chatId: 'chatC', threadId: 3, messageId: 12 }))
    await h.sched.advance(700)
    const resolvedId = await h.openCard.mock.results[0]!.value
    const turnId = deriveTurnId('chatC', 3, 12)!
    const adoption = h.signal.tryAdopt(turnId)!
    expect(adoption.activityMessageId).toBe(resolvedId)

    // Simulate the gateway's canonical turn-end: clearActivitySummary clears the
    // durable record (statusKey + exact id) and stopTurnTypingLoop stops once.
    h.records.delete('chatC:3') // clearActivityCardRecord(statusKey, id)
    h.typing.stop('chatC', 3)

    expect(h.typing.activeCount()).toBe(0)
    expect(h.records.size).toBe(0)
    expect(h.signal.pendingCount()).toBe(0)
  })

  it('never-adopted handback self-reaps its frozen card past the TTL', async () => {
    const h = makeHarness()
    h.signal.noteHandbackRelease(handbackInbound({ chatId: 'chatD', messageId: 77 }))
    await h.sched.advance(700)
    const resolvedId = await h.openCard.mock.results[0]!.value
    expect(h.typing.activeCount()).toBe(1)
    expect(h.records.size).toBe(1)

    // No enqueue ever arrives. Past the adopt TTL the orphan self-reaps.
    await h.sched.advance(30_000)

    expect(h.finalizedIds).toEqual([resolvedId]) // finalized exactly THAT card
    expect(h.typing.activeCount()).toBe(0) // typing stopped
    expect(h.records.size).toBe(0) // durable record cleared (at-most-once)
    expect(h.signal.pendingCount()).toBe(0) // map empty
  })

  it('identity race: a user inbound on the same topic never mis-adopts the handback, no double-send', async () => {
    const h = makeHarness()
    h.signal.noteHandbackRelease(handbackInbound({ chatId: 'chatE', messageId: 200 }))
    await h.sched.advance(700)
    expect(h.openCard).toHaveBeenCalledTimes(1)

    // A racing user inbound on the SAME topic key mints a DIFFERENT turnId.
    const userTurnId = deriveTurnId('chatE', null, 201)! // user's message id
    expect(h.signal.tryAdopt(userTurnId)).toBeNull() // must NOT mis-adopt
    expect(h.signal.pendingCount()).toBe(1) // handback entry still live

    // The handback's own enqueue adopts correctly — still exactly one send.
    const handbackTurnId = deriveTurnId('chatE', null, 200)!
    const adoption = h.signal.tryAdopt(handbackTurnId)
    expect(adoption).not.toBeNull()
    expect(h.openCard).toHaveBeenCalledTimes(1) // no double-send
    expect(h.signal.pendingCount()).toBe(0)
  })

  it('dedupes a second handback release for the same topic; ignores non-handback inbounds', async () => {
    const h = makeHarness()
    // Non-handback → no-op.
    h.signal.noteHandbackRelease(userInbound({ chatId: 'chatF', messageId: 1 }))
    expect(h.signal.pendingCount()).toBe(0)

    // Two handbacks for the same topic → the first owns the pre-turn signal.
    h.signal.noteHandbackRelease(handbackInbound({ chatId: 'chatF', messageId: 10 }))
    h.signal.noteHandbackRelease(handbackInbound({ chatId: 'chatF', messageId: 11 }))
    expect(h.signal.pendingCount()).toBe(1)
    await h.sched.advance(700)
    expect(h.openCard).toHaveBeenCalledTimes(1)
  })

  it('skips the emit when the adopting turn already settled before the debounce fires', async () => {
    const settled = new Set<string>()
    const h = makeHarness({ isTurnSettled: (k) => settled.has(k) })
    h.signal.noteHandbackRelease(handbackInbound({ chatId: 'chatG', messageId: 5 }))
    settled.add('chatG:_') // the turn delivered its answer during the debounce
    await h.sched.advance(700)
    expect(h.openCard).not.toHaveBeenCalled()
    expect(h.typing.activeCount()).toBe(0)
    expect(h.signal.pendingCount()).toBe(0)
  })
})
