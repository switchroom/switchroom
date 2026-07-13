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
  /**
   * A background sub-agent (Agent/Task dispatched, turn ended before it
   * returned) is still in flight AND within its suppression TTL (#3117). The
   * main-turn gate (`turnInFlight`) is blind to detached background work: a
   * worker that is alive-but-silent for a full idle window (one long tool call,
   * no stream events to re-stamp the activity clock) would otherwise be cleared,
   * destroying the context its handback needs. Suppress the clear while this is
   * true. It is TTL-bounded by the caller so a leaked/never-cleared pending flag
   * cannot disable idle-clear forever — past the TTL the caller passes false and
   * self-healing resumes. Optional/undefined ⇒ treated as false (no background
   * work), which preserves the pre-#3117 behaviour for callers that don't wire
   * it (e.g. the pure-decider unit tests that exercise only the wall clock).
   */
  backgroundWorkInFlight?: boolean;
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
  // #3117 — a detached background sub-agent within its suppression TTL keeps the
  // session alive even when the main-turn gate is open and the activity clock
  // has gone cold (a silent long-running worker emits no stream events). The
  // caller (gateway) bounds this by a TTL so a stuck pending flag can't disable
  // idle-clear forever; here we simply honour it. Because #3116's write-time
  // re-eval re-runs this whole function against the live state, this suppression
  // is enforced at BOTH decision time and /clear write time for free.
  if (state.backgroundWorkInFlight) return { clear: false };
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
 * Inputs the gateway feeds into a decision that live OUTSIDE the idle clocks:
 * the resolved window, the main-turn gate, and the TTL-bounded background-work
 * suppressor. Kept separate from `IdleClearState` (the clock state the tracker
 * owns) so the tracker's decide surface is exactly "here is the world right
 * now" and the tracker supplies its own clocks + latch.
 */
export interface IdleDecisionInputs {
  /** Resolved idle window in ms (env → per-agent config → 3h default). <=0 disables. */
  idleClearMs: number;
  /** A turn is in flight (the same gate proactive-compact uses). Never clear mid-turn. */
  turnInFlight: boolean;
  /**
   * A detached background sub-agent is in flight AND within its suppression TTL
   * (#3117). Optional; undefined ⇒ false (pre-#3117 behaviour). The caller bounds
   * this by a TTL so a leaked pending flag can't disable idle-clear forever.
   */
  backgroundWorkInFlight?: boolean;
}

/**
 * The gateway's idle bookkeeping as ONE stateful object (#3115).
 *
 * Before #3115 this lived as four bare module-level `let`s in gateway.ts
 * (`lastIdleActivityAt`, `lastIdleTurnEndAt`, `idleAutoCleared`,
 * `idleClearDispatching`) plus the inline `markIdleActivity` / `markIdleTurnEnd`
 * / `maybeIdleClear` stamp+decide logic scattered across `handleSessionEvent`,
 * `onInjectInbound`, and `handleInbound`. Nothing imported gateway.ts (~30k
 * lines, import-time side effects), so the WIRING — that every session event
 * actually stamps the clocks — was untestable and the test mirrored the logic
 * in a local `IdleModel` instead of exercising it. Deleting the real stamp
 * block left every test green while re-introducing the #3113 "productive work
 * gets wiped" bug.
 *
 * Extracting the state here makes the real object importable and drivable: a
 * deleted stamp call now fails a test because the test holds the SAME object
 * the gateway holds. The gateway keeps ownership of its environment concerns
 * (resolving the window, `turnInFlightForGate()`, the pending-dispatch probe)
 * and feeds them in via `IdleDecisionInputs`; the tracker owns only the clocks
 * and the fire-once / re-entrancy latches.
 *
 * The clock is injected per-call (`now`) exactly like the pure `decideIdleClear`
 * / `classifyIdleEvent` it delegates to — the gateway passes `Date.now()`, the
 * tests pass a deterministic virtual clock.
 */
