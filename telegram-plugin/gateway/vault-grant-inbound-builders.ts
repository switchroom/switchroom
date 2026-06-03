/**
 * Pure builders for the synthetic `vault_grant_approved` and
 * `vault_grant_denied` inbounds the gateway injects after the
 * operator taps Approve / Deny on a `vault_request_access` card
 * (#1052 / #1150).
 *
 * Extracted from `gateway.ts` so the InboundMessage shape is pinned
 * by tests separate from the broker/IPC plumbing. The shape is
 * load-bearing — it carries the `meta.source` field the bridge keys
 * on when rendering `<channel source="vault_grant_approved">` /
 * `<channel source="vault_grant_denied">` blocks for the model, and
 * the `meta.{agent,key,scope,stage_id,operator_id}` fields that
 * downstream filters / dashboards may anchor on.
 *
 * A regression that drops a meta field or changes the source string
 * would silently break the agent's wake-up flow — the bridge wouldn't
 * recognize the source and route as a generic channel event, the
 * model wouldn't know it was an approval response, and the
 * conversation would drift. Pinning the builders against fixture
 * tests is cheaper than catching that downstream.
 */

import type { InboundMessage } from './ipc-protocol.js'

/** Subset of the pending-request state the builders need. Kept narrow
 *  so callers don't have to pass the full PendingVaultRequestAccess. */
export interface VaultGrantInboundContext {
  agent: string
  key: string
  scope: 'read' | 'write'
  /** Telegram chat id where the approval card lived. Used as the
   *  inbound's chatId — keeps the synthesized turn associated with
   *  the conversation that triggered the request. */
  chat_id: string
  /** Seconds. For approved grants; ignored for deny. */
  ttl_seconds: number
  /** Supergroup forum topic (message_thread_id) the agent was working in
   *  when it requested the credential — so the resumed turn's reply lands
   *  back in that topic, not General. Undefined for DM / non-topic requests. */
  threadId?: number
}

/**
 * Build the synthetic InboundMessage for a successful operator
 * approval. Meta fields are pinned by tests.
 *
 * @param ctx              Per-request context (agent, key, scope, chat).
 * @param grantId          Broker-returned grant id (e.g. "vg_a1b2c3").
 * @param stageId          The card's stage id from the approval flow.
 * @param operatorId       Telegram user id of the approving operator
 *                         (string for portability — Telegram ids are
 *                         numeric but routinely round-trip as strings).
 * @param nowMs            Wall-clock ms. Used for both `ts` and
 *                         `messageId` so the helper is deterministic
 *                         under fake clock. Defaults to `Date.now()`.
 */
export function buildVaultGrantApprovedInbound(opts: {
  ctx: VaultGrantInboundContext
  grantId: string
  stageId: string
  operatorId: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  const days = Math.round(opts.ctx.ttl_seconds / 86400)
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts, // synthetic — no Telegram message id exists
    user: 'vault-broker',
    userId: 0,
    ts,
    text:
      `✅ Operator approved your vault access request for ` +
      `\`${opts.ctx.key}\` (scope=${opts.ctx.scope}, ` +
      `${days}d, grant=${opts.grantId}). ` +
      `The token has been written. Please resume the task that was ` +
      `waiting on this credential — fetch via the usual switchroom vault ` +
      `get path.`,
    meta: {
      source: 'vault_grant_approved',
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      key: opts.ctx.key,
      scope: opts.ctx.scope,
      grant_id: opts.grantId,
      stage_id: opts.stageId,
      operator_id: opts.operatorId,
    },
  }
}

/**
 * Build the synthetic InboundMessage for an operator denial.
 *
 * The text steers the model toward a fallback path (apologise, try a
 * different approach, skip the feature) — added in #1156 alongside
 * the buffer-on-disconnect fix because the deny side had the same
 * agent-stays-idle bug as the approve side.
 */
