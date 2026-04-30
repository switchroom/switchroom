/**
 * Issues card — pinned per-agent surface that shows current unresolved
 * issues from the sink (#425). Phase 0.4 of #424.
 *
 * One card per agent / chat. Edited in place when the issue list
 * changes. Deleted when the count drops to zero AND a card was
 * previously posted, so healthy agents don't carry permanent visual
 * clutter.
 *
 * Severity → emoji: info ℹ️, warn ⚠️, error 🔴, critical 🚨. The
 * card's header emoji is the max severity in the list. So a glance
 * tells the user "is anything critical?" without reading rows.
 *
 * Pure formatting + state machine. No telegram I/O — caller wires
 * the bot API. Mirrors `boot-card.ts`'s shape so the gateway can
 * reuse the same patterns.
 */

import { escapeHtml } from "./card-format.js";
import type { IssueEvent, IssueSeverity } from "../src/issues/index.js";

export interface BotApiForIssuesCard {
  sendMessage(
    chatId: string,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
}

const SEVERITY_EMOJI: Record<IssueSeverity, string> = {
  info: "ℹ️",
  warn: "⚠️",
  error: "🔴",
  critical: "🚨",
};

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

/**
 * Render the issues card body as HTML. Returns null when there are
 * zero unresolved events — the caller should treat null as "delete
 * any existing card" rather than try to send an empty message (which
 * Telegram refuses anyway).
 *
 * Layout:
 *   <maxEmoji> <agent> · N issues
 *
 *   <emoji> <severity-padded> <source>::<code>  <summary>  (×N) — <relative time>
 *   ... up to MAX_ROWS rows ...
 *   (+ M more not shown)
 *
 * Long rows are truncated; max-rows is bounded so a runaway agent
 * with hundreds of distinct fingerprints doesn't blow Telegram's
 * 4096-char message cap.
 */
export interface RenderIssuesCardOpts {
  agentName: string;
  events: IssueEvent[];
  /** For relative-time rendering. Override in tests. */
  now?: number;
  /** Max rows shown in the card. Default 10 — extras roll up to "+N more". */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 10;

export function renderIssuesCard(opts: RenderIssuesCardOpts): string | null {
  const events = opts.events.filter((e) => e.resolved_at == null);
  if (events.length === 0) return null;

  // Sort: highest severity first; within same severity, most recent first.
  const sorted = [...events].sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity];
    const rb = SEVERITY_RANK[b.severity];
    if (rb !== ra) return rb - ra;
    return b.last_seen - a.last_seen;
  });

  const maxSeverity = sorted[0].severity;
  const headerEmoji = SEVERITY_EMOJI[maxSeverity];
  const count = sorted.length;
  const header = `${headerEmoji} <b>${escapeHtml(opts.agentName)}</b> · ${count} ${count === 1 ? "issue" : "issues"}`;

  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const visible = sorted.slice(0, maxRows);
  const overflow = sorted.length - visible.length;

  const now = opts.now ?? Date.now();
  const rows = visible.map((e) => {
    const emoji = SEVERITY_EMOJI[e.severity];
    const occ = e.occurrences > 1 ? ` <i>(×${e.occurrences})</i>` : "";
    const ago = relTime(now - e.last_seen);
    return `${emoji} <code>${escapeHtml(e.fingerprint)}</code>  ${escapeHtml(e.summary)}${occ} — <i>${ago}</i>`;
  });

  const lines = [header, "", ...rows];
  if (overflow > 0) {
    lines.push("");
    lines.push(`<i>+${overflow} more not shown — run <code>/issues</code></i>`);
  }
  return lines.join("\n");
}

