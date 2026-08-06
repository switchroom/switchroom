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
 * Ephemeral (non-turn-continuing) Telegram surface tools (switchroom#3513
 * follow-up, MF4). A text block followed ONLY by tools in this set is still the
 * TERMINAL answer for backstop-coalescing purposes — these tools carry no
 * model-authored answer text and are the only ones plausibly fired AFTER a
 * terminal answer (answer, then react / typing / edit). Everything NOT in
 * this set — work / deliverable tools (download_attachment, get_recent_messages,
 * send_checklist, ask_user, …) and every non-telegram tool (retain / read /
 * bash / web / …) — is turn-CONTINUING: a text block a real tool followed is
 * intra-turn narration, never the terminal answer.
 *
 * Authoritative source: `bridge/bridge.ts` TOOL_SCHEMAS. `reply` / `stream_reply`
 * are deliberately absent — they are handled by the `replyCalled` gate, not this
 * list. `progress_update` is NOT a bridge tool (it is a runtime-metrics /
 * sub-agent parent-card send site) and never appears as a turn `tool_use`, so it
 * is intentionally excluded.
 */
export const EPHEMERAL_TOOLS = new Set([
  'react',
  'send_typing',
  'delete_message',
  'edit_message',
])

/**
 * True iff `name` is an ephemeral Telegram surface tool (see EPHEMERAL_TOOLS).
 * Strips the host-chosen `mcp__<key>__` MCP prefix (matching `tool-names.ts`'s
 * `stripPrefix`) so it works regardless of the registration key
 * (`switchroom-telegram`, `clerk-telegram`, a fork's custom key).
 *
 * @param {string | null | undefined} name
 * @returns {boolean}
 */
export function isEphemeralTool(name) {
  if (typeof name !== 'string') return false
  const suffix = name.replace(/^mcp__[^_].*?telegram__/, '')
  return EPHEMERAL_TOOLS.has(suffix)
}

/**
 * The deterministic, model-discipline-free backstop coalescer (switchroom#3513
 * follow-up). Selects the ONE text a per-turn backstop (turn-flush E1/E2,
 * captured-prose bridge E3, outbox sweep E4) should deliver from all captured /
 * scanned assistant text blocks of a turn.
 *
 * `blocks` is in source order; each `{ text, followedByToolUse }` carries the
 * per-TURN structural provenance (`followedByToolUse === true` ⇔ a
 * turn-CONTINUING tool_use — a non-ephemeral, non-reply tool — arrived after
 * this block, ANYWHERE later in the turn, not only later in its own message).
 * `undefined` = provenance unknown → treated as NOT followed (fail OPEN: deliver,
 * never drop).
 *
 * Rules:
 *  1. TERMINAL RUN — the maximal SUFFIX of non-empty blocks with
 *     `followedByToolUse !== true`. Non-empty → return its `\n\n` join. A
 *     legitimate multi-paragraph answer written as several consecutive terminal
 *     blocks stays whole (no truncation; #3237/#2798 parity).
 *  2. UNCONDITIONAL structural suppression — every block with
 *     `followedByToolUse === true` is excluded from the terminal run, with NO
 *     length gate and NO opener/wording heuristic. "A real tool followed" is a
 *     hard structural fact the turn continued past this block.
 *  3. EMPTY-TERMINAL corner — if the terminal run is empty (the LAST non-empty
 *     block was itself tool-followed), return that last block IFF its trimmed
 *     length ≥ SUBSTANTIVE_MIN_CHARS, else null. A short tool-followed fragment
 *     is narration/a closer → null routes to the re-prompt ladder, never silence.
 *
 * @param {ReadonlyArray<{ text: string, followedByToolUse?: boolean }>} blocks
 * @returns {{ text: string } | null}  null = nothing to deliver.
 */
export function selectBackstopDelivery(blocks) {
  const nonEmpty = (Array.isArray(blocks) ? blocks : [])
    .map((b) => ({
      text: typeof b?.text === 'string' ? b.text.trim() : '',
      followedByToolUse: b?.followedByToolUse,
    }))
    .filter((b) => b.text.length > 0)
  if (nonEmpty.length === 0) return null

  // Rule 1 + 2: the terminal SUFFIX run of non-tool-followed blocks.
  const run = []
  for (let i = nonEmpty.length - 1; i >= 0; i--) {
    if (nonEmpty[i].followedByToolUse === true) break
    run.unshift(nonEmpty[i].text)
  }
  if (run.length > 0) return { text: run.join('\n\n') }

  // Rule 3: empty terminal — the last block was tool-followed. Deliver it only
  // if it clears the substantive floor; otherwise it is a narration fragment.
  const last = nonEmpty[nonEmpty.length - 1]
  if (last.text.length >= SUBSTANTIVE_MIN_CHARS) return { text: last.text }
  return null
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
