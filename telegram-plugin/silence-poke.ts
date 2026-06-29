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
}

const state = new Map<string, SilencePokeState>()
let timer: ReturnType<typeof setInterval> | null = null
let activeDeps: SilencePokeDeps | null = null

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
  })
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
      //
      // In both cases: `continue` WITHOUT setting fallbackFired so the next
      // tick re-checks. Once the work signal clears and the turn stays silent
      // past the base threshold, or the ceiling is crossed, the fallback fires.
      const ceiling = thresholds.fallbackHardCeiling ?? Number.POSITIVE_INFINITY
      const underCeiling = silence < ceiling
      if (underCeiling) {
        const forceDisable = process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS === '0'
        if (!forceDisable && activeDeps.isLegitimatelyWorking != null) {
          if (activeDeps.isLegitimatelyWorking(key)) continue
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
}
