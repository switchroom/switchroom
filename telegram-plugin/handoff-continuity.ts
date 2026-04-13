/**
 * Pure helpers for the session-handoff continuity line.
 *
 * On session start, the telegram plugin reads `$AGENT_DIR/.handoff-topic`
 * (written by the summarizer Stop hook). On the FIRST assistant reply
 * of the new session the plugin prepends a subtle one-liner:
 *
 *   ↩️ Picked up where we left off — <topic>
 *
 * The sidecar is consumed (read + deleted) so the line only fires once.
 * All helpers here are filesystem-only or env-only — no Telegram side
 * effects — which keeps them unit-testable in isolation.
 */

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOPIC_DISPLAY_MAX = 117;
export const HANDOFF_TOPIC_FILENAME = ".handoff-topic";

export function resolveAgentDirFromEnv(): string | null {
  const state = process.env.TELEGRAM_STATE_DIR;
  if (!state || state.trim().length === 0) return null;
  return dirname(state);
}

/**
 * Read the handoff topic file if present. Returns the trimmed first
 * non-empty line, truncated to TOPIC_DISPLAY_MAX with an ellipsis.
 * Missing, empty, or unreadable → null.
 */
export function readHandoffTopic(agentDir: string): string | null {
  const p = join(agentDir, HANDOFF_TOPIC_FILENAME);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  let topic = lines[0];
  if (topic.length > TOPIC_DISPLAY_MAX) {
    topic = topic.slice(0, TOPIC_DISPLAY_MAX) + "…";
  }
  return topic;
}

/**
 * Read + delete the topic file atomically (best-effort). A second call
 * returns null even if the first succeeded — the sidecar is one-shot.
 */
export function consumeHandoffTopic(agentDir: string): string | null {
  const topic = readHandoffTopic(agentDir);
  if (topic === null) return null;
  const p = join(agentDir, HANDOFF_TOPIC_FILENAME);
  try {
    unlinkSync(p);
  } catch {
    // Already gone / race — the topic we read is still valid to return
  }
  return topic;
}

/**
 * Reads CLERK_HANDOFF_SHOW_LINE. Defaults to true when unset so users
 * opt out explicitly via clerk.yaml rather than opt in.
 */
export function shouldShowHandoffLine(): boolean {
  const v = process.env.CLERK_HANDOFF_SHOW_LINE;
  if (v === undefined) return true;
  return v.toLowerCase() !== "false";
}

export type HandoffFormat = "html" | "markdownv2" | "text";

/**
 * Format the continuity line for the requested outbound format. The
 * returned string already includes the trailing `\n\n` separator so the
 * caller can concatenate directly with the assistant's reply body.
 *
 * HTML: wraps in <i>…</i>. MarkdownV2: wraps in _…_ with escaping.
 * text: plain. All variants prefix the ↩️ emoji.
 */
export function formatHandoffLine(
  topic: string,
  format: HandoffFormat,
): string {
  const prefix = "↩️ Picked up where we left off — ";
  if (format === "html") {
    return `<i>${prefix}${escapeHtml(topic)}</i>\n\n`;
  }
  if (format === "markdownv2") {
    const escaped = escapeMarkdownV2(topic);
    const prefixEsc = escapeMarkdownV2(prefix);
    return `_${prefixEsc}${escaped}_\n\n`;
  }
  return `${prefix}${topic}\n\n`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const MDV2_SPECIALS = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
function escapeMarkdownV2(s: string): string {
  return s.replace(MDV2_SPECIALS, (m) => "\\" + m);
}
