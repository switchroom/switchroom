/**
 * Unit tests for the litellm-local 429 notice — the debounced "fleet token
 * limiter engaged" message (telegram-plugin/litellm-local-notice.ts) and its
 * side-effect runner (telegram-plugin/gateway/litellm-local-notice-wiring.ts).
 *
 * Pins the operator spec:
 *   - first litellm-local 429 → ONE calm notice
 *   - further 429s inside the cooldown window → suppressed, counted silently
 *   - first 429 after the window → notice carrying "throttled N more times
 *     since the last notice"
 *   - a notice only ever fires on an actual throttle event (evaluate-on-event,
 *     no timers — a quiet agent posts nothing)
 *   - never fires for non-litellm-local classifications
 *   - copy names the fleet limiter (LiteLLM tpm_limit/rpm_limit), explicitly
 *     NOT an Anthropic account limit, turn retries, no action needed
 *   - window is operator-tunable with a validated 15-min default
 *
 * No real Date.now in the pure module — `now` is a parameter throughout
 * (same injected-clock convention as throttle-tier.test.ts).
 */

import { describe, it, expect } from 'vitest'
import {
  buildLitellmLocalNoticeMetric,
  evaluateLitellmLocalNotice,
  initialLitellmLocalNoticeState,
  isLitellmLocalNoticeEligible,
  LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT,
  parseLitellmNoticeWindowMs,
  renderLitellmLocalNotice,
  type LitellmLocalNoticeState,
} from '../litellm-local-notice.js'
import { createLitellmLocalNoticeRunner } from '../gateway/litellm-local-notice-wiring.js'
import { classify429Detail } from '../throttle-tier.js'

const NOW = Date.UTC(2026, 6, 12, 8, 0, 0) // 2026-07-12T08:00:00Z
const WINDOW = LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT

// Verbatim litellm-proxy-local fixture (same provenance as
// throttle-tier.test.ts / litellmProxyLocal429Signals): the v1 parallel
// request limiter's wrapped exception.
const LITELLM_LOCAL_DETAIL =
  'litellm.RateLimitError: RateLimitError: Crossed TPM / RPM Limit. ' +
  'current tpm: 20112, tpm limit: 20000. Limit type: tpm. ' +
  'Rate limit exceeded for key. litellm rate limit handler'

const ACCOUNT_SCOPED_DETAIL =
  "This request would exceed your account's rate limit. Your account will reset at 8:50am (UTC)."

// ─── Cooldown state machine ──────────────────────────────────────────────────

