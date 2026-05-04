/**
 * PR-C2 — reportApiFailure crossing its threshold while a chat is in
 * `pendingCompletion` state must not corrupt the deferred-completion
 * resolution path.
 *
 * Setup: parent turn_end while a bg sub-agent is still running →
 * chatState.pendingCompletion=true. Then `maxConsecutive4xx` permanent
 * 4xx failures arrive (the card is being abandoned locally). We then
 * resolve the bg sub-agent via sub_agent_turn_end. The driver must:
 *
 *   - Fire onTurnComplete exactly once for the originating turnKey.
 *   - Not double-flush.
 *
 * fails when: the terminal-apiFailure branch races with the
 * pendingCompletion resolution path and either swallows or duplicates
 * the completion callback.
 */
import { describe, it, expect } from 'vitest'
import { makeHarness, enqueue } from './_progress-card-harness.js'

describe('PR-C2: API failure crossing threshold during pendingCompletion', () => {
  it('deferred completion still resolves exactly once; no double-flush', () => {
    const completions: string[] = []
    const { driver } = makeHarness({
      minIntervalMs: 0,
      coalesceMs: 0,
      heartbeatMs: 999_999, // keep heartbeat from racing the test
      maxConsecutive4xx: 3,
      promoteAfterMs: 999_999,
      onTurnComplete: (s) => completions.push(s.turnKey),
    })
    const maps = driver._debugGetMaps!()
    const CHAT = 'cA'

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

    expect(maps.chats.size).toBe(1)
    const turnKey = [...maps.chats.keys()][0]
    const cs = maps.chats.get(turnKey) as { pendingCompletion: boolean; apiFailures: { terminal: boolean } }
    expect(cs.pendingCompletion).toBe(true)

    // Hammer reportApiFailure past the threshold (3).
    for (let i = 0; i < 5; i++) {
      driver.reportApiFailure(turnKey, {
        kind: 'permanent_4xx',
        code: 400,
        description: 'bad request',
      })
    }
    expect(cs.apiFailures.terminal).toBe(true)
    // No completion fired yet — bg still running.
    expect(completions.length).toBe(0)

    // Resolve the bg sub-agent. The originating turn must complete
    // exactly once.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'saBG' }, CHAT)
    expect(completions.length).toBe(1)
    expect(completions[0]).toBe(turnKey)
  })
})
