/**
 * Pure transition selector for the proactive-compaction user
 * notification (a single Telegram card edited START → FINISH). Kept
 * side-effect-free so the lifecycle — the part prone to double-post /
 * stale-edit / spurious-finish — is unit-testable in isolation. The
 * impure shell (send/editMessageText, the wall-clock timeout) lives in
 * gateway.ts.
 *
 * The "finished" signal is the proactive-compaction state machine's
 * re-arm edge (`armed: false → true`, which the decider only produces
 * when post-`/compact` occupancy drops below 0.6×cap — i.e. context
 * verifiably shrank). This module does NOT own the wall-clock timeout
 * (an idle agent produces no evaluations, so a dangling card must be
 * resolved by a real timer in the shell, independent of this loop).
 *
 * Session reset/rotation (`session.max_idle` / `max_turns`) is
 * deliberately silent and is not represented here.
 */

export interface CompactNotifyState {
  phase: "idle" | "awaiting";
  /**
   * The active session file when START was posted. FINISH is only
   * accepted if the re-arm edge is observed against this SAME file —
   * a sub-agent transcript briefly leading session-tail's currentFile
   * can read a small occupancy and spuriously satisfy the re-arm
   * condition; gating on the start-file rejects that false positive.
   */
  fileAtStart: string | null;
}

/**
 * - `none`              — no card action this evaluation.
 * - `start`             — post a fresh START card.
 * - `start-superseding` — a prior card is still outstanding; mark it
 *                         superseded, then post a fresh START card.
 * - `finish`            — edit the outstanding card to FINISHED.
 */
export type CompactNotifyAction =
  | "none"
  | "start"
  | "start-superseding"
  | "finish";

export interface CompactNotifyEvent {
  /** The proactive-compaction decider fired `/compact` this eval. */
  fired: boolean;
  /** Decider re-arm edge this eval (wasArmed=false → state.armed=true). */
  rearmed: boolean;
  /** session-tail's active file used for the occupancy read this eval. */
  activeFile: string | null;
}

export function idleCompactNotifyState(): CompactNotifyState {
  return { phase: "idle", fileAtStart: null };
}

/**
 * Select the card action for this idle evaluation and the next state.
 * Pure: same inputs → same outputs, no I/O.
 *
 * Precedence:
 *  1. A fire always (re)starts a card. If one was still outstanding,
 *     supersede it first (single-outstanding-card invariant).
 *  2. While awaiting, a re-arm edge ON THE SAME start-file → FINISH.
 *  3. Otherwise hold (the shell's wall-clock timeout resolves a card
 *     that never gets a re-arm — e.g. a compaction that didn't shrink
 *     context, or an agent that went idle right after START).
 */
export function nextCompactNotify(
  state: CompactNotifyState,
  ev: CompactNotifyEvent,
): { state: CompactNotifyState; action: CompactNotifyAction } {
  if (ev.fired) {
    const superseding = state.phase === "awaiting";
    return {
      state: { phase: "awaiting", fileAtStart: ev.activeFile },
      action: superseding ? "start-superseding" : "start",
    };
  }

  if (state.phase === "awaiting") {
    if (
      ev.rearmed &&
      ev.activeFile != null &&
      ev.activeFile === state.fileAtStart
    ) {
      return { state: idleCompactNotifyState(), action: "finish" };
    }
    return { state, action: "none" };
  }

  return { state, action: "none" };
}
