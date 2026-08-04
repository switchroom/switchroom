/**
 * silence-poke.ts — framework safety net for a genuinely wedged turn.
 *
 * Scope (post-#1981-era retirement): this module is now ONLY the
 * last-resort unwedge. The conversational pacing the user actually sees
 * — the acknowledgement beat, the "still going" progress updates — is
 * owned by the live-updating reply/draft (the chat IS the artifact) and
 * by the model's own `reply`/`stream_reply` calls, not by framework
 * nudges. The earlier model-targeted nudge ladder (ack at 10s, soft at
 * 75s, firm at 180s) and the 60s user-visible awareness ping were
 * retired: their success rate was 0-7% by the design's own KPI, and they
 * duplicated a job the draft thinking-lane now does natively. See
 * `reference/rfcs/conversational-pacing.md` § Safety net.
 *
 * What remains: ONE silence clock and ONE terminal action.
 *
 *   silence clock = now - lastOutboundAt   (or turnStartedAt if no outbound yet)
 *
 * Outbound = a fresh `reply` or `stream_reply` first-emit. Reactions,
 * edits, and tool churn DO NOT reset the silence clock — the model could
 * be ripping through 20 tool calls and still be "silent" to the user.
 *
 * Fix A caveat (opt-in, `deferFallbackWhileToolInFlight`): tool churn still
 * doesn't reset the *clock*, but when the threshold is crossed WITH a parent
 * tool genuinely in flight, the terminal unwedge is DEFERRED (not skipped) up to
 * `fallbackHardCeiling`. Since #2162 the live activity feed renders that tool
 * work, so the "still silent to the user" premise no longer holds while a tool
 * is visibly running; nulling `currentTurn` there would darken the very feed the
 * user is watching. A turn with no in-flight tool is unaffected.
 *
 * #4330 caveat: an activity-card render that LANDED on Telegram within
 * `CARD_RENDER_FRESH_MS` (stamped via `noteCardRender` from the card-drain
 * transport) likewise DEFERS the terminal unwedge, bounded by the same hard
 * ceiling — a visibly-updating pinned "→ Working…" card is user-visible
 * activity, and killing the turn under it is a false positive. It never
 * resets the clock: the framework heartbeat climbs the card on pure wall
 * clock even on a hung turn, so a reset would pin a dead turn forever.
 *
 * Terminal action, once per turn:
 *
 *   t=0       startTurn() — silence clock starts at turnStartedAt
 *   t=300s    framework fallback: the gateway sends a user-visible
 *             "still working… / still thinking…" message AND unwedges the
 *             turn (clears activeTurnStartedAt, nulls currentTurn, drains
 *             buffered inbound, purges stale turn state). This is the
 *             load-bearing unwedge primitive — NOT a nudge — that keeps a
 *             dead turn from pinning the conversation forever.
 *
 * The fallback message is enriched with in-flight tool context so it
 * reads honestly ("running Grep \"foo\" for 4m") instead of a generic
 * "still working…" when the agent is clearly busy — #1292. Tool churn
 * enriches the TEXT only, never the timing.
 *
 * Kill switch: SWITCHROOM_DISABLE_SILENCE_POKE=1 disables the whole
 * subsystem (no timer, no fallback, no unwedge). The conversational
 * pacing prompt + draft still apply; only the framework safety net is off.
 */

import {
  decideMidTurnFloor,
  midTurnFloorEnabled,
  type LoopRole,
} from './turn-liveness-floor.js'

/** #1292: snapshot of an in-flight tool call, surfaced in the 300s
 * framework-fallback message so the user sees the actual observable
 * ("running Grep \"foo\" for 4m") instead of the dishonest generic
 * "still working… no update in 5 min" when the agent is clearly busy
 * grinding through tool calls. */
export interface ToolSnapshot {
  /** Bare tool name as it came off the wire (e.g. "Grep", "Read", "Bash"). */
  name: string
  /** Natural-language descriptor from `toolLabel()` if available (e.g. the
   * query for Grep, basename for Read/Edit/Write, hostname for WebFetch),
   * or null when no useful label could be derived. */
  label: string | null
  /** Time since this tool call started, in ms. */
  durationMs: number
}

