/**
 * Unit tests for the computeLabel function in hooks/tool-label-pretool.mjs.
 *
 * These tests verify:
 *   1. computeLabel returns non-null for unknown built-in tools (never-null fallthrough)
 *   2. computeLabel returns non-null for unknown MCP tools (humanized name fallback)
 *   3. Surface-tool suppression works for non-switchroom-telegram telegram-suffixed keys
 *      (e.g. clerk-telegram, custom fork) — not just the hardcoded "switchroom-telegram"
 */

import { describe, it, expect } from 'vitest'
// The hook exports computeLabel for unit testing (see "Skip main() when imported" guard).
import { computeLabel } from '../hooks/tool-label-pretool.mjs'

describe('computeLabel — never-null built-in fallthrough', () => {
  it('returns non-null for an unrecognized built-in tool', () => {
    // A future Claude built-in tool that the hook doesn't know about yet.
    // The never-null fallthrough must prevent a dark-turn (no feed, no label).
    expect(computeLabel('SomeFutureBuiltin', {})).not.toBeNull()
    // Must be a non-empty string too.
    expect(computeLabel('SomeFutureBuiltin', {})).toBeTruthy()
  })

  it('returns non-null for an unknown MCP tool (operator-configured server)', () => {
    // An operator-installed MCP server the hook has no explicit label for.
    // Falls through to the humanized-name fallback: "Using dothing".
    expect(computeLabel('mcp__brandnew__dothing', {})).not.toBeNull()
    expect(computeLabel('mcp__brandnew__dothing', {})).toBeTruthy()
  })

  it('humanizes the tool name for an unknown MCP tool with no description', () => {
    expect(computeLabel('mcp__brandnew__dothing', {})).toBe('Using dothing')
    expect(computeLabel('mcp__acme_corp__send_message', {})).toBe('Using send message')
  })

  it('uses the model-authored description for an unknown MCP tool when present', () => {
    expect(
      computeLabel('mcp__brandnew__dothing', { description: 'Fetched the quarterly report' }),
    ).toBe('Fetched the quarterly report')
  })
})

describe('computeLabel — surface-tool suppression is key-agnostic', () => {
  it('returns null for telegram reply under any registration key', () => {
    // Standard switchroom-telegram key.
    expect(computeLabel('mcp__switchroom-telegram__reply', {})).toBeNull()

    // Legacy clerk-telegram key — same plugin, different registration name.
    expect(computeLabel('mcp__clerk-telegram__reply', {})).toBeNull()

    // Hypothetical custom fork.
    expect(computeLabel('mcp__my-custom-telegram__reply', {})).toBeNull()
  })

  it('returns null for telegram react under any registration key', () => {
    expect(computeLabel('mcp__switchroom-telegram__react', {})).toBeNull()
    expect(computeLabel('mcp__clerk-telegram__react', {})).toBeNull()
  })

  it('returns null for telegram send_typing under any registration key', () => {
    expect(computeLabel('mcp__switchroom-telegram__send_typing', {})).toBeNull()
    expect(computeLabel('mcp__clerk-telegram__send_typing', {})).toBeNull()
  })

  it('returns a label (not null) for telegram get_recent_messages', () => {
    // get_recent_messages is a read/query tool, not a surface tool — it should be labeled.
    expect(computeLabel('mcp__switchroom-telegram__get_recent_messages', {})).toBe('Reading chat history')
    expect(computeLabel('mcp__clerk-telegram__get_recent_messages', {})).toBe('Reading chat history')
  })
})
