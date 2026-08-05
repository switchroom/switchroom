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

import {
  isNarrationBlock,
  isStructuralNarration,
  selectBackstopDelivery,
  SUBSTANTIVE_MIN_CHARS,
} from './hooks/narration-classify.mjs'

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

/**
 * Inputs for {@link isSilentSentinelCardOutcome} — the fields of the ending
 * turn the card-suppression gate reads. All are already tracked on the
 * gateway's `CurrentTurn`; passed as a plain struct so the decision is a pure,
 * unit-testable core (`gateway.ts` / `narrative-lane.ts` are not importable in
 * tests).
 */
export interface SilentSentinelCardInput {
  /** True when the model called `reply` / `stream_reply` at least once. */
  replyCalled: boolean
  /**
   * The most-recent `reply` / `stream_reply` `input.text` this turn — empty
   * string when the reply tool was never called (`CurrentTurn.lastReplyText`).
   */
  lastReplyText: string
  /**
   * Raw assistant text blocks accumulated across the turn — the same source
   * `decideTurnFlush` classifies (`CurrentTurn.capturedText`). Only consulted
   * on the reply-never-called (flush) path.
   */
  capturedText: string[]
  /**
   * A SUBSTANTIVE final answer reached the user at some point this turn
   * (`CurrentTurn.finalAnswerEverDelivered`). When true the card is a
   * legitimate record beside a delivered answer and is NEVER suppressed.
   */
  finalAnswerEverDelivered: boolean
}

/**
 * Decide whether an ending turn's user-facing outcome was an INTENTIONAL silent
 * sentinel (NO_REPLY / HEARTBEAT_OK) — the deterministic gate that suppresses
 * the per-turn activity/telemetry card for a turn that said nothing to the user.
 *
 * The symptom (#4348): a background sub-agent handback injects a forced-synthesis
 * turn, the parent legitimately answers `NO_REPLY`, and the gateway still
 * finalizes a `🤖 Agent · done · 0 tools · … · ✓ NO_REPLY` card in the chat.
 * `sentinel-reply-guard-pretool.mjs` already drops the sentinel-only reply so
 * nothing reaches chat, but the blocked `tool_use` still stamps `lastReplyText`,
 * and the activity card finalizes as pure noise.
 *
 * This reuses the SAME silent-turn predicates the flush safety net and the Stop
 * hook use — it invents no second notion of "silent":
 *   - Reply path (`replyCalled`): the model called `reply` with a sentinel-ONLY
 *     payload, which `sentinel-reply-guard-pretool.mjs` drops before chat, so the
 *     card's whole outcome is a silence signal that never became a message. Only
 *     `isSilentFlushMarker` / `isCompositeSilentNoise` count here — a
 *     `prose\nNO_REPLY` reply is NOT dropped by that guard (it has non-marker
 *     content), so its prose WAS delivered and its card must stay. `endsWithSilentMarker`
 *     is deliberately NOT applied to a delivered reply.
 *   - Flush path (reply never called): the turn's captured terminal text is its
 *     outcome, so match every shape `decideTurnFlush` treats as `silent-marker` —
 *     bare marker, composite noise, and prose+trailing-`NO_REPLY` (#2053 / H6).
 *
 * The `finalAnswerEverDelivered` short-circuit is the normal-case guarantee: a
 * turn that actually delivered a substantive answer keeps its card, so a real
 * reply (even one a later stray `NO_REPLY` follows) is never suppressed.
 */
export function isSilentSentinelCardOutcome(input: SilentSentinelCardInput): boolean {
  // A substantive answer reached the user — the card is a legitimate record.
  if (input.finalAnswerEverDelivered) return false
  // Reply-tool outcome: a sentinel-ONLY payload the guard dropped before chat.
  if (isSilentFlushMarker(input.lastReplyText) || isCompositeSilentNoise(input.lastReplyText)) {
    return true
  }
  // Flush outcome: reply never called; classify the captured terminal text with
  // the exact predicates decideTurnFlush's `silent-marker` skip uses.
  if (!input.replyCalled) {
    const joined = input.capturedText.join('\n\n').trim()
    if (
      joined.length > 0 &&
      (isSilentFlushMarker(joined) || isCompositeSilentNoise(joined) || endsWithSilentMarker(joined))
    ) {
      return true
    }
  }
  return false
}