export interface SilencePokeState {
  /** Wall-clock ms of turn start. Silence clock zero-point when no outbound yet. */
  turnStartedAt: number
  /** Wall-clock ms of last outbound message, or null. */
  lastOutboundAt: number | null
  /** Wall-clock ms of last `thinking` session event, or null. */
  lastThinkingAt: number | null
  /** True once the 300s framework fallback has fired this turn. */
  fallbackFired: boolean
  /** #2527: true once the mid-turn liveness floor has fired this turn.
   *  Independent of `fallbackFired` — the floor is the early (45s) quiet
   *  beat, the fallback the late (300s) loud unwedge. Fire-once each. */
  floorFired: boolean
  /** #1292: in-flight tool calls keyed by toolUseId. Populated by
   * `noteToolStart` on every parent-agent `tool_use` event the gateway
   * sees and drained by `noteToolEnd` on the matching `tool_result`.
   * Read only inside `tick()` when the 300s fallback fires — at that
   * point we snapshot the entries (sorted by startedAt ascending) and
   * include the longest-running one in the fallback message body.
   * NOTE: presence of in-flight tools does NOT reset the silence
   * clock — the design choice in this module's header is preserved.
   * We only enrich the fallback TEXT, not the timing. */
  inFlightTools: Map<string, { name: string; startedAt: number; label: string | null }>
  /**
   * #3519: true once ANY `Bash` tool_use has been observed in this turn.
   * A foreground `Bash` that exceeds the claude-CLI foreground window is
   * auto-moved to the background: its `tool_result` returns to the model
   * (so `inFlightTools` empties and `isLegitimatelyWorking()`'s foreground
   * / async-dispatch checks all go false), yet the process keeps running
   * and the model sits silent waiting on it. That silent gap is invisible
   * to every existing "still working" signal, so the 300s fallback fired
   * mid-work — nulling `currentTurn`, tearing down the pinned progress
   * card, and letting the next tool burst mint a BRAND-NEW card (the
   * stacked-cards bug). Arming this flag on the first Bash of the turn lets
   * the fallback defer such gaps. Turn-scoped (set here, only cleared by a
   * fresh `startTurn`); bounded by `fallbackHardCeiling` so a genuinely
   * wedged bash-turn still unwedges at the ceiling. Does NOT reset the
   * silence clock — a real reply / feed edit still does that; this only
   * gates the terminal teardown. */
  sawBashThisTurn: boolean
  /**
   * #4330: wall-clock ms of the last activity-card render (open or in-place
   * edit) that actually LANDED on Telegram for this turn — the pinned
   * "→ Working… · Nm · N tools" status card the user is watching. Stamped by
   * `noteCardRender` from the card-drain transport site
   * (`gateway/narrative-lane.ts` drainActivitySummary), which covers every
   * producer: tool labels, narrative SHOWs, the liveness open, and the
   * framework heartbeat climb. Deliberately NOT a clock reset — the heartbeat
   * climb re-renders on pure wall clock, so a hung turn's card keeps
   * "updating" and an unbounded reset would pin a dead turn forever (the
   * #1556 class). Instead the tick() DEFERS the terminal fallback while the
   * card moved within `CARD_RENDER_FRESH_MS`, bounded by
   * `fallbackHardCeiling` exactly like the in-flight-tool / compaction
   * defers. null until the first card render of the turn. */
  lastCardRenderAt: number | null
  /**
   * #3519 sharpen: claude-CLI background shells PROVEN alive right now. A
   * shell is added on its launch marker (structured `backgroundTaskId`, via
   * `noteBackgroundShellAlive`) and removed when the CLI proactively reports
   * it done (`<task-notification>` completed/failed) or the model `KillShell`s
   * it (via `noteBackgroundShellDead`). Non-empty ⇒ a process is running, so
   * defer the 300s teardown. Empty ⇒ nothing running, so a FINISHED bash no
   * longer defers — restoring ~300s wedge recovery that the coarse
   * `sawBashThisTurn` guard held to 900s. Turn-scoped (cleared by startTurn),
   * bounded by `fallbackHardCeiling` like every other defer. */
  aliveShells: Set<string>
}

export interface ThresholdsMs {
  /** Silence (since last outbound, or turn start) after which the
   *  framework sends the user-visible fallback AND unwedges the turn. */
  fallback: number
  /**
   * Fix A — hard ceiling for the in-flight-tool defer. When
   * `deferFallbackWhileToolInFlight` is on, the fallback is held back while a
   * parent tool is genuinely in flight (the agent is demonstrably working and
   * the live activity feed is showing it). This bounds that defer: once silence
   * crosses the ceiling the fallback fires REGARDLESS of an in-flight tool, so a
   * hung-mid-tool turn can't pin the conversation forever. Ignored unless the
   * defer is on; defaults to no ceiling (Infinity) when omitted.
   */
  fallbackHardCeiling?: number
  /**
   * #2527 — mid-turn liveness floor threshold. After this much busy-silence
   * on a `user` turn that hasn't delivered a substantive answer, the floor
   * fires ONE quiet (no-ping) interim so the user isn't left staring at the
   * ambient 👀. Strictly below `fallback` (which owns the beat above it).
   * Omitted (undefined) disables the floor entirely.
   */
  floor?: number
}

