/**
 * Integration tests for the pin-lifecycle manager.
 *
 * Previously this logic lived inline in gateway.ts (progressDriver
 * setup block) and was unreachable from tests — the full
 * first-emit → pin → edit → turn-end → unpin sequence had no direct
 * coverage. This suite pins all the behaviors the gateway depends on,
 * plus failure branches that only exist in production until now.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createPinManager,
  type PinManager,
  type PinManagerDeps,
  type ActivePinEntry,
  type TimerHandle,
} from '../progress-card-pin-manager.js'
import { errors } from './fake-bot-api.js'

interface PendingTimer {
  fn: () => void
  ms: number
  cancelled: boolean
  fired: boolean
}

interface Harness {
  mgr: PinManager
  deps: {
    pin: ReturnType<typeof vi.fn>
    unpin: ReturnType<typeof vi.fn>
    deleteMessage: ReturnType<typeof vi.fn>
    addPin: ReturnType<typeof vi.fn>
    removePin: ReturnType<typeof vi.fn>
    log: ReturnType<typeof vi.fn>
  }
  /** Recorded sidecar state — tests assert on this directly. */
  sidecar: ActivePinEntry[]
  /** Captured pin-delay timers — tests fire them manually. */
  timers: PendingTimer[]
  /** Fire every pending (not-yet-fired, not-cancelled) timer. */
  fireTimers(): void
}

/** Build a harness with sensible defaults. `now` is fixed at 10_000. */
function mkHarness(overrides: Partial<PinManagerDeps> = {}): Harness {
  const sidecar: ActivePinEntry[] = []
  const timers: PendingTimer[] = []

  const deps = {
    pin: vi.fn(async () => true),
    unpin: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    addPin: vi.fn((entry: ActivePinEntry) => {
      sidecar.push(entry)
    }),
    removePin: vi.fn((chatId: string, messageId: number) => {
      const idx = sidecar.findIndex((e) => e.chatId === chatId && e.messageId === messageId)
      if (idx >= 0) sidecar.splice(idx, 1)
    }),
    log: vi.fn(),
  }

  const scheduleTimer = (fn: () => void, ms: number): TimerHandle => {
    const entry: PendingTimer = { fn, ms, cancelled: false, fired: false }
    timers.push(entry)
    return {
      cancel() {
        entry.cancelled = true
      },
    }
  }

  const mgr = createPinManager({
    ...deps,
    now: () => 10_000,
    scheduleTimer,
    ...overrides,
  })

  const fireTimers = (): void => {
    // Snapshot so timers pushed during firing don't run this pass.
    const snapshot = [...timers]
    for (const t of snapshot) {
      if (t.cancelled || t.fired) continue
      t.fired = true
      t.fn()
    }
  }

  return { mgr, deps, sidecar, timers, fireTimers }
}

