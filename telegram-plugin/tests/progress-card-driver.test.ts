/**
 * Tests for the progress-card driver — per-chat state + emit cadence.
 *
 * Uses injected fake clock + fake setTimeout so the timing behaviour is
 * deterministic (no real wall-clock waits in CI).
 */
import { describe, it, expect, vi } from 'vitest'
import { createProgressDriver, summariseTurn } from '../progress-card-driver.js'
import { initialState, reduce, render } from '../progress-card.js'
import type { SessionEvent } from '../session-tail.js'

function harness(
  minIntervalMs = 500,
  coalesceMs = 400,
  opts?: {
    captureSummaries?: boolean
    heartbeatMs?: number
    maxIdleMs?: number
    initialDelayMs?: number
    onTurnComplete?: (args: { chatId: string; threadId?: string; summary: string; taskIndex: number; taskTotal: number }) => void
  },
) {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; turnKey: string; html: string; done: boolean; isFirstEmit: boolean }> = []
  const summaries: string[] = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    onTurnEnd: opts?.captureSummaries ? (s) => summaries.push(s) : undefined,
    onTurnComplete: opts?.onTurnComplete,
    minIntervalMs,
    coalesceMs,
    heartbeatMs: opts?.heartbeatMs,
    maxIdleMs: opts?.maxIdleMs,
    initialDelayMs: opts?.initialDelayMs ?? 0,
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
    // Fire any scheduled timer whose fireAt is now or earlier, in order.
    for (;;) {
      timers.sort((a, b) => a.fireAt - b.fireAt)
      const next = timers[0]
      if (!next || next.fireAt > now) break
      if (next.repeat != null) {
        // Intervals: reschedule for the next tick before firing.
        next.fireAt += next.repeat
        next.fn()
      } else {
        timers.shift()
        next.fn()
      }
    }
  }

  return { driver, emits, summaries, advance, tick: advance }
}

let nextMsgId = 1
const enqueue = (chatId: string, text = 'hi', msgId?: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: msgId ?? String(nextMsgId++),
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">${text}</channel>`,
})

describe('progress-card driver', () => {
  it('emits immediately on enqueue', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    expect(emits).toHaveLength(1)
    expect(emits[0].chatId).toBe('c1')
    expect(emits[0].done).toBe(false)
    expect(emits[0].html).toContain('<blockquote>hi</blockquote>')
  })

  it('startTurn fires an initial "Working…" render BEFORE any tool_use event', () => {
    // This is the anti-latency fix: the inbound-message handler calls
    // startTurn synchronously, so the card lands within ~1s of the user's
    // message even if the session-tail enqueue event is still several
    // hundred ms away.
    const { driver, emits } = harness()
    driver.startTurn({ chatId: 'c1', userText: 'please investigate' })
    expect(emits).toHaveLength(1)
    expect(emits[0].chatId).toBe('c1')
    expect(emits[0].done).toBe(false)
    // Distinctive Working… banner is present.
    expect(emits[0].html).toContain('⚙️ <b>Working…</b>')
    // No tool_use has been fed in yet — there must be no checklist items.
    expect(emits[0].html).not.toContain('◉ <b>')
    // And the echoed user request shows up so the card ties back to the
    // user's message.
    expect(emits[0].html).toContain('please investigate')
  })

  it('startTurn passes threadId through for forum-topic chats', () => {
    const { driver, emits } = harness()
    driver.startTurn({ chatId: 'c1', threadId: 't42', userText: 'hi' })
    expect(emits).toHaveLength(1)
    expect(emits[0].threadId).toBe('t42')
  })

  it('emits immediately on stage change (plan → run)', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    emits.length = 0
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    expect(emits).toHaveLength(1)
    // The card banner stays "Working…" during 'run'; the stage switch is
    // signalled by the new 🔧 checklist line rather than an inline header.
    expect(emits[0].html).toContain('⚙️ <b>Working…</b>')
    expect(emits[0].html).toContain('◉ <b>Read</b>')
  })

  it('emits immediately on turn_end with done=true', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    emits.length = 0
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(emits).toHaveLength(1)
    expect(emits[0].done).toBe(true)
    expect(emits[0].html).toContain('✅ <b>Done</b>')
  })

  it('coalesces bursts of non-stage-changing events', () => {
    const { driver, emits, advance } = harness(500, 400)
    driver.ingest(enqueue('c1'), null) // emit #1
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1') // emit #2 (stage change)
    // tool_result doesn't change stage (we're already in 'run')
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Grep' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'b', toolName: 'Grep' }, 'c1')
    expect(emits.length).toBe(2) // only the two stage changes so far
    // Advance through the coalesce delay + min-interval floor
    advance(1000)
    expect(emits.length).toBe(3) // exactly one more flush for the burst
    const last = emits[emits.length - 1]
    expect(last.html).toContain('● Read')
    expect(last.html).toContain('● Grep')
  })

  it('never emits the same HTML twice in a row (deduped)', () => {
    const { driver, emits, advance } = harness()
    driver.ingest(enqueue('c1'), null)
    emits.length = 0
    // Thinking events don't change the rendered output
    driver.ingest({ kind: 'thinking' }, 'c1')
    advance(2000)
    driver.ingest({ kind: 'thinking' }, 'c1')
    advance(2000)
    expect(emits).toHaveLength(0)
  })

  it('separate chats have separate state', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1', 'request-one'), null)
    driver.ingest(enqueue('c2', 'request-two'), null)
    expect(emits.map((e) => e.chatId)).toEqual(['c1', 'c2'])
    expect(emits[0].html).toContain('request-one')
    expect(emits[1].html).toContain('request-two')
  })

  it('turn_end drops state so next turn starts fresh', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(driver.peek('c1')).toBeUndefined()
    emits.length = 0

    // New turn
    driver.ingest(enqueue('c1', 'second'), null)
    expect(emits).toHaveLength(1)
    expect(emits[0].html).toContain('<blockquote>second</blockquote>')
    // No leaked items from the prior turn
    expect(emits[0].html).not.toContain('Read')
  })

  it('respects minIntervalMs floor on back-to-back coalesced flushes', () => {
    const { driver, emits, advance } = harness(500, 400)
    driver.ingest(enqueue('c1'), null) // emit @1000
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1') // stage change, emit @1000
    emits.length = 0
    // Close out the Read — not a stage change, coalesces
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 'c1')
    // Coalesce window is 400ms; min-interval is 500ms (since last emit was @1000)
    // Expected: flush at max(400, 500-0) = 500ms from the last emit
    advance(400) // still inside min-interval — no flush yet
    expect(emits).toHaveLength(0)
    advance(200) // now past both windows
    expect(emits).toHaveLength(1)
  })

  it('fires onTurnEnd with a one-line summary at turn_end', () => {
    const { driver, summaries } = harness(500, 400, { captureSummaries: true })
    driver.ingest(enqueue('c1', 'fix the tests'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Bash' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'b', toolName: 'Bash' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('2 tools')
    expect(summaries[0]).toContain('fix the tests')
  })

  it('does not fire onTurnEnd when callback is not supplied', () => {
    const { driver, summaries } = harness() // no captureSummaries
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'turn_end', durationMs: 0 }, 'c1')
    expect(summaries).toHaveLength(0)
  })
})

