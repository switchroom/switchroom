/**
 * Unit tests for the `progress_update` turn-less fallback attention cap
 * (`gateway/progress-fallback-cap.ts`).
 *
 * The bug this guards: when an inbound mints no turn atom (handback / progress
 * inbound turns), the per-turn 5-call cap never applied, so a worker could
 * `progress_update` at the 20s floor indefinitely. This is the real module the
 * gateway calls — it exercises the rolling-window cap, the delivery-only
 * counting, and the prune-to-empty memory behaviour directly.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  progressFallbackAtCap,
  recordProgressFallbackSend,
  _resetProgressFallbackCap,
  PROGRESS_FALLBACK_MAX,
  PROGRESS_FALLBACK_WINDOW_MS,
} from '../gateway/progress-fallback-cap.js'

const KEY = 'chat123:_'

describe('progress fallback cap', () => {
  beforeEach(() => {
    _resetProgressFallbackCap()
  })

  it('allows exactly PROGRESS_FALLBACK_MAX deliveries then caps', () => {
    let now = 1_000
    for (let i = 0; i < PROGRESS_FALLBACK_MAX; i++) {
      expect(progressFallbackAtCap(KEY, now)).toBe(false)
      recordProgressFallbackSend(KEY, now)
      now += 25_000 // past the 20s floor, still well inside the window
    }
    // The (MAX+1)th within the window is refused.
    expect(progressFallbackAtCap(KEY, now)).toBe(true)
  })

  it('rolls: a delivery ages out after the window and frees a slot', () => {
    const start = 1_000
    let now = start
    for (let i = 0; i < PROGRESS_FALLBACK_MAX; i++) {
      recordProgressFallbackSend(KEY, now)
      now += 25_000
    }
    expect(progressFallbackAtCap(KEY, now)).toBe(true)

    // Jump past the window relative to the FIRST send: the oldest entries age
    // out, so we are under cap again.
    now = start + PROGRESS_FALLBACK_WINDOW_MS + 1
    expect(progressFallbackAtCap(KEY, now)).toBe(false)
  })

  it('a slot is consumed only by recordProgressFallbackSend, not by the check', () => {
    const now = 1_000
    // Checking the cap repeatedly must not itself consume slots (models a
    // thrown send: cap checked, send throws, nothing recorded).
    for (let i = 0; i < 100; i++) {
      expect(progressFallbackAtCap(KEY, now)).toBe(false)
    }
    // Full budget still available.
    for (let i = 0; i < PROGRESS_FALLBACK_MAX; i++) {
      expect(progressFallbackAtCap(KEY, now)).toBe(false)
      recordProgressFallbackSend(KEY, now + i)
    }
    expect(progressFallbackAtCap(KEY, now + PROGRESS_FALLBACK_MAX)).toBe(true)
  })

  it('keys are independent', () => {
    const now = 1_000
    for (let i = 0; i < PROGRESS_FALLBACK_MAX; i++) {
      recordProgressFallbackSend('a:_', now + i)
    }
    expect(progressFallbackAtCap('a:_', now + PROGRESS_FALLBACK_MAX)).toBe(true)
    expect(progressFallbackAtCap('b:_', now + PROGRESS_FALLBACK_MAX)).toBe(false)
  })

  it('prunes an emptied key so the map does not grow unbounded', () => {
    // A single delivery, then a check well past the window: the key should be
    // dropped, restoring the full budget (proves the array was pruned, not
    // just skipped over).
    recordProgressFallbackSend(KEY, 1_000)
    const later = 1_000 + PROGRESS_FALLBACK_WINDOW_MS + 1
    expect(progressFallbackAtCap(KEY, later)).toBe(false)
    // And a fresh full budget is available from `later`.
    for (let i = 0; i < PROGRESS_FALLBACK_MAX; i++) {
      expect(progressFallbackAtCap(KEY, later + i)).toBe(false)
      recordProgressFallbackSend(KEY, later + i)
    }
    expect(progressFallbackAtCap(KEY, later + PROGRESS_FALLBACK_MAX)).toBe(true)
  })
})
