// Outbound guard against accidental LINE-START BLOCK CONSTRUCTS (issue #3252,
// sibling of dollar-math-guard.ts).
//
// ── Root cause ───────────────────────────────────────────────────────────
// Since the Bot API 10.1 migration (#2669) every assistant reply is sent to
// Telegram as RAW GFM markdown via `sendRichMessage({ markdown })`. Telegram
// parses that markdown server-side with a CommonMark/GFM-family parser. That
// means a line of ordinary PROSE that merely happens to START with a markdown
// block-construct trigger (`#`, `>`, `-`/`+`/`*`, or `N.`) can be silently
// promoted to a heading / blockquote / bullet / ordered-list item the model
// never intended:
//   "> 50% of users"  → blockquote        ">2x faster" → blockquote
//   "# of items"      → heading           "#1 priority" → (see below)
//   "- 5 degrees"     → bullet            "2026. was a great year" → ol item
//
// ── Why this is the HARD, AMBIGUOUS guard family ─────────────────────────
// Unlike the `$…$` currency case (where math typesetting of a two-dollar span
// is NEVER wanted), the agent DELIBERATELY emits headings, bullets, ordered
// lists and blockquotes — Ken's rich-formatting directive treats them as a
// wanted feature. The SAME leading character means "format this" (intended)
// or "literal prose" (accidental) depending purely on authorial intent, which
// is not recoverable from the bytes. A blanket line-start escape would DESTROY
// intended formatting and is unacceptable. So this guard is deliberately
// CONSERVATIVE: it escapes ONLY the narrow sub-patterns that are unmistakably
// accidental and can be disambiguated DETERMINISTICALLY from the byte stream,
// and it leaves every plausibly-intended construct byte-for-byte untouched.
// Everything that cannot be made safe is DEFERRED (see the block comment on
// `escapeAccidentalLineStart` and guard-linestart-note.md), NOT guessed at.
//
// ── What this guard ACTUALLY escapes (the safe subset) ───────────────────
//   1. Blockquote comparison-operator: a line-start `>` glued DIRECTLY to a
//      digit or `=` (`>2x`, `>50%`, `>=3`). An INTENDED blockquote is always
//      written `> ` WITH a space; `>` glued to a digit/`=` is a "greater than"
//      comparison in prose, never a blockquote. Escaping only the no-space,
//      digit/`=`-adjacent form leaves every real `> quoted line` untouched.
//   2. Ordered-list with a 4+ digit "number": a line starting `2026. ` /
//      `1999) ` — i.e. a YEAR or other 4+ digit integer followed by `.`/`)`
//      and a space. No real numbered list is authored starting at item 2026;
//      4+ digit leading integers are effectively always accidental years/
//      quantities. Real lists (`1.`–`999.`) are LEFT ALONE.
// Both are backslash-escaped (`\>`, `2026\.`) exactly like the dollar guard —
// `>`, `.`, `)` are ASCII punctuation, escapable per CommonMark's "any ASCII
// punctuation may be backslash-escaped" rule; Telegram's rich parser strips
// the backslash the same way `escapeMarkdown` relies on for `~ = | * _`.
//
// ── Accidental heading (`#3460`, `#foo`) — guarded by guardAccidentalHeading ─
//   Telegram's Bot API rich-markdown parser is NON-spec: it promotes ANY
//   line-leading `#{1,6}` run to a heading even WITHOUT the CommonMark-required
//   trailing space (`#3460 done` renders as a huge heading). This is
//   deterministically disambiguable: a `#{1,6}` run followed by a space,
//   another `#`, or end-of-line is an INTENDED heading (or ambiguous) and is
//   LEFT ALONE; a run glued to a non-space, non-`#` char (`#3460`, `#foo`,
//   `###x`) is the accidental Telegram-only heading and IS escaped. See
//   `guardAccidentalHeading` below — it mirrors the render.ts:escapeLineLeadingHash
//   fix (#3306) but runs at the universal wire seam, independent of the
//   SWITCHROOM_RICH_RENDER kill-switch, so cards/banners/status/approval sends
//   (which bypass the rich renderer) are also covered.
//
// ── What is DEFERRED (left to the rich-formatting workstream) ────────────
//   • Bullet lists `-`/`+`/`*` + space (`- 5 degrees`): genuinely ambiguous
//     with the heavily-used bullet construct; the glued form `-5` (no space)
//     is not a list item → already literal → no guard needed. Escaping the
//     spaced form would eat intended bullets, so the whole family is deferred.
//   • Ordered-list with 1–3 digit numbers (`1. `, `42. `): ambiguous with a
//     real numbered list. Decimals (`3.14`) have no space after the dot → not
//     a list item → already literal.
//
// ── Where this runs ──────────────────────────────────────────────────────
// Same seam as the dollar guard: `richMessage()` (rich-send.ts) — the ONE
// adapter every `{ markdown }` wire send funnels through. Integration of this
// function into that seam is done SEPARATELY by the integrator; this file only
// exports the pure transform + its helpers. `plain`-mode degradations bypass
// `richMessage` (no markdown parsing) and are correctly untouched.
//
// Idempotent: an already-escaped `\>` / `2026\.` no longer matches the
// accidental patterns (the leading char is now `\`), so re-running is a strict
// no-op. Code spans / fenced code blocks and 4-space indented code lines are
// NEVER touched.
//
// ── Telegram-parser assumptions requiring live UAT (see note) ────────────
// Vitest cannot cover server-side Telegram rendering. The two claims this
// guard rests on — (a) Telegram promotes `>2x` (no space) and `2026. ` to
// blockquote/ordered-list, and (b) it CONSUMES the escaping backslash so the
// reader sees a literal `>` / `.` (not `\>` / `\.`) — are asserted by analogy
// to CommonMark + the `escapeMarkdown` chars Telegram demonstrably strips.
// Both need a live round-trip before merge. See guard-linestart-note.md.

