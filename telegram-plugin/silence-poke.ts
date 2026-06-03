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
 * `reference/conversational-pacing.md` § Safety net.
 *
 * What remains: ONE silence clock and ONE terminal action.
 *
 *   silence clock = now - lastOutboundAt   (or turnStartedAt if no outbound yet)
 *
 * Outbound = a fresh `reply` or `stream_reply` first-emit. Reactions,
 * edits, and tool churn DO NOT reset the silence clock — the model could
 * be ripping through 20 tool calls and still be "silent" to the user.
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

export type SilencePokeMetric =
  | { kind: 'silence_fallback_sent'; key: string; fallback_kind: 'working' | 'thinking'; silence_ms: number }

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
 * Verbatim framework-fallback text — the user-visible "still working / still
 * thinking" message the gateway sends at the 300s threshold when the model
 * hasn't broken its own silence. Wording is load-bearing (see
 * `reference/conversational-pacing.md` § Safety net). Two principles:
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
  blockedOnApproval = false,
): string {
  const minutes = Math.max(1, Math.round(silenceMs / 60_000))
  // The turn isn't stalled — it's parked on an approval card waiting for YOUR
  // tap (the dominant live "wedge" class is benign approval-latency, not a
  // hang). Saying "still working…" here actively lies; name the real blocker so
  // the operator knows the ball is in their court. Takes precedence over the
  // in-flight-tool framing (a tool awaiting approval isn't "running").
  if (blockedOnApproval) {
    return `waiting for your approval — tap Approve or Deny on the card above (${minutes} min)`
  }
  const suffix = `(no update from agent in ${minutes} min)`
  // #1292 case (a): tools in flight. Name the longest-running one
  // (entry[0] — caller pre-sorts by startedAt ascending). Avoid the
  // "still working" framing #1292 explicitly calls out as dishonest:
  // the agent IS doing work, we can see the tool. Format:
  //   running Grep "foo" for 4m (no update from agent in 5 min)
  //   running Grep "foo" + 2 more (4m) (no update from agent in 5 min)
  //   running Grep (no label) for 4m (no update from agent in 5 min)
  //
  // Raw MCP tool names (`mcp__server__tool`) are technical identifiers
  // and look like a leak when surfaced to a user. When the tool name
  // matches that shape AND a human-friendly label is available, drop
  // the raw name and lead with the label instead:
  //   Searching memory for 4m (no update from agent in 5 min)
  // Built-in tool names (Grep, Read, Bash) stay as-is — they ARE
  // human-readable, and the label is supplementary detail (e.g. the
  // search pattern) that reads naturally after the verb.
  if (inFlightTools.length > 0) {
    const longest = inFlightTools[0]!
    const dur = formatDurationShort(longest.durationMs)
    const labelTail = longest.label && longest.label.length > 0
      ? ` ${truncateLabel(longest.label)}`
      : ''
    const more = inFlightTools.length > 1
      ? ` + ${inFlightTools.length - 1} more`
      : ''
    const isMcpRawName = /^mcp__/.test(longest.name)
    if (isMcpRawName && labelTail !== '') {
      // Label-only: "Searching memory for 4m (…)". Drop the raw
      // `mcp__server__tool` and the leading "running" because the
      // label already reads as a gerund phrase.
      return `${truncateLabel(longest.label!)}${more} for ${dur} ${suffix}`
    }
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

    if (!s.fallbackFired && silence >= thresholds.fallback) {
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
