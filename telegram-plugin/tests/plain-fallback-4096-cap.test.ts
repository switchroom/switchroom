/**
 * Regression: switchroom #4043 — the plain-text FALLBACK was never re-capped to
 * the plain endpoint's 4096-char wire limit.
 *
 * Every send path chunks for the RICH cap (`RICH_MESSAGE_MAX_CHARS` = 32768,
 * `format.ts`). Three sites then degrade a chunk to the PLAIN `sendMessage`
 * endpoint, which caps at 4096:
 *
 *   1. the reply path's markdown parse-reject fallback
 *      (`gateway/outbound-send-path.ts`, `sendReplyChunks` → `sendChunkPlainText`)
 *   2. the outbox sweep's parse-reject fallback
 *      (`gateway/outbox-sweep.ts`, `sendChunkRich` → `bot.api.sendMessage`)
 *   3. the captured-prose exhausted-boundary fallback
 *      (`gateway/outbound-send-path.ts`, `deliverCapturedProse`)
 *
 * Pre-fix all three handed the FULL rich-sized chunk to the plain endpoint, so
 * Telegram answered `Bad Request: message is too long` and the rescue send —
 * the thing that exists so a long answer is never lost — failed too. In the
 * sweep that is worse than a loss: the record is never journaled and never
 * cleared, so the same doomed send is retried on every tick forever.
 *
 * These assert the USER OUTCOME, not the code path: the fake Telegram enforces
 * the real 4096 limit, so a test that merely walked the fallback without the
 * re-cap would throw and fail. The whole body must arrive, in pieces the plain
 * endpoint accepts.
 */

import { describe, it, expect } from 'vitest'
import { GrammyError } from 'grammy'
import {
  PLAIN_TEXT_MAX_CHARS,
  RICH_MESSAGE_MAX_CHARS,
  splitPlainTextToCap,
} from '../format.js'
import {
  sendReplyChunks,
  deliverCapturedProse,
  computeReplyChunks,
  type ReplyChunkSendDeps,
  type DeliverCapturedProseDeps,
} from '../gateway/outbound-send-path.js'
import { createOutboxSend } from '../gateway/outbox-sweep.js'
import { createRetryApiCall } from '../retry-api-call.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'

const CHAT = '100200300'

/** A body far past the plain cap but comfortably inside the rich cap, with
 *  ordinary paragraph boundaries (so the splitter has somewhere safe to cut). */
function longBody(chars: number): string {
  const para = 'Sentence about the delivery seam that the user actually reads. '
  let out = ''
  let n = 0
  while (out.length < chars) {
    out += para.repeat(6) + `\n\nparagraph ${n++}\n\n`
  }
  return out.slice(0, chars)
}

/** Telegram's real plain-endpoint rejection for an oversized body. */
function tooLongError(): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed!',
    { ok: false, error_code: 400, description: 'Bad Request: message is too long' },
    'sendMessage',
    {} as never,
  )
}

/** Telegram's real markdown parse-reject (what triggers every plain fallback). */
function parseRejectError(method: 'sendMessage' | 'sendRichMessage'): GrammyError {
  return new GrammyError(
    `Call to ${method} failed!`,
    {
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities: unexpected end of input",
    },
    method,
    {} as never,
  )
}

describe('splitPlainTextToCap (#4043 — the shared re-cap)', () => {
  it('leaves a body that already fits untouched (single piece, byte-identical)', () => {
    const body = 'short enough'
    expect(splitPlainTextToCap(body)).toEqual([body])
  })

  it('caps every piece at 4096 and loses nothing', () => {
    const body = longBody(20_000)
    const pieces = splitPlainTextToCap(body)
    expect(pieces.length).toBeGreaterThan(1)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(PLAIN_TEXT_MAX_CHARS)
    expect(pieces.join('').replace(/\s+/g, '')).toBe(body.replace(/\s+/g, ''))
  })

  it('hard-slices an INDIVISIBLE region rather than emitting it oversized', () => {
    // No newline, no space: `splitMarkdownChunks` emits such a region whole.
    const blob = 'x'.repeat(10_000)
    const pieces = splitPlainTextToCap(blob)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(PLAIN_TEXT_MAX_CHARS)
    expect(pieces.join('')).toBe(blob)
  })
})

