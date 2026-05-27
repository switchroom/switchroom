/**
 * Per-chat FIFO ordering tests for outbound Telegram API calls.
 *
 * The MCP tool handlers (reply, stream_reply, react, edit, delete, pin,
 * forward) used to call `bot.api.*` concurrently with no coordination —
 * so a later `reply` could overtake an earlier in-flight edit, or a
 * `react` could resolve before the `reply` it reacts to.
 *
 * These tests pin the contract: per-chat dispatches to bot.api run
 * strictly sequentially (in tool-invocation order) even when later calls
 * have much shorter mocked latency than earlier ones, and calls to
 * DIFFERENT chats still run concurrently.
 */
import { describe, it, expect } from 'vitest'
import { createChatLock } from '../chat-lock.js'
import { handleStreamReply, type StreamReplyDeps, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createMockBot } from './bot-api.harness.js'

function deferred<T = unknown>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((r, j) => {
    resolve = r
    reject = j
  })
  return { promise, resolve, reject }
}

describe('createChatLock', () => {
  it('serializes same-chat calls in invocation order even when later work is faster', async () => {
    const lock = createChatLock()
    const order: string[] = []
    const slow = deferred<void>()

    const first = lock.run('c1', async () => {
      order.push('first:start')
      await slow.promise
      order.push('first:end')
      return 'A'
    })
    const second = lock.run('c1', async () => {
      order.push('second:start')
      order.push('second:end')
      return 'B'
    })

    // Give the scheduler a chance; second must NOT have started yet.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['first:start'])

    slow.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe('A')
    expect(b).toBe('B')
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ])
  })

  it('runs different chats concurrently', async () => {
    const lock = createChatLock()
    const order: string[] = []
    const d1 = deferred<void>()
    const d2 = deferred<void>()

    const p1 = lock.run('c1', async () => {
      order.push('c1:start')
      await d1.promise
      order.push('c1:end')
    })
    const p2 = lock.run('c2', async () => {
      order.push('c2:start')
      await d2.promise
      order.push('c2:end')
    })

    // Both should have started before either resolves.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['c1:start', 'c2:start'])

    d2.resolve()
    d1.resolve()
    await Promise.all([p1, p2])
    // c2 finishes first because it was resolved first — no over-serialization.
    expect(order).toEqual(['c1:start', 'c2:start', 'c2:end', 'c1:end'])
  })

  it('does not poison the chain on rejection', async () => {
    const lock = createChatLock()
    const first = lock.run('c1', async () => {
      throw new Error('boom')
    })
    const second = lock.run('c1', async () => 'ok')

    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('ok')
  })
})

