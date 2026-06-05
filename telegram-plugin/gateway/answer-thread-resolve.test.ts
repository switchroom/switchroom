import { describe, it, expect } from 'vitest'
import { resolveAnswerThreadId } from './answer-thread-resolve.js'

describe('resolveAnswerThreadId — precedence', () => {
  it('(1) explicit model thread wins over everything', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: 7,
        originResolved: true,
        originThreadId: 3,
        liveThreadId: 4,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: 9,
      }),
    ).toBe(7)
  })

  it('(2) origin turn thread wins over the live turn (the Brevo→Meta fix)', () => {
    expect(
      resolveAnswerThreadId({ originResolved: true, originThreadId: 3, liveThreadId: 4 }),
    ).toBe(3)
  })

  it('(2) a DM origin (resolved, thread undefined) pins to undefined, not the live thread', () => {
    expect(
      resolveAnswerThreadId({ originResolved: true, originThreadId: undefined, liveThreadId: 4 }),
    ).toBeUndefined()
  })

  it('(3) no origin → falls back to the live turn thread (legacy #1664)', () => {
    expect(
      resolveAnswerThreadId({ originResolved: false, liveThreadId: 4 }),
    ).toBe(4)
  })

  // ── tier (4): late-reply topic recovery (2026-06-05) ──────────────────────
  it('(4) no explicit, no origin, NO live turn → recovers the most-recent ended turn thread', () => {
    // The marko bug: a reply that fired after the orphaned-reply backstop ended
    // its turn. Pre-fix this returned undefined (General); now it recovers topic 3.
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveThreadId: undefined,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: 3,
      }),
    ).toBe(3)
  })

  it('(4) a recovered DM turn (ended, thread undefined) stays threadless', () => {
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveThreadId: undefined,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: undefined,
      }),
    ).toBeUndefined()
  })

  it('(4) recovery does NOT override a live turn — live thread still wins at tier 3', () => {
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveThreadId: 4,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: 3,
      }),
    ).toBe(4)
  })

  it('(4) no recovery candidate → legacy result (undefined), unchanged', () => {
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveThreadId: undefined,
        lastEndedResolvedForChat: false,
      }),
    ).toBeUndefined()
  })

  it('pure DM (every tier undefined) → undefined', () => {
    expect(resolveAnswerThreadId({ originResolved: false })).toBeUndefined()
  })
})
