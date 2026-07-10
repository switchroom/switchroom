// Outbound send-path — deterministic text pipeline + chunking core (#2996).
//
// Phase 2 of the gateway.ts decomposition (issue #2996, plan §3B). This
// module owns the pure, side-effect-free heart of the reply/stream/turn-flush
// outbound pipeline: the normalize → redact → punctuation/bold → voice-scrub
// text transform, the effective-text spacing decision, the length-limit
// chunking, and the oversize-chunk re-split. These are exactly the transforms
// where the recent oversize / redaction / voice-scrub regressions landed, and
// extracting them here makes them unit-testable in isolation (see
// outbound-send-path.test.ts golden snapshots).
//
// Deliberately NOT moved here (they stay in gateway.ts, delegating to this
// module): the side-effecting send orchestration — currentTurn pinning,
// emission-authority / over-ping decisions, activity-card finalize, voice
// synthesis + sends, typing loops, history recording, the shared
// `outboundDedup` singleton check/record, and the raw bot.api send loop with
// its partial-failure contract. Those read gateway module state and are not
// byte-identically relocatable without an invocable-executeReply harness that
// this pure-core extraction is itself the prerequisite for.
//
// currentTurn coupling (#1067/#1664): this module NEVER reads the currentTurn
// global. Every function here is pure over its arguments — turn identity is
// pinned by the caller and never observed here.

import {
  repairEscapedWhitespace,
  normalizeParagraphBreaks,
  normalizePunctuation,
  stripExcessBold,
  addParagraphSpacers,
  splitMarkdownChunks,
  hardSliceToCap,
  RICH_MESSAGE_MAX_CHARS,
} from '../format.js'
import { scrubVoice } from '../text-voice-scrub.js'

/** The redactor the caller injects. In gateway this is `redactOutboundText`,
 *  which wraps `redact()` and logs (never the secret value) when a mask fires.
 *  Injected rather than imported so the redaction structural-wiring test
 *  (`gateway-outbound-redact.test.ts`) keeps pinning the helper in gateway.ts,
 *  and so this module stays free of the stderr side effect. */
export type RedactFn = (text: string, site: string) => string

export interface NormalizeOutboundResult {
  /** The fully-normalized text. This is the value used downstream as the
   *  dedup key, the Telegraph threshold input, and (after effective-text
   *  spacing) the chunk source. Callers apply it exactly as the pre-#2996
   *  inline pipeline did. */
  text: string
  /** Number of voice-scrub replacements applied (dashes → commas/periods,
   *  opener strips). >0 means the voice scrub mutated the text; the caller
   *  emits the `voice_scrub_applied` runtime metric on that condition. */
  voiceReplaced: number
}

/**
 * Stage 1 — the deterministic outbound text transform, byte-identical to the
 * inline pipeline at the entry of executeReply (and mirrored on the
 * answer-stream + turn-flush paths):
 *
 *   1. repairEscapedWhitespace  — undo LLM JSON-escape bungles
 *   2. normalizeParagraphBreaks — promote lone prose breaks to GFM hard breaks
 *   3. redact (injected)        — outbound secret scrub (#2044), BEFORE the
 *                                 punctuation/bold normalizers so a secret with
 *                                 an em-dash or `**` is matched literally
 *   4. stripExcessBold∘normalizePunctuation — fleet-consistent formatting
 *   5. scrubVoice               — em/en dash → comma/period (#1683)
 *
 * The order is load-bearing and MUST NOT change (each step's comment in the
 * former inline site documents why). Pure over its arguments.
 */
export function normalizeOutboundBody(
  rawText: string,
  site: string,
  redact: RedactFn,
): NormalizeOutboundResult {
  let text = normalizeParagraphBreaks(repairEscapedWhitespace(rawText))
  text = redact(text, site)
  text = stripExcessBold(normalizePunctuation(text))
  let voiceReplaced = 0
  const scrub = scrubVoice(text)
  if (scrub.replaced > 0) {
    text = scrub.scrubbed
    voiceReplaced = scrub.replaced
  }
  return { text, voiceReplaced }
}

/**
 * Effective-text spacing (#2669 rich-message regression fix). The rich GFM
 * renderer collapses `\n\n` gaps tight, so prose paragraphs render jammed.
 * Inject a visible blank-line spacer on the rich path only; the literal
 * (`format:'text'`) path stays byte-exact. Pure.
 */
export function computeEffectiveText(text: string, literalText: boolean): string {
  return literalText ? text : addParagraphSpacers(text)
}

/**
 * Length-limit chunking. The literal path uses the newline/length `chunk()`
 * splitter; the rich path uses `splitMarkdownChunks` (markdown-boundary-aware).
 * Pure. `chunk` is passed in so the splitter (moved here as `chunkText`) and
 * this decision stay colocated without a circular gateway import.
 */
export function computeReplyChunks(args: {
  effectiveText: string
  literalText: boolean
  limit: number
  chunkMode: 'length' | 'newline'
}): string[] {
  const { effectiveText, literalText, limit, chunkMode } = args
  return literalText
    ? chunkText(effectiveText, limit, chunkMode)
    : splitMarkdownChunks(effectiveText, limit)
}

/**
 * Oversize-chunk re-split (length-error recovery). A single pre-computed chunk
 * can still exceed the wire cap when `splitMarkdownChunks` hit an indivisible
 * region and emitted it whole (a giant fenced block, a no-boundary blob).
 * Re-split at the hard `RICH_MESSAGE_MAX_CHARS` cap; for a truly indivisible
 * block, fall back to a hard character cut so each delivered piece stays under
 * the wire cap. Byte-identical to the inline `sendChunkResplit` piece
 * computation. Pure.
 */
export function resplitOversizeChunk(piece: string): string[] {
  const subPieces = splitMarkdownChunks(piece, RICH_MESSAGE_MAX_CHARS)
  return subPieces.length > 1 ? subPieces : hardSliceToCap(piece, RICH_MESSAGE_MAX_CHARS)
}

/**
 * Length/newline text splitter (relocated verbatim from gateway.ts). Splits
 * `text` into <= `limit`-char pieces. In `newline` mode it prefers a paragraph
 * break, then a line break, then a space past the halfway point; `length` mode
 * cuts hard at the limit. Pure.
 */
export function chunkText(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
