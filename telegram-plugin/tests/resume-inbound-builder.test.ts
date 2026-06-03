/**
 * Unit tests for telegram-plugin/gateway/resume-inbound-builder.ts
 *
 * Pure builders — no SQLite, no gateway. They run under bun test alongside
 * the other telegram-plugin tests. The contract under test:
 *
 *   - humanizeElapsed bucketing (moments / min / h / days, plus the
 *     negative/NaN guard).
 *   - buildResumeInterruptedInbound  → source='resume_interrupted', resume
 *     framing, dedup anchor meta.resume_turn_key, thread routing.
 *   - buildResumeWatchdogReportInbound → source='resume_watchdog_timeout',
 *     report (not resume) framing, idle_ms passthrough.
 *   - selectResumeBuilder policy table.
 */

import { describe, it, expect } from 'bun:test'
import {
  humanizeElapsed,
  buildResumeInterruptedInbound,
  buildResumeWatchdogReportInbound,
  selectResumeBuilder,
} from '../gateway/resume-inbound-builder.js'
import type { Turn, TurnEndedVia } from '../registry/turns-schema.js'

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    turn_key: '12345:11',
    chat_id: '12345',
    thread_id: null,
    started_at: 1_000_000,
    ended_at: null,
    ended_via: 'restart',
    last_assistant_msg_id: null,
    last_assistant_done: null,
    last_user_msg_id: null,
    user_prompt_preview: null,
    assistant_reply_preview: null,
    tool_call_count: null,
    interrupt_reason: null,
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides,
  }
}

describe('humanizeElapsed', () => {
  it('returns "moments" under 45s', () => {
    expect(humanizeElapsed(0)).toBe('moments')
    expect(humanizeElapsed(44_000)).toBe('moments')
  })

  it('buckets minutes under an hour', () => {
    expect(humanizeElapsed(60_000)).toBe('~1 min')
    expect(humanizeElapsed(5 * 60_000)).toBe('~5 min')
    expect(humanizeElapsed(59 * 60_000)).toBe('~59 min')
  })

  it('buckets hours under a day', () => {
    expect(humanizeElapsed(60 * 60_000)).toBe('~1h')
    expect(humanizeElapsed(3 * 60 * 60_000)).toBe('~3h')
  })

  it('buckets days at/over 24h with singular/plural', () => {
    expect(humanizeElapsed(24 * 60 * 60_000)).toBe('~1 day')
    expect(humanizeElapsed(50 * 60 * 60_000)).toBe('~2 days')
  })

  it('guards against negative / non-finite input', () => {
    expect(humanizeElapsed(-5)).toBe('an unknown amount of time')
    expect(humanizeElapsed(NaN)).toBe('an unknown amount of time')
    expect(humanizeElapsed(Infinity)).toBe('an unknown amount of time')
  })
})

describe('buildResumeInterruptedInbound', () => {
  it('sets the resume_interrupted source and dedup anchor', () => {
    const turn = makeTurn({ turn_key: 'abc:7', ended_via: 'sigterm' })
    const msg = buildResumeInterruptedInbound({ turn, nowMs: turn.started_at + 3 * 60 * 60_000 })
    expect(msg.type).toBe('inbound')
    expect(msg.meta.source).toBe('resume_interrupted')
    expect(msg.meta.resume_turn_key).toBe('abc:7')
    expect(msg.meta.interrupted_via).toBe('sigterm')
    expect(msg.user).toBe('switchroom')
    expect(msg.userId).toBe(0)
  })

  it('frames the elapsed time in the body and tells the model to resume, not ask', () => {
    const turn = makeTurn()
    const msg = buildResumeInterruptedInbound({ turn, nowMs: turn.started_at + 3 * 60 * 60_000 })
    expect(msg.text).toContain('~3h')
    expect(msg.text.toLowerCase()).toContain('interrupted')
    expect(msg.text.toLowerCase()).toContain('do')
    expect(msg.text).toContain('not ask whether to resume')
  })

  it('defaults interrupted_via to restart when ended_via is null', () => {
    const turn = makeTurn({ ended_via: null })
    const msg = buildResumeInterruptedInbound({ turn })
    expect(msg.meta.interrupted_via).toBe('restart')
  })

  it('includes the prompt preview when present and carries original_prompt meta', () => {
    const turn = makeTurn({ user_prompt_preview: 'refactor the auth module' })
    const msg = buildResumeInterruptedInbound({ turn })
    expect(msg.text).toContain('refactor the auth module')
    expect(msg.meta.original_prompt).toBe('refactor the auth module')
  })

  it('truncates a long prompt preview in the body', () => {
    const long = 'x'.repeat(300)
    const turn = makeTurn({ user_prompt_preview: long })
    const msg = buildResumeInterruptedInbound({ turn })
    expect(msg.text).toContain('…')
    expect(msg.text).not.toContain('x'.repeat(200))
  })

  it('routes to the forum thread when thread_id is numeric', () => {
    const turn = makeTurn({ thread_id: '99' })
    const msg = buildResumeInterruptedInbound({ turn })
    expect(msg.threadId).toBe(99)
  })

  it('omits threadId for a non-forum (null thread_id) chat', () => {
    const msg = buildResumeInterruptedInbound({ turn: makeTurn({ thread_id: null }) })
    expect(msg.threadId).toBeUndefined()
  })
})