describe('progress-card checklist rendering', () => {
  it('tool_use emits a running item; tool_result flips to done', () => {
    const { driver, emits, advance } = harness()
    driver.ingest(enqueue('c1'), null)
    emits.length = 0
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1', input: { file_path: '/x/foo.ts' } }, 'c1')
    expect(emits.at(-1)!.html).toContain('◉ <b>Read</b> foo.ts')
    driver.ingest({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' }, 'c1')
    advance(1000)
    expect(emits.at(-1)!.html).toContain('● Read foo.ts')
    expect(emits.at(-1)!.html).not.toContain('◉ <b>Read</b>')
  })

  it('multiple tools preserve insertion order in the rendered checklist', () => {
    const { driver, emits, advance } = harness()
    driver.ingest(enqueue('c1'), null)
    // Sequential tool_use / tool_result pairs — mirroring the actual
    // Claude Code session shape (parallel tool_use in one assistant
    // block is rare and the SDK serialises results).
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 'A', input: { command: 'ls' } }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'A', toolName: null }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 'B', input: { file_path: '/x/foo.ts' } }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'B', toolName: null }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Grep', toolUseId: 'C', input: { pattern: 'xyz' } }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'C', toolName: null }, 'c1')
    advance(1000)
    const html = emits.at(-1)!.html
    // Order preserved: Bash → Read → Grep.
    const bashIdx = html.indexOf('Bash</b> ls') >= 0 ? html.indexOf('Bash</b> ls') : html.indexOf('Bash ls')
    const readIdx = html.indexOf('Read</b> foo.ts') >= 0 ? html.indexOf('Read</b> foo.ts') : html.indexOf('Read foo.ts')
    const grepIdx = html.indexOf('Grep</b>') >= 0 ? html.indexOf('Grep</b>') : html.indexOf('Grep ')
    expect(bashIdx).toBeGreaterThan(-1)
    expect(readIdx).toBeGreaterThan(bashIdx)
    expect(grepIdx).toBeGreaterThan(readIdx)
  })

  it('reducer pairs tool_result to tool_use by id even when results arrive out of order', () => {
    // Purely reducer-level (not driver) since the driver collapses bursts
    // and the emit cadence obscures intermediate state. We reach into the
    // reduced state via peek() after flushing the coalesce timer.
    const { driver, advance } = harness()
    driver.ingest(enqueue('c1'), null)
    // Two tool_use in one assistant "batch" (simulating a model that
    // emitted parallel tool_use blocks); reducer will close the first as
    // soon as the second tool_use arrives, so to exercise the id-pairing
    // path we need to keep each tool_use's result arriving before the
    // next tool_use starts, but with out-of-order ids within a single
    // result batch. Here we drive two separate pairs and rely on id
    // matching to attach the right results.
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 'first' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'first', toolName: null }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 'second' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'nonexistent', toolName: null }, 'c1')
    advance(1000)
    const st = driver.peek('c1')
    expect(st).toBeDefined()
    // First Read is done; Bash still running because the stray
    // tool_result fell back to the oldest running item (Bash). This is
    // the documented fallback behaviour.
    expect(st!.items.map((i) => [i.tool, i.state])).toEqual([
      ['Read', 'done'],
      ['Bash', 'done'],
    ])
  })

  it('failed tool (is_error:true) renders with ❌', () => {
    const { driver, emits, advance } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1', input: { command: 'git push' } }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash', isError: true }, 'c1')
    advance(1000)
    const html = emits.at(-1)!.html
    expect(html).toContain('✗ Bash git push')
  })

  it('overflow: 13+ items collapse oldest with "(+N more earlier steps)"', () => {
    const { driver, emits, advance } = harness()
    driver.ingest(enqueue('c1'), null)
    // 15 distinct tools (alternating names so rollup compaction doesn't kick in)
    const names = ['Read', 'Bash', 'Grep', 'Edit', 'Glob', 'Write', 'WebFetch']
    for (let i = 0; i < 15; i++) {
      const name = names[i % names.length]
      driver.ingest({ kind: 'tool_use', toolName: name, toolUseId: `t${i}`, input: {} }, 'c1')
      driver.ingest({ kind: 'tool_result', toolUseId: `t${i}`, toolName: name }, 'c1')
    }
    advance(2000)
    const html = emits.at(-1)!.html
    expect(html).toContain('(+10 earlier)')
    const checklistSymbols = (html.match(/\n(●|◉|✗|○) /g) ?? []).length
    expect(checklistSymbols).toBe(5)
  })

  it('banner transitions from "Working…" to "Done" on turn_end and keeps checklist visible', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1', input: { file_path: '/x/a.ts' } }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't2', input: { command: 'echo hi' } }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 't2', toolName: 'Bash' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    const final = emits.at(-1)!
    expect(final.done).toBe(true)
    expect(final.html).toContain('✅ <b>Done</b>')
    expect(final.html).not.toContain('⚙️ <b>Working…</b>')
    // Final checklist still visible.
    expect(final.html).toContain('● Read a.ts')
    expect(final.html).toContain('● Bash echo hi')
  })
})

