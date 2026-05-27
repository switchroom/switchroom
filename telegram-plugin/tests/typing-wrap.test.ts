import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTypingWrapper } from '../typing-wrap.js'

function makeDeps(overrides: { isSurfaceTool?: (name: string) => boolean } = {}) {
  // PR3 supergroup-mode: start/stop now take (chatId, threadId?). The
  // existing tests cover the chatId-only case (threadId omitted → null);
  // new tests below pin the per-thread isolation.
  const startTypingLoop = vi.fn<(chatId: string, threadId?: number | null) => void>()
  const stopTypingLoop = vi.fn<(chatId: string, threadId?: number | null) => void>()
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

  it('starts typing immediately on the first tool call for a chat (no debounce)', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'Bash')
    // First tool on a fresh chat fires immediately — no timer wait required.
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    expect(deps.startTypingLoop).toHaveBeenCalledWith('chat-A', null)
  })

  it('a parallel second tool on the same chat uses the debounce', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    // First tool fires immediately.
    w.onToolUse('t1', 'chat-A', 'Bash')
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    // Second tool while t1 is still in-flight: chat-A is active, so debounce applies.
    w.onToolUse('t2', 'chat-A', 'Read')
    // No second start yet.
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    // After debounce elapses, second call fires.
    vi.advanceTimersByTime(500)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)
  })

  it('does not start an extra loop for a fast parallel tool that resolves before its debounce', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    // First tool fires immediately.
    w.onToolUse('t1', 'chat-A', 'Bash')
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    // Second tool while t1 is still in-flight.
    w.onToolUse('t2', 'chat-A', 'Read')
    vi.advanceTimersByTime(200)
    // t2 resolves before its debounce — no second start.
    w.onToolResult('t2')
    vi.advanceTimersByTime(1000)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
  })

  it('starts then stops typing when a single slow tool completes', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'WebFetch')
    // Fires immediately (first tool).
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    w.onToolResult('t1')
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(1)
    expect(deps.stopTypingLoop).toHaveBeenCalledWith('chat-A', null)
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
    // Both are the first tool on their respective chats — both fire immediately.
    w.onToolUse('t1', 'chat-A', 'Bash')
    w.onToolUse('t2', 'chat-B', 'Grep')
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)
    expect(deps.startTypingLoop).toHaveBeenNthCalledWith(1, 'chat-A', null)
    expect(deps.startTypingLoop).toHaveBeenNthCalledWith(2, 'chat-B', null)

    w.onToolResult('t1')
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(1)
    expect(deps.stopTypingLoop).toHaveBeenLastCalledWith('chat-A', null)

    w.onToolResult('t2')
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(2)
    expect(deps.stopTypingLoop).toHaveBeenLastCalledWith('chat-B', null)
  })

  it('drainAll clears pending entries and stops any started loops', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    // First calls on each chat fire immediately.
    w.onToolUse('t1', 'chat-A', 'Bash')
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    w.onToolUse('t2', 'chat-B', 'Grep')
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)
    w.drainAll()
    // Both loops stopped.
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(2)
    // Advance — no stray timers fire post-drain.
    vi.advanceTimersByTime(5000)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)
    // Subsequent onToolResult for cleared entries is a no-op.
    w.onToolResult('t1')
    w.onToolResult('t2')
    expect(deps.stopTypingLoop).toHaveBeenCalledTimes(2)
  })

  it('honours a custom debounceMs for parallel overlapping tools on the same chat', () => {
    const deps = makeDeps()
    const w = createTypingWrapper({ ...deps, debounceMs: 100 })
    // First tool fires immediately.
    w.onToolUse('t1', 'chat-A', 'Bash')
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    // Second tool while t1 is in-flight: uses custom debounce.
    w.onToolUse('t2', 'chat-A', 'Read')
    vi.advanceTimersByTime(99)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)
  })

  // ─── PR3 supergroup-mode: per-(chat,thread) lane isolation ────────────
  it('SAME chat + DIFFERENT threads each get their own immediate-fire lane', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    // Both are "first tool on lane" — both fire immediately, not debounced.
    w.onToolUse('t1', 'chat-A', 'Bash', 17)
    w.onToolUse('t2', 'chat-A', 'Read', 23)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)
    expect(deps.startTypingLoop).toHaveBeenNthCalledWith(1, 'chat-A', 17)
    expect(deps.startTypingLoop).toHaveBeenNthCalledWith(2, 'chat-A', 23)
  })

  it('SAME chat + SAME thread STILL uses debounce on the second tool', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'Bash', 17)
    w.onToolUse('t2', 'chat-A', 'Read', 17)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)
  })

  it('stopping topic A does NOT clear topic B\'s lane (the headline bug fix)', () => {
    // The bug: chatId-only keying meant `activeChats.delete(chatId)`
    // when topic A's tool ended ALSO marked topic B's lane as inactive,
    // so topic B's next tool would re-fire immediately (wrong — it's
    // already typing) and a subsequent stop could mismatch.
    // Per-(chat,thread) lane keying preserves independence.
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'Bash', 17)   // topic A lane: active
    w.onToolUse('t2', 'chat-A', 'Read', 23)   // topic B lane: active (independent)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)

    w.onToolResult('t1')  // topic A done
    expect(deps.stopTypingLoop).toHaveBeenLastCalledWith('chat-A', 17)
    // Topic B is still active — a third tool on topic B should DEBOUNCE
    // (lane is still active), not fire immediately.
    w.onToolUse('t3', 'chat-A', 'Edit', 23)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(2)  // no immediate fire
    vi.advanceTimersByTime(500)
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(3)
    expect(deps.startTypingLoop).toHaveBeenLastCalledWith('chat-A', 23)
  })

  it('treats undefined / null threadId as the same lane (chatKey null/0 collapse)', () => {
    const deps = makeDeps()
    const w = createTypingWrapper(deps)
    w.onToolUse('t1', 'chat-A', 'Bash')           // undefined thread
    w.onToolUse('t2', 'chat-A', 'Read', null)     // null thread — same lane
    expect(deps.startTypingLoop).toHaveBeenCalledTimes(1)  // only first fires immediately
    expect(deps.startTypingLoop).toHaveBeenLastCalledWith('chat-A', null)
  })
})