/**
 * Inputs for {@link isHollowGhostCardOutcome} — the ending-turn fields the
 * hollow-card gate reads. A strict superset of the silent-sentinel inputs plus
 * `labeledToolCount` (the deterministic surfaced-tool total). All are already
 * tracked on the gateway's `CurrentTurn`; passed as a plain struct so the
 * decision stays a pure, unit-testable core.
 */
export interface HollowGhostCardInput {
  /** True when the model called `reply` / `stream_reply` at least once. */
  replyCalled: boolean
  /**
   * Count of surfaced (non-suppressed) tool steps this turn
   * (`CurrentTurn.labeledToolCount`) — the same source that drives the card's
   * `✓ N steps` total and the `tools=` lifecycle field. Zero means the turn did
   * no surfaced tool work, so the card has no step body to record.
   */
  labeledToolCount: number
  /**
   * Rendered narrative/mirror lines surfaced into the activity card this turn
   * (`CurrentTurn.mirrorLines`) — every `showNarrativeStep` appends one via
   * `appendActivityLabel`. A NON-EMPTY array means the user saw real narration
   * content in the card (e.g. "Doing the work now"), so the card is a legitimate
   * record even with zero tool steps and no reply — it is NOT the empty ghost
   * card. This is the axis that separates Ken's #45 bug (a card opened by the
   * liveness timer that stayed contentless — `🤖 Agent · done · 0 tools · 40s`,
   * `mirrorLines` empty) from a narration-only turn (a rendered step, no tool).
   */
  mirrorLines: string[]
  /**
   * Raw assistant text blocks accumulated across the turn
   * (`CurrentTurn.capturedText`) — the turn-flush classifies the same source.
   */
  capturedText: string[]
  /**
   * The most-recent `reply` / `stream_reply` `input.text` this turn
   * (`CurrentTurn.lastReplyText`); empty when the reply tool was never called.
   */
  lastReplyText: string
  /**
   * A SUBSTANTIVE final answer reached the user at some point this turn
   * (`CurrentTurn.finalAnswerEverDelivered`). When true the card is a legitimate
   * record beside a delivered answer and is NEVER suppressed.
   */
  finalAnswerEverDelivered: boolean
}

/**
 * Decide whether an ending turn produced a genuinely HOLLOW activity card — the
 * `#45` ghost-reply condition — so the gateway can DELETE the card instead of
 * finalizing it to a contentless `🤖 Agent · done · 0 tools · Ns` record.
 *
 * The symptom (#45): a turn injected into the session (typically a duplicate
 * sub-agent handback beat) adopts a per-turn activity card at turn START, then
 * ends having done ZERO surfaced tool work, never calling reply, delivering no
 * final answer, and emitting no captured terminal text. The card was already
 * posted but never gets any content — the gateway already WARNs on this exact
 * signature (`ghost-reply detected — turn ended with zero outbound messages …
 * replyCalled=false capturedText=empty`) but does not suppress the empty card.
 *
 * This is the complement of {@link isSilentSentinelCardOutcome}: that gate
 * handles a turn whose outcome was an INTENTIONAL silent sentinel (a NO_REPLY /
 * HEARTBEAT_OK the model actually emitted, which reaches `lastReplyText` /
 * `capturedText`). A hollow ghost turn emitted NOTHING at all — no sentinel text
 * for the sentinel gate to match — so `decideTurnFlush` classifies it as
 * `empty-text`, not `silent-marker`, and the sentinel gate returns false (see
 * the `isSilentSentinelCardOutcome` test "a genuinely empty dark turn … is NOT a
 * sentinel"). Both gates share the same conservative floor.
 *
 * Conservative by construction — every guarantee that keeps a real card is an
 * early false:
 *   - `finalAnswerEverDelivered` — a substantive answer reached the user; the
 *     card is a legitimate record.
 *   - `replyCalled` — the model called reply (even a dropped sentinel-only reply
 *     is the SENTINEL gate's job, not this one); never treated as hollow here.
 *   - `labeledToolCount > 0` — the turn did surfaced tool work, so the card
 *     carries a real `✓ N steps` body worth keeping.
 *   - any non-blank `mirrorLines` — the turn surfaced narrative content into the
 *     card that the user saw (a `showNarrativeStep`), so the card is a real
 *     record, NOT the contentless ghost card. This is the axis that keeps a
 *     narration-only turn (rendered step, zero tools/reply/text) from being
 *     mistaken for Ken's empty `done · 0 tools` card, whose `mirrorLines` is
 *     empty because the card was opened by the liveness timer, not narration.
 *   - any non-blank `capturedText` / `lastReplyText` — the turn produced terminal
 *     text; not hollow (and, if it is silent-sentinel noise, the sentinel gate
 *     already suppresses it).
 * Only a turn that is empty on ALL of those axes is hollow.
 */
