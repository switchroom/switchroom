import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTypingWrapper } from '../typing-wrap.js'

function makeDeps(overrides: { isSurfaceTool?: (name: string) => boolean } = {}) {
  const startTypingLoop = vi.fn<(chatId: string) => void>()
  const stopTypingLoop = vi.fn<(chatId: string) => void>()
  const isSurfaceTool =
    overrides.isSurfaceTool ??
    ((name: string) =>
      name === 'mcp__switchroom-telegram__reply'
      || name === 'mcp__switchroom-telegram__stream_reply'
      || name === 'mcp__switchroom-telegram__edit_message'
      || name === 'mcp__switchroom-telegram__react')
  return { startTypingLoop, stopTypingLoop, isSurfaceTool }
}

describe('createTypingWrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts typing after the debounce window', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'Bash')
    expect(deps.startTypingLoop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    expect(deps.startTypingLoop).toHaveBeenCalledWith('chat-A')
  })

  it('does not start typing if tool_result arrives before the debounce elapses', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'Read')
    vi.advanceTimersByTime(200)
    w.onToolResult('t1')
    // Even after the original debounce would have fired, no start.
    vi.advanceTimersByTime(1000)
    expect(deps.startTypingLoop).not.toHaveBeenCalled()
    expect(deps.stopTypingLoop).not.toHaveBeenCalled()
  })

  it('starts then stops typing when tool_result follows a slow tool', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'WebFetch')
    vi.advanceTimersByTime(600)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    w.onToolResult('t1')
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(1)
    expect(deps.stopTypingLoop).toHaveBeenCalledWith('chat-A')
  })

  it('skips surface tools (reply/stream_reply/edit_message/react)', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'mcp__switchroom-telegram__reply')
    w.onToolUse('t2', 'chat-A', 'mcp__switchroom-telegram__stream_reply')
    w.onToolUse('t3', 'chat-A', 'mcp__switchroom-telegram__edit_message')
    w.onToolUse('t4', 'chat-A', 'mcp__switchroom-telegram__react')
    vi.advanceTimersByTime(5000)
    expect(deps.startTypingLoop).not.toHaveBeenCalled()
    // onToolResult on a surface id is a no-op too (nothing stored).
    w.onToolResult('t1')
    expect(deps.stopTypingLoop).not.toHaveBeenCalled()
  })

  it('handles two parallel tool_use calls on different chats independently', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'Bash')
    w.onToolUse('t2', 'chat-B', 'Grep')
    vi.advanceTimersByTime(500)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)
    expect(deps.startTypingLoop).toHaveBeenNthCalledWith(1, 'chat-A')
    expect(deps.startTypingLoop).toHaveBeenNthCalledWith(2, 'chat-B')

    w.onToolResult('t1')
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(1)
    expect(deps.stopTypingLoop).toHaveBeenLastCalledWith('chat-A')

    w.onToolResult('t2')
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(2)
    expect(deps.stopTypingLoop).toHaveBeenLastCalledWith('chat-B')
  })

  it('drainAll clears pending timers and stops any started loops', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    // One already-started, one still pending.
    w.onToolUse('t1', 'chat-A', 'Bash')
    vi.advanceTimersByTime(500)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    w.onToolUse('t2', 'chat-B', 'Grep')
    // t2 hasn't debounced yet.
    w.drainAll()
    // t1 got a stop; t2's timer was cleared without starting.
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(1)
    expect(deps.stopTypingLoop).toHaveBeenCalledWith('chat-A')
    // Advance — t2's pending timer must not fire post-drain.
    vi.advanceTimersByTime(5000)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    // Subsequent onToolResult for cleared entries is a no-op.
    w.onToolResult('t1')
    w.onToolResult('t2')
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(1)
  })

  it('honours a custom debounceMs', () => {
    const deps = makeDeps()
    const w = createTypingWrapper({ ...deps, debounceMs: 100 })
    w.onToolUse('t1', 'chat-A', 'Bash')
    vi.advanceTimersByTime(99)
    expect(deps.startTypingLoop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
  })
})
