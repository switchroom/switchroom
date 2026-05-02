/**
 * Pre-allocate-draft decision logic for inbound messages.
 *
 * Lives in its own module (separate from gateway.ts) so the contract
 * can be unit-tested without booting the gateway. The gateway-side
 * call site at `gateway.ts` (search for `decideShouldPreAlloc`) wraps
 * this with the actual `sendMessageDraft` call.
 *
 * Decision history:
 * - #416 — original pre-alloc, DM-only (was `isDmChatId(chat_id)`)
 * - #479 / PR #491 — drop the DM-only gate so groups also get the
 *   `🔵 thinking` placeholder. Forum topics still excluded because
 *   `sendMessageDraft` doesn't accept `message_thread_id` on the same
 *   path; that needs a separate non-draft fallback (tracked separately).
 *
 * The pre-alloc placeholder is the user's first signal that the agent
 * heard them — a draft message appears in the chat within ~1s, the
 * client renders an animated "typing" indicator, and the message text
 * (`🔵 thinking`) is meaningful rather than three dots.
 */

export interface PreAllocDecisionInput {
  /**
   * Whether `sendMessageDraft` is available on this gateway. Comes
   * from the boot probe at gateway.ts (set to non-null when the API
   * binding is present, null when grammy/Bot API doesn't expose it).
   */
  sendMessageDraftAvailable: boolean
  /**
   * The Telegram `message_thread_id` from the inbound message, or
   * null/undefined when the chat isn't a forum topic. Forum topics
   * are explicitly excluded from pre-alloc because `sendMessageDraft`
   * doesn't accept `message_thread_id`.
   */
  messageThreadId: number | string | null | undefined
  /**
   * Whether a pre-allocated draft already exists for this chat (i.e.
   * an earlier turn's pre-alloc hasn't been consumed yet). When true,
   * skip — we don't want to leak draft ids.
   */
  alreadyHasDraft: boolean
}

export type PreAllocDecision =
  | { allocate: true }
  | { allocate: false; reason: 'no-draft-api' | 'forum-topic' | 'already-allocated' }

/**
 * Decide whether to pre-allocate a draft for this inbound message.
 *
 * Returns `{ allocate: true }` when all three guards pass: the API is
 * available, the chat isn't a forum topic, and we don't already have
 * a draft outstanding. Returns `{ allocate: false, reason }` on the
 * three drop branches so callers + tests can introspect why a
 * particular drop happened.
 *
 * Notably, this returns `allocate: true` for both DMs and group chats
 * — that's the post-#479 behaviour. Pre-#479 the function would have
 * also returned false when `chat_id` was negative (group). After the
 * fix, group chats get the same placeholder UX as DMs.
 */
export function decideShouldPreAlloc(input: PreAllocDecisionInput): PreAllocDecision {
  if (!input.sendMessageDraftAvailable) {
    return { allocate: false, reason: 'no-draft-api' }
  }
  if (input.messageThreadId != null && input.messageThreadId !== '') {
    return { allocate: false, reason: 'forum-topic' }
  }
  if (input.alreadyHasDraft) {
    return { allocate: false, reason: 'already-allocated' }
  }
  return { allocate: true }
}

/**
 * The placeholder text the gateway writes to the pre-allocated draft.
 *
 * No trailing ellipsis: the draft transport already animates a
 * "typing" indicator on the user's Telegram client, so a `…` after
 * the word stacks redundant visual noise. Test fixture `tests/
 * placeholder-text.test.ts` pins this.
 */
export const PRE_ALLOC_PLACEHOLDER_TEXT = '🔵 thinking'
