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
 */
export function stackCardLines(lines: string[]): string {
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
      pieces.push('\n')
      continue
    }
    // Strip any trailing whitespace the line already carried so we emit
    // exactly one `  \n` hard break (never accumulate spaces on a re-run).
    pieces[pieces.length - 1] = line.replace(/[ \t\r]+$/, '')
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
