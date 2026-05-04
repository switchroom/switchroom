/**
 * P2 of #662 — runInBackground detection.
 *
 * When the parent dispatches an Agent/Task tool with
 * `input.run_in_background: true`, the resulting fleet member must be
 * marked with `status: 'background'` instead of `running`. Foreground
 * dispatches (no flag, or false) stay `running`.
 */

import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

function harness() {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const driver = createProgressDriver({
    emit: () => {},
    minIntervalMs: 500,
    coalesceMs: 400,
    initialDelayMs: 0,
    promoteAfterMs: 999_999,
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
  return { driver, advance: (ms: number) => { now += ms } }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('P2: runInBackground detection', () => {
  it('marks fleet member status=background when Agent dispatched with run_in_background:true', () => {
    const { driver } = harness()
    driver.ingest(enqueue('c1'), null)
    // Parent fires Agent tool_use with run_in_background=true.
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu1',
        input: { prompt: 'do bg work', description: 'bg-job', run_in_background: true },
      },
      'c1',
    )
    // sub_agent_started arrives with matching prompt.
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'do bg work', subagentType: 'worker' },
      'c1',
    )

    const m = driver.peekFleet('c1')!.get('sa1')!
    expect(m.status).toBe('background')
  })

  it('keeps status=running when Agent dispatched without run_in_background', () => {
    const { driver } = harness()
    driver.ingest(enqueue('c2'), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu2',
        input: { prompt: 'do fg work', description: 'fg-job' },
      },
      'c2',
    )
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'sa2', firstPromptText: 'do fg work' },
      'c2',
    )
    const m = driver.peekFleet('c2')!.get('sa2')!
    expect(m.status).toBe('running')
  })

  it('keeps status=running when run_in_background is explicitly false', () => {
    const { driver } = harness()
    driver.ingest(enqueue('c3'), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu3',
        input: { prompt: 'p', run_in_background: false },
      },
      'c3',
    )
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'sa3', firstPromptText: 'p' },
      'c3',
    )
    const m = driver.peekFleet('c3')!.get('sa3')!
    expect(m.status).toBe('running')
  })
})
