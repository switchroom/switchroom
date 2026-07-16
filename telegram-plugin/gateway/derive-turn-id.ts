/**
 * derive-turn-id.ts — the stable per-turn identity, extracted from the gateway
 * monolith so BOTH the enqueue seam and out-of-gateway tests use the SAME
 * function (no mirror-drift between production and the round-trip test).
 *
 * Component 3 — derive the stable per-turn identity from the chat, thread, and
 * originating message id. Stamped into the inbound meta at build time
 * (`origin_turn_id`) AND reconstructed at enqueue time from the same three
 * values, so the id stamped on the message the model reads matches the id on
 * the turn the gateway started for it. Using the message id (not the
 * not-yet-known startedAt) is what lets the two sites agree. Returns null when
 * there is no message id (synthetic / cron turns with no originating inbound —
 * they never need origin routing, the live turn IS the origin).
 *
 * NOTE (#3268): a subagent-handback IS a synthetic inbound, but it MUST still
 * derive a stable non-null id so the dead-air pre-turn card can be adopted by
 * identity at enqueue. The handback inbound builder therefore rounds-trips its
 * fabricated `ts` through `meta.message_id` (mirroring resume-inbound-builder),
 * so `ev.messageId` is populated at enqueue and this function yields the SAME
 * `chatKey#ts` the pre-turn seam recorded at release.
 */

import { chatKey } from './chat-key.js'

export function deriveTurnId(
  chatId: string,
  threadId: number | null | undefined,
  messageId: string | number | null | undefined,
): string | null {
  if (messageId == null || messageId === '' || String(messageId) === '0') return null
  return `${chatKey(chatId, threadId ?? null)}#${messageId}`
}
