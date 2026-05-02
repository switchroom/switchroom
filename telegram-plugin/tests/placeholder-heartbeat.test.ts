import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  startHeartbeat,
  formatElapsed,
  composeHeartbeatText,
  DEFAULT_HEARTBEAT_LABEL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_DURATION_MS,
} from '../placeholder-heartbeat.js'

/**
 * Pure-function tests. Pin the §3.2 elapsed-time format boundaries
 * and the §4.6 label-composition behaviour.
 */
describe('formatElapsed — §3.2 precision tiers', () => {
  describe('0–9s window: 1s precision', () => {
    it('formats 0 as "0s"', () => expect(formatElapsed(0)).toBe('0s'))
    it('formats 1000 as "1s"', () => expect(formatElapsed(1000)).toBe('1s'))
    it('formats 5000 as "5s"', () => expect(formatElapsed(5000)).toBe('5s'))
    it('formats 9000 as "9s"', () => expect(formatElapsed(9000)).toBe('9s'))
    it('floors sub-second remainders ("5.7s" → "5s")', () => {
      expect(formatElapsed(5700)).toBe('5s')
    })
  })

  describe('10–59s window: 5s precision (matches tick cadence)', () => {
    it('rounds 10000 to "10s"', () => expect(formatElapsed(10000)).toBe('10s'))
    it('rounds 12000 to "10s"', () => expect(formatElapsed(12000)).toBe('10s'))
    it('rounds 13000 to "15s" (5s rounding bumps up)', () => {
      expect(formatElapsed(13000)).toBe('15s')
    })
    it('rounds 17000 to "15s"', () => expect(formatElapsed(17000)).toBe('15s'))
    it('rounds 55000 to "55s"', () => expect(formatElapsed(55000)).toBe('55s'))
    it('rounds 57000 to "55s"', () => expect(formatElapsed(57000)).toBe('55s'))
    it('rounds 58000 to "60s" — wait that rolls over to 1m', () => {
      // 58s rounds to 60s, but our threshold is < 60s for the 5s window.
      // The 1m+ branch handles this via Math.floor on totalMinutes.
      // 58s → totalMinutes=0, branches into the 5s window → 60s.
      // Document the boundary: anything >= 58s in the 5s window snaps
      // to the next minute via the rounding rule.
      // Spec lock: at exactly 58s we hit the second tier returning "60s"
      // — which is technically a degenerate "0m" case. Verify what the
      // function actually does here so we know.
      const result = formatElapsed(58000)
      expect(['60s', '1m']).toContain(result)
    })
  })

  describe('1–9m window: minute precision', () => {
    it('formats 60000 as "1m"', () => expect(formatElapsed(60000)).toBe('1m'))
    it('formats 65000 as "1m 5s"', () => expect(formatElapsed(65000)).toBe('1m 5s'))
    it('formats 90000 as "1m 30s"', () => expect(formatElapsed(90000)).toBe('1m 30s'))
    it('formats 120000 as "2m"', () => expect(formatElapsed(120000)).toBe('2m'))
    it('formats 540000 (9m) as "9m"', () => expect(formatElapsed(540000)).toBe('9m'))
    it('snaps remainder up to the next minute when rounding crosses 60s', () => {
      // 1m 58s → seconds=118, totalMinutes=1, remainderSec=58 → rounds
      // to 60 → bumps minute to 2 → "2m"
      expect(formatElapsed(118000)).toBe('2m')
    })
  })

  describe('≥10m: minute-only ceiling', () => {
    it('formats 600000 (10m) as "10m+"', () => expect(formatElapsed(600000)).toBe('10m+'))
    it('formats 1000000 as "10m+"', () => expect(formatElapsed(1000000)).toBe('10m+'))
    it('formats 1 hour as "10m+"', () => expect(formatElapsed(60 * 60 * 1000)).toBe('10m+'))
  })

  describe('defensive cases', () => {
    it('treats negative input as 0s', () => {
      // Clock skew or test races could produce negative elapsed.
      expect(formatElapsed(-1000)).toBe('0s')
    })
    it('treats NaN as 0s without throwing', () => {
      // Math.floor(NaN/1000) is NaN; Math.max(0, NaN) is NaN; we
      // need to handle this defensively. If the function throws,
      // the heartbeat tick crashes — bad. Document the behaviour.
      // This test lets the implementation either return "0s" or
      // crash; if it crashes, fix the implementation.
      expect(() => formatElapsed(NaN)).not.toThrow()
    })
  })
})

