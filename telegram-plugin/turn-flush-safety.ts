/**
 * Turn-end flush safety net.
 *
 * Purpose: if a Claude turn ends without the model calling the `reply` or
 * `stream_reply` tool, we still want the user to see the model's final
 * assistant text in Telegram. The live Telegram-plugin gateway tracks the
 * current turn's state (chatId, whether the reply tool was called, and the
 * captured assistant text). At turn_end we call `decideTurnFlush` to decide
 * whether to deterministically flush that captured text via the normal
 * outbound send path.
 *
 * The decision is pure — the caller is responsible for actually sending.
 * Keeping the policy in one unit-testable function is the whole point:
 * the suppress cases (silent-reply markers, empty text, sub-agent turns,
 * system-initiated turns with no inbound user message, the feature flag)
 * are easy to audit and extend.
 *
 * The feature flag `SWITCHROOM_TG_TURN_FLUSH_SAFETY` is enabled by default
 * and can be set to `0` / `false` / `off` to disable without a rebuild.
 */

const SILENT_MARKERS = new Set(['NO_REPLY', 'HEARTBEAT_OK'])
// Small buffer so `NO_REPLY.` with a stray period still counts as silent.
const SILENT_MARKER_MAX_LEN = Math.max(
  ...Array.from(SILENT_MARKERS, m => m.length),
) + 2

/**
 * Exact-match (case-insensitive, whitespace-trimmed) check for the silent
 * reply sentinels NO_REPLY and HEARTBEAT_OK. Mirrors server.ts
 * `isSilentReplyMarker` intentionally — keeping a local copy avoids a
 * circular-import dependency on server.ts (which has heavy top-level
 * side effects).
 *
 * Trailing-punctuation tolerance: a single trailing non-alphanumeric character
 * (e.g. `NO_REPLY.`) is stripped before matching so accidental punctuation
 * from model output doesn't prevent suppression. Substring matches (e.g.
 * `the agent suggested NO_REPLY earlier`) are still rejected because the
 * length guard rejects anything longer than SILENT_MARKER_MAX_LEN.
 */
export function isSilentFlushMarker(text: string | undefined): boolean {
  if (typeof text !== 'string') return false
  let trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > SILENT_MARKER_MAX_LEN) return false
  // Strip a single trailing non-word character to handle "NO_REPLY." etc.
  if (trimmed.length > 0 && /\W$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1)
  }
  return SILENT_MARKERS.has(trimmed.toUpperCase())
}

export type FlushDecision =
  | { kind: 'flush'; text: string }
  | { kind: 'skip'; reason: FlushSkipReason }

export type FlushSkipReason =
  | 'flag-disabled'
  | 'reply-called'
  | 'reply-called-no-new-text'
  | 'no-inbound-chat'
  | 'empty-text'
  | 'silent-marker'

export interface FlushDecisionInput {
  /** Inbound chat the turn was servicing. `null` means system-initiated /
   * sub-agent — never flush those, they have their own outbound lifecycle. */
  chatId: string | null
  /** True when the model called `reply` / `stream_reply` at least once for
   * this turn. */
  replyCalled: boolean
  /** Raw text content blocks accumulated from assistant events across the
   * turn. Joined + trimmed internally. */
  capturedText: string[]
  /** Snapshot of `capturedText.length` at the moment of the most recent
   * reply / stream_reply tool call in this turn. Indices `[capturedText
   * length-at-last-reply, capturedText.length)` are the post-reply tail
   * — substantive content the model emitted AFTER the reply (e.g. soft
   * commit "on it, back in a few" followed by the real answer in
   * terminal text only, the #1291 repro). When the tail meets
   * `replyCalledTailMinChars` we flush it; otherwise we skip.
   *
   * Defaults to `capturedText.length` (treat all captured text as
   * pre-reply, preserve the pre-#1291 behaviour where any reply tool
   * call suppressed flush entirely) so callers that don't track the
   * marker keep the old contract. */
  capturedTextLenAtLastReply?: number
  /** Minimum trimmed-tail length to qualify a post-reply tail flush.
   * Defaults to `REPLY_CALLED_TAIL_MIN_CHARS` (40). Below this we skip
   * with `reply-called-no-new-text` — typical for trailing markdown
   * artifacts or a one-word afterthought. */
  replyCalledTailMinChars?: number
  /** Feature flag — defaults to true. Pass `false` to force skip everywhere. */
  flushEnabled?: boolean
}

/** Default minimum trimmed length for the post-reply tail to be flushed
 * as a follow-up message. Below this we treat the tail as noise / artifact
 * and skip silently. */
export const REPLY_CALLED_TAIL_MIN_CHARS = 40

/**
 * Pure decision: should the gateway deterministically send the model's
 * captured assistant text at turn_end? Returns `{kind: 'flush', text}` with
 * the joined text when yes, otherwise `{kind: 'skip', reason}`.
 *
 * Ordering of checks is deliberate: cheapest/strongest first so logs
 * attribute a skip to the most specific cause.
 *
 * #1291 — when `replyCalled` is true we no longer suppress unconditionally.
 * The model may have emitted a soft-commit reply ("on it, back in a few")
 * followed by the real substantive answer in terminal text only. Using
 * `capturedTextLenAtLastReply` we isolate the post-reply tail and flush
 * it if it's substantive enough; otherwise we skip with
 * `reply-called-no-new-text` (logged) or `reply-called` (silent, no tail).
 */
export function decideTurnFlush(input: FlushDecisionInput): FlushDecision {
  const flushEnabled = input.flushEnabled !== false
  if (!flushEnabled) return { kind: 'skip', reason: 'flag-disabled' }

  if (input.replyCalled) {
    const tailIdx = input.capturedTextLenAtLastReply ?? input.capturedText.length
    const tail = input.capturedText.slice(tailIdx).join('\n').trim()
    const minChars = input.replyCalledTailMinChars ?? REPLY_CALLED_TAIL_MIN_CHARS
    if (tail.length === 0) {
      // The reply tool was called and nothing of substance came after —
      // the turn is fully served by the reply. Skip silently (the gateway
      // WARN gate excludes this reason from logs).
      return { kind: 'skip', reason: 'reply-called' }
    }
    if (tail.length < minChars) {
      // Post-reply tail exists but is below the substantive-content
      // threshold — typically trailing markdown artifacts or a one-word
      // afterthought. Skip but with a distinct reason so this case IS
      // logged (auditable for #1291 regressions, vs the silent
      // 'reply-called' which is the expected steady state).
      return { kind: 'skip', reason: 'reply-called-no-new-text' }
    }
    if (input.chatId == null) return { kind: 'skip', reason: 'no-inbound-chat' }
    if (isSilentFlushMarker(tail)) return { kind: 'skip', reason: 'silent-marker' }
    return { kind: 'flush', text: tail }
  }

  if (input.chatId == null) return { kind: 'skip', reason: 'no-inbound-chat' }
  const joined = input.capturedText.join('\n').trim()
  if (joined.length === 0) return { kind: 'skip', reason: 'empty-text' }
  if (isSilentFlushMarker(joined)) return { kind: 'skip', reason: 'silent-marker' }
  return { kind: 'flush', text: joined }
}

/**
 * Resolve the feature-flag env var. Default: enabled. Set
 * SWITCHROOM_TG_TURN_FLUSH_SAFETY to `0`, `false`, `off`, or `no` to disable.
 */
export function isTurnFlushSafetyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.SWITCHROOM_TG_TURN_FLUSH_SAFETY
  if (raw == null) return true
  const v = raw.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  return true
}
