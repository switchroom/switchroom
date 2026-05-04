/**
 * P1 of #662 — renderer output never reintroduces raw absolute paths
 * or bearer-shaped tokens. Most coverage lives in fleet-state.test.ts;
 * this asserts the *renderer* basenames/redacts via the FleetMember's
 * sanitised values (i.e. it doesn't re-pull from raw input anywhere).
 */

import { describe, it, expect } from 'vitest'
import { renderTwoZoneCard } from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'
import type { ProgressCardState } from '../progress-card.js'

const baseState: ProgressCardState = {
  turnStartedAt: 1,
  items: [],
  narratives: [],
  stage: 'run',
  thinking: false,
  subAgents: new Map(),
  pendingAgentSpawns: new Map(),
  tasks: [],
}

function fm(over: Partial<FleetMember>): FleetMember {
  return {
    agentId: 'aaaaaaaaaaaa',
    role: 'agent',
    startedAt: 0,
    toolCount: 1,
    lastActivityAt: 1000,
    lastTool: null,
    status: 'running',
    terminalAt: null,
    errorSeen: false,
    originatingTurnKey: 'k',
    ...over,
  }
}

describe('two-zone-card sanitise', () => {
  it('does not contain raw absolute path under /etc/secrets', () => {
    const fleet = new Map([['a', fm({
      lastTool: { name: 'Read', sanitisedArg: 'foo.key' }, // already sanitised by fleet-state
    })]])
    const out = renderTwoZoneCard({ state: baseState, fleet, now: 2000 })
    expect(out).not.toContain('/etc/secrets')
    expect(out).toContain('foo.key')
  })

  it('does not contain bearer-shaped tokens (sanitised upstream)', () => {
    const fleet = new Map([['a', fm({
      lastTool: { name: 'Bash', sanitisedArg: 'curl -H "Authorization: [redacted]" https://api' },
    })]])
    const out = renderTwoZoneCard({ state: baseState, fleet, now: 2000 })
    expect(out).toContain('[redacted]')
    expect(out).not.toMatch(/Bearer\s+[A-Za-z0-9]{16,}/)
  })
})
