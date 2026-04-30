/**
 * Auto-fallback on quota exhaustion — pure decision logic + side-effect
 * plan builder, separate from gateway.ts so it can be unit-tested without
 * spinning up the bot or the filesystem.
 *
 * Runtime flow (assembled by the caller):
 *   1. Poll quota via `fetchQuota` from quota-check.ts
 *   2. Pass the result into `evaluateFallbackTrigger` to decide if we
 *      should act, together with an in-memory lockout record that
 *      prevents rapid re-fire.
 *   3. If the trigger says "fallback", call `performAutoFallback`
 *      which returns a plan + side-effect descriptor the caller
 *      executes (mark exhausted, swap slot, restart agent, notify).
 */

import type { QuotaResult, QuotaUtilization } from './quota-check.js';
import { renderOperatorEvent } from './operator-events.js';

/** Threshold over which we treat the active slot as functionally out
 *  of quota. 99.5% leaves a tiny head-room for clock skew between the
 *  Anthropic rate-limit window and wall clock, matching the dashboard's
 *  own rounding behaviour. Tune with care. */
export const DEFAULT_TRIGGER_UTILIZATION_PCT = 99.5;

/** Minimum time between two consecutive fallback attempts for the same
 *  slot name, in milliseconds. Guards against a poll-storm firing the
 *  restart-notify pipeline repeatedly before the quota meta file has
 *  a chance to flush to disk. */
export const DEFAULT_FALLBACK_COOLDOWN_MS = 2 * 60_000;

export type LockoutRecord = {
  /** Slot name most recently marked exhausted by this process. */
  lastTransitionedFrom: string | null;
  /** Wall-clock ms timestamp of the last transition. */
  lastTransitionAt: number;
};

export type FallbackDecision =
  | { action: 'noop'; reason: string }
  | {
      action: 'fallback';
      triggerReason: 'utilization-over-threshold' | '429-response' | 'explicit';
      resetAtMs: number | null;
      utilizationPct: number | null;
    };

export type EvaluateArgs = {
  quota: QuotaResult;
  activeSlot: string | null;
  now: number;
  lockout: LockoutRecord;
  thresholdPct?: number;
  cooldownMs?: number;
  /** Set to true when the caller already saw a 429 response body;
   *  this short-circuits past utilization-based decisions. */
  saw429?: boolean;
};

/** Pure decision function — takes a quota result + lockout state and
 *  returns whether the caller should trigger auto-fallback.
 *  No side effects. Throws only on programmer error. */
export function evaluateFallbackTrigger(args: EvaluateArgs): FallbackDecision {
  const threshold = args.thresholdPct ?? DEFAULT_TRIGGER_UTILIZATION_PCT;
  const cooldown = args.cooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS;

  if (!args.activeSlot) {
    return { action: 'noop', reason: 'no active slot (nothing to fall back from)' };
  }

  // Cooldown guard: if we already transitioned out of this slot
  // recently, don't flap. The caller can safely re-poll without
  // creating noise.
  if (
    args.lockout.lastTransitionedFrom === args.activeSlot &&
    args.now - args.lockout.lastTransitionAt < cooldown
  ) {
    return { action: 'noop', reason: 'recent transition, within cooldown' };
  }

  if (args.saw429) {
    return {
      action: 'fallback',
      triggerReason: '429-response',
      resetAtMs: extractNearestResetMs(args.quota),
      utilizationPct: extractHighestUtilization(args.quota),
    };
  }

  if (!args.quota.ok) {
    return { action: 'noop', reason: `quota check failed: ${args.quota.reason}` };
  }

  const highest = extractHighestUtilization(args.quota);
  if (highest == null) {
    return { action: 'noop', reason: 'no utilization headers' };
  }

  if (highest >= threshold) {
    return {
      action: 'fallback',
      triggerReason: 'utilization-over-threshold',
      resetAtMs: extractNearestResetMs(args.quota),
      utilizationPct: highest,
    };
  }

  return { action: 'noop', reason: `utilization ${highest.toFixed(1)}% below ${threshold}%` };
}

function extractHighestUtilization(q: QuotaResult): number | null {
  if (!q.ok) return null;
  const u: QuotaUtilization = q.data;
  const five = u.fiveHourUtilizationPct ?? null;
  const seven = u.sevenDayUtilizationPct ?? null;
  if (five == null && seven == null) return null;
  if (five == null) return seven;
  if (seven == null) return five;
  return Math.max(five, seven);
}

