// Outbound guard against ACCIDENTAL inline-pair typesetting — the sibling of the
// dollar-math guard (#3252 follow-up). Mirrors that guard's doctrine exactly.
//
// ── Root cause (same seam, same class of bug) ─────────────────────────────
// Since the Bot API 10.1 migration (#2669) every assistant reply is sent to
// Telegram as RAW GFM markdown via `sendRichMessage({ markdown })`; Telegram
// parses it server-side. Telegram's rich GFM parser honours several PAIRED
// inline-formatting delimiters that ordinary prose can form by accident:
//
//   • `~text~` / `~~text~~`  → strikethrough
//   • `==text==`             → highlight / "marked" (Telegram 10.1 supports it)
//   • `||text||`             → spoiler
//   • `` `text` ``           → code span
//
// switchroom's `escapeMarkdown` (format.ts) backslash-escapes exactly these
// trigger chars (`` ` `` `*` `_` `~` `=` `|` `[` `]`) for DYNAMIC card content —
// which is our IN-REPO EVIDENCE that Telegram's rich parser genuinely INTERPRETS
// `~ = |` and `` ` `` as formatting (otherwise escaping them would be pointless).
// But the assistant's free-form reply body is NOT run through escapeMarkdown
// (that would nuke the agent's DELIBERATE `~~strike~~` / `||spoiler||` /
// `` `code` `` formatting — Ken's rich-formatting directive). So an ordinary
// reply like "trims it to ~10 units, down from ~20" can accidentally form a
// `~…~` strikethrough span across "10 units, down from ".
//
// ── Which of the four we actually guard (and why) ─────────────────────────
// Ranked by real-world likelihood in normal agent prose:
//
//  1. TILDE  `~`  — HIGH. Approximation tildes on numbers ("~10", "~$5M",
//     "~.5s") are extremely common in agent prose and two of them form a
//     strikethrough pair. GUARDED.
//  2. MARK   `==` — MEDIUM. Equality/comparison operators in prose ("x==y",
//     "if a==b and c==d") sit word-flanked and two of them form a highlight
//     span. GUARDED.
//  3. SPOILER `||` — LOW. Logical-OR in prose ("a||b || c||d"). Rare but the
//     same word-flanked shape, same fix. GUARDED (cheap, precise).
//  4. BACKTICK `` ` `` — SKIPPED as effectively-literal. A TRULY unpaired
//     backtick renders LITERALLY per CommonMark (a backtick run with no
//     equal-length closer is left as text — this is exactly what
//     `findClosingBackticks` returns -1 for, so `splitCodeSegments` already
//     leaves it in a PROSE segment untouched). The only case a stray backtick
//     "mis-renders" is an ODD count where an earlier pair swallows prose into a
//     code span — but that is INDISTINGUISHABLE from an intended `` `code` ``
//     span plus a separate literal backtick, and the agent uses `` `code` ``
//     deliberately. Per the false-negative-beats-false-positive rule we leave
//     it. (Neutralising it would risk mangling real code spans, which the task
//     forbids.) See the design note for the full verification.
//
// ── The heuristic — precision over recall, never touch intended formatting ──
// The hard constraint: the agent DELIBERATELY emits `~~strike~~`, `||spoiler||`
// and `` `code` `` as wanted formatting. We must neutralise ONLY the
// unmistakably-accidental shape and leave every intended span byte-identical.
//
//  • TILDE: a `~` is accidental only when it is DIGIT-ADJACENT — immediately
//    followed by an optional `$`/`.` and a digit (`~10`, `~$5`, `~.5`). Intended
//    strikethrough wraps WORDS (`~~deprecated~~`, `~struck~`) → its tildes are
//    letter-adjacent, never matched. We arm only when 2+ such digit-adjacent
//    tildes exist in prose (one alone can never form a pair), then escape them.
//    This also catches the inner tilde of a `~~10` double-open.
//
//  • MARK / SPOILER: the delimiter is accidental only when it is a binary
//    OPERATOR — i.e. flanked by a word char on BOTH sides (`x==y`, `a||b`).
//    An INTENDED `==mark==` / `||spoiler||` has its opening delimiter preceded
//    by whitespace/line-start and its closing delimiter followed by
//    whitespace/line-end, so it is NEVER word-flanked on both sides. We arm only
//    when 2+ such both-word-flanked operators exist (a lone one cannot form a
//    span, and a space-flanked `a == b` cannot open a span under CommonMark
//    left/right-flanking rules, so both are correctly left alone), then escape.
//
// When in doubt we LEAVE IT: a missed neutralisation (reader sees an accidental
// strike) is strictly better than shredding the agent's intended formatting.
//
// ── Mechanics (identical to the dollar guard) ─────────────────────────────
//  • Code-span/fence aware: reuses `splitCodeSegments` from dollar-math-guard so
//    NOTHING inside a `` `code` `` span or fenced block is ever touched.
//  • Deterministic pure string transform; strict NO-OP unless a real signal is
//    present (2+ of a construct in prose).
//  • Idempotent: escaped output (`\~`, `\=\=`, `\|\|`) can never re-match the
//    triggers (the `~` case uses a `(?<!\\)` negative-lookbehind; the `==`/`||`
//    cases can't recur because the escaped form no longer contains two
//    consecutive `=`/`|`), so running the guard twice is byte-for-byte stable.
//
// ── Telegram assumptions requiring live UAT (Vitest CANNOT cover these) ────
//  (a) That Telegram's rich parser CONSUMES the backslash so the reader sees a
//      literal `~` / `=` / `|` (not a visible `\`). Asserted by analogy to
//      `escapeMarkdown`, which backslash-escapes these very chars and which the
//      whole card system depends on Telegram stripping.
//  (b) Whether a SINGLE `~` renders strikethrough on the rich path (GitHub GFM
//      needs `~~`; Telegram MarkdownV2 uses single `~`). Our digit-adjacent
//      heuristic is correct under BOTH readings, but the *likelihood* ranking of
//      the tilde case depends on it.
//  (c) That `==` highlight and `||` spoiler render for the word-flanked operator
//      shape (left/right-flanking behaviour).
// Send real prose through a live agent and confirm literal glyphs before merge.

