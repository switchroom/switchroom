/**
 * Unit tests for the deferred safe-boundary interrupt core (Problem B).
 *
 * The gateway-side wiring (timer, SIGINT-via-tmux, sendToAgent resume,
 * coalescing) is exercised by integration; these pin the pure decision:
 *   - ToolFlightTracker correctly tracks open tool calls by toolUseId and
 *     clears on turn_end / a fresh enqueue.
 *   - decideInterruptTiming returns fire-now unless the flag is on AND a tool
 *     is in flight.
 *   - resolveInterruptMaxWaitMs never yields a non-positive / forever wait.
 */

import { describe, it, expect } from 'vitest'
import {
  ToolFlightTracker,
  decideInterruptTiming,
  resolveInterruptMaxWaitMs,
  resolveSafeBoundaryEnabled,
  DEFAULT_INTERRUPT_MAX_WAIT_MS,
} from '../gateway/interrupt-defer.js'

describe('ToolFlightTracker', () => {
  it('starts at a safe boundary (no tools in flight)', () => {
    const t = new ToolFlightTracker()
    expect(t.isMidToolCall()).toBe(false)
    expect(t.inFlightCount()).toBe(0)
  })

  it('a tool_use opens an unsafe boundary; its tool_result closes it', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'tool_use', toolUseId: 'tu_1' })
    expect(t.isMidToolCall()).toBe(true)
    t.onEvent({ kind: 'tool_result', toolUseId: 'tu_1' })
    expect(t.isMidToolCall()).toBe(false)
  })

  it('stays unsafe while ANY of several parallel tools is open', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'tool_use', toolUseId: 'a' })
    t.onEvent({ kind: 'tool_use', toolUseId: 'b' })
    t.onEvent({ kind: 'tool_use', toolUseId: 'c' })
    expect(t.inFlightCount()).toBe(3)
    t.onEvent({ kind: 'tool_result', toolUseId: 'b' })
    t.onEvent({ kind: 'tool_result', toolUseId: 'a' })
    expect(t.isMidToolCall()).toBe(true) // c still open
    t.onEvent({ kind: 'tool_result', toolUseId: 'c' })
    expect(t.isMidToolCall()).toBe(false)
  })

  it('turn_end clears any residual in-flight tools', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'tool_use', toolUseId: 'tu_1' })
    t.onEvent({ kind: 'tool_use', toolUseId: 'tu_2' })
    t.onEvent({ kind: 'turn_end' })
    expect(t.isMidToolCall()).toBe(false)
  })

  it('a fresh enqueue clears the slate (new turn starts clean)', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'tool_use', toolUseId: 'tu_1' })
    t.onEvent({ kind: 'enqueue' })
    expect(t.isMidToolCall()).toBe(false)
  })

  it('ignores sub-agent and non-tool events', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'sub_agent_tool_use', toolUseId: 'sub_1' })
    t.onEvent({ kind: 'thinking' })
    t.onEvent({ kind: 'text' })
    t.onEvent({ kind: 'tool_label', toolUseId: 'tu_x' })
    expect(t.isMidToolCall()).toBe(false)
  })

  it('ignores tool_use with a missing / empty toolUseId', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'tool_use' })
    t.onEvent({ kind: 'tool_use', toolUseId: null })
    t.onEvent({ kind: 'tool_use', toolUseId: '' })
    expect(t.isMidToolCall()).toBe(false)
  })

  it('tool_result for an unknown id is a harmless no-op', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'tool_use', toolUseId: 'real' })
    t.onEvent({ kind: 'tool_result', toolUseId: 'never-opened' })
    expect(t.isMidToolCall()).toBe(true) // 'real' still open
  })

  it('clear() resets the tracker', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'tool_use', toolUseId: 'tu_1' })
    t.clear()
    expect(t.isMidToolCall()).toBe(false)
  })
})

describe('decideInterruptTiming', () => {
  it('fires now when the flag is off, even mid-tool-call', () => {
    expect(
      decideInterruptTiming({ safeBoundaryEnabled: false, midToolCall: true }),
    ).toBe('fire-now')
  })

  it('fires now when the flag is on but no tool is in flight', () => {
    expect(
      decideInterruptTiming({ safeBoundaryEnabled: true, midToolCall: false }),
    ).toBe('fire-now')
  })

  it('defers only when the flag is on AND a tool is in flight', () => {
    expect(
      decideInterruptTiming({ safeBoundaryEnabled: true, midToolCall: true }),
    ).toBe('defer')
  })

  it('fires now in the fully-off case', () => {
    expect(
      decideInterruptTiming({ safeBoundaryEnabled: false, midToolCall: false }),
    ).toBe('fire-now')
  })
})

describe('resolveSafeBoundaryEnabled (default ON)', () => {
  it('defaults to true when unset', () => {
    expect(resolveSafeBoundaryEnabled(undefined)).toBe(true)
  })
  it('stays true when explicitly true', () => {
    expect(resolveSafeBoundaryEnabled(true)).toBe(true)
  })
  it('only an explicit false opts out', () => {
    expect(resolveSafeBoundaryEnabled(false)).toBe(false)
  })
})

describe('resolveInterruptMaxWaitMs', () => {
  it('uses the configured value when positive', () => {
    expect(resolveInterruptMaxWaitMs(3000)).toBe(3000)
  })

  it('falls back to the default when undefined', () => {
    expect(resolveInterruptMaxWaitMs(undefined)).toBe(DEFAULT_INTERRUPT_MAX_WAIT_MS)
  })

  it('never returns a non-positive wait (no forever-wait)', () => {
    expect(resolveInterruptMaxWaitMs(0)).toBe(DEFAULT_INTERRUPT_MAX_WAIT_MS)
    expect(resolveInterruptMaxWaitMs(-1)).toBe(DEFAULT_INTERRUPT_MAX_WAIT_MS)
  })

  it('models the lifecycle: open tool → defer; tool_result → safe → fire', () => {
    const t = new ToolFlightTracker()
    t.onEvent({ kind: 'tool_use', toolUseId: 'w1' })
    // `!` lands here, flag on:
    expect(
      decideInterruptTiming({ safeBoundaryEnabled: true, midToolCall: t.isMidToolCall() }),
    ).toBe('defer')
    // tool completes:
    t.onEvent({ kind: 'tool_result', toolUseId: 'w1' })
    expect(t.isMidToolCall()).toBe(false) // gateway fires the parked interrupt here
  })
})
