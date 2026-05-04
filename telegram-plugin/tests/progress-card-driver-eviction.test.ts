/**
 * Regression: TTL eviction of internal dedup maps must NOT depend on the
 * heartbeat tick. The heartbeat stops whenever `chats.size === 0`, so any
 * eviction inside it leaves `seenEnqueueMsgIds` and `pendingSyncEchoes` to
 * grow unbounded across idle periods. Outer-base-key entries
 * (`chatRunningSubagents`, `baseTurnSeqs`) likewise need an explicit
 * cleanup hook on chat-close because nothing else ever drops them.
 *
 * Fix shape: an inline throttled `maybeEvict(now)` runs at the top of
 * every public ingress, and `completeTurnFully` calls
 * `cleanupBaseKeyIfUnused` after `chats.delete`.
 */
import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

let nextMsgId = 9000

function harness() {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; turnKey: string; html: string; done: boolean }> = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    minIntervalMs: 0,
    coalesceMs: 0,
    initialDelayMs: 0,
    heartbeatMs: 5000,
    now: () => now,
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref })
      return { ref }
    },
    clearTimeout: (handle) => {
      const target = (handle as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === target)
      if (idx !== -1) timers.splice(idx, 1)
    },
    setInterval: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref, repeat: ms })
      return { ref }
    },
    clearInterval: (handle) => {
      const target = (handle as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === target)
      if (idx !== -1) timers.splice(idx, 1)
    },
  })

  const advance = (ms: number): void => {
    now += ms
    for (;;) {
      timers.sort((a, b) => a.fireAt - b.fireAt)
      const next = timers[0]
      if (!next || next.fireAt > now) break
      if (next.repeat != null) {
        next.fireAt += next.repeat
        next.fn()
      } else {
        timers.shift()
        next.fn()
      }
    }
  }

  return { driver, emits, advance, getNow: () => now }
}

function enqueue(chatId: string, threadId?: string): SessionEvent {
  return {
    kind: 'enqueue',
    chatId,
    messageId: String(nextMsgId++),
    threadId: threadId ?? null,
    rawContent: `<channel chat_id="${chatId}">hi</channel>`,
  }
}

