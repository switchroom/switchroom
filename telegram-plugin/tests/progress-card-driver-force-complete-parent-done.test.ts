/**
 * Regression: forceCompleteTurn must set `parentTurnEndAt` so the heartbeat's
 * `parentDone` branch lights up and the elapsed counter keeps ticking through
 * `subAgentTickIntervalMs` while sub-agents are still running.
 *
 * Bug shape (#686, fixed in #687): forceCompleteTurn reduced `turn_end` but
 * never set `parentTurnEndAt`. The heartbeat's `parentDone` was therefore
 * always false during the deferred-unpin window, the elapsed-ticker bypass
 * never engaged, and the rendered card froze on its last emit until the
 * sub-agents finished.
 *
 * Test shape: spawn a sub-agent, call forceCompleteTurn, then advance fake
 * time across several heartbeat ticks. The "Done" header (parentDone branch
 * of the renderer) MUST appear and elapsed time MUST keep advancing in the
 * emitted HTML.
 */
import { describe, it, expect } from 'vitest'
import { makeHarness, enqueue } from './_progress-card-harness.js'

describe('progress-card-driver: forceCompleteTurn unfreezes elapsed-ticker', () => {
  it('parentDone engages and elapsed advances after forceCompleteTurn while a sub-agent is still running', () => {
    const { driver, emits, advance } = makeHarness({
      minIntervalMs: 0,
      coalesceMs: 0,
      heartbeatMs: 1_000,
    })
    const CHAT = 'chatF'

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

    // External completion signal (e.g. stream_reply done=true). Sub-agent
    // is still running, so the chatState enters pendingCompletion and the
    // heartbeat keeps the card alive.
    driver.forceCompleteTurn({ chatId: CHAT })

    // The flush triggered by forceCompleteTurn itself produces an emit
    // with the parentDone-branch ("Done") header.
    const emitsAfterForce = emits.length
    expect(emitsAfterForce).toBeGreaterThan(0)
    const renderedAtForce = emits[emitsAfterForce - 1].html
    // The renderer surfaces "Background" once parentDone=true and a bg
    // sub-agent is still running; if the bug regresses (parentTurnEndAt
    // stays null), parentDone is false and we'd see "Working".
    expect(renderedAtForce).toMatch(/Background/)
    expect(renderedAtForce).not.toMatch(/Working/)

    // Advance well past the elapsed-ticker interval to prove the
    // heartbeat keeps emitting fresh elapsed values rather than freezing
    // on the last emit. Several ticks should produce at least one extra
    // emit with different rendered HTML.
    advance(15_000)
    const tailEmits = emits.slice(emitsAfterForce)
    expect(tailEmits.length).toBeGreaterThan(0)
    // At least one post-force emit must differ from the force-emit HTML —
    // proving the elapsed counter advanced rather than freezing.
    const advanced = tailEmits.some((e) => e.html !== renderedAtForce)
    expect(advanced).toBe(true)

    // Resolve the sub-agent and assert the deferred completion fires.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'saBG' }, CHAT)
    const finalEmit = emits[emits.length - 1]
    expect(finalEmit.done).toBe(true)
  })
})
