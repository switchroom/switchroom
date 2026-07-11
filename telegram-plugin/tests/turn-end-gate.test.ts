// #1667 — gateway-level regression test for the #1664 turn_end re-prompt gate.
//
// This drives the REAL decision core the gateway's `case 'turn_end':` block
// delegates to (`decideTurnEndGate` in `gateway/turn-end-gate.ts`), plus the
// REAL `decideTurnFlush` that feeds it — not a re-implementation. A future
// change to the gateway's gate ordering or the `finalAnswerDelivered` swap is
// caught here, closing the coverage gap the issue calls out
// (`silent-end.test.ts`'s `simulateTurnEnd` helper re-implements the decision
// rather than exercising gateway code).
//
// This test is a micro-step of the #2996 gateway decomposition: the gate's
// pure ordering is now importable and pinned, whereas `gateway.ts` itself is
// not importable in tests (boot side effects at module load — confirmed during
// the #2996 work, PR #3010).
//
// vitest runner (no bun natives): both `turn-end-gate.ts` and
// `turn-flush-safety.ts` are pure ES modules.
import { describe, it, expect } from 'vitest'
import { decideTurnEndGate } from '../gateway/turn-end-gate.js'
import { decideTurnFlush, type FlushDecision } from '../turn-flush-safety.js'

// Mirror the gateway's own upstream computation: turn-flush is only consulted
// when the answer-stream did NOT already materialise the answer. When it did,
// the gateway substitutes a synthetic `{kind:'skip', reason:'reply-called'}`.
const STREAM_MATERIALIZED: FlushDecision = { kind: 'skip', reason: 'reply-called' }

// Real `decideTurnFlush` call, matching the gateway's inputs at turn_end.
function realFlush(opts: {
  replyCalled: boolean
  capturedText: string[]
  chatId?: string | null
}): FlushDecision {
  return decideTurnFlush({
    chatId: opts.chatId === undefined ? 'c:1' : opts.chatId,
    replyCalled: opts.replyCalled,
    capturedText: opts.capturedText,
    flushEnabled: true,
  })
}

