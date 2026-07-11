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
 *      begins. Only the REDUNDANT restarts are dropped — and a dropped tick is
 *      never silently lost: it arms a COALESCED catch-up at the instant the
 *      window opens, so the worst-case gap between two emissions is `floorMs`
 *      (3.5 s), comfortably inside Telegram's ~5 s action expiry. Without it,
 *      an eaten tick on a fixed-cadence loop pushes the next emission out to
 *      `floorMs + refreshMs` = 7.5 s and the chat goes DARK mid-turn — trading
 *      a flood ban for a dead indicator, which is not a trade we make.
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
  /** Injected timer for the catch-up (tests pass fake timers). */
  schedule?: (fn: () => void, ms: number) => unknown
  /** Cancel a handle returned by `schedule`. */
  cancel?: (handle: unknown) => void
  /** Observability hook — fires for each dropped emission. */
  onDrop?: (info: { key: string; reason: 'floor' | 'flood' }) => void
}

export interface TypingEmitter {
  /**
   * Emit one chat action for (chatId, threadId), subject to the floor and the
   * flood gate. Returns true iff the action was actually handed to `send`.
   * A floor-dropped emission arms a coalesced catch-up (see below), so the
   * caller's cadence is never silently lost.
   */
  emit: (chatId: string, threadId?: number | null, action?: string) => boolean
  /**
   * Cancel any pending catch-up for a chat key. The canonical turn-end calls
   * this so a dropped tick can't resurrect "typing…" after the turn is over.
   * Does NOT clear the floor — the floor must survive loop stops, because the
   * tool loop stops on every tool result and that is precisely the churn the
   * floor exists to absorb.
   */
  cancelPending: (chatId: string, threadId?: number | null) => void
  /** Test/observability: number of chat keys currently tracked. */
  trackedKeys: () => number
  /** Test/observability: number of catch-ups currently armed (0 ⇒ none leaked). */
  pendingCatchUps: () => number
  /** Drop all floor state and cancel every catch-up (shutdown / tests). */
  reset: () => void
}

/** Keep the floor map from growing without bound in a long-lived gateway. */
const PRUNE_AFTER_FACTOR = 10
const PRUNE_SIZE_THRESHOLD = 64

export function createTypingEmitter(deps: TypingEmitterDeps): TypingEmitter {
  const floorMs = deps.floorMs ?? TYPING_FLOOR_MS
  const now = deps.now ?? Date.now
  const isSuppressed = deps.isSuppressed ?? (() => false)
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms)
      ;(h as { unref?: () => void }).unref?.()
      return h
    })
  const cancel =
    deps.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  /** chat key → epoch ms at which the current emission window was claimed. */
  const windowClaimedAt = new Map<string, number>()
  /** chat key → the single armed catch-up timer (coalesced; never two). */
  const catchUps = new Map<string, unknown>()

  function prune(t: number): void {
    if (windowClaimedAt.size <= PRUNE_SIZE_THRESHOLD) return
    const cutoff = t - floorMs * PRUNE_AFTER_FACTOR
    for (const [k, ts] of [...windowClaimedAt.entries()]) {
      if (ts < cutoff && !catchUps.has(k)) windowClaimedAt.delete(k)
    }
  }

  function clearCatchUp(key: string): void {
    const h = catchUps.get(key)
    if (h !== undefined) {
      cancel(h)
      catchUps.delete(key)
    }
  }

  /**
   * A dropped tick MUST NOT become silence. Both loops re-arm a FIXED-cadence
   * interval, so a tick eaten by the floor is simply lost: the next emission
   * for that key could land as late as `floorMs + refreshMs` (7.5 s) after the
   * last one — past Telegram's ~5 s chat-action expiry, and the chat goes dark
   * mid-turn. That would trade a flood ban for a dead "typing…" indicator,
   * which breaches `know-what-my-agent-is-doing` ("stays present from receipt
   * to turn end").
   *
   * So a floor drop arms ONE coalesced catch-up at the exact moment the window
   * opens (`claimedAt + floorMs`). Effect: the worst-case gap between two
   * emissions is bounded by `floorMs`, while the emission CAP is untouched (the
   * catch-up fires only once the floor has expired, so it can never emit early).
   * A second drop inside the same window must not arm a second timer — hence
   * the coalesce.
   */
  function armCatchUp(
    key: string,
    chatId: string,
    threadId: number | null,
    action: string,
    delayMs: number,
  ): void {
    if (catchUps.has(key)) return // coalesced — one timer per key, always
    const h = schedule(() => {
      catchUps.delete(key)
      // Re-enters `emit`, which re-checks the floor (now expired) and the flood
      // gate. A send here cancels nothing — there is nothing left to cancel.
      emit(chatId, threadId, action)
    }, Math.max(0, delayMs))
    catchUps.set(key, h)
  }

  function emit(chatId: string, threadId: number | null = null, action = 'typing'): boolean {
    const key = deps.chatKey(chatId, threadId ?? null)
    const t = now()
    const claimed = windowClaimedAt.get(key)
    // `t >= claimed` guards a backwards clock step (NTP): a stale future
    // timestamp must not wedge the indicator off, so treat it as expired.
    if (claimed != null && t >= claimed && t - claimed < floorMs) {
      armCatchUp(key, chatId, threadId ?? null, action, claimed + floorMs - t)
      deps.onDrop?.({ key, reason: 'floor' })
      return false
    }
    // Claim the window BEFORE the flood check so a burst of restarts costs
    // one flood-state read per floor, not one per restart.
    windowClaimedAt.set(key, t)
    prune(t)
    if (isSuppressed()) {
      // A flood window is open. Don't arm a catch-up — the goal is silence, not
      // a deferred ping into the ban.
      clearCatchUp(key)
      deps.onDrop?.({ key, reason: 'flood' })
      return false
    }
    // This send satisfies whatever a pending catch-up was going to deliver.
    // Cancelling it here is what keeps a catch-up from re-arming itself into a
    // self-sustaining heartbeat after the loops have stopped.
    clearCatchUp(key)
    deps.send(chatId, threadId ?? null, action)
    return true
  }

  return {
    emit,
    cancelPending(chatId, threadId = null) {
      clearCatchUp(deps.chatKey(chatId, threadId ?? null))
    },
    trackedKeys: () => windowClaimedAt.size,
    pendingCatchUps: () => catchUps.size,
    reset: () => {
      for (const key of [...catchUps.keys()]) clearCatchUp(key)
      windowClaimedAt.clear()
    },
  }
}
