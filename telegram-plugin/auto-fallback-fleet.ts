/**
 * Fleet-wide auto-fallback (RFC H — successor to the per-agent
 * `performAutoFallback` in `auto-fallback.ts`).
 *
 * Why this exists alongside the legacy per-agent path:
 *
 *   The pre-#XYZ auto-fallback called `fallbackToNextSlot(agentDir)`,
 *   which writes the new active slot to ONE agent's local
 *   `.claude/credentials.json`. That left the rest of the fleet still
 *   pointing at the just-exhausted account — which would then hit the
 *   wall on its own next call, surfacing N separate "Model unavailable"
 *   cards for the same root cause.
 *
 *   Manual `/auth use <label>` already takes the fleet-wide path
 *   (broker.setActive → fan-out to all per-agent credential mirrors).
 *   Auto-fallback now uses the same path so scope is consistent and
 *   one quota event resolves the whole fleet in one swap.
 *
 * What this module does:
 *
 *   1. Probe live quota for every account in parallel via the
 *      broker (`client.probeQuota(...)`, #1336) so we pick the best
 *      target with current data, not stale broker disk-cache.
 *   2. Skip blocked accounts entirely; pick the lowest-utilization
 *      healthy candidate (or, if none, the lowest throttling one).
 *   3. Call `client.setActive(target)` — same broker verb /auth use
 *      uses. Broker re-mirrors creds to all agents.
 *   4. Render the causal-shape announcement
 *      (`renderFallbackAnnouncement`) with the OLD account's binding
 *      window in the headline (5-hour vs 7-day) and the new
 *      account's headroom in the body.
 *
 * Pure-data return shape — caller does the actual Telegram send +
 * lockout-record bookkeeping, mirroring the legacy module's contract.
 */

import type { QuotaResult, QuotaUtilization } from './quota-check.js';
import type { ListStateData } from '../src/auth/broker/client.js';
import {
  renderFallbackAnnouncement,
  classifyHealth,
  buildSnapshotsFromState,
} from './auth-snapshot-format.js';

/**
 * Failure notice for when the fallback dispatcher itself errors (broker
 * unreachable, listState/markExhausted throw). The model-unavailable
 * card renders "Auto-failover in progress — see the announcement below"
 * BEFORE the outcome is known; every error path must therefore still
 * produce an announcement or the card's promise is broken (the
 * 2026-06-06→07 incident: 12 cards promised an announcement while every
 * dispatch errored "set-active requires admin" — log-only, nothing
 * arrived). Pure builder so the shape is unit-testable.
 */
export function renderFallbackFailureNotice(triggerAgent: string, reason: string): string {
  return (
    `⚠️ <b>Auto-failover could not run</b> (trigger: <b>${escFailureHtml(triggerAgent)}</b>)\n` +
    `${escFailureHtml(reason)}\n\n` +
    `<i>Switch manually with <code>/auth use &lt;label&gt;</code>, or <code>/auth</code> for fleet status.</i>`
  );
}

function escFailureHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Cooldown for the failure notice. The fleetFallbackGate's dedup window
 * deliberately arms ONLY on a successful swap (fleet-fallback-gate.ts:
 * "No-ops … DO NOT arm the suppression window") — so it bounds nothing
 * on the error path, and the card-less `quota_wall_detected` trigger
 * re-signals every ~60s for the duration of a weekly wall. Without a
 * notice-level bound, a persistent broker outage during a wall would
 * stream ~60 failure notices/hour to every chat for days.
 *
 * Plain time cooldown, per gateway, in-memory. Deliberately NOT keyed
 * by reason: broker error strings vary per attempt (timeout ms values
 * etc.), so a new-reason bypass would re-open the spam hole. Worst
 * case is one notice per gateway per cooldown window.
 */
export const FALLBACK_FAILURE_NOTICE_COOLDOWN_MS = 30 * 60_000;

export interface FallbackFailureNoticeState {
  /** Unix ms of the last failure notice this gateway sent. 0 = never. */
  lastSentAtMs: number;
}

export function evaluateFallbackFailureNotice(
  prev: FallbackFailureNoticeState,
  now: number,
  cooldownMs: number = FALLBACK_FAILURE_NOTICE_COOLDOWN_MS,
): { send: boolean; next: FallbackFailureNoticeState } {
  if (now - prev.lastSentAtMs >= cooldownMs) {
    return { send: true, next: { lastSentAtMs: now } };
  }
  return { send: false, next: prev };
}

export type FleetFallbackOutcome =
  | {
      kind: 'switched';
      oldLabel: string;
      newLabel: string;
      announcement: string;
      /** Quota for the OLD account at the moment of failure — caller
       *  may persist this as the broker's `quota.json` so the next
       *  /auth render reflects the freshly-known exhaustion without
       *  another probe. Null when the live probe failed but the broker
       *  rolled anyway (it owns the authoritative exhaustion state). */
      oldQuota: QuotaUtilization | null;
      /** Quota for the new active account, useful for caller logging.
       *  Null when the rolled-to account had no successful probe. */
      newQuota: QuotaUtilization | null;
    }
  | {
      kind: 'all-blocked';
      oldLabel: string;
      announcement: string;
      oldQuota: QuotaUtilization | null;
    }
  | {
      kind: 'no-old-active';
      announcement: string;
    }
  | {
      kind: 'no-eligible-target';
      oldLabel: string;
      announcement: string;
      oldQuota: QuotaUtilization | null;
    };

