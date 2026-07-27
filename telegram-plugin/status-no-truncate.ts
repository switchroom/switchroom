/**
 * Status-card shared constants.
 *
 * Both status surfaces — the main-session agent activity card
 * (`tool-activity-summary.ts`) and the background-worker activity feed
 * (`worker-activity-feed.ts`) — render through the single
 * `renderStatusCard` primitive in `tool-activity-summary.ts`. This module
 * holds the tuning constants that primitive (and its internal helpers)
 * read, so a forked renderer never re-derives them.
 *
 * Wire cap: since the Bot API 10.1 rich-message migration (#2669) every card
 * renders as GFM markdown via `sendRichMessage`, whose limit is
 * `RICH_MESSAGE_MAX_CHARS` (32768), not the legacy 4096 plain-text cap.
 *
 * The former `SWITCHROOM_STATUS_NO_TRUNCATE` feature flag was retired:
 * rolling-window-with-char-budget is now the only behaviour. The per-line
 * cap (`STATUS_LINE_MAX`) and rolling window (`STATUS_ROLLING_LINES`) apply
 * universally on BOTH surfaces; the total char budget
 * (`STATUS_CARD_CHAR_BUDGET`) is the wire-limit backstop.
 */

import { RICH_MESSAGE_MAX_CHARS } from './format.js'

/**
 * Number of trailing narrative/step lines shown in the rolling window.
 * The feed is a fixed-height rolling window: oldest drops off as new arrive.
 * Overflow surfaces a `+N earlier…` header on BOTH surfaces.
 */
export const STATUS_ROLLING_LINES = 5

/**
 * Ceiling on the per-worker recent-step history RETAINED in `row.narrative`
 * (worker-activity-feed.ts) and the deepest trail the worker cards will render.
 *
 * Distinct from `STATUS_ROLLING_LINES` (which governs the 🤖 agent card's
 * window and stays at 5) so raising the worker trail never widens the agent
 * card. Set to 6 because the deterministic per-worker depth curve
 * (`workerHistoryDepth`, tool-activity-summary.ts) peaks at 6 for a lone
 * worker — `max(3, 7 − workerCount)` at `w = 1`. The buffer must retain at
 * least this many lines or the renderer would ask for 6 and only find 5.
 */
export const WORKER_HISTORY_MAX = 6

/**
 * Per-line character cap, applied to every step + child step on BOTH
 * surfaces before HTML-escaping (clip raw → escape last). A line longer
 * than this is truncated with a trailing `…`.
 */
export const STATUS_LINE_MAX = 200

/**
 * The safe char budget for a rendered Telegram status card. The rich-message
 * wire cap is `RICH_MESSAGE_MAX_CHARS` (32768) post-#2669 — the legacy 4096
 * plain-text cap no longer applies on the rich path. We use the constant
 * directly as the backstop.
 *
 * With STATUS_ROLLING_LINES=5 lines each ≤ STATUS_LINE_MAX this backstop
 * effectively never fires in practice, but is kept as a wire-limit safety net.
 */
export const STATUS_CARD_CHAR_BUDGET = RICH_MESSAGE_MAX_CHARS

/**
 * Indent marker for a nested (foreground sub-agent) step line.
 *
 * NOTE: the three leading spaces here are ASCII, which Telegram's server-side
 * markdown parser DROPS — the visible nesting cue on this surface is the `↳`
 * glyph, not the indent. That is a known latent wart, deliberately left alone
 * — it needs its own live render check on the single-worker / agent card,
 * tracked in #3668. It is NOT broken by the #3662 mechanism (nothing here
 * depends on the ASCII run being visible), so it is not fixed here. If #3668
 * ever does make it a real indent, use U+2800 — NOT U+00A0, which was tried in
 * #3662 and renders flat. Do NOT copy this string as the idiom for a real
 * indent.
 *
 * @see WORKER_STEP_INDENT — the U+2800 indent used for actual left-nesting on
 * the combined (2+ worker) card, and the evidence for why ASCII (and U+00A0)
 * cannot work.
 */
export const NESTED_PREFIX = '   ↳ '

