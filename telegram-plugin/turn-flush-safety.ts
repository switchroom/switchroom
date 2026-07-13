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

// Trivial end-of-turn confirmations the model emits as terminal text after
// calling reply (e.g. "Sent." once the reply tool returns). On their own
// they're harmless; the danger is when they're glued to silent markers
// across Stop-hook re-prompt cycles into a composite blob like
// "Sent.\nNO_REPLY\nNO_REPLY" — which `isSilentFlushMarker` can't match
// (multi-line, over the length guard) so it leaks to chat. See
// `isCompositeSilentNoise`.
const TRIVIAL_CONFIRMATIONS = new Set(['SENT', 'DONE', 'OK', 'OKAY', 'ACK'])

function isTrivialConfirmationLine(line: string): boolean {
  let t = line.trim()
  if (t.length === 0 || t.length > 8) return false
  if (/\W$/.test(t)) t = t.slice(0, -1) // strip a single trailing punct ("Sent.")
  return TRIVIAL_CONFIRMATIONS.has(t.toUpperCase())
}

/**
 * Recognise a multi-line composite that is *entirely* silent noise — every
 * non-empty line is a silent marker (NO_REPLY / HEARTBEAT_OK) or a trivial
 * confirmation ("Sent."), AND at least one line is a real silent marker.
 *
 * Backstop for the Stop-hook re-prompt leak: the model replies cleanly,
 * emits a terminal "Sent.", gets re-prompted by the silent-end Stop hook,
 * answers "NO_REPLY" one or more times, and the accumulated `capturedText`
 * ("Sent.\nNO_REPLY\nNO_REPLY") flushes as a visible message because
 * `isSilentFlushMarker` only matches a single sentinel. Requiring ≥1 hard
 * marker keeps this conservative — a standalone "Sent." (no NO_REPLY) is NOT
 * suppressed here, so we never silently drop a turn that wasn't already
 * signalling "nothing to add".
 */
export function isCompositeSilentNoise(text: string | undefined): boolean {
  if (typeof text !== 'string') return false
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
  if (lines.length === 0) return false
  const hasMarker = lines.some(l => isSilentFlushMarker(l))
  if (!hasMarker) return false
  return lines.every(l => isSilentFlushMarker(l) || isTrivialConfirmationLine(l))
}

/**
 * Recognise output whose final non-empty line is a bare silent marker
 * (NO_REPLY / HEARTBEAT_OK, with the same single-trailing-punctuation
 * tolerance as `isSilentFlushMarker`), regardless of what precedes it.
 *
 * This closes #2053: a turn (commonly a cron turn) that emits prose
 * followed by a bare `NO_REPLY` line — e.g.
 *   "Nothing actionable in today's digest.\nNO_REPLY"
 * — is the model explicitly signalling "intentionally silent". The
 * single-line `isSilentFlushMarker` misses it (multi-line, over the
 * length guard) and `isCompositeSilentNoise` misses it too (the prose
 * line is neither a marker nor a trivial confirmation), so the blob
 * would otherwise flush to chat WITH the sentinel text appended.
 *
 * The trailing-marker line itself is the explicit silence signal — when
 * the model deliberately terminates with NO_REPLY it means "do not
 * deliver this turn", so we suppress the whole blob rather than strip
 * the sentinel and flush the prose. Stripping-and-flushing would defeat
 * the model's intent (it chose silence) and re-introduce the exact
 * surprise-message problem the flush safety net was built to avoid.
 *
 * Requires the LAST line to be the marker — a marker buried mid-output
 * with real content after it (e.g. "NO_REPLY\nThe answer is 42.") is
 * NOT suppressed, because the trailing content is the model's actual
 * message.
 */
export function endsWithSilentMarker(text: string | undefined): boolean {
  if (typeof text !== 'string') return false
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
  if (lines.length === 0) return false
  return isSilentFlushMarker(lines[lines.length - 1])
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
   * turn. Joined + trimmed internally. Only consulted when `replyCalled`
   * is false — once the model has called reply / stream_reply the turn is
   * served and trailing terminal text is dropped (see `decideTurnFlush`). */
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
 *
 * The safety net has exactly one job: a turn that ended with the model
 * having said *nothing* to the user. Once `replyCalled` is true the model
 * has communicated through the proper channel and the decision is always
 * `skip` — assistant text emitted after a reply is the model's own
 * end-of-turn wrap-up (a closing summary, narration to itself), not a
 * message it chose to send. Promoting that terminal text into a Telegram
 * message second-guesses an explicit reply and posts a redundant duplicate
 * on essentially every turn, because the model habitually writes a closing
 * summary. The framework owns the *beat*; the model authors the *words*
 * and emits them via reply (`reference/rfcs/conversational-pacing.md`).
 *
 * (This reverts the #1291 post-reply-tail flush. Its intent — catch a
 * soft-commit reply followed by the real answer in terminal text only —
 * could not be told apart from the habitual wrap-up by length, so it
 * misfired constantly. A model that soft-commits and never delivers is a
 * pacing failure caught by the silence-poke ladder, not papered over here.)
 */
export function decideTurnFlush(input: FlushDecisionInput): FlushDecision {
  const flushEnabled = input.flushEnabled !== false
  if (!flushEnabled) return { kind: 'skip', reason: 'flag-disabled' }

  // The model communicated through the proper channel — trust it. Any
  // assistant text it emitted as terminal text afterwards is its own
  // end-of-turn wrap-up, never a second Telegram message.
  if (input.replyCalled) return { kind: 'skip', reason: 'reply-called' }

  if (input.chatId == null) return { kind: 'skip', reason: 'no-inbound-chat' }
  // #2798 — join whole authored assistant text blocks with a PARAGRAPH break,
  // not a single newline. Each `capturedText` element is one complete
  // `content[i].text` block (session-tail.ts `projectAssistantTextBlocks`), so
  // the boundary between two elements is a paragraph boundary. Joining with a
  // lone `\n` collapses adjacent blocks into one run — on the Bot API 10.1
  // rich-markdown path (#2669) a single newline is a soft break, so the blocks
  // render as an undifferentiated wall-of-text. `\n\n` is the GFM paragraph
  // separator; the Bot API 10.1 rich renderer shows it as one visible blank
  // line, so the paragraphs render with real separation on their own (the
  // former NBSP spacer pass was removed in the #2669 follow-up — it added a
  // spurious second blank line).
  //
  // The silent-marker guards below are unaffected by this change:
  // isSilentFlushMarker length-guards the whole joined string; the composite /
  // trailing-marker guards split on '\n' and filter empty lines, so the extra
  // blank line an '\n\n' join introduces is discarded before matching.
  const joined = input.capturedText.join('\n\n').trim()
  if (joined.length === 0) return { kind: 'skip', reason: 'empty-text' }
  if (isSilentFlushMarker(joined)) return { kind: 'skip', reason: 'silent-marker' }
  // Composite silent noise — e.g. "Sent.\nNO_REPLY\nNO_REPLY" accumulated
  // across Stop-hook re-prompt cycles. The single-sentinel check above
  // misses it (multi-line, over the length guard); without this the blob
  // leaks to chat as a visible message.
  if (isCompositeSilentNoise(joined)) return { kind: 'skip', reason: 'silent-marker' }
  // Prose followed by a trailing bare NO_REPLY / HEARTBEAT_OK line (#2053).
  // The model wrote content but explicitly terminated with the silence
  // sentinel — treat the whole turn as intentionally silent rather than
  // flush the prose with the sentinel glued on.
  if (endsWithSilentMarker(joined)) return { kind: 'skip', reason: 'silent-marker' }
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
