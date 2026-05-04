/**
 * P1 of #662 — phaseFor truth table.
 *
 * Drives the `phaseFor(state, fleet)` resolver across the 6-row spec
 * table from `reference/status-card-design.md` plus edge cases that
 * have historically been mis-classified (parent-stalled-fleet-active,
 * parent-done-fg-failed-bg-running, reply-and-fleet, sub-text-only).
 */

import { describe, it, expect } from 'vitest'
import { phaseFor } from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'
import type { ProgressCardState } from '../progress-card.js'

function fm(id: string, status: FleetMember['status'], lastActivityAt: number = 1000): FleetMember {
  return {
    agentId: id,
    role: 'agent',
    startedAt: 0,
    toolCount: 0,
    lastActivityAt,
    lastTool: null,
    status,
    terminalAt: status === 'done' || status === 'failed' || status === 'killed' ? lastActivityAt : null,
    errorSeen: status === 'failed',
    originatingTurnKey: 'k',
  }
}

function st(opts: Partial<ProgressCardState> & { stage: ProgressCardState['stage'] }): ProgressCardState {
  return {
    turnStartedAt: 1,
    items: [],
    narratives: [],
    stage: opts.stage,
    thinking: false,
    subAgents: new Map(),
    pendingAgentSpawns: new Map(),
    tasks: [],
    ...opts,
  }
}

const fleetOf = (...members: FleetMember[]) => new Map(members.map((m) => [m.agentId, m]))

const NOW = 100_000

describe('phaseFor truth table', () => {
  it.each([
    // [name, state, fleet, opts, expectedLabel]
    ['working: parent in flight, no fleet', st({ stage: 'run' }), new Map(), {}, 'Working…'],
    ['working: parent in flight + fleet running', st({ stage: 'run' }), fleetOf(fm('a', 'running', NOW)), {}, 'Working…'],
    ['background: parent done, bg running', st({ stage: 'done' }), fleetOf(fm('a', 'running', NOW)), { parentDone: true }, 'Background'],
    ['background: parentDone flag + fg running', st({ stage: 'run' }), fleetOf(fm('a', 'running', NOW)), { parentDone: true }, 'Background'],
    ['stalled: parent idle + all fleet stuck', st({ stage: 'run' }), fleetOf(fm('a', 'stuck', 0), fm('b', 'stuck', 0)), {}, 'Stalled'],
    ['done: parent done + all fleet terminal', st({ stage: 'done' }), fleetOf(fm('a', 'done'), fm('b', 'failed')), {}, 'Done'],
    ['done: parent done, no fleet', st({ stage: 'done' }), new Map(), {}, 'Done'],
    ['silent: parent terminal + no reply', st({ stage: 'done' }), new Map(), { silentEnd: true }, 'Ended without reply'],
    ['forced close: stalledClose flag wins', st({ stage: 'done' }), fleetOf(fm('a', 'done')), { stalledClose: true }, 'Forced close'],
    // Edge cases
    ['parent-done + fg-failed + bg-running → Background, not Done', st({ stage: 'done' }), fleetOf(fm('a', 'failed'), fm('b', 'running', NOW)), { parentDone: true }, 'Background'],
    ['mixed terminal+stuck → not Done', st({ stage: 'run' }), fleetOf(fm('a', 'done'), fm('b', 'stuck', 0)), {}, 'Stalled'],
    ['reply tool fired AND fleet running → Background (parentDone)', st({ stage: 'done' }), fleetOf(fm('a', 'running', NOW)), { parentDone: true }, 'Background'],
  ])('%s', (_name, state, fleet, opts, expectedLabel) => {
    const phase = phaseFor(state, fleet, NOW, opts as Record<string, unknown>)
    expect(phase.label).toBe(expectedLabel)
  })
})
