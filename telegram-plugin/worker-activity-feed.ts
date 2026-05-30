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
 * The feed is gated to BACKGROUND workers and lives behind the
 * `SWITCHROOM_WORKER_ACTIVITY_FEED` flag — see the gateway wiring. The
 * watcher already drives the cues (it polls the worker jsonl directly,
 * so it keeps firing after the parent turn ends), which is why the feed
 * is fed from watcher callbacks rather than the bridge event stream.
 */

import { escapeHtml, formatDuration, truncate } from './card-format.js'

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
const TOOL_ARG_MAX = 64
const SUMMARY_MAX = 100

/**
 * Render the worker-activity message body as Telegram HTML.
 *
 * Layout (running):
 *   🔧 <b>Worker</b> · <i>{description}</i>
 *   ⚡ <code>{tool}</code> {arg} <i>({n} tools · {elapsed})</i>
 *     ↳ <i>{latest summary}</i>
 *
 * Terminal collapses the activity line to a tool-count + duration recap:
 *   ✅ <b>Worker done</b> · <i>{description}</i>
 *   <i>{n} tools · {elapsed}</i>
 */
export function renderWorkerActivity(v: WorkerActivityView): string {
  const desc = truncate(v.description.trim() || 'background task', DESC_MAX)
  const elapsed = formatDuration(v.elapsedMs)
  const toolWord = v.toolCount === 1 ? 'tool' : 'tools'

  if (v.state === 'done' || v.state === 'failed') {
    const head =
      v.state === 'done'
        ? `✅ <b>Worker done</b> · <i>${escapeHtml(desc)}</i>`
        : `⚠️ <b>Worker failed</b> · <i>${escapeHtml(desc)}</i>`
    return `${head}\n<i>${v.toolCount} ${toolWord} · ${elapsed}</i>`
  }

  const header = `🔧 <b>Worker</b> · <i>${escapeHtml(desc)}</i>`

  let activity: string
  if (v.lastTool != null) {
    const arg = v.lastTool.sanitisedArg.trim()
    const argPart = arg.length > 0 ? ` ${escapeHtml(truncate(arg, TOOL_ARG_MAX))}` : ''
    activity = `⚡ <code>${escapeHtml(v.lastTool.name)}</code>${argPart} <i>(${v.toolCount} ${toolWord} · ${elapsed})</i>`
  } else {
    activity = `<i>starting… (${elapsed})</i>`
  }

  const summary = v.latestSummary.trim()
  const lines = [header, activity]
  if (summary.length > 0) {
    lines.push(`  ↳ <i>${escapeHtml(truncate(summary, SUMMARY_MAX))}</i>`)
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

  async function doUpdate(h: WorkerHandle, view: WorkerActivityView): Promise<void> {
    if (nowFn() < h.cooldownUntil) return
    const body = renderWorkerActivity(view)

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
    const body = renderWorkerActivity(view)
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
