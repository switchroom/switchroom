/**
 * silence-poke.ts — framework safety net for "model is silent to the user."
 *
 * Background (issue #1122): we're moving away from a pinned progress card
 * to a conversational shape where the chat itself is the artifact. The
 * progress card was implicitly doing one useful job — covering for a
 * model that doesn't know how to say "still working." This module is the
 * explicit replacement: when the model has been silent past a threshold,
 * we nudge it (or, as a last resort, send a framework message ourselves).
 *
 * Two clocks (this module owns ONE of them; the other is the legacy
 * idle stall in status-reactions.ts and is unrelated):
 *
 *   silence clock = now - lastOutboundAt   (or turnStartedAt if no outbound yet)
 *
 * Outbound = a fresh `reply` or `stream_reply` first-emit. Reactions,
 * edits, and tool churn DO NOT reset the silence clock — that's the
 * whole point. The model could be ripping through 20 tool calls and
 * still be "silent" to the user.
 *
 * Escalation ladder per turn:
 *
 *   t=0       startTurn() — silence clock starts at turnStartedAt
 *   t=75s     soft poke armed — appended to next tool result as a
 *             <system-reminder> nudging the model to send an update
 *   t=180s    firm poke armed (stronger wording) if no outbound landed
 *   t=300s    framework fallback: gateway itself sends a user-visible
 *             "still working… / still thinking…" message. Fires at most
 *             once per turn. Pings the device (user needs to know).
 *
 * Subagent-dispatch override: when the model dispatches a sub-agent
 * (`Task(...)`, `@worker` etc), the soft threshold extends to 300s for
 * that turn — the model is legitimately waiting on a child, no point
 * poking it to narrate the wait. Firm/fallback thresholds unchanged.
 *
 * Wired into the gateway at the central tool-result chokepoint
 * (`gateway.ts:onToolCall`) so the poke text piggybacks the next tool
 * result back to claude. MCP doesn't allow mid-generation injection;
 * tool results are the only synchronous moment we own the wire.
 *
 * Kill switch: SWITCHROOM_DISABLE_SILENCE_POKE=1 disables the whole
 * subsystem (no timers, no injection, no fallback). The conversational
 * pacing prompt still applies; only the framework safety net is off.
 */

export type PokeLevel = 'soft' | 'firm'

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
  /** 0 = none, 1 = soft fired, 2 = firm fired, 3 = fallback fired. */
  pokesFired: 0 | 1 | 2 | 3
  /** Armed pending drain on the next tool result, or null. */
  pokeArmed: { level: PokeLevel } | null
  /** When true, soft threshold extends to subagentSoft (default 300s). */
  subagentDispatchActive: boolean
  /** Wall-clock ms of last `thinking` session event, or null. */
  lastThinkingAt: number | null
  /** True once the 300s framework fallback has fired this turn. */
  fallbackFired: boolean
  /** Wall-clock ms of last poke fire — used for poke-success latency. */
  lastPokeFiredAt: number | null
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
  soft: number
  firm: number
  fallback: number
  /** Soft threshold when subagentDispatchActive=true. */
  subagentSoft: number
  /** How long after a poke we still count an outbound as a "success." */
  pokeSuccessWindowMs: number
}

export const DEFAULT_THRESHOLDS: ThresholdsMs = {
  soft: 75_000,
  firm: 180_000,
  fallback: 300_000,
  subagentSoft: 300_000,
  pokeSuccessWindowMs: 15_000,
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

export type SilencePokeMetric =
  | { kind: 'silence_poke_fired'; key: string; level: PokeLevel; silence_ms: number; subagent_wait: boolean }
  | { kind: 'silence_poke_succeeded'; key: string; level: PokeLevel; latency_ms: number }
  | { kind: 'silence_fallback_sent'; key: string; fallback_kind: 'working' | 'thinking'; silence_ms: number }

export interface SilencePokeDeps {
  /** Called when the 300s fallback fires. Caller sends the user-visible
   *  message + ensures it pings the device. Caller must NOT call back
   *  into noteOutbound for this — it's a framework-sourced message,
   *  not a model-sourced one, and we want pokes to continue (well, no,
   *  fallbackFired ensures only one per turn anyway). */
  onFrameworkFallback: (ctx: FrameworkFallbackContext) => Promise<void> | void
  /** Telemetry sink for poke events. */
  emitMetric: (event: SilencePokeMetric) => void
  /** Threshold overrides (tests). */
  thresholdsMs?: ThresholdsMs
  /** Poll interval (tests). */
  pollIntervalMs?: number
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
    pokesFired: 0,
    pokeArmed: null,
    subagentDispatchActive: false,
    lastThinkingAt: null,
    fallbackFired: false,
    lastPokeFiredAt: null,
    inFlightTools: new Map(),
  })
}