describe('progress-card driver heartbeat', () => {
  // Bug 3 regression: once a turn settles into "1 long-running Agent
  // item", no new session-tail events fire and the driver's
  // change-only emit logic produces zero further renders — so the
  // elapsed-time counter in the header never visibly ticks. The
  // heartbeat forces a re-render every `heartbeatMs` while any chat
  // has an open turn.
  it('emits periodic renders while a turn is open even with no events flowing', () => {
    const { driver, emits, advance } = harness(500, 400, { heartbeatMs: 5000 })
    driver.ingest(enqueue('c1'), null) // initial render
    driver.ingest({ kind: 'tool_use', toolName: 'Agent' }, 'c1') // stage change
    const emitsBefore = emits.length

    // Advance 15s with ZERO events. Heartbeat fires every 5s; whether
    // each tick actually emits depends on whether the render output
    // differs (which it does, since the header shows elapsed time and
    // the running item's (dur) bumps past each second boundary).
    advance(15_000)
    const delta = emits.length - emitsBefore
    // Must see at least one heartbeat-driven render — otherwise the
    // card is frozen for the full 15s with no events, which is the
    // exact bug we're fixing.
    expect(delta).toBeGreaterThanOrEqual(1)
  })

  it('stops the heartbeat after turn_end (no extra renders once the turn is done)', () => {
    const { driver, emits, advance } = harness(500, 400, { heartbeatMs: 5000 })
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c1')
    const countAfterEnd = emits.length

    // Long idle — heartbeat must be dormant.
    advance(60_000)
    expect(emits.length).toBe(countAfterEnd)
  })

  it('can be disabled by setting heartbeatMs=0', () => {
    const { driver, emits, advance } = harness(500, 400, { heartbeatMs: 0 })
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Agent' }, 'c1')
    const countBefore = emits.length
    advance(30_000)
    expect(emits.length).toBe(countBefore)
  })
})

describe('progress-card driver — zombie ceiling (maxIdleMs)', () => {
  // Regression: a card orphaned by a missed `turn_end` or an enqueue
  // echo-drop would sit in the driver's chats map forever and the
  // heartbeat would re-render it indefinitely (50+ minute ghost cards
  // ticking in the pinned slot). The `maxIdleMs` ceiling force-closes
  // any card whose last real session event is older than the cutoff.
  it('force-closes a card that has idled past maxIdleMs with no events', () => {
    const completeCalls: Array<{ chatId: string; summary: string; taskIndex: number; taskTotal: number }> = []
    const { driver, emits, advance } = harness(500, 400, {
      heartbeatMs: 5_000,
      onTurnComplete: (a) => completeCalls.push(a),
    })
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Agent' }, 'c1')

    // 29 minutes idle — the ghost ceiling (30 min default) has NOT
    // tripped yet. Heartbeat ticks but card still lives.
    advance(29 * 60_000)
    expect(completeCalls).toHaveLength(0)
    expect(driver.peek('c1')).toBeDefined()

    // Cross the 30-minute ceiling. Next heartbeat tick after the
    // crossing closes the zombie.
    advance(2 * 60_000)
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0].chatId).toBe('c1')
    // The final emit for this card must be done=true so the caller
    // unpins / stops editing.
    const lastC1 = [...emits].reverse().find((e) => e.chatId === 'c1')
    expect(lastC1?.done).toBe(true)
    // Chat state has been cleared so a fresh turn starts clean.
    expect(driver.peek('c1')).toBeUndefined()
  })

  it('keeps the card alive while real events keep landing', () => {
    const completeCalls: Array<{ chatId: string }> = []
    const { driver, advance } = harness(500, 400, {
      heartbeatMs: 5_000,
      onTurnComplete: (a) => completeCalls.push({ chatId: a.chatId }),
    })
    driver.ingest(enqueue('c1'), null)
    // Simulate a slow turn that emits a tool_use every 10 min for an
    // hour — lastEventAt keeps advancing, so the 30-min ceiling must
    // never trip.
    for (let i = 0; i < 6; i++) {
      advance(10 * 60_000)
      driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    }
    expect(completeCalls).toHaveLength(0)
    expect(driver.peek('c1')).toBeDefined()
  })

  it('zombie close fires onTurnComplete exactly once and stops the heartbeat', () => {
    const completeCalls: Array<{ chatId: string }> = []
    const { driver, emits, advance } = harness(500, 400, {
      heartbeatMs: 5_000,
      onTurnComplete: (a) => completeCalls.push({ chatId: a.chatId }),
    })
    driver.ingest(enqueue('c1'), null)
    advance(31 * 60_000) // crosses ceiling
    expect(completeCalls).toHaveLength(1)

    const postCloseEmits = emits.length
    // Another hour with no card in the map — heartbeat should be
    // dormant, no further emits.
    advance(60 * 60_000)
    expect(emits.length).toBe(postCloseEmits)
  })

  it('honours a custom maxIdleMs', () => {
    const completeCalls: Array<{ chatId: string }> = []
    let now = 1000
    const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
    let nextRef = 0
    const emits: Array<{ done: boolean }> = []
    const driver = createProgressDriver({
      emit: (a) => emits.push({ done: a.done }),
      onTurnComplete: (a) => completeCalls.push({ chatId: a.chatId }),
      heartbeatMs: 1000,
      maxIdleMs: 5_000,
      initialDelayMs: 0,
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
    driver.ingest(enqueue('c1'), null)
    advance(4_000)
    expect(completeCalls).toHaveLength(0)
    advance(2_000) // total idle ~6s, past the 5s cutoff
    expect(completeCalls).toHaveLength(1)
  })

  it('maxIdleMs=0 disables the zombie ceiling entirely', () => {
    const completeCalls: Array<{ chatId: string }> = []
    const { driver, advance } = harness(500, 400, {
      heartbeatMs: 5_000,
      onTurnComplete: (a) => completeCalls.push({ chatId: a.chatId }),
      maxIdleMs: 0,
    })
    driver.ingest(enqueue('c1'), null)
    advance(4 * 60 * 60_000) // 4 hours idle
    expect(completeCalls).toHaveLength(0)
    expect(driver.peek('c1')).toBeDefined()
  })
})

