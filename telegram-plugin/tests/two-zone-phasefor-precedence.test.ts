/**
 * PR-A — phaseFor precedence: silent-end must be lifted above the
 * background/done branches but gated on parentDone (or stage===done) so
 * it can't fire while the parent is still in flight.
 *
 * Drives `phaseFor` across all combinations of
 * (parentDone, silentEnd, fleetRunning, stalledClose) and asserts the
 * resolved label.
 */

import { describe, it, expect } from 'vitest'
import { phaseFor } from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'
import type { ProgressCardState } from '../progress-card.js'

function fm(id: string, status: FleetMember['status'], lastActivityAt: number = 100_000): FleetMember {
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

function st(stage: ProgressCardState['stage']): ProgressCardState {
  return {
    turnStartedAt: 1,
    items: [],
    narratives: [],
    stage,
    thinking: false,
    subAgents: new Map(),
    pendingAgentSpawns: new Map(),
    tasks: [],
  }
}

const NOW = 100_000

interface Row {
  parentDone: boolean
  silentEnd: boolean
  fleetRunning: boolean
  stalledClose: boolean
  expected: string
}

// Truth table: 2^4 = 16 combinations of the four boolean inputs.
// stalledClose dominates everything → Forced close.
// silentEnd fires only when parentDone is true.
// When silentEnd is gated off and parent is still running, fleetRunning
// alone yields Working… (parent active); when parent is done +
// fleetRunning we get Background; parentDone alone yields Done.
const rows: Row[] = [
  // stalledClose=true → always Forced close
  { parentDone: false, silentEnd: false, fleetRunning: false, stalledClose: true, expected: 'Forced close' },
  { parentDone: false, silentEnd: false, fleetRunning: true,  stalledClose: true, expected: 'Forced close' },
  { parentDone: false, silentEnd: true,  fleetRunning: false, stalledClose: true, expected: 'Forced close' },
  { parentDone: false, silentEnd: true,  fleetRunning: true,  stalledClose: true, expected: 'Forced close' },
  { parentDone: true,  silentEnd: false, fleetRunning: false, stalledClose: true, expected: 'Forced close' },
  { parentDone: true,  silentEnd: false, fleetRunning: true,  stalledClose: true, expected: 'Forced close' },
  { parentDone: true,  silentEnd: true,  fleetRunning: false, stalledClose: true, expected: 'Forced close' },
  { parentDone: true,  silentEnd: true,  fleetRunning: true,  stalledClose: true, expected: 'Forced close' },

  // stalledClose=false
  // parent in flight (parentDone=false)
  { parentDone: false, silentEnd: false, fleetRunning: false, stalledClose: false, expected: 'Working…' },
  { parentDone: false, silentEnd: false, fleetRunning: true,  stalledClose: false, expected: 'Working…' },
  // silentEnd is GATED on parentDone — must not fire while parent in flight
  { parentDone: false, silentEnd: true,  fleetRunning: false, stalledClose: false, expected: 'Working…' },
  { parentDone: false, silentEnd: true,  fleetRunning: true,  stalledClose: false, expected: 'Working…' },

  // parent done
  { parentDone: true,  silentEnd: false, fleetRunning: false, stalledClose: false, expected: 'Done' },
  { parentDone: true,  silentEnd: false, fleetRunning: true,  stalledClose: false, expected: 'Background' },
  // silentEnd LIFTED above background/done — fires even when fleet still running
  { parentDone: true,  silentEnd: true,  fleetRunning: false, stalledClose: false, expected: 'Ended without reply' },
  { parentDone: true,  silentEnd: true,  fleetRunning: true,  stalledClose: false, expected: 'Ended without reply' },
]

describe('phaseFor precedence — (parentDone, silentEnd, fleetRunning, stalledClose)', () => {
  it.each(rows)(
    'parentDone=$parentDone silentEnd=$silentEnd fleetRunning=$fleetRunning stalledClose=$stalledClose → $expected',
    ({ parentDone, silentEnd, fleetRunning, stalledClose, expected }) => {
      const stage: ProgressCardState['stage'] = parentDone ? 'done' : 'run'
      const fleet = new Map<string, FleetMember>()
      if (fleetRunning) fleet.set('a', fm('a', 'running', NOW))
      const opts: Record<string, unknown> = {}
      if (silentEnd) opts.silentEnd = true
      if (stalledClose) opts.stalledClose = true
      // parentDone is conveyed via stage; also pass the explicit flag for parity
      if (parentDone) opts.parentDone = true

      const phase = phaseFor(st(stage), fleet, NOW, opts)
      expect(phase.label).toBe(expected)
    },
  )
})
