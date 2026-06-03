import { describe, expect, it } from 'vitest'

import { mayDrainBufferedInbound } from '../gateway/serialize-drain-gate.js'

/**
 * Component 1 (multitopic reply-routing) — deliver-before-drain gate.
 *
 * In a forum supergroup one sequential claude CLI owns every topic with a
 * singleton currentTurn. The buffer drain used to fire on the bare turn-end
 * signal regardless of whether the ending turn had delivered its reply, so
 * a buffered cross-topic message drained the instant the prior turn's
 * turn-end event landed — even when its reply was still ~42s out. By the
 * time the prior reply executed, currentTurn had flipped and the reply
 * routed to the wrong topic.
 *
 * The predicate gates the drain: drain only when claude is idle AND (the
 * kill switch is off, OR there is no ending-turn handle, OR the ending turn
 * delivered its final answer). The no-reply case (finalAnswerDelivered
 * false) deliberately blocks here — liveness is restored by the bounded
 * escape-hatch timer, NOT by this predicate.
 */
describe('mayDrainBufferedInbound', () => {
  it('drains when idle AND the ending turn delivered its final answer', () => {
    expect(
      mayDrainBufferedInbound({
        turnInFlight: false,
        endingTurnFinalAnswerDelivered: true,
        enabled: true,
      }),
    ).toBe(true)
  })

  it('does NOT drain when the ending turn ended WITHOUT a reply (the wedge fix)', () => {
    // The Brevo turn-end fired before its late reply landed; the buffered
    // Meta message must NOT drain here.
    expect(
      mayDrainBufferedInbound({
        turnInFlight: false,
        endingTurnFinalAnswerDelivered: false,
        enabled: true,
      }),
    ).toBe(false)
  })

  it('drains when there is no ending-turn handle (sibling purge / idle sweep)', () => {
    expect(
      mayDrainBufferedInbound({
        turnInFlight: false,
        endingTurnFinalAnswerDelivered: null,
        enabled: true,
      }),
    ).toBe(true)
    expect(
      mayDrainBufferedInbound({
        turnInFlight: false,
        endingTurnFinalAnswerDelivered: undefined,
        enabled: true,
      }),
    ).toBe(true)
  })

  it('NEVER drains while a turn is in flight, regardless of other inputs', () => {
    for (const delivered of [true, false, null, undefined] as const) {
      for (const enabled of [true, false]) {
        expect(
          mayDrainBufferedInbound({
            turnInFlight: true,
            endingTurnFinalAnswerDelivered: delivered,
            enabled,
          }),
        ).toBe(false)
      }
    }
  })

  it('kill switch off → legacy behaviour: drain whenever idle (delivered ignored)', () => {
    expect(
      mayDrainBufferedInbound({
        turnInFlight: false,
        endingTurnFinalAnswerDelivered: false,
        enabled: false,
      }),
    ).toBe(true)
    expect(
      mayDrainBufferedInbound({
        turnInFlight: false,
        endingTurnFinalAnswerDelivered: true,
        enabled: false,
      }),
    ).toBe(true)
  })

  it('is total over the input space', () => {
    for (const turnInFlight of [true, false]) {
      for (const delivered of [true, false, null, undefined] as const) {
        for (const enabled of [true, false]) {
          const got = mayDrainBufferedInbound({
            turnInFlight,
            endingTurnFinalAnswerDelivered: delivered,
            enabled,
          })
          let want: boolean
          if (turnInFlight) want = false
          else if (!enabled) want = true
          else if (delivered == null) want = true
          else want = delivered === true
          expect(got).toBe(want)
        }
      }
    }
  })
})
