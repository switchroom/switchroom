/**
 * Claude-independent credit-exhaustion notify (#348).
 *
 * Background: Anthropic's API rate-limit headers (used by quota-check.ts)
 * tell us 5h/7d utilization, but they don't surface plan-level credit
 * exhaustion ("out of pre-paid usage", "billing disabled by org admin",
 * etc). Claude Code itself caches that signal in `.claude.json` as
 * `cachedExtraUsageDisabledReason`. When the agent runs into the wall —
 * especially in a cron context where stdout is discarded — Switchroom
 * has no way to tell the user without ALSO checking that file.
 *
 * Pre-#348: cron-issued requests against an out-of-credits account
 * silently failed (stdout to /dev/null), and the user only noticed
 * hours later when they wondered why their morning brief never came.
 * Direct violation of the #1 product principle (silent failure is
 * the worst case — see reference/know-what-my-agent-is-doing.md).
 *
 * This module is a pure decision layer. It reads the file, compares
 * against the last-notified state on disk, and tells the caller
 * whether to emit a Telegram message + what to say. The gateway
 * wires the actual `bot.api.sendMessage` call.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const STATE_FILE = "credits-watch.json";

/**
 * Possible values of `cachedExtraUsageDisabledReason` in `.claude.json`
 * that warrant a user-facing notification. Other values (null,
 * undefined, transient unknowns) are treated as "no notification
 * needed".
 *
 * Conservative list: only fatal-billing reasons. We don't want to fire
 * on every transient API blip the cache happens to write.
 */
const FATAL_REASONS = new Set([
  "out_of_credits",
  "org_level_disabled",
  "credits_exhausted",
  "extra_usage_disabled",
]);

export interface CreditState {
  /** Last reason we notified the user about. null when healthy / never notified. */
  lastNotifiedReason: string | null;
  /** Wall-clock ms when we last notified. */
  lastNotifiedAt: number;
}

export function emptyCreditState(): CreditState {
  return { lastNotifiedReason: null, lastNotifiedAt: 0 };
}

/**
 * Read `.claude.json` and return the cached extra-usage-disabled reason.
 * Returns null when:
 *   - The file is missing (Claude Code hasn't booted yet on this machine)
 *   - The file is unreadable / malformed
 *   - The field is unset, null, or not a string
 */
export function readClaudeJsonOverage(claudeConfigDir: string): string | null {
  const path = join(claudeConfigDir, ".claude.json");
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const reason = (parsed as { cachedExtraUsageDisabledReason?: unknown })
    .cachedExtraUsageDisabledReason;
  if (typeof reason !== "string" || reason.length === 0) return null;
  return reason;
}

/**
 * Pure decision: given the current `.claude.json` reason and the last
 * notified state, decide whether to notify and what state to write.
 *
 * Transition table (current → previous → action):
 *   - fatal-X → no-prev or healthy → notify (new fatal state)
 *   - fatal-X → fatal-X → skip (already notified for this exact reason)
 *   - fatal-X → fatal-Y → notify (state changed; X != Y)
 *   - healthy → fatal-X → notify (recovered — let user know it's working again)
 *   - healthy → healthy → skip (steady-state)
 *   - non-fatal-X → anything → skip (unknown/transient state, don't pollute)
 */
export type CreditDecision =
  | { kind: "notify"; message: string; newState: CreditState; transition: "entered" | "exited" | "changed" }
  | { kind: "skip"; reason: string };

export function evaluateCreditState(args: {
  agentName: string;
  currentReason: string | null;
  prev: CreditState;
  now: number;
}): CreditDecision {
  const { agentName, currentReason, prev, now } = args;

  // Non-fatal current state (null, or some unknown reason) — no
  // notification regardless of prev (we already notified on entry to
  // fatal; recovery from a known-fatal state below is the only path
  // that fires when current is null).
  const currentIsFatal = currentReason != null && FATAL_REASONS.has(currentReason);
  const prevIsFatal = prev.lastNotifiedReason != null && FATAL_REASONS.has(prev.lastNotifiedReason);

  // Recovery path: last-notified was fatal, current is null/non-fatal.
  if (!currentIsFatal && prevIsFatal) {
    return {
      kind: "notify",
      message: `✅ <b>${escapeHtml(agentName)}</b>: credits restored — agent should resume normal operation.`,
      newState: { lastNotifiedReason: null, lastNotifiedAt: now },
      transition: "exited",
    };
  }

  // Entry path: current is fatal, prev was healthy.
  if (currentIsFatal && !prevIsFatal) {
    return {
      kind: "notify",
      message: buildEntryMessage(agentName, currentReason!),
      newState: { lastNotifiedReason: currentReason, lastNotifiedAt: now },
      transition: "entered",
    };
  }

  // Reason-change path: both fatal but different value.
  if (currentIsFatal && prevIsFatal && currentReason !== prev.lastNotifiedReason) {
    return {
      kind: "notify",
      message: buildEntryMessage(agentName, currentReason!),
      newState: { lastNotifiedReason: currentReason, lastNotifiedAt: now },
      transition: "changed",
    };
  }

  // Steady-state cases: no notification.
  if (currentIsFatal && prevIsFatal) {
    return { kind: "skip", reason: "already-notified-for-this-reason" };
  }
  return { kind: "skip", reason: "no-fatal-state" };
}

function buildEntryMessage(agentName: string, reason: string): string {
  const desc = humanizeReason(reason);
  return [
    `⚠️ <b>${escapeHtml(agentName)}</b>: ${desc}`,
    ``,
    `Cron tasks and inbound replies will fail until this is resolved. Check`,
    `your subscription or pre-paid usage at <a href="https://console.anthropic.com">console.anthropic.com</a>.`,
    ``,
    `<i>Source: Claude CLI cache (cachedExtraUsageDisabledReason=${escapeHtml(reason)})</i>`,
  ].join("\n");
}

function humanizeReason(reason: string): string {
  switch (reason) {
    case "out_of_credits":
      return "out of pre-paid credits";
    case "org_level_disabled":
      return "org admin has disabled extra usage";
    case "credits_exhausted":
      return "subscription credits exhausted";
    case "extra_usage_disabled":
      return "extra-usage billing is disabled";
    default:
      return `usage disabled (${reason})`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── State persistence ───────────────────────────────────────────────────────

export function loadCreditState(stateDir: string): CreditState {
  const path = join(stateDir, STATE_FILE);
  if (!existsSync(path)) return emptyCreditState();
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.lastNotifiedReason === null ||
        typeof parsed.lastNotifiedReason === "string") &&
      typeof parsed.lastNotifiedAt === "number" &&
      Number.isFinite(parsed.lastNotifiedAt)
    ) {
      return {
        lastNotifiedReason: parsed.lastNotifiedReason,
        lastNotifiedAt: parsed.lastNotifiedAt,
      };
    }
  } catch {
    /* fall through */
  }
  return emptyCreditState();
}

export function saveCreditState(stateDir: string, state: CreditState): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, STATE_FILE);
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}
