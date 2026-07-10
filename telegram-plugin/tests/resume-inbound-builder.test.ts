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
  buildResumeDeferredReportInbound,
  isResumeSyntheticTurn,
  selectResumeBuilder,
  decideBootResumeKind,
  RESUME_SYNTHETIC_PROMPT_PREFIX,
  renderInterruptedSubagentsBlock,
  type InterruptedSubagent,
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
    resumed_at: null,
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

  it('includes the FULL stored preview in the body (no double-truncation below the 200-char storage cap)', () => {
    // The turns table already caps the preview at ~200 chars (TURN_PREVIEW_MAX);
    // the builder must NOT slice it shorter (the old 160-char cut dropped detail
    // from the tail of a longer request). A 180-char preview must appear in full.
    const preview = "step 1 do X; step 2 do Y; step 3 do Z; " + "d".repeat(141) // 180 chars
    expect(preview.length).toBe(180)
    const msg = buildResumeInterruptedInbound({ turn: makeTurn({ user_prompt_preview: preview }) })
    expect(msg.text).toContain(preview) // verbatim, not sliced to 160
    expect(msg.meta.original_prompt).toBe(preview)
  })

  it('tells the resumed turn to recover the FULL original via get_recent_messages', () => {
    const msg = buildResumeInterruptedInbound({ turn: makeTurn({ user_prompt_preview: 'short task' }) })
    expect(msg.text).toContain('get_recent_messages')
    // Frames the quoted preview as partial so the model knows to fetch the rest.
    expect(msg.text).toMatch(/first ~200 characters|start of the request/i)
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

  // Origin routing + ack-ability (the resume-deliver hardening). meta.chat_id
  // makes the gateway build a currentTurn (progress card + silence-poke) and
  // fire ackDelivery; meta.message_id round-trips so the deliver-until-acked
  // queue can ack THIS synthetic by its own enqueue id (no re-deliver storm).
  it('carries origin chat_id + message_id in meta (DM)', () => {
    const turn = makeTurn({ chat_id: '12345', thread_id: null })
    const msg = buildResumeInterruptedInbound({ turn, nowMs: 1_700_000_000_000 })
    expect(msg.meta.chat_id).toBe('12345')
    expect(msg.meta.message_id).toBe('1700000000000')
    expect(msg.messageId).toBe(1_700_000_000_000)
    expect(msg.meta.message_thread_id).toBeUndefined()
  })

  it('carries message_thread_id in meta for a forum topic (supergroup routing)', () => {
    const turn = makeTurn({ chat_id: '-1001234567890', thread_id: '42' })
    const msg = buildResumeInterruptedInbound({ turn })
    expect(msg.meta.chat_id).toBe('-1001234567890')
    expect(msg.meta.message_thread_id).toBe('42')
    expect(msg.threadId).toBe(42)
  })
})

