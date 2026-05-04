/**
 * P1 of #662 — fleet zone caps at 5 visible rows; surplus collapses
 * to "+ N more" footer. Order is most-recent-activity first.
 */

import { describe, it, expect } from 'vitest'
import { renderFleetZone } from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'

function fm(id: string, lastActivityAt: number): FleetMember {
  return {
    agentId: id,
    role: 'role-' + id,
    startedAt: 0,
    toolCount: 1,
    lastActivityAt,
    lastTool: { name: 'Read', sanitisedArg: 'x.ts' },
    status: 'running',
    terminalAt: null,
    errorSeen: false,
    originatingTurnKey: 'k',
  }
}

describe('renderFleetZone cap', () => {
  it('returns empty string for empty fleet', () => {
    expect(renderFleetZone(new Map(), 0)).toBe('')
  })

  it('renders all rows for fleet ≤ 5', () => {
    const fleet = new Map([
      ['a', fm('aaaaaa', 100)],
      ['b', fm('bbbbbb', 200)],
      ['c', fm('cccccc', 300)],
    ])
    const out = renderFleetZone(fleet, 1000)
    expect(out).toContain('FLEET (3)')
    expect(out).toContain('aaaaaa')
    expect(out).toContain('bbbbbb')
    expect(out).toContain('cccccc')
    expect(out).not.toContain('more')
  })

  it('caps at 5 with "+ N more" footer for fleet > 5, ordered most-recent-first', () => {
    const fleet = new Map<string, FleetMember>()
    for (let i = 0; i < 7; i++) {
      const id = `agent${i}xx`
      fleet.set(id, fm(id, 100 + i))
    }
    const out = renderFleetZone(fleet, 1000)
    expect(out).toContain('FLEET (7)')
    expect(out).toContain('+ 2 more')
    // Most-recent activity (i=6, ts=106) must appear; oldest two (i=0, i=1) must not
    expect(out).toContain('agent6')
    expect(out).toContain('agent2')
    expect(out).not.toContain('agent0')
    expect(out).not.toContain('agent1')
    // Count visible rows by counting status glyphs at row starts
    const rowLines = out.split('\n').filter((l) => l.startsWith('↻'))
    expect(rowLines.length).toBe(5)
  })
})
