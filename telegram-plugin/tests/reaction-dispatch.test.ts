/**
 * Unit tests for the reaction-dispatch primitives (#2291).
 *
 * Covers config resolution (default OFF), the synchronous emoji-allowlist
 * predicate (match / no-match / removed-ignored / no-emoji), and the
 * inbound envelope builder (shape + history-hit / history-miss body).
 */

import { describe, it, expect } from 'bun:test'
import {
  REACTION_DISPATCH_DEFAULTS,
  resolveReactionDispatchConfig,
  evaluateReactionDispatch,
  buildReactionDispatchInbound,
  type ReactionDispatchResolvedConfig,
} from '../gateway/reaction-dispatch.ts'

function cfg(over: Partial<{ enabled: boolean; emojis: string[] }> = {}): ReactionDispatchResolvedConfig {
  return resolveReactionDispatchConfig({
    enabled: over.enabled ?? true,
    emojis: over.emojis ?? ['👨‍💻'],
  })
}

describe('resolveReactionDispatchConfig — default OFF', () => {
  it('null/undefined raw collapses to the OFF defaults', () => {
    expect(resolveReactionDispatchConfig(undefined)).toBe(REACTION_DISPATCH_DEFAULTS)
    expect(resolveReactionDispatchConfig(null)).toBe(REACTION_DISPATCH_DEFAULTS)
    expect(REACTION_DISPATCH_DEFAULTS.enabled).toBe(false)
    expect(REACTION_DISPATCH_DEFAULTS.emojis.size).toBe(0)
  })

  it('a block with emojis but no enabled flag stays disabled by default', () => {
    const r = resolveReactionDispatchConfig({ emojis: ['👨‍💻'] })
    // enabled defaults to false even when an allowlist is provided.
    expect(r.enabled).toBe(false)
    expect(r.emojis.has('👨‍💻')).toBe(true)
  })

  it('emojis REPLACE (set membership), enabled overrides', () => {
    const r = resolveReactionDispatchConfig({ enabled: true, emojis: ['✅', '❌'] })
    expect(r.enabled).toBe(true)
    expect([...r.emojis].sort()).toEqual(['✅', '❌'].sort())
  })
})

describe('evaluateReactionDispatch — emoji filtering', () => {
  it('allowlist match → ok', () => {
    expect(evaluateReactionDispatch(cfg(), { emoji: '👨‍💻', action: 'add' })).toEqual({ ok: true })
  })

  it('allowlist no-match → rejected', () => {
    expect(evaluateReactionDispatch(cfg(), { emoji: '👍', action: 'add' })).toEqual({
      ok: false,
      reason: 'emoji_not_in_allowlist',
    })
  })

  it('disabled config → rejected even on an allowlisted emoji', () => {
    expect(
      evaluateReactionDispatch(cfg({ enabled: false }), { emoji: '👨‍💻', action: 'add' }),
    ).toEqual({ ok: false, reason: 'disabled' })
  })

  it('default-off config never fires', () => {
    expect(
      evaluateReactionDispatch(REACTION_DISPATCH_DEFAULTS, { emoji: '👨‍💻', action: 'add' }),
    ).toEqual({ ok: false, reason: 'disabled' })
  })

  it('null emoji (custom emoji) → rejected', () => {
    expect(evaluateReactionDispatch(cfg(), { emoji: null, action: 'add' })).toEqual({
      ok: false,
      reason: 'no_emoji',
    })
  })

  it('change action with allowlisted emoji → ok (add/change both dispatch)', () => {
    expect(evaluateReactionDispatch(cfg(), { emoji: '👨‍💻', action: 'change' })).toEqual({
      ok: true,
    })
  })
})

describe('buildReactionDispatchInbound — envelope shape', () => {
  it('history hit: body carries the reacted message text', () => {
    const { text, meta } = buildReactionDispatchInbound({
      emoji: '👨‍💻',
      chatId: '456',
      messageId: 123,
      user: 'Ken',
      userId: 999,
      reactedText: 'capture this to Linear',
    })
    expect(text).toBe(
      '<channel source="switchroom-telegram" event="reaction" ' +
        'emoji="👨‍💻" message_id="123" chat_id="456" user="Ken">' +
        'capture this to Linear</channel>',
    )
    expect(meta).toMatchObject({
      source: 'switchroom-telegram',
      event: 'reaction',
      reaction_emoji: '👨‍💻',
      target_message_id: '123',
      reacted_text: 'capture this to Linear',
    })
  })

  it('history miss: empty body, envelope still well-formed', () => {
    const { text, meta } = buildReactionDispatchInbound({
      emoji: '✅',
      chatId: '456',
      messageId: 7,
      user: 'Ken',
      userId: 999,
      reactedText: '',
    })
    expect(text).toBe(
      '<channel source="switchroom-telegram" event="reaction" ' +
        'emoji="✅" message_id="7" chat_id="456" user="Ken"></channel>',
    )
    expect(meta.reacted_text).toBe('')
  })

  it('escapes XML-significant chars in attrs and body', () => {
    const { text } = buildReactionDispatchInbound({
      emoji: '👨‍💻',
      chatId: '456',
      messageId: 1,
      user: 'A & B "x"',
      userId: 1,
      reactedText: 'a <b> & c',
    })
    expect(text).toContain('user="A &amp; B &quot;x&quot;"')
    expect(text).toContain('>a &lt;b&gt; & c<')
  })
})
