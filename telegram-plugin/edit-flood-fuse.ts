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
 * ── Where the ceiling actually sits (review 2026-07-26, R1) ───────────────
 * An earlier draft of this docblock claimed the fuse "sits ABOVE every
 * legitimate cadence". That is FALSE and the claim mattered, so it is
 * corrected here rather than deleted. The in-repo cadences are:
 *
 *   - send gate `editFloorMs` = 1500ms          ⇒ up to 40 edits/min/message
 *   - send gate cosmetic budget 150 / 300s      ⇒ 30 edits/min/message
 *   - worker feed's own floor 2500ms            ⇒ 24 edits/min/message
 *   - gateway `FEED_HEARTBEAT_TICK_MS` = 6000ms ⇒ 10 repaints/min/turn
 *
 * The fuse's cosmetic ceilings sit BELOW all of these. That is deliberate —
 * Telegram's own per-group limit is ~20 messages/minute and edits count
 * against it, so the *legitimate* cadences are themselves above what
 * Telegram tolerates; that is precisely how `overlord` got banned while
 * every in-repo pacer believed it was behaving. The fuse is therefore the
 * BINDING constraint on a hot card, not a never-reached backstop.
 *
 * Because it binds routinely, "over budget" must never mean "silently
 * lost". Two rules follow, and both are load-bearing:
 *   - per-MESSAGE over-budget edits SUPERSEDE (newest wins, older frame is
 *     discarded) — safe, because the frame that killed it will paint;
 *   - per-CHAT over-budget edits may only be DROPPED while a NEWER frame for
 *     that same message is still in flight to repaint it. When the waiting
 *     frame is the only one for its card (a turn-final `finalize`, say) it is
 *     RELEASED late instead of dropped. Dropping it would freeze the card
 *     mid-run AND return `true` to the send gate, which would then record a
 *     never-painted payload as on-screen and no-op-skip every retry.
 *
 * ── 2026-07-27: the fuse existed and the ban happened anyway ──────────────
 * The ceilings above were sized against the in-repo pacers, not against what
 * Telegram actually tolerates. Agent `overlord` then sustained ~17
 * `editMessageText`/min on ONE DM chat for hours (326 edits against 6 real
 * replies in the final 20 minutes) and took a **15908-second** flood ban that
 * severed every outbound reply. Both original ceilings — 20 edits/60s per
 * message, 30 edits/60s per chat — sat ABOVE that observed rate, so the fuse
 * never bound once. Three structural changes follow, and each is a separate,
 * independently-sufficient reason the same incident cannot recur:
 *
 *   1. **Class awareness.** The fuse now reads the send gate's priority class
 *      off `outbound-class.ts` (AsyncLocalStorage). `cosmetic` traffic — every
 *      activity/worker/liveness repaint — is governed by its own, much tighter
 *      ceilings; `useful` / `critical` edits (approval cards, answers) are not
 *      throttled by them. Previously the fuse was class-blind and had to pick
 *      one number for both, which is why the number was too high.
 *   2. **A hard cosmetic rate ceiling.** 4 edits/60s per message (one per 15s,
 *      matching the worker feed's own `elapsedRefreshMs`) and 6 edits/60s per
 *      chat across ALL cosmetic surfaces. 6/min is below the ~4-6/min band the
 *      live chat survived for hours and far below the 15-17/min that earned
 *      the ban. Coalescing (supersede) means the card still shows CURRENT
 *      state at every permitted edit — the operator loses refresh frequency,
 *      never accuracy.
 *   3. **A shared per-chat budget with a reply reservation.** Telegram meters
 *      sends and edits against the SAME per-chat allowance, so separate
 *      edit/send windows could each be "in budget" while their sum was not.
 *      One `perChatTotalMaxPerWindow` window (default 20/60s) now counts
 *      every admitted call, and `perChatReplyReserve` (default 8) slots of it
 *      are unreachable by `cosmetic` traffic. A reply therefore cannot be
 *      starved by repaints even if a future call site is misclassified.
 *
 * Plus **escalating** backoff: a 429 used to apply ONE 0.5× tightening for a
 * flat 10 minutes, so a stream that took repeated small 429s re-tightened to
 * the same level forever and walked into the big ban. Tightening is now
 * multiplicative PER 429 (`tightenFactor ^ level`, level capped by
 * `maxTightenLevel`) and decays one level at a time, so sustained pressure
 * ratchets the cosmetic rate down towards the floor of 1/window.
 *
 * Every ceiling is operator-overridable via env — see
 * {@link editFloodFuseConfigFromEnv}. Previously none of them were.
 */

import type { Bot } from 'grammy'

import type { Clock } from './send-gate.js'
import { systemClock } from './send-gate.js'
import {
  currentOutboundClass,
  defaultOutboundClass,
  type OutboundClass,
} from './outbound-class.js'

/** Methods that mutate an EXISTING message — droppable, coalescible. */
const EDIT_METHODS: ReadonlySet<string> = new Set([
  'editMessageText',
  'editMessageCaption',
  'editMessageMedia',
  'editMessageReplyMarkup',
  'editMessageLiveLocation',
  // Review 2026-07-26 (R2): the checklist tools drive this one exactly like a
  // card — `update_checklist` re-edits ONE message id in a loop
  // (gateway.ts `_rawEditMessageChecklist`, called through `bot.api.raw`, which
  // grammY routes through the transformer stack like everything else). Omitting
  // it left a same-shaped flood path completely unfused.
  'editMessageChecklist',
])

/** Methods that CREATE user-visible output — paced, never dropped. */
const SEND_METHODS: ReadonlySet<string> = new Set([
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendMediaGroup', 'sendAnimation',
  'sendVideo', 'sendVoice', 'sendAudio', 'sendSticker', 'sendLocation',
  'forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages',
  // Review 2026-07-26 (R3): `sendRichMessage` is the plugin's PRIMARY send —
  // every rich reply, every activity-card OPEN, every stream finalisation goes
  // through it (`rich-send.ts`, `narrative-lane.ts`, `stream-render.ts`).
  // Leaving it out meant the "non-edit sends are paced" property applied to
  // almost nothing that this gateway actually sends. Sends are never dropped,
  // so this only ever adds a bounded (`maxDeferMs`) delay under real pressure.
  // NOTE: `sendRichMessageDraft` is deliberately NOT here — an ephemeral
  // 30s-preview draft is high-cadence by design and is not a persisted message.
  'sendRichMessage',
])

export interface EditFloodFuseConfig {
  /** Master switch. When false, `apply` is a pure passthrough. Default true. */
  enabled?: boolean
  clock?: Clock
  /**
   * Hard ceiling on NON-cosmetic (`useful` / `critical`) edits to ONE message
   * id. Default 20 per 60s. Approval cards and answer finalisations live here;
   * they are low-cadence by nature, so this stays a backstop, not a pacer.
   */
  perMessageMaxPerWindow?: number
  perMessageWindowMs?: number
  /** Hard ceiling on ALL edits to ONE chat across all messages. Default 30 per 60s. */
  perChatEditMaxPerWindow?: number
  /** Pacing ceiling on non-edit sends to ONE chat. Default 25 per 60s. */
  perChatSendMaxPerWindow?: number
  /**
   * ADDITIONAL ceiling applied to COSMETIC edits of ONE message id, on top of
   * `perMessageMaxPerWindow` (the effective ceiling is the lower of the two).
   * Default 4 per 60s — one per 15s, matching the worker feed's
   * `elapsedRefreshMs`. This is the number that bounds a hot progress card.
   */
  cosmeticPerMessageMaxPerWindow?: number
  /**
   * ADDITIONAL ceiling applied to COSMETIC edits in ONE chat, summed across
   * every cosmetic surface in it (lower of this and `perChatEditMaxPerWindow`
   * binds). Default 6 per 60s. Without it, N concurrent cards each inside their
   * own per-message ceiling still add up to a flood.
   */
  cosmeticPerChatMaxPerWindow?: number
  /**
   * Shared per-chat allowance counting EVERY admitted call — edits and sends,
   * every class. Default 20 per 60s, matching Telegram's own per-chat/group
   * metering (which does not separate the two). Sends and non-cosmetic edits
   * are paced against it and never dropped.
   */
  perChatTotalMaxPerWindow?: number
  /**
   * Slots of `perChatTotalMaxPerWindow` that `cosmetic` traffic may NEVER
   * consume. Default 8. This is the reply-starvation guarantee: whatever the
   * repaint surfaces do, at least this many calls per window remain available
   * to an actual answer.
   */
  perChatReplyReserve?: number
  /**
   * Cap on COSMETIC edits that may be released late (over budget) because
   * nothing newer will repaint them — the bounded form of the R1 rule. Default
   * 2 per `perChatWindowMs`, so the worst-case sustained cosmetic rate is
   * `cosmeticPerChatMaxPerWindow + lateReleaseMaxPerWindow`.
   */
  lateReleaseMaxPerWindow?: number
  perChatWindowMs?: number
  /** Longest a call may be held before it is dropped (edit) / released (send). Default 30s. */
  maxDeferMs?: number
  /** Multiplicative decrease applied per observed 429. Default 0.5. */
  tightenFactor?: number
  /** How long ONE level of tightening stays in force before decaying. Default 10 minutes. */
  tightenMs?: number
  /** Cap on compounding 429 tightening levels. Default 4 (⇒ 0.5^4 = 1/16). */
  maxTightenLevel?: number
  /** Observability hook; fired whenever the fuse binds. */
  onTrip?: (info: {
    method: string
    key: string
    action: 'deferred' | 'dropped' | 'superseded'
    cls: OutboundClass
  }) => void
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
  /** Compounding 429 tightening level currently in force (0 = untightened). */
  tightenLevel: number
  /** Live NON-cosmetic per-message ceiling (post-AIMD). */
  perMessageCeiling: number
  /** Live COSMETIC per-message ceiling (post-AIMD) — the incident-relevant one. */
  cosmeticPerMessageCeiling: number
  /** Live COSMETIC per-chat ceiling (post-AIMD). */
  cosmeticPerChatCeiling: number
}

export const EDIT_FLOOD_FUSE_DEFAULTS = {
  perMessageMaxPerWindow: 20,
  perMessageWindowMs: 60_000,
  perChatEditMaxPerWindow: 30,
  perChatSendMaxPerWindow: 25,
  /**
   * 4/60s. One cosmetic repaint per 15s per card. Chosen to equal the worker
   * feed's `elapsedRefreshMs` (15000) — the slowest cadence at which the feed
   * itself considers a repaint worth making — so the fuse binds the runaway
   * case without ever throttling the feed's own intended pace.
   */
  cosmeticPerMessageMaxPerWindow: 4,
  /**
   * 6/60s across every cosmetic surface in a chat. The incident's own timeline
   * is the evidence: 10-minute buckets of 58/53/41 edits (≈4-6/min) ran for
   * hours without a ban; 115/78/73 then 152/174 (≈8-17/min) earned one. 6/min
   * sits at the top of the survived band and less than half the banned rate.
   */
  cosmeticPerChatMaxPerWindow: 6,
  /**
   * 20/60s. Telegram's documented per-group ceiling, and it meters sends and
   * edits together — so this is the only window that reflects the real budget.
   */
  perChatTotalMaxPerWindow: 20,
  /** 8 of those 20 slots/min are unreachable by cosmetic traffic. */
  perChatReplyReserve: 8,
  /** At most 2 cosmetic frames/min may exceed the ceiling as "lone" releases. */
  lateReleaseMaxPerWindow: 2,
  perChatWindowMs: 60_000,
  maxDeferMs: 30_000,
  tightenFactor: 0.5,
  tightenMs: 600_000,
  maxTightenLevel: 4,
} as const

/** Parse a positive integer from env, or undefined when unset/invalid. */
function envInt(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/**
 * Operator config surface. Before the 2026-07-27 incident the fuse had exactly
 * one knob — `SWITCHROOM_EDIT_FUSE=0`, which turns the whole failsafe OFF —
 * so an operator whose chat was being flooded had no way to tighten it and no
 * way to loosen it for a chat that could take more. Every ceiling is now
 * overridable; unset values keep the defaults above.
 */
export function editFloodFuseConfigFromEnv(
  env: Record<string, string | undefined>,
): EditFloodFuseConfig {
  const cfg: EditFloodFuseConfig = { enabled: env.SWITCHROOM_EDIT_FUSE !== '0' }
  const assign = <K extends keyof EditFloodFuseConfig>(k: K, v: number | undefined): void => {
    if (v !== undefined) (cfg[k] as number) = v
  }
  assign('cosmeticPerMessageMaxPerWindow', envInt(env.SWITCHROOM_FEED_EDIT_MAX_PER_MSG_PER_MIN))
  assign('cosmeticPerChatMaxPerWindow', envInt(env.SWITCHROOM_FEED_EDIT_MAX_PER_CHAT_PER_MIN))
  assign('perChatTotalMaxPerWindow', envInt(env.SWITCHROOM_CHAT_TOTAL_MAX_PER_MIN))
  assign('perChatReplyReserve', envInt(env.SWITCHROOM_CHAT_REPLY_RESERVE))
  assign('maxDeferMs', envInt(env.SWITCHROOM_EDIT_FUSE_MAX_DEFER_MS))
  return cfg
}

/** grammY resolves an edit with `true` when there is nothing to return. */
const DROPPED_RESULT = true

interface Window {
  ts: number[]
  /** The newest waiter on this key; a fresh waiter supersedes it. */
  waiter: { kill: () => void } | null
  /**
   * How many calls for this key are currently inside `apply` (per-MESSAGE keys
   * only). Read at the per-chat defer deadline: dropping is only honest while
   * a NEWER frame for the same message is still in flight to repaint. See the
   * docblock's "Where the ceiling actually sits" (R1).
   */
  inflight: number
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
  // Cosmetic tiers are an ADDITIONAL constraint on the same window keys, so the
  // effective ceiling is the lower of the two. Folding them in here (rather
  // than as extra tiers) keeps the admission path at the same number of awaits.
  const cosmeticPerMessageMax = Math.min(
    perMessageMax, config.cosmeticPerMessageMaxPerWindow ?? D.cosmeticPerMessageMaxPerWindow)
  const cosmeticPerChatMax = Math.min(
    perChatEditMax, config.cosmeticPerChatMaxPerWindow ?? D.cosmeticPerChatMaxPerWindow)
  const perChatTotalMax = config.perChatTotalMaxPerWindow ?? D.perChatTotalMaxPerWindow
  const perChatWindowMs = config.perChatWindowMs ?? D.perChatWindowMs
  // Clamped so a misconfigured reserve can never make the cosmetic allowance
  // negative (deadlocking every card) or eat the whole budget.
  const perChatReplyReserve = Math.min(
    Math.max(0, config.perChatReplyReserve ?? D.perChatReplyReserve),
    Math.max(0, perChatTotalMax - 1),
  )
  const lateReleaseMax = Math.max(0, config.lateReleaseMaxPerWindow ?? D.lateReleaseMaxPerWindow)
  const maxDeferMs = config.maxDeferMs ?? D.maxDeferMs
  const tightenFactor = config.tightenFactor ?? D.tightenFactor
  const tightenMs = config.tightenMs ?? D.tightenMs
  const maxTightenLevel = Math.max(0, config.maxTightenLevel ?? D.maxTightenLevel)
  const onTrip = config.onTrip

  const windows = new Map<string, Window>()
  const counters = { deferred: 0, dropped: 0, superseded: 0, floodObserved: 0 }
  /**
   * Compounding 429 backoff. `tightenLevel` is the number of multiplicative
   * decreases currently in force; `tightenedUntil` is when the NEXT level
   * decays. A single flat tightening (the pre-2026-07-27 behaviour) let a
   * stream that kept taking small 429s sit at 0.5× indefinitely and walk into
   * a long ban; escalating means repeated 429s ratchet the rate down.
   */
  let tightenLevel = 0
  let tightenedUntil = 0

  /** Decay one level per `tightenMs` of quiet, rather than a single cliff. */
  function levelAt(now: number): number {
    if (tightenLevel === 0) return 0
    while (tightenLevel > 0 && tightenedUntil <= now) {
      tightenLevel--
      tightenedUntil = tightenLevel > 0 ? tightenedUntil + tightenMs : 0
    }
    return tightenLevel
  }

  function isTightened(now: number): boolean {
    return levelAt(now) > 0
  }

  /**
   * AIMD multiplicative decrease, compounding per observed 429. Applied to
   * every ceiling while tightened; floored at 1 so the fuse never deadlocks a
   * surface completely.
   */
  function ceiling(base: number, now: number): number {
    const level = levelAt(now)
    if (level === 0) return base
    return Math.max(1, Math.floor(base * Math.pow(tightenFactor, level)))
  }

  function win(key: string): Window {
    let w = windows.get(key)
    if (w === undefined) {
      w = { ts: [], waiter: null, inflight: 0 }
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
  let sinceEvict = 0
  function evict(now: number): void {
    if (windows.size < 4096) return
    // Sweep at most once per 1024 admissions: an unconditional sweep would be
    // O(n) on EVERY outbound call once the map is large, i.e. the fuse itself
    // would become the latency problem it exists to prevent.
    if (++sinceEvict < 1024) return
    sinceEvict = 0
    const widest = Math.max(perMessageWindowMs, perChatWindowMs)
    for (const [k, w] of windows) {
      // `inflight > 0` keeps a key whose caller is mid-wait: evicting it would
      // hand that caller a stale Window object while a FRESH one (empty `ts`)
      // took its place in the map, resetting the ceiling for everyone else.
      if (w.waiter === null && w.inflight === 0
        && (w.ts.length === 0 || w.ts[w.ts.length - 1]! <= now - widest)) {
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

  /** Record a 429 (whatever shape it arrives in) and tighten one more level. */
  function noteFlood(now: number): void {
    counters.floodObserved++
    levelAt(now)
    tightenLevel = Math.min(maxTightenLevel, tightenLevel + 1)
    // Every level currently in force is re-armed for a full `tightenMs`; the
    // decay clock restarts from the newest 429, not from the first.
    tightenedUntil = now + tightenMs
  }

  function looksLikeFlood(err: unknown): boolean {
    const e = err as { error_code?: number; parameters?: { retry_after?: number } } | null
    if (e != null && typeof e === 'object') {
      if (e.error_code === 429) return true
      if (e.parameters != null && typeof e.parameters.retry_after === 'number') return true
    }
    // Match on the SEMANTIC markers only. A bare "429" substring
    // false-positives on ordinary server text (e.g. "message 429 not found"),
    // and a false positive here halves every ceiling for ten minutes.
    const msg = err instanceof Error ? err.message : String(err ?? '')
    return /too many requests/i.test(msg) || /retry[ _-]?after/i.test(msg)
  }

/**
   * How a call that finds no room behaves:
   *   supersede — per-message edits: a newer edit to the SAME message kills it
   *   drop      — per-chat edits: waits, then drops at the defer deadline
   *   release   — sends: waits, then passes through (never lost)
   */
  type WaitMode = 'supersede' | 'drop' | 'release'

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
    key: string, windowMs: number, max: number, method: string, mode: WaitMode, cls: OutboundClass,
    /**
     * Consulted ONLY at the defer deadline for `mode: 'drop'`. Returning false
     * converts the drop into a late release: this call is the last thing that
     * will ever paint its message, so losing it is not "shedding a stale
     * frame", it is freezing a card. Absent ⇒ drop unconditionally (the
     * pre-review behaviour).
     */
    dropGuard: (() => boolean) | undefined,
    /**
     * Absolute deadline SHARED by every tier of one `apply` call. Each tier
     * used to start its own `maxDeferMs`, so a call crossing three tiers could
     * be held 3×`maxDeferMs` — an unbounded-in-practice hold that a caller's
     * own timeout, not this fuse, would have to end. One deadline per call
     * makes `maxDeferMs` mean what it says.
     */
    deadline: number,
    /**
     * Bounded overshoot budget for the R1 late-release path (cosmetic edits
     * only). R1 says an over-budget edit that nothing newer will repaint must
     * be RELEASED late rather than dropped, so a card cannot freeze mid-run.
     * Taken literally that rule has no ceiling: a stream of cosmetic edits to
     * DISTINCT message ids is a stream of "lone" frames, every one of which
     * releases over budget — which is how 6 concurrent worker cards can sail
     * past a 6/min chat ceiling. Charging each late release to a small extra
     * window keeps R1's guarantee for the rare genuinely-lone frame (a
     * worker's terminal recap) while capping the leak at `lateReleaseMax` per
     * window. Absent ⇒ unbounded late release (sends, non-cosmetic edits).
     */
    lateReleaseKey?: string,
  ): Promise<number | null> {
    const w = win(key)
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
        if (mode !== 'release' && (dropGuard === undefined || dropGuard())) {
          counters.dropped++
          onTrip?.({ method, key, action: 'dropped', cls })
          return null
        }
        // A send — or an edit that nothing newer will repaint — is released
        // rather than dropped, and still takes a slot so the window reflects
        // what actually went out. Cosmetic late releases are additionally
        // charged to the bounded overshoot budget; when that is exhausted the
        // frame is dropped after all, so the ceiling cannot be walked past one
        // "lone" frame at a time.
        if (lateReleaseKey !== undefined) {
          const lw = win(lateReleaseKey)
          prune(lw, now, perChatWindowMs)
          if (lw.ts.length >= ceiling(lateReleaseMax, now)) {
            counters.dropped++
            onTrip?.({ method, key, action: 'dropped', cls })
            return null
          }
          lw.ts.push(now)
        }
        w.ts.push(now)
        return now
      }
      if (!counted) {
        counters.deferred++
        counted = true
        onTrip?.({ method, key, action: 'deferred', cls })
      }
      // Last-write-wins: a newer edit to the same message kills this one. Only
      // valid on the per-MESSAGE tier — on a per-chat key the "newer" edit is
      // usually to a DIFFERENT message, and killing an unrelated card's edit is
      // not last-write-wins, it is data loss.
      let killed = false
      if (mode === 'supersede') {
        w.waiter?.kill()
        const superseded = new Promise<void>((resolve) => {
          w.waiter = { kill: () => { killed = true; resolve() } }
        })
        await Promise.race([clock.sleep(Math.min(wait, deadline - now)), superseded])
        if (killed) {
          counters.superseded++
          onTrip?.({ method, key, action: 'superseded', cls })
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
    // ONE deadline for the whole call, shared by every tier it crosses.
    const deadline = now + maxDeferMs

    // The send gate's priority class, propagated through AsyncLocalStorage.
    // An untagged edit is COSMETIC by default — see `defaultOutboundClass`.
    const cls = currentOutboundClass() ?? defaultOutboundClass(isEdit)
    const totalKey = `t:${chat}`
    // Cosmetic traffic may only reach `perChatTotalMax - perChatReplyReserve`;
    // the remaining slots stay available to a real reply no matter how hot the
    // repaint surfaces are. This reservation is the reply-starvation guarantee.
    const totalMaxFor = (c: OutboundClass): number =>
      c === 'cosmetic' ? Math.max(1, perChatTotalMax - perChatReplyReserve) : perChatTotalMax

    if (isEdit) {
      if (msg == null) return runObserved(next)
      const msgKey = `m:${chat}:${msg}`
      const mw = win(msgKey)
      // Counted BEFORE the first await so a frame that arrives while an older
      // one is waiting is visible to that older one's `dropGuard`.
      mw.inflight++
      try {
        const msgSlot = await awaitRoom(
          msgKey, perMessageWindowMs,
          cls === 'cosmetic' ? cosmeticPerMessageMax : perMessageMax,
          method, 'supersede', cls, undefined, deadline,
        )
        if (msgSlot === null) return DROPPED_RESULT as unknown as R
        // R1: only drop while something newer for THIS message is still in
        // flight to repaint it. `> 1` = this frame plus at least one newer.
        const dropGuard = (): boolean => mw.inflight > 1
        // Cosmetic frames share ONE overshoot budget per chat across both
        // per-chat tiers, so a frame cannot late-release twice on its way out.
        const lateKey = cls === 'cosmetic' ? `lr:${chat}` : undefined
        const reserved: Array<[string, number]> = [[msgKey, msgSlot]]
        const giveBack = (): void => { for (const [k, at] of reserved) unreserve(k, at) }

        const chatKey = `ce:${chat}`
        const chatSlot = await awaitRoom(
          chatKey, perChatWindowMs,
          cls === 'cosmetic' ? cosmeticPerChatMax : perChatEditMax,
          method, 'drop', cls, dropGuard, deadline, lateKey,
        )
        if (chatSlot === null) { giveBack(); return DROPPED_RESULT as unknown as R }
        reserved.push([chatKey, chatSlot])

        // Shared per-chat budget — the one that mirrors Telegram's real
        // metering. A non-cosmetic edit is RELEASED late rather than dropped:
        // an approval card or answer finalisation has no newer frame coming.
        const totalSlot = await awaitRoom(
          totalKey, perChatWindowMs, totalMaxFor(cls), method,
          cls === 'cosmetic' ? 'drop' : 'release', cls, dropGuard, deadline, lateKey,
        )
        if (totalSlot === null) { giveBack(); return DROPPED_RESULT as unknown as R }
        return runObserved(next)
      } finally {
        mw.inflight--
      }
    }

    // Sends create user-visible output and are NEVER dropped — only paced. The
    // shared budget's reserve is what guarantees they still have room when the
    // repaint surfaces are saturated.
    await awaitRoom(`cs:${chat}`, perChatWindowMs, perChatSendMax, method, 'release', cls, undefined, deadline)
    await awaitRoom(totalKey, perChatWindowMs, totalMaxFor(cls), method, 'release', cls, undefined, deadline)
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
      tightenLevel: levelAt(now),
      perMessageCeiling: ceiling(perMessageMax, now),
      cosmeticPerMessageCeiling: ceiling(cosmeticPerMessageMax, now),
      cosmeticPerChatCeiling: ceiling(cosmeticPerChatMax, now),
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
