/**
 * Lifecycle tests for the per-sub-agent card registry.
 *
 * Wires a fake clock + manual timer dispatcher around
 * `createSubAgentCardRegistry` so we can assert on emit sequencing,
 * lazy spawn, coalesce, and finalize without touching real timers.
 */

import { describe, it, expect } from 'vitest'
import {
  createSubAgentCardRegistry,
  isPerAgentPinsEnabled,
  subAgentTurnKey,
  type SubAgentCardEmitArgs,
} from '../subagent-card.js'
import {
  initialState,
  reduce,
  type ProgressCardState,
} from '../progress-card.js'
import type { SessionEvent } from '../session-tail.js'

const BASE_TIME = 1_700_000_000_000
const PARENT_TURN_KEY = 'chat-1:42:1'
const CHAT_ID = 'chat-1'
const THREAD_ID = '42'

interface PendingTimer {
  fn: () => void
  ms: number
  cancelled: boolean
  fired: boolean
}

function mkHarness(opts: { enabled?: boolean; now?: () => number } = {}) {
  let nowVal = BASE_TIME
  const emits: SubAgentCardEmitArgs[] = []
  const tlog: string[] = []
  const timers: PendingTimer[] = []
  const intervals: PendingTimer[] = []

  const advance = (ms: number) => {
    nowVal += ms
  }

  const fireDueTimers = () => {
    for (const t of timers) {
      if (t.cancelled || t.fired) continue
      t.fired = true
      t.fn()
    }
  }

  const registry = createSubAgentCardRegistry(
    { enabled: opts.enabled ?? true },
    {
      emit: (args) => emits.push(args),
      now: opts.now ?? (() => nowVal),
      coalesceMs: 100,
      multiCardCoalesceMs: 200,
      minIntervalMs: 50,
      heartbeatMs: 1000,
      log: (line) => tlog.push(line),
      setT: (fn, ms) => {
        const entry: PendingTimer = { fn, ms, cancelled: false, fired: false }
        timers.push(entry)
        return { ref: entry }
      },
      clearT: (handle) => {
        const entry = handle.ref as PendingTimer
        entry.cancelled = true
      },
      setI: (fn, ms) => {
        const entry: PendingTimer = { fn, ms, cancelled: false, fired: false }
        intervals.push(entry)
        return { ref: entry }
      },
      clearI: (handle) => {
        const entry = handle.ref as PendingTimer
        entry.cancelled = true
      },
    },
  )

  return {
    registry,
    emits,
    tlog,
    timers,
    intervals,
    advance,
    fireDueTimers,
    now: () => nowVal,
  }
}

function enqueue(): SessionEvent {
  return { kind: 'enqueue', rawContent: '<channel>do work</channel>', messageId: 'm1' } as unknown as SessionEvent
}

function subStart(agentId: string, firstPromptText = 'go'): SessionEvent {
  return {
    kind: 'sub_agent_started',
    agentId,
    firstPromptText,
  } as unknown as SessionEvent
}

function subToolUse(agentId: string, toolName = 'Read', toolUseId = 'tu_1'): SessionEvent {
  return {
    kind: 'sub_agent_tool_use',
    agentId,
    toolName,
    toolUseId,
    input: { file_path: '/tmp/x.ts' },
  } as SessionEvent
}

function subToolResult(agentId: string, toolUseId = 'tu_1'): SessionEvent {
  return {
    kind: 'sub_agent_tool_result',
    agentId,
    toolUseId,
    isError: false,
  } as unknown as SessionEvent
}

function subTurnEnd(agentId: string): SessionEvent {
  return { kind: 'sub_agent_turn_end', agentId } as unknown as SessionEvent
}

function ingest(state: ProgressCardState, events: SessionEvent[], now: number): ProgressCardState {
  let s = state
  for (const e of events) s = reduce(s, e, now)
  return s
}

describe('subAgentTurnKey', () => {
  it('joins parent + agent with `::`', () => {
    expect(subAgentTurnKey('chat:42:1', 'sub-A')).toBe('chat:42:1::sub-A')
  })
})

describe('isPerAgentPinsEnabled', () => {
  it('returns true only when env flag is exactly "1"', () => {
    expect(isPerAgentPinsEnabled({ PROGRESS_CARD_PER_AGENT_PINS: '1' })).toBe(true)
    expect(isPerAgentPinsEnabled({ PROGRESS_CARD_PER_AGENT_PINS: '0' })).toBe(false)
    expect(isPerAgentPinsEnabled({})).toBe(false)
    expect(isPerAgentPinsEnabled({ PROGRESS_CARD_PER_AGENT_PINS: 'true' })).toBe(false)
  })
})

describe('lazy spawn — first content event', () => {
  it('does NOT spawn a card on sub_agent_started alone', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toEqual([])
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY)).toEqual([])
  })

  it('spawns + emits on the first sub_agent_tool_use', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A'), subToolUse('sub-A')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toHaveLength(1)
    expect(h.emits[0].agentId).toBe('sub-A')
    expect(h.emits[0].turnKey).toBe('chat-1:42:1::sub-A')
    expect(h.emits[0].chatId).toBe(CHAT_ID)
    expect(h.emits[0].threadId).toBe(THREAD_ID)
    expect(h.emits[0].isFirstEmit).toBe(true)
    expect(h.emits[0].done).toBe(false)
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY)).toEqual(['sub-A'])
  })

  it('spawns even when first content event is the terminal close', () => {
    // Cold-jsonl synth: a sub_agent_turn_end may arrive without prior
    // tool_use. Should still emit one card so the user sees what
    // happened.
    const h = mkHarness()
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A'), subTurnEnd('sub-A')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    // Terminal: the registry emits done=true on first sync.
    expect(h.emits).toHaveLength(1)
    expect(h.emits[0].done).toBe(true)
  })
})

