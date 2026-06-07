import { describe, expect, it } from 'vitest'

import { resolveAnswerThreadId } from '../gateway/answer-thread-resolve.js'

/**
 * Component 3 (multitopic reply-routing) — turn-origin answer thread.
 *
 * The Brevo answer landed ~42s after Brevo's turn-end; by then currentTurn
 * had flipped to the Meta turn. executeReply captured `turn = currentTurn`
 * and, when the model omitted message_thread_id, routed to the LIVE (Meta)
 * turn's thread — so Brevo's answer landed in Meta. The fix routes by the
 * ORIGIN turn (matched by origin_turn_id), authoritative even after the
 * flip, and never falls through to the chat last-seen heuristic for answers.
 */
describe('resolveAnswerThreadId', () => {
  const BREVO = 4
  const META = 3

  it('the model explicit no longer wins over a framework anchor (origin wins); kill switch restores legacy', () => {
    // Default (framework authority): the resolved origin owns the topic — the
    // model passing a different explicit thread cannot redirect the reply.
    expect(
      resolveAnswerThreadId({
        explicitThreadId: BREVO, // model tried to send it to Brevo
        originResolved: true,
        originThreadId: META, // but the question came from Meta
        liveTurnPresent: true,
        liveThreadId: META,
      }),
    ).toBe(META)
    // Kill switch (SWITCHROOM_REPLY_TOPIC_AUTHORITY=0): explicit wins outright.
    expect(
      resolveAnswerThreadId({
        frameworkTopicAuthority: false,
        explicitThreadId: BREVO,
        originResolved: true,
        originThreadId: META,
        liveThreadId: META,
      }),
    ).toBe(BREVO)
  })

  it('routes to the ORIGIN turn thread even when currentTurn has flipped (the headline fix)', () => {
    // Brevo reply executing late: origin=Brevo(4), live currentTurn=Meta(3).
    // Must land in Brevo, NOT the live Meta thread.
    expect(
      resolveAnswerThreadId({
        explicitThreadId: undefined,
        originResolved: true,
        originThreadId: BREVO,
        liveThreadId: META,
      }),
    ).toBe(BREVO)
  })

  it('origin thread is authoritative even when it equals the live thread (no flip)', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: undefined,
        originResolved: true,
        originThreadId: BREVO,
        liveThreadId: BREVO,
      }),
    ).toBe(BREVO)
  })

  it('a DM origin turn yields undefined (no thread), not the live thread', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: undefined,
        originResolved: true,
        originThreadId: undefined, // DM origin
        liveThreadId: META,
      }),
    ).toBeUndefined()
  })

  it('falls back to the LIVE turn thread only when no origin is resolvable (legacy #1664)', () => {
    // Model omitted origin_turn_id, or the origin turn was evicted from the
    // bounded registry: preserve the existing turn-pinned behaviour.
    expect(
      resolveAnswerThreadId({
        explicitThreadId: undefined,
        originResolved: false,
        originThreadId: undefined,
        liveThreadId: META,
      }),
    ).toBe(META)
  })

  it('DM (no thread anywhere) → undefined', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: undefined,
        originResolved: false,
        originThreadId: undefined,
        liveThreadId: undefined,
      }),
    ).toBeUndefined()
  })

  it('precedence (framework authority, default): origin > live > explicit (never chatThreadMap — not an input)', () => {
    // The chat last-seen thread is deliberately NOT a parameter: answer
    // paths can never reach it, which is what closes the wrong-topic bug.
    // The model's explicit no longer beats a framework anchor — origin wins
    // even when the model asserted a different topic (the General→CRM fix):
    expect(
      resolveAnswerThreadId({
        explicitThreadId: 9,
        originResolved: true,
        originThreadId: BREVO,
        liveTurnPresent: true,
        liveThreadId: META,
      }),
    ).toBe(BREVO)
    // no explicit, origin resolved → origin (not live):
    expect(
      resolveAnswerThreadId({
        explicitThreadId: undefined,
        originResolved: true,
        originThreadId: BREVO,
        liveThreadId: META,
      }),
    ).toBe(BREVO)
    // kill switch restores the legacy explicit-first precedence:
    expect(
      resolveAnswerThreadId({
        frameworkTopicAuthority: false,
        explicitThreadId: 9,
        originResolved: true,
        originThreadId: BREVO,
        liveThreadId: META,
      }),
    ).toBe(9)
  })
})
