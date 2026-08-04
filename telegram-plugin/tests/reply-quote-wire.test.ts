/**
 * Wire-level outcome test for `quote_text` (surgical quote-reply).
 *
 * WHY AT THE FETCH LAYER
 * ----------------------
 * The bug this pins was a PAYLOAD-SHAPE bug: `reply_parameters.quote` was built
 * as `{ text, position: 0 }` when the Bot API declares `quote` a **String**
 * (`quote_position` is a separate sibling Integer). Telegram answered every
 * quoted reply with `400 Bad Request: field "quote" must be of type String` —
 * 378 of 384 total `sendRichMessage` failures across the live fleet
 * (agent `overlord`, 2026-07-29 → 07-30). A unit test over the options builder
 * would have asserted the same wrong shape happily; only a test that reads what
 * actually goes over the wire can catch it, and only that keeps a future
 * wrapper (a re-render, an opts transform, a new send adapter) from re-breaking
 * it invisibly.
 *
 * So this drives the REAL send path — `sendReply` (the body of the gateway's
 * `executeReply`, which is a thin wrapper over it) — against a REAL grammy
 * `Bot` whose HTTP client is an injected `fetch`. Every assertion is made on
 * the JSON body grammy serialized for `POST /botTOKEN/sendRichMessage`.
 */

import { describe, it, expect } from 'vitest'
import { Bot, type Context } from 'grammy'
import { sendReply, type SendReplyGatewayDeps } from '../gateway/outbound-send-path.js'
import { handleStreamReply, type StreamReplyDeps } from '../stream-reply-handler.js'
import type { StreamBotApi } from '../stream-controller.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import { FlushedTurnSupersedeRegistry } from '../flushed-turn-supersede.js'
import { VoiceOnDemandCache } from '../voice-ondemand.js'
import { PreSynthQueue } from '../voice-presynth.js'
import type { Access } from '../gateway/gateway.js'

const CHAT = '5550001'

type WireCall = { method: string; payload: Record<string, unknown> }

/** Scripted Telegram error for one wire method. Fires `times` times (default 1),
 *  then that method succeeds. `times` matters for the body-error cases: a real
 *  unparseable body fails EVERY time it is re-sent to the same method, so a
 *  fire-once script would let a wrong fallback branch pass by accident. */
type ScriptedError = { method: string; description: string; times?: number }

/** A REAL grammy Bot whose HTTP client is an injected fetch — every call is
 *  captured as the JSON body grammy actually serialized for the Bot API. */
function makeWireBot(opts: { errors?: ScriptedError[] } = {}) {
  const calls: WireCall[] = []
  const errors = [...(opts.errors ?? [])]
  let nextMessageId = 9000

  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input)
    const method = url.slice(url.lastIndexOf('/') + 1)
    const body = typeof init?.body === 'string' ? init.body : '{}'
    const payload = JSON.parse(body) as Record<string, unknown>
    calls.push({ method, payload })
    const scripted = errors.findIndex((e) => e.method === method)
    if (scripted >= 0) {
      const err = errors[scripted]
      const remaining = (err.times ?? 1) - 1
      if (remaining > 0) errors[scripted] = { ...err, times: remaining }
      else errors.splice(scripted, 1)
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: err.description }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(CHAT), type: 'private' },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const bot = new Bot<Context>('123456:TEST-TOKEN', {
    client: { fetch: fetchImpl },
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: 'test',
      username: 'test_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business_account: false,
      has_main_web_app: false,
    },
  })

  const sends = () => calls.filter((c) => c.method.startsWith('send'))
  const replyParams = (c: WireCall) => c.payload.reply_parameters as Record<string, unknown> | undefined
  return { bot, calls, sends, replyParams }
}

