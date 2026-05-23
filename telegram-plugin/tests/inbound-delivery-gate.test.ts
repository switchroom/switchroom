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

  it('is total: the ONLY deferral path is mid-turn AND not steering AND not interrupt', () => {
    for (const turnInFlight of [true, false]) {
      for (const isSteering of [true, false]) {
        for (const isInterrupt of [true, false]) {
          const decision = decideInboundDelivery({ turnInFlight, isSteering, isInterrupt })
          const expectBuffer = turnInFlight && !isSteering && !isInterrupt
          expect(decision).toBe(expectBuffer ? 'buffer-until-idle' : 'deliver')
        }
      }
    }
  })

  // ─── Interrupt-marker carve-out (2026-05-24 fix for the stranded-body bug) ──
  // Live UAT trace: user fires `! actually do X` mid-turn. SIGINT delivered
  // to claude via tmux send-keys. The killed turn does NOT emit
  // turn_complete in many cases (mid-tool-call kill, in-flight subagent),
  // so the post-`!` body sits in pendingInboundBuffer forever — the
  // turn-complete drain trigger never fires. The user never gets a reply
  // to their replacement instruction.
  //
  // The carve-out is a peer of isSteering: an interrupt body is by
  // definition an intentional mid-turn delivery — the user explicitly
  // asked for "stop and do this instead".
  describe('interrupt-marker carve-out', () => {
    it('delivers a `!`-interrupt body mid-turn (does NOT buffer)', () => {
      // The headline regression fix. Without the carve-out the killed turn
      // strands the body indefinitely.
      expect(
        decideInboundDelivery({
          turnInFlight: true,
          isSteering: false,
          isInterrupt: true,
        }),
      ).toBe('deliver')
    })

    it('delivers a `!`-interrupt body even when claude is idle (no harm)', () => {
      expect(
        decideInboundDelivery({
          turnInFlight: false,
          isSteering: false,
          isInterrupt: true,
        }),
      ).toBe('deliver')
    })

    it('isInterrupt is optional — omitting it preserves legacy behavior', () => {
      // Backward-compat for callers that haven't been updated yet. Mirrors
      // the optional-default pattern used in other gateway predicates this
      // session (silent-reply-anchor wasOverPingSuppressed, recent-outbound-
      // dedup turnKey).
      expect(
        decideInboundDelivery({ turnInFlight: true, isSteering: false }),
      ).toBe('buffer-until-idle')
      expect(
        decideInboundDelivery({ turnInFlight: false, isSteering: false }),
      ).toBe('deliver')
    })

    it('explicit isInterrupt:false is identical to omitting it', () => {
      expect(
        decideInboundDelivery({
          turnInFlight: true,
          isSteering: false,
          isInterrupt: false,
        }),
      ).toBe('buffer-until-idle')
    })

    it('interrupt + steering combination delivers (both are exempt paths)', () => {
      // Pathological prompt: `! /steer change tactics`. parseInterruptMarker
      // strips the `!`, then steering parse sees `/steer`. Either flag
      // alone delivers; both together still deliver. No regression.
      expect(
        decideInboundDelivery({
          turnInFlight: true,
          isSteering: true,
          isInterrupt: true,
        }),
      ).toBe('deliver')
    })
  })
})
