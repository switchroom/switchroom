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
