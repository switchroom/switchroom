/**
 * The single gate every `sendChatAction` in the gateway passes through (#3084).
 *
 * WHY THIS EXISTS — the 2026-07-11 flood ban
 * ------------------------------------------
 * The typing indicator used to be "a 4 s interval", which sounds rate-limited
 * and is not. Both typing loops (`startTypingLoop` in gateway.ts and the
 * turn-level `createTurnTypingLoop`) are restart-safe by design: a re-start
 * clears the old interval and fires ONE action immediately so "typing…" lands
 * instantly. The tool-use wrapper restarts the loop on every tool call, so the
 * ping rate tracked the AGENT'S TOOL-CALL RATE, not the 4 s cadence — the
 * interval was decorative. On 2026-07-11 `overlord` emitted 8,729
 * sendChatAction calls (55% of all outbound volume, bursting at 200-300/min
 * into ONE DM) to deliver 203 messages, and earned a per-bot-token flood ban:
 * `429 retry_after=16739s` — 4.6 hours with every outbound reply rejected.
 *
 * The old code comment said the redundant pings were "harmless — same action,
 * and sendChatAction is cheap." They are not cheap. They spend the per-bot
 * flood budget the REPLIES need.
 *
 * WHAT THIS ENFORCES
 * ------------------
 *   1. A per-chat-key emission FLOOR. At most one chat action per key per
 *      `floorMs` (~4 s refresh window), no matter how many loops restart, from
 *      which caller, on which surface. Both loops share ONE emitter, so the
 *      floor holds ACROSS them — they target the same chat key and neither can
 *      out-shout the other. This is what structurally decouples ping rate from
 *      tool-call rate.
 *   2. The UX intent survives: a COLD start (no ping for this key inside the
 *      floor) still fires immediately, so "typing…" lands the moment a turn
 *      begins. Only the REDUNDANT restarts are dropped.
 *   3. NON-ESSENTIAL by definition: while a flood-wait window is open
 *      (`isSuppressed`, wired to the #2923 circuit breaker) no typing is
 *      emitted at all. It cannot succeed, and sending into an open window can
 *      extend the ban.
 *
 * The window is claimed on every attempt that PASSES the floor, including one
 * suppressed by a flood window. That is deliberate: it bounds the flood-state
 * read to once per floor per chat instead of once per tool call.
 *
 * Pure + injectable (clock, send, chat-key, suppression) so the whole gate is
 * unit-testable on a fake clock without a bot — `tests/typing-emitter.test.ts`.
 */

/** Refresh cadence of the typing loops. Telegram's `typing` expires at ~5 s. */
export const TYPING_REFRESH_MS = 4000

/**
 * Minimum gap between two chat actions on one chat key. Deliberately a hair
 * UNDER `TYPING_REFRESH_MS` so a loop's own on-time refresh is never eaten by
 * timer jitter (a 3999 ms tick would be dropped by a 4000 ms floor, and the
 * indicator would go dark for a whole window). The gap between successive
 * emissions therefore stays under Telegram's ~5 s action expiry, while the
 * worst-case rate falls from the observed ~300/min to ~17/min per chat.
 */
export const TYPING_FLOOR_MS = 3500

export interface TypingEmitterDeps {
  /** Perform the actual chat action. Errors are the caller's concern — the
   *  emitter never throws and never awaits. */
  send: (chatId: string, threadId: number | null, action: string) => void
  /** Canonical chat:thread key (the gateway's `chatKey`) — a supergroup topic
   *  is its own lane and gets its own floor. */
  chatKey: (chatId: string, threadId: number | null) => string
  /** True while a flood-wait window is open. Typing is non-essential: while
   *  this is true nothing is emitted. Defaults to "never suppressed". */
  isSuppressed?: () => boolean
  /** Injected clock (tests pass a fake). */
  now?: () => number
  /** Per-key emission floor in ms. */
  floorMs?: number
  /** Observability hook — fires for each dropped emission. */
  onDrop?: (info: { key: string; reason: 'floor' | 'flood' }) => void
}

export interface TypingEmitter {
  /**
   * Emit one chat action for (chatId, threadId), subject to the floor and the
   * flood gate. Returns true iff the action was actually handed to `send`.
   */
  emit: (chatId: string, threadId?: number | null, action?: string) => boolean
  /** Test/observability: number of chat keys currently tracked. */
  trackedKeys: () => number
  /** Drop all floor state (shutdown / tests). */
  reset: () => void
}

/** Keep the floor map from growing without bound in a long-lived gateway. */
const PRUNE_AFTER_FACTOR = 10
const PRUNE_SIZE_THRESHOLD = 64

export function createTypingEmitter(deps: TypingEmitterDeps): TypingEmitter {
  const floorMs = deps.floorMs ?? TYPING_FLOOR_MS
  const now = deps.now ?? Date.now
  const isSuppressed = deps.isSuppressed ?? (() => false)
  /** chat key → epoch ms at which the current emission window was claimed. */
  const windowClaimedAt = new Map<string, number>()

  function prune(t: number): void {
    if (windowClaimedAt.size <= PRUNE_SIZE_THRESHOLD) return
    const cutoff = t - floorMs * PRUNE_AFTER_FACTOR
    for (const [k, ts] of [...windowClaimedAt.entries()]) {
      if (ts < cutoff) windowClaimedAt.delete(k)
    }
  }

  return {
    emit(chatId, threadId = null, action = 'typing') {
      const key = deps.chatKey(chatId, threadId ?? null)
      const t = now()
      const claimed = windowClaimedAt.get(key)
      // `t >= claimed` guards a backwards clock step (NTP): a stale future
      // timestamp must not wedge the indicator off, so treat it as expired.
      if (claimed != null && t >= claimed && t - claimed < floorMs) {
        deps.onDrop?.({ key, reason: 'floor' })
        return false
      }
      // Claim the window BEFORE the flood check so a burst of restarts costs
      // one flood-state read per floor, not one per restart.
      windowClaimedAt.set(key, t)
      prune(t)
      if (isSuppressed()) {
        deps.onDrop?.({ key, reason: 'flood' })
        return false
      }
      deps.send(chatId, threadId ?? null, action)
      return true
    },
    trackedKeys: () => windowClaimedAt.size,
    reset: () => windowClaimedAt.clear(),
  }
}
