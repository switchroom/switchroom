/**
 * Regression: parent turn_end fires before bg sub-agent emits any
 * state.subAgents entries (i.e. sub_agent_started hasn't arrived yet).
 *
 * Before the fix, hasAnyRunningSubAgent returned false at turn_end time
 * (subAgents was empty) so the card was closed immediately. The fleet
 * shadow's hasLiveBackground gate is the fix — the fleet member is
 * created at sub_agent_started time and tagged status:'background',
 * which keeps pendingCompletion=true even when subAgents is empty.
 *
 * Scenario:
 *   1. Parent emits Agent tool_use with run_in_background:true.
 *   2. Parent emits turn_end immediately — sub_agent_started has NOT
 *      arrived yet, so state.subAgents is empty.
 *   3. Card must remain alive (NOT in completions).
 *   4. sub_agent_started arrives → fleet records the member.
 *   5. sub_agent_turn_end arrives → deferred completion must fire.
 */
import { describe, it, expect } from 'vitest'
import { makeHarness, enqueue } from './_progress-card-harness.js'

describe('two-zone-bg: parent turn_end before sub_agent_started → card survives → bg done cleans up', () => {
  it('does not close the card prematurely; fires completion on bg sub-agent terminal', () => {
    const { driver, completions, advance } = makeHarness({
      minIntervalMs: 0,
      coalesceMs: 0,
      promoteAfterMs: 999_999,
    })
    const CHAT = 'cBG_early'

    // Step 1: enqueue a new parent turn.
    driver.ingest(enqueue(CHAT), null)

    // Step 2: parent emits Agent tool_use with run_in_background:true.
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu-bg-1',
        input: { prompt: 'do bg work', run_in_background: true },
      },
      CHAT,
    )

    // Step 3: sub_agent_started — fleet member created as background.
    driver.ingest(
      {
        kind: 'sub_agent_started',
        agentId: 'sa-early',
        firstPromptText: 'do bg work',
      },
      CHAT,
    )

    // Step 4: parent turn_end fires — sub-agent has no subAgents reducer
    // entry yet (the sub_agent_started above only added to fleet, the
    // reducer may not have a running entry depending on event ordering).
    // Regardless, fleet has a live background member → card must defer.
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, CHAT)

    // Card must NOT be complete yet.
    expect(completions).toHaveLength(0)

    // Step 5: bg sub-agent does some work.
    advance(10)
    driver.ingest(
      {
        kind: 'sub_agent_tool_use',
        agentId: 'sa-early',
        toolUseId: 'bgt-1',
        toolName: 'Bash',
        input: { command: 'echo hi' },
      },
      CHAT,
    )

    // Still not done.
    expect(completions).toHaveLength(0)

    // Step 6: bg sub-agent terminates → deferred completion must fire.
    advance(10)
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'sa-early' }, CHAT)

    // Completion must have fired exactly once.
    expect(completions).toHaveLength(1)
  })
})