function relTime(deltaMs: number): string {
  if (deltaMs < 0) return "just now";
  const s = Math.round(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * Stateful handle managing the lifecycle of the pinned card for one
 * (agent, chat) pair. Caller drives `refresh()` when the issue list
 * changes; the handle decides whether to post, edit, or delete.
 *
 * Resilient to message_id drift: if `editMessageText` rejects (the
 * pinned card was manually deleted, or the bot's edit window expired),
 * the next refresh re-posts a new card.
 */
export interface IssuesCardHandle {
  /** Currently posted card's message_id, or null if nothing is posted. */
  messageId(): number | null;
  /** Re-render against the current event list. Idempotent. */
  refresh(events: IssueEvent[]): Promise<void>;
}

export interface CreateIssuesCardOpts {
  agentName: string;
  chatId: string;
  /** Forum topic / thread id, if posting into a topic chat. */
  threadId?: number;
  bot: BotApiForIssuesCard;
  /** Override Date.now for tests. */
  now?: () => number;
  /** Override default maxRows. */
  maxRows?: number;
  /** stderr-style log sink. Defaults to noop. */
  log?: (msg: string) => void;
}

/**
 * Inspect an error thrown by a grammY API call and, if it's a 429
 * flood-wait, return the retry_after value in seconds. Returns null
 * for any non-429 error (or non-grammY shape). We avoid importing
 * `GrammyError` directly to keep this module test-friendly — duck-typing
 * on the documented public field shape suffices for our needs.
 *
 * See #442.
 */
function extractRetryAfterSecs(err: unknown): number | null {
  if (err == null || typeof err !== "object") return null;
  const e = err as { error_code?: unknown; parameters?: { retry_after?: unknown } };
  if (e.error_code !== 429) return null;
  const ra = e.parameters?.retry_after;
  if (typeof ra === "number" && Number.isFinite(ra) && ra > 0) return ra;
  return null;
}

const COOLDOWN_JITTER_MS = 500;

export function createIssuesCardHandle(
  opts: CreateIssuesCardOpts,
): IssuesCardHandle {
  let messageId: number | null = null;
  let lastBody: string | null = null;
  // Cooldown gate: when we hit a 429, suspend further refreshes until
  // retry_after elapses. The watcher polls every 2s; without this gate
  // we'd burn through grammY's auto-retry budget and risk a bot-wide
  // 24h ban under sustained issue-flapping. See #442.
  let cooldownUntil = 0;
  const log = opts.log ?? (() => {});
  const nowFn = opts.now ?? Date.now;

  function noteRateLimited(err: unknown, label: string): void {
    const retryAfter = extractRetryAfterSecs(err);
    if (retryAfter == null) return;
    cooldownUntil = nowFn() + retryAfter * 1000 + COOLDOWN_JITTER_MS;
    log(
      `issues-card: ${label} 429 — backing off ${retryAfter}s (cooldown until ${cooldownUntil})`,
    );
  }

  return {
    messageId() {
      return messageId;
    },
    async refresh(events: IssueEvent[]) {
      // Honour Telegram's flood-wait. Skipping a refresh is cheap;
      // burning through the wait is what gets bots banned.
      if (nowFn() < cooldownUntil) return;

      const body = renderIssuesCard({
        agentName: opts.agentName,
        events,
        now: nowFn(),
        maxRows: opts.maxRows,
      });

      // Healthy: no card needed. Delete the existing one if any.
      if (body == null) {
        if (messageId != null) {
          try {
            await opts.bot.deleteMessage(opts.chatId, messageId);
          } catch (err) {
            noteRateLimited(err, "delete");
            log(`issues-card: delete failed: ${(err as Error).message}`);
          }
          messageId = null;
          lastBody = null;
        }
        return;
      }

      // No-op when nothing changed (avoid spamming editMessageText on
      // unchanged renders, which Telegram rate-limits).
      if (body === lastBody && messageId != null) return;

      const sendOpts: Record<string, unknown> = {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
      };

      if (messageId == null) {
        try {
          const sent = await opts.bot.sendMessage(opts.chatId, body, sendOpts);
          messageId = sent.message_id;
          lastBody = body;
        } catch (err) {
          noteRateLimited(err, "send");
          log(`issues-card: send failed: ${(err as Error).message}`);
        }
        return;
      }

      try {
        await opts.bot.editMessageText(opts.chatId, messageId, body, sendOpts);
        lastBody = body;
      } catch (err) {
        noteRateLimited(err, "edit");
        // The card's message_id is stale (manually deleted, edit window
        // expired, etc.). Re-post fresh on the next tick.
        log(`issues-card: edit failed, re-posting: ${(err as Error).message}`);
        messageId = null;
        lastBody = null;
        // If we've just been told to back off, don't double-down by
        // immediately re-posting — let the cooldown gate above pick
        // up the next call.
        if (nowFn() < cooldownUntil) return;
        try {
          const sent = await opts.bot.sendMessage(opts.chatId, body, sendOpts);
          messageId = sent.message_id;
          lastBody = body;
        } catch (err2) {
          noteRateLimited(err2, "re-post");
          log(`issues-card: re-post failed: ${(err2 as Error).message}`);
        }
      }
    },
  };
}
