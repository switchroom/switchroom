/**
 * Refactor regression: every per-chat close site must end in the SAME
 * post-conditions on the driver's internal state. Pre-refactor, three
 * code paths (turn_end → completeTurnFully, heartbeat zombie ceiling →
 * closeZombie, Gap-8 deferred-completion timeout → inline) reproduced
 * the cleanup tail by hand and diverged on edge cases. The refactor
 * funnels them all through `closePerChat(reason)` so the only remaining
 * deltas are:
 *
 *   - 'turn-end': no sub-agent force-close (none are running).
 *   - 'zombie'  : force-close running sub-agents; preserve
 *                 pendingSyncEchoes (echo may still arrive).
 *   - 'stalled' : force-close running sub-agents; flush(stalledClose=true).
 *
 * This test drives all three reasons against a fresh driver instance
 * and asserts the convergent post-conditions. It is the load-bearing
 * test for the unified close path — if it fails, the refactor regressed.
 */
import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

let nextMsgId = 7000

function harness(opts?: { maxIdleMs?: number; deferredCompletionTimeoutMs?: number }) {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; turnKey: string; html: string; done: boolean }> = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    minIntervalMs: 0,
    coalesceMs: 0,
    initialDelayMs: 0,
    heartbeatMs: 1_000,
    maxIdleMs: opts?.maxIdleMs ?? 30_000,
    deferredCompletionTimeoutMs: opts?.deferredCompletionTimeoutMs ?? 10_000,
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

function enqueue(chatId: string): SessionEvent {
  return {
    kind: 'enqueue',
    chatId,
    messageId: String(nextMsgId++),
    threadId: null,
    rawContent: `<channel chat_id="${chatId}">go</channel>`,
  }
}

describe('progress-card-driver: all close paths converge on identical final state', () => {
  it("'turn-end' path: chats empty, baseTurnSeqs cleaned, heartbeat stopped", () => {
    const { driver } = harness()
    const maps = driver._debugGetMaps!()

    driver.ingest(enqueue('cA'), null)
    expect(maps.chats.size).toBe(1)
    expect(maps.baseTurnSeqs.has('cA')).toBe(true)

    driver.ingest({ kind: 'turn_end', durationMs: 50 }, 'cA')

    expect(maps.chats.size).toBe(0)
    expect(maps.baseTurnSeqs.has('cA')).toBe(false)
    expect(maps.chatRunningSubagents.has('cA')).toBe(false)
  })

  it("'zombie' path (heartbeat maxIdle ceiling): same convergence + pendingSyncEchoes preserved", () => {
    const { driver, advance } = harness({ maxIdleMs: 5_000 })
    const maps = driver._debugGetMaps!()

    driver.ingest(enqueue('cA'), null)
    expect(maps.chats.size).toBe(1)

    // Seed a pending sync-echo so we can assert the zombie path leaves it
    // in place (the echo may still arrive after close).
    maps.pendingSyncEchoes.set('cA:fake', 1000)

    // Idle past maxIdleMs so the heartbeat reclassifies the card as zombie.
    advance(20_000)

    expect(maps.chats.size).toBe(0)
    expect(maps.baseTurnSeqs.has('cA')).toBe(false)
    expect(maps.chatRunningSubagents.has('cA')).toBe(false)
    // CRITICAL invariant: zombie close must NOT clear pendingSyncEchoes.
    // The dedup map's TTL eviction (maybeEvict) reaps it later.
    expect(maps.pendingSyncEchoes.has('cA:fake')).toBe(true)
  })

  it("'zombie' path also force-closes running sub-agents (sync registry drained)", () => {
    const { driver, advance } = harness({ maxIdleMs: 5_000 })
    const maps = driver._debugGetMaps!()

    driver.ingest(enqueue('cA'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'work' }, 'cA')
    expect(maps.chats.size).toBe(1)

    // Idle past maxIdleMs without ever reporting sub_agent_turn_end.
    advance(20_000)

    expect(maps.chats.size).toBe(0)
    // Issue #399: sync registry must be drained even when sub-agents
    // never reported their own turn_end.
    expect(maps.chatRunningSubagents.has('cA')).toBe(false)
  })

  it("'stalled' path (Gap-8 deferred-completion timeout): same convergence", () => {
    const { driver, advance } = harness({
      maxIdleMs: 999_999, // disable zombie ceiling so we hit the stalled branch
      deferredCompletionTimeoutMs: 5_000,
    })
    const maps = driver._debugGetMaps!()

    driver.ingest(enqueue('cA'), null)
    // Spawn a background sub-agent so parent turn_end defers instead of
    // closing immediately.
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu1',
        input: { prompt: 'bg', run_in_background: true },
      },
      'cA',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'bg' }, 'cA')
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'cA')
    // After parent turn_end: card alive in pendingCompletion.
    expect(maps.chats.size).toBe(1)

    // Sub-agent never reports done; advance past the deferred timeout so
    // the heartbeat's stalled-cards branch fires.
    advance(15_000)

    expect(maps.chats.size).toBe(0)
    expect(maps.baseTurnSeqs.has('cA')).toBe(false)
    expect(maps.chatRunningSubagents.has('cA')).toBe(false)
  })

  it('all three paths fire onTurnComplete callback exactly once', () => {
    // The completion callback is the externally-visible side-effect that
    // gates everything downstream (Stop hook, summary writer). Every
    // close path must fire it; the unified path makes that automatic
    // because the cleanup tail in completeTurnFully gates on
    // completionFired.
    const calls: string[] = []
    const opts = {
      onTurnComplete: (a: { turnKey: string }) => {
        calls.push(a.turnKey)
      },
    }
    let now = 1000
    const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
    let nextRef = 0
    const driver = createProgressDriver({
      emit: () => {},
      minIntervalMs: 0,
      coalesceMs: 0,
      initialDelayMs: 0,
      heartbeatMs: 1_000,
      maxIdleMs: 5_000,
      deferredCompletionTimeoutMs: 5_000,
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
      ...opts,
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

    // turn-end
    driver.ingest(enqueue('cA'), null)
    driver.ingest({ kind: 'turn_end', durationMs: 10 }, 'cA')
    // zombie
    driver.ingest(enqueue('cB'), null)
    advance(20_000)
    // stalled (after time has advanced to satisfy the deferred timeout)
    driver.ingest(enqueue('cC'), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tu',
        input: { prompt: 'bg', run_in_background: true },
      },
      'cC',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'sa', firstPromptText: 'bg' }, 'cC')
    driver.ingest({ kind: 'turn_end', durationMs: 10 }, 'cC')
    advance(20_000)

    // Each chat got exactly one completion callback.
    const byChat = new Map<string, number>()
    for (const tk of calls) {
      const chat = tk.split(':')[0]
      byChat.set(chat, (byChat.get(chat) ?? 0) + 1)
    }
    expect(byChat.get('cA')).toBe(1)
    expect(byChat.get('cB')).toBe(1)
    expect(byChat.get('cC')).toBe(1)
  })
})
