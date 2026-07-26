/**
 * Edit-flood fuse — a LAST-RESORT rate ceiling installed at the one seam no
 * outbound call can bypass (#3620).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The send gate (`send-gate.ts`) is the primary pacer, and every call that
 * goes through `robustApiCall` is admitted by it. But two properties make it
 * a gate with side doors rather than a failsafe:
 *
 *   1. Its per-message protections (edit floor, last-write-wins coalescing,
 *      no-op skip, long-horizon edit budget) are OPT-IN: `gate()` routes to
 *      the edit path only when the caller passes BOTH `messageId` and
 *      `editPayload` (send-gate.ts, `gate()`). A caller that forgets gets a
 *      plain send — no floor, no coalescing.
 *   2. An untagged call is admitted as `critical` (UNTAGGED_SEND_CLASS), the
 *      class that is never shed and queues unbounded.
 *
 * That combination is exactly what earned agent `overlord` a 3713-second
 * flood ban on 2026-07-25: the live activity card edited ONE message id with
 * neither key nor class, so it ran at the per-chat bucket rate (60/min) for
 * an hour. Keying that call site fixes that call site — it does not make the
 * next unkeyed call site impossible.
 *
 * ── Why a grammY transformer ──────────────────────────────────────────────
 * The gateway constructs exactly ONE `new Bot(TOKEN)`, and grammY routes
 * 100% of outbound API traffic through that instance's transformer stack —
 * `bot.api.*`, `ctx.api.*`, anything holding a reference to the `Api` object,
 * wrapped or raw, gated or not. Installing here is therefore STRUCTURAL, not
 * conventional: a new call site cannot opt out, because there is no code path
 * to the network that skips the transformer stack. (`shared/bot-runtime.ts`
 * already proves the seam with `installTgPostLogger`.)
 *
 * ── What it does (and deliberately does NOT do) ───────────────────────────
 *   - EDITS of the same `${chat_id}:${message_id}` are capped at
 *     `perMessageMaxPerWindow` per `perMessageWindowMs` (default 20/60s).
 *     Over-budget edits WAIT for the window to slide, and while they wait a
 *     newer edit to the same message SUPERSEDES them — last-write-wins at the
 *     chokepoint, for every caller, including ones that never heard of the
 *     send gate. A superseded or over-deferred edit is DROPPED (resolved as a
 *     benign no-op), which is safe precisely because the next render of any
 *     card carries full state.
 *   - NON-EDIT sends are PACED (per-chat rolling ceiling) but NEVER dropped.
 *     Dropping a reply would lose a user-visible answer; dropping a repaint
 *     costs nothing. Pacing is capped at `maxDeferMs`, after which the call
 *     passes through rather than blocking a reply for an unbounded time.
 *   - On an observed 429 the ceilings TIGHTEN multiplicatively (AIMD) for
 *     `tightenMs`, then restore. `retry-api-call.ts` sleeps `retry_after` and
 *     resumes at FULL rate; nothing in the stack previously reduced the
 *     sustained rate after a soft 429.
 *
 * This is a fuse, not a scheduler: it sits ABOVE every legitimate cadence in
 * the codebase (the worker feed's own floor is 2500ms ⇒ ≤24 edits/min across
 * a whole chat, and the send gate's cosmetic budget is 30/min per message)
 * and only binds when something has genuinely run away.
 */

import type { Bot } from 'grammy'

import type { Clock } from './send-gate.js'
import { systemClock } from './send-gate.js'

/** Methods that mutate an EXISTING message — droppable, coalescible. */
const EDIT_METHODS: ReadonlySet<string> = new Set([
  'editMessageText',
  'editMessageCaption',
  'editMessageMedia',
  'editMessageReplyMarkup',
  'editMessageLiveLocation',
])

/** Methods that CREATE user-visible output — paced, never dropped. */
const SEND_METHODS: ReadonlySet<string> = new Set([
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendMediaGroup', 'sendAnimation',
  'sendVideo', 'sendVoice', 'sendAudio', 'sendSticker', 'sendLocation',
  'forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages',
])

