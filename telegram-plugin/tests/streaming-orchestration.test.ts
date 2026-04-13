/**
 * Orchestration tests for the streaming state machine that lives in
 * server.ts around `activeDraftStreams: Map<streamKey, DraftStreamHandle>`.
 *
 * These tests model the pattern used by the real `stream_reply` MCP
 * handler and `handlePtyPartial` — both of which look up the map, create
 * a controller on miss, and delete the entry on done. We exercise the
 * *state transitions* directly against real `createStreamController`
 * instances backed by the mock bot harness, so that regressions in the
 * reliability-critical flows (claim-then-new-turn, cross-chat isolation,
 * thread keying, post-done re-entry) fail a test instead of silently
 * ghosting in production.
 *
 * Scope: single-controller primitives are covered in
 *        `stream-controller.test.ts`. This file exists for multi-stream
 *        + restart + race-shape scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createStreamController } from '../stream-controller.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'

function streamKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}

/**
 * Tiny facsimile of server.ts's stream_reply case. Takes a Map of
 * active streams and wires the create-on-miss + delete-on-done flow.
 * Pure — no side effects outside the map and bot calls.
 */
function modelStreamReply(params: {
  bot: ReturnType<typeof createMockBot>
  map: Map<string, DraftStreamHandle>
  chatId: string
  threadId?: number
  text: string
  done?: boolean
  throttleMs?: number
  parseMode?: 'HTML' | 'MarkdownV2'
}): { stream: DraftStreamHandle; settled: Promise<void> } {
  const key = streamKey(params.chatId, params.threadId)
  let stream = params.map.get(key)
  if (!stream) {
    stream = createStreamController({
      bot: params.bot,
      chatId: params.chatId,
      threadId: params.threadId,
      parseMode: params.parseMode,
      throttleMs: params.throttleMs ?? 600,
    })
    params.map.set(key, stream)
  }
  // Fire-and-forget update — caller advances fake timers + flushes
  // microtasks to drive progress, matching draft-stream.test.ts style.
  void stream.update(params.text)
  const settled = params.done
    ? stream.finalize().then(() => { params.map.delete(key) })
    : Promise.resolve()
  return { stream, settled }
}