describe('#4043 site 1 — reply path parse-reject fallback (sendReplyChunks)', () => {
  /** Fake wire: the rich send parse-rejects; the plain send enforces 4096. */
  function makeDeps() {
    const plainSends: string[] = []
    let id = 500
    const deps: ReplyChunkSendDeps = {
      sendRich: () => Promise.reject(parseRejectError('sendRichMessage')),
      sendLiteral: () => Promise.reject(parseRejectError('sendMessage')),
      sendLiteralRaw: (_opts, text) => {
        if (text.length > PLAIN_TEXT_MAX_CHARS) return Promise.reject(tooLongError())
        plainSends.push(text)
        return Promise.resolve({ message_id: id++ })
      },
      sendRichRaw: () => Promise.reject(parseRejectError('sendRichMessage')),
      editPreview: () => Promise.resolve({}),
      richMessage: (s) => ({ markdown: s }),
      logOutbound: () => {},
      deleteStalePreview: () => Promise.resolve(),
      stderr: () => {},
    }
    return { deps, plainSends }
  }

  it('delivers a 20k-char answer as ≤4096-char plain pieces instead of failing', async () => {
    const body = longBody(20_000)
    // The reply path splits for the RICH cap — one chunk, ~20k chars.
    const chunks = computeReplyChunks({
      effectiveText: body,
      literalText: false,
      limit: RICH_MESSAGE_MAX_CHARS,
      chunkMode: 'newline',
    })
    expect(chunks).toHaveLength(1)

    const { deps, plainSends } = makeDeps()
    const sentIds: number[] = []
    await sendReplyChunks(deps, {
      chatId: CHAT,
      chunks,
      literalText: false,
      suppressText: false,
      threadId: undefined,
      previewMessageId: null,
      sentIds,
      buildSendOpts: () => ({}),
      buildPreviewEditOpts: () => ({}),
    })

    expect(plainSends.length).toBeGreaterThan(1)
    for (const s of plainSends) expect(s.length).toBeLessThanOrEqual(PLAIN_TEXT_MAX_CHARS)
    // Every delivered message is reported back to the caller (history / dedup).
    expect(sentIds).toHaveLength(plainSends.length)
    // Nothing was dropped on the floor.
    expect(plainSends.join('').replace(/\s+/g, '')).toBe(body.replace(/\s+/g, ''))
  })

  it('still sends a short parse-rejected chunk as ONE plain message', async () => {
    const { deps, plainSends } = makeDeps()
    const sentIds: number[] = []
    await sendReplyChunks(deps, {
      chatId: CHAT,
      chunks: ['a short answer'],
      literalText: false,
      suppressText: false,
      threadId: undefined,
      previewMessageId: null,
      sentIds,
      buildSendOpts: () => ({}),
      buildPreviewEditOpts: () => ({}),
    })
    expect(plainSends).toEqual(['a short answer'])
    expect(sentIds).toHaveLength(1)
  })
})

