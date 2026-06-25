/**
 * Regression contract for #2533: the over-ping anti-spam downgrade MUST NOT
 * pollute final-answer classification.
 *
 * The bug (surfaced by the `midturn-silent-dm` UAT against v0.15.57): in
 * `executeReply`, the #1675 over-ping safety net reassigns the local
 * `disableNotification` to `true` to silence a 2nd+ ping in a turn, and the
 * final-answer classifier was then read with that *downgraded* value. So a
 * final answer the model INTENDED to ping but the anti-spam net silenced was
 * misclassified as not-final → `finalAnswerDelivered` stayed false → a
 * spurious silent-end re-prompt (#1664) AND a false 'undelivered' 😐 (#2530).
 *
 * The contract this pins (what `executeStreamReply` already did, and what
 * #2533 made `executeReply` do): final-answer classification keys on the
 * MODEL'S ORIGINAL INTENT (`args.disable_notification`), not the
 * over-ping-downgraded send value. The actual SEND still honours the
 * downgrade — only the classification is decoupled.
 *
 * `executeReply` itself isn't unit-callable (it lives in the 22k-line
 * gateway), so this ties the two real pure modules together to reproduce the
 * exact failing sequence and assert the invariant.
 */

import { describe, it, expect } from 'vitest'
import { decideOverPing } from '../over-ping-safety-net.js'
import { isFinalAnswerReply, isSubstantiveFinalReply } from '../final-answer-detect.js'

describe('#2533 — over-ping downgrade must not pollute final-answer classification', () => {
  // The midturn-silent-dm failing sequence: an interim ack pings, then a
  // SHORT final answer the model also intended to ping.
  const ACK = { text: 'On it.', modelWantsPing: true }
  const FINAL = { text: 'Hostname is example-host.', modelWantsPing: true } // <200 chars

  it('reproduces the sequence: ack claims the ping slot, the short final gets over-ping-suppressed', () => {
    // Beat 1 — the ack pings; first ping of the turn claims the slot (not suppressed).
    const ackDecision = decideOverPing({ modelRequestedPing: ACK.modelWantsPing, firstPingAt: null, nowMs: 1_000 })
    expect(ackDecision.suppress).toBe(false)
    expect(ackDecision.claimSlot).toBe(true)
    const firstPingAt = 1_000

    // Beat 2 — the real final answer also wants to ping, but the slot is taken → SUPPRESS.
    const finalDecision = decideOverPing({ modelRequestedPing: FINAL.modelWantsPing, firstPingAt, nowMs: 2_000 })
    expect(finalDecision.suppress).toBe(true) // the gateway would downgrade disable_notification:false → true
  })

  it('classifying on the MODEL INTENT marks the suppressed short final as final (correct)', () => {
    // This is what the gateway MUST do (#2533): use args.disable_notification,
    // NOT the over-ping-downgraded value.
    const modelDisableNotification = !FINAL.modelWantsPing // model wanted to ping → false
    expect(
      isFinalAnswerReply({ text: FINAL.text, disableNotification: modelDisableNotification }),
    ).toBe(true) // delivered final → finalAnswerDelivered=true → no spurious re-prompt, no false 😐
  })

  it('classifying on the DOWNGRADED value misclassifies it as not-final (the bug #2533 fixed)', () => {
    // The over-ping net forced disable_notification → true. If classification
    // reads THAT (the pre-#2533 bug), the short non-done final is seen as an
    // interim ack → finalAnswerDelivered stays false → spurious re-prompt + 😐.
    const downgradedDisableNotification = true
    expect(
      isFinalAnswerReply({ text: FINAL.text, disableNotification: downgradedDisableNotification }),
    ).toBe(false) // <-- this WRONG classification is exactly what the gateway must NOT produce
  })

  it('a genuinely-silent interim ack (model set disable_notification:true) is still NOT final — fix does not over-correct', () => {
    // The decoupling must not turn EVERY reply final: a short reply the MODEL
    // marked silent (a real interim ack) still classifies non-final on model intent.
    const modelSilentAck = true
    expect(
      isFinalAnswerReply({ text: 'looking into that…', disableNotification: modelSilentAck }),
    ).toBe(false)
  })

  it('a long over-ping-suppressed answer was already final regardless (length backstop) — fix matters for SHORT finals', () => {
    const long = 'x'.repeat(250)
    // Even classifying on the downgraded value, length ≥200 makes it final — so
    // the bug only ever bit SHORT over-ping-suppressed finals (the #2533 case).
    expect(isFinalAnswerReply({ text: long, disableNotification: true })).toBe(true)
    expect(isFinalAnswerReply({ text: long, disableNotification: false })).toBe(true)
  })
})