describe('streaming orchestration — activeDraftStreams map', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('first call creates a stream in the map; second call reuses it', async () => {
    const map = new Map<string, DraftStreamHandle>()

    const { stream: a } = modelStreamReply({ bot, map, chatId: '1', text: 'hi' })
    await microtaskFlush()
    vi.advanceTimersByTime(700)
    await microtaskFlush()
    const { stream: b } = modelStreamReply({ bot, map, chatId: '1', text: 'hi again' })
    await microtaskFlush()

    expect(a).toBe(b)
    expect(map.size).toBe(1)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
  })

  it('done=true deletes the map entry; next call creates a fresh stream', async () => {
    const map = new Map<string, DraftStreamHandle>()

    const { stream: first, settled } = modelStreamReply({ bot, map, chatId: '1', text: 'a', done: true })
    await microtaskFlush()
    await settled
    expect(map.has('1:_')).toBe(false)
    expect(first.isFinal()).toBe(true)

    const { stream: second } = modelStreamReply({ bot, map, chatId: '1', text: 'next turn' })
    await microtaskFlush()

    expect(first).not.toBe(second)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
    expect(second.getMessageId()).toBe(501)
  })

  it('different chats keep independent streams (no crosstalk)', async () => {
    const map = new Map<string, DraftStreamHandle>()

    modelStreamReply({ bot, map, chatId: '1', text: 'chat A' })
    modelStreamReply({ bot, map, chatId: '2', text: 'chat B' })
    await microtaskFlush()

    expect(map.size).toBe(2)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
    const chatIds = bot.api.sendMessage.mock.calls.map(c => c[0]).sort()
    expect(chatIds).toEqual(['1', '2'])
  })

  it('same chat, different threads → independent streams (forum topic safety)', async () => {
    const map = new Map<string, DraftStreamHandle>()

    modelStreamReply({ bot, map, chatId: '1', threadId: 10, text: 'topic A' })
    modelStreamReply({ bot, map, chatId: '1', threadId: 20, text: 'topic B' })
    await microtaskFlush()

    expect(map.size).toBe(2)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
    const threads = bot.api.sendMessage.mock.calls.map(c => c[2]?.message_thread_id).sort()
    expect(threads).toEqual([10, 20])
  })

  it('pty preview → stream_reply handoff: second call edits the PTY message in place', async () => {
    const map = new Map<string, DraftStreamHandle>()

    const ptyStream = createStreamController({ bot, chatId: '1', parseMode: 'HTML', throttleMs: 600 })
    map.set('1:_', ptyStream)
    void ptyStream.update('<i>drafting…</i>')
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    const previewId = ptyStream.getMessageId()
    expect(previewId).toBe(500)

    vi.advanceTimersByTime(600)
    await microtaskFlush()
    const { settled } = modelStreamReply({
      bot, map, chatId: '1', parseMode: 'HTML', text: 'final answer', done: true,
    })
    await microtaskFlush()
    await settled

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalled()
    expect(bot.api.editMessageText.mock.calls[0][1]).toBe(previewId)
    expect(map.has('1:_')).toBe(false)
  })

  it('rapid stream_reply burst coalesces to one send + one edit with latest text', async () => {
    // The first update fires send('one') immediately. While that's
    // in-flight, updates 'two'/'three'/'four' overwrite pendingText
    // synchronously. draft-stream's flushLoop drains pendingText to
    // 'four' in a single follow-up edit after send resolves. Net:
    // 4 update() calls → 1 send + 1 edit with the latest text.
    const map = new Map<string, DraftStreamHandle>()

    for (const t of ['one', 'two', 'three', 'four']) {
      modelStreamReply({ bot, map, chatId: '1', text: t, throttleMs: 1000 })
    }
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('one')
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('four')

    // No further work scheduled; advancing timers should be a no-op.
    vi.advanceTimersByTime(5000)
    await microtaskFlush()
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
  })

  it('done=true after pending text still flushes the final snapshot', async () => {
    const map = new Map<string, DraftStreamHandle>()

    modelStreamReply({ bot, map, chatId: '1', text: 'drafting…', throttleMs: 1000 })
    await microtaskFlush()
    const { settled } = modelStreamReply({
      bot, map, chatId: '1', text: 'final answer', done: true, throttleMs: 1000,
    })
    await microtaskFlush()
    await settled

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('final answer')
    expect(map.size).toBe(0)
  })

  it('failed first send leaves a retry-able stream: next update re-attempts send', async () => {
    // First send fails; draft-stream swallows the error, leaves
    // messageId=null. A subsequent update() triggers a fresh send on the
    // same stream object — this is what makes a momentary network blip
    // recoverable without the caller needing to evict-and-recreate.
    bot.api.sendMessage
      .mockImplementationOnce(async () => { throw new Error('network down') })
      .mockImplementationOnce(async () => ({ message_id: 777 }))

    const map = new Map<string, DraftStreamHandle>()
    const { stream } = modelStreamReply({ bot, map, chatId: '1', text: 'first try' })
    await microtaskFlush()

    expect(stream.getMessageId()).toBeNull()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)

    // Caller issues next snapshot — should retry send, not try to edit null.
    vi.advanceTimersByTime(1000)
    modelStreamReply({ bot, map, chatId: '1', text: 'second try' })
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
    expect(bot.api.editMessageText).not.toHaveBeenCalled()
    expect(stream.getMessageId()).toBe(777)
  })
})

// ---------------------------------------------------------------------------
// suppressPtyPreview claim/release — the "duplicate Telegram message" race
// ---------------------------------------------------------------------------
//
// The reply tool handler claims the stream by:
//   1. adding the streamKey to suppressPtyPreview BEFORE touching the stream
//   2. finalizing and deleting the active stream
//   3. sending the canonical reply
//   4. NOT releasing the suppress lock in the `finally` — turn_end does that
//
// This prevents the PTY tail from seeing an empty activeDraftStreams in step
// 2 and creating a fresh preview that would surface as a duplicate.

function modelPtyPartial(params: {
  bot: ReturnType<typeof createMockBot>
  map: Map<string, DraftStreamHandle>
  suppress: Set<string>
  chatId: string
  threadId?: number
  text: string
  throttleMs?: number
}): DraftStreamHandle | null {
  const key = streamKey(params.chatId, params.threadId)
  if (params.suppress.has(key)) return null
  let stream = params.map.get(key)
  if (!stream) {
    stream = createStreamController({
      bot: params.bot,
      chatId: params.chatId,
      threadId: params.threadId,
      parseMode: 'HTML',
      throttleMs: params.throttleMs ?? 600,
    })
    params.map.set(key, stream)
  }
  void stream.update(params.text)
  return stream
}

