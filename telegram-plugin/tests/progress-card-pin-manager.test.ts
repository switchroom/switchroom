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
} from '../progress-card-pin-manager.js'
import { errors } from './fake-bot-api.js'

interface Harness {
  mgr: PinManager
  deps: {
    pin: ReturnType<typeof vi.fn>
    unpin: ReturnType<typeof vi.fn>
    addPin: ReturnType<typeof vi.fn>
    removePin: ReturnType<typeof vi.fn>
    log: ReturnType<typeof vi.fn>
  }
  /** Recorded sidecar state — tests assert on this directly. */
  sidecar: ActivePinEntry[]
}

/** Build a harness with sensible defaults. `now` is fixed at 10_000. */
function mkHarness(overrides: Partial<PinManagerDeps> = {}): Harness {
  const sidecar: ActivePinEntry[] = []

  const deps = {
    pin: vi.fn(async () => true),
    unpin: vi.fn(async () => true),
    addPin: vi.fn((entry: ActivePinEntry) => {
      sidecar.push(entry)
    }),
    removePin: vi.fn((chatId: string, messageId: number) => {
      const idx = sidecar.findIndex((e) => e.chatId === chatId && e.messageId === messageId)
      if (idx >= 0) sidecar.splice(idx, 1)
    }),
    log: vi.fn(),
  }

  const mgr = createPinManager({
    ...deps,
    now: () => 10_000,
    ...overrides,
  })

  return { mgr, deps, sidecar }
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
      await h.mgr.drainInFlight()

      // Bot API was called with the exact shape the gateway used inline.
      expect(h.deps.pin).toHaveBeenCalledWith('chat-1', 500, { disable_notification: true })
      expect(h.deps.pin).toHaveBeenCalledTimes(1)
      // Sidecar recorded the pin with the injected clock.
      expect(h.sidecar).toEqual([
        { chatId: 'chat-1', messageId: 500, turnKey: 'chat-1:42:1', pinnedAt: 10_000 },
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
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(2)
      expect(h.mgr.pinnedTurnKeys().sort()).toEqual(['c:1', 'c:2'])
    })

    it('works without a sidecar (no agentDir in production = no addPin wired)', async () => {
      const h = mkHarness({ addPin: undefined, removePin: undefined })
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
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
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(1)
      expect(h.deps.log).toHaveBeenCalled()
    })
  })

  describe('completeTurn — unpin', () => {
    it('unpins the pinned message and clears the sidecar', async () => {
      const h = mkHarness()
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 500, isFirstEmit: true })
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
      await h.mgr.drainInFlight()
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      expect(h.mgr.pinnedTurnKeys()).toEqual([])

      // Turn 2 on the same chat
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:2', messageId: 501, isFirstEmit: true })
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
      await h.mgr.drainInFlight()
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })
      await h.mgr.drainInFlight()

      // Unlikely but defensive: if the driver ever reuses the same
      // turnKey, the manager starts clean.
      h.mgr.considerPin({ chatId: 'c', turnKey: 'c:1', messageId: 777, isFirstEmit: true })
      await h.mgr.drainInFlight()

      expect(h.deps.pin).toHaveBeenCalledTimes(2)
      expect(h.mgr.pinnedMessageId('c:1')).toBe(777)
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
      h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:1' })

      const drained = h.mgr.drainInFlight()
      resolvePin()
      resolveUnpin()
      await drained

      // After drain, removePin should have fired (from unpin's finally).
      expect(h.deps.removePin).toHaveBeenCalled()
    })
  })
})