describe('coalesce — burst events fire as one render', () => {
  it('a second sync within the coalesce window does NOT double-emit', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A'), subToolUse('sub-A')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toHaveLength(1)

    // Burst: another tool_use → another sync within the coalesce window.
    h.advance(20)
    state = ingest(state, [subToolResult('sub-A'), subToolUse('sub-A', 'Bash', 'tu_2')], h.now())
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toHaveLength(1) // still pending in the coalesce timer

    // Fire the coalesce timer.
    h.advance(150)
    h.fireDueTimers()
    expect(h.emits).toHaveLength(2)
    expect(h.emits[1].agentId).toBe('sub-A')
    expect(h.emits[1].isFirstEmit).toBe(false)
  })
})

describe('finalize — terminal state emits done=true exactly once', () => {
  it('sub_agent_turn_end after activity → done emit', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A'), subToolUse('sub-A')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toHaveLength(1)

    h.advance(100)
    state = ingest(state, [subToolResult('sub-A'), subTurnEnd('sub-A')], h.now())
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toHaveLength(2)
    expect(h.emits[1].done).toBe(true)
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY)).toEqual([])
  })

  it('finalizeAll force-finalizes any remaining cards', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A'), subToolUse('sub-A')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })

    h.advance(50)
    h.registry.finalizeAll(PARENT_TURN_KEY, h.now())
    // The final emit fires.
    const finalEmit = h.emits[h.emits.length - 1]
    expect(finalEmit.done).toBe(true)
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY)).toEqual([])
  })
})

describe('multi-agent: distinct cards, k-of-n indexing', () => {
  it('three sub-agents → three distinct emits with distinct turnKeys', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(
      state,
      [
        enqueue(),
        subStart('sub-A'), subToolUse('sub-A', 'Read', 'tu_a'),
        subStart('sub-B'), subToolUse('sub-B', 'Bash', 'tu_b'),
        subStart('sub-C'), subToolUse('sub-C', 'Grep', 'tu_c'),
      ],
      BASE_TIME,
    )
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toHaveLength(3)
    const turnKeys = h.emits.map((e) => e.turnKey).sort()
    expect(turnKeys).toEqual([
      'chat-1:42:1::sub-A',
      'chat-1:42:1::sub-B',
      'chat-1:42:1::sub-C',
    ])
    const agentIds = h.emits.map((e) => e.agentId).sort()
    expect(agentIds).toEqual(['sub-A', 'sub-B', 'sub-C'])
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY).sort()).toEqual(['sub-A', 'sub-B', 'sub-C'])
  })

  it('one sub-agent finishing leaves siblings tracked', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(
      state,
      [
        enqueue(),
        subStart('sub-A'), subToolUse('sub-A', 'Read', 'tu_a'),
        subStart('sub-B'), subToolUse('sub-B', 'Bash', 'tu_b'),
      ],
      BASE_TIME,
    )
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY).sort()).toEqual(['sub-A', 'sub-B'])

    h.advance(100)
    state = ingest(state, [subToolResult('sub-A', 'tu_a'), subTurnEnd('sub-A')], h.now())
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY)).toEqual(['sub-B'])
  })

  it('renders k-of-n where k starts at 2 (parent reserves k=1)', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(
      state,
      [
        enqueue(),
        subStart('sub-A'), subToolUse('sub-A', 'Read', 'tu_a'),
        subStart('sub-B'), subToolUse('sub-B', 'Bash', 'tu_b'),
      ],
      BASE_TIME,
    )
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toHaveLength(2)
    // Both render rows include "Agent X of 3" — parent counts as 1, two
    // sub-agents make total 3. k for sub-A is 2, k for sub-B is 3 (or
    // vice versa depending on spawn order).
    for (const e of h.emits) {
      expect(e.html).toMatch(/Agent [23] of 3/)
    }
    // Each card should mention exactly one of the agentIds in its title fallback chain.
    expect(h.emits.some((e) => e.html.includes('Agent 2 of 3'))).toBe(true)
    expect(h.emits.some((e) => e.html.includes('Agent 3 of 3'))).toBe(true)
  })
})

describe('disabled mode — no-op', () => {
  it('with enabled=false, syncFromParent is inert', () => {
    const h = mkHarness({ enabled: false })
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A'), subToolUse('sub-A')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toEqual([])
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY)).toEqual([])
  })
})

describe('dispose — cleans timers and state', () => {
  it('idempotent and clears tracked agentIds', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A'), subToolUse('sub-A')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY)).toEqual(['sub-A'])

    h.registry.dispose()
    expect(h.registry.trackedAgentIds(PARENT_TURN_KEY)).toEqual([])
    // Calling again is safe.
    expect(() => h.registry.dispose()).not.toThrow()
  })
})

describe('end-to-end: events drive emits with correct content', () => {
  it('first emit HTML contains title + status row + glyph', () => {
    const h = mkHarness()
    let state = initialState()
    state = ingest(state, [enqueue(), subStart('sub-A', 'go research'), subToolUse('sub-A', 'Read', 'tu_a')], BASE_TIME)
    h.registry.syncFromParent({ state, chatId: CHAT_ID, threadId: THREAD_ID, parentTurnKey: PARENT_TURN_KEY, now: h.now() })
    expect(h.emits).toHaveLength(1)
    const html = h.emits[0].html
    expect(html).toContain('<b>Agent 2 of 2</b>')
    // Read tool with file path renders as the verb.
    expect(html).toMatch(/<i>Read /)
  })
})
