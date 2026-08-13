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
// ── INTENTIONAL math is exempt (wire-verified 2026-08-13) ─────────────────
// Telegram's rich path renders a `$…$` pair as a native mathematical_expression
// node, and intentional math (`$x^2+y^2$`) must reach the wire byte-identical —
// an escaped `\$x^2+y^2\$` destroys a SUPPORTED construct. The discrimination
// lives in `splitProtectedSegments` (code-segments.ts): a COMPACT math span
// (whitespace-free inner, not currency-shaped) is a protected segment, so this
// guard neither counts its `$`s toward the 2+ threshold nor escapes them.
// Currency amounts always sit next to whitespace/prose (`$5M and $10M`) or have
// a digits-and-punctuation-only inner (`$5M-$10M`), so #3252-class accidental
// pairs remain fully guarded. Known residual: a SPACED math span (`$a + b$`)
// is indistinguishable from currency prose and is not exempted — it is escaped
// when the message also carries a currency signal, rendering as literal text
// (legible, not broken).
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

// The code-span/fence splitter now lives in ONE shared module so every #3252
// guard reuses the same CommonMark-correct implementation. Re-exported here for
// backwards compatibility with any importer that reached for it via this file.
import { splitCodeSegments, splitProtectedSegments, type Segment } from "./code-segments.js";
export { splitCodeSegments, splitProtectedSegments, type Segment };

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
 * blocks AND compact intentional-math `$…$` spans (protected segments, see
 * code-segments.ts) are never touched. Idempotent (F5) and deterministic.
 */
export function guardDollarMath(text: string): string {
  if (!text.includes("$")) return text;
  // Link-aware: a `$` inside a URL/table (rare but possible) is structural and
  // must not be escaped. splitProtectedSegments skips code/links/autolinks/tables.
  const segments = splitProtectedSegments(text);

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
