import { describe, expect, it } from 'vitest'
import {
  applyTelegramProgressGuidance,
  buildTelegramProgressGuidance,
  shouldAppendTelegramProgressGuidance,
} from './sub-agent-telegram-prompt.js'

describe('shouldAppendTelegramProgressGuidance', () => {
  it('is true when telegram is enabled and a chat id is known', () => {
    expect(
      shouldAppendTelegramProgressGuidance({
        telegramEnabled: true,
        defaultChatId: '8248703757',
      }),
    ).toBe(true)
  })

  it('is false when telegram is disabled', () => {
    expect(
      shouldAppendTelegramProgressGuidance({
        telegramEnabled: false,
        defaultChatId: '8248703757',
      }),
    ).toBe(false)
  })

  it('is false when no chat id is known', () => {
    expect(
      shouldAppendTelegramProgressGuidance({
        telegramEnabled: true,
        defaultChatId: undefined,
      }),
    ).toBe(false)
    expect(
      shouldAppendTelegramProgressGuidance({
        telegramEnabled: true,
        defaultChatId: '',
      }),
    ).toBe(false)
  })
})

describe('buildTelegramProgressGuidance', () => {
  it('embeds the chat id verbatim', () => {
    const out = buildTelegramProgressGuidance({ defaultChatId: '12345' })
    expect(out).toContain('12345')
    expect(out).toContain('mcp__switchroom-telegram__progress_update')
  })

  it('mentions the inflection points (plan, pivot, chunk done)', () => {
    const out = buildTelegramProgressGuidance({ defaultChatId: '1' })
    expect(out).toContain('Plan formed')
    expect(out).toContain('Pivot or blocker')
    expect(out).toContain('Chunk finished')
  })

  it('warns that intermediate tool output is not visible to the user', () => {
    const out = buildTelegramProgressGuidance({ defaultChatId: '1' })
    expect(out.toLowerCase()).toContain('telegram')
    expect(out.toLowerCase()).toContain('do not reach the user')
  })
})

describe('applyTelegramProgressGuidance', () => {
  it('returns the body unchanged when telegram is disabled', () => {
    const body = 'You are the worker sub-agent.'
    expect(
      applyTelegramProgressGuidance(body, {
        telegramEnabled: false,
        defaultChatId: '1',
      }),
    ).toBe(body)
  })

  it('returns the body unchanged when chat id is missing', () => {
    const body = 'You are the worker sub-agent.'
    expect(
      applyTelegramProgressGuidance(body, {
        telegramEnabled: true,
        defaultChatId: undefined,
      }),
    ).toBe(body)
  })

  it('appends the guidance block when telegram + chat id are present', () => {
    const body = 'You are the worker sub-agent.'
    const out = applyTelegramProgressGuidance(body, {
      telegramEnabled: true,
      defaultChatId: '8248703757',
    })
    expect(out).toContain(body)
    expect(out).toContain('Telegram visibility')
    expect(out).toContain('8248703757')
  })

  it('trims trailing whitespace before appending so the join is clean', () => {
    const body = 'You are the worker.\n\n\n  '
    const out = applyTelegramProgressGuidance(body, {
      telegramEnabled: true,
      defaultChatId: '1',
    })
    // No triple-blank between body and the appended block.
    expect(out).not.toMatch(/\n\n\n\n## Telegram/)
    expect(out).toMatch(/You are the worker\.\n\n## Telegram/)
  })
})
