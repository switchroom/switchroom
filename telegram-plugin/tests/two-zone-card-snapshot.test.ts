/**
 * P1 of #662 — golden snapshots for 4 canonical card states.
 */

import { describe, it, expect } from 'vitest'
import { renderTwoZoneCard } from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'
import type { ProgressCardState } from '../progress-card.js'

function st(over: Partial<ProgressCardState> & { stage: ProgressCardState['stage'] }): ProgressCardState {
  return {
    turnStartedAt: 0,
    items: [],
    narratives: [],
    stage: over.stage,
    thinking: false,
    subAgents: new Map(),
    pendingAgentSpawns: new Map(),
    tasks: [],
    ...over,
  }
}

function fm(over: Partial<FleetMember>): FleetMember {
  return {
    agentId: 'aaaaaa00',
    role: 'agent',
    startedAt: 0,
    toolCount: 0,
    lastActivityAt: 0,
    lastTool: null,
    status: 'running',
    terminalAt: null,
    errorSeen: false,
    originatingTurnKey: 'k',
    ...over,
  }
}

const NOW = 60_000

describe('two-zone-card snapshots', () => {
  it('empty fleet — clean clerk-style card', () => {
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 5000 }),
      fleet: new Map(),
      now: NOW,
    })
    expect(out).toMatchSnapshot()
  })

  it('3 members mixed', () => {
    const fleet = new Map([
      ['a', fm({ agentId: 'aaaaaa01', role: 'researcher', status: 'running', toolCount: 4, lastActivityAt: NOW - 2000, lastTool: { name: 'Grep', sanitisedArg: 'TODO' } })],
      ['b', fm({ agentId: 'bbbbbb02', role: 'worker', status: 'done', toolCount: 8, lastActivityAt: NOW - 10_000, terminalAt: NOW - 10_000 })],
      ['c', fm({ agentId: 'cccccc03', role: 'reviewer', status: 'stuck', toolCount: 2, lastActivityAt: NOW - 70_000, lastTool: { name: 'Read', sanitisedArg: 'big.ts' } })],
    ])
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 30_000 }),
      fleet,
      now: NOW,
    })
    expect(out).toMatchSnapshot()
  })

  it('all-done with completed receipts', () => {
    const fleet = new Map([
      ['a', fm({ agentId: 'aaaaaa01', role: 'worker', status: 'done', toolCount: 5, lastActivityAt: NOW - 10_000, terminalAt: NOW - 10_000 })],
      ['b', fm({ agentId: 'bbbbbb02', role: 'reviewer', status: 'done', toolCount: 3, lastActivityAt: NOW - 5000, terminalAt: NOW - 5000 })],
    ])
    const out = renderTwoZoneCard({
      state: st({ stage: 'done', turnStartedAt: NOW - 20_000 }),
      fleet,
      now: NOW,
    })
    expect(out).toMatchSnapshot()
  })

  it('all-stuck', () => {
    const fleet = new Map([
      ['a', fm({ agentId: 'aaaaaa01', role: 'worker', status: 'stuck', toolCount: 1, lastActivityAt: NOW - 90_000, lastTool: { name: 'Bash', sanitisedArg: 'sleep 999' } })],
      ['b', fm({ agentId: 'bbbbbb02', role: 'worker', status: 'stuck', toolCount: 1, lastActivityAt: NOW - 80_000, lastTool: { name: 'Bash', sanitisedArg: 'sleep 999' } })],
    ])
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 95_000 }),
      fleet,
      now: NOW,
    })
    expect(out).toMatchSnapshot()
  })
})
