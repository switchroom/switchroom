/**
 * system-message-observer — the card-lane recorder's pure behaviour (#4571).
 *
 * The observer hangs off gateway.ts's single `robustApiCall` chokepoint and
 * turns every card the gateway posts (activity summary, status pin, approval /
 * boot / issues cards, progress lines) into ONE resolvable history row. The
 * two properties that make it safe to run on the hot send path are asserted
 * here against a fake writer pair:
 *
 *   1. an EDIT of a card it already recorded never creates a second row, and
 *      inside the refresh window costs zero writer calls at all;
 *   2. an id that turns out to belong to a real reply / inbound is demoted to
 *      `foreign` and never written to again.
 *
 * The end-to-end proof (card posted → id resolvable → a reply pointing at it
 * is understood) needs a real bun:sqlite history.db and lives in
 * card-history-lane.test.ts (bun).
 */

import { describe, it, expect } from 'vitest'
import {
  makeSystemMessageObserver,
  normalizeSendVerb,
  extractSentMessage,
  DEFAULT_EDIT_REFRESH_MS,
} from '../gateway/system-message-observer.js'

const CHAT = '5550001'

/** A Telegram `Message` response as the Bot API returns it from sendMessage /
 *  editMessageText. */
function sentMessage(messageId: number, text: string, threadId?: number) {
  return {
    message_id: messageId,
    chat: { id: Number(CHAT) },
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    text,
  }
}

/** A writer pair backed by a Map, mirroring recordSystemOutbound /
 *  updateSystemOutboundText's real return contract. */
function fakeStore(seed?: Record<number, { role: 'system' | 'other'; text: string }>) {
  const rows = new Map<number, { role: 'system' | 'other'; text: string; kind: string | null }>()
  for (const [id, r] of Object.entries(seed ?? {})) {
    rows.set(Number(id), { role: r.role, text: r.text, kind: null })
  }
  const calls = { insert: 0, update: 0 }
  return {
    rows,
    calls,
    insert(args: { message_id: number; kind: string | null; text: string }): boolean {
      calls.insert++
      if (rows.has(args.message_id)) return false
      rows.set(args.message_id, { role: 'system', text: args.text, kind: args.kind })
      return true
    },
    updateText(args: { message_id: number; text: string }): boolean {
      calls.update++
      const row = rows.get(args.message_id)
      if (row == null || row.role !== 'system') return false
      row.text = args.text
      return true
    },
  }
}

describe('normalizeSendVerb', () => {
  it('strips the transport suffix so a card OPEN and its EDITs classify identically', () => {
    expect(normalizeSendVerb('activity-summary.send')).toBe('activity-summary')
    expect(normalizeSendVerb('activity-summary.edit')).toBe('activity-summary')
  })

  it('passes a suffix-less verb through and returns null for an untagged send', () => {
    expect(normalizeSendVerb('boot-card')).toBe('boot-card')
    expect(normalizeSendVerb(undefined)).toBeNull()
    expect(normalizeSendVerb('   ')).toBeNull()
  })
})

describe('extractSentMessage', () => {
  it('ignores non-Message results (pins/deletes/reactions return true, swallowed 400s undefined)', () => {
    expect(extractSentMessage(true, { chat_id: CHAT })).toBeNull()
    expect(extractSentMessage(undefined, { chat_id: CHAT })).toBeNull()
    expect(extractSentMessage({ ok: true }, { chat_id: CHAT })).toBeNull()
  })

  it("prefers the response's own chat and thread over the caller's opts", () => {
    const out = extractSentMessage(sentMessage(20267, 'card body', 77), {
      chat_id: 'wrong',
      threadId: 5,
    })
    expect(out).toEqual({ chatId: CHAT, messageId: 20267, threadId: 77, text: 'card body' })
  })

  it('falls back to the caller chat/thread when the response omits them', () => {
    const out = extractSentMessage({ message_id: 9, text: 'x' }, { chat_id: CHAT, threadId: 5 })
    expect(out).toEqual({ chatId: CHAT, messageId: 9, threadId: 5, text: 'x' })
  })
})

