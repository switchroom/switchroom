/**
 * Per-turn silent-gap tracker for streaming observability.
 *
 * Tracks the longest contiguous interval within a turn where no user-visible
 * signal was sent. Signals include: progress-card edits, status-reaction
 * transitions, answer-lane updates, and fresh sendMessage calls.
 *
 * Keyed by chatId+threadId so concurrent turns in different chats don't
 * collide. Designed to be fully standalone (no grammy/bot dependency) so
 * it's testable with deterministic time injection via vi.useFakeTimers().
 *
 * Usage:
 *   signalTracker.reset(key, now)       // at turn start
 *   signalTracker.noteSignal(key, now)  // on every user-visible signal
 *   signalTracker.getLongestGap(key)    // at turn_end
 *   signalTracker.clear(key)            // after emitting (cleanup)
 */

export interface TurnSignalState {
  /** The time the current gap started (i.e., the last signal time). */
  lastSignalAt: number
  /** The longest gap observed so far (ms). */
  longestGapMs: number
}

/**
 * Module-scoped map: `"chatId:threadId"` → state. Using a module-level map
 * keeps the tracker lightweight and avoids passing state through every
 * call-site while remaining mockable in tests via the exported functions.
 */
const state = new Map<string, TurnSignalState>()

/**
 * Begin tracking a new turn. Records `now` as the initial signal time and
 * resets the gap accumulator. Call at the start of each fresh turn.
 */
export function reset(key: string, now: number): void {
  state.set(key, { lastSignalAt: now, longestGapMs: 0 })
}

/**
 * Record a user-visible signal. Measures the gap since the last signal and
 * updates `longestGapMs` if this gap is larger.
 */
export function noteSignal(key: string, now: number): void {
  const entry = state.get(key)
  if (entry == null) return
  const gap = now - entry.lastSignalAt
  if (gap > entry.longestGapMs) entry.longestGapMs = gap
  entry.lastSignalAt = now
}

/**
 * Returns the longest gap observed during the current turn (ms).
 * Returns 0 if no tracking state exists for this key.
 */
export function getLongestGap(key: string): number {
  return state.get(key)?.longestGapMs ?? 0
}

/**
 * Returns the last signal time for this key, or undefined if not tracked.
 * Useful for computing a trailing gap at turn_end before calling clear().
 */
export function getLastSignalAt(key: string): number | undefined {
  return state.get(key)?.lastSignalAt
}

/**
 * Remove state for this key. Call after emitting the turn_signal_gap metric.
 */
export function clear(key: string): void {
  state.delete(key)
}

/** Exposed for tests — clears all tracked state. */
export function __resetAllForTests(): void {
  state.clear()
}
