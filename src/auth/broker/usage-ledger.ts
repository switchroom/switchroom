/**
 * Per-account, per-model-tier usage ledger (pure decision + data layer).
 *
 * THE ASK (Ken, 2026-07-12): "Let's make sure switchroom tracks model usage
 * per account for premium models like fable." The broker already probes every
 * account each fleet tick and reads Anthropic's unified rate-limit headers —
 * the standard-tier `5h`/`7d` windows off a 1-token haiku probe, and (since
 * #3176/#3179) the premium-tier `7d_oi` (`seven_day_overage_included`) bucket
 * off a 1-token flagship canary. Until now the broker kept only the LATEST
 * snapshot per account (`last-quota.json` / `last-tier-quota.json`), throwing
 * away everything else. This module turns those already-received headers into a
 * durable, rolling per-(account, tier) usage ledger — WITHOUT issuing a single
 * extra request (the samples are harvested at the existing probe/canary capture
 * points; the #3176 canary is unchanged).
 *
 * WHY BROKER-SIDE / IN-REPO: the broker is in-repo, unit-tested and shipped via
 * normal releases; the staged LiteLLM pacing callback (`custom_pacing.py`) is
 * host-managed proxy config, out of this repo and off CI. Harvesting from the
 * headers the broker ALREADY receives is the in-repo, zero-added-cost path and
 * gives continuous per-tier utilization/reset — the exact "how much Fable is
 * left" signal the operator asked for.
 *
 * TOKENS: the unified rate-limit headers carry utilization %, reset times and
 * an allowed/rejected status — NOT token counts. This ledger records those
 * (Anthropic's own accounting) plus an observation count; true per-request
 * token accounting would need the proxy callback (real traffic, out of repo)
 * and is deliberately out of scope here rather than fabricated.
 *
 * PURE: no I/O, no clock except the injected `now`. The server owns
 * persistence (`usage-ledger.json`) and calls into this module at its existing
 * `cacheQuotaSnapshot` (standard) and `recordTierProbe` (premium) capture
 * points. Fully unit-tested.
 */

import type { QuotaResult } from "../quota.js";
import { MODEL_TIER_WALL_PCT } from "./model-tier-quota.js";

/** The two tiers we ledger. `standard` = the 5h/7d windows a haiku probe sees;
 *  `premium` = the flagship `7d_oi` bucket a flagship canary sees (#3176). */
export type UsageTier = "standard" | "premium";

/** Standard-tier hard wall — matches `consumer-quota-sensor` EXHAUSTION_PCT and
 *  `account-eligibility` WALL_PCT so "walled" means the same across the codebase. */
export const STANDARD_WALL_PCT = 99.5;

/**
 * Rolling-ring cap per (account, tier). At the ~10-min fleet-probe cadence
 * (`DEFAULT_CONSUMER_PROBE_INTERVAL_MS`) 288 samples ≈ 48h of history — enough
 * to show a trend without the ledger growing unbounded. Overridable so the
 * server can size it from env; a bad value falls back to the default.
 */
export const USAGE_RING_CAP_DEFAULT = 288;

/** Resolve the ring cap from an env value, else the default. Exported for the
 *  server + tests; a non-finite / non-positive value is ignored. */
export function resolveUsageRingCap(raw: string | undefined): number {
  if (raw == null || raw.trim().length === 0) return USAGE_RING_CAP_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : USAGE_RING_CAP_DEFAULT;
}

/**
 * One observed usage sample for a (account, tier), harvested from a probe/canary
 * response's rate-limit headers. `utilizationPct` is the tier's BINDING window
 * utilization (0-100); `resetAt` is when that window rolls; `status` is the
 * allowed/rejected verdict when the headers carried one (premium tier), else
 * null; `walled` is whether this sample was at/above the tier wall.
 */
export interface UsageSample {
  /** Capture time, unix ms. */
  at: number;
  /** Binding-window utilization (0-100), or null when the header was absent. */
  utilizationPct: number | null;
  /** Unix ms when the binding window resets, or null. */
  resetAt: number | null;
  /** allowed/rejected verdict (premium tier), or null (standard probe). */
  status: string | null;
  /** True when this sample was at/above the tier's wall. */
  walled: boolean;
}

/** Rolling ledger for one (account, tier). */
export interface UsageTierLedger {
  tier: UsageTier;
  /** Bounded rolling ring, OLDEST first / NEWEST last. Length ≤ ring cap. */
  samples: UsageSample[];
  /** Monotonic count of samples EVER recorded — survives ring trimming, so it
   *  is an honest observation count even after old samples age out. */
  observations: number;
  /** Unix ms of the first sample ever recorded. */
  firstObservedAt: number;
  /** Unix ms of the most recent sample. */
  lastObservedAt: number;
}

