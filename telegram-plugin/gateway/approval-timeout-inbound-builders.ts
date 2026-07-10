/**
 * Pure builders for the synthetic inbounds the gateway injects when an
 * agent-initiated approval card TTL-expires with no operator tap — one per
 * family: `vault_request_access`, `vault_request_save`, `request_secret`,
 * `mental_model_propose`.
 *
 * Before this, the only way these families woke the parked agent was an
 * explicit tap. A card that expired unanswered left the agent (which ended its
 * turn to wait) parked forever. These builders mirror the tap-outcome builders
 * in `vault-grant-inbound-builders.ts`, but carry TIMEOUT wording:
 *
 *   "This is a TIMEOUT, not a denial — you may re-request or degrade
 *    gracefully."
 *
 * matching the permission-card timeout philosophy (#2411 / #2862) so the model
 * can tell an expiry from a real denial and NOT spam an identical re-request
 * into an absent operator.
 *
 * The `meta.source` string is load-bearing (the bridge keys on it) and each is
 * distinct from its tap-outcome sibling. Pinned by
 * `approval-timeout-inbound-builders.test.ts`.
 */

import type { InboundMessage } from './ipc-protocol.js'

interface TimeoutInboundBase {
  agent: string
  /** Chat the card lived in — keeps the resumed turn on the same conversation. */
  chatId: string
  /** Forum topic, if the request came from one — so the resumed reply routes back. */
  threadId?: number
  stageId: string
  /** TTL window in whole minutes, for the message copy. */
  timeoutMinutes: number
  nowMs?: number
}

function envelope(opts: {
  chatId: string
  threadId?: number
  ts: number
  text: string
  source: string
  agent: string
  stageId: string
  extraMeta?: Record<string, string>
}): InboundMessage {
  return {
    type: 'inbound',
    chatId: opts.chatId,
    ...(opts.threadId != null ? { threadId: opts.threadId } : {}),
    messageId: opts.ts,
    user: 'vault-broker',
    userId: 0,
    ts: opts.ts,
    text: opts.text,
    meta: {
      source: opts.source,
      agent: opts.agent,
      ...(opts.threadId != null ? { message_thread_id: String(opts.threadId) } : {}),
      stage_id: opts.stageId,
      ...(opts.extraMeta ?? {}),
    },
  }
}

/** `vault_request_access` card expired unanswered. */
export function buildVaultAccessTimeoutInbound(
  opts: TimeoutInboundBase & { key: string; scope: 'read' | 'write' },
): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return envelope({
    chatId: opts.chatId,
    threadId: opts.threadId,
    ts,
    source: 'vault_grant_timeout',
    agent: opts.agent,
    stageId: opts.stageId,
    extraMeta: { key: opts.key, scope: opts.scope },
    text:
      `⌛ Your vault access request for \`${opts.key}\` (scope=${opts.scope}) ` +
      `timed out after ${opts.timeoutMinutes} min — the operator did not tap. ` +
      `This is a TIMEOUT, not a denial. Pick a fallback for the original task ` +
      `(tell the user, try a different approach, or skip the feature), or ` +
      `re-request later if it still matters. Do NOT re-request in a loop.`,
  })
}

/** `vault_request_save` card expired unanswered. */
export function buildVaultSaveTimeoutInbound(
  opts: TimeoutInboundBase & { key: string },
): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return envelope({
    chatId: opts.chatId,
    threadId: opts.threadId,
    ts,
    source: 'vault_save_timeout',
    agent: opts.agent,
    stageId: opts.stageId,
    extraMeta: { key: opts.key },
    text:
      `⌛ Your vault_request_save for \`${opts.key}\` timed out after ` +
      `${opts.timeoutMinutes} min — the operator did not tap, so the secret was ` +
      `NOT stored and \`vault:${opts.key}\` will not resolve. This is a TIMEOUT, ` +
      `not a denial. Pick a fallback or re-request the save later. Do NOT loop.`,
  })
}

/** `request_secret` card expired unanswered. */
export function buildSecretRequestTimeoutInbound(
  opts: TimeoutInboundBase & { key: string },
): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return envelope({
    chatId: opts.chatId,
    threadId: opts.threadId,
    ts,
    source: 'secret_request_timeout',
    agent: opts.agent,
    stageId: opts.stageId,
    extraMeta: { key: opts.key },
    text:
      `⌛ Your request_secret for \`${opts.key}\` timed out after ` +
      `${opts.timeoutMinutes} min — the operator did not provide it. This is a ` +
      `TIMEOUT, not a denial. Proceed without it, ask the user how they want to ` +
      `handle the task, or re-request later. Do NOT re-request in a loop.`,
  })
}

/** `mental_model_propose` card expired unanswered. */
export function buildMentalModelProposeTimeoutInbound(
  opts: TimeoutInboundBase & { name: string },
): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  return envelope({
    chatId: opts.chatId,
    threadId: opts.threadId,
    ts,
    source: 'mental_model_propose_timeout',
    agent: opts.agent,
    stageId: opts.stageId,
    extraMeta: { name: opts.name },
    text:
      `⌛ Your mental_model_propose for \`${opts.name}\` timed out after ` +
      `${opts.timeoutMinutes} min — the operator did not tap, so nothing was ` +
      `declared. This is a TIMEOUT, not a denial. Re-propose later if it still ` +
      `stands. Do NOT re-propose in a loop.`,
  })
}
