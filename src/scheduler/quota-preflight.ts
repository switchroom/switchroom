/**
 * Cron quota preflight (pure decision).
 *
 * A scheduled fire goes through the persistent claude session (cron can't run
 * as a separate `claude -p` — that's off-subscription programmatic use, banned
 * by the compliance pillar). If the fleet is fully quota-walled, dispatching is
 * futile: the turn 429s and the run is silently lost (the scheduler's audit is
 * delivery-based, so it even records "success"). Auto-fallback (v0.14.80) +
 * the consumer sensor (v0.14.81) keep exhaustion short and self-healing, so the
 * residual risk is the brief total-wall window.
 *
 * This decides whether to DEFER a fire rather than throw it at a wall. It
 * defers ONLY when EVERY account is exhausted (dispatching is definitely
 * futile). When at least one account is healthy it does NOT defer: the fleet
 * serves the agent a healthy account via failover, and we never hold a
 * dispatch on a maybe — holding risks nothing, but we keep the gate narrow and
 * reliable. A single lag-window run may still be lost in the partial case;
 * recurring crons recover on their next occurrence, and the operator has no
 * hard deadlines (by design decision).
 *
 * PURE — no I/O. Fail-open is the caller's job (broker unreachable → dispatch).
 */

import type { ListStateData } from "../auth/broker/client.js";

export interface QuotaPreflightDecision {
  defer: boolean;
  reason: string;
}

export function decideQuotaPreflight(state: ListStateData): QuotaPreflightDecision {
  const accounts = state.accounts ?? [];
  if (accounts.length === 0) {
    // No accounts to reason about — never block a fire on this.
    return { defer: false, reason: "no accounts in broker state" };
  }
  const healthy = accounts.filter((a) => !a.exhausted);
  if (healthy.length > 0) {
    return {
      defer: false,
      reason: `${healthy.length}/${accounts.length} account(s) healthy`,
    };
  }
  return { defer: true, reason: `all ${accounts.length} account(s) exhausted` };
}