export interface UsageAccountLedger {
  standard?: UsageTierLedger;
  premium?: UsageTierLedger;
}

/** The whole ledger, keyed by account label. Persisted to `usage-ledger.json`. */
export interface UsageLedger {
  [account: string]: UsageAccountLedger;
}

/**
 * Build the STANDARD-tier sample from a haiku-probe result, or null when the
 * probe carried no usable window (a "thin" probe — both windows absent). The
 * binding window is the HIGHER-utilized of the present windows (that is the one
 * that walls the account); its reset is the sample reset. PURE.
 */
export function standardSampleFromResult(
  result: QuotaResult,
  now: number,
): UsageSample | null {
  if (!result.ok) return null;
  const d = result.data;
  // Default-present semantics: the flags are only `false` when #2494 explicitly
  // marked a window absent; unset (legacy/cached) reads as present.
  const fivePresent = d.fiveHourUtilPresent !== false;
  const sevenPresent = d.sevenDayUtilPresent !== false;
  if (!fivePresent && !sevenPresent) return null; // thin probe → no signal
  type Win = { util: number; reset: number | null };
  const wins: Win[] = [];
  if (fivePresent) {
    wins.push({
      util: d.fiveHourUtilizationPct,
      reset: d.fiveHourResetAt?.getTime() ?? null,
    });
  }
  if (sevenPresent) {
    wins.push({
      util: d.sevenDayUtilizationPct,
      reset: d.sevenDayResetAt?.getTime() ?? null,
    });
  }
  // Binding = highest utilization; that window's reset is what governs.
  const binding = wins.reduce((a, b) => (b.util > a.util ? b : a));
  return {
    at: now,
    utilizationPct: binding.util,
    resetAt: binding.reset,
    status: d.unifiedStatus ?? null,
    walled: binding.util >= STANDARD_WALL_PCT,
  };
}

/**
 * Build the PREMIUM-tier (`7d_oi`) sample from a flagship-canary result, or null
 * when the result carried NO tier signal (a non-flagship probe, or a rotted
 * canary id that 4xx'd without `7d_oi` headers — "no tier observed", never a
 * fabricated 0%). Mirrors #3176's classifier: a tier signal exists when any of
 * `unifiedStatus` / `sevenDayOiStatus` / `sevenDayOiUtilizationPct` is present.
 * `walled` reuses the #3176 wall definition (rejected status, or util ≥ wall).
 * PURE.
 */
export function premiumSampleFromResult(
  result: QuotaResult,
  now: number,
): UsageSample | null {
  if (!result.ok) return null;
  const d = result.data;
  const hasSignal =
    d.unifiedStatus != null ||
    d.sevenDayOiStatus != null ||
    d.sevenDayOiUtilizationPct != null;
  if (!hasSignal) return null; // no tier signal → not a premium observation
  const util = d.sevenDayOiUtilizationPct ?? null;
  // Prefer the per-bucket status; fall back to the overall unified verdict.
  const status = d.sevenDayOiStatus ?? d.unifiedStatus ?? null;
  const walled =
    d.sevenDayOiStatus === "rejected" ||
    (util != null && util >= MODEL_TIER_WALL_PCT);
  return {
    at: now,
    utilizationPct: util,
    resetAt: d.sevenDayOiResetAt?.getTime() ?? null,
    status,
    walled,
  };
}

/**
 * Append a sample to `ledger[account][tier]`, trimming the ring to `ringCap`.
 * MUTATES and returns `ledger` (the server holds a single live ref; tests pass
 * a fresh object). A null `sample` is a no-op — a failed/thin/no-signal probe
 * never pollutes the ledger (same discipline as the exhaustion classifiers).
 */
export function recordUsageSample(
  ledger: UsageLedger,
  account: string,
  tier: UsageTier,
  sample: UsageSample | null,
  ringCap: number = USAGE_RING_CAP_DEFAULT,
): UsageLedger {
  if (sample == null) return ledger;
  const cap = ringCap >= 1 ? Math.floor(ringCap) : USAGE_RING_CAP_DEFAULT;
  const acct = (ledger[account] ??= {});
  let tl = acct[tier];
  if (tl == null) {
    tl = {
      tier,
      samples: [],
      observations: 0,
      firstObservedAt: sample.at,
      lastObservedAt: sample.at,
    };
    acct[tier] = tl;
  }
  tl.samples.push(sample);
  // Trim oldest-first to the cap.
  if (tl.samples.length > cap) {
    tl.samples.splice(0, tl.samples.length - cap);
  }
  tl.observations += 1;
  tl.lastObservedAt = sample.at;
  // firstObservedAt is monotone (never moves once set).
  if (sample.at < tl.firstObservedAt) tl.firstObservedAt = sample.at;
  return ledger;
}

