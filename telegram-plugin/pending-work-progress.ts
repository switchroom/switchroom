/**
 * Cross-turn pending-async progress — issue #1445.
 *
 * When a turn ends with pending background async work (the model
 * dispatched `Agent` / `Task` and ended its turn before the worker
 * returned), keep editing the model's last reply *in place* at
 * intervals so the user sees ambient liveness during the wait — without
 * any new pinged messages and without re-introducing the retired
 * progress card.
 *
 * Background data justifying this module (2026-05-23 forensic + UAT):
 *
 * - silence-poke success rate is 0–7% across hundreds of fires
 *   (finn: 0/78, clerk: 6/91, klanker: 5/158) — the polite levels
 *   reach the model as `<system-reminder>`s piggybacked on the next
 *   tool result, so they (a) only land if the model is actively
 *   cycling tools, (b) compete with hundreds of other tokens, and (c)
 *   only ever exist while the turn is open. The 300s framework
 *   fallback is the only user-visible silence-poke output, and its
 *   first job is to *kill the wedged turn*.
 *
 * - The dominant user-visible failure mode (issue #1445) is in fact
 *   cross-turn: the model calls `Agent` (or `Bash` with
 *   `run_in_background:true`), sends one ack reply that pings, then
 *   ends the turn. The silence-poke ladder is *gone* the moment
 *   endTurn() fires. The user then sees nothing for 10–30+ minutes
 *   until the worker returns. A live UAT confirmed: a deliberate
 *   `sleep 350` prompt produced one `[PING] Background sleep running;
 *   awaiting completion notification.` at +19s and the turn ended.
 *
 * Mechanism:
 *
 *   tool_use(Agent|Task)        → mark chat key `pending=true`
 *   outbound reply              → capture anchor (messageId, text)
 *   turn_end with pending+anchor → activate the timer for the key
 *   tick (every 5s, edit every  → editMessageText against the anchor
 *     EDIT_INTERVAL_MS)            appending/refreshing the suffix
 *                                  " — still working (Nm) · message me
 *                                  anytime, I'll keep you posted"
 *                                  (the reachability clause signals the
 *                                  agent is still listening while a
 *                                  background worker runs — issue PR3)
 *   inbound user message        → clear (user re-engaged or moved on)
 *   subagent_handback inject    → clear (model about to re-engage)
 *   MAX_LIFETIME_MS budget cap  → clear (give up; 30 min default)
 *
 * Single shared timer for the whole gateway — like silence-poke's
 * `tick()`, the per-key cost is O(map size) per poll. The poll
 * interval is short (5s) but edits are spaced at EDIT_INTERVAL_MS so
 * the Telegram bot.api editMessageText rate stays well under limits.
 *
 * Edits preserve the anchor's original send shape — rich-markdown vs the
 * literal `format:'text'` path (#2669, successor to the #1698 parse-mode
 * contract). The anchor was sent through the reply tool, which defaults to
 * the rich-markdown path; the edit re-sends via the SAME path so the
 * anchor body keeps rendering the way it first did. On subsequent edits
 * the prior suffix is stripped before re-appending so the message never
 * accumulates duplicate suffixes.
 *
 * Kill switch: `SWITCHROOM_DISABLE_PENDING_PROGRESS=1` disables the
 * whole subsystem. The conversational-pacing prompt is unaffected.
 */

export const EDIT_INTERVAL_MS = 60_000
export const POLL_INTERVAL_MS = 5_000
export const MAX_LIFETIME_MS = 30 * 60_000
/**
 * TTL bounding how long an in-flight background dispatch (Agent/Task) suppresses
 * the idle auto-/clear gate (#3117). Deliberately tied to `MAX_LIFETIME_MS` (the
 * cross-turn ambient budget cap): the two express the same "how long do we
 * believe a background worker is still legitimately running" budget, so keeping
 * them equal means the idle-suppression window and the ambient-liveness window
 * agree by construction. A SHORTER idle TTL would risk clobbering a legitimate
 * ~25-min worker mid-flight; a LONGER one would weaken the self-healing bound
 * (a leaked `pending=true` that never clears would disable idle-clear for
 * longer). 30 min is the deliberate midpoint the design settled on. The gate
 * suppresses only while `dispatch age < this`; past it the suppression lapses so
 * a stuck flag can never disable idle-clear permanently. */
