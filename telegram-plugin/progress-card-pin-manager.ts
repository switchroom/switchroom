/**
 * Extracted pin-lifecycle manager for the progress-card driver.
 *
 * Previously lived inline in gateway.ts (progressDriver setup block) —
 * reaching into module-level state (`progressPinnedMsgIds`,
 * `unpinnedTurnKeys`, `lockedBot`, `resolveAgentDirFromEnv`) and making
 * the full first-emit → pin → edit → turn-end → unpin sequence
 * unreachable from tests without spinning up the whole bot runner.
 *
 * This module exposes the same behaviour behind a pure interface, with
 * bot-API + sidecar writes injected as callbacks. Contract (tested in
 * progress-card-pin-manager.test.ts):
 *
 *   considerPin(candidate)
 *     - On `isFirstEmit === true` for a turnKey not yet pinned:
 *         records the pinned message id
 *         records an active-pin sidecar entry (if addPin is wired)
 *         calls bot.pin(chatId, messageId, { disable_notification: true })
 *         on pin rejection: calls removePin to keep the sidecar consistent
 *     - On subsequent emits for the same turnKey: no-op (idempotent).
 *
 *   completeTurn({ chatId, threadId, turnKey })
 *     - Looks up pinnedMessageId for turnKey; if present:
 *         unpins exactly once (duplicate completeTurn calls are safe)
 *         calls removePin to clear the sidecar
 *     - The unpinnedTurnKeys set is cleared on completeTurn so a future
 *       re-use of the same key (unlikely but cheap) starts fresh.
 *
 *   unpinForChat(chatId, threadId)
 *     - External hook for context-exhaustion / /restart: unpins every
 *       currently-pinned turn matching the chat+thread prefix.
 */

export interface PinCandidate {
  readonly chatId: string
  readonly threadId?: string
  readonly turnKey: string
  readonly messageId: number
  readonly isFirstEmit: boolean
}

export interface ActivePinEntry {
  readonly chatId: string
  readonly messageId: number
  readonly turnKey: string
  readonly pinnedAt: number
}

export interface TimerHandle {
  cancel(): void
}

export interface PinManagerDeps {
  /** Underlying `bot.api.pinChatMessage` wrapper. */
  pin: (
    chatId: string,
    messageId: number,
    opts?: { disable_notification?: boolean },
  ) => Promise<unknown>
  /** Underlying `bot.api.unpinChatMessage` wrapper. */
  unpin: (chatId: string, messageId: number) => Promise<unknown>
  /** Optional: persist a pin to the sidecar. Skipped when not wired. */
  addPin?: (entry: ActivePinEntry) => void
  /** Optional: remove from the sidecar. Skipped when not wired. */
  removePin?: (chatId: string, messageId: number) => void
  /**
   * Optional: `bot.api.deleteMessage` wrapper. When wired, the manager
   * deletes the "Clerk pinned ..." service message that Telegram posts
   * automatically after each pin. Skipped when not wired.
   */
  deleteMessage?: (chatId: string, messageId: number) => Promise<unknown>
  /** Logger for pin/unpin failures. Receives lines with trailing newline. */
  log?: (line: string) => void
  /** Clock injection for test determinism. Defaults to `Date.now`. */
  now?: () => number
  /**
   * How long to wait after the first emit before actually pinning. The
   * driver's `initialDelayMs` already suppresses the card entirely for
   * fast turns, so by the time first-emit fires the turn is already
   * considered slow and the pin can follow immediately. Defaults to 0.
   */
  pinDelayMs?: number
  /**
   * Injectable timer scheduler. Defaults to `setTimeout` + `clearTimeout`.
   * Tests pass a fake that captures callbacks and fires them manually so
   * they can assert on the before/after states without real clocks.
   */
  scheduleTimer?: (fn: () => void, ms: number) => TimerHandle
}

