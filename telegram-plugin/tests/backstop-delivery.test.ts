import { describe, expect, it, vi } from 'vitest'

import {
  BackstopDeliveryLedger,
  backstopReceiptIds,
  backstopDelivered,
  runBackstopDelivery,
  combineReadBackResults,
  type ReadBackResult,
} from '../gateway/backstop-delivery.js'
import {
  backstopSendOutcomeGated,
  buildTurnRecord,
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

/**
 * #3278 — read-back confirmation of an accepted-but-dropped send.
 *
 * A returned message_id proves Telegram ACCEPTED the send, not that the message
 * is VISIBLE (a flood/anti-spam silent discard returns a fresh id yet the user
 * sees nothing). These assert the deterministic OUTCOMES of the per-chunk state
 * machine `unsent → pending → landed-unconfirmed → {landed-confirmed | unsent}`
 * driven by a no-op editMessageText read-back — NOT code-path execution.
 */
describe('#3278 read-back — the ledger confirmation state machine', () => {
  it('confirmChunk transitions landed-unconfirmed → landed-confirmed', () => {
    const l = new BackstopDeliveryLedger()
    l.recordChunk('#t', 0, [900]) // landed-unconfirmed
    expect(l.hasChunk('#t', 0)).toBe(true)
    expect(l.hasConfirmedChunk('#t', 0)).toBe(false)
    expect(l.landedUnconfirmedIndices('#t', 1)).toEqual([0])
    l.confirmChunk('#t', 0)
    expect(l.hasConfirmedChunk('#t', 0)).toBe(true)
    expect(l.landedUnconfirmedIndices('#t', 1)).toEqual([])
    expect(l.allConfirmed('#t', 1)).toBe(true)
    expect(l.confirmedIds('#t')).toEqual([900])
  })

  it('demoteChunk resets a landed(-unconfirmed) chunk back to unsent (safe re-send)', () => {
    const l = new BackstopDeliveryLedger()
    l.recordChunk('#t', 0, [901])
    l.confirmChunk('#t', 0)
    l.demoteChunk('#t', 0) // positive-absence read-back
    expect(l.hasChunk('#t', 0)).toBe(false)
    expect(l.hasConfirmedChunk('#t', 0)).toBe(false)
    expect(l.unsentIndices('#t', 1)).toEqual([0]) // resume set includes it again
    expect(l.confirmedIds('#t')).toEqual([])
  })

  it('allConfirmed is false while any chunk is only landed-unconfirmed', () => {
    const l = new BackstopDeliveryLedger()
    l.recordChunk('#t', 0, [1]); l.confirmChunk('#t', 0)
    l.recordChunk('#t', 1, [2]) // landed-unconfirmed
    expect(l.allConfirmed('#t', 2)).toBe(false)
    expect(l.landedUnconfirmedIndices('#t', 2)).toEqual([1])
  })

  it('confirmedIds returns ONLY confirmed chunk ids, in index order', () => {
    const l = new BackstopDeliveryLedger()
    l.recordChunk('#t', 0, [10]); l.confirmChunk('#t', 0)
    l.recordChunk('#t', 1, [11]) // unconfirmed
    l.recordChunk('#t', 2, [12, 13]); l.confirmChunk('#t', 2)
    expect(l.confirmedIds('#t')).toEqual([10, 12, 13])
  })
})

describe('#3278 combineReadBackResults — per-chunk id combine (guard A7)', () => {
  it('ANY absent id ⇒ absent (re-send the whole chunk)', () => {
    expect(combineReadBackResults(['exists', 'absent'])).toBe('absent')
    expect(combineReadBackResults(['absent', 'ambiguous'])).toBe('absent')
  })
  it('ALL exist ⇒ exists', () => {
    expect(combineReadBackResults(['exists', 'exists'])).toBe('exists')
  })
  it('some ambiguous, none absent ⇒ ambiguous (never re-send)', () => {
    expect(combineReadBackResults(['exists', 'ambiguous'])).toBe('ambiguous')
  })
  it('empty id set ⇒ ambiguous (fabricate neither confirm nor demote)', () => {
    expect(combineReadBackResults([])).toBe('ambiguous')
  })
})

describe('#3278 runBackstopDelivery — read-back drives the delivery outcome', () => {
  it('exists probe ⇒ landed-confirmed, delivered=true, ONE probe, no re-send', async () => {
    const ledger = new BackstopDeliveryLedger()
    const sendChunk = vi.fn(async () => [960])
    const readBack = vi.fn(async (): Promise<ReadBackResult> => 'exists')
    const res = await runBackstopDelivery(ledger, '#ok', ['the answer'], null, { sendChunk, readBack }, 3)
    expect(res.delivered).toBe(true)
    expect(res.exhausted).toBe(false)
    expect(sendChunk).toHaveBeenCalledTimes(1) // never re-sent
    expect(readBack).toHaveBeenCalledTimes(1) // exactly one probe per chunk
    expect(ledger.hasConfirmedChunk('#ok', 0)).toBe(true)
  })

  it('400/absent probe ⇒ demote → RE-SENT EXACTLY ONCE, then confirmed', async () => {
    const ledger = new BackstopDeliveryLedger()
    let sends = 0
    const sendChunk = vi.fn(async () => { sends++; return [900 + sends] })
    let probes = 0
    // First probe: the send was silently dropped (absent). After the re-send the
    // message is present (exists).
    const readBack = vi.fn(async (): Promise<ReadBackResult> => {
      probes++
      return probes === 1 ? 'absent' : 'exists'
    })
    const res = await runBackstopDelivery(ledger, '#drop', ['answer'], null, { sendChunk, readBack }, 3)
    expect(sendChunk).toHaveBeenCalledTimes(2) // initial + exactly one re-send
    expect(res.delivered).toBe(true)
    expect(ledger.hasConfirmedChunk('#drop', 0)).toBe(true)
  })

  it('429/ambiguous probe ⇒ NOT re-sent, stays landed-unconfirmed, still DELIVERED', async () => {
    const ledger = new BackstopDeliveryLedger()
    const sendChunk = vi.fn(async () => [950])
    const readBack = vi.fn(async (): Promise<ReadBackResult> => 'ambiguous')
    const res = await runBackstopDelivery(ledger, '#amb', ['answer'], null, { sendChunk, readBack }, 3)
    expect(sendChunk).toHaveBeenCalledTimes(1) // never re-sent on ambiguous
    // An inconclusive probe establishes nothing, so the landed-id evidence
    // stands: the answer IS in the chat and the turn is not a failure.
    expect(res.delivered).toBe(true)
    expect(res.confirmed).toBe(false) // landed-unconfirmed, honestly reported
    expect(res.exhausted).toBe(false)
    expect(ledger.hasConfirmedChunk('#amb', 0)).toBe(false)
    expect(ledger.landedUnconfirmedIndices('#amb', 1)).toEqual([0]) // still landed-unconfirmed
  })

  it('a read-back adapter THAT THROWS is ambiguous — never re-sent, never a failure', async () => {
    const ledger = new BackstopDeliveryLedger()
    const sendChunk = vi.fn(async () => [951])
    const readBack = vi.fn(async () => { throw new Error('boom') })
    const res = await runBackstopDelivery(ledger, '#throw', ['answer'], null, { sendChunk, readBack }, 3)
    expect(sendChunk).toHaveBeenCalledTimes(1)
    expect(res.delivered).toBe(true)
    expect(res.confirmed).toBe(false)
  })

  it('#3278 CORE: API-ack fresh id but read-back ABSENT ⇒ send_failed, NOT complete', async () => {
    const ledger = new BackstopDeliveryLedger()
    const cardId = 500
    // The Bot API returns a fresh non-card id (an accept) every time...
    const sendChunk = vi.fn(async () => [970])
    // ...but the read-back proves the message is not actually in the chat
    // (flood/anti-spam silent discard). It never confirms.
    const readBack = vi.fn(async (): Promise<ReadBackResult> => 'absent')
    const res = await runBackstopDelivery(ledger, '#ghost', ['answer'], cardId, { sendChunk, readBack }, 3)
    expect(res.delivered).toBe(false) // pre-#3278 this was true → false `complete`
    expect(res.exhausted).toBe(true)
    // The exact input the gateway feeds the turn record: delivered=false ⇒ the
    // status is send_failed and the obligation is left OPEN — the answer is NOT
    // silently marked complete.
    const turn: { finalAnswerDelivered: boolean; deliveryOutcome?: 'delivered' | 'failed' | 'suppressed' } = {
      finalAnswerDelivered: true,
    }
    finalizeBackstopSendGated(turn, {
      threw: !res.delivered, sentIds: res.sentIds, chunkCount: res.chunkCount, cardMessageId: cardId,
    })
    expect(computeTurnStatus(turn)).toBe('send_failed')
  })

  it('scope guard: NO readBack dep ⇒ ZERO probes, legacy confirm-on-landing preserved', async () => {
    const ledger = new BackstopDeliveryLedger()
    const readBack = vi.fn()
    const sendChunk = vi.fn(async () => [980])
    // deliberately omit `readBack` — the hot path / opt-out shape.
    const res = await runBackstopDelivery(ledger, '#noprobe', ['answer'], null, { sendChunk })
    expect(readBack).not.toHaveBeenCalled()
    expect(res.delivered).toBe(true) // confirmed on landing (receipt-gated)
    expect(ledger.hasConfirmedChunk('#noprobe', 0)).toBe(true)
  })

  it('partial: chunk 0 confirmed, chunk 1 ambiguous ⇒ both landed ⇒ delivered, chunk 0 not re-sent', async () => {
    const ledger = new BackstopDeliveryLedger()
    const calls: number[] = []
    const sendChunk = vi.fn(async (i: number) => { calls.push(i); return [700 + i] })
    const readBack = vi.fn(async (i: number): Promise<ReadBackResult> => (i === 0 ? 'exists' : 'ambiguous'))
    const res = await runBackstopDelivery(ledger, '#part', ['c0', 'c1'], null, { sendChunk, readBack }, 3)
    expect(res.delivered).toBe(true) // every chunk landed a fresh id
    expect(res.confirmed).toBe(false) // ...but chunk 1 was never corroborated
    expect(calls.filter(i => i === 0)).toHaveLength(1) // confirmed chunk never re-sent
    expect(ledger.hasConfirmedChunk('#part', 0)).toBe(true)
    expect(ledger.hasConfirmedChunk('#part', 1)).toBe(false)
  })

  // ── The measurement bug this PR fixes ────────────────────────────────────
  //
  // The probe is issued at cosmetic priority in the same millisecond as the
  // send it probes, so the per-chat token bucket (1/sec, just consumed by that
  // very send) sheds it: in production it resolved `ambiguous` 146 times in two
  // weeks and `absent` ZERO times. Under the old confirmation-gated verdict each
  // of those became `delivered:false` → `send_failed` on a turn whose answer the
  // user had received, plus an error reaction and a still-OPEN obligation.
  it('AMBIGUOUS probe ⇒ turn record `complete`, NOT send_failed (the fixed bug)', async () => {
    const ledger = new BackstopDeliveryLedger()
    const cardId = 500
    const sendChunk = vi.fn(async () => [971]) // a fresh, non-card chat id
    const readBack = vi.fn(async (): Promise<ReadBackResult> => 'ambiguous')
    const res = await runBackstopDelivery(ledger, '#shed', ['answer'], cardId, { sendChunk, readBack }, 3)
    const turn: { finalAnswerDelivered: boolean; deliveryOutcome?: 'delivered' | 'failed' | 'suppressed' } = {
      finalAnswerDelivered: true,
    }
    finalizeBackstopSendGated(turn, {
      threw: !res.delivered, sentIds: res.sentIds, chunkCount: res.chunkCount, cardMessageId: cardId,
    })
    expect(computeTurnStatus(turn)).toBe('complete')
  })

  it('an ambiguous probe on a CARD-ONLY delivery is still send_failed (guard 7 holds)', async () => {
    const ledger = new BackstopDeliveryLedger()
    const cardId = 501
    // The only id that landed IS the progress card — swept ~60-90s later, so
    // the user receives nothing. Ambiguity must not rescue this.
    const sendChunk = vi.fn(async () => [cardId])
    const readBack = vi.fn(async (): Promise<ReadBackResult> => 'ambiguous')
    const res = await runBackstopDelivery(ledger, '#cardonly', ['answer'], cardId, { sendChunk, readBack }, 3)
    expect(res.delivered).toBe(false)
    const turn: { finalAnswerDelivered: boolean; deliveryOutcome?: 'delivered' | 'failed' | 'suppressed' } = {
      finalAnswerDelivered: true,
    }
    finalizeBackstopSendGated(turn, {
      threw: !res.delivered, sentIds: res.sentIds, chunkCount: res.chunkCount, cardMessageId: cardId,
    })
    expect(computeTurnStatus(turn)).toBe('send_failed')
  })

  it('an ambiguous probe on a chunk that never landed is still NOT delivered', async () => {
    const ledger = new BackstopDeliveryLedger()
    // chunk 0 lands; chunk 1 throws on every attempt → never landed.
    const sendChunk = vi.fn(async (i: number) => {
      if (i === 1) throw new Error('flood')
      return [800 + i]
    })
    const readBack = vi.fn(async (): Promise<ReadBackResult> => 'ambiguous')
    const res = await runBackstopDelivery(ledger, '#gap', ['c0', 'c1'], null, { sendChunk, readBack }, 2)
    expect(res.delivered).toBe(false)
    expect(res.exhausted).toBe(true)
  })

  // Mixed sequence: the two probe states that MOVE the verdict, composed in one
  // run. Chunk 0's first send is silently discarded (`absent` ⇒ demote ⇒
  // re-send) and the probe on the RE-SEND is shed (`ambiguous`). Under the old
  // confirmation-gated verdict the re-sent chunk was never `landed-confirmed`,
  // so the whole turn came out `delivered:false` — a `send_failed` for an answer
  // that had just been successfully re-sent. Demote-and-re-send and
  // ambiguity-is-not-failure must compose.
  it('absent ⇒ demote ⇒ re-send, then AMBIGUOUS on the re-send ⇒ delivered, sent exactly twice', async () => {
    const ledger = new BackstopDeliveryLedger()
    let sends = 0
    const sendChunk = vi.fn(async () => { sends++; return [990 + sends] })
    let probes = 0
    const readBack = vi.fn(async (): Promise<ReadBackResult> => {
      probes++
      return probes === 1 ? 'absent' : 'ambiguous'
    })
    const res = await runBackstopDelivery(ledger, '#mixed', ['answer'], null, { sendChunk, readBack }, 3)
    expect(sendChunk).toHaveBeenCalledTimes(2) // initial + exactly one re-send
    expect(readBack).toHaveBeenCalledTimes(2) // probed once per landing
    expect(res.delivered).toBe(true) // the re-send landed a fresh id; ambiguity proves nothing
    expect(res.confirmed).toBe(false) // ...and is honestly reported as uncorroborated
    expect(res.sentIds).toEqual([992]) // the demoted first id is gone; the re-send's id stands
    expect(res.landedUnconfirmedIds).toEqual([992])
    // The outcome the user actually experiences: a `complete` turn record.
    const turn: { finalAnswerDelivered: boolean; deliveryOutcome?: 'delivered' | 'failed' | 'suppressed' } = {
      finalAnswerDelivered: true,
    }
    finalizeBackstopSendGated(turn, {
      threw: !res.delivered, sentIds: res.sentIds, chunkCount: res.chunkCount, cardMessageId: null,
    })
    expect(computeTurnStatus(turn)).toBe('complete')
  })
})

// ── The observability of the new optimism (#3702 L2/L5/L6a) ─────────────────
//
// Counting an inconclusive probe as delivered is a BET. These pin the two
// artifacts that let the fleet find out if it is ever wrong: the per-delivery
// stderr line, and the `landed_unconfirmed` field on the turns.jsonl row.
describe('#3702 landed-unconfirmed is MEASURED, not silently assumed', () => {
  it('a delivered-but-unconfirmed turn writes the diagnostic stderr line', async () => {
    const ledger = new BackstopDeliveryLedger()
    const lines: string[] = []
    const res = await runBackstopDelivery(
      ledger, '#obs', ['answer'], null,
      {
        sendChunk: async () => [1001],
        readBack: async (): Promise<ReadBackResult> => 'ambiguous',
        stderr: (s) => lines.push(s),
      },
      3,
    )
    expect(res.delivered).toBe(true)
    expect(res.confirmed).toBe(false)
    const diag = lines.filter(l => l.includes('backstop delivery landed-unconfirmed'))
    expect(diag).toHaveLength(1)
    expect(diag[0]).toContain('#obs')
    expect(diag[0]).toContain('1 of 1 landed id(s)') // the measured quantity, not just a warning
  })

  it('a fully CONFIRMED delivery writes NO landed-unconfirmed line (no false alarm)', async () => {
    const ledger = new BackstopDeliveryLedger()
    const lines: string[] = []
    const res = await runBackstopDelivery(
      ledger, '#conf', ['answer'], null,
      {
        sendChunk: async () => [1002],
        readBack: async (): Promise<ReadBackResult> => 'exists',
        stderr: (s) => lines.push(s),
      },
      3,
    )
    expect(res.confirmed).toBe(true)
    expect(res.landedUnconfirmedIds).toEqual([])
    expect(lines.filter(l => l.includes('backstop delivery landed-unconfirmed'))).toHaveLength(0)
  })

  it('landedUnconfirmedIds is exactly the uncorroborated subset of sentIds', async () => {
    const ledger = new BackstopDeliveryLedger()
    // chunk 0 confirmed, chunk 1 landed-unconfirmed (shed probe).
    const res = await runBackstopDelivery(
      ledger, '#subset', ['c0', 'c1'], null,
      {
        sendChunk: async (i: number) => [1100 + i],
        readBack: async (i: number): Promise<ReadBackResult> => (i === 0 ? 'exists' : 'ambiguous'),
      },
      3,
    )
    expect(res.sentIds).toEqual([1100, 1101])
    expect(res.landedUnconfirmedIds).toEqual([1101]) // c0 is corroborated; c1 is the bet
    expect(res.delivered).toBe(true)
    expect(res.confirmed).toBe(false)
  })

  it('the count reaches turns.jsonl: a complete turn carries `landed_unconfirmed`', async () => {
    const ledger = new BackstopDeliveryLedger()
    const res = await runBackstopDelivery(
      ledger, '#row', ['c0', 'c1'], null,
      {
        sendChunk: async (i: number) => [1200 + i],
        readBack: async (): Promise<ReadBackResult> => 'ambiguous',
      },
      3,
    )
    const turn = {
      agent: 'test-agent',
      startedAt: 1_000_000,
      toolCallCount: 0,
      turnId: '#row',
      finalAnswerDelivered: true,
      deliveryOutcome: 'delivered' as const,
      landedUnconfirmed: res.landedUnconfirmedIds.length,
    }
    const row = buildTurnRecord(turn, 1_002_000)
    // The status is honest AND the bet is visible on the same row — that pairing
    // is the point: a `complete` we could not corroborate is countable.
    expect(row.status).toBe('complete')
    expect(row.landed_unconfirmed).toBe(2)
  })

  it('an ordinary confirmed turn omits the field entirely (row shape unchanged)', () => {
    const row = buildTurnRecord(
      {
        agent: 'test-agent',
        startedAt: 1_000_000,
        toolCallCount: 0,
        turnId: '#plain',
        finalAnswerDelivered: true,
        deliveryOutcome: 'delivered',
        landedUnconfirmed: 0,
      },
      1_002_000,
    )
    expect(row.status).toBe('complete')
    expect('landed_unconfirmed' in row).toBe(false)
  })
})
