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
  isCompositeSilentNoise,
  endsWithSilentMarker,
  isTurnFlushSafetyEnabled,
} from '../turn-flush-safety.js'

describe('isCompositeSilentNoise — Stop-hook re-prompt leak backstop', () => {
  it('suppresses the observed leak "Sent.\\nNO_REPLY\\nNO_REPLY"', () => {
    expect(isCompositeSilentNoise('Sent.\nNO_REPLY\nNO_REPLY')).toBe(true)
  })
  it('suppresses repeated bare markers and marker+confirmation variants', () => {
    expect(isCompositeSilentNoise('NO_REPLY\nNO_REPLY')).toBe(true)
    expect(isCompositeSilentNoise('Done\nNO_REPLY')).toBe(true)
    expect(isCompositeSilentNoise('NO_REPLY\nHEARTBEAT_OK')).toBe(true)
  })
  it('requires at least one real marker — standalone confirmations still flush', () => {
    // Conservative: no NO_REPLY/HEARTBEAT_OK present → NOT suppressed here,
    // so we never silently drop a turn that wasn\'t already signalling silence.
    expect(isCompositeSilentNoise('Sent.')).toBe(false)
    expect(isCompositeSilentNoise('Done.\nOK')).toBe(false)
  })
  it('does NOT suppress real content glued to a marker', () => {
    expect(
      isCompositeSilentNoise('Here is the summary of the page.\nNO_REPLY'),
    ).toBe(false)
    expect(isCompositeSilentNoise('NO_REPLY\nThe answer is 42.')).toBe(false)
  })
  it('handles non-strings / empty safely', () => {
    expect(isCompositeSilentNoise(undefined)).toBe(false)
    expect(isCompositeSilentNoise('')).toBe(false)
    expect(isCompositeSilentNoise('   \n  ')).toBe(false)
  })
})

describe('decideTurnFlush — composite silent noise is skipped, not leaked', () => {
  it('skips "Sent.\\nNO_REPLY\\nNO_REPLY" (the live clerk/test-harness leak)', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['Sent.', 'NO_REPLY', 'NO_REPLY'],
    })
    expect(d).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })
  it('still flushes genuine trailing answer text', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['The page summarises three news stories.'],
    })
    expect(d.kind).toBe('flush')
  })
})

describe('endsWithSilentMarker — prose+trailing-sentinel recognition (#2053)', () => {
  it('recognises prose followed by a trailing bare NO_REPLY line', () => {
    expect(endsWithSilentMarker('Nothing actionable in the digest.\nNO_REPLY')).toBe(true)
    expect(endsWithSilentMarker('Build is green.\nHEARTBEAT_OK')).toBe(true)
  })
  it('tolerates a single trailing punctuation on the marker', () => {
    expect(endsWithSilentMarker('done.\nNO_REPLY.')).toBe(true)
  })
  it('does NOT match when real content follows the marker', () => {
    expect(endsWithSilentMarker('NO_REPLY\nThe answer is 42.')).toBe(false)
  })
  it('does NOT match a marker mentioned inside genuine prose', () => {
    expect(endsWithSilentMarker('reply with exactly NO_REPLY when nothing to add')).toBe(false)
  })
  it('handles non-strings / empty safely', () => {
    expect(endsWithSilentMarker(undefined)).toBe(false)
    expect(endsWithSilentMarker('')).toBe(false)
    expect(endsWithSilentMarker('  \n  ')).toBe(false)
  })
})

describe('decideTurnFlush — prose+trailing-sentinel is suppressed, not leaked (#2053)', () => {
  it('skips a cron-style "prose\\nNO_REPLY" blob (the #2053 leak)', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['Reviewed the overnight digest — nothing needs your attention.', 'NO_REPLY'],
    })
    expect(d).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })
  it('still flushes a real answer whose last line is NOT a sentinel', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['Here is the summary.', 'Three stories, all low priority.'],
    })
    expect(d.kind).toBe('flush')
  })
})

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

  // The turn-flush safety net covers exactly one failure mode: a turn that
  // ended with the model never having said anything. Once the model has
  // called reply / stream_reply the turn is served — any assistant text it
  // emits afterwards is its own end-of-turn wrap-up (a closing summary,
  // narration to itself), NOT a message it chose to send. The framework
  // must never promote that terminal text into a second Telegram bubble.
  //
  // Regression guard for the redundant-follow-up-message fix: this reverts
  // the #1291 post-reply-tail flush, which posted a duplicate recap on
  // essentially every turn because the model habitually writes a closing
  // summary after its final reply. See reference/conversational-pacing.md
  // — "the framework owns the beat; the model authors the words".
  describe('reply-called turns never flush trailing terminal text', () => {
    it('skips even when a long substantive tail follows the reply', () => {
      const decision = decideTurnFlush({
        chatId: '700',
        replyCalled: true,
        capturedText: [
          'thinking out loud before the reply',
          'Answered the Playwright question and acked the calendar ' +
            'diagnosis is still in flight. Will surface the root cause ' +
            'when the worker returns.',
        ],
      })
      expect(decision).toEqual({ kind: 'skip', reason: 'reply-called' })
    })

    it('skips regardless of how many text blocks trail the reply', () => {
      const decision = decideTurnFlush({
        chatId: '701',
        replyCalled: true,
        capturedText: [
          'a substantive paragraph the model wrote as terminal text',
          'and another one, each well over any old length threshold',
          'and a third closing summary block for good measure',
        ],
      })
      expect(decision).toEqual({ kind: 'skip', reason: 'reply-called' })
    })

    it('skips with reply-called when capturedText is empty', () => {
      const decision = decideTurnFlush({
        chatId: '702',
        replyCalled: true,
        capturedText: [],
      })
      expect(decision).toEqual({ kind: 'skip', reason: 'reply-called' })
    })

    it('feature flag off still wins over a reply-called turn', () => {
      const decision = decideTurnFlush({
        chatId: '703',
        replyCalled: true,
        capturedText: ['a long substantive tail that pre-fix would flush'],
        flushEnabled: false,
      })
      expect(decision).toEqual({ kind: 'skip', reason: 'flag-disabled' })
    })
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

  it('tolerates a single trailing non-word character (#299 review feedback)', () => {
    expect(isSilentFlushMarker('NO_REPLY.')).toBe(true)
    expect(isSilentFlushMarker('NO_REPLY!')).toBe(true)
    expect(isSilentFlushMarker('HEARTBEAT_OK,')).toBe(true)
    expect(isSilentFlushMarker('  HEARTBEAT_OK.  ')).toBe(true)
    // Two trailing punctuation chars → not stripped, no match
    expect(isSilentFlushMarker('NO_REPLY!!')).toBe(false)
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