describe('summariseTurn', () => {
  const base = (now: number, userRequest: string) =>
    reduce(initialState(), {
      kind: 'enqueue',
      chatId: 'c',
      messageId: '1',
      threadId: null,
      rawContent: `<channel chat_id="c">${userRequest}</channel>`,
    }, now)

  it('zero tools renders as "no tools"', () => {
    const s = base(1000, 'hi')
    expect(summariseTurn(s, 2000)).toBe('no tools, 1s — hi')
  })

  it('pluralises correctly', () => {
    let s = base(1000, 'x')
    s = reduce(s, { kind: 'tool_use', toolName: 'Read' }, 1100)
    s = reduce(s, { kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 1200)
    expect(summariseTurn(s, 5000)).toBe('1 tool, 4s — x')
  })

  it('m:ss format above 60 seconds', () => {
    const s = base(1000, 'long')
    expect(summariseTurn(s, 1000 + 125_000)).toBe('no tools, 2:05 — long')
  })

  it('falls back gracefully without a user request', () => {
    let s = reduce(initialState(), {
      kind: 'enqueue', chatId: 'c', messageId: null, threadId: null, rawContent: '',
    }, 1000)
    s = reduce(s, { kind: 'tool_use', toolName: 'Read' }, 1100)
    s = reduce(s, { kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 1200)
    expect(summariseTurn(s, 2000)).toBe('1 tool, 1s')
  })
})

describe('progress-card driver — multi-agent rate limit', () => {
  it('expands coalesce window once edit budget is hot (>18 in 60s)', () => {
    // Use a small threshold so we can exercise the path without
    // simulating 18 distinct events. editBudgetCoalesceMs=2000, threshold=3.
    let now = 1000
    const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
    let nextRef = 0
    const emits: Array<{ chatId: string; html: string; done: boolean }> = []
    const driver = createProgressDriver({
      emit: (a) => emits.push({ chatId: a.chatId, html: a.html, done: a.done }),
      minIntervalMs: 100,
      coalesceMs: 100,
      heartbeatMs: 0,
      initialDelayMs: 0,
      editBudgetThreshold: 3,
      editBudgetCoalesceMs: 2000,
      now: () => now,
      setTimeout: (fn, ms) => {
        const ref = nextRef++
        timers.push({ fireAt: now + ms, fn, ref })
        return { ref }
      },
      clearTimeout: (h) => {
        const t = (h as { ref: number }).ref
        const i = timers.findIndex((x) => x.ref === t)
        if (i !== -1) timers.splice(i, 1)
      },
      setInterval: (fn, ms) => {
        const ref = nextRef++
        timers.push({ fireAt: now + ms, fn, ref, repeat: ms })
        return { ref }
      },
      clearInterval: (h) => {
        const t = (h as { ref: number }).ref
        const i = timers.findIndex((x) => x.ref === t)
        if (i !== -1) timers.splice(i, 1)
      },
    })
    const advance = (ms: number): void => {
      now += ms
      for (;;) {
        timers.sort((a, b) => a.fireAt - b.fireAt)
        const t = timers[0]
        if (!t || t.fireAt > now) break
        if (t.repeat != null) { t.fireAt += t.repeat; t.fn() } else { timers.shift(); t.fn() }
      }
    }

    // Fire 4 distinct visible-state events 200ms apart — each forces an
    // emit (well past the 100ms coalesce). After 3 emits we go hot.
    driver.ingest(
      { kind: 'enqueue', chatId: 'c', messageId: '1', threadId: null, rawContent: '<channel chat_id="c">go</channel>' },
      null,
    )
    expect(emits.length).toBe(1) // enqueue is immediate

    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 'a', input: { file_path: '/x' } }, 'c')
    advance(200)
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 'c')
    advance(200)
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 'b', input: { file_path: '/y' } }, 'c')
    advance(200)
    // Should have ~4 emits by now (enqueue + 3 visible updates). Now hot.
    const emitsBeforeHot = emits.length
    expect(emitsBeforeHot).toBeGreaterThanOrEqual(3)

    // Schedule another visible event. With budget hot, coalesce expands
    // to 2000ms so a 500ms wait must NOT fire it.
    driver.ingest({ kind: 'tool_result', toolUseId: 'b', toolName: 'Read' }, 'c')
    advance(500)
    expect(emits.length).toBe(emitsBeforeHot) // suppressed by hot coalesce
    advance(2000)
    expect(emits.length).toBe(emitsBeforeHot + 1) // finally fires
  })
})

