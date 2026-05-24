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
 *                                  " — still working (Nm)"
 *   inbound user message        → clear (user re-engaged or moved on)
 *   subagent_handback inject    → clear (model about to re-engage)
 *   MAX_LIFETIME_MS budget cap  → clear (give up; 30 min default)
 *
 * Single shared timer for the whole gateway — like silence-poke's
 * `tick()`, the per-key cost is O(map size) per poll. The poll
 * interval is short (5s) but edits are spaced at EDIT_INTERVAL_MS so
 * the Telegram bot.api editMessageText rate stays well under limits.
 *
 * Edits preserve the anchor's original `parse_mode` (issue #1698). The
 * anchor was sent through the reply tool, which defaults to HTML; an
 * earlier version of this module dropped parse_mode on edit, which made
 * the next "still working (Nm)" tick re-render `<b>` / `<code>` tags as
 * literal text. The suffix itself is plain text (no `<`/`>`/`&`) so it
 * is safe under any parse_mode. On subsequent edits the prior suffix is
 * stripped before re-appending so the message never accumulates duplicate
 * suffixes.
 *
 * Kill switch: `SWITCHROOM_DISABLE_PENDING_PROGRESS=1` disables the
 * whole subsystem. The conversational-pacing prompt is unaffected.
 */

export const EDIT_INTERVAL_MS = 60_000
export const POLL_INTERVAL_MS = 5_000
export const MAX_LIFETIME_MS = 30 * 60_000
/** Telegram message length limit is 4096; budget headroom for the
 *  suffix and any escape expansion. If the anchor text plus suffix
 *  would exceed this, we skip the edit (the user still sees the
 *  original) rather than truncate the model's authored prose. */
export const TELEGRAM_MSG_CAP = 4000

/**
 * Regex matching the suffix we append. Used to strip a prior suffix
 * before appending the next one. The (\d+) covers "1m" / "12m" / etc.
 * Kept anchored to end-of-string so it only matches OUR suffix, not
 * something the model happened to write.
 */
const SUFFIX_RE = /\n\n— still working \(\d+m\)$/

export interface PendingProgressEditCtx {
  chatId: string
  threadId: number | null
  messageId: number
  newText: string
  /** Telegram parse_mode the original anchor was sent with (#1698).
   *  The edit must use the same mode or pre-rendered HTML / MarkdownV2
   *  tags in `anchorOriginalText` re-render as literal text. */
  parseMode: 'HTML' | 'MarkdownV2' | undefined
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
}

interface State {
  /** True after a `tool_use(Agent|Task)` was observed for this key in
   *  the current turn. Cleared on next turn start. */
  pending: boolean
  /** The captured anchor — last outbound reply message_id for this
   *  key. */
  anchorMessageId: number | null
  /** The captured anchor text — what the model wrote, *minus* any
   *  prior pending-progress suffix. Used as the base for every edit. */
  anchorOriginalText: string
  /** parse_mode the anchor was originally sent with. Edits must
   *  reuse this or the rendered HTML / MarkdownV2 tags in
   *  anchorOriginalText render as literal text on the next tick
   *  (issue #1698). */
  anchorParseMode: 'HTML' | 'MarkdownV2' | undefined
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
      anchorMessageId: null,
      anchorOriginalText: '',
      anchorParseMode: undefined,
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
  s.anchorMessageId = null
  s.anchorOriginalText = ''
  s.anchorParseMode = undefined
}

/**
 * Mark this chat as having dispatched async background work in the
 * current turn. Idempotent. Called when the gateway sees a `tool_use`
 * for `Agent` or `Task`.
 */
export function noteAsyncDispatch(key: string): void {
  if (!enabled()) return
  ensure(key).pending = true
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
    /** parse_mode the anchor was sent with. Captured so the
     *  cross-turn edit tick can reuse it (#1698). Undefined or
     *  omitted means the original send had no parse_mode (plain
     *  text). Production callers MUST pass this — every reply path
     *  knows its own parse_mode. Defaulted to undefined only so test
     *  fixtures don't have to thread it through where they're
     *  asserting other behaviour. */
    parseMode?: 'HTML' | 'MarkdownV2' | undefined
  },
): void {
  if (!enabled()) return
  const s = ensure(key)
  s.anchorMessageId = opts.messageId
  s.anchorOriginalText = opts.text.replace(SUFFIX_RE, '')
  s.anchorParseMode = opts.parseMode
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
 * Clear pending-progress for a chat — reasons:
 *   'inbound'   — user sent a new message, they're re-engaged
 *   'handback'  — switchroom injected a subagent_handback channel turn
 *   'timeout'   — exceeded MAX_LIFETIME_MS
 *   'manual'    — test / debug
 */
export function clearPending(
  key: string,
  reason: 'inbound' | 'handback' | 'timeout' | 'manual',
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

    const sinceEdit = s.lastEditAt == null ? 0 : now - s.lastEditAt
    if (sinceEdit < EDIT_INTERVAL_MS) continue

    // Build suffix from elapsed wall-clock. Always at least 1m so the
    // user-visible counter reads honestly (we only edit at intervals
    // ≥ EDIT_INTERVAL_MS = 60s).
    const minutes = Math.max(1, Math.round(elapsed / 60_000))
    const suffix = `\n\n— still working (${minutes}m)`
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
      parseMode: s.anchorParseMode,
    }
    // Fire-and-forget so a slow edit doesn't block the tick loop.
    // Errors are logged but never bubble (a 429 / "message not modified"
    // / chat-deleted is a soft failure).
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
        process.stderr.write(
          `pending-work-progress: edit failed key=${key} ` +
            `msg=${editCtx.messageId}: ${(err as Error).message}\n`,
        )
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
