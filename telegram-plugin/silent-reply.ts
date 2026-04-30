/**
 * Silent-reply markers + allowlist guard.
 *
 * Lives in its own module (separate from server.ts) so that tests and
 * other importers can pull these helpers in without booting the
 * full MCP server — server.ts has top-level side effects (env load,
 * TELEGRAM_BOT_TOKEN check, history.db open, session-tail spawn) that
 * are inappropriate for a unit-test import boundary.
 *
 * Sprint1 review finding #6: an earlier revision of the reply /
 * stream_reply tool handlers returned the silent-reply ack BEFORE
 * calling `assertAllowedChat`, so unauthorised chats could bypass the
 * outbound allowlist by having the agent emit `NO_REPLY`. The ack
 * itself is a cross-chat signal (it confirms to the LLM that the chat
 * exists and is reachable) even though no Telegram message is sent, so
 * we must refuse disallowed chats *before* producing it. The
 * guardSilentReply helper locks that ordering in.
 */

const SILENT_REPLY_MARKERS = new Set(['NO_REPLY', 'HEARTBEAT_OK'])

// Derive the char-length bound from the marker set so adding a new
// marker doesn't silently desync with a hand-tuned constant.
const SILENT_REPLY_MAX_LEN = Math.max(
  ...Array.from(SILENT_REPLY_MARKERS, (m) => m.length),
) + 2 // small buffer for trailing punctuation callers might add accidentally

export function isSilentReplyMarker(text: string | undefined): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > SILENT_REPLY_MAX_LEN) return false
  // Case-insensitive match: models occasionally emit `no_reply` or
  // `NoReply`. Require letters/underscores/digits only so legitimate
  // prose that happens to contain "NO_REPLY was suggested" still sends.
  return SILENT_REPLY_MARKERS.has(trimmed.toUpperCase())
}

/**
 * Decide whether a `reply`/`stream_reply` invocation should be short-
 * circuited as a silent-reply ack, enforcing the allowlist FIRST.
 *
 * `assertAllowed` throws when `chat_id` is not on the allowlist; callers
 * let that propagate so the MCP tool call fails loudly.
 */
export function guardSilentReply(params: {
  chat_id: string
  text: string | undefined
  hasFiles: boolean
  assertAllowed: (chat_id: string) => void
}): { kind: 'silent'; markerText: string } | { kind: 'continue' } {
  const { chat_id, text, hasFiles, assertAllowed } = params
  if (hasFiles) return { kind: 'continue' }
  if (!isSilentReplyMarker(text)) return { kind: 'continue' }
  // Allowlist check BEFORE returning the ack — see docblock above.
  assertAllowed(chat_id)
  return { kind: 'silent', markerText: (text as string).trim() }
}
