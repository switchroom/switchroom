/**
 * Deterministic silent-turn card climb — the framework owns "alive" and "for how
 * long"; the model owns "what".
 *
 * Implements Phase 1 (the keystone) of `reference/rfcs/deterministic-turn-liveness.md`.
 * Serves `reference/jobs/know-what-my-agent-is-doing.md` (outcome: at any moment
 * during a turn the user can see the agent is alive and how long it has been
 * working, without asking).
 *
 * ## The bug this closes
 *
 * On the 0-label path of `feedHeartbeatTick` (a turn that has surfaced NO tool
 * label — a long single `Bash`, or only suppressed-by-design tools), the tick
 * delegated to `openLivenessFeedIfDue`, whose WHEN-gate `shouldEarlyOpenLiveness`
 * returns `false` the moment a card is already open (`activityMessageId != null`).
 * Result: once the "Working…" card opened, the 0-label branch NEVER edited it
 * again during a silent tool — the card froze on its opening elapsed while the
 * agent was busy for tens of seconds. The only remaining signal was the ambient
 * "stuck" reaction flip, which reads as *done*, not *working*.
 *
 * ## The fix
 *
 * Give the 0-label branch the SAME climbing-elapsed EDIT the labelled branch
 * already performs: when a card is open and `mirrorLines` is empty, re-render the
 * minimal "Working…" card with a fresh wall-clock elapsed on every heartbeat tick.
 * The render is derived PURELY from `ageMs` (`now - turn.startedAt`), so a tool
 * call blocked mid-flight — emitting nothing — cannot starve it. Worst-case gap
 * between visible edits is one to two `FEED_HEARTBEAT_MIN_STALE_MS` windows
 * (~6-12s), versus the observed ~50s freeze.
 *
 * This is a card EDIT, not a text send: it edits the card the chat already owns,
 * and Telegram card edits do not push-notify — squarely the Ambient layer of
 * `reference/rfcs/conversational-pacing.md`, crossing no invariant (no parallel
 * surface, no mid-turn device buzz). When the model DOES narrate, its words land
 * on the same card chronologically (`mirrorLines` becomes non-empty and the
 * labelled-feed heartbeat takes over) — the climb fills only the gaps the model
 * leaves and never overwrites narration.
 *
 * Kept as a small pure function so the guarantee can be proven at the transport
 * boundary (Phase 4b regression test) rather than by grepping the gateway source.
 */
import {
  renderActivityFeedWithNested,
  formatStepSuffix,
  type SessionActivityHeader,
} from './tool-activity-summary.js'

/** The minimal placeholder line the silent-turn card carries when no tool label
 *  has surfaced. Matches `openLivenessFeedIfDue`'s open render so the climb edit
 *  is a clean continuation of the placeholder the OPEN path produced. */
export const SILENT_TURN_PLACEHOLDER = 'Working…'

export interface SilentTurnClimbInput {
  /** `turn.mirrorLines.length`. 0 ⇒ no tool label has surfaced this turn (pure
   *  thinking / only suppressed tools) — the case this climb owns. >0 ⇒ a real
   *  label drives the labelled-feed heartbeat, which owns the climb instead. */
  mirrorLineCount: number
  /** `turn.activityMessageId`. `null` ⇒ no card is open yet, so the OPEN path
   *  (`openLivenessFeedIfDue`) owns this tick; non-null ⇒ a card is open and this
   *  branch must keep it climbing (the exact freeze this fix closes). */
  activityMessageId: number | null
  /** `turn.labeledToolCount` — surfaced in the card header's tool count. */
  labeledToolCount: number
  /** `now - turn.startedAt`: wall-clock elapsed since turn start. The single
   *  signal the model can never supply while blocked inside a tool. */
  ageMs: number
}

/**
 * The deterministic 0-label climb render. Returns the card body HTML to EDIT the
 * already-open "Working…" card with a climbing wall-clock elapsed, or `null` when
 * this branch must NOT edit:
 *   - `mirrorLineCount > 0` — a tool label surfaced; the labelled-feed heartbeat
 *     owns the climb (its edit cleanly replaces this placeholder).
 *   - `activityMessageId == null` — no card is open yet; the OPEN path
 *     (`openLivenessFeedIfDue`) owns this tick.
 *
 * The header's `elapsedMs` carries the climbing clock, so each tick's edit shows
 * a higher "Working · Ns" than the last. Model-independent by construction: it
 * reads only wall-clock `ageMs`.
 */
export function silentTurnClimbRender(input: SilentTurnClimbInput): string | null {
  if (input.mirrorLineCount > 0) return null
  if (input.activityMessageId == null) return null
  const header: SessionActivityHeader = {
    label: 'Agent',
    elapsedMs: input.ageMs,
    toolCount: input.labeledToolCount,
    state: 'running',
  }
  // Single "step" whose start is the turn start, so `ageMs` IS the step's own
  // elapsed. formatStepSuffix keeps the `→` line timer-free until STEP_TIMER_MIN_MS;
  // the header total still climbs every tick — that is the visible clock.
  return renderActivityFeedWithNested(
    [SILENT_TURN_PLACEHOLDER],
    [],
    false,
    formatStepSuffix(input.ageMs),
    undefined,
    header,
  )
}
