/**
 * Unit tests for the per-tool-call wall-clock deadline (Stage A prevention).
 *
 * The gateway-side wiring (5s sweep timer, synthetic-result injection, flight
 * clearing) is exercised by integration; these pin the pure, deterministic
 * core:
 *   - a never-returning STANDARD tool breaches within its ceiling, and the
 *     injected synthetic error lets the turn proceed;
 *   - the per-toolUseId guard drops a real result that arrives AFTER the
 *     synthetic error (no double-processing);
 *   - human + background classes are EXCLUDED from the short ceiling;
 *   - classification + config helpers behave.
 *
 * FAILS on current head: `../gateway/tool-call-deadline.js` does not exist
 * there — the deadline mechanism is the contribution under test.
 */

import { describe, it, expect } from 'vitest'
import {
  ToolCallDeadlineTracker,
  classifyToolClass,
  standardDeadlineMs,
  toolCallDeadlineEnforced,
  deadlineErrorText,
  sweepToolCallDeadlines,
  resolveDeadlineConfig,
  observeToolUse,
  DEFAULT_STANDARD_DEADLINE_MS,
  DEFAULT_DEADLINE_CONFIG,
  type DeadlineConfig,
  type DeadlineBreach,
} from '../gateway/tool-call-deadline.js'

const cfg: DeadlineConfig = { standardMs: 120_000, humanMs: Number.POSITIVE_INFINITY, backgroundMs: Number.POSITIVE_INFINITY }

describe('ToolCallDeadlineTracker — standard ceiling', () => {
  it('a never-returning standard tool breaches within the ceiling and the turn proceeds', () => {
    const t = new ToolCallDeadlineTracker()
    const t0 = 1_000_000
    t.noteStart('tu_1', 'Read', 'standard', t0)

    // Just under the ceiling: no breach, still in flight.
    expect(t.sweep(t0 + 119_999, cfg)).toEqual([])
    expect(t.hasInFlight()).toBe(true)

    // At the ceiling: exactly one breach for tu_1; the gateway injects the
    // synthetic error and the flight entry is cleared so isMidToolCall stops
    // masking the hang and the turn can proceed.
    const breaches = t.sweep(t0 + 120_000, cfg)
    expect(breaches).toHaveLength(1)
    expect(breaches[0]!.toolUseId).toBe('tu_1')
    expect(breaches[0]!.name).toBe('Read')
    expect(breaches[0]!.klass).toBe('standard')
    expect(breaches[0]!.deadlineMs).toBe(120_000)
    expect(breaches[0]!.elapsedMs).toBe(120_000)
    expect(t.hasInFlight()).toBe(false)

    // The synthetic result the gateway injects reads as an operational error.
    const text = deadlineErrorText(breaches[0]!.name, breaches[0]!.deadlineMs)
    expect(text).toContain('exceeded')
    expect(text).toContain('120s')
  })

  it('does not re-report a breach on the next sweep', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_1', 'Read', 'standard', 0)
    expect(t.sweep(200_000, cfg)).toHaveLength(1)
    expect(t.sweep(300_000, cfg)).toEqual([])
  })

  it('a fast standard tool that returns before the ceiling never breaches', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_1', 'Read', 'standard', 0)
    expect(t.noteResult('tu_1')).toBe(true)
    expect(t.sweep(10_000_000, cfg)).toEqual([])
    expect(t.hasInFlight()).toBe(false)
  })
})

