/**
 * Proactive quota threshold-tier push (#E4).
 *
 * Background: JTBD `track-plan-quota-live` anti-pattern: "Quota visible
 * only in a separate dashboard or a command. If the user has to go
 * looking, they won't, and they'll hit the wall." The existing stack
 * covers the wall (auto-fallback at 99.5%, credits-watch on fatal billing
 * transitions) but fires zero proactive signal at 80% — the point where
 * the user can still act by switching accounts. This module closes that gap.
 *
 * It is a pure decision layer. It reads the broker's cached quota state
 * for all accounts, classifies health via the same `classifyHealth`
 * three-state machine used by the /auth dashboard, compares against a
 * persisted last-notified state, and tells the gateway whether to emit
 * a Telegram message + what to say. The gateway wires the actual
 * `bot.api.sendMessage` call (via `swallowingApiCall`) — same as
 * `credits-watch.ts`.
 *
 * Edge-trigger discipline: only fires on health *transitions*
 * (healthy → throttling and throttling → healthy). Does NOT fire on
 * healthy → blocked or blocked → healthy — `credits-watch.ts` already
 * covers those via the fatal-billing path. Steady-state throttling
 * never re-notifies.
 *
 * Scope: per-account across the whole pool, not just the active one.
 * The user's natural recovery action is switching to a healthy account,
 * so they need visibility into non-active accounts too.
 *
 * Source data: broker `listState` + `probeQuota`. `listState` is a local
 * IPC call (cheap). `probeQuota` is only called on state-change (when
 * we're going to send a message anyway) to get fresh numbers for the
 * notification body. On no-change polls, only `listState` is called.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AccountSnapshot } from "./auth-snapshot-format.js";
import {
  classifyHealth,
  type AccountHealth,
  THROTTLING_THRESHOLD_PCT,
  bindingWindow,
  formatRelative,
  fmtPct,
} from "./auth-snapshot-format.js";
import type { QuotaUtilization } from "./quota-check.js";

const STATE_FILE = "quota-watch.json";

// ─── State types ──────────────────────────────────────────────────────────────

/**
 * Per-account last-notified health. We only care about the
 * healthy ↔ throttling boundary — blocked is `credits-watch`'s domain.
 * `null` means "never notified" (treat as healthy for transition logic).
 */
export type QuotaWatchHealth = "healthy" | "throttling" | null;

export interface QuotaWatchAccountState {
  /** Last health we sent a notification for. null = never notified. */
  lastNotifiedHealth: QuotaWatchHealth;
  /** Wall-clock ms of the last notification. */
  lastNotifiedAt: number;
}

export type QuotaWatchState = Record<string, QuotaWatchAccountState>;

export function emptyQuotaWatchState(): QuotaWatchState {
  return {};
}

export function emptyAccountState(): QuotaWatchAccountState {
  return { lastNotifiedHealth: null, lastNotifiedAt: 0 };
}

// ─── Decision logic ───────────────────────────────────────────────────────────

export type QuotaWatchTransition =
  | "entered-throttling"
  | "recovered-to-healthy";

export type QuotaWatchDecision =
  | {
      kind: "notify";
      accountLabel: string;
      message: string;
      newAccountState: QuotaWatchAccountState;
      transition: QuotaWatchTransition;
    }
  | { kind: "skip"; accountLabel: string; reason: string };

/**
 * Evaluate one account's quota state against its last-notified health.
 *
 * Transition table:
 *   healthy → healthy        skip (steady-state)
 *   healthy → throttling     notify (entered-throttling)
 *   healthy → blocked        skip (credits-watch covers this)
 *   throttling → healthy     notify (recovered-to-healthy)
 *   throttling → throttling  skip (already notified)
 *   throttling → blocked     skip (credits-watch covers blocked)
 *   blocked → *              skip (credits-watch domain)
 *   unknown → *              skip (no quota data — don't spam)
 *   * → unknown              skip (probe failed — transient, don't alarm)
 */
