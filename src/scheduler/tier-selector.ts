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
  kind?: "poll" | "prompt" | "action";
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
 * Whether the cadence-default AUTO-ROUTER is enabled (#2307 Tier-1).
 *
 * Re-enabling cadence-driven Tier-1 routing is only safe now that the cron
 * session is capability-complete (full MCP + shared memory + a non-wedging
 * boot — PRs 1–3). But it is a high-blast-radius flip (it routes every
 * frequent hint-less cron into the cheap session on the next `apply`), so it
 * ships DEFAULT-OFF behind this flag and is proven on a test-harness canary
 * before the default is reconsidered. OFF ⟹ `applyDefaultTier` is the #2305
 * pass-through (today's behaviour). Only `1`/`true`/`on` enables it.
 *
 * NOTE: graceful fallback (the cron fire falls back to the main session when no
 * cron bridge is registered) means a transient scaffold-vs-runtime flag
 * mismatch is non-fatal — the fire still lands, just not cheaply, and the
 * cron_fell_back_to_main metric records it.
 */
export function resolveCronAutoTier(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SWITCHROOM_CRON_AUTO_TIER ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
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
  if (input.kind === "action") {
    return { tier: "action", source: "explicit", reason: "declared kind: action (model-free verb)" };
  }
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
  kind?: "poll" | "prompt" | "action";
  model?: string;
  context?: "fresh" | "agent";
}

/**
 * Apply the cron tier default to a hint-less entry.
 *
 * History: #2305 turned this into a pass-through because the Tier-1 cron
 * session was tool/memory-STARVED (telegram bridge + built-ins only) — forcing
 * a frequent cron into it on cadence alone would run it starved, and the
 * earlier "you don't have memory" prompt made it punt. That hazard is now
 * GONE: #2307 PRs 1–3 made the cron session capability-complete (full MCP set,
 * shared hindsight memory bank, tool-search-deferred, a non-wedging boot, and
 * observability for a down session). So cadence is once again a sound
 * automatic signal — a frequent hint-less cron is overwhelmingly a routine
 * check that doesn't need the live session's accumulated context.
 *
 * Re-enabled behaviour (when `autoTierEnabled`): a hint-less entry whose
 * cadence is frequent (≤ `frequentGapMin`, default 60min) gets `context:
 * "fresh"` injected → it routes to the cheap Tier-1 session. Daily/weekly and
 * any cron whose cadence we can't read (`estimateCronGapMin → Infinity`) stay
 * on the main session. EXPLICIT hints (kind / context / model) are always
 * honoured untouched — the author's signal wins.
 *
 * High blast radius (it flips routing for every frequent cron on the next
 * `apply`), so it is DEFAULT-OFF behind `SWITCHROOM_CRON_AUTO_TIER`
 * (`resolveCronAutoTier`) until a test-harness canary proves the cron session
 * runs without falling back. OFF ⟹ the #2305 pass-through (today's behaviour),
 * so this function is inert for the fleet until the flag is set. Pure: env is
 * read only via the injected `autoTierEnabled` default.
 */
export function applyDefaultTier<T extends TierableEntry>(
  entry: T,
  frequentGapMin: number = DEFAULT_FREQUENT_GAP_MIN,
  autoTierEnabled: boolean = resolveCronAutoTier(),
): T {
  // Default-off kill-switch: pass-through preserves today's behaviour exactly.
  if (!autoTierEnabled) return entry;
  // Explicit author hints win — never override kind/context/model.
  if (entry.kind !== undefined || entry.context !== undefined || entry.model !== undefined) {
    return entry;
  }
  // Cadence default. Frequent ⟹ cheap (inject context:fresh); infrequent or
  // unreadable cadence (Infinity) ⟹ leave on the main session.
  const rec = recommendCronTier({ smallestGapMin: estimateCronGapMin(entry.cron) }, frequentGapMin);
  return rec.tier === "cheap" ? { ...entry, context: "fresh" as const } : entry;
}
