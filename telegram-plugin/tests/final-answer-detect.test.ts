/**
 * Unit coverage for the #1664 final-answer detection predicate.
 *
 * `isFinalAnswerReply` is the finer signal the silent-end re-prompt needs:
 * the gateway's `replyCalled` flag flips on the first reply / stream_reply
 * tool use and cannot tell an interim ack from the real answer. This
 * predicate classifies each reply so a turn whose every reply was "interim"
 * (and whose real answer ended up as plain transcript text) ends with
 * `finalAnswerDelivered === false` and triggers the re-prompt — the #1664
 * bug (streamed answers rendered to a draft, retracted at turn_end, lost).
 *
 * These tests pin the pure predicate. The gateway wires it into
 * executeReply / executeStreamReply (covered by the gateway integration
 * surface); pinning the policy here keeps it auditable without importing
 * the multi-thousand-line gateway module.
 */

import { describe, it, expect } from 'vitest'
import {
  isFinalAnswerReply,
  isSubstantiveFinalReply,
  FINAL_ANSWER_MIN_CHARS,
} from '../final-answer-detect.js'

describe('isFinalAnswerReply — #1664 final-answer classification', () => {
  it('classifies a notification-bearing reply as the final answer', () => {
    // disable_notification:false is the pacing contract's "final answer"
    // signal — interim updates pass disable_notification:true.
    expect(
      isFinalAnswerReply({ text: 'short answer', disableNotification: false }),
    ).toBe(true)
  })

  it('classifies a short interim ack (disable_notification:true) as NOT final', () => {
    expect(
      isFinalAnswerReply({ text: 'on it…', disableNotification: true }),
    ).toBe(false)
  })

  it('length backstop: a long reply mis-marked interim still counts as final', () => {
    const longText = 'x'.repeat(FINAL_ANSWER_MIN_CHARS)
    expect(
      isFinalAnswerReply({ text: longText, disableNotification: true }),
    ).toBe(true)
  })

  it('length backstop is inclusive at exactly FINAL_ANSWER_MIN_CHARS', () => {
    expect(
      isFinalAnswerReply({
        text: 'x'.repeat(FINAL_ANSWER_MIN_CHARS),
        disableNotification: true,
      }),
    ).toBe(true)
    // One char under the threshold and marked interim → still interim.
    expect(
      isFinalAnswerReply({
        text: 'x'.repeat(FINAL_ANSWER_MIN_CHARS - 1),
        disableNotification: true,
      }),
    ).toBe(false)
  })

  it('stream_reply done=true is always the final answer, even short + interim', () => {
    // A done=true call explicitly closes the stream — it IS the answer,
    // regardless of length or the notification flag.
    expect(
      isFinalAnswerReply({ text: 'ok', disableNotification: true, done: true }),
    ).toBe(true)
  })

  it('a non-terminal stream_reply chunk (done=false) is classified like a plain reply', () => {
    // Short interim chunk → not final.
    expect(
      isFinalAnswerReply({ text: 'thinking…', disableNotification: true, done: false }),
    ).toBe(false)
    // Notification-bearing chunk → final.
    expect(
      isFinalAnswerReply({ text: 'here it is', disableNotification: false, done: false }),
    ).toBe(true)
  })

  it('an empty reply marked interim is NOT the final answer', () => {
    expect(
      isFinalAnswerReply({ text: '', disableNotification: true }),
    ).toBe(false)
  })

  it('FINAL_ANSWER_MIN_CHARS is the documented 200-char backstop', () => {
    // Guards the constant against silent drift — the value is referenced
    // in the CurrentTurn doc-comment and the Stop-hook rationale.
    expect(FINAL_ANSWER_MIN_CHARS).toBe(200)
  })
})

describe('isSubstantiveFinalReply — feed-reopen ACK-ONLY distinction', () => {
  // isSubstantiveFinalReply is isFinalAnswerReply MINUS the ping-only path.
  // It tells "genuine final answer" (stream-done or ≥200 chars) apart from
  // "final only because it pinged" (a short interim ack). The feed-reopen
  // gate reopens only when finalAnswerDelivered && !substantive, so a real
  // answer + post-answer housekeeping does NOT spuriously reopen / trip the
  // silent-end re-prompt.

  it('stream_reply done=true → substantive (closes the stream = the answer)', () => {
    expect(
      isSubstantiveFinalReply({ text: 'ok', disableNotification: true, done: true }),
    ).toBe(true)
  })

  it('a reply at/over the length backstop → substantive', () => {
    expect(
      isSubstantiveFinalReply({
        text: 'x'.repeat(FINAL_ANSWER_MIN_CHARS),
        disableNotification: true,
      }),
    ).toBe(true)
    // One under the threshold, silent → not substantive.
    expect(
      isSubstantiveFinalReply({
        text: 'x'.repeat(FINAL_ANSWER_MIN_CHARS - 1),
        disableNotification: true,
      }),
    ).toBe(false)
  })

  it('a short PINGING reply is final but NOT substantive (the ack case)', () => {
    // The crux: isFinalAnswerReply says true (it pings), but this is the
    // ack the feed-reopen gate must treat as reopen-eligible — NOT a real
    // answer. So isSubstantiveFinalReply must say false.
    expect(
      isFinalAnswerReply({ text: 'on it, checking Brevo…', disableNotification: false }),
    ).toBe(true)
    expect(
      isSubstantiveFinalReply({ text: 'on it, checking Brevo…', disableNotification: false }),
    ).toBe(false)
  })

  it('a short SILENT interim reply is neither final nor substantive', () => {
    expect(
      isFinalAnswerReply({ text: 'thinking…', disableNotification: true }),
    ).toBe(false)
    expect(
      isSubstantiveFinalReply({ text: 'thinking…', disableNotification: true }),
    ).toBe(false)
  })

  it('a long reply is substantive regardless of the ping flag', () => {
    const longText = 'x'.repeat(FINAL_ANSWER_MIN_CHARS)
    expect(
      isSubstantiveFinalReply({ text: longText, disableNotification: false }),
    ).toBe(true)
    expect(
      isSubstantiveFinalReply({ text: longText, disableNotification: true }),
    ).toBe(true)
  })
})
