/**
 * Canonical chat-key construction with branded type.
 *
 * The gateway tracks per-chat state (active turn, draft stream, status
 * reactions, progress throttle, etc.) in `Map<string, ...>` instances
 * keyed by a string derived from `(chatId, threadId | null)`. Multiple
 * callsites historically constructed those keys inline as
 * `` `${chatId}:${threadId ?? '_'}` ``. That worked until PR #1564 hit
 * the silence-poke wedge: an `activeTurnStartedAt` entry survived a
 * turn-end because the entry was set under one rendering of the key
 * (`null` thread → `_`) and the cleanup ran against another
 * (`undefined` thread → `_`, but also `0` thread → `0`, which doesn't
 * coalesce). The fallback's `purgeReactionTracking` cleared one
 * statusKey at a time; sibling keys for the same chat persisted, so
 * `activeTurnStartedAt.size > 0` stayed true forever and every
 * subsequent inbound was held mid-turn.
 *
 * This module makes the bug class hard to reintroduce:
 *
 *   1. `chatKey()` is the canonical constructor for "this chat+thread"
 *      keys. It collapses `null`, `undefined`, and `0` thread IDs
 *      into the same token (`_`). All sites in `gateway.ts`,
 *      `stream-reply-handler.ts`, and `pty-partial-handler.ts` route
 *      through it (or mirror its expression inline).
 *   2. The returned `ChatKey` is a branded string — a documentation
 *      marker for human readers. `telegram-plugin/` is bun-bundled
 *      and NOT in `tsconfig.json`'s `include`; `lint:plugin-references`
 *      filters tsc output to reference-class errors only (TS2304/2552/
 *      2722/2561). A future opt-in `Map<ChatKey, T>` migration could
 *      provide enforcement teeth, but that requires either bringing
 *      `telegram-plugin/` into the strict tsc check or rewriting the
 *      lint to fail on TS2345 type-mismatch. Today the brand is a
 *      nudge, not a fence.
 *
 * `chatKeyWithSuffix()` extends a ChatKey with a lane suffix
 * (`activity`, `progress`, etc.) — same documentation brand.
 *
 * Non-ChatKey keyspaces (chat:message, chat:user, chat:sender:reason)
 * are deliberately NOT branded — they have different shape and
 * different invariants, see `deferredKey` / `inboundCoalesceKey` /
 * the gate-dedup helper in `gateway.ts`.
 */

export type ChatKey = string & { readonly __brand: 'ChatKey' }

export function chatKey(chatId: string, threadId?: number | null): ChatKey {
  const t = threadId == null || threadId === 0 ? '_' : String(threadId)
  return `${chatId}:${t}` as ChatKey
}

export function chatKeyWithSuffix(
  chatId: string,
  threadId: number | null | undefined,
  suffix: string,
): ChatKey {
  return `${chatKey(chatId, threadId)}:${suffix}` as ChatKey
}

/**
 * Extract the chatId portion of a ChatKey. Used by sibling-key sweeps
 * (PR #1564's `purgeStaleTurnsForChat`) that need to enumerate every
 * thread under a single chat.
 */
export function chatIdOfChatKey(key: ChatKey): string {
  const idx = key.indexOf(':')
  return idx === -1 ? key : key.slice(0, idx)
}