/**
 * Record a fresh user-visible outbound message (reply or stream_reply
 * first-emit). Resets the silence clock + the escalation counter. If a
 * poke fired recently, emit a `silence_poke_succeeded` metric.
 */
export function noteOutbound(key: string, now: number): void {
  const s = state.get(key)
  if (s == null) return
  // Success measurement: if a poke fired within the success window and
  // an outbound just landed, count it as a successful poke.
  const thresholds = activeDeps?.thresholdsMs ?? DEFAULT_THRESHOLDS
  if (
    s.lastPokeFiredAt != null
    && (now - s.lastPokeFiredAt) <= thresholds.pokeSuccessWindowMs
    && activeDeps != null
    && s.pokesFired >= 1
    && s.pokesFired <= 2
  ) {
    activeDeps.emitMetric({
      kind: 'silence_poke_succeeded',
      key,
      level: s.pokesFired === 1 ? 'soft' : 'firm',
      latency_ms: now - s.lastPokeFiredAt,
    })
  }
  s.lastOutboundAt = now
  s.pokesFired = 0
  s.pokeArmed = null
  // Intentionally DO NOT clear `subagentDispatchActive` here. The
  // model's `reply` narrating the dispatch ("spinning up @reviewer")
  // is itself the outbound that resets the silence clock — clearing
  // the flag would defeat the extended-threshold guarantee for the
  // wait that follows. The flag persists until endTurn(). Fixes the
  // non-blocking note from PR2 review (#1125).
  s.lastPokeFiredAt = null
  s.fallbackFired = false
}

/**
 * Note that the model dispatched a sub-agent (Task tool, @worker, etc).
 * Extends the soft threshold for THIS turn. The flag persists until
 * endTurn() — subsequent outbound messages within the turn keep the
 * extended threshold, which is the correct shape for the dispatch
 * narrate → wait → child-result → summarise sequence.
 */
