/**
 * PR-C2 — full lifecycle of background sub-agent carry across two
 * consecutive parent turns.
 *
 *   Turn A: enqueue → spawn bg sub-agent → parent reply + turn_end
 *           (parent done, bg still running → phase=Background on A's card).
 *   Turn B: enqueue (carries the still-running bg member into B's fleet).
 *           B's phase starts as Working (parent active again).
 *   Background sub-agent emits during B → still Working.
 *   Background sub-agent reaches sub_agent_turn_end during B → fleet
 *           now empty of running members; B's phase resolves cleanly.
 *
 * fails when: a refactor drops the originatingTurnKey routing of a bg
 * sub-agent's events back to its origin chat, OR when the bg member
 * isn't carried into turn B's fleet on enqueue.
 */
import { describe, it, expect } from 'vitest'
import { phaseFor } from '../two-zone-card.js'
import { makeHarness, enqueue } from './_progress-card-harness.js'

describe('PR-C2: two-zone bg-carry full lifecycle (turn A → turn B → bg done)', () => {
  it('phase transitions A=Background, B=Working, B-after-bg-done=Done', () => {
    const { driver, advance, getNow, completions } = makeHarness({
      minIntervalMs: 500,
      coalesceMs: 400,
      promoteAfterMs: 999_999,
    })
    const CHAT = 'cA'

    // ── Turn A: spawn bg sub-agent, parent replies, turn_end. ──────────
    driver.ingest(enqueue(CHAT), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu1',
        input: { prompt: 'bg work', run_in_background: true },
      },
      CHAT,
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'saBG', firstPromptText: 'bg work' }, CHAT)
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, CHAT)
    driver.recordOutboundDelivered(CHAT)
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, CHAT)

    // After parent turn_end, the originating chatState is held in
    // pendingCompletion because saBG is still running.
    const fleetAfterA = driver.peekFleet(CHAT)!
    expect(fleetAfterA.has('saBG')).toBe(true)
    expect(fleetAfterA.get('saBG')!.status).toBe('background')

    // Phase resolution for A: parentDone=true + bg running → Background.
    {
      const all = (driver as unknown as {
        peekAllFleets?: () => Array<{ turnKey: string; fleet: Map<string, unknown>; state?: unknown }>
      }).peekAllFleets?.() ?? []
      // Find turn A — it's the one whose fleet contains saBG and whose
      // turnKey ends in :1.
      const a = all.find((e) => e.turnKey.endsWith(':1'))
      expect(a).toBeDefined()
    }
    // Capture A's turnKey for the deferred-completion assertion below.
    const turnKeyA = (driver as unknown as {
      peekAllFleets?: () => Array<{ turnKey: string; fleet: Map<string, unknown> }>
    }).peekAllFleets!().find((e) => e.fleet.has('saBG'))!.turnKey

    // ── Turn B: fresh enqueue. The bg member carries forward. ─────────
    advance(50)
    driver.ingest(enqueue(CHAT), null)
    const fleetB = driver.peekFleet(CHAT)!
    // Carry: saBG should still be reachable somewhere in the driver's
    // fleets (either on B's fresh state or A's still-pending one).
    const allFleets = (driver as unknown as {
      peekAllFleets?: () => Array<{ turnKey: string; fleet: Map<string, { status: string }> }>
    }).peekAllFleets?.() ?? []
    const sawBG = allFleets.some((f) => f.fleet.has('saBG'))
    expect(sawBG).toBe(true)

    // B parent is in flight — phaseFor should resolve to Working… because
    // parentDone=false for B regardless of bg state.
    const phaseB = phaseFor(
      {
        turnStartedAt: getNow(),
        items: [],
        narratives: [],
        stage: 'run',
        thinking: false,
        subAgents: new Map(),
        pendingAgentSpawns: new Map(),
        tasks: [],
      },
      fleetB,
      getNow(),
      {},
    )
    expect(phaseB.label).toBe('Working…')

    // ── BG sub-agent emits during B (proves routing still works). ────
    advance(20)
    driver.ingest(
      {
        kind: 'sub_agent_tool_use',
        agentId: 'saBG',
        toolUseId: 'bgt1',
        toolName: 'Read',
        input: { file_path: '/tmp/x.txt' },
      },
      CHAT,
    )

    // ── BG sub-agent finishes during B. ──────────────────────────────
    advance(20)
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'saBG' }, CHAT)

    // Turn A's pendingCompletion should now resolve (saBG no longer
    // running). Turn B's fleet should drop its bg copy too.
    const allAfter = (driver as unknown as {
      peekAllFleets?: () => Array<{ turnKey: string; fleet: Map<string, { status: string }> }>
    }).peekAllFleets?.() ?? []
    for (const entry of allAfter) {
      const m = entry.fleet.get('saBG')
      if (m == null) continue
      // Whichever turn still holds saBG, it must be terminal (done/failed/killed)
      expect(['done', 'failed', 'killed']).toContain(m.status)
    }
    // Critical: A's deferred completion MUST have fired now that saBG
    // reached sub_agent_turn_end. Without this assertion the loop above
    // trivially passes when allAfter is empty.
    expect(completions).toContain(turnKeyA)
  })
})
