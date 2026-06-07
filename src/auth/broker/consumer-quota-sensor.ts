/**
 * Consumer-account quota sensor (pure decision layer).
 *
 * The broker fails an account over only when something marks it exhausted
 * (`this.quota[account]`, set by the `mark-exhausted` verb). AGENTS raise that
 * signal when their gateway sees a 429. A CONSUMER pinned to a dedicated
 * account that no agent shares (e.g. hindsight on its own account, kept out of
 * `fallback_order` for quota isolation) has NO ONE to raise it — so its
 * serving-failover (consumerAccountWithFailover, #2194) never triggers and the
 * consumer sits dead on an exhausted account (the 2026-06-06 hindsight outage).
 *
 * The fix is a broker-side probe of consumer-pinned accounts that marks
 * exhaustion itself. This module is the PURE decision: given a quota probe,
 * is the account walled, and until when. The loop + I/O live in server.ts.
 */

import type { QuotaResult } from "../quota.js";

/**
 * Utilization at/above this on the binding window counts as a hard wall.
 * Matches `classifyHealth`'s 'blocked' threshold in auth-snapshot-format.ts so
 * the sensor and the /auth health view agree on what "exhausted" means.
 */
export const EXHAUSTION_PCT = 99.5;

/**
 * Default cadence for the consumer-account probe. A consumer account that no
 * agent shares is probed by the broker itself; 10 min catches exhaustion
 * within a window at ~6 tiny (haiku) probes/hr per consumer account —
 * negligible quota. Override with SWITCHROOM_CONSUMER_QUOTA_PROBE_MS; disable
 * with SWITCHROOM_DISABLE_CONSUMER_QUOTA_PROBE=1 (or interval 0).
 */
export const DEFAULT_CONSUMER_PROBE_INTERVAL_MS = 10 * 60 * 1000;

export interface ExhaustionDecision {
  exhausted: boolean;
  /**
   * Epoch ms when the maxed window resets, so the caller can set
   * `exhausted_until` to the real reset and let it expire (race-free, no
   * explicit clear). Null when the probe carried no reset — caller falls back
   * to a default window.
   */
  until: number | null;
}

/**
 * Decide whether a quota probe indicates the account is exhausted (a hard
 * wall), and when it resets. PURE — no I/O.
 *
 * A FAILED probe is NOT exhaustion. A transient network/probe error must never
 * fail a consumer over — that was the `all-blocked`-from-stale-probe lesson.
 * Only a successful probe showing the binding window at/above the wall counts.
 */
export function quotaIndicatesExhaustion(result: QuotaResult): ExhaustionDecision {
  if (!result.ok) return { exhausted: false, until: null };
  const d = result.data;
  const fiveBlocked = d.fiveHourUtilizationPct >= EXHAUSTION_PCT;
  const sevenBlocked = d.sevenDayUtilizationPct >= EXHAUSTION_PCT;
  if (!fiveBlocked && !sevenBlocked) return { exhausted: false, until: null };
  // Use the reset of the maxed window; if both are walled, the later one
  // (the account stays exhausted until the longer window clears).
  const fiveReset = fiveBlocked ? (d.fiveHourResetAt?.getTime() ?? null) : null;
  const sevenReset = sevenBlocked ? (d.sevenDayResetAt?.getTime() ?? null) : null;
  const candidates = [fiveReset, sevenReset].filter((x): x is number => x != null);
  const until = candidates.length > 0 ? Math.max(...candidates) : null;
  return { exhausted: true, until };
}

/**
 * Resolve the probe interval from env, or the default. Returns 0 when the
 * sensor is disabled (kill-switch or explicit 0), which the caller treats as
 * "don't arm the timer".
 */
export function resolveConsumerProbeIntervalMs(env: NodeJS.ProcessEnv): number {
  if (env.SWITCHROOM_DISABLE_CONSUMER_QUOTA_PROBE === "1") return 0;
  const raw = env.SWITCHROOM_CONSUMER_QUOTA_PROBE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_CONSUMER_PROBE_INTERVAL_MS;
}
