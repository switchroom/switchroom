import { describe, expect, it } from 'vitest'

import { decideInboundDelivery } from '../gateway/inbound-delivery-gate.js'

/**
 * Regression coverage for #1556 — the lawgpt composer wedge.
 *
 * Before this gate, the gateway sent every inbound to the bridge
 * immediately, buffering only when the bridge was offline. A
 * non-steering message that arrived mid-turn was typed into claude's
 * TUI composer and stranded when the auto-submit raced
 * turn-completion. The deterministic invariant the gate enforces:
 *
 *   a non-steering inbound is delivered ONLY when no turn is in flight.
 *
 * Steering (/steer, /s) is the sole exemption — reaching claude
 * mid-turn is the entire point of that feature.
 */
describe('decideInboundDelivery', () => {
  it('delivers immediately when claude is idle (no turn in flight)', () => {
    expect(
      decideInboundDelivery({ turnInFlight: false, isSteering: false }),
    ).toBe('deliver')
  })

  it('BUFFERS a non-steering message that arrives mid-turn (the wedge fix)', () => {
    expect(
      decideInboundDelivery({ turnInFlight: true, isSteering: false }),
    ).toBe('buffer-until-idle')
  })

  it('delivers a steering message mid-turn (steering is intentionally exempt)', () => {
    expect(
      decideInboundDelivery({ turnInFlight: true, isSteering: true }),
    ).toBe('deliver')
  })

  it('delivers a steering message when idle (steer with no active turn)', () => {
    expect(
      decideInboundDelivery({ turnInFlight: false, isSteering: true }),
    ).toBe('deliver')
  })

  it('is total: the ONLY deferral path is mid-turn AND not steering', () => {
    for (const turnInFlight of [true, false]) {
      for (const isSteering of [true, false]) {
        const decision = decideInboundDelivery({ turnInFlight, isSteering })
        const expectBuffer = turnInFlight && !isSteering
        expect(decision).toBe(expectBuffer ? 'buffer-until-idle' : 'deliver')
      }
    }
  })
})
