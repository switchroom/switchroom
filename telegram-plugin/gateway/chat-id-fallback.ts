/**
 * Shared chat_id allowlist fallback for the reply / stream_reply final-answer
 * paths.
 *
 * Non-Claude models (Gemini via LiteLLM `sr-*` routing) sometimes pass a
 * chat_id that fails the allowlist:
 *
 *   - **Bug A (numeric coercion):** the model passes a JSON number, so the
 *     caller must `String(...)`-coerce before the allowlist compare (the
 *     allowlist is a string set). Without coercion `42 !== "42"` and every
 *     reply looks un-allowlisted.
 *   - **Bug B (executeReply fallback):** the raw value is wrong, so fall back
 *     to the *active* turn's already-validated `sessionChatId`.
 *   - **Bug D (lastActiveTurnChatId survives silence poke):** a ≥5-min silence
 *     poke fires `clearTurnStarted`, so `currentTurn` is null by the time the
 *     model finally replies. The active-turn tier is gone, but the last-known
 *     turn's chat still routes the answer correctly.
 *
 * These hotfixes shipped test-free; this helper isolates the pure decision so
 * each bug gets a focused regression test.
 *
 * Returns the resolved chat_id (rawChatId unchanged when no valid fallback
 * exists, so the caller's `assertAllowedChat` throws the human-readable error)
 * plus the tier used, for logging. Pure — no module state read.
 */
export interface ChatIdAllowlist {
  allowFrom: string[]
  groups: Record<string, unknown>
}

export function resolveChatIdFallback(
  rawChatId: string,
  access: ChatIdAllowlist,
  turnSessionChatId: string | undefined,
  lastKnownChatId: string | undefined,
  hasLiveTurn: boolean,
): { chatId: string; tier: 'raw' | 'active' | 'last-known' } {
  if (access.allowFrom.includes(rawChatId) || rawChatId in access.groups) {
    return { chatId: rawChatId, tier: 'raw' }
  }
  const fallbackChatId = turnSessionChatId ?? lastKnownChatId
  if (fallbackChatId && (access.allowFrom.includes(fallbackChatId) || fallbackChatId in access.groups)) {
    return { chatId: fallbackChatId, tier: hasLiveTurn ? 'active' : 'last-known' }
  }
  return { chatId: rawChatId, tier: 'raw' }
}
