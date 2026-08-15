/**
 * Wire-level OUTCOME tests for the UTF-8 sanitiser (#4728).
 *
 * These reproduce the production drop, they do not merely exercise the
 * helper. The stubbed transport below is a FAITHFUL stand-in for Telegram's
 * decoder: it parses the serialized request body and answers
 * `400 Bad Request: strings must be encoded in UTF-8` whenever any string in
 * it contains an unpaired surrogate — which is exactly what the real server
 * did to `gymbro`'s `permission_request` card on 2026-07-31 (twice), and why
 * the operator never saw that approval card.
 *
 * `JSON.stringify` does NOT throw on a lone surrogate (well-formed
 * `JSON.stringify`, ES2019) — it emits the `\udXXX` escape — so the bad body
 * really does reach the wire, and the failure really is server-side.
 *
 * Delete `installUtf8Sanitizer(bot)` from `makeTelegramLikeBot` (or from
 * `initGatewayBot`) and every `(a)`-`(d)` case below goes RED with the
 * production GrammyError, because the send REJECTS instead of delivering.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Bot, GrammyError } from 'grammy'
import { installTgPostLogger, installRichMarkdownGuard } from '../shared/bot-runtime.js'
import {
  installUtf8Sanitizer,
  sanitizeLoneSurrogates,
  sanitizePayloadStrings,
  hasLoneSurrogate,
} from '../shared/utf8-sanitize.js'

/** An unpaired HIGH surrogate — no valid UTF-8 encoding exists for it. */
const LONE_HIGH = '\uD800'
/** An unpaired LOW surrogate — the half every truncation site in the plugin
 * fails to repair (they all only strip a TRAILING high surrogate). */
const LONE_LOW = '\uDC00'
/** A well-formed astral pair (🤖). Must survive untouched. */
const ASTRAL = '\u{1F916}'

function anyLoneSurrogate(v: unknown): boolean {
  if (typeof v === 'string') return hasLoneSurrogate(v)
  if (Array.isArray(v)) return v.some(anyLoneSurrogate)
  if (v !== null && typeof v === 'object') return Object.values(v).some(anyLoneSurrogate)
  return false
}

interface CapturedCall {
  method: string
  body: Record<string, unknown>
}

/**
 * A real grammy Bot wired with the production transformer stack, whose
 * transport rejects a non-UTF-8-encodable body the way Telegram does.
 */
function makeTelegramLikeBot(): { bot: Bot; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const fakeFetch = (async (url: unknown, init?: { body?: unknown }) => {
    const method = String(url).split('/').pop() ?? ''
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body) as Record<string, unknown>
    }
    calls.push({ method, body })
    if (anyLoneSurrogate(body)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: false,
          error_code: 400,
          description: 'Bad Request: strings must be encoded in UTF-8',
        }),
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } },
      }),
    } as unknown as Response
  }) as unknown as typeof fetch

  const bot = new Bot('123456:TEST_TOKEN', {
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
    client: { fetch: fakeFetch },
  })
  // Production ordering (initGatewayBot): sanitiser FIRST so it composes
  // INNERMOST and is the last transformer to touch the payload.
  installUtf8Sanitizer(bot)
  installTgPostLogger(bot)
  installRichMarkdownGuard(bot)
  return { bot, calls }
}

function lastBody(calls: CapturedCall[]): Record<string, unknown> {
  return calls[calls.length - 1].body
}