describe('ToolCallDeadlineTracker — per-toolUseId guard (critical)', () => {
  it('drops a real result that arrives AFTER the synthetic error', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_1', 'Read', 'standard', 0)
    // Force-fail on breach.
    expect(t.sweep(120_000, cfg)).toHaveLength(1)
    // The real tool_result finally arrives — it MUST be dropped, not processed.
    expect(t.noteResult('tu_1')).toBe(false)
    // And the drop is one-shot: a second stray result for the same id is not
    // still flagged as reaped (defensive) but is a harmless unknown → true.
    expect(t.noteResult('tu_1')).toBe(true)
  })

  it('a result for a never-breached / unknown id is processed normally', () => {
    const t = new ToolCallDeadlineTracker()
    expect(t.noteResult('unknown')).toBe(true)
  })

  it('a reused toolUseId after a breach clears the stale reaped mark', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_1', 'Read', 'standard', 0)
    expect(t.sweep(120_000, cfg)).toHaveLength(1)
    // Reused id (fresh call) — noteStart clears the reaped mark so its real
    // result is processed normally.
    t.noteStart('tu_1', 'Read', 'standard', 500_000)
    expect(t.noteResult('tu_1')).toBe(true)
  })
})

describe('ToolCallDeadlineTracker — excluded classes', () => {
  it('human waits are never force-failed on the short ceiling', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_h', 'ask_user', 'human', 0)
    expect(t.sweep(10_000_000, cfg)).toEqual([])
    expect(t.hasInFlight()).toBe(true)
  })

  it('background (Task/Agent/long Bash) tools are never force-failed on the short ceiling', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_b', 'Task', 'background', 0)
    expect(t.sweep(10_000_000, cfg)).toEqual([])
    expect(t.hasInFlight()).toBe(true)
  })

  it('a finite override CAN bound human/background if an operator sets one', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_h', 'ask_user', 'human', 0)
    const bounded: DeadlineConfig = { standardMs: 120_000, humanMs: 60_000, backgroundMs: Number.POSITIVE_INFINITY }
    expect(t.sweep(60_000, bounded)).toHaveLength(1)
  })

  it('clear() drops in-flight and reaped state', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_1', 'Read', 'standard', 0)
    t.sweep(120_000, cfg)
    t.clear()
    expect(t.hasInFlight()).toBe(false)
    // reaped cleared too: a post-clear result for the old id is unknown → true.
    expect(t.noteResult('tu_1')).toBe(true)
  })
})

describe('classifyToolClass', () => {
  it('ask_user → human', () => {
    expect(classifyToolClass('ask_user')).toBe('human')
  })
  it('a tool parked on an approval card → human', () => {
    expect(classifyToolClass('Bash', { awaitingApproval: true })).toBe('human')
  })
  it('Task / Agent → background', () => {
    expect(classifyToolClass('Task')).toBe('background')
    expect(classifyToolClass('Agent')).toBe('background')
  })
  it('a run_in_background Bash → background', () => {
    expect(classifyToolClass('Bash', { backgroundBash: true })).toBe('background')
  })
  it('an ordinary foreground tool → standard', () => {
    expect(classifyToolClass('Read')).toBe('standard')
    expect(classifyToolClass('Grep')).toBe('standard')
    expect(classifyToolClass('Bash')).toBe('standard')
  })
})

describe('sweepToolCallDeadlines (gateway wrapper)', () => {
  it('observe-only: logs a breach but does NOT force-fail when enforce=false', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_1', 'Read', 'standard', 0)
    const logs: string[] = []
    const forced: DeadlineBreach[] = []
    const out = sweepToolCallDeadlines(t, 120_000, cfg, {
      enforce: false,
      log: (l) => logs.push(l),
      onForceFail: (b) => forced.push(b),
    })
    expect(out).toHaveLength(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('[tool-deadline] breach tool=Read')
    expect(logs[0]).toContain('enforce=false')
    expect(forced).toEqual([])
  })

  it('enforce: force-fails each breached tool', () => {
    const t = new ToolCallDeadlineTracker()
    t.noteStart('tu_1', 'Read', 'standard', 0)
    const forced: DeadlineBreach[] = []
    sweepToolCallDeadlines(t, 120_000, cfg, {
      enforce: true,
      log: () => {},
      onForceFail: (b) => forced.push(b),
    })
    expect(forced.map((b) => b.toolUseId)).toEqual(['tu_1'])
  })
})

