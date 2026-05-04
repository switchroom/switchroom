/**
 * PR-C2 — additional golden snapshots for renderTwoZoneCard not
 * covered by two-zone-card-snapshot.test.ts:
 *
 *   1. silent-end + bg fleet running (silentEnd lifted above
 *      Background; the bg member still appears in the FLEET zone).
 *   2. stalled-close header (`stalledClose` precedence dominates).
 *   3. Parent zone "(+N earlier)" overflow when items.length >
 *      PARENT_BULLET_CAP (=8).
 *
 * fails when: phaseFor's precedence regresses (silentEnd no longer
 * lifted above background), the stalledClose label changes, or
 * PARENT_BULLET_CAP overflow rendering drops the "(+N earlier)" prefix.
 */
import { describe, it, expect } from 'vitest'
import { renderTwoZoneCard } from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'
import type { ProgressCardState } from '../progress-card.js'

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

const NOW = 100_000

describe('PR-C2: two-zone card snapshot extras', () => {
  it('silent-end + bg fleet still running → header is "Ended without reply", FLEET shows bg member', () => {
    const fleet = new Map([
      ['a', fm({
        agentId: 'aaaaaa01', role: 'background', status: 'background',
        toolCount: 7, lastActivityAt: NOW - 2000,
        lastTool: { name: 'Bash', sanitisedArg: 'long.sh' },
      })],
    ])
    const out = renderTwoZoneCard({
      state: st({ stage: 'done', turnStartedAt: NOW - 30_000 }),
      fleet,
      now: NOW,
      opts: { silentEnd: true },
    })
    expect(out).toBe(
      '🙊 <b>Ended without reply</b> · ⏱ 00:30 · 7t · 1s\n' +
      '\n' +
      '<b>FLEET (1)</b>\n' +
      '⏸ background <code>aaaaaa</code> · 7t · Bash <code>long.sh</code> (2s ago)',
    )
  })

  it('stalled-close header dominates regardless of fleet state', () => {
    const fleet = new Map([
      ['a', fm({ agentId: 'aaaaaa01', role: 'worker', status: 'running', toolCount: 3, lastActivityAt: NOW - 1000 })],
    ])
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 60_000 }),
      fleet,
      now: NOW,
      opts: { stalledClose: true },
    })
    // Header begins with the "Forced close" phase. We don't snapshot the
    // full body — just lock down the header and the icon.
    expect(out.startsWith('⚠ <b>Forced close</b> · ⏱ 01:00')).toBe(true)
  })

  it('parent zone overflow: "(+N earlier)" prefix when items > PARENT_BULLET_CAP=8', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      tool: 'Read',
      label: `f${i}.ts`,
    }))
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 5000, items }),
      fleet: new Map(),
      now: NOW,
    })
    // 12 items, cap 8 → 4 hidden.
    expect(out).toContain('(+4 earlier)')
    // The visible bullets are the LAST 8 (slice(-8) → f4..f11).
    expect(out).toContain('<code>f11.ts</code>')
    expect(out).toContain('<code>f4.ts</code>')
    // f3 (the latest hidden) must not appear as a bullet code block.
    expect(out).not.toContain('<code>f3.ts</code>')
  })
})
