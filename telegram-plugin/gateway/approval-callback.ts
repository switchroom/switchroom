/**
 * Generic `apv:` callback handler (RFC B §6.1, §8).
 *
 * Owns the post-tap state-machine for every approval card, regardless of
 * which surface (secret/vault/MCP) opened the request:
 *
 *   1. Parse the callback_data via parseApprovalCallback.
 *   2. Round-trip to the broker: approval_consume.
 *      - If consumed=false (already-tapped, expired, unknown): show a
 *        toast and edit the card to its post-tap text.
 *   3. On `deny`: approval_record(granted=false).
 *      On `once`: approval_record(granted=true, ttl_ms=undefined) — the
 *        record exists for /approvals revoke targeting; it's harmless if
 *        the agent only ever calls approval_lookup once.
 *      On `always`: approval_record(granted=true, ttl_ms=null).
 *      On `ttl:1h|24h|7d`: approval_record(granted=true, ttl_ms=<n>).
 *   4. Edit the card text in-place to reflect the decision; remove the
 *      inline keyboard so the buttons can't be re-tapped.
 *
 * The agent that opened the request is responsible for short-polling
 * approval_lookup (RFC §10) to discover the outcome and proceed.
 */

import { type Context, InlineKeyboard } from "grammy";
import {
  parseApprovalCallback,
  ttlMsFromToken,
  type ApprovalChoice,
} from "./approval-card.js";
import {
  approvalConsume,
  approvalRecord,
} from "../../src/vault/approvals/client.js";
import type { ApprovalDecisionMode } from "../../src/vault/approvals/schema.js";
import { scopeToOpenInDriveButton } from "../../src/drive/deep-links.js";

/**
 * Resolve a tapped approval choice to its decision tuple — PURE, no
 * kernel I/O, so the `bad ttl token` branch (the only fallible path in
 * the old inline switch) is unit-testable without mocking grammy.
 *
 * Extracted (PR-5) from `handleApprovalCallback` so PR-4's invariant —
 * "compute + validate the decision BEFORE burning the single-use
 * nonce" — is now structural, not a comment: the handler calls this
 * first and only proceeds to `approvalConsume` on `ok: true`. A
 * malformed ttl token returns `{ ok: false }` and the nonce is never
 * touched (operator can re-tap a valid choice).
 */
export type ResolvedApprovalDecision =
  | {
      ok: true;
      decision: ApprovalDecisionMode;
      granted: boolean;
      ttl_ms: number | null;
      displayMode: string;
    }
  | { ok: false; error: string };

export function resolveApprovalDecision(
  choice: ApprovalChoice,
): ResolvedApprovalDecision {
  switch (choice.kind) {
    case "deny":
      return { ok: true, decision: "deny", granted: false, ttl_ms: null, displayMode: "denied" };
    case "once":
      // No expiry — recorded as a one-shot grant; the agent calls
      // approval_lookup at most once, then proceeds. /approvals revoke
      // can still target the row by id.
      return { ok: true, decision: "allow_once", granted: true, ttl_ms: null, displayMode: "granted once" };
    case "always":
      return { ok: true, decision: "allow_always", granted: true, ttl_ms: null, displayMode: "granted always" };
    case "ttl": {
      const ms = ttlMsFromToken(choice.param);
      if (ms === null) return { ok: false, error: "bad ttl token" };
      return { ok: true, decision: "allow_ttl", granted: true, ttl_ms: ms, displayMode: `granted for ${choice.param}` };
    }
  }
}

/**
 * Build the post-tap keyboard for a granted decision. Today this is
 * just the `[ 📖 Open in Drive ]` button when the granted scope names
 * a specific Drive doc or folder (RFC E §4.3 — granted-card
 * confirmations gain the deep-link). Returns `undefined` when no
 * post-tap keyboard applies, which the gateway translates into
 * `reply_markup: undefined` to strip the original action buttons.
 *
 * Pure / scope-driven — no kernel I/O — so it stays unit-testable
 * without mocking grammy's Context.
 */
export function buildGrantedKeyboard(scope: string): InlineKeyboard | undefined {
  const btn = scopeToOpenInDriveButton(scope);
  if (btn === null) return undefined;
  return new InlineKeyboard().url(btn.text, btn.url);
}

export async function handleApprovalCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  const parsed = parseApprovalCallback(data);
  if (parsed === null) {
    await ctx.answerCallbackQuery({ text: "malformed approval callback" });
    return;
  }

  // Resolve + validate the decision BEFORE burning the single-use
  // nonce (PR-4 invariant, now structural via the pure
  // resolveApprovalDecision — see its doc). A malformed ttl token
  // returns { ok: false } here and the nonce is never touched, so the
  // operator can re-tap a valid choice; pre-fix this validation ran
  // AFTER approvalConsume(), burning the nonce with no decision
  // recorded → the agent's approval_lookup poll never saw a verdict
  // and the turn wedged. There is now NO fallible step between the
  // consume→record below.
  const resolved = resolveApprovalDecision(parsed.choice);
  if (!resolved.ok) {
    await ctx.answerCallbackQuery({ text: resolved.error });
    return;
  }
  const { decision, granted, ttl_ms, displayMode } = resolved;

  const consumed = await approvalConsume(parsed.request_id);
  if (consumed === null) {
    await ctx.answerCallbackQuery({ text: "approval kernel unreachable" });
    return;
  }
  if (!consumed.consumed) {
    // Single-use enforcement: someone already tapped, or the nonce
    // expired/unknown. Match the RFC §8.1 wording.
    await ctx.answerCallbackQuery({ text: "this prompt expired" });
    return;
  }

  const granted_by_user_id = ctx.from?.id ?? 0;
  // Approver set at decision time = the chat that received the card. We
  // store the singleton for now; the gateway-side approver-set lookup
  // (drift detection input) will widen this in the per-callsite wire-up
  // when each surface migrates and starts passing access.allowFrom.
  const approver_set = [String(granted_by_user_id)];

  const decision_id = await approvalRecord({
    request_id: parsed.request_id,
    decision,
    approver_set,
    granted_by_user_id,
    ttl_ms,
  });

  if (decision_id === null) {
    await ctx.answerCallbackQuery({ text: "kernel record failed" });
    return;
  }

  // Edit the original card to its post-tap state. Drop the original
  // action keyboard either way; on a successful grant for a Drive
  // scope, surface `[ 📖 Open in Drive ]` so the user can jump
  // straight from "agent has access" to the doc (RFC E §4.3).
  const icon = granted ? "✅" : "🚫";
  const newBody =
    `${icon} ${displayMode}` +
    (granted
      ? ` · /approvals revoke <code>${decision_id}</code>`
      : "");

  const postTapKeyboard = granted && consumed.scope
    ? buildGrantedKeyboard(consumed.scope)
    : undefined;

  try {
    await ctx.editMessageText(newBody, {
      parse_mode: "HTML",
      reply_markup: postTapKeyboard,
    });
  } catch {
    // Best-effort: card may have been edited or deleted under us.
  }
  await ctx.answerCallbackQuery({ text: granted ? "Approved" : "Denied" });
}
