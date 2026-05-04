/**
 * PR-C2 — fast-turn race between considerPin's deferred timer and a
 * subsequent completeTurn.
 *
 * considerPin schedules a pendingPin timer with `pinDelayMs`. If the
 * turn completes BEFORE the timer fires, completeTurn must:
 *
 *   - Cancel the timer (no Telegram pin issued).
 *   - Drop the entry from pendingPins (no orphan).
 *
 * fails when: completeTurn's pending-pin cancellation branch is removed
 * or the entry isn't deleted from `pendingPins` after `timer.cancel()`
 * (which would let a follow-up considerPin for the same composite get
 * silently no-op'd by the `pendingPins.has(key)` guard).
 */
import { describe, it, expect, vi } from 'vitest'
import { createPinManager, type TimerHandle } from '../progress-card-pin-manager.js'

interface T { fn: () => void; cancelled: boolean; fired: boolean }

describe('PR-C2: fast-turn pin-race — completeTurn before timer fires', () => {
  it('cancels the pending pin timer and clears pendingPins; no pin API call ever issued', async () => {
    const timers: T[] = []
    const pin = vi.fn(async () => true)
    const unpin = vi.fn(async () => true)

    const mgr = createPinManager({
      pin, unpin,
      log: () => {},
      now: () => 1000,
      pinDelayMs: 100, // non-zero so we have a race window
      scheduleTimer: (fn): TimerHandle => {
        const t: T = { fn, cancelled: false, fired: false }
        timers.push(t)
        return { cancel: () => { t.cancelled = true } }
      },
    })

    mgr.considerPin({
      chatId: 'c', threadId: '0', turnKey: 'c:0:1', messageId: 500, isFirstEmit: true,
    })

    // Timer scheduled but NOT fired.
    expect(timers).toHaveLength(1)
    expect(timers[0].cancelled).toBe(false)
    expect(timers[0].fired).toBe(false)

    // Fast turn completes before timer fires.
    mgr.completeTurn({ chatId: 'c', turnKey: 'c:0:1' })
    await mgr.drainInFlight()

    expect(timers[0].cancelled).toBe(true)
    expect(pin).not.toHaveBeenCalled()
    expect(unpin).not.toHaveBeenCalled()
    expect(mgr.pinnedTurnKeys()).toEqual([])

    // No orphan: a fresh considerPin under the same composite must be
    // able to schedule a new timer (would no-op if pendingPins still
    // had the stale entry).
    mgr.considerPin({
      chatId: 'c', threadId: '0', turnKey: 'c:0:1', messageId: 500, isFirstEmit: true,
    })
    expect(timers).toHaveLength(2)
    expect(timers[1].cancelled).toBe(false)
  })
})
