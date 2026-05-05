/**
 * Regression test for #689 — SIGTERM mid-turn must flush pinned progress
 * cards with a "Restart interrupted" banner and unpin them, instead of
 * leaving them frozen on "Working…" forever.
 *
 * The full SIGTERM flush logic in gateway.ts is built around a closure
 * that needs a complete grammY bot harness, so this test exercises the
 * pieces it composes: `pinManager.pinnedEntries()` (the new
 * shutdown-introspection API) and `pinManager.unpinForChat()` (the
 * synchronous unpin path). The gateway's shutdown closure is a trivial
 * map over `pinnedEntries()` calling `editMessageText` + `unpinForChat`
 * — covering those two primitives covers the regression.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createPinManager,
  type PinManagerDeps,
  type TimerHandle,
} from '../progress-card-pin-manager.js'

interface PendingTimer { fn: () => void; cancelled: boolean; fired: boolean }

function mkHarness(overrides: Partial<PinManagerDeps> = {}) {
  const timers: PendingTimer[] = []
  const deps = {
    pin: vi.fn(async () => true),
    unpin: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    addPin: vi.fn(),
    removePin: vi.fn(),
    log: vi.fn(),
  }
  const scheduleTimer = (fn: () => void): TimerHandle => {
    const entry: PendingTimer = { fn, cancelled: false, fired: false }
    timers.push(entry)
    return { cancel() { entry.cancelled = true } }
  }
  const mgr = createPinManager({ ...deps, now: () => 10_000, scheduleTimer, ...overrides })
  const fireTimers = (): void => {
    for (const t of [...timers]) {
      if (t.cancelled || t.fired) continue
      t.fired = true
      t.fn()
    }
  }
  return { mgr, deps, fireTimers }
}

describe('SIGTERM mid-turn progress-card flush (#689)', () => {
  it('pinnedEntries() reports chatId + threadId + messageId for every live pin', async () => {
    const h = mkHarness()
    h.mgr.considerPin({
      chatId: 'chat-A', threadId: '7', turnKey: 'chat-A:7:1',
      messageId: 101, isFirstEmit: true,
    })
    h.mgr.considerPin({
      chatId: 'chat-B', turnKey: 'chat-B:1',
      messageId: 202, isFirstEmit: true,
    })
    h.fireTimers()
    await h.mgr.drainInFlight()

    const entries = h.mgr.pinnedEntries()
    expect(entries).toHaveLength(2)
    const sorted = [...entries].sort((a, b) => a.messageId - b.messageId)
    expect(sorted[0]).toMatchObject({
      chatId: 'chat-A', threadId: '7', turnKey: 'chat-A:7:1',
      messageId: 101, agentId: '__parent__',
    })
    expect(sorted[1]).toMatchObject({
      chatId: 'chat-B', turnKey: 'chat-B:1',
      messageId: 202, agentId: '__parent__',
    })
    // Threadless pins must not invent a threadId field — the gateway
    // shutdown closure skips passing message_thread_id when undefined.
    expect(sorted[1].threadId).toBeUndefined()
  })

  it('simulated SIGTERM: edit-then-unpin every pinned card with the banner', async () => {
    const h = mkHarness()
    h.mgr.considerPin({
      chatId: 'chat-A', threadId: '7', turnKey: 'chat-A:7:1',
      messageId: 101, isFirstEmit: true,
    })
    h.mgr.considerPin({
      chatId: 'chat-B', turnKey: 'chat-B:1',
      messageId: 202, isFirstEmit: true,
    })
    h.fireTimers()
    await h.mgr.drainInFlight()

    // Stand-in for `lockedBot.api.editMessageText`.
    const editMessageText = vi.fn(async () => true)
    const banner = '⚠️ <b>Restart interrupted this work</b>\n<i>SIGTERM: update: pulled X</i>'

    const entries = h.mgr.pinnedEntries()
    const ops = entries.map(({ chatId, threadId, messageId }) =>
      editMessageText(chatId, messageId, banner, { parse_mode: 'HTML' })
        .finally(() => {
          h.mgr.unpinForChat(chatId, threadId != null ? Number(threadId) : undefined)
        }),
    )
    await Promise.allSettled(ops)
    await h.mgr.drainInFlight()

    // Both cards saw the interrupted-banner edit.
    expect(editMessageText).toHaveBeenCalledTimes(2)
    expect(editMessageText).toHaveBeenCalledWith('chat-A', 101, banner, { parse_mode: 'HTML' })
    expect(editMessageText).toHaveBeenCalledWith('chat-B', 202, banner, { parse_mode: 'HTML' })

    // And both cards were unpinned afterwards.
    expect(h.deps.unpin).toHaveBeenCalledWith('chat-A', 101)
    expect(h.deps.unpin).toHaveBeenCalledWith('chat-B', 202)
    expect(h.mgr.pinnedEntries()).toEqual([])
    expect(h.mgr.pinnedTurnKeys()).toEqual([])
  })

  it('unpins even when the banner edit fails (frozen card is worse than no card)', async () => {
    const h = mkHarness()
    h.mgr.considerPin({
      chatId: 'chat-A', threadId: '7', turnKey: 'chat-A:7:1',
      messageId: 101, isFirstEmit: true,
    })
    h.fireTimers()
    await h.mgr.drainInFlight()

    const editMessageText = vi.fn(async () => {
      throw new Error('Bad Request: message to edit not found')
    })
    const banner = '⚠️ <b>Restart interrupted this work</b>\n<i>SIGTERM</i>'

    const entries = h.mgr.pinnedEntries()
    const ops = entries.map(({ chatId, threadId, messageId }) =>
      editMessageText(chatId, messageId, banner, { parse_mode: 'HTML' })
        .catch(() => {})
        .finally(() => {
          h.mgr.unpinForChat(chatId, threadId != null ? Number(threadId) : undefined)
        }),
    )
    await Promise.allSettled(ops)
    await h.mgr.drainInFlight()

    expect(h.deps.unpin).toHaveBeenCalledWith('chat-A', 101)
    expect(h.mgr.pinnedEntries()).toEqual([])
  })
})
