import { describe, expect, it } from 'vitest'
import {
  applyTelegramProgressGuidance,
  buildTelegramProgressGuidance,
  shouldAppendTelegramProgressGuidance,
} from './sub-agent-telegram-prompt.js'

// shouldAppendTelegramProgressGuidance is kept for call-site compatibility
// but its result is no longer acted on by applyTelegramProgressGuidance (#256).
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

// buildTelegramProgressGuidance is deprecated but kept for compatibility.
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
  // --- Core contract: body is ALWAYS returned unchanged (#256) ---

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

  it('returns the body unchanged even when telegram + chat id are both present (#256 regression)', () => {
    // Previously this case appended the guidance block. After #256 it must NOT.
    const body = 'You are the worker sub-agent.'
    const out = applyTelegramProgressGuidance(body, {
      telegramEnabled: true,
      defaultChatId: '8248703757',
    })
    expect(out).toBe(body)
  })

  it('does not append any "Telegram visibility" content regardless of args (#256 regression)', () => {
    // Regression guard: if a future change accidentally re-enables the feature
    // this test will catch it.
    const body = 'You are the worker sub-agent.'

    const cases = [
      { telegramEnabled: true, defaultChatId: '8248703757' },
      { telegramEnabled: true, defaultChatId: '1' },
      { telegramEnabled: false, defaultChatId: '8248703757' },
      { telegramEnabled: false, defaultChatId: undefined },
    ] as const

    for (const args of cases) {
      const out = applyTelegramProgressGuidance(body, args)
      expect(out).toBe(body)
      expect(out).not.toContain('Telegram visibility')
      expect(out).not.toContain('mcp__switchroom-telegram__progress_update')
    }
  })

  it('does not mutate trailing whitespace in the body', () => {
    // Ensure the function is truly a no-op — no trimming or normalisation.
    const body = 'You are the worker.\n\n\n  '
    const out = applyTelegramProgressGuidance(body, {
      telegramEnabled: true,
      defaultChatId: '1',
    })
    expect(out).toBe(body)
  })
})
