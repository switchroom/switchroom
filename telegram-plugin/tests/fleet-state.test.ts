/**
 * P0 of #662 — pure-function unit tests for FleetMember transitions.
 *
 * These tests document the contract the renderer (P1) and the
 * background-persistence registry (P2) will rely on. The reducer is
 * intentionally side-effect-free; clocks and randomness are passed in.
 */

import { describe, it, expect } from 'vitest'

import {
  createFleetMember,
  applyToolUse,
  applyToolResult,
  applyTurnEnd,
  markStuck,
  cap,
  sanitiseToolArg,
  roleFromDispatch,
  type FleetMember,
} from '../fleet-state.js'

const T0 = 1_700_000_000_000

function freshMember(overrides: Partial<Parameters<typeof createFleetMember>[0]> = {}): FleetMember {
  return createFleetMember({
    agentId: 'a1',
    role: 'worker',
    startedAt: T0,
    originatingTurnKey: 'chat:thr:1',
    ...overrides,
  })
}

describe('createFleetMember', () => {
  it('initialises sane defaults', () => {
    const m = freshMember()
    expect(m.agentId).toBe('a1')
    expect(m.role).toBe('worker')
    expect(m.startedAt).toBe(T0)
    expect(m.toolCount).toBe(0)
    expect(m.lastActivityAt).toBe(T0)
    expect(m.lastTool).toBeNull()
    expect(m.status).toBe('running')
    expect(m.terminalAt).toBeNull()
    expect(m.errorSeen).toBe(false)
    expect(m.originatingTurnKey).toBe('chat:thr:1')
  })
})

describe('applyToolUse', () => {
  it('bumps toolCount and lastActivityAt; updates lastTool with sanitised arg', () => {
    const m0 = freshMember()
    const m1 = applyToolUse(m0, 'Read', { file_path: '/etc/secrets/foo.key' }, T0 + 100)
    expect(m1.toolCount).toBe(1)
    expect(m1.lastActivityAt).toBe(T0 + 100)
    expect(m1.lastTool).toEqual({ name: 'Read', sanitisedArg: 'foo.key' })
    const m2 = applyToolUse(m1, 'Bash', { command: 'ls' }, T0 + 200)
    expect(m2.toolCount).toBe(2)
    expect(m2.lastTool?.name).toBe('Bash')
  })

  it('does not mutate the input member', () => {
    const m0 = freshMember()
    applyToolUse(m0, 'Read', {}, T0 + 100)
    expect(m0.toolCount).toBe(0)
    expect(m0.lastTool).toBeNull()
  })
})

describe('applyToolResult', () => {
  it('flips errorSeen on isError=true', () => {
    const m = applyToolResult(freshMember(), true)
    expect(m.errorSeen).toBe(true)
  })
  it('keeps errorSeen=false when isError=false', () => {
    const m = applyToolResult(freshMember(), false)
    expect(m.errorSeen).toBe(false)
  })
  it('does not unset errorSeen once set', () => {
    const m1 = applyToolResult(freshMember(), true)
    const m2 = applyToolResult(m1, false)
    expect(m2.errorSeen).toBe(true)
  })
})

describe('applyTurnEnd', () => {
  it('marks done if no errors seen', () => {
    const m = applyTurnEnd(freshMember(), T0 + 500)
    expect(m.status).toBe('done')
    expect(m.terminalAt).toBe(T0 + 500)
  })
  it('marks failed if errorSeen', () => {
    const m0 = applyToolResult(freshMember(), true)
    const m1 = applyTurnEnd(m0, T0 + 500)
    expect(m1.status).toBe('failed')
    expect(m1.terminalAt).toBe(T0 + 500)
  })
})