describe('interrupted sub-agent block', () => {
  const twoRunning: InterruptedSubagent[] = [
    { agentType: 'worker', description: 'refactor the auth module and add tests', status: 'running' },
    { agentType: 'researcher', description: 'survey the pricing pages of 5 competitors', status: 'running' },
  ]

  it('renderInterruptedSubagentsBlock lists each worker with type + prompt', () => {
    const block = renderInterruptedSubagentsBlock(twoRunning)
    expect(block).toContain('2 sub-agents were still')
    expect(block).toContain('did NOT complete')
    expect(block).toContain('[worker]')
    expect(block).toContain('refactor the auth module and add tests')
    expect(block).toContain('[researcher]')
    expect(block).toContain('survey the pricing pages of 5 competitors')
    expect(block).toContain('Re-dispatch the ones still needed')
  })

  it('returns empty string when there are no in-flight sub-agents', () => {
    expect(renderInterruptedSubagentsBlock(undefined)).toBe('')
    expect(renderInterruptedSubagentsBlock([])).toBe('')
  })

  it('interrupted-turn inbound contains BOTH running sub-agents', () => {
    const msg = buildResumeInterruptedInbound({ turn: makeTurn(), subagents: twoRunning })
    expect(msg.text).toContain('refactor the auth module and add tests')
    expect(msg.text).toContain('survey the pricing pages of 5 competitors')
    expect(msg.text).toContain('did NOT complete')
    expect(msg.text).toContain('Re-dispatch the ones still needed')
  })

  it('interrupted-turn inbound is UNCHANGED when no sub-agents were running', () => {
    const withNone = buildResumeInterruptedInbound({ turn: makeTurn(), subagents: [] })
    const bare = buildResumeInterruptedInbound({ turn: makeTurn() })
    expect(withNone.text).toBe(bare.text)
    expect(withNone.text).not.toContain('did NOT complete')
  })

  it('truncates each dispatch prompt to ~200 chars', () => {
    const long = 'x'.repeat(400)
    const block = renderInterruptedSubagentsBlock([{ agentType: 'worker', description: long }])
    // The 400-char prompt must not survive in full; the entry line is capped.
    expect(block).not.toContain(long)
    expect(block).toContain('…')
    // 200-char cap → the truncated slice (199 chars + ellipsis) is present.
    expect(block).toContain('x'.repeat(199))
    expect(block).not.toContain('x'.repeat(201))
  })

  it('caps the list at 10 and summarises the remainder', () => {
    const many: InterruptedSubagent[] = Array.from({ length: 14 }, (_, i) => ({
      agentType: 'worker',
      description: `task number ${i + 1}`,
    }))
    const block = renderInterruptedSubagentsBlock(many)
    expect(block).toContain('14 sub-agents were still')
    expect(block).toContain('task number 10')
    expect(block).not.toContain('task number 11')
    expect(block).toContain('…and 4 more.')
    // Exactly 10 numbered entries rendered.
    const numbered = block.match(/^\s+\d+\. \[/gm) ?? []
    expect(numbered.length).toBe(10)
  })

  it('falls back to a generic label + placeholder when type/prompt are missing', () => {
    const block = renderInterruptedSubagentsBlock([{ agentType: null, description: null }])
    expect(block).toContain('[sub-agent]')
    expect(block).toContain('(no task description recorded)')
  })

  it('singularises a single killed sub-agent', () => {
    const block = renderInterruptedSubagentsBlock([{ agentType: 'worker', description: 'do X' }])
    expect(block).toContain('1 sub-agent was still')
    expect(block).not.toContain('1 sub-agents')
  })

  it('codepoint-safe truncation never splits a surrogate pair', () => {
    // 199 ASCII chars, then an astral-plane emoji (2 UTF-16 code units)
    // straddling the cap. A code-unit slice would cut the pair in half and
    // leave a lone surrogate; the codepoint-safe slice must not.
    const desc = 'a'.repeat(199) + '🚀' + 'b'.repeat(50)
    const block = renderInterruptedSubagentsBlock([{ agentType: 'worker', description: desc }])
    expect(block).toContain('…')
    // No lone surrogates anywhere in the rendered block.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(block)).toBe(false)
    expect(block).toBe(block.normalize('NFC')) // sanity: still a well-formed string
  })

  it('the watchdog report inbound carries the block in DEFERRED form (ask-first contract)', () => {
    const msg = buildResumeWatchdogReportInbound({
      turn: makeTurn({ ended_via: 'timeout' }),
      idleMs: 300_000,
      subagents: twoRunning,
    })
    expect(msg.text).toContain('did NOT complete')
    expect(msg.text).toContain('refactor the auth module and add tests')
    // Deferred wording: re-dispatch is conditional on the user asking to retry…
    expect(msg.text).toContain("If the user asks you to retry, they'll need re-dispatching")
    expect(msg.text).toContain("don't assume their work landed")
    // …and the resume-path imperative must NOT appear — it would contradict
    // the watchdog inbound's "Do NOT silently resume … ask" hang-safety gate.
    expect(msg.text).not.toContain('Re-dispatch the ones still needed')
    expect(msg.text).not.toContain('before declaring the task done')
  })

  it('the resume-path inbound keeps the assertive imperative (and not the deferred form)', () => {
    const msg = buildResumeInterruptedInbound({ turn: makeTurn(), subagents: twoRunning })
    expect(msg.text).toContain('Re-dispatch the ones still needed before declaring the task done')
    expect(msg.text).not.toContain('If the user asks you to retry')
  })

  for (const reason of ['loop-guard', 'clean-restart-suppressed'] as const) {
    it(`the deferred report (${reason}) carries the block in DEFERRED form — suppressed resumes still name worker deaths`, () => {
      const msg = buildResumeDeferredReportInbound({
        turn: makeTurn(),
        reason,
        subagents: twoRunning,
      })
      expect(msg.text).toContain('did NOT complete')
      expect(msg.text).toContain('refactor the auth module and add tests')
      expect(msg.text).toContain('survey the pricing pages of 5 competitors')
      // Deferred wording only — never the resume-path imperative, which would
      // contradict this inbound's "Do NOT silently resume … ask" contract.
      expect(msg.text).toContain("If the user asks you to retry, they'll need re-dispatching")
      expect(msg.text).not.toContain('Re-dispatch the ones still needed')
      expect(msg.text).not.toContain('before declaring the task done')
      // Appending the block must not disturb the loop-guard anchor at pos 0.
      expect(msg.text.startsWith(RESUME_SYNTHETIC_PROMPT_PREFIX)).toBe(true)
    })
  }

  it('deferred report without subagents is unchanged (no block)', () => {
    const withNone = buildResumeDeferredReportInbound({ turn: makeTurn(), reason: 'loop-guard', subagents: [] })
    const bare = buildResumeDeferredReportInbound({ turn: makeTurn(), reason: 'loop-guard' })
    expect(withNone.text).toBe(bare.text)
    expect(withNone.text).not.toContain('did NOT complete')
  })

  it('appending the block preserves the RESUME_SYNTHETIC_PROMPT_PREFIX anchor on resume + watchdog inbounds too', () => {
    const resume = buildResumeInterruptedInbound({ turn: makeTurn(), subagents: twoRunning })
    expect(resume.text.startsWith(RESUME_SYNTHETIC_PROMPT_PREFIX)).toBe(true)
    const report = buildResumeWatchdogReportInbound({
      turn: makeTurn({ ended_via: 'timeout' }),
      idleMs: 300_000,
      subagents: twoRunning,
    })
    expect(report.text.startsWith(RESUME_SYNTHETIC_PROMPT_PREFIX)).toBe(true)
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

  // The report turn ALSO gets origin routing (currentTurn + topic) — a "your
  // last turn was interrupted" notice should land in the topic the work lived
  // in — but it is NOT deliver-until-acked tracked, so it carries NO
  // message_id (only the 'resume_interrupted' builder does, gating tracking).
  it('carries origin chat_id + message_thread_id but NO message_id (report is untracked)', () => {
    const turn = makeTurn({ ended_via: 'timeout', chat_id: '-1001234567890', thread_id: '42' })
    const msg = buildResumeWatchdogReportInbound({ turn, idleMs: 300_000 })
    expect(msg.meta.chat_id).toBe('-1001234567890')
    expect(msg.meta.message_thread_id).toBe('42')
    expect(msg.meta.message_id).toBeUndefined()
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

// ---------------------------------------------------------------------------
// Loop-guard: RESUME_SYNTHETIC_PROMPT_PREFIX / isResumeSyntheticTurn
// ---------------------------------------------------------------------------

describe('resume synthetic-turn detection (loop-guard anchor)', () => {
  it('EVERY synthetic boot inbound text starts with the machine-stable prefix', () => {
    // The loop-guard keys on this prefix landing in user_prompt_preview, so if
    // a prose edit drops it the chain-cap silently breaks. Pin it here.
    const turn = makeTurn({ user_prompt_preview: 'do the thing' })
    expect(buildResumeInterruptedInbound({ turn }).text.startsWith(RESUME_SYNTHETIC_PROMPT_PREFIX)).toBe(true)
    expect(
      buildResumeWatchdogReportInbound({ turn: makeTurn({ ended_via: 'timeout' }), idleMs: 1000 }).text.startsWith(
        RESUME_SYNTHETIC_PROMPT_PREFIX,
      ),
    ).toBe(true)
    expect(
      buildResumeDeferredReportInbound({ turn, reason: 'loop-guard' }).text.startsWith(
        RESUME_SYNTHETIC_PROMPT_PREFIX,
      ),
    ).toBe(true)
    expect(
      buildResumeDeferredReportInbound({ turn, reason: 'clean-restart-suppressed' }).text.startsWith(
        RESUME_SYNTHETIC_PROMPT_PREFIX,
      ),
    ).toBe(true)
  })

  it('isResumeSyntheticTurn is true for a turn whose preview is a synthetic prompt', () => {
    const synthetic = buildResumeInterruptedInbound({ turn: makeTurn() })
    // A resume turn stores the first ~200 chars of the synthetic text as its
    // preview (channel wrapper stripped) — simulate that.
    const resumeTurn = makeTurn({ user_prompt_preview: synthetic.text.slice(0, 200) })
    expect(isResumeSyntheticTurn(resumeTurn)).toBe(true)
  })

  it('isResumeSyntheticTurn is false for real user work and for null preview', () => {
    expect(isResumeSyntheticTurn(makeTurn({ user_prompt_preview: 'refactor the auth module' }))).toBe(false)
    expect(isResumeSyntheticTurn(makeTurn({ user_prompt_preview: null }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildResumeDeferredReportInbound
// ---------------------------------------------------------------------------

describe('buildResumeDeferredReportInbound', () => {
  it('emits source=resume_deferred and carries the dedup anchor + reason', () => {
    const turn = makeTurn({ turn_key: 'zz:3' })
    const msg = buildResumeDeferredReportInbound({ turn, reason: 'loop-guard' })
    expect(msg.meta.source).toBe('resume_deferred')
    expect(msg.meta.resume_turn_key).toBe('zz:3')
    expect(msg.meta.defer_reason).toBe('loop-guard')
  })

  it('loop-guard framing tells the model the chain was capped, not to resume', () => {
    const msg = buildResumeDeferredReportInbound({ turn: makeTurn(), reason: 'loop-guard' })
    expect(msg.text.toLowerCase()).toContain('resume of earlier interrupted work')
    expect(msg.text).toContain('Do NOT silently resume')
  })

  it('clean-restart-suppressed framing cites boot_resume: never', () => {
    const msg = buildResumeDeferredReportInbound({ turn: makeTurn(), reason: 'clean-restart-suppressed' })
    expect(msg.text).toContain('boot_resume: never')
    expect(msg.text).toContain('Do NOT silently resume')
  })

  it('routes to the origin thread when the turn carried one', () => {
    const turn = makeTurn({ chat_id: '-100999', thread_id: '77' })
    const msg = buildResumeDeferredReportInbound({ turn, reason: 'loop-guard' })
    expect(msg.chatId).toBe('-100999')
    expect(msg.threadId).toBe(77)
    expect(msg.meta.message_thread_id).toBe('77')
  })
})

// ---------------------------------------------------------------------------
// decideBootResumeKind — boot-resume precedence + bounded resume chain
// ---------------------------------------------------------------------------

describe('decideBootResumeKind', () => {
  const MAX = 10_800_000 // 3h

  it('resumes genuinely in-flight work after a deliberate restart (not suppressed)', () => {
    // The core product fix: clean restart mid-turn → resume, not silence.
    const pending = makeTurn({ ended_via: 'restart', user_prompt_preview: 'ship the release' })
    expect(decideBootResumeKind({ pending, suppressed: false, ageMs: 1000, maxAgeMs: MAX })).toBe('resume')
  })

  it("boot_resume:never (suppressed) → 'defer-suppressed' passive report, never silence", () => {
    const pending = makeTurn({ ended_via: 'restart', user_prompt_preview: 'ship the release' })
    expect(decideBootResumeKind({ pending, suppressed: true, ageMs: 1000, maxAgeMs: MAX })).toBe('defer-suppressed')
  })

  it('watchdog timeout still reports even when not suppressed', () => {
    const pending = makeTurn({ ended_via: 'timeout', user_prompt_preview: 'ship the release' })
    expect(decideBootResumeKind({ pending, suppressed: false, ageMs: 1000, maxAgeMs: MAX })).toBe('report')
  })

  it('BOUNDED CHAIN: a restart DURING a resume turn does NOT re-resume — loop-guard fires', () => {
    // Simulate the chain the coordinator flagged:
    //   A: real work, interrupted → resume R1 (turn B created from R1's text)
    //   restart lands during B → pending is B, whose preview IS the synthetic
    //   resume prompt. We must NOT mint a second resume (endless loop risk).
    const r1 = buildResumeInterruptedInbound({ turn: makeTurn({ user_prompt_preview: 'real work' }) })
    const turnB = makeTurn({ ended_via: 'restart', user_prompt_preview: r1.text.slice(0, 200) })
    // Even though NOT suppressed (would normally resume), the loop-guard wins:
    expect(decideBootResumeKind({ pending: turnB, suppressed: false, ageMs: 1000, maxAgeMs: MAX })).toBe('defer-loop')
  })

  it('BOUNDED CHAIN: a restart during a deferred-report turn stays capped (still defer-loop, never resume)', () => {
    // Depth does not grow: a report-of-report is still a passive report, never
    // a resume — so no unbounded restart→resume→restart chain can form.
    const deferred = buildResumeDeferredReportInbound({ turn: makeTurn(), reason: 'loop-guard' })
    const turnC = makeTurn({ ended_via: 'restart', user_prompt_preview: deferred.text.slice(0, 200) })
    const kind = decideBootResumeKind({ pending: turnC, suppressed: false, ageMs: 1000, maxAgeMs: MAX })
    expect(kind).toBe('defer-loop')
    expect(kind).not.toBe('resume')
  })

  it('loop-guard takes precedence over suppression too (synthetic turn never resumes or double-reports as resume)', () => {
    const r1 = buildResumeInterruptedInbound({ turn: makeTurn() })
    const turnB = makeTurn({ ended_via: 'restart', user_prompt_preview: r1.text.slice(0, 200) })
    expect(decideBootResumeKind({ pending: turnB, suppressed: true, ageMs: 1000, maxAgeMs: MAX })).toBe('defer-loop')
  })

  it('stale in-flight work downgrades to report when older than maxAgeMs', () => {
    const pending = makeTurn({ ended_via: 'restart', user_prompt_preview: 'stale work' })
    expect(decideBootResumeKind({ pending, suppressed: false, ageMs: MAX + 1, maxAgeMs: MAX })).toBe('report')
  })
})