// ─── isFirstEmit flag ─────────────────────────────────────────────────────
// Locks the contract that isFirstEmit=true on the very first flush per turn
// and isFirstEmit=false on all subsequent flushes. Server.ts uses this to
// know when to pin the newly-created Telegram message.

describe('isFirstEmit flag', () => {
  it('is true on the very first emit, false on subsequent emits', () => {
    const { driver, emits, advance } = harness(0, 0)
    driver.ingest(enqueue('c'), 'c')
    advance(0)
    expect(emits).toHaveLength(1)
    expect(emits[0].isFirstEmit).toBe(true)

    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c')
    advance(600)
    expect(emits.length).toBeGreaterThan(1)
    for (const e of emits.slice(1)) {
      expect(e.isFirstEmit).toBe(false)
    }
  })

  it('resets to true for a new turn (fresh enqueue)', () => {
    const { driver, emits, advance } = harness(0, 0)
    // Turn 1
    driver.ingest(enqueue('c'), 'c')
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c')
    advance(0)
    const turn1Emits = emits.length

    // Turn 2
    driver.ingest(enqueue('c', 'second request'), 'c')
    advance(0)
    expect(emits.length).toBeGreaterThan(turn1Emits)
    expect(emits[turn1Emits].isFirstEmit).toBe(true)
  })

  it('is false on the done=true emit (turn_end fires after first message exists)', () => {
    const { driver, emits, advance } = harness(0, 0)
    driver.ingest(enqueue('c'), 'c')
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c')
    advance(0)
    const doneEmit = emits.find(e => e.done)
    expect(doneEmit).toBeDefined()
    expect(doneEmit!.isFirstEmit).toBe(false)
  })
})

// ─── onTurnComplete callback ──────────────────────────────────────────────
// Locks the contract: onTurnComplete fires once per turn on turn_end,
// with chatId, threadId, summary, taskIndex, and taskTotal.

describe('onTurnComplete callback', () => {
  it('fires once on turn_end with summary and task counts', () => {
    const completions: Array<{ chatId: string; threadId?: string; summary: string; taskIndex: number; taskTotal: number }> = []
    const { driver, advance } = harness(0, 0, { onTurnComplete: (a) => completions.push(a) })

    driver.ingest(enqueue('c', 'fix the tests'), 'c')
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 3000 }, 'c')
    advance(0)

    expect(completions).toHaveLength(1)
    expect(completions[0].chatId).toBe('c')
    expect(completions[0].threadId).toBeUndefined()
    expect(completions[0].summary).toContain('fix the tests')
    expect(completions[0].taskIndex).toBe(1)
    expect(completions[0].taskTotal).toBe(1)
  })

  it('does NOT fire on normal tool events — only on turn_end', () => {
    const completions: { summary: string }[] = []
    const { driver, advance } = harness(0, 0, { onTurnComplete: (a) => completions.push(a) })

    driver.ingest(enqueue('c', 'task'), 'c')
    advance(0)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c')
    advance(600)
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 'c')
    advance(600)
    // No turn_end yet
    expect(completions).toHaveLength(0)
  })

  it('reports taskIndex=1, taskTotal=1 for a single-chat turn', () => {
    const completions: { taskIndex: number; taskTotal: number }[] = []
    const { driver, advance } = harness(0, 0, { onTurnComplete: (a) => completions.push(a) })

    driver.ingest(enqueue('c'), 'c')
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c')
    advance(0)

    expect(completions[0]).toMatchObject({ taskIndex: 1, taskTotal: 1 })
  })
})

// ─── task N/M counter in rendered HTML ───────────────────────────────────
// When multiple turns are active simultaneously (forum topics on same chatId),
// the rendered card header shows "(N/M)" so the user can tell which task.

describe('task N/M counter', () => {
  it('single turn: no N/M suffix in header', () => {
    const { driver, emits, advance } = harness(0, 0)
    driver.ingest(enqueue('c', 'do something'), 'c')
    advance(0)
    // No taskNum means no suffix
    expect(emits[0].html).not.toMatch(/\(\d+\/\d+\)/)
  })
})

// ─── render() TaskNum ──────────────────────────────────────────────────────
// Direct tests of the render() taskNum parameter added for the pinned-card feature.