describe('observeToolUse', () => {
  it('starts a standard deadline for an ordinary tool', () => {
    const prev = process.env.SWITCHROOM_DISABLE_TOOL_DEADLINE
    delete process.env.SWITCHROOM_DISABLE_TOOL_DEADLINE
    const t = new ToolCallDeadlineTracker()
    observeToolUse(t, 'tu_1', 'Read', undefined, 0)
    expect(t.sweep(120_000, cfg)).toHaveLength(1)
    if (prev !== undefined) process.env.SWITCHROOM_DISABLE_TOOL_DEADLINE = prev
  })

  it('classes a run_in_background Bash as background (excluded)', () => {
    const t = new ToolCallDeadlineTracker()
    observeToolUse(t, 'tu_1', 'Bash', { run_in_background: true }, 0)
    expect(t.sweep(10_000_000, cfg)).toEqual([])
  })

  it('is a no-op when the subsystem is disabled', () => {
    process.env.SWITCHROOM_DISABLE_TOOL_DEADLINE = '1'
    const t = new ToolCallDeadlineTracker()
    observeToolUse(t, 'tu_1', 'Read', undefined, 0)
    expect(t.hasInFlight()).toBe(false)
    delete process.env.SWITCHROOM_DISABLE_TOOL_DEADLINE
  })

  it('is a no-op for an empty toolUseId', () => {
    const t = new ToolCallDeadlineTracker()
    observeToolUse(t, '', 'Read', undefined, 0)
    expect(t.hasInFlight()).toBe(false)
  })
})

describe('config helpers', () => {
  it('resolveDeadlineConfig reads standard from env, excludes human/background', () => {
    const c = resolveDeadlineConfig({ SWITCHROOM_TOOL_DEADLINE_STANDARD_MS: '90000' })
    expect(c.standardMs).toBe(90_000)
    expect(c.humanMs).toBe(Number.POSITIVE_INFINITY)
    expect(c.backgroundMs).toBe(Number.POSITIVE_INFINITY)
  })
  it('standardDeadlineMs falls back on blank / garbage / non-positive', () => {
    expect(standardDeadlineMs({})).toBe(DEFAULT_STANDARD_DEADLINE_MS)
    expect(standardDeadlineMs({ SWITCHROOM_TOOL_DEADLINE_STANDARD_MS: '' })).toBe(DEFAULT_STANDARD_DEADLINE_MS)
    expect(standardDeadlineMs({ SWITCHROOM_TOOL_DEADLINE_STANDARD_MS: 'nope' })).toBe(DEFAULT_STANDARD_DEADLINE_MS)
    expect(standardDeadlineMs({ SWITCHROOM_TOOL_DEADLINE_STANDARD_MS: '0' })).toBe(DEFAULT_STANDARD_DEADLINE_MS)
    expect(standardDeadlineMs({ SWITCHROOM_TOOL_DEADLINE_STANDARD_MS: '-5' })).toBe(DEFAULT_STANDARD_DEADLINE_MS)
  })
  it('standardDeadlineMs honours a valid override', () => {
    expect(standardDeadlineMs({ SWITCHROOM_TOOL_DEADLINE_STANDARD_MS: '90000' })).toBe(90_000)
  })
  it('enforcement is OPT-IN (default off)', () => {
    expect(toolCallDeadlineEnforced({})).toBe(false)
    expect(toolCallDeadlineEnforced({ SWITCHROOM_TOOL_DEADLINE_ENFORCE: '1' })).toBe(true)
    expect(toolCallDeadlineEnforced({ SWITCHROOM_TOOL_DEADLINE_ENFORCE: 'true' })).toBe(true)
  })
  it('DEFAULT_DEADLINE_CONFIG excludes human + background by default', () => {
    expect(DEFAULT_DEADLINE_CONFIG.standardMs).toBe(DEFAULT_STANDARD_DEADLINE_MS)
    expect(DEFAULT_DEADLINE_CONFIG.humanMs).toBe(Number.POSITIVE_INFINITY)
    expect(DEFAULT_DEADLINE_CONFIG.backgroundMs).toBe(Number.POSITIVE_INFINITY)
  })
})
