/**
 * Agent self-improvement — the TIER router (RFC §"Solution Space",
 * graduated autonomy). Classifies a candidate change by blast radius:
 *
 *   T1 — small, reversible edit to a skill the agent ALREADY owns
 *        (single file, ≤ diff cap). Auto-applied (after the eval gate),
 *        silently and reversibly, via the native skill-write path.
 *   T2 — medium / shared-skill change. PROPOSE (one-tap), never
 *        auto-apply in slice 1.
 *   T3 — new cron, new skill, cross-agent, or irreversible. ASK
 *        explicitly. Also queued as a pending suggestion in slice 1.
 *   T0 — nothing actionable.
 *
 * The router is the on-leash guarantee in code: ANY of {new cron, new
 * skill, cross-agent, irreversible} forces T3 — no path lets those
 * auto-apply. This mirrors the `no-self-escalation` / `on-leash`
 * invariants the job spec names as its kill-clause.
 */

import type { ChangeCandidate, Tier } from "./types.js";
import { resolveSelfImproveConfig, type SelfImproveConfig } from "./config.js";

export interface TierDecision {
  tier: Tier;
  /** Human-readable rationale (operator-facing + audit). */
  reason: string;
}

/**
 * Classify a candidate change. Pure function of the candidate + config.
 *
 * Decision order is deliberate — the most-restrictive gate wins:
 *   1. Irreversible / cross-agent / new-cron / new-skill → T3 (hard).
 *   2. No skill target, or a skill the agent does NOT own → T2 (propose).
 *   3. Multi-file or over the diff cap → T2 (too big to auto-apply).
 *   4. Otherwise → T1 (small, reversible, owned, single-file).
 */
export function classifyTier(
  candidate: ChangeCandidate,
  cfg: SelfImproveConfig = resolveSelfImproveConfig(),
): TierDecision {
  // (0) Nothing to do.
  if (!candidate.proposedChange || candidate.proposedChange.trim() === "") {
    return { tier: "T0", reason: "no actionable change proposed" };
  }

  // (1) Hard T3 — the on-leash floor. Never auto-applied.
  if (candidate.irreversible) {
    return { tier: "T3", reason: "irreversible change — operator must decide" };
  }
  if (candidate.crossAgent) {
    return {
      tier: "T3",
      reason: "cross-agent change — operator must decide (no self-escalation)",
    };
  }
  if (candidate.touchesCron) {
    return {
      tier: "T3",
      reason: "creates/edits a cron — never self-served (on-leash)",
    };
  }
  if (candidate.createsNewSkill) {
    return {
      tier: "T3",
      reason: "creates a new skill — proposed, never auto-created",
    };
  }

  // (2) No owned-skill target → can't be a silent own-skill edit.
  if (!candidate.skillSlug || candidate.ownsSkill !== true) {
    return {
      tier: "T2",
      reason: candidate.skillSlug
        ? `targets skill "${candidate.skillSlug}" the agent does not own — propose, don't auto-apply`
        : "no own-skill target — surface as a one-tap suggestion",
    };
  }

  // (3) Too big to auto-apply silently.
  if (candidate.multiFile === true) {
    return {
      tier: "T2",
      reason: "touches more than one skill file — over the T1 single-file bound",
    };
  }
  const lines = candidate.changedLines ?? 0;
  if (lines > cfg.t1MaxChangedLines) {
    return {
      tier: "T2",
      reason: `${lines} changed lines exceeds the T1 cap of ${cfg.t1MaxChangedLines}`,
    };
  }

  // (4) Small, reversible, owned, single-file → T1.
  return {
    tier: "T1",
    reason: `small (${lines} line${lines === 1 ? "" : "s"}) reversible edit to owned skill "${candidate.skillSlug}"`,
  };
}