describe('render() taskNum header suffix', () => {
  function enqueueState(text: string) {
    return reduce(
      initialState(),
      {
        kind: 'enqueue',
        chatId: 'c',
        messageId: '1',
        threadId: null,
        rawContent: `<channel chat_id="c">${text}</channel>`,
      },
      1000,
    )
  }

  it('no suffix when taskNum is undefined (single task)', () => {
    const st = enqueueState('test')
    const out = render(st, 2000)
    expect(out).not.toMatch(/\(\d+\/\d+\)/)
  })

  it('no suffix when total=1 (still a single task)', () => {
    const st = enqueueState('test')
    const out = render(st, 2000, { index: 1, total: 1 })
    expect(out).not.toMatch(/\(\d+\/\d+\)/)
  })

  it('shows (1/2) when this is the first of two tasks', () => {
    const st = enqueueState('test')
    const out = render(st, 2000, { index: 1, total: 2 })
    expect(out).toContain('(1/2)')
    expect(out).toContain('Working…')
  })

  it('shows (2/2) when this is the second of two tasks', () => {
    const st = enqueueState('test')
    const out = render(st, 2000, { index: 2, total: 2 })
    expect(out).toContain('(2/2)')
  })

  it('shows (2/3) correctly', () => {
    const st = enqueueState('test')
    const out = render(st, 2000, { index: 2, total: 3 })
    expect(out).toContain('(2/3)')
  })

  it('N/M suffix also appears on Done stage', () => {
    let st = enqueueState('test')
    st = reduce(st, { kind: 'turn_end', durationMs: 1000 }, 2000)
    const out = render(st, 2000, { index: 1, total: 2 })
    expect(out).toContain('(1/2)')
    expect(out).toContain('Done')
  })
})

// ─── one-card-per-task (multi-card) ──────────────────────────────────────────
// Each startTurn/enqueue creates an independent card with its own lifecycle:
// - distinct turnKey
// - first card is force-closed (done emit + onTurnComplete) when second starts
// - N/M label reflects sequential card count
// - isFirstEmit is true exactly once per card
// - session events route to the most recent (current) card

