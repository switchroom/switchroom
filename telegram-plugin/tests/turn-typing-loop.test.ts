import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTurnTypingLoop } from '../gateway/turn-typing-loop.js'

/**
 * Turn-level `typing…` indicator lifecycle — the second "something is happening"
 * signal that runs alongside the early-card-open. Telegram's typing action
 * auto-expires after ~5 s, so the loop must re-fire on a periodic refresh while
 * the turn is in flight and stop cleanly at turn-end WITHOUT leaking a refresh
 * interval. The factory is unit-tested over fake timers + a spy `sendChatAction`
 * so the lifecycle is proven without the gateway or the bot API.
 */

function makeDeps(overrides: { refreshMs?: number } = {}) {
  const sendChatAction =
    vi.fn<(chatId: string, threadId: number | null) => void>()
  // Mirror the gateway's chatKey null/0-collapse: undefined/null thread → '_'.
  const chatKey = (chatId: string, threadId: number | null) =>
    `${chatId}:${threadId == null ? '_' : threadId}`
  return { sendChatAction, chatKey, refreshMs: overrides.refreshMs }
}

describe('createTurnTypingLoop — turn-long typing indicator lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires a typing action immediately on turn start (no wait for the first refresh)', () => {
    const deps = makeDeps()
    const loop = createTurnTypingLoop(deps)
    loop.start('chat-A')
    expect(deps.sendChatAction).toHaveBeenCalledTimes(1)
    expect(deps.sendChatAction).toHaveBeenCalledWith('chat-A', null)
    expect(loop.activeCount()).toBe(1)
  })

  it('refreshes the typing action every refreshMs while the turn is in flight', () => {
    const deps = makeDeps({ refreshMs: 4000 })
    const loop = createTurnTypingLoop(deps)
    loop.start('chat-A')
    expect(deps.sendChatAction).toHaveBeenCalledTimes(1) // immediate
    vi.advanceTimersByTime(4000)
    expect(deps.sendChatAction).toHaveBeenCalledTimes(2) // first refresh
    vi.advanceTimersByTime(8000)
    expect(deps.sendChatAction).toHaveBeenCalledTimes(4) // two more refreshes
  })

  it('stops cleanly on turn end and leaks NO refresh interval afterwards', () => {
    const deps = makeDeps({ refreshMs: 4000 })
    const loop = createTurnTypingLoop(deps)
    loop.start('chat-A')
    vi.advanceTimersByTime(4000)
    expect(deps.sendChatAction).toHaveBeenCalledTimes(2)
    loop.stop('chat-A')
    expect(loop.activeCount()).toBe(0)
    // No further fires after the stop — the interval was cleared, not leaked.
    vi.advanceTimersByTime(60_000)
    expect(deps.sendChatAction).toHaveBeenCalledTimes(2)
  })

  it('stop is idempotent (a no-op when no loop is registered)', () => {
    const deps = makeDeps()
    const loop = createTurnTypingLoop(deps)
    // Stop before any start — must not throw and must remain at zero loops.
    expect(() => loop.stop('chat-A')).not.toThrow()
    expect(loop.activeCount()).toBe(0)
  })

  it('restart on the same key never leaks a second interval (self-heal)', () => {
    const deps = makeDeps({ refreshMs: 4000 })
    const loop = createTurnTypingLoop(deps)
    loop.start('chat-A') // turn 1
    loop.start('chat-A') // turn 2 on the same key (abnormal abort skipped stop)
    // Exactly one live loop, not two.
    expect(loop.activeCount()).toBe(1)
    // After one refresh window, only ONE refresh fired (plus the 2 immediates).
    vi.advanceTimersByTime(4000)
    // 2 immediates (one per start) + 1 refresh from the single live interval.
    expect(deps.sendChatAction).toHaveBeenCalledTimes(3)
  })

  it('isolates per-(chat,thread): stopping topic A leaves topic B running', () => {
    const deps = makeDeps({ refreshMs: 4000 })
    const loop = createTurnTypingLoop(deps)
    loop.start('chat-A', 17) // topic A
    loop.start('chat-A', 23) // topic B — same chat, different thread, own lane
    expect(loop.activeCount()).toBe(2)
    expect(deps.sendChatAction).toHaveBeenNthCalledWith(1, 'chat-A', 17)
    expect(deps.sendChatAction).toHaveBeenNthCalledWith(2, 'chat-A', 23)

    loop.stop('chat-A', 17) // end topic A's turn only
    expect(loop.activeCount()).toBe(1) // topic B still live

    deps.sendChatAction.mockClear()
    vi.advanceTimersByTime(4000)
    // Only topic B refreshes; topic A is fully stopped.
    expect(deps.sendChatAction).toHaveBeenCalledTimes(1)
    expect(deps.sendChatAction).toHaveBeenCalledWith('chat-A', 23)
  })

  it('stopAll clears every live loop (shutdown-drain cleanup) and leaks none', () => {
    const deps = makeDeps({ refreshMs: 4000 })
    const loop = createTurnTypingLoop(deps)
    loop.start('chat-A', 17)
    loop.start('chat-B')
    expect(loop.activeCount()).toBe(2)
    loop.stopAll()
    expect(loop.activeCount()).toBe(0)
    deps.sendChatAction.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(deps.sendChatAction).not.toHaveBeenCalled()
  })

  it('collapses undefined and null threadId to the same lane', () => {
    const deps = makeDeps()
    const loop = createTurnTypingLoop(deps)
    loop.start('chat-A') // undefined thread
    loop.start('chat-A', null) // null thread — same lane (restart, not a 2nd loop)
    expect(loop.activeCount()).toBe(1)
  })
})