export const DEFAULT_THRESHOLDS: ThresholdsMs = {
  fallback: 300_000,
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000

/**
 * #4330 — how recent the last landed activity-card render must be for the
 * card to count as "actively updating in front of the user". The framework
 * heartbeat edits the card every ~6s (FEED_HEARTBEAT_MIN_STALE_MS); 30s
 * tolerates several shed/coalesced cosmetic edits under flood-control
 * backoff while still lapsing quickly once the card genuinely stops moving
 * (turn ended → card cleared, or the drain wedged).
 */
export const CARD_RENDER_FRESH_MS = 30_000

export interface FrameworkFallbackContext {
  key: string
  chatId: string
  threadId: number | null
  /** Picked from lastThinkingAt: 'thinking' if a thinking event landed in
   *  the last 30s of silence, else 'working'. Note: 'working' is the
   *  default base; when `inFlightTools` is non-empty the fallback text
   *  uses the tool-aware wording instead of either 'working' / 'thinking'
   *  (see `formatFrameworkFallbackText`). */
  fallbackKind: 'working' | 'thinking'
  silenceMs: number
  /** #1292: snapshot of in-flight tool calls at the moment the fallback
   *  fires, sorted by startedAt ascending. Empty when no tools were
   *  in flight (e.g. agent genuinely silent, or all tools completed
   *  faster than the 300s threshold). The format helper uses entry [0]
   *  (longest-running) for the message body and "+ N more" when
   *  length > 1. */
  inFlightTools: ToolSnapshot[]
}

/**
 * #2527 — context handed to the gateway when the mid-turn floor fires. The
 * gateway formats the honest text (from `inFlightTools`) and sends it through
 * the SAME path a model reply takes — no parallel send. Mirrors
 * `FrameworkFallbackContext` minus the wedge semantics: the floor never
 * unwedges the turn, it just speaks.
 */
export interface MidTurnFloorContext {
  key: string
  chatId: string
  threadId: number | null
  silenceMs: number
  inFlightTools: ToolSnapshot[]
  /** True when fired by a user "Status?" mid-turn inbound rather than the timer. */
  forced: boolean
}

export type SilencePokeMetric =
  | { kind: 'silence_fallback_sent'; key: string; fallback_kind: 'working' | 'thinking'; silence_ms: number }
  | { kind: 'mid_turn_floor'; key: string; silence_ms: number; forced: boolean; decision: 'fire' | string }
  /** #3552 — per-turn state dropped because its turn is provably over. */
  | { kind: 'silence_poke_orphan_reaped'; key: string; silence_ms: number }

export interface SilencePokeDeps {
  /** Called when the 300s fallback fires. Caller sends the user-visible
   *  message + ensures it pings the device, then unwedges the turn. */
  onFrameworkFallback: (ctx: FrameworkFallbackContext) => Promise<void> | void
  /** Telemetry sink for the fallback event. */
  emitMetric: (event: SilencePokeMetric) => void
  /** Threshold overrides (tests). */
  thresholdsMs?: ThresholdsMs
  /** Poll interval (tests). */
  pollIntervalMs?: number
  /**
   * Feed-survival predicate callback. When provided, the 300s framework
   * fallback is DEFERRED while this function returns true: the agent is
   * demonstrably working (in-flight tool, detached background process, or a
   * human-wait tool like ask_user), and since #2162 the live activity feed
   * shows that work, so nulling `currentTurn` would darken a feed the user is
   * actively watching. The defer is bounded by `thresholdsMs.fallbackHardCeiling`
   * so a hung-or-missing-work-signal turn still unwedges eventually.
   *
   * This supersedes `deferFallbackWhileToolInFlight`. When present it is ALWAYS
   * consulted (no extra env flag required). Set SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=0
   * in the environment to force-disable the defer even when this callback is wired.
   */
  isLegitimatelyWorking?: (key: string) => boolean
  /**
   * Legacy boolean flag — honoured when `isLegitimatelyWorking` is absent.
   * When true, the 300s fallback is deferred while `inFlightTools` is non-empty,
   * bounded by `thresholdsMs.fallbackHardCeiling`.
   * @deprecated Prefer `isLegitimatelyWorking` which covers detached work and
   * human-wait tools in addition to foreground in-flight tool calls.
   */
  deferFallbackWhileToolInFlight?: boolean
  /**
   * #2527 — called when the mid-turn liveness floor fires. The gateway sends
   * the honest "still on it" interim through the shared reply path. Optional:
   * when absent the floor never fires (back-compat for test harnesses).
   */
  onMidTurnFloor?: (ctx: MidTurnFloorContext) => Promise<void> | void
  /**
   * #2527 — the gateway-owned half of the floor decision: the turn's loop
   * role and whether a substantive answer has already landed. silence-poke
   * owns the timing/working/fire-once half; the pure `decideMidTurnFloor`
   * combines both. Returns null when there is no live turn for `key`.
   */
  floorState?: (key: string) => { role: LoopRole; finalAnswerDelivered: boolean } | null
  /**
   * #3552 — orphan-state reaper predicate. Returns true while `key` still has a
   * LIVE turn behind it, false once the turn is provably over.
   *
   * Why: `startTurn(key)` arms per-turn state that only `endTurn(key)` drops,
   * and several turn-end paths never reach an `endTurn` call — a bridge death
   * (`disconnect-flush`), a keyed teardown that bypasses the `turn_end` handler,
   * or any future path that nulls the turn without the cleanup tail. The state
   * then survives its turn and sits in the Map until the 300s fallback fires
   * against a dead key, is recognised as a late fire, logs
   * `turn_ended_cleanly_during_window` and only THEN calls `endTurn`. Measured:
   * 504 such skips vs 110 real fires in 14 days (switchroom#3552).
   *
   * Wiring this callback moves that cleanup from "300s later, at fire time" to
   * "the next poll tick", deterministically and independent of which path ended
   * the turn. The predicate MUST be the same one the fallback's late-fire guard
   * uses (`activeTurnStartedAt` empty AND no current turn) so a turn that has
   * merely released its buffer gate mid-turn — the normal post-final-answer
   * state, where silence-poke must keep watching — is never reaped.
   *
   * Optional: when absent (test harnesses) the reaper is off and behaviour is
   * exactly as before.
   */
  isTurnLive?: (key: string) => boolean
  /**
   * #4058 — mid-turn auto-compaction defer predicate. Returns true while the
   * Claude CLI is compacting the session for `key`'s turn (the PreCompact hook
   * wrote the compaction marker and the `compact_boundary` transcript record
   * hasn't landed / the marker isn't stale — see gateway/compaction-marker.ts).
   *
   * Why: during compaction the model emits ZERO output and runs ZERO tools
   * for minutes, so every other work signal (`isLegitimatelyWorking`,
   * in-flight tools, alive shells) is false and the 300s fallback fired on a
   * healthy turn — a spurious "framework ended that stalled turn" card + a
   * harmless re-ask, recurring on any session near the context ceiling.
   *
   * Semantics mirror the #1292/#3519 defers exactly: the silence CLOCK is
   * never reset here; the terminal unwedge is DEFERRED (`continue` without
   * setting fallbackFired) and remains bounded by `fallbackHardCeiling`, so
   * a genuinely-wedged compaction still unwedges at the ceiling. Optional:
   * absent (legacy fixtures) ⇒ behaviour unchanged.
   */
  isCompactionInFlight?: (key: string) => boolean
}

const state = new Map<string, SilencePokeState>()
let timer: ReturnType<typeof setInterval> | null = null
let activeDeps: SilencePokeDeps | null = null

/**
 * #3519 sharpen — deterministic SAFE-DEGRADATION latch (process-scoped).
 * Flipped true the first time `noteBackgroundShellAlive` fires, i.e. the
 * moment the session-tail marker parser resolves a real `backgroundTaskId`
 * against the live claude CLI. Its purpose is to distinguish two look-alike
 * states that both present as "a Bash ran but no shell is registered alive":
 *   • CLI markers work, the bash simply FINISHED  → trust the empty alive-set,
 *     let the 300s fallback fire (fast wedge recovery restored); and
 *   • CLI changed its markers so the parser never matches → we CANNOT tell a
 *     live auto-backgrounded bash from a finished one, so fall back to the
 *     coarse 900s-bounded `sawBashThisTurn` guard (never stack, never hang).
 * Once ANY marker has parsed, the CLI is proven compatible and the alive-set
 * is authoritative. Never seen ⇒ stay conservative. Reset by tests only. */
let bgMarkerParserConfirmed = false

/**
 * True iff the kill switch is OFF. Re-read every call so tests can
 * toggle process.env without reloading the module.
 */
export function silencePokeEnabled(): boolean {
  const v = process.env.SWITCHROOM_DISABLE_SILENCE_POKE
  return !(v === '1' || v === 'true')
}

/**
 * Initialise a fresh turn's silence state. No-op when kill switch is on.
 */
export function startTurn(key: string, now: number): void {
  if (!silencePokeEnabled()) return
  state.set(key, {
    turnStartedAt: now,
    lastOutboundAt: null,
    lastThinkingAt: null,
    fallbackFired: false,
    floorFired: false,
    inFlightTools: new Map(),
    lastCardRenderAt: null,
    sawBashThisTurn: false,
    aliveShells: new Set(),
  })
}

/**
 * #3519 sharpen: register a claude-CLI background shell as ALIVE for `key`.
 * Called by the gateway when session-tail resolves a `backgroundTaskId` on a
 * tool_result (a foreground Bash auto-moved to the background, or an explicit
 * run_in_background:true). Flips the process-scoped parser-confirmed latch so
 * the safe-degradation path knows the CLI markers are compatible. No-op when
 * the key has no live turn (the launch outlived its turn — the cross-turn
 * ambient owns that case, not the 300s teardown).
 */
export function noteBackgroundShellAlive(key: string, shellId: string): void {
  bgMarkerParserConfirmed = true
  const s = state.get(key)
  if (s == null) return
  s.aliveShells.add(shellId)
}

/**
 * #3519 sharpen: mark a background shell DEAD for `key`. Called by the gateway
 * on a `<task-notification>` (completed/failed) or a `KillShell`. Idempotent —
 * removing an unknown id (already cleared, or launched in a prior turn) is a
 * no-op. Once the set empties, a subsequent >300s silence is a real wedge and
 * the fallback fires at ~300s.
 */
export function noteBackgroundShellDead(key: string, shellId: string): void {
  const s = state.get(key)
  if (s == null) return
  s.aliveShells.delete(shellId)
}

/**
 * Record a fresh user-visible outbound message (reply or stream_reply
 * first-emit). Resets the silence clock so the 300s fallback is measured
 * from the most recent thing the user actually saw.
 */
export function noteOutbound(key: string, now: number): void {
  const s = state.get(key)
  if (s == null) return
  s.lastOutboundAt = now
  s.fallbackFired = false
}

/**
 * Record observable PRODUCTION that isn't a final reply — an activity-feed
 * render (`→/✓` edit-in-place message) or an answer-stream draft update. Resets
 * the silence clock exactly like a reply.
 *
 * Why this exists (2026-06-05): the header's "only a real reply counts; tool
 * churn / the model ripping through 20 tool calls is still SILENT to the user"
 * rule predates the live activity feed (#2162) and the compose draft. Those
 * surfaces ARE user-visible now, so a turn actively rendering them is NOT
 * silent — yet the 300s fallback (which nulls `currentTurn` and kills the very
 * feed/draft the user is watching) still fired on a long tool/composition turn,
 * darkening the live status mid-work. Counting production as liveness makes the
 * fallback fire only on GENUINE silence (no reply, no feed, no draft, no tool
 * events for the window) — a real wedge. A wedged agent produces nothing
 * observable, so its clock is never reset and it still recovers.
 *
 * No-op when the kill switch is on or the key has no turn.
 */
export function noteProduction(key: string, now: number): void {
  const s = state.get(key)
  if (s == null) return
  s.lastOutboundAt = now
  s.fallbackFired = false
}

/**
 * #4330: record an activity-card render (open or in-place edit) that actually
 * LANDED on Telegram for `key` — the pinned "→ Working…" status card visibly
 * moved. Called from the card-drain transport site
 * (`gateway/narrative-lane.ts` drainActivitySummary) after a successful
 * sendRichMessage / non-shed editMessageText, so it covers every card
 * producer — tool labels, narrative SHOWs, the liveness open, AND the
 * framework heartbeat climb (`feedHeartbeatTick`), which is exactly the path
 * that has no `noteProduction` site.
 *
 * Deliberately does NOT reset the silence clock (`lastOutboundAt` untouched,
 * `fallbackFired` untouched): the heartbeat climb renders on pure wall clock
 * (`now - turn.startedAt`), so a genuinely hung turn's card keeps climbing
 * forever — counting that as production would keep a dead turn alive
 * indefinitely (the #1556 dangling-turn class the stream-render tool-label
 * comment warns about). Instead, tick() DEFERS the terminal fallback while
 * `now - lastCardRenderAt < CARD_RENDER_FRESH_MS`, bounded by
 * `fallbackHardCeiling` — same semantics as the #1292/#3519/#4058 defers.
 * Model-driven card progress (a NEW tool label, a foreground sub-agent nested
 * render, a draft update) additionally resets the clock via the existing
 * `noteProduction` sites; this stamp is the floor beneath them.
 *
 * No-op when the kill switch is on or the key has no live turn.
 */
export function noteCardRender(key: string, now: number): void {
  const s = state.get(key)
  if (s == null) return
  s.lastCardRenderAt = now
}

/**
 * Record a `thinking` session event. Used to pick "still thinking…" vs
 * "still working…" wording for the 300s framework fallback.
 */
export function noteThinking(key: string, now: number): void {
  const s = state.get(key)
  if (s == null) return
  s.lastThinkingAt = now
}

/**
 * #1292: record the start of a tool call. Stored in `inFlightTools` keyed
 * by `toolUseId` so a later `noteToolEnd` can drain the entry. Read only
 * by `tick()` when the 300s fallback fires, where we snapshot the map
 * into the fallback context so the user-visible message can name the
 * actual observable (e.g. "running Grep \"foo\" for 4m") instead of the
 * dishonest generic "still working… no update in 5 min".
 *
 * Idempotent: calling twice with the same toolUseId overwrites — useful
 * when a late `noteToolLabel` arrives but the caller wants to reuse the
 * start-side API. The `startedAt` is updated; for label-only refreshes
 * use `noteToolLabel` instead so duration stays correct.
 *
 * No-op when the kill switch is on (state Map will be empty for this key).
 */
export function noteToolStart(
  key: string,
  toolUseId: string,
  name: string,
  label: string | null,
  now: number,
): void {
  const s = state.get(key)
  if (s == null) return
  s.inFlightTools.set(toolUseId, { name, startedAt: now, label })
  // #3519: arm the background-bash defer on the first Bash of the turn.
  // A foreground Bash can be auto-moved to the background by the claude CLI
  // once it crosses the foreground window; its tool_result then returns
  // (draining inFlightTools) while the process keeps running and the model
  // goes silent waiting on it. That gap is invisible to every other "still
  // working" signal, so without this the 300s fallback tore down the pinned
  // card mid-work and the next burst minted a fresh one (stacked cards).
  if (name === 'Bash') s.sawBashThisTurn = true
}

/**
 * #1292: record completion of a tool call. Removes the entry from
 * `inFlightTools`. Idempotent — calling on an unknown toolUseId is a
 * no-op. Sub-second tools that start and end inside one poll interval
 * are still safe because the map is only read inside `tick()` at the
 * 300s fallback boundary; the churn never gets observed.
 */
export function noteToolEnd(
  key: string,
  toolUseId: string,
  _now: number,
): void {
  const s = state.get(key)
  if (s == null) return
  s.inFlightTools.delete(toolUseId)
}

/**
 * #1292: late label update for an in-flight tool. The tool-label sidecar
 * (PreToolUse hook, polled every 250ms via `tool-label-sidecar.ts`) can
 * publish a richer label some time after the `tool_use` event landed.
 * When that arrives, refresh the entry in-place so the fallback message
 * — if it fires later — picks up the better label.
 *
 * No-op when the toolUseId isn't tracked (e.g. tool already completed,
 * or the start event was skipped because the tool is a Telegram surface).
 */
export function noteToolLabel(
  key: string,
  toolUseId: string,
  label: string,
): void {
  const s = state.get(key)
  if (s == null) return
  const entry = s.inFlightTools.get(toolUseId)
  if (entry == null) return
  entry.label = label
}

/** End a turn — drop state. Idempotent. */
export function endTurn(key: string): void {
  state.delete(key)
}

/**
 * Current silence duration (ms) for a key — `now - (lastOutboundAt ??
 * turnStartedAt)`, the same clock `tick()` uses to decide the 300s fallback —
 * or null when no turn state exists for the key. Lets the sibling-topic purge
 * distinguish a STALE/wedged sibling (silent ≥ the fallback threshold, so its
 * own poke would also fire) from a LIVE one mid-turn (recent outbound, low
 * silence), so a silence-poke on one supergroup topic doesn't purge a live
 * sibling topic's reaction controller + typing loop. NB: this is silence, NOT
 * turn-start age — a long but actively-narrating turn has low silence and must
 * not be treated as stale.
 */
export function silenceMsForKey(key: string, now: number): number | null {
  const s = state.get(key)
  if (s == null) return null
  return now - (s.lastOutboundAt ?? s.turnStartedAt)
}

/**
 * Framework-fallback text for the 300s silence threshold. Returns `null` for
 * the pure-stall cases (the "still working / still thinking" / "running <Tool>
 * for Nm" notice) — that timer-fired stall ping was a stop-gap from before the
 * live-updating reply/draft carried the progress beats natively, and the
 * operator has retired it (it's the exact cadence-based "still working" update
 * the conversational-pacing RFC's Anti-patterns section bans). The 300s
 * fallback's surviving job — unwedging a turn that produced no output at all —
 * is the gateway's turn-teardown after this call, NOT a user-visible message,
 * so dropping the stall send keeps the safety net's real work intact (see
 * `reference/rfcs/conversational-pacing.md` § Silence-poke fallback).
 *
 * The ONE case that still returns a string is `blockedOnApproval`: the turn is
 * parked on an approval card waiting for YOUR tap. That is not a stall — it
 * tells the user the ball is in their court — so it keeps pinging.
 *
 * Extracted from the gateway's `onFrameworkFallback` callback so the wording
 * can be snapshot-tested in isolation. CC-4 in `docs/status-ask-cause-classes.md`.
 */
export function formatFrameworkFallbackText(
  fallbackKind: 'working' | 'thinking',
  silenceMs: number,
  inFlightTools: ToolSnapshot[] = [],
  blockedOnApproval = false,
): string | null {
  const minutes = Math.max(1, Math.round(silenceMs / 60_000))
  // The turn isn't stalled — it's parked on an approval card waiting for YOUR
  // tap (the dominant live "wedge" class is benign approval-latency, not a
  // hang). Saying "still working…" here actively lies; name the real blocker so
  // the operator knows the ball is in their court. Takes precedence over the
  // in-flight-tool framing (a tool awaiting approval isn't "running"). This is
  // the only branch that still emits a user-visible message.
  if (blockedOnApproval) {
    return `waiting for your approval — tap Approve or Deny on the card above (${minutes} min)`
  }
  // Stop-gap retired: the "still working… (no update from agent in N min)" /
  // "running <Tool> for Nm" stall notice (including the #1292 tool-aware
  // enrichment) no longer sends. The live draft + the model's own pacing beats
  // carry progress; a timer-fired stall ping on top of that is the banned
  // cadence-based update. `fallbackKind` and `inFlightTools` are now unused for
  // the stall path but kept on the signature so the gateway's call sites — and
  // the deterministic update-status / unwedge paths around them — are untouched.
  void fallbackKind
  void inFlightTools
  return null
}

/**
 * #3551 — inputs to the silence-fallback TEARDOWN NOTICE decision.
 *
 * Distinct from `formatFrameworkFallbackText`, which answers "is anything
 * happening worth narrating?" (and, since the stall-notice was retired,
 * answers `null` on every branch but `blockedOnApproval`). This one answers a
 * different, terminal question: "the framework is about to END this live turn
 * — does the user need to be told?"
 */
export interface FallbackTeardownNoticeInput {
  /** This fire is genuinely tearing down a live turn for THIS chat/thread.
   *  False on the multi-chat case where the current turn belongs elsewhere, or
   *  when there was no turn left to end. */
  tearsDownLiveTurn: boolean
  /** Loop role of the turn being torn down; null when unknown. */
  role: LoopRole | null
  /** A final answer already landed on this turn. */
  finalAnswerDelivered: boolean
  /** This fire ALREADY DELIVERED a LOUD, user-addressed message about why
   *  nothing is happening — in practice the approval re-ping ("waiting for your
   *  approval — tap Approve or Deny"). Never stack a second message on that.
   *
   *  #3551 L1: deliberately NARROWER than "some text went out". The other text
   *  this fire can emit is `formatUpdateStatusLine`, a SILENT status surface
   *  about an unrelated in-flight `update_apply` that says nothing about this
   *  turn ending — a user who asked a question during an update and got killed
   *  anyway is exactly the case this notice exists for, so that line must NOT
   *  suppress it.
   *  #3551 L2: means DELIVERED, not "attempted". The caller's send is wrapped in
   *  a log-only try/catch, so a throwing re-ping must not buy silence. */
  userAddressedTextDelivered: boolean
  /** The obligation ledger is on, so the killed turn's unanswered inbound will
   *  be re-presented. Governs the tail sentence — never claim a re-ask that
   *  cannot happen. */
  representWillFollow: boolean
  silenceMs: number
}

export type FallbackTeardownNoticeDecision =
  | {
      send: false
      reason:
        | 'user-addressed-text-delivered'
        | 'no-live-turn-torn-down'
        | 'non-user-turn'
        | 'answer-already-delivered'
    }
  | { send: true; text: string }

/**
 * #3551 — decide whether a silence-poke fire that ENDS a live turn must say so.
 *
 * The bug this closes: on the non-approval branch the 300s fallback delivered
 * NO text (`formatFrameworkFallbackText` returns null) while still tearing the
 * turn down and redelivering buffered inbound. From the user's seat: five
 * minutes of nothing, then the agent inexplicably restarting the same request,
 * with no signal that the framework — not the agent — made that happen.
 * Measured: 110 fires / 14 days, p50 silence 302s, ~9h of dead air.
 *
 * The fix is NOT to stop killing the turn. The teardown is the fallback's one
 * genuinely load-bearing job (`#1122`: without it every later inbound queues
 * behind a dead turn forever), and removing it would trade a silent turn for a
 * permanently wedged conversation. The fix is to make the kill OBSERVABLE.
 *
 * This is deliberately NOT a re-introduction of the retired stall notice, and
 * the gates below are what keep it that way:
 *   - `userAddressedTextDelivered` — never stack on a delivered approval
 *     re-ping. Narrow by design: a SILENT, unrelated update-status line does
 *     not buy silence here (#3551 L1), and an approval re-ping that threw on
 *     send does not either (#3551 L2).
 *   - `tearsDownLiveTurn` — a late-fire against an already-dead key says nothing.
 *   - `role !== 'user'` — a cron/system turn's silence is legitimate; nobody is
 *     waiting, so its teardown is housekeeping, not news.
 *   - `finalAnswerDelivered` — the user already has their answer; ending the
 *     residual housekeeping turn is invisible to them and needs no notice.
 * What remains is exactly one case: a HUMAN asked something, got nothing for
 * N minutes, and the framework just ended that attempt. That is a terminal
 * event, fired at most once per turn (the caller drops the key immediately
 * after), not a cadence-based progress ping — the thing
 * `reference/rfcs/conversational-pacing.md` § Anti-patterns bans.
 */
export function decideFallbackTeardownNotice(
  input: FallbackTeardownNoticeInput,
): FallbackTeardownNoticeDecision {
  if (input.userAddressedTextDelivered)
    return { send: false, reason: 'user-addressed-text-delivered' }
  if (!input.tearsDownLiveTurn) return { send: false, reason: 'no-live-turn-torn-down' }
  if (input.role !== 'user') return { send: false, reason: 'non-user-turn' }
  if (input.finalAnswerDelivered) return { send: false, reason: 'answer-already-delivered' }
  const minutes = Math.max(1, Math.round(input.silenceMs / 60_000))
  const tail = input.representWillFollow
    ? 'Your message is still tracked and is being re-asked now.'
    : 'Your message was not answered — please re-send it.'
  return {
    send: true,
    text: `⚠️ no output for ${minutes} min — the framework ended that stalled turn. ${tail}`,
  }
}

/**
 * #2995 — the LONGEST-running in-flight tool for a turn key, or null when
 * none is tracked. Read-only accessor over `inFlightTools` for the
 * mid-flight busy-ack: the gateway needs the blocking step's name/label
 * and its age to decide whether (and how) to ack a buffered mid-turn
 * inbound. Does not touch the silence clock.
 */
export function longestInFlightTool(key: string, now: number): ToolSnapshot | null {
  const s = state.get(key)
  if (s == null) return null
  const snaps = snapshotInFlight(s, now)
  return snaps.length > 0 ? snaps[0]! : null
}

/** Snapshot in-flight tools sorted longest-running first — for the honest
 *  floor/fallback message body. */
function snapshotInFlight(s: SilencePokeState, now: number): ToolSnapshot[] {
  return Array.from(s.inFlightTools.values())
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => ({ name: t.name, label: t.label, durationMs: now - t.startedAt }))
}

