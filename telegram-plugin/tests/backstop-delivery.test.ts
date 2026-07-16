import { describe, expect, it, vi } from 'vitest'

import {
  BackstopDeliveryLedger,
  backstopReceiptIds,
  backstopDelivered,
  runBackstopDelivery,
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
 *  - a per-turn backstop double-fire latch (guard 5),
 *  - a bounded retry resumes mid-chunk and never re-sends chunk 0 (guard 6),
 *  - terminal failure reports `delivered:false` so the caller leaves the
 *    delivery obligation OPEN (finding 1).
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

describe('guard 5 — once-per-turn backstop double-fire latch', () => {
  it('claim returns true exactly once per turnId', () => {
    const ledger = new BackstopDeliveryLedger()
    expect(ledger.claim('#18925')).toBe(true)
    expect(ledger.claim('#18925')).toBe(false)
    // A different turn is independent.
    expect(ledger.claim('#18929')).toBe(true)
  })

  it('release re-opens the latch after a terminal failure', () => {
    const ledger = new BackstopDeliveryLedger()
    ledger.claim('#t')
    ledger.release('#t')
    expect(ledger.claim('#t')).toBe(true)
  })
})

describe('guard 6 — per-chunk idempotency ledger: retry never re-sends chunk 0', () => {
  it('resumes at the first unsent chunk after a partial send', () => {
    const ledger = new BackstopDeliveryLedger()
    const turnId = '#partial'
    const chunkCount = 3
    ledger.markPending(turnId, 0)
    ledger.recordChunk(turnId, 0, [1001])
    ledger.markPending(turnId, 1)
    ledger.recordChunk(turnId, 1, [1002])
    ledger.markPending(turnId, 2) // in-flight, never acked

    expect(ledger.hasChunk(turnId, 0)).toBe(true)
    expect(ledger.hasChunk(turnId, 1)).toBe(true)
    expect(ledger.hasChunk(turnId, 2)).toBe(false)
    expect(ledger.unsentIndices(turnId, chunkCount)).toEqual([2])

    ledger.recordChunk(turnId, 2, [1003])
    expect(ledger.sentIds(turnId)).toEqual([1001, 1002, 1003])
    expect(ledger.sentIds(turnId)[0]).toBe(1001)
  })

  it('sentIds are returned in chunk-index order regardless of record order', () => {
    const ledger = new BackstopDeliveryLedger()
    ledger.recordChunk('#o', 2, [3])
    ledger.recordChunk('#o', 0, [1])
    ledger.recordChunk('#o', 1, [2])
    expect(ledger.sentIds('#o')).toEqual([1, 2, 3])
  })

  it('entries() zip a resplit chunk (2 ids for 1 input chunk) in order', () => {
    const ledger = new BackstopDeliveryLedger()
    ledger.recordChunk('#z', 0, [10])
    ledger.recordChunk('#z', 1, [11, 12]) // chunk 1 length-resplit into 2 sends
    expect(ledger.entries('#z')).toEqual([
      { index: 0, messageIds: [10] },
      { index: 1, messageIds: [11, 12] },
    ])
  })
})

/**
 * Integration oracles over `runBackstopDelivery` — the exact orchestration that
 * replaced the card-coupled send. It drives the real retry/ledger/receipt code
 * with an injected `sendChunk`, asserting on what reaches `recordOutbound` and
 * on the `delivered`/`exhausted` decision the gateway feeds to the obligation
 * ledger + turn record.
 */
describe('runBackstopDelivery — integration oracle over the delivery wiring', () => {
  it('records a FRESH non-card id in history; delivered=true (#3276 primary)', async () => {
    const ledger = new BackstopDeliveryLedger()
    const cardId = 18944
    const recorded: Array<{ ids: number[]; texts: string[] }> = []
    const sendChunk = vi.fn(async (i: number) => [18950 + i]) // fresh chat ids
    const res = await runBackstopDelivery(
      ledger,
      '#18925',
      ['the answer'],
      cardId,
      { sendChunk, recordOutbound: (ids, texts) => recorded.push({ ids, texts }) },
    )
    expect(res.delivered).toBe(true)
    expect(res.exhausted).toBe(false)
    expect(recorded).toHaveLength(1)
    // A real fresh chat id landed in history whose id ≠ the progress-card id.
    expect(recorded[0].ids).toEqual([18950])
    expect(recorded[0].ids).not.toContain(cardId)
    expect(backstopReceiptIds(recorded[0].ids, cardId)).toEqual([18950])
  })

  it('card-only "delivery" can never happen — the receipt gate excludes the card id', async () => {
    const ledger = new BackstopDeliveryLedger()
    const cardId = 18944
    // Even if a buggy send echoed the card id, the receipt gate drops it.
    const sendChunk = vi.fn(async () => [cardId])
    const res = await runBackstopDelivery(ledger, '#c', ['x'], cardId, { sendChunk })
    expect(res.delivered).toBe(false)
    expect(res.exhausted).toBe(true)
  })

  it('retry resumes mid-chunk — chunk 0 is NOT re-sent on attempt 2 (guard 6, finding 1)', async () => {
    const ledger = new BackstopDeliveryLedger()
    const calls: number[] = []
    let failedOnce = false
    const sendChunk = vi.fn(async (i: number) => {
      calls.push(i)
      if (i === 2 && !failedOnce) {
        failedOnce = true
        throw new Error('FLOOD_WAIT_ACTIVE')
      }
      return [700 + i]
    })
    const res = await runBackstopDelivery(ledger, '#resume', ['c0', 'c1', 'c2'], null, { sendChunk }, 3)

    expect(res.delivered).toBe(true)
    expect(res.sentIds).toEqual([700, 701, 702])
    // chunk 0 and 1 sent exactly once; chunk 2 attempted twice (fail, then ok).
    expect(calls.filter(i => i === 0)).toHaveLength(1) // <-- chunk 0 never re-sent
    expect(calls.filter(i => i === 1)).toHaveLength(1)
    expect(calls.filter(i => i === 2)).toHaveLength(2)
    expect(res.attempts).toBe(2)
  })

  it('terminal failure ⇒ delivered=false / exhausted=true after maxAttempts (obligation left open)', async () => {
    const ledger = new BackstopDeliveryLedger()
    const sendChunk = vi.fn(async () => { throw new Error('FLOOD_WAIT_ACTIVE') })
    const res = await runBackstopDelivery(ledger, '#dead', ['only chunk'], null, { sendChunk }, 3)
    expect(res.delivered).toBe(false)
    expect(res.exhausted).toBe(true)
    expect(res.attempts).toBe(3) // exhausted the bounded retry
    expect(res.sentIds).toEqual([]) // nothing landed
    // This is the exact input the gateway uses: delivered=false ⇒ it records
    // send_failed AND leaves the obligation OPEN (noteTurnEnded, not close).
    expect(backstopSendOutcomeGated({
      threw: !res.delivered, sentIds: res.sentIds, chunkCount: res.chunkCount, cardMessageId: null,
    })).toBe('failed')
  })

  it('recordOutbound texts are ALIGNED to sent ids even when a chunk resplits (finding 5)', async () => {
    const ledger = new BackstopDeliveryLedger()
    const recorded: Array<{ ids: number[]; texts: string[] }> = []
    // chunk 1 lands TWO ids (a length-resplit); a naive chunks.slice zip would
    // misalign. entries()-based zip repeats the source text per landed id.
    const sendChunk = vi.fn(async (i: number) => (i === 1 ? [11, 12] : [10]))
    await runBackstopDelivery(
      ledger, '#zip', ['A', 'B'], null,
      { sendChunk, recordOutbound: (ids, texts) => recorded.push({ ids, texts }) },
    )
    expect(recorded[0].ids).toEqual([10, 11, 12])
    expect(recorded[0].texts).toEqual(['A', 'B', 'B'])
    expect(recorded[0].ids).toHaveLength(recorded[0].texts.length)
  })
})
