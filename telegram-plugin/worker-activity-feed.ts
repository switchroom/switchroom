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
 * Pure render (`renderWorkerActivity`) + an injected bot API
 * (`BotApiForWorkerFeed`), mirroring `issues-card.ts` so the gateway
 * reuses the same wiring. The manager (`createWorkerActivityFeed`) owns
 * one edit-in-place message per worker, keyed by jsonl agent id, with:
 *   - a first-paint delay so trivial sub-second workers never post a
 *     message (their result still lands via the handback reply),
 *   - a proactive min-edit-interval throttle (worker jsonl ticks ~1/s;
 *     Telegram rate-limits edits) plus body-dedup,
 *   - per-worker serialization so two rapid ticks can't double-send,
 *   - 429 cooldown + message_id drift resilience (re-post on stale edit),
 *   - a forced terminal edit on `finish` regardless of throttle.
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
import { renderStatusCard, formatStepSuffix } from './tool-activity-summary.js'

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
   * Heartbeat timer factory. Injectable for tests. Defaults to the real
   * `setInterval`, `.unref()`'d so it never keeps the process alive.
   */
  setInterval?: (cb: () => void, ms: number) => unknown
  /** Heartbeat timer disposer. Injectable for tests. Defaults to `clearInterval`. */
  clearInterval?: (handle: unknown) => void
  /**
   * Heartbeat tick cadence in ms. On each tick a stale, running worker is
   * re-rendered with a climbing `· Ns` suffix so a worker that emits no new
   * narrative still visibly advances. Default 6000ms.
   */
  heartbeatTickMs?: number
}