describe('UTF-8 sanitiser — the dropped approval card (#4728)', () => {
  it('(a) an approval-card body with a lone surrogate DELIVERS instead of 400ing', async () => {
    const { bot, calls } = makeTelegramLikeBot()
    // Shape of a real permission card: rich markdown + the Approve/Deny row.
    const sent = await bot.api.sendRichMessage(
      1,
      { markdown: `**Approve?**\n\`Bash\` — rm -rf ${LONE_HIGH}tmp` },
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'Approve', callback_data: 'perm:allow:1' }]],
        },
      },
    )
    expect(sent.message_id).toBe(1)
    expect(calls[calls.length - 1].method).toBe('sendRichMessage')
    const markdown = (lastBody(calls).rich_message as { markdown: string }).markdown
    expect(markdown).toBe('**Approve?**\n`Bash` — rm -rf �tmp')
    expect(hasLoneSurrogate(markdown)).toBe(false)
  })

  it('(b) an orphaned LOW surrogate — the half no truncation site repairs — also delivers', async () => {
    const { bot, calls } = makeTelegramLikeBot()
    const sent = await bot.api.sendRichMessage(1, { markdown: `${LONE_LOW} continued` })
    expect(sent.message_id).toBe(1)
    expect((lastBody(calls).rich_message as { markdown: string }).markdown).toBe('� continued')
  })

  it('(c) a lone surrogate in an inline-keyboard LABEL delivers (whole payload, not one field)', async () => {
    const { bot, calls } = makeTelegramLikeBot()
    const sent = await bot.api.sendRichMessage(
      1,
      { markdown: 'clean body' },
      {
        reply_markup: {
          inline_keyboard: [[{ text: `Always allow ${LONE_HIGH}`, callback_data: 'perm:always:1' }]],
        },
      },
    )
    expect(sent.message_id).toBe(1)
    const kb = (lastBody(calls).reply_markup as {
      inline_keyboard: { text: string }[][]
    }).inline_keyboard
    expect(kb[0][0].text).toBe('Always allow �')
  })

  it('(d) an ORDINARY sendMessage with a lone surrogate delivers too', async () => {
    const { bot, calls } = makeTelegramLikeBot()
    const sent = await bot.api.sendMessage(1, `answer${LONE_HIGH}`)
    expect(sent.message_id).toBe(1)
    expect(lastBody(calls).text).toBe('answer�')
  })

  it('(e) proves the harness is honest: an UNSANITISED bot really does 400', async () => {
    // Same transport, sanitiser NOT installed — the pre-fix production path.
    // Without this case, (a)-(d) could pass against a permissive stub.
    const calls: CapturedCall[] = []
    const fakeFetch = (async (url: unknown, init?: { body?: unknown }) => {
      const body = typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {}
      calls.push({ method: String(url).split('/').pop() ?? '', body })
      return {
        ok: true,
        status: 200,
        json: async () => (anyLoneSurrogate(body)
          ? { ok: false, error_code: 400, description: 'Bad Request: strings must be encoded in UTF-8' }
          : { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const bot = new Bot('123456:TEST_TOKEN', {
      botInfo: {
        id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot',
        can_join_groups: false, can_read_all_group_messages: false,
        supports_inline_queries: false, can_connect_to_business: false,
        has_main_web_app: false,
      },
      client: { fetch: fakeFetch },
    })
    installTgPostLogger(bot)
    installRichMarkdownGuard(bot)
    await expect(
      bot.api.sendRichMessage(1, { markdown: `**Approve?** ${LONE_HIGH}` }),
    ).rejects.toThrow(GrammyError)
    await expect(
      bot.api.sendRichMessage(1, { markdown: `**Approve?** ${LONE_HIGH}` }),
    ).rejects.toThrow(/strings must be encoded in UTF-8/)
  })

  it('(f) a clean body is byte-identical and the payload object is not cloned', async () => {
    const { bot, calls } = makeTelegramLikeBot()
    const sent = await bot.api.sendRichMessage(1, { markdown: `all good ${ASTRAL} 100% ✓` })
    expect(sent.message_id).toBe(1)
    expect((lastBody(calls).rich_message as { markdown: string }).markdown)
      .toBe(`all good ${ASTRAL} 100% ✓`)
    // Identity no-op is the contract the transformer relies on to stay free.
    const payload = { chat_id: 1, text: 'clean' }
    expect(sanitizePayloadStrings(payload)).toBe(payload)
  })
})

describe('sanitizeLoneSurrogates / sanitizePayloadStrings — unit contract', () => {
  it('preserves well-formed pairs, including adjacent ones', () => {
    const s = `${ASTRAL}${ASTRAL}ok`
    expect(sanitizeLoneSurrogates(s)).toBe(s)
    expect(hasLoneSurrogate(s)).toBe(false)
  })

  it('repairs both halves and is length-preserving', () => {
    expect(sanitizeLoneSurrogates(`a${LONE_HIGH}b`)).toBe('a�b')
    expect(sanitizeLoneSurrogates(`a${LONE_LOW}b`)).toBe('a�b')
    expect(sanitizeLoneSurrogates(`a${LONE_HIGH}b`).length).toBe(3)
  })

  it('repairs a high surrogate followed by another high surrogate (both lone)', () => {
    expect(sanitizeLoneSurrogates(`${LONE_HIGH}${LONE_HIGH}`)).toBe('��')
  })

  it('is idempotent', () => {
    const once = sanitizeLoneSurrogates(`x${LONE_HIGH}y`)
    expect(sanitizeLoneSurrogates(once)).toBe(once)
  })

  it('is stateless across calls (the shared /g regex must not carry lastIndex)', () => {
    for (let i = 0; i < 4; i++) {
      expect(hasLoneSurrogate(`ab${LONE_HIGH}`)).toBe(true)
      expect(sanitizeLoneSurrogates(`ab${LONE_HIGH}`)).toBe('ab�')
    }
  })

  it('does not rebuild non-plain objects (an InputFile-like instance survives by identity)', () => {
    class InputFileLike {
      constructor(public filename: string) {}
    }
    const file = new InputFileLike('photo.png')
    const payload = { chat_id: 1, photo: file, caption: `hi${LONE_HIGH}` }
    const out = sanitizePayloadStrings(payload)
    expect(out).not.toBe(payload)
    expect(out.caption).toBe('hi�')
    expect(out.photo).toBe(file)
    expect(out.photo).toBeInstanceOf(InputFileLike)
  })

  it('leaves non-string scalars alone', () => {
    const payload = { chat_id: 1, disable_notification: true, x: null, y: undefined }
    expect(sanitizePayloadStrings(payload)).toBe(payload)
  })

  it('handles a null/undefined payload without throwing (grammy passes those)', () => {
    expect(sanitizePayloadStrings(undefined)).toBe(undefined)
    expect(sanitizePayloadStrings(null)).toBe(null)
  })
})

describe('boot wiring: the sanitiser is the INNERMOST transformer', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'gateway', 'gateway.ts'),
    'utf8',
  )

  it('installs it exactly once', () => {
    const hits = src.match(/installUtf8Sanitizer\(bot\)/g) ?? []
    expect(hits.length).toBe(1)
  })

  it('installs it BEFORE every other transformer, so it composes innermost', () => {
    // grammy: `call = trans(prev, ...)` — last installed is outermost, first
    // installed is innermost. Innermost is the only position that guarantees
    // no later transformer can reintroduce a lone surrogate behind our back.
    const sanitizer = src.indexOf('installUtf8Sanitizer(bot)')
    expect(sanitizer).toBeGreaterThan(-1)
    for (const later of [
      'installTgPostLogger(bot)',
      'installRichMarkdownGuard(bot)',
      'installSentTextCapture(bot)',
      'installEditFloodFuse(bot',
    ]) {
      expect(src.indexOf(later), later).toBeGreaterThan(sanitizer)
    }
  })
})