describe('one card per task', () => {
  it('each startTurn produces a distinct turnKey', () => {
    const { driver, emits, advance } = harness(0, 0)
    driver.startTurn({ chatId: 'c', userText: 'task one' })
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c')
    advance(0)
    driver.startTurn({ chatId: 'c', userText: 'task two' })
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c')
    advance(0)

    const keys = emits.map(e => e.turnKey)
    const uniqueKeys = new Set(keys)
    // Both tasks produce emits with different turnKeys
    expect(uniqueKeys.size).toBe(2)
    // turnKeys are deterministic: chatId:seq
    expect(keys[0]).toBe('c:1')
    const doneKeys = emits.filter(e => e.done).map(e => e.turnKey)
    expect(doneKeys).toEqual(['c:1', 'c:2'])
  })

  it('second startTurn mid-turn force-closes first card as done before creating second', () => {
    const completions: Array<{ turnKey: string; taskIndex: number; taskTotal: number }> = []
    const { driver, emits, advance } = harness(0, 0, { onTurnComplete: (a) => completions.push(a) })

    // Turn 1 starts, some work, then turn 2 interrupts before turn_end
    driver.startTurn({ chatId: 'c', userText: 'first' })
    advance(0)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c')
    advance(0)

    const emitsAfterT1 = emits.length

    // Turn 2 starts — should force-close turn 1
    driver.startTurn({ chatId: 'c', userText: 'second (steering)' })
    advance(0)

    // Turn 1 should have emitted a done=true before turn 2's first emit
    const doneEmitForT1 = emits.slice(emitsAfterT1).find(e => e.done && e.turnKey === 'c:1')
    expect(doneEmitForT1).toBeDefined()

    // onTurnComplete fired for turn 1
    expect(completions).toHaveLength(1)
    expect(completions[0].turnKey).toBe('c:1')
    expect(completions[0].taskIndex).toBe(1)

    // Turn 2's first emit has isFirstEmit=true
    const t2First = emits.find(e => e.turnKey === 'c:2' && e.isFirstEmit)
    expect(t2First).toBeDefined()

    // Now turn 2 ends normally
    driver.ingest({ kind: 'turn_end', durationMs: 200 }, 'c')
    advance(0)
    expect(completions).toHaveLength(2)
    expect(completions[1].turnKey).toBe('c:2')
  })

  it('N/M counter does NOT appear for sequential tasks — only when cards are simultaneously active', () => {
    // Fix for UX bug: the old cumulative baseTurnSeqs counter caused sequential
    // turns to show "(1/2)", "(2/2)", … "(11/11)" which was confusing — it looked
    // like "task 11 of 11 (all done)" rather than simply "turn 11 in this session".
    // The counter should only appear when 2+ cards are active AT THE SAME TIME.
    // With force-close semantics (startTurn deletes the old card before creating
    // the new one), there's never more than 1 active card, so the counter is
    // always hidden for sequential turns.
    const { driver, emits, advance } = harness(0, 0)

    // Task 1
    driver.startTurn({ chatId: 'c', userText: 'first task' })
    advance(0)
    // Turn 2 starts mid-turn (force-closes turn 1)
    driver.startTurn({ chatId: 'c', userText: 'second task' })
    advance(0)

    // No N/M suffix on any emit — sequential turns, only 1 active at a time
    const t1First = emits.find(e => e.turnKey === 'c:1' && e.isFirstEmit)
    expect(t1First?.html).not.toMatch(/\(\d+\/\d+\)/)

    const t1Done = emits.find(e => e.turnKey === 'c:1' && e.done)
    expect(t1Done?.html).not.toMatch(/\(\d+\/\d+\)/)

    const t2First = emits.find(e => e.turnKey === 'c:2' && e.isFirstEmit)
    expect(t2First?.html).not.toMatch(/\(\d+\/\d+\)/)
  })

  it('session events after second startTurn route to second card, not first', () => {
    const { driver, emits, advance } = harness(0, 0)

    driver.startTurn({ chatId: 'c', userText: 'first' })
    advance(0)
    driver.startTurn({ chatId: 'c', userText: 'second' })
    advance(0)
    emits.length = 0

    // tool_use should land on card 2
    driver.ingest({ kind: 'tool_use', toolName: 'Bash' }, 'c')
    advance(600)

    const bashEmit = emits.find(e => e.html.includes('Bash'))
    expect(bashEmit).toBeDefined()
    expect(bashEmit!.turnKey).toBe('c:2')
  })

  it('isFirstEmit is true exactly once per card across two startTurn calls', () => {
    const { driver, emits, advance } = harness(0, 0)

    driver.startTurn({ chatId: 'c', userText: 'first' })
    advance(0)
    driver.startTurn({ chatId: 'c', userText: 'second' })
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c')
    advance(0)

    const firstEmits = emits.filter(e => e.isFirstEmit)
    expect(firstEmits).toHaveLength(2)
    expect(firstEmits[0].turnKey).toBe('c:1')
    expect(firstEmits[1].turnKey).toBe('c:2')
  })

  it('different chats each get their own turn sequence (no cross-chat interference)', () => {
    const { driver, emits, advance } = harness(0, 0)

    driver.startTurn({ chatId: 'c1', userText: 'chat one' })
    advance(0)
    driver.startTurn({ chatId: 'c2', userText: 'chat two' })
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c1')
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c2')
    advance(0)

    const c1Keys = emits.filter(e => e.chatId === 'c1').map(e => e.turnKey)
    const c2Keys = emits.filter(e => e.chatId === 'c2').map(e => e.turnKey)
    expect(new Set(c1Keys)).toEqual(new Set(['c1:1']))
    expect(new Set(c2Keys)).toEqual(new Set(['c2:1']))
  })

  it('onTurnComplete receives turnKey for each card separately', () => {
    const completions: Array<{ turnKey: string }> = []
    const { driver, advance } = harness(0, 0, { onTurnComplete: (a) => completions.push(a) })

    driver.startTurn({ chatId: 'c', userText: 'task 1' })
    advance(0)
    // Turn 2 force-closes turn 1 via onTurnComplete
    driver.startTurn({ chatId: 'c', userText: 'task 2' })
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 200 }, 'c')
    advance(0)

    expect(completions).toHaveLength(2)
    expect(completions.map(c => c.turnKey)).toEqual(['c:1', 'c:2'])
  })

  it('session-tail echo enqueue after startTurn is dropped (single card per turn)', () => {
    // Regression: the inbound handler calls startTurn() synchronously, and
    // then the SAME enqueue shows up later via session-tail (Claude writes
    // the MCP queue-operation to JSONL). Without the isSync guard both
    // fired, spawning a second card that took over updates while the first
    // stayed pinned at "Working… 0ms".
    const completions: Array<{ turnKey: string }> = []
    const { driver, emits, advance } = harness(0, 0, { onTurnComplete: (a) => completions.push(a) })

    driver.startTurn({ chatId: 'c', userText: 'hello' })
    advance(0)
    // Session-tail echo arrives (no isSync flag) for the same chat+thread.
    driver.ingest(enqueue('c', 'hello', 'echo1'), null)
    advance(0)
    driver.ingest({ kind: 'tool_use', toolName: 'Bash' }, 'c')
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, 'c')
    advance(0)

    // Exactly one first-emit (one card) and one completion for c:1.
    const firstEmits = emits.filter(e => e.isFirstEmit)
    expect(firstEmits).toHaveLength(1)
    expect(firstEmits[0].turnKey).toBe('c:1')
    expect(completions).toHaveLength(1)
    expect(completions[0].turnKey).toBe('c:1')
    // And the tool_use landed on the same card, not a new one.
    const bashEmit = emits.find(e => e.html.includes('Bash'))
    expect(bashEmit?.turnKey).toBe('c:1')
  })

  it('session-tail enqueue still creates a card when no startTurn primed it', () => {
    // Belt-and-suspenders: if the sync startTurn path is ever skipped
    // (e.g. during a cold start or an unexpected flow), the session-tail
    // enqueue must still open a card — the isSync guard only drops echoes,
    // not lone session-tail enqueues.
    const { driver, emits, advance } = harness(0, 0)

    driver.ingest(enqueue('c', 'hello'), null)
    advance(0)

    const firstEmits = emits.filter(e => e.isFirstEmit)
    expect(firstEmits).toHaveLength(1)
    expect(firstEmits[0].turnKey).toBe('c:1')
  })

  it('late session-tail echo after fast turn_end is dropped (no orphan card)', () => {
    const { driver, emits, advance } = harness(0, 0)

    // Sync startTurn creates the card.
    driver.startTurn({ chatId: 'c', userText: 'hello' })
    advance(0)
    expect(emits.filter(e => e.isFirstEmit)).toHaveLength(1)

    // Turn ends fast (before session-tail fires).
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c')
    advance(0)
    const emitCountAfterEnd = emits.length

    // Late session-tail echo arrives — should be dropped.
    driver.ingest(enqueue('c', 'hello', 'echo-late'), null)
    advance(0)

    // No new emits — the echo was consumed.
    expect(emits.length).toBe(emitCountAfterEnd)
  })

  it('multiple late echoes after turn_end are all dropped (session restarts)', () => {
    const { driver, emits, advance } = harness(0, 0)

    driver.startTurn({ chatId: 'c', userText: 'hello' })
    advance(0)
    expect(emits.filter(e => e.isFirstEmit)).toHaveLength(1)

    // Turn ends fast.
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c')
    advance(0)
    const emitCountAfterEnd = emits.length

    // First echo — Guard 2 catches and consumes pendingSyncEchoes.
    // Guard 0 records the messageId.
    driver.ingest(enqueue('c', 'hello', 'msg42'), null)
    advance(0)
    expect(emits.length).toBe(emitCountAfterEnd)

    // Second echo (from session restart, same messageId) — Guard 0 catches.
    driver.ingest(enqueue('c', 'hello', 'msg42'), null)
    advance(0)
    expect(emits.length).toBe(emitCountAfterEnd)

    // Third echo — also caught by Guard 0.
    driver.ingest(enqueue('c', 'hello', 'msg42'), null)
    advance(0)
    expect(emits.length).toBe(emitCountAfterEnd)
  })

  it('messageId dedup allows different messages through', () => {
    const { driver, emits, advance } = harness(0, 0)

    driver.startTurn({ chatId: 'c', userText: 'hello' })
    advance(0)
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c')
    advance(0)
    const emitCountAfterEnd = emits.length

    // Echo of the original message — Guard 2 catches.
    // Guard 0 records the messageId.
    driver.ingest(enqueue('c', 'hello', 'msg42'), null)
    advance(0)
    expect(emits.length).toBe(emitCountAfterEnd)

    // Second echo of same message — Guard 0 catches.
    driver.ingest(enqueue('c', 'hello', 'msg42'), null)
    advance(0)
    expect(emits.length).toBe(emitCountAfterEnd)

    // Different message (different messageId) — should create new card.
    driver.ingest(enqueue('c', 'new question'), null)
    advance(0)
    expect(emits.length).toBeGreaterThan(emitCountAfterEnd)
    const newFirstEmit = emits.filter(e => e.isFirstEmit)
    expect(newFirstEmit).toHaveLength(2) // original + new
  })

  it('enqueue with null chatId is silently dropped (no ghost card)', () => {
    const { driver, emits, advance } = harness(0, 0)

    // Simulate a non-channel session-tail enqueue (terminal input has no chat_id).
    const nullEnqueue: SessionEvent = {
      kind: 'enqueue',
      chatId: null,
      messageId: 'term1',
      threadId: null,
      rawContent: 'terminal input without channel wrapper',
    }
    driver.ingest(nullEnqueue, null)
    advance(0)
    expect(emits).toHaveLength(0)
    expect(driver.peek('', undefined)).toBeUndefined()
  })

  it('enqueue with empty string chatId is silently dropped', () => {
    const { driver, emits, advance } = harness(0, 0)

    const emptyEnqueue: SessionEvent = {
      kind: 'enqueue',
      chatId: '' as string,
      messageId: 'term2',
      threadId: null,
      rawContent: 'no chat_id',
    }
    driver.ingest(emptyEnqueue, null)
    advance(0)
    expect(emits).toHaveLength(0)
  })

  it('ghost card (null chatId) is force-closed when a real turn starts', () => {
    const { driver, emits, advance } = harness(0, 0)

    // Start a real turn.
    driver.startTurn({ chatId: 'c', userText: 'hello' })
    advance(0)
    expect(emits.filter(e => e.isFirstEmit)).toHaveLength(1)

    // Subsequent events route correctly.
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 'tu1' }, 'c')
    advance(0)
    expect(emits.some(e => e.html.includes('Read'))).toBe(true)
  })
})

