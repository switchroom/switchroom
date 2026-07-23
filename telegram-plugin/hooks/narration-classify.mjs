/**
 * narration-classify.mjs — the ONE shared trailing-text narration classifier
 * (switchroom#3513).
 *
 * ## Why this file exists (correction 2)
 * Before #3513 the narration heuristic existed as TWO hand-synced copies — the
 * TS gateway side (`turn-flush-safety.ts` `NARRATION_OPENER` / `isNarrationBlock`
 * / `selectFlushDeliveryText`) and the unbundled Stop-hook `.mjs` side
 * (`silent-end-scan.mjs`, with a "MUST stay in sync" comment). Two independent
 * classifiers judging the SAME trailing assistant text is exactly the drift
 * hazard that let intent-narration ("Now checking the gateway logs…") leak into
 * a delivered Telegram message. This module is the single source of truth,
 * authored as a raw `.mjs` (JS + JSDoc types) so it can be imported by BOTH:
 *   - the unbundled Stop-hook `.mjs` (which can only import sibling `.mjs` +
 *     node builtins — see `silent-end-scan.mjs`), and
 *   - the bundled gateway TS (`turn-flush-safety.ts`) via `.mjs` interop (the
 *     same pattern `tool-activity-summary.ts` already uses to import
 *     `hooks/tool-label-pretool.mjs`).
 *
 * ## The primary rule — STRUCTURAL, substance-gated (corrections 3 + 4)
 * The wording heuristic (`isNarrationBlock`) is provably incomplete (this bug is
 * its counterexample). The deterministic, wording-independent discriminator is
 * STRUCTURAL: did a `tool_use` follow this text block in the model's message?
 * A narration preamble is drafted, then the model ACTS (a tool follows it); a
 * terminal answer is not followed by a tool. `followedByToolUse === true` is a
 * DEMOTION signal, NOT an unconditional narration verdict — it is gated by the
 * substantive floor / opener heuristic so a SUBSTANTIVE real answer that merely
 * precedes a tool call (the model answers, then reacts / pins / edits) still
 * delivers. Only a short OR narration-shaped block that a tool followed is
 * treated as non-deliverable. `followedByToolUse !== true` (false or absent) is
 * never structural narration here — the caller applies the opener heuristic as a
 * residual tie-breaker where it has no provenance.
 */

import { createHash } from 'node:crypto'

/**
 * Substantive-answer floor (chars, trimmed). The same bar the codebase uses
 * everywhere (`final-answer-detect.ts` `FINAL_ANSWER_MIN_CHARS`,
 * `turn-flush-safety.ts` `FLUSH_SUBSTANTIVE_MIN_CHARS`) to recognise "this block
 * is a real answer, not a short narration/closer".
 */
export const SUBSTANTIVE_MIN_CHARS = 200

/**
 * Narration heuristic: a block that OPENS with a first-person "about to do X"
 * phrase the model emits BEFORE composing its real answer ("Let me check…",
 * "I'll look it up…", "Now let me…"). Deliberately NOT length-based.
 */
export const NARRATION_OPENER =
  /^(let me\b|lemme\b|i'?ll\b|i will\b|i am going to\b|i'?m going to\b|i'?m about to\b|going to\b|first,?\s+(?:let me|i'?ll|i will)\b|now,?\s+(?:let me|i'?ll|i will)\b|next,?\s+(?:let me|i'?ll|i will)\b|let'?s\b)/i

/**
 * A NON-terminal progress line that opens with a gerund and trails into an
 * ellipsis/colon: "Checking now…", "Pulling the numbers:". A single short line
 * (under the substantive floor, no internal paragraph) ending in `…`/`...`/`:`.
 */
export const NARRATION_TRAILER = /(?:\.{3}|…|:)\s*$/

/**
 * @param {string} block
 * @returns {boolean}
 */
export function isTrailingNarrationLine(block) {
  const t = typeof block === 'string' ? block.trim() : ''
  if (t.length === 0 || t.length >= SUBSTANTIVE_MIN_CHARS) return false
  if (t.includes('\n')) return false
  return NARRATION_TRAILER.test(t)
}

/**
 * The wording heuristic (residual tie-breaker for provenance-less callers).
 * @param {string} block
 * @returns {boolean}
 */
export function isNarrationBlock(block) {
  const s = typeof block === 'string' ? block : ''
  return NARRATION_OPENER.test(s.trimStart()) || isTrailingNarrationLine(s)
}

/**
 * The #3513 PRIMARY rule: is this block structural intra-turn narration?
 *
 * TRUE only when a `tool_use` followed the block in the model's message
 * (`followedByToolUse === true`) AND the block also reads as narration OR falls
 * below the substantive floor. This preserves the #3237 asymmetry:
 *   - `followedByToolUse === true`  → demotion, GATED by substance/heuristic
 *     (a substantive non-narration block followed by react/pin/typing/edit is
 *     NOT structural narration → still delivers).
 *   - `followedByToolUse === false` → never structural narration (a terminal
 *     block; nothing followed it).
 *   - `followedByToolUse` absent    → never structural narration here; the
 *     caller applies `isNarrationBlock` as a residual tie-breaker.
 *
 * @param {string} text
 * @param {boolean | undefined} followedByToolUse
 * @returns {boolean}
 */
export function isStructuralNarration(text, followedByToolUse) {
  if (followedByToolUse !== true) return false
  const t = typeof text === 'string' ? text.trim() : ''
  if (t.length === 0) return true
  return isNarrationBlock(t) || t.length < SUBSTANTIVE_MIN_CHARS
}

/**
 * The durable shown-ledger key for a block: sha256 of its trimmed text. Matches
 * the hash both the ephemeral-paint writer and the backstop-delivery readers
 * compute, so a marked block is recognised across processes (#3513 §4).
 *
 * @param {string} text
 * @returns {string}
 */
export function ledgerHashHex(text) {
  return createHash('sha256').update(String(text ?? '').trim(), 'utf8').digest('hex')
}
