/**
 * Shared formatters for Telegram status cards.
 *
 * Since the Bot API 10.1 rich-message migration (#2669) the cards emit raw
 * GFM markdown (sent via `sendRichMessage` / `editMessageText({ markdown })`),
 * not HTML. `escapeMarkdown` (re-exported from `format.ts`) is the
 * dynamic-value escaper cards use where they used to call `escapeHtml`.
 *
 * Both the main progress card (rendered via `stream-reply-handler.ts`)
 * and the pinned worker card (`subagent-watcher.ts`) emit to Telegram;
 * before issue #94 each had its own private copies with subtly
 * different conventions:
 *
 *   - `formatDuration(500)` → progress-card returned `500ms`, watcher
 *     returned `<1s` (which crashed Telegram's HTML parser when not
 *     escaped — see #86 / #89 / #101). The numeric form is HTML-safe at
 *     every call site without per-call escaping, so we standardise on
 *     it here.
 *
 *   - `escapeHtml` / `truncate` were identical character-for-character
 *     in both modules. Centralising removes one more piece of drift the
 *     reviewer has to verify.
 *
 * Keep this module nearly dependency-free. It's imported by every
 * card-render surface and must not pull in plugin or gateway state. The
 * single exception is the `escapeMarkdown` re-export from `format.ts`,
 * which is itself state-free.
 */

import { escapeMarkdown, codeSpanSafe } from './format.js'
import { normalizeDashes } from './text-voice-scrub.js'

/**
 * Re-export so card surfaces have one import for the markdown escaper they
 * use when interpolating dynamic values into a hand-built markdown card.
 * `codeSpanSafe` is the code-span (backtick) counterpart: use it for values
 * interpolated INSIDE `` `…` `` (where backslash escaping is wrong).
 */
export { escapeMarkdown, codeSpanSafe }

/**
 * Separator appended to every card line that is followed by a hard break when
 * `stackCardLines` runs in `collapseSafe` mode (#3666).
 *
 * It is a NO-BREAK SPACE (U+00A0), chosen deliberately:
 *
 *   - It is a real character in the message text, so it survives Telegram's
 *     pinned-bar collapse (which drops the `\n` and substitutes nothing) and
 *     keeps the two lines' glyphs apart in the one-line preview.
 *   - It is NOT ASCII whitespace, so neither this module's own
 *     trailing-whitespace strip nor the GFM parser's hard-break handling
 *     (which consumes only the ASCII spaces immediately before the newline)
 *     can eat it.
 *   - It is invisible where the card is normally read — the chat feed — since
 *     it lands at end-of-line. That is the whole reason a separator with
 *     visible ink (`' ·'`, `' —'`) was rejected: it would put dangling
 *     punctuation on every line of every pinned card to fix a defect that only
 *     manifests on the pin bar.
 *
 * If a real-pin eyeball shows a single space is too weak a break, this constant
 * is the one place to strengthen it (e.g. `' ·'`) — the seam is deliberate.
 */
export const COLLAPSE_SAFE_SEPARATOR = '\u00A0'

/**
 * Normalise a line's tail before `stackCardLines` re-terminates it.
 *
 * Two strips, both there for the SAME reason: this function must be idempotent,
 * so re-stacking an already-stacked body can never accumulate terminator
 * characters.
 *
 *   - trailing ASCII whitespace, so exactly one `  \n` hard break is emitted;
 *   - in `collapseSafe` mode, any `COLLAPSE_SAFE_SEPARATOR` run the line
 *     already carries (interleaved with ASCII whitespace, since a caller may
 *     have split the body on `\n` rather than on `  \n`), so exactly one
 *     separator is emitted.
 *
 * The separator strip is written against the CONSTANT, not against a hardcoded
 * U+00A0, so it stays correct if the separator is ever strengthened to visible
 * ink. That one-constant seam is what COLLAPSE_SAFE_SEPARATOR's own doc comment
 * promises, and it would be a lie if this strip did not follow it.
 */