export function evaluateQuotaWatchAccount(args: {
  agentName: string;
  snap: AccountSnapshot;
  prev: QuotaWatchAccountState;
  now: number;
}): QuotaWatchDecision {
  const { agentName, snap, prev, now } = args;
  const label = snap.label;
  const currentHealth = classifyHealth(snap);

  // Unknown (probe failed) or blocked — skip entirely.
  if (currentHealth === "unknown" || currentHealth === "blocked") {
    return { kind: "skip", accountLabel: label, reason: `${currentHealth}-not-our-domain` };
  }

  // Normalise prev: null means healthy (never alerted = was healthy).
  const prevHealth: "healthy" | "throttling" = prev.lastNotifiedHealth ?? "healthy";

  // Steady-state — no change.
  if (currentHealth === prevHealth) {
    return { kind: "skip", accountLabel: label, reason: "steady-state" };
  }

  // healthy → throttling: proactive threshold push.
  if (currentHealth === "throttling" && prevHealth === "healthy") {
    const newState: QuotaWatchAccountState = {
      lastNotifiedHealth: "throttling",
      lastNotifiedAt: now,
    };
    return {
      kind: "notify",
      accountLabel: label,
      message: buildThrottlingMessage(agentName, snap),
      newAccountState: newState,
      transition: "entered-throttling",
    };
  }

  // throttling → healthy: recovery.
  if (currentHealth === "healthy" && prevHealth === "throttling") {
    const newState: QuotaWatchAccountState = {
      lastNotifiedHealth: "healthy",
      lastNotifiedAt: now,
    };
    return {
      kind: "notify",
      accountLabel: label,
      message: buildRecoveryMessage(agentName, snap),
      newAccountState: newState,
      transition: "recovered-to-healthy",
    };
  }

  // Any other combination (e.g. blocked → healthy, etc.) — skip.
  return { kind: "skip", accountLabel: label, reason: "no-matching-transition" };
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildThrottlingMessage(agentName: string, snap: AccountSnapshot): string {
  const q = snap.quota!; // classifyHealth returned throttling, so quota is non-null
  const fiveStr = fmtPct(q.fiveHourUtilizationPct);
  const sevenStr = fmtPct(q.sevenDayUtilizationPct);
  const max = Math.max(q.fiveHourUtilizationPct, q.sevenDayUtilizationPct);
  const win = max === q.fiveHourUtilizationPct ? "5h" : "7d";
  const winLabel = win === "5h" ? "5-hour" : "7-day";
  const resetAt = win === "5h" ? q.fiveHourResetAt : q.sevenDayResetAt;
  const resetStr = resetAt
    ? ` · refills in ${formatRelative(resetAt, new Date())}`
    : "";

  const activeNote = snap.isActive
    ? ""
    : `\nThis is a non-active account. Consider <code>/auth use ${escapeHtml(snap.label)}</code> to switch, or keep it as a fallback reserve.`;

  const altNote = snap.isActive
    ? `\nConsider <code>/auth use &lt;other-account&gt;</code> if you have a healthier account, or wait for the ${winLabel} window to refill${resetStr}.`
    : "";

  return [
    `🟡 <b>Quota approaching limit</b> — <code>${escapeHtml(snap.label)}</code>`,
    ``,
    `${fiveStr} of 5h  ·  ${sevenStr} of 7d`,
    `Binding window: ${winLabel}${resetStr}`,
    `${activeNote}${altNote}`,
    ``,
    `<i>Threshold: ${THROTTLING_THRESHOLD_PCT}% on either window. Source: broker quota cache.</i>`,
    `<i>Run /auth for full fleet status or /usage for the active account.</i>`,
  ]
    .join("\n")
    .replace(/\n\n\n+/g, "\n\n")
    .trim();
}

function buildRecoveryMessage(agentName: string, snap: AccountSnapshot): string {
  const q = snap.quota;
  const utilLine = q
    ? `Current: ${fmtPct(q.fiveHourUtilizationPct)} of 5h  ·  ${fmtPct(q.sevenDayUtilizationPct)} of 7d`
    : "Current quota data unavailable.";

  return [
    `🟢 <b>Quota back in healthy range</b> — <code>${escapeHtml(snap.label)}</code>`,
    ``,
    utilLine,
    ``,
    `<i>Below ${THROTTLING_THRESHOLD_PCT}% on both windows.</i>`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── State persistence ────────────────────────────────────────────────────────

export function loadQuotaWatchState(stateDir: string): QuotaWatchState {
  const path = join(stateDir, STATE_FILE);
  if (!existsSync(path)) return emptyQuotaWatchState();
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyQuotaWatchState();
    }
    // Validate each entry — drop malformed ones rather than failing the whole file.
    const result: QuotaWatchState = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        (
          (val as Record<string, unknown>).lastNotifiedHealth === null ||
          (val as Record<string, unknown>).lastNotifiedHealth === "healthy" ||
          (val as Record<string, unknown>).lastNotifiedHealth === "throttling"
        ) &&
        typeof (val as Record<string, unknown>).lastNotifiedAt === "number" &&
        Number.isFinite((val as Record<string, unknown>).lastNotifiedAt as number)
      ) {
        result[key] = val as QuotaWatchAccountState;
      }
    }
    return result;
  } catch {
    return emptyQuotaWatchState();
  }
}

export function saveQuotaWatchState(stateDir: string, state: QuotaWatchState): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, STATE_FILE);
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Merge one account's updated state into a full `QuotaWatchState` map.
 * Callers use this after each `evaluateQuotaWatchAccount` that returns
 * `kind: "notify"` to produce the new map to persist.
 */
export function patchQuotaWatchState(
  current: QuotaWatchState,
  accountLabel: string,
  accountState: QuotaWatchAccountState,
): QuotaWatchState {
  return { ...current, [accountLabel]: accountState };
}