export class IdleTracker {
  /** Epoch ms of the last activity (inbound, cron fire, or any genuine session event). */
  private lastActivityAt: number;
  /** Epoch ms a turn last ended (null = none this process). */
  private lastTurnEndedAt: number | null = null;
  /** Already auto-cleared since the last activity? Fire-once-per-idle-period latch. */
  private alreadyCleared = false;
  /** A /clear dispatch is in flight — re-entrancy guard so a tick can't double-fire. */
  private dispatching = false;

  constructor(startedAt: number) {
    this.lastActivityAt = startedAt;
  }

  /** Epoch ms of the last activity — for wiring assertions (was `lastIdleActivityAt`). */
  get activityAt(): number {
    return this.lastActivityAt;
  }
  /** Epoch ms a turn last ended, or null — for wiring assertions. */
  get turnEndedAt(): number | null {
    return this.lastTurnEndedAt;
  }
  /** The fire-once latch — true once cleared this idle period, until re-armed. */
  get cleared(): boolean {
    return this.alreadyCleared;
  }
  /** A /clear dispatch is currently in flight. */
  get isDispatching(): boolean {
    return this.dispatching;
  }

  /**
   * Reset the idle timer + re-arm auto-clear. Call on ANY activity — inbound,
   * a genuine cron fire, or (via `noteEvent`) any claude session-stream event.
   * Was the gateway's `markIdleActivity()`.
   */
  noteInbound(now: number): void {
    this.lastActivityAt = now;
    this.alreadyCleared = false;
  }

  /**
   * Feed a claude session-stream event through the classifier and stamp the
   * clocks. Genuine activity re-arms the auto-clear; a turn ending additionally
   * stamps the turn-end clock. Was the gateway's inline
   * `classifyIdleEvent` + `markIdleActivity`/`markIdleTurnEnd` block in
   * `handleSessionEvent` — the load-bearing wiring #3115 makes testable.
   */
  noteEvent(kind: string, now: number, durationMs?: number): void {
    const signal = classifyIdleEvent(kind, durationMs);
    if (signal.activity) this.noteInbound(now);
    if (signal.turnEnded) this.lastTurnEndedAt = now;
  }

  /** Snapshot the tracker's clocks into an `IdleClearState` for a decision. */
  private stateFor(inputs: IdleDecisionInputs, alreadyCleared: boolean): IdleClearState {
    return {
      lastActivityAt: this.lastActivityAt,
      lastTurnEndedAt: this.lastTurnEndedAt,
      idleClearMs: inputs.idleClearMs,
      alreadyCleared,
      turnInFlight: inputs.turnInFlight,
      backgroundWorkInFlight: inputs.backgroundWorkInFlight,
    };
  }

  /**
   * Decide whether to auto-clear right now, honouring the fire-once latch.
   * Delegates to the pure `decideIdleClear` against the live clocks + inputs.
   */
  decide(now: number, inputs: IdleDecisionInputs): IdleClearDecision {
    return decideIdleClear(this.stateFor(inputs, this.alreadyCleared), now);
  }

  /**
   * Re-evaluate idleness at /clear WRITE time (#3116 precondition), IGNORING the
   * fire-once latch. `maybeIdleClear` latches `alreadyCleared=true` before the
   * async inject for re-entrancy, so the write-time re-eval must judge idleness
   * on the live clocks + turn/background gates only — any activity that arrived
   * in the check-to-send gap must still suppress the buffered /clear.
   */
  decideIgnoringLatch(now: number, inputs: IdleDecisionInputs): IdleClearDecision {
    return decideIdleClear(this.stateFor(inputs, false), now);
  }

  /** Latch the fire-once guard: a /clear has been decided for this idle period. */
  markClearFired(): void {
    this.alreadyCleared = true;
  }
  /** Re-arm after a suppressed dispatch so the next idle period can clear again. */
  reArm(): void {
    this.alreadyCleared = false;
  }
  /** Mark a /clear dispatch as begun (re-entrancy latch). */
  beginDispatch(): void {
    this.dispatching = true;
  }
  /** Mark a /clear dispatch as finished (re-entrancy latch released). */
  endDispatch(): void {
    this.dispatching = false;
  }
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