/**
 * Left indent for a step line rendered UNDER a worker header on the combined
 * (2+ worker) card — three U+2800 BRAILLE PATTERN BLANK, written as escapes so
 * the bytes are visible in source.
 *
 * ── Why not ASCII, and why not U+00A0 ────────────────────────────────
 * Card bodies reach Telegram as raw GFM markdown (`richMessage` →
 * `sendRichMessage` / `editMessageText({ markdown })`, #2669) and are parsed
 * SERVER-SIDE by a CommonMark/GFM-family parser. Leading ASCII spaces are
 * stripped (and 4+ would open an indented CODE block), so an ASCII indent
 * renders FLAT.
 *
 * #3662 shipped three U+00A0 here on the reasoning that a non-ASCII space is
 * ordinary text content to that parser. That reasoning was an INFERENCE and it
 * was WRONG: the merged fix was inert — the card still rendered flat on a
 * phone. The bytes were never the problem; they reach the Bot API intact
 * (verified by dumping wire bytes out of the real outbound path: `302 240` ×3
 * present at every stage, final string byte-identical to input). Telegram's
 * parser left-trims a leading INLINE whitespace run, and U+00A0 is Unicode
 * whitespace — general category Zs. The #2692/#3229 precedent that motivated
 * U+00A0 covered a materially different shape (a U+00A0-ONLY line inside a
 * paragraph gap, which survives because BLOCK parsing sees it as non-blank),
 * not a U+00A0 run LEADING a content line, which inline left-trim eats.
 *
 * U+2800 works because it is general category So (Symbol, other), NOT Zs: no
 * whitespace-trimming rule — ASCII `\s`, Unicode `White_Space`, or `Zs` — can
 * classify it as whitespace, yet it renders as blank width. That is a category
 * fact rather than another inference about Telegram's parser, and it is ALSO
 * live-verified: on 2026-07-26 four candidates were sent to a real phone in one
 * message — three U+00A0 rendered FLAT (confirming the #3662 failure), three
 * U+2800 INDENTED CORRECTLY, a leading `↳ ` rendered as visible ink (the
 * NESTED_PREFIX idiom), and a leading `· ` was promoted by Telegram into a real
 * list bullet.
 *
 * That last result is why `· ` is unusable, and it is the same reason the
 * guide's other indent idiom, the blockquote (`> `), is unusable: card lines are
 * joined by `stackCardLines`, which promotes EVERY inter-line break to a GFM
 * hard break *because* card lines are never block-structure lines. A `> ` or
 * `· ` prefix breaks that precondition, and the next worker's header line would
 * be absorbed into the quote/list as a lazy continuation.
 *
 * Guard: `worker-feed-coalesce.test.ts` asserts the PROPERTY (the indent is not
 * whitespace under any of the three rules), not just the bytes — a byte-only
 * assertion is what let #3662 ship green and inert.
 */
export const WORKER_STEP_INDENT = '\u2800\u2800\u2800'

/**
 * Line-1 prefix that marks a card as structurally SUBORDINATE to the \ud83e\udd16 agent
 * card (#3820). Worker cards carry it; the agent card never does.
 *
 * `\u2514\u2500` (U+2514 BOX DRAWINGS LIGHT UP AND RIGHT + U+2500 BOX DRAWINGS LIGHT
 * HORIZONTAL) is ordinary ink to Telegram's server-side GFM parser: it is not
 * a line-start block trigger (`#`, `>`, `-`/`+`/`*`, `N.` \u2014 see
 * render/line-start-guard.ts for the full trigger set), so it can neither be
 * promoted to a list/quote/heading nor left-trimmed the way a leading
 * whitespace run is (the #3662 failure documented on WORKER_STEP_INDENT).
 *
 * LENGTH INVARIANT: exactly the same length as `SUBORDINATE_LINE_INDENT`, so
 * the char-budget arithmetic in `fitCardToBudget` charges one flat per-line
 * cost instead of special-casing line 1. `status-accent.test.ts` asserts it.
 */
export const SUBORDINATE_HEADER_PREFIX = '\u2514\u2500 '

/**
 * Left indent applied to EVERY line of a subordinate (worker) card after
 * line 1 \u2014 the whole card block sits one level in from the agent card's left
 * margin, so "parent vs child" is readable from the block's SHAPE at a glance
 * on a phone, not from reading its label (#3820).
 *
 * Same U+2800 run as `WORKER_STEP_INDENT` and for the same live-verified
 * reason (category So, not Zs \u2192 survives Telegram's inline left-trim; ASCII
 * spaces and U+00A0 both render flat). Aliased rather than re-declared so the
 * two indents can never drift to different glyphs.
 *
 * On the combined (2+ worker) card this composes with `WORKER_STEP_INDENT`:
 * chrome / row headers land at one level, their steps at two.
 */
export const SUBORDINATE_LINE_INDENT = WORKER_STEP_INDENT

/**
 * Apply subordinate-card nesting to a card's pre-rendered lines: line 1 gets
 * `SUBORDINATE_HEADER_PREFIX`, every later line gets `SUBORDINATE_LINE_INDENT`.
 *
 * Prefixes go OUTSIDE the markdown spans (lines arrive already wrapped in
 * `**` / `_` / `~~`), exactly like `renderStepFeed`'s `indent` parameter, so a
 * prefix can never land inside an emphasis run and break it.
 *
 * Pure; returns a new array. Empty in \u2192 empty out.
 */
export function nestSubordinateCardLines(lines: string[]): string[] {
  return lines.map((line, i) =>
    i === 0 ? `${SUBORDINATE_HEADER_PREFIX}${line}` : `${SUBORDINATE_LINE_INDENT}${line}`,
  )
}
