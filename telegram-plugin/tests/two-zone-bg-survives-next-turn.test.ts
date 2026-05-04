/**
 * P2 of #662 / fixes #64 — background sub-agent persistence across
 * subsequent parent turns.
 *
 * Lifecycle under test:
 *   - Turn A enqueue → parent dispatches Agent({run_in_background:true})
 *     → sub_agent_started → parent reply → turn_end (would normally
 *     finalize and dispose).
 *   - Turn B enqueues. The original PerChatState for turn A must
 *     survive because its fleet still has a 'background' member.
 *   - Background sub-agent emits sub_agent_tool_use. Routing must land
 *     the event on turn A's state (originatingTurnKey), NOT turn B's
 *     fresh state.
 *   - When the background sub-agent finally fires sub_agent_turn_end,
 *     turn A's PerChatState completes and is disposed.
 */

import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

function harness() {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const completions: string[] = []
  const driver = createProgressDriver({
    emit: () => {},
    minIntervalMs: 500,
    coalesceMs: 400,
    initialDelayMs: 0,
    promoteAfterMs: 999_999,
    onTurnComplete: (s) => completions.push(s.turnKey),
    now: () => now,
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref })
      return { ref }
    },
    clearTimeout: (h) => {
      const ref = (h as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === ref)
      if (idx !== -1) timers.splice(idx, 1)
    },
    setInterval: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref, repeat: ms })
      return { ref }
    },
    clearInterval: (h) => {
      const ref = (h as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === ref)
      if (idx !== -1) timers.splice(idx, 1)
    },
  })
  return { driver, completions, advance: (ms: number) => { now += ms } }
}

const enqueue = (chatId: string, msgId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: msgId,
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('P2 / #64: background sub-agent persists across parent turn boundaries', () => {
  it('PerChatState for turn A survives parent turn_end while background fleet member runs', () => {
    const { driver, completions } = harness()
    const CHAT = 'c1'

    // Turn A
    driver.ingest(enqueue(CHAT, '1'), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu1',
        input: { prompt: 'bg work', description: 'long-bg', run_in_background: true },
      },
      CHAT,
    )
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'saBG', firstPromptText: 'bg work' },
      CHAT,
    )
    // Parent reply fires + delivery so turn_end takes the ✅ Done path.
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, CHAT)
    driver.recordOutboundDelivered(CHAT)
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, CHAT)

    // Background sub-agent is still running → onTurnComplete must NOT
    // have fired for turn A yet. Fleet is still inspectable.
    expect(completions.length).toBe(0)
    const fleetA = driver.peekFleet(CHAT)!
    expect(fleetA.has('saBG')).toBe(true)
    expect(fleetA.get('saBG')!.status).toBe('background')
  })

  it('background sub-agent tool_use after a NEW turn arrives still updates the originating turn fleet', () => {
    const { driver, completions, advance } = harness()
    const CHAT = 'c1'

    // Turn A spawns bg sub-agent
    driver.ingest(enqueue(CHAT, '1'), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu1',
        input: { prompt: 'bg work', description: 'long-bg', run_in_background: true },
      },
      CHAT,
    )
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'saBG', firstPromptText: 'bg work' },
      CHAT,
    )
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, CHAT)
    driver.recordOutboundDelivered(CHAT)
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, CHAT)

    const fleetBeforeTurnB = driver.peekFleet(CHAT)!
    const turnAStartedAt = fleetBeforeTurnB.get('saBG')!.startedAt

    // Advance the clock so the bg sub-agent's later tool_use gets a
    // distinguishable lastActivityAt (proves routing actually mutated
    // the originating member rather than no-oping).
    advance(50)

    // Turn B starts (and ends quickly, no sub-agents).
    driver.ingest(enqueue(CHAT, '2'), null)
    advance(10)
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, CHAT)
    driver.recordOutboundDelivered(CHAT)
    driver.ingest({ kind: 'turn_end', durationMs: 200 }, CHAT)

    // Background sub-agent emits a tool_use after parent moved on.
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

    // The bg fleet member's lastActivityAt advanced — proving routing
    // landed on the originating PerChatState rather than dropping the
    // event as a "late event for ended turn".
    // Iterate all fleets — the originating one survives even if peekFleet
    // returns turn B's state.
    // We discover it via a known-stable agentId.
    // Use the test-only carry: peekFleet returns whichever chat:thread
    // matches; but turn B may shadow it. So use the fleet from turn A
    // by looking it up via the driver's introspection — we just call
    // peekFleet(CHAT) and accept that it returns a fleet where saBG
    // either lives (if A is still bound) or doesn't (if B took over).
    // Either way the saBG entry exists somewhere; check it via the
    // dedicated test hook.
    const allLiveBg = driver.peekFleet(CHAT)
    // saBG might live on turn A's fleet which is no longer the
    // currentTurnKey; but the routing must have updated it. We rely on
    // a debug hook to find it across all chats.
    expect(allLiveBg).toBeDefined()
    // Strict: we expect SOMEWHERE in the driver, saBG's lastActivityAt
    // is now newer than turnAStartedAt.
    // Pull via the driver's test hook (added in P2): peekAllFleets.
    const all = (driver as unknown as { peekAllFleets?: () => Array<{ turnKey: string; fleet: Map<string, { agentId: string; lastActivityAt: number; toolCount: number }> }> })
      .peekAllFleets?.() ?? []
    let found: { lastActivityAt: number; toolCount: number } | undefined
    for (const entry of all) {
      const m = entry.fleet.get('saBG')
      if (m != null) found = m
    }
    expect(found).toBeDefined()
    expect(found!.toolCount).toBe(1)
    expect(found!.lastActivityAt).toBeGreaterThan(turnAStartedAt)
    // Turn B should have completed normally (no bg on it).
    expect(completions.some((k) => k.endsWith(':2'))).toBe(true)
    // Turn A should NOT have completed yet (bg still running).
    expect(completions.some((k) => k.endsWith(':1'))).toBe(false)
  })

  it('completes the originating turn when the last background sub-agent reaches turn_end', () => {
    const { driver, completions } = harness()
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT, '1'), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu1',
        input: { prompt: 'bg', run_in_background: true },
      },
      CHAT,
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'saBG', firstPromptText: 'bg' }, CHAT)
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, CHAT)
    driver.recordOutboundDelivered(CHAT)
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, CHAT)
    expect(completions.length).toBe(0)

    // BG sub-agent eventually finishes.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'saBG' }, CHAT)
    expect(completions.length).toBe(1)
    expect(completions[0]).toMatch(/:1$/)
  })
})
