/**
 * Deterministic cron tier *selector* — the value-gate from the cheap-crons
 * JTBD (`reference/crons-use-the-model-only-when-it-earns-it.md`).
 *
 * The job: scheduled work should pay for a model only when the model adds
 * value. Today the cheap tiers are opt-in — an agent or operator must set
 * `model`/`context`/`kind` — so the *default* is the most expensive tier
 * (a full live-session turn) for every cron. That fails the Defaults
 * principle: the cheap, correct behaviour should be chosen for the user,
 * not configured by them.
 *
 * This module takes the tier decision away from the model and makes it a
 * pure function of observable signals, so the choice is deterministic and
 * fully enumerable (the operator's bar: be deterministically sure, prove
 * it by enumeration, never infer determinism from a sampling test). The
 * agent's explicit hint is an OVERRIDE, never the source of truth.
 *
 * Roll-out discipline (also from the JTBD): this is a RECOMMENDATION
 * surface first. The scheduler logs `recommended` vs what actually fires
 * (shadow mode) so the divergence and the token/hit-rate it implies can be
 * measured against the existing audit BEFORE the recommendation is allowed
 * to drive routing. Nothing here changes a fire's behaviour on its own.
 *
 * Signals, in priority order:
 *   1. Explicit hint (kind / context / known-cheap model) → respected, source=explicit.
 *   2. Cadence (the smallest gap the cron implies) → the deterministic default.
 *
 * Cadence is a deterministic proxy, not ground truth: a frequent cron is
 * far more likely to be a routine check that doesn't need the agent's full
 * context than a daily/weekly briefing is. It is the only signal we can read
 * from the entry WITHOUT a model (reading the prompt's meaning would itself
 * be a non-deterministic model call — exactly what this job exists to
 * avoid). The agent/operator overrides per-entry when the proxy is wrong;
 * shadow mode measures how often it is.
 */

import { isKnownCheapModel, type CronTier } from "./cron-routing.js";
import { estimateCronGapMin } from "./cron-cadence.js";

export type TierSource = "explicit" | "cadence-default";

export interface TierRecommendation {
  /** poll → Tier 0 (model-free); cheap → Tier 1 (cheap session); main → Tier 2 (live session). */
  tier: CronTier;
  /** Where the decision came from: an explicit hint, or the cadence default. */
  source: TierSource;
  /** Human-readable justification, surfaced in the recommender + shadow log. */
  reason: string;
}

export interface TierSelectorInput {
  /** The cron's smallest implied gap in minutes (from extractCronSmallestGapMin). */
  smallestGapMin: number;
  kind?: "poll" | "prompt";
  model?: string;
  context?: "fresh" | "agent";
}

/**
 * Default cadence threshold (minutes). A cron whose smallest gap is at or
 * below this defaults to a cheap session; above it, to the agent session.
 * One hour is the conservative line: sub-hourly crons are overwhelmingly
 * routine checks/sweeps (the token sink), while hourly-or-slower are more
 * often context-dependent briefings. Tunable via env so the shadow data
 * can move it before enforcement.
 */
export const DEFAULT_FREQUENT_GAP_MIN = 60;

export function resolveFrequentGapMin(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.SWITCHROOM_CRON_FREQUENT_GAP_MIN ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FREQUENT_GAP_MIN;
}

/**
 * Recommend a tier for a cron entry. Pure and deterministic: same input →
 * same output, always. Does NOT read env except via the injected
 * `frequentGapMin` (default resolved by the caller), so it stays a leaf.
 */
export function recommendCronTier(
  input: TierSelectorInput,
  frequentGapMin: number = DEFAULT_FREQUENT_GAP_MIN,
): TierRecommendation {
  // 1. Explicit hints win — the agent/operator asked for a specific tier.
  if (input.kind === "poll") {
    return { tier: "poll", source: "explicit", reason: "declared kind: poll (model-free check)" };
  }
  if (input.context === "fresh") {
    return { tier: "cheap", source: "explicit", reason: "declared context: fresh (cheap cron session)" };
  }
  if (input.context === "agent") {
    return { tier: "main", source: "explicit", reason: "declared context: agent (full live session)" };
  }
  if (input.model !== undefined) {
    return isKnownCheapModel(input.model)
      ? { tier: "cheap", source: "explicit", reason: `cheap model '${input.model}' → cheap cron session` }
      : { tier: "main", source: "explicit", reason: `model '${input.model}' is not a known-cheap id → full live session` };
  }

  // 2. No explicit hint — the cadence default. Deterministic from the cron.
  if (input.smallestGapMin <= frequentGapMin) {
    return {
      tier: "cheap",
      source: "cadence-default",
      reason:
        `fires every ~${input.smallestGapMin}min (≤ ${frequentGapMin}min) — defaulting to a cheap ` +
        `session; set context: agent (or an Opus/custom model) if this needs the agent's full context`,
    };
  }
  return {
    tier: "main",
    source: "cadence-default",
    reason:
      `fires every ~${input.smallestGapMin}min (> ${frequentGapMin}min) — defaulting to the agent's ` +
      `full session; set model: sonnet (or context: fresh) to run it cheaply`,
  };
}

/** The minimal shape `applyDefaultTier` reads + augments. */
export interface TierableEntry {
  cron: string;
  kind?: "poll" | "prompt";
  model?: string;
  context?: "fresh" | "agent";
}

/**
 * Fill in the cheap-by-default tier when the entry carries NO explicit hint.
 *
 * This is what makes cheap the *default* (the Defaults-principle fix): a
 * frequent, hint-less cron is augmented with `context: "fresh"` so the
 * router (`resolveCronRouting`) sends it to a cheap Tier-1 session instead
 * of the agent's full session. Explicit entries (kind/model/context set) are
 * returned untouched — the operator/agent's choice always wins. Infrequent
 * crons (and any cadence we can't read confidently → estimateCronGapMin
 * returns Infinity) keep the conservative full-session default, so we never
 * strip context from work that may need it.
 *
 * Pure: cadence comes from the cron string via estimateCronGapMin; no I/O.
 */
export function applyDefaultTier<T extends TierableEntry>(
  entry: T,
  frequentGapMin: number = DEFAULT_FREQUENT_GAP_MIN,
): T {
  // Any explicit hint → leave it exactly as authored.
  if (entry.kind === "poll" || entry.context !== undefined || entry.model !== undefined) {
    return entry;
  }
  const rec = recommendCronTier(
    { smallestGapMin: estimateCronGapMin(entry.cron) },
    frequentGapMin,
  );
  // Only the cheap recommendation changes anything; "main" is already the
  // router's default for a hint-less entry, so leave it untouched.
  return rec.tier === "cheap" ? { ...entry, context: "fresh" } : entry;
}