describe('markStuck', () => {
  it('flips running → stuck after idleMs threshold', () => {
    const m0 = freshMember()
    const m1 = markStuck(m0, T0 + 60_001, 60_000)
    expect(m1.status).toBe('stuck')
  })
  it('is no-op when not yet idle long enough', () => {
    const m0 = freshMember()
    const m1 = markStuck(m0, T0 + 59_000, 60_000)
    expect(m1.status).toBe('running')
  })
  it('is idempotent on terminal states', () => {
    const done = applyTurnEnd(freshMember(), T0 + 100)
    const stillDone = markStuck(done, T0 + 999_999, 60_000)
    expect(stillDone.status).toBe('done')
  })
  it('is idempotent on already-stuck', () => {
    const m0 = freshMember()
    const m1 = markStuck(m0, T0 + 60_001, 60_000)
    const m2 = markStuck(m1, T0 + 120_000, 60_000)
    expect(m2.status).toBe('stuck')
    // No new mutation churn — same object reference is fine but not required
  })
})

describe('cap', () => {
  it('orders by lastActivityAt desc and reports hidden count', () => {
    const members: FleetMember[] = [
      { ...freshMember({ agentId: 'a' }), lastActivityAt: T0 + 100 },
      { ...freshMember({ agentId: 'b' }), lastActivityAt: T0 + 500 },
      { ...freshMember({ agentId: 'c' }), lastActivityAt: T0 + 300 },
      { ...freshMember({ agentId: 'd' }), lastActivityAt: T0 + 900 },
      { ...freshMember({ agentId: 'e' }), lastActivityAt: T0 + 700 },
      { ...freshMember({ agentId: 'f' }), lastActivityAt: T0 + 50 },
      { ...freshMember({ agentId: 'g' }), lastActivityAt: T0 + 800 },
    ]
    const { visible, hidden } = cap(members, 5)
    expect(visible.map((m) => m.agentId)).toEqual(['d', 'g', 'e', 'b', 'c'])
    expect(hidden).toBe(2)
  })
  it('hidden=0 when under cap', () => {
    const members: FleetMember[] = [freshMember({ agentId: 'a' })]
    const { visible, hidden } = cap(members, 5)
    expect(visible.length).toBe(1)
    expect(hidden).toBe(0)
  })
})

describe('sanitiseToolArg', () => {
  it('basenames absolute file paths', () => {
    expect(sanitiseToolArg('Read', { file_path: '/etc/secrets/foo.key' })).toBe('foo.key')
  })
  it('basenames Edit/Write targets', () => {
    expect(sanitiseToolArg('Edit', { file_path: '/home/u/code/x.ts' })).toBe('x.ts')
    expect(sanitiseToolArg('Write', { file_path: '/tmp/out.json' })).toBe('out.json')
  })
  it('redacts bearer-token-like strings in Bash commands', () => {
    const out = sanitiseToolArg('Bash', { command: 'curl -H "Authorization: Bearer sk-ant-1234567890abcdef" https://x' })
    expect(out).not.toContain('sk-ant-1234567890abcdef')
    expect(out.toLowerCase()).toContain('redacted')
  })
  it('returns empty string when no recognisable arg', () => {
    expect(sanitiseToolArg('Unknown', {})).toBe('')
  })
  it('truncates very long args', () => {
    const long = 'x'.repeat(500)
    const out = sanitiseToolArg('Bash', { command: long })
    expect(out.length).toBeLessThanOrEqual(120)
  })
})

describe('roleFromDispatch', () => {
  it('prefers description', () => {
    expect(roleFromDispatch('Run tests', 'general-purpose', 'Please run')).toBe('Run tests')
  })
  it('falls back to subagentType', () => {
    expect(roleFromDispatch(undefined, 'researcher', 'Find facts')).toBe('researcher')
  })
  it('falls back to first 20 chars of firstPromptText', () => {
    expect(roleFromDispatch(undefined, undefined, 'Find me the truth about everything')).toBe('Find me the truth ab')
  })
  it('falls back to "agent" when nothing supplied', () => {
    expect(roleFromDispatch(undefined, undefined, '')).toBe('agent')
  })
})
