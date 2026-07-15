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
// EVERY prose `$` (`$` → `\$`) once the message looks like it carries currency
// — i.e. the prose (non-code) content holds 2+ total `$` AND at least one of
// them sits next to a digit (`$50`, `$.50`, or a trailing `50$`). A lone `$`
// (single total, or no digit-adjacent `$` anywhere) can never form a currency
// math span the way #3252 describes, so it is left byte-for-byte untouched.
// Code spans / fenced code blocks are NEVER touched (verbatim). Escaping every
// prose `$` (not just the `$digit` ones) is what closes the F3 false-negatives:
// `"$50 or 50$"`, `"$10 … from $ yesterday"`, and `"$.50 and $5"` all still form
// a `$…$` pair if only the leading-`$digit` token is escaped — so we escape the
// lot once the currency signal + 2-dollar threshold are met.
//
// Idempotent (F5): the escape uses a negative-lookbehind (`(?<!\\)\$`) so an
// already-escaped `\$` is never doubled to `\\$`. Running the guard twice (e.g.
// the streaming path renders then this wrapper re-wraps) is a strict no-op the
// second time.
//
// ── Where this runs (F1) ───────────────────────────────────────────────────
// This guard is invoked from `richMessage()` (rich-send.ts) — the ONE adapter
// every `{ markdown }` wire send funnels through (the `reply`-tool final answer
// via computeReplyChunks/sendReplyChunks, the draft-stream previews, cards,
// approvals, banners). That is the single deterministic seam that covers every
// markdown-parsed outbound exactly once. `plain`-mode degradations bypass
// `richMessage` (they go straight to `sendMessage`, no markdown parsing → no
// math), so they are correctly left untouched.
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
// Tradeoff (UNVERIFIED — see F4): this relies on Telegram's server-side rich
// GFM parser (a) recognising `$` as an escapable ASCII punctuation char and
// (b) CONSUMING the backslash so the reader sees a literal `$` and copy-paste
// yields `$0.5-0.9M` (no stray `\`). This is asserted by analogy to the
// `` ~ = | * _ `` chars that `escapeMarkdown` (format.ts) already backslash-
// escapes and that Telegram demonstrably strips — BUT note `escapeMarkdown`
// pointedly does NOT include `$` in its escape set, so we have no in-repo
// evidence that `\$` specifically round-trips. Vitest CANNOT cover this (it is
// server-side Telegram behaviour). If Telegram does NOT consume the backslash,
// guarded replies would show a visible `\$0.5-0.9M` — arguably worse than the
// math bug. **This is the one residual risk requiring human UAT before merge:**
// send a real two-dollar-amount message through a live agent and confirm it
// renders as a literal `$` (not `\$`, not math-italic). See the PR's UAT note.

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

/** Counts every `$` in a segment (the total-dollar threshold input). */
const ANY_DOLLAR = /\$/g;

/** The "this is currency, not a stray symbol" signal: a `$` sitting next to a
 *  digit on either side — `$50` / `$.50` (leading) or `50$` (trailing), the
 *  latter covering European / trailing-symbol conventions. One such token in
 *  the prose is enough to arm the guard (combined with the 2+ total threshold).
 *  Non-global: used only as a boolean `.test`. */
const CURRENCY_SIGNAL = /\$\.?\d|\d\s?\$/;

/** Every prose `$` that is NOT already backslash-escaped. The negative
 *  lookbehind makes the escape idempotent (F5): a pre-existing `\$` is left
 *  alone, so running the guard twice never produces `\\$`. Global for replace. */
const UNESCAPED_DOLLAR = /(?<!\\)\$/g;

/**
 * Neutralise accidental `$…$` inline-math typesetting of currency amounts.
 *
 * Operates on the FINAL rendered rich-markdown string (post-`render`). A no-op
 * unless the prose (non-code) content holds 2+ total `$` AND at least one of
 * them is digit-adjacent (a currency signal). When armed, EVERY unescaped prose
 * `$` is backslash-escaped so no two `$` can pair into a math span — this is
 * what closes the F3 trailing-`$` / `$.50` false-negatives. Code spans / fenced
 * blocks are never touched. Idempotent (F5) and deterministic.
 */
export function guardDollarMath(text: string): string {
  if (!text.includes("$")) return text;
  const segments = splitCodeSegments(text);

  let total = 0;
  let hasCurrencySignal = false;
  for (const seg of segments) {
    if (seg.code) continue;
    total += seg.text.match(ANY_DOLLAR)?.length ?? 0;
    if (!hasCurrencySignal && CURRENCY_SIGNAL.test(seg.text)) hasCurrencySignal = true;
  }
  // Fewer than two dollars can never form a pair; without a digit-adjacent `$`
  // the two dollars are (e.g.) `$foo`/`$bar` shell-var prose, which we leave
  // alone to avoid escaping legitimate lone symbols (F3: no false positives).
  if (total < 2 || !hasCurrencySignal) return text;

  return segments
    .map((seg) => (seg.code ? seg.text : seg.text.replace(UNESCAPED_DOLLAR, () => "\\$")))
    .join("");
}
