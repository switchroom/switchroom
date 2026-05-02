/**
 * Parse-mode validation in the fake bot — opt-in via
 * `createFakeBotApi({ validateParseMode: 'lenient' })`.
 *
 * Why this matters: real Telegram returns 400 with cryptic
 * "can't parse entities" errors on unbalanced MarkdownV2 (a missing
 * `*`, an unclosed `_`, etc.). The fake accepted any string by
 * default, so production code that emits malformed markdown looked
 * fine in tests and broke in chat. This is the test surface for the
 * new lenient validator.
 *
 * Lenient ≠ a full Telegram parser. It catches the most common
 * mistake — unbalanced count of marker chars — which is what
 * streaming-update bugs (chunk break mid-emphasis) produce. A full
 * parser is bounded but tedious; lenient is the 80/20.
 */

import { describe, expect, it } from 'vitest'
import { createFakeBotApi, parseModeBalanced } from './fake-bot-api.js'

describe('parseModeBalanced — pure helper', () => {
  it('balanced text returns null', () => {
    expect(parseModeBalanced('hello world')).toBeNull()
    expect(parseModeBalanced('*bold*')).toBeNull()
    expect(parseModeBalanced('_italic_')).toBeNull()
    expect(parseModeBalanced('*bold* and _italic_')).toBeNull()
    expect(parseModeBalanced('a link [text](url)')).toBeNull()
    expect(parseModeBalanced('inline `code` ok')).toBeNull()
    expect(parseModeBalanced('```\ncode block\n```')).toBeNull()
  })

  it('flags unbalanced *', () => {
    expect(parseModeBalanced('*bold but no close')).toContain("'*'")
  })

  it('flags unbalanced _', () => {
    expect(parseModeBalanced('_italic but no close')).toContain("'_'")
  })

  it('flags unbalanced [', () => {
    expect(parseModeBalanced('a [link without close')).toContain("'['")
  })

  it('flags unbalanced backtick', () => {
    expect(parseModeBalanced('inline `unclosed code')).toContain('backtick')
  })

  it('escaped markers are exempt', () => {
    expect(parseModeBalanced('this is a literal \\* asterisk')).toBeNull()
    expect(parseModeBalanced('escaped \\_ underscore')).toBeNull()
  })

  it('content inside ``` code blocks is exempt', () => {
    expect(parseModeBalanced('```\nthis * has unbalanced markers _\n```')).toBeNull()
  })

  it('content inside `inline` code is exempt', () => {
    expect(parseModeBalanced('look at `*` and `_` markers')).toBeNull()
  })
})

describe('createFakeBotApi({ validateParseMode })', () => {
  it("default (off) accepts unbalanced MarkdownV2 (back-compat)", async () => {
    // fails when: the default of validateParseMode changes from 'off',
    // breaking the 167 existing tests that rely on permissive behavior.
    const bot = createFakeBotApi()
    await expect(
      bot.api.sendMessage('c1', '*unbalanced markdown', { parse_mode: 'MarkdownV2' }),
    ).resolves.toMatchObject({ message_id: expect.any(Number) })
  })

  it('lenient mode rejects unbalanced MarkdownV2 with a 400-shaped error', async () => {
    // fails when: the validator is turned off silently, OR the error
    // shape stops matching what robustApiCall in production looks for
    // (instanceof GrammyError with error_code 400).
    const bot = createFakeBotApi({ validateParseMode: 'lenient' })
    await expect(
      bot.api.sendMessage('c1', '*unbalanced markdown', { parse_mode: 'MarkdownV2' }),
    ).rejects.toMatchObject({ error_code: 400 })
  })

  it('lenient mode accepts well-formed MarkdownV2', async () => {
    const bot = createFakeBotApi({ validateParseMode: 'lenient' })
    await expect(
      bot.api.sendMessage('c1', '*bold* and _italic_', { parse_mode: 'MarkdownV2' }),
    ).resolves.toMatchObject({ message_id: expect.any(Number) })
  })

  it('lenient mode does NOT validate when parse_mode is HTML or absent', async () => {
    // We only validate MarkdownV2 in lenient mode — HTML has different
    // failure modes (Telegram is more forgiving) and plain-text has
    // no entities to validate.
    const bot = createFakeBotApi({ validateParseMode: 'lenient' })
    await expect(
      bot.api.sendMessage('c1', '*unbalanced markdown', { parse_mode: 'HTML' }),
    ).resolves.toBeDefined()
    await expect(
      bot.api.sendMessage('c1', '*unbalanced markdown'),
    ).resolves.toBeDefined()
  })

  it('lenient mode validates editMessageText too', async () => {
    // Streaming updates are the most common source of malformed
    // MarkdownV2 (chunk break mid-entity). Validation must fire on
    // editMessageText, not just sendMessage.
    const bot = createFakeBotApi({ validateParseMode: 'lenient' })
    const r = (await bot.api.sendMessage('c1', 'initial *ok*', { parse_mode: 'MarkdownV2' })) as {
      message_id: number
    }
    await expect(
      bot.api.editMessageText('c1', r.message_id, '*broken edit', { parse_mode: 'MarkdownV2' }),
    ).rejects.toMatchObject({ error_code: 400 })
  })
})
