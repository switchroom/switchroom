/**
 * user-failure-notices.ts — gateway-side handling of the plain-language
 * "couldn't complete that" user notice, plus the `transport-transient`
 * classifier kind (a mid-response stream abort reaching Anthropic).
 *
 * Two concerns, one subsystem (the plain user-failure-notice send side):
 *
 *  1. `emitTransportTransientEvent` — the calm path for a `transport-transient`
 *     operator event. Claude Code emits `error: "server_error"` with NO HTTP
 *     status on a mid-response stream abort; that is a transport failure, not an
 *     account/auth/quota fault, and Claude retries it internally. So there is NO
 *     broadcast card (a Reauth card would be the wrong remedy and reach every
 *     chat). Instead: record for `/status` history, and DEFER one plain user
 *     notice to the turn-end gate (`pending-user-notice.ts`) so a genuinely
 *     reply-less dead turn still gets one calm line while a recovered retry
 *     sends nothing. A BURST — >=3 terminal transport-transient events for one
 *     agent within ~10min — escalates to exactly ONE operator-only, Dismiss-only
 *     card ("repeated stream failures reaching Anthropic"), so honest
 *     suppression never hides a genuinely degraded pipe.
 *
 *  2. `flushDeferredUserNotices` — the turn-end send loop for notices the gate
 *     released (moved here from the gateway; see #3293 finding 1).
 *
 * Pure orchestration: every side effect (record, schedule, resolve, send, log,
 * clock) crosses in through `UserFailureNoticeDeps`, so the outcomes are
 * unit-testable with fakes and no gateway/grammy/IPC coupling leaks in.
 */

import { escapeMarkdown } from '../format.js'
import type { InlineKeyboardMarkup, OperatorEvent } from '../operator-events.js'
import type { PendingUserNotice } from '../pending-user-notice.js'

// ─── transport-transient escalation counter (pure) ───────────────────────────

const ESCALATION_WINDOW_MS = 10 * 60_000
const ESCALATION_THRESHOLD = 3

/** Per-agent sliding window of terminal transport-transient event timestamps. */
const transportEscalation = new Map<string, number[]>()

/**
 * Record one terminal transport-transient event for `agent` at `now` and decide
 * whether it crosses the escalation threshold. Returns `true` at most once per
 * burst: crossing the threshold RESETS the window so a sustained outage emits
 * one operator card per ~`windowMs`, not one per event.
 */
export function noteTransportTransientAndShouldEscalate(
  agent: string,
  now: number,
  opts?: { windowMs?: number; threshold?: number },
): boolean {
  const windowMs = opts?.windowMs ?? ESCALATION_WINDOW_MS
  const threshold = opts?.threshold ?? ESCALATION_THRESHOLD
  const recent = (transportEscalation.get(agent) ?? []).filter((t) => now - t < windowMs)
  recent.push(now)
  if (recent.length >= threshold) {
    transportEscalation.set(agent, [])
    return true
  }
  transportEscalation.set(agent, recent)
  return false
}

/** Test/reauth-recovery helper: forget the escalation window (all or one agent). */
export function resetTransportTransientEscalation(agent?: string): void {
  if (agent == null) transportEscalation.clear()
  else transportEscalation.delete(agent)
}

/**
 * The ONE operator-only card a transport-transient BURST escalates to. Dismiss-
 * only — no Reauth (a dropped stream is not a credential fault), no failover
 * (every account hits the same degraded pipe).
 */
export function renderTransportEscalationCard(agent: string): {
  text: string
  keyboard: InlineKeyboardMarkup
} {
  const a = escapeMarkdown(agent)
  return {
    text: [
      `🔌 **Repeated stream failures** reaching Anthropic for **${a}**.`,
      `3+ mid-response aborts within ~10 min. Turns retry automatically; if this persists, Anthropic's API may be degraded.`,
    ].join('\n'),
    keyboard: {
      inline_keyboard: [
        [{ text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(agent)}` }],
      ],
    },
  }
}

// ─── Deps + orchestration ────────────────────────────────────────────────────

export interface UserFailureNoticeDeps {
  /** Injectable clock. */
  now(): number
  /** Allowlist chats (broadcast audience). */
  allowFrom(): readonly string[]
  /** Topic key of the live turn, or undefined (agent-level / between turns). */
  liveTurnKey(): string | undefined
  /** Persist to /status history (best-effort — must swallow its own errors). */
  record(event: OperatorEvent): void
  /** Schedule the turn-end-gated plain user notice for `chatIds`. */
  scheduleUserNotice(input: {
    chatIds: string[]
    agent: string
    kind: string
    key: string | undefined
    atMs: number
  }): void
  /** Release the notices resolved by this turn end (may be empty). */
  resolveNotices(turnDeliveredReply: boolean, turnKey: string): PendingUserNotice[]
  /** Topic-aware raw send (fire-and-forget). `keyboard` omitted → plain message. */
  send(chatId: string, text: string, keyboard?: InlineKeyboardMarkup): void
  /** stderr line (the gateway prefixes "telegram gateway: "). */
  log(msg: string): void
}

/**
 * Handle a `transport-transient` operator event: record it, defer the plain
 * user notice to turn-end, and — on a burst — post exactly one operator-only
 * escalation card. Never sends a broadcast card.
 */
export function emitTransportTransientEvent(
  event: OperatorEvent,
  deps: UserFailureNoticeDeps,
): void {
  const now = deps.now()
  deps.record(event)
  const escalate = noteTransportTransientAndShouldEscalate(event.agent, now)
  deps.log(
    `transport-transient agent=${event.agent} escalate=${escalate} ` +
      `(no broadcast card; user-notice deferred to turn-end)`,
  )
  const allowFrom = deps.allowFrom()
  if (allowFrom.length === 0) return
  deps.scheduleUserNotice({
    chatIds: [...allowFrom],
    agent: event.agent,
    kind: event.kind,
    key: deps.liveTurnKey(),
    atMs: now,
  })
  if (escalate) {
    const card = renderTransportEscalationCard(event.agent)
    deps.send(allowFrom[0], card.text, card.keyboard)
  }
}

/**
 * Turn-end resolution of deferred user failure notices (#3293 finding 1, moved
 * out of gateway.ts). `turnDeliveredReply` is `finalAnswerDelivered ||
 * replyCalled` — a delivered reply DROPS the notices (turn recovered); a
 * reply-less end flushes them (turn genuinely died). `turnKey` scopes resolution
 * to the ending turn's topic under keyed liveness.
 */
export function flushDeferredUserNotices(
  turnDeliveredReply: boolean,
  turnKey: string,
  deps: UserFailureNoticeDeps,
): void {
  const notices = deps.resolveNotices(turnDeliveredReply, turnKey)
  if (notices.length === 0) return
  for (const notice of notices) {
    deps.log(
      `user-notice flush (turn died reply-less) agent=${notice.agent} ` +
        `kind=${notice.kind} chats=${notice.chatIds.length}`,
    )
    for (const chatId of notice.chatIds) deps.send(chatId, notice.text)
  }
}
