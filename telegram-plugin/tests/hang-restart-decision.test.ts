/**
 * Unit tests for the progress-based hang-restart discriminator (Stage B).
 *
 * The crux: a mid-tool framework fallback with a STALE turn-active marker
 * escalates to a real restart, but a fallback whose marker mtime keeps
 * advancing (a healthy long turn), OR whose in-flight tool is a known-long
 * class (Bash/WebFetch/Task/research — Finding A), must NOT be restarted.
 *
 * FAILS on current head: `../gateway/hang-restart-decision.js` does not exist
 * there — the discriminator is the contribution under test.
 */

import { describe, it, expect } from 'vitest'
import {
  decideHangRestart,
  isHangRestartProtectedTool,
  classifyToolClass,
  hangStalenessMs,
  DEFAULT_HANG_STALENESS_MS,
} from '../gateway/hang-restart-decision.js'

const STALE = 300_000

describe('decideHangRestart — the crux discriminator', () => {
  it('(1) tool mid-call + zero marker progress past the ceiling ⇒ restart requested', () => {
    const d = decideHangRestart({
      inFlightToolNames: ['some_mcp_tool'], // a standard, non-long tool
      markerAgeMs: 600_000, // 10 min since last observable progress
      stalenessThresholdMs: STALE,
    })
    expect(d.restart).toBe(true)
    expect(d.reason).toBe('mid-tool-marker-stale')
  })

  it('(2) a turn whose marker mtime keeps advancing is NOT restarted', () => {
    const d = decideHangRestart({
      inFlightToolNames: ['some_mcp_tool'],
      markerAgeMs: 4_000, // marker touched 4s ago — the turn is working
      stalenessThresholdMs: STALE,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toBe('marker-advancing')
  })

  it('a marker exactly at the staleness ceiling is stale ⇒ restart', () => {
    const d = decideHangRestart({
      inFlightToolNames: ['some_mcp_tool'],
      markerAgeMs: STALE,
      stalenessThresholdMs: STALE,
    })
    expect(d.restart).toBe(true)
  })

  it('an absent marker (no progress signal at all) is treated as stale ⇒ restart', () => {
    const d = decideHangRestart({
      inFlightToolNames: ['some_mcp_tool'],
      markerAgeMs: null,
      stalenessThresholdMs: STALE,
    })
    expect(d.restart).toBe(true)
  })

  it('a fallback that is NOT mid-tool never restarts (ordinary teardown owns it)', () => {
    const d = decideHangRestart({
      inFlightToolNames: [],
      markerAgeMs: null,
      stalenessThresholdMs: STALE,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toBe('not-mid-tool')
  })
})

describe('decideHangRestart — Finding A: protect known-long foreground tools', () => {
  it('a healthy long foreground Bash + stale marker is NOT restarted', () => {
    // The exact false-positive the review flagged: a 15-min foreground `Bash`
    // build/test never touches the marker, so at the ceiling it looks stale —
    // but it is genuinely working. It must be protected.
    const d = decideHangRestart({
      inFlightToolNames: ['Bash'],
      markerAgeMs: 900_000, // 15 min stale
      stalenessThresholdMs: STALE,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toBe('protected-long-tool:Bash')
  })

  it('WebFetch / Task / a research MCP tool + stale marker are NOT restarted', () => {
    for (const name of ['WebFetch', 'Task', 'Agent', 'perplexity_research', 'mcp__webkite__crawl']) {
      const d = decideHangRestart({
        inFlightToolNames: [name],
        markerAgeMs: 900_000,
        stalenessThresholdMs: STALE,
      })
      expect(d.restart, `${name} should be protected`).toBe(false)
      expect(d.reason).toContain('protected-long-tool')
    }
  })

  it('a protected long tool ALONGSIDE a standard tool still protects (conservative)', () => {
    const d = decideHangRestart({
      inFlightToolNames: ['quick_tool', 'Bash'],
      markerAgeMs: 900_000,
      stalenessThresholdMs: STALE,
    })
    expect(d.restart).toBe(false)
  })

  it('a genuinely-standard hung tool (no long class in flight) + stale ⇒ restart', () => {
    const d = decideHangRestart({
      inFlightToolNames: ['Read', 'some_mcp_query'],
      markerAgeMs: 900_000,
      stalenessThresholdMs: STALE,
    })
    expect(d.restart).toBe(true)
  })
})

describe('isHangRestartProtectedTool + classifyToolClass', () => {
  it('protects background / long-fetch / research / human classes', () => {
    for (const n of ['Task', 'Agent', 'Bash', 'WebFetch', 'WebSearch', 'ask_user',
      'perplexity_research', 'deep_research', 'mcp__webkite__crawl']) {
      expect(isHangRestartProtectedTool(n), n).toBe(true)
    }
  })
  it('does NOT protect ordinary quick tools', () => {
    for (const n of ['Read', 'Grep', 'Edit', 'Write', 'some_mcp_query']) {
      expect(isHangRestartProtectedTool(n), n).toBe(false)
    }
  })
  it('classifyToolClass taxonomy (ported from Stage A)', () => {
    expect(classifyToolClass('ask_user')).toBe('human')
    expect(classifyToolClass('Task')).toBe('background')
    expect(classifyToolClass('Bash', { backgroundBash: true })).toBe('background')
    expect(classifyToolClass('Read')).toBe('standard')
  })
})

describe('config helpers', () => {
  it('hangStalenessMs keys off TURN_HANG_SECS (seconds → ms), default 300s', () => {
    expect(hangStalenessMs({})).toBe(DEFAULT_HANG_STALENESS_MS)
    expect(hangStalenessMs({ TURN_HANG_SECS: '120' })).toBe(120_000)
    expect(hangStalenessMs({ TURN_HANG_SECS: 'nope' })).toBe(DEFAULT_HANG_STALENESS_MS)
    expect(hangStalenessMs({ TURN_HANG_SECS: '0' })).toBe(DEFAULT_HANG_STALENESS_MS)
  })
})
