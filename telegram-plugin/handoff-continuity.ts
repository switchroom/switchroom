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

import { readFileSync, unlinkSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOPIC_DISPLAY_MAX = 117;
export const HANDOFF_TOPIC_FILENAME = ".handoff-topic";
/**
 * Secondary sidecar written by the progress-card driver on every
 * successful turn_end. The file is overwritten each turn so it always
 * reflects the most-recent turn. Used as a fallback source for the
 * continuity line when the Stop-hook summarizer hasn't run yet (e.g.
 * crash, mid-session restart, summarizer failure). Deleted alongside
 * `.handoff-topic` in `consumeHandoffTopic`.
 */
export const LAST_TURN_SUMMARY_FILENAME = ".last-turn-summary";

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
 * Read the per-turn summary file if present (written by the progress-
 * card driver on every turn_end). Returns the trimmed first non-empty
 * line, truncated like `readHandoffTopic`. The file is always
 * overwritten so it reflects the most-recent completed turn.
 */
export function readLastTurnSummary(agentDir: string): string | null {
  const p = join(agentDir, LAST_TURN_SUMMARY_FILENAME);
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
 *
 * Fallback: if no `.handoff-topic` is present (summarizer didn't run,
 * crashed, or the session was restarted mid-loop), try the
 * `.last-turn-summary` sidecar written by the progress-card driver.
 * Both sidecars get removed on consume so the continuity line only
 * fires once per resume.
 */
export function consumeHandoffTopic(agentDir: string): string | null {
  const primary = readHandoffTopic(agentDir);
  const primaryPath = join(agentDir, HANDOFF_TOPIC_FILENAME);
  const fallbackPath = join(agentDir, LAST_TURN_SUMMARY_FILENAME);

  // Always remove the per-turn summary when we consume — otherwise a
  // later session restart would still see a stale entry even after the
  // continuity line fired.
  const removeFallback = (): void => {
    try {
      unlinkSync(fallbackPath);
    } catch {
      /* already gone */
    }
  };

  if (primary !== null) {
    try {
      unlinkSync(primaryPath);
    } catch {
      /* already gone */
    }
    removeFallback();
    return primary;
  }

  const fallback = readLastTurnSummary(agentDir);
  if (fallback !== null) {
    removeFallback();
    return fallback;
  }
  return null;
}

/**
 * Atomically overwrite `.last-turn-summary` with a single-line summary.
 * Called by the progress-card driver on every turn_end. Best-effort: any
 * write failure is swallowed (logged by the caller if desired) — a
 * missing fallback file is recoverable, a half-written one is not.
 *
 * The summary is the natural plain-text signature of a completed turn:
 *   `<N tools, Ys> — <user request (truncated)>`
 * Callers should pass a pre-built line; this function handles only the
 * atomic write + first-line discipline.
 */
export function writeLastTurnSummary(agentDir: string, summary: string): void {
  const line = summary.split(/\r?\n/)[0]?.trim() ?? "";
  if (line.length === 0) return;
  const final = line.length > TOPIC_DISPLAY_MAX
    ? line.slice(0, TOPIC_DISPLAY_MAX) + "…"
    : line;
  const p = join(agentDir, LAST_TURN_SUMMARY_FILENAME);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, final + "\n", "utf-8");
    renameSync(tmp, p);
  } catch {
    /* best-effort — continuity line is purely cosmetic */
  }
}

/**
 * Reads SWITCHROOM_HANDOFF_SHOW_LINE. Defaults to true when unset so users
 * opt out explicitly via switchroom.yaml rather than opt in.
 */
export function shouldShowHandoffLine(): boolean {
  const v = process.env.SWITCHROOM_HANDOFF_SHOW_LINE;
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
