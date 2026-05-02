/**
 * Tests for the outbound dedup cache (#546).
 *
 * The bug pattern we're defending against:
 *   - turn-flush sends a long reply rendered as HTML (`<b>foo</b>`).
 *   - 9-11 seconds later, the agent's reply tool retries (after a
 *     bridge reconnect) and ships the SAME content as raw markdown
 *     (`**foo**`).
 *   - User sees both. Trust leaks.
 *
 * The cache normalises both forms to the same key so `record(html)`
 * is detected when `check(markdown)` arrives, and vice versa.
 */

import { describe, it, expect } from 'bun:test'
import {
  OutboundDedupCache,
  normalizeForDedup,
  DEFAULT_DEDUP_TTL_MS,
  DEDUP_MIN_CONTENT_LEN,
} from '../recent-outbound-dedup.js'

const LONG_HTML = '<b>Heads up</b> — those blockers are now in <code>main</code>: rotate the password, fix the pipeline, verify env vars.'
const LONG_MARKDOWN = '**Heads up** — those blockers are now in `main`: rotate the password, fix the pipeline, verify env vars.'
const LONG_PLAIN = 'Heads up — those blockers are now in main: rotate the password, fix the pipeline, verify env vars.'

describe('normalizeForDedup', () => {
  it('hashes HTML and markdown forms of the same content equally', () => {
    expect(normalizeForDedup(LONG_HTML)).toBe(normalizeForDedup(LONG_MARKDOWN))
  })

  it('hashes plain-text form equally too (no markup at all)', () => {
    expect(normalizeForDedup(LONG_HTML)).toBe(normalizeForDedup(LONG_PLAIN))
  })

  it('strips HTML tags including attributes', () => {
    const r = normalizeForDedup('<a href="https://x">link</a>')
    expect(r).toBe('link')
  })

  it('strips markdown bold / italic / code markers', () => {
    expect(normalizeForDedup('**bold**')).toBe('bold')
    expect(normalizeForDedup('__bold__')).toBe('bold')
    expect(normalizeForDedup('`code`')).toBe('code')
  })

  it('strips line-leading markdown markers', () => {
    expect(normalizeForDedup('# heading\n- item\n> quote')).toBe('heading item quote')
  })

  it('collapses whitespace + lowercases for comparison', () => {
    expect(normalizeForDedup('  Foo   Bar\n\n\nBaz  ')).toBe('foo bar baz')
  })

  it('expands HTML entities to spaces (defensive)', () => {
    // The renderer emits &gt; for >; both forms should hash equally.
    expect(normalizeForDedup('a &gt; b')).toBe('a   b'.replace(/\s+/g, ' ').trim())
  })

  it('different content produces different hashes', () => {
    expect(normalizeForDedup('hello world')).not.toBe(normalizeForDedup('hello there'))
  })
})

describe('OutboundDedupCache — happy path', () => {
  it('records and detects same content within TTL', () => {
    const cache = new OutboundDedupCache()
    cache.record('123', undefined, LONG_HTML, 1000)
    const r = cache.check('123', undefined, LONG_MARKDOWN, 5000)
    expect(r).not.toBeNull()
    expect(r!.matched).toBe(true)
    expect(r!.ageMs).toBe(4000)
    expect(r!.preview).toContain('Heads up')
  })

  it('returns null on cache miss', () => {
    const cache = new OutboundDedupCache()
    cache.record('123', undefined, LONG_HTML, 1000)
    const r = cache.check('123', undefined, 'completely different content here', 2000)
    expect(r).toBeNull()
  })

  it('matches across HTML / markdown / plain renderings (the actual bug)', () => {
    const cache = new OutboundDedupCache()
    cache.record('chat', undefined, LONG_HTML, 1000)
    expect(cache.check('chat', undefined, LONG_MARKDOWN, 1500)).not.toBeNull()
    expect(cache.check('chat', undefined, LONG_PLAIN, 1500)).not.toBeNull()
  })
})

