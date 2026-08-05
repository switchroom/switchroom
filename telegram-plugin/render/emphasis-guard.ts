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
// A SECOND, always-safe arm (added for issue #3464 alongside the line-start
// glued-`#` guard) escapes a `*` that is flanked by WHITESPACE OR A STRING
// BOUNDARY on BOTH immediate sides (`a * b`, ` * `, a bare `*`, a trailing
// `rm *`). Under GFM flanking rules such a `*` is neither left- nor right-
// flanking, so it can NEVER open OR close emphasis; escaping it therefore
// cannot break an intended `*italic*` / `**bold**` (whose delimiters are
// word-adjacent on their INNER side, so never whitespace-flanked on both
// sides). Because this `*` can never pair, the arm fires on a single
// occurrence — it needs no 2+ threshold. Live Telegram UAT for #3464 confirmed
// the non-spec Bot API parser can still surface a stray lone `*` in this
// position, so neutralising it deterministically is the durable fix.
//
// The ONE boundary-flanked position this arm must NOT touch is a line-leading
// `* ` — that is an unordered-list BULLET (`* item`), not an inert operator.
// Escaping it would break `*`-bullets on every outbound message AND (because
// this arm runs before `guardAccidentalHeading`) disarm the glued-`#` fix for
// `* #4382`. See `isLineLeadingBullet`. A lone `*` on its own line has no
// trailing space, is not a bullet, and is still escaped.
//
// What we DELIBERATELY LEAVE ALONE (conservative false-negatives, per the
// "when in doubt, leave it" doctrine inherited from the dollar guard):
//   - Boundary-flanked delimiters with a NON-whitespace neighbour on the other
//     side (`*.ts`, leading-`_` `_private`): these are INDISTINGUISHABLE from
//     an intended `*glob*` / `_italic_` opener (`*.ts is a glob*` is a
//     legitimate italic). Escaping them would risk breaking intended emphasis —
//     the one thing this guard must never do — so a glob/leading-underscore
//     that pairs into an accidental span is accepted as a rare false-negative
//     rather than risked as a false-positive. (The whitespace-on-BOTH-sides
//     form `rm *` is NOT in this class — a `*` with whitespace/boundary on both
//     sides is provably inert, so the new arm above escapes it safely.)
//     `_` in this position is likewise left alone; the boundary-flanked arm is
//     `*`-only.
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

// Segment splitting (code spans / fences AND markdown link destinations /
// autolinks / table rows) is shared across all #3252 guards — one source of
// truth in render/code-segments.ts. Routing through `splitProtectedSegments`
// (not the code-only `splitCodeSegments`) is what makes this guard link-aware:
// an intra-word `_`/`*` inside a URL path (`.../a_b_c`) is STRUCTURAL, not
// prose, and must never be escaped (the link would break). See code-segments.ts.
import { splitProtectedSegments } from "./code-segments.js";

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

/** A `*` flanked by WHITESPACE OR A STRING BOUNDARY on BOTH immediate sides
 *  (`a * b`, ` * `, a bare `*`, `rm *`). Neither left- nor right-flanking under
 *  GFM, so it can never open or close emphasis — escaping it is always safe and
 *  can never touch an intended `*italic*` / `**bold**` (word-adjacent on the
 *  inner side). Idempotent: after escaping, the `*` is preceded by `\` (neither
 *  whitespace nor `^`), so the lookbehind no longer matches. `\n` is whitespace,
 *  so a `*` alone on its own line is covered without a multiline flag.
 *
 *  CRITICAL EXCLUSION — a line-leading `* ` is an unordered-LIST BULLET, not an
 *  inert operator, and MUST NOT be escaped (`isLineLeadingBullet` below). Two
 *  reasons: (a) `*`-bullets are extremely common in replies and escaping the
 *  marker would break the list on EVERY outbound message (an asymmetric
 *  regression — `-`/`+` bullets are untouched); (b) this guard runs BEFORE
 *  `guardAccidentalHeading` in the `guardAccidentalFormatting` pipeline
 *  (rich-send.ts), and the heading guard's `ACCIDENTAL_HEADING_AFTER_MARKER`
 *  needs the LITERAL `*` marker to fire — escaping the marker here would silently
 *  disarm the glued-`#` fix for the `* #4382` case (#3464). A lone `*` on its own
 *  line (`\n*\n`) is NOT a bullet — no trailing space — so it is still escaped. */
const BOUNDARY_FLANKED_ASTERISK = /(?<=^|\s)\*(?=\s|$)/g;

/** True iff the `*` at `starIndex` is a line-leading unordered-list bullet: a
 *  line start (string start or after `\n`) + up to 3 spaces/tabs of indent, then
 *  the `*`, then a space/tab. This is the ONE boundary-flanked position we leave
 *  alone (see BOUNDARY_FLANKED_ASTERISK). Note: a segment that begins mid-line
 *  (right after an inline code span) has its start treated as a line start here,
 *  which errs toward PRESERVING an ambiguous leading `*` — the safe direction,
 *  since wrongly escaping a bullet is the failure this exclusion exists to stop. */