export function buildVaultGrantDeniedInbound(opts: {
  ctx: VaultGrantInboundContext
  stageId: string
  operatorId: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: 'vault-broker',
    userId: 0,
    ts,
    text:
      `🚫 Operator denied your vault access request for ` +
      `\`${opts.ctx.key}\` (scope=${opts.ctx.scope}). ` +
      `The credential is unavailable — pick a fallback for the original task ` +
      `(apologise to the user, try a different approach, or skip the feature). ` +
      `Do NOT re-request this key without first asking the user.`,
    meta: {
      source: 'vault_grant_denied',
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      key: opts.ctx.key,
      scope: opts.ctx.scope,
      stage_id: opts.stageId,
      operator_id: opts.operatorId,
    },
  }
}

/** Subset of PendingVaultRequestSave the save-outcome builders need.
 *  The `vault_request_save` flow has no scope/ttl (it stores a value,
 *  it doesn't mint a scoped grant). */
export interface VaultSaveInboundContext {
  agent: string
  key: string
  /** Telegram chat the save card lived in — keeps the synthesized
   *  resume-turn associated with the originating conversation. */
  chat_id: string
  /** Supergroup forum topic the agent was working in when it requested the
   *  save — so the resumed reply lands in that topic, not General. */
  threadId?: number
}

/**
 * Synthetic inbound for a successful operator Save tap on a
 * `vault_request_save` card. Symmetric with
 * `buildVaultGrantApprovedInbound`: the `vault_request_save` tool
 * returns "waiting for operator" and the agent ends its turn, so
 * without this inbound the secret is stored but the agent is never
 * told and never resumes (the exact silence bug this fixes — the
 * `vrs:` handler had no wake-up despite a comment claiming one).
 */
export function buildVaultSaveCompletedInbound(opts: {
  ctx: VaultSaveInboundContext
  stageId: string
  operatorId: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: 'vault-broker',
    userId: 0,
    ts,
    text:
      `✅ Operator saved your secret as \`vault:${opts.ctx.key}\`. ` +
      `Please resume the task that was waiting on it — reference the ` +
      `value via the usual \`vault:${opts.ctx.key}\` path.`,
    meta: {
      source: 'vault_save_completed',
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      key: opts.ctx.key,
      stage_id: opts.stageId,
      operator_id: opts.operatorId,
    },
  }
}

/**
 * Synthetic inbound for a Save tap whose vault write FAILED. Steers
 * the model away from assuming the secret exists.
 */
export function buildVaultSaveFailedInbound(opts: {
  ctx: VaultSaveInboundContext
  stageId: string
  operatorId: string
  reason: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: 'vault-broker',
    userId: 0,
    ts,
    text:
      `⚠️ The operator tapped Save but the vault write for ` +
      `\`vault:${opts.ctx.key}\` FAILED (${opts.reason}). The secret was ` +
      `NOT stored — do NOT assume \`vault:${opts.ctx.key}\` resolves. ` +
      `Either retry the save (the operator may need to fix the underlying ` +
      `issue first) or pick a fallback for the original task.`,
    meta: {
      source: 'vault_save_failed',
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      key: opts.ctx.key,
      stage_id: opts.stageId,
      operator_id: opts.operatorId,
    },
  }
}

/**
 * Synthetic inbound for an operator Discard tap. The secret was never
 * written; steer the model to a fallback rather than silent idle.
 */
export function buildVaultSaveDiscardedInbound(opts: {
  ctx: VaultSaveInboundContext
  stageId: string
  operatorId: string
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return {
    type: 'inbound',
    chatId: opts.ctx.chat_id,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts,
    user: 'vault-broker',
    userId: 0,
    ts,
    text:
      `🚫 Operator discarded your \`vault_request_save\` for ` +
      `\`${opts.ctx.key}\` — the secret was NOT stored and ` +
      `\`vault:${opts.ctx.key}\` will not resolve. Pick a fallback for ` +
      `the original task (ask the user, try another approach, or skip ` +
      `the feature). Do NOT re-request the save without asking the user.`,
    meta: {
      source: 'vault_save_discarded',
      agent: opts.ctx.agent,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      key: opts.ctx.key,
      stage_id: opts.stageId,
      operator_id: opts.operatorId,
    },
  }
}
