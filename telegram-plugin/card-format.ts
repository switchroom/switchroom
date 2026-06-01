/**
 * Shared formatters for Telegram status cards.
 *
 * Both the main progress card (rendered via `stream-reply-handler.ts`)
 * and the pinned worker card (`subagent-watcher.ts`) emit HTML to
 * Telegram; before issue #94 each had its own private copies with subtly
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
 * Keep this module dependency-free. It's imported by every card-render
 * surface and must not pull in plugin or gateway state.
 */

/**
 * Render a millisecond duration as `<n>ms` for sub-second values, or
 * `MM:SS` thereafter. Output is always HTML-safe (no `<` / `>` / `&`),
 * so callers can interpolate it into HTML without `escapeHtml`.
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

/**
 * Escape `&`, `<`, `>` for safe interpolation into Telegram HTML
 * messages. Telegram's HTML parser is strict — an unescaped `<` is
 * read as a tag opener and rejects the message with
 * "can't parse entities" (see #101 for the cascade that crashed the
 * gateway into a restart loop).
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/** Truncate to at most `n` characters, replacing the last char with `…`. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Strip Markdown markup from a single line, leaving plain prose.
 *
 * Worker narration is authored as Markdown — the model writes `**bold**`,
 * `` `code` ``, `- bullets`, `# headings`. The status cards render Telegram
 * HTML, which does NOT interpret Markdown, so an unstripped `**` shows up as
 * two literal asterisks (the #94-class "half-done" look). Strip the markup
 * here so the card reads as clean prose.
 *
 * Run this BEFORE `truncate` + `escapeHtml`: clean → measure → escape. (The
 * stripper never touches `<`/`>`/`&`, so escaping stays the last step.)
 */
export function stripMarkdown(s: string): string {
  let out = s;
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
  out = out.replace(/^\s{0,3}#{1,6}\s+/, '');
  out = out.replace(/^\s{0,3}>\s?/, '');
  out = out.replace(/^\s{0,3}[-*+]\s+/, '');
  out = out.replace(/^\s{0,3}\d+[.)]\s+/, '');
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
 * Output is plain text — the caller still truncates + escapes before
 * interpolating into HTML.
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
