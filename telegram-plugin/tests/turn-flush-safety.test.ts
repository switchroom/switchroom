/**
 * Unit coverage for the gateway-side turn-end flush safety net.
 *
 * The fix restores a deterministic "if the model produced assistant text
 * but never called reply/stream_reply, send that text to Telegram at
 * turn_end" rule, after it was silently gated off in the gateway by an
 * earlier `progressDriver == null` condition. Ken hit this live three
 * times in a row — turns ended with visible reasoning in the transcript
 * but no Telegram bubble.
 *
 * These tests pin the pure decision function. The actual send path in
 * gateway.ts is the same one used by the `reply` tool, so if this policy
 * returns `{kind: 'flush', text}` we know the message will reach the chat.
 */

import { describe, it, expect } from 'vitest'
import {
  decideTurnFlush,
  isSilentFlushMarker,
  isTurnFlushSafetyEnabled,
} from '../turn-flush-safety.js'

describe('decideTurnFlush', () => {
  it('(a) does NOT flush when the reply tool was called', () => {
    const decision = decideTurnFlush({
      chatId: '100',
      replyCalled: true,
      capturedText: ['here is the answer'],
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'reply-called' })
  })

  it('(b) flushes when the turn produced text but the reply tool was never called', () => {
    const decision = decideTurnFlush({
      chatId: '200',
      replyCalled: false,
      capturedText: ['here is the answer', 'more detail'],
    })
    expect(decision).toEqual({
      kind: 'flush',
      text: 'here is the answer\nmore detail',
    })
  })

  it('(c) HEARTBEAT_OK is a silent marker — flush suppressed', () => {
    const decision = decideTurnFlush({
      chatId: '300',
      replyCalled: false,
      capturedText: ['HEARTBEAT_OK'],
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })

  it('NO_REPLY is a silent marker — flush suppressed', () => {
    const decision = decideTurnFlush({
      chatId: '301',
      replyCalled: false,
      capturedText: ['NO_REPLY'],
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })

  it('silent markers match case-insensitively with whitespace trim', () => {
    expect(
      decideTurnFlush({
        chatId: '302',
        replyCalled: false,
        capturedText: ['  heartbeat_ok  '],
      }),
    ).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })

  it('(d) background sub-agent turn (chatId == null) is NOT flushed', () => {
    // Sub-agent turns never populate `currentSessionChatId` — we surface
    // that here as `chatId: null` and the decision must be skip.
    const decision = decideTurnFlush({
      chatId: null,
      replyCalled: false,
      capturedText: ['child agent result'],
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'no-inbound-chat' })
  })

  it('empty captured text is NOT flushed', () => {
    expect(
      decideTurnFlush({
        chatId: '400',
        replyCalled: false,
        capturedText: [],
      }),
    ).toEqual({ kind: 'skip', reason: 'empty-text' })
    expect(
      decideTurnFlush({
        chatId: '400',
        replyCalled: false,
        capturedText: ['', '   ', '\n'],
      }),
    ).toEqual({ kind: 'skip', reason: 'empty-text' })
  })

  it('feature flag off disables flush even on a legitimate orphan', () => {
    const decision = decideTurnFlush({
      chatId: '500',
      replyCalled: false,
      capturedText: ['an answer'],
      flushEnabled: false,
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'flag-disabled' })
  })

  it('flushEnabled defaults to true when omitted', () => {
    const decision = decideTurnFlush({
      chatId: '600',
      replyCalled: false,
      capturedText: ['some answer'],
    })
    expect(decision.kind).toBe('flush')
  })

  it('prioritises flag-disabled over every other skip reason', () => {
    expect(
      decideTurnFlush({
        chatId: null,
        replyCalled: true,
        capturedText: [],
        flushEnabled: false,
      }),
    ).toEqual({ kind: 'skip', reason: 'flag-disabled' })
  })

  it('prioritises reply-called over chatId/empty checks', () => {
    expect(
      decideTurnFlush({
        chatId: null,
        replyCalled: true,
        capturedText: [],
      }),
    ).toEqual({ kind: 'skip', reason: 'reply-called' })
  })
})

describe('isSilentFlushMarker', () => {
  it('recognises NO_REPLY and HEARTBEAT_OK exactly', () => {
    expect(isSilentFlushMarker('NO_REPLY')).toBe(true)
    expect(isSilentFlushMarker('HEARTBEAT_OK')).toBe(true)
    expect(isSilentFlushMarker('no_reply')).toBe(true)
    expect(isSilentFlushMarker('  HEARTBEAT_OK  ')).toBe(true)
  })

  it('does NOT match prose containing the marker', () => {
    expect(isSilentFlushMarker('the model said NO_REPLY earlier')).toBe(false)
    expect(isSilentFlushMarker('HEARTBEAT_OK; shutting down')).toBe(false)
  })

  it('does not match undefined/empty', () => {
    expect(isSilentFlushMarker(undefined)).toBe(false)
    expect(isSilentFlushMarker('')).toBe(false)
    expect(isSilentFlushMarker('   ')).toBe(false)
  })
})

describe('isTurnFlushSafetyEnabled', () => {
  it('defaults to true when the env var is absent', () => {
    expect(isTurnFlushSafetyEnabled({})).toBe(true)
  })

  it('disables on explicit false-y values', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' OFF ']) {
      expect(isTurnFlushSafetyEnabled({ SWITCHROOM_TG_TURN_FLUSH_SAFETY: v }))
        .toBe(false)
    }
  })

  it('stays enabled for anything else (including "1", "true", unknown)', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
      expect(isTurnFlushSafetyEnabled({ SWITCHROOM_TG_TURN_FLUSH_SAFETY: v }))
        .toBe(true)
    }
  })
})