export interface EditFloodFuseConfig {
  /** Master switch. When false, `apply` is a pure passthrough. Default true. */
  enabled?: boolean
  clock?: Clock
  /** Hard ceiling on edits to ONE message id. Default 20 per 60s. */
  perMessageMaxPerWindow?: number
  perMessageWindowMs?: number
  /** Hard ceiling on edits to ONE chat across all messages. Default 30 per 60s. */
  perChatEditMaxPerWindow?: number
  /** Pacing ceiling on non-edit sends to ONE chat. Default 25 per 60s. */
  perChatSendMaxPerWindow?: number
  perChatWindowMs?: number
  /** Longest a call may be held before it is dropped (edit) / released (send). Default 30s. */
  maxDeferMs?: number
  /** Multiplicative decrease applied to every ceiling after a 429. Default 0.5. */
  tightenFactor?: number
  /** How long a tightened ceiling stays in force. Default 10 minutes. */
  tightenMs?: number
  /** Observability hook; fired whenever the fuse binds. */
  onTrip?: (info: { method: string; key: string; action: 'deferred' | 'dropped' | 'superseded' }) => void
}

export interface EditFloodFuseStats {
  enabled: boolean
  /** Calls the fuse held back waiting for a window to slide. */
  deferred: number
  /** Edits dropped because the window never opened inside `maxDeferMs`. */
  dropped: number
  /** Edits dropped because a NEWER edit to the same message arrived. */
  superseded: number
  /** 429s observed (each one tightens the ceilings). */
  floodObserved: number
  /** Whether a tightened ceiling is in force right now. */
  tightened: boolean
  /** Live per-message ceiling (post-AIMD). */
  perMessageCeiling: number
}

export const EDIT_FLOOD_FUSE_DEFAULTS = {
  perMessageMaxPerWindow: 20,
  perMessageWindowMs: 60_000,
  perChatEditMaxPerWindow: 30,
  perChatSendMaxPerWindow: 25,
  perChatWindowMs: 60_000,
  maxDeferMs: 30_000,
  tightenFactor: 0.5,
  tightenMs: 600_000,
} as const

/** grammY resolves an edit with `true` when there is nothing to return. */
const DROPPED_RESULT = true

interface Window {
  ts: number[]
  /** The newest waiter on this key; a fresh waiter supersedes it. */
  waiter: { kill: () => void } | null
}

/**
 * The fuse as a pure, clock-injectable unit. `apply` has the grammY
 * transformer shape so it can be handed straight to `bot.api.config.use`.
 */
