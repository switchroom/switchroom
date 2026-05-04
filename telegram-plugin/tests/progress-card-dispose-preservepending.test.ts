/**
 * PR-C2 — `dispose({ preservePending: true })` must NOT remove chats
 * whose `pendingCompletion === true`.
 *
 * Regression: commit 4c0186d introduced a dispose() that wiped all
 * in-flight card state on every bridge disconnect. The selective
 * dispose path was added to keep cards with running background
 * sub-agents alive across the disconnect/reconnect cycle.
 *
 * fails when: dispose's preservePending branch unconditionally clears
 * `chats`, OR forgets to leave the heartbeat running while a pending
 * chat survives.
 */
import { describe, it, expect } from 'vitest'
import { makeHarness, enqueue } from './_progress-card-harness.js'

describe('PR-C2: dispose({ preservePending: true })', () => {
  it('chat with pendingCompletion survives dispose; heartbeat-driven completion still fires after a "reconnect"', () => {
    const completions: string[] = []
    const { driver, advance } = makeHarness({
      minIntervalMs: 0,
      coalesceMs: 0,
      heartbeatMs: 1_000,
      maxIdleMs: 999_999,
      deferredCompletionTimeoutMs: 5_000,
      promoteAfterMs: 999_999,
      onTurnComplete: (s) => completions.push(s.turnKey),
    })
    const maps = driver._debugGetMaps!()
    const CHAT = 'cA'

    // Set up a turn with a background sub-agent so parent turn_end
    // produces pendingCompletion=true.
    driver.ingest(enqueue(CHAT), null)
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
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, CHAT)

    // Confirm pendingCompletion shape.
    expect(maps.chats.size).toBe(1)
    const csBefore = [...maps.chats.values()][0] as { pendingCompletion: boolean }
    expect(csBefore.pendingCompletion).toBe(true)

    // Bridge disconnect: dispose preserving pending.
    driver.dispose!({ preservePending: true })

    // Chat must survive.
    expect(maps.chats.size).toBe(1)
    const csAfter = [...maps.chats.values()][0] as { pendingCompletion: boolean }
    expect(csAfter.pendingCompletion).toBe(true)

    // Now simulate "bridge reconnect" — nothing to do at the driver level
    // for that, but the heartbeat must still be wired so the deferred
    // completion timeout eventually fires.
    advance(15_000)

    // Stalled-cards heartbeat branch should have closed the chat by now.
    expect(maps.chats.size).toBe(0)
    expect(completions.length).toBe(1)
  })

  it('chats WITHOUT pendingCompletion are dropped by preservePending dispose', () => {
    const { driver } = makeHarness()
    const maps = driver._debugGetMaps!()
    driver.ingest(enqueue('cActive'), null)
    expect(maps.chats.size).toBe(1)

    driver.dispose!({ preservePending: true })
    expect(maps.chats.size).toBe(0)
  })
})