describe('#4043 site 2 — outbox sweep parse-reject fallback (createOutboxSend)', () => {
  function fakeBot() {
    const plainSends: Array<{ text: string; opts: Record<string, unknown> }> = []
    let id = 900
    return {
      plainSends,
      api: {
        sendRichMessage: async () => {
          throw parseRejectError('sendRichMessage')
        },
        sendMessage: async (_chatId: string, text: string, opts: Record<string, unknown>) => {
          if (text.length > PLAIN_TEXT_MAX_CHARS) throw tooLongError()
          plainSends.push({ text, opts })
          return { message_id: id++ }
        },
      },
    }
  }

  const passthroughRetry = <U>(fn: () => Promise<U>): Promise<U> => fn()

  it('delivers a 20k-char record as ≤4096-char plain pieces instead of retrying forever', async () => {
    const bot = fakeBot()
    const send = createOutboxSend({ getBot: () => bot as never, retry: passthroughRetry })
    const body = longBody(20_000)

    const res = await send(CHAT, null, body)

    expect(bot.plainSends.length).toBeGreaterThan(1)
    for (const s of bot.plainSends) {
      expect(s.text.length).toBeLessThanOrEqual(PLAIN_TEXT_MAX_CHARS)
    }
    // The sweep reports one entry per message ACTUALLY landed, with the text
    // that message carries — history / journal bookkeeping tracks the wire.
    expect(res.chunks).toHaveLength(bot.plainSends.length)
    expect(res.chunks.map((c) => c.text)).toEqual(bot.plainSends.map((s) => s.text))
    expect(res.messageId).toBe(res.chunks[res.chunks.length - 1]!.messageId)
    expect(bot.plainSends.map((s) => s.text).join('').replace(/\s+/g, '')).toBe(
      body.replace(/\s+/g, ''),
    )
  })

  it('the Listen keyboard rides the FINAL plain piece only (no duplicate buttons)', async () => {
    const bot = fakeBot()
    const markup = { inline_keyboard: [[{ text: '🔊 Listen', callback_data: 'voice:1' }]] }
    const send = createOutboxSend({
      getBot: () => bot as never,
      retry: passthroughRetry,
      resolveReplyMarkup: () => markup,
    })

    await send(CHAT, null, longBody(20_000))

    const withMarkup = bot.plainSends.filter((s) => s.opts.reply_markup != null)
    expect(withMarkup).toHaveLength(1)
    expect(bot.plainSends[bot.plainSends.length - 1]!.opts.reply_markup).toEqual(markup)
  })
})

describe('reply-path plain fallback — message-scoped trailers ride ONE piece', () => {
  /**
   * MAJOR 1. `buildSendOpts` builds opts for ONE message: `reply_markup` on the
   * LAST chunk, `reply_parameters` on the quoting chunk. `sendChunkPlainText`
   * then re-caps that chunk into N plain pieces — and used to hand the SAME
   * opts object to every one of them. Outcome the user sees: N copies of the
   * inline keyboard (a `single_use` keyboard only clears off the message that
   * was tapped, so the action can be double-fired) and N quote-replies.
   *
   * The sweep path already got this right for the button
   * (`outbox-sweep.ts` `withoutMarkup`); this is the reply path's version.
   */
  const markup = {
    inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:42' }]],
    single_use: true,
  }
  const replyParams = { message_id: 77, quote: { text: 'the question', position: 0 } }

  function makeDeps() {
    const plainSends: Array<{ text: string; opts: Record<string, unknown> }> = []
    let id = 600
    const deps: ReplyChunkSendDeps = {
      sendRich: () => Promise.reject(parseRejectError('sendRichMessage')),
      sendLiteral: () => Promise.reject(parseRejectError('sendMessage')),
      sendLiteralRaw: (opts, text) => {
        if (text.length > PLAIN_TEXT_MAX_CHARS) return Promise.reject(tooLongError())
        plainSends.push({ text, opts: opts as Record<string, unknown> })
        return Promise.resolve({ message_id: id++ })
      },
      sendRichRaw: () => Promise.reject(parseRejectError('sendRichMessage')),
      editPreview: () => Promise.resolve({}),
      richMessage: (s) => ({ markdown: s }),
      logOutbound: () => {},
      deleteStalePreview: () => Promise.resolve(),
      stderr: () => {},
    }
    return { deps, plainSends }
  }

  /** Mirrors the live `buildSendOpts` (gateway/outbound-send-path.ts): quote on
   *  the first chunk, keyboard on the last, thread on every one. */
  const buildSendOpts = (i: number, isLastChunk: boolean) => ({
    ...(i === 0 ? { reply_parameters: replyParams } : {}),
    message_thread_id: 9,
    ...(isLastChunk ? { reply_markup: markup } : {}),
  })

  it('an oversized keyboard-bearing reply: ONE keyboard (final piece), ONE quote (first piece)', async () => {
    const body = longBody(20_000)
    const chunks = computeReplyChunks({
      effectiveText: body,
      literalText: false,
      limit: RICH_MESSAGE_MAX_CHARS,
      chunkMode: 'newline',
    })
    // One rich chunk that is BOTH the first (quotes) and the last (keyboard).
    expect(chunks).toHaveLength(1)

    const { deps, plainSends } = makeDeps()
    const sentIds: number[] = []
    await sendReplyChunks(deps, {
      chatId: CHAT,
      chunks,
      literalText: false,
      suppressText: false,
      threadId: 9,
      previewMessageId: null,
      sentIds,
      buildSendOpts,
      buildPreviewEditOpts: () => ({}),
    })

    // It really did split — otherwise the assertions below are vacuous.
    expect(plainSends.length).toBeGreaterThan(1)

    // Exactly ONE live keyboard, and it is on the LAST message the user sees.
    const withMarkup = plainSends.filter((s) => s.opts.reply_markup != null)
    expect(withMarkup).toHaveLength(1)
    expect(plainSends[plainSends.length - 1]!.opts.reply_markup).toEqual(markup)

    // Exactly ONE quote-reply, and it is on the FIRST message.
    const withQuote = plainSends.filter((s) => s.opts.reply_parameters != null)
    expect(withQuote).toHaveLength(1)
    expect(plainSends[0]!.opts.reply_parameters).toEqual(replyParams)

    // Per-message policy params still ride EVERY piece.
    for (const s of plainSends) expect(s.opts.message_thread_id).toBe(9)

    // And the answer itself is intact.
    expect(plainSends.map((s) => s.text).join('').replace(/\s+/g, '')).toBe(
      body.replace(/\s+/g, ''),
    )
  })

  it('a single-piece fallback still carries both trailers on its one message', async () => {
    const { deps, plainSends } = makeDeps()
    const sentIds: number[] = []
    await sendReplyChunks(deps, {
      chatId: CHAT,
      chunks: ['a short answer'],
      literalText: false,
      suppressText: false,
      threadId: 9,
      previewMessageId: null,
      sentIds,
      buildSendOpts,
      buildPreviewEditOpts: () => ({}),
    })
    expect(plainSends).toHaveLength(1)
    expect(plainSends[0]!.opts.reply_markup).toEqual(markup)
    expect(plainSends[0]!.opts.reply_parameters).toEqual(replyParams)
  })
})

