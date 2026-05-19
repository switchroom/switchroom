/**
 * Pure decision core for proactive context compaction
 * (`session.max_context_tokens`). Kept side-effect-free so the
 * anti-spam state machine — the part most prone to livelock /
 * double-fire — is unit-testable in isolation. The impure shell
 * (config load, session-file read, tmux `/compact` inject) lives in
 * gateway.ts and calls `decideProactiveCompact` at the model-idle gate.
 *
 * Occupancy fed in by the caller = the latest usage-bearing assistant
 * turn's `input + cache_read + cache_creation` tokens (the prefix the
 * model re-read this turn ≈ live context-window fill). Not cumulative.
 */

/** Hysteresis lower band: re-arm only once occupancy < fraction × cap. */
export const COMPACT_REARM_FRACTION = 0.6;

/**
 * Turn-count re-fire floor: after a fire, skip this many idle
 * evaluations regardless of occupancy. Guards against a slow
 * post-`/compact` JSONL rotation still reading the pre-compact turn and
 * triggering an immediate second compaction.
 */
export const COMPACT_COOLDOWN_TURNS = 3;

export interface CompactState {
  /** False after a fire; re-armed only below the hysteresis band. */
  armed: boolean;
  /** Idle evaluations remaining before re-fire is even considered. */
  cooldownTurns: number;
}

export interface CompactDecision {
  fire: boolean;
  /** Next state — caller must persist this verbatim. */
  state: CompactState;
}

export function initialCompactState(): CompactState {
  return { armed: true, cooldownTurns: 0 };
}

/**
 * Decide whether to fire `/compact` this idle evaluation, given the
 * current state, the measured occupancy, and the configured cap.
 *
 * Precedence (each returns early):
 *  1. Cooldown floor — burn one turn, never fire.
 *  2. Disarmed — re-arm iff occupancy < REARM_FRACTION × cap; never
 *     fire on the arming pass (so we can't arm and fire together).
 *  3. Below cap — hold.
 *  4. Armed and at/above cap — fire, disarm, start the cooldown.
 *
 * Livelock safety: once disarmed, step 2 is the ONLY path back to
 * armed, and it requires occupancy to actually drop below the lower
 * band. If a compaction fails to shrink context, the cap stays
 * exceeded, occupancy never drops below 0.6×cap, and we stay disarmed
 * — i.e. we degrade to "don't fire" rather than firing every turn.
 */
export function decideProactiveCompact(
  state: CompactState,
  occupancy: number,
  cap: number,
): CompactDecision {
  if (state.cooldownTurns > 0) {
    return {
      fire: false,
      state: { armed: state.armed, cooldownTurns: state.cooldownTurns - 1 },
    };
  }

  if (!state.armed) {
    const armed = occupancy < cap * COMPACT_REARM_FRACTION;
    return { fire: false, state: { armed, cooldownTurns: 0 } };
  }

  if (occupancy < cap) {
    return { fire: false, state };
  }

  return {
    fire: true,
    state: { armed: false, cooldownTurns: COMPACT_COOLDOWN_TURNS },
  };
}