function makeHarness(opts: { errors?: ScriptedError[] } = {}) {
  const wire = makeWireBot(opts)
  const bot = wire.bot

  const access: Access = {
    dmPolicy: 'allowlist',
    allowFrom: [CHAT],
    groups: {},
    pending: {},
    parseMode: 'html',
    historyEnabled: false,
  }

  const noop = () => {}
  const deps: SendReplyGatewayDeps = {
    outboundDedup: new OutboundDedupCache(),
    flushedTurnSupersede: new FlushedTurnSupersedeRegistry(),
    firstTextReplyLogged: new Set<string>(),
    suppressPtyPreview: new Set<string>(),
    activeDraftStreams: new Map(),
    lastPtyPreviewByChat: new Map(),
    voiceOnDemandCache: new VoiceOnDemandCache(),
    voicePreSynthQueue: new PreSynthQueue({ runJob: async () => {} }),
    pendingProgress: { clearPending: noop, noteOutbound: noop },
    signalTracker: { noteOutbound: noop, noteSignal: noop },
    silencePoke: { noteOutbound: noop },
    getCurrentTurn: () => null,
    getLastActiveTurnChatId: () => undefined,
    HISTORY_ENABLED: false,
    TURN_ORIGIN_ROUTING_ENABLED: false,
    AUTOCLASSIFY_MIDTURN_SHADOW: false,
    MAX_ATTACHMENT_BYTES: 50 * 1024 * 1024,
    MAX_CHUNK_LIMIT: 4000,
    PHOTO_EXTS: new Set(['.png', '.jpg']),
    lockedBot: bot,
    robustApiCall: <T>(fn: () => Promise<T>) => fn(),
    swallowingApiCall: async (fn: () => Promise<unknown>) => {
      try {
        return await fn()
      } catch {
        return undefined
      }
    },
    loadAccess: () => access,
    redactOutboundText: (t: string) => t,
    assertAllowedChat: noop,
    assertSendable: noop,
    statusKey: (chatId: string, threadId?: number | null) => `${chatId}:${threadId ?? ''}`,
    streamKey: (chatId: string, threadId?: number | null) => `${chatId}:${threadId ?? ''}`,
    resolveReplyOwnerTurn: () => ({
      turn: null,
      tier: 'none',
      candidates: {
        liveTurnId: null,
        originTurnId: null,
        quotedTurnId: null,
        latestEndedTurnId: null,
      },
    }),
    findTurnByOriginId: () => null,
    findTurnByQuotedMessageId: () => null,
    resolveAnswerThreadWithLog: () => undefined,
    resolveThreadId: () => undefined,
    getLatestInboundMessageId: () => null,
    getLastSubagentHandbackAt: () => null,
    // #4176 — no sub-agent live on this session (see subagent-reply-authority.ts).
    subagentReplyAuthority: { subagentCouldOwnReply: () => false },
    recordOutbound: noop,
    emissionAuthorityFor: () =>
      ({
        claimOrDowngradePing: () => ({ allowed: true, ping: true }),
      }) as never,
    clearActivitySummary: noop,
    startTypingLoop: noop,
    stopTypingLoop: noop,
    logOutbound: noop,
    closeObligationOnSubstantiveReply: noop,
    finalizeStatusReaction: noop,
    releaseTurnBufferGate: noop,
    reapQueuedStatus: noop,
    noteAgentOutputAt: noop,
    rememberAgentButtonMeta: noop,
    resolveVoiceOutPlan: () => null,
    synthesizeVoiceOut: async () => null,
    publishToTelegraph: async () => null,
    clearSilentEndState: noop,
    emitRuntimeMetric: noop,
    shadowEmit: noop,
    progressDriver: null,
  }

  return { ...wire, deps }
}

/** Drive the REAL `stream_reply` handler against the same wire-capturing bot. */
function makeStreamHarness(opts: { errors?: ScriptedError[] } = {}) {
  const wire = makeWireBot(opts)
  const noop = () => {}
  const deps: StreamReplyDeps = {
    bot: wire.bot as unknown as { api: StreamBotApi },
    retry: <T>(fn: () => Promise<T>) => fn(),
    repairEscapedWhitespace: (t: string) => t,
    assertAllowedChat: noop,
    resolveThreadId: () => undefined,
    disableLinkPreview: true,
    defaultFormat: 'html',
    logStreamingEvent: noop,
    historyEnabled: false,
    recordOutbound: noop,
    writeError: noop,
    throttleMs: 0,
  }
  const state = {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
    suppressPtyPreview: new Set<string>(),
    lastPtyPreviewByChat: new Map<string, string>(),
  }
  return { ...wire, deps, state }
}

