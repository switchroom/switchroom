/**
 * Wire-level outcome tests for the `tg-post` logger's error shape (#3927).
 *
 * The bug: grammY resolves its transformer chain with the raw `ApiResponse`
 * and only converts `{ok:false}` into a thrown `GrammyError` AFTER the chain
 * returns (grammy `out/core/client.js`, `callApi`). Every Telegram-level
 * rejection — 429 flood-wait, 400, 403 — therefore reached
 * `installTgPostLogger` as a RESOLVED value and was logged
 * `status=ok err=- code=- desc=-`. Only transport `HttpError`s ever hit the
 * `catch`. A rate-limited `unpinAllChatMessages` on clerk logged as SUCCESS
 * 3ms before the retry policy logged `429 rate limited, waiting 3s`.
 *
 * These tests MUST go through a REAL grammy `Bot` with a stubbed transport
 * (the same reason `rich-markdown-guard-transformer.test.ts` does): the
 * mock-`api` harnesses sit ABOVE the transformer layer, so `api.config.use`
 * transformers never run there and a test written through them would be a
 * false guard. Stubbing `client.fetch` with an `ok:false` envelope is the
 * only way to reproduce the exact resolved-rejection path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Bot } from 'grammy'
import { installTgPostLogger } from '../shared/bot-runtime.js'

/**
 * A real Bot whose transport always answers with the given Telegram
 * envelope. HTTP status stays 200 — a Bot API rejection is a 200 response
 * carrying `ok:false`, which is precisely why it resolves the chain.
 */
function makeBot(envelope: Record<string, unknown>): Bot {
  const fakeFetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => envelope,
    }) as unknown as Response) as unknown as typeof fetch

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
  installTgPostLogger(bot)
  return bot
}

/** Run one API call against the stub and return every tg-post line emitted. */
async function tgPostLinesFor(envelope: Record<string, unknown>): Promise<string[]> {
  const written: string[] = []
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as unknown as typeof process.stderr.write)
  try {
    const bot = makeBot(envelope)
    // grammy converts the ok:false envelope into a thrown GrammyError once
    // the transformer chain has returned — expected, and not what we assert.
    await bot.api.sendMessage(4242, 'hello').catch(() => undefined)
  } finally {
    spy.mockRestore()
  }
  return written.filter(l => l.startsWith('tg-post '))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tg-post logger — resolved ok:false responses (#3927)', () => {
  // These calls are made directly on `bot.api.*` with NO enclosing retry
  // policy, so every rejection here IS the outcome and stays `status=err`.
  // The `status=retry` tier (#3931) only applies inside `createRetryApiCall`
  // — see `tg-post-retry-attribution.test.ts`.
  it('logs a 429 flood-wait as status=err code=429 (FAILS before the fix: logged status=ok)', async () => {
    const lines = await tgPostLinesFor({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 3',
      parameters: { retry_after: 3 },
    })

    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line).toContain('status=err')
    expect(line).toContain('code=429')
    expect(line).toContain('err=telegram_429')
    expect(line).toContain('desc=Too Many Requests: retry after 3')
    // The precise regression: it must NOT claim success.
    expect(line).not.toContain('status=ok')
  })

  it('logs a non-benign 400 as status=err carrying the rejection reason', async () => {
    const lines = await tgPostLinesFor({
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities: unsupported start tag",
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('status=err')
    expect(lines[0]).toContain('code=400')
    expect(lines[0]).toContain("desc=Bad Request: can't parse entities")
  })

  it('logs a 403 as status=err', async () => {
    const lines = await tgPostLinesFor({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('status=err')
    expect(lines[0]).toContain('code=403')
  })
})

describe('tg-post logger — benign 400s do not become error noise (#3927)', () => {
  // Promoting every ok:false to status=err would flood the log with the
  // high-volume no-ops the retry policy already swallows, burying the signal
  // this change exists to create. They get their own `benign` tier instead:
  // still logged (same volume as the status=ok line they replace), never
  // matched by `grep status=err`.
  const benign: Array<[string, string]> = [
    ['not modified', 'Bad Request: message is not modified'],
    ['edit target gone', 'Bad Request: message to edit not found'],
    ['delete target gone', 'Bad Request: message to delete not found'],
  ]

  for (const [label, description] of benign) {
    it(`logs "${label}" as status=benign, never status=err`, async () => {
      const lines = await tgPostLinesFor({ ok: false, error_code: 400, description })

      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('status=benign')
      expect(lines[0]).not.toContain('status=err')
      // Still honest about what happened — the reason is on the line.
      expect(lines[0]).toContain('code=400')
      expect(lines[0]).toContain('desc=Bad Request: message')
    })
  }
})

describe('tg-post logger — success is unchanged', () => {
  it('still logs a genuine ok:true response as status=ok with empty error fields', async () => {
    const lines = await tgPostLinesFor({
      ok: true,
      result: { message_id: 7, date: 0, chat: { id: 4242, type: 'private' } },
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('status=ok')
    expect(lines[0]).toContain('err=- code=- desc=-')
  })
})
