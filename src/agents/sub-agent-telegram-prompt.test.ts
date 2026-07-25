import { describe, expect, it } from 'vitest'
import {
  applyTelegramProgressGuidance,
  applySubAgentLocalTimeGuidance,
  buildSubAgentLocalTimeLine,
  buildTelegramProgressGuidance,
  shouldAppendTelegramProgressGuidance,
} from './sub-agent-telegram-prompt.js'

describe('shouldAppendTelegramProgressGuidance', () => {
  it('is true when telegram is enabled and a chat id is known', () => {
    expect(
      shouldAppendTelegramProgressGuidance({
        telegramEnabled: true,
        defaultChatId: '12345',
      }),
    ).toBe(true)
  })

  it('is false when telegram is disabled', () => {
    expect(
      shouldAppendTelegramProgressGuidance({
        telegramEnabled: false,
        defaultChatId: '12345',
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

  it('names the inflection points worth spending a send on', () => {
    const out = buildTelegramProgressGuidance({ defaultChatId: '1' })
    expect(out).toContain('blocker or pivot')
    expect(out).toContain('long silent stretch')
  })

  // Truthfulness guard. The pinned progress card was deleted in #1122/#1126
  // and the card-injection path in `executeProgressUpdate` went with it, but
  // this prompt kept telling every sub-agent its updates land on a card row
  // and cost the user nothing. A sub-agent that believes a send is free will
  // spam the chat (exactly the #256 regression). The guidance must describe
  // what the tool does TODAY: a real, rate-limited Telegram message.
  it('does NOT claim a pinned card or a free/no-message send', () => {
    const out = buildTelegramProgressGuidance({ defaultChatId: '1' }).toLowerCase()
    expect(out).not.toContain('pinned card')
    expect(out).not.toContain('pinned progress card')
    expect(out).not.toContain('does not send a separate telegram message')
    expect(out).not.toContain('call it freely')
  })

  it('states that it sends a real Telegram message, and its limits', () => {
    const out = buildTelegramProgressGuidance({ defaultChatId: '1' })
    expect(out.toLowerCase()).toContain('new plain telegram message')
    expect(out.toLowerCase()).toContain('sparingly')
    expect(out).toContain('20 seconds')
    expect(out).toContain('5 per turn')
    expect(out).toContain('300 chars')
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

  it('returns the body unchanged when chat id is the empty string', () => {
    const body = 'You are the worker sub-agent.'
    expect(
      applyTelegramProgressGuidance(body, {
        telegramEnabled: true,
        defaultChatId: '',
      }),
    ).toBe(body)
  })

  it('appends the guidance block when telegram is enabled and chat id is known', () => {
    const body = 'You are the worker sub-agent.'
    const out = applyTelegramProgressGuidance(body, {
      telegramEnabled: true,
      defaultChatId: '12345',
    })
    expect(out.startsWith(body)).toBe(true)
    expect(out.length).toBeGreaterThan(body.length)
    expect(out).toContain('mcp__switchroom-telegram__progress_update')
    expect(out).toContain('12345')
  })

  it('preserves the original body verbatim as a prefix of the appended output', () => {
    const body = 'You are the worker.\n\n\n  '
    const out = applyTelegramProgressGuidance(body, {
      telegramEnabled: true,
      defaultChatId: '1',
    })
    expect(out.slice(0, body.length)).toBe(body)
  })
})

// switchroom #tz-fix: sub-agents get no UserPromptSubmit local-time hook, so
// their .md carries a deterministic local-time anchor. We inject the RESOLVED
// timezone + directive (never a frozen wall-clock — the .md is written once at
// scaffold time, so a baked timestamp would read stale on every later dispatch).
describe('buildSubAgentLocalTimeLine', () => {
  it('pins the passed resolved timezone and says the clock is already local', () => {
    const out = buildSubAgentLocalTimeLine('Australia/Melbourne')
    expect(out).toContain('Australia/Melbourne')
    expect(out.toLowerCase()).toContain('local')
    // Directs the sub-agent AWAY from UTC as "now".
    expect(out).toContain('never assume or emit UTC')
  })

  it('does NOT bake a concrete wall-clock timestamp (the .md is static; would go stale)', () => {
    const out = buildSubAgentLocalTimeLine('Australia/Melbourne')
    // No baked ISO date / no baked "HH:MM AM/PM" instant — only the zone + guidance.
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(out).not.toMatch(/\d{1,2}:\d{2}\s*(?:AM|PM)/)
  })
})

describe('applySubAgentLocalTimeGuidance', () => {
  it('appends the local-time anchor unconditionally (no telegram gate)', () => {
    const body = 'You are the worker sub-agent.'
    const out = applySubAgentLocalTimeGuidance(body, 'Australia/Melbourne')
    expect(out.startsWith(body)).toBe(true)
    expect(out).toContain('Australia/Melbourne')
  })
})