export interface FleetFallbackDeps {
  /** Live broker state. Caller passes pre-fetched data so this module
   *  is testable without spinning up a UDS. */
  state: ListStateData;
  /** Parallel array of live quota probes, same order as `state.accounts`.
   *  Get via `client.probeQuota(state.accounts.map(a => a.label))`
   *  and map the response back to per-account results (#1336). */
  quotas: QuotaResult[];
  /** Non-admin failover invoker — the broker's `mark-exhausted` verb. Marks
   *  the triggering agent's (exhausted) account and rolls every agent on it to
   *  the next non-exhausted `fallback_order` account, returning that target as
   *  `rolledTo` (null when every fallback is also exhausted). This is what lets
   *  auto-fallback work from ANY agent — `set-active` (the admin verb the manual
   *  /auth button uses) is gated to admin agents, so a non-admin agent that
   *  429'd could never self-heal. mark-exhausted derives the account from the
   *  caller's own identity, so it needs no admin. */
  failover: () => Promise<{ rolledTo: string | null; rolled: string[] }>;
  /** Agent that triggered this fallback (for the announcement byline). */
  triggerAgent: string;
  /** Operator timezone for absolute reset times in the announcement. */
  tz?: string;
  now?: Date;
}

/**
 * Plan + execute the fleet-wide swap. Returns a structured outcome the
 * caller can both log and notify on.
 *
 * Idempotency: when the active account is already healthy (a stale
 * model-unavailable event arrives after the quota window already
 * rolled over, for example), we DO NOT swap. Returns
 * `'no-eligible-target'` so the caller silently no-ops the
 * announcement.
 */
export async function runFleetAutoFallback(
  deps: FleetFallbackDeps,
): Promise<FleetFallbackOutcome> {
  const now = deps.now ?? new Date();
  const tz = deps.tz ?? 'UTC';
  const snapshots = buildSnapshotsFromState(deps.state, deps.quotas);

  const oldSnap = snapshots.find((s) => s.isActive);
  if (!oldSnap) {
    return {
      kind: 'no-old-active',
      announcement: '<i>Auto-fallback skipped: no active account in broker state.</i>',
    };
  }

  // Idempotency guard: don't swap a healthy active account, even if
  // the trigger event said quota_exhausted. The event may be stale
  // (event posted, window rolled over, gateway picked it up late).
  // #2494 Bug A — classify against this run's `now` so the refill
  // normalization uses the same clock as the rest of the decision (a default
  // `new Date()` would diverge from `deps.now` and could mis-zero a window
  // whose reset is still future relative to the event's clock).
  const oldHealth = classifyHealth(oldSnap, now);
  if (oldHealth === 'healthy') {
    return {
      kind: 'no-eligible-target',
      oldLabel: oldSnap.label,
      oldQuota: oldSnap.quota,
      announcement:
        `<i>Auto-fallback skipped: ${oldSnap.label} probed healthy ` +
        `(${pctSummary(oldSnap.quota)}). Stale event?</i>`,
    };
  }

  // Execute the non-admin swap. The broker marks the triggering agent's
  // (exhausted) account and rolls the fleet to the next non-exhausted
  // fallback_order account, returning it as `rolledTo`. We trust the broker's
  // choice (same `nextHealthyAccount` selection /auth rotate uses) rather than
  // picking here, so the announcement matches what actually happened. Caller
  // catches and surfaces failures — we don't double-wrap.
  const { rolledTo } = await deps.failover();

  if (!rolledTo) {
    // All-blocked path: the broker found no non-exhausted fallback. The active
    // account IS now marked exhausted (good for consumers/telemetry), but there
    // was nowhere to roll. Notify with earliest-reset info.
    return {
      kind: 'all-blocked',
      oldLabel: oldSnap.label,
      oldQuota: oldSnap.quota,
      announcement: renderFallbackAnnouncement({
        oldLabel: oldSnap.label,
        oldQuota: oldSnap.quota,
        newLabel: null,
        newQuota: null,
        triggerAgent: deps.triggerAgent,
        tz,
        now,
      }),
    };
  }

  // Quota for the rolled-to account, looked up from the same probe snapshots
  // (the broker chose by fallback_order, which may differ from the
  // lowest-utilization heuristic — the announcement reflects the real target).
  const newQuota = snapshots.find((s) => s.label === rolledTo)?.quota ?? null;

  return {
    kind: 'switched',
    oldLabel: oldSnap.label,
    newLabel: rolledTo,
    oldQuota: oldSnap.quota,
    newQuota,
    announcement: renderFallbackAnnouncement({
      oldLabel: oldSnap.label,
      oldQuota: oldSnap.quota,
      newLabel: rolledTo,
      newQuota,
      triggerAgent: deps.triggerAgent,
      tz,
      now,
    }),
  };
}

// NOTE: target SELECTION now lives in the broker (`nextHealthyAccount`,
// fallback_order order — the same selection /auth rotate uses). This module
// no longer picks a target; it calls the non-admin `failover()` (mark-exhausted)
// and announces whatever the broker rolled to. A second, divergent selector
// here (the old lowest-utilization `pickFallbackTarget`) was removed so there's
// one authoritative chooser.

function pctSummary(q: QuotaUtilization | null): string {
  if (!q) return 'no probe';
  return `${Math.round(q.fiveHourUtilizationPct)}% / ${Math.round(q.sevenDayUtilizationPct)}%`;
}
