// In-agent query of the auth-broker's single-source-of-truth overage signal.
//
// When the wedge-watchdog (autoaccept-poll sidecar) detects claude's
// `/rate-limit-options` weekly-quota menu, it must decide between the DEFAULT
// (Esc-park + trigger account failover, the behaviour for every account) and the
// opt-in carve-out (select "usage credits" → spend Anthropic overage credit).
//
// That money-spending decision is owned ENTIRELY by the broker — the single
// audited place — never by this sidecar. This module is the thin client: it asks
// the broker, over its per-agent UDS, whether the account this agent is bound to
// is currently overage-serving (`active_overage_serving` on `list-state`) and
// returns that boolean. The broker computes it from `allow_overage_accounts` +
// the live `overageStatus`/`overageDisabledReason` snapshot + any active 429
// mark; this code reads NO config and makes NO independent decision.
//
// Soft-fail → false. A broker that is unreachable, slow, predates the field, or
// errors yields `false` — i.e. fail SAFE to Esc-park, never spend on uncertainty.

import {
  withAuthBrokerClient,
  type AuthBrokerClientOpts,
} from "../auth/broker/client.js";

/**
 * Ask the broker whether the active account may currently be served on Anthropic
 * overage past the weekly wall. Returns false on ANY failure (fail-safe to
 * Esc-park). Never throws.
 */
export async function queryActiveOverageServing(
  opts?: AuthBrokerClientOpts,
): Promise<boolean> {
  try {
    return await withAuthBrokerClient(async (client) => {
      const state = await client.listState();
      return state.active_overage_serving === true;
    }, opts);
  } catch (err) {
    console.error(
      `[overage-decision] broker overage query failed: ${(err as Error).message} — defaulting to no-overage (Esc-park)`,
    );
    return false;
  }
}
