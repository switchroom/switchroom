/**
 * Unit tests for the switchroom-telegram tool-surface right-sizing (P4):
 * connection gating of linear_* (A) + per-tool alwaysLoad pins for the hot
 * path (B). Pure function — no bridge.ts import (which has side effects).
 */

import { describe, it, expect } from 'bun:test'
import {
  buildEffectiveToolSchemas,
  ALWAYS_LOAD_TOOLS,
  LINEAR_TOOLS,
  type NamedTool,
} from '../bridge/tool-filter.js'

// A representative slice mirroring the real TOOL_SCHEMAS names.
const SAMPLE: NamedTool[] = [
  { name: 'reply', description: 'r' },
  { name: 'get_recent_messages', description: 'g' },
  { name: 'react', description: 'k' },
  { name: 'edit_message', description: 'e' },
  { name: 'send_typing', description: 't' },
  { name: 'download_attachment', description: 'd' },
  { name: 'ask_user', description: 'a' }, // cold
  { name: 'send_gif', description: 'gif' }, // cold
  { name: 'vault_request_access', description: 'v' }, // cold
  { name: 'linear_agent_activity', description: 'la' },
  { name: 'linear_create_issue', description: 'lc' },
  { name: 'linear_agent_setup', description: 'ls' },
]

const names = (tools: NamedTool[]) => tools.map((t) => t.name)
const metaOf = (tools: Array<NamedTool & { _meta?: unknown }>, n: string) =>
  tools.find((t) => t.name === n)?._meta

describe('buildEffectiveToolSchemas — connection gating (A)', () => {
  it('drops all linear_* tools when Linear is NOT enabled', () => {
    const out = buildEffectiveToolSchemas(SAMPLE, { linearEnabled: false })
    for (const t of LINEAR_TOOLS) expect(names(out)).not.toContain(t)
    // non-linear tools all survive
    expect(names(out)).toContain('reply')
    expect(names(out)).toContain('ask_user')
    expect(out.length).toBe(SAMPLE.length - LINEAR_TOOLS.size)
  })

  it('keeps linear_* tools when Linear IS enabled', () => {
    const out = buildEffectiveToolSchemas(SAMPLE, { linearEnabled: true })
    for (const t of LINEAR_TOOLS) expect(names(out)).toContain(t)
    expect(out.length).toBe(SAMPLE.length)
  })
})

describe('buildEffectiveToolSchemas — per-tool deferral pins (B)', () => {
  it('pins exactly the hot tools with _meta anthropic/alwaysLoad', () => {
    const out = buildEffectiveToolSchemas(SAMPLE, { linearEnabled: true })
    for (const hot of ALWAYS_LOAD_TOOLS) {
      expect(metaOf(out, hot)).toEqual({ 'anthropic/alwaysLoad': true })
    }
  })

  it('the reply path (reply) is ALWAYS pinned — never defers', () => {
    const out = buildEffectiveToolSchemas(SAMPLE, { linearEnabled: false })
    expect(metaOf(out, 'reply')).toEqual({ 'anthropic/alwaysLoad': true })
  })

  it('cold tools carry NO _meta (so they defer under tool-search)', () => {
    const out = buildEffectiveToolSchemas(SAMPLE, { linearEnabled: true })
    for (const cold of ['ask_user', 'send_gif', 'vault_request_access', 'linear_create_issue']) {
      expect(metaOf(out, cold)).toBeUndefined()
    }
  })
})

describe('buildEffectiveToolSchemas — purity', () => {
  it('does not mutate the input array or its objects', () => {
    const input: NamedTool[] = [{ name: 'reply' }, { name: 'send_gif' }]
    const snapshot = JSON.stringify(input)
    buildEffectiveToolSchemas(input, { linearEnabled: true })
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('preserves order', () => {
    const out = buildEffectiveToolSchemas(SAMPLE, { linearEnabled: true })
    expect(names(out)).toEqual(names(SAMPLE))
  })
})
