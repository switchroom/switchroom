import { describe, expect, it } from 'vitest'

import {
  computeTurnStatus,
  backstopSendOutcome,
  type DeliveryOutcome,
} from '../gateway/turn-record-status.js'

/**
 * PR B — send-honesty. The turns.jsonl `status` must reflect the REAL send
 * outcome, not the speculative `finalAnswerDelivered` flag the turn-flush
 * backstop sets before its async send runs.
 *
 * These assert the recorded status OUTCOME for each turn shape — the exact
 * string `emitTurnRecord` writes via `computeTurnStatus` — not merely that a
 * code path ran. The turn-flush IIFE stamps `deliveryOutcome` from
 * `backstopSendOutcome` once the send resolves, so the two helpers together are
 * the whole decision the gateway makes.
 */

// Model the turn-flush send exactly as the gateway IIFE does: resolve the send,
// stamp deliveryOutcome from what happened on the wire, then read the status.
function recordedStatusForFlush(args: {
  finalAnswerDelivered: boolean
  threw: boolean
  sentCount: number
  chunkCount: number
}) {
  const deliveryOutcome: DeliveryOutcome = backstopSendOutcome({
    threw: args.threw,
    sentCount: args.sentCount,
    chunkCount: args.chunkCount,
  })
  return computeTurnStatus({
    finalAnswerDelivered: args.finalAnswerDelivered,
    deliveryOutcome,
  })
}

describe('computeTurnStatus — recorded turn status reflects real outcome', () => {
  it('genuine no-reply turn → no_reply', () => {
    // No backstop send happened; legacy flag path. Unchanged semantics.
    expect(computeTurnStatus({ finalAnswerDelivered: false })).toBe('no_reply')
  })

  it('synchronous reply-tool delivery (no deliveryOutcome) → complete', () => {
    // Reply-tool tail sets finalAnswerDelivered after its send loop and never
    // stamps deliveryOutcome; the legacy reading still yields complete.
    expect(computeTurnStatus({ finalAnswerDelivered: true })).toBe('complete')
  })

  it('reply-tool short-circuit suppressed the flush → complete (reply delivered)', () => {
    expect(
      computeTurnStatus({ finalAnswerDelivered: true, deliveryOutcome: 'suppressed' }),
    ).toBe('complete')
  })

  it('fail-safe: undefined outcome + finalAnswerDelivered false never fabricates complete', () => {
    expect(computeTurnStatus({ finalAnswerDelivered: false, deliveryOutcome: undefined })).toBe(
      'no_reply',
    )
  })
})

describe('turn-flush send outcome → recorded status', () => {
  it('send SUCCEEDS (all chunks delivered) → complete', () => {
    expect(
      recordedStatusForFlush({
        finalAnswerDelivered: true,
        threw: false,
        sentCount: 2,
        chunkCount: 2,
      }),
    ).toBe('complete')
  })

  it('send THROWS (simulated FLOOD_WAIT_ACTIVE) → send_failed', () => {
    // BUG ORACLE: on the pre-fix code, `finalAnswerDelivered=true` was written
    // BEFORE the send ran and the record read that flag → status 'complete'
    // even though the send threw and the user received nothing. Assert the fix:
    // the resolved outcome makes the record honest.
    const status = recordedStatusForFlush({
      finalAnswerDelivered: true, // speculatively set at gateway.ts:17526
      threw: true, // FLOOD_WAIT_ACTIVE caught at the send catch
      sentCount: 0,
      chunkCount: 1,
    })
    expect(status).toBe('send_failed')
    expect(status).not.toBe('complete') // the false-delivered defect must be gone
  })

  it('PARTIAL multi-chunk (chunk 1 ok, chunk 2 fails) → send_failed, not complete', () => {
    // No throw is even required to be dishonest — a truncated answer is not a
    // delivered answer.
    const status = recordedStatusForFlush({
      finalAnswerDelivered: true,
      threw: true, // the loop threw on chunk 2 after chunk 1 landed
      sentCount: 1,
      chunkCount: 3,
    })
    expect(status).toBe('send_failed')
  })

  it('backstopSendOutcome: no throw but short delivery is still failed (partial)', () => {
    expect(backstopSendOutcome({ threw: false, sentCount: 1, chunkCount: 2 })).toBe('failed')
  })

  it('backstopSendOutcome: full delivery is delivered', () => {
    expect(backstopSendOutcome({ threw: false, sentCount: 3, chunkCount: 3 })).toBe('delivered')
  })
})
