/**
 * watch.ts — the scheduled half of OpenRouter credit monitoring.
 *
 * `switchroom doctor` answers "is credit low RIGHT NOW, when someone asks".
 * This answers "tell me before I have to ask". Same evaluator (`./credit.ts`),
 * so the two can never disagree about what "low" means.
 *
 * HOUSE PATTERN, deliberately copied rather than reinvented
 * --------------------------------------------------------
 * `src/hindsight-watch/` is switchroom's existing model-free watchdog: a host
 * CLI verb on a host cron, zero model tokens per tick, durable state under
 * `~/.switchroom/`, and delivery through `postOperatorNoticeViaGateways`. This
 * reuses that shape and, critically, its `RENOTIFY_MS` (6 h) so every standing
 * operator alert in switchroom repeats on ONE rhythm rather than each watchdog
 * inventing its own.
 *
 * WHAT IT WILL AND WILL NOT WAKE THE OPERATOR FOR
 * ----------------------------------------------
 * Only an `actionable` assessment DMs (see `CreditAssessment.actionable`):
 * a quantified shortfall, or a key the API rejects outright.
 *
 * It deliberately does NOT DM for the "no per-key limit set, so credit cannot
 * be measured" case, even though `doctor` reports that as a WARN. That is a
 * standing CONFIGURATION GAP, not an incident — it will be equally true in six
 * hours and in six weeks, and paging someone about it on a timer is exactly how
 * an alert channel gets muted. It belongs in `doctor`, where the operator went
 * looking; not in their DMs, where it arrived uninvited.
 *
 * Pure module: no network, no FS, no clock, no bot. The CLI verb injects them.
 */

import type { CreditAssessment } from "./credit.js";

/**
 * Re-notify cadence, matched to `src/hindsight-watch/thresholds.ts`
 * (`RENOTIFY_MS`) — one rhythm for every standing operator alert.
 */
export const RENOTIFY_MS = 6 * 60 * 60 * 1000;

/** Durable state. Small on purpose — it survives a torn write by degrading. */
export interface CreditWatchState {
  /** Epoch ms of the last DM, per severity. */
  lastNotifiedAt?: number;
  /** The status that was last notified, so an escalation re-fires immediately. */
  lastNotifiedStatus?: string;
}

export interface WatchDecision {
  /** The DM to send, or `null` to stay silent this tick. */
  notice: string | null;
  /** State to persist. */
  nextState: CreditWatchState;
  /** Cron-meaningful: true when a signal is firing (whether or not it DM'd). */
  firing: boolean;
}

/**
 * Decide what this tick does.
 *
 * Escalation beats the cooldown: if the previous DM said "running low" and it
 * is now "critically low", the operator hears about it immediately rather than
 * up to six hours later. A REPEAT of the same severity waits out the window.
 * De-escalation and recovery are silent — nobody needs a DM saying a problem
 * they were told about got smaller.
 */
export function decideNotification(
  assessment: CreditAssessment,
  state: CreditWatchState,
  now: number,
): WatchDecision {
  if (!assessment.actionable) {
    // Nothing firing → clear the ledger so a NEW incident notifies at once
    // rather than being swallowed by a stale cooldown from a resolved one.
    return { notice: null, nextState: {}, firing: false };
  }

  const escalated =
    state.lastNotifiedStatus != null &&
    state.lastNotifiedStatus !== "fail" &&
    assessment.status === "fail";
  const cooled =
    state.lastNotifiedAt == null || now - state.lastNotifiedAt >= RENOTIFY_MS;

  if (!escalated && !cooled) {
    // Firing, but already reported and not worse. Keep the state as-is.
    return { notice: null, nextState: state, firing: true };
  }

  const repeat = state.lastNotifiedAt != null && !escalated;
  return {
    notice: renderNotice(assessment, { repeat, escalated }),
    nextState: { lastNotifiedAt: now, lastNotifiedStatus: assessment.status },
    firing: true,
  };
}

/**
 * The operator DM. Names the provider, the VAULT KEY NAME (never a value) and
 * the action — the same contract as every other operator alert in switchroom.
 */
export function renderNotice(
  assessment: CreditAssessment,
  opts: { repeat: boolean; escalated: boolean },
): string {
  const head =
    assessment.status === "fail"
      ? opts.escalated
        ? "🚨 OpenRouter credit — ESCALATED"
        : "🚨 OpenRouter credit"
      : "⚠️ OpenRouter credit";
  const suffix = opts.repeat && !opts.escalated ? " (still unresolved)" : "";
  return [
    `${head}${suffix}`,
    assessment.detail,
    assessment.fix ? `→ ${assessment.fix}` : "",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}
