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
 * the worst case — see reference/jobs/know-what-my-agent-is-doing.md).
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
 * Which `cachedExtraUsageDisabledReason` values warrant a user-facing alarm.
 *
 * IMPORTANT — empty by default (subscription-only model). The flag name says it
 * all: `cachedExtraUsageDisabledReason` is *always* "why **extra usage** (the
 * optional pay-as-you-go layer beyond the Pro/Max plan) is disabled." switchroom
 * is subscription-only by design (compliance pillar 3 — "the plan is the
 * ceiling, no API/pay-as-you-go"), so extra usage being OFF is the **expected,
 * desired** state. Every value (`out_of_credits`, `extra_usage_disabled`,
 * `credits_exhausted`, even `org_level_disabled` = "org admin disabled extra
 * usage") describes that benign state — none indicates a real switchroom
 * failure. Firing a "cron + replies will fail, buy credits" card on it is a
 * false alarm AND advises something that contradicts the subscription-honest
 * model.
 *
 * The genuine failure modes are covered elsewhere:
 *   - an account's subscription window exhausts → stderr → fleet auto-fallback
 *     (model-unavailable.ts → fireFleetAutoFallback) rolls to a healthy account;
 *   - the WHOLE fleet exhausts → the quota-watch all-exhausted operator alert.
 *
 * So credits-watch defaults to silent. An operator who actually runs on
 * pay-as-you-go and wants the alarm can opt specific reasons back in via
 * `SWITCHROOM_CREDITS_WATCH_FATAL_REASONS` (comma-separated). See
 * `resolveCreditWatchFatalReasons`.
 */
export const DEFAULT_CREDIT_FATAL_REASONS = new Set<string>();

/** All reason strings recognized for opt-in via the env var. */
const KNOWN_CREDIT_REASONS = [
  "out_of_credits",
  "org_level_disabled",
  "credits_exhausted",
  "extra_usage_disabled",
] as const;

/**
 * Resolve the active fatal-reason set. Empty by default (subscription-only);
 * if `SWITCHROOM_CREDITS_WATCH_FATAL_REASONS` is set, parse it as a
 * comma-separated list (tokens kept verbatim — an unknown token is harmless,
 * it simply never matches a real reason value). `*` opts in all known reasons.
 */
export function resolveCreditWatchFatalReasons(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.SWITCHROOM_CREDITS_WATCH_FATAL_REASONS;
  if (!raw || raw.trim().length === 0) return new Set(DEFAULT_CREDIT_FATAL_REASONS);
  if (raw.trim() === "*") return new Set(KNOWN_CREDIT_REASONS);
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  return wanted;
}

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
  /**
   * Which reasons are treated as fatal (worth alarming). Defaults to
   * `DEFAULT_CREDIT_FATAL_REASONS` (empty — subscription-only: extra-usage-off
   * is never a real failure). The gateway passes the env-resolved set.
   */
  fatalReasons?: Set<string>;
}): CreditDecision {
  const { agentName, currentReason, prev, now } = args;
  const fatalReasons = args.fatalReasons ?? DEFAULT_CREDIT_FATAL_REASONS;

  // Non-fatal current state (null, or some unknown reason) — no
  // notification regardless of prev (we already notified on entry to
  // fatal; recovery from a known-fatal state below is the only path
  // that fires when current is null).
  const currentIsFatal = currentReason != null && fatalReasons.has(currentReason);
  const prevIsFatal = prev.lastNotifiedReason != null && fatalReasons.has(prev.lastNotifiedReason);

  // Recovery path: last-notified was fatal, current is null/non-fatal.
  if (!currentIsFatal && prevIsFatal) {
    return {
      kind: "notify",
      message: `✅ **${escapeHtml(agentName)}**: credits restored — agent should resume normal operation.`,
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
    `⚠️ **${escapeHtml(agentName)}**: ${desc}`,
    ``,
    `Cron tasks and inbound replies will fail until this is resolved. Check`,
    `your subscription or pre-paid usage at [console.anthropic.com](https://console.anthropic.com).`,
    ``,
    `_Source: Claude CLI cache (cachedExtraUsageDisabledReason=${escapeHtml(reason)})_`,
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
  return s.replace(/([\\`*_~=\[\]|])/g, "\\$1");
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
