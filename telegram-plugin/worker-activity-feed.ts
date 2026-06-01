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
  escapeHtml,
  formatDuration,
  stripMarkdown,
  truncate,
} from './card-format.js'

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

const DESC_MAX = 80
const STEP_MAX = 100
const RESULT_MAX = 320
/** Subtle horizontal rule between the running feed and the finished result. */
const RULE = '─────'
/**
 * How many trailing narrative lines the live feed keeps visible. The feed
 * grows like the main agent's answer but can't grow unbounded — Telegram
 * caps message length and a wall of stale lines buries the live one. Six
 * keeps recent context without dominating the chat.
 */
const NARRATIVE_MAX_LINES = 6

/**
 * Append the accumulated step feed to `lines`, mirroring the main agent's
 * activity card (`renderActivityFeed`): prior steps render done (`✓`, italic),
 * the newest renders in-progress (`→`, bold) unless `allDone`, and an overflow
 * header (`✓ +N earlier…`) appears when the feed exceeds NARRATIVE_MAX_LINES.
 * `steps` are already cleaned + escaped HTML.
 */
function appendStepFeed(lines: string[], steps: string[], allDone: boolean): void {
  if (steps.length === 0) return
  const shown = steps.slice(-NARRATIVE_MAX_LINES)
  const hidden = steps.length - shown.length
  if (hidden > 0) lines.push(`<i>✓ +${hidden} earlier…</i>`)
  const lastIdx = shown.length - 1
  shown.forEach((s, i) => {
    lines.push(!allDone && i === lastIdx ? `<b>→ ${s}</b>` : `<i>✓ ${s}</i>`)
  })
}

/**
 * Render the worker-activity message body as native Telegram HTML, matching
 * the main agent's activity card (`renderActivityFeed` in
 * tool-activity-summary.ts): a `🛠 Worker · <desc>` header, a one-line status,
 * then a `✓`/`→` step feed. Worker narration is authored as Markdown, so every
 * text fragment is run through `stripMarkdown` before escaping — without it the
 * raw `**`/`` ` ``/`---` leak through as literal characters (the "half-done"
 * look we're fixing).
 *
 * Layout (running):
 *   🛠 <b>Worker</b> · <i>{description}</i>
 *   <i>running · {elapsed} · {n} tools</i>
 *   <i>✓ {earlier step}</i>
 *   <b>→ {newest step}</b>
 *
 * Layout (finished): the feed renders all-done, then a rule + cleaned result:
 *   🛠 <b>Worker</b> · <i>{description}</i>
 *   <i>finished · completed · {n} tools · {elapsed}</i>
 *   <i>✓ {step}</i>
 *   ─────
 *   ✅ <i>{cleaned result paragraph}</i>
 */
export function renderWorkerActivity(v: WorkerActivityView): string {
  const desc = truncate(stripMarkdown(v.description).trim() || 'background task', DESC_MAX)
  const elapsed = formatDuration(v.elapsedMs)
  const toolWord = v.toolCount === 1 ? 'tool' : 'tools'
  const header = `🛠 <b>Worker</b> · <i>${escapeHtml(desc)}</i>`
  const finished = v.state === 'done' || v.state === 'failed'

  const steps = (v.narrativeLines ?? [])
    .map((s) => stripMarkdown(s))
    .filter((s) => s.length > 0)
    .map((s) => escapeHtml(truncate(s, STEP_MAX)))

  if (finished) {
    const verb = v.state === 'done' ? 'completed' : 'failed'
    const lines = [header, `<i>finished · ${verb} · ${v.toolCount} ${toolWord} · ${elapsed}</i>`]
    appendStepFeed(lines, steps, true)
    // On terminal, latestSummary carries the worker's final result text
    // (gateway onFinish), distinct from the running narrative steps.
    const result = cleanWorkerResultParagraph(v.latestSummary)
    if (result.length > 0) {
      const emoji = v.state === 'done' ? '✅' : '⚠️'
      lines.push(RULE)
      lines.push(`${emoji} <i>${escapeHtml(truncate(result, RESULT_MAX))}</i>`)
    }
    return lines.join('\n')
  }

  const lines = [header, `<i>running · ${elapsed} · ${v.toolCount} ${toolWord}</i>`]
  if (steps.length > 0) {
    appendStepFeed(lines, steps, false)
  } else {
    // Back-compat for direct render callers that pass only latestSummary;
    // the manager always supplies narrativeLines.
    const summary = stripMarkdown(v.latestSummary)
    if (summary.length > 0) {
      lines.push(`<b>→ ${escapeHtml(truncate(summary, STEP_MAX))}</b>`)
    } else {
      lines.push('<i>starting…</i>')
    }
  }
  return lines.join('\n')
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
}