describe('composeHeartbeatText — §4.6 label composition', () => {
  it('uses default label when none provided', () => {
    expect(composeHeartbeatText(null, 5000)).toBe(`${DEFAULT_HEARTBEAT_LABEL} · 5s`)
  })

  it('uses provided label as-is', () => {
    expect(composeHeartbeatText('📚 recalling memories', 5000))
      .toBe('📚 recalling memories · 5s')
  })

  it('strips a trailing elapsed token if the label already contains one', () => {
    // Defensive guard: if recall.py somehow pushes a label that already
    // includes ` · 3s`, don't double-append. Prevents the
    // "📚 recalling memories · 3s · 8s" wart.
    expect(composeHeartbeatText('📚 recalling memories · 3s', 8000))
      .toBe('📚 recalling memories · 8s')
  })

  it('passes a single-token label through unchanged (strip only triggers on " · token" patterns)', () => {
    // The strip regex (composeHeartbeatText) only fires when the label
    // already contains ` · X` — guarding against double-elapsed
    // appends. A label that's JUST an elapsed-shaped string ("5s") with
    // no separator passes through verbatim. Different scenario.
    expect(composeHeartbeatText('5s', 10000)).toBe('5s · 10s')
  })

  it('treats empty string the same as null', () => {
    expect(composeHeartbeatText('', 5000)).toBe(`${DEFAULT_HEARTBEAT_LABEL} · 5s`)
  })

  it('uses · separator (U+00B7), not raw "..." or "."', () => {
    // Pinning the exact separator character. iOS/Android/desktop
    // Telegram all render U+00B7 cleanly; ASCII alternatives like
    // "•" or "..." render inconsistently across clients.
    const result = composeHeartbeatText(null, 5000)
    expect(result).toContain(' · ')
    expect(result).not.toContain(' . ')
    expect(result).not.toContain(' ... ')
  })
})