// Segment splitting is shared across all #3252 guards — one source of truth in
// render/code-segments.ts. `splitProtectedSegments` skips code spans/fences AND
// link destinations / autolinks / GFM table rows verbatim.
import { splitProtectedSegments } from "./code-segments.js";

/** Line-start `>` glued directly to a digit or `=` — the "greater than"
 *  comparison-operator prose that Telegram wrongly quotes. NOT matched when a
 *  space follows the `>` (that is an intended blockquote). */
const ACCIDENTAL_BLOCKQUOTE = /^>[0-9=]/;

/** Line-start 4+ digit integer followed by `.`/`)` then a space or end-of-line
 *  — a year/quantity Telegram wrongly promotes to an ordered-list item. Real
 *  lists (1–3 digit markers) are excluded by the `{4,}` bound. */
const ACCIDENTAL_ORDERED_LIST = /^(\d{4,})([.)])(\s|$)/;

/**
 * Escape the accidental block-construct trigger at the start of ONE line
 * (the string must NOT contain a newline). Applies only when the line is a
 * true line start (the caller guarantees this). A no-op unless the line begins
 * with one of the narrow, deterministically-accidental patterns above.
 *
 * Lines indented 4+ spaces are an indented-code context in CommonMark and are
 * left verbatim.
 */
function escapeAccidentalLineStart(line: string): string {
  const indent = /^ */.exec(line)![0];
  // 4+ leading spaces => indented code block; never a block construct here.
  if (indent.length >= 4) return line;
  const rest = line.slice(indent.length);

  // 1. Accidental blockquote (`>2x`, `>50%`, `>=3`). Idempotent: an already
  //    escaped `\>` starts with `\`, so `rest` no longer starts with `>`.
  if (ACCIDENTAL_BLOCKQUOTE.test(rest)) {
    return indent + "\\" + rest;
  }

  // 2. Accidental ordered-list from a 4+ digit number (`2026. was`).
  //    Idempotent: `2026\.` has a `\` where the delimiter was, so the
  //    `(\d{4,})([.)])` shape no longer matches.
  const ol = ACCIDENTAL_ORDERED_LIST.exec(rest);
  if (ol) {
    const digits = ol[1];
    const delim = ol[2];
    return indent + digits + "\\" + delim + rest.slice(digits.length + 1);
  }

  return line;
}

/**
 * Neutralise accidental line-start block constructs (heading / blockquote /
 * bullet / ordered-list promotion of prose) on the FINAL rendered rich-markdown
 * string (post-`render`). CONSERVATIVE and deterministic: escapes ONLY the two
 * unmistakably-accidental patterns documented above and leaves all plausibly
 * intended formatting untouched. Code spans / fenced blocks / 4-space indented
 * code are never touched. Idempotent and a strict no-op absent a real signal.
 */
export function guardAccidentalBlockConstructs(text: string): string {
  // Cheap short-circuit: no `>` and no plausible 4+ digit list marker => no-op.
  if (!text.includes(">") && !/\d{4,}[.)]/.test(text)) return text;

  const segments = splitProtectedSegments(text);
  let out = "";
  // True at text start and immediately after any emitted `\n`.
  let atLineStart = true;

  for (const seg of segments) {
    if (seg.code) {
      out += seg.text;
      // Code spans never contain a newline; fenced blocks end on backticks, not
      // a newline. Either way the next char is on the same line unless the code
      // text itself ends with a newline.
      atLineStart = seg.text.endsWith("\n");
      continue;
    }
    const lines = seg.text.split("\n");
    for (let k = 0; k < lines.length; k++) {
      // A prose segment can begin MID-LINE (right after an inline code span),
      // so its first line is a real line start only if the running flag says so.
      const lineIsAtStart = k === 0 ? atLineStart : true;
      const processed = lineIsAtStart ? escapeAccidentalLineStart(lines[k]) : lines[k];
      out += processed;
      if (k < lines.length - 1) out += "\n";
    }
    atLineStart = seg.text.endsWith("\n");
  }

  return out;
}