describe('makeSystemMessageObserver', () => {
  it('records a posted card once, and an EDIT of it never adds a second row', () => {
    const store = fakeStore()
    let now = 1_000
    const observe = makeSystemMessageObserver({ insert: store.insert, updateText: store.updateText, now: () => now })

    observe(sentMessage(20267, 'Working… reading history.ts'), {
      chat_id: CHAT,
      verb: 'activity-summary.send',
    })
    expect(store.rows.size).toBe(1)
    expect(store.rows.get(20267)?.kind).toBe('activity-summary')

    // 40 edits of the SAME card, spread well past the refresh window.
    for (let i = 0; i < 40; i++) {
      now += DEFAULT_EDIT_REFRESH_MS + 1
      observe(sentMessage(20267, `Working… step ${i}`), {
        chat_id: CHAT,
        verb: 'activity-summary.edit',
      })
    }
    // The outcome that matters: still exactly one row for that card.
    expect(store.rows.size).toBe(1)
    // …carrying a recent snapshot of the card body, not the stale open text.
    expect(store.rows.get(20267)?.text).toBe('Working… step 39')
  })

  it('does no DB work at all for edits inside the refresh window', () => {
    const store = fakeStore()
    let now = 1_000
    const observe = makeSystemMessageObserver({ insert: store.insert, updateText: store.updateText, now: () => now })

    observe(sentMessage(30, 'open'), { chat_id: CHAT, verb: 'activity-summary.send' })
    const afterOpen = { ...store.calls }

    for (let i = 0; i < 25; i++) {
      now += 100 // ~2.5s of a climbing activity card
      observe(sentMessage(30, `tick ${i}`), { chat_id: CHAT, verb: 'activity-summary.edit' })
    }
    expect(store.calls.insert).toBe(afterOpen.insert)
    expect(store.calls.update).toBe(afterOpen.update)
  })

  it('leaves a real reply / inbound alone and stops probing it', () => {
    // 4242 already belongs to a non-system row (recordOutbound got there first).
    const store = fakeStore({ 4242: { role: 'other', text: 'the real answer' } })
    let now = 1_000
    const observe = makeSystemMessageObserver({ insert: store.insert, updateText: store.updateText, now: () => now })

    observe(sentMessage(4242, 'edited answer'), { chat_id: CHAT, verb: 'reply' })
    expect(store.rows.get(4242)).toEqual({ role: 'other', text: 'the real answer', kind: null })

    const afterProbe = { ...store.calls }
    for (let i = 0; i < 10; i++) {
      now += DEFAULT_EDIT_REFRESH_MS + 1
      observe(sentMessage(4242, `edited answer ${i}`), { chat_id: CHAT, verb: 'reply' })
    }
    // One probing update total — then the id is marked foreign forever.
    expect(store.calls.insert).toBe(afterProbe.insert)
    expect(store.calls.update).toBe(afterProbe.update)
    expect(store.rows.get(4242)?.text).toBe('the real answer')
  })

  it('demotes a card that got promoted to a real reply mid-turn', () => {
    const store = fakeStore()
    let now = 1_000
    const observe = makeSystemMessageObserver({ insert: store.insert, updateText: store.updateText, now: () => now })

    observe(sentMessage(55, 'card'), { chat_id: CHAT, verb: 'activity-summary.send' })
    // recordOutbound promotes the row to a real assistant reply.
    store.rows.set(55, { role: 'other', text: 'the real answer', kind: null })

    now += DEFAULT_EDIT_REFRESH_MS + 1
    observe(sentMessage(55, 'card edit'), { chat_id: CHAT, verb: 'activity-summary.edit' })
    expect(store.rows.get(55)?.text).toBe('the real answer')

    const after = { ...store.calls }
    now += DEFAULT_EDIT_REFRESH_MS + 1
    observe(sentMessage(55, 'card edit 2'), { chat_id: CHAT, verb: 'activity-summary.edit' })
    expect(store.calls.update).toBe(after.update)
  })

  it('never throws when the writer blows up — observing a send cannot break the send', () => {
    const observe = makeSystemMessageObserver({
      insert: () => {
        throw new Error('disk full')
      },
      updateText: () => {
        throw new Error('disk full')
      },
    })
    expect(() => observe(sentMessage(1, 'x'), { chat_id: CHAT })).not.toThrow()
  })

  it('evicts under load without losing the one-row-per-card guarantee', () => {
    const store = fakeStore()
    let now = 1_000
    const observe = makeSystemMessageObserver(
      { insert: store.insert, updateText: store.updateText, now: () => now },
      { maxTracked: 8 },
    )

    for (let id = 1; id <= 64; id++) {
      observe(sentMessage(id, `card ${id}`), { chat_id: CHAT, verb: 'boot-card' })
    }
    expect(store.rows.size).toBe(64)

    // An evicted id re-observed: the insert is refused by the store, the probe
    // finds a system row, and no duplicate appears.
    now += DEFAULT_EDIT_REFRESH_MS + 1
    observe(sentMessage(1, 'card 1 edited'), { chat_id: CHAT, verb: 'boot-card' })
    expect(store.rows.size).toBe(64)
    expect(store.rows.get(1)?.text).toBe('card 1 edited')
  })
})