describe('buildResumeWatchdogReportInbound', () => {
  it('sets the resume_watchdog_timeout source and idle_ms passthrough', () => {
    const turn = makeTurn({ ended_via: 'timeout' })
    const msg = buildResumeWatchdogReportInbound({ turn, idleMs: 300_000 })
    expect(msg.meta.source).toBe('resume_watchdog_timeout')
    expect(msg.meta.interrupted_via).toBe('timeout')
    expect(msg.meta.idle_ms).toBe('300000')
  })

  it('reports the hang honestly and asks rather than resuming', () => {
    const turn = makeTurn({ ended_via: 'timeout' })
    const msg = buildResumeWatchdogReportInbound({ turn, idleMs: 300_000 })
    expect(msg.text.toLowerCase()).toContain('hang-watchdog')
    expect(msg.text).toContain('no observable progress')
    expect(msg.text).toContain('Do NOT silently resume')
    expect(msg.text.toLowerCase()).toContain('take a different angle')
  })

  it('mentions tool-call count when the turn ran tools before stalling', () => {
    const turn = makeTurn({ ended_via: 'timeout', tool_call_count: 4 })
    const msg = buildResumeWatchdogReportInbound({ turn, idleMs: 300_000 })
    expect(msg.text).toContain('4 tool calls')
    expect(msg.meta.tool_call_count).toBe('4')
  })

  it('singularizes a single tool call', () => {
    const turn = makeTurn({ ended_via: 'timeout', tool_call_count: 1 })
    const msg = buildResumeWatchdogReportInbound({ turn, idleMs: 300_000 })
    expect(msg.text).toContain('1 tool call')
    expect(msg.text).not.toContain('1 tool calls')
  })

  it('omits the tool clause when no tools ran', () => {
    const turn = makeTurn({ ended_via: 'timeout', tool_call_count: 0 })
    const msg = buildResumeWatchdogReportInbound({ turn, idleMs: 300_000 })
    expect(msg.text).not.toContain('tool call')
  })
})

describe('selectResumeBuilder', () => {
  const cases: Array<[TurnEndedVia | null, 'resume' | 'report' | null]> = [
    ['timeout', 'report'],
    ['restart', 'resume'],
    ['sigterm', 'resume'],
    ['unknown', 'resume'],
    [null, 'resume'],
    ['stop', null],
  ]
  for (const [endedVia, expected] of cases) {
    it(`maps ended_via=${String(endedVia)} → ${String(expected)}`, () => {
      expect(selectResumeBuilder(endedVia)).toBe(expected)
    })
  }

  // 3h staleness failsafe (operator spec, 2026-06-03).
  const MAX = 10_800_000 // 3h
  it('downgrades a fresh resume to report when older than maxAgeMs (no auto-resume of stale work)', () => {
    expect(selectResumeBuilder('restart', { ageMs: MAX + 1, maxAgeMs: MAX })).toBe('report')
    expect(selectResumeBuilder(null, { ageMs: MAX + 60_000, maxAgeMs: MAX })).toBe('report')
  })
  it('keeps resume when within maxAgeMs', () => {
    expect(selectResumeBuilder('restart', { ageMs: MAX - 1, maxAgeMs: MAX })).toBe('resume')
    expect(selectResumeBuilder('sigterm', { ageMs: 1000, maxAgeMs: MAX })).toBe('resume')
  })
  it('age cap never UPGRADES — report/null stay as-is regardless of age', () => {
    expect(selectResumeBuilder('timeout', { ageMs: MAX + 1, maxAgeMs: MAX })).toBe('report')
    expect(selectResumeBuilder('stop', { ageMs: MAX + 1, maxAgeMs: MAX })).toBe(null)
  })
  it('legacy behaviour preserved when age/maxAge omitted (blanket resume)', () => {
    expect(selectResumeBuilder('restart')).toBe('resume')
    expect(selectResumeBuilder('restart', { ageMs: MAX + 1 })).toBe('resume') // needs BOTH to cap
  })
})