/**
 * Notification ownership (R8 / PR-2 — design `docs/message-emission-
 * determinism.md` §over-ping). The substantive final answer must OWN the
 * turn's single device ping. The residual the bare "first ping wins" rule
 * left: an interim ack pings first and claims the slot, so the later
 * substantive answer is downgraded to silent — "the reply is last but the
 * phone never buzzed for the answer." `decideOverPing` is now aware of WHO
 * holds the slot (`firstPingWasSubstantive`) and WHO is asking
 * (`substantive`) and UPGRADES a substantive answer over an ack's slot,
 * while still suppressing every double-ping the #1674 guard exists for.
 *
 * The 2×2 ownership matrix (model wants to ping, slot already held):
 *
 *   incoming \ slot held by │ ACK (non-substantive) │ SUBSTANTIVE
 *   ────────────────────────┼───────────────────────┼─────────────
 *   SUBSTANTIVE answer       │ UPGRADE (ping, claim)  │ suppress (#1674)
 *   ACK                      │ suppress (orig)        │ suppress
 */
describe('R8 / PR-2 — substantive final answer OWNS the turn ping (upgrade matrix)', () => {
  const SUBSTANTIVE = 'x'.repeat(300) // ≥200 → isSubstantiveFinalReply true
  const ACK = 'On it.' // <200, non-done → ack

  it('row 1 — substantive answer pinging over an ACK-held slot ⇒ UPGRADE (not suppressed)', () => {
    // The ack pinged first (claimed the slot, non-substantive).
    const ack = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: null,
      substantive: isSubstantiveFinalReply({ text: ACK, disableNotification: false }),
      nowMs: 1_000,
    })
    expect(ack.claimSlot).toBe(true)
    expect(ack.upgrade).toBe(false)
    // Now the substantive answer wants to ping; the slot is ack-held.
    const answer = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: 1_000,
      substantive: isSubstantiveFinalReply({ text: SUBSTANTIVE, disableNotification: false }),
      firstPingWasSubstantive: false, // the ack
      nowMs: 2_000,
    })
    expect(answer.suppress).toBe(false) // the ANSWER pings — phone buzzes for the answer
    expect(answer.claimSlot).toBe(true) // slot upgraded to substantive
    expect(answer.upgrade).toBe(true)
  })

  it('row 2 — ACK pinging over a SUBSTANTIVE-held slot ⇒ suppress (no double-ping after the answer)', () => {
    const d = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: 1_000,
      substantive: isSubstantiveFinalReply({ text: ACK, disableNotification: false }),
      firstPingWasSubstantive: true, // the real answer already owned the slot
      nowMs: 2_000,
    })
    expect(d.suppress).toBe(true)
    expect(d.claimSlot).toBe(false)
    expect(d.upgrade).toBe(false)
  })

  it('row 3 — SUBSTANTIVE over a SUBSTANTIVE-held slot ⇒ suppress (preserves the #1674 model-double-ping guard)', () => {
    // The reproducer #1674 targeted: a substantive answer pinged, then a
    // substantive wrap-up also wants to ping. One beep, not two.
    const d = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: 30_000,
      substantive: isSubstantiveFinalReply({ text: SUBSTANTIVE, disableNotification: false }),
      firstPingWasSubstantive: true,
      nowMs: 36_000,
    })
    expect(d.suppress).toBe(true)
    expect(d.upgrade).toBe(false)
    expect(d.sinceFirstPingMs).toBe(6_000)
  })

  it('row 4 — ACK over an ACK-held slot ⇒ suppress (original one-ping-per-turn behaviour, unchanged)', () => {
    const d = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: 1_000,
      substantive: isSubstantiveFinalReply({ text: ACK, disableNotification: false }),
      firstPingWasSubstantive: false,
      nowMs: 2_000,
    })
    expect(d.suppress).toBe(true)
    expect(d.claimSlot).toBe(false)
    expect(d.upgrade).toBe(false)
  })

  it('the upgrade fires AT MOST once: after an upgrade, a further ack does NOT re-upgrade', () => {
    // ack pings (slot=ack) → answer upgrades (slot=substantive) → a trailing
    // ack must now suppress, not ping a third time.
    const trailingAck = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: 2_000, // upgraded slot timestamp
      substantive: false,
      firstPingWasSubstantive: true, // slot now substantive after the upgrade
      nowMs: 3_000,
    })
    expect(trailingAck.suppress).toBe(true)
    expect(trailingAck.upgrade).toBe(false)
  })

  it('a substantive FIRST ping still claims (no upgrade flag) — upgrade is strictly the second-ping case', () => {
    const d = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: null, // no prior ping this turn
      substantive: true,
      nowMs: 1_000,
    })
    expect(d.claimSlot).toBe(true)
    expect(d.upgrade).toBe(false) // first ping is a claim, not an upgrade
    expect(d.suppress).toBe(false)
  })
})