function normalizeLineTail(line: string, collapseSafe: boolean): string {
  let out = line.replace(/[ \t\r]+$/, '')
  // The length guard is not defensive noise: `''.endsWith('')` is true and
  // `''.slice(0, -0)` is `''`, so an empty separator would spin this loop
  // forever — a hang in the gateway's render path. The doc comment above the
  // constant invites future edits to it, so make that edit unable to hang.
  if (!collapseSafe || COLLAPSE_SAFE_SEPARATOR.length === 0) return out
  while (out.endsWith(COLLAPSE_SAFE_SEPARATOR)) {
    out = out.slice(0, -COLLAPSE_SAFE_SEPARATOR.length).replace(/[ \t\r]+$/, '')
  }
  return out
}

/** Options for `stackCardLines`. */
export interface StackCardLinesOpts {
  /** Append `COLLAPSE_SAFE_SEPARATOR` to each hard-broken line so the stack
   *  stays readable on a surface that collapses it to one line (#3666).
   *  Opt-in: only pinned cards pay the (tiny) extra character per line. */
  collapseSafe?: boolean
}

/**
 * Join a card's pre-rendered, single-line entries so they STACK in the
 * Bot API 10.1 rich-message renderer (#2669) — the same visual result the
 * main reply path gets after `normalizeParagraphBreaks`.
 *
 * Why this exists: the rich GFM renderer treats a LONE `\n` between two
 * non-blank lines as a SOFT break and collapses them onto one visual line
 * (this is the exact reason `normalizeParagraphBreaks` promotes prose `\n`
 * to a hard break on the reply path). Status / worker / issues / boot
 * cards build a list of styled prose lines (`_✓ step_`, `**→ step**`,
 * header lines, a `─────` rule) and join them with `\n`. Sent verbatim via
 * `richMessage`, those lines collapse into a run-on blob — the long-standing
 * "progress-card bullets collapse into one line" bug.
 *
 * Each card line is a SINGLE styled line with no internal newline (steps are
 * pre-clipped to one line, headers are emitted one-per-array-entry), so we
 * can deterministically promote EVERY inter-line break to a GFM hard break
 * (`  \n`, two trailing spaces) without risking a list/table/code corruption:
 * card lines are never GFM block-structure lines (no leading `-`/`*`/`|`/```),
 * they are inline-styled prose. A blank entry (intentional `\n\n` gap, if a
 * caller ever inserts one) is preserved as a real paragraph break.
 *
 * This is the card-surface analogue of the reply path's
 * `normalizeParagraphBreaks`: it guarantees a card authored as stacked
 * bullet/step lines renders identically to a normal reply.
 *
 * `opts.collapseSafe` (#3666) additionally makes the stack survive being
 * rendered on a surface that COLLAPSES the message to one line — Telegram's
 * pinned-message bar drops the newlines and substitutes nothing, mashing the
 * last glyph of each line into the first glyph of the next
 * (`… · opus 5✓ Reading gateway.ts→ Running search …`). Opt-in, because it is
 * only correct for cards that are actually pinned; see COLLAPSE_SAFE_SEPARATOR.
 */
export function stackCardLines(
  lines: string[],
  opts?: StackCardLinesOpts,
): string {
  const collapseSafe = opts?.collapseSafe === true
  const pieces: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    pieces.push(line)
    if (i === lines.length - 1) break
    const cur = line.trim()
    const next = lines[i + 1].trim()
    // A blank current or next line is a genuine `\n\n` paragraph gap — leave
    // the separator a plain newline so the blank entry reconstructs the gap.
    if (cur === '' || next === '') {
      // The gap still needs a collapse separator when THIS line has content:
      // a collapsing surface drops the `\n\n` with no substitute exactly as it
      // drops a `  \n`, and the blank entry is the empty string, so it
      // contributes NO character of its own to hold the two sides apart. Only
      // when `cur` is blank is the separator skipped — appending it to a blank
      // entry would turn the gap into a visible U+00A0 paragraph in the FEED.
      if (collapseSafe && cur !== '') {
        pieces[pieces.length - 1] = normalizeLineTail(line, true) + COLLAPSE_SAFE_SEPARATOR
      }
      pieces.push('\n')
      continue
    }
    // Strip any trailing whitespace the line already carried so we emit
    // exactly one `  \n` hard break (never accumulate spaces on a re-run) and,
    // under collapseSafe, exactly one separator — see normalizeLineTail.
    // The collapse separator is appended AFTER the strip (it is not ASCII
    // whitespace, so it survives both this strip and the markdown parser's
    // own trailing-whitespace handling) and BEFORE the two hard-break spaces,
    // which stay immediately adjacent to the `\n` so the break still parses.
    pieces[pieces.length - 1] =
      normalizeLineTail(line, collapseSafe) + (collapseSafe ? COLLAPSE_SAFE_SEPARATOR : '')
    pieces.push('  \n')
  }
  return pieces.join('')
}

