/**
 * Model-tier quota wall — the pure decision layer for Anthropic's per-tier
 * `7d_oi` (`seven_day_overage_included`) bucket (#3176).
 *
 * THE DEFECT this module exists to fix: the broker's quota probe hits
 * `POST /v1/messages` with HAIKU and only records the 5h/7d utilization
 * windows. Anthropic's `7d_oi` bucket is PER-MODEL-TIER — an account can be
 * `rejected` on the flagship (Fable) tier while `allowed` on opus/haiku
 * (verified 2026-07-12: same account, same moment, fable=429 / opus=200 /
 * haiku=200, with `7d_oi-utilization=1.0`, `7d_oi-status=rejected`,
 * `representative-claim=seven_day_overage_included`, `retry-after≈2.8h`). A
 * haiku probe therefore reads `5h=1% / 7d=58%` — healthy — so the broker set
 * the account fleet-active and every flagship agent 429'd (an 86-request
 * storm over ~5 min until the mark rolled off).
 *
 * A model-tier wall is NOT the same as a 5h/7d exhaustion mark:
 *  - It is TIER-SCOPED: the account still serves opus/haiku fine. A blanket
 *    exhaustion mark would wrongly bench those tiers.
 *  - It is NOT transient (not a burst / RPM throttle) and NOT proxy-local
 *    (LiteLLM never emits Anthropic's unified headers). It is a real weekly
 *    wall on the flagship tier with a genuine reset.
 *
 * PURE — no I/O, no clock except the injected `now`. Fully unit-tested.
 */

import type { QuotaResult } from "../quota.js";
import { MODEL_TIER_REPRESENTATIVE_CLAIM } from "../quota.js";

/**
 * `7d_oi` utilization at/above this counts as a hard tier wall even if the
 * status header is missing. Matches the 99.5% wall the 5h/7d windows use
 * (account-eligibility.ts `WALL_PCT`) so "walled" means the same thing across
 * buckets. In practice the tier wall reports `1.0` (100%) with an explicit
 * `rejected` status.
 */
export const MODEL_TIER_WALL_PCT = 99.5;

/** The tier a model-tier wall applies to (the fleet flagship / premium tier). */
export const MODEL_TIER = "premium" as const;

export interface ModelTierWallDecision {
  /** True when the probe result proves the flagship-tier `7d_oi` bucket walled. */
  walled: boolean;
  /** Epoch ms when the tier wall lifts, when the probe carried a reset. Null
   *  otherwise (caller applies a default window). */
  until: number | null;
  /** The binding bucket claim, for operator messaging. Null when not walled. */
  bucket: string | null;
}

/**
 * Decide whether a quota probe result indicates the account is walled on the
 * flagship model tier (the `7d_oi` bucket), and when it resets. PURE.
 *
 * A FAILED probe is NOT a wall — a transient network/probe error must never
 * bench a tier (the all-blocked-from-stale-probe lesson). A NON-429 success
 * that simply lacks the tier headers (e.g. the default haiku probe, or a
 * stale/rotted canary model id that 4xx'd as "model not found") is NOT a wall
 * either — absence of signal is treated as "no wall observed", never a
 * mismark. Only a POSITIVE signal counts:
 *   - `sevenDayOiStatus === 'rejected'`, OR
 *   - `unifiedStatus === 'rejected'` with the binding representative-claim
 *     being `seven_day_overage_included`, OR
 *   - a measured `sevenDayOiUtilizationPct >= MODEL_TIER_WALL_PCT`.
 */
export function quotaIndicatesModelTierWall(
  result: QuotaResult,
): ModelTierWallDecision {
  const none: ModelTierWallDecision = { walled: false, until: null, bucket: null };
  if (!result.ok) return none;
  const d = result.data;

  const statusRejected = d.sevenDayOiStatus === "rejected";
  const claimRejected =
    d.unifiedStatus === "rejected" &&
    d.representativeClaim === MODEL_TIER_REPRESENTATIVE_CLAIM;
  const utilWalled =
    d.sevenDayOiUtilizationPct != null &&
    d.sevenDayOiUtilizationPct >= MODEL_TIER_WALL_PCT;

  if (!statusRejected && !claimRejected && !utilWalled) return none;

  return {
    walled: true,
    until: d.sevenDayOiResetAt?.getTime() ?? null,
    bucket: MODEL_TIER_REPRESENTATIVE_CLAIM,
  };
}

/**
 * Does this probe result POSITIVELY prove the flagship tier is NOT walled — a
 * clear signal to clear a stale tier-wall mark? True only when the canary came
 * back OK with an explicit `allowed` verdict AND {@link
 * quotaIndicatesModelTierWall} does not fire. A failed probe, a result with no
 * tier headers (the haiku probe, or a rotted canary id that 4xx'd), or any
 * `rejected` verdict is NOT a clear signal — the mark is left untouched (the
 * safe direction: never clear a real wall off an inconclusive probe). PURE.
 */
export function quotaTierAllowed(result: QuotaResult): boolean {
  if (!result.ok) return false;
  if (quotaIndicatesModelTierWall(result).walled) return false;
  const d = result.data;
  return d.unifiedStatus === "allowed" || d.sevenDayOiStatus === "allowed";
}

/**
 * A persisted model-tier wall mark. Distinct from the blanket `exhausted_until`
 * mark: it benches the account for FLAGSHIP-tier serving only, and expires at
 * the tier bucket's own reset. `marked_at` lets live truth override it
 * (most-recent-signal-wins), same discipline as ExhaustionMark.
 */
export interface ModelTierWallMark {
  /** Epoch ms until which the flagship tier is walled for this account. */
  premium_walled_until: number;
  /** The binding bucket, for operator messaging. */
  premium_wall_bucket?: string;
  /** Epoch ms when the mark was written. */
  premium_wall_marked_at?: number;
}

/**
 * Is this account currently walled on the flagship tier? Live-truth first: a
 * fresh probe result that POSITIVELY shows the tier `7d_oi` bucket `allowed`
 * (a non-walled measurement newer than the mark) clears the wall; otherwise an
 * unexpired mark governs. `snapshotTierAllowed` is the caller's live signal
 * ("the newest canary probe measured the tier and it was NOT walled"); when
 * the caller has no fresh tier measurement it passes undefined and the mark
 * alone decides.
 */
export function isModelTierWalled(opts: {
  mark?: ModelTierWallMark;
  now: number;
  /** True when a fresh canary probe measured the tier as NOT walled (newer
   *  than the mark). Undefined = no fresh tier truth. */
  snapshotTierAllowed?: boolean;
}): boolean {
  const { mark, now, snapshotTierAllowed } = opts;
  if (snapshotTierAllowed === true) return false;
  if (mark !== undefined && mark.premium_walled_until > now) return true;
  return false;
}

/**
 * Default tier-wall window when a canary 429 carried no parseable reset. The
 * `7d_oi` bucket is a WEEKLY bucket, but we deliberately clamp an
 * unparseable-reset wall to a short window (the caller re-probes each fleet
 * tick and re-marks while the wall persists) so a one-off misread self-clears
 * fast rather than benching the flagship tier for days. Mirrors the
 * mark-exhausted 5h default discipline.
 */
export const MODEL_TIER_WALL_DEFAULT_MS = 5 * 60 * 60 * 1000;
