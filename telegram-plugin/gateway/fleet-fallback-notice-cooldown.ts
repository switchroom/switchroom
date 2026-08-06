/**
 * fleet-fallback-notice-cooldown.ts — per-gateway cooldown gates for the two
 * NO-OP fleet-fallback outcomes: "all accounts blocked" and "strict-pinned".
 *
 * Both outcomes make `doFireFleetAutoFallback` return false WITHOUT swapping the
 * active account, so the `fleetFallbackGate` dedup window never arms for them and
 * the ~60s `quota_wall_detected` re-trigger would otherwise re-broadcast the
 * identical card every minute for the life of the wall. Each outcome gets its own
 * per-gateway cooldown window (separate state so a strict-pinned card never
 * suppresses a genuine later all-blocked, or vice versa). A successful swap resets
 * both windows so a fresh transition after recovery is not stale-suppressed.
 *
 * Extracted verbatim from gateway.ts (switchroom#4442) to keep the inline notice
 * logic out of the file the line-ratchet guards. Behaviour is byte-identical to
 * the previous inline gates: same 30-min cooldown window (via
 * `evaluateAllBlockedNotice`), same stderr suppress-log text, same
 * return-false-on-suppress contract.
 */

import {
  evaluateAllBlockedNotice,
  type FallbackAllBlockedNoticeState,
} from '../auto-fallback-fleet.js'

let allBlockedState: FallbackAllBlockedNoticeState = { lastSentAtMs: 0 }
let strictPinnedState: FallbackAllBlockedNoticeState = { lastSentAtMs: 0 }

/** Reset both cooldown windows — called on a successful account swap. */
export function resetFleetFallbackNoticeCooldowns(): void {
  allBlockedState = { lastSentAtMs: 0 }
  strictPinnedState = { lastSentAtMs: 0 }
}

/**
 * Gate the "all accounts blocked" card. Returns true if it should be sent now
 * (advancing the cooldown window); false if suppressed by the window, writing the
 * same stderr suppress log the gateway used inline.
 */
export function shouldSendAllBlockedNotice(
  triggerAgent: string,
  now: number = Date.now(),
): boolean {
  const verdict = evaluateAllBlockedNotice(allBlockedState, now)
  if (!verdict.send) {
    process.stderr.write(
      `telegram gateway: [fleet-fallback] all-blocked card suppressed (cooldown) agent=${triggerAgent}\n`,
    )
    return false
  }
  allBlockedState = verdict.next
  return true
}

/**
 * Gate the "strict-pinned" card. Same contract as `shouldSendAllBlockedNotice`,
 * against the separate strict-pinned cooldown window.
 */
export function shouldSendStrictPinnedNotice(
  triggerAgent: string,
  now: number = Date.now(),
): boolean {
  const verdict = evaluateAllBlockedNotice(strictPinnedState, now)
  if (!verdict.send) {
    process.stderr.write(
      `telegram gateway: [fleet-fallback] strict-pinned card suppressed (cooldown) agent=${triggerAgent}\n`,
    )
    return false
  }
  strictPinnedState = verdict.next
  return true
}