/**
 * #2527 — evaluate and (if eligible) fire the mid-turn liveness floor for one
 * turn. silence-poke owns the timing/working/fire-once half; the gateway
 * provides the role + delivery half via `floorState`; the pure
 * `decideMidTurnFloor` combines them so the policy lives in one tested place.
 * `forced=true` is a user "Status?" poke (bypasses timing + working).
 */
function tryMidTurnFloor(key: string, s: SilencePokeState, now: number, forced: boolean): void {
  if (activeDeps == null) return
  const { onMidTurnFloor, floorState, isLegitimatelyWorking } = activeDeps
  if (onMidTurnFloor == null || floorState == null) return
  const thresholds = activeDeps.thresholdsMs ?? DEFAULT_THRESHOLDS
  if (thresholds.floor == null) return
  const fs = floorState(key)
  if (fs == null) return
  const silence = now - (s.lastOutboundAt ?? s.turnStartedAt)
  if (silence < 0) return
  const decision = decideMidTurnFloor({
    enabled: midTurnFloorEnabled(),
    role: fs.role,
    finalAnswerDelivered: fs.finalAnswerDelivered,
    silenceMs: silence,
    floorThresholdMs: thresholds.floor,
    fallbackThresholdMs: thresholds.fallback,
    legitimatelyWorking: isLegitimatelyWorking?.(key) ?? false,
    alreadyFired: s.floorFired,
    force: forced,
  })
  if (decision.kind !== 'fire') {
    // Per-tick skips are noise; only surface a declined FORCED poke (the
    // user asked "Status?" and we chose not to speak — worth seeing).
    if (forced) {
      activeDeps.emitMetric({ kind: 'mid_turn_floor', key, silence_ms: silence, forced, decision: decision.reason })
    }
    return
  }
  s.floorFired = true
  activeDeps.emitMetric({ kind: 'mid_turn_floor', key, silence_ms: silence, forced, decision: 'fire' })
  const { chatId, threadId } = parseKey(key)
  try {
    const r = onMidTurnFloor({ key, chatId, threadId, silenceMs: silence, inFlightTools: snapshotInFlight(s, now), forced })
    if (r != null && typeof (r as Promise<void>).catch === 'function') {
      ;(r as Promise<void>).catch((err) => {
        process.stderr.write(`silence-poke: mid-turn floor handler rejected: ${err}\n`)
      })
    }
  } catch (err) {
    process.stderr.write(`silence-poke: mid-turn floor handler threw: ${err}\n`)
  }
}

