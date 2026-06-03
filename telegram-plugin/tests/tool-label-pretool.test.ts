/**
 * Tests for computeLabel in telegram-plugin/hooks/tool-label-pretool.mjs —
 * the PreToolUse hook that drives the live activity feed's per-tool labels.
 *
 * Focus: the MCP generic fallback. Previously the hook allowlisted only
 * switchroom-telegram + hindsight and returned null for every other MCP
 * tool, so a research turn driven by operator-configured MCP servers
 * (perplexity, webkite, …) produced NO activity-feed entries — the user
 * saw only a typing dot + reaction (the "I can't see what it's doing"
 * report). The fallback now mirrors the gateway's describeToolUse.
 */

import { describe, it, expect } from 'vitest'
import { computeLabel } from '../hooks/tool-label-pretool.mjs'

describe('computeLabel — built-in + known MCP (regression)', () => {
  it('labels common built-in tools', () => {
    expect(computeLabel('Bash', { description: 'Run the tests' })).toBe('Run the tests')
    expect(computeLabel('Read', { file_path: '/x/CLAUDE.md' })).toBe('Reading CLAUDE.md')
    expect(computeLabel('WebSearch', { query: 'tasmania weather' })).toBe(
      'Searching the web for tasmania weather',
    )
    expect(computeLabel('ToolSearch', {})).toBe('Finding the right tool')
  })

  it('labels / suppresses the built-in MCP servers as before', () => {
    expect(computeLabel('mcp__switchroom-telegram__reply', {})).toBe('Replying')
    expect(computeLabel('mcp__hindsight__recall', {})).toBe('Searching memory')
    // surface/control tools are the conversation — never labeled
    expect(computeLabel('mcp__switchroom-telegram__send_typing', {})).toBeNull()
    expect(computeLabel('mcp__hindsight__sync_retain', {})).toBeNull()
    // an UNlisted switchroom-telegram tool must still be suppressed
    expect(computeLabel('mcp__switchroom-telegram__progress_update', {})).toBeNull()
  })
})

describe('computeLabel — MCP generic fallback (the fix)', () => {
  it('surfaces operator research tools that used to be invisible', () => {
    // perplexity — the exact case behind the silent research turn
    expect(computeLabel('mcp__perplexity__perplexity_search', { query: 'hobart forecast' })).toBe(
      'Searching the web for hobart forecast',
    )
    expect(computeLabel('mcp__perplexity__perplexity_ask', {})).toBe('Searching the web')
    // webkite read
    expect(computeLabel('mcp__webkite__webkite_read', { url: 'https://bom.gov.au/tas' })).toBe(
      'Reading bom.gov.au/tas',
    )
    expect(computeLabel('mcp__webkite__webkite_read', {})).toBe('Reading the web')
  })

  it('gives friendly labels for known workspace servers', () => {
    expect(computeLabel('mcp__gdrive__search', {})).toBe('Looking through your files')
    expect(computeLabel('mcp__claude_ai_gmail__list', {})).toBe('Checking your email')
    expect(computeLabel('mcp__notion__notion-search', {})).toBe('Checking your notes')
  })

  it('falls back to a model-authored field, else a humanized tool name', () => {
    expect(computeLabel('mcp__acme__do_thing', { description: 'Crunching the numbers' })).toBe(
      'Crunching the numbers',
    )
    expect(computeLabel('mcp__acme__fetch_invoices', {})).toBe('Using fetch invoices')
  })

  it('NEVER returns null for a generic MCP tool (the regression that hid research)', () => {
    // The whole point: an unknown MCP tool must produce SOME label now.
    expect(computeLabel('mcp__perplexity__perplexity_ask', {})).not.toBeNull()
    expect(computeLabel('mcp__webkite__webkite_read', {})).not.toBeNull()
    expect(computeLabel('mcp__some_new_server__some_tool', {})).not.toBeNull()
  })
})
