/**
 * Wire-level outcome tests for the universal accidental-formatting guard
 * (`installRichMarkdownGuard`, #3252/#3463 follow-up).
 *
 * These MUST go through a REAL grammy `Bot` with a stubbed transport. The
 * existing unit/golden harnesses (`tests/bot-api.harness.ts` etc.) mock the
 * `api` object ABOVE the grammy transformer layer, so `api.config.use`
 * transformers never run there — a test written through them is a FALSE guard
 * (it stays green with the transformer absent or mis-gated). By stubbing
 * `client.fetch` we capture the exact serialized wire body AFTER the
 * transformer has mutated the raw payload, which is the only place the guard's
 * effect is observable.
 *
 * Red-team F-R1: the markdown lives at `payload.rich_message.markdown`, NOT
 * `payload.markdown`. A guard gating on the latter matches nothing and every
 * one of these assertions would still fail — so these tests pin the correct
 * field shape too.
 */
import { describe, it, expect } from 'vitest'
import { Bot } from 'grammy'
import { installTgPostLogger, installRichMarkdownGuard } from '../shared/bot-runtime.js'

interface CapturedCall {
  method: string
  body: Record<string, unknown>
}

/**
 * Build a real grammy Bot whose transport is stubbed: every API call is
 * captured (method + parsed JSON body) and answered with a minimal ok
 * response. `botInfo` is supplied so `bot.init()` never hits the network.
 */
function makeCapturingBot(): { bot: Bot; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const fakeFetch = (async (url: unknown, init?: { body?: unknown }) => {
    const method = String(url).split('/').pop() ?? ''
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body) as Record<string, unknown>
    }
    calls.push({ method, body })
    // Minimal Telegram ok envelope. `result` shape doesn't matter for these
    // send/edit calls — grammy only reads `ok`/`result`.
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } }),
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
  // Install exactly the production transformer stack ordering: logger first,
  // then guard (guard composes outermost — grammy runs last-installed first).
  installTgPostLogger(bot)
  installRichMarkdownGuard(bot)
  return { bot, calls }
}

function lastRichMarkdown(calls: CapturedCall[]): unknown {
  const c = calls[calls.length - 1]
  return (c.body.rich_message as { markdown?: unknown } | undefined)?.markdown
}

describe('installRichMarkdownGuard — universal wire seam', () => {
  it('(a) escapes a raw { markdown } sendRichMessage on the wire', async () => {
    const { bot, calls } = makeCapturingBot()
    await bot.api.sendRichMessage(1, { markdown: '#3460 done' })
    expect(calls[calls.length - 1].method).toBe('sendRichMessage')
    expect(lastRichMarkdown(calls)).toBe('\\#3460 done')
  })

  it('(b) escapes an editMessageText object-arg { markdown } on the wire', async () => {
    const { bot, calls } = makeCapturingBot()
    await bot.api.editMessageText(1, 42, { markdown: '#3460 done' })
    expect(calls[calls.length - 1].method).toBe('editMessageText')
    expect(lastRichMarkdown(calls)).toBe('\\#3460 done')
  })

  it('(c) leaves a literalText / string-arg edit UNTOUCHED (carries text, not rich_message)', async () => {
    const { bot, calls } = makeCapturingBot()
    await bot.api.editMessageText(1, 42, '#3460 done')
    const c = calls[calls.length - 1]
    expect(c.method).toBe('editMessageText')
    expect(c.body.text).toBe('#3460 done')
    expect(c.body.rich_message).toBeUndefined()
  })

  it('(d) leaves a genuine heading byte-identical', async () => {
    const { bot, calls } = makeCapturingBot()
    await bot.api.sendRichMessage(1, { markdown: '# Title\n## Sub' })
    expect(lastRichMarkdown(calls)).toBe('# Title\n## Sub')
  })

  it('(e) is idempotent on an already-guarded (richMessage-wrapped) body', async () => {
    const { bot, calls } = makeCapturingBot()
    // Simulate a body that already went through richMessage()'s internal guard.
    await bot.api.sendRichMessage(1, { markdown: '\\#3460 done' })
    expect(lastRichMarkdown(calls)).toBe('\\#3460 done')
  })

  it('does not mutate the caller\'s shared input object', async () => {
    const { bot } = makeCapturingBot()
    const input = { markdown: '#3460 done' }
    await bot.api.sendRichMessage(1, input)
    // Caller's object is unchanged; only the cloned wire payload is escaped.
    expect(input.markdown).toBe('#3460 done')
  })
})