describe('wrapBot — bot.api.* calls auto-lock by first-arg chat id', () => {
  it('same-chat sendMessage calls dispatch in invocation order despite timing inversion', async () => {
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    const dSlow = deferred<{ message_id: number }>()
    const startOrder: string[] = []
    bot.api.sendMessage.mockImplementationOnce(async (_c: string, t: string) => {
      startOrder.push(`A:start:${t}`)
      const r = await dSlow.promise
      startOrder.push(`A:end:${t}`)
      return r
    })
    bot.api.sendMessage.mockImplementationOnce(async (_c: string, t: string) => {
      startOrder.push(`B:start:${t}`)
      return { message_id: 2 }
    })

    const p1 = wrapped.api.sendMessage('chatX', 'first', {})
    const p2 = wrapped.api.sendMessage('chatX', 'second', {})

    // Drain microtasks. Only A should have started.
    await Promise.resolve(); await Promise.resolve()
    expect(startOrder).toEqual(['A:start:first'])

    dSlow.resolve({ message_id: 1 })
    await Promise.all([p1, p2])

    expect(startOrder).toEqual(['A:start:first', 'A:end:first', 'B:start:second'])
    // Confirm the underlying bot saw calls in the right order
    expect(bot.api.sendMessage.mock.calls.map((c) => c[1])).toEqual(['first', 'second'])
  })

  it('different chats run concurrently through the same wrapped bot', async () => {
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    const dA = deferred<{ message_id: number }>()
    const dB = deferred<{ message_id: number }>()
    const started: string[] = []
    bot.api.sendMessage.mockImplementationOnce(async (c: string) => {
      started.push(c)
      return dA.promise
    })
    bot.api.sendMessage.mockImplementationOnce(async (c: string) => {
      started.push(c)
      return dB.promise
    })

    const pA = wrapped.api.sendMessage('A', 'a', {})
    const pB = wrapped.api.sendMessage('B', 'b', {})
    await Promise.resolve(); await Promise.resolve()
    expect(started).toEqual(['A', 'B'])

    dB.resolve({ message_id: 20 })
    dA.resolve({ message_id: 10 })
    const [ra, rb] = await Promise.all([pA, pB])
    expect(ra.message_id).toBe(10)
    expect(rb.message_id).toBe(20)
  })

  it('SAME chat + DIFFERENT thread sendMessage calls dispatch concurrently (supergroup-mode unblock)', async () => {
    // PR2 of supergroup-mode: chat-lock moved from chatId-only keying
    // to (chat, thread) keying. Two topics in the same supergroup must
    // not artificially serialize at the bot.api layer.
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    const dTopicA = deferred<{ message_id: number }>()
    const dTopicB = deferred<{ message_id: number }>()
    const started: string[] = []
    bot.api.sendMessage.mockImplementationOnce(async (_c: string, t: string) => {
      started.push(`A:${t}`)
      return dTopicA.promise
    })
    bot.api.sendMessage.mockImplementationOnce(async (_c: string, t: string) => {
      started.push(`B:${t}`)
      return dTopicB.promise
    })

    // Same chatId "supergrp" but different message_thread_id.
    const pA = wrapped.api.sendMessage('supergrp', 'planning msg', { message_thread_id: 17 })
    const pB = wrapped.api.sendMessage('supergrp', 'cron digest', { message_thread_id: 23 })
    await Promise.resolve(); await Promise.resolve()
    // BOTH should have started — supergroup-mode parallelism guarantee.
    expect(started).toEqual(['A:planning msg', 'B:cron digest'])

    // Resolve B first; A's resolution must not delay B's return.
    dTopicB.resolve({ message_id: 200 })
    const rB = await pB
    expect(rB.message_id).toBe(200)

    dTopicA.resolve({ message_id: 100 })
    const rA = await pA
    expect(rA.message_id).toBe(100)
  })

  it('SAME chat + SAME thread sendMessage calls STILL serialize (per-topic ordering preserved)', async () => {
    // Per-topic message order matters (a reply tied to a message_id
    // must see that message exist first). The lock must still serialize
    // within a topic.
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    const dSlow = deferred<{ message_id: number }>()
    const startOrder: string[] = []
    bot.api.sendMessage.mockImplementationOnce(async (_c: string, t: string) => {
      startOrder.push(`first:${t}`)
      const r = await dSlow.promise
      startOrder.push(`first:end:${t}`)
      return r
    })
    bot.api.sendMessage.mockImplementationOnce(async (_c: string, t: string) => {
      startOrder.push(`second:${t}`)
      return { message_id: 2 }
    })

    const p1 = wrapped.api.sendMessage('supergrp', 'first', { message_thread_id: 17 })
    const p2 = wrapped.api.sendMessage('supergrp', 'second', { message_thread_id: 17 })

    await Promise.resolve(); await Promise.resolve()
    // Same thread → second waits for first.
    expect(startOrder).toEqual(['first:first'])

    dSlow.resolve({ message_id: 1 })
    await Promise.all([p1, p2])
    expect(startOrder).toEqual(['first:first', 'first:end:first', 'second:second'])
  })

  it('a 429 from one topic does NOT stall sends to a different topic in the same chat', async () => {
    // CPO #8=B guardrail: when grammY's autoRetry transformer backs off
    // on a 429 in topic A, topic B's sends must keep flowing. This test
    // pins the contract by simulating a slow/rejecting first call (proxy
    // for a 429+backoff path) on topic A and asserting topic B doesn't
    // wait on it.
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    // Topic A's send hangs (proxy for an in-flight 429-backoff path);
    // topic B's send must NOT wait on it.
    const dTopicA = deferred<{ message_id: number }>()
    const started: string[] = []
    bot.api.sendMessage.mockImplementationOnce(async () => {
      started.push('topicA:start')
      return dTopicA.promise
    })
    bot.api.sendMessage.mockImplementationOnce(async () => {
      started.push('topicB:start')
      return { message_id: 2 }
    })

    const pA = wrapped.api.sendMessage('supergrp', 'overloaded', { message_thread_id: 17 })
    const pB = wrapped.api.sendMessage('supergrp', 'unaffected', { message_thread_id: 23 })

    // Topic B should complete WITHOUT waiting on topic A's hang.
    const rB = await pB
    expect(rB.message_id).toBe(2)
    expect(started).toContain('topicB:start')

    // Resolve A so the lock chain drains cleanly.
    dTopicA.resolve({ message_id: 1 })
    const rA = await pA
    expect(rA.message_id).toBe(1)
  })

  it('strips message_thread_id=1 from sendMessage opts (General-topic Bot API quirk)', async () => {
    // Telegram's General topic has id=1 at MTProto but the Bot API
    // REJECTS message_thread_id=1 on send with HTTP 400 "message thread
    // not found" (tdlib/telegram-bot-api#447). The wrapper strips id=1
    // from the opts bag before the underlying API call.
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    bot.api.sendMessage.mockImplementationOnce(async () => ({ message_id: 1 }))

    await wrapped.api.sendMessage('supergrp', 'hello General', { message_thread_id: 1 })

    const callOpts = bot.api.sendMessage.mock.calls[0]![2]
    expect(callOpts).toBeDefined()
    expect((callOpts as Record<string, unknown>).message_thread_id).toBeUndefined()
  })

  it('preserves other opts when stripping message_thread_id=1', async () => {
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot
    bot.api.sendMessage.mockImplementationOnce(async () => ({ message_id: 1 }))

    await wrapped.api.sendMessage('supergrp', 'hello', {
      message_thread_id: 1,
      parse_mode: 'HTML',
      reply_to_message_id: 42,
    })

    const callOpts = bot.api.sendMessage.mock.calls[0]![2] as Record<string, unknown>
    expect(callOpts.message_thread_id).toBeUndefined()
    expect(callOpts.parse_mode).toBe('HTML')
    expect(callOpts.reply_to_message_id).toBe(42)
  })

  it('does NOT mutate the caller\'s opts object (strip uses a copy)', async () => {
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot
    bot.api.sendMessage.mockImplementationOnce(async () => ({ message_id: 1 }))

    const callerOpts = { message_thread_id: 1, parse_mode: 'HTML' as const }
    await wrapped.api.sendMessage('supergrp', 'hello', callerOpts)

    expect(callerOpts.message_thread_id).toBe(1)  // caller's object untouched
  })

  it('does NOT strip non-1 thread IDs', async () => {
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot
    bot.api.sendMessage.mockImplementationOnce(async () => ({ message_id: 1 }))

    await wrapped.api.sendMessage('supergrp', 'planning msg', { message_thread_id: 17 })

    const callOpts = bot.api.sendMessage.mock.calls[0]![2] as Record<string, unknown>
    expect(callOpts.message_thread_id).toBe(17)  // non-General threads untouched
  })

  it('two SAME-chat General-topic sends still serialize (id=1 normalized to chat-root lane)', async () => {
    // After stripping id=1, the lock key normalizes to chatKey(chatId, null)
    // = `chatId:_`. Two General-topic sends queue through the same
    // chat-root lane preserving order (Telegram per-chat order matters).
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    const dSlow = deferred<{ message_id: number }>()
    const order: string[] = []
    bot.api.sendMessage.mockImplementationOnce(async (_c: string, t: string) => {
      order.push(`first:${t}`)
      const r = await dSlow.promise
      order.push(`first:end:${t}`)
      return r
    })
    bot.api.sendMessage.mockImplementationOnce(async (_c: string, t: string) => {
      order.push(`second:${t}`)
      return { message_id: 2 }
    })

    const p1 = wrapped.api.sendMessage('supergrp', 'general msg 1', { message_thread_id: 1 })
    const p2 = wrapped.api.sendMessage('supergrp', 'general msg 2', { message_thread_id: 1 })

    await Promise.resolve(); await Promise.resolve()
    expect(order).toEqual(['first:general msg 1'])  // second waits

    dSlow.resolve({ message_id: 1 })
    await Promise.all([p1, p2])
    expect(order).toEqual(['first:general msg 1', 'first:end:general msg 1', 'second:general msg 2'])
  })

  it('General-topic strip does NOT serialize against non-General sends in the same chat', async () => {
    // id=1 → chat-root lane. id=17 → its own lane. Independent dispatch.
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    const dGeneral = deferred<{ message_id: number }>()
    const dPlanning = deferred<{ message_id: number }>()
    const started: string[] = []
    bot.api.sendMessage.mockImplementationOnce(async () => {
      started.push('general')
      return dGeneral.promise
    })
    bot.api.sendMessage.mockImplementationOnce(async () => {
      started.push('planning')
      return dPlanning.promise
    })

    const pGeneral = wrapped.api.sendMessage('supergrp', 'g', { message_thread_id: 1 })
    const pPlanning = wrapped.api.sendMessage('supergrp', 'p', { message_thread_id: 17 })

    await Promise.resolve(); await Promise.resolve()
    expect(started).toEqual(['general', 'planning'])  // both started concurrently

    dPlanning.resolve({ message_id: 17 })
    dGeneral.resolve({ message_id: 1 })
    await Promise.all([pGeneral, pPlanning])
  })

  it('react (setMessageReaction) queues behind an in-flight reply (sendMessage) to the same chat', async () => {
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    const dSend = deferred<{ message_id: number }>()
    const wire: string[] = []
    bot.api.sendMessage.mockImplementationOnce(async () => {
      wire.push('send:start')
      const r = await dSend.promise
      wire.push('send:end')
      return r
    })
    bot.api.setMessageReaction.mockImplementationOnce(async () => {
      wire.push('react:start')
      return true as const
    })

    const pReply = wrapped.api.sendMessage('chatZ', 'hello', {})
    const pReact = wrapped.api.setMessageReaction('chatZ', 42, [{ type: 'emoji', emoji: '👍' }])
    await Promise.resolve(); await Promise.resolve()
    expect(wire).toEqual(['send:start']) // react must not have dispatched

    dSend.resolve({ message_id: 99 })
    await Promise.all([pReply, pReact])
    expect(wire).toEqual(['send:start', 'send:end', 'react:start'])
  })
})

