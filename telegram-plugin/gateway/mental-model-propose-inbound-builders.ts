/**
 * Pure builders for the synthetic inbounds the gateway injects after the
 * operator taps Approve / Deny on a mental-model PROPOSAL card (hindsight
 * Phase 5, stacked on #2874). Mirrors `vault-grant-inbound-builders.ts`.
 *
 * Extracted from `gateway.ts` so the InboundMessage shape is pinned by tests
 * separately from the config-apply/IPC plumbing. The shape is load-bearing —
 * `meta.source` is what the bridge keys on to render
 * `<channel source="mental_model_proposal_applied">` /
 * `mental_model_proposal_denied` / `mental_model_proposal_failed` blocks, and
 * the `meta.{agent,name,stage_id,operator_id}` fields are the forensic anchor.
 *
 * A regression that drops a meta field or changes the source string would
 * silently break the agent's wake-up: the bridge wouldn't recognise the source
 * and would route as a generic channel event, the model wouldn't know its
 * proposal resolved, and the conversation would drift. Pinning these against
 * fixture tests is cheaper than catching that downstream.
 */

import type { InboundMessage } from "./ipc-protocol.js";

/** Subset of the pending proposal the builders need. Kept narrow so callers
 *  don't have to pass the full pending record. */
export interface MentalModelProposeInboundContext {
  agent: string;
  /** The proposed model's stable name (identity key). */
  name: string;
  /** Telegram chat id where the approval card lived. Used as the inbound's
   *  chatId so the synthesized turn stays associated with the originating
   *  conversation. */
  chat_id: string;
  /** Supergroup forum topic (message_thread_id) the agent was working in when
   *  it proposed — so the resumed turn's reply lands back in that topic, not
   *  General. Undefined for DM / non-topic proposals. */
  threadId?: number;
}

/**
 * Build the synthetic InboundMessage for a successful operator approval whose
 * config edit APPLIED — the proposed model is now a declared model and has
 * been (or will be, on reconcile) ensured in the bank.
 */
export function buildMentalModelProposeAppliedInbound(opts: {
  ctx: MentalModelProposeInboundContext;
  stageId: string;
  operatorId: string;
  nowMs?: number;
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now();
  return {
    type: "inbound",
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts, // synthetic — no Telegram message id exists
    user: "hindsight-curator",
    userId: 0,
    ts,
    text:
      `✅ Operator approved your mental-model proposal \`${opts.ctx.name}\`. ` +
      `It is now a DECLARED model in your \`memory.mental_models[]\` and is ` +
      `being ensured in your bank (idempotent). Resume whatever you were doing ` +
      `— the model will refresh from your bank content; no further action is ` +
      `needed to create it.`,
    meta: {
      source: "mental_model_proposal_applied",
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      name: opts.ctx.name,
      stage_id: opts.stageId,
      operator_id: opts.operatorId,
    },
  };
}

/**
 * Build the synthetic InboundMessage for an operator denial. The model was
 * NOT declared and NOTHING was written. Steers the agent to a fallback rather
 * than re-proposing.
 */
export function buildMentalModelProposeDeniedInbound(opts: {
  ctx: MentalModelProposeInboundContext;
  stageId: string;
  operatorId: string;
  nowMs?: number;
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now();
  return {
    type: "inbound",
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: "hindsight-curator",
    userId: 0,
    ts,
    text:
      `🚫 Operator denied your mental-model proposal \`${opts.ctx.name}\`. ` +
      `NOTHING was written — the model was not declared or created. Carry on ` +
      `with the original task without it. Do NOT re-propose the same model ` +
      `without first asking the user.`,
    meta: {
      source: "mental_model_proposal_denied",
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      name: opts.ctx.name,
      stage_id: opts.stageId,
      operator_id: opts.operatorId,
    },
  };
}

/**
 * Build the synthetic InboundMessage for an approval whose config edit FAILED
 * (hostd apply/reconcile error, config-edit disabled, a dupe that raced in,
 * etc.). The operator tapped Approve but the model did NOT land — be honest so
 * the agent doesn't assume it exists.
 */
export function buildMentalModelProposeFailedInbound(opts: {
  ctx: MentalModelProposeInboundContext;
  stageId: string;
  operatorId: string;
  reason: string;
  nowMs?: number;
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now();
  return {
    type: "inbound",
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: "hindsight-curator",
    userId: 0,
    ts,
    text:
      `⚠️ The operator approved your mental-model proposal \`${opts.ctx.name}\` but ` +
      `persisting it FAILED (${opts.reason}). The model was NOT declared or ` +
      `created — do NOT assume it exists. Carry on with the original task; the ` +
      `operator can retry the declaration by hand if it still matters.`,
    meta: {
      source: "mental_model_proposal_failed",
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      name: opts.ctx.name,
      stage_id: opts.stageId,
      operator_id: opts.operatorId,
    },
  };
}