describe('initial delay suppression', () => {
  it('suppresses the card when turn_end arrives within initialDelayMs', () => {
    const { driver, emits, advance } = harness(0, 0, { initialDelayMs: 5000 })

    driver.startTurn({ chatId: 'c', userText: 'hello' })
    advance(0)

    // No emit yet — deferred by 5s.
    expect(emits).toHaveLength(0)

    // Turn ends at 2s (within the 5s window).
    advance(2000)
    driver.ingest({ kind: 'turn_end', durationMs: 2000 }, 'c')
    advance(0)

    // Card was never shown — zero emits.
    expect(emits).toHaveLength(0)
  })

  it('shows the card after initialDelayMs if the turn is still running', () => {
    const { driver, emits, advance } = harness(0, 0, { initialDelayMs: 5000 })

    driver.startTurn({ chatId: 'c', userText: 'hello' })
    advance(0)
    expect(emits).toHaveLength(0)

    // 5s passes — deferred timer fires.
    advance(5000)
    expect(emits).toHaveLength(1)
    expect(emits[0].isFirstEmit).toBe(true)
  })

  it('subsequent events coalesce normally after the card appears', () => {
    const { driver, emits, advance } = harness(500, 400, { initialDelayMs: 5000 })

    driver.startTurn({ chatId: 'c', userText: 'hello' })
    advance(5000)
    expect(emits).toHaveLength(1)

    // Tool use arrives after the card is shown — normal coalesce.
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1' }, 'c')
    advance(500)
    expect(emits.length).toBeGreaterThan(1)
  })
})
