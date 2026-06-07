/**
 * exhaust-until.ts — the single decision for the `until` (epoch-ms) handed to
 * the broker's mark-exhausted, shared by BOTH quota-wall paths in the gateway:
 *   - the /rate-limit-options menu signal (onQuotaWallDetected), and
 *   - the inference-path 429 (the model-unavailable operator-event path).
 *
 * Factored out of gateway.ts so the decision is unit-testable without importing
 * the gateway module (heavy import-time side effects). Pure: no IPC, no clock
 * except the injectable `now`.
 *
 * The ONE invariant both paths depend on: NEVER return undefined. A weekly wall
 * reaches the gateway as a reset hint the parser can't always read:
 *   - Menu path: the sidecar's parseWeeklyReset handles "resets Jun 9, 5am (tz)"
 *     → a finite future epoch flows straight through.
 *   - 429 path: model-unavailable.ts's parseResetTime handles the ROLLING
 *     wordings ("resets in 2h", "retry after 60s") → a finite ~hours epoch. But
 *     the WEEKLY wording reaches it as "resets <Mon> <D>, <H>am", which
 *     parseResetTime CANNOT parse (`new Date('Jun 9, 5am 2026')` → Invalid Date)
 *     → resetAtMs is undefined here EXACTLY when the wall is weekly.
 *
 * undefined (or a past / NaN reset) is the dangerous case: markExhausted's ~5h
 * default would un-exhaust a weekly-walled account after 5h and let the broker
 * re-mirror it onto the fleet (the #2218 rollback). So undefined → the +7d
 * floor. A too-long `until` only delays the broker's re-probe of the account;
 * it never serves an exhausted account, so erring long is the compliance-safe
 * direction (vision.md pillar 3).
 */

/** Weekly-quota window — the safety floor for an exhaustion `until`. */
export const EXHAUST_WEEKLY_FLOOR_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Resolve the exhaustion `until` (epoch-ms) from a best-effort reset timestamp.
 * Returns `resetAtMs` when it is a finite epoch in the future; otherwise the
 * +7d floor anchored at `now`. NEVER returns undefined.
 */
export function resolveExhaustUntil(
  resetAtMs: number | undefined,
  now: number = Date.now(),
): number {
  if (typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) && resetAtMs > now) {
    return resetAtMs
  }
  return now + EXHAUST_WEEKLY_FLOOR_MS
}
