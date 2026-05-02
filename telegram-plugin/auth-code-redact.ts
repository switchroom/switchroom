/**
 * Redact OAuth-code paste messages from Telegram chat history.
 *
 * When a user pastes their Claude OAuth browser code (during
 * `/auth login`, `/auth reauth`, or `/auth code`), the message lingers
 * in chat history. The code is single-use — Anthropic's PKCE flow
 * exchanges it for a refresh token via a code_verifier kept on the
 * agent's host — so third parties reading the chat after exchange
 * can't replay it. But:
 *
 *   1. Hygiene: plaintext OAuth tokens in chat history look bad in
 *      screenshots, shared screens, compliance / debug dumps.
 *   2. Defense in depth: anyone with both chat history AND host
 *      access could race the exchange in the small pre-exchange window.
 *   3. Asymmetry: the gateway's bare-code-paste handler already
 *      deletes; the four other auth-code call sites don't.
 *
 * This helper standardises the delete + 🔑-reaction pattern so all
 * five call sites match. See issue #488.
 *
 * The function is intentionally non-blocking and swallows errors:
 * - `deleteMessage` may fail if the message is too old (Telegram
 *   limits bots to 48h) or if the user has already deleted it
 * - `setMessageReaction` after a successful delete fails because the
 *   message is gone — that's expected and intentional, the user sees
 *   the delete instead of the reaction
 *
 * The reaction provides a visual breadcrumb on the rare path where
 * delete fails (older messages, race with user delete).
 */

interface BotApi {
  deleteMessage(chatId: string, messageId: number): Promise<unknown>
  setMessageReaction(
    chatId: string,
    messageId: number,
    reaction: Array<{ type: 'emoji'; emoji: string }>,
  ): Promise<unknown>
}

/**
 * Delete the OAuth code paste message and (best-effort) react with 🔑.
 *
 * @param api Bot API surface (lockedBot.api in production)
 * @param chatId Stringified Telegram chat id
 * @param messageId Numeric message id to redact, or null for no-op
 * @param log Optional log sink — receives a single line on every
 *            attempt (success or failure). When the function silently
 *            swallowed errors before, operators had no way to diagnose
 *            why a paste was still visible in chat (#488 follow-up).
 *
 * Both calls are fire-and-forget. The reaction is dispatched first so
 * fast clients see the 🔑 land before the message is gone — most clients
 * actually only render whichever wins the race, which is fine either way.
 *
 * Failures are logged (when a sink is provided) but never re-thrown:
 * delete can fail if the message is too old (Telegram limits bots to
 * 48h), if the user already deleted it, or if the bot lacks permission
 * (group chats without delete rights). Reactions can fail similarly.
 * Visibility-into-failure is the operator-facing fix; the silent path
 * left tokens lingering in chat history with no diagnostic trail.
 */
export function redactAuthCodeMessage(
  api: BotApi,
  chatId: string,
  messageId: number | null,
  log?: (line: string) => void,
): void {
  if (messageId == null) {
    log?.('telegram gateway: auth-code redact: no message_id, skipping\n')
    return
  }
  void api.setMessageReaction(chatId, messageId, [
    { type: 'emoji', emoji: '🔑' },
  ]).then(
    () => log?.(`telegram gateway: auth-code redact: 🔑 reaction added msgId=${messageId} chatId=${chatId}\n`),
    (err: unknown) => log?.(`telegram gateway: auth-code redact: reaction FAILED msgId=${messageId} chatId=${chatId}: ${(err as Error).message}\n`),
  )
  void api.deleteMessage(chatId, messageId).then(
    () => log?.(`telegram gateway: auth-code redact: deleted msgId=${messageId} chatId=${chatId}\n`),
    (err: unknown) => log?.(`telegram gateway: auth-code redact: delete FAILED msgId=${messageId} chatId=${chatId}: ${(err as Error).message} — token may still be visible in chat\n`),
  )
}
