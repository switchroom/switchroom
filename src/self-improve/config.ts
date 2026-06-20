/**
 * Agent self-improvement — starting defaults (RFC §"Starting defaults",
 * tuned on the `clerk` agent first). Centralised + overridable via env
 * so they're easy to tune without a code edit, per the RFC's
 * "make it easy to tune" requirement. Slice 1 keeps the gate
 * deterministic (no small-model triage) — that's a later option.
 */

/** Parse a positive integer env override, falling back to `def`. */
function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export interface SelfImproveConfig {
  /**
   * Repetition threshold — the Nth occurrence of a signal trips the
   * gate. Default 2 ("correct once, never again": the SECOND time a
   * correction/fix recurs, we act).
   */
  repetitionThreshold: number;
  /**
   * T1 auto-apply diff cap — an edit larger than this (changed lines)
   * is NOT a T1; it downgrades to a T2 proposal.
   */
  t1MaxChangedLines: number;
  /** Max T1 auto-applies per agent per day. */
  maxAutoAppliesPerDay: number;
  /** Max outstanding (un-actioned) pending suggestions before we stop queueing. */
  maxOutstandingPending: number;
}

/**
 * Resolve the effective config. Env overrides let the operator tune on
 * `clerk` without a rebuild:
 *   SWITCHROOM_SELF_IMPROVE_THRESHOLD
 *   SWITCHROOM_SELF_IMPROVE_T1_MAX_LINES
 *   SWITCHROOM_SELF_IMPROVE_MAX_AUTO_PER_DAY
 *   SWITCHROOM_SELF_IMPROVE_MAX_PENDING
 */
export function resolveSelfImproveConfig(): SelfImproveConfig {
  return {
    repetitionThreshold: Math.max(
      2,
      intEnv("SWITCHROOM_SELF_IMPROVE_THRESHOLD", 2),
    ),
    t1MaxChangedLines: intEnv("SWITCHROOM_SELF_IMPROVE_T1_MAX_LINES", 30),
    maxAutoAppliesPerDay: intEnv("SWITCHROOM_SELF_IMPROVE_MAX_AUTO_PER_DAY", 3),
    maxOutstandingPending: intEnv("SWITCHROOM_SELF_IMPROVE_MAX_PENDING", 5),
  };
}

/** Whether self-improvement is enabled (opt-OUT, on by default per RFC). */
export function selfImproveEnabled(): boolean {
  return process.env.SWITCHROOM_SELF_IMPROVE !== "0";
}
