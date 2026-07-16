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

  it('mentions the inflection points (start, blocker, chunk done)', () => {
    const out = buildTelegramProgressGuidance({ defaultChatId: '1' })
    expect(out).toContain('Start of work')
    expect(out).toContain('Blocker')
    expect(out).toContain('chunk done')
  })

  it('explains that progress_update lands on the parent card, not as a separate message', () => {
    const out = buildTelegramProgressGuidance({ defaultChatId: '1' })
    expect(out.toLowerCase()).toContain('pinned')
    expect(out.toLowerCase()).toContain('card')
    expect(out.toLowerCase()).toContain('does not send a separate telegram message')
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