describe('outbox sweep plain fallback — a mid-loop 429 does not re-deliver landed pieces', () => {
  /**
   * MAJOR 2. `createOutboxSend` wraps the WHOLE `sendChunkRich` — its
   * multi-piece plain-fallback loop included — in
   * `retryWithThreadFallback(deps.retry, …)`, and `createRetryApiCall`
   * re-invokes that closure after a flood wait (`retry-api-call.ts`). So a 429
   * on piece 4 of 5 re-ran the closure from the top: the rich send
   * deterministically parse-rejects again and pieces 1-3 were re-sent into the
   * user's chat. A mid-loop 429 is likely precisely in the flood conditions the
   * sweep runs under.
   *
   * Asserted as the USER OUTCOME: every piece appears on the wire exactly once.
   */
  function floodError(retryAfter: number): GrammyError {
    return new GrammyError(
      'Call to sendMessage failed!',
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after ' + retryAfter,
        parameters: { retry_after: retryAfter },
      },
      'sendMessage',
      {} as never,
    )
  }

  /** Fake wire: rich always parse-rejects; the Nth plain send 429s ONCE. */
  function fakeBot(floodOnCall: number) {
    const plainSends: Array<{ text: string; opts: Record<string, unknown> }> = []
    let richCalls = 0
    let plainCalls = 0
    let flooded = false
    let id = 900
    return {
      plainSends,
      richCalls: () => richCalls,
      api: {
        sendRichMessage: async () => {
          richCalls++
          throw parseRejectError('sendRichMessage')
        },
        sendMessage: async (_chatId: string, text: string, opts: Record<string, unknown>) => {
          plainCalls++
          if (text.length > PLAIN_TEXT_MAX_CHARS) throw tooLongError()
          if (!flooded && plainCalls === floodOnCall) {
            flooded = true
            // Telegram rejected it — nothing landed for this piece.
            throw floodError(1)
          }
          plainSends.push({ text, opts })
          return { message_id: id++ }
        },
      },
    }
  }

  it('resumes at the failed piece instead of re-sending pieces 1-3', async () => {
    const bot = fakeBot(4)
    // The REAL retry policy (which is what re-invokes the closure), with sleep
    // stubbed so the flood wait costs no wall-clock time.
    const retry = createRetryApiCall({ sleep: async () => {} })
    const send = createOutboxSend({ getBot: () => bot as never, retry })
    const body = longBody(20_000)

    const res = await send(CHAT, null, body)

    const expected = splitPlainTextToCap(body)
    expect(expected.length).toBeGreaterThanOrEqual(5) // a real mid-loop failure

    // Every piece delivered EXACTLY once, in order — no duplicate prefix.
    expect(bot.plainSends.map((s) => s.text)).toEqual(expected)
    // Bookkeeping matches the wire (no phantom / double-counted messages).
    expect(res.chunks.map((c) => c.text)).toEqual(expected)
    expect(res.chunks).toHaveLength(expected.length)
    // The deterministic parse-reject is not re-issued on the retry either.
    expect(bot.richCalls()).toBe(1)
    // And nothing was lost.
    expect(bot.plainSends.map((s) => s.text).join('').replace(/\s+/g, '')).toBe(
      body.replace(/\s+/g, ''),
    )
  })

  it('a 429 on the FINAL keyboard-bearing piece re-sends only that piece', async () => {
    const body = longBody(20_000)
    const expected = splitPlainTextToCap(body)
    // Flood the LAST plain send — the piece that carries the button.
    const bot = fakeBot(expected.length)
    const markup = { inline_keyboard: [[{ text: '🔊 Listen', callback_data: 'voice:1' }]] }
    const retry = createRetryApiCall({ sleep: async () => {} })
    const send = createOutboxSend({
      getBot: () => bot as never,
      retry,
      resolveReplyMarkup: () => markup,
    })

    await send(CHAT, null, body)

    // The whole prefix is NOT re-delivered: one message per piece, no more.
    expect(bot.plainSends.map((s) => s.text)).toEqual(expected)
    const withMarkup = bot.plainSends.filter((s) => s.opts.reply_markup != null)
    expect(withMarkup).toHaveLength(1)
    expect(bot.plainSends[bot.plainSends.length - 1]!.opts.reply_markup).toEqual(markup)
  })
})

