/**
 * Live worker-activity feed — a regular chat message that edits in place
 * while a *background* sub-agent (Agent/Task `run_in_background: true`)
 * runs, then finalizes when the worker completes.
 *
 * Why this exists: the pinned progress card was deleted (#1126) and the
 * "Chat is the artifact" principle bars re-adding card chrome. But a
 * background worker decouples from the parent turn — when the parent's
 * turn ends, nothing surfaces the worker's ongoing jsonl activity, so a
 * long worker reads as silence (the exact gap an operator hit watching a
 * dispatched worker go quiet). This module surfaces that activity the
 * same way the main agent's live answer does: a normal Telegram message
 * that grows/edits as work happens — indistinguishable from "the agent
 * is typing live", not a status widget.
 *
 * COALESCED (#3084 follow-up): all live workers dispatched to the SAME
 * chat/thread render into ONE shared message (a {@link FeedGroup}), not one
 * message each. With N workers, N separate messages each coalesce their own
 * edit stream but ALL draw from the send gate's 1/sec per-chat bucket — so
 * ~N-1 of every second's edits SHED and every card refreshes only ~once per N
 * seconds (liveness collapse). One combined message = ONE per-message edit
 * stream: it coalesces (last-write-wins) and never contends with siblings, so
 * every worker's row refreshes together within the ~1.5s edit floor. A single-
 * worker chat still renders the full 🛠 Worker card (identical to before); a
 * 2+ worker chat renders `renderCombinedWorkerFeed`.
 *
 * Pure render (`renderWorkerActivity` / `renderCombinedWorkerFeed`) + an
 * injected bot API (`BotApiForWorkerFeed`). The manager
 * (`createWorkerActivityFeed`) owns one edit-in-place message per (chat,thread)
 * with:
 *   - a first-paint delay so trivial sub-second workers never post a
 *     message (their result still lands via the handback reply),
 *   - a proactive min-edit-interval throttle (worker jsonl ticks ~1/s;
 *     Telegram rate-limits edits) plus body-dedup,
 *   - per-message serialization so two rapid ticks can't double-send,
 *   - 429 cooldown + message_id drift resilience (re-post on stale edit),
 *   - a forced terminal edit on the LAST worker's `finish`.
 *
 * The completed-worker RESULT is NOT folded into this cosmetic feed — it
 * reaches the user as its own `useful` handback reply (gateway onFinish). The
 * feed shows only *live* work; a finished worker's row is dropped from the
 * combined body (or, when it is the last worker, the message finalizes to its
 * terminal recap).
 *
 * The feed is gated to BACKGROUND workers and is ON by default; set
 * `SWITCHROOM_WORKER_ACTIVITY_FEED=0` to disable it — see the gateway
 * wiring. The watcher already drives the cues (it polls the worker jsonl
 * directly, so it keeps firing after the parent turn ends), which is why
 * the feed is fed from watcher callbacks rather than the bridge event stream.
 */

import {
  cleanWorkerResultParagraph,
  stripMarkdown,
  truncate,
} from './card-format.js'
import { STATUS_ROLLING_LINES } from './status-no-truncate.js'
import {
  renderStatusCard,
  formatStepSuffix,
  renderCombinedWorkerFeed,
  type CombinedWorkerRow,
} from './tool-activity-summary.js'
import { isSendGateShed } from './send-gate.js'

/** Worker-activity feed is ON by default; an operator opts out with
 *  SWITCHROOM_WORKER_ACTIVITY_FEED=0. */
export function isWorkerActivityFeedEnabled(envVal: string | undefined): boolean {
  return envVal !== '0'
}

export type WorkerActivityState = 'running' | 'done' | 'failed'

/** The render-relevant snapshot of a worker at one instant. */
export interface WorkerActivityView {
  /** Dispatch-time task description (stable across the worker's life). */
  description: string
  /** Most recent tool the worker invoked, with a pre-sanitised arg. */
  lastTool: { name: string; sanitisedArg: string } | null
  /** Number of tool calls observed so far. */
  toolCount: number
  /** The worker's latest narrative line, if any (already capped upstream). */
  latestSummary: string
  /**
   * Accumulated narrative lines, oldest→newest, already deduped + capped by
   * the feed manager. When present and non-empty, the render grows a `✓`/`→`
   * step feed (prior steps done, newest in-progress — mirroring the main
   * agent's activity card) instead of collapsing to the single `latestSummary`
   * line. Absent/empty → the single-line fallback (back-compat for direct
   * render callers).
   */
  narrativeLines?: string[]
  /** Wall-clock since dispatch, ms. */
  elapsedMs: number
  state: WorkerActivityState
  /**
   * Live model the worker is running, as a raw resolved model id sourced from
   * its transcript (`message.model`) or, before its first assistant line, the
   * dispatch-time `tool_input.model` persisted on the registry row. Rendered as
   * a short friendly tag on the worker card's metrics line. Omitted when
   * unknown — never guessed from config.
   */
  model?: string
}

