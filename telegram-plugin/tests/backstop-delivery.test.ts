import { describe, expect, it } from 'vitest'

import {
  BackstopDeliveryLedger,
  backstopReceiptIds,
  backstopDelivered,
} from '../gateway/backstop-delivery.js'
import {
  backstopSendOutcomeGated,
  finalizeBackstopSendGated,
  computeTurnStatus,
} from '../gateway/turn-record-status.js'

/**
 * #3276 — the turn-flush backstop delivered by editing the ephemeral progress
 * card and counted that card-edit id as an answer delivery, so the turn record
 * said `complete` while the card was GC'd and nothing durable reached the chat.
 *
 * These assert the deterministic OUTCOMES the fix guarantees:
 *  - a delivered answer is a FRESH non-card chat id (guard 7),
 *  - `complete` IFF such an id exists; card-only "success" ⇒ `send_failed`,
 *  - a per-turn latch arbitrates backstop-vs-reply exactly once (guard 5),
 *  - a partial send + retry never re-sends chunk 0 (guard 6).
 *
 * Each is red on today's card-coupled backstop: it would report the card id as
 * the delivered id (fails the "id ≠ card" assertions) and derive `complete`
 * from a raw chunk count (fails the card-only ⇒ `send_failed` assertion).
 */

describe('guard 7 — receipt gate: a delivered answer is a FRESH non-card chat id', () => {
  it('primary: a fresh chat id is recorded whose id ≠ any card id', () => {
    const cardId = 500
    const sentIds = [777] // a fresh sendMessage id, not the card
    const fresh = backstopReceiptIds(sentIds, cardId)
    expect(fresh).toEqual([777])
    expect(fresh).not.toContain(cardId)
    expect(backstopDelivered(sentIds, cardId)).toBe(true)
  })

  it('card-present: the delivered id excludes backstopCardMessageId', () => {
    const cardId = 18944
    // The pre-fix backstop pushed the card id into sentIds via editMessageText.
    const raw = [18944]
    expect(backstopReceiptIds(raw, cardId)).toEqual([])
    expect(backstopDelivered(raw, cardId)).toBe(false)
  })

  it('mixed: only the fresh ids survive the gate', () => {
    const cardId = 18944
    expect(backstopReceiptIds([18944, 18950, 18951], cardId)).toEqual([18950, 18951])
  })
})

describe('status honesty — complete IFF a real non-card id exists', () => {
  it('card-only delivery ⇒ send_failed, never complete', () => {
    const cardId = 18944
    const turn: { finalAnswerDelivered: boolean; deliveryOutcome?: 'delivered' | 'failed' | 'suppressed' } = {
      finalAnswerDelivered: true,
    }
    finalizeBackstopSendGated(turn, {
      threw: false,
      sentIds: [18944], // only the card was edited
      chunkCount: 1,
      cardMessageId: cardId,
    })
    expect(turn.deliveryOutcome).toBe('failed')
    expect(computeTurnStatus(turn)).toBe('send_failed')
  })

  it('fresh chat id delivered ⇒ complete', () => {
    const turn: { finalAnswerDelivered: boolean; deliveryOutcome?: 'delivered' | 'failed' | 'suppressed' } = {
      finalAnswerDelivered: true,
    }
    finalizeBackstopSendGated(turn, {
      threw: false,
      sentIds: [18950],
      chunkCount: 1,
      cardMessageId: 18944,
    })
    expect(turn.deliveryOutcome).toBe('delivered')
    expect(computeTurnStatus(turn)).toBe('complete')
  })

  it('partial multi-chunk (fewer fresh ids than chunks) ⇒ send_failed', () => {
    expect(
      backstopSendOutcomeGated({ threw: false, sentIds: [18950], chunkCount: 2, cardMessageId: null }),
    ).toBe('failed')
  })

  it('throw ⇒ failed regardless of ids', () => {
    expect(
      backstopSendOutcomeGated({ threw: true, sentIds: [18950], chunkCount: 1, cardMessageId: null }),
    ).toBe('failed')
  })

  it('empty split (0 chunks) ⇒ failed, not delivered', () => {
    expect(
      backstopSendOutcomeGated({ threw: false, sentIds: [], chunkCount: 0, cardMessageId: null }),
    ).toBe('failed')
  })
})

describe('guard 5 — once-per-turn delivery latch arbitrates backstop-vs-reply', () => {
  it('claim returns true exactly once per turnId', () => {
    const ledger = new BackstopDeliveryLedger()
    expect(ledger.claim('#18925')).toBe(true)
    expect(ledger.claim('#18925')).toBe(false)
    expect(ledger.isLatched('#18925')).toBe(true)
    // A different turn is independent.
    expect(ledger.claim('#18929')).toBe(true)
  })

  it('release re-opens the latch so a genuine late reply is not suppressed', () => {
    const ledger = new BackstopDeliveryLedger()
    ledger.claim('#t')
    ledger.release('#t')
    expect(ledger.isLatched('#t')).toBe(false)
  })
})

describe('guard 6 — per-chunk idempotency ledger: retry never re-sends chunk 0', () => {
  it('resumes at the first unsent chunk after a partial send', () => {
    const ledger = new BackstopDeliveryLedger()
    const turnId = '#partial'
    const chunkCount = 3
    // First attempt: chunk 0 and 1 land, chunk 2 throws before acking.
    ledger.markPending(turnId, 0)
    ledger.recordChunk(turnId, 0, [1001])
    ledger.markPending(turnId, 1)
    ledger.recordChunk(turnId, 1, [1002])
    ledger.markPending(turnId, 2) // in-flight, never acked

    // Retry: chunk 0 and 1 are already delivered → resume set is [2] only.
    expect(ledger.hasChunk(turnId, 0)).toBe(true)
    expect(ledger.hasChunk(turnId, 1)).toBe(true)
    expect(ledger.hasChunk(turnId, 2)).toBe(false)
    expect(ledger.unsentIndices(turnId, chunkCount)).toEqual([2])

    // Complete the retry.
    ledger.recordChunk(turnId, 2, [1003])
    expect(ledger.sentIds(turnId)).toEqual([1001, 1002, 1003])
    // Chunk 0 was never re-sent — its id is unchanged.
    expect(ledger.sentIds(turnId)[0]).toBe(1001)
  })

  it('sentIds are returned in chunk-index order regardless of record order', () => {
    const ledger = new BackstopDeliveryLedger()
    ledger.recordChunk('#o', 2, [3])
    ledger.recordChunk('#o', 0, [1])
    ledger.recordChunk('#o', 1, [2])
    expect(ledger.sentIds('#o')).toEqual([1, 2, 3])
  })
})
