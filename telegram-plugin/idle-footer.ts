/**
 * Pure renderer for the idle/active footer shown on each agent's Telegram topic.
 *
 * No DB, no IO, no time-source coupling. Both `rows` and `now` are
 * caller-supplied so the function is trivially testable.
 *
 * ## "Most recent" definition
 * We pick the row with the greatest `startedAt` value. Using `startedAt` (rather
 * than `endedAt ?? startedAt`) keeps the semantics simple: the most recently
 * *started* turn is the one that best reflects the agent's current engagement.
 * A turn that finished long ago but whose `endedAt` happens to be later than a
 * newer turn's `startedAt` would give a misleading "working since" signal; that
 * edge case can't occur in practice (turns are sequential per chat), but the
 * comment documents the deliberate choice.
 */

export interface TurnRow {
  turnKey: string;
  chatId: string;
  startedAt: number;     // ms epoch
  endedAt: number | null; // ms epoch, or null if the turn is still running
}

/**
 * Format a past timestamp as a human-readable "ago" string.
 *
 *   <60 s  → "<1m ago"
 *   60 s..59 min → "Nm ago"
 *   60 min..23 h → "Nh ago"
 *   >=24 h → "Nd ago"
 */
function formatAgo(ts: number, now: number): string {
  const diffMs = now - ts;
  const diffSec = diffMs / 1000;
  if (diffSec < 60) return "<1m ago";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMs / 3_600_000);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffMs / 86_400_000);
  return `${diffDay}d ago`;
}

/**
 * Format an array of turn rows into a footer string for the agent's topic.
 *
 * States:
 * - No rows            → "🟡 quiet · no turns yet"
 * - Latest turn running → "⚙️ working since <Nm ago>"  (uses startedAt)
 * - Latest turn ended  → "🟢 idle · last reply <Nm ago>" (uses endedAt)
 */
export function formatIdleFooter(rows: ReadonlyArray<TurnRow>, now: number): string {
  if (rows.length === 0) {
    return "🟡 quiet · no turns yet";
  }

  // Pick most recent by MAX(startedAt).
  const latest = rows.reduce((best, row) => (row.startedAt > best.startedAt ? row : best));

  if (latest.endedAt == null) {
    return `⚙️ working since ${formatAgo(latest.startedAt, now)}`;
  }

  return `🟢 idle · last reply ${formatAgo(latest.endedAt, now)}`;
}