export interface BotApiForWorkerFeed {
  sendMessage(
    chatId: string,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>
}

/** Dispatch-time task description cap for the worker header. */
const DESC_MAX = 80

/**
 * Thin adapter over the unified `renderStatusCard` primitive (emoji 🛠, label
 * 'Worker'): builds the header, passes raw narrative steps (the primitive runs
 * stripMarkdown → collapse ws → clip → escape per line), and on finish passes
 * the cleaned result paragraph as the `result` block.
 *
 * Layout (running):
 *   🛠 <b>Worker</b> · <i>{description}</i>
 *   <i>{elapsed} · {n} tools</i>
 *   <s><i>✓ {earlier step}</i></s>
 *   <b>→ {newest step}</b>
 *
 * Layout (finished): the feed renders all-done, then a rule + cleaned result:
 *   🛠 <b>Worker</b> · <i>{description}</i>
 *   <i>done · {n} tools · {elapsed}</i>
 *   <s><i>✓ {step}</i></s>
 *   ─────
 *   ✅ <i>{cleaned result paragraph}</i>
 */
export function renderWorkerActivity(v: WorkerActivityView, liveSuffix = ''): string {
  const desc = truncate(stripMarkdown(v.description).trim() || 'background task', DESC_MAX)
  const finished = v.state === 'done' || v.state === 'failed'

  // Raw narrative steps (unstripped/unescaped) — the unified renderer runs the
  // full per-line pipeline (stripMarkdown → collapse ws → clip → escape).
  const rawSteps = (v.narrativeLines ?? []).filter((s) => s != null && s.trim().length > 0)

  // Back-compat for direct render callers that pass only latestSummary while
  // RUNNING; the manager always supplies narrativeLines. On the FINISHED path
  // latestSummary is the worker's RESULT (below), never a narrative step — so
  // the fallback only applies while running.
  let steps = rawSteps
  if (steps.length === 0 && !finished) {
    const summary = stripMarkdown(v.latestSummary).replace(/\s+/g, ' ').trim()
    if (summary.length > 0) steps = [v.latestSummary]
  }

  const header: Parameters<typeof renderStatusCard>[0]['header'] = {
    emoji: '🛠',
    label: 'Worker',
    description: desc,
    elapsedMs: v.elapsedMs,
    toolCount: v.toolCount,
    state: v.state,
    model: v.model,
  }

  // Terminal: latestSummary carries the worker's final result text (gateway
  // onFinish), distinct from the running narrative steps. Pass it as `result`.
  let result: { emoji: string; text: string } | undefined
  if (finished) {
    const text = cleanWorkerResultParagraph(v.latestSummary)
    if (text.length > 0) result = { emoji: v.state === 'done' ? '✅' : '⚠️', text }
  }

  // `renderStatusCard` always returns content when a header is supplied. When
  // running with no steps it shows just the header — append a "starting…" line
  // for parity with the prior behaviour.
  const card = renderStatusCard({
    header,
    steps,
    final: finished,
    liveSuffix: finished ? '' : liveSuffix,
    result,
  })
  if (card == null) {
    // Unreachable (header always present) — defensive.
    return `🛠 **Worker** · _starting…_`
  }
  if (!finished && steps.length === 0) {
    // Header-only running render → append the starting placeholder with a GFM
    // hard break (`  \n`) so it stacks under the header instead of collapsing
    // onto the header line in the rich-message renderer (matches stackCardLines).
    return `${card}  \n_starting…_`
  }
  return card
}

export interface WorkerActivityFeedOpts {
  bot: BotApiForWorkerFeed
  /** `Date.now` override for tests. */
  now?: () => number
  /**
   * Minimum ms between in-place edits to one worker's message. Worker
   * jsonl ticks roughly once per second; without this we'd burn through
   * Telegram's edit budget. Default 2500ms. First paint and the terminal
   * `finish` edit bypass it.
   */
  minEditIntervalMs?: number
  /**
   * A worker must have been running at least this long before its first
   * message is posted. Sub-second / trivial workers never surface a live
   * message — their result still reaches the user via the handback
   * reply, so a message would be pure noise. Default 8000ms.
   */
  firstPaintMinMs?: number
  /** stderr-style log sink. Defaults to noop. */
  log?: (msg: string) => void
  /**
   * Remaining ms of the currently-open per-bot flood window, read from the
   * SAME persisted marker the gateway's `robustApiCall` and held-card sweep
   * consult (`makeFloodWaitProbe(FLOOD_STATE_PATH)`). Two independent reads of
   * one source of truth — not a second notion of "is the channel open".
   *
   * Why the feed needs it (#3084 follow-up): the feed's send/edit adapters run
   * through the send gate, which SHEDS (resolves `undefined`) any call made
   * while a flood window is open. Without this probe the heartbeat re-fires a
   * shed send every `heartbeatTickMs` (~6s) for the WHOLE ban — thousands of
   * gate admissions, and (pre-fix) a `sent.message_id` crash on the `undefined`
   * every tick. With it, a running/first-paint tick that sees an open window
   * parks the group in cooldown for the window's remaining and makes ZERO api
   * calls until it closes, mirroring the held-card sweep's pre-send probe.
   * Defaults to `() => 0` (no window) so tests and non-gateway callers are
   * unchanged.
   */
  floodWaitRemainingMs?: () => number
  /**
   * Heartbeat timer factory. Injectable for tests. Defaults to the real
   * `setInterval`, `.unref()`'d so it never keeps the process alive.
   */
  setInterval?: (cb: () => void, ms: number) => unknown
  /** Heartbeat timer disposer. Injectable for tests. Defaults to `clearInterval`. */
  clearInterval?: (handle: unknown) => void
  /**
   * Heartbeat tick cadence in ms. On each tick a stale, running feed is
   * re-rendered with climbing elapsed so a worker that emits no new narrative
   * still visibly advances. Default 6000ms.
   */
  heartbeatTickMs?: number
  /**
   * Max worker rows rendered in a COMBINED feed (2+ workers in one chat/thread)
   * before the `+M more working…` spill line. Keeps the coalesced body compact
   * and legible (and under the rich-message wire ceiling). Default 8. A single-
   * worker chat renders the full 🛠 Worker card and ignores this. Sourced from
   * `channels.telegram.worker_feed.max_rows` via the config cascade.
   */
  maxRows?: number
}

/**
 * One live worker's per-row state inside a chat/thread feed group. The row
 * carries everything the render needs for THIS worker; the shared message
 * (id, cooldown, chain) lives on the enclosing {@link FeedGroup}.
 */
interface WorkerRow {
  /** jsonl agent id — carried so success/failure log lines can name the worker. */
  agentId: string
  /**
   * Accumulated narrative lines (oldest→newest), deduped within the whole
   * rolling window. Rolling-window capped to STATUS_ROLLING_LINES. Grows the
   * live render so the feed reads like the main agent's answer.
   */
  narrative: string[]
  /** Last view for this worker (drives the heartbeat re-render + combined row). */
  lastView: WorkerActivityView | null
  /** Latest state observed for this worker; excluded from the running set once
   *  terminal (its result reaches the user via the separate handback reply). */
  state: WorkerActivityState
  /**
   * Latched in `finish` before the terminal edit. A late watcher `onProgress`
   * tick that arrives after `finish()` queued its chain must NOT resurrect the
   * row and paint a fresh `running` state on an already-finalized worker.
   */
  finished: boolean
  /**
   * Wall-clock ms the worker was dispatched, derived from `now - view.elapsedMs`
   * on the first update. The heartbeat computes a live elapsed from this so the
   * elapsed climbs even when no fresh view arrives, and it fixes the worker's
   * stable sort order within the combined feed.
   */
  dispatchAtMs: number | null
  /**
   * Wall-clock ms the CURRENT step started — stamped whenever a NEW narrative
   * line lands (the `→` line changes). The heartbeat's step suffix shows the
   * step's OWN elapsed from this anchor (single-worker card only), and only
   * once past STEP_TIMER_MIN_MS.
   */
  stepStartedAtMs: number | null
}

/**
 * One shared feed message per (chatId, threadId). ALL live workers dispatched
 * to the same chat/thread render into this one message — so their edits form a
 * single per-message edit stream under the send gate's 1/sec per-chat ceiling
 * (last-write-wins coalescing + no-op skip) instead of N contending streams
 * that shed (#3084). A single-worker group renders the full 🛠 Worker card;
 * a 2+ worker group renders the combined `renderCombinedWorkerFeed` body.
 */
interface FeedGroup {
  /** Stable key `${chatId} ${threadId ?? ''}`. */
  feedKey: string
  chatId: string
  threadId?: number
  messageId: number | null
  lastBody: string | null
  lastEditAt: number
  cooldownUntil: number
  /** Single serialization chain for the shared message — ticks can't interleave sends. */
  chain: Promise<void>
  /** Live workers in this group, keyed by agentId (insertion ≈ dispatch order). */
  workers: Map<string, WorkerRow>
  /**
   * A terminal render (the last worker's recap) staged because a 429 cooldown /
   * flood window blocked the edit. The heartbeat re-drives it once the cooldown
   * expires so a finished feed can't get stuck on its last running render.
   * Null when no finalize is pending.
   */
  pendingFinalize: WorkerActivityView | null
}

const COOLDOWN_JITTER_MS = 500

function extractRetryAfterSecs(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null
  const e = err as { error_code?: unknown; parameters?: { retry_after?: unknown } }
  if (e.error_code !== 429) return null
  const ra = e.parameters?.retry_after
  if (typeof ra === 'number' && Number.isFinite(ra) && ra > 0) return ra
  return null
}

/**
 * Classify a card-edit transport error. Card edits are a best-effort
 * liveness surface — a recoverable hiccup must never freeze the card, and
 * a permanent failure must never log a scary warning for something with
 * nothing to update.
 *
 *   'not_modified' — content identical to what's already shown. The card
 *     already reads correctly; treat as SUCCESS (no retry, no warning).
 *   'rate_limited' — 429 with retry_after. Back off; the heartbeat re-drives
 *     the edit after cooldown (running renders + deferred terminal edits).
 *   'gone'         — message/chat deleted or edit window expired. Nothing to
 *     update; drop the message silently (no warning — there is no card).
 *   'transient'    — anything else (network blip, 5xx). Retry on the next
 *     heartbeat tick; don't spam stderr.
 */
type EditOutcome = 'not_modified' | 'rate_limited' | 'gone' | 'transient'
function classifyEditError(err: unknown): EditOutcome {
  const retryAfter = extractRetryAfterSecs(err)
  if (retryAfter != null) return 'rate_limited'
  const desc =
    err instanceof Error ? err.message : err != null && typeof err === 'object' && 'description' in err
      ? String((err as { description?: unknown }).description)
      : String(err)
  const low = desc.toLowerCase()
  // "message is not modified" / "message was not modified" — Telegram's
  // identical-content signal. The card already shows the right thing.
  if (low.includes('not modified')) return 'not_modified'
  // Message or chat no longer exists, or the edit window (48h) has closed.
  // "message to edit not found" / "message to delete not found" / "chat not
  // found" / "message can't be edited". Nothing to update.
  if (
    low.includes('not found') ||
    low.includes("can't be edited") ||
    low.includes('cannot be edited') ||
    low.includes('not enough rights')
  ) {
    return 'gone'
  }
  return 'transient'
}

/**
 * Manager owning one live message per (chat,thread) into which all live
 * workers there coalesce. Public methods stay keyed by jsonl agent id (the
 * gateway wiring is unchanged): the manager resolves the enclosing feed group
 * internally. The gateway calls `update` on each watcher activity cue and
 * `finish` on terminal; `drop` discards a worker's state without a final edit
 * (error / supersession paths).
 */
export interface WorkerActivityFeed {
  /** True if a message is currently posted for this worker's feed group. */
  has(agentId: string): boolean
  /** The Telegram message_id currently posted for this worker's feed group, or
   *  null if none is posted (never painted, or dropped after a stale-edit
   *  re-post). Lets the gateway pin the EXISTING `🛠 Worker` message. Note:
   *  siblings sharing the chat/thread return the SAME id (one message). */
  messageIdOf(agentId: string): number | null
  /** Push a running-state cue. Returns the serialized op for tests. */
  update(
    agentId: string,
    chatId: string,
    view: WorkerActivityView,
    threadId?: number,
  ): Promise<void>
  /** Finalize a worker: drop its row from the combined feed (its result reaches
   *  the user via the separate handback), or — when it is the last live worker
   *  in the group — force the terminal recap edit. No-op if the worker was
   *  never tracked. */
  finish(agentId: string, view: WorkerActivityView): Promise<void>
  /** Forget a worker's state without a recap edit (e.g. error path); re-renders
   *  the group so the dropped worker disappears from the combined body. */
  drop(agentId: string): void
  /**
   * Issue #3023 (card resurrection). Undo a finalization: clear the durable
   * `finalized` gate (and any lingering per-row `finished` latch) so a
   * worker whose card was FALSELY finalized can be painted/edited again. The
   * watcher calls this (via the gateway's `onResurrect` wiring) when a
   * falsely-finalized worker's JSONL resumes growing. A fresh `running` cue
   * after this repaints a live card — the operator invariant that active work
   * stays visible. Idempotent; a no-op if the worker was never finalized.
   */
  resurrect(agentId: string): void
  /** Clear the heartbeat interval (gateway shutdown). Idempotent. */
  stop(): void
  /** Manually fire one heartbeat tick (test hook). */
  heartbeatTick(): void
  /** Number of tracked workers across all feed groups (test/inspection hook). */
  readonly size: number
}

export function createWorkerActivityFeed(opts: WorkerActivityFeedOpts): WorkerActivityFeed {
  const log = opts.log ?? (() => {})
  const nowFn = opts.now ?? Date.now
  const floodWaitRemainingMs = opts.floodWaitRemainingMs ?? (() => 0)
  const minEditInterval = opts.minEditIntervalMs ?? 2500
  const firstPaintMin = opts.firstPaintMinMs ?? 8000
  const heartbeatTickMs = opts.heartbeatTickMs ?? 6000
  const maxRows = Math.max(1, Math.floor(opts.maxRows ?? 8))
  const setIntervalFn =
    opts.setInterval ??
    ((cb: () => void, ms: number): unknown => {
      const t = setInterval(cb, ms)
      // Never keep the process alive on the heartbeat alone.
      ;(t as { unref?: () => void }).unref?.()
      return t
    })
  const clearIntervalFn = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))

  /** Feed groups keyed by `${chatId} ${threadId ?? ''}`. */
  const groups = new Map<string, FeedGroup>()
  /** Reverse index agentId → feedKey, so the agentId-keyed public API resolves
   *  its group in O(1). Cleared when a worker's row is removed. */
  const agentIndex = new Map<string, string>()

  /**
   * Agent ids that have been finalized (`finish` latched). Survives row/group
   * deletion so a LATE watcher `onProgress` tick — which can arrive after
   * `finish()`'s chain has fully settled — cannot resurrect a fresh row and
   * paint a running card on a worker that is already done. A late tick arrives
   * within seconds of finish (watcher poll cadence), so the set only needs to
   * cover recent finalizations — capped at FINALIZED_CAP and trimmed FIFO to
   * stay bounded across a long gateway lifetime.
   */
  const finalized = new Set<string>()
  const FINALIZED_CAP = 256
  function markFinalized(agentId: string): void {
    if (finalized.has(agentId)) return
    finalized.add(agentId)
    if (finalized.size > FINALIZED_CAP) {
      const oldest = finalized.values().next().value
      if (oldest != null) finalized.delete(oldest)
    }
  }
  let heartbeatTimer: unknown = null

  function feedKeyOf(chatId: string, threadId?: number): string {
    return `${chatId} ${threadId ?? ''}`
  }
  function groupOfAgent(agentId: string): FeedGroup | undefined {
    const key = agentIndex.get(agentId)
    return key != null ? groups.get(key) : undefined
  }

  function sendOptsFor(g: FeedGroup): Record<string, unknown> {
    return {
      disable_web_page_preview: true,
      // Sub-agent progress feed is a status surface, never the user's answer —
      // silence the open ping. (editMessageText ignores disable_notification,
      // so this is a no-op on the in-place edits that share these opts.)
      disable_notification: true,
      ...(g.threadId != null ? { message_thread_id: g.threadId } : {}),
    }
  }

  function noteRateLimited(g: FeedGroup, err: unknown, label: string): void {
    const retryAfter = extractRetryAfterSecs(err)
    if (retryAfter == null) return
    g.cooldownUntil = nowFn() + retryAfter * 1000 + COOLDOWN_JITTER_MS
    log(`worker-feed: ${label} 429 — backing off ${retryAfter}s`)
  }

  /**
   * Park a group in cooldown for the remaining of an open flood window (if
   * any), so the heartbeat's `nowFn() < g.cooldownUntil` guard suppresses every
   * further send/edit until the ban closes. Returns true when a window was open
   * (caller should abandon the current attempt). Two reads of the SAME on-disk
   * marker `robustApiCall` gates on — never a second notion of "channel open".
   */
  function parkIfFloodWindowOpen(g: FeedGroup): boolean {
    const remaining = floodWaitRemainingMs()
    if (remaining <= 0) return false
    const until = nowFn() + remaining + COOLDOWN_JITTER_MS
    if (until > g.cooldownUntil) g.cooldownUntil = until
    return true
  }

  function accumulateNarrative(row: WorkerRow, view: WorkerActivityView): void {
    const line = view.latestSummary.trim()
    if (line.length === 0) return
    // Dedup within the whole rolling window (the watcher re-emits the same
    // narrative across ticks, and a preamble + its tool label can repeat
    // non-adjacently — the A,B,A duplication observed on live cards).
    if (row.narrative.includes(line)) return
    row.narrative.push(line)
    // The `→` current-step line just CHANGED — reset the per-step timer.
    row.stepStartedAtMs = nowFn()
    if (row.narrative.length > STATUS_ROLLING_LINES) {
      row.narrative.splice(0, row.narrative.length - STATUS_ROLLING_LINES)
    }
  }

  /** Live wall-clock elapsed for a worker (climbs between fresh views). */
  function liveElapsed(row: WorkerRow, now: number): number {
    const base = row.dispatchAtMs != null ? now - row.dispatchAtMs : row.lastView?.elapsedMs ?? 0
    return Math.max(base, row.lastView?.elapsedMs ?? 0)
  }

  /** The running rows of a group, dispatch-ordered (oldest first, stable). */
  function runningRows(g: FeedGroup): WorkerRow[] {
    return [...g.workers.values()]
      .filter((w) => w.state === 'running' && w.lastView != null)
      .sort((a, b) => (a.dispatchAtMs ?? 0) - (b.dispatchAtMs ?? 0))
  }

  /**
   * Render a group's shared message body at `now`.
   *   - `terminalRecap` set + zero running → the last worker's terminal recap
   *     (single 🛠 Worker card, done/failed).
   *   - exactly one running → the full 🛠 Worker card (single-worker parity).
   *   - 2+ running → the combined `renderCombinedWorkerFeed` body.
   *   - zero running, no recap → null (nothing to show).
   * `heartbeat` toggles the single-worker climbing `· Ns` step suffix.
   */
  function renderGroupBody(
    g: FeedGroup,
    now: number,
    terminalRecap: WorkerActivityView | null,
    heartbeat: boolean,
  ): string | null {
    const running = runningRows(g)
    if (running.length === 0) {
      if (terminalRecap == null) return null
      return renderWorkerActivity(terminalRecap)
    }
    // On a normal update/finish the header shows the worker's LAST-REPORTED
    // elapsed (byte-stable for the dedup / no-op skip). Only the heartbeat —
    // which fires when no fresh view arrived — climbs a live wall-clock elapsed
    // so a silent worker still visibly advances.
    const elapsedFor = (r: WorkerRow): number =>
      heartbeat ? liveElapsed(r, now) : r.lastView?.elapsedMs ?? liveElapsed(r, now)
    if (running.length === 1) {
      const r = running[0]
      const view: WorkerActivityView = {
        ...(r.lastView as WorkerActivityView),
        elapsedMs: elapsedFor(r),
        narrativeLines: [...r.narrative],
      }
      let liveSuffix = ''
      if (heartbeat) {
        const stepElapsed = r.stepStartedAtMs != null ? now - r.stepStartedAtMs : liveElapsed(r, now)
        liveSuffix = formatStepSuffix(stepElapsed)
      }
      return renderWorkerActivity(view, liveSuffix)
    }
    const rows: CombinedWorkerRow[] = running.map((r) => {
      const v = r.lastView as WorkerActivityView
      const currentStep = r.narrative.length > 0 ? r.narrative[r.narrative.length - 1] : v.latestSummary
      return {
        description: v.description,
        elapsedMs: elapsedFor(r),
        toolCount: v.toolCount,
        currentStep,
        model: v.model,
      }
    })
    return renderCombinedWorkerFeed(rows, { maxRows })
  }

  /** Remove a worker's row + index entry; delete the group if it is now empty. */
  function removeWorker(g: FeedGroup, agentId: string): void {
    g.workers.delete(agentId)
    agentIndex.delete(agentId)
    if (g.workers.size === 0) groups.delete(g.feedKey)
  }

  /**
   * Drive the group's shared message to the current combined body. Handles
   * first-paint gating, the proactive throttle (bypassed by `force`), the
   * dedup/no-op skip, the send-gate SHED contract, and 429/flood cooldown.
   * `terminalRecap` (set on the last worker's finish) renders + finalizes the
   * message, then removes the finished row.
   */
  async function doRender(
    g: FeedGroup,
    opts2: { force?: boolean; heartbeat?: boolean; terminalRecap?: WorkerActivityView; finishingAgentId?: string } = {},
  ): Promise<void> {
    const now = nowFn()
    const isTerminal = opts2.terminalRecap != null
    if (now < g.cooldownUntil) {
      if (isTerminal && opts2.terminalRecap != null) g.pendingFinalize = opts2.terminalRecap
      return
    }
    // A flood window is open: the gate would SHED every call. Park in cooldown
    // and make ZERO api calls until it closes; the heartbeat re-drives.
    if (parkIfFloodWindowOpen(g)) {
      if (isTerminal && opts2.terminalRecap != null) g.pendingFinalize = opts2.terminalRecap
      return
    }

    const body = renderGroupBody(g, now, opts2.terminalRecap ?? null, opts2.heartbeat ?? false)
    if (body == null) {
      // Nothing to show. On a terminal finalize with no message ever posted,
      // just drop the finished row (the handback carries the result).
      if (isTerminal && opts2.finishingAgentId != null) {
        g.pendingFinalize = null
        removeWorker(g, opts2.finishingAgentId)
      }
      return
    }

    // First paint: hold until some worker in the group has run long enough.
    if (g.messageId == null) {
      const maxElapsed = Math.max(0, ...runningRows(g).map((r) => liveElapsed(r, now)))
      // A terminal recap for a group that never painted → nothing to finalize.
      if (isTerminal && opts2.finishingAgentId != null) {
        g.pendingFinalize = null
        removeWorker(g, opts2.finishingAgentId)
        return
      }
      if (maxElapsed < firstPaintMin) return
      try {
        const sent = await opts.bot.sendMessage(g.chatId, body, sendOptsFor(g))
        // Shed contract (#3084): the gate resolves `undefined`/non-object for a
        // shed send (open flood window) or dropped-stale `useful` TTL. That is
        // NOT a delivered message — record no id, park on any window, let the
        // heartbeat re-drive.
        if (sent == null || typeof sent.message_id !== 'number') {
          parkIfFloodWindowOpen(g)
          log(`worker-feed: first paint shed by send gate feed=${g.feedKey} — not delivered`)
          return
        }
        g.messageId = sent.message_id
        g.lastBody = body
        g.lastEditAt = now
        log(
          `worker-feed: paint feed=${g.feedKey} chat=${g.chatId} ` +
            `thread=${g.threadId ?? '-'} msgId=${g.messageId} workers=${g.workers.size} bytes=${body.length}`,
        )
      } catch (err) {
        noteRateLimited(g, err, 'send')
        log(`worker-feed: send failed: ${(err as Error).message}`)
      }
      return
    }

    // Dedup + proactive throttle (finish/terminal edits force through).
    if (body === g.lastBody) {
      if (isTerminal && opts2.finishingAgentId != null) {
        g.pendingFinalize = null
        removeWorker(g, opts2.finishingAgentId)
      }
      return
    }
    if (!opts2.force && now - g.lastEditAt < minEditInterval) return

    try {
      const res = await opts.bot.editMessageText(g.chatId, g.messageId, body, sendOptsFor(g))
      // Shed honesty (#3084): a cosmetic edit the gate shed resolves the
      // distinguishable SEND_GATE_SHED sentinel (NOT a bare `undefined`, which
      // the gate reserves for a benign no-op drop whose payload IS on screen).
      // The shed payload is NOT on screen, so do not record it as `lastBody`.
      if (isSendGateShed(res)) {
        parkIfFloodWindowOpen(g)
        if (isTerminal && opts2.terminalRecap != null) g.pendingFinalize = opts2.terminalRecap
        return
      }
      g.lastBody = body
      g.lastEditAt = now
      if (isTerminal) {
        log(
          `worker-feed: finish feed=${g.feedKey} chat=${g.chatId} thread=${g.threadId ?? '-'} ` +
            `msgId=${g.messageId} agent=${opts2.finishingAgentId ?? '-'} ` +
            `state=${opts2.terminalRecap?.state ?? 'done'} bytes=${body.length}`,
        )
      } else {
        log(
          `worker-feed: edit feed=${g.feedKey} chat=${g.chatId} ` +
            `thread=${g.threadId ?? '-'} msgId=${g.messageId} workers=${g.workers.size} bytes=${body.length}`,
        )
      }
      if (isTerminal && opts2.finishingAgentId != null) {
        g.pendingFinalize = null
        removeWorker(g, opts2.finishingAgentId)
      }
    } catch (err) {
      const outcome = classifyEditError(err)
      if (outcome === 'rate_limited') {
        noteRateLimited(g, err, isTerminal ? 'finish' : 'edit')
        if (isTerminal && opts2.terminalRecap != null) g.pendingFinalize = opts2.terminalRecap
        return
      }
      if (outcome === 'not_modified') {
        g.lastBody = body
        g.lastEditAt = now
        if (isTerminal && opts2.finishingAgentId != null) {
          g.pendingFinalize = null
          removeWorker(g, opts2.finishingAgentId)
        }
        return
      }
      if (outcome === 'gone') {
        // Message/chat gone or edit window closed — no card to update. Drop the
        // stale message id; a fresh first-paint re-establishes one if workers
        // are still live. On a terminal finalize, also drop the finished row.
        g.messageId = null
        g.lastBody = null
        if (isTerminal && opts2.finishingAgentId != null) {
          g.pendingFinalize = null
          removeWorker(g, opts2.finishingAgentId)
        }
        return
      }
      // 'transient' — leave the message intact; the heartbeat re-attempts.
      if (isTerminal && opts2.terminalRecap != null) g.pendingFinalize = opts2.terminalRecap
      log(`worker-feed: edit transient error feed=${g.feedKey}: ${(err as Error).message}`)
    }
  }

  // Arm the heartbeat once at construction. The real timer is `.unref()`'d so
  // it never keeps the process alive; tests inject setInterval/clearInterval.
  function heartbeatTick(): void {
    const now = nowFn()
    for (const g of [...groups.values()]) {
      // Deferred-finalize re-drive: a terminal edit that hit a cooldown/flood
      // window was staged on `pendingFinalize`. Re-drive it once the cooldown
      // expires so a finished feed can't get stuck on its last running render.
      if (g.pendingFinalize != null && now >= g.cooldownUntil) {
        const recap = g.pendingFinalize
        // The finishing agent is whatever finished row remains (state terminal).
        const finishingAgentId = [...g.workers.values()].find((w) => w.finished)?.agentId
        g.chain = g.chain
          .then(() => doRender(g, { force: true, terminalRecap: recap, finishingAgentId }))
          .catch((err) => {
            log(`worker-feed: heartbeat finalize re-drive error feed=${g.feedKey}: ${(err as Error).message}`)
          })
        continue
      }

      if (now < g.cooldownUntil) continue
      const running = runningRows(g)
      if (running.length === 0) continue

      // First-paint path: no message yet and some worker has now crossed
      // firstPaintMin (a prose-silent worker's single early tick was held).
      if (g.messageId == null) {
        const maxElapsed = Math.max(0, ...running.map((r) => liveElapsed(r, now)))
        if (maxElapsed < firstPaintMin) continue
        g.chain = g.chain
          .then(() => doRender(g, {}))
          .catch((err) => {
            log(`worker-feed: heartbeat first-paint chain error feed=${g.feedKey}: ${(err as Error).message}`)
          })
        continue
      }

      if (now - g.lastEditAt < minEditInterval) continue
      const stale = now - g.lastEditAt >= heartbeatTickMs
      if (!stale) continue
      // Re-render THROUGH the chain → doRender path with climbing elapsed.
      g.chain = g.chain
        .then(() => doRender(g, { heartbeat: true }))
        .catch((err) => {
          log(`worker-feed: heartbeat chain error feed=${g.feedKey}: ${(err as Error).message}`)
        })
    }
  }

  heartbeatTimer = setIntervalFn(heartbeatTick, heartbeatTickMs)

  return {
    has(agentId) {
      const g = groupOfAgent(agentId)
      return g != null && g.messageId != null && g.workers.has(agentId)
    },
    messageIdOf(agentId) {
      return groupOfAgent(agentId)?.messageId ?? null
    },
    get size() {
      let n = 0
      for (const g of groups.values()) n += g.workers.size
      return n
    },
    update(agentId, chatId, view, threadId) {
      // No chat to post to (owner DM unconfigured) — don't create state that
      // would retry a failing send('') every tick.
      if (chatId.length === 0) return Promise.resolve()
      // Resurrection guard: a worker already finalized must not get a fresh
      // running cue (a late watcher tick would repaint a done worker as live).
      if (finalized.has(agentId)) return Promise.resolve()
      const existingRow = groupOfAgent(agentId)?.workers.get(agentId)
      if (existingRow?.finished === true) return Promise.resolve()

      const feedKey = feedKeyOf(chatId, threadId)
      let g = groups.get(feedKey)
      if (g == null) {
        g = {
          feedKey,
          chatId,
          threadId,
          messageId: null,
          lastBody: null,
          lastEditAt: 0,
          cooldownUntil: 0,
          chain: Promise.resolve(),
          workers: new Map(),
          pendingFinalize: null,
        }
        groups.set(feedKey, g)
      }
      let row = g.workers.get(agentId)
      if (row == null) {
        row = {
          agentId,
          narrative: [],
          lastView: null,
          state: 'running',
          finished: false,
          dispatchAtMs: null,
          stepStartedAtMs: null,
        }
        g.workers.set(agentId, row)
        agentIndex.set(agentId, feedKey)
      }
      // Accumulate before the gate so a throttled tick still grows the
      // narrative — it surfaces on the next edit that does fire.
      accumulateNarrative(row, view)
      row.state = 'running'
      row.lastView = { ...view, narrativeLines: [...row.narrative] }
      if (row.dispatchAtMs == null) row.dispatchAtMs = nowFn() - view.elapsedMs

      const group = g
      group.chain = group.chain.then(() => doRender(group)).catch((err) => {
        log(`worker-feed: update chain error ${agentId}: ${(err as Error).message}`)
      })
      return group.chain
    },
    finish(agentId, view) {
      const g = groupOfAgent(agentId)
      const row = g?.workers.get(agentId)
      if (g == null || row == null) {
        // Never tracked (trivial worker) — mark finalized so a late tick can't
        // resurrect, and let the handback carry the result.
        markFinalized(agentId)
        return Promise.resolve()
      }
      // Latch synchronously so a late `running` cue on the chain can't resurrect.
      row.finished = true
      row.state = view.state === 'failed' ? 'failed' : 'done'
      markFinalized(agentId)

      const group = g
      group.chain = group.chain
        .then(() => {
          const others = runningRows(group).filter((w) => w.agentId !== agentId)
          if (others.length > 0) {
            // Siblings still live → drop this row from the combined body and
            // re-render the running set. The result reaches the user via the
            // separate handback, never folded into this cosmetic edit.
            removeWorker(group, agentId)
            return doRender(group, { force: true })
          }
          // Last live worker → finalize the shared message to its terminal recap.
          const recap: WorkerActivityView = { ...view, narrativeLines: [...row.narrative] }
          return doRender(group, { force: true, terminalRecap: recap, finishingAgentId: agentId })
        })
        .catch((err) => {
          log(`worker-feed: finish chain error ${agentId}: ${(err as Error).message}`)
        })
      return group.chain
    },
    drop(agentId) {
      // A dropped worker is also done — mark finalized so a late tick can't
      // resurrect a running card on it (same gate as `finish`).
      markFinalized(agentId)
      const g = groupOfAgent(agentId)
      if (g == null) return
      const hadMessage = g.messageId != null
      removeWorker(g, agentId)
      // Re-render so the dropped worker disappears from a combined body. Skip
      // when the group is gone (removeWorker deleted it) or never painted.
      if (hadMessage && groups.has(g.feedKey) && runningRows(g).length > 0) {
        g.chain = g.chain
          .then(() => doRender(g, { force: true }))
          .catch((err) => {
            log(`worker-feed: drop re-render error ${agentId}: ${(err as Error).message}`)
          })
      }
    },
    resurrect(agentId) {
      // Issue #3023: the worker's card was falsely finalized and its JSONL has
      // resumed. Re-open the paint path: drop the durable finalized gate + any
      // surviving per-row latch so a fresh `running` cue repaints a live card.
      const wasFinalized = finalized.delete(agentId)
      const row = groupOfAgent(agentId)?.workers.get(agentId)
      if (row != null) {
        row.finished = false
        row.state = 'running'
      }
      if (wasFinalized || row != null) {
        log(`worker-feed: resurrect agent=${agentId} — cleared finalized gate; card will repaint on next running cue`)
      }
    },
    heartbeatTick,
    stop() {
      if (heartbeatTimer != null) {
        clearIntervalFn(heartbeatTimer)
        heartbeatTimer = null
      }
    },
  }
}
