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
  /** Logger for pin/unpin failures. Receives lines with trailing newline. */
  log?: (line: string) => void
  /** Clock injection for test determinism. Defaults to `Date.now`. */
  now?: () => number
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

  // Turn -> pinned message id. Populated only after a successful pin
  // call returns; cleared on completeTurn.
  const pinned = new Map<string, number>()
  // Turns whose unpin has already fired. Guards against duplicate
  // completeTurn calls causing a second unpin (the gateway fires
  // onTurnComplete exactly once today, but the reducer's zombie path
  // can also land on the same turnKey).
  const unpinned = new Set<string>()
  // Fire-and-forget promises we want tests to be able to drain.
  const inFlight = new Set<Promise<unknown>>()

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
    pinned.delete(turnKey)
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

  return {
    considerPin(c) {
      if (!c.isFirstEmit) return
      if (pinned.has(c.turnKey)) return
      // Lock the slot BEFORE the async pin call so a second emit for the
      // same turnKey arriving during the API round-trip doesn't also
      // trigger a pin. The sidecar write happens here too so a crash
      // between these writes and the pin call still leaves a recovery
      // record for the startup sweep.
      pinned.set(c.turnKey, c.messageId)
      if (deps.addPin) {
        deps.addPin({
          chatId: c.chatId,
          messageId: c.messageId,
          turnKey: c.turnKey,
          pinnedAt: now(),
        })
      }
      const p = deps.pin(c.chatId, c.messageId, { disable_notification: true }).catch(
        (err: Error) => {
          log(`telegram gateway: progress-card pin failed: ${err?.message ?? err}\n`)
          // Roll back the sidecar — the pin didn't land. We leave the
          // in-memory `pinned` entry untouched so a later completeTurn
          // still attempts an unpin (harmless if the pin really failed;
          // correct if it partially landed on Telegram's side).
          if (deps.removePin) deps.removePin(c.chatId, c.messageId)
        },
      )
      track(p)
    },

    completeTurn({ chatId, turnKey }) {
      const pinnedId = pinned.get(turnKey)
      if (pinnedId != null) doUnpin(turnKey, chatId, pinnedId)
      // Once the turn is complete we never see the same turnKey again
      // (driver generates a fresh sequence). Clearing the flag keeps
      // the set from growing unbounded over a long-running gateway.
      unpinned.delete(turnKey)
    },

    unpinForChat(chatId, threadId) {
      const base = threadId != null ? `${chatId}:${threadId}` : chatId
      // Snapshot the keys so doUnpin's map mutation doesn't invalidate
      // iteration mid-loop.
      const matching: Array<[string, number]> = []
      for (const [turnKey, pinnedId] of pinned) {
        if (turnKey.startsWith(`${base}:`)) matching.push([turnKey, pinnedId])
      }
      for (const [turnKey, pinnedId] of matching) doUnpin(turnKey, chatId, pinnedId)
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
