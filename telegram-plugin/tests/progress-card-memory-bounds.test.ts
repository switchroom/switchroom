/**
 * PR-C2 — end-to-end memory bounds: drive 100 turn cycles and assert
 * every internal Map remains bounded.
 *
 * Companion to PR-B's targeted eviction test, which drove only 20
 * cycles and asserted on `seenEnqueueMsgIds` / `pendingSyncEchoes`.
 * This larger run is a regression net for "everything else" — if a
 * future refactor forgets to evict any new map keyed by chat/turn,
 * the size invariant blows up here even when the PR-B test still
 * passes.
 *
 * fails when: any of the per-chat/per-turn Maps in `_debugGetMaps`
 * grows linearly with turn count (e.g. cleanup is removed from
 * completeTurnFully, or a new Map is added without an eviction hook).
 */
import { describe, it, expect } from 'vitest'
import { makeHarness, enqueue } from './_progress-card-harness.js'

describe('PR-C2: end-to-end memory bounds across 100 turn cycles', () => {
  it('all _debugGetMaps Maps stay bounded', () => {
    const { driver, advance } = makeHarness({
      heartbeatMs: 5_000,
      promoteAfterMs: 999_999,
    })
    const maps = driver._debugGetMaps!()

    for (let i = 0; i < 100; i++) {
      driver.ingest(enqueue('chatA'), null)
      driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, 'chatA')
      driver.recordOutboundDelivered('chatA')
      driver.ingest({ kind: 'turn_end', durationMs: 50 }, 'chatA')
      // Advance well past TTLs (60s) and the eviction throttle (~30s).
      advance(65_000)
    }

    expect(maps.chats.size).toBe(0)
    expect(maps.chatRunningSubagents.size).toBe(0)
    expect(maps.baseTurnSeqs.size).toBe(0)
    // The dedup maps may keep at most one straggler from the final turn.
    expect(maps.seenEnqueueMsgIds.size).toBeLessThanOrEqual(1)
    expect(maps.pendingSyncEchoes.size).toBeLessThanOrEqual(1)
    // editTimestamps is per-turnKey; cleared on completeTurnFully.
    expect(maps.editTimestamps.size).toBeLessThanOrEqual(1)
  })

  it('with a long-lived bg sub-agent across cycles, only the originating turnKey persists', () => {
    const { driver, advance } = makeHarness({
      heartbeatMs: 5_000,
      promoteAfterMs: 999_999,
    })
    const maps = driver._debugGetMaps!()

    // One bg sub-agent that NEVER finishes; 50 surrounding turns close cleanly.
    driver.ingest(enqueue('chatA'), null)
    driver.ingest(
      {
        kind: 'tool_use', toolName: 'Agent', toolUseId: 'tu1',
        input: { prompt: 'forever-bg', run_in_background: true },
      },
      'chatA',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'saBG', firstPromptText: 'forever-bg' }, 'chatA')
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, 'chatA')
    driver.recordOutboundDelivered('chatA')
    driver.ingest({ kind: 'turn_end', durationMs: 50 }, 'chatA')

    for (let i = 0; i < 50; i++) {
      driver.ingest(enqueue('chatA'), null)
      driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, 'chatA')
      driver.recordOutboundDelivered('chatA')
      driver.ingest({ kind: 'turn_end', durationMs: 50 }, 'chatA')
      advance(65_000)
    }

    // After 50 clean surrounding turns each followed by `advance(65_000)`
    // (well past TTL + eviction throttle), every chatState — including
    // the originating one whose bg sub-agent never finished — has been
    // rolled forward and evicted. Empty is the correct steady state, not
    // the "≤ 2" the original PR shipped. What this test really proves
    // is that `chats` doesn't grow with cycle count.
    expect(maps.chats.size).toBe(0)
    expect(maps.baseTurnSeqs.size).toBeLessThanOrEqual(1)
  })
})