export function isHollowGhostCardOutcome(input: HollowGhostCardInput): boolean {
  if (input.finalAnswerEverDelivered) return false
  if (input.replyCalled) return false
  if (input.labeledToolCount > 0) return false
  if (Array.isArray(input.mirrorLines) && input.mirrorLines.join('').trim().length > 0) return false
  if (Array.isArray(input.capturedText) && input.capturedText.join('').trim().length > 0) return false
  if (typeof input.lastReplyText === 'string' && input.lastReplyText.trim().length > 0) return false
  return true
}

/**
 * Substantive-answer floor (chars, trimmed). Mirrors
 * `final-answer-detect.ts` `FINAL_ANSWER_MIN_CHARS` and
 * `hooks/silent-end-scan.mjs` — the same bar the codebase uses everywhere to
 * recognise "this text block is a real answer, not a short narration/closer".
 */
export const FLUSH_SUBSTANTIVE_MIN_CHARS = SUBSTANTIVE_MIN_CHARS

/**
 * Pick the text a turn-flush should actually DELIVER from the captured
 * assistant blocks.
 *
 * The duplicate-reply bug (2026-07) had the answer-ready flush fire while the
 * model was still composing its `reply` tool call: `capturedText` at that
 * moment holds intent-narration blocks ("Let me check X", "I'll now …") FOLLOWED
 * by the composed answer block. Flushing `capturedText.join('\n\n')` dumped the
 * whole narration+answer blob into chat — which then never matched the clean
 * answer-only `reply` on the outbound dedup (containment, not equality), so the
 * user got a narration-laden duplicate.
 *
 * The answer is the TERMINAL block — the last thing the model wrote is what it
 * settled on, REGARDLESS of length. A real dropped answer is often short
 * (a one-line confirmation, a two-sentence reply), so gating delivery on the
 * 200-char substantive floor was wrong: with blocks
 * `[verboseNarration(250), realAnswer(150)]` a reversed length scan returns the
 * 250-char narration and DROPS the 150-char real answer. Instead we take the
 * last non-empty block as the answer and strip only the EARLIER blocks — and
 * only when they look like intent-narration. If the earlier blocks are
 * themselves substantial (a genuine multi-paragraph answer written as several
 * blocks) we keep the whole thing joined, so we never truncate a real long
 * answer down to its last paragraph.
 *
 * #3237 — the STRUCTURAL discriminator. The opener heuristic below
 * (`isNarrationBlock`) cannot tell a narration preamble ("Let me pull the
 * numbers…" followed by a separate reply) from a real answer paragraph that
 * merely OPENS with "Let me explain…": both match the same regex, and length
 * cannot separate them (the observed narration was itself ≥200 chars). The one
 * signal that DOES separate them is structural — did a `tool_use` follow this
 * block in the model's actual message? A narration preamble is drafted, then
 * the model ACTS (a tool call follows it); a terminal answer paragraph is not
 * followed by any tool call. That per-block flag (`lastInMessage`) is computed
 * upstream by `projectAssistantTextBlocks` (session-tail.ts) and, when the
 * caller plumbs it through as `followedByToolUse`, we consult STRUCTURE, but
 * asymmetrically:
 *   - present-and-FALSE (no tool_use followed) is purely additive — it can only
 *     RESCUE a block the opener regex would have mis-stripped (a terminal answer
 *     opening "Let me explain…"); it never drops a block the heuristic kept.
 *   - present-and-TRUE (a tool_use followed) is NOT taken as narration on its
 *     own: a substantial real-content paragraph can precede a tool call, so the
 *     strip is GATED by the substance check (narration only if it also matches
 *     the opener/trailer heuristic OR falls below the substantive floor). This
 *     is deliberately not "strictly additive" over the opener-only strip — it
 *     both rescues real content the old flag-alone path would have dropped and
 *     stays truncation-free.
 * Where the structural flag is ABSENT for a block (legacy `string[]` caller, or
 * the accumulator lost provenance) we fall back to the opener/trailer heuristic
 * for that block.
 *
 * `followedByToolUse` is a parallel array aligned to `blocks` (index `i` ⇒
 * `blocks[i]`); it is zipped BEFORE the empty-block filter so alignment holds
 * even if the caller passes empty/whitespace blocks. `undefined` at an index
 * (or a missing/short array) means "no reliable structural signal for this
 * block" → opener-heuristic fallback.
 *
 * `blocks` are already trimmed/non-empty candidates (silent markers removed by
 * the caller's guards). Returns the chosen delivery text.
 */
