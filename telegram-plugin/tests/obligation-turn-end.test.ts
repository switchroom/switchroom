import { describe, expect, it } from 'vitest'

import { decideObligationTurnEnd } from '../gateway/obligation-turn-end.js'
import { ObligationLedger } from '../gateway/obligation-ledger.js'

/**
 * #2624 — obligation close on replyCalled shipped test-free. Pin BOTH branches:
 *
 *   - Normal reply → close at turn_end (finalAnswerDelivered OR replyCalled).
 *   - Ack-then-ghost / no-reply → NOT closed at turn_end; stays open so the
 *     idle sweep ends it via silence_fallback.
 */
describe('decideObligationTurnEnd (#2624)', () => {
  it('final answer delivered → close', () => {
    expect(decideObligationTurnEnd(true, false)).toBe('close')
  })

  it('replyCalled (short sr-* reply demoted to non-final) → close', () => {
    // The LiteLLM sr-* cascade: reply("OK", {disable_notification:true}) is
    // below the 200-char backstop + notification-suppressed, so
    // finalAnswerDelivered is false — but the model explicitly replied.
    expect(decideObligationTurnEnd(false, true)).toBe('close')
  })

  it('final answer AND replyCalled → close', () => {
    expect(decideObligationTurnEnd(true, true)).toBe('close')
  })

  it('no reply at all (ack-then-ghost / no-reply) → note-ended, NOT close', () => {
    expect(decideObligationTurnEnd(false, false)).toBe('note-ended')
  })
})

describe('#2624 obligation lifecycle — end-to-end over the ledger', () => {
  const openObligation = (ledger: ObligationLedger, turnId: string) =>
    ledger.openIfAbsent({
      originTurnId: turnId,
      chatId: '123',
      messageId: 1,
      text: 'do the thing',
      openedAt: 1_000,
    })

  it('normal reply closes the obligation at turn_end', () => {
    const ledger = new ObligationLedger()
    openObligation(ledger, 'turn-A')
    expect(ledger.isOpen('turn-A')).toBe(true)

    // Simulate the gateway turn_end branch for a turn that called reply.
    if (decideObligationTurnEnd(true, false) === 'close') {
      ledger.close('turn-A')
    } else {
      ledger.noteTurnEnded('turn-A', 2_000)
    }
    expect(ledger.isOpen('turn-A')).toBe(false)
  })

  it('ack-then-ghost turn_end does NOT close — obligation survives for silence_fallback', () => {
    const ledger = new ObligationLedger()
    openObligation(ledger, 'turn-B')

    // turn_end with no reply: the ack-then-ghost path.
    if (decideObligationTurnEnd(false, false) === 'close') {
      ledger.close('turn-B')
    } else {
      ledger.noteTurnEnded('turn-B', 2_000)
    }
    // Still open at turn_end — the whole point: it is ended later via
    // silence_fallback, NOT turn_end.
    expect(ledger.isOpen('turn-B')).toBe(true)

    // The silence-fallback sweep is what finally closes it.
    expect(ledger.close('turn-B')).toBe(true)
    expect(ledger.isOpen('turn-B')).toBe(false)
  })
})