export const BACKGROUND_WORK_SUPPRESS_TTL_MS = MAX_LIFETIME_MS
/** Rich-message wire cap is 32768 (#2669); budget headroom for the
 *  suffix and any escape expansion. If the anchor text plus suffix
 *  would exceed this, we skip the edit (the user still sees the
 *  original) rather than truncate the model's authored prose. */
export const TELEGRAM_MSG_CAP = 32768

/**
 * Regex matching the suffix we append. Used to strip a prior suffix
 * before appending the next one. The (\d+) covers "1m" / "12m" / etc.
 * The reachability clause is optional so anchors carrying a pre-v0.14.30
 * suffix (no clause) are still stripped during a rolling upgrade. Both the
 * legacy em-dash prefix (`— still working`) and the rich-markdown italic
 * form (`_still working … _`, #2669) are matched so a rolling upgrade
 * strips either. Kept anchored to end-of-string so it only matches OUR
 * suffix, not something the model happened to write.
 */
const SUFFIX_RE =
  /\n\n(?:— |_)still working \(\d+m\)( · message me anytime, I'll keep you posted)?_?$/

export interface PendingProgressEditCtx {
  chatId: string
  threadId: number | null
  messageId: number
  newText: string
  /** True when the original anchor was a literal `format:'text'` send
   *  (plain `sendMessage`, no rich-message wrapper). The edit must match:
   *  a rich anchor re-edits via `editMessageText({ markdown })`, a literal
   *  anchor re-edits as a plain string (#2669 single-rich-path migration of
   *  the #1698 parse-mode-preservation contract). */
  literalText: boolean
}

/**
 * Discriminated union — kept structurally identical to the
 * `pending_progress_*` variants in `runtime-metrics.ts:RuntimeMetricEvent`
 * so the gateway's `emitMetric: emitRuntimeMetric` wire-up typechecks
 * cleanly with no cast. `started` carries only the chat key; `edited`
 * always carries the cumulative elapsed time; `cleared` carries an
 * optional elapsed + the reason (`inbound` | `handback` | `timeout` |
 * `manual`).
 */
export type PendingProgressMetric =
  | { kind: 'pending_progress_started'; chatKey: string }
  | { kind: 'pending_progress_edited'; chatKey: string; elapsedMs: number }
  | {
      kind: 'pending_progress_cleared'
      chatKey: string
      elapsedMs?: number
      reason?: string
    }

export interface PendingProgressDeps {
  editMessage: (ctx: PendingProgressEditCtx) => Promise<void>
  emitMetric?: (event: PendingProgressMetric) => void
  /** Optional clock override for tests. */
  nowMs?: () => number
  /** Optional poll interval override for tests. */
  pollIntervalMs?: number
  /**
   * Defense-in-depth (#1760). When provided, returns the gateway's
   * `activeTurnStartedAt` epoch ms for this chat key, or undefined if no
   * turn is currently active. The ticker uses this on every fire to detect
   * a stale ambient: if a NEWER turn has started (epoch > our activatedAt)
   * the prior turn's cross-turn pending-progress is by definition orphaned
   * (the turn_end teardown was missed, e.g. SDK event dropped) and the
   * ticker self-terminates instead of editing a stale anchor. Converts the
   * #1760 failure mode from "stuck forever" to "at most one stale tick."
   *
   * Defaults to undefined — preserves prior behaviour for tests that
   * exercise the ticker without a gateway.
   */
  isActiveTurnNewerThan?: (key: string, activatedAt: number) => boolean
}

interface State {
  /** True after a `tool_use(Agent|Task)` was observed for this key in
   *  the current turn. Cleared on next turn start. */
  pending: boolean
  /** Epoch ms when `pending` was last set true (#3117). null when not
   *  pending. Load-bearing for the idle-clear suppression TTL: without a
   *  timestamp the gate cannot bound how long an in-flight background dispatch
   *  holds off idle-clear, so a leaked `pending=true` would disable idle-clear
   *  forever. Re-stamped on each `noteAsyncDispatch` (a fresh dispatch re-arms
   *  the TTL) and cleared when `pending` is set false (`startTurn`); a full
   *  `clearPending` drops the whole entry, which is equivalent. */
  dispatchedAt: number | null
  /** The captured anchor — last outbound reply message_id for this
   *  key. */
  anchorMessageId: number | null
  /** The captured anchor text — what the model wrote, *minus* any
   *  prior pending-progress suffix. Used as the base for every edit. */
  anchorOriginalText: string
  /** True when the anchor was a literal `format:'text'` send. Edits must
   *  match the original send shape (rich vs literal) or the suffix re-edit
   *  changes how the anchor body renders (the #2669 single-rich-path
   *  successor to the #1698 parse-mode-preservation contract). */
  anchorLiteralText: boolean
  /** Wall-clock ms when the cross-turn ambient state was *activated*
   *  (at turn_end with pending+anchor). null before activation. */
  activatedAt: number | null
  /** Wall-clock ms of last edit fire — gates the EDIT_INTERVAL_MS
   *  cadence. null until first edit fires. */
  lastEditAt: number | null
}

const stateByKey = new Map<string, State>()
let timer: ReturnType<typeof setInterval> | null = null
let activeDeps: PendingProgressDeps | null = null

function enabled(): boolean {
  const v = process.env.SWITCHROOM_DISABLE_PENDING_PROGRESS
  return !(v === '1' || v === 'true')
}

function nowMs(): number {
  return activeDeps?.nowMs ? activeDeps.nowMs() : Date.now()
}

function ensure(key: string): State {
  let s = stateByKey.get(key)
  if (!s) {
    s = {
      pending: false,
      dispatchedAt: null,
      anchorMessageId: null,
      anchorOriginalText: '',
      anchorLiteralText: false,
      activatedAt: null,
      lastEditAt: null,
    }
    stateByKey.set(key, s)
  }
  return s
}

/**
 * Fresh turn — reset the per-turn `pending` flag and the per-turn
 * anchor. The cross-turn `activated` state is per-PRIOR-turn and is
 * cleared by the explicit clear paths (`clearPending` with reason
 * `inbound` / `handback` / `timeout`), not by a new turn. The gateway
 * wires those clears at TWO sites for full coverage:
 *
 *   1. `handleInbound` (real user message) → `clearPending('inbound')`
 *      — the fast path; fires the moment the gateway sees an inbound,
 *      before the new turn atom is even built.
 *   2. `handleSessionEvent` `enqueue` case (every fresh turn atom)
 *      → `clearPending('handback')` — the backstop covering
 *      synthesised wakes (subagent-handback, cron, vault grant,
 *      restart marker) that push directly to `pendingInboundBuffer`
 *      and bypass `handleInbound`. Idempotent w/r/t the first clear.
 *
 * `startTurn` itself only matters if the state map already has an
 * entry for `key` — which post-fix is impossible (the clears
 * delete it). Kept for test ergonomics and as defence-in-depth.
 */
export function startTurn(key: string): void {
  if (!enabled()) return
  const s = stateByKey.get(key)
  if (s == null) return
  // Only the per-turn fields reset. activatedAt/lastEditAt belong to
  // the prior turn's pending-progress and are cleared separately.
  s.pending = false
  s.dispatchedAt = null
  s.anchorMessageId = null
  s.anchorOriginalText = ''
  s.anchorLiteralText = false
}

/**
 * Mark this chat as having dispatched async background work in the
 * current turn. Idempotent. Called when the gateway sees a `tool_use`
 * for `Agent` or `Task`.
 */
export function noteAsyncDispatch(key: string): void {
  if (!enabled()) return
  const s = ensure(key)
  s.pending = true
  // Stamp (and re-stamp) the dispatch epoch so the idle-clear suppression TTL
  // (#3117) can bound how long this holds off /clear. Re-stamping on each
  // dispatch means a fresh Agent/Task within the same wait re-arms the TTL —
  // freshest legitimate work wins.
  s.dispatchedAt = nowMs()
}

/**
 * Capture an outbound reply as a candidate anchor for cross-turn
 * editing. Called on every successful bot reply send. If a prior
 * pending-progress suffix is present in the text (rare — should only
 * happen if we sent something to ourselves), strip it before storing
 * so subsequent edits don't double-suffix.
 */
export function noteOutbound(
  key: string,
  opts: {
    messageId: number
    text: string
    /** True when the anchor was a literal `format:'text'` send. Captured
     *  so the cross-turn edit tick re-edits with the same shape (#2669
     *  single-rich-path successor to the #1698 parse-mode contract).
     *  Omitted ⇒ false (the rich-markdown default). */
    literalText?: boolean
  },
): void {
  if (!enabled()) return
  const s = ensure(key)
  s.anchorMessageId = opts.messageId
  s.anchorOriginalText = opts.text.replace(SUFFIX_RE, '')
  s.anchorLiteralText = opts.literalText ?? false
}

/**
 * Called at turn_end. If the turn had a pending async dispatch AND
 * captured an anchor, activate the cross-turn ambient state — the
 * timer will start editing.
 *
 * If pending=false OR no anchor was captured, drop the state entry
 * entirely (nothing for us to do).
 */
export function noteTurnEnd(key: string): void {
  if (!enabled()) return
  const s = stateByKey.get(key)
  if (s == null) return
  if (s.pending && s.anchorMessageId != null) {
    s.activatedAt = nowMs()
    // lastEditAt is null so the first edit fires after one full
    // EDIT_INTERVAL_MS from activation — not immediately.
    s.lastEditAt = s.activatedAt
    activeDeps?.emitMetric?.({
      kind: 'pending_progress_started',
      chatKey: key,
    })
  } else {
    stateByKey.delete(key)
  }
}

/**
 * True when the current turn for `key` dispatched async background work
 * (Agent / Task / Bash run_in_background:true) but the turn has not yet ended
 * with a cleared pending flag.  Used by the feed-survival predicate so the
 * orphaned-reply backstop and silence-poke teardown are deferred while a
 * detached background process is still running — even after inFlight empties
 * when the near-instant tool_result (e.g. the Bash background handle) returns.
 */
export function hasPendingAsyncDispatch(key: string): boolean {
  return stateByKey.get(key)?.pending === true
}

/**
 * Age in ms since the current pending async dispatch was stamped for `key`
 * (#3117), or null if there is no pending dispatch (or, defensively, no
 * timestamp — a pre-stamp entry from a rolling upgrade). Uses the same clock
 * override as the rest of the module so tests drive it deterministically.
 */
export function asyncDispatchAgeMs(key: string): number | null {
  const s = stateByKey.get(key)
  if (s == null || s.pending !== true || s.dispatchedAt == null) return null
  return nowMs() - s.dispatchedAt
}

/**
 * True iff ANY chat key currently has a pending async dispatch whose age is
 * within `ttlMs` (#3117). The idle auto-/clear gate is agent-wide (not scoped
 * to a single chat key), so it consults this aggregate: while a background
 * sub-agent is in flight AND fresh, suppress the clear; once every pending
 * dispatch has aged past the TTL (a leaked/stuck flag), the suppression lapses
 * and idle-clear self-heals. A non-positive `ttlMs` disables suppression.
 */
export function anyPendingAsyncDispatchWithin(ttlMs: number): boolean {
  if (ttlMs <= 0) return false
  const now = nowMs()
  for (const s of stateByKey.values()) {
    if (
      s.pending === true &&
      s.dispatchedAt != null &&
      now - s.dispatchedAt < ttlMs
    ) {
      return true
    }
  }
  return false
}

/**
 * Clear pending-progress for a chat — reasons:
 *   'inbound'   — user sent a new message, they're re-engaged
 *   'handback'  — switchroom injected a subagent_handback channel turn
 *   'progress'  — switchroom injected a subagent_progress channel turn
 *                 (#1720) — the model is about to compose an explicit
 *                 in-voice reply about the worker's status, so the
 *                 ambient "— still working (Nm)" edit should yield
 *   'timeout'   — exceeded MAX_LIFETIME_MS
 *   'manual'    — test / debug
 */
export function clearPending(
  key: string,
  reason:
    | 'inbound'
    | 'handback'
    | 'progress'
    | 'timeout'
    | 'manual'
    | 'reply_finalize'
    | 'stale_turn',
): void {
  if (!stateByKey.has(key)) return
  const s = stateByKey.get(key)!
  const elapsed = s.activatedAt != null ? nowMs() - s.activatedAt : 0
  stateByKey.delete(key)
  activeDeps?.emitMetric?.({
    kind: 'pending_progress_cleared',
    chatKey: key,
    elapsedMs: elapsed,
    reason,
  })
}

/**
 * Start the shared interval timer. Idempotent. Honours the kill
 * switch — no-op when disabled.
 */
export function startTimer(deps: PendingProgressDeps): void {
  if (!enabled()) return
  if (timer != null) return
  activeDeps = deps
  const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS
  timer = setInterval(() => tick(nowMs()), interval)
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

/**
 * Parse `<chatId>:<threadIdOrEmpty>` back into structured fields,
 * matching the `statusKey` shape used throughout the gateway.
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

function tick(now: number): void {
  if (activeDeps == null) return
  for (const [key, s] of stateByKey.entries()) {
    if (s.activatedAt == null || s.anchorMessageId == null) continue

    const elapsed = now - s.activatedAt
    if (elapsed >= MAX_LIFETIME_MS) {
      clearPending(key, 'timeout')
      continue
    }

    // #1760 defense-in-depth: if a newer turn is currently active for
    // this chat, the prior turn's cross-turn pending-progress is stale
    // (the canonical teardown — turn_end or the next turn's reply-
    // finalize — was missed). Drop the timer instead of editing the
    // old anchor; the new turn will manage its own anchor via the
    // regular noteOutbound / noteTurnEnd path. Converts "stuck forever"
    // (the live #1760 evidence) into "at most one stale tick."
    if (
      activeDeps.isActiveTurnNewerThan != null
      && activeDeps.isActiveTurnNewerThan(key, s.activatedAt)
    ) {
      clearPending(key, 'stale_turn')
      continue
    }

    const sinceEdit = s.lastEditAt == null ? 0 : now - s.lastEditAt
    if (sinceEdit < EDIT_INTERVAL_MS) continue

    // Build suffix from elapsed wall-clock. Always at least 1m so the
    // user-visible counter reads honestly (we only edit at intervals
    // ≥ EDIT_INTERVAL_MS = 60s).
    const minutes = Math.max(1, Math.round(elapsed / 60_000))
    const suffix = `\n\n_still working (${minutes}m) · message me anytime, I'll keep you posted_`
    const newText = s.anchorOriginalText + suffix

    if (newText.length > TELEGRAM_MSG_CAP) {
      // Don't truncate the model's prose — just skip this edit.
      // The previous edit (or the original) is still visible.
      s.lastEditAt = now
      continue
    }

    const { chatId, threadId } = parseKey(key)
    s.lastEditAt = now

    const editCtx: PendingProgressEditCtx = {
      chatId,
      threadId,
      messageId: s.anchorMessageId,
      newText,
      literalText: s.anchorLiteralText,
    }
    // Fire-and-forget so a slow edit doesn't block the tick loop. The
    // production `editMessage` dep is `swallowingApiCall`-wrapped, which
    // catches every transport outcome (not-modified / not-found / 429 /
    // network) upstream and never rejects — so in production this `.catch`
    // is a backstop that rarely fires. It is kept as a contract-level guard
    // (a throwing dep, or a future non-swallowing wiring, must not log a
    // scary "edit failed" warning for a best-effort liveness surface nor
    // keep hammering a dead anchor). Only a genuinely unexpected error
    // reaches the fallthrough; transport classes are silent.
    void Promise.resolve()
      .then(() => activeDeps!.editMessage(editCtx))
      .then(() => {
        activeDeps!.emitMetric?.({
          kind: 'pending_progress_edited',
          chatKey: key,
          elapsedMs: elapsed,
        })
      })
      .catch((err) => {
        const desc =
          err instanceof Error ? err.message : err != null && typeof err === 'object' && 'description' in err
            ? String((err as { description?: unknown }).description)
            : String(err)
        const low = desc.toLowerCase()
        // "message is not modified" — the anchor already shows this suffix.
        // The card is correct; count it as an edit and move on silently.
        if (low.includes('not modified')) {
          activeDeps!.emitMetric?.({
            kind: 'pending_progress_edited',
            chatKey: key,
            elapsedMs: elapsed,
          })
          return
        }
        // Message / chat gone, or the 48h edit window closed. The anchor
        // is dead — stop retrying it (clear state) so the tick isn't
        // hammering a non-existent message every EDIT_INTERVAL_MS. The
        // next outbound reply re-establishes a fresh anchor. Silent: no
        // card to update is not a liveness-logic error.
        if (
          low.includes('not found') ||
          low.includes("can't be edited") ||
          low.includes('cannot be edited') ||
          low.includes('not enough rights')
        ) {
          clearPending(key, 'stale_turn')
          return
        }
        // 429 / transient network blip — leave state intact; the next tick
        // retries. No stderr: a transport hiccup on a best-effort card is
        // not a logic error, and the production wiring already applies
        // retry_after backoff upstream.
      })
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────

/** Test-only: drive one tick deterministically. */
export function __tickForTests(now: number): void {
  tick(now)
}

/** Test-only: install deps without starting the real timer. */
export function __setDepsForTests(deps: PendingProgressDeps | null): void {
  activeDeps = deps
}

/** Test-only: peek at per-key state. */
export function __getStateForTests(key: string): State | undefined {
  return stateByKey.get(key)
}

/** Test-only: full reset. */
export function __resetAllForTests(): void {
  stateByKey.clear()
  stopTimer()
}