interface WorkerHandle {
  /** jsonl agent id — carried so success/failure log lines can name the worker. */
  agentId: string
  chatId: string
  threadId?: number
  messageId: number | null
  lastBody: string | null
  lastEditAt: number
  cooldownUntil: number
  /**
   * Accumulated narrative lines (oldest→newest), deduped against the
   * immediately-preceding line. Rolling-window capped to STATUS_ROLLING_LINES.
   * Grows the live render so the feed reads like the main agent's answer.
   */
  narrative: string[]
  /** Per-worker serialization chain so ticks can't interleave sends. */
  chain: Promise<void>
  /** Last view rendered into the message (drives the heartbeat re-render). */
  lastView: WorkerActivityView | null
  /**
   * A terminal (`finish`) view whose edit could not land yet — most often
   * because a 429 cooldown was in effect when `doFinish` ran. The heartbeat
   * re-drives `doFinish` with this view once the cooldown expires so a
   * transport hiccup can't leave the card stuck on its last running render
   * ("worker done, card says running"). Cleared on a successful terminal
   * edit, on a permanent failure (message gone), or when the handle is
   * deleted. Null when no finalize is pending.
   */
  pendingFinish: WorkerActivityView | null
  /**
   * Latched in `doFinish` before the terminal edit. A late watcher
   * `onProgress` tick that arrives after `finish()` queued its chain (but
   * before the `.finally(handles.delete)` microtask drains) must NOT
   * resurrect the handle and paint a fresh `running` message on an
   * already-finalized worker. The heartbeat's orphan-paint guard
   * (`if (!handles.has(h.agentId)) continue`) only covers the heartbeat
   * tick — this flag covers the `update` entry point. Set synchronously
   * inside `doFinish` (runs on the chain), checked synchronously in
   * `update` before handle creation.
   */
  finished: boolean
  /**
   * Wall-clock ms the worker was dispatched, derived from `now - view.elapsedMs`
   * on the first update. The heartbeat computes a live elapsed from this so the
   * `· Ns` suffix climbs even when no fresh view arrives.
   */
  dispatchAtMs: number | null
  /**
   * Wall-clock ms the CURRENT step started — stamped whenever a NEW narrative
   * line lands (the `→` line changes). The heartbeat's step suffix shows the
   * step's OWN elapsed from this anchor (not the worker total, which the
   * header already carries), and only once past STEP_TIMER_MIN_MS.
   */
  stepStartedAtMs: number | null
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
 *     update; drop the handle silently (no warning — there is no card).
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
 * Manager owning one live message per background worker. Keyed by jsonl
 * agent id. The gateway calls `update` on each watcher activity cue and
 * `finish` on terminal; `drop` discards a worker's state without a final
 * edit (error / supersession paths).
 */
export interface WorkerActivityFeed {
  /** True if a message is currently posted for this worker. */
  has(agentId: string): boolean
  /** The Telegram message_id currently posted for this worker, or null if
   *  none is posted (never painted, or dropped after a stale-edit re-post).
   *  Lets the gateway pin the EXISTING `🛠 Worker` message (status-pin). */
  messageIdOf(agentId: string): number | null
  /** Push a running-state cue. Returns the serialized op for tests. */
  update(
    agentId: string,
    chatId: string,
    view: WorkerActivityView,
    threadId?: number,
  ): Promise<void>
  /** Force the terminal recap edit. No-op if no message was ever posted. */
  finish(agentId: string, view: WorkerActivityView): Promise<void>
  /** Forget a worker's state without editing (e.g. error path). */
  drop(agentId: string): void
  /**
   * Issue #3023 (card resurrection). Undo a finalization: clear the durable
   * `finalized` gate (and any lingering per-handle `finished` latch) so a
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
  /** Number of tracked workers (test/inspection hook). */
  readonly size: number
}

export function createWorkerActivityFeed(opts: WorkerActivityFeedOpts): WorkerActivityFeed {
  const log = opts.log ?? (() => {})
  const nowFn = opts.now ?? Date.now
  const minEditInterval = opts.minEditIntervalMs ?? 2500
  const firstPaintMin = opts.firstPaintMinMs ?? 8000
  const heartbeatTickMs = opts.heartbeatTickMs ?? 6000
  const setIntervalFn =
    opts.setInterval ??
    ((cb: () => void, ms: number): unknown => {
      const t = setInterval(cb, ms)
      // Never keep the process alive on the heartbeat alone.
      ;(t as { unref?: () => void }).unref?.()
      return t
    })
  const clearIntervalFn = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  const handles = new Map<string, WorkerHandle>()
  /**
   * Agent ids that have been finalized (`doFinish` latched). Survives handle
   * deletion so a LATE watcher `onProgress` tick — which can arrive after
   * `finish()`'s chain has fully settled and the handle was deleted — cannot
   * resurrect a fresh handle and paint a running card on a worker that is
   * already done. The per-handle `finished` flag only covers the narrow
   * window between latch and delete; this set is the durable gate. A late
   * tick arrives within seconds of finish (watcher poll cadence), so the set
   * only needs to cover recent finalizations — capped at FINALIZED_CAP and
   * trimmed FIFO to stay bounded across a long gateway lifetime.
   */
  const finalized = new Set<string>()
  const FINALIZED_CAP = 256
  function markFinalized(agentId: string): void {
    if (finalized.has(agentId)) return
    finalized.add(agentId)
    if (finalized.size > FINALIZED_CAP) {
      // Map-free FIFO trim: Set iterates in insertion order; drop the oldest.
      const oldest = finalized.values().next().value
      if (oldest != null) finalized.delete(oldest)
    }
  }
  let heartbeatTimer: unknown = null

  function sendOptsFor(h: WorkerHandle): Record<string, unknown> {
    return {
      disable_web_page_preview: true,
      // Sub-agent progress card is a status surface, never the user's
      // answer — silence the open ping. (editMessageText ignores
      // disable_notification, so this is a no-op on the in-place edits
      // that share these opts.)
      disable_notification: true,
      ...(h.threadId != null ? { message_thread_id: h.threadId } : {}),
    }
  }

  function noteRateLimited(h: WorkerHandle, err: unknown, label: string): void {
    const retryAfter = extractRetryAfterSecs(err)
    if (retryAfter == null) return
    h.cooldownUntil = nowFn() + retryAfter * 1000 + COOLDOWN_JITTER_MS
    log(`worker-feed: ${label} 429 — backing off ${retryAfter}s`)
  }

  function accumulateNarrative(h: WorkerHandle, view: WorkerActivityView): void {
    const line = view.latestSummary.trim()
    if (line.length === 0) return
    // Dedup within the whole rolling window, not just the immediately-
    // preceding line. The watcher re-emits the same narrative across ticks
    // while a tool runs (adjacent repeats), AND one logical step can surface
    // twice non-adjacently — e.g. a "Look for X" preamble followed later by
    // the Task tool whose describeToolUse label is the same "Look for X"
    // description, interleaved with another step (the A,B,A duplication the
    // operator observed on live cards). A legitimate later re-visit of the
    // same step re-appears once the earlier copy scrolls out of the window.
    if (h.narrative.includes(line)) return
    h.narrative.push(line)
    // The `→` current-step line just CHANGED — reset the per-step timer so the
    // heartbeat's `· Ns` suffix measures THIS step, not the whole worker run.
    h.stepStartedAtMs = nowFn()
    // Rolling window — keep only the last STATUS_ROLLING_LINES in memory. The
    // render shows exactly those lines (clipped per-line by the unified pipeline);
    // fitCardToBudget is the wire-limit backstop.
    if (h.narrative.length > STATUS_ROLLING_LINES) {
      h.narrative.splice(0, h.narrative.length - STATUS_ROLLING_LINES)
    }
  }

  async function doUpdate(h: WorkerHandle, view: WorkerActivityView, liveSuffix = ''): Promise<void> {
    // Accumulate before any gate so a throttled/cooled-down tick still grows
    // the narrative — the line surfaces on the next edit that does fire.
    accumulateNarrative(h, view)
    // Stamp the dispatch wall-clock once so the heartbeat can climb a live
    // elapsed even between fresh views. lastView feeds the heartbeat re-render.
    const merged: WorkerActivityView = { ...view, narrativeLines: [...h.narrative] }
    h.lastView = merged
    if (h.dispatchAtMs == null) h.dispatchAtMs = nowFn() - view.elapsedMs
    if (nowFn() < h.cooldownUntil) return
    const body = renderWorkerActivity(merged, liveSuffix)

    // First paint: hold off until the worker has run long enough to be
    // worth a message; trivial workers stay silent (handback covers them).
    if (h.messageId == null) {
      if (view.elapsedMs < firstPaintMin) return
      try {
        const sent = await opts.bot.sendMessage(h.chatId, body, sendOptsFor(h))
        h.messageId = sent.message_id
        h.lastBody = body
        h.lastEditAt = nowFn()
        log(
          `worker-feed: paint agent=${h.agentId} chat=${h.chatId} ` +
            `thread=${h.threadId ?? '-'} msgId=${h.messageId} bytes=${body.length}`,
        )
      } catch (err) {
        noteRateLimited(h, err, 'send')
        log(`worker-feed: send failed: ${(err as Error).message}`)
      }
      return
    }

    // Dedup + proactive throttle.
    if (body === h.lastBody) return
    if (nowFn() - h.lastEditAt < minEditInterval) return

    try {
      await opts.bot.editMessageText(h.chatId, h.messageId, body, sendOptsFor(h))
      h.lastBody = body
      h.lastEditAt = nowFn()
      log(
        `worker-feed: edit agent=${h.agentId} chat=${h.chatId} ` +
          `thread=${h.threadId ?? '-'} msgId=${h.messageId} bytes=${body.length}`,
      )
    } catch (err) {
      const outcome = classifyEditError(err)
      if (outcome === 'rate_limited') {
        noteRateLimited(h, err, 'edit')
        return
      }
      if (outcome === 'not_modified') {
        // Card already shows this body — record it as landed and move on.
        h.lastBody = body
        h.lastEditAt = nowFn()
        return
      }
      if (outcome === 'gone') {
        // Message/chat deleted or edit window closed — there is no card to
        // update. Drop the handle silently; a fresh first-paint on the next
        // running tick re-establishes one if the worker is still active. No
        // warning: "no card" is not a liveness-logic error.
        h.messageId = null
        h.lastBody = null
        return
      }
      // 'transient' — network blip / 5xx. Leave the handle intact; the
      // heartbeat re-attempts on its next tick. Log at debug, not stderr-warn:
      // a transport hiccup on a best-effort card is not "shit code", it's a
      // retryable blip the framework rides out deterministically.
      log(`worker-feed: edit transient error agent=${h.agentId}: ${(err as Error).message}`)
    }
  }

  async function doFinish(h: WorkerHandle, view: WorkerActivityView): Promise<void> {
    // Latch FIRST, before any early return. A `running`-cue tick arriving
    // after `finish()` queued this chain (but before its `.finally(delete)`
    // drains) would otherwise resurrect a handle via `update()` and paint a
    // fresh running message on a finalized worker. Setting this synchronously
    // on the chain — ahead of the cooldown/no-message guards — makes the
    // gate in `update()` authoritative regardless of which guard path runs.
    // The durable `finalized` set survives the subsequent handle deletion so
    // a tick arriving AFTER the full settle still can't resurrect.
    h.finished = true
    markFinalized(h.agentId)
    // No message ever posted → nothing to finalize. The worker's result
    // reaches the user via the handback reply; a bare "done" recap with
    // no preceding activity would be noise.
    if (h.messageId == null) {
      h.pendingFinish = null
      return
    }
    if (nowFn() < h.cooldownUntil) {
      // Honour the flood-wait; a terminal edit isn't worth a ban. But
      // unlike the prior "stale but harmless" surrender, STAGE the terminal
      // view so the heartbeat re-drives the finalize edit the instant the
      // cooldown expires — a transport hiccup can no longer leave a
      // finished worker's card stuck on its last running render.
      h.pendingFinish = view
      return
    }
    const body = renderWorkerActivity({ ...view, narrativeLines: h.narrative })
    if (body === h.lastBody) {
      h.pendingFinish = null
      return
    }
    try {
      await opts.bot.editMessageText(h.chatId, h.messageId, body, sendOptsFor(h))
      h.lastBody = body
      h.lastEditAt = nowFn()
      h.pendingFinish = null
      log(
        `worker-feed: finish agent=${h.agentId} chat=${h.chatId} ` +
          `thread=${h.threadId ?? '-'} msgId=${h.messageId} state=${view.state} bytes=${body.length}`,
      )
    } catch (err) {
      const outcome = classifyEditError(err)
      if (outcome === 'rate_limited') {
        noteRateLimited(h, err, 'finish')
        // Re-stage for the heartbeat to re-drive after cooldown.
        h.pendingFinish = view
        return
      }
      if (outcome === 'not_modified') {
        // Card already shows the finalized body — terminal edit succeeded.
        h.lastBody = body
        h.lastEditAt = nowFn()
        h.pendingFinish = null
        return
      }
      if (outcome === 'gone') {
        // Message/chat gone — no card to finalize. Drop silently; the
        // handback reply carries the result regardless.
        h.pendingFinish = null
        return
      }
      // 'transient' — re-stage for a heartbeat retry; log at debug.
      h.pendingFinish = view
      log(`worker-feed: finish transient error agent=${h.agentId}: ${(err as Error).message}`)
    }
  }

  /**
   * Heartbeat — keeps a running worker's message alive AND performs the
   * FIRST paint for a prose-silent worker whose only tick arrived before
   * `firstPaintMin`.
   *
   * Why the first-paint branch exists: a background worker that dives
   * straight into quiet work (e.g. a long `Bash` / `npm test`) emits a
   * single `sub_agent_tool_use` event when the command is invoked, then no
   * further JSONL lines for the whole run. That one tick drives `update`
   * once — but if it lands before `firstPaintMin` the paint is held, and
   * with no subsequent tick nothing ever re-drives it, so the worker shows
   * NOTHING for its entire run (the "I can't see the worker" gap). The
   * heartbeat closes it: once such a handle is past `firstPaintMin`, drive a
   * paint here through the same chain → doUpdate path. After first paint the
   * suffix-only maintenance branch keeps it advancing.
   *
   * For handles that already have a posted message, this is the original
   * option-(a), suffix-only re-render (never editMessageText directly). Skips:
   *   - handles inside a 429 cooldown,
   *   - handles with no `lastView` (no update ever arrived) or non-running,
   *   - for the maintenance branch: handles edited within minEditInterval
   *     (no stampede) or whose current step isn't yet stale.
   * The `· Ns` liveSuffix is applied ONLY when the worker's current step is
   * stale (now - lastEditAt >= heartbeatTickMs) so a normally-ticking worker is
   * untouched and its body stays byte-stable for the dedup.
   */
  function heartbeatTick(): void {
    const now = nowFn()
    for (const h of handles.values()) {
      // Orphan-paint guard: `finish()` deletes the handle in a `.finally` that
      // may not have drained if a tick fires in the same synchronous stretch.
      // Skip any handle no longer in the map so the first-paint branch below
      // can never send a fresh `running` message on an already-finished worker
      // (which would orphan a card that never finalizes). Restores the
      // structural safety the pre-first-paint `messageId == null` skip gave.
      if (!handles.has(h.agentId)) continue

      // Deferred-finalize re-drive: a terminal edit that hit a 429 cooldown
      // (or a transient error) was staged on `pendingFinish` by `doFinish`.
      // Re-drive it once the cooldown has expired so a finished worker's card
      // can't get stuck on its last running render. This is the deterministic
      // backstop that replaces the old "stale but harmless" surrender — the
      // framework owns ALIVE-and-done, wall-clock driven, no model in the loop.
      // (The handle is still in the map because `finish()`'s `.finally(delete)`
      // is chained AFTER `doFinish` and won't drain while a re-drive keeps the
      // chain busy; once the terminal edit lands, `pendingFinish` is cleared
      // and the `.finally` runs on the next chain settle.)
      if (h.pendingFinish != null && now >= h.cooldownUntil) {
        const view = h.pendingFinish
        h.chain = h.chain
          .then(() => doFinish(h, view))
          .catch((err) => {
            log(`worker-feed: heartbeat finalize re-drive error ${h.agentId}: ${(err as Error).message}`)
          })
          .finally(() => {
            // Mirror `finish()`'s teardown: once the re-driven `doFinish`
            // clears `pendingFinish` (terminal edit landed OR permanently
            // failed), drop the handle. If it re-staged (another 429), the
            // handle survives for the next heartbeat tick to retry.
            if (handles.get(h.agentId)?.pendingFinish == null) {
              handles.delete(h.agentId)
            }
          })
        continue
      }

      if (h.lastView == null) continue
      if (h.lastView.state !== 'running') continue
      if (now < h.cooldownUntil) continue

      const liveElapsed = h.dispatchAtMs != null ? now - h.dispatchAtMs : h.lastView.elapsedMs

      // First-paint path: a prose-silent worker's single early tick was held
      // (elapsed < firstPaintMin) and no further tick re-drove it. Once it is
      // past firstPaintMin, drive the paint. doUpdate's send branch re-checks
      // firstPaintMin against the refreshed elapsed, so this is exact.
      if (h.messageId == null) {
        if (liveElapsed < firstPaintMin) continue
        const view = { ...h.lastView, elapsedMs: Math.max(h.lastView.elapsedMs, liveElapsed) }
        h.chain = h.chain
          .then(() => doUpdate(h, view))
          .catch((err) => {
            log(`worker-feed: heartbeat first-paint chain error ${h.agentId}: ${(err as Error).message}`)
          })
        continue
      }

      if (now - h.lastEditAt < minEditInterval) continue
      const stale = now - h.lastEditAt >= heartbeatTickMs
      if (!stale) continue
      // Per-step suffix: the CURRENT step's own elapsed (since the `→` line
      // last changed), never the worker total — the header already shows the
      // total, and repeating it on the step line was the Ken-observed dupe.
      // Under STEP_TIMER_MIN_MS formatStepSuffix returns '' (no timer yet);
      // the header elapsed still climbs via the refreshed view below.
      const stepElapsed = h.stepStartedAtMs != null ? now - h.stepStartedAtMs : liveElapsed
      const liveSuffix = formatStepSuffix(stepElapsed)
      // Re-render THROUGH the chain + doUpdate path — never editMessageText directly.
      //
      // CLOCK-ANCHOR PARITY: refresh the view's elapsedMs to the same `now`
      // anchor the step suffix uses. The header renders
      // `view.elapsedMs`; passing the stale lastView froze the header at the
      // last watcher event while the `· Ns` suffix kept ticking, so the
      // current step's timer could read MORE than the card's master elapsed
      // (Ken-observed defect). Both numbers now derive from one anchor
      // (dispatchAtMs) at one `now`, so header elapsed >= step suffix always.
      const view = { ...h.lastView, elapsedMs: Math.max(h.lastView.elapsedMs, liveElapsed) }
      h.chain = h.chain
        .then(() => doUpdate(h, view, liveSuffix))
        .catch((err) => {
          log(`worker-feed: heartbeat chain error ${h.agentId}: ${(err as Error).message}`)
        })
    }
  }

  // Arm the heartbeat once at construction. The real timer is `.unref()`'d so
  // it never keeps the process alive; tests inject setInterval/clearInterval.
  heartbeatTimer = setIntervalFn(heartbeatTick, heartbeatTickMs)

  return {
    has(agentId) {
      return handles.get(agentId)?.messageId != null
    },
    messageIdOf(agentId) {
      return handles.get(agentId)?.messageId ?? null
    },
    get size() {
      return handles.size
    },
    update(agentId, chatId, view, threadId) {
      // No chat to post to (owner DM unconfigured) — don't create a
      // handle that would retry a failing send('') every tick.
      if (chatId.length === 0) return Promise.resolve()
      // Resurrection guard: a worker that has already been finalized
      // (`doFinish` latched `finalized`) must not get a fresh running cue.
      // A late watcher `onProgress` tick can arrive after `finish()`'s chain
      // has fully settled and the handle was deleted — without this durable
      // gate the tick would create a brand-new handle and paint a fresh
      // `running` message on an already-done worker (the card lies). The
      // heartbeat's orphan-paint guard covers the heartbeat tick only; the
      // per-handle `finished` flag covers the pre-delete window; this set
      // covers the post-delete window.
      if (finalized.has(agentId)) return Promise.resolve()
      const existing = handles.get(agentId)
      if (existing?.finished === true) return Promise.resolve()
      let h = existing
      if (h == null) {
        h = {
          agentId,
          chatId,
          threadId,
          messageId: null,
          lastBody: null,
          lastEditAt: 0,
          cooldownUntil: 0,
          narrative: [],
          chain: Promise.resolve(),
          lastView: null,
          dispatchAtMs: null,
          stepStartedAtMs: null,
          finished: false,
          pendingFinish: null,
        }
        handles.set(agentId, h)
      }
      const handle = h
      handle.chain = handle.chain.then(() => doUpdate(handle, view)).catch((err) => {
        log(`worker-feed: update chain error ${agentId}: ${(err as Error).message}`)
      })
      return handle.chain
    },
    finish(agentId, view) {
      const h = handles.get(agentId)
      if (h == null) return Promise.resolve()
      h.chain = h.chain
        .then(() => doFinish(h, view))
        .catch((err) => {
          log(`worker-feed: finish chain error ${agentId}: ${(err as Error).message}`)
        })
        .finally(() => {
          // Only tear down the handle once the terminal edit has actually
          // landed (or permanently failed). If `doFinish` staged the edit on
          // `pendingFinish` (a 429 cooldown / transient error was in effect),
          // the handle must survive so the heartbeat can re-drive the
          // finalize after cooldown. The heartbeat's re-drive chain ends by
          // re-entering `doFinish`, which clears `pendingFinish` on success
          // or permanent-failure — so this `.finally` deletes on the NEXT
          // chain settle once there is nothing left to finalize. Without this
          // guard, the `.finally` would delete the handle (and its staged
          // pendingFinish) immediately after the first staged doFinish,
          // stranding the card on its last running render.
          if (handles.get(agentId)?.pendingFinish == null) {
            handles.delete(agentId)
          }
        })
      return h.chain
    },
    drop(agentId) {
      // A dropped worker is also done — mark finalized so a late watcher
      // tick can't resurrect a running card on it (same gate as `finish`).
      markFinalized(agentId)
      handles.delete(agentId)
    },
    resurrect(agentId) {
      // Issue #3023: the worker's card was falsely finalized and its JSONL has
      // resumed. Re-open the paint path: drop the durable finalized gate so a
      // fresh `running` cue creates a new handle and first-paints a live card
      // again, and un-latch any surviving handle (finish deleted it in the
      // common case, but a staged pendingFinish could keep it alive). The next
      // `update` tick from the watcher's replayed progress does the repaint.
      const wasFinalized = finalized.delete(agentId)
      const h = handles.get(agentId)
      if (h != null) {
        h.finished = false
        h.pendingFinish = null
      }
      if (wasFinalized || h != null) {
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