describe('quote_text lands on the wire as ReplyParameters.quote (a String)', () => {
  it('sends reply_parameters.quote as a string and resolves delivered', async () => {
    const h = makeHarness()
    const res = await sendReply(h.deps, {
      args: {
        chat_id: CHAT,
        text: 'Yes — that line is the one that breaks.',
        reply_to: 4242,
        quote_text: 'the position is a separate field',
      },
      turn: null,
    })

    const sends = h.sends()
    expect(sends.length).toBeGreaterThan(0)
    const rp = h.replyParams(sends[0])
    expect(rp).toBeDefined()
    expect(rp!.message_id).toBe(4242)
    // The bug: `quote` was an OBJECT (`{ text, position }`). Telegram requires
    // a String, and rejected every such send with 400.
    expect(typeof rp!.quote).toBe('string')
    expect(rp!.quote).toBe('the position is a separate field')
    // No fabricated position — Telegram locates the quote itself, and neither
    // send site has a real position source.
    expect(rp).not.toHaveProperty('quote_position')
    expect(rp).not.toHaveProperty('quote_parse_mode')
    // Delivered: the send resolved and the tool result is not a failure notice.
    const out = res.content[0]?.text ?? ''
    expect(out).not.toMatch(/fail/i)
    expect(out).toMatch(/sent/i)
  })

  it('is NOT html-escaped — the quote must stay an exact substring of the original', async () => {
    const h = makeHarness()
    await sendReply(h.deps, {
      args: {
        chat_id: CHAT,
        text: 'Checked.',
        reply_to: 77,
        quote_text: 'tom & jerry <b>not a tag</b>',
      },
      turn: null,
    })
    const rp = h.replyParams(h.sends()[0])!
    expect(rp.quote).toBe('tom & jerry <b>not a tag</b>')
  })

  it('a quote Telegram cannot find degrades to an unquoted reply instead of losing the answer', async () => {
    const h = makeHarness({
      errors: [
        { method: 'sendRichMessage', description: 'Bad Request: QUOTE_TEXT_INVALID' },
      ],
    })
    const res = await sendReply(h.deps, {
      args: {
        chat_id: CHAT,
        text: 'The answer still has to land.',
        reply_to: 4242,
        quote_text: 'a paraphrase that is not in the original',
      },
      turn: null,
    })

    const sends = h.sends()
    expect(sends.length).toBe(2)
    // First attempt carried the quote and was rejected …
    expect(h.replyParams(sends[0])!.quote).toBe('a paraphrase that is not in the original')
    // … the retry keeps the reply target and drops only the highlight.
    const retry = h.replyParams(sends[1])!
    expect(retry.message_id).toBe(4242)
    expect(retry).not.toHaveProperty('quote')
    expect(res.content[0]?.text ?? '').toMatch(/sent/i)
  })

  // A `<blockquote>` parse failure is a BODY error whose description happens to
  // contain the substring "quote". If the quote classifier claims it, the ladder
  // takes the quote branch, re-sends the SAME unparseable body without the
  // quote, hits the same 400 with no secondary handling, and throws — so the
  // pre-existing plain-text rescue never runs and the composed answer is lost.
  // This is an outcome test on purpose: asserting the classifier returns false
  // in isolation would not have caught it, because the loss happens in the
  // ladder, not in the predicate.
  for (const description of [
    'Bad Request: can\'t parse entities: Can\'t find end tag corresponding to start tag "blockquote"',
    'Bad Request: can\'t parse entities: Unsupported start tag "blockquote"',
  ]) {
    it(`a blockquote parse error on a QUOTED reply still reaches the plain-text rescue (${description.slice(-24)})`, async () => {
      const h = makeHarness({
        // Fails every time it is attempted — a body Telegram cannot parse does
        // not start parsing on the second try.
        errors: [{ method: 'sendRichMessage', description, times: 5 }],
      })

      const res = await sendReply(h.deps, {
        args: {
          chat_id: CHAT,
          text: 'The answer must survive a blockquote parse error.',
          reply_to: 4242,
          quote_text: 'a real substring of the original',
        },
        turn: null,
      })

      const sends = h.sends()
      // The rich attempt failed; the rescue must have gone out over a DIFFERENT
      // method (plain text, no rich wrapper ⇒ the entity parser never runs).
      const rescue = sends.filter((c) => c.method !== 'sendRichMessage')
      expect(rescue.length).toBeGreaterThan(0)
      // The answer actually landed, with its body intact.
      expect(String(rescue[0].payload.text ?? '')).toContain(
        'The answer must survive a blockquote parse error.',
      )
      expect(res.content[0]?.text ?? '').toMatch(/sent/i)
      // And the quote branch was never taken: no second rich send stripped of
      // the quote (that path is what swallowed the answer).
      const richSends = sends.filter((c) => c.method === 'sendRichMessage')
      expect(richSends.length).toBe(1)
    })
  }

  it('omits quote entirely when quote_text is absent (plain reply unchanged)', async () => {
    const h = makeHarness()
    await sendReply(h.deps, {
      args: { chat_id: CHAT, text: 'plain reply', reply_to: 12 },
      turn: null,
    })
    const rp = h.replyParams(h.sends()[0])!
    expect(rp).toEqual({ message_id: 12 })
  })

  it('stream_reply carries the same String shape to the wire', async () => {
    const h = makeStreamHarness()
    await handleStreamReply(
      {
        chat_id: CHAT,
        text: 'streamed answer',
        done: true,
        reply_to: '881',
        quote_text: 'exactly this fragment',
      },
      h.state,
      h.deps,
    )
    const sends = h.sends()
    expect(sends.length).toBeGreaterThan(0)
    const rp = h.replyParams(sends[0])!
    expect(rp.message_id).toBe(881)
    expect(typeof rp.quote).toBe('string')
    expect(rp.quote).toBe('exactly this fragment')
    expect(rp).not.toHaveProperty('quote_position')
  })

  it('stream_reply drops an unfindable quote and still delivers the message', async () => {
    const h = makeStreamHarness({
      errors: [
        {
          method: 'sendRichMessage',
          description: 'Bad Request: message quote not found in the original message',
        },
      ],
    })
    const res = await handleStreamReply(
      {
        chat_id: CHAT,
        text: 'streamed answer',
        done: true,
        reply_to: '881',
        quote_text: 'not present in the original',
      },
      h.state,
      h.deps,
    )
    const sends = h.sends()
    expect(sends.length).toBe(2)
    expect(h.replyParams(sends[0])!.quote).toBe('not present in the original')
    expect(h.replyParams(sends[1])!).toEqual({ message_id: 881 })
    expect(res.messageId).not.toBeNull()
  })

  it('truncates an over-long quote to the Bot API 1024-char cap (a prefix is still an exact substring)', async () => {
    const h = makeHarness()
    const long = 'x'.repeat(1500)
    await sendReply(h.deps, {
      args: { chat_id: CHAT, text: 'ok', reply_to: 5, quote_text: long },
      turn: null,
    })
    const rp = h.replyParams(h.sends()[0])!
    expect((rp.quote as string).length).toBe(1024)
    expect(long.startsWith(rp.quote as string)).toBe(true)
  })

  it('never cuts an astral character in half at the 1024 boundary', async () => {
    const h = makeHarness()
    // '𝄞' is one astral char = TWO UTF-16 units. 1023 filler units put its high
    // surrogate at index 1023 and its low surrogate at 1024, so a naive
    // slice(0, 1024) would emit a LONE HIGH SURROGATE — not valid UTF-8 on the
    // wire, and no longer a substring of anything.
    const long = 'x'.repeat(1023) + '𝄞' + 'y'.repeat(200)
    await sendReply(h.deps, {
      args: { chat_id: CHAT, text: 'ok', reply_to: 5, quote_text: long },
      turn: null,
    })
    const quote = h.replyParams(h.sends()[0])!.quote as string
    // Cut back to 1023 rather than splitting the pair …
    expect(quote.length).toBe(1023)
    // … so no unpaired surrogate survives …
    for (const ch of quote) expect(ch.codePointAt(0)! >= 0xd800 && ch.codePointAt(0)! <= 0xdfff).toBe(false)
    // … and it round-trips through UTF-8 unchanged (a lone surrogate would be
    // replaced by U+FFFD here).
    expect(Buffer.from(quote, 'utf8').toString('utf8')).toBe(quote)
    // … and it is still an exact prefix of the original.
    expect(long.startsWith(quote)).toBe(true)
  })
})