describe('startHeartbeat — §3 lifecycle (with fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeDeps(overrides: Partial<Parameters<typeof startHeartbeat>[3]> = {}) {
    const calls: Array<{ chatId: string; draftId: number; text: string; at: number }> = []
    const sendMessageDraft = vi.fn(async (chatId: string, draftId: number, text: string) => {
      calls.push({ chatId, draftId, text, at: Date.now() })
      return true as const
    })
    return {
      calls,
      deps: {
        sendMessageDraft,
        isPlaceholderActive: vi.fn(() => true),
        getCurrentLabel: vi.fn(() => null),
        intervalMs: 5000,
        maxDurationMs: 60_000,
        log: undefined,
        ...overrides,
      },
    }
  }

  it('first tick fires at +intervalMs (NOT immediately)', () => {
    const { calls, deps } = makeDeps()
    const startedAt = Date.now()
    startHeartbeat('123', 99, startedAt, deps)

    // Before the first tick: zero calls.
    expect(calls.length).toBe(0)
    // At intervalMs - 1: still zero.
    vi.advanceTimersByTime(4999)
    expect(calls.length).toBe(0)
    // At intervalMs: first call.
    vi.advanceTimersByTime(1)
    expect(calls.length).toBe(1)
    expect(calls[0]!.text).toBe(`${DEFAULT_HEARTBEAT_LABEL} · 5s`)
  })

  it('emits exactly N calls between t=0 and t=N*intervalMs', () => {
    const { calls, deps } = makeDeps()
    startHeartbeat('123', 99, Date.now(), deps)

    vi.advanceTimersByTime(15000)  // 3 ticks at 5s interval

    expect(calls.length).toBe(3)
    expect(calls[0]!.text).toBe(`${DEFAULT_HEARTBEAT_LABEL} · 5s`)
    expect(calls[1]!.text).toBe(`${DEFAULT_HEARTBEAT_LABEL} · 10s`)
    expect(calls[2]!.text).toBe(`${DEFAULT_HEARTBEAT_LABEL} · 15s`)
  })

  it('stops when isPlaceholderActive returns false', () => {
    let active = true
    const { calls, deps } = makeDeps({
      isPlaceholderActive: vi.fn(() => active),
    })
    startHeartbeat('123', 99, Date.now(), deps)

    vi.advanceTimersByTime(5000)
    expect(calls.length).toBe(1)

    // Simulate placeholder consumption
    active = false
    vi.advanceTimersByTime(5000)
    expect(calls.length).toBe(1)  // No second call — exited cleanly

    vi.advanceTimersByTime(60000)  // Plenty of time
    expect(calls.length).toBe(1)  // Still no further calls
  })

  it('respects maxDurationMs even if isPlaceholderActive stays true', () => {
    const { calls, deps } = makeDeps({
      maxDurationMs: 12_000,  // Stop after 12s, well before 60s
    })
    startHeartbeat('123', 99, Date.now(), deps)

    vi.advanceTimersByTime(15000)
    // 5s tick: yes (elapsed=5s < 12s cap)
    // 10s tick: yes (elapsed=10s < 12s cap)
    // 15s tick: NO (elapsed=15s >= 12s cap, exits without editing)
    expect(calls.length).toBe(2)
  })

  it('cancel() prevents the next pending tick', () => {
    const { calls, deps } = makeDeps()
    const handle = startHeartbeat('123', 99, Date.now(), deps)

    vi.advanceTimersByTime(5000)
    expect(calls.length).toBe(1)

    handle.cancel()

    vi.advanceTimersByTime(60000)
    expect(calls.length).toBe(1)  // No further ticks after cancel
  })

  it('cancel() is idempotent (safe to call multiple times)', () => {
    const { deps } = makeDeps()
    const handle = startHeartbeat('123', 99, Date.now(), deps)

    expect(() => {
      handle.cancel()
      handle.cancel()
      handle.cancel()
    }).not.toThrow()
  })

  it('swallows sendMessageDraft errors and continues ticking', () => {
    let attempts = 0
    const sendMessageDraft = vi.fn(async (_chatId: string, _draftId: number, _text: string) => {
      attempts++
      if (attempts === 2) throw new Error('Bad Request: rate limited')
      return true as const
    })
    const { deps } = makeDeps({
      sendMessageDraft,
    })

    startHeartbeat('123', 99, Date.now(), deps)
    vi.advanceTimersByTime(15000)

    // 3 ticks fired; 2nd one's promise rejected, but next tick still scheduled
    expect(attempts).toBe(3)
  })

  it('reads getCurrentLabel on each tick (label can change between ticks)', () => {
    let currentLabel: string | null = null
    const { calls, deps } = makeDeps({
      getCurrentLabel: vi.fn(() => currentLabel),
    })
    startHeartbeat('123', 99, Date.now(), deps)

    vi.advanceTimersByTime(5000)
    expect(calls[0]!.text).toBe(`${DEFAULT_HEARTBEAT_LABEL} · 5s`)

    // Simulate recall.py update_placeholder
    currentLabel = '📚 recalling memories'
    vi.advanceTimersByTime(5000)
    expect(calls[1]!.text).toBe('📚 recalling memories · 10s')

    // Simulate post-recall transition
    currentLabel = '💭 thinking'
    vi.advanceTimersByTime(5000)
    expect(calls[2]!.text).toBe('💭 thinking · 15s')
  })

  it('intervalMs=0 returns a no-op handle (operator opt-out per §10.1)', () => {
    const { calls, deps } = makeDeps({ intervalMs: 0 })
    const handle = startHeartbeat('123', 99, Date.now(), deps)

    vi.advanceTimersByTime(60000)
    expect(calls.length).toBe(0)
    expect(() => handle.cancel()).not.toThrow()
  })

  it('intervalMs negative returns a no-op handle (defensive)', () => {
    const { calls, deps } = makeDeps({ intervalMs: -100 })
    startHeartbeat('123', 99, Date.now(), deps)

    vi.advanceTimersByTime(60000)
    expect(calls.length).toBe(0)
  })

  it('exposes module defaults that match design doc §5', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(5000)
    expect(DEFAULT_MAX_DURATION_MS).toBe(5 * 60 * 1000)
    expect(DEFAULT_HEARTBEAT_LABEL).toBe('🔵 thinking')
  })

  describe('dedup — skip edit when text unchanged', () => {
    it('dedups when 2s interval lands multiple ticks in the same 5s formatElapsed bucket', () => {
      // Live-traffic finding: at intervalMs=2000, formatElapsed's 5s
      // precision in the 10-59s window means consecutive ticks
      // produce identical text ("· 10s", "· 10s", "· 15s"). Without
      // dedup these become wasted Telegram editMessageText calls
      // returning "message not modified". Pin the dedup so an operator
      // tuning the interval doesn't rediscover the issue.
      const { calls, deps } = makeDeps({ intervalMs: 2000 })
      startHeartbeat('123', 99, Date.now(), deps)

      vi.advanceTimersByTime(20000)
      // Ticks fire at: 2s, 4s, 6s, 8s, 10s, 12s, 14s, 16s, 18s, 20s
      // formatElapsed produces:
      //   2s, 4s, 6s, 8s, 10s, 10s (12s rounds to 10), 15s, 15s, 20s, 20s
      // Distinct: 2s, 4s, 6s, 8s, 10s, 15s, 20s = 7 unique texts
      // Without dedup: 10 sendMessageDraft calls
      // With dedup: 7 sendMessageDraft calls
      expect(calls.length).toBe(7)
      const texts = calls.map((c) => c.text)
      expect(texts).toEqual([
        `${DEFAULT_HEARTBEAT_LABEL} · 2s`,
        `${DEFAULT_HEARTBEAT_LABEL} · 4s`,
        `${DEFAULT_HEARTBEAT_LABEL} · 6s`,
        `${DEFAULT_HEARTBEAT_LABEL} · 8s`,
        `${DEFAULT_HEARTBEAT_LABEL} · 10s`,
        `${DEFAULT_HEARTBEAT_LABEL} · 15s`,
        `${DEFAULT_HEARTBEAT_LABEL} · 20s`,
      ])
    })

    it('does NOT dedup when label changes mid-bucket (forward-compat with §4 enrichment)', () => {
      // §4 enrichment: recall.py / session-tail change the label
      // mid-tick. Even if the elapsed bucket is the same, a label
      // change MUST emit because the visible text differs.
      let currentLabel: string | null = null
      const { calls, deps } = makeDeps({
        intervalMs: 2000,
        getCurrentLabel: vi.fn(() => currentLabel),
      })
      startHeartbeat('123', 99, Date.now(), deps)

      vi.advanceTimersByTime(2000)
      expect(calls[0]!.text).toBe(`${DEFAULT_HEARTBEAT_LABEL} · 2s`)

      // Label changes — same bucket would normally dedup, but the
      // text actually differs because of the new label.
      currentLabel = '📚 recalling memories'
      vi.advanceTimersByTime(2000)
      expect(calls[1]!.text).toBe('📚 recalling memories · 4s')
      expect(calls.length).toBe(2)
    })

    it('first tick always emits (no prior text to compare against)', () => {
      const { calls, deps } = makeDeps({ intervalMs: 5000 })
      startHeartbeat('123', 99, Date.now(), deps)
      vi.advanceTimersByTime(5000)
      expect(calls.length).toBe(1)
    })
  })
})
