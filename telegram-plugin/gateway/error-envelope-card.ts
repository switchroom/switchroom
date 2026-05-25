/**
 * Render a one-tap unlock card for hostd error_envelopes that carry a
 * `flip_yaml_flag` fix (#1758 Phase 1).
 *
 * CRITICAL safety: the `yaml_path` MUST be on the
 * `UNLOCK_CARD_YAML_ALLOWLIST` exported from
 * `src/host-control/config-edit-validator.ts`. A malformed or hostile
 * envelope from any backend could otherwise nudge the operator into
 * one-tap-approving an arbitrary flag flip. Non-allowlisted paths fall
 * back to plain-text rendering (the caller surfaces `resp.error` as
 * today).
 *
 * Phase 1 scope: ONLY `flip_yaml_flag`. `request_vault_grant` is
 * explicitly deferred to a later phase (still plain-text rendered).
 */

import type { HostdResponse } from "../../src/host-control/protocol.js";
import { isAllowlistedYamlPath } from "../../src/host-control/config-edit-validator.js";
import {
  buildApprovalCard,
  type BuiltApprovalCard,
} from "./approval-card.js";

export type UnlockCardOutcome =
  | { kind: "card"; card: BuiltApprovalCard; yaml_path: string; to: unknown }
  | { kind: "plain-text" };

/**
 * Decide whether to render a one-tap unlock card for the given
 * response. Returns `{kind: "plain-text"}` whenever the envelope
 * lacks a `flip_yaml_flag` fix OR the path isn't on the allowlist.
 *
 * `approvalRequestId` is the 32-hex nonce minted by the approval
 * kernel; caller is responsible for binding the card to that nonce
 * and recording the apply-on-tap intent.
 */
export function renderErrorEnvelopeCard(
  resp: HostdResponse,
  agentName: string,
  approvalRequestId: string,
): UnlockCardOutcome {
  const env = resp.error_envelope;
  if (!env || !env.fix) return { kind: "plain-text" };
  if (env.fix.kind !== "flip_yaml_flag") {
    // request_vault_grant is Phase-2 work; everything else has no
    // unlock-card UX. Caller falls back to plain-text rendering.
    return { kind: "plain-text" };
  }
  const { yaml_path, to } = env.fix;
  if (!isAllowlistedYamlPath(yaml_path)) {
    // Defense-in-depth: never render a one-tap card for a path the
    // operator hasn't explicitly opted into.
    return { kind: "plain-text" };
  }
  const card = buildApprovalCard({
    request_id: approvalRequestId,
    agent: agentName,
    scope_humanized: `flip ${yaml_path} → ${JSON.stringify(to)}`,
    why: env.human + (env.why ? ` — ${env.why}` : ""),
    offer_always: false,
    offer_ttl: false,
  });
  return { kind: "card", card, yaml_path, to };
}
