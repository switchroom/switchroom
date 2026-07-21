// Outbound repair of markdown tokens Telegram's rich GFM parser (Bot API 10.1)
// CANNOT render, so the reader would otherwise see literal noise glyphs.
//
// ── Root cause ───────────────────────────────────────────────────────────
// Assistant replies are composed by a model that habitually emits constructs
// from OTHER surfaces (GitHub / Obsidian / LaTeX): caret highlight/superscript
// `^…^`, footnote markers `[^1]`, and HTML `<details><summary>` collapsibles.
// None of these are part of Telegram's rich markdown; they degrade to literal
// carets, stray `[^1]`, and raw `<details>` tags on the reader's screen — the
// worst kind of consistency failure (a broken glyph in chat). The resident
// floor card tells the model not to emit them, but prompt discipline is not a
// guarantee. This guard makes the repair deterministic at send time.
//
// ── What it repairs (deterministic, pure string transform) ─────────────────
//   • `<details><summary>Title</summary>body</details>` → a Telegram EXPANDABLE
//     blockquote (`**> Title` first line + `> …` continuation) — the native
//     equivalent of a collapsible. `<details>` without a `<summary>` folds the
//     whole body into an expandable blockquote. Any orphan `<details>` /
//     `</details>` / `<summary>` tags left over are stripped.
//   • `^highlight^` / `x^2^` caret pairs → the inner text, carets removed
//     (Telegram has no highlight/superscript; the carets render literally).
//   • Footnote reference markers `[^id]` → removed (Telegram has no footnotes).
//     A footnote DEFINITION line `[^id]: …` is left alone (the `]:` lookahead).
//
// ── What it deliberately does NOT touch ────────────────────────────────────
//   • `$…$` math: already neutralised deterministically upstream by
//     `guardDollarMath` (it backslash-escapes `$` so the pair can never typeset
//     as math — the reader sees literal `$`). Re-processing `$` here would
//     double-process and risk corrupting currency prose, so this guard leaves
//     `$` untouched by design. Math repair is COVERED, just in the sibling guard.
//   • `~sub~` tilde pairs: the strikethrough/tilde trigger is owned by
//     `guardAccidentalInlinePairs` (disjoint char set). This guard never
//     inspects or inserts `~`.
//   • `__underline__`: renders as BOLD in Telegram — legible, not broken — so it
//     is left as-is (the floor card asks the model to avoid it, but there is no
//     glyph-level failure to repair).
//
// Code spans / fenced blocks / link destinations / table rows are emitted
// verbatim (shared `splitProtectedSegments`). A strict no-op for any body
// without one of these tokens, and idempotent (running twice is a no-op the
// second time — a repaired blockquote contains no `<details>`, a stripped caret
// pair contains no `^`). Safe to compose once per send alongside the #3252
// accidental-formatting guards.

import { splitProtectedSegments } from "./code-segments.js";

/** Paired caret highlight / superscript: `^text^` (no newline, non-empty, no
 *  nested caret). Non-greedy inner run. Replaced by the inner text. */
const CARET_PAIR = /\^([^\^\n]+)\^/g;

/** Footnote reference marker `[^id]` NOT immediately followed by `:` (which
 *  would make it a footnote DEFINITION line we leave intact). Removed entirely. */
const FOOTNOTE_MARKER = /\[\^[^\]\n]+\](?!:)/g;

/** `<details>…</details>` with an optional leading `<summary>…</summary>`.
 *  Dot-all via `[\s\S]`; non-greedy so adjacent blocks don't merge. */
const DETAILS_BLOCK =
  /<details[^>]*>\s*(?:<summary[^>]*>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>/gi;

/** Orphan collapsible tags left after DETAILS_BLOCK (malformed / unpaired). */
const ORPHAN_TAGS = /<\/?(?:details|summary)[^>]*>/gi;

/** Fold `title` + `body` into a Telegram expandable blockquote: the first
 *  emitted line carries the `**> ` marker (switchroom's expandable-blockquote
 *  encoding — see parse.ts), every subsequent line a plain `> `. */
function toExpandableBlockquote(title: string, body: string): string {
  const lines: string[] = [];
  const t = title.trim();
  if (t) lines.push(t);
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    // Collapse leading/trailing blank lines but keep interior structure.
    if (line.trim() === "" && lines.length === 0) continue;
    lines.push(line);
  }
  // Trim trailing blanks.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return "";
  return lines
    .map((line, i) => (i === 0 ? `**> ${line}` : `> ${line}`))
    .join("\n");
}

/** Repair unsupported tokens in a single PROSE segment. */
function repairProse(text: string): string {
  let out = text;
  out = out.replace(DETAILS_BLOCK, (_m, summary: string | undefined, body: string) =>
    toExpandableBlockquote(summary ?? "", body ?? ""),
  );
  out = out.replace(ORPHAN_TAGS, "");
  out = out.replace(CARET_PAIR, (_m, inner: string) => inner);
  out = out.replace(FOOTNOTE_MARKER, "");
  return out;
}

/**
 * Neutralise Telegram-unrenderable tokens (`<details>`, `^…^`, `[^1]`) on the
 * FINAL rendered rich-markdown string. Code / links / tables are verbatim.
 * Deterministic, idempotent, and a strict no-op absent any target token.
 */
export function guardUnsupportedTokens(text: string): string {
  // Cheap pre-check: nothing to do unless a target trigger char is present.
  if (!/[\^]|<details|<\/details|<summary/i.test(text)) return text;
  return splitProtectedSegments(text)
    .map((seg) => (seg.code ? seg.text : repairProse(seg.text)))
    .join("");
}
