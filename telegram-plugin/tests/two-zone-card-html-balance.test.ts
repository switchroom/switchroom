/**
 * P1 of #662 — render-invariant property tests.
 *
 * For any input state with fleet 0..50 and any tool-arg shape:
 *   1. Output passes a tag-balance validator (no <blockquote> 400s).
 *   2. Output is < 4096 bytes.
 *   3. Idempotent: same inputs → same output.
 *
 * Uses vitest `it.each` with ~30 hand-crafted shapes covering the
 * property surface (per #662 P1 — replaces fast-check).
 */

import { describe, it, expect } from 'vitest'
import { renderTwoZoneCard } from '../two-zone-card.js'
import type { FleetMember, FleetStatus } from '../fleet-state.js'
import type { ProgressCardState } from '../progress-card.js'
import { isBalancedHtml } from './html-balanced.js'

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

function makeMember(i: number, status: FleetStatus, argShape: string): FleetMember {
  return {
    agentId: `agent-${i.toString().padStart(8, '0')}`,
    role: i % 3 === 0 ? `worker-${i}` : i % 3 === 1 ? 'general-purpose' : 'investigate the auth bug',
    startedAt: 0,
    toolCount: i,
    lastActivityAt: 100 + i,
    lastTool: i === 0 ? null : { name: 'Read', sanitisedArg: argShape },
    status,
    terminalAt: ['done', 'failed', 'killed'].includes(status) ? 100 + i : null,
    errorSeen: status === 'failed',
    originatingTurnKey: 'k',
  }
}

const ARG_SHAPES = [
  '',
  'simple.ts',
  'foo.key',
  'a/b/c/very-long-relative-path-that-should-not-explode-the-card.ts',
  '<html-y-arg>',
  '&amp;already-escaped',
  'emoji 🚀 in arg',
  'quotes "and" \'apostrophes\'',
  '[redacted]',
  '\nmultiline\nshould\nflatten',
]

const STATUSES: FleetStatus[] = ['running', 'background', 'done', 'failed', 'stuck', 'killed']

const SIZES = [0, 1, 3, 5, 10, 50]

const cases: Array<[string, number, string]> = []
for (const size of SIZES) {
  for (const arg of ARG_SHAPES.slice(0, 3)) {
    cases.push([`size=${size} arg=${JSON.stringify(arg).slice(0, 20)}`, size, arg])
  }
}

describe('two-zone-card render invariants', () => {
  it.each(cases)('%s — balanced HTML, <4096 bytes, idempotent', (_name, size, arg) => {
    const fleet = new Map<string, FleetMember>()
    for (let i = 0; i < size; i++) {
      const status = STATUSES[i % STATUSES.length]
      fleet.set(`a${i}`, makeMember(i, status, arg))
    }
    const out1 = renderTwoZoneCard({ state: baseState, fleet, now: 5000 })
    const out2 = renderTwoZoneCard({ state: baseState, fleet, now: 5000 })
    const balance = isBalancedHtml(out1)
    expect(balance.balanced, `unbalanced: open=${balance.openTags.join(',')} extra=${balance.extraCloses.join(',')}`).toBe(true)
    expect(out1.length).toBeLessThan(4096)
    expect(out1).toBe(out2)
  })

  it('handles arg shapes individually with size=5', () => {
    for (const arg of ARG_SHAPES) {
      const fleet = new Map<string, FleetMember>()
      for (let i = 0; i < 5; i++) fleet.set(`a${i}`, makeMember(i, 'running', arg))
      const out = renderTwoZoneCard({ state: baseState, fleet, now: 5000 })
      const b = isBalancedHtml(out)
      expect(b.balanced, `unbalanced for arg=${arg}: open=${b.openTags.join(',')}`).toBe(true)
      expect(out.length).toBeLessThan(4096)
    }
  })
})

describe('html-balanced validator self-test', () => {
  it('balanced cases', () => {
    expect(isBalancedHtml('').balanced).toBe(true)
    expect(isBalancedHtml('plain text').balanced).toBe(true)
    expect(isBalancedHtml('<b>bold</b>').balanced).toBe(true)
    expect(isBalancedHtml('<b>bold <i>italic</i></b>').balanced).toBe(true)
    expect(isBalancedHtml('text with &lt;not a tag&gt;').balanced).toBe(true)
    expect(isBalancedHtml('<blockquote>x</blockquote>').balanced).toBe(true)
  })
  it('unbalanced cases', () => {
    expect(isBalancedHtml('<b>open').balanced).toBe(false)
    expect(isBalancedHtml('close</b>').balanced).toBe(false)
    expect(isBalancedHtml('<b><i>x</b></i>').balanced).toBe(false)
  })
})
