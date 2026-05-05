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
 *     - On `isFirstEmit === true` for a (turnKey, agentId) pair not yet
 *       pinned:
 *         records the pinned message id
 *         records an active-pin sidecar entry (if addPin is wired)
 *         calls bot.pin(chatId, messageId, { disable_notification: true })
 *         on pin rejection: calls removePin to keep the sidecar consistent
 *     - On subsequent emits for the same (turnKey, agentId): no-op
 *       (idempotent).
 *
 *   completeTurn({ chatId, threadId, turnKey, agentId? })
 *     - Looks up pinnedMessageId for (turnKey, agentId); if present:
 *         unpins exactly once (duplicate completeTurn calls are safe)
 *         calls removePin to clear the sidecar
 *     - The unpinned set entry is cleared so a future re-use of the same
 *       composite key (unlikely but cheap) starts fresh.
 *
 *   completeAllForTurn({ turnKey })
 *     - Catastrophic-cleanup helper. Unpins every pinned card for a turn,
 *       across all agentIds. Used on bridge-disconnect / forced shutdown
 *       paths where individual sub_agent_turn_end events may never land.
 *
 *   unpinForChat(chatId, threadId)
 *     - External hook for context-exhaustion / /restart: unpins every
 *       currently-pinned (turnKey, agentId) matching the chat+thread
 *       prefix.
 *
 * Per-agent cards (#per-agent-cards): the manager keys pin state on the
 * composite (turnKey, agentId) so a parent card and its sub-agent cards
 * can co-exist independently in the same turn. Callers that don't yet
 * thread agentId through (e.g. legacy single-card-per-turn callers) get
 * a stable default sentinel — see `PARENT_AGENT_ID` below — so existing
 * behaviour is preserved without modification.
 */

/**
 * Sentinel agent id for the "parent" / single-card-per-turn case. Used
 * as the default when callers don't yet pass an explicit agentId, so the
 * composite-key bookkeeping degrades to the original turnKey-only
 * behaviour for legacy call sites.
 */
export const PARENT_AGENT_ID = '__parent__'

export interface PinCandidate {
  readonly chatId: string
  readonly threadId?: string
  readonly turnKey: string
  readonly messageId: number
  readonly isFirstEmit: boolean
  /**
   * Per-agent identity. Defaults to {@link PARENT_AGENT_ID} when omitted
   * — callers that haven't yet been threaded for per-agent cards behave
   * as before (one pin per turnKey).
   */
  readonly agentId?: string
}

export interface ActivePinEntry {
  readonly chatId: string
  readonly messageId: number
  readonly turnKey: string
  readonly pinnedAt: number
  /**
   * Stored verbatim alongside the entry. Existing sidecar files written
   * before the per-agent split have no agentId; readers should treat a
   * missing field as {@link PARENT_AGENT_ID}.
   */
  readonly agentId?: string
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

export interface CompleteTurnArgs {
  chatId: string
  threadId?: string
  turnKey: string
  /** Defaults to {@link PARENT_AGENT_ID}. */
  agentId?: string
}

export interface PinManager {
  /** Decide whether to pin based on an emit's metadata. Idempotent. */
  considerPin(candidate: PinCandidate): void
  /**
   * Called from `onTurnComplete` (parent) or from `sub_agent_turn_end`
   * (per-agent) — unpins the (turnKey, agentId) composite's pinned card.
   * `agentId` defaults to {@link PARENT_AGENT_ID} for legacy single-card
   * call sites.
   */
  completeTurn(args: CompleteTurnArgs): void
  /**
   * Catastrophic-cleanup helper. Unpins every pinned card under a turnKey
   * — across all agentIds. Used when a parent turn ends without per-agent
   * sub_agent_turn_end events arriving (bridge disconnect, gateway crash,
   * forced shutdown). Distinct from `completeTurn`, which targets a single
   * card.
   */
  completeAllForTurn(args: { chatId: string; threadId?: string; turnKey: string }): void
  /**
   * External hook. Unpins every currently-pinned (turnKey, agentId)
   * matching the chat (and optional thread). Used by
   * context-exhaustion / external cancellation paths that need to clear
   * all active pins for a chat.
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
  /**
   * Register a pin made outside the per-turn `considerPin()` path so
   * `captureServiceMessage()` will recognise its service message and
   * delete it. Used by the worker / sub-agent card (issue #94), which
   * pins through the gateway directly rather than the progress-card
   * pin candidate flow. Idempotent — calling twice with the same
   * (chatId, messageId) is a no-op.
   */
  trackExternalPin(chatId: string, messageId: number): void
  /**
   * Drop an external pin from tracking. Call when the corresponding
   * pinned message is unpinned/deleted by its owner so the manager
   * doesn't keep a stale reference. Idempotent.
   */
  untrackExternalPin(chatId: string, messageId: number): void
  /**
   * Test-only: snapshot the unique turnKeys that currently have at
   * least one pinned card. With per-agent cards this may collapse
   * multiple composite entries down to a single turnKey.
   */
  pinnedTurnKeys(): ReadonlyArray<string>
  /**
   * Test-only: snapshot the agentIds currently pinned under a turnKey.
   * Empty array when nothing is pinned for that turn.
   */
  pinnedAgentIds(turnKey: string): ReadonlyArray<string>
  /**
   * Test-only: look up the pinned message id for a (turnKey, agentId).
   * `agentId` defaults to {@link PARENT_AGENT_ID} for backward compat.
   */
  pinnedMessageId(turnKey: string, agentId?: string): number | undefined
  /**
   * Test hook to await all in-flight pin/unpin promises. Production
   * callers don't need this; tests can call it to drain the fire-and-
   * forget `.catch()` chains before asserting on side effects.
   */
  drainInFlight(): Promise<void>
}

/**
 * Composite key for the per-agent pin maps. Uses a `::` separator that
 * cannot appear in a turnKey (which is `${chatId}:${threadId}:${seq}`)
 * or in any agentId (JSONL filename stems are slug-safe).
 */
function pinKey(turnKey: string, agentId: string): string {
  return `${turnKey}::${agentId}`
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

  // (turnKey, agentId) -> pinned message id. Populated only after a
  // successful pin call returns; cleared on completeTurn for that
  // composite.
  const pinned = new Map<string, number>()
  // (turnKey, agentId) -> pending pin state. Holds the candidate +
  // timer handle while we wait pinDelayMs before actually calling the
  // Telegram pin API. If completeTurn fires before the timer, we cancel
  // and never pin — fast turns stay silent. Removed when the timer
  // fires (moved to `pinned`) or when completeTurn cancels it.
  const pendingPins = new Map<
    string,
    { chatId: string; messageId: number; turnKey: string; agentId: string; timer: TimerHandle }
  >()
  // Composite keys whose unpin has already fired. Guards against
  // duplicate completeTurn calls causing a second unpin.
  const unpinned = new Set<string>()
  // `${chatId}:${pinnedMessageId}` -> service-message id. Populated when
  // the grammY `pinned_message` update handler forwards the wrapper
  // message to us. We delete on capture; this map exists only so a late
  // unpin path can also scrub the service message if the capture-delete
  // somehow failed.
  const serviceMessages = new Map<string, number>()
  // Pins that the manager DIDN'T make through `considerPin()` but should
  // still recognise so their "Clerk pinned …" service message gets
  // deleted. Issue #94: the worker / sub-agent card pins via the gateway
  // directly; without this set, captureServiceMessage would skip its
  // service message and the user sees the system-message noise that the
  // main card already suppresses. Keyed by `${chatId}:${messageId}`.
  const externalPins = new Set<string>()
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

  function doUnpin(turnKey: string, agentId: string, chatId: string, pinnedId: number): void {
    const key = pinKey(turnKey, agentId)
    if (unpinned.has(key)) return
    unpinned.add(key)
    log(`telegram gateway: progress-card: unpin turnKey=${turnKey} agentId=${agentId} msgId=${pinnedId}\n`)
    pinned.delete(key)
    const svcKey = serviceKey(chatId, pinnedId)
    const svcId = serviceMessages.get(svcKey)
    if (svcId != null) {
      serviceMessages.delete(svcKey)
      deleteServiceMessage(chatId, svcId)
    }
    const unpinStart = now()
    const p = deps.unpin(chatId, pinnedId)
      .then(() => {
        const ms = now() - unpinStart
        log(`telegram gateway: progress-card: unpin OK turnKey=${turnKey} agentId=${agentId} msgId=${pinnedId} durationMs=${ms}\n`)
      })
      .catch((err: Error) => {
        const ms = now() - unpinStart
        log(`telegram gateway: progress-card unpin failed turnKey=${turnKey} agentId=${agentId} msgId=${pinnedId} durationMs=${ms} error="${err?.message ?? err}"\n`)
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

  function firePin(turnKey: string, agentId: string, chatId: string, messageId: number): void {
    // Called when the pin-delay timer fires. Promote from pendingPins
    // into pinned, then issue the Telegram pin API call.
    const key = pinKey(turnKey, agentId)
    pendingPins.delete(key)
    if (pinned.has(key) || unpinned.has(key)) {
      // Either we already pinned (shouldn't happen — timer is the only
      // path that sets `pinned`) or the turn completed between scheduling
      // and firing and the pending entry was cleared elsewhere. Bail.
      return
    }
    pinned.set(key, messageId)
    log(`telegram gateway: progress-card: pinned turnKey=${turnKey} agentId=${agentId} msgId=${messageId}\n`)
    if (deps.addPin) {
      deps.addPin({
        chatId,
        messageId,
        turnKey,
        pinnedAt: now(),
        agentId,
      })
    }
    const pinStart = now()
    const p = deps.pin(chatId, messageId, { disable_notification: true })
      .then(() => {
        const ms = now() - pinStart
        log(`telegram gateway: progress-card: pin OK turnKey=${turnKey} agentId=${agentId} msgId=${messageId} durationMs=${ms}\n`)
      })
      .catch(
        (err: Error) => {
          const ms = now() - pinStart
          const errMsg = err?.message ?? String(err)
          const line = `telegram gateway: progress-card pin failed chatId=${chatId} msgId=${messageId} turnKey=${turnKey} agentId=${agentId} durationMs=${ms} error="${errMsg}"\n`
          log(line)
          console.warn(line.replace(/\n$/, ''))
          // Pin API failed — drop from the in-memory map so a later
          // unpin attempt doesn't fire `deps.unpin` for a message we
          // never actually pinned. Do NOT add to `unpinned` — we never
          // issued an unpin. Sidecar is also cleared for consistency.
          pinned.delete(key)
          if (deps.removePin) deps.removePin(chatId, messageId)
        },
      )
    track(p)
  }

  return {
    considerPin(c) {
      if (!c.isFirstEmit) return
      const agentId = c.agentId ?? PARENT_AGENT_ID
      const key = pinKey(c.turnKey, agentId)
      if (pinned.has(key)) return
      if (pendingPins.has(key)) return
      // Schedule the pin via the injected timer. Fast-turn suppression is
      // owned upstream by the driver's `initialDelayMs` — by the time
      // considerPin sees isFirstEmit=true the card has already been
      // published, so pinDelayMs defaults to 0 (fire on next tick).
      // The indirection remains so tests and callers can still override
      // with a positive value if they want a pre-pin visual buffer.
      const timer = scheduleTimer(() => {
        firePin(c.turnKey, agentId, c.chatId, c.messageId)
      }, pinDelayMs)
      pendingPins.set(key, {
        chatId: c.chatId,
        messageId: c.messageId,
        turnKey: c.turnKey,
        agentId,
        timer,
      })
    },

    completeTurn({ chatId, turnKey, agentId }) {
      const aid = agentId ?? PARENT_AGENT_ID
      const key = pinKey(turnKey, aid)
      // Fast-turn path: if the pin is still pending, cancel the timer
      // and we're done — no pin ever landed, no unpin needed.
      const pending = pendingPins.get(key)
      if (pending != null) {
        pending.timer.cancel()
        pendingPins.delete(key)
      }
      const pinnedId = pinned.get(key)
      if (pinnedId != null) doUnpin(turnKey, aid, chatId, pinnedId)
      // Once the turn is complete we never see the same composite again
      // (driver generates a fresh sequence for the turn, agentIds are
      // stable per agent lifetime). Clearing the flag keeps the set from
      // growing unbounded over a long-running gateway.
      unpinned.delete(key)
    },

    completeAllForTurn({ chatId, turnKey }) {
      // Snapshot composites for this turn before mutating — pendingPins
      // and pinned will both shrink as we go.
      const matchingPending: Array<{ key: string; agentId: string }> = []
      for (const [key, entry] of pendingPins) {
        if (entry.turnKey === turnKey) matchingPending.push({ key, agentId: entry.agentId })
      }
      for (const { key } of matchingPending) {
        const pending = pendingPins.get(key)
        if (pending != null) {
          pending.timer.cancel()
          pendingPins.delete(key)
        }
      }
      const matchingPinned: Array<{ agentId: string; pinnedId: number }> = []
      for (const [key, pinnedId] of pinned) {
        // Composite keys are `${turnKey}::${agentId}` — split on `::`.
        const sep = key.lastIndexOf('::')
        if (sep < 0) continue
        const tk = key.slice(0, sep)
        if (tk !== turnKey) continue
        const agentId = key.slice(sep + 2)
        matchingPinned.push({ agentId, pinnedId })
      }
      for (const { agentId, pinnedId } of matchingPinned) {
        doUnpin(turnKey, agentId, chatId, pinnedId)
      }
      // Mirror completeTurn's housekeeping: clear unpinned-set entries
      // for this turn so a future reuse (unlikely) starts fresh.
      for (const key of [...unpinned]) {
        const sep = key.lastIndexOf('::')
        if (sep < 0) continue
        if (key.slice(0, sep) === turnKey) unpinned.delete(key)
      }
    },

    unpinForChat(chatId, threadId) {
      const base = threadId != null ? `${chatId}:${threadId}` : chatId
      // Cancel any pending (not-yet-fired) timers for this chat/thread
      // first — otherwise they'd pin after we thought we cleaned up.
      const pendingMatching: string[] = []
      for (const [key, entry] of pendingPins) {
        if (entry.turnKey.startsWith(`${base}:`)) pendingMatching.push(key)
      }
      for (const key of pendingMatching) {
        const pending = pendingPins.get(key)
        if (pending != null) {
          pending.timer.cancel()
          pendingPins.delete(key)
        }
      }
      // Snapshot the entries so doUnpin's map mutation doesn't invalidate
      // iteration mid-loop.
      const matching: Array<{ turnKey: string; agentId: string; pinnedId: number }> = []
      for (const [key, pinnedId] of pinned) {
        const sep = key.lastIndexOf('::')
        if (sep < 0) continue
        const tk = key.slice(0, sep)
        if (!tk.startsWith(`${base}:`)) continue
        const agentId = key.slice(sep + 2)
        matching.push({ turnKey: tk, agentId, pinnedId })
      }
      for (const { turnKey, agentId, pinnedId } of matching) {
        doUnpin(turnKey, agentId, chatId, pinnedId)
      }
    },

    captureServiceMessage({ chatId, pinnedMessageId, serviceMessageId }) {
      // Only act on service messages that wrap one of our tracked pins —
      // otherwise we'd be deleting arbitrary pin-service messages in the
      // chat, which could include user-initiated pins.
      //
      // We match against two sets: per-turn progress-card pins (managed
      // through `considerPin`) AND externally-registered pins (the
      // worker / sub-agent card, registered via `trackExternalPin` —
      // see issue #94).
      let matched = false
      for (const [, msgId] of pinned) {
        if (msgId === pinnedMessageId) { matched = true; break }
      }
      if (!matched && externalPins.has(serviceKey(chatId, pinnedMessageId))) {
        matched = true
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

    trackExternalPin(chatId, messageId) {
      externalPins.add(serviceKey(chatId, messageId))
    },

    untrackExternalPin(chatId, messageId) {
      externalPins.delete(serviceKey(chatId, messageId))
    },

    pinnedTurnKeys() {
      const seen = new Set<string>()
      for (const key of pinned.keys()) {
        const sep = key.lastIndexOf('::')
        if (sep < 0) continue
        seen.add(key.slice(0, sep))
      }
      return [...seen]
    },

    pinnedAgentIds(turnKey) {
      const out: string[] = []
      for (const key of pinned.keys()) {
        const sep = key.lastIndexOf('::')
        if (sep < 0) continue
        if (key.slice(0, sep) !== turnKey) continue
        out.push(key.slice(sep + 2))
      }
      return out
    },

    pinnedMessageId(turnKey, agentId) {
      return pinned.get(pinKey(turnKey, agentId ?? PARENT_AGENT_ID))
    },

    async drainInFlight() {
      // Copy so we don't race with track() adding more while we await.
      const snapshot = [...inFlight]
      await Promise.allSettled(snapshot)
    },
  }
}