describe('#1667 — turn_end gate (decideTurnEndGate), driving real gateway code', () => {
  // (a) Interim-ack-only turn: reply landed (interim ack) but no final answer
  //     delivered, and no substantive trailing prose to flush → re-prompt.
  it('interim-ack-only turn (outbound sent, finalAnswerDelivered=false) → reprompt', () => {
    // reply tool called, so decideTurnFlush skips with reason 'reply-called';
    // the real answer went out as an ephemeral draft, never finalized, so
    // finalAnswerDelivered stayed false.
    const flushDecision = realFlush({ replyCalled: true, capturedText: [] })
    expect(flushDecision).toEqual({ kind: 'skip', reason: 'reply-called' })
    const decision = decideTurnEndGate({ flushDecision, finalAnswerDelivered: false })
    expect(decision).toBe('reprompt')
  })

  // (b) Final-answer-reply turn: reply landed AND was the genuine final answer
  //     → finalAnswerDelivered true → no re-prompt.
  it('final-answer-reply turn (finalAnswerDelivered=true) → none (no reprompt)', () => {
    const flushDecision = realFlush({ replyCalled: true, capturedText: [] })
    const decision = decideTurnEndGate({ flushDecision, finalAnswerDelivered: true })
    expect(decision).toBe('none')
  })

  // (b') Answer-stream materialised the answer: gateway substitutes the
  //      synthetic skip AND sets finalAnswerDelivered=true → none.
  it('answer-stream materialized as answer (finalAnswerDelivered=true) → none', () => {
    const decision = decideTurnEndGate({
      flushDecision: STREAM_MATERIALIZED,
      finalAnswerDelivered: true,
    })
    expect(decision).toBe('none')
  })

  // (c) Zero-outbound turn: no reply, no captured text → decideTurnFlush skips
  //     with 'empty-text' (NOT flush, NOT silent-marker), and
  //     finalAnswerDelivered is false → still re-prompts (the original #1122
  //     case, now the subset of "no final answer delivered").
  it('zero-outbound turn (no reply, empty text) → reprompt', () => {
    const flushDecision = realFlush({ replyCalled: false, capturedText: [] })
    expect(flushDecision).toEqual({ kind: 'skip', reason: 'empty-text' })
    const decision = decideTurnEndGate({ flushDecision, finalAnswerDelivered: false })
    expect(decision).toBe('reprompt')
  })

  // (d) Ordering precedence #1 — silent-marker beats the re-prompt gate. A turn
  //     whose only output is a NO_REPLY sentinel is legitimately silent and
  //     must NOT re-prompt, even though finalAnswerDelivered is false.
  it('silent-marker (NO_REPLY) takes precedence over the reprompt gate', () => {
    const flushDecision = realFlush({ replyCalled: false, capturedText: ['NO_REPLY'] })
    expect(flushDecision).toEqual({ kind: 'skip', reason: 'silent-marker' })
    // finalAnswerDelivered=false would trip 'reprompt' at the tail, but the
    // silent-marker branch returns first.
    const decision = decideTurnEndGate({ flushDecision, finalAnswerDelivered: false })
    expect(decision).toBe('silent_end')
  })

  it('silent-marker (HEARTBEAT_OK) → silent_end (no reprompt)', () => {
    const flushDecision = realFlush({ replyCalled: false, capturedText: ['HEARTBEAT_OK'] })
    expect(flushDecision).toEqual({ kind: 'skip', reason: 'silent-marker' })
    const decision = decideTurnEndGate({ flushDecision, finalAnswerDelivered: false })
    expect(decision).toBe('silent_end')
  })

  // (d) Ordering precedence #2 — turn-flush beats the re-prompt gate. A turn
  //     that skipped the reply tool but left substantive terminal prose is
  //     delivered via flush; the gate returns 'flush' even though
  //     finalAnswerDelivered is still false at that point (the gateway sets it
  //     true inside the flush branch afterwards).
  it('turn-flush (substantive terminal prose, no reply) takes precedence over reprompt', () => {
    const flushDecision = realFlush({
      replyCalled: false,
      capturedText: ['Done — all three services are green.'],
    })
    expect(flushDecision.kind).toBe('flush')
    const decision = decideTurnEndGate({ flushDecision, finalAnswerDelivered: false })
    expect(decision).toBe('flush')
  })

  // Full documented ordering, asserted as a table so a re-order regresses
  // loudly: silent-marker > flush > (finalAnswerDelivered===false ? reprompt : none).
  it('honors the full documented precedence order', () => {
    const silent: FlushDecision = { kind: 'skip', reason: 'silent-marker' }
    const flush: FlushDecision = { kind: 'flush', text: 'the answer' }
    const replyCalled: FlushDecision = { kind: 'skip', reason: 'reply-called' }
    const emptyText: FlushDecision = { kind: 'skip', reason: 'empty-text' }

    // silent-marker wins regardless of finalAnswerDelivered.
    expect(decideTurnEndGate({ flushDecision: silent, finalAnswerDelivered: false })).toBe('silent_end')
    expect(decideTurnEndGate({ flushDecision: silent, finalAnswerDelivered: true })).toBe('silent_end')
    // flush wins regardless of finalAnswerDelivered.
    expect(decideTurnEndGate({ flushDecision: flush, finalAnswerDelivered: false })).toBe('flush')
    expect(decideTurnEndGate({ flushDecision: flush, finalAnswerDelivered: true })).toBe('flush')
    // reply-called tail: gated purely on finalAnswerDelivered.
    expect(decideTurnEndGate({ flushDecision: replyCalled, finalAnswerDelivered: false })).toBe('reprompt')
    expect(decideTurnEndGate({ flushDecision: replyCalled, finalAnswerDelivered: true })).toBe('none')
    expect(decideTurnEndGate({ flushDecision: emptyText, finalAnswerDelivered: false })).toBe('reprompt')
    expect(decideTurnEndGate({ flushDecision: emptyText, finalAnswerDelivered: true })).toBe('none')
  })
})
