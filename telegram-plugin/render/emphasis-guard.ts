// Outbound guard against accidental inline-emphasis typesetting from `_`/`*`
// that the model never meant as formatting (issue #3252, sibling of the
// `$…$` currency-math guard in dollar-math-guard.ts).
//
// ── Root cause ───────────────────────────────────────────────────────────
// Since the Bot API 10.1 migration (#2669) every assistant reply is sent to
// Telegram as RAW GFM markdown via `sendRichMessage({ markdown })` — Telegram
// parses the markdown server-side. Telegram's rich GFM parser pairs `_`/`*`
// delimiters into emphasis spans. The agent DELIBERATELY uses `**bold**`,
// `*italic*` and `_italic_` (Ken's rich-formatting directive) — that is a
// wanted feature and MUST survive untouched. But the same characters also
// occur in prose the model never meant to format:
//   - snake_case identifiers — `file_name_here` italicises "name" once two
//     intra-word `_` pair up (and Telegram's `_` pairing is more liberal than
//     strict CommonMark, which does not emphasise intra-word underscores);
//   - inline multiplication — `a*b*c`, `2*3` — where two intra-word `*` pair
//     and italicise the middle factor;
//   - mid-word `_`/`*` in paths / variable names.
// These are the direct sibling of the dollar bug: a delimiter that pairs up
// across prose and typesets a span nobody meant.
//
// ── Fix ──────────────────────────────────────────────────────────────────
// Deterministically break the pairing by backslash-escaping ONLY the clearly-
// accidental delimiters, identified by a single unambiguous signal:
//
//   an INTRA-WORD delimiter — a single `_` or `*` with an ASCII alphanumeric
//   character IMMEDIATELY on BOTH sides (`e_n`, `a*b`, `2_f`, `2*3`).
//
// This signal is chosen because intended emphasis can NEVER match it: an
// intended opener (`*italic*`, `_italic_`) is flanked on its OUTER side by a
// word boundary — whitespace, start-of-string, or punctuation — never by an
// alphanumeric. So an alphanumeric-on-both-sides delimiter is, by
// construction, not the opener or closer of an intended span. `**bold**` /
// `__x__` double runs are excluded for free: the inner neighbour of each `*`
// in `a**b` is another `*` (not alphanumeric), so neither half matches.
//
// What we DELIBERATELY LEAVE ALONE (conservative false-negatives, per the
// "when in doubt, leave it" doctrine inherited from the dollar guard):
//   - Space-flanked operators (`3 * 4`): a whitespace-flanked `*`/`_` is
//     neither left- nor right-flanking under GFM, so it can never open or
//     close emphasis — there is no bug to fix, and escaping it would be pure
//     churn.
//   - Boundary-flanked delimiters (`rm *`, `*.ts`, leading-`_` `_private`):
//     these are INDISTINGUISHABLE from an intended `*glob*` / `_italic_`
//     opener (`*.ts is a glob*` is a legitimate italic). Escaping them would
//     risk breaking intended emphasis — the one thing this guard must never
//     do — so a glob/leading-underscore that pairs into an accidental span is
//     accepted as a rare false-negative rather than risked as a false-positive.
//     (A future arm could target these behind live Telegram UAT; see below.)
//
// Idempotent: the escape is expressed as an intra-word match, so an
// already-escaped `\_`/`\*` has a backslash (not an alphanumeric) immediately
// before the delimiter and therefore never re-matches — running the guard
// twice is a strict no-op. Code spans / fenced code blocks are NEVER touched
// (verbatim), via the same splitCodeSegments logic the dollar guard uses.
//
// ── Where this runs ────────────────────────────────────────────────────────
// Like the dollar guard, this is intended to be invoked from `richMessage()`
// (rich-send.ts) — the single seam every `{ markdown }` wire send funnels
// through. THIS commit only adds the pure function + its test; the seam
// wiring is integrated separately (all guards in one pass) to avoid conflicts.
//
// ── UNVERIFIED (needs live Telegram UAT) ───────────────────────────────────
// Same residual risk as the dollar guard: this relies on Telegram's server-
// side rich GFM parser (a) recognising `\_` / `\*` as escapable ASCII
// punctuation and (b) CONSUMING the backslash so the reader sees a literal
// `_` / `*` and copy-paste yields `file_name` / `a*b` (no stray `\`). This is
// asserted by analogy to the `` ~ = | * _ `` chars `escapeMarkdown`
// (format.ts) already backslash-escapes and that Telegram demonstrably strips.
// Vitest CANNOT cover server-side rendering; a real intra-word `_`/`*` message
// through a live agent must confirm it renders literal (not `\_`, not italic).

// Code-span/fence splitting is shared across all #3252 guards — one source of
// truth in render/code-segments.ts (previously duplicated here).
import { splitCodeSegments } from "./code-segments.js";

/** An intra-word underscore: a single `_` with an ASCII alphanumeric on BOTH
 *  immediate sides (`file_name`, `v2_final`). Intended `_italic_` never
 *  matches — its opener is boundary-flanked on the outer side. The
 *  alphanumeric lookbehind also makes the escape idempotent: an already-
 *  escaped `\_` has `\` (not alnum) before the `_`, so it never re-matches. */
const INTRA_WORD_UNDERSCORE = /(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g;

/** An intra-word asterisk: a single `*` with an ASCII alphanumeric on BOTH
 *  immediate sides (`a*b`, `2*3`). Intended `*italic*` / `**bold**` never
 *  match — italic openers are boundary-flanked, and in a `**` run the inner
 *  neighbour is `*` (not alnum). Idempotent for the same reason as above. */
const INTRA_WORD_ASTERISK = /(?<=[A-Za-z0-9])\*(?=[A-Za-z0-9])/g;

/**
 * Neutralise accidental inline emphasis produced by intra-word `_` / `*`.
 *
 * Operates on the FINAL rendered rich-markdown string (post-`render`). A no-op
 * unless the prose (non-code) content contains at least one intra-word `_` or
 * `*` (an ASCII alphanumeric on both immediate sides). When present, each such
 * delimiter is backslash-escaped so it can never pair into an emphasis span.
 *
 * Intended `**bold**`, `*italic*` and `_italic_` are LEFT UNTOUCHED by
 * construction (their delimiters are boundary-flanked, never intra-word).
 * Code spans / fenced blocks are never touched. Idempotent and deterministic.
 */
export function guardAccidentalEmphasis(text: string): string {
  if (!text.includes("_") && !text.includes("*")) return text;
  const segments = splitCodeSegments(text);

  // NO-OP guard: only rewrite when a real intra-word signal exists in prose.
  let hasSignal = false;
  for (const seg of segments) {
    if (seg.code) continue;
    if (INTRA_WORD_UNDERSCORE.test(seg.text) || INTRA_WORD_ASTERISK.test(seg.text)) {
      hasSignal = true;
      break;
    }
  }
  // Reset lastIndex — the /g regexes above are stateful across .test() calls.
  INTRA_WORD_UNDERSCORE.lastIndex = 0;
  INTRA_WORD_ASTERISK.lastIndex = 0;
  if (!hasSignal) return text;

  return segments
    .map((seg) =>
      seg.code
        ? seg.text
        : seg.text
            .replace(INTRA_WORD_UNDERSCORE, "\\_")
            .replace(INTRA_WORD_ASTERISK, "\\*"),
    )
    .join("");
}
