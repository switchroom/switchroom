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
function makeTelegramLikeBot(now?: () => number): { bot: Bot; calls: CapturedCall[] } {
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
  installUtf8Sanitizer(bot, now)
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

  it('(f2) a clean payload is not rebuilt at ANY depth — no container allocated, no property defined', () => {
    // (f) only pins the identity of the TOP-level return, which a walk that
    // clones every nested container and discards the clones still satisfies.
    // This transformer is the innermost hop of every `bot.api.*` call and the
    // draft-stream `editMessageText` path runs it several times a second, so
    // "the clean case rebuilds nothing" is a real contract, not a comment.
    const button = { text: `Approve ${ASTRAL}`, callback_data: 'perm:allow:1' }
    const row = [button]
    const keyboard = [row]
    const markup = { inline_keyboard: keyboard }
    const payload = { chat_id: 1, text: `all good ${ASTRAL} 100% ✓`, reply_markup: markup }

    const realDefineProperty = Object.defineProperty
    let definePropertyCalls = 0
    Object.defineProperty = ((...args: Parameters<typeof Object.defineProperty>) => {
      definePropertyCalls++
      return realDefineProperty(...args)
    }) as typeof Object.defineProperty
    let out: typeof payload
    try {
      out = sanitizePayloadStrings(payload)
    } finally {
      Object.defineProperty = realDefineProperty
    }

    // Goes RED on an eager clone: the old walk defined one property per key
    // at every level before deciding nothing had changed.
    expect(definePropertyCalls).toBe(0)
    // Every container comes back by identity, top level down to the button.
    expect(out).toBe(payload)
    expect(out.reply_markup).toBe(markup)
    expect(out.reply_markup.inline_keyboard).toBe(keyboard)
    expect(out.reply_markup.inline_keyboard[0]).toBe(row)
    expect(out.reply_markup.inline_keyboard[0][0]).toBe(button)
  })

  it('(f3) a DIRTY payload still rebuilds correctly from the lazily-materialised clone', () => {
    // The lazy clone backfills the already-walked (clean) prefix. If that
    // backfill were wrong, keys before the first repair would vanish.
    const payload = {
      chat_id: 1,
      before_a: 'kept a',
      before_b: 'kept b',
      text: `boom${LONE_HIGH}`,
      after: 'kept c',
      nested: { keep: 'yes', bad: `${LONE_LOW}x` },
      arr: ['keep 0', 'keep 1', `bad${LONE_HIGH}`, 'keep 3'],
    }
    const out = sanitizePayloadStrings(payload)
    expect(out).not.toBe(payload)
    expect(Object.keys(out)).toEqual(Object.keys(payload))
    expect(out.before_a).toBe('kept a')
    expect(out.before_b).toBe('kept b')
    expect(out.text).toBe('boom�')
    expect(out.after).toBe('kept c')
    expect(out.nested).toEqual({ keep: 'yes', bad: '�x' })
    expect(out.arr).toEqual(['keep 0', 'keep 1', 'bad�', 'keep 3'])
    // Clone-on-write: the input itself is untouched.
    expect(payload.text).toBe(`boom${LONE_HIGH}`)
    expect(payload.arr[2]).toBe(`bad${LONE_HIGH}`)
  })

  it('(g) a payload whose own enumerable getter THROWS still sends — the sanitiser fails open', async () => {
    // The walk reads own enumerable properties, which invokes getters. This
    // transformer sits on the innermost hop of EVERY `bot.api.*` call, so an
    // exception escaping it would wedge the whole gateway, not one send.
    //
    // Ordering here is deliberately inverted relative to production (the
    // recorder is installed first, so it is INNERMOST and answers without
    // serialising) purely to isolate what the sanitiser hands downstream.
    // Production ordering is pinned by the boot-wiring describe below.
    const seen: unknown[] = []
    const bot = new Bot('123456:TEST_TOKEN', {
      botInfo: {
        id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot',
        can_join_groups: false, can_read_all_group_messages: false,
        supports_inline_queries: false, can_connect_to_business: false,
        has_main_web_app: false,
      },
    })
    bot.api.config.use(async (_prev, _method, payload) => {
      seen.push(payload)
      return {
        ok: true,
        result: { message_id: 7, date: 0, chat: { id: 1, type: 'private' } },
      } as never
    })
    installUtf8Sanitizer(bot)

    const payload: Record<string, unknown> = { chat_id: 1 }
    Object.defineProperty(payload, 'text', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('getter exploded')
      },
    })

    // Load-bearing: without the guard in `installUtf8Sanitizer` this is the
    // exception that would escape into every outbound call.
    expect(() => sanitizePayloadStrings(payload)).toThrow('getter exploded')

    const sent = await bot.api.raw.sendMessage(payload as never)
    expect(sent.message_id).toBe(7)
    // Failed open: the ORIGINAL payload was passed through, not swallowed.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(payload)
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

  it('does not copy INHERITED enumerable keys into the clone (prototype pollution)', () => {
    // The walk uses `for...in`, which unlike `Object.entries` also yields
    // inherited enumerable keys. Without the own-property guard a polluted
    // `Object.prototype` would add a field to the body sent to Telegram.
    const proto = Object.prototype as unknown as Record<string, unknown>
    Object.defineProperty(proto, '__polluted__', {
      value: `evil${LONE_HIGH}`,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    try {
      const payload = { chat_id: 1, text: `hi${LONE_HIGH}` }
      const out = sanitizePayloadStrings(payload)
      expect(out.text).toBe('hi�')
      expect(Object.prototype.hasOwnProperty.call(out, '__polluted__')).toBe(false)
      expect(Object.keys(out)).toEqual(['chat_id', 'text'])
      expect(JSON.stringify(out)).toBe('{"chat_id":1,"text":"hi�"}')
    } finally {
      delete proto.__polluted__
    }
  })

  it('leaves non-string scalars alone', () => {
    const payload = { chat_id: 1, disable_notification: true, x: null, y: undefined }
    expect(sanitizePayloadStrings(payload)).toBe(payload)
  })

  it('handles a null/undefined payload without throwing (grammy passes those)', () => {
    expect(sanitizePayloadStrings(undefined)).toBe(undefined)
    expect(sanitizePayloadStrings(null)).toBe(null)
  })

  it('keeps an own `__proto__` key as an own property of the clone', () => {
    // `out['__proto__'] = v` hits the Object.prototype accessor and reassigns
    // the clone's PROTOTYPE instead of creating an own property — the key
    // would vanish from the payload entirely.
    const payload: Record<string, unknown> = { chat_id: 1, text: `hi${LONE_HIGH}` }
    Object.defineProperty(payload, '__proto__', {
      value: `p${LONE_LOW}`,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    const out = sanitizePayloadStrings(payload)
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('p�')
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    // And it survives serialisation, which is the only thing the wire sees.
    expect(JSON.stringify(out)).toContain('"__proto__":"p�"')
    expect(out.text).toBe('hi�')
  })
})

describe('repair logging: real count, throttled per method', () => {
  /**
   * Swap `process.stderr.write` directly rather than through `vi`: this file
   * runs under BOTH vitest and `bun test`, and the mock/timer halves of `vi`
   * are not equivalent across the two.
   */
  async function captureSanitizeLog(fn: (lines: string[]) => Promise<void>): Promise<void> {
    const lines: string[] = []
    const real = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      const s = String(chunk)
      if (s.includes('utf8-sanitize')) lines.push(s)
      return true
    }) as typeof process.stderr.write
    try {
      await fn(lines)
    } finally {
      process.stderr.write = real
    }
  }

  it('reports how many code units were repaired, and logs once per method per minute', async () => {
    let clock = 1_000_000
    await captureSanitizeLog(async lines => {
      const { bot } = makeTelegramLikeBot(() => clock)

      // Two lone surrogates in one body: a high with no follower, a low with
      // no leader. The docblock promises a count, so the line must carry one.
      await bot.api.sendMessage(1, `a${LONE_HIGH}b${LONE_LOW}`)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('repaired 2 lone surrogate(s)')
      expect(lines[0]).toContain('method=sendMessage')
      // Never the content itself.
      expect(lines[0]).not.toContain('a�b')

      // Same method inside the window — a persistently corrupt draft stream
      // must not emit one line per edit.
      clock += 500
      await bot.api.sendMessage(1, `c${LONE_HIGH}`)
      clock += 500
      await bot.api.sendMessage(1, `d${LONE_HIGH}`)
      expect(lines).toHaveLength(1)

      // A different method has its own budget.
      await bot.api.editMessageText(1, 1, `e${LONE_HIGH}`)
      expect(lines).toHaveLength(2)
      expect(lines[1]).toContain('method=editMessageText')
      expect(lines[1]).toContain('repaired 1 lone surrogate(s)')

      // Next window: the corruption is still diagnosable.
      clock += 61_000
      await bot.api.sendMessage(1, `f${LONE_HIGH}`)
      expect(lines).toHaveLength(3)
      expect(lines[2]).toContain('method=sendMessage')
    })
  })

  it('failing open is LOGGED, not silent, and names the method', async () => {
    // Fail-open is correct (see the docblock) but a silent fail-open turns a
    // future walk bug into a bare Telegram 400 with no trail back here — the
    // exact opacity #4728 exists to end. Goes RED on a bare `catch {}`.
    let clock = 2_000_000
    await captureSanitizeLog(async lines => {
      const bot = new Bot('123456:TEST_TOKEN', {
        botInfo: {
          id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot',
          can_join_groups: false, can_read_all_group_messages: false,
          supports_inline_queries: false, can_connect_to_business: false,
          has_main_web_app: false,
        },
      })
      bot.api.config.use(async () => ({
        ok: true,
        result: { message_id: 7, date: 0, chat: { id: 1, type: 'private' } },
      } as never))
      installUtf8Sanitizer(bot, () => clock)

      const explode = (): Record<string, unknown> => {
        const p: Record<string, unknown> = { chat_id: 1 }
        Object.defineProperty(p, 'text', {
          enumerable: true,
          configurable: true,
          get() { throw new Error('getter exploded') },
        })
        return p
      }

      // Still sends (fail-open), and says so.
      const sent = await bot.api.raw.sendMessage(explode() as never)
      expect(sent.message_id).toBe(7)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('FAILED OPEN')
      expect(lines[0]).toContain('method=sendMessage')
      expect(lines[0]).toContain('getter exploded')

      // Throttled on its own budget, like the repair line.
      clock += 500
      await bot.api.raw.sendMessage(explode() as never)
      expect(lines).toHaveLength(1)

      clock += 61_000
      await bot.api.raw.sendMessage(explode() as never)
      expect(lines).toHaveLength(2)
      expect(lines[1]).toContain('FAILED OPEN')
    })
  })

  it('logs nothing for a clean body', async () => {
    await captureSanitizeLog(async lines => {
      const { bot } = makeTelegramLikeBot()
      await bot.api.sendMessage(1, `all good ${ASTRAL}`)
      expect(lines).toHaveLength(0)
    })
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

  it('there is exactly ONE bot instance for that single install to cover', () => {
    // The ordering assertion below is textual. A second `new Bot(` in
    // gateway.ts would get no sanitiser at all while every test here stayed
    // green, so pin the instance count too.
    expect((src.match(/new Bot\(/g) ?? []).length).toBe(1)
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

  it('nothing at all is installed between `new Bot(` and the sanitiser', () => {
    // The named-installer check above is one-sided: it pins four KNOWN
    // installers as later, but someone adding `installFoo(bot)` between
    // `new Bot(TOKEN)` and `installUtf8Sanitizer(bot)` composes INNER of the
    // sanitiser, sends unsanitised, and leaves every test in this file green.
    // So pin it from the other side: the sanitiser must be the FIRST thing
    // wired onto the bot, full stop.
    const botIdx = src.search(/new Bot\(/)
    expect(botIdx).toBeGreaterThan(-1)

    const WIRING = /install[A-Za-z0-9_]*\(\s*bot\b|\.api\.config\.use\(/g
    WIRING.lastIndex = botIdx
    const first = WIRING.exec(src)
    expect(first, 'no bot wiring found after `new Bot(`').not.toBeNull()
    expect(
      first![0],
      `first bot wiring after \`new Bot(\` was \`${first![0]}\` — the UTF-8 ` +
      'sanitiser must be installed first so it composes innermost',
    ).toBe('installUtf8Sanitizer(bot')
  })
})