export interface PinManager {
  /** Decide whether to pin based on an emit's metadata. Idempotent. */
  considerPin(candidate: PinCandidate): void
  /** Called from `onTurnComplete` — unpins the turn's pinned card. */
  completeTurn(args: { chatId: string; threadId?: string; turnKey: string }): void
  /**
   * External hook. Unpins every currently-pinned turn matching the chat
   * (and optional thread). Used by context-exhaustion / external
   * cancellation paths that need to clear all active pins for a chat.
   */
  unpinForChat(chatId: string, threadId: number | undefined): void
  /**
   * Hook for the grammY `message:pinned_message` update. When Telegram
   * auto-posts the "Clerk pinned ..." service message after a pin we
   * made, the gateway calls this with the service message id and the id
   * of the pinned message it wraps. The manager deletes the service
   * message immediately if it matches one of our tracked pins.
   */
  captureServiceMessage(args: {
    chatId: string
    pinnedMessageId: number
    serviceMessageId: number
  }): void
  /** Test-only: snapshot the currently-pinned turnKeys. */
  pinnedTurnKeys(): ReadonlyArray<string>
  /** Test-only: look up the pinned message id for a turnKey. */
  pinnedMessageId(turnKey: string): number | undefined
  /**
   * Test hook to await all in-flight pin/unpin promises. Production
   * callers don't need this; tests can call it to drain the fire-and-
   * forget `.catch()` chains before asserting on side effects.
   */
  drainInFlight(): Promise<void>
}