async function modelReplyClaim(params: {
  bot: ReturnType<typeof createMockBot>
  map: Map<string, DraftStreamHandle>
  suppress: Set<string>
  chatId: string
  threadId?: number
}): Promise<{ previewId: number | null }> {
  const key = streamKey(params.chatId, params.threadId)
  params.suppress.add(key) // step 1: claim BEFORE touching the stream
  const open = params.map.get(key)
  let previewId: number | null = null
  if (open && !open.isFinal()) {
    await open.finalize()
    previewId = open.getMessageId()
    params.map.delete(key)
  }
  return { previewId }
}

function modelTurnEnd(params: {
  suppress: Set<string>
  chatId: string
  threadId?: number
}): void {
  params.suppress.delete(streamKey(params.chatId, params.threadId))
}

describe('suppressPtyPreview claim/release race', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('PTY partials during a reply claim are dropped (no duplicate send)', async () => {
    const map = new Map<string, DraftStreamHandle>()
    const suppress = new Set<string>()

    // Step 1: PTY creates a preview
    modelPtyPartial({ bot, map, suppress, chatId: '1', text: 'drafting' })
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)

    // Step 2: reply claims — finalizes preview, deletes map entry
    const { previewId } = await modelReplyClaim({ bot, map, suppress, chatId: '1' })
    expect(previewId).toBe(500)
    expect(map.has('1:_')).toBe(false)
    expect(suppress.has('1:_')).toBe(true)

    // Step 3: while suppressed, PTY fires another partial — should be dropped
    const result = modelPtyPartial({ bot, map, suppress, chatId: '1', text: 'more content' })
    await microtaskFlush()

    expect(result).toBeNull()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1) // no duplicate send
    expect(map.has('1:_')).toBe(false) // no ghost stream created
  })

  it('claim is added BEFORE stream deletion (race-tight ordering)', async () => {
    // If suppress.add happens AFTER map.delete, a PTY partial firing in
    // between would create a new stream. We model the claim in the exact
    // order the real code uses — any reordering here should fail this test.
    const map = new Map<string, DraftStreamHandle>()
    const suppress = new Set<string>()

    modelPtyPartial({ bot, map, suppress, chatId: '1', text: 'preview' })
    await microtaskFlush()

    // Interleave: start claim, but simulate a partial arriving mid-claim.
    // In the real code, suppress.add is synchronous and happens before any
    // await. So by the time PTY could fire, suppress is already set.
    suppress.add('1:_') // the claim's first action
    const result = modelPtyPartial({ bot, map, suppress, chatId: '1', text: 'racy partial' })
    await microtaskFlush()

    expect(result).toBeNull()
    // Finish the claim
    const open = map.get('1:_')!
    await open.finalize()
    map.delete('1:_')

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1) // only the original
  })

  it('turn_end releases suppress; next turn PTY partial creates a fresh stream', async () => {
    const map = new Map<string, DraftStreamHandle>()
    const suppress = new Set<string>()

    modelPtyPartial({ bot, map, suppress, chatId: '1', text: 'first preview' })
    await microtaskFlush()
    await modelReplyClaim({ bot, map, suppress, chatId: '1' })

    // Reply lands (simulated by a direct send). Turn ends.
    modelTurnEnd({ suppress, chatId: '1' })
    expect(suppress.has('1:_')).toBe(false)

    // Next turn — a new PTY partial can now create a stream again.
    const result = modelPtyPartial({ bot, map, suppress, chatId: '1', text: 'next turn preview' })
    await microtaskFlush()

    expect(result).not.toBeNull()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2) // original preview + new one
  })

  it('suppress is scoped by chat+thread — claim in chat A does not block chat B', async () => {
    const map = new Map<string, DraftStreamHandle>()
    const suppress = new Set<string>()

    modelPtyPartial({ bot, map, suppress, chatId: 'A', text: 'A draft' })
    await microtaskFlush()
    await modelReplyClaim({ bot, map, suppress, chatId: 'A' })

    // Chat B is untouched by A's claim — a PTY partial for B should work
    const result = modelPtyPartial({ bot, map, suppress, chatId: 'B', text: 'B draft' })
    await microtaskFlush()

    expect(result).not.toBeNull()
    expect(suppress.has('A:_')).toBe(true)
    expect(suppress.has('B:_')).toBe(false)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
  })
})
