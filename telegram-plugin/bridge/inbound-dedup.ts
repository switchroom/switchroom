/**
 * Bridge-side inbound messageId dedup (#2094 finding 4).
 *
 * `onInbound` forwards every IPC inbound to the claude session with no dedup.
 * A genuine user message that was delivered successfully but slow to ack can
 * be RE-SENT by the offline/stranded-message sweep — and claude then processes
 * it twice: a side-effectful slash command double-executes, a 👀 is painted
 * twice, etc. #2093's idle-gating shrank the window but did not close it.
 *
 * Durable fix: a per-chat set of already-forwarded messageIds. A repeat of a
 * messageId within the same turn is dropped. The set is cleared on
 * turn-complete (the bridge's turn-complete proxy is a successful
 * reply/stream_reply for that chat) so memory stays bounded, and it is capped
 * defensively so a chat that never replies can't grow the set without limit.
 *
 * SCOPE — only PLAIN user messages are deduped (see `shouldDedupInbound`).
 * Synthetic inbounds (meta.source: cron / resume / vault, messageId == a
 * timestamp), button callbacks, and structured events (checklist task changes,
 * reactions) are NEVER deduped: they either carry unique ids already or
 * legitimately repeat the same messageId for genuinely distinct events.
 */

/** Defensive cap on tracked ids per chat (FIFO-evicted). Bounds memory for a
 * chat that produces many messages without ever hitting a turn-complete. */
export const INBOUND_DEDUP_MAX_PER_CHAT = 512

export interface DedupInboundLike {
  messageId: number
  meta: Record<string, string>
}

/**
 * Only genuine, re-deliverable user messages are eligible for dedup. Excludes:
 *  - messageId <= 0 (no real Telegram id to key on),
 *  - meta.source set (synthetic: cron / resume / vault / secret_* — unique
 *    timestamp ids, and re-delivery is handled upstream),
 *  - meta.button_callback (a tap; repeats are the user's intent),
 *  - meta.kind (structured events like checklist_task_changed — the same
 *    checklist messageId legitimately repeats for distinct state changes),
 *  - meta.event (reaction-class inbounds).
 */
export function shouldDedupInbound(msg: DedupInboundLike): boolean {
  if (!Number.isFinite(msg.messageId) || msg.messageId <= 0) return false
  const m = msg.meta ?? {}
  if (m.source != null) return false
  if (m.button_callback != null) return false
  if (m.kind != null) return false
  if (m.event != null) return false
  return true
}

/**
 * Per-chat forwarded-messageId tracker. Keyed by chatKey (`chatId:threadId`).
 */
export class InboundDedup {
  private readonly byChat = new Map<string, Set<number>>()

  constructor(private readonly maxPerChat: number = INBOUND_DEDUP_MAX_PER_CHAT) {}

  /**
   * Record `messageId` as forwarded for `chatKey`. Returns 'fresh' the first
   * time a messageId is seen (caller forwards it) and 'duplicate' on a repeat
   * (caller drops it). FIFO-evicts the oldest id once the per-chat cap is hit.
   */
  checkAndRecord(chatKey: string, messageId: number): 'fresh' | 'duplicate' {
    let set = this.byChat.get(chatKey)
    if (set == null) {
      set = new Set<number>()
      this.byChat.set(chatKey, set)
    }
    if (set.has(messageId)) return 'duplicate'
    if (set.size >= this.maxPerChat) {
      // Set iteration order is insertion order — drop the oldest.
      const oldest = set.values().next().value
      if (oldest !== undefined) set.delete(oldest)
    }
    set.add(messageId)
    return 'fresh'
  }

  /** Clear every tracked id for a chat (all threads) — the turn-complete
   * reset. Thread-agnostic so a reply that omits message_thread_id still
   * clears the inbound's thread-scoped key. */
  clearChat(chatId: string): void {
    const prefix = `${chatId}:`
    for (const key of this.byChat.keys()) {
      if (key === chatId || key.startsWith(prefix)) this.byChat.delete(key)
    }
  }

  /** Test/introspection helper: number of tracked ids for a chatKey. */
  size(chatKey: string): number {
    return this.byChat.get(chatKey)?.size ?? 0
  }
}

/** Canonical chat-key derivation (mirrors gateway/chat-key.ts): a null/0
 * thread collapses to '_'. */
export function dedupChatKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId == null || threadId === 0 ? '_' : threadId}`
}