function isLineLeadingBullet(text: string, starIndex: number): boolean {
  // A bullet requires a space/tab immediately after the marker.
  const next = text[starIndex + 1];
  if (next !== " " && next !== "\t") return false;
  // Walk left over up to 3 indent spaces/tabs; the run must reach a line start.
  let i = starIndex - 1;
  let indent = 0;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) {
    if (++indent > 3) return false;
    i--;
  }
  return i < 0 || text[i] === "\n";
}

/** Every unescaped `_` / `*` in prose (the pair-threshold input). An emphasis
 *  span needs a MATCHING pair of the same delimiter, so a delimiter can only
 *  mis-render when 2+ of it exist. The `(?<!\\)` keeps the count idempotent. */
const ANY_UNDERSCORE = /(?<!\\)_/g;
const ANY_ASTERISK = /(?<!\\)\*/g;

/**
 * Neutralise accidental inline emphasis produced by intra-word `_` / `*`.
 *
 * Operates on the FINAL rendered rich-markdown string (post-`render`).
 *
 * ── Threshold: 2+ of the delimiter (finding 4) ────────────────────────────
 * A `_` (or `*`) escape only fires when the prose holds an intra-word
 * occurrence of that delimiter AND 2+ TOTAL of it. Emphasis is a PAIRED
 * construct — a single `_` (or `*`) in the whole message can never form a span,
 * so escaping a lone intra-word delimiter is pure churn that only widens the
 * false-positive surface (a stray `\` if Telegram ever failed to consume it),
 * with zero correctness gain. Requiring 2+ matches the dollar / inline-pairs
 * "a lone delimiter can't pair" doctrine. This is strictly SAFE: any real
 * mis-render needs 2+ delimiters, and when 2+ exist (e.g. `file_name_here`, or
 * an intra-word `file_name` sitting alongside an intended `_italic_` elsewhere —
 * three underscores that Telegram could mis-pair) the intra-word delimiter IS
 * escaped, so no accidental span survives. Only the provably-inert lone-`_`
 * (`file_name` as the ONLY underscore in the message) is now left byte-identical.
 *
 * Intended `**bold**`, `*italic*` and `_italic_` are LEFT UNTOUCHED by
 * construction (their delimiters are boundary-flanked, never intra-word).
 * Code spans / fenced blocks, link destinations and autolinks are never touched
 * (via `splitProtectedSegments`). Idempotent and deterministic.
 */
export function guardAccidentalEmphasis(text: string): string {
  if (!text.includes("_") && !text.includes("*")) return text;
  const segments = splitProtectedSegments(text);

  // NO-OP guard: only rewrite when a real intra-word signal exists in prose AND
  // 2+ of that delimiter exist (so a pair — hence a mis-render — is possible).
  let hasIntraUnderscore = false;
  let hasIntraAsterisk = false;
  let hasBoundaryAsterisk = false;
  let underscoreCount = 0;
  let asteriskCount = 0;
  for (const seg of segments) {
    if (seg.code) continue;
    if (INTRA_WORD_UNDERSCORE.test(seg.text)) hasIntraUnderscore = true;
    if (INTRA_WORD_ASTERISK.test(seg.text)) hasIntraAsterisk = true;
    // Arm only on a boundary-flanked `*` that is NOT a line-leading bullet, so a
    // segment whose only such `*` is a bullet keeps the guard a strict no-op.
    if (!hasBoundaryAsterisk) {
      for (const m of seg.text.matchAll(BOUNDARY_FLANKED_ASTERISK)) {
        if (!isLineLeadingBullet(seg.text, m.index ?? 0)) {
          hasBoundaryAsterisk = true;
          break;
        }
      }
    }
    underscoreCount += seg.text.match(ANY_UNDERSCORE)?.length ?? 0;
    asteriskCount += seg.text.match(ANY_ASTERISK)?.length ?? 0;
  }
  // Reset lastIndex — the /g regexes above are stateful across .test() calls.
  INTRA_WORD_UNDERSCORE.lastIndex = 0;
  INTRA_WORD_ASTERISK.lastIndex = 0;
  BOUNDARY_FLANKED_ASTERISK.lastIndex = 0;

  const armUnderscore = hasIntraUnderscore && underscoreCount >= 2;
  const armAsterisk = hasIntraAsterisk && asteriskCount >= 2;
  // The boundary-flanked `*` can NEVER pair (neither flanking), so no 2+
  // threshold: a single occurrence is escaped on its own.
  const armBoundaryAsterisk = hasBoundaryAsterisk;
  if (!armUnderscore && !armAsterisk && !armBoundaryAsterisk) return text;

  return segments
    .map((seg) => {
      if (seg.code) return seg.text;
      let out = seg.text;
      if (armUnderscore) out = out.replace(INTRA_WORD_UNDERSCORE, "\\_");
      if (armAsterisk) out = out.replace(INTRA_WORD_ASTERISK, "\\*");
      if (armBoundaryAsterisk) {
        out = out.replace(BOUNDARY_FLANKED_ASTERISK, (m, offset: number, str: string) =>
          isLineLeadingBullet(str, offset) ? m : "\\*",
        );
      }
      return out;
    })
    .join("");
}
