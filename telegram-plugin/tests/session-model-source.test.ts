/**
 * Pins the /status session-model freshness contract (#2982 + live-model PR):
 * the FRESHEST observation wins between the transcript's `message.model` and
 * the /model override, arbitrated by a shared monotonic sequence. This is the
 * "model display must never be stale" invariant:
 *
 *   - override set AFTER the last transcript observation (idle-time /model
 *     switch, no assistant line yet) → /status shows the override;
 *   - a new assistant line after that → the transcript wins again.
 */
import { describe, it, expect } from 'vitest'
import { createSessionModelSource } from '../gateway/session-model-source.js'

describe('createSessionModelSource — freshest observation wins', () => {
  it('returns null when neither source has reported', () => {
    const s = createSessionModelSource()
    expect(s.resolve()).toBeNull()
    expect(s.getOverride()).toBeNull()
  })

  it('transcript-only → transcript', () => {
    const s = createSessionModelSource()
    s.noteTranscriptModel('claude-opus-4-8')
    expect(s.resolve()).toEqual({ model: 'claude-opus-4-8', source: 'transcript' })
  })

  it('override-only → override (fresh boot before the first assistant line)', () => {
    const s = createSessionModelSource()
    s.setOverride('sr-glm-5')
    expect(s.resolve()).toEqual({ model: 'sr-glm-5', source: 'override' })
  })

  it('idle-after-switch window: an override set AFTER the last transcript line wins', () => {
    // The #2982 regression this pins: /model switch while idle — the
    // transcript still holds the OLD model, the override holds the NEW one.
    const s = createSessionModelSource()
    s.noteTranscriptModel('claude-opus-4-8') // old model's last assistant line
    s.setOverride('Sonnet 5') // confirmed switch, no assistant line yet
    expect(s.resolve()).toEqual({ model: 'Sonnet 5', source: 'override' })
  })

  it('a NEW assistant line after the switch reclaims the transcript as the source', () => {
    const s = createSessionModelSource()
    s.noteTranscriptModel('claude-opus-4-8')
    s.setOverride('Sonnet 5')
    s.noteTranscriptModel('claude-sonnet-5') // first line under the new model
    expect(s.resolve()).toEqual({ model: 'claude-sonnet-5', source: 'transcript' })
  })

  it('clearing the override (null) falls back to the transcript', () => {
    const s = createSessionModelSource()
    s.noteTranscriptModel('claude-opus-4-8')
    s.setOverride('sr-glm-5')
    s.setOverride(null)
    expect(s.getOverride()).toBeNull()
    expect(s.resolve()).toEqual({ model: 'claude-opus-4-8', source: 'transcript' })
  })

  it('getOverride reports the override independent of freshness', () => {
    const s = createSessionModelSource()
    s.setOverride('sr-glm-5')
    s.noteTranscriptModel('claude-opus-4-8') // transcript is now fresher
    expect(s.resolve()?.source).toBe('transcript')
    // ...but the override record itself is still readable (menu "session" marker).
    expect(s.getOverride()).toBe('sr-glm-5')
  })
})
