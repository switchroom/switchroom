/**
 * Pure formatter for `switchroom telegram topics <chat_id>` output.
 *
 * The DB-fetching half lives in `src/cli/telegram.ts` because it needs
 * `bun:sqlite` (runtime-bound) and can't be exercised from vitest. This
 * module is pure-data-in, string-out so the formatting is unit-testable.
 *
 * Part of PR7 of the supergroup-mode rollout (docs/rfcs/supergroup-mode.md).
 */

import chalk from "chalk";

export interface TopicRow {
  /** Telegram thread ID; `null` means chat-root (no forum thread). */
  thread_id: number | null;
  /** Count of messages observed in this (chat, thread). */
  msg_count: number;
  /** Earliest message timestamp (epoch seconds). */
  first_ts: number;
  /** Latest message timestamp (epoch seconds). */
  last_ts: number;
  /** Text of the FIRST observed message in this thread (truncated by caller). */
  first_text: string | null;
  /** Role of the first message ('user' / 'assistant') for context. */
  first_role: string | null;
}

const PREVIEW_MAX = 60;

/**
 * Render the discovery output as a multi-line string. Caller prints it.
 *
 * Sections:
 *   - One block per observed topic: thread ID + msg count + first-seen
 *     age + first-message preview.
 *   - A copy-paste-ready `topic_aliases:` snippet at the end.
 *
 * The General-topic note (`thread_id === 1`) is flagged inline because
 * id=1 is the Telegram General topic at MTProto but the Bot API rejects
 * it on send (see chat-lock.ts strip-1 logic) — operators benefit from
 * the reminder when choosing whether to alias it.
 */
export function formatTopicsTable(
  rows: TopicRow[],
  chatId: string,
  agentName: string,
): string {
  const lines: string[] = [];
  lines.push(
    chalk.bold(`Topics observed in chat ${chatId}`) +
      chalk.gray(` (agent: ${agentName})`),
  );
  lines.push("");

  for (const row of rows) {
    const threadLabel =
      row.thread_id == null
        ? chalk.bold("chat-root")
        : chalk.bold(String(row.thread_id));
    const generalNote = row.thread_id === 1 ? chalk.yellow(" (General)") : "";
    const firstAgo = formatAgo(row.first_ts);
    const meta = chalk.gray(
      `(${row.msg_count} msg${row.msg_count === 1 ? "" : "s"}, first seen ${firstAgo})`,
    );
    lines.push(`  ${threadLabel}${generalNote}  ${meta}`);

    const preview = row.first_text ? truncate(row.first_text, PREVIEW_MAX) : "(no message)";
    const role = row.first_role ?? "?";
    lines.push(`    ${chalk.dim(`${role}: ${preview}`)}`);
  }

  // Copy-paste-ready YAML snippet for the operator. Only includes
  // numeric thread_ids (chat-root isn't a forum topic — can't alias).
  const aliasable = rows.filter((r) => r.thread_id != null);
  if (aliasable.length > 0) {
    lines.push("");
    lines.push(chalk.dim("To use in switchroom.yaml under channels.telegram.topic_aliases:"));
    lines.push(chalk.dim("  topic_aliases:"));
    for (const row of aliasable) {
      const placeholder =
        row.thread_id === 1
          ? "general"
          : `topic_${row.thread_id}`;
      lines.push(chalk.dim(`    ${placeholder}: ${row.thread_id}`));
    }
  }

  return lines.join("\n");
}

/**
 * Truncate a string to `max` chars, appending `…` if cut. Collapses
 * embedded newlines to spaces so the preview stays single-line.
 */
export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

/**
 * Render an epoch-seconds timestamp as a human "age" string.
 * - <60s: "just now"
 * - <60m: "Nm ago"
 * - <24h: "Nh ago"
 * - <30d: "Nd ago"
 * - otherwise: ISO date
 *
 * Pure (takes the current time as `now`) so tests can fix the clock.
 */
export function formatAgo(ts: number, now: number = Math.floor(Date.now() / 1000)): string {
  const delta = Math.max(0, now - ts);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
