/**
 * Unit tests for telegram-plugin/gateway/inbound-coalesce.ts.
 *
 * Pin the four behaviours `gateway.ts`'s legacy in-line coalescer
 * relied on, so the extraction (#553 Phase 3) is observably equivalent:
 *
 *   1. First message schedules a flush after gapMs.
 *   2. Subsequent messages reset the timer (sliding window).
 *   3. Flush invokes onFlush(key, merged) exactly once.
 *   4. gapMs <= 0 bypasses the buffer entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInboundCoalescer, inboundCoalesceKey } from '../gateway/inbound-coalesce.js'

interface Payload { text: string }

const merge = (entries: Payload[]): Payload => ({ text: entries.map((e) => e.text).join('\n') })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('inboundCoalesceKey', () => {
  it('combines chatId, threadId, and userId so distinct senders never collide', () => {
    expect(inboundCoalesceKey('c1', null, 'u1')).not.toBe(inboundCoalesceKey('c1', null, 'u2'))
    expect(inboundCoalesceKey('c1', null, 'u1')).not.toBe(inboundCoalesceKey('c2', null, 'u1'))
    expect(inboundCoalesceKey('c1', null, 'u1')).toBe(inboundCoalesceKey('c1', null, 'u1'))
  })

  it('keeps the same user\'s messages in DIFFERENT topics in distinct buckets (supergroup-mode)', () => {
    // CPO decision #9 ratified 2026-05-27: per-topic coalesce intent.
    // The 1.5s window is "user sends 3 sentences as one thought" —
    // applying it cross-topic merges genuinely separate conversations.
    expect(inboundCoalesceKey('c1', 17, 'u1')).not.toBe(inboundCoalesceKey('c1', 23, 'u1'))
    expect(inboundCoalesceKey('c1', 17, 'u1')).not.toBe(inboundCoalesceKey('c1', null, 'u1'))
  })

  it('collapses null / undefined / 0 thread IDs to the same key (chatKey convention)', () => {
    const k1 = inboundCoalesceKey('c1', null, 'u1')
    const k2 = inboundCoalesceKey('c1', undefined, 'u1')
    const k3 = inboundCoalesceKey('c1', 0, 'u1')
    expect(k1).toBe(k2)
    expect(k1).toBe(k3)
  })
})

describe('createInboundCoalescer', () => {
  it('flushes a single message after gapMs with the joined payload', () => {
    const flushed: Array<{ key: string; merged: Payload }> = []
    const c = createInboundCoalescer<Payload>({
      gapMs: 1500,
      merge,
      onFlush: (key, merged) => flushed.push({ key, merged }),
    })

    c.enqueue('c1:u1', { text: 'hi' })
    expect(c.peek('c1:u1')?.count).toBe(1)
    expect(flushed).toEqual([])

    vi.advanceTimersByTime(1499)
    expect(flushed).toEqual([])
    vi.advanceTimersByTime(1)
    expect(flushed).toEqual([{ key: 'c1:u1', merged: { text: 'hi' } }])
    expect(c.peek('c1:u1')).toBeNull()
  })

  it('resets the timer on each new message (sliding window)', () => {
    const flushed: Array<{ key: string; merged: Payload }> = []
    const c = createInboundCoalescer<Payload>({
      gapMs: 1500,
      merge,
      onFlush: (key, merged) => flushed.push({ key, merged }),
    })

    c.enqueue('c1:u1', { text: 'one' })
    vi.advanceTimersByTime(1000)         // 1s into the gap
    c.enqueue('c1:u1', { text: 'two' })  // resets the timer
    vi.advanceTimersByTime(1000)         // another 1s — still no flush
    expect(flushed).toEqual([])
    vi.advanceTimersByTime(500)          // 1.5s since "two" → flush now
    expect(flushed).toEqual([{ key: 'c1:u1', merged: { text: 'one\ntwo' } }])
  })

  it('bypasses the buffer entirely when gapMs <= 0', () => {
    const flushed: Array<{ key: string; merged: Payload }> = []
    const c = createInboundCoalescer<Payload>({
      gapMs: 0,
      merge,
      onFlush: (key, merged) => flushed.push({ key, merged }),
    })
    const r = c.enqueue('c1:u1', { text: 'hi' })
    expect(r.bypass).toBe(true)
    expect(c.peek('c1:u1')).toBeNull()
    expect(flushed).toEqual([])  // caller is responsible for flushing
  })

  it('keeps distinct keys independent', () => {
    const flushed: Array<{ key: string; merged: Payload }> = []
    const c = createInboundCoalescer<Payload>({
      gapMs: 1500,
      merge,
      onFlush: (key, merged) => flushed.push({ key, merged }),
    })
    c.enqueue('c1:u1', { text: 'A' })
    c.enqueue('c2:u2', { text: 'B' })
    expect(c.size()).toBe(2)
    vi.advanceTimersByTime(1500)
    expect(flushed.map((f) => f.key).sort()).toEqual(['c1:u1', 'c2:u2'])
  })

  it('honours a dynamic gapMs function (read per-call so config changes take effect)', () => {
    let gap = 1500
    const flushed: string[] = []
    const c = createInboundCoalescer<Payload>({
      gapMs: () => gap,
      merge,
      onFlush: (key) => flushed.push(key),
    })
    c.enqueue('c1:u1', { text: 'first' })
    vi.advanceTimersByTime(1500)
    expect(flushed).toEqual(['c1:u1'])

    // Operator dialled it down to 500ms — next message uses the new value.
    gap = 500
    c.enqueue('c1:u1', { text: 'second' })
    vi.advanceTimersByTime(500)
    expect(flushed).toEqual(['c1:u1', 'c1:u1'])
  })

  it('reset() cancels pending flushes and drops buffered entries', () => {
    const flushed: Array<{ key: string; merged: Payload }> = []
    const c = createInboundCoalescer<Payload>({
      gapMs: 1500,
      merge,
      onFlush: (key, merged) => flushed.push({ key, merged }),
    })
    c.enqueue('c1:u1', { text: 'hi' })
    c.reset()
    vi.advanceTimersByTime(5000)
    expect(flushed).toEqual([])
    expect(c.size()).toBe(0)
  })
})