describe('progress-card-driver: TTL eviction off the heartbeat', () => {
  it('seenEnqueueMsgIds and pendingSyncEchoes stay bounded across idle periods (chats.size==0)', () => {
    const { driver, advance } = harness()
    const maps = driver._debugGetMaps!()

    // Drive 20 turn enqueue->complete cycles, advancing past the 60s TTL
    // between cycles. Critically, chats.size returns to 0 between cycles,
    // so the heartbeat stops — exposing the leak the fix targets.
    for (let i = 0; i < 20; i++) {
      driver.ingest(enqueue('chatA'), null)
      driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'chatA')
      // Advance well past both TTLs (60s for messageIds, 30s for echoes)
      // and past the eviction throttle (30s) so the next ingest evicts.
      advance(65_000)
      expect(maps.chats.size).toBe(0)
    }

    // After 20 cycles spread across >20 minutes of fake time, both dedup
    // maps must be tiny — they should never accumulate stale entries.
    expect(maps.seenEnqueueMsgIds.size).toBeLessThanOrEqual(1)
    expect(maps.pendingSyncEchoes.size).toBeLessThanOrEqual(1)
  })

  it('chatRunningSubagents and baseTurnSeqs drop their base-key on full chat close', () => {
    const { driver, advance } = harness()
    const maps = driver._debugGetMaps!()

    for (let i = 0; i < 20; i++) {
      driver.ingest(enqueue('chatA'), null)
      driver.ingest({ kind: 'sub_agent_started', agentId: `agent-${i}`, firstPromptText: 'x' }, 'chatA')
      driver.ingest({ kind: 'sub_agent_turn_end', agentId: `agent-${i}`, durationMs: 50 }, 'chatA')
      driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'chatA')
      advance(65_000)
      // Between turns, no chat is alive — outer base-key entries must be
      // gone too.
      expect(maps.chats.size).toBe(0)
      expect(maps.chatRunningSubagents.size).toBe(0)
      expect(maps.baseTurnSeqs.size).toBe(0)
    }
  })

  it('two chats sharing a baseKey: closing one does NOT delete the shared outer key', () => {
    // baseKey collapses (chatId, threadId) pairs with no thread to a single
    // string. Two threads on the same chat share a base only if they have
    // the same threadId; two distinct chatIds always have distinct bases.
    // Within a single chat, multiple concurrent turn-keys share the same
    // base — closing one of them must NOT prematurely drop the outer key
    // while the other turn is still alive.
    const { driver } = harness()
    const maps = driver._debugGetMaps!()

    // Start turn 1 on chatA — synthesises an enqueue and creates the card.
    driver.startTurn({ chatId: 'chatA', userText: 'first' })
    expect(maps.chats.size).toBe(1)
    expect(maps.baseTurnSeqs.get('chatA')).toBeGreaterThanOrEqual(1)

    // A second startTurn on the same chat force-closes turn 1 and creates
    // turn 2 — there is exactly one chat live again, but baseTurnSeqs has
    // ticked to 2. That outer entry must remain because turn 2 is alive.
    driver.startTurn({ chatId: 'chatA', userText: 'second' })
    expect(maps.chats.size).toBe(1)
    const seqAfter = maps.baseTurnSeqs.get('chatA')
    expect(seqAfter).toBeGreaterThanOrEqual(2)

    // End turn 2 → chats empty → base-key cleanup must run.
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'chatA')
    expect(maps.chats.size).toBe(0)
    expect(maps.baseTurnSeqs.has('chatA')).toBe(false)
    expect(maps.chatRunningSubagents.has('chatA')).toBe(false)
  })

  it('two distinct chats: closing one does NOT touch the other base-key', () => {
    // The driver routes turn_end via `currentTurnKey`, not `chatIdMaybe` —
    // a quirk of the session-tail single-stream design. To close a specific
    // chat from a test we use `forceCompleteTurn`, which is the path the
    // gateway invokes for explicit per-chat fan-out.
    const { driver } = harness()
    const maps = driver._debugGetMaps!()

    driver.ingest(enqueue('chatA'), null)
    driver.ingest(enqueue('chatB'), null)
    expect(maps.chats.size).toBe(2)
    expect(maps.baseTurnSeqs.has('chatA')).toBe(true)
    expect(maps.baseTurnSeqs.has('chatB')).toBe(true)

    // Close A only — must not touch chatB's base-key.
    driver.forceCompleteTurn({ chatId: 'chatA' })
    expect(maps.baseTurnSeqs.has('chatA')).toBe(false)
    expect(maps.baseTurnSeqs.has('chatB')).toBe(true)

    // Now close B.
    driver.forceCompleteTurn({ chatId: 'chatB' })
    expect(maps.baseTurnSeqs.has('chatB')).toBe(false)
    expect(maps.chats.size).toBe(0)
  })

  it('PR-C2 follow-up: bg-subagent-carry guard — chatRunningSubagents inner map survives turn_end while a sub-agent is still in flight', () => {
    // When parent turn_end fires but a sub-agent is still running, the
    // chatState enters pendingCompletion and the per-base
    // `chatRunningSubagents` inner map MUST NOT be cleaned up — the
    // next turn's enqueue will clone it back into the new fleet
    // (issue #334 / #64). Cleanup on close is gated on the inner map
    // being empty.
    const { driver } = harness()
    const maps = driver._debugGetMaps!()

    driver.ingest(enqueue('chatA'), null)
    driver.ingest(
      {
        kind: 'tool_use', toolName: 'Agent', toolUseId: 'tu1',
        input: { prompt: 'bg', run_in_background: true },
      },
      'chatA',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'saBG', firstPromptText: 'bg' }, 'chatA')
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, 'chatA')
    driver.recordOutboundDelivered('chatA')
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'chatA')

    // Pending — chats.size==1 (originating bg-pending state survives).
    expect(maps.chats.size).toBe(1)
    // Critical: the running-subagents inner map for 'chatA' must still
    // contain saBG. If cleanupBaseKeyIfUnused regressed and ran here,
    // the next turn would lose the bg carry.
    expect(maps.chatRunningSubagents.get('chatA')?.has('saBG')).toBe(true)

    // Resolve the bg sub-agent; now full close should also drain the
    // sync registry inner map.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'saBG' }, 'chatA')
    expect(maps.chats.size).toBe(0)
    expect(maps.chatRunningSubagents.has('chatA')).toBe(false)
  })
})