export function selectFlushDeliveryText(
  blocks: string[],
  followedByToolUse?: ReadonlyArray<boolean | undefined>,
): string {
  const candidates = blocks
    .map((b, i) => ({ text: b.trim(), followedByToolUse: followedByToolUse?.[i] }))
    .filter(c => c.text.length > 0)
  if (candidates.length === 0) return ''

  // #3513 — the STRUCTURAL rule now applies to the TERMINAL block too, not only
  // preceding blocks. A lone trailing block that a `tool_use` FOLLOWED (the
  // model kept acting after writing it) is intra-turn narration by construction,
  // never the terminal answer — so it must not be delivered as one. This is the
  // primary fix for the observed leak ("Now checking the gateway logs…"),
  // wording-independent where the opener regex fails. It stays substance-gated
  // (correction 3): only a SHORT or narration-shaped block that a tool followed
  // is suppressed — a SUBSTANTIVE, non-narration block followed by a
  // non-delivering tool (react / pin / typing / edit) is NOT structural
  // narration and still delivers.
  //
  // Only the STRUCTURAL signal (`followedByToolUse === true`) may strip the
  // terminal block; the opener/trailer heuristic remains a residual tie-breaker
  // for PRECEDING blocks only, so a provenance-less single block still delivers
  // verbatim (#3276 finding 7 — a colon-terminated line that IS the whole answer
  // is never dropped).
  let cs = candidates
  while (cs.length > 1 && isStructuralNarration(cs[cs.length - 1].text, cs[cs.length - 1].followedByToolUse)) {
    cs = cs.slice(0, -1)
  }
  if (cs.length === 1) {
    return isStructuralNarration(cs[0].text, cs[0].followedByToolUse) ? '' : cs[0].text
  }

  const answer = cs[cs.length - 1].text
  const preceding = cs.slice(0, -1)
  // Deliver only the terminal answer when every earlier block is
  // intent-narration. Per block:
  //   - structural flag TRUE ⇒ a tool_use followed this block, but that alone
  //     is NOT sufficient to drop it: a substantial real-content paragraph can
  //     legitimately precede a tool call (the model writes a real answer, then
  //     calls a memory/verify tool, then a short wrap-up). So gate the
  //     structural strip with the substantive floor — narration only if the
  //     block ALSO looks like narration OR is below the substantive floor.
  //   - structural flag FALSE ⇒ present-and-false definitively overrides the
  //     opener regex: no tool_use followed, so it is a terminal-style block,
  //     never narration (#3237).
  //   - structural flag ABSENT ⇒ fall back to the opener/trailer heuristic.
  // Otherwise the earlier blocks carry real content — keep the full joined text
  // so a legitimate multi-block answer is never truncated to its last
  // paragraph (#3237).
  const allNarration = preceding.every(c =>
    c.followedByToolUse === true
      ? isNarrationBlock(c.text) || c.text.trim().length < FLUSH_SUBSTANTIVE_MIN_CHARS
      : c.followedByToolUse === false
        ? false
        : isNarrationBlock(c.text),
  )
  return allNarration ? answer : cs.map(c => c.text).join('\n\n')
}

