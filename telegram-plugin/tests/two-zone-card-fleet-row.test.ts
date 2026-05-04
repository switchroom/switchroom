/**
 * P1 of #662 — fleet row formatting: id6 truncation, role fallback,
 * terminal status suffix, glyph mapping.
 */

import { describe, it, expect } from 'vitest'
import {
  renderFleetRow,
  glyphForFleetStatus,
  formatRelativeTime,
} from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'

function fm(over: Partial<FleetMember>): FleetMember {
  return {
    agentId: 'abcdef0123456789',
    role: 'agent',
    startedAt: 0,
    toolCount: 0,
    lastActivityAt: 1000,
    lastTool: null,
    status: 'running',
    terminalAt: null,
    errorSeen: false,
    originatingTurnKey: 'k',
    ...over,
  }
}

describe('glyphForFleetStatus', () => {
  it('maps every status to a glyph', () => {
    expect(glyphForFleetStatus('running')).toBe('↻')
    expect(glyphForFleetStatus('background')).toBe('⏸')
    expect(glyphForFleetStatus('done')).toBe('✓')
    expect(glyphForFleetStatus('failed')).toBe('✗')
    expect(glyphForFleetStatus('stuck')).toBe('⚠')
    expect(glyphForFleetStatus('killed')).toBe('✗')
  })
})

describe('formatRelativeTime', () => {
  it('seconds under 60', () => {
    expect(formatRelativeTime(3000)).toBe('3s ago')
  })
  it('minutes + seconds', () => {
    expect(formatRelativeTime(72_000)).toBe('1m12s ago')
  })
  it('zero', () => {
    expect(formatRelativeTime(0)).toBe('0s ago')
  })
})

describe('renderFleetRow', () => {
  const NOW = 10_000

  it('uses 6-char id slice', () => {
    const out = renderFleetRow(fm({ agentId: 'abcdef0123456789' }), NOW)
    expect(out).toContain('abcdef')
    expect(out).not.toContain('abcdef0')
  })

  it('renders running with last tool + age', () => {
    const out = renderFleetRow(fm({
      lastActivityAt: NOW - 5000,
      lastTool: { name: 'Read', sanitisedArg: 'file.ts' },
      toolCount: 3,
    }), NOW)
    expect(out).toContain('Read')
    expect(out).toContain('file.ts')
    expect(out).toContain('5s ago')
    expect(out).toContain('3t')
    expect(out.startsWith('↻')).toBe(true)
  })

  it('renders terminal done with relative time', () => {
    const out = renderFleetRow(fm({
      status: 'done',
      terminalAt: NOW - 12_000,
      lastActivityAt: NOW - 12_000,
    }), NOW)
    expect(out).toContain('done 12s ago')
    expect(out.startsWith('✓')).toBe(true)
  })

  it('renders failed terminal with status suffix', () => {
    const out = renderFleetRow(fm({
      status: 'failed',
      terminalAt: NOW - 3000,
      lastActivityAt: NOW - 3000,
      errorSeen: true,
    }), NOW)
    expect(out).toContain('failed 3s ago')
    expect(out.startsWith('✗')).toBe(true)
  })

  it('falls back when no lastTool yet', () => {
    const out = renderFleetRow(fm({ lastActivityAt: NOW }), NOW)
    expect(out).toContain('↻')
    expect(out).toContain('agent')
  })
})
