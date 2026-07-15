// Outbound guard against accidental TeX/inline-math typesetting of currency
// amounts (issue #3252).
//
// ── Root cause ───────────────────────────────────────────────────────────
// Since the Bot API 10.1 migration (#2669) every assistant reply is sent to
// Telegram as RAW GFM markdown via `sendRichMessage({ markdown })` — Telegram
// parses the markdown server-side. Telegram's rich GFM parser honours the GFM
// inline-math extension: a `$...$` PAIR typesets the text between the two
// dollar signs as math (math-italic, U+1D400-range glyphs on the reader's
// screen). switchroom's renderer (`render.ts` → `escapeMarkdown`) escapes the
// other inline-formatting triggers (`` ` `` `*` `_` `~` `=` `[` `]` `|`) but
// NOT `$`. So a perfectly ordinary reply with TWO dollar amounts —
//   "…ceiling is ~$0.5-0.9M but nearly all in small dealers … is ~$150-450k"
// — accidentally forms a math span across everything between the two `$`, and
// the reader sees the middle typeset as math-italic. history.db stores the
// clean ASCII; switchroom emits clean ASCII; the math is produced downstream
// by Telegram's rich-markdown parser from the unescaped `$…$` pair.
//
// ── Fix ──────────────────────────────────────────────────────────────────
// Deterministically break the `$…$` pairing on the wire by backslash-escaping
// each `$` that immediately precedes a digit (`$` → `\$`), but ONLY when the
// message contains 2+ such `$digit` tokens (a lone `$5` prose price can never
// form a span, so it is left byte-for-byte untouched), and NEVER inside a code
// span / fenced code block (whose content is verbatim and must not change).
//
// Why `\$` and not a zero-width joiner (U+2060):
//   - It reuses the EXACT mechanism switchroom already relies on for every
//     other formatting char (`escapeMarkdown` backslash-escapes `~ = | * _`
//     etc.), which Telegram's rich parser demonstrably strips and renders
//     literally — the whole card system depends on it. `$` is ASCII
//     punctuation, so CommonMark's "any ASCII punctuation may be
//     backslash-escaped" rule applies identically.
//   - The reader sees a literal `$`; copy-paste yields exactly `$0.5-0.9M`
//     (the backslash is consumed by the parser, never in the rendered text or
//     the clipboard). No zero-width characters that could pollute search /
//     copy / re-tokenisation.
//   - Fully deterministic (pure string transform), and a strict no-op for any
//     message with fewer than two `$digit` tokens.
//
// Tradeoff: relies on Telegram's rich parser honouring CommonMark backslash
// escapes of `$`. This is the same guarantee the existing escaped set already
// depends on in production, so the residual risk is nil; in the impossible
// case Telegram neither supported math NOR consumed the backslash, `\$` would
// render literally — but that would already have broken every other escaped
// char, so it is not a real regression surface.

/** A contiguous slice of rendered markdown, tagged as code (verbatim, never
 *  transformed) or prose (eligible for the dollar guard). */
interface Segment {
  code: boolean;
  text: string;
}

/** From index `from` (just past an opening run of `runLen` backticks), find the
 *  index immediately AFTER the matching closing run of exactly `runLen`
 *  backticks. Returns -1 when there is no matching close (a stray backtick),
 *  in which case the opener is treated as literal prose. Equal-length matching
 *  is the CommonMark rule for code spans and matches the balanced fences this
 *  renderer emits for code blocks. */
function findClosingBackticks(text: string, from: number, runLen: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "`") {
      let j = i;
      while (j < text.length && text[j] === "`") j++;
      if (j - i === runLen) return j;
      i = j;
    } else {
      i++;
    }
  }
  return -1;
}

/** Split rendered markdown into alternating prose / code segments so the guard
 *  can skip code spans and fenced code blocks entirely. */
function splitCodeSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      let j = i;
      while (j < text.length && text[j] === "`") j++;
      const runLen = j - i;
      const close = findClosingBackticks(text, j, runLen);
      if (close !== -1) {
        if (plainStart < i) out.push({ code: false, text: text.slice(plainStart, i) });
        out.push({ code: true, text: text.slice(i, close) });
        i = close;
        plainStart = close;
        continue;
      }
    }
    i++;
  }
  if (plainStart < text.length) out.push({ code: false, text: text.slice(plainStart) });
  return out;
}

/** Matches a `$` immediately followed by an ASCII digit — the currency/math
 *  span opener. Lookahead keeps the digit out of the match so it is not
 *  consumed by the replace. */
const DOLLAR_DIGIT = /\$(?=\d)/g;

/**
 * Neutralise accidental `$…$` inline-math typesetting of currency amounts.
 *
 * Operates on the FINAL rendered rich-markdown string (post-`render`). A no-op
 * unless the prose (non-code) content holds 2+ `$digit` tokens; when it does,
 * every prose `$` that precedes a digit is backslash-escaped so the pair can
 * no longer open a math span. Code spans / fenced blocks are never touched.
 * Pure and deterministic.
 */
export function guardDollarMath(text: string): string {
  if (!text.includes("$")) return text;
  const segments = splitCodeSegments(text);

  let count = 0;
  for (const seg of segments) {
    if (seg.code) continue;
    count += seg.text.match(DOLLAR_DIGIT)?.length ?? 0;
    if (count >= 2) break;
  }
  if (count < 2) return text;

  return segments
    .map((seg) => (seg.code ? seg.text : seg.text.replace(DOLLAR_DIGIT, () => "\\$")))
    .join("");
}
