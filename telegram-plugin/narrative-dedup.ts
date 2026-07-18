/**
 * Reducer-side narrative dedup gate (the correctness core of the
 * JSONL-text-narrative primitive).
 *
 * A `text` / `sub_agent_text` JSONL block is one of two things:
 *
 *   1. DRAFT-THEN-SEND — the model composing its answer just before it
 *      calls `reply` / `stream_reply` with near-identical text. Surfacing
 *      it would double-print the answer (once as a transient narrative
 *      step, once as the canonical reply). It MUST be suppressed.
 *   2. WORKING NARRATION — the agent's own commentary that is never sent
 *      to the user ("On it. Let me find the repo…", "Sent. Waiting on the
 *      build…"). It SHOULD be surfaced as a transient liveness step.
 *
 * A projector sees one JSONL line at a time and cannot know whether a
 * later line is a reply tool_use, so the SHOW/SUPPRESS decision is a
 * stateful, one-step-deferred decision made reducer-side (the gateway for
 * the main agent, the subagent-watcher for sub/worker). This module is the
 * pure, fully-unit-testable kernel of that decision — no I/O, no state of
 * its own; the caller owns the `pendingNarrative` slot.
 *
 * The threshold heuristic deliberately matches the spirit of the #546
 * outbound dedup (trim + lowercase + whitespace-collapse) so a draft and
 * its reply compare equal the same way #546 considers them the same
 * message.
 */

/** Tool suffixes whose `input.text` IS the canonical answer surface. */
export const REPLY_TOOLS = new Set(['reply', 'stream_reply'])

/**
 * Strip this plugin's `mcp__<server-key>__telegram__` prefix, matched by the
 * same key-agnostic regex `computeLabel` / `isTelegramReplyTool` use so renames
 * and forks (`clerk-telegram`, `switchroom-telegram`, …) all resolve. A bare
 * name (no prefix) is returned unchanged.
 */
const TELEGRAM_TOOL_PREFIX_RE = /^mcp__[^_].*?telegram__/

/**
 * Prefix-aware membership test for {@link REPLY_TOOLS}.
 *
 * Production jsonl carries the fully-qualified MCP tool name
 * (`mcp__switchroom-telegram__stream_reply`), so a bare `REPLY_TOOLS.has(name)`
 * is always false in prod and the draft-then-send suppression path silently
 * goes inert (#3231). Bare names ('reply' / 'stream_reply') can still appear
 * from non-MCP sources, so both wire shapes must match: strip the telegram MCP
 * prefix (a no-op for bare names) then test the suffix against REPLY_TOOLS.
 */
export function isReplyTool(toolName: string | null | undefined): boolean {
  if (typeof toolName !== 'string') return false
  return REPLY_TOOLS.has(toolName.replace(TELEGRAM_TOOL_PREFIX_RE, ''))
}

/**
 * Normalize for prefix comparison: strip markdown/HTML-ish emphasis,
 * heading and quote marks, collapse whitespace, lowercase. Mirrors the
 * #546 outbound-dedup normalization so a markdown-decorated draft and its
 * plain reply compare equal.
 */
export function normalizeNarrative(s: string): string {
  return s
    .replace(/[*_`>#~]/g, '') // markdown emphasis / heading / quote marks
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Longest-common-prefix ratio over the SHORTER of the two normalized strings. */
export function prefixSimilarity(a: string, b: string): number {
  const x = normalizeNarrative(a)
  const y = normalizeNarrative(b)
  if (x.length === 0 || y.length === 0) return 0
  const n = Math.min(x.length, y.length)
  let i = 0
  while (i < n && x[i] === y[i]) i++
  return i / n
}

/**
 * The single tunable. Longest-common-PREFIX ratio (not Levenshtein) is
 * deliberate: a draft shares a long head with the sent answer even when the
 * model trims a trailing sentence before sending. 0.8 over the shorter
 * string tolerates that trim while rejecting the "Sent. Waiting…" +
 * different-reply case (short string, near-zero shared prefix). Exported so
 * the test pins it — a silent retune breaks a test.
 */
export const DRAFT_SUPPRESS_THRESHOLD = 0.8

/** TRUE ⇒ this text block is a draft-then-send of `replyText`; SUPPRESS it. */
export function isDraftOfReply(textBlock: string, replyText: string): boolean {
  return prefixSimilarity(textBlock, replyText) >= DRAFT_SUPPRESS_THRESHOLD
}