export function createPinManager(deps: PinManagerDeps): PinManager {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const pinDelayMs = deps.pinDelayMs ?? 0
  const scheduleTimer: (fn: () => void, ms: number) => TimerHandle =
    deps.scheduleTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(t) }
    })

  // Turn -> pinned message id. Populated only after a successful pin
  // call returns; cleared on completeTurn.
  const pinned = new Map<string, number>()
  // Turn -> pending pin state. Holds the candidate + timer handle while
  // we wait pinDelayMs before actually calling the Telegram pin API. If
  // completeTurn fires before the timer, we cancel and never pin — fast
  // turns stay silent. Removed when the timer fires (moved to `pinned`)
  // or when completeTurn cancels it.
  const pendingPins = new Map<
    string,
    { chatId: string; messageId: number; timer: TimerHandle }
  >()
  // Turns whose unpin has already fired. Guards against duplicate
  // completeTurn calls causing a second unpin (the gateway fires
  // onTurnComplete exactly once today, but the reducer's zombie path
  // can also land on the same turnKey).
  const unpinned = new Set<string>()
  // `${chatId}:${pinnedMessageId}` -> service-message id. Populated when
  // the grammY `pinned_message` update handler forwards the wrapper
  // message to us. We delete on capture; this map exists only so a late
  // unpin path can also scrub the service message if the capture-delete
  // somehow failed.
  const serviceMessages = new Map<string, number>()
  // Fire-and-forget promises we want tests to be able to drain.
  const inFlight = new Set<Promise<unknown>>()

  function serviceKey(chatId: string, pinnedMessageId: number): string {
    return `${chatId}:${pinnedMessageId}`
  }

  function deleteServiceMessage(chatId: string, serviceMessageId: number): void {
    if (!deps.deleteMessage) return
    const p = deps.deleteMessage(chatId, serviceMessageId).catch((err: Error) => {
      log(`telegram gateway: progress-card pin service-msg delete failed: ${err?.message ?? err}\n`)
    })
    track(p)
  }

  function track(p: Promise<unknown>): void {
    inFlight.add(p)
    // Remove on settle — including rejections, which are caught by the
    // callers. Using `then(..., ...)` rather than `finally` so a late
    // thrown error inside finally can't corrupt the tracking set.
    p.then(
      () => { inFlight.delete(p) },
      () => { inFlight.delete(p) },
    )
  }

  function doUnpin(turnKey: string, chatId: string, pinnedId: number): void {
    if (unpinned.has(turnKey)) return
    unpinned.add(turnKey)
    log(`telegram gateway: progress-card: unpin turnKey=${turnKey} msgId=${pinnedId}\n`)
    pinned.delete(turnKey)
    const key = serviceKey(chatId, pinnedId)
    const svcId = serviceMessages.get(key)
    if (svcId != null) {
      serviceMessages.delete(key)
      deleteServiceMessage(chatId, svcId)
    }
    const p = deps.unpin(chatId, pinnedId)
      .catch((err: Error) => {
        log(`telegram gateway: progress-card unpin failed: ${err?.message ?? err}\n`)
      })
      .finally(() => {
        // Keep the sidecar consistent whether the API call succeeded
        // or failed — the sidecar exists to recover after we lose the
        // in-memory map across a restart, so removing on unpin-attempt
        // is the correct boundary.
        if (deps.removePin) deps.removePin(chatId, pinnedId)
      })
    track(p)
  }

  function firePin(turnKey: string, chatId: string, messageId: number): void {
    // Called when the pin-delay timer fires. Promote from pendingPins
    // into pinned, then issue the Telegram pin API call.
    pendingPins.delete(turnKey)
    if (pinned.has(turnKey) || unpinned.has(turnKey)) {
      // Either we already pinned (shouldn't happen — timer is the only
      // path that sets `pinned`) or the turn completed between scheduling
      // and firing and the pending entry was cleared elsewhere. Bail.
      return
    }
    pinned.set(turnKey, messageId)
    log(`telegram gateway: progress-card: pinned turnKey=${turnKey} msgId=${messageId}\n`)
    if (deps.addPin) {
      deps.addPin({
        chatId,
        messageId,
        turnKey,
        pinnedAt: now(),
      })
    }
    const p = deps.pin(chatId, messageId, { disable_notification: true }).catch(
      (err: Error) => {
        log(`telegram gateway: progress-card pin failed: ${err?.message ?? err}\n`)
        if (deps.removePin) deps.removePin(chatId, messageId)
      },
    )
    track(p)
  }

  return {
    considerPin(c) {
      if (!c.isFirstEmit) return
      if (pinned.has(c.turnKey)) return
      if (pendingPins.has(c.turnKey)) return
      // Schedule the pin via the injected timer. Fast-turn suppression is
      // owned upstream by the driver's `initialDelayMs` — by the time
      // considerPin sees isFirstEmit=true the card has already been
      // published, so pinDelayMs defaults to 0 (fire on next tick).
      // The indirection remains so tests and callers can still override
      // with a positive value if they want a pre-pin visual buffer.
      const timer = scheduleTimer(() => {
        firePin(c.turnKey, c.chatId, c.messageId)
      }, pinDelayMs)
      pendingPins.set(c.turnKey, {
        chatId: c.chatId,
        messageId: c.messageId,
        timer,
      })
    },

    completeTurn({ chatId, turnKey }) {
      // Fast-turn path: if the pin is still pending, cancel the timer
      // and we're done — no pin ever landed, no unpin needed.
      const pending = pendingPins.get(turnKey)
      if (pending != null) {
        pending.timer.cancel()
        pendingPins.delete(turnKey)
      }
      const pinnedId = pinned.get(turnKey)
      if (pinnedId != null) doUnpin(turnKey, chatId, pinnedId)
      // Once the turn is complete we never see the same turnKey again
      // (driver generates a fresh sequence). Clearing the flag keeps
      // the set from growing unbounded over a long-running gateway.
      unpinned.delete(turnKey)
    },

    unpinForChat(chatId, threadId) {
      const base = threadId != null ? `${chatId}:${threadId}` : chatId
      // Cancel any pending (not-yet-fired) timers for this chat/thread
      // first — otherwise they'd pin after we thought we cleaned up.
      const pendingMatching: string[] = []
      for (const [turnKey] of pendingPins) {
        if (turnKey.startsWith(`${base}:`)) pendingMatching.push(turnKey)
      }
      for (const turnKey of pendingMatching) {
        const pending = pendingPins.get(turnKey)
        if (pending != null) {
          pending.timer.cancel()
          pendingPins.delete(turnKey)
        }
      }
      // Snapshot the keys so doUnpin's map mutation doesn't invalidate
      // iteration mid-loop.
      const matching: Array<[string, number]> = []
      for (const [turnKey, pinnedId] of pinned) {
        if (turnKey.startsWith(`${base}:`)) matching.push([turnKey, pinnedId])
      }
      for (const [turnKey, pinnedId] of matching) doUnpin(turnKey, chatId, pinnedId)
    },

    captureServiceMessage({ chatId, pinnedMessageId, serviceMessageId }) {
      // Only act on service messages that wrap one of our tracked pins —
      // otherwise we'd be deleting arbitrary pin-service messages in the
      // chat, which could include user-initiated pins.
      let matched = false
      for (const [, msgId] of pinned) {
        if (msgId === pinnedMessageId) { matched = true; break }
      }
      if (!matched) return
      const key = serviceKey(chatId, pinnedMessageId)
      serviceMessages.set(key, serviceMessageId)
      deleteServiceMessage(chatId, serviceMessageId)
      // Also drop the tracked id — if the delete succeeded there's
      // nothing left to scrub on unpin. If it failed the catch logged it
      // and a retry on unpin wouldn't help (Telegram pin-service messages
      // don't age back into existence).
      serviceMessages.delete(key)
    },

    pinnedTurnKeys() {
      return [...pinned.keys()]
    },

    pinnedMessageId(turnKey) {
      return pinned.get(turnKey)
    },

    async drainInFlight() {
      // Copy so we don't race with track() adding more while we await.
      const snapshot = [...inFlight]
      await Promise.allSettled(snapshot)
    },
  }
}
