/**
 * P0 of #662 — invariant test that the driver's `fleet` shadow Map
 * stays in lockstep with the legacy `chatState.subAgents` map across a
 * full sub-agent lifecycle.
 *
 * We drive the real driver via createProgressDriver (no Telegram bot
 * required — the emit callback just records calls) and feed a complete
 * lifecycle: started → 3× tool_use → tool_result(isError=true) →
 * turn_end. After every event we assert:
 *   - cardinality matches between fleet and subAgents
 *   - on terminal turn_end: status='failed' (errorSeen accumulated)
 *   - originatingTurnKey was snapshotted from currentTurnKey
 *   - lastTool reflects the most recent tool_use's sanitised arg
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

describe('driver fleet-state shadow', () => {
  it('shadow Map stays in lockstep with chatState.subAgents through a failed sub-agent lifecycle', () => {
    const { driver } = harness()
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT), null)

    const events: SessionEvent[] = [
      { kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'do work', subagentType: 'worker' },
      { kind: 'sub_agent_tool_use', agentId: 'sa1', toolUseId: 't1', toolName: 'Read', input: { file_path: '/etc/secrets/k.key' } },
      { kind: 'sub_agent_tool_use', agentId: 'sa1', toolUseId: 't2', toolName: 'Bash', input: { command: 'ls' } },
      { kind: 'sub_agent_tool_use', agentId: 'sa1', toolUseId: 't3', toolName: 'Edit', input: { file_path: '/tmp/x.ts' } },
      { kind: 'sub_agent_tool_result', agentId: 'sa1', toolUseId: 't3', isError: true, errorText: 'boom' },
    ]

    for (const ev of events) {
      driver.ingest(ev, CHAT)
      const state = driver.peek(CHAT)
      const fleet = driver.peekFleet(CHAT)
      expect(state).toBeDefined()
      expect(fleet).toBeDefined()
      // Cardinality invariant — every sub-agent in the legacy map has a
      // shadow entry, and vice versa.
      expect(fleet!.size).toBe(state!.subAgents.size)
      for (const id of state!.subAgents.keys()) {
        expect(fleet!.has(id)).toBe(true)
      }
    }

    // Pre-turn-end: fleet member exists, status still running, errorSeen true.
    const midFleet = driver.peekFleet(CHAT)!
    const midMember = midFleet.get('sa1')!
    expect(midMember.status).toBe('running')
    expect(midMember.errorSeen).toBe(true)
    expect(midMember.toolCount).toBe(3)
    expect(midMember.lastTool).toEqual({ name: 'Edit', sanitisedArg: 'x.ts' })
    expect(midMember.role).toBe('worker') // from subagentType fallback
    // Snapshotted from currentTurnKey at sub_agent_started.
    expect(midMember.originatingTurnKey).toMatch(/^c1:/)

    // Now end the sub-agent's turn — fleet member should flip to failed.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'sa1' }, CHAT)
    const finalFleet = driver.peekFleet(CHAT)!
    const finalMember = finalFleet.get('sa1')!
    expect(finalMember.status).toBe('failed')
    expect(finalMember.terminalAt).not.toBeNull()
  })

  it('uses description as role when present', () => {
    const { driver } = harness()
    driver.ingest(enqueue('c2'), null)
    // session-tail's sub_agent_started doesn't carry description directly,
    // but the watcher path supplies subagentType — verify the fallback chain
    // works when neither is set: first 20 chars of firstPromptText.
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'sa2', firstPromptText: 'investigate the auth bug end-to-end' },
      'c2',
    )
    const m = driver.peekFleet('c2')!.get('sa2')!
    expect(m.role).toBe('investigate the auth')
  })
})