/**
 * #4368 — a fabricated reply anchor on the wire.
 *
 * The model's `reply` tool can quote a SYNTHETIC inbound: a boot-resume /
 * subagent-handback / cron turn fabricates a `message_id` from `Date.now()`
 * (~1.78e13). Telegram's `reply_parameters.message_id` HARD-rejects anything
 * out of the signed-int32 range (400 `field "message_id" must be a valid
 * Number`), and `allow_sending_without_reply` does NOT bypass that — so quoting
 * a synthetic id used to 400 EVERY chunk of the reply, losing the answer.
 *
 * `executeReply` (whose body is `sendReply`) must route `args.reply_to` through
 * `parseSourceMessageId` so an out-of-range anchor is DROPPED and the reply
 * lands UNANCHORED. This reads what actually goes over the wire — a builder-
 * level assertion would not catch a future opts transform re-introducing it.
 */
describe('synthetic reply anchor is dropped on the wire (#4368)', () => {
  it('quoting an out-of-int32 reply_to sends UNANCHORED and still delivers', async () => {
    const h = makeHarness()
    const res = await sendReply(h.deps, {
      args: {
        chat_id: CHAT,
        text: 'The answer must land even when the quoted inbound was synthetic.',
        reply_to: 1_785_000_000_000,
      },
      turn: null,
    })

    const sends = h.sends()
    expect(sends.length).toBeGreaterThan(0)
    // The fabricated id never reaches the wire: no reply_parameters at all …
    expect(h.replyParams(sends[0])).toBeUndefined()
    // … and specifically no out-of-range message_id anywhere in the payload.
    expect(JSON.stringify(sends[0].payload)).not.toContain('1785000000000')
    // … and the answer actually delivered (not a failure notice).
    expect(res.content[0]?.text ?? '').toMatch(/sent/i)
  })

  it('a real (in-range) reply_to is still honored as a quote anchor', async () => {
    const h = makeHarness()
    await sendReply(h.deps, {
      args: { chat_id: CHAT, text: 'ok', reply_to: 4242 },
      turn: null,
    })
    expect(h.replyParams(h.sends()[0])!).toEqual({ message_id: 4242 })
  })
})