/**
 * #2527 — fire the mid-turn floor immediately for `key` (a user "Status?"
 * mid-turn inbound landed during a silent stretch). No-op if there is no
 * live turn for the key or the floor is ineligible/already-fired.
 */
export function pokeFloorNow(key: string, now: number): void {
  const s = state.get(key)
  if (s == null) return
  tryMidTurnFloor(key, s, now, true)
}

/**
 * Internal tick — iterates active states and fires the 300s framework
 * fallback (which the gateway turns into a user-visible message + an
 * unwedge). Exported as __tickForTests so the suite can step the clock
 * deterministically.
 */
function tick(now: number): void {
  if (activeDeps == null) return
  const thresholds = activeDeps.thresholdsMs ?? DEFAULT_THRESHOLDS
  for (const [key, s] of state.entries()) {
    const zeroAt = s.lastOutboundAt ?? s.turnStartedAt
    const silence = now - zeroAt
    if (silence < 0) continue

    // #3552 — orphan reap. Drop per-turn state the moment its turn is provably
    // over, instead of leaving it armed until the 300s fallback fires against a
    // dead key and disarms it as a "late fire". Deterministic and path-agnostic:
    // it does not matter WHICH turn-end path forgot to call `endTurn`, the state
    // cannot outlive the turn by more than one poll interval. Same predicate as
    // the fallback's late-fire guard, so a mid-turn buffer-gate release (the
    // normal post-final-answer state, turn still live) is never reaped.
    if (activeDeps.isTurnLive != null && !activeDeps.isTurnLive(key)) {
      state.delete(key)
      activeDeps.emitMetric({ kind: 'silence_poke_orphan_reaped', key, silence_ms: silence })
      continue
    }

    // #2527 — the early, quiet mid-turn liveness beat (below the fallback
    // window). Evaluated every tick; fires at most once per turn.
    tryMidTurnFloor(key, s, now, false)

    if (!s.fallbackFired && silence >= thresholds.fallback) {
      // Feed-survival defer: hold back the unwedge while the agent is
      // demonstrably working — an in-flight tool, a detached background process,
      // or a human-wait tool (ask_user). Since #2162 the live activity feed
      // renders that work, so nulling currentTurn would darken a feed the user
      // is actively watching. Bounded by fallbackHardCeiling so a
      // hung-or-leaked-signal turn still unwedges eventually.
      //
      // Two defer paths (tried in priority order):
      //   1. `isLegitimatelyWorking(key)` — new single source of truth covering
      //      foreground in-flight tools, detached background work, and human-wait
      //      tools. Active by default when the callback is wired; force-disabled
      //      by SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=0.
      //   2. Legacy `deferFallbackWhileToolInFlight` boolean — covers only
      //      `inFlightTools.size > 0`; kept for test fixtures that set it
      //      directly without wiring the callback.
      //   3. #3519 `sawBashThisTurn` — covers the claude-CLI-side background
      //      bash gap the two paths above are blind to (foreground Bash moved
      //      to background: tool_result returned, process still running, model
      //      silent). Independent of the callback so it holds even when
      //      `isLegitimatelyWorking()` returns false.
      //
      // In all cases: `continue` WITHOUT setting fallbackFired so the next
      // tick re-checks. Once the work signal clears and the turn stays silent
      // past the base threshold, or the ceiling is crossed, the fallback fires.
      const ceiling = thresholds.fallbackHardCeiling ?? Number.POSITIVE_INFINITY
      const underCeiling = silence < ceiling
      if (underCeiling) {
        // #4058 — mid-turn auto-compaction: the CLI is summarizing the
        // session, so the model provably CANNOT produce output or tool
        // events; the silence is healthy, not a wedge. Defer exactly like
        // the in-flight-tool paths below (clock untouched, fallbackFired
        // unset, re-checked next tick) and stay bounded by the same hard
        // ceiling via the enclosing `underCeiling` guard. Deliberately NOT
        // gated by SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=0 — that flag
        // scopes the TOOL defers; compaction has no tool in flight.
        if (activeDeps.isCompactionInFlight?.(key) === true) continue
        // #4330 — the pinned activity card is visibly updating. A card render
        // (open or edit) landed on Telegram within CARD_RENDER_FRESH_MS, so
        // the user is watching a live "→ Working… · Nm · N tools" surface —
        // the "silent to the user" premise does not hold, and tearing the
        // turn down would kill the very card they are watching, then re-ask
        // their message under it. DEFER (clock untouched, fallbackFired
        // unset, re-checked next tick), bounded by the enclosing
        // `underCeiling` guard: the heartbeat climb keeps a hung turn's card
        // moving on pure wall clock, so a truly wedged turn still unwedges at
        // the hard ceiling. Like the #4058 compaction defer, deliberately NOT
        // gated by SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=0 — that flag
        // scopes the TOOL defers; a card render is not a tool signal.
        if (
          s.lastCardRenderAt != null &&
          now - s.lastCardRenderAt < CARD_RENDER_FRESH_MS
        ) continue
        const forceDisable = process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS === '0'
        if (!forceDisable && activeDeps.isLegitimatelyWorking != null) {
          if (activeDeps.isLegitimatelyWorking(key)) continue
          // #3519 sharpen: even when the callback reports "not working", a
          // `Bash` earlier this turn may have been auto-moved to the CLI-side
          // background (its tool_result returned, so every foreground /
          // async-dispatch signal is false, yet the process is alive and the
          // model sits silent on it) — the gap `isLegitimatelyWorking` is
          // blind to by construction. Two-layer defer, sharp then safe:
          //
          //   (1) PROVEN-alive — a background shell registered from its
          //       structured `backgroundTaskId` launch marker and not yet
          //       reported dead (`<task-notification>` completed / KillShell).
          //       A process is running RIGHT NOW, so defer. When it finishes,
          //       the alive-set empties and the fallback fires at ~300s —
          //       restoring fast wedge recovery the coarse guard held to 900s.
          if (s.aliveShells.size > 0) continue
          //   (2) SAFE DEGRADATION — only while the CLI markers have NEVER
          //       parsed (`!bgMarkerParserConfirmed`): we cannot then tell a
          //       live auto-backgrounded bash from a finished one, so fall
          //       back to the coarse turn-scoped `sawBashThisTurn` guard —
          //       900s-bounded by `fallbackHardCeiling` (never stacks, never
          //       hangs). Once ANY marker has parsed, the CLI is proven
          //       compatible, this layer switches off, and layer (1) alone
          //       governs. Scoped to the modern callback-wired path so the
          //       legacy defer-off / defer-bool fixtures keep their semantics.
          if (!bgMarkerParserConfirmed && s.sawBashThisTurn) continue
        } else if (!forceDisable && activeDeps.deferFallbackWhileToolInFlight === true && s.inFlightTools.size > 0) {
          continue
        }
      }
      s.fallbackFired = true
      const { chatId, threadId } = parseKey(key)
      const recentThinking = s.lastThinkingAt != null
        && (now - s.lastThinkingAt) < 30_000
      const fallbackKind: 'working' | 'thinking' = recentThinking ? 'thinking' : 'working'
      // #1292: snapshot in-flight tools at fire time, sorted by
      // startedAt ascending so entry[0] is the longest-running.
      // Pre-computed durations in ms; the formatter just renders.
      const inFlightTools: ToolSnapshot[] = Array.from(s.inFlightTools.values())
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(t => ({
          name: t.name,
          label: t.label,
          durationMs: now - t.startedAt,
        }))
      activeDeps.emitMetric({
        kind: 'silence_fallback_sent',
        key,
        fallback_kind: fallbackKind,
        silence_ms: silence,
      })
      // Caller may throw or fail — guard so a busted fallback doesn't kill the timer.
      try {
        const r = activeDeps.onFrameworkFallback({
          key,
          chatId,
          threadId,
          fallbackKind,
          silenceMs: silence,
          inFlightTools,
        })
        if (r != null && typeof (r as Promise<void>).catch === 'function') {
          ;(r as Promise<void>).catch((err) => {
            process.stderr.write(
              `silence-poke: framework fallback handler rejected: ${err}\n`,
            )
          })
        }
      } catch (err) {
        process.stderr.write(
          `silence-poke: framework fallback handler threw: ${err}\n`,
        )
      }
    }
  }
}