/**
 * Render a millisecond duration as `<n>ms` for sub-second values, or
 * `MM:SS` thereafter. Output contains no markdown-special characters, so
 * callers can interpolate it into a markdown card without escaping.
 *
 *   formatDuration(0)      → "0ms"
 *   formatDuration(500)    → "500ms"
 *   formatDuration(999)    → "999ms"
 *   formatDuration(1000)   → "00:01"
 *   formatDuration(59_000) → "00:59"
 *   formatDuration(60_000) → "01:00"
 *
 * Cap at 99:59 — turns and worker tasks both finish well inside that
 * window in practice. Longer-running surfaces should use a different
 * formatter rather than expect `100:00` to be sensible here.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `00:${s.toString().padStart(2, '0')}`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
}

/** Truncate to at most `n` characters, replacing the last char with `…`. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Strip Markdown markup from a single line, leaving plain prose.
 *
 * Worker narration is authored as Markdown — the model writes `**bold**`,
 * `` `code` ``, `- bullets`, `# headings`. The status cards have a fixed
 * structure (steps, durations) and interleave narration as plain prose, so
 * we strip the author's inline markup here so the narration reads as clean
 * prose and never collides with the card's own markdown structure.
 *
 * Run this BEFORE `truncate` + `escapeMarkdown`: clean → measure → escape.
 */
export function stripMarkdown(s: string): string {
  // Close the em-dash leak on this model-authored-prose surface using the
  // SAME dash logic as the reply-path voice scrub (no duplicated regex). Run
  // it FIRST, while code spans (`` `…` ``) still have their backticks intact,
  // so `normalizeDashes`'s own code-region masking preserves a dash inside a
  // code span before the backtick-stripping below erases the fences.
  let out = normalizeDashes(s);
  // Inline + leftover code spans → bare text.
  out = out.replace(/`+/g, '');
  // Links / images: [text](url) and ![alt](url) → the label.
  out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Paired bold / emphasis runs (longest marker first).
  out = out.replace(/\*\*(.+?)\*\*/g, '$1');
  out = out.replace(/__(.+?)__/g, '$1');
  out = out.replace(/\*(.+?)\*/g, '$1');
  out = out.replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/g, '$1');
  // Leading block markup: heading, blockquote, bullet, ordered item.
  // `gm` so the markers are stripped on EVERY line, not just the string
  // start — a multi-line summary like "Done.\n\n## Summary\n…" must not
  // leak a raw `## Summary` when rendered as a single card step.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, '');
  out = out.replace(/^\s{0,3}\d+[.)]\s+/gm, '');
  // Residual unpaired bold markers (a lone `*` is left alone so `3 * 4`
  // survives; only the doubled form is markup-by-construction).
  out = out.replace(/\*\*/g, '');
  return out.trim();
}

/** True for a whole-line horizontal rule: `---`, `___`, `***` (3+ of one). */
function isRuleLine(s: string): boolean {
  return /^\s*([-_*])\1{2,}\s*$/.test(s);
}

/**
 * Clean a worker's multi-line result/narration into a single plain-text
 * paragraph for a card's finished body. Drops fenced code blocks and
 * horizontal rules, strips per-line Markdown, then space-joins what's left.
 * Output is plain text — the caller still truncates + escapes (escapeMarkdown)
 * before interpolating into the card's markdown body.
 */
export function cleanWorkerResultParagraph(s: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const raw of s.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (isRuleLine(raw)) continue;
    const cleaned = stripMarkdown(raw);
    if (cleaned.length > 0) kept.push(cleaned);
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}
