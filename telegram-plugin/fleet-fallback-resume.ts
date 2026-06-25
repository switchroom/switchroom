/**
 * Resume-the-turn-after-swap gate (THE load-bearing half of the
 * auth-failover-stall fix).
 *
 * Background — the stall this kills:
 *   When a Claude account hits a rate limit MID-TURN (HTTP 429, including a
 *   *session* cap like "You've hit your session limit · resets 5pm"), the
 *   failover machinery correctly detects it (session-tail → model-unavailable
 *   → gateway.fireFleetAutoFallback → doFireFleetAutoFallback) and swaps the
 *   fleet to a spare account. But the swap only takes effect on the NEXT
 *   claude invocation — the turn that died on the 429 is never resumed. The
 *   agent goes silent until the user manually sends a fresh message
 *   ("Resume"). Symptom: a mid-conversation stall that needs a manual re-poke.
 *
 * The fix: after a SUCCESSFUL swap (outcome.kind === 'switched'), the gateway
 * re-runs the dead turn on the freshly-active account.
 *
 * Mechanism choice — restart, NOT redeliver:
 *   The inbound that died on the 429 was already DELIVERED (the turn started,
 *   then the model rejected it). It is therefore NOT sitting in the
 *   pending-inbound buffer (`redeliverBufferedInbound` only drains inbounds
 *   that never reached a live bridge). The canonical way to re-run an
 *   already-delivered, interrupted turn is `triggerSelfRestart`: on the next
 *   boot the gateway's boot-resume path re-injects the LATEST interrupted turn
 *   from the turn registry — exactly the turn the 429 killed — and the fresh
 *   claude process picks up the swapped-to account. `redeliverBufferedInbound`
 *   would have nothing to redeliver here, so it is the wrong seam.
 *
 * This module owns ONLY the decision + the guards, kept pure so it is testable
 * without restarting a process (the gateway module-state pattern mirrors
 * `fleet-fallback-gate.ts`). The gateway wires the actual `triggerSelfRestart`
 * call to `decide()` returning `'resume'`.
 *
 * Guards (all REQUIRED by the fix spec):
 *   1. all-blocked / no-swap no-op — `decide()` is only ever consulted by the
 *      caller on `outcome.kind === 'switched'`; on any other outcome the caller
 *      does not call us, preserving the existing all-blocked cooldown path.
 *   2. Single-flight — once a resume is armed, a second swap (a 429 storm, a
 *      repeated quota event) within the same window does NOT re-arm. Only ONE
 *      restart fires per swap. Without this a swap-storm could loop-restart the
 *      agent.
 *   3. Staleness failsafe — an ancient interrupted turn is NOT resurrected. If
 *      the failed turn started longer ago than `maxAgeMs` (default 3h, matching
 *      the boot-resume RESUME_MAX_AGE_MS failsafe), `decide()` returns
 *      `'skip-stale'` so a day-old buffered turn isn't replayed unprompted.
 *      `null` failedTurnStartedAtMs (no turn timestamp known) is treated as
 *      "resume" — the boot-resume path applies its own 3h guard as a second
 *      line of defence.
 */

export interface FleetFallbackResumeOptions {
  /** Max age of the failed turn before a resume is suppressed as stale.
   *  Default 3h — mirrors the gateway boot-resume RESUME_MAX_AGE_MS. */
  maxAgeMs?: number;
  /** Time source (overridable in tests). */
  nowFn?: () => number;
  /** Cooldown after an armed resume during which a second swap will NOT
   *  re-arm. Defends against a 429 storm loop-restarting the agent. Default
   *  60s — comfortably longer than a restart + boot takes, so the in-flight
   *  restart settles before another resume can arm. */
  singleFlightMs?: number;
}

export type ResumeDecision =
  /** Fire the resume (restart so the boot path replays the dead turn). */
  | 'resume'
  /** Suppressed: a resume is already in flight (single-flight guard). */
  | 'skip-inflight'
  /** Suppressed: the failed turn is older than maxAgeMs (staleness guard). */
  | 'skip-stale';

export interface FleetFallbackResumeGate {
  /**
   * Decide whether to resume the dead turn after a successful swap. Call ONLY
   * when the swap outcome was `'switched'`. Records the arm time on a 'resume'
   * verdict so a follow-on swap within `singleFlightMs` is suppressed.
   *
   * @param failedTurnStartedAtMs epoch-ms the failed turn began, or null when
   *        unknown (then the staleness guard is deferred to the boot path).
   */
  decide(failedTurnStartedAtMs: number | null): ResumeDecision;
  /** Test seam — reset to fresh state. Production code should not call this. */
  reset(): void;
  /** Test/debug — current internal state. */
  inspect(): { lastResumedAtMs: number };
}

export const DEFAULT_RESUME_MAX_AGE_MS = 10_800_000; // 3h
export const DEFAULT_RESUME_SINGLE_FLIGHT_MS = 60_000; // 60s

export function createFleetFallbackResumeGate(
  opts: FleetFallbackResumeOptions = {},
): FleetFallbackResumeGate {
  const nowFn = opts.nowFn ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RESUME_MAX_AGE_MS;
  const singleFlightMs = opts.singleFlightMs ?? DEFAULT_RESUME_SINGLE_FLIGHT_MS;
  // -Infinity = never resumed. A concrete value arms the single-flight window.
  let lastResumedAtMs = Number.NEGATIVE_INFINITY;

  function decide(failedTurnStartedAtMs: number | null): ResumeDecision {
    const now = nowFn();
    // Guard 2 — single-flight. A second swap within the window does not
    // re-arm; the in-flight restart owns the resume.
    if (now - lastResumedAtMs < singleFlightMs) return 'skip-inflight';
    // Guard 3 — staleness. A known-old failed turn is not resurrected. An
    // unknown (null) timestamp defers to the boot-resume 3h failsafe.
    if (failedTurnStartedAtMs != null && now - failedTurnStartedAtMs > maxAgeMs) {
      return 'skip-stale';
    }
    lastResumedAtMs = now;
    return 'resume';
  }

  return {
    decide,
    reset() {
      lastResumedAtMs = Number.NEGATIVE_INFINITY;
    },
    inspect() {
      return { lastResumedAtMs };
    },
  };
}
