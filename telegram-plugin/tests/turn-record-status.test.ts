import { describe, expect, it } from 'vitest'

import {
  computeTurnStatus,
  backstopSendOutcome,
  finalizeBackstopSend,
  buildTurnRecord,
  type DeliveryOutcome,
} from '../gateway/turn-record-status.js'

/**
 * PR B — send-honesty. The turns.jsonl `status` must reflect the REAL send
 * outcome, not the speculative `finalAnswerDelivered` flag the turn-flush
 * backstop sets before its async send runs.
 *
 * These assert the recorded status OUTCOME for each turn shape — the exact
 * string `emitTurnRecord` writes — not merely that a code path ran.
 */

describe('computeTurnStatus — recorded turn status reflects real outcome', () => {
  it('genuine no-reply turn → no_reply', () => {
    expect(computeTurnStatus({ finalAnswerDelivered: false })).toBe('no_reply')
  })

  it('synchronous reply-tool delivery (no deliveryOutcome) → complete', () => {
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

describe('backstopSendOutcome — resolve outcome from what happened on the wire', () => {
  it('throw → failed', () => {
    expect(backstopSendOutcome({ threw: true, receiptIds: [], chunkCount: 1 })).toBe('failed')
  })

  it('partial (no throw, short delivery) → failed', () => {
    expect(backstopSendOutcome({ threw: false, receiptIds: [101], chunkCount: 2 })).toBe('failed')
  })

  it('full delivery (real message ids) → delivered', () => {
    expect(backstopSendOutcome({ threw: false, receiptIds: [101, 102, 103], chunkCount: 3 })).toBe(
      'delivered',
    )
  })

  it('Fix 5 — empty split (0 chunks, no throw) → failed, not delivered', () => {
    expect(backstopSendOutcome({ threw: false, receiptIds: [], chunkCount: 0 })).toBe('failed')
  })

  /**
   * #3276 REGRESSION — the silent-drop oracle. A non-throwing send that
   * produced NO positive message-id receipt (the incident's `sendRichMessage
   * status=ok` on a status card / a degraded stub "ok" with no real id) must
   * be `failed`, never `delivered`. This is the assertion that fails on the OLD
   * "non-throw + chunk count ⇒ delivered" behavior.
   */
  it('#3276 — no-throw send with ZERO positive receipts → failed (not delivered)', () => {
    expect(backstopSendOutcome({ threw: false, receiptIds: [], chunkCount: 1 })).toBe('failed')
  })

  it('#3276 — receipts present but non-positive (0 / negative) do not count → failed', () => {
    expect(backstopSendOutcome({ threw: false, receiptIds: [0, -1], chunkCount: 1 })).toBe('failed')
  })

  it('#3276 — a real positive receipt per chunk → delivered', () => {
    expect(backstopSendOutcome({ threw: false, receiptIds: [18950], chunkCount: 1 })).toBe(
      'delivered',
    )
  })
})

/**
 * Fix 3 — WIRING integration. These drive the SAME seams the gateway
 * turn-flush IIFE runs — `finalizeBackstopSend` (the stamp) feeding
 * `buildTurnRecord` (which `emitTurnRecord` serializes verbatim) — and assert
 * the RECORDED status string. If the accounting stamps the wrong branch, or the
 * record builder ever reverted to the speculative `finalAnswerDelivered`
 * ternary, these fail — not just if the pure predicate is wrong.
 */
describe('turn-flush wiring → recorded turns.jsonl status', () => {
  const ENDED_AT = 1_700_000_500_000
  const mkTurn = () => ({
    agent: 'test-agent',
    startedAt: ENDED_AT - 5_000,
    toolCallCount: 0,
    turnId: 'turn-abc',
    // speculatively set at gateway.ts flush site BEFORE the send runs:
    finalAnswerDelivered: true,
    deliveryOutcome: undefined as DeliveryOutcome | undefined,
  })

  const recordAfterSend = (send: { threw: boolean; receiptIds: number[]; chunkCount: number }) => {
    const turn = mkTurn()
    finalizeBackstopSend(turn, send) // mutates turn.deliveryOutcome — as the IIFE does
    return buildTurnRecord(turn, ENDED_AT)
  }

  it('send SUCCEEDS (all chunks delivered with real ids) → complete', () => {
    expect(recordAfterSend({ threw: false, receiptIds: [201, 202], chunkCount: 2 }).status).toBe(
      'complete',
    )
  })

  it('send THROWS (simulated FLOOD_WAIT_ACTIVE) → send_failed, never complete', () => {
    // BUG ORACLE: pre-fix, `finalAnswerDelivered=true` was written BEFORE the
    // send ran and the record read that flag → 'complete' even though the send
    // threw and the user got nothing. Assert the wired outcome is honest.
    const rec = recordAfterSend({ threw: true, receiptIds: [], chunkCount: 1 })
    expect(rec.status).toBe('send_failed')
    expect(rec.status).not.toBe('complete')
  })

  it('PARTIAL multi-chunk (chunk 1 ok, chunk 2 throws) → send_failed', () => {
    expect(recordAfterSend({ threw: true, receiptIds: [201], chunkCount: 3 }).status).toBe(
      'send_failed',
    )
  })

  /**
   * #3276 REGRESSION — end-to-end status oracle. A turn whose backstop send
   * did NOT throw but recorded NO real message-id receipt (the incident: card
   * `status=ok`, no recorded id) must write `send_failed`, so the drop is
   * surfaced instead of buried as `complete`. Pre-fix this wrote `complete`.
   */
  it('#3276 — no-throw send, zero recorded message ids → send_failed (surfaced, not complete)', () => {
    const rec = recordAfterSend({ threw: false, receiptIds: [], chunkCount: 1 })
    expect(rec.status).toBe('send_failed')
    expect(rec.status).not.toBe('complete')
  })

  it('#3276 — no-throw send WITH a real recorded message id → complete', () => {
    // A flushed turn routed through the reply primitive collects a real
    // Telegram message_id; that independent receipt is what earns `complete`.
    expect(recordAfterSend({ threw: false, receiptIds: [18950], chunkCount: 1 }).status).toBe(
      'complete',
    )
  })

  it('reply-tool suppressed the flush → complete (reply delivered), via the stamp', () => {
    const turn = mkTurn()
    turn.deliveryOutcome = 'suppressed' // the IIFE's suppressed-branch stamp
    expect(buildTurnRecord(turn, ENDED_AT).status).toBe('complete')
  })

  it('record carries the honest tuple (tools + duration) alongside status', () => {
    const rec = recordAfterSend({ threw: true, sentCount: 0, chunkCount: 1 })
    expect(rec).toMatchObject({
      status: 'send_failed',
      tools: 0,
      duration_ms: 5_000,
      turn_id: 'turn-abc',
      agent: 'test-agent',
    })
  })
})