/** Line-start `#{1,6}` run glued DIRECTLY to a non-space, non-`#` char — the
 *  Telegram-non-spec accidental heading (`#3460`, `#foo`, `###x`). The negative
 *  lookahead `(?=[^\s#])` requires a following char that is neither whitespace,
 *  a `#`, nor end-of-line, so an intended `# Title` / `## Sub` (space-delimited)
 *  and a bare `#` / `##` (end-of-line) are NEVER matched. Up to 3 leading spaces
 *  are permitted (4+ is indented code, and the `{0,3}` bound then leaves a space
 *  before the `#`, so it correctly does not match). Only the first `#` of the run
 *  is backslash-escaped, which is sufficient to stop Telegram promoting the line
 *  to a heading. Idempotent: an already-escaped `\#3460` starts with `\`, so the
 *  `#{1,6}` no longer sits at the (post-indent) line start. */
const ACCIDENTAL_HEADING = /^([ \t]{0,3})(#{1,6})(?=[^\s#])/;

/** Same accidental-heading run, but sitting AFTER one or more line-start LIST or
 *  BLOCKQUOTE markers on the SAME line (`- #4382`, `* #4382`, `+ #4382`,
 *  `1. #4382`, `> #4382`, and nested combinations like `- > #4382`) — issue
 *  #3464. `guardAccidentalHeading`'s original `^`-anchored pattern only sees a
 *  `#` at the true (post-indent) line start, so a `#` glued after a marker slips
 *  through and Telegram's non-spec Bot API parser promotes it to a heading just
 *  as it does at a bare line start (confirmed by live UAT for #3464). The prefix
 *  is `([ \t]{0,3}<marker>+)`: up to 3 leading spaces, then one-or-more markers,
 *  each an unordered bullet (`-`/`*`/`+`) or short ordered marker (`1.`/`1)`,
 *  1–3 digits) followed by ≥1 space/tab, or a blockquote `>` with optional
 *  spaces. Group 1 captures the WHOLE prefix so the replacement re-emits it
 *  verbatim and escapes ONLY the first `#` of group 2. The same `(?=[^\s#])`
 *  lookahead keeps a real nested heading (`- # Heading`, space AFTER the `#`)
 *  and a bare `#`/`##` untouched. Idempotent: after escaping, the `#` sits
 *  behind a `\` (`- \#4382`), so the `(#{1,6})` no longer follows the prefix. */
const ACCIDENTAL_HEADING_AFTER_MARKER =
  /^([ \t]{0,3}(?:(?:[-*+]|\d{1,3}[.)])[ \t]+|>[ \t]*)+)(#{1,6})(?=[^\s#])/;

/**
 * Escape the accidental heading trigger at the start of ONE line (the string
 * must NOT contain a newline; the caller guarantees a true line start). A no-op
 * unless the line begins with a `#{1,6}` run glued to a non-space, non-`#` char
 * — either at the true line start (`#4382`) or immediately after one or more
 * line-start list/blockquote markers (`- #4382`, `> #4382`, `1. #4382`, #3464).
 * The two patterns are mutually exclusive on any given line (the bare one needs
 * a `#` right after the indent; the marker one needs a marker first), so running
 * both replaces can never double-escape.
 */
function escapeAccidentalHeadingLine(line: string): string {
  return line
    .replace(ACCIDENTAL_HEADING, "$1\\$2")
    .replace(ACCIDENTAL_HEADING_AFTER_MARKER, "$1\\$2");
}

/**
 * Neutralise accidental line-start HEADING promotion (`#3460 done` → giant
 * heading) on the FINAL rendered rich-markdown string. Telegram's Bot API
 * parser promotes a line-leading `#{1,6}` run to a heading even without the
 * CommonMark-required trailing space; this escapes ONLY the space-less,
 * non-`#`-adjacent form and leaves genuine `# Title` / `## Sub` headings
 * untouched. Code spans / fenced blocks / link destinations / table rows are
 * never touched (shared `splitProtectedSegments`). Idempotent and a strict
 * no-op absent a real signal. Mirrors render.ts:escapeLineLeadingHash (#3306)
 * but runs at the universal wire seam, so it also covers the card / banner /
 * status / approval sends that bypass the rich renderer.
 */
export function guardAccidentalHeading(text: string): string {
  // Cheap short-circuit: no `#` at all => no-op.
  if (!text.includes("#")) return text;

  const segments = splitProtectedSegments(text);
  let out = "";
  // True at text start and immediately after any emitted `\n`.
  let atLineStart = true;

  for (const seg of segments) {
    if (seg.code) {
      out += seg.text;
      atLineStart = seg.text.endsWith("\n");
      continue;
    }
    const lines = seg.text.split("\n");
    for (let k = 0; k < lines.length; k++) {
      // A prose segment can begin MID-LINE (right after an inline code span),
      // so its first line is a real line start only if the running flag says so.
      const lineIsAtStart = k === 0 ? atLineStart : true;
      const processed = lineIsAtStart ? escapeAccidentalHeadingLine(lines[k]) : lines[k];
      out += processed;
      if (k < lines.length - 1) out += "\n";
    }
    atLineStart = seg.text.endsWith("\n");
  }

  return out;
}