import { splitCodeSegments } from './code-segments.js'

/** Digit-adjacent tilde: `~` directly before an optional `$`/`.` and a digit
 *  (`~10`, `~$5`, `~.5`). The `(?<!\\)` keeps it idempotent — an already-escaped
 *  `\~` is never re-escaped. Global: used for both counting and replacement. */
const TILDE_APPROX = /(?<!\\)~(?=\$?\.?\d)/g

/** A `==` acting as a binary operator: word char on BOTH sides (`x==y`). Never
 *  matches an intended `==mark==` (whose delimiters are whitespace-flanked on
 *  the outside). Idempotency is structural — the escaped `\=\=` holds no two
 *  consecutive `=`, so it can never re-match. Global. */
const MARK_OP = /(?<=\w)==(?=\w)/g

/** A `||` acting as a binary operator: word char on BOTH sides (`a||b`). Never
 *  matches an intended `||spoiler||`. Structurally idempotent like `MARK_OP`.
 *  Global. */
const SPOILER_OP = /(?<=\w)\|\|(?=\w)/g

/** Count matches of a global regex in a string (throwaway, resets lastIndex via
 *  match). */
function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0
}

/**
 * Neutralise ACCIDENTAL inline-pair formatting (`~…~` strikethrough,
 * `==…==` highlight, `||…||` spoiler) that Telegram's rich GFM parser would
 * typeset from ordinary prose.
 *
 * Operates on the FINAL rendered rich-markdown string (post-`render`), at the
 * same `richMessage()` seam as `guardDollarMath`. A strict NO-OP unless the
 * prose (non-code) content holds 2+ of a construct in its clearly-accidental
 * shape (digit-adjacent tildes; word-flanked `==`/`||` operators). Code spans /
 * fenced blocks are NEVER touched, and the agent's DELIBERATE `~~strike~~` /
 * `||spoiler||` / `==mark==` / `` `code` `` formatting passes through untouched.
 * Deterministic and idempotent.
 */
export function guardAccidentalInlinePairs(text: string): string {
  // Fast bail: none of the guarded trigger chars are present.
  if (!/[~=|]/.test(text)) return text

  const segments = splitCodeSegments(text)

  // Arm each construct independently, counting only PROSE (never code). A single
  // occurrence can never form a pair, so the threshold is 2.
  let tildes = 0
  let marks = 0
  let spoilers = 0
  for (const seg of segments) {
    if (seg.code) continue
    tildes += countMatches(seg.text, TILDE_APPROX)
    marks += countMatches(seg.text, MARK_OP)
    spoilers += countMatches(seg.text, SPOILER_OP)
  }

  const armTilde = tildes >= 2
  const armMark = marks >= 2
  const armSpoiler = spoilers >= 2
  if (!armTilde && !armMark && !armSpoiler) return text

  return segments
    .map((seg) => {
      if (seg.code) return seg.text
      let out = seg.text
      // `\~` — first tilde of an accidental pair can no longer pair.
      if (armTilde) out = out.replace(TILDE_APPROX, () => '\\~')
      // `\=\=` / `\|\|` — the operator can no longer open/close a span.
      if (armMark) out = out.replace(MARK_OP, () => '\\=\\=')
      if (armSpoiler) out = out.replace(SPOILER_OP, () => '\\|\\|')
      return out
    })
    .join('')
}