/** A rendering-friendly rollup of one tier's ledger, refill-normalized. */
export interface UsageTierSummary {
  tier: UsageTier;
  /** Monotonic count of samples ever recorded. */
  observations: number;
  /** Number of samples currently retained in the ring. */
  retained: number;
  /** Latest utilization %, refill-normalized (reset passed → 0). Null when the
   *  latest sample carried no utilization header. */
  currentUtilizationPct: number | null;
  /** Remaining headroom (100 - util), refill-normalized. Null when unknown. */
  headroomPct: number | null;
  /** Latest binding-window reset, unix ms, or null. */
  resetAt: number | null;
  /** Latest allowed/rejected status, or null. */
  status: string | null;
  /** True when the latest sample was at/above the tier wall AND not refilled. */
  walled: boolean;
  /** True when the latest sample's reset has passed (window rolled since). */
  refilled: boolean;
  /** Unix ms of the most recent sample, or null when empty. */
  lastObservedAt: number | null;
  /** Peak utilization across the retained ring (trend), refill-agnostic. Null
   *  when no sample carried a utilization header. */
  peakUtilizationPct: number | null;
}

export interface UsageAccountSummary {
  account: string;
  standard: UsageTierSummary | null;
  premium: UsageTierSummary | null;
}

function summarizeTier(
  tl: UsageTierLedger | undefined,
  now: number,
): UsageTierSummary | null {
  if (tl == null || tl.samples.length === 0) return null;
  const latest = tl.samples[tl.samples.length - 1];
  // Refill-normalize: a latest sample whose reset has already passed means the
  // window rolled since capture — treat it as refilled (0% used / full headroom)
  // with zero extra probes, same discipline as `refillNormalizedUtils`.
  const refilled = latest.resetAt != null && latest.resetAt <= now;
  const rawUtil = latest.utilizationPct;
  const currentUtilizationPct =
    rawUtil == null ? null : refilled ? 0 : rawUtil;
  const headroomPct =
    currentUtilizationPct == null ? null : Math.max(0, 100 - currentUtilizationPct);
  const utilSamples = tl.samples
    .map((s) => s.utilizationPct)
    .filter((u): u is number => u != null);
  const peakUtilizationPct =
    utilSamples.length > 0 ? Math.max(...utilSamples) : null;
  return {
    tier: tl.tier,
    observations: tl.observations,
    retained: tl.samples.length,
    currentUtilizationPct,
    headroomPct,
    resetAt: latest.resetAt,
    status: latest.status,
    walled: latest.walled && !refilled,
    refilled,
    lastObservedAt: tl.lastObservedAt,
    peakUtilizationPct,
  };
}

/** Summarize one account's usage across both tiers, refill-normalized. PURE. */
export function summarizeAccountUsage(
  ledger: UsageLedger,
  account: string,
  now: number,
): UsageAccountSummary {
  const acct = ledger[account];
  return {
    account,
    standard: summarizeTier(acct?.standard, now),
    premium: summarizeTier(acct?.premium, now),
  };
}

/**
 * Premium (flagship / Fable) headroom % for `account` right now, refill-aware.
 * Null when the ledger has no premium observation for the account (never
 * probed the flagship tier, or only "no signal" results). Convenience over
 * {@link summarizeAccountUsage}. PURE.
 */
export function premiumHeadroomPct(
  ledger: UsageLedger,
  account: string,
  now: number,
): number | null {
  return summarizeAccountUsage(ledger, account, now).premium?.headroomPct ?? null;
}

/**
 * Among `candidates` (already-eligible accounts, in caller preference order),
 * pick the one with the MOST premium headroom from the ledger. Returns null
 * when NO candidate has a known premium headroom — the caller then keeps its
 * existing order (this is a PREFERENCE among eligible accounts, never a new
 * gate; #3176's `premium_walled_until` marks remain the eligibility authority).
 *
 * Deterministic + order-stable: ties (equal headroom, incl. the empty-ledger
 * case where all are unknown) resolve to the earliest candidate in the input
 * order, so behavior is unchanged whenever the ledger carries no data. PURE.
 */
export function bestPremiumHeadroomAccount(
  ledger: UsageLedger,
  candidates: string[],
  now: number,
): string | null {
  let best: string | null = null;
  let bestHeadroom = -Infinity;
  for (const cand of candidates) {
    const h = premiumHeadroomPct(ledger, cand, now);
    if (h == null) continue;
    // Strictly-greater keeps the FIRST candidate on ties → order-stable.
    if (h > bestHeadroom) {
      bestHeadroom = h;
      best = cand;
    }
  }
  return best;
}
