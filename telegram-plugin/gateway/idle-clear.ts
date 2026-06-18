/**
 * Idle auto-clear: wipe a session's working context after a wall-clock idle
 * period (default 3h), so a long-untouched agent starts fresh next message
 * instead of resuming a stale, context-heavy thread. Long-term memory lives in
 * Hindsight, so a clear loses only the in-session scratch.
 *
 * Sibling of proactive-compact.ts (occupancy-driven /compact at the turn-end
 * idle gate). This one is wall-clock-driven: it fires `/clear` from a periodic
 * interval because a fully-idle agent never ends a turn, so the turn-end gate
 * alone would never see it. Both inject via the same primitive and both refuse
 * to fire mid-turn (turnInFlight guard).
 *
 * The decider is pure so the fire-once / re-arm / not-mid-turn / disabled logic
 * is unit-tested without the gateway.
 */

/** Default idle window when `session.idle_clear_after` is unset (3h). ON by default. */
export const DEFAULT_IDLE_CLEAR_MS = 3 * 60 * 60 * 1000;

export interface IdleClearState {
  /** Epoch ms of the last activity (inbound, turn start, cron fire). */
  lastActivityAt: number;
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

/**
 * Decide whether to auto-clear this evaluation. Fires exactly once per idle
 * period: only when enabled, not mid-turn, not already cleared, and the idle
 * window has elapsed. The caller sets `alreadyCleared` on fire and resets it
 * (with `lastActivityAt`) on the next activity to re-arm.
 */
export function decideIdleClear(
  state: IdleClearState,
  now: number,
): IdleClearDecision {
  if (state.idleClearMs <= 0) return { clear: false }; // disabled
  if (state.turnInFlight) return { clear: false }; // never mid-turn
  if (state.alreadyCleared) return { clear: false }; // once per idle period
  if (now - state.lastActivityAt < state.idleClearMs) return { clear: false };
  return { clear: true };
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
