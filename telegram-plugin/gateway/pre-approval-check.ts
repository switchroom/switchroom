// #2975 Stage 2 — read-only pre-approval predicate.
//
// hostd asks (over the approval-gateway socket, via `check_pre_approved`)
// whether an EXACT `(agent, diff)` pair is already operator-consented, so it
// can skip the `config_propose_edit` per-hour rate limit for that persist. This
// is the READ-ONLY sibling of the `tryAutoResolve` auto-resolve hook wired into
// `onRequestConfigApproval`: it runs the SAME forge-resistance gate — an EXACT
// byte-match of the incoming diff against a diff the gateway itself
// pre-registered when the operator tapped Approve — but it MUST NOT delete the
// correlation. The single-use delete stays on the real
// `request_config_approval` auto-resolve, so a peek can never consume the
// consent (and a rate-limit bypass can never spend a correlation that the
// actual persist then needs).
//
// Extracted as a pure function (stores + helpers injected) so the exact
// contract — true only for a registered byte-exact pair, and NEVER a mutation —
// is unit-testable without importing the whole gateway module.

/** Minimal read surface this predicate needs from a correlation store. It only
 *  ever calls `sweep` (evict-expired, which is not a semantic mutation of a
 *  live entry) and `get` (read). It deliberately has NO `delete`/`set` so a
 *  mis-edit that mutates the store won't typecheck here. */
export interface ReadonlyCorrelationStore {
  sweep(now: number): void;
  get(key: string): { unifiedDiff: string } | undefined;
}

export interface PreApprovalCheckDeps {
  /** "🔁 Always allow" correlations, keyed `${agentName}::${rule}`. */
  alwaysAllow: ReadonlyCorrelationStore;
  /** Mental-model-proposal correlations, keyed by mentalModelCorrelationKey. */
  mentalModel: ReadonlyCorrelationStore;
  /** Locate a CANDIDATE always-allow entry by the rule token the diff adds.
   *  Shape-based, NOT the security gate — the gate is the byte-match below. */
  extractAddedAllowRule: (unifiedDiff: string) => string | null;
  /** Compose the mental-model correlation key for `(agent, diff)`. */
  mentalModelCorrelationKey: (agentName: string, unifiedDiff: string) => string;
  /** Clock seam (defaults to Date.now()). */
  now?: () => number;
}

/**
 * Returns true iff `(agentName, unifiedDiff)` byte-matches a still-live
 * pre-registered correlation (always-allow OR mental-model). Read-only: it
 * never deletes a correlation. A forged diff — the consented token under a
 * different field, or ANY byte difference — finds no byte-exact entry and
 * returns false, so hostd falls back to the ordinary rate-limited path.
 */
export function isDiffPreApproved(
  agentName: string,
  unifiedDiff: string,
  deps: PreApprovalCheckDeps,
): boolean {
  const now = (deps.now ?? Date.now)();

  // "🔁 Always allow": locate a candidate by the added rule token, then require
  // an EXACT byte-match of the diff (the token match alone is NOT the gate).
  deps.alwaysAllow.sweep(now);
  const added = deps.extractAddedAllowRule(unifiedDiff);
  if (added) {
    const entry = deps.alwaysAllow.get(`${agentName}::${added}`);
    if (entry && entry.unifiedDiff === unifiedDiff) return true;
  }

  // Mental-model proposal the operator approved on the proposal card: byte-exact
  // match against the pre-registered diff (the security gate).
  deps.mentalModel.sweep(now);
  const mmEntry = deps.mentalModel.get(
    deps.mentalModelCorrelationKey(agentName, unifiedDiff),
  );
  if (mmEntry && mmEntry.unifiedDiff === unifiedDiff) return true;

  return false;
}
