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
import { escapeMarkdown } from './card-format.js';
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
    `⚠️ **Auto-failover could not run** (trigger: **${escapeMarkdown(triggerAgent)}**)\n` +
    `${escapeMarkdown(reason)}\n\n` +
    `_Switch manually with \`/auth use <label>\`, or \`/auth\` for fleet status._`
  );
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

/**
 * Cooldown for the "All accounts blocked" card (Bug 2). The all-blocked outcome
 * is a NO-OP swap — `doFireFleetAutoFallback` returns false on it, so the
 * fleetFallbackGate's dedup window (which arms ONLY on a successful swap) never
 * arms. Meanwhile the card-less `quota_wall_detected` trigger re-signals every
 * ~60s for the whole duration of a weekly wall, so the identical all-blocked
 * card re-broadcasts every minute. This is the notice-level bound that the swap
 * dedup window can't provide for the no-op path — same shape and rationale as
 * the failure-notice cooldown above.
 *
 * Deliberately a plain per-gateway time cooldown (not keyed by trigger account /
 * earliest-recovery): the all-blocked condition is fleet-wide, so a single
 * window suppresses the repeat regardless of which agent's wall re-fired it.
 * A genuinely NEW state transition is NOT suppressed by this: a later SUCCESSFUL
 * swap arms the separate gate window and the next all-blocked (a real new
 * exhaustion) is bounded only by this window, not silenced.
 */
export const FALLBACK_ALL_BLOCKED_NOTICE_COOLDOWN_MS = 30 * 60_000;

export interface FallbackAllBlockedNoticeState {
  /** Unix ms of the last all-blocked card this gateway sent. 0 = never. */
  lastSentAtMs: number;
}

export function evaluateAllBlockedNotice(
  prev: FallbackAllBlockedNoticeState,
  now: number,
  cooldownMs: number = FALLBACK_ALL_BLOCKED_NOTICE_COOLDOWN_MS,
): { send: boolean; next: FallbackAllBlockedNoticeState } {
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
  failover: () => Promise<{
    rolledTo: string | null;
    rolled: string[];
    /** True when the triggering agent has a strict pin (`auth.strict`): its
     *  null `rolledTo` means it rides out the wall on its own account — NOT
     *  a fleet-wide all-blocked. Absent from pre-flag brokers → false. */
    callerPinnedStrict?: boolean;
  }>;
  /** Agent that triggered this fallback (for the announcement byline). */
  triggerAgent: string;
  /** Operator timezone for absolute reset times in the announcement. */
  tz?: string;
  now?: Date;
  /**
   * The reset time PARSED from the triggering error prose (429 throttle tier
   * enrichment) — threaded into the announcement as the recovery-line
   * fallback when the old account's live probe carried no reset.
   */
  parsedResetAt?: Date;
  /**
   * 429 throttle tier escalation: the trigger is a TERMINAL transient 429
   * whose parsed reset lies beyond the retry-in-place threshold. Its wording
   * explicitly NEGATES the usage-limit reading, so the old account's
   * UTILIZATION probe typically classifies healthy — the healthy-idempotency
   * guard would self-cancel the swap ("probed healthy / Stale event?"),
   * silently dropping the spec's ">threshold → mark + fail over" leg. When
   * set, the terminal parsed-reset signal is trusted over the utilization
   * probe: the guard is bypassed and the swap proceeds (the broker mark
   * honors the caller-passed `until` — the parsed reset). Staleness safety
   * holds upstream: the flag is only set for a terminal error line the
   * session-tail just read, never for replayed/late events.
   */
  rateLimitTrigger?: boolean;
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
      announcement: '_Auto-fallback skipped: no active account in broker state._',
    };
  }

  // Idempotency guard: don't swap a healthy active account, even if
  // the trigger event said quota_exhausted. The event may be stale
  // (event posted, window rolled over, gateway picked it up late).
  // #2494 Bug A — classify against this run's `now` so the refill
  // normalization uses the same clock as the rest of the decision (a default
  // `new Date()` would diverge from `deps.now` and could mis-zero a window
  // whose reset is still future relative to the event's clock).
  // 429 throttle tier: a rate-limit trigger's wording NEGATES the usage-limit
  // reading, so healthy utilization is the EXPECTED state, not evidence of a
  // stale event — the guard must not self-cancel that swap (see
  // FleetFallbackDeps.rateLimitTrigger).
  const oldHealth = classifyHealth(oldSnap, now);
  if (oldHealth === 'healthy' && !deps.rateLimitTrigger) {
    return {
      kind: 'no-eligible-target',
      oldLabel: oldSnap.label,
      oldQuota: oldSnap.quota,
      announcement:
        `_Auto-fallback skipped: ${oldSnap.label} probed healthy ` +
        `(${pctSummary(oldSnap.quota)}). Stale event?_`,
    };
  }

  // Execute the non-admin swap. The broker marks the triggering agent's
  // (exhausted) account and rolls the fleet to the next non-exhausted
  // fallback_order account, returning it as `rolledTo`. We trust the broker's
  // choice (same `nextHealthyAccount` selection /auth rotate uses) rather than
  // picking here, so the announcement matches what actually happened. Caller
  // catches and surfaces failures — we don't double-wrap.
  const { rolledTo, callerPinnedStrict } = await deps.failover();

  if (!rolledTo && callerPinnedStrict) {
    // Strict pin: the broker marked the account but deliberately did not roll
    // the caller (agents.<name>.auth.strict). Rendering the all-blocked card
    // here would tell the operator the whole fleet is exhausted while the
    // snapshots in that very card show healthy accounts.
    return {
      kind: 'no-eligible-target',
      oldLabel: oldSnap.label,
      oldQuota: oldSnap.quota,
      announcement:
        `_**${escapeMarkdown(deps.triggerAgent)}** is strictly pinned to ` +
        `${escapeMarkdown(oldSnap.label)} (\`auth.strict\`) — riding out the wall ` +
        `on its own account. The rest of the fleet is unaffected._`,
    };
  }

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
        // Bug 3 — thread the full per-account fleet snapshot so the all-blocked
        // card enumerates EVERY account (5h%/7d% + recovery ETA), letting the
        // user verify the fleet is truly exhausted, not just the trigger account.
        fleetSnapshots: snapshots,
        parsedResetAt: deps.parsedResetAt ?? null,
        cause: deps.rateLimitTrigger ? 'rate-limit' : undefined,
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
      parsedResetAt: deps.parsedResetAt ?? null,
      cause: deps.rateLimitTrigger ? 'rate-limit' : undefined,
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
