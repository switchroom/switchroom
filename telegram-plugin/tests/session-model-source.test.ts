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
import type { SessionModelDivergence } from '../gateway/session-model-source.js'
import { servedModelMatchesRequested } from '../gateway/model-command.js'

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

  it('#3241 optimistic override: a silently-switched model recorded without a confirmation still wins /status', () => {
    // Part B — the typed set path records the REQUESTED model optimistically when
    // the confirmation line was missed. That override, being the freshest write,
    // must reclaim /status from the stale transcript line just like a confirmed
    // switch (symptom 4: "/status shows old model" after an in-place typed switch).
    const s = createSessionModelSource()
    s.noteTranscriptModel('claude-opus-4-8') // old model's last assistant line
    s.setOverride('fable') // optimistic record of the requested model (no confirmation read)
    expect(s.resolve()).toEqual({ model: 'fable', source: 'override' })
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

// ── #3427 item 4: requested-vs-served divergence tripwire ────────────────────
//
// `--fallback-model` masks an invalid requested id: the override carries the
// requested token while claude silently serves the fallback. The FIRST live
// transcript observation of the post-relaunch session is the earliest
// deterministic verification point — these assert the handler FIRES on a
// mismatch (with the right payload), fires at most once per armed override,
// and — the #3437 H1/H2 false-positive contract — NEVER fires from a
// command-time (unarmed) override set or from a first-attach replay line.

describe('createSessionModelSource — divergence tripwire (#3427)', () => {
  function armed() {
    const fired: SessionModelDivergence[] = []
    const s = createSessionModelSource({ servedMatchesRequested: servedModelMatchesRequested })
    s.setDivergenceHandler((d) => fired.push(d))
    return { s, fired }
  }

  it('fires ONCE with requested+served when the first post-boot line serves a different model', () => {
    const { s, fired } = armed()
    s.setOverride('claude-sonnet-9', { verify: true }) // boot rehydration: invalid id, fallback will substitute
    s.noteTranscriptModel('claude-opus-4-8') // first assistant line: the fallback
    expect(fired).toEqual([{ requested: 'claude-sonnet-9', served: 'claude-opus-4-8' }])
    // Subsequent lines do not re-fire (once per armed override).
    s.noteTranscriptModel('claude-opus-4-8')
    expect(fired).toHaveLength(1)
  })

  it('does NOT fire when the served model satisfies the requested token (alias → full id)', () => {
    const { s, fired } = armed()
    s.setOverride('sonnet', { verify: true })
    s.noteTranscriptModel('claude-sonnet-5')
    expect(fired).toHaveLength(0)
  })

  it('verification is consumed by the FIRST live observation — a later different model is a normal switch, not a divergence', () => {
    const { s, fired } = armed()
    s.setOverride('claude-opus-4-8', { verify: true })
    s.noteTranscriptModel('claude-opus-4-8') // verified OK
    s.noteTranscriptModel('claude-sonnet-5') // e.g. a native in-session switch
    expect(fired).toHaveLength(0)
  })

  it('re-arms on every verify-set', () => {
    const { s, fired } = armed()
    s.setOverride('claude-opus-4-8', { verify: true })
    s.noteTranscriptModel('claude-opus-4-8') // ok
    s.setOverride('claude-sonnet-9', { verify: true }) // next apply-boot, bogus id
    s.noteTranscriptModel('claude-opus-4-8') // fallback again
    expect(fired).toEqual([{ requested: 'claude-sonnet-9', served: 'claude-opus-4-8' }])
  })

  it('clearing the override disarms (nothing to verify)', () => {
    const { s, fired } = armed()
    s.setOverride('claude-sonnet-9', { verify: true })
    s.setOverride(null)
    s.noteTranscriptModel('claude-opus-4-8')
    expect(fired).toHaveLength(0)
  })

  // H1 (#3437 review blocker): the command-time scheduleModelRelaunch record —
  // setOverride(model) with NO verify — must not arm. The prior boot may have
  // left the handler registered and its own arm consumed; an assistant line in
  // the pre-restart window is served by the OLD model and would otherwise
  // false-accuse a perfectly valid NEW token.
  it('H1: a command-time setOverride (no verify) NEVER arms — no false DIVERGENCE in the pre-restart window', () => {
    const { s, fired } = armed()
    // Prior apply-boot: armed, verified OK on the first line.
    s.setOverride('claude-opus-4-8', { verify: true })
    s.noteTranscriptModel('claude-opus-4-8')
    // Operator issues /model <valid new id>; scheduleModelRelaunch records it
    // pre-restart (status honesty) WITHOUT verify.
    s.setOverride('claude-sonnet-5')
    // The still-running OLD session emits another assistant line before the
    // restart lands — served by the OLD model. Must NOT fire.
    s.noteTranscriptModel('claude-opus-4-8')
    expect(fired).toHaveLength(0)
    // …and the override record itself is intact for /status honesty.
    expect(s.getOverride()).toBe('claude-sonnet-5')
  })

  it('H1: a verify-arm is CLEARED by a later plain set (the newest write wins, unarmed)', () => {
    const { s, fired } = armed()
    s.setOverride('claude-sonnet-9', { verify: true }) // armed, not yet verified
    s.setOverride('claude-haiku-4-5') // command-time re-set before any line
    s.noteTranscriptModel('claude-opus-4-8')
    expect(fired).toHaveLength(0)
  })

  // H2 (#3437 review blocker): the session-tail's first-attach replay delivers
  // the PRIOR session's in-flight turn AFTER boot — OLD-model lines. They must
  // neither fire nor consume verification; the first LIVE line still verifies.
  it('H2: replayed observations neither fire nor consume — the first LIVE line still verifies (valid switch, no card)', () => {
    const { s, fired } = armed()
    s.setOverride('claude-sonnet-5', { verify: true }) // apply-boot onto a VALID id
    // Boot replay of the pre-relaunch in-flight turn (old model claude-opus-4-8).
    s.noteTranscriptModel('claude-opus-4-8', { replayed: true })
    s.noteTranscriptModel('claude-opus-4-8', { replayed: true })
    expect(fired).toHaveLength(0) // the false-positive path the review flagged
    // First LIVE line of the new session: the requested model. Verified clean.
    s.noteTranscriptModel('claude-sonnet-5')
    expect(fired).toHaveLength(0)
  })

  it('H2: a genuinely bogus id still fires on the first LIVE line after replay', () => {
    const { s, fired } = armed()
    s.setOverride('claude-sonnet-9', { verify: true })
    s.noteTranscriptModel('claude-opus-4-8', { replayed: true }) // replayed old-turn line: ignored
    expect(fired).toHaveLength(0)
    s.noteTranscriptModel('claude-opus-4-8') // first LIVE line: the fallback
    expect(fired).toEqual([{ requested: 'claude-sonnet-9', served: 'claude-opus-4-8' }])
  })

  it('replayed observations still update /status freshness exactly as before', () => {
    const { s } = armed()
    s.setOverride('claude-sonnet-5', { verify: true })
    s.noteTranscriptModel('claude-opus-4-8', { replayed: true })
    // Freshness contract unchanged: the newer observation (transcript) wins.
    expect(s.resolve()).toEqual({ model: 'claude-opus-4-8', source: 'transcript' })
  })

  it('never fires without a comparator (default construction) — old callers unchanged', () => {
    const fired: SessionModelDivergence[] = []
    const s = createSessionModelSource()
    s.setDivergenceHandler((d) => fired.push(d))
    s.setOverride('claude-sonnet-9', { verify: true })
    s.noteTranscriptModel('claude-opus-4-8')
    expect(fired).toHaveLength(0)
  })

  it('a handler that clears the override does not break resolution', () => {
    const s = createSessionModelSource({ servedMatchesRequested: servedModelMatchesRequested })
    s.setDivergenceHandler(() => s.setOverride(null))
    s.setOverride('claude-sonnet-9', { verify: true })
    s.noteTranscriptModel('claude-opus-4-8')
    expect(s.getOverride()).toBeNull()
    expect(s.resolve()).toEqual({ model: 'claude-opus-4-8', source: 'transcript' })
  })
})
