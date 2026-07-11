/**
 * Turn-level `typing…` indicator — the second "something is happening" signal.
 *
 * A person you message shows as typing the WHOLE time they compose, not just
 * the split-second a message is transmitted. Telegram's `sendChatAction('typing')`
 * auto-expires after ~5 s, so a single one-shot ping on inbound leaves the chat
 * dark after 5 s for any turn that thinks or reads a file before replying — the
 * exact black-box gap this closes. We hold a continuous `typing…` for the whole
 * turn by re-firing the action every ~4 s, and stop cleanly at the canonical
 * turn-end. It runs ALONGSIDE the activity card (the early-card-open is the
 * other signal): both start at turn enqueue and stop at turn-end, so the two
 * "alive" signals start and stop together.
 *
 * This is the SAME mechanism as the tool-use `typingIntervals` (`typing-wrap.ts`)
 * but on a DELIBERATELY SEPARATE interval map: if the turn loop shared that map,
 * a mid-turn reply's `finally { stopTypingLoop }` would kill it and the chat
 * would go dark for the rest of the turn. A dedicated map makes the turn loop
 * structurally immune to those stops — only `stop` (the canonical turn-end)
 * clears it.
 *
 * The map is separate; the SENDS are not (#3084). This file used to claim the
 * redundant pings were "harmless — same action, and `sendChatAction` is cheap".
 * They are not cheap: they spend the per-bot flood budget the REPLIES need, and
 * on 2026-07-11 the two loops together earned a 4.6-hour flood ban. The gateway
 * now injects a `sendChatAction` that routes through the SHARED typing emitter
 * (`typing-emitter.ts`), which enforces one action per chat key per refresh
 * window across BOTH loops. This factory keeps its lifecycle semantics —
 * fire-on-start, refresh, stop-at-turn-end — and the floor lives in the emitter.
 *
 * Extracted into a factory so the lifecycle (fires on start, refreshes on the
 * interval, stops on turn-end, NEVER leaks a refresh interval after the turn
 * completes) has its own unit test (`tests/turn-typing-loop.test.ts`) without
 * spinning up the whole gateway or the Telegram bot API. The gateway injects
 * the real `sendChatAction` + the chat-key function; tests inject spies + fake
 * timers.
 */

export interface TurnTypingLoopDeps {
  /** Fire one `typing` chat action for (chatId, threadId). Errors are the
   *  caller's concern (the gateway swallows them); the loop never throws. */
  sendChatAction: (chatId: string, threadId: number | null) => void
  /** Canonical chat:thread key (the gateway's `chatKey`), so a per-topic turn
   *  loop is isolated from a sibling topic on the same chat. */
  chatKey: (chatId: string, threadId: number | null) => string
  /** Refresh cadence in ms. Telegram's `typing` auto-expires after ~5 s, so the
   *  default 4 s keeps it continuously lit. Override for tests. */
  refreshMs?: number
}

export interface TurnTypingLoop {
  /** Start (or restart) the turn-long `typing…` loop for a chat/thread. Fires
   *  one action immediately, then every `refreshMs`. Idempotent re-start: a
   *  prior loop on the same key is stopped first, so this never leaks. */
  start: (chatId: string, threadId?: number | null) => void
  /** Stop the loop for a chat/thread and clear its interval. Idempotent — a
   *  no-op when no loop is registered. The single owner of the stop is the
   *  gateway's canonical turn-end. */
  stop: (chatId: string, threadId?: number | null) => void
  /** Stop EVERY live loop and clear the map — the gateway's shutdown-drain
   *  cleanup (mirrors the other interval-map clears there). */
  stopAll: () => void
  /** Test/observability: how many loops are currently live (0 ⇒ none leaked). */
  activeCount: () => number
}

/**
 * Build a turn-typing loop over injected deps. The interval map is private to
 * the returned closure — the SEPARATE map that makes the turn loop immune to
 * the tool-use typing stops.
 */
export function createTurnTypingLoop(deps: TurnTypingLoopDeps): TurnTypingLoop {
  const refreshMs = deps.refreshMs ?? 4000
  const intervals = new Map<string, ReturnType<typeof setInterval>>()

  function stop(chatId: string, threadId: number | null = null): void {
    const key = deps.chatKey(chatId, threadId)
    const iv = intervals.get(key)
    if (iv != null) {
      clearInterval(iv)
      intervals.delete(key)
    }
  }

  function start(chatId: string, threadId: number | null = null): void {
    // Restart-safe: stop any prior loop on this key first so a re-start never
    // leaks a second interval (the self-heal when an abnormal abort skipped the
    // turn-end stop — the next turn's start clears the stray loop).
    stop(chatId, threadId)
    const key = deps.chatKey(chatId, threadId)
    const send = () => deps.sendChatAction(chatId, threadId)
    send() // fire immediately so "typing…" lands ~instantly, not after refreshMs
    const iv = setInterval(send, refreshMs)
    // unref so a live loop never holds the process open (mirrors the gateway's
    // other interval timers). Guarded for environments without unref.
    ;(iv as { unref?: () => void }).unref?.()
    intervals.set(key, iv)
  }

  function stopAll(): void {
    for (const iv of [...intervals.values()]) clearInterval(iv)
    intervals.clear()
  }

  return {
    start,
    stop,
    stopAll,
    activeCount: () => intervals.size,
  }
}