describe('OutboundDedupCache — TTL expiry', () => {
  it('does not match an entry past TTL', () => {
    const cache = new OutboundDedupCache({ ttlMs: 5000 })
    cache.record('123', undefined, LONG_HTML, 1000)
    // 6s later → past 5s TTL
    expect(cache.check('123', undefined, LONG_MARKDOWN, 7000)).toBeNull()
  })

  it('uses default TTL of 60s when none provided', () => {
    const cache = new OutboundDedupCache()
    cache.record('123', undefined, LONG_HTML, 0)
    expect(cache.check('123', undefined, LONG_HTML, DEFAULT_DEDUP_TTL_MS - 1)).not.toBeNull()
    expect(cache.check('123', undefined, LONG_HTML, DEFAULT_DEDUP_TTL_MS + 1)).toBeNull()
  })

  it('evicts old entries on subsequent operations', () => {
    const cache = new OutboundDedupCache({ ttlMs: 5000 })
    cache.record('chat', undefined, LONG_HTML, 1000)
    expect(cache.size(2000)).toBe(1)
    expect(cache.size(10000)).toBe(0) // past TTL → evicted
  })
})

describe('OutboundDedupCache — chat / thread isolation', () => {
  it('does not match across different chat ids', () => {
    const cache = new OutboundDedupCache()
    cache.record('chat-A', undefined, LONG_HTML, 1000)
    expect(cache.check('chat-B', undefined, LONG_HTML, 2000)).toBeNull()
  })

  it('does not match across different thread ids in the same chat', () => {
    const cache = new OutboundDedupCache()
    cache.record('chat', 1, LONG_HTML, 1000)
    expect(cache.check('chat', 2, LONG_HTML, 2000)).toBeNull()
  })

  it('matches when threadId is undefined on both record + check', () => {
    const cache = new OutboundDedupCache()
    cache.record('chat', undefined, LONG_HTML, 1000)
    expect(cache.check('chat', undefined, LONG_HTML, 2000)).not.toBeNull()
  })

  it('does NOT match record(undefined) against check(0) — distinct keys', () => {
    // 0 is a valid threadId in some Telegram APIs; treat as distinct
    // from undefined to avoid false positives.
    const cache = new OutboundDedupCache()
    cache.record('chat', undefined, LONG_HTML, 1000)
    expect(cache.check('chat', 0, LONG_HTML, 2000)).toBeNull()
  })
})

describe('OutboundDedupCache — short content is not deduped', () => {
  it(`ignores content under ${DEDUP_MIN_CONTENT_LEN} chars on record`, () => {
    const cache = new OutboundDedupCache()
    cache.record('chat', undefined, 'short reply', 1000)
    expect(cache.size(1500)).toBe(0)
  })

  it(`ignores short content on check (returns null even if hash would match)`, () => {
    const cache = new OutboundDedupCache()
    // Force-record by accessing internals would be a hack — instead, prove
    // the check side filters too. Record a long entry; check a SHORT
    // canonicalised query against it. Different lengths → different hashes
    // anyway, so this test mostly documents the intent.
    cache.record('chat', undefined, LONG_HTML, 1000)
    expect(cache.check('chat', undefined, 'ok', 2000)).toBeNull()
  })

  it('legitimate short repeats do not get suppressed', () => {
    // "ok" / "got it" / "✅ Done" are common in normal multi-turn
    // conversation. Deduping them would suppress legitimate replies.
    // Same reasoning as DEDUP_MIN_CONTENT_LEN's docstring.
    const cache = new OutboundDedupCache()
    cache.record('chat', undefined, 'ok', 1000)
    cache.record('chat', undefined, 'ok', 5000)
    cache.record('chat', undefined, 'ok', 9000)
    expect(cache.size(10_000)).toBe(0) // none recorded
    expect(cache.check('chat', undefined, 'ok', 10_000)).toBeNull()
  })
})

describe('OutboundDedupCache — multiple entries per chat', () => {
  it('matches the first hash that fits, even if more recent entries exist', () => {
    const cache = new OutboundDedupCache()
    const A = 'first long reply with enough characters to count as content'
    const B = 'second long reply with enough characters to count as content too'
    cache.record('chat', undefined, A, 1000)
    cache.record('chat', undefined, B, 5000)
    expect(cache.check('chat', undefined, A, 6000)).not.toBeNull()
    expect(cache.check('chat', undefined, B, 6000)).not.toBeNull()
  })

  it('evicted entries no longer match', () => {
    const cache = new OutboundDedupCache({ ttlMs: 3000 })
    cache.record('chat', undefined, LONG_HTML, 1000)
    // Wait past TTL.
    expect(cache.check('chat', undefined, LONG_HTML, 5000)).toBeNull()
    // Re-record after eviction; check works again.
    cache.record('chat', undefined, LONG_HTML, 5000)
    expect(cache.check('chat', undefined, LONG_HTML, 6000)).not.toBeNull()
  })
})
