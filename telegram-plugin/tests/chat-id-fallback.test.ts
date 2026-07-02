import { describe, expect, it } from 'vitest'

import { resolveChatIdFallback, type ChatIdAllowlist } from '../gateway/chat-id-fallback.js'

/**
 * Regression tests for the sr-* chat_id routing hotfixes that shipped
 * test-free, plus the stream_reply fallback parity fix.
 *
 * The reply / stream_reply final-answer paths call resolveChatIdFallback with a
 * String()-coerced chat_id. This suite pins the pure decision:
 *   - Bug A — numeric coercion (String() at the callsite makes 42 match "42")
 *   - Bug B — executeReply falls back to the active turn's sessionChatId
 *   - Bug D — lastActiveTurnChatId survives the silence poke (currentTurn null)
 *   - stream_reply — the SAME fallback (mirrors the executeReply Bug-D test)
 */
describe('resolveChatIdFallback', () => {
  const access = (allowFrom: string[], groups: Record<string, unknown> = {}): ChatIdAllowlist => ({
    allowFrom,
    groups,
  })

  it('allowlisted raw chat_id passes through unchanged (tier=raw)', () => {
    const r = resolveChatIdFallback('123', access(['123']), '999', '999', true)
    expect(r).toEqual({ chatId: '123', tier: 'raw' })
  })

  it('a chat_id present in groups (not allowFrom) passes through (tier=raw)', () => {
    const r = resolveChatIdFallback('-100777', access([], { '-100777': {} }), '999', '999', true)
    expect(r).toEqual({ chatId: '-100777', tier: 'raw' })
  })

  // Bug A — numeric coercion. The model passes a JSON number; the caller
  // String()-coerces before calling. A stringified numeric id matches the
  // string allowlist, so it must pass through as tier=raw (no spurious
  // fallback).
  it('Bug A: numerically-coerced chat_id ("42") matches the string allowlist', () => {
    const coerced = String(42 as unknown as number)
    const r = resolveChatIdFallback(coerced, access(['42']), '999', '999', true)
    expect(r).toEqual({ chatId: '42', tier: 'raw' })
  })

  // Bug B — executeReply fallback. Raw chat_id not allowlisted, a live turn is
  // present → route to the active turn's validated sessionChatId.
  it('Bug B: non-allowlisted raw + live turn → active turn sessionChatId', () => {
    const r = resolveChatIdFallback('wrong-id', access(['123']), '123', '123', true)
    expect(r).toEqual({ chatId: '123', tier: 'active' })
  })

  // Bug D — lastActiveTurnChatId survives the silence poke. currentTurn is null
  // (turnSessionChatId undefined, hasLiveTurn false) because clearTurnStarted
  // fired after ≥5 min silence, but the model finally replied after the poke.
  // The last-known chat still routes the answer.
  it('Bug D: no live turn (silence poke) → last-known turn chat', () => {
    const r = resolveChatIdFallback('wrong-id', access(['123']), undefined, '123', false)
    expect(r).toEqual({ chatId: '123', tier: 'last-known' })
  })

  // stream_reply Bug-D mirror: stream_reply is the primary final-answer path
  // and now applies the SAME fallback. Identical inputs → identical decision.
  it('stream_reply parity: same fallback after a silence poke (mirrors Bug D)', () => {
    const r = resolveChatIdFallback('wrong-id', access(['555']), undefined, '555', false)
    expect(r).toEqual({ chatId: '555', tier: 'last-known' })
  })

  it('no valid fallback → returns raw so assertAllowedChat throws the human error', () => {
    const r = resolveChatIdFallback('wrong-id', access(['123']), 'also-wrong', 'still-wrong', true)
    expect(r).toEqual({ chatId: 'wrong-id', tier: 'raw' })
  })

  it('active tier wins over last-known when both are set (turn present)', () => {
    const r = resolveChatIdFallback('wrong-id', access(['active-chat', 'old-chat']), 'active-chat', 'old-chat', true)
    expect(r).toEqual({ chatId: 'active-chat', tier: 'active' })
  })
})
