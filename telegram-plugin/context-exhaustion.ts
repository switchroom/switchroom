/**
 * Helpers for detecting and handling context-window exhaustion.
 *
 * When Claude Code's context fills up, the assistant emits a text block
 * whose content begins with "Prompt is too long" and the turn ends
 * WITHOUT a `turn_duration` system event. The orphaned-reply backstop
 * then waits for `turn_end` forever, so every subsequent user message
 * hits the same wall — permanent silence.
 *
 * These helpers are pure so they're easy to unit-test. The side-effecty
 * restart / notify logic lives in server.ts.
 */

export const CONTEXT_EXHAUSTION_MARKER = 'Prompt is too long'
export const ORPHANED_REPLY_TIMEOUT_MS = 30_000

/**
 * Maximum number of times the orphaned-reply backstop timer may re-arm
 * itself when a tool call is in flight, before it fires a synthetic turn_end
 * anyway (to surface a genuinely hung tool).
 *
 * Math: 20 re-arms × 30 s fuse = 10 min of genuine tool activity before the
 * backstop surfaces. Chosen to cover multi-phase agent turns (write → compile
 * → test → fix loop) while still catching a truly wedged single tool within a
 * reasonable wall-clock bound.
 */
export const ORPHANED_REPLY_MAX_REARMS = 20

export function isContextExhaustionText(text: string): boolean {
  return text.includes(CONTEXT_EXHAUSTION_MARKER)
}

/**
 * Should the orphaned-reply timeout be armed right now? True when the
 * session has a chat, captured assistant text, and the reply tool has
 * not yet been called for this turn.
 */
export function shouldArmOrphanedReplyTimeout(params: {
  currentSessionChatId: string | null
  capturedTextCount: number
  replyCalled: boolean
  progressCardActive?: boolean
}): boolean {
  return (
    params.currentSessionChatId != null &&
    params.capturedTextCount > 0 &&
    !params.replyCalled &&
    !params.progressCardActive
  )
}

/**
 * Default "recently streaming" window (ms) for the orphaned-reply liveness
 * stamp. The gateway overrides this from
 * SWITCHROOM_ORPHANED_REPLY_STREAM_WINDOW_MS; this constant is the fallback and
 * the value the LivenessTracker tests pin against.
 */
export const ORPHANED_REPLY_STREAM_WINDOW_MS = 120_000

/**
 * Result of a fuse-expiry decision.
 *
 *  - `rearm`           — re-arm the fuse (keep the turn alive) instead of
 *                        firing the synthetic turn_end backstop.
 *  - `countsAgainstCap`— this rearm (or the fire it turned into at the cap) was
 *                        a working/recently-streaming rearm, i.e. subject to the
 *                        ORPHANED_REPLY_MAX_REARMS cap. Human-wait rearms are
 *                        uncapped and report `false` here.
 */
export interface OrphanedReplyExpiryDecision {
  rearm: boolean
  countsAgainstCap: boolean
}

/**
 * Per-turn liveness tracker for the orphaned-reply backstop.
 *
 * WHY THIS EXISTS (the thinking-pause fix):
 *   The orphaned-reply fuse (ORPHANED_REPLY_TIMEOUT_MS = 30 s) used to be reset
 *   ONLY by `tool_label` and `text` stream events. During a long model
 *   reasoning pause the gateway sees NO such events (thinking events carry no
 *   text), so the fuse ran down and force-ended a genuinely-live turn mid-work
 *   ("orphaned-reply timeout (30000ms) — forcing backstop" ~1 ms before
 *   turn_end, with minutes of real work still to come).
 *
 * THE FIX:
 *   Stamp `lastStreamEventAt` on ANY genuine stream event (via onStreamEvent,
 *   called from the gateway dispatcher entry). If a genuine event arrived
 *   within `windowMs` (default 120 s) the turn is "recently streaming" and the
 *   fuse re-arms instead of firing — a reasoning pause is survivable while a
 *   genuine multi-minute hang (no events at all) still fires.
 *
 * This is a small, pure, side-effect-free seam so the decision logic is unit
 * testable without the full gateway. The gateway holds one instance per
 * CurrentTurn (so per-turn identity / supersession semantics are unchanged) and
 * delegates: the dispatcher calls onStreamEvent; the fire callback calls
 * decideOnExpiry; the defensive turn_end guard reads recentlyStreaming.
 */
export class LivenessTracker {
  /** Wall-clock (ms) of the last genuine stream event for this turn. */
  lastStreamEventAt: number
  /**
   * How many times the fuse re-armed on a working / recently-streaming
   * expiry. Bounded by ORPHANED_REPLY_MAX_REARMS. Zeroed by onStreamEvent
   * whenever a genuine stream event lands, so the cap only bites CONSECUTIVE
   * silent expiries (a genuinely wedged single tool with no stream at all).
   */
  orphanedReplyRearmCount = 0

  constructor(startedAt: number) {
    this.lastStreamEventAt = startedAt
  }

  /**
   * Stamp liveness for a genuine stream event and reset the rearm counter.
   *
   * F4 predicate: everything EXCEPT the synthetic `turn_end` re-entry
   * (durationMs === -1, the fire callback's own re-dispatch) counts as a
   * genuine stream event. Stamping a REAL turn_end (durationMs >= 0) is
   * harmless — the turn is ending anyway.
   *
   * The counter reset lives HERE (driven by the dispatcher), NOT in the fuse
   * re-arm path — otherwise every rearm would zero its own counter and nullify
   * the 20-cap.
   */
  onStreamEvent(kind: string, durationMs: number | undefined, now: number): void {
    if (kind === 'turn_end' && durationMs === -1) return
    this.lastStreamEventAt = now
    this.orphanedReplyRearmCount = 0
  }

  /** True iff a genuine stream event landed within `windowMs` of `now`. */
  recentlyStreaming(now: number, windowMs: number): boolean {
    return now - this.lastStreamEventAt < windowMs
  }

  /**
   * Decide what to do when the orphaned-reply fuse expires.
   *
   * Rearm when the turn is working OR recently streaming OR a human is being
   * waited on. Working / recently-streaming rearms count against `maxRearms`
   * (so a genuinely wedged single tool that never streams still surfaces after
   * the cap). Human-wait rearms are uncapped (the human simply hasn't tapped
   * yet). Once the cap is hit with nothing else keeping the turn alive, fire
   * (rearm:false) — matching the existing fail-safe.
   *
   * Mutates `orphanedReplyRearmCount` on each rearm.
   */
  decideOnExpiry(opts: {
    working: boolean
    humanWaiting: boolean
    now: number
    windowMs: number
    maxRearms: number
  }): OrphanedReplyExpiryDecision {
    // Human-wait rearms are uncapped (unchanged from prior behaviour).
    if (opts.humanWaiting) {
      this.orphanedReplyRearmCount++
      return { rearm: true, countsAgainstCap: false }
    }
    const recently = this.recentlyStreaming(opts.now, opts.windowMs)
    if (opts.working || recently) {
      if (this.orphanedReplyRearmCount < opts.maxRearms) {
        this.orphanedReplyRearmCount++
        return { rearm: true, countsAgainstCap: true }
      }
      // Cap reached with only working/recently-streaming keeping it alive:
      // fire to surface the wedge.
      return { rearm: false, countsAgainstCap: true }
    }
    // Nothing keeping the turn alive → fire (fail-safe).
    return { rearm: false, countsAgainstCap: false }
  }
}
