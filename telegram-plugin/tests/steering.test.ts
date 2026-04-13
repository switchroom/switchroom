/**
 * Unit tests for the pure steering helpers in ../steering.ts.
 *
 * No plugin side effects: we import straight from the module so tests
 * don't trigger server.ts's grammy startup.
 */
import { describe, test, expect } from 'vitest'
import {
  parseQueuePrefix,
  escapeXmlAttribute,
  formatPriorAssistantPreview,
  buildChannelMetaAttributes,
} from '../steering.js'

describe('parseQueuePrefix', () => {
  test('matches /queue foo', () => {
    expect(parseQueuePrefix('/queue foo')).toEqual({ queued: true, body: 'foo' })
  })

  test('matches /q foo', () => {
    expect(parseQueuePrefix('/q foo')).toEqual({ queued: true, body: 'foo' })
  })

  test('case-insensitive on keyword: /Queue, /QUEUE, /Q', () => {
    expect(parseQueuePrefix('/Queue foo')).toEqual({ queued: true, body: 'foo' })
    expect(parseQueuePrefix('/QUEUE foo')).toEqual({ queued: true, body: 'foo' })
    expect(parseQueuePrefix('/Q foo')).toEqual({ queued: true, body: 'foo' })
  })

  test('does NOT match /queued foo (keyword must be exact)', () => {
    expect(parseQueuePrefix('/queued foo')).toEqual({ queued: false, body: '/queued foo' })
  })

  test('does NOT match /queuefoo (no space after keyword)', () => {
    expect(parseQueuePrefix('/queuefoo')).toEqual({ queued: false, body: '/queuefoo' })
  })

  test('does NOT match bare /queue (no trailing space)', () => {
    // Decision: require the space so we never match a zero-body case.
    expect(parseQueuePrefix('/queue')).toEqual({ queued: false, body: '/queue' })
  })

  test('does NOT match /queue\\nfoo (separator must be a literal space)', () => {
    expect(parseQueuePrefix('/queue\nfoo')).toEqual({ queued: false, body: '/queue\nfoo' })
    expect(parseQueuePrefix('/queue\tfoo')).toEqual({ queued: false, body: '/queue\tfoo' })
  })

  test('does NOT match leading-whitespace before slash', () => {
    expect(parseQueuePrefix(' /queue foo')).toEqual({ queued: false, body: ' /queue foo' })
  })

  test('does NOT match non-leading /queue', () => {
    expect(parseQueuePrefix('hello /queue foo')).toEqual({ queued: false, body: 'hello /queue foo' })
  })

  test('strips only the first prefix; /queue /q foo yields body "/q foo"', () => {
    expect(parseQueuePrefix('/queue /q foo')).toEqual({ queued: true, body: '/q foo' })
  })

  test('trims whitespace from returned body', () => {
    expect(parseQueuePrefix('/queue    foo   ')).toEqual({ queued: true, body: 'foo' })
  })

  test('multiline body preserved after trimming', () => {
    // The leading space after `/queue` is mandatory; the REST can include
    // newlines and is trimmed at edges only, not internally.
    expect(parseQueuePrefix('/queue line one\nline two')).toEqual({
      queued: true,
      body: 'line one\nline two',
    })
  })

  test('empty string input returns unchanged', () => {
    expect(parseQueuePrefix('')).toEqual({ queued: false, body: '' })
  })

  test('/queue with just trailing space and no body matches with empty body', () => {
    // Decision: the space is mandatory; if the user typed `/queue ` with
    // nothing after it, we still flag queued=true. The server layer will
    // emit queued="true" and an empty content — the model will see an
    // empty message and reply asking for the task.
    expect(parseQueuePrefix('/queue ')).toEqual({ queued: true, body: '' })
  })
})

describe('escapeXmlAttribute', () => {
  test('escapes all 5 entities', () => {
    expect(escapeXmlAttribute(`a & b < c > d " e ' f`))
      .toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f')
  })

  test('empty string passes through', () => {
    expect(escapeXmlAttribute('')).toBe('')
  })

  test('unicode passes through unchanged', () => {
    expect(escapeXmlAttribute('hello 世界 🚀')).toBe('hello 世界 🚀')
  })

  test('already-safe string survives (double-encodes &amp; to &amp;amp; — documented)', () => {
    // Idempotency note: this is NOT idempotent on already-escaped entities
    // because & is escaped on every pass. Accepted trade-off — the caller
    // is expected to pass raw text, not pre-escaped XML.
    expect(escapeXmlAttribute('&amp;')).toBe('&amp;amp;')
  })

  test('bare safe text passes through', () => {
    expect(escapeXmlAttribute('hello world')).toBe('hello world')
  })
})

