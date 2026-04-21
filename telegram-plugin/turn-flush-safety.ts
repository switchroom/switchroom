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
 */
export function isSilentFlushMarker(text: string | undefined): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > SILENT_MARKER_MAX_LEN) return false
  return SILENT_MARKERS.has(trimmed.toUpperCase())
}

export type FlushDecision =
  | { kind: 'flush'; text: string }
  | { kind: 'skip'; reason: FlushSkipReason }

export type FlushSkipReason =
  | 'flag-disabled'
  | 'reply-called'
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
  /** Feature flag — defaults to true. Pass `false` to force skip everywhere. */
  flushEnabled?: boolean
}

/**
 * Pure decision: should the gateway deterministically send the model's
 * captured assistant text at turn_end? Returns `{kind: 'flush', text}` with
 * the joined text when yes, otherwise `{kind: 'skip', reason}`.
 *
 * Ordering of checks is deliberate: cheapest/strongest first so logs
 * attribute a skip to the most specific cause.
 */
export function decideTurnFlush(input: FlushDecisionInput): FlushDecision {
  const flushEnabled = input.flushEnabled !== false
  if (!flushEnabled) return { kind: 'skip', reason: 'flag-disabled' }
  if (input.replyCalled) return { kind: 'skip', reason: 'reply-called' }
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