interface WorkerHandle {
  chatId: string
  threadId?: number
  messageId: number | null
  lastBody: string | null
  lastEditAt: number
  cooldownUntil: number
  /**
   * Accumulated narrative lines (oldest→newest), deduped against the
   * immediately-preceding line and capped to NARRATIVE_MAX_LINES. Grows the
   * live render so the feed reads like the main agent's answer.
   */
  narrative: string[]
  /** Per-worker serialization chain so ticks can't interleave sends. */
  chain: Promise<void>
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
 * Manager owning one live message per background worker. Keyed by jsonl
 * agent id. The gateway calls `update` on each watcher activity cue and
 * `finish` on terminal; `drop` discards a worker's state without a final
 * edit (error / supersession paths).
 */
export interface WorkerActivityFeed {
  /** True if a message is currently posted for this worker. */
  has(agentId: string): boolean
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
  /** Number of tracked workers (test/inspection hook). */
  readonly size: number
}

export function createWorkerActivityFeed(opts: WorkerActivityFeedOpts): WorkerActivityFeed {
  const log = opts.log ?? (() => {})
  const nowFn = opts.now ?? Date.now
  const minEditInterval = opts.minEditIntervalMs ?? 2500
  const firstPaintMin = opts.firstPaintMinMs ?? 8000
  const handles = new Map<string, WorkerHandle>()

  function sendOptsFor(h: WorkerHandle): Record<string, unknown> {
    return {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
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
    // Dedup against the immediately-preceding line — the watcher re-emits the
    // same narrative across ticks while a tool runs; we only grow on change.
    if (h.narrative[h.narrative.length - 1] === line) return
    h.narrative.push(line)
    if (h.narrative.length > NARRATIVE_MAX_LINES) {
      h.narrative.splice(0, h.narrative.length - NARRATIVE_MAX_LINES)
    }
  }

  async function doUpdate(h: WorkerHandle, view: WorkerActivityView): Promise<void> {
    // Accumulate before any gate so a throttled/cooled-down tick still grows
    // the narrative — the line surfaces on the next edit that does fire.
    accumulateNarrative(h, view)
    if (nowFn() < h.cooldownUntil) return
    const body = renderWorkerActivity({ ...view, narrativeLines: h.narrative })

    // First paint: hold off until the worker has run long enough to be
    // worth a message; trivial workers stay silent (handback covers them).
    if (h.messageId == null) {
      if (view.elapsedMs < firstPaintMin) return
      try {
        const sent = await opts.bot.sendMessage(h.chatId, body, sendOptsFor(h))
        h.messageId = sent.message_id
        h.lastBody = body
        h.lastEditAt = nowFn()
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
    } catch (err) {
      noteRateLimited(h, err, 'edit')
      // Stale message_id (manually deleted / edit window gone). Re-post
      // on the next tick rather than now, so we don't double-down inside
      // a cooldown.
      log(`worker-feed: edit failed, will re-post: ${(err as Error).message}`)
      h.messageId = null
      h.lastBody = null
    }
  }

  async function doFinish(h: WorkerHandle, view: WorkerActivityView): Promise<void> {
    // No message ever posted → nothing to finalize. The worker's result
    // reaches the user via the handback reply; a bare "done" recap with
    // no preceding activity would be noise.
    if (h.messageId == null) return
    if (nowFn() < h.cooldownUntil) {
      // Honour the flood-wait; a terminal edit isn't worth a ban. The
      // message is left at its last running render — stale but harmless.
      return
    }
    const body = renderWorkerActivity({ ...view, narrativeLines: h.narrative })
    if (body === h.lastBody) return
    try {
      await opts.bot.editMessageText(h.chatId, h.messageId, body, sendOptsFor(h))
      h.lastBody = body
      h.lastEditAt = nowFn()
    } catch (err) {
      noteRateLimited(h, err, 'finish')
      log(`worker-feed: finish edit failed: ${(err as Error).message}`)
    }
  }

  return {
    has(agentId) {
      return handles.get(agentId)?.messageId != null
    },
    get size() {
      return handles.size
    },
    update(agentId, chatId, view, threadId) {
      // No chat to post to (owner DM unconfigured) — don't create a
      // handle that would retry a failing send('') every tick.
      if (chatId.length === 0) return Promise.resolve()
      let h = handles.get(agentId)
      if (h == null) {
        h = {
          chatId,
          threadId,
          messageId: null,
          lastBody: null,
          lastEditAt: 0,
          cooldownUntil: 0,
          narrative: [],
          chain: Promise.resolve(),
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
          handles.delete(agentId)
        })
      return h.chain
    },
    drop(agentId) {
      handles.delete(agentId)
    },
  }
}