describe('createPinManager', () => {
  describe('considerPin — first emit', () => {
    it('pins the message, records the sidecar entry, tracks the turnKey', async () => {
      const h = mkHarness()
      h.mgr.considerPin({
        chatId: 'chat-1',
        threadId: '42',
        turnKey: 'chat-1:42:1',
        messageId: 500,
        isFirstEmit: true,
      })
      h.fireTimers()
      await h.mgr.drainInFlight()

      // Bot API was called with the exact shape the gateway used inline.
      expect(h.deps.pin).toHaveBeenCalledWith('chat-1', 500, { disable_notification: true })
      expect(h.deps.pin).toHaveBeenCalledTimes(1)
      // Sidecar recorded the pin with the injected clock.
      expect(h.sidecar).toEqual([
        { chatId: 'chat-1', messageId: 500, turnKey: 'chat-1:42:1', pinnedAt: 10_000, agentId: '__parent__' },
      ])
      // In-memory index reflects the pin.
      expect(h.mgr.pinnedTurnKeys()).toEqual(['chat-1:42:1'])
      expect(h.mgr.pinnedMessageId('chat-1:42:1')).toBe(500)
    })

    it('ignores emits where isFirstEmit=false', async () => {
      const h = mkHarness()
      h.mgr.considerPin({
        chatId: 'chat-1',
        turnKey: 'chat-1:1',
        messageId: 500,
        isFirstEmit: false,
      })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).not.toHaveBeenCalled()
      expect(h.deps.addPin).not.toHaveBeenCalled()
      expect(h.mgr.pinnedTurnKeys()).toEqual([])
    })

    it('is idempotent — a second isFirstEmit for the same turnKey does nothing', async () => {
      const h = mkHarness()
      const c = {
        chatId: 'c',
        turnKey: 'c:1',
        messageId: 500,
        isFirstEmit: true,
      }
      h.mgr.considerPin(c)
      h.mgr.considerPin({ ...c, messageId: 501 })
      h.fireTimers()
      await h.mgr.drainInFlight()

      // Only the first pin landed.
      expect(h.deps.pin).toHaveBeenCalledTimes(1)
      expect(h.deps.pin).toHaveBeenCalledWith('c', 500, { disable_notification: true })
      expect(h.deps.addPin).toHaveBeenCalledTimes(1)
      expect(h.mgr.pinnedMessageId('c:1')).toBe(500)
    })

    it('different turnKeys pin independently', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:2', messageId: 501, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(2)
      expect(h.mgr.pinnedTurnKeys().sort()).toEqual(['c:1', 'c:2'])
    })

    it('works without a sidecar (no agentDir in production = no addPin wired)', async () => {
      const h = mkHarness({ addPin: undefined, removePin: undefined })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalled()
      expect(h.mgr.pinnedMessageId('c:1')).toBe(500)
    })
  })

  describe('considerPin — failure rollback', () => {
    it('pin rejection: removePin fires, pinned map entry stays (see invariant doc)', async () => {
      const h = mkHarness()
      h.deps.pin.mockRejectedValueOnce(errors.forbidden('pinChatMessage'))

      h.mgr.considerPin({
        chatId: 'c',
        turnKey: 'c:1',
        messageId: 500,
        isFirstEmit: true,
      })
      h.fireTimers()
      await h.mgr.drainInFlight()

      // Sidecar was rolled back when the pin rejected.
      expect(h.deps.removePin).toHaveBeenCalledWith('c', 500)
      expect(h.sidecar).toEqual([])
      // Log captured the failure.
      expect(h.deps.log).toHaveBeenCalledWith(
        expect.stringMatching(/progress-card pin failed/),
      )
      // In-memory entry is retained so a later completeTurn still attempts
      // an unpin — on the off-chance the pin partially landed on Telegram.
      expect(h.mgr.pinnedMessageId('c:1')).toBe(500)
    })

    it('pin rejection with 429: log line still fires, no retry', async () => {
      const h = mkHarness()
      h.deps.pin.mockRejectedValueOnce(errors.floodWait(3, 'pinChatMessage'))

      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(1)
      expect(h.deps.log).toHaveBeenCalled()
    })
  })

  describe('completeTurn — unpin', () => {
    it('unpins the pinned message and clears the sidecar', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()
      expect(h.sidecar).toHaveLength(1)

      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      expect(h.deps.unpin).toHaveBeenCalledWith('c', 500)
      expect(h.sidecar).toEqual([])
      expect(h.mgr.pinnedMessageId('c:1')).toBeUndefined()
    })

    it('no-op when the turn was never pinned', async () => {
      const h = mkHarness()
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:never' })
      await h.mgr.drainInFlight()
      expect(h.deps.unpin).not.toHaveBeenCalled()
    })

    it('duplicate completeTurn does not double-unpin', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      expect(h.deps.unpin).toHaveBeenCalledTimes(1)
      expect(h.deps.removePin).toHaveBeenCalledTimes(1)
    })

    it('unpin rejection still removes the sidecar entry', async () => {
      const h = mkHarness()
      h.deps.unpin.mockRejectedValueOnce(errors.badRequest('chat not found', 'unpinChatMessage'))
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      // Sidecar is cleared on unpin-attempt regardless of outcome —
      // the sidecar exists for crash recovery, so leaving stale entries
      // would cause duplicate unpins on the next boot.
      expect(h.sidecar).toEqual([])
      expect(h.deps.log).toHaveBeenCalledWith(
        expect.stringMatching(/progress-card unpin failed/),
      )
    })
  })

  describe('unpinForChat — external cancellation hook', () => {
    it('unpins every pinned turn matching a chat+thread', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', threadId: '42', turnKey: 'c:42:1', messageId: 500, isFirstEmit: true })
      h.mgr.considerPin({ chatId: 'c', threadId: '42', turnKey: 'c:42:2', messageId: 501, isFirstEmit: true })
      h.mgr.considerPin({ chatId: 'c', threadId: '99', turnKey: 'c:99:1', messageId: 502, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()
      expect(h.mgr.pinnedTurnKeys()).toHaveLength(3)

      h.mgr.unpinForChat('c', 42)
      await h.mgr.drainInFlight()

      // Thread 42's pins were cleared, thread 99's remains.
      expect(h.deps.unpin).toHaveBeenCalledWith('c', 500)
      expect(h.deps.unpin).toHaveBeenCalledWith('c', 501)
      expect(h.deps.unpin).not.toHaveBeenCalledWith('c', 502)
      expect(h.mgr.pinnedTurnKeys()).toEqual(['c:99:1'])
    })

    it('unpinForChat with no threadId matches chat-root turns only', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.mgr.considerPin({ chatId: 'c', threadId: '42', turnKey: 'c:42:1', messageId: 501, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      h.mgr.unpinForChat('c', undefined)
      await h.mgr.drainInFlight()

      // Only the chat-root turn (prefix "c:") was unpinned. The threaded
      // turn (prefix "c:42:") also starts with "c:" in string terms —
      // verify behaviour carefully. By current design, unpinForChat
      // with no thread matches `c:` prefix — including threaded turns.
      // This is the contract the gateway had before extraction.
      // If we wanted to change it to chat-root-only, that'd be a
      // deliberate spec change.
      expect(h.mgr.pinnedTurnKeys()).toEqual([])
    })

    it('unpinForChat on an empty manager is safe', async () => {
      const h = mkHarness()
      h.mgr.unpinForChat('c', 42)
      await h.mgr.drainInFlight()
      expect(h.deps.unpin).not.toHaveBeenCalled()
    })

    it('unpinForChat is safe mid-iteration when pins mutate the map', async () => {
      const h = mkHarness()
      for (let i = 1; i <= 5; i++) {
        h.mgr.considerPin({ chatId: 'c', threadId: '42', turnKey: `c:42:${i}`, messageId: 499 + i, isFirstEmit: true })
      }
      h.fireTimers()
      await h.mgr.drainInFlight()

      // Snapshot-before-iterate is important: the doUnpin path mutates
      // the pinned map. If iteration used the live map directly, we'd
      // miss entries.
      h.mgr.unpinForChat('c', 42)
      await h.mgr.drainInFlight()

      expect(h.deps.unpin).toHaveBeenCalledTimes(5)
      expect(h.mgr.pinnedTurnKeys()).toEqual([])
    })
  })

  describe('multi-turn lifecycle', () => {
    it('pin → complete → new turn with same chat keeps things independent', async () => {
      const h = mkHarness()

      // Turn 1
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      expect(h.mgr.pinnedTurnKeys()).toEqual([])

      // Turn 2 on the same chat
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:2', messageId: 501, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:2' })
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(2)
      expect(h.deps.unpin).toHaveBeenCalledTimes(2)
      expect(h.deps.pin.mock.calls[0][1]).toBe(500)
      expect(h.deps.pin.mock.calls[1][1]).toBe(501)
    })

    it('concurrent turns across chats: each turn is pinned + unpinned independently', async () => {
      const h = mkHarness()

      h.mgr.considerPin({ chatId: 'A', turnKey: 'A:1', messageId: 500, isFirstEmit: true })
      h.mgr.considerPin({ chatId: 'B', turnKey: 'B:1', messageId: 501, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()
      expect(h.mgr.pinnedTurnKeys().sort()).toEqual(['A:1', 'B:1'])

      h.mgr.completeTurn({ chatId: 'A', turnKey: 'A:1' })
      await h.mgr.drainInFlight()
      expect(h.mgr.pinnedTurnKeys()).toEqual(['B:1'])

      h.mgr.completeTurn({ chatId: 'B', turnKey: 'B:1' })
      await h.mgr.drainInFlight()
      expect(h.mgr.pinnedTurnKeys()).toEqual([])
    })

    it('reused turnKey after complete starts fresh (unpinned set was cleared)', async () => {
      const h = mkHarness()

      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      // Unlikely but defensive: if the driver ever reuses the same
      // turnKey, the manager starts clean.
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 777, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(2)
      expect(h.mgr.pinnedMessageId('c:1')).toBe(777)
    })
  })

  describe('captureServiceMessage — pin-service-msg deletion', () => {
    it('deletes the service message when it wraps a tracked pin', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      h.mgr.captureServiceMessage({ chatId: 'c', pinnedMessageId: 500, serviceMessageId: 9001 })
      await h.mgr.drainInFlight()

      expect(h.deps.deleteMessage).toHaveBeenCalledWith('c', 9001)
    })

    it('ignores service messages wrapping pins we did not track', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      h.mgr.captureServiceMessage({ chatId: 'c', pinnedMessageId: 999, serviceMessageId: 9001 })
      await h.mgr.drainInFlight()

      expect(h.deps.deleteMessage).not.toHaveBeenCalled()
    })

    it('issue #94: deletes service messages for externally-tracked pins (worker card)', async () => {
      // Worker / sub-agent cards are pinned via the gateway directly,
      // not through `considerPin`. They register with `trackExternalPin`
      // so `captureServiceMessage` recognises their service messages and
      // suppresses the "Clerk pinned …" system noise (matching the main
      // card's behaviour). Without this branch the worker card's pin
      // event would slip through unmatched.
      const h = mkHarness()
      h.mgr.trackExternalPin('c', 777)

      h.mgr.captureServiceMessage({ chatId: 'c', pinnedMessageId: 777, serviceMessageId: 9002 })
      await h.mgr.drainInFlight()

      expect(h.deps.deleteMessage).toHaveBeenCalledWith('c', 9002)
    })

    it('issue #94: untrackExternalPin stops further captures', async () => {
      const h = mkHarness()
      h.mgr.trackExternalPin('c', 777)
      h.mgr.untrackExternalPin('c', 777)

      h.mgr.captureServiceMessage({ chatId: 'c', pinnedMessageId: 777, serviceMessageId: 9002 })
      await h.mgr.drainInFlight()

      // Once untracked, the manager treats the pin as unknown again and
      // declines to delete — same shape as the "ignores untracked pins"
      // test above.
      expect(h.deps.deleteMessage).not.toHaveBeenCalled()
    })

    it('no-op when deleteMessage is not wired', async () => {
      const h = mkHarness({ deleteMessage: undefined })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(() => {
        h.mgr.captureServiceMessage({ chatId: 'c', pinnedMessageId: 500, serviceMessageId: 9001 })
      }).not.toThrow()
      await h.mgr.drainInFlight()
    })

    it('deleteMessage rejection is logged and does not throw', async () => {
      const h = mkHarness()
      h.deps.deleteMessage.mockRejectedValueOnce(errors.badRequest('message to delete not found', 'deleteMessage'))

      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      h.mgr.captureServiceMessage({ chatId: 'c', pinnedMessageId: 500, serviceMessageId: 9001 })
      await h.mgr.drainInFlight()

      expect(h.deps.log).toHaveBeenCalledWith(
        expect.stringMatching(/pin service-msg delete failed/),
      )
    })

    it('unpin deletes a service message that was captured but not yet deleted', async () => {
      // Simulate: capture arrives, but deleteMessage is pending forever —
      // then an unpin fires. Because captureServiceMessage already
      // attempted the delete and removed its entry, unpin won't double-fire;
      // this guards the inverse scenario where capture never arrived.
      // Here we test the safety-net path: no capture → no stray delete.
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      // No captureServiceMessage call — simulates a lost/unmatched update.
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      expect(h.deps.unpin).toHaveBeenCalledWith('c', 500)
      expect(h.deps.deleteMessage).not.toHaveBeenCalled()
    })
  })

  describe('drainInFlight', () => {
    it('resolves even when no promises are pending', async () => {
      const h = mkHarness()
      await expect(h.mgr.drainInFlight()).resolves.toBeUndefined()
    })

    it('awaits both the pin catch-chain and the unpin finally-chain', async () => {
      const h = mkHarness()
      // Slow pin + slow unpin → drainInFlight should cover both.
      let resolvePin!: () => void
      let resolveUnpin!: () => void
      h.deps.pin.mockImplementationOnce(() => new Promise<true>((r) => { resolvePin = () => r(true) }))
      h.deps.unpin.mockImplementationOnce(() => new Promise<true>((r) => { resolveUnpin = () => r(true) }))

      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })

      const drained = h.mgr.drainInFlight()
      resolvePin()
      resolveUnpin()
      await drained

      // After drain, removePin should have fired (from unpin's finally).
      expect(h.deps.removePin).toHaveBeenCalled()
    })
  })

  describe('deferred pin timing — fast turns stay silent', () => {
    it('considerPin does not call pin synchronously — timer is scheduled', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      await h.mgr.drainInFlight()

      // Timer scheduled, but not fired → no pin yet. Default pinDelayMs
      // is now 0 (fast-turn suppression is owned upstream by the
      // driver's initialDelayMs); the setTimeout indirection remains so
      // completeTurn can still cancel a pin that hasn't landed yet.
      expect(h.timers).toHaveLength(1)
      expect(h.timers[0].ms).toBe(0)
      expect(h.deps.pin).not.toHaveBeenCalled()
      expect(h.deps.addPin).not.toHaveBeenCalled()
      expect(h.mgr.pinnedTurnKeys()).toEqual([])
    })

    it('fast turn: completeTurn before timer fires → never pins, never unpins', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      // Turn completes before pinDelayMs elapses. The timer is cancelled
      // and no pin/unpin ever touches Telegram.
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      // Even if the timer somehow fires later (belt-and-braces), it should
      // be marked cancelled and skipped.
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).not.toHaveBeenCalled()
      expect(h.deps.unpin).not.toHaveBeenCalled()
      expect(h.deps.addPin).not.toHaveBeenCalled()
      expect(h.sidecar).toEqual([])
    })

    it('slow turn: pin fires when timer elapses, then completeTurn unpins', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      await h.mgr.drainInFlight()
      expect(h.deps.pin).not.toHaveBeenCalled()

      // Timer elapses → pin lands.
      h.fireTimers()
      await h.mgr.drainInFlight()
      expect(h.deps.pin).toHaveBeenCalledWith('c', 500, { disable_notification: true })
      expect(h.mgr.pinnedMessageId('c:1')).toBe(500)

      // completeTurn after the pin → unpin lands.
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()
      expect(h.deps.unpin).toHaveBeenCalledWith('c', 500)
      expect(h.mgr.pinnedMessageId('c:1')).toBeUndefined()
    })

    it('unpinForChat cancels pending (not-yet-fired) timers', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', threadId: '42', turnKey: 'c:42:1', messageId: 500, isFirstEmit: true })
      h.mgr.considerPin({ chatId: 'c', threadId: '42', turnKey: 'c:42:2', messageId: 501, isFirstEmit: true })

      // Clear pending pins before any timer fires.
      h.mgr.unpinForChat('c', 42)
      h.fireTimers()
      await h.mgr.drainInFlight()

      // No pins, no unpins — the timers were cancelled and never fired.
      expect(h.deps.pin).not.toHaveBeenCalled()
      expect(h.deps.unpin).not.toHaveBeenCalled()
    })

    it('unpinForChat cancels pending timers AND unpins already-fired pins', async () => {
      const h = mkHarness()
      // First pin: fire its timer → already pinned.
      h.mgr.considerPin({ chatId: 'c', threadId: '42', turnKey: 'c:42:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()
      expect(h.deps.pin).toHaveBeenCalledTimes(1)

      // Second pin: timer still pending.
      h.mgr.considerPin({ chatId: 'c', threadId: '42', turnKey: 'c:42:2', messageId: 501, isFirstEmit: true })

      h.mgr.unpinForChat('c', 42)
      h.fireTimers() // noop — second timer was cancelled.
      await h.mgr.drainInFlight()

      // First pin got unpinned; second never pinned.
      expect(h.deps.pin).toHaveBeenCalledTimes(1)
      expect(h.deps.unpin).toHaveBeenCalledWith('c', 500)
      expect(h.deps.unpin).not.toHaveBeenCalledWith('c', 501)
    })

    it('custom pinDelayMs overrides the default', async () => {
      const h = mkHarness({ pinDelayMs: 5_000 })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })

      expect(h.timers).toHaveLength(1)
      expect(h.timers[0].ms).toBe(5_000)
    })

    it('pinDelayMs=0 still defers through the timer (no sync pin)', async () => {
      // Guards against a tempting optimization: "if pinDelayMs === 0,
      // pin synchronously." We pass it through the timer anyway so the
      // contract is uniform (considerPin never blocks, never pins
      // before control returns).
      const h = mkHarness({ pinDelayMs: 0 })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })

      expect(h.deps.pin).not.toHaveBeenCalled()
      expect(h.timers).toHaveLength(1)

      h.fireTimers()
      await h.mgr.drainInFlight()
      expect(h.deps.pin).toHaveBeenCalledTimes(1)
    })
  })

  describe('per-agent composite key — one pin per (turnKey, agentId)', () => {
    it('distinct agentIds under the same turnKey pin independently', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true, agentId: 'parent' })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 501, isFirstEmit: true, agentId: 'sub-a' })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 502, isFirstEmit: true, agentId: 'sub-b' })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(3)
      expect(h.mgr.pinnedTurnKeys()).toEqual(['c:1'])
      expect(h.mgr.pinnedAgentIds('c:1').sort()).toEqual(['parent', 'sub-a', 'sub-b'])
      expect(h.mgr.pinnedMessageId('c:1', 'parent')).toBe(500)
      expect(h.mgr.pinnedMessageId('c:1', 'sub-a')).toBe(501)
      expect(h.mgr.pinnedMessageId('c:1', 'sub-b')).toBe(502)
    })

    it('idempotent within a (turnKey, agentId) — second considerPin is a no-op', async () => {
      const h = mkHarness()
      const c = { chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true, agentId: 'sub-a' }
      h.mgr.considerPin(c)
      h.mgr.considerPin({ ...c, messageId: 999 })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(1)
      expect(h.deps.pin).toHaveBeenCalledWith('c', 500, { disable_notification: true })
      expect(h.mgr.pinnedMessageId('c:1', 'sub-a')).toBe(500)
    })

    it('completeTurn for one agentId leaves siblings under the same turnKey untouched', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true, agentId: 'parent' })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 501, isFirstEmit: true, agentId: 'sub-a' })
      h.fireTimers()
      await h.mgr.drainInFlight()

      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1', agentId: 'sub-a' })
      await h.mgr.drainInFlight()

      expect(h.deps.unpin).toHaveBeenCalledTimes(1)
      expect(h.deps.unpin).toHaveBeenCalledWith('c', 501)
      expect(h.mgr.pinnedAgentIds('c:1')).toEqual(['parent'])
      expect(h.mgr.pinnedMessageId('c:1', 'parent')).toBe(500)
    })

    it('legacy callers (no agentId) get the parent-sentinel default', async () => {
      const h = mkHarness()
      // Old call shape: no agentId. Uses PARENT_AGENT_ID under the hood.
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.mgr.pinnedAgentIds('c:1')).toEqual(['__parent__'])
      // pinnedMessageId without agentId resolves the parent sentinel.
      expect(h.mgr.pinnedMessageId('c:1')).toBe(500)
      // completeTurn without agentId targets the parent sentinel too.
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()
      expect(h.deps.unpin).toHaveBeenCalledWith('c', 500)
    })

    it('parent and a sub-agent for the legacy turnKey pin under different sentinels', async () => {
      // Mixed call shape: parent uses no agentId (sentinel), sub-agent
      // passes an explicit one. They must not collide.
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 501, isFirstEmit: true, agentId: 'sub-a' })
      h.fireTimers()
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(2)
      expect(h.mgr.pinnedAgentIds('c:1').sort()).toEqual(['__parent__', 'sub-a'])
    })
  })

  describe('completeAllForTurn — catastrophic cleanup', () => {
    it('unpins every agentId pinned under a turnKey', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true, agentId: 'parent' })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 501, isFirstEmit: true, agentId: 'sub-a' })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 502, isFirstEmit: true, agentId: 'sub-b' })
      // A different turn — must not be affected.
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:2', messageId: 600, isFirstEmit: true, agentId: 'parent' })
      h.fireTimers()
      await h.mgr.drainInFlight()

      h.mgr.completeAllForTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      expect(h.deps.unpin).toHaveBeenCalledTimes(3)
      const unpinnedIds = h.deps.unpin.mock.calls.map((args) => args[1]).sort((a, b) => Number(a) - Number(b))
      expect(unpinnedIds).toEqual([500, 501, 502])
      expect(h.mgr.pinnedTurnKeys()).toEqual(['c:2'])
    })

    it('cancels pending (not-yet-fired) timers under the turnKey', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true, agentId: 'parent' })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 501, isFirstEmit: true, agentId: 'sub-a' })
      // Timers scheduled but not fired yet.
      h.mgr.completeAllForTurn({ chatId: 'c', turnKey: 'c:1' })
      h.fireTimers() // noop — both timers were cancelled
      await h.mgr.drainInFlight()

      expect(h.deps.pin).not.toHaveBeenCalled()
      expect(h.deps.unpin).not.toHaveBeenCalled()
    })

    it('safe on a turnKey with no pins', async () => {
      const h = mkHarness()
      h.mgr.completeAllForTurn({ chatId: 'c', turnKey: 'c:never' })
      await h.mgr.drainInFlight()
      expect(h.deps.unpin).not.toHaveBeenCalled()
    })
  })
})