describe('evaluateLitellmLocalNotice — per-agent cooldown state machine', () => {
  it('first 429 for an agent sends, with zero suppressed', () => {
    const v = evaluateLitellmLocalNotice(initialLitellmLocalNoticeState(), 'clerk', NOW, WINDOW)
    expect(v.send).toBe(true)
    expect(v.suppressedSinceLastNotice).toBe(0)
    expect(v.next.lastSentAtMsByAgent['clerk']).toBe(NOW)
    expect(v.next.suppressedCountByAgent['clerk']).toBe(0)
  })

  it('second 429 inside the window is suppressed and counted', () => {
    const first = evaluateLitellmLocalNotice(initialLitellmLocalNoticeState(), 'clerk', NOW, WINDOW)
    const second = evaluateLitellmLocalNotice(first.next, 'clerk', NOW + 60_000, WINDOW)
    expect(second.send).toBe(false)
    expect(second.next.suppressedCountByAgent['clerk']).toBe(1)
    const third = evaluateLitellmLocalNotice(second.next, 'clerk', NOW + 120_000, WINDOW)
    expect(third.send).toBe(false)
    expect(third.next.suppressedCountByAgent['clerk']).toBe(2)
    // The last-sent stamp is NOT refreshed by suppressed events — the window
    // anchors on the last NOTICE, so a sustained burst can't starve it.
    expect(third.next.lastSentAtMsByAgent['clerk']).toBe(NOW)
  })

  it('first 429 after the window sends and carries the suppressed count, then resets', () => {
    let state = evaluateLitellmLocalNotice(initialLitellmLocalNoticeState(), 'clerk', NOW, WINDOW).next
    for (let i = 1; i <= 3; i++) {
      state = evaluateLitellmLocalNotice(state, 'clerk', NOW + i * 60_000, WINDOW).next
    }
    const after = evaluateLitellmLocalNotice(state, 'clerk', NOW + WINDOW + 1, WINDOW)
    expect(after.send).toBe(true)
    expect(after.suppressedSinceLastNotice).toBe(3)
    expect(after.next.suppressedCountByAgent['clerk']).toBe(0)
    expect(after.next.lastSentAtMsByAgent['clerk']).toBe(NOW + WINDOW + 1)
  })

  it('window boundary: elapsed === windowMs sends; one ms earlier suppresses', () => {
    const armed = evaluateLitellmLocalNotice(initialLitellmLocalNoticeState(), 'clerk', NOW, WINDOW).next
    expect(evaluateLitellmLocalNotice(armed, 'clerk', NOW + WINDOW - 1, WINDOW).send).toBe(false)
    expect(evaluateLitellmLocalNotice(armed, 'clerk', NOW + WINDOW, WINDOW).send).toBe(true)
  })

  it('agents debounce independently (per-agent window)', () => {
    const a = evaluateLitellmLocalNotice(initialLitellmLocalNoticeState(), 'clerk', NOW, WINDOW)
    const b = evaluateLitellmLocalNotice(a.next, 'gymbro', NOW + 1_000, WINDOW)
    expect(b.send).toBe(true)
    // clerk's window is untouched by gymbro's notice.
    const c = evaluateLitellmLocalNotice(b.next, 'clerk', NOW + 2_000, WINDOW)
    expect(c.send).toBe(false)
  })

  it('never mutates the previous state (pure)', () => {
    const prev: LitellmLocalNoticeState = {
      lastSentAtMsByAgent: { clerk: NOW },
      suppressedCountByAgent: { clerk: 1 },
    }
    evaluateLitellmLocalNotice(prev, 'clerk', NOW + 1, WINDOW)
    expect(prev.suppressedCountByAgent['clerk']).toBe(1)
    evaluateLitellmLocalNotice(prev, 'clerk', NOW + WINDOW, WINDOW)
    expect(prev.lastSentAtMsByAgent['clerk']).toBe(NOW)
    expect(prev.suppressedCountByAgent['clerk']).toBe(1)
  })
})

// ─── Config parsing ──────────────────────────────────────────────────────────

describe('parseLitellmNoticeWindowMs — tunable window with validated default', () => {
  it('defaults to 15 minutes when unset', () => {
    expect(LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT).toBe(15 * 60_000)
    expect(parseLitellmNoticeWindowMs(undefined)).toBe(LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT)
    expect(parseLitellmNoticeWindowMs(null)).toBe(LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT)
  })

  it('accepts a custom positive number', () => {
    expect(parseLitellmNoticeWindowMs(5 * 60_000)).toBe(5 * 60_000)
    expect(parseLitellmNoticeWindowMs(1)).toBe(1)
  })

  it('rejects invalid values back to the default (zero, negative, NaN, Infinity, non-number)', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, '600000', {}, [], true]) {
      expect(parseLitellmNoticeWindowMs(bad)).toBe(LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT)
    }
  })
})

// ─── Notice text ─────────────────────────────────────────────────────────────

