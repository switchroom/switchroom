/**
 * Idle auto-clear: wipe a session's working context after a wall-clock idle
 * period (default 3h), so a long-untouched agent starts fresh next message
 * instead of resuming a stale, context-heavy thread. Long-term memory lives in
 * Hindsight, so a clear loses only the in-session scratch.
 *
 * WHAT "IDLE" MEANS HERE (the #3084/#3107 semantics, fixed 2026-07-11):
 *
 *   Idle = nothing has happened since the last thing happened.
 *
 * "Something happened" is ANY observable event on this agent:
 *   - an inbound Telegram message,
 *   - a cron / inject_inbound fire,
 *   - ANY event off the claude session stream — turn start, thinking, a tool
 *     call, a tool result, streamed text, a sub-agent event, turn end.
 *
 * It emphatically does NOT mean "no turn has *started* recently". That was the
 * original reading and it inverted the invariant: the idle window was measured
 * from a turn's START, so the longer and harder an agent worked, the more
 * certain the wipe. On 2026-07-11 `overlord` worked for three hours straight
 * (subagents, ~25 PRs) after its last recorded turn boundary and was `/clear`ed
 * the moment the window elapsed — its whole working context destroyed for being
 * productive. See `reference/jobs/always-available.md`.
 *
 * Two independent clocks feed the decision, and the window is measured from
 * whichever is later:
 *   - `lastActivityAt`  — stamped on every event above (the load-bearing fix:
 *     an agent that is DOING something is not idle, turn boundaries or not).
 *   - `lastTurnEndedAt` — stamped when a turn ends (defence in depth: the
 *     instant a turn ends, `turnInFlight` stops suppressing the clear, so a
 *     turn that ran longer than the window would otherwise be wiped on the very
 *     next tick — the timer must never be "already expired" at turn end).
 *
 * A genuinely idle session — no inbound, no cron, no model activity for the
 * whole window — is still cleared. That is the feature and it stays.
 *
 * Sibling of proactive-compact.ts (occupancy-driven /compact at the turn-end
 * idle gate). This one is wall-clock-driven: it fires `/clear` from a periodic
 * interval because a fully-idle agent never ends a turn, so the turn-end gate
 * alone would never see it. Both inject via the same primitive and both refuse
 * to fire mid-turn (turnInFlight guard).
 *
 * The decider and the event classifier are pure so the whole
 * fire-once / re-arm / not-mid-turn / not-just-worked / disabled logic is
 * unit-tested without the gateway.
 */

/** Default idle window when `session.idle_clear_after` is unset (3h). ON by default. */
export const DEFAULT_IDLE_CLEAR_MS = 3 * 60 * 60 * 1000;

export interface IdleClearState {
  /**
   * Epoch ms of the last activity: inbound, cron fire, or ANY claude session
   * stream event (turn start, tool call, tool result, text, sub-agent event,
   * turn end). Not just turn starts — see the header.
   */
  lastActivityAt: number;
  /**
   * Epoch ms when a turn last ended (null = no turn has ended this process).
   * The window is measured from `max(lastActivityAt, lastTurnEndedAt)` so a turn
   * that outran the idle window is not cleared the instant it finishes.
   */
  lastTurnEndedAt: number | null;
  /** Idle window in ms. <= 0 disables auto-clear. */
  idleClearMs: number;
  /** Already auto-cleared since the last activity? Prevents re-clearing every tick. */
  alreadyCleared: boolean;
  /** A turn is in flight — never clear mid-turn. */
  turnInFlight: boolean;
}

export interface IdleClearDecision {
  clear: boolean;
}

/** Epoch ms of the last thing that happened — activity or a turn ending. */
export function lastEventAt(state: IdleClearState): number {
  return Math.max(state.lastActivityAt, state.lastTurnEndedAt ?? 0);
}

/**
 * Decide whether to auto-clear this evaluation. Fires exactly once per idle
 * period: only when enabled, not mid-turn, not already cleared, and the idle
 * window has elapsed since the last thing that happened. The caller sets
 * `alreadyCleared` on fire and resets it (with `lastActivityAt`) on the next
 * activity to re-arm.
 */
export function decideIdleClear(
  state: IdleClearState,
  now: number,
): IdleClearDecision {
  if (state.idleClearMs <= 0) return { clear: false }; // disabled
  if (state.turnInFlight) return { clear: false }; // never mid-turn
  if (state.alreadyCleared) return { clear: false }; // once per idle period
  // Measured from the LAST thing that happened — activity or a turn ending —
  // never from a turn's start. A turn that ran longer than the window ends with
  // a fresh turn-end stamp, so it is not idle the moment it finishes.
  if (now - lastEventAt(state) < state.idleClearMs) return { clear: false };
  return { clear: true };
}

/** What a claude session-stream event means for the idle clocks. */
export interface IdleEventSignal {
  /** Genuine agent activity → stamp `lastActivityAt` (and re-arm). */
  activity: boolean;
  /** A turn ended → stamp `lastTurnEndedAt`. */
  turnEnded: boolean;
}

/**
 * Classify a session-stream event for the idle clocks. Pure, so the gateway's
 * dispatcher stays a one-liner and the semantics are testable.
 *
 * EVERY genuine stream event is activity — thinking, tool_use, tool_result,
 * text, model, enqueue (turn start), turn_end, and all `sub_agent_*` kinds.
 * The claude session emits nothing at all while the agent is truly idle, so
 * "any event = activity" is exactly the intended reading and cannot keep a
 * dormant session alive forever.
 *
 * The one exception is the gateway's OWN synthetic `turn_end` (durationMs ===
 * -1), re-dispatched by the orphaned-reply backstop: it is the gateway talking
 * to itself, not the model doing something, so it does not stamp activity — but
 * it DOES end the turn (the in-flight gate opens), so it stamps the turn-end
 * clock. Same `!(turn_end && durationMs === -1)` predicate the per-turn liveness
 * stamp already uses for "genuine stream event".
 */
export function classifyIdleEvent(
  kind: string,
  durationMs?: number,
): IdleEventSignal {
  const turnEnded = kind === "turn_end";
  const synthetic = turnEnded && durationMs === -1;
  return { activity: !synthetic, turnEnded };
}

/**
 * Parse a `^\d+[smh]$` duration (the SessionSchema format, e.g. "3h", "30m",
 * "7200s") to ms. Returns null on a malformed string so the caller can fall
 * back to the default. Kept local (vs importing the web module's parser) to
 * avoid cross-package coupling.
 */
export function idleDurationToMs(raw: string): number | null {
  const m = /^(\d+)([smh])$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return null;
  }
}
