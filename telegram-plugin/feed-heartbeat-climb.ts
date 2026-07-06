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

/**
 * The per-turn view `runSilentTurnHeartbeatTick` reads — a structural subset of
 * the gateway's `CurrentTurn`, kept transport-free so this module (and its test)
 * never imports the gateway.
 */
export interface SilentTurnTickView {
  /** `turn.mirrorLines.length` at tick time. */
  mirrorLineCount: number
  /** `turn.activityMessageId` at tick time (null ⇒ no card open yet). */
  activityMessageId: number | null
  /** `turn.labeledToolCount` — surfaced in the card header. */
  labeledToolCount: number
  /** `now - turn.startedAt` at tick time. */
  ageMs: number
  /** The labelled branch's stale floor (`FEED_HEARTBEAT_MIN_STALE_MS`). The
   *  climb applies the SAME guard for symmetry: a turn younger than one stale
   *  window is fresh (its card just opened ~1.2s in), so no climb edit yet.
   *  Without this the climb relied on the tick interval == the stale window
   *  (both 6s today) — an implicit coupling this guard makes explicit. */
  minStaleMs: number
}

/**
 * The gateway seams the tick drives, injected as thunks so THIS function — the
 * shipped 0-label branch of `feedHeartbeatTick` — is directly executable in a
 * test with spies at each seam. The gateway wires the real implementations
 * (`openLivenessFeedIfDue`, `turn.activityPendingRender = …`, `cardDrainGate`,
 * `ea.mayDrain`, `ea.openOrEditCard('liveness', …)`,
 * `drainActivitySummary(turn, 'liveness')`); the wiring is pinned structurally
 * in tests/feed-heartbeat-liveness-open.test.ts.
 */
export interface SilentTurnTickDeps {
  /** The one shared OPEN path (`openLivenessFeedIfDue(turn)`). Owns the open;
   *  the climb never opens (reply-is-last gating lives on the open path). */
  openLivenessFeedIfDue: () => void
  /** Stage the climb render (`turn.activityPendingRender = rendered`). */
  setPendingRender: (rendered: string) => void
  /** The centralized chatLock-serialized card-drain gate
   *  (`cardDrainGate(turn, ea, run)`). */
  cardDrainGate: (run: () => void) => void
  /** The single-flight pure read (`ea.mayDrain(turn)`). */
  mayDrain: () => boolean
  /** The emission-authority façade routing (`ea.openOrEditCard('liveness', apply)`).
   *  With a card open this only ever EDITs — Telegram edits don't push-notify. */
  openOrEditCard: (apply: () => void) => void
  /** The drain kick-off (`turn.activityInFlight = drainActivitySummary(turn,
   *  'liveness')`) — the transport writer (sendMessage / editMessageText via
   *  robustApiCall) lives behind this seam. */
  drain: () => void
}

/**
 * The REAL 0-label branch of `feedHeartbeatTick` (deterministic-turn-liveness.md
 * Phase 1) — extracted here so the shipped decision logic is directly under
 * outcome-based test (`tests/silent-turn-climb-transport.test.ts`); the gateway
 * IIFE cannot be imported in-process, so the tick body lives in this module and
 * the gateway calls it with its real deps.
 *
 * Returns true when the tick was handled by the 0-label path (the caller must
 * stop — the labelled-feed heartbeat does not run), false when a tool label has
 * surfaced (`mirrorLineCount > 0`) and the labelled branch owns the tick.
 *
 * Behaviour:
 *   - no card open yet → delegate to the one shared OPEN path (never opens here);
 *   - card open + turn younger than `minStaleMs` → fresh, no edit yet (the same
 *     stale-guard the labelled branch applies to its step elapsed);
 *   - card open + stale → stage the climbing "Working · Ns" render and EDIT it
 *     through the same cardDrainGate → mayDrain → openOrEditCard → drain gate
 *     sequence the labelled branch uses. Deterministic + framework-owned: reads
 *     only wall-clock `ageMs`, so a blocked tool call cannot starve it.
 */
export function runSilentTurnHeartbeatTick(
  view: SilentTurnTickView,
  deps: SilentTurnTickDeps,
): boolean {
  if (view.mirrorLineCount !== 0) return false
  if (view.activityMessageId == null) {
    deps.openLivenessFeedIfDue()
    return true
  }
  // Stale-guard (symmetry with the labelled branch's `elapsed <
  // FEED_HEARTBEAT_MIN_STALE_MS` check): the 0-label "step" starts at turn
  // start, so `ageMs` IS its elapsed. A younger turn's card just opened.
  if (view.ageMs < view.minStaleMs) return true
  const rendered = silentTurnClimbRender({
    mirrorLineCount: view.mirrorLineCount,
    activityMessageId: view.activityMessageId,
    labeledToolCount: view.labeledToolCount,
    ageMs: view.ageMs,
  })
  if (rendered == null) return true
  deps.setPendingRender(rendered)
  deps.cardDrainGate(() => {
    if (deps.mayDrain()) {
      // Maintains an already-open card (guarded above on activityMessageId !=
      // null) → only ever EDITs. 'liveness' producer is correct.
      deps.openOrEditCard(() => {
        deps.drain()
      })
    }
  })
  return true
}
