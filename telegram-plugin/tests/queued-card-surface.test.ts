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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  handleSessionEvent,
  __resetParkedTurnStartsForTest,
  __parkedTurnStartCountForTest,
} from '../gateway/stream-render.js'
import { makeHarness, enqueue, CHAT, type Harness } from './turn-mint-harness.js'
import { deriveTurnId } from '../gateway/derive-turn-id.js'

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

// The parked store is module-scope and `bun test` runs all ~657 files in ONE
// process, so resetting on ENTRY alone is not enough: a case that ends mid-park
// leaves the entry behind for every later FILE. #4611 — this suite's last case
// parks msg 502 and never dequeues, and the leftover made the obligation sweep
// read the session as busy for the rest of the run, failing represent-guard.
beforeEach(() => {
  __resetParkedTurnStartsForTest()
})
afterEach(() => {
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
    // Runner-agnostic: the TTL prune reads wall-clock `Date.now()` (it is NOT a
    // scheduled setTimeout), so we drive it by advancing `Date.now` around the
    // dequeue rather than a vitest-only fake-timer API (`vi.runAllTimersAsync`
    // is absent under bun — the same reason handback-preturn-signal.test.ts
    // injects its own scheduler). `parkedAt` is stamped with the REAL clock at
    // park; only the prune's `now` is advanced, so the entry ages past the TTL.
    const h = makeHarness()
    const rec = withRecordingBot(h)

    handleSessionEvent(h.deps, enqueue('1201'))
    const turnA = h.current()!
    handleSessionEvent(h.deps, enqueue('1202'))
    await settle() // real microtask/macrotask flush → the card id lands on the entry
    expect(rec.sends).toHaveLength(1)
    const cardId = rec.sends[0]!.id

    // 31 minutes pass with neither dequeue nor remove; a stray dequeue prunes it.
    const realNow = Date.now
    Date.now = () => realNow() + 31 * 60_000
    try {
      turnA.endedAt = Date.now()
      handleSessionEvent(h.deps, { kind: 'dequeue' })
    } finally {
      Date.now = realNow
    }
    await settle()

    expect(__parkedTurnStartCountForTest()).toBe(0)
    expect(h.current()).toBe(turnA) // 1202 was NOT minted 31 min late
    expect(rec.edits).toHaveLength(1)
    expect(rec.edits[0]!.messageId).toBe(cardId)
    expect(rec.edits[0]!.markdown).toContain('timed out')
  })
})

/**
 * Regression for the handback-while-busy MAJOR (adversarial review of #4040).
 *
 * The COMMON worker-handoff case: a worker hands back while the parent session
 * is busy → the handback pre-turn signal arms a card for that turn → the same
 * handback inbound parks → (before the fix) the park posted a SECOND "⏳ Queued"
 * card unconditionally → on dequeue the handback `tryAdopt` won the surface, so
 * the Part B `activityMessageId == null` guard was false and the queued card was
 * neither adopted nor finalized → TWO cards for one message, the queued one
 * FROZEN forever.
 *
 * The shared harness hardcodes `HANDBACK_PRETURN_ENABLED:false` +
 * `tryAdopt:()=>null`, so it never exercised this; here we turn the signal ON
 * with a card-bearing `tryAdopt`, matching prod. Both tests fail on the current
 * HEAD (a queued card is posted and then frozen) and pass after the fix.
 */
const HANDBACK_CARD_ID = 7777

/** Turn the handback pre-turn signal ON for message `msgId`'s turn. `pendingAtPark`
 *  models whether `noteHandbackRelease` has already armed the entry by the time the
 *  message parks (true = the common case; false = the sub-second race the beginTurn
 *  safety net covers). `tryAdopt` always returns the handback card for that turn. */
function withHandbackFor(h: Harness, msgId: string, pendingAtPark: boolean) {
  const tid = deriveTurnId(CHAT, null, msgId)!
  const d = h.deps as unknown as {
    HANDBACK_PRETURN_ENABLED: boolean
    handbackPreturnSignal: {
      hasPendingForTurnId: (t: string) => boolean
      tryAdopt: (t: string) => { activityMessageId: number | null; statusKey: string } | null
    }
  }
  d.HANDBACK_PRETURN_ENABLED = true
  d.handbackPreturnSignal = {
    hasPendingForTurnId: (t: string) => pendingAtPark && t === tid,
    tryAdopt: (t: string) =>
      t === tid ? { activityMessageId: HANDBACK_CARD_ID, statusKey: `${CHAT}:main` } : null,
  }
  return tid
}