export function createEditFloodFuse(config: EditFloodFuseConfig = {}) {
  const enabled = config.enabled ?? true
  const clock = config.clock ?? systemClock
  const D = EDIT_FLOOD_FUSE_DEFAULTS
  const perMessageMax = config.perMessageMaxPerWindow ?? D.perMessageMaxPerWindow
  const perMessageWindowMs = config.perMessageWindowMs ?? D.perMessageWindowMs
  const perChatEditMax = config.perChatEditMaxPerWindow ?? D.perChatEditMaxPerWindow
  const perChatSendMax = config.perChatSendMaxPerWindow ?? D.perChatSendMaxPerWindow
  const perChatWindowMs = config.perChatWindowMs ?? D.perChatWindowMs
  const maxDeferMs = config.maxDeferMs ?? D.maxDeferMs
  const tightenFactor = config.tightenFactor ?? D.tightenFactor
  const tightenMs = config.tightenMs ?? D.tightenMs
  const onTrip = config.onTrip

  const windows = new Map<string, Window>()
  const counters = { deferred: 0, dropped: 0, superseded: 0, floodObserved: 0 }
  /** Timestamp until which the AIMD tightening is in force (0 = untightened). */
  let tightenedUntil = 0

  function isTightened(now: number): boolean {
    return tightenedUntil > now
  }

  /**
   * AIMD multiplicative decrease. Applied to every ceiling while tightened;
   * floored at 1 so the fuse never deadlocks a surface completely.
   */
  function ceiling(base: number, now: number): number {
    if (!isTightened(now)) return base
    return Math.max(1, Math.floor(base * tightenFactor))
  }

  function win(key: string): Window {
    let w = windows.get(key)
    if (w === undefined) {
      w = { ts: [], waiter: null }
      windows.set(key, w)
    }
    return w
  }

  function prune(w: Window, now: number, windowMs: number): void {
    const cutoff = now - windowMs
    while (w.ts.length > 0 && w.ts[0]! <= cutoff) w.ts.shift()
  }

  /**
   * Bounded LRU-ish eviction so a long-lived process cannot grow the map
   * without limit. A window with no in-flight waiter and no timestamps inside
   * the widest window is dead state.
   */
  function evict(now: number): void {
    if (windows.size < 4096) return
    const widest = Math.max(perMessageWindowMs, perChatWindowMs)
    for (const [k, w] of windows) {
      if (w.waiter === null && (w.ts.length === 0 || w.ts[w.ts.length - 1]! <= now - widest)) {
        windows.delete(k)
      }
    }
  }

  /** ms until `w` has room, or 0 if it has room now. */
  function waitFor(w: Window, now: number, windowMs: number, max: number): number {
    prune(w, now, windowMs)
    if (w.ts.length < max) return 0
    return Math.max(1, w.ts[0]! + windowMs - now)
  }

  function payloadKeys(payload: unknown): { chat: string | null; msg: string | null } {
    const p = (payload ?? {}) as Record<string, unknown>
    const chat = p.chat_id != null ? String(p.chat_id) : null
    const msg = p.message_id != null ? String(p.message_id) : null
    return { chat, msg }
  }

  /** Record a 429 (whatever shape it arrives in) and tighten. */
  function noteFlood(now: number): void {
    counters.floodObserved++
    tightenedUntil = now + tightenMs
  }

  function looksLikeFlood(err: unknown): boolean {
    const e = err as { error_code?: number; parameters?: { retry_after?: number } } | null
    if (e != null && typeof e === 'object') {
      if (e.error_code === 429) return true
      if (e.parameters != null && typeof e.parameters.retry_after === 'number') return true
    }
    const msg = err instanceof Error ? err.message : String(err ?? '')
    return /\b429\b/.test(msg) || /too many requests/i.test(msg) || /retry after/i.test(msg)
  }

  /** Give back a slot reserved by `awaitRoom` (used when a later tier denies). */
  function unreserve(key: string, at: number): void {
    const w = windows.get(key)
    if (w === undefined) return
    const i = w.ts.lastIndexOf(at)
    if (i >= 0) w.ts.splice(i, 1)
  }

  /**
   * Wait for room on `key` and RESERVE the slot on success. Reserving inside
   * the same synchronous step as the check is what makes the ceiling hold
   * under concurrency: N producers that all pass a check-then-act test in the
   * same tick would each admit, and N parallel sub-agents is exactly the shape
   * that turns a ceiling into N× the ceiling.
   *
   * Returns the reserved timestamp, or null when the call must be dropped.
   */
  async function awaitRoom(
    key: string, windowMs: number, max: number, method: string, supersedable: boolean,
  ): Promise<number | null> {
    const w = win(key)
    const deadline = clock.now() + maxDeferMs
    let counted = false
    for (;;) {
      const now = clock.now()
      const wait = waitFor(w, now, windowMs, ceiling(max, now))
      if (wait === 0) {
        w.ts.push(now)
        return now
      }
      if (now >= deadline) {
        // Held as long as we are willing to hold. An edit is dropped (the next
        // render carries full state); a send is released (losing a reply is
        // worse than a late one).
        if (supersedable) {
          counters.dropped++
          onTrip?.({ method, key, action: 'dropped' })
          return null
        }
        // A send is released rather than dropped, and still takes a slot so
        // the window reflects what actually went out.
        w.ts.push(now)
        return now
      }
      if (!counted) {
        counters.deferred++
        counted = true
        onTrip?.({ method, key, action: 'deferred' })
      }
      // Last-write-wins: a newer edit to the same message kills this one.
      let killed = false
      if (supersedable) {
        w.waiter?.kill()
        const superseded = new Promise<void>((resolve) => {
          w.waiter = { kill: () => { killed = true; resolve() } }
        })
        await Promise.race([clock.sleep(Math.min(wait, deadline - now)), superseded])
        if (killed) {
          counters.superseded++
          onTrip?.({ method, key, action: 'superseded' })
          return null
        }
        w.waiter = null
      } else {
        await clock.sleep(Math.min(wait, deadline - now))
      }
    }
  }

  /** The grammY transformer body. */
  async function apply<R>(
    method: string,
    payload: unknown,
    next: () => Promise<R>,
  ): Promise<R> {
    if (!enabled) return next()

    const isEdit = EDIT_METHODS.has(method)
    const isSend = SEND_METHODS.has(method)
    if (!isEdit && !isSend) return runObserved(next)

    const { chat, msg } = payloadKeys(payload)
    // Inline-message edits carry no chat/message id — nothing to key on, and
    // they are not part of any card loop. Pass through (still observed).
    if (chat == null) return runObserved(next)

    const now = clock.now()
    evict(now)

    if (isEdit) {
      if (msg == null) return runObserved(next)
      const msgKey = `m:${chat}:${msg}`
      const msgSlot = await awaitRoom(msgKey, perMessageWindowMs, perMessageMax, method, true)
      if (msgSlot === null) return DROPPED_RESULT as unknown as R
      const chatKey = `ce:${chat}`
      const chatSlot = await awaitRoom(chatKey, perChatWindowMs, perChatEditMax, method, true)
      if (chatSlot === null) {
        // Denied by the second tier — hand the first tier's slot back so a
        // dropped edit never consumes budget it did not use.
        unreserve(msgKey, msgSlot)
        return DROPPED_RESULT as unknown as R
      }
      return runObserved(next)
    }

    const chatKey = `cs:${chat}`
    await awaitRoom(chatKey, perChatWindowMs, perChatSendMax, method, false)
    return runObserved(next)
  }

  /** Run the downstream call, tightening the ceilings if it floods. */
  async function runObserved<R>(next: () => Promise<R>): Promise<R> {
    try {
      const res = await next()
      // grammY throws on ok:false, but a transformer installed BELOW another
      // one can still observe a raw ApiResponse — handle both shapes.
      const r = res as unknown as { ok?: boolean; error_code?: number }
      if (r != null && typeof r === 'object' && r.ok === false && r.error_code === 429) {
        noteFlood(clock.now())
      }
      return res
    } catch (err) {
      if (looksLikeFlood(err)) noteFlood(clock.now())
      throw err
    }
  }

  function stats(): EditFloodFuseStats {
    const now = clock.now()
    return {
      enabled,
      deferred: counters.deferred,
      dropped: counters.dropped,
      superseded: counters.superseded,
      floodObserved: counters.floodObserved,
      tightened: isTightened(now),
      perMessageCeiling: ceiling(perMessageMax, now),
    }
  }

  return { apply, stats }
}

export type EditFloodFuse = ReturnType<typeof createEditFloodFuse>

/**
 * The bot handle the fuse installs on. Typed against grammY's own `Bot` so the
 * transformer signature is checked by the compiler, not by convention.
 */
export type FuseInstallable = Bot

export function installEditFloodFuse(bot: FuseInstallable, config: EditFloodFuseConfig = {}): EditFloodFuse {
  const fuse = createEditFloodFuse(config)
  bot.api.config.use(async (prev, method, payload, signal) =>
    fuse.apply(method, payload, () => prev(method, payload, signal)))
  return fuse
}