export function noteSubagentDispatch(key: string): void {
  const s = state.get(key)
  if (s == null) return
  s.subagentDispatchActive = true
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

/**
 * Drain any armed poke for ANY active turn and return the system-reminder
 * text to append. Returns null if nothing is armed.
 *
 * Called at the gateway's tool-result chokepoint; the appended reminder
 * piggybacks the result back to claude. Drains the flag immediately so
 * the next tool result doesn't double-inject.
 *
 * Iterates all keys because the tool result doesn't carry which turn it
 * belongs to. In practice the gateway has ≤1 active turn at a time, but
 * the code handles multi-turn correctly: each turn's poke text is
 * appended once (and never appears in another turn's tool result, since
 * we drain by mutating the matched state).
 */
export function consumeArmedPoke(): string | null {
  for (const s of state.values()) {
    if (s.pokeArmed != null) {
      const level = s.pokeArmed.level
      s.pokeArmed = null
      return formatPokeText(level)
    }
  }
  return null
}

/** End a turn — drop state. Idempotent. */
export function endTurn(key: string): void {
  state.delete(key)
}

/** Verbatim poke text. Wording is load-bearing — see issue #1122 design. */
export function formatPokeText(level: PokeLevel): string {
  if (level === 'soft') {
    return (
      "[silence-poke] You've been silent to the user for 75s. If you're "
      + "still working on this, send one short conversational reply — e.g. "
      + "\"still going, working through X\" — so they know you're alive. "
      + "Keep it brief; don't restate the task. If you're about to finish "
      + 'within the next few seconds, skip the update.'
    )
  }
  return (
    "[silence-poke] 3 minutes silent. Please send an update now — what "
    + "you're working on, or whether you're stuck. If something is taking "
    + 'unusually long (slow tool, network, waiting on a sub-agent), say so '
    + 'explicitly.'
  )
}

/**
 * Verbatim framework-fallback text — the user-visible "still working / still
 * thinking" message the gateway sends at the 300s threshold when the model
 * hasn't broken its own silence. Wording is load-bearing (see
 * `reference/conversational-pacing.md` § Silence-poke ladder). Two principles:
 *
 *   1. The parenthetical `(no update from agent in N min)` is honest —
 *      distinguishes from "the agent said something" so users learn to trust
 *      real agent messages. `N` is derived from `silenceMs`, never hard-coded.
 *   2. The verb is `working` by default, `thinking` only when the session
 *      stream has emitted a `kind: 'thinking'` event in the last 30s. Picked
 *      by the caller via `fallbackKind`; this helper just formats.
 *
 * Extracted from the gateway's `onFrameworkFallback` callback so the wording
 * can be snapshot-tested in isolation. CC-4 in `docs/status-ask-cause-classes.md`.
 */
export function formatFrameworkFallbackText(
  fallbackKind: 'working' | 'thinking',
  silenceMs: number,
  inFlightTools: ToolSnapshot[] = [],
): string {
  const minutes = Math.max(1, Math.round(silenceMs / 60_000))
  const suffix = `(no update from agent in ${minutes} min)`
  // #1292 case (a): tools in flight. Name the longest-running one
  // (entry[0] — caller pre-sorts by startedAt ascending). Avoid the
  // "still working" framing #1292 explicitly calls out as dishonest:
  // the agent IS doing work, we can see the tool. Format:
  //   running Grep "foo" for 4m (no update from agent in 5 min)
  //   running Grep "foo" + 2 more (4m) (no update from agent in 5 min)
  //   running Grep (no label) for 4m (no update from agent in 5 min)
  if (inFlightTools.length > 0) {
    const longest = inFlightTools[0]!
    const dur = formatDurationShort(longest.durationMs)
    const labelTail = longest.label && longest.label.length > 0
      ? ` ${truncateLabel(longest.label)}`
      : ''
    const more = inFlightTools.length > 1
      ? ` + ${inFlightTools.length - 1} more`
      : ''
    return `running ${longest.name}${labelTail}${more} for ${dur} ${suffix}`
  }
  return fallbackKind === 'thinking'
    ? `still thinking… ${suffix}`
    : `still working… ${suffix}`
}

/** Compact m/s rendering for the fallback message. Anything under a
 *  minute reads as `${s}s`, otherwise `${m}m`. Always rounds toward the
 *  user-honest direction — "4m" for 4m 30s, "5m" for 4m 45s. */
function formatDurationShort(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const minutes = Math.round(totalSec / 60)
  return `${minutes}m`
}

/** Telegram lines are short on mobile. Clip the label to keep the
 *  fallback message readable. Truncation point is generous (60 chars)
 *  because tool labels are pre-truncated by `toolLabel()` already. */
function truncateLabel(label: string): string {
  const MAX = 60
  if (label.length <= MAX) return label
  return label.slice(0, MAX - 1) + '…'
}

/**
 * Internal tick — iterates active states, arms pokes or fires fallback.
 * Exported as __tickForTests so suite can step the clock deterministically.
 */
function tick(now: number): void {
  if (activeDeps == null) return
  const thresholds = activeDeps.thresholdsMs ?? DEFAULT_THRESHOLDS
  for (const [key, s] of state.entries()) {
    const zeroAt = s.lastOutboundAt ?? s.turnStartedAt
    const silence = now - zeroAt
    if (silence < 0) continue
    const softThreshold = s.subagentDispatchActive
      ? thresholds.subagentSoft
      : thresholds.soft

    if (s.pokesFired === 0 && silence >= softThreshold) {
      s.pokeArmed = { level: 'soft' }
      s.pokesFired = 1
      s.lastPokeFiredAt = now
      activeDeps.emitMetric({
        kind: 'silence_poke_fired',
        key,
        level: 'soft',
        silence_ms: silence,
        subagent_wait: s.subagentDispatchActive,
      })
      continue
    }

    if (s.pokesFired === 1 && silence >= thresholds.firm) {
      s.pokeArmed = { level: 'firm' }
      s.pokesFired = 2
      s.lastPokeFiredAt = now
      activeDeps.emitMetric({
        kind: 'silence_poke_fired',
        key,
        level: 'firm',
        silence_ms: silence,
        subagent_wait: s.subagentDispatchActive,
      })
      continue
    }

    if (s.pokesFired === 2 && !s.fallbackFired && silence >= thresholds.fallback) {
      s.fallbackFired = true
      s.pokesFired = 3
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
