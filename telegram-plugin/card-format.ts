/**
 * Shared formatters for Telegram status cards.
 *
 * Both the main progress card (`progress-card.ts`) and the pinned worker
 * card (`subagent-watcher.ts`) emit HTML to Telegram; before issue #94
 * each module had its own private copies of these helpers with subtly
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
