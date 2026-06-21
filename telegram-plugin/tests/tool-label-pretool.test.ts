/**
 * Unit coverage for `computeLabel` — the PreToolUse hook formatter that feeds
 * the live foreground activity feed.
 *
 * Pins two load-bearing invariants that are easy to regress together:
 *
 *  1. NEVER-NULL for a real, surfaceable tool. A null label writes no sidecar
 *     line, so no `tool_label` event fires, so the activity feed never opens.
 *     If such a tool is a turn's first/only tool, a working turn reads as pure
 *     silence — the "dark turn" report. Any unrecognized built-in tool (and a
 *     degenerate empty-slug Skill) must still produce a label.
 *
 *  2. SURFACE/CONTROL tools stay suppressed. `send_typing` and `sync_retain`
 *     must return null at the hook so they never emit a sidecar row. The
 *     never-null fallthrough must NOT resurface them (the feed-below-answer
 *     regression class). Conversation surface tools (reply/react) ARE labelled
 *     here but the gateway drops them via its own `isTelegramSurfaceTool`
 *     guard — out of scope for this file, which only pins the hook contract.
 */
import { describe, expect, it } from 'vitest'
// computeLabel is exported; the module self-guards main() so import is safe.
import { computeLabel } from '../hooks/tool-label-pretool.mjs'

describe('computeLabel — never-null invariant', () => {
  it('labels an unrecognized built-in tool rather than returning null', () => {
    // A tool with no mcp__ prefix that matches none of the switch arms used
    // to fall through to `return null` → the dark-turn mechanism.
    expect(computeLabel('SomeFutureBuiltinTool', {})).toBe('Working…')
    expect(computeLabel('ExitPlanMode', {})).toBe('Working…')
  })

  it('labels a Skill call with an empty slug', () => {
    expect(computeLabel('Skill', {})).toBe('Running a skill')
    expect(computeLabel('Skill', { skill: '' })).toBe('Running a skill')
  })

  it('still uses the slug when a Skill provides one', () => {
    expect(computeLabel('Skill', { skill: 'code-review' })).toBe(
      'Running skill code-review',
    )
  })

  it('labels known built-in tools normally', () => {
    expect(computeLabel('Bash', { command: 'ls' })).toBeTruthy()
    expect(computeLabel('Read', { file_path: '/tmp/x' })).toBeTruthy()
  })

  it('labels an unknown MCP tool generically (never null)', () => {
    const label = computeLabel('mcp__someserver__do_thing', {})
    expect(label).toBeTruthy()
    expect(label).not.toBeNull()
  })
})

describe('computeLabel — surface/control suppression (H2 guard)', () => {
  it('suppresses send_typing and sync_retain at the hook (returns null)', () => {
    expect(computeLabel('mcp__switchroom-telegram__send_typing', {})).toBeNull()
    expect(computeLabel('mcp__hindsight__sync_retain', { content: 'x' })).toBeNull()
  })

  it('suppresses any other switchroom-telegram tool not explicitly labelled', () => {
    expect(
      computeLabel('mcp__switchroom-telegram__delete_message', {}),
    ).toBeNull()
  })
})
