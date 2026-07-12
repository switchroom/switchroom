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
 * defers in two cases:
 *
 *   1. EVERY account is exhausted (dispatching is definitely futile). When at
 *      least one account is healthy it does NOT defer on this rule: the fleet
 *      serves the agent a healthy account via failover.
 *   2. 429 throttle tier — the agent's EFFECTIVE account (its override, else
 *      the fleet active) carries a future `throttled_until`. A throttled
 *      account is NOT rolled off (that's the whole point of the tier), so the
 *      fire would 429 against the same account; soft-defer until the throttle
 *      clears. `retryAtMs` carries the clear time so the caller can align the
 *      retry with it instead of blind backoff.
 *
 * A single lag-window run may still be lost in the partial case; recurring
 * crons recover on their next occurrence, and the operator has no hard
 * deadlines (by design decision).
 *
 * PURE — no I/O, no clock except the injected `now`. Fail-open is the
 * caller's job (broker unreachable → dispatch).
 */

import type { ListStateData } from "../auth/broker/client.js";

export interface QuotaPreflightDecision {
  defer: boolean;
  reason: string;
  /** When set (throttle soft-defer), the unix ms at/after which a retry is
   *  expected to succeed — the throttled account's `throttled_until`. The
   *  caller aligns the retry timer with it (bounded) instead of the default
   *  backoff ladder. */
  retryAtMs?: number;
}

export function decideQuotaPreflight(
  state: ListStateData,
  opts: { agent?: string; now?: number } = {},
): QuotaPreflightDecision {
  const now = opts.now ?? Date.now();
  const accounts = state.accounts ?? [];
  if (accounts.length === 0) {
    // No accounts to reason about — never block a fire on this.
    return { defer: false, reason: "no accounts in broker state" };
  }
  const healthy = accounts.filter((a) => !a.exhausted);
  if (healthy.length === 0) {
    return { defer: true, reason: `all ${accounts.length} account(s) exhausted` };
  }
  // 429 throttle tier — soft-defer while the agent's effective account is
  // transiently rate-limited. The throttle deliberately does NOT roll the
  // fleet, so "some other account is healthy" doesn't help: this agent's
  // next turn still runs on the throttled account.
  const effectiveLabel =
    (opts.agent !== undefined
      ? (state.agents ?? []).find((a) => a.name === opts.agent)?.account
      : undefined) ?? state.active;
  const effective = accounts.find((a) => a.label === effectiveLabel);
  if (
    effective !== undefined &&
    !effective.exhausted &&
    effective.throttled_until !== undefined &&
    effective.throttled_until > now
  ) {
    const inS = Math.ceil((effective.throttled_until - now) / 1000);
    return {
      defer: true,
      reason: `account '${effective.label}' rate-throttled (clears in ${inS}s)`,
      retryAtMs: effective.throttled_until,
    };
  }
  return {
    defer: false,
    reason: `${healthy.length}/${accounts.length} account(s) healthy`,
  };
}