describe('#4043 site 3 — captured-prose exhausted-boundary fallback', () => {
  it('delivers a 20k-char recovered answer as ≤4096-char plain pieces', async () => {
    const plainSends: string[] = []
    let id = 700
    const api = {
      sendRichMessage: async () => {
        throw parseRejectError('sendRichMessage')
      },
      sendMessage: async (_chatId: string, text: string) => {
        if (text.length > PLAIN_TEXT_MAX_CHARS) throw tooLongError()
        plainSends.push(text)
        return { message_id: id++ }
      },
    }
    const recorded: Array<{ message_ids: number[]; texts: string[] }> = []
    const body = longBody(20_000)
    const deps: DeliverCapturedProseDeps = {
      outboundDedup: new OutboundDedupCache(),
      bot: { api } as unknown as DeliverCapturedProseDeps['bot'],
      robustApiCall: (fn) => fn(),
      redactOutboundText: (t) => t,
      recordOutbound: (rec) => recorded.push({ message_ids: rec.message_ids, texts: rec.texts }),
      HISTORY_ENABLED: true,
      OBLIGATION_LEDGER_ENABLED: true,
      obligationLedger: { close: () => {} },
      clearSilentEndState: () => {},
      // Re-prompt budget already spent → the plain-text fallback arm fires.
      recordUndeliveredTurnEnd: () => ({ exhausted: true }),
      hasOutboundDeliveredSince: () => false,
    }

    await deliverCapturedProse(deps, {
      chatId: CHAT,
      threadId: undefined,
      statusKeyStr: `${CHAT}:main`,
      registryKey: null,
      originTurnId: 'turn-4043',
      text: body,
    })

    expect(plainSends.length).toBeGreaterThan(1)
    for (const s of plainSends) expect(s.length).toBeLessThanOrEqual(PLAIN_TEXT_MAX_CHARS)
    // The recovered answer reached the user AND landed in history (no generic
    // apology instead of the answer).
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.texts).toEqual(plainSends)
    expect(plainSends.join('').replace(/\s+/g, '')).toBe(body.replace(/\s+/g, ''))
  })
})