describe('wrapBot + handleStreamReply + reply ordering', () => {
  function makeDeps(
    bot: ReturnType<typeof createMockBot>,
    overrides?: Partial<StreamReplyDeps>,
  ): StreamReplyDeps {
    return {
      bot,
      markdownToHtml: (t) => t,
      escapeMarkdownV2: (t) => t,
      repairEscapedWhitespace: (t) => t,
      takeHandoffPrefix: () => '',
      assertAllowedChat: () => {},
      resolveThreadId: () => undefined,
      disableLinkPreview: true,
      defaultFormat: 'text',
      logStreamingEvent: () => {},
      historyEnabled: false,
      recordOutbound: () => {},
      writeError: () => {},
      throttleMs: 0,
      ...overrides,
    }
  }

  it('a follow-on reply sendMessage waits for a slow in-flight stream send to resolve', async () => {
    // Simulates: stream_reply(chat, "draft") in flight, then reply(chat,
    // "final") to the same chat. Without the lock, the reply's sendMessage
    // can overtake the stream's sendMessage on the wire. With the lock,
    // reply starts only after the stream's initial send resolves.
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot
    const state: StreamReplyState = { activeDraftStreams: new Map<string, DraftStreamHandle>() }
    const deps = makeDeps(bot, { bot: wrapped })

    const wire: string[] = []
    const dStreamSend = deferred<{ message_id: number }>()
    bot.api.sendMessage.mockImplementationOnce(async () => {
      wire.push('stream:send:start')
      const r = await dStreamSend.promise
      wire.push('stream:send:end')
      return r
    })
    bot.api.sendMessage.mockImplementationOnce(async () => {
      wire.push('reply:send')
      return { message_id: 501 }
    })

    // Fire stream_reply (no done — just an update that triggers the send).
    const pStream = handleStreamReply({ chat_id: 'cZ', text: 'draft' }, state, deps)
    // Immediately issue a direct sendMessage via the wrapped bot (stand-in
    // for a second reply call to the same chat racing the stream).
    const pReply = wrapped.api.sendMessage('cZ', 'final answer', {})

    for (let i = 0; i < 10; i++) await Promise.resolve()
    // Stream's send is in flight; reply must be queued behind it.
    expect(wire).toEqual(['stream:send:start'])

    dStreamSend.resolve({ message_id: 500 })
    await Promise.all([pStream, pReply])

    expect(wire).toEqual([
      'stream:send:start',
      'stream:send:end',
      'reply:send',
    ])
  })

  it('recordOutbound-style history order matches wire order for same-chat races', async () => {
    // Assert: when two same-chat sendMessage calls race with inverted
    // latency, the resolution order (what recordOutbound would observe)
    // matches invocation order.
    const lock = createChatLock()
    const bot = createMockBot()
    const wrapped = lock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot

    const dA = deferred<{ message_id: number }>()
    bot.api.sendMessage.mockImplementationOnce(async () => dA.promise)
    bot.api.sendMessage.mockImplementationOnce(async () => ({ message_id: 2 }))

    const resolved: number[] = []
    const p1 = wrapped.api.sendMessage('c', 'first', {}).then((r) => resolved.push(r.message_id))
    const p2 = wrapped.api.sendMessage('c', 'second', {}).then((r) => resolved.push(r.message_id))

    // Resolve A later even though invocation order was A then B.
    dA.resolve({ message_id: 1 })
    await Promise.all([p1, p2])

    expect(resolved).toEqual([1, 2])
  })
})