function extractNearestResetMs(q: QuotaResult): number | null {
  if (!q.ok) return null;
  const candidates: number[] = [];
  if (q.data.fiveHourResetAt) candidates.push(q.data.fiveHourResetAt.getTime());
  if (q.data.sevenDayResetAt) candidates.push(q.data.sevenDayResetAt.getTime());
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/** The full plan built by the orchestrator — mirrored by the
 *  executor in gateway.ts. Pure data so tests can assert on it. */
export type FallbackPlan =
  | {
      kind: 'executed';
      previousSlot: string;
      newSlot: string;
      resetAtMs: number | null;
      notificationHtml: string;
      agentName: string;
      /** Carried through from the FallbackDecision so the executor can
       *  decide whether to do a hard or graceful restart. Reactive
       *  (`429-response`) failover wants a hard restart — the request
       *  the user just made already failed, so there's no in-flight
       *  turn worth preserving. Preemptive (`utilization-over-threshold`
       *  / `explicit`) failover wants a graceful one. See #420. */
      triggerReason: 'utilization-over-threshold' | '429-response' | 'explicit';
    }
  | {
      kind: 'exhausted-all';
      activeSlot: string;
      resetAtMs: number | null;
      notificationHtml: string;
      agentName: string;
    };

export type PerformArgs = {
  agentDir: string;
  agentName: string;
  decision: Extract<FallbackDecision, { action: 'fallback' }>;
  deps: {
    /** Current active slot; null means caller has already detached. */
    currentActiveSlot: (agentDir: string) => string | null;
    markSlotQuotaExhausted: (agentDir: string, slot: string, resetAtMs?: number, reason?: string) => void;
    fallbackToNextSlot: (name: string, agentDir: string) => { newActive: string | null; previous: string | null };
  };
};

/** Run the side-effects for a fallback decision and return a plan
 *  describing what happened. Caller is responsible for:
 *   - Executing the agent restart CLI (via runSwitchroomCommand)
 *   - Sending the notification via Telegram
 *   - Updating the in-memory lockout record (see `nextLockout`)
 */
export function performAutoFallback(args: PerformArgs): FallbackPlan {
  const active = args.deps.currentActiveSlot(args.agentDir);
  if (!active) {
    return {
      kind: 'exhausted-all',
      activeSlot: 'unknown',
      resetAtMs: args.decision.resetAtMs,
      notificationHtml: buildAllExhaustedMessage('unknown', args.agentName, args.decision.resetAtMs),
      agentName: args.agentName,
    };
  }

  args.deps.markSlotQuotaExhausted(
    args.agentDir,
    active,
    args.decision.resetAtMs ?? undefined,
    args.decision.triggerReason,
  );

  const { newActive, previous } = args.deps.fallbackToNextSlot(args.agentName, args.agentDir);
  const prev = previous ?? active;

  if (!newActive || newActive === prev) {
    return {
      kind: 'exhausted-all',
      activeSlot: prev,
      resetAtMs: args.decision.resetAtMs,
      notificationHtml: buildAllExhaustedMessage(prev, args.agentName, args.decision.resetAtMs),
      agentName: args.agentName,
    };
  }

  return {
    kind: 'executed',
    previousSlot: prev,
    newSlot: newActive,
    resetAtMs: args.decision.resetAtMs,
    notificationHtml: buildSwitchedMessage(prev, newActive, args.agentName, args.decision.resetAtMs),
    agentName: args.agentName,
    triggerReason: args.decision.triggerReason,
  };
}

/** Compute the next lockout record after a successful fallback. */
export function nextLockout(previousSlot: string, now: number): LockoutRecord {
  return { lastTransitionedFrom: previousSlot, lastTransitionAt: now };
}

export function emptyLockout(): LockoutRecord {
  return { lastTransitionedFrom: null, lastTransitionAt: 0 };
}

/**
 * Build the notification HTML for a successful slot switch.
 * Delegates to renderOperatorEvent for quota-exhausted; appends
 * slot-transition detail as structured context.
 */
function buildSwitchedMessage(
  prev: string,
  next: string,
  agent: string,
  resetAtMs: number | null,
): string {
  const reset = resetAtMs ? formatResetAt(resetAtMs) : 'unknown';
  const detail = [
    `Switched from slot ${prev} to ${next}. Restarting agent.`,
    `Reset at: ${reset}.`,
  ].join(' ');
  return renderOperatorEvent({
    kind: 'quota-exhausted',
    agent,
    detail,
    suggestedActions: [],
    firstSeenAt: new Date(),
  }).text;
}

/**
 * Build the notification HTML when all slots are exhausted.
 * Delegates to renderOperatorEvent for quota-exhausted; appends
 * all-exhausted detail.
 */
function buildAllExhaustedMessage(
  active: string,
  agent: string,
  resetAtMs: number | null,
): string {
  const reset = resetAtMs ? formatResetAt(resetAtMs) : 'unknown';
  const detail = [
    `All account slots exhausted. Active slot: ${active}.`,
    `Earliest reset at: ${reset}.`,
    `Run /auth add ${agent} to attach another subscription.`,
  ].join(' ');
  return renderOperatorEvent({
    kind: 'quota-exhausted',
    agent,
    detail,
    suggestedActions: [],
    firstSeenAt: new Date(),
  }).text;
}

function formatResetAt(ms: number): string {
  // ISO with seconds trimmed — Telegram doesn't need millisecond precision.
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