describe('renderLitellmLocalNotice — copy contract', () => {
  it('names the fleet limiter, negates the account reading, promises the retry', () => {
    const text = renderLitellmLocalNotice({ agent: 'clerk', suppressedSinceLastNotice: 0 })
    expect(text).toContain('Fleet token limiter')
    expect(text).toContain('tpm_limit')
    expect(text).toContain('rpm_limit')
    expect(text).toContain('LiteLLM')
    expect(text).toContain('not an Anthropic account limit')
    expect(text).toContain('retries automatically')
    expect(text).toContain('no action needed')
    expect(text).toContain('**clerk**')
  })

  it('omits the suppressed line on a first notice, includes it after silent throttles', () => {
    const first = renderLitellmLocalNotice({ agent: 'clerk', suppressedSinceLastNotice: 0 })
    expect(first).not.toContain('since the last notice')
    const later = renderLitellmLocalNotice({ agent: 'clerk', suppressedSinceLastNotice: 4 })
    expect(later).toContain('Throttled 4 more times since the last notice.')
  })

  it('pluralizes the suppressed line correctly for exactly one silent throttle', () => {
    const text = renderLitellmLocalNotice({ agent: 'clerk', suppressedSinceLastNotice: 1 })
    expect(text).toContain('Throttled 1 more time since the last notice.')
    expect(text).not.toContain('1 more times')
  })

  it('escapes markdown metacharacters in the agent name', () => {
    const text = renderLitellmLocalNotice({ agent: 'a_b*c', suppressedSinceLastNotice: 0 })
    expect(text).toContain('a\\_b\\*c')
    expect(text).not.toContain('**a_b*c**')
  })
})

// ─── Metric builder ──────────────────────────────────────────────────────────

describe('buildLitellmLocalNoticeMetric', () => {
  it('builds the litellm_local_429_notice payload shape', () => {
    expect(
      buildLitellmLocalNoticeMetric({ agent: 'clerk', suppressedCount: 7, windowMs: WINDOW }),
    ).toEqual({
      kind: 'litellm_local_429_notice',
      agent: 'clerk',
      suppressed_count: 7,
      window_ms: WINDOW,
    })
  })
})

// ─── Classification guard ────────────────────────────────────────────────────

describe('isLitellmLocalNoticeEligible — only litellm-local qualifies', () => {
  it('accepts litellm-local and rejects everything else', () => {
    expect(isLitellmLocalNoticeEligible('litellm-local')).toBe(true)
    expect(isLitellmLocalNoticeEligible('account-scoped')).toBe(false)
    expect(isLitellmLocalNoticeEligible('generic-transient')).toBe(false)
    expect(isLitellmLocalNoticeEligible(null)).toBe(false)
    expect(isLitellmLocalNoticeEligible(undefined)).toBe(false)
  })

  it('agrees with classify429Detail on real fixtures', () => {
    expect(isLitellmLocalNoticeEligible(classify429Detail(LITELLM_LOCAL_DETAIL))).toBe(true)
    expect(isLitellmLocalNoticeEligible(classify429Detail(ACCOUNT_SCOPED_DETAIL))).toBe(false)
    expect(isLitellmLocalNoticeEligible(classify429Detail('overloaded_error'))).toBe(false)
  })
})

// ─── Wiring runner ───────────────────────────────────────────────────────────

interface Harness {
  runner: ReturnType<typeof createLitellmLocalNoticeRunner>
  sends: Array<{ chatId: string | number; markdown: string }>
  metrics: unknown[]
  logs: string[]
  clock: { now: number }
  window: { ms: number }
}

function makeHarness(opts?: { chats?: Array<string | number> }): Harness {
  const sends: Array<{ chatId: string | number; markdown: string }> = []
  const metrics: unknown[] = []
  const logs: string[] = []
  const clock = { now: NOW }
  const window = { ms: WINDOW }
  const runner = createLitellmLocalNoticeRunner({
    listNoticeChats: () => opts?.chats ?? ['111', '222'],
    sendNotice: (chatId, markdown) => sends.push({ chatId, markdown }),
    windowMs: () => window.ms,
    emitMetric: (ev) => metrics.push(ev),
    log: (m) => logs.push(m),
    now: () => clock.now,
  })
  return { runner, sends, metrics, logs, clock, window }
}

