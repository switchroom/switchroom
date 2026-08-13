// Outbound repair of markdown tokens Telegram's rich GFM parser (Bot API 10.1)
// CANNOT render, so the reader would otherwise see literal noise glyphs.
//
// ── Root cause ───────────────────────────────────────────────────────────
// Assistant replies are composed by a model that habitually emits constructs
// from OTHER surfaces (GitHub / Obsidian / LaTeX). Most of them turn out to be
// natively supported by Telegram's rich markdown path (wire-verified
// 2026-08-13 by sending raw `sendRichMessage` probes and reading back the
// echoed `rich_message.blocks`):
//   • `<details open><summary>S</summary>…</details>` → a real typed
//     `details` node (native collapsible) — SUPPORTED, must pass through.
//   • `$x^2+y^2$` → a `mathematical_expression` node — SUPPORTED (and
//     protected from the sibling guards via `splitProtectedSegments`'s
//     compact-math-span rule; see code-segments.ts).
//   • footnotes `claim[^1]` + `[^1]: body` → full superscript/anchor/
//     reference_link/footer machinery — SUPPORTED, must pass through.
//   • `<sub>`/`<sup>`/`<u>`, `<aside>…<cite>…</cite></aside>`, `tg://time`
//     links, `- [ ]` task lists — all SUPPORTED, never touched here.
// (An earlier revision of this guard "repaired" `<details>` into a `**> `
// expandable blockquote and deleted footnote reference markers. Both repairs
// were built on a false belief: `**>` is MarkdownV2 syntax that the rich
// markdown path renders as LITERAL `**>` paragraph text — the probe proved the
// conversion turned a SUPPORTED construct into an UNSUPPORTED one. That logic
// is deleted, not gated.)
//
// What genuinely does NOT render and still needs repair: the caret
// highlight/superscript shorthand `^…^`. Telegram's rich markdown has no caret
// syntax — the carets render literally on the reader's screen. The resident
// floor card tells the model to use `<sup>…</sup>` instead, but prompt
// discipline is not a guarantee; this guard makes the repair deterministic at
// send time.
//
// ── What it repairs (deterministic, pure string transform) ─────────────────
//   • `^highlight^` / `x^2^` caret pairs → the inner text, carets removed.
//
// ── What it deliberately does NOT touch ────────────────────────────────────
//   • `$…$` math: a compact math span is PROTECTED upstream (a `code: true`
//     segment from `splitProtectedSegments`), and accidental currency `$` is
//     owned by `guardDollarMath` (disjoint char set).
//   • `~sub~` tilde pairs: the strikethrough/tilde trigger is owned by
//     `guardAccidentalInlinePairs` (disjoint char set). This guard never
//     inspects or inserts `~`.
//   • `__underline__`: renders as BOLD in Telegram — legible, not broken — so it
//     is left as-is (the floor card asks the model to avoid it, but there is no
//     glyph-level failure to repair).
//   • footnote markers `[^id]` / definitions `[^id]: …`: natively supported,
//     pass through verbatim. (The caret regex below can never touch them: the
//     `]` / `:` break the alphanumeric-only inner run.)
//
// Code spans / fenced blocks / link destinations / math spans / table rows are
// emitted verbatim (shared `splitProtectedSegments`). A strict no-op for any
// body without a caret pair, and idempotent (a stripped caret pair contains no
// `^`). Safe to compose once per send alongside the #3252 accidental-formatting
// guards.

import { splitProtectedSegments } from "./code-segments.js";

/** Paired caret highlight / superscript: `^text^` where the inner run is a
 *  single ALPHANUMERIC token (no newline, no whitespace, no nested caret, and
 *  crucially no expression punctuation like `+ = -`). Non-greedy inner run.
 *  Replaced by the inner text.
 *
 *  The alphanumeric-only constraint is deliberate and NARROWER than a plain
 *  "non-caret non-space" run: it distinguishes a genuine single superscript /
 *  highlight token (`x^2^`, `^highlighted^`) from a whitespace-free math
 *  expression whose carets are INDEPENDENT exponents (`a^2+b^2=c^2`). With a
 *  permissive inner run the first two carets of `a^2+b^2=c^2` pair up (`^2+b^`)
 *  and get stripped, mangling the math; requiring the inner run to be pure
 *  alphanumerics means `^2+b^` never matches (the `+` breaks the run), so
 *  `a^2+b^2=c^2`, `2^8`, and `x^n` all pass through untouched. It also keeps
 *  the guard off footnote markers `[^1]` (the `]` breaks the run). */
const CARET_PAIR = /\^([A-Za-z0-9]+)\^/g;

/** Repair unsupported tokens in a single PROSE segment. */
function repairProse(text: string): string {
  return text.replace(CARET_PAIR, (_m, inner: string) => inner);
}

/**
 * Neutralise Telegram-unrenderable caret pairs (`^…^`) on the FINAL rendered
 * rich-markdown string. Code / links / math spans / tables are verbatim.
 * Deterministic, idempotent, and a strict no-op absent any target token.
 */
export function guardUnsupportedTokens(text: string): string {
  // Cheap pre-check: nothing to do unless a caret is present at all.
  if (!text.includes("^")) return text;
  return splitProtectedSegments(text)
    .map((seg) => (seg.code ? seg.text : repairProse(seg.text)))
    .join("");
}