describe('Part B — handback-while-busy: exactly one card, never a frozen "Queued"', () => {
  it('SUPPRESSES the queued card at park when a handback signal already owns the turn (common case)', async () => {
    const h = makeHarness()
    const rec = withRecordingBot(h)
    withHandbackFor(h, '502', /* pendingAtPark */ true)

    // Turn A mints on an idle session.
    handleSessionEvent(h.deps, enqueue('501'))
    const turnA = h.current()!

    // The handback inbound (502) parks while A is busy. The handback signal
    // already owns 502's surface → NO queued card is posted.
    handleSessionEvent(h.deps, enqueue('502', 'handback: worker done'))
    await settle()
    expect(rec.sends).toHaveLength(0) // ← fails on HEAD (a 2nd card was posted)

    // A ends → 502 dequeues → adopts the HANDBACK card as its one surface.
    turnA.endedAt = Date.now()
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    const turnB = h.current()!
    expect(turnB.activityMessageId).toBe(HANDBACK_CARD_ID)
    // No queued card was ever posted, edited, or left frozen.
    expect(rec.sends).toHaveLength(0)
    expect(rec.edits).toHaveLength(0)
    expect(rec.deletes).toHaveLength(0)
  })

  it('DELETES the orphaned queued card at dequeue when the handback armed after park (the race)', async () => {
    const h = makeHarness()
    const rec = withRecordingBot(h)
    withHandbackFor(h, '502', /* pendingAtPark */ false)

    handleSessionEvent(h.deps, enqueue('501'))
    const turnA = h.current()!

    // 502 parks BEFORE the handback entry armed → the queued card is posted.
    handleSessionEvent(h.deps, enqueue('502', 'handback: worker done'))
    await settle()
    expect(rec.sends).toHaveLength(1)
    const queuedCardId = rec.sends[0]!.id

    // A ends → 502 dequeues → the handback adoption WINS the surface, and the
    // now-orphaned queued card is DELETED so it never freezes on "⏳ Queued".
    turnA.endedAt = Date.now()
    handleSessionEvent(h.deps, { kind: 'dequeue' })
    const turnB = h.current()!
    expect(turnB.activityMessageId).toBe(HANDBACK_CARD_ID) // handback card is the surface
    expect(rec.deletes).toHaveLength(1) // ← fails on HEAD (no cleanup, card frozen)
    expect(rec.deletes[0]!.messageId).toBe(queuedCardId)
    // One live card total: the handback card. The queued card was removed, not
    // left as a frozen "Queued" and not finalized as folded/timed-out.
    expect(rec.edits).toHaveLength(0)
  })
})

describe('Part B — synthetic (fabricated) message ids never 400 the queued card', () => {
  /** Recording bot that enforces the REAL Telegram Bot API contract on
   *  `reply_parameters.message_id`: anything non-integer or beyond signed int32
   *  is hard-rejected with the exact 400 the live gateway hit
   *  (gateway-supervisor.log 2026-08-04, msg=1785846295635) — BEFORE recording,
   *  exactly like the wire call. `allow_sending_without_reply` does not bypass
   *  the range check, only the message-not-found case. */
  function withTelegramStrictBot(h: Harness) {
    const sends: SendRec[] = []
    let nextId = 9001
    ;(h.deps as unknown as { bot: unknown }).bot = {
      api: {
        sendRichMessage: async (chatId: string, msg: { markdown: string }, opts: Record<string, unknown>) => {
          const rp = opts.reply_parameters as { message_id?: unknown } | undefined
          if (rp != null) {
            const mid = rp.message_id
            if (typeof mid !== 'number' || !Number.isInteger(mid) || mid <= 0 || mid >= 2 ** 31) {
              throw new Error(
                `Call to 'sendRichMessage' failed! (400: Bad Request: field "message_id" must be a valid Number)`,
              )
            }
          }
          const id = nextId++
          sends.push({ chatId, markdown: msg.markdown, opts, id })
          return { message_id: id }
        },
        editMessageText: async () => true,
        deleteMessage: async () => true,
      },
    }
    return { sends }
  }

  it('sends the queued card UNANCHORED (no 400) when the parked message id is a fabricated Date.now() timestamp', async () => {
    const h = makeHarness()
    const rec = withTelegramStrictBot(h)

    // Turn A mints on an idle session.
    handleSessionEvent(h.deps, enqueue('501'))
    expect(rec.sends).toHaveLength(0)

    // A synthetic enqueue (subagent handback / boot resume) parks mid-turn with
    // a fabricated ms-timestamp message id — finite, but NOT a Telegram id.
    handleSessionEvent(h.deps, enqueue('1785846295635', 'handback: worker done'))
    await settle()
    expect(__parkedTurnStartCountForTest()).toBe(1)

    // The card SENT (no 400 — RED on the pre-fix guard, which forwarded the
    // 13-digit id into reply_parameters and lost the whole card)…
    expect(rec.sends).toHaveLength(1)
    // …and it sent WITHOUT reply-linkage: no reply_parameters at all.
    expect(rec.sends[0]!.opts.reply_parameters).toBeUndefined()
  })

  it('still reply-anchors when the parked message id is a real Telegram id', async () => {
    const h = makeHarness()
    const rec = withTelegramStrictBot(h)

    handleSessionEvent(h.deps, enqueue('501'))
    handleSessionEvent(h.deps, enqueue('502', 'real mid-turn message'))
    await settle()
    expect(rec.sends).toHaveLength(1)
    expect((rec.sends[0]!.opts.reply_parameters as { message_id: number }).message_id).toBe(502)
  })
})
