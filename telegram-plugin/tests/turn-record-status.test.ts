import { describe, expect, it } from 'vitest'

import {
  computeTurnStatus,
  computeTurnRoute,
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

/**
 * Honest delivery ROUTE. Derived from the SAME resolved delivery state
 * `computeTurnStatus` reads, so the fleet-health detector can tell a
 * flush-recovered turn (answer delivered by a backstop after the reply tool was
 * bypassed) apart from a genuine silent no-op. These assert the mapping OUTCOME,
 * not merely that a branch ran.
 */
describe('computeTurnRoute — honest delivery route from resolved state', () => {
  it('deliveryOutcome delivered → flush (backstop delivered the answer)', () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: true, replyCalled: false, deliveryOutcome: 'delivered' }),
    ).toBe('flush')
  })

  it('deliveryOutcome suppressed → reply (flush short-circuited; reply delivered)', () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: true, replyCalled: true, deliveryOutcome: 'suppressed' }),
    ).toBe('reply')
  })

  it('deliveryOutcome failed → none (nothing reached the user)', () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: true, replyCalled: true, deliveryOutcome: 'failed' }),
    ).toBe('none')
  })

  it('undefined outcome + finalAnswer + replyCalled → reply (synchronous reply tail)', () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: true, replyCalled: true, deliveryOutcome: undefined }),
    ).toBe('reply')
  })

  it('undefined outcome + finalAnswer + NOT replyCalled → stream', () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: true, replyCalled: false, deliveryOutcome: undefined }),
    ).toBe('stream')
  })

  it('undefined outcome + no final answer → none (genuine no-reply)', () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: false, replyCalled: false, deliveryOutcome: undefined }),
    ).toBe('none')
  })

  it('buildTurnRecord stamps route on the row (flush for a delivered backstop send)', () => {
    const rec = buildTurnRecord(
      {
        agent: 'test-agent',
        startedAt: 1_700_000_495_000,
        toolCallCount: 0,
        turnId: 'turn-route',
        finalAnswerDelivered: true,
        replyCalled: false,
        deliveryOutcome: 'delivered',
      },
      1_700_000_500_000,
    )
    expect(rec.route).toBe('flush')
  })
})

describe('backstopSendOutcome — resolve outcome from what happened on the wire', () => {
  it('throw → failed', () => {
    expect(backstopSendOutcome({ threw: true, sentCount: 0, chunkCount: 1 })).toBe('failed')
  })

  it('partial (no throw, short delivery) → failed', () => {
    expect(backstopSendOutcome({ threw: false, sentCount: 1, chunkCount: 2 })).toBe('failed')
  })

  it('full delivery → delivered', () => {
    expect(backstopSendOutcome({ threw: false, sentCount: 3, chunkCount: 3 })).toBe('delivered')
  })

  it('Fix 5 — empty split (0 chunks, no throw) → failed, not delivered', () => {
    expect(backstopSendOutcome({ threw: false, sentCount: 0, chunkCount: 0 })).toBe('failed')
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

  const recordAfterSend = (send: { threw: boolean; sentCount: number; chunkCount: number }) => {
    const turn = mkTurn()
    finalizeBackstopSend(turn, send) // mutates turn.deliveryOutcome — as the IIFE does
    return buildTurnRecord(turn, ENDED_AT)
  }

  it('send SUCCEEDS (all chunks delivered) → complete', () => {
    expect(recordAfterSend({ threw: false, sentCount: 2, chunkCount: 2 }).status).toBe('complete')
  })

  it('send THROWS (simulated FLOOD_WAIT_ACTIVE) → send_failed, never complete', () => {
    // BUG ORACLE: pre-fix, `finalAnswerDelivered=true` was written BEFORE the
    // send ran and the record read that flag → 'complete' even though the send
    // threw and the user got nothing. Assert the wired outcome is honest.
    const rec = recordAfterSend({ threw: true, sentCount: 0, chunkCount: 1 })
    expect(rec.status).toBe('send_failed')
    expect(rec.status).not.toBe('complete')
  })

  it('PARTIAL multi-chunk (chunk 1 ok, chunk 2 throws) → send_failed', () => {
    expect(recordAfterSend({ threw: true, sentCount: 1, chunkCount: 3 }).status).toBe('send_failed')
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
