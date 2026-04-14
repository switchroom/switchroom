/**
 * Integration tests for the PTY partial handler state machine.
 *
 * These run against the real `createStreamController` (backed by the mock
 * bot harness) so they exercise the full send/edit wiring — not just the
 * decision logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPtyPartialHandler,
  handlePtyPartialPure,
  type PtyHandlerState,
  type PtyHandlerDeps,
} from '../pty-partial-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'

function makeState(overrides?: Partial<PtyHandlerState>): PtyHandlerState {
  return {
    currentSessionChatId: null,
    currentSessionThreadId: undefined,
    pendingPtyPartial: null,
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
    suppressPtyPreview: new Set<string>(),
    lastPtyPreviewByChat: new Map<string, string>(),
    ...overrides,
  }
}

function makeDeps(
  bot: ReturnType<typeof createMockBot>,
  overrides?: Partial<PtyHandlerDeps>,
): PtyHandlerDeps {
  return {
    bot,
    renderText: (t) => t, // identity for tests — easier to assert
    ...overrides,
  }
}

describe('handlePtyPartialPure', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('buffers the first partial when chatId is not yet known', () => {
    const state = makeState()
    const action = handlePtyPartialPure('drafting', state, makeDeps(bot))
    expect(action).toBe('buffered')
    expect(state.pendingPtyPartial).toEqual({ text: 'drafting' })
    expect(state.activeDraftStreams.size).toBe(0)
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  it('suppressed chat drops partial (no state mutation, no send)', () => {
    const state = makeState({
      currentSessionChatId: '1',
      suppressPtyPreview: new Set(['1:_']),
    })
    const action = handlePtyPartialPure('should be dropped', state, makeDeps(bot))
    expect(action).toBe('suppressed')
    expect(state.activeDraftStreams.size).toBe(0)
    expect(state.lastPtyPreviewByChat.size).toBe(0)
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  it('dedups when same text arrives twice in a row', async () => {
    const state = makeState({ currentSessionChatId: '1' })
    const deps = makeDeps(bot)

    expect(handlePtyPartialPure('same', state, deps)).toBe('update-new')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)

    expect(handlePtyPartialPure('same', state, deps)).toBe('dedup-skip')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1) // no second call
    expect(bot.api.editMessageText).not.toHaveBeenCalled()
  })

  it('first partial for a chat triggers onFirstPartial exactly once', async () => {
    const state = makeState({ currentSessionChatId: '1' })
    const onFirstPartial = vi.fn<(chatId: string, chars: number) => void>()
    const deps = makeDeps(bot, { onFirstPartial })

    handlePtyPartialPure('hello', state, deps)
    handlePtyPartialPure('hello world', state, deps)
    await microtaskFlush()

    expect(onFirstPartial).toHaveBeenCalledTimes(1)
    expect(onFirstPartial).toHaveBeenCalledWith('1', 5)
  })

  it('applies renderText before pushing into the stream', async () => {
    const state = makeState({ currentSessionChatId: '1' })
    const deps = makeDeps(bot, {
      renderText: (t) => `<b>${t}</b>`,
    })

    handlePtyPartialPure('bold', state, deps)
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('<b>bold</b>')
  })

  it('reuses an existing stream on second update', async () => {
    const state = makeState({ currentSessionChatId: '1' })
    const deps = makeDeps(bot)

    expect(handlePtyPartialPure('one', state, deps)).toBe('update-new')
    await microtaskFlush()

    vi.advanceTimersByTime(1000)
    expect(handlePtyPartialPure('two', state, deps)).toBe('update-existing')
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('two')
  })

  it('keyed by chat+thread — independent streams per forum topic', async () => {
    const state = makeState({ currentSessionChatId: '1', currentSessionThreadId: 10 })
    const deps = makeDeps(bot)
    handlePtyPartialPure('topic A', state, deps)
    state.currentSessionThreadId = 20
    handlePtyPartialPure('topic B', state, deps)
    await microtaskFlush()

    expect(state.activeDraftStreams.size).toBe(2)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('onStreamSend fires with chatId + messageId after initial send lands', async () => {
    const state = makeState({ currentSessionChatId: '1' })
    const onStreamSend = vi.fn<(chatId: string, messageId: number, chars: number) => void>()
    const deps = makeDeps(bot, { onStreamSend })

    handlePtyPartialPure('hi', state, deps)
    await microtaskFlush()

    expect(onStreamSend).toHaveBeenCalledWith('1', 500, 2)
  })
})

describe('createPtyPartialHandler — session + buffer replay', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('buffers partial arriving before enqueue, replays on onSessionEnqueue', async () => {
    const state = makeState()
    const handler = createPtyPartialHandler(state, makeDeps(bot))

    expect(handler.onPartial('early partial')).toBe('buffered')
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
    expect(state.pendingPtyPartial).toEqual({ text: 'early partial' })

    const replayed = handler.onSessionEnqueue('42')
    await microtaskFlush()

    expect(replayed).toBe('update-new')
    expect(state.pendingPtyPartial).toBeNull()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage.mock.calls[0][0]).toBe('42')
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('early partial')
  })

  it('onSessionEnqueue with no buffered partial is a no-op send-wise', () => {
    const state = makeState()
    const handler = createPtyPartialHandler(state, makeDeps(bot))

    const result = handler.onSessionEnqueue('42', 7)
    expect(result).toBeNull()
    expect(state.currentSessionChatId).toBe('42')
    expect(state.currentSessionThreadId).toBe(7)
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  it('onTurnEnd clears session + dedup cache for the active chat only', async () => {
    const state = makeState()
    const handler = createPtyPartialHandler(state, makeDeps(bot))

    handler.onSessionEnqueue('A')
    handler.onPartial('text A')
    // switch chat
    state.currentSessionChatId = 'B'
    handler.onPartial('text B')
    await microtaskFlush()

    // Pretend we're still "on" chat B for turn_end
    state.currentSessionChatId = 'B'
    handler.onTurnEnd()

    expect(state.currentSessionChatId).toBeNull()
    expect(state.lastPtyPreviewByChat.has('B:_')).toBe(false)
    // Chat A's cache entry should still exist (wasn't the active chat)
    expect(state.lastPtyPreviewByChat.has('A:_')).toBe(true)
  })

  it('full happy-path: buffer → enqueue replay → live partials → final send', async () => {
    const state = makeState()
    const handler = createPtyPartialHandler(state, makeDeps(bot))

    // Extractor fires before session-tail reads enqueue
    handler.onPartial('hel')
    handler.onPartial('hello') // second one overwrites the buffer
    expect(state.pendingPtyPartial).toEqual({ text: 'hello' })

    // Session-tail finally resolves chat id; buffered partial replays
    handler.onSessionEnqueue('user-123')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('hello')

    // Live partials land as edits after throttle
    vi.advanceTimersByTime(1000)
    handler.onPartial('hello world')
    await microtaskFlush()
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('hello world')
  })

  it('claim survives turn_end — late PTY partial after reply does NOT send a duplicate', async () => {
    // Regression: user saw a formatted canonical reply, then ~30s later
    // the same content re-landed as a fresh unformatted message. Root
    // cause was `suppressPtyPreview.delete` at turn_end opening a window
    // during which a delayed PTY partial would call draft_send afresh
    // with raw TUI text. The claim must persist across turn_end.
    const state = makeState()
    const handler = createPtyPartialHandler(state, makeDeps(bot))

    handler.onSessionEnqueue('1')
    handler.onPartial('draft')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)

    // Reply tool claims and finalizes (same shape as server.ts reply handler)
    state.suppressPtyPreview.add('1:_')
    const open = state.activeDraftStreams.get('1:_')!
    await open.finalize()
    state.activeDraftStreams.delete('1:_')

    // Turn ends
    state.currentSessionChatId = '1'
    handler.onTurnEnd()

    // A delayed PTY partial arrives AFTER turn_end — this used to create
    // a second message; with the fix the claim still holds.
    state.currentSessionChatId = '1'
    vi.advanceTimersByTime(30_000)
    expect(handler.onPartial('stale TUI text')).toBe('suppressed')
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1) // no duplicate
  })

  it('onInboundNewCycle releases the claim so the next turn streams live preview', async () => {
    const state = makeState()
    const handler = createPtyPartialHandler(state, makeDeps(bot))

    // Prior turn ran, landed a reply, turn ended — claim still held.
    state.suppressPtyPreview.add('1:_')
    state.currentSessionChatId = '1'
    handler.onTurnEnd()
    expect(state.suppressPtyPreview.has('1:_')).toBe(true)

    // New inbound user message fires the new-cycle boundary.
    handler.onInboundNewCycle('1')
    expect(state.suppressPtyPreview.has('1:_')).toBe(false)

    // PTY partial for the fresh turn creates a stream normally.
    handler.onSessionEnqueue('1')
    expect(handler.onPartial('new turn draft')).toBe('update-new')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalled()
  })

  it('orphaned-reply path is untouched — no claim was set, PTY still streams', async () => {
    // Safety check: if the agent turn ends WITHOUT ever calling reply
    // (orphaned-reply / backstop path), suppressPtyPreview was never
    // added for this chat, so PTY partials keep working across the
    // turn_end boundary as before.
    const state = makeState()
    const handler = createPtyPartialHandler(state, makeDeps(bot))

    handler.onSessionEnqueue('9')
    // No reply tool call, no claim added.
    state.currentSessionChatId = '9'
    handler.onTurnEnd()

    state.currentSessionChatId = '9'
    expect(handler.onPartial('still streaming')).toBe('update-new')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('claim from reply handler (suppressPtyPreview) is honored mid-stream', async () => {
    const state = makeState()
    const handler = createPtyPartialHandler(state, makeDeps(bot))

    handler.onSessionEnqueue('1')
    handler.onPartial('first')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)

    // Reply tool claims — adds to suppress set, finalizes, deletes stream
    state.suppressPtyPreview.add('1:_')
    const open = state.activeDraftStreams.get('1:_')!
    await open.finalize()
    state.activeDraftStreams.delete('1:_')

    // Next PTY partial: dropped
    vi.advanceTimersByTime(1000)
    expect(handler.onPartial('racy')).toBe('suppressed')
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1) // no duplicate
    expect(state.activeDraftStreams.size).toBe(0)
  })
})