describe('formatPriorAssistantPreview', () => {
  test('passes through short plain text', () => {
    expect(formatPriorAssistantPreview('hello world')).toBe('hello world')
  })

  test('truncates over-limit text', () => {
    const long = 'a'.repeat(500)
    const out = formatPriorAssistantPreview(long, 200)
    expect(out).toHaveLength(200)
  })

  test('exact-length text passes through', () => {
    const exact = 'x'.repeat(200)
    expect(formatPriorAssistantPreview(exact, 200)).toBe(exact)
  })

  test('strips simple HTML tags', () => {
    expect(formatPriorAssistantPreview('<b>foo</b> <i>bar</i>')).toBe('foo bar')
  })

  test('collapses whitespace runs', () => {
    expect(formatPriorAssistantPreview('a\n\n\tb   c')).toBe('a b c')
  })

  test('XML-escapes after truncation', () => {
    expect(formatPriorAssistantPreview('a & b < c')).toBe('a &amp; b &lt; c')
  })

  test('does NOT decode HTML entities (documented)', () => {
    // Entities like &amp; survive as literal "&amp;" through strip and then
    // get re-escaped to &amp;amp;. Acceptable for a model-facing preview.
    expect(formatPriorAssistantPreview('a &amp; b')).toBe('a &amp;amp; b')
  })

  test('empty string returns empty', () => {
    expect(formatPriorAssistantPreview('')).toBe('')
  })

  test('custom maxChars is honored', () => {
    expect(formatPriorAssistantPreview('hello world', 5)).toBe('hello')
  })
})

describe('buildChannelMetaAttributes', () => {
  test('no flags returns empty string', () => {
    expect(buildChannelMetaAttributes({})).toBe('')
  })

  test('queued only', () => {
    expect(buildChannelMetaAttributes({ queued: true })).toBe(' queued="true"')
  })

  test('steering only', () => {
    expect(buildChannelMetaAttributes({ steering: true })).toBe(' steering="true"')
  })

  test('both queued and steering (caller is expected to enforce exclusivity)', () => {
    expect(buildChannelMetaAttributes({ queued: true, steering: true }))
      .toBe(' queued="true" steering="true"')
  })

  test('priorTurnInProgress with no seconds or preview', () => {
    expect(buildChannelMetaAttributes({ priorTurnInProgress: true }))
      .toBe(' prior_turn_in_progress="true"')
  })

  test('priorTurnInProgress with seconds', () => {
    expect(buildChannelMetaAttributes({
      priorTurnInProgress: true,
      secondsSinceTurnStart: 42,
    })).toBe(' prior_turn_in_progress="true" seconds_since_turn_start="42"')
  })

  test('priorTurnInProgress with preview', () => {
    expect(buildChannelMetaAttributes({
      priorTurnInProgress: true,
      priorAssistantPreview: 'hello',
    })).toBe(' prior_turn_in_progress="true" prior_assistant_preview="hello"')
  })

  test('all fields populated — attribute ordering is stable', () => {
    expect(buildChannelMetaAttributes({
      queued: true,
      steering: true,
      priorTurnInProgress: true,
      secondsSinceTurnStart: 3,
      priorAssistantPreview: 'foo',
    })).toBe(' queued="true" steering="true" prior_turn_in_progress="true" seconds_since_turn_start="3" prior_assistant_preview="foo"')
  })

  test('seconds omitted when priorTurnInProgress is false', () => {
    expect(buildChannelMetaAttributes({ secondsSinceTurnStart: 10 })).toBe('')
  })

  test('preview omitted when priorTurnInProgress is false', () => {
    expect(buildChannelMetaAttributes({ priorAssistantPreview: 'foo' })).toBe('')
  })

  test('empty-string preview is treated as absent', () => {
    expect(buildChannelMetaAttributes({
      priorTurnInProgress: true,
      priorAssistantPreview: '',
    })).toBe(' prior_turn_in_progress="true"')
  })

  test('seconds are floored and clamped non-negative', () => {
    expect(buildChannelMetaAttributes({
      priorTurnInProgress: true,
      secondsSinceTurnStart: 3.7,
    })).toBe(' prior_turn_in_progress="true" seconds_since_turn_start="3"')
    expect(buildChannelMetaAttributes({
      priorTurnInProgress: true,
      secondsSinceTurnStart: -5,
    })).toBe(' prior_turn_in_progress="true" seconds_since_turn_start="0"')
  })

  test('false flags are omitted, not rendered as empty', () => {
    expect(buildChannelMetaAttributes({
      queued: false,
      steering: false,
      priorTurnInProgress: false,
    })).toBe('')
  })
})