// The narration heuristic (`isNarrationBlock` / openers / trailer) and the
// structural rule (`isStructuralNarration`) now live in the ONE shared
// classifier `hooks/narration-classify.mjs`, imported at the top of this file
// and by the unbundled Stop hook (`hooks/silent-end-scan.mjs`) alike — so the
// TS gateway side and the `.mjs` side can never drift (switchroom#3513
// correction 2; retires the old "MUST stay in sync" hand-synced copies).

export type FlushDecision =
  | { kind: 'flush'; text: string }
  | { kind: 'skip'; reason: FlushSkipReason }

export type FlushSkipReason =
  | 'flag-disabled'
  | 'reply-called'
  | 'no-inbound-chat'
  | 'empty-text'
  | 'silent-marker'
  // A prior BACKSTOP (E2 answer-ready flush, or an out-of-process E3/E4 machine
  // across a crash/restart) already delivered this turn's answer — the durable
  // exactly-once-among-backstops guard (#3513 follow-up, MF2). Set by the
  // caller, not `decideTurnFlush`.
  | 'already-delivered'

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
  /** Optional per-block structural provenance, aligned to `capturedText`
   * (index `i` describes `capturedText[i]`). `true` ⇒ a `tool_use` followed
   * this text block in its assistant message (the draft-then-send narration
   * signal — the negation of `projectAssistantTextBlocks`' `lastInMessage`).
   * Consumed by `selectFlushDeliveryText` to separate a narration preamble from
   * a real answer paragraph that merely opens with a narration phrase (#3237).
   * When absent (legacy caller / lost provenance) the strip falls back to the
   * opener/trailer heuristic. Present-and-false is additive (only rescues a
   * mis-stripped terminal answer); present-and-true is gated by the substantive
   * floor rather than trusted alone. */
  capturedBlockMeta?: boolean[]
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
  // separator; the gateway send path then wedges visible spacers into those
  // gaps via addParagraphSpacers (mirroring the reply path, #2692) so the
  // paragraphs render with real separation (the rich GFM renderer otherwise
  // shows a bare `\n\n` gap TIGHT).
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
  // #3513 follow-up — deterministic, model-discipline-free coalescing. The
  // DELIVERED text is the TERMINAL RUN (the suffix of blocks NOT followed by a
  // turn-continuing tool_use); every tool-followed block is suppressed
  // UNCONDITIONALLY (no length/wording gate), replacing #3515's substance-gated
  // heuristic on this backstop path. `selectBackstopDelivery` returns null when
  // nothing terminal survives (a short tool-followed fragment) — treat that as
  // 'empty-text' so the turn routes to the Stop-hook re-prompt ladder rather
  // than delivering an interim narration line. The silent-marker / empty guards
  // above still run on the full `joined` string so a partly-silent turn is
  // classified correctly.
  const selected = selectBackstopDelivery(
    input.capturedText.map((text, i) => ({
      text,
      followedByToolUse: input.capturedBlockMeta?.[i],
    })),
  )
  if (selected == null || selected.text.trim().length === 0) {
    return { kind: 'skip', reason: 'empty-text' }
  }
  return { kind: 'flush', text: selected.text }
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