/**
 * Parse `<chatId>:<threadIdOrEmpty>` back into structured fields. Matches
 * the `statusKey` shape used throughout the gateway.
 */
function parseKey(key: string): { chatId: string; threadId: number | null } {
  const idx = key.indexOf(':')
  if (idx < 0) return { chatId: key, threadId: null }
  const chatId = key.slice(0, idx)
  const tail = key.slice(idx + 1)
  if (tail === '' || tail === 'undefined') return { chatId, threadId: null }
  const n = Number(tail)
  return { chatId, threadId: Number.isFinite(n) ? n : null }
}

/**
 * Start the timer. Idempotent — second call is a no-op. Stash deps so
 * tick() can find them. Honours the kill switch.
 */
export function startTimer(deps: SilencePokeDeps): void {
  if (!silencePokeEnabled()) return
  if (timer != null) return
  activeDeps = deps
  const poll = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  timer = setInterval(() => tick(Date.now()), poll)
  if (typeof timer.unref === 'function') timer.unref()
}

/** Stop the timer. Idempotent. */
export function stopTimer(): void {
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
  activeDeps = null
}

/** Test-only: drive a single tick at a deterministic clock value. */
export function __tickForTests(now: number): void {
  tick(now)
}

/** Test-only: install deps without starting the real timer. */
export function __setDepsForTests(deps: SilencePokeDeps | null): void {
  activeDeps = deps
}

/** Test-only: peek at state. */
export function __getStateForTests(key: string): SilencePokeState | undefined {
  return state.get(key)
}

/** Test-only: full reset. */
export function __resetAllForTests(): void {
  state.clear()
  stopTimer()
  bgMarkerParserConfirmed = false
}

/** Test-only: peek at the process-scoped #3519 safe-degradation latch. */
export function __bgMarkerParserConfirmedForTests(): boolean {
  return bgMarkerParserConfirmed
}
