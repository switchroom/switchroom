/**
 * Forum-topic placeholder lifecycle (issue #479 forum-topic case).
 *
 * Background: the pre-alloc-draft path (`pre-alloc-decision.ts` + the
 * `sendMessageDraftFn` block in `gateway.ts`) gives DMs and non-forum
 * groups a `🔵 thinking` placeholder visible within ~1s of inbound.
 * Forum topics are excluded because Telegram's `sendMessageDraft` API
 * doesn't accept `message_thread_id` — the draft would land at the
 * topic-zero level, not in the actual topic the user is in.
 *
 * For forum topics we substitute a regular `sendMessage` with the
 * thread_id, tracked here so we can delete it on turn_end. The UX is:
 *
 *   t=0   user sends inbound
 *   t≈1s  `🔵 thinking` appears in the topic
 *   t≈Ns  agent's first stream_reply lands as a separate message —
 *         BOTH are briefly visible (no edit-in-place yet)
 *   t≈N+1s turn_end → placeholder is deleted, only the agent's reply
 *         remains
 *
 * The brief overlap (placeholder + reply visible simultaneously between
 * stream_reply arrival and turn_end) is the documented compromise vs.
 * the cleaner draft-based UX. Edit-in-place is a future enhancement
 * (would require teaching the stream_reply path to consume an existing
 * message instead of always sending a new one).
 *
 * State is module-local (one gateway process owns its placeholders).
 * Keyed on `chat:thread` so a single forum chat with multiple active
 * topics tracks each independently.
 */

/**
 * Minimal Bot-API surface needed for the placeholder lifecycle. Tests
 * inject a mock; production uses grammy's `bot.api`.
 */
export interface ForumTopicPlaceholderApi {
  sendMessage: (
    chatId: number | string,
    text: string,
    opts?: { message_thread_id?: number | string },
  ) => Promise<{ message_id: number }>
  deleteMessage: (chatId: number | string, messageId: number) => Promise<unknown>
}

interface PlaceholderEntry {
  messageId: number
  allocatedAt: number
}

const placeholders = new Map<string, PlaceholderEntry>()

/**
 * Map key for a forum-topic placeholder.
 *
 * `chat_id` alone is not enough because one forum chat can have
 * multiple active topics — each gets its own placeholder. Joining
 * with a separator that can't appear in either id keeps the namespace
 * collision-free for any plausible Telegram id.
 */
export function forumTopicPlaceholderKey(
  chatId: number | string,
  threadId: number | string,
): string {
  return `${String(chatId)}::${String(threadId)}`
}

/**
 * Send a placeholder message into a forum topic and track it for
 * later cleanup. Returns the new message_id, or null if the API call
 * failed (placeholder is best-effort — never blocks the turn).
 *
 * If a placeholder for this (chat, thread) already exists, the
 * existing one is left in place and `null` is returned. Idempotent
 * within a turn; the caller's "should we send?" gate (e.g. a fresh
 * inbound message gate) is the dedupe authority.
 */
export async function sendForumTopicPlaceholder(
  api: ForumTopicPlaceholderApi,
  chatId: number | string,
  threadId: number | string,
  opts: { now?: () => number; placeholderText?: string } = {},
): Promise<number | null> {
  const key = forumTopicPlaceholderKey(chatId, threadId)
  if (placeholders.has(key)) return null

  const now = opts.now ?? Date.now
  const text = opts.placeholderText ?? '🔵 thinking'
  try {
    const sent = await api.sendMessage(chatId, text, { message_thread_id: threadId })
    placeholders.set(key, { messageId: sent.message_id, allocatedAt: now() })
    return sent.message_id
  } catch {
    // Best-effort. Caller doesn't need to know — the placeholder UX
    // degrades gracefully: the user just doesn't get a placeholder,
    // same as today's pre-fix forum-topic behaviour.
    return null
  }
}

/**
 * Delete the placeholder for (chat, thread) if one exists. No-op if
 * none was tracked. Always clears the map entry (whether or not the
 * delete succeeds) so a flaky network can't leave stale state.
 */
export async function clearForumTopicPlaceholder(
  api: ForumTopicPlaceholderApi,
  chatId: number | string,
  threadId: number | string,
): Promise<void> {
  const key = forumTopicPlaceholderKey(chatId, threadId)
  const entry = placeholders.get(key)
  if (entry == null) return
  placeholders.delete(key)
  try {
    await api.deleteMessage(chatId, entry.messageId)
  } catch {
    // Best-effort. The user might see a leftover placeholder if the
    // delete fails — annoying but not actionable from this layer.
  }
}

/**
 * Test/inspection helper: snapshot of currently-tracked placeholders.
 * Returns a fresh object so callers can't mutate internal state.
 */
export function getForumTopicPlaceholderState(): ReadonlyMap<string, PlaceholderEntry> {
  return new Map(placeholders)
}

/**
 * Test helper: clear all tracked state. Production code never calls
 * this — placeholders are cleaned up via `clearForumTopicPlaceholder`
 * on turn_end. Exposed for unit tests that want a clean slate
 * between cases.
 */
export function _resetForumTopicPlaceholdersForTest(): void {
  placeholders.clear()
}
