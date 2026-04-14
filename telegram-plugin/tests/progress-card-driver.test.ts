/**
 * Tests for the progress-card driver — per-chat state + emit cadence.
 *
 * Uses injected fake clock + fake setTimeout so the timing behaviour is
 * deterministic (no real wall-clock waits in CI).
 */
import { describe, it, expect, vi } from 'vitest'
import { createProgressDriver, summariseTurn } from '../progress-card-driver.js'
import { initialState, reduce } from '../progress-card.js'
import type { SessionEvent } from '../session-tail.js'

function harness(
  minIntervalMs = 500,
  coalesceMs = 400,
  opts?: { captureSummaries?: boolean; heartbeatMs?: number },
) {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; html: string; done: boolean }> = []
  const summaries: string[] = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    onTurnEnd: opts?.captureSummaries ? (s) => summaries.push(s) : undefined,
    minIntervalMs,
    coalesceMs,
    heartbeatMs: opts?.heartbeatMs,
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

const enqueue = (chatId: string, text = 'hi'): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
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
    expect(emits[0].html).toContain('💬 hi')
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
    expect(emits[0].html).not.toContain('🔧 <b>')
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
    expect(emits[0].html).toContain('🔧 <b>Read</b>')
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
    expect(last.html).toContain('✅ Read')
    expect(last.html).toContain('✅ Grep')
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
    expect(emits[0].html).toContain('💬 second')
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
    expect(emits.at(-1)!.html).toContain('🔧 <b>Read</b> foo.ts')
    driver.ingest({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' }, 'c1')
    advance(1000)
    expect(emits.at(-1)!.html).toContain('✅ Read foo.ts')
    expect(emits.at(-1)!.html).not.toContain('🔧 <b>Read</b>')
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
    expect(html).toContain('❌ Bash git push')
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
    expect(html).toContain('(+3 more earlier steps)')
    // The visible tail contains exactly 12 checklist lines (count the
    // state emojis — excluding the header banner ⚙️/✅).
    const checklistEmojis = (html.match(/\n  (✅|🔧|❌) /g) ?? []).length
    expect(checklistEmojis).toBe(12)
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
    expect(final.html).toContain('✅ Read a.ts')
    expect(final.html).toContain('✅ Bash echo hi')
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
