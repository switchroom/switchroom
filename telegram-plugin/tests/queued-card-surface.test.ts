/**
 * Part B (#3927 follow-up) — the queued-turn card.
 *
 * Since #3927 a genuinely-queued mid-turn message is PARKED with no surface at
 * all until it dequeues: on the machine-authoritative path the legacy Hook A
 * placeholder never fires (it lives in the buffer-until-idle branch that returns
 * before the machine enqueues). These tests assert the fix's lifecycle against
 * the REAL `handleSessionEvent`:
 *
 *   • park    → a "⏳ Queued" card is posted ONCE, reply-anchored to the parked
 *               message, in the envelope's own chat/thread.
 *   • dequeue → the SAME card id is adopted as the turn's activityMessageId and
 *               EDITED in place (not re-sent) — one continuous lifecycle.
 *   • remove  → the card is finalized as "folded into the current task".
 *   • TTL     → the card is finalized as timed-out, never left frozen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  handleSessionEvent,
  __resetParkedTurnStartsForTest,
  __parkedTurnStartCountForTest,
} from '../gateway/stream-render.js'
import { makeHarness, enqueue, type Harness } from './turn-mint-harness.js'

interface SendRec { chatId: string; markdown: string; opts: Record<string, unknown>; id: number }
interface EditRec { chatId: string; messageId: number; markdown: string }
interface DelRec { chatId: string; messageId: number }

/** Attach a recording bot to a harness so the queued-card send/edit/delete calls
 *  are observable. `sendRichMessage` returns an incrementing message id. */
function withRecordingBot(h: Harness) {
  const sends: SendRec[] = []
  const edits: EditRec[] = []
  const deletes: DelRec[] = []
  let nextId = 9001
  ;(h.deps as unknown as { bot: unknown }).bot = {
    api: {
      sendRichMessage: async (chatId: string, msg: { markdown: string }, opts: Record<string, unknown>) => {
        const id = nextId++
        sends.push({ chatId, markdown: msg.markdown, opts, id })
        return { message_id: id }
      },
      editMessageText: async (chatId: string, messageId: number, msg: { markdown: string }) => {
        edits.push({ chatId, messageId, markdown: msg.markdown })
        return true
      },
      deleteMessage: async (chatId: string, messageId: number) => {
        deletes.push({ chatId, messageId })
        return true
      },
    },
  }
  return { sends, edits, deletes }
}

/** Flush the microtask + macrotask queue so the async card send's `.then` (which
 *  stores the card id on the parked envelope) has run. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  __resetParkedTurnStartsForTest()
})

describe('Part B — queued card is posted at park and adopted on dequeue', () => {
  it('parks with a reply-anchored "Queued" card, then EDITS that same card in place on dequeue', async () => {
    const h = makeHarness()
    const rec = withRecordingBot(h)

    // Turn A mints on an idle session.
    handleSessionEvent(h.deps, enqueue('501'))
    const turnA = h.current()!
    expect(rec.sends).toHaveLength(0) // idle mint posts no queued card

    // Message B arrives mid-turn → parks → queued card is posted ONCE.
    handleSessionEvent(h.deps, enqueue('502', 'also check the vault'))
    await settle()
    expect(__parkedTurnStartCountForTest()).toBe(1)
    expect(rec.sends).toHaveLength(1)
    const card = rec.sends[0]!
    expect(card.markdown).toContain('Queued')
    // Reply-anchored to B's own message id, in B's chat.
    expect((card.opts.reply_parameters as { message_id: number }).message_id).toBe(502)
    expect(card.chatId).toBe('1001')

    // Turn A ends; the CLI drains the queue → B mints and ADOPTS the card.
    turnA.endedAt = Date.now()
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    const turnB = h.current()!
    expect(turnB).not.toBe(turnA)
    expect(turnB.sourceMessageId).toBe(502)
    // The queued card became the live progress card — same id, adopted in place.
    expect(turnB.activityMessageId).toBe(card.id)
    expect(turnB.activityEverOpened).toBe(true)
    // No SECOND card was ever sent (edited in place, not re-posted).
    expect(rec.sends).toHaveLength(1)
  })

  it('posts one card PER envelope (multiple queued messages each get their own)', async () => {
    const h = makeHarness()
    const rec = withRecordingBot(h)

    handleSessionEvent(h.deps, enqueue('601'))
    handleSessionEvent(h.deps, enqueue('602'))
    handleSessionEvent(h.deps, enqueue('603'))
    await settle()
    expect(__parkedTurnStartCountForTest()).toBe(2)
    expect(rec.sends).toHaveLength(2)
    expect(new Set(rec.sends.map((s) => s.id)).size).toBe(2)
  })
})

describe('Part B — queued card is finalized, never frozen', () => {
  it('finalizes the card as "folded" when the message is removed (folded into the running turn)', async () => {
    const h = makeHarness()
    const rec = withRecordingBot(h)

    handleSessionEvent(h.deps, enqueue('701'))
    const queued = enqueue('702', 'while you are in there…')
    handleSessionEvent(h.deps, queued)
    await settle()
    expect(rec.sends).toHaveLength(1)
    const cardId = rec.sends[0]!.id

    handleSessionEvent(h.deps, { kind: 'queue_remove', rawContent: queued.rawContent })
    expect(__parkedTurnStartCountForTest()).toBe(0)
    // The card was edited (finalized) in place — folded, not left on "Queued".
    expect(rec.edits).toHaveLength(1)
    expect(rec.edits[0]!.messageId).toBe(cardId)
    expect(rec.edits[0]!.markdown).toContain('Folded')
  })

  it('finalizes the card as timed-out on TTL expiry (a dequeue that never arrives)', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      const rec = withRecordingBot(h)

      handleSessionEvent(h.deps, enqueue('1201'))
      const turnA = h.current()!
      handleSessionEvent(h.deps, enqueue('1202'))
      // Under fake timers the send still resolves on a real microtask flush.
      await vi.runAllTimersAsync()
      expect(rec.sends).toHaveLength(1)
      const cardId = rec.sends[0]!.id

      // 31 minutes pass with neither dequeue nor remove; a stray dequeue prunes it.
      vi.advanceTimersByTime(31 * 60_000)
      turnA.endedAt = Date.now()
      handleSessionEvent(h.deps, { kind: 'dequeue' })
      await vi.runAllTimersAsync()

      expect(__parkedTurnStartCountForTest()).toBe(0)
      expect(h.current()).toBe(turnA) // 1202 was NOT minted 31 min late
      expect(rec.edits).toHaveLength(1)
      expect(rec.edits[0]!.messageId).toBe(cardId)
      expect(rec.edits[0]!.markdown).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})