describe('createLitellmLocalNoticeRunner — side-effect sequencing', () => {
  it('first litellm-local 429 broadcasts one notice to every authorized chat + one metric', () => {
    const h = makeHarness()
    h.runner.onRateLimited('litellm-local', 'clerk')
    expect(h.sends.map((s) => s.chatId)).toEqual(['111', '222'])
    expect(h.sends[0].markdown).toContain('Fleet token limiter')
    expect(h.metrics).toEqual([
      { kind: 'litellm_local_429_notice', agent: 'clerk', suppressed_count: 0, window_ms: WINDOW },
    ])
  })

  it('suppresses inside the window (no send, no metric), then reports the count after expiry', () => {
    const h = makeHarness()
    h.runner.onRateLimited('litellm-local', 'clerk')
    h.clock.now = NOW + 60_000
    h.runner.onRateLimited('litellm-local', 'clerk')
    h.clock.now = NOW + 120_000
    h.runner.onRateLimited('litellm-local', 'clerk')
    // Two suppressed events: still just the first broadcast.
    expect(h.sends).toHaveLength(2) // 2 chats × 1 notice
    expect(h.metrics).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('suppressed (cooldown)'))).toBe(true)
    // Past the window: one new notice carrying "2 more times".
    h.clock.now = NOW + WINDOW
    h.runner.onRateLimited('litellm-local', 'clerk')
    expect(h.sends).toHaveLength(4)
    expect(h.sends[2].markdown).toContain('Throttled 2 more times since the last notice.')
    expect(h.metrics[1]).toMatchObject({ suppressed_count: 2 })
  })

  it('never fires for non-litellm-local classifications', () => {
    const h = makeHarness()
    h.runner.onRateLimited('account-scoped', 'clerk')
    h.runner.onRateLimited('generic-transient', 'clerk')
    expect(h.sends).toHaveLength(0)
    expect(h.metrics).toHaveLength(0)
    // Non-eligible events must not perturb the debounce state either: the
    // next real litellm-local 429 is still a FIRST notice.
    h.runner.onRateLimited('litellm-local', 'clerk')
    expect(h.sends).toHaveLength(2)
    expect(h.sends[0].markdown).not.toContain('since the last notice')
  })

  it('a quiet agent posts nothing (notices are evaluate-on-event, no timers)', () => {
    const h = makeHarness()
    // Time passes with zero throttle events — nothing is ever sent.
    h.clock.now = NOW + 10 * WINDOW
    expect(h.sends).toHaveLength(0)
    expect(h.metrics).toHaveLength(0)
  })

  it('re-reads the tunable window per event (operator retune takes effect live)', () => {
    const h = makeHarness({ chats: ['111'] })
    h.window.ms = 5 * 60_000
    h.runner.onRateLimited('litellm-local', 'clerk')
    h.clock.now = NOW + 5 * 60_000
    h.runner.onRateLimited('litellm-local', 'clerk')
    expect(h.sends).toHaveLength(2)
    expect(h.metrics[1]).toMatchObject({ window_ms: 5 * 60_000 })
  })

  it('a throwing send never breaks the caller and later events still work', () => {
    const sends: string[] = []
    const logs: string[] = []
    const clock = { now: NOW }
    let shouldThrow = true
    const runner = createLitellmLocalNoticeRunner({
      listNoticeChats: () => ['111'],
      sendNotice: (_chatId, markdown) => {
        if (shouldThrow) throw new Error('boom')
        sends.push(markdown)
      },
      windowMs: () => WINDOW,
      emitMetric: () => {},
      log: (m) => logs.push(m),
      now: () => clock.now,
    })
    expect(() => runner.onRateLimited('litellm-local', 'clerk')).not.toThrow()
    expect(logs.some((l) => l.includes('error') && l.includes('boom'))).toBe(true)
    shouldThrow = false
    clock.now = NOW + WINDOW
    runner.onRateLimited('litellm-local', 'clerk')
    expect(sends).toHaveLength(1)
  })
})
