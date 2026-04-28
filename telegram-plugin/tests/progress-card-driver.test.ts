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
    // User request is no longer in the HTML — shown via Telegram reply banner.
    expect(emits[0].html).not.toContain('<blockquote>')
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
    // The user request is no longer in the HTML — it is shown via Telegram's
    // native reply banner (reply_parameters on the initial sendMessage).
    expect(emits[0].html).not.toContain('<blockquote>')
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
    expect(emits[0].html).toContain('◉ <b><code>Read</code></b>')
  })

  it('emits immediately on turn_end with done=true', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    // Issue #132: a reply tool call is required for the renderer to land
    // on "✅ Done"; without it the turn-end render is "🙊 Ended without reply".
    // This test exercises the happy path. See the silent-end test below
    // for the inverse.
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, 'c1')
    // Issue #137: also need at least one delivery — without it the renderer
    // would land on "⚠️ Reply attempted but not delivered". The gateway's
    // executeReply path calls recordOutboundDelivered after the message
    // actually lands; this is the test-side equivalent.
    driver.recordOutboundDelivered('c1')
    emits.length = 0
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(emits).toHaveLength(1)
    expect(emits[0].done).toBe(true)
    expect(emits[0].html).toContain('✅ <b>Done</b>')
  })

  it('issue #132: turn ending without reply tool renders 🙊 silent-end', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    // Tool work happens but no reply / stream_reply is ever called.
    driver.ingest({ kind: 'tool_use', toolName: 'Bash' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Bash' }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'b', toolName: 'Read' }, 'c1')
    emits.length = 0
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(emits).toHaveLength(1)
    expect(emits[0].done).toBe(true)
    // The header swaps from ✅ Done to 🙊 Ended without reply, and the
    // diagnostic hint line tells the user what happened.
    expect(emits[0].html).toContain('🙊 <b>Ended without reply</b>')
    expect(emits[0].html).not.toContain('✅ <b>Done</b>')
    expect(emits[0].html).toContain("Agent ran tools but didn't send a reply")
  })

  it('issue #132: stream_reply also flips replyToolCalled (any plugin prefix)', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    // Different MCP server-key prefix — old "clerk-telegram" still matches
    // because tool-names.ts uses a regex on `mcp__*__telegram__`.
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__clerk-telegram__stream_reply' }, 'c1')
    // The agent attempted a reply AND a delivery actually happened — this
    // is the happy-path baseline that distinguishes #132 (no reply tool)
    // from #137 (reply tool but no delivery).
    driver.recordOutboundDelivered('c1')
    emits.length = 0
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(emits[0].html).toContain('✅ <b>Done</b>')
    expect(emits[0].html).not.toContain('🙊')
    expect(emits[0].html).not.toContain('Reply attempted but not delivered')
  })

  it('issue #137: replyToolCalled but no delivery → ⚠️ "Reply attempted but not delivered"', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    // Agent calls the reply tool (any registered MCP server-key prefix)…
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__stream_reply' }, 'c1')
    // …but the gateway never calls recordOutboundDelivered (simulating
    // an MCP bridge tear-down between tool-acceptance and final flush).
    emits.length = 0
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(emits).toHaveLength(1)
    expect(emits[0].done).toBe(true)
    // Distinct from silent-end's 🙊 — the user needs to know the agent
    // TRIED, just that the message never made it.
    expect(emits[0].html).toContain('⚠️ <b>Reply attempted but not delivered</b>')
    expect(emits[0].html).not.toContain('✅ <b>Done</b>')
    expect(emits[0].html).not.toContain('🙊 <b>Ended without reply</b>')
    // Diagnostic hint suggests /restart specifically (more likely to
    // recover from a transient bridge issue than a rephrase).
    expect(emits[0].html).toContain('Try /restart')
  })

  it('issue #137: silentEnd takes precedence — no reply tool means it is #132 not #137', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Bash' }, 'c1')
    // No reply tool fired AND no delivery — pure silent-end. The renderer's
    // mutex (silentEnd checked first) means we get 🙊, not ⚠️.
    emits.length = 0
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(emits[0].html).toContain('🙊 <b>Ended without reply</b>')
    expect(emits[0].html).not.toContain('⚠️ <b>Reply attempted')
  })

  it('issue #137: recordOutboundDelivered for unknown chat is a silent no-op', () => {
    const { driver } = harness()
    // No active card for "ghost" — this could happen if a system message
    // (boot banner, restart ack) routes through the same code path.
    expect(() => driver.recordOutboundDelivered('ghost')).not.toThrow()
  })

  it('issue #137: multiple deliveries per turn keep the card on ✅ Done', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__stream_reply' }, 'c1')
    // Stream of partial chunks — three deliveries.
    driver.recordOutboundDelivered('c1')
    driver.recordOutboundDelivered('c1')
    driver.recordOutboundDelivered('c1')
    emits.length = 0
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
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
    expect(last.html).toContain('● <code>Read</code>')
    expect(last.html).toContain('● <code>Grep</code>')
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
    // Each chat produces its own emit; user request text is no longer
    // rendered in the card body (#156 — shown via Telegram reply banner).
    expect(emits.map((e) => e.chatId)).toEqual(['c1', 'c2'])
    expect(emits[0].html).not.toContain('<blockquote>')
    expect(emits[1].html).not.toContain('<blockquote>')
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
    // User request is no longer in the HTML — shown via Telegram reply banner.
    expect(emits[0].html).not.toContain('<blockquote>')
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
    expect(emits.at(-1)!.html).toContain('◉ <b><code>Read</code></b> <code>foo.ts</code>')
    driver.ingest({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' }, 'c1')
    advance(1000)
    expect(emits.at(-1)!.html).toContain('● <code>Read</code> <code>foo.ts</code>')
    expect(emits.at(-1)!.html).not.toContain('◉ <b><code>Read</code></b>')
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
    // Order preserved: Bash → Read → Grep. Tool names AND args render in <code>.
    const bashIdx = html.indexOf('<code>Bash</code> <code>ls</code>')
    const readIdx = html.indexOf('<code>Read</code> <code>foo.ts</code>')
    const grepIdx = html.indexOf('<code>Grep</code>')
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
    expect(html).toContain('✗ <code>Bash</code> <code>git push</code>')
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
    // Reply tool call is required to render "✅ Done" — see issue #132.
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply', toolUseId: 't3' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 't3', toolName: 'mcp__switchroom-telegram__reply' }, 'c1')
    // Issue #137: simulate the gateway's executeReply call into the driver
    // after the actual outbound landed, so the renderer doesn't downgrade
    // to "⚠️ Reply attempted but not delivered".
    driver.recordOutboundDelivered('c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    const final = emits.at(-1)!
    expect(final.done).toBe(true)
    expect(final.html).toContain('✅ <b>Done</b>')
    expect(final.html).not.toContain('⚙️ <b>Working…</b>')
    // Final checklist still visible.
    expect(final.html).toContain('● <code>Read</code> <code>a.ts</code>')
    expect(final.html).toContain('● <code>Bash</code> <code>echo hi</code>')
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

  it('ghost-pin safety net: orphan never reports turn_end → maxIdleMs auto-closes (#142 follow-up)', () => {
    // The orphan-defer change in this PR makes `hasAnyRunningSubAgent` the
    // defer gate. The intended safety-net argument is that an orphan whose
    // `sub_agent_turn_end` never arrives (JSONL-delivery race, agent
    // process crash mid-tool, etc.) won't ghost-pin forever because the
    // heartbeat zombie ceiling (maxIdleMs) force-closes any card whose
    // last real session event is older than the cutoff.
    //
    // This test pins that safety net explicitly. Without it, a future
    // change to maxIdleMs default (e.g. raising it to 24h or disabling
    // it) would silently re-introduce the ghost-pin failure mode that
    // PR #49's correlated-only carve-out was originally designed to
    // prevent (#31, #43).
    let now = 1000
    const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
    let nextRef = 0
    const completeCalls: Array<{ chatId: string }> = []
    const emits: Array<{ done: boolean }> = []
    const driver = createProgressDriver({
      emit: (a) => emits.push({ done: a.done }),
      onTurnComplete: (a) => completeCalls.push({ chatId: a.chatId }),
      heartbeatMs: 1000,
      maxIdleMs: 5_000,        // tight test cutoff
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

    // Setup: orphan sub-agent dispatched, parent turn_end fires while
    // orphan is still running (the new defer behavior holds the card).
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'orphan', firstPromptText: 'P' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c1')
    advance(0)
    expect(completeCalls).toHaveLength(0) // deferred — orphan still running

    // No `sub_agent_turn_end` ever arrives. lastEventAt is stuck at the
    // turn_end timestamp. After maxIdleMs (5s here, 5min in production)
    // the heartbeat zombie ceiling must fire and close the card so the
    // pin doesn't ghost forever.
    advance(6_000) // past the 5s cutoff
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0].chatId).toBe('c1')
    // Final emit carries done=true so the gateway unpins.
    const lastEmit = emits[emits.length - 1]
    expect(lastEmit?.done).toBe(true)
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

describe('forceCompleteTurn — external completion signal', () => {
  it('cusp race: stream_reply completes at +28s, no card ever emits', () => {
    // Reproduces the turn-:15 bug. The turn completes fast (before
    // initialDelayMs=30s elapses), and stream_reply(done=true) fires
    // forceCompleteTurn. The deferred first-emit timer must be cancelled
    // so it can't fire at +30s with a ghost card.
    const { driver, emits, advance } = harness(0, 0, { initialDelayMs: 30_000 })

    driver.startTurn({ chatId: 'c', userText: 'quick question' })
    advance(0)
    expect(emits).toHaveLength(0) // deferred

    // Turn has some tool activity at +10s.
    advance(10_000)
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1' }, 'c')
    advance(0)
    expect(emits).toHaveLength(0) // still deferred (timer hasn't fired)

    // At +28s stream_reply(done=true) arrives; gateway forwards to driver.
    advance(18_000)
    driver.forceCompleteTurn({ chatId: 'c' })
    advance(0)

    // Zero emits — card was suppressed before the deferred timer could fire.
    expect(emits).toHaveLength(0)

    // Advance past the would-be timer firing moment.
    advance(10_000) // +38s total, past the 30s timer
    expect(emits).toHaveLength(0) // still nothing — timer was cancelled
  })

  it('card already emitted: forceCompleteTurn finalises + unpins', () => {
    // Slow turn: card emitted at +30s, then stream_reply done=true arrives
    // at +45s. Driver should fire turn_end render, onTurnComplete, and
    // clean up — same as a session-tail turn_end would.
    const emitted: Array<{ turnKey: string; summary: string; taskIndex: number; taskTotal: number }> = []
    const { driver, emits, advance } = harness(0, 0, {
      initialDelayMs: 30_000,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.startTurn({ chatId: 'c', userText: 'slow one' })
    advance(30_000) // timer fires, card emits
    expect(emits.length).toBeGreaterThan(0)
    const firstEmitCount = emits.length

    // Stream_reply done=true at +45s.
    advance(15_000)
    driver.forceCompleteTurn({ chatId: 'c' })
    advance(0)

    // onTurnComplete fired exactly once with the turn summary.
    expect(emitted).toHaveLength(1)
    expect(emitted[0].summary).toContain('no tools')
    // A final done-render landed after the forceCompleteTurn call.
    expect(emits.length).toBeGreaterThan(firstEmitCount)
    expect(emits[emits.length - 1].done).toBe(true)
  })

  it('idempotent: second forceCompleteTurn is a no-op', () => {
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 30_000,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.startTurn({ chatId: 'c', userText: 'q' })
    advance(0)
    driver.forceCompleteTurn({ chatId: 'c' })
    driver.forceCompleteTurn({ chatId: 'c' })
    driver.forceCompleteTurn({ chatId: 'c' })
    advance(0)

    // Only one completion fired even with three external signals.
    expect(emitted).toHaveLength(1)
  })

  it('no active turn: forceCompleteTurn is a silent no-op', () => {
    const emitted: Array<unknown> = []
    const { driver } = harness(0, 0, {
      initialDelayMs: 30_000,
      onTurnComplete: (args) => emitted.push(args),
    })

    // No startTurn, no enqueue — nothing is active.
    expect(() => driver.forceCompleteTurn({ chatId: 'c' })).not.toThrow()
    expect(emitted).toHaveLength(0)
  })

  it('forceCompleteTurn then turn_end: turn_end is a no-op (first-wins)', () => {
    const emitted: Array<unknown> = []
    const { driver, emits, advance } = harness(0, 0, {
      initialDelayMs: 30_000,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.startTurn({ chatId: 'c', userText: 'q' })
    advance(10_000)
    driver.forceCompleteTurn({ chatId: 'c' })
    advance(0)
    expect(emitted).toHaveLength(1)

    // Session-tail turn_end arrives late — must not re-trigger completion.
    driver.ingest({ kind: 'turn_end', durationMs: 10_000 }, 'c')
    advance(0)

    expect(emitted).toHaveLength(1) // still 1
    // The card never emitted (fast-turn suppression held).
    expect(emits).toHaveLength(0)
  })

  it('pendingCompletion: turn_end with running sub-agent defers', () => {
    // Parent turn_end fires while a sub-agent is still running.
    // Completion callbacks must NOT fire yet — card stays alive so the
    // user sees the sub-agent progressing.
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'bg', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)

    // Parent turn_end landed but sub-agent X is still running → no completion.
    expect(emitted).toHaveLength(0)
  })

  it('deferred completion fires when last sub-agent finishes', () => {
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'bg', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)
    expect(emitted).toHaveLength(0)

    // Sub-agent reports its own turn_end → completion fires.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5000 }, 'c')
    advance(0)

    expect(emitted).toHaveLength(1)
  })

  it('pendingCompletion: orphan sub-agent (run_in_background) gates defer (closes #87)', () => {
    // `Agent({run_in_background:true})` produces an orphan sub-agent because
    // the parent's tool_result lands BEFORE sub_agent_started — there is no
    // matching pendingAgentSpawn for prompt-text correlation, so
    // parentToolUseId stays null. Pre-fix, the defer gate was correlated-
    // only, orphans were excluded, and the card unpinned at parent turn_end
    // while the background worker was still running. After the fix,
    // `hasAnyRunningSubAgent` gates the defer and the card stays pinned
    // until the orphan reports done.
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c'), null)
    // No preceding tool_use Agent → sub_agent_started has no parent to
    // correlate to → orphan (parentToolUseId == null).
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)

    // Parent turn_end landed but orphan X is still running → defer must
    // hold. Pre-fix this would have completed immediately (orphans excluded).
    expect(emitted).toHaveLength(0)

    // Orphan reports its own turn_end → completion fires.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5000 }, 'c')
    advance(0)
    expect(emitted).toHaveLength(1)
  })

  it('two sub-agents running: completion waits for the last one', () => {
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'a', prompt: 'P1' } },
      'c',
    )
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p2', input: { description: 'b', prompt: 'P2' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P1' }, 'c')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'Y', firstPromptText: 'P2' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)

    // Parent turn_end → X and Y still running, no completion.
    expect(emitted).toHaveLength(0)

    // X finishes → Y still running, still no completion.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 2000 }, 'c')
    advance(0)
    expect(emitted).toHaveLength(0)

    // Y finishes → last one done, completion fires.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'Y', durationMs: 3000 }, 'c')
    advance(0)
    expect(emitted).toHaveLength(1)
  })

  it('forceCompleteTurn with running sub-agent defers (stream_reply done semantic)', () => {
    // stream_reply(done=true) = user's answer landed, NOT all work done.
    // Must not abandon still-running sub-agents.
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'bg', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')

    // stream_reply(done=true) fires before any turn_end.
    driver.forceCompleteTurn({ chatId: 'c' })
    advance(0)
    expect(emitted).toHaveLength(0)

    // Sub-agent eventually finishes.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5000 }, 'c')
    advance(0)
    expect(emitted).toHaveLength(1)
  })

  it('forceCompleteTurn with running orphan sub-agent defers (closes #87)', () => {
    // The orphan-defer test above (`pendingCompletion: orphan sub-agent`)
    // exercises the turn_end path. This test pins the same gate on the
    // forceCompleteTurn path — stream_reply(done=true) arriving before
    // turn_end while an orphan from `Agent({run_in_background:true})` is
    // still running must defer, not complete immediately.
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c'), null)
    // No preceding tool_use Agent → orphan (parentToolUseId == null).
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')

    driver.forceCompleteTurn({ chatId: 'c' })
    advance(0)
    expect(emitted).toHaveLength(0)

    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5000 }, 'c')
    advance(0)
    expect(emitted).toHaveLength(1)
  })

  it('completion fires exactly once even if turn_end + forceCompleteTurn both arrive', () => {
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'bg', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')

    // Both completion signals arrive.
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    driver.forceCompleteTurn({ chatId: 'c' })
    advance(0)
    expect(emitted).toHaveLength(0) // still deferred (sub-agent running)

    // Sub-agent finishes → completion fires EXACTLY ONCE.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5000 }, 'c')
    advance(0)
    expect(emitted).toHaveLength(1)
  })

  it('new enqueue during waiting-for-sub-agents: force-closes old card, abandons sub-agent', () => {
    // Simulates a new user message arriving while an old turn's background
    // sub-agent is still running. The old card must be force-closed with
    // the sub-agent marked done (abandoned). startTurn synthesizes an
    // isSync:true enqueue which bypasses Guard 1's echo-drop and reaches
    // the force-close path.
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c', 'first'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'bg', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)
    expect(emitted).toHaveLength(0)

    // New user message arrives via startTurn (the production path) — old
    // card must force-close now, sub-agent abandoned.
    driver.startTurn({ chatId: 'c', userText: 'second message' })
    advance(0)
    expect(emitted).toHaveLength(1) // old card closed via closeZombie
  })

  it('normal fast turn (no sub-agents): completes immediately on turn_end', () => {
    const emitted: Array<unknown> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => emitted.push(args),
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1', input: { file_path: '/f' } }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c')
    advance(0)

    // No sub-agents → normal immediate completion.
    expect(emitted).toHaveLength(1)
  })

  it('threadId scoping: completes the matching chat+thread only', () => {
    const emitted: Array<{ chatId: string; threadId?: string }> = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 30_000,
      onTurnComplete: (args) => emitted.push({ chatId: args.chatId, threadId: args.threadId }),
    })

    driver.startTurn({ chatId: 'c', threadId: 't1', userText: 'q' })
    advance(0)

    // Wrong thread — should be a no-op.
    driver.forceCompleteTurn({ chatId: 'c', threadId: 't2' })
    advance(0)
    expect(emitted).toHaveLength(0)

    // Matching thread — completes.
    driver.forceCompleteTurn({ chatId: 'c', threadId: 't1' })
    advance(0)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({ chatId: 'c', threadId: 't1' })
  })

  // ─── Bug repro: progress-card "✅ Done" notification spam ──────────────────
  //
  // Bug (2026-04-22): while two parallel review sub-agents were running after
  // the parent agent's turn_end, the user received ~13 identical "✅ Done
  // ⏱ XX:XX" progress-card notifications in ~30 minutes. Each sub-agent
  // tool_use event triggered a fresh emit with `done=true` (because the
  // reducer sets `stage='done'` on turn_end), and `handleStreamReply`
  // finalizes + deletes the draft stream after every `done=true` call — so
  // the next emit on the same card came back through as a brand-new
  // `sendMessage` (= new Telegram push notification), not an edit.
  //
  // Fix: while the driver is in the deferred-completion state (parent
  // turn_end landed but sub-agents still running), emits must carry
  // `done=false`. Only the truly-final emit — the one produced by
  // `maybeCompleteDeferredTurn` / `closeZombie` / normal turn_end-with-no-
  // sub-agents — may set `done=true`.

  it('deferred completion: sub-agent events after parent turn_end emit done=false', () => {
    // Reproduces the notification-spam bug. Setup: parent enqueue → Agent
    // tool_use → sub_agent_started → parent turn_end. Sub-agent then emits
    // a burst of tool_use events while still running.
    const { driver, emits, advance } = harness(500, 400, {
      initialDelayMs: 0,
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'review', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)

    // The turn_end flush may emit done=true on the transition frame, BUT the
    // subsequent sub-agent emits must NOT. Snapshot the emit count so we
    // can distinguish the frames we care about.
    const afterTurnEnd = emits.length

    // Simulate the sub-agent grinding through 20 tool calls over 30s.
    for (let i = 0; i < 20; i++) {
      driver.ingest(
        { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: `t${i}`, toolName: 'Read' },
        'c',
      )
      advance(1500) // 30s / 20 = 1.5s between events
      driver.ingest(
        { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: `t${i}` },
        'c',
      )
    }
    advance(5000) // drain any pending coalesce timers

    // Every emit AFTER the deferred-completion transition must be done=false.
    // The bug produced a stream of done=true emits, each one closing the
    // stream controller and forcing handleStreamReply to sendMessage fresh
    // (= new push notification) on the next event.
    const postDeferred = emits.slice(afterTurnEnd)
    const doneTrueDuringDeferred = postDeferred.filter((e) => e.done === true)
    expect(doneTrueDuringDeferred).toHaveLength(0)
  })

  it('deferred completion: burst of 30 sub-agent events produces bounded emit count', () => {
    // Independent of the done-flag bug: a burst of sub-agent events while
    // the card is in deferred-completion state must be coalesced. The edit-
    // budget guardrail (>18 edits in 60s → expand coalesce window) must
    // apply during the deferred phase just as it does during an active turn.
    const { driver, emits, advance } = harness(500, 400, {
      initialDelayMs: 0,
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'review', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)
    emits.length = 0

    // 30 sub-agent tool_use events over 60s
    for (let i = 0; i < 30; i++) {
      driver.ingest(
        { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: `t${i}`, toolName: 'Read' },
        'c',
      )
      advance(2000)
    }
    advance(5000)

    // With 500ms min interval + 400ms coalesce + budget-hot expansion,
    // 60s should produce at most ~30 emits (one per 2s tool_use) and at
    // least ~10 (enough to show progress). Assert the budget guardrail
    // kept the edits well below the 60-event worst case.
    expect(emits.length).toBeLessThanOrEqual(30)
  })

  it('deferred completion: no duplicate onTurnComplete during sub-agent bursts', () => {
    // Race-condition check. A burst of sub-agent events while
    // pendingCompletion=true must not re-fire the completion callback.
    const completions: string[] = []
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
      onTurnComplete: (args) => completions.push(args.turnKey),
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'r', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)
    expect(completions).toHaveLength(0)

    for (let i = 0; i < 10; i++) {
      driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: `t${i}`, toolName: 'Read' }, 'c')
      advance(100)
    }
    advance(1000)
    expect(completions).toHaveLength(0)

    // Last sub-agent finishes → completion fires exactly once.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5000 }, 'c')
    advance(0)
    expect(completions).toHaveLength(1)

    // Post-completion events routed to no turn should be ignored — they
    // must not re-fire the callback.
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 'late', toolName: 'Read' }, 'c')
    advance(1000)
    expect(completions).toHaveLength(1)
  })

  it('deferred completion: final emit (from maybeCompleteDeferredTurn) sets done=true exactly once', () => {
    // After the bug is fixed, we still need the final frame to carry
    // done=true so handleStreamReply finalizes the stream and the unpin
    // path runs. Verify the terminal emit lands with done=true.
    const { driver, emits, advance } = harness(0, 0, {
      initialDelayMs: 0,
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'r', prompt: 'P' } },
      'c',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 't0', toolName: 'Read' }, 'c')
    advance(1000)
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5000 }, 'c')
    advance(0)

    // Exactly one terminal emit with done=true.
    const doneEmits = emits.filter((e) => e.done === true)
    expect(doneEmits).toHaveLength(1)
    // …and it must be the very last one.
    expect(emits[emits.length - 1].done).toBe(true)
  })

  it('deferred completion: two parallel sub-agents — original spam scenario', () => {
    // Reproduces Ken's exact scenario from 2026-04-22: two parallel review
    // sub-agents running in the background, one still running while the
    // other has finished. The card should show [Sub-agents · 1 running,
    // 1 done] and keep ticking, but every emit must be done=false until
    // both sub-agents report in.
    const { driver, emits, advance } = harness(500, 400, {
      initialDelayMs: 0,
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'a', prompt: 'P1' } }, 'c')
    driver.ingest({ kind: 'tool_use', toolName: 'Agent', toolUseId: 'p2', input: { description: 'b', prompt: 'P2' } }, 'c')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P1' }, 'c')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'Y', firstPromptText: 'P2' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)
    emits.length = 0

    // X finishes first, Y keeps grinding.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 2000 }, 'c')
    advance(1000)

    for (let i = 0; i < 13; i++) {
      driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'Y', toolUseId: `y${i}`, toolName: 'Read' }, 'c')
      advance(120_000 / 13)
    }
    advance(5000)

    // None of the emits during this "one running, one done" phase may be
    // done=true — that was the spam bug.
    const doneTrue = emits.filter((e) => e.done === true)
    expect(doneTrue).toHaveLength(0)

    // Now Y finishes → the terminal emit fires done=true, exactly once.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'Y', durationMs: 3000 }, 'c')
    advance(0)
    expect(emits.filter((e) => e.done === true)).toHaveLength(1)
    expect(emits[emits.length - 1].done).toBe(true)
  })

  it('hasActiveCard: reports true during deferred completion, false after', () => {
    // Backstop guard for the gateway's closeProgressLane call: while the
    // driver is in pendingCompletion state, the stream must NOT be torn
    // down by the backstop. hasActiveCard() is how closeProgressLane
    // knows to skip.
    const { driver, advance } = harness(0, 0, {
      initialDelayMs: 0,
    })

    // No card yet.
    expect(driver.hasActiveCard('c')).toBe(false)

    driver.ingest(enqueue('c'), null)
    advance(0)
    expect(driver.hasActiveCard('c')).toBe(true)

    driver.ingest({ kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'r', prompt: 'P' } }, 'c')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)

    // Deferred-completion phase — card still managed by the driver.
    expect(driver.hasActiveCard('c')).toBe(true)

    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5000 }, 'c')
    advance(0)

    // Completion fired → card gone from driver.
    expect(driver.hasActiveCard('c')).toBe(false)
  })

  it('hasActiveCard: false for wrong threadId', () => {
    const { driver, advance } = harness(0, 0, { initialDelayMs: 0 })
    driver.startTurn({ chatId: 'c', threadId: 't1', userText: 'q' })
    advance(0)
    expect(driver.hasActiveCard('c', 't1')).toBe(true)
    expect(driver.hasActiveCard('c', 't2')).toBe(false)
    expect(driver.hasActiveCard('other')).toBe(false)
  })

  it('content-equality guard: no emit when render would produce identical HTML', () => {
    // An event that mutates internal state but doesn't change the rendered
    // card must not fire an emit — this is the existing visibleDiff guard.
    // Verify it still holds for sub-agent events during deferred completion.
    const { driver, emits, advance } = harness(500, 400, {
      initialDelayMs: 0,
    })

    driver.ingest(enqueue('c'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'r', prompt: 'P' } }, 'c')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' }, 'c')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)
    emits.length = 0

    // Two identical sub_agent_text events in a row — second one should
    // be a no-op visibility-wise.
    driver.ingest({ kind: 'sub_agent_text', agentId: 'X', text: 'same text' }, 'c')
    advance(1000)
    const afterFirst = emits.length
    driver.ingest({ kind: 'sub_agent_text', agentId: 'X', text: 'same text' }, 'c')
    advance(1000)
    expect(emits.length).toBe(afterFirst)
  })

  it('deferred completion: multi-sub-agent race — parent turn_end while A mid-tool, B has partial results', () => {
    // Regression test for issue #6 item 1.
    //
    // Scenario:
    //   - Two parallel sub-agents (A, B) spawned via Agent tool_use.
    //   - Sub-agent A fires sub_agent_tool_use but NOT sub_agent_tool_result
    //     (mid-tool, in-flight).
    //   - Sub-agent B fires sub_agent_tool_use + sub_agent_tool_result
    //     (at least one completed tool cycle).
    //   - Parent turn_end arrives — both sub-agents still alive.
    //   - A then completes its tool (sub_agent_tool_result), more flush
    //     cycles happen.
    //   - Throughout all of this, every emit must carry done=false.
    //   - Only after BOTH A and B fire sub_agent_turn_end does done=true appear.
    //
    // Today's code (PR #4) already passes this. The test locks the invariant
    // against future regressions.
    const { driver, emits, advance } = harness(500, 400, {
      initialDelayMs: 0,
    })

    // Step 1: turn starts
    driver.ingest(enqueue('c'), null)

    // Step 2: spawn TWO parallel sub-agents
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'pA', input: { description: 'worker-A', prompt: 'PA' } },
      'c',
    )
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'pB', input: { description: 'worker-B', prompt: 'PB' } },
      'c',
    )

    // Step 3: both sub-agents start
    driver.ingest({ kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'PA' }, 'c')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'PB' }, 'c')

    // Step 4: A fires a tool_use but NOT its tool_result (mid-tool, in-flight)
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'A', toolUseId: 'a-t1', toolName: 'Read' }, 'c')

    // Step 5: B fires tool_use + tool_result (B has ≥1 completed tool cycle)
    // B completing a cycle before parent turn_end ensures the deferred-completion logic sees
    // heterogeneous sub-agent states (one mid-tool, one with completed cycles).
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'B', toolUseId: 'b-t1', toolName: 'Bash' }, 'c')
    driver.ingest({ kind: 'sub_agent_tool_result', agentId: 'B', toolUseId: 'b-t1' }, 'c')

    // Step 6: parent turn_end — sub-agents still in flight
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c')
    advance(0)

    // Snapshot emit count at this point to assert done=false in steps 6-8.
    const baselineCount = emits.length
    expect(baselineCount).toBeGreaterThan(0) // card has been emitting

    // All emits so far must be done=false.
    expect(emits.filter((e) => e.done === true)).toHaveLength(0)

    // Step 7a: A's in-flight tool completes (sub_agent_tool_result for a-t1)
    driver.ingest({ kind: 'sub_agent_tool_result', agentId: 'A', toolUseId: 'a-t1' }, 'c')
    advance(600) // past coalesceMs so any pending flush fires

    // Still done=false — both sub-agents still alive
    expect(emits.filter((e) => e.done === true)).toHaveLength(0)

    // Step 7b: more flush triggers (heartbeat, additional tool calls)
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'A', toolUseId: 'a-t2', toolName: 'Bash' }, 'c')
    advance(600)
    driver.ingest({ kind: 'sub_agent_tool_result', agentId: 'A', toolUseId: 'a-t2' }, 'c')
    advance(600)
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'B', toolUseId: 'b-t2', toolName: 'Write' }, 'c')
    advance(600)
    driver.ingest({ kind: 'sub_agent_tool_result', agentId: 'B', toolUseId: 'b-t2' }, 'c')
    advance(600)

    // Assert: throughout steps 6-7, every emit has done=false (Step 9)
    expect(emits.filter((e) => e.done === true)).toHaveLength(0)
    expect(emits.length).toBeGreaterThan(baselineCount) // flushes did happen

    // Step 8a: first sub-agent finishes — A done, B still running
    // One sub-agent finishing must NOT close the card — other sub-agent still running.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'A' }, 'c')
    advance(0)

    // Still no done=true — B is still in flight
    expect(emits.filter((e) => e.done === true)).toHaveLength(0)

    // Step 8b: second sub-agent finishes — both done → card closes
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'B' }, 'c')
    advance(0)

    // Now exactly one terminal emit with done=true, and it must be the last one.
    const doneEmits = emits.filter((e) => e.done === true)
    expect(doneEmits).toHaveLength(1)
    expect(emits[emits.length - 1].done).toBe(true)
  })

  it('late sub-agent event after card close: logs to stderr and returns cleanly', () => {
    // Regression test for issue #6 item 2.
    //
    // After completeTurnFully nulls currentTurnKey, any sub_agent_* event
    // that arrives (from a stale session-tail tail) should:
    //   1. Emit a process.stderr.write diagnostic log (matches file's observability pattern).
    //   2. Return cleanly without corrupting any state.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const { driver, emits, advance } = harness(0, 0, { initialDelayMs: 0 })

      // Complete a full turn so the card closes (currentTurnKey → null).
      driver.ingest(enqueue('c'), null)
      driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c')
      advance(0)

      // Card is now closed. Confirm via hasActiveCard.
      expect(driver.hasActiveCard('c')).toBe(false)

      const emitCountBeforeLate = emits.length

      // Fire a late sub_agent_tool_result — arrives after card close.
      driver.ingest({ kind: 'sub_agent_tool_result', agentId: 'Z', toolUseId: 'z-t1' }, 'c')
      advance(0)

      // Assert 1: process.stderr.write was called with the diagnostic log.
      expect(stderrSpy).toHaveBeenCalled()
      const lateEventLog = stderrSpy.mock.calls
        .map((c) => c[0] as string)
        .find((s) => typeof s === 'string' && s.includes('late-sub-agent-event-dropped'))
      expect(lateEventLog).toBeDefined()
      expect(lateEventLog).toContain('sub_agent_tool_result')

      // Assert 2: no state corruption — no new emits, card still closed.
      expect(emits).toHaveLength(emitCountBeforeLate)
      expect(driver.hasActiveCard('c')).toBe(false)
    } finally {
      stderrSpy.mockRestore()
    }
  })
})

// ─── API failure escalation (permanent-4xx terminal state) ───────────────────
// Locks the contract for the failure-escalation mechanism introduced in
// fix/progress-card-api-failure-escalation. After K=3 consecutive permanent
// 4xx errors the card is marked terminal; all further flushes and heartbeat
// ticks are no-ops for that card. A single success resets the counter.
// Transient (5xx/network) and benign ("message is not modified") errors never
// advance the counter.

describe('progress-card driver — API failure escalation', () => {
  // Build a harness that exposes the turnKey for the current active card so
  // tests can call reportApiFailure / reportApiSuccess directly.
  function failureHarness(opts?: { maxConsecutive4xx?: number; heartbeatMs?: number }) {
    let now = 1000
    const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
    let nextRef = 0
    const emits: Array<{ chatId: string; turnKey: string; html: string; done: boolean; isFirstEmit: boolean }> = []

    const driver = createProgressDriver({
      emit: (a) => emits.push({ chatId: a.chatId, turnKey: a.turnKey, html: a.html, done: a.done, isFirstEmit: a.isFirstEmit }),
      minIntervalMs: 0,
      coalesceMs: 0,
      heartbeatMs: opts?.heartbeatMs ?? 0,
      initialDelayMs: 0,
      maxConsecutive4xx: opts?.maxConsecutive4xx ?? 3,
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

    // Return the current active turnKey (chatId:seq).
    const currentTurnKey = (chatId: string): string => `${chatId}:1`

    return { driver, emits, advance, currentTurnKey }
  }

  it('3 consecutive permanent_4xx → terminal=true, 4th flush is a no-op', () => {
    const { driver, emits, advance, currentTurnKey } = failureHarness()

    driver.startTurn({ chatId: 'c', userText: 'task' })
    advance(0)
    const turnKey = currentTurnKey('c')

    // Fire a tool_use to give the card some content, note current emit count.
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1' }, 'c')
    advance(0)
    const emitCountBefore4xx = emits.length

    // 3 consecutive permanent_4xx failures.
    const perm4xx = { code: 403, description: 'Forbidden: bot was blocked by the user', kind: 'permanent_4xx' as const }
    driver.reportApiFailure(turnKey, perm4xx)
    driver.reportApiFailure(turnKey, perm4xx)
    driver.reportApiFailure(turnKey, perm4xx)

    // Now the card is terminal — further events must NOT produce emits.
    driver.ingest({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' }, 'c')
    advance(100)
    expect(emits.length).toBe(emitCountBefore4xx)

    // turn_end flush is also suppressed.
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c')
    advance(0)
    expect(emits.length).toBe(emitCountBefore4xx)
  })

  it('2 consecutive permanent_4xx then a successful emit → counter resets to 0', () => {
    const { driver, emits, advance, currentTurnKey } = failureHarness()

    driver.startTurn({ chatId: 'c', userText: 'task' })
    advance(0)
    const turnKey = currentTurnKey('c')

    const perm4xx = { code: 404, description: 'Bad Request: message to edit not found', kind: 'permanent_4xx' as const }
    driver.reportApiFailure(turnKey, perm4xx)
    driver.reportApiFailure(turnKey, perm4xx)

    // Success: counter resets.
    driver.reportApiSuccess(turnKey)

    // One more 4xx — with counter at 0 this is only the 1st, not the 3rd.
    driver.reportApiFailure(turnKey, perm4xx)

    // Card is NOT yet terminal (only 1 out of 3 needed).
    // A new event should still cause an emit.
    const countBefore = emits.length
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 'b1' }, 'c')
    advance(0)
    expect(emits.length).toBeGreaterThan(countBefore)
  })

  it('transient failures do NOT increment the counter — can loop indefinitely', () => {
    const { driver, emits, advance, currentTurnKey } = failureHarness()

    driver.startTurn({ chatId: 'c', userText: 'task' })
    advance(0)
    const turnKey = currentTurnKey('c')

    const transient = { code: 500, description: 'Internal Server Error', kind: 'transient' as const }

    // Report 100 transient errors — the card must remain non-terminal.
    for (let i = 0; i < 100; i++) {
      driver.reportApiFailure(turnKey, transient)
    }

    // Events must still produce emits.
    const countBefore = emits.length
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 'tr1' }, 'c')
    advance(0)
    expect(emits.length).toBeGreaterThan(countBefore)
  })

  it('benign ("message is not modified") does not count as a failure', () => {
    const { driver, emits, advance, currentTurnKey } = failureHarness()

    driver.startTurn({ chatId: 'c', userText: 'task' })
    advance(0)
    const turnKey = currentTurnKey('c')

    const benign = { code: 400, description: 'Bad Request: message is not modified', kind: 'benign' as const }

    // 50 benign errors — counter must stay at 0.
    for (let i = 0; i < 50; i++) {
      driver.reportApiFailure(turnKey, benign)
    }

    // Card is still live — next event produces an emit.
    const countBefore = emits.length
    driver.ingest({ kind: 'tool_use', toolName: 'Grep', toolUseId: 'g1' }, 'c')
    advance(0)
    expect(emits.length).toBeGreaterThan(countBefore)
  })

  it('new turn_start on same chat resets terminal state and counter', () => {
    const { driver, emits, advance } = failureHarness()

    // Turn 1: drive to terminal.
    driver.startTurn({ chatId: 'c', userText: 'first' })
    advance(0)
    const turn1Key = 'c:1'

    const perm4xx = { code: 403, description: 'Forbidden: bot was blocked by the user', kind: 'permanent_4xx' as const }
    driver.reportApiFailure(turn1Key, perm4xx)
    driver.reportApiFailure(turn1Key, perm4xx)
    driver.reportApiFailure(turn1Key, perm4xx)

    // Turn 1 is now terminal.
    const emitCountAfterTerminal = emits.length

    // Simulate turn_end that the session fires between turns — clears turn 1
    // so startTurn can create a fresh card.
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c')
    advance(0)

    // Turn 2: fresh card with clean apiFailures state.
    driver.startTurn({ chatId: 'c', userText: 'second' })
    advance(0)

    // The new turn must produce at least one emit (isFirstEmit=true).
    const firstEmitOfTurn2 = emits.find(e => e.turnKey === 'c:2' && e.isFirstEmit)
    expect(firstEmitOfTurn2).toBeDefined()

    // And continued events on the new turn are not suppressed.
    const countBefore = emits.length
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 'b2' }, 'c')
    advance(0)
    expect(emits.length).toBeGreaterThan(countBefore)
  })

  it('when terminal=true, heartbeatTick does not call the emit function', () => {
    // Use heartbeatMs=1000 so we can observe heartbeat ticks.
    const { driver, emits, advance, currentTurnKey } = failureHarness({ heartbeatMs: 1000 })

    driver.startTurn({ chatId: 'c', userText: 'task' })
    advance(0)
    driver.ingest({ kind: 'tool_use', toolName: 'Agent', toolUseId: 'a1' }, 'c')
    advance(0)

    const turnKey = currentTurnKey('c')

    // Advance so heartbeat fires once, confirm a heartbeat-driven emit lands.
    advance(1000)
    const emitCountBeforeTerminal = emits.length
    expect(emitCountBeforeTerminal).toBeGreaterThan(1) // at least one heartbeat emit

    // Drive to terminal.
    const perm4xx = { code: 400, description: 'Bad Request: message to edit not found', kind: 'permanent_4xx' as const }
    driver.reportApiFailure(turnKey, perm4xx)
    driver.reportApiFailure(turnKey, perm4xx)
    driver.reportApiFailure(turnKey, perm4xx)

    const emitCountAfterTerminal = emits.length

    // Advance through multiple heartbeat ticks — no further emits.
    advance(5000) // 5 heartbeat ticks
    expect(emits.length).toBe(emitCountAfterTerminal)
  })

  it('reportApiFailure is idempotent after terminal=true', () => {
    // Calling reportApiFailure many more times after terminal must not
    // throw, must not cause emits, and must not somehow flip terminal back.
    const { driver, emits, advance, currentTurnKey } = failureHarness()

    driver.startTurn({ chatId: 'c', userText: 'task' })
    advance(0)
    const turnKey = currentTurnKey('c')

    const perm4xx = { code: 403, description: 'Forbidden', kind: 'permanent_4xx' as const }
    driver.reportApiFailure(turnKey, perm4xx)
    driver.reportApiFailure(turnKey, perm4xx)
    driver.reportApiFailure(turnKey, perm4xx)

    const emitCountAfterTerminal = emits.length

    // 10 more after terminal — must all be no-ops.
    for (let i = 0; i < 10; i++) {
      driver.reportApiFailure(turnKey, perm4xx)
    }
    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 'r1' }, 'c')
    advance(0)

    expect(emits.length).toBe(emitCountAfterTerminal)
  })

  it('maxConsecutive4xx=0 disables the escalation mechanism entirely', () => {
    // When maxConsecutive4xx=0 the feature is off — any number of 4xx
    // errors must not produce a terminal card.
    const { driver, emits, advance, currentTurnKey } = failureHarness({ maxConsecutive4xx: 0 })

    driver.startTurn({ chatId: 'c', userText: 'task' })
    advance(0)
    const turnKey = currentTurnKey('c')

    const perm4xx = { code: 404, description: 'Bad Request: message to edit not found', kind: 'permanent_4xx' as const }
    for (let i = 0; i < 20; i++) {
      driver.reportApiFailure(turnKey, perm4xx)
    }

    // Card must still be live.
    const countBefore = emits.length
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 'b1' }, 'c')
    advance(0)
    expect(emits.length).toBeGreaterThan(countBefore)
  })

  it('reportApiFailure and reportApiSuccess are no-ops for unknown turnKeys', () => {
    // If the turn has already completed (chat purged from map), calls with
    // a stale turnKey must not throw.
    const { driver } = failureHarness()

    const perm4xx = { code: 403, description: 'Forbidden', kind: 'permanent_4xx' as const }
    expect(() => driver.reportApiFailure('nonexistent:99', perm4xx)).not.toThrow()
    expect(() => driver.reportApiSuccess('nonexistent:99')).not.toThrow()
  })

  it('429 rate-limit errors do not advance the permanent counter', () => {
    // Telegram 429 Too Many Requests is transient (retry_after). Classifier
    // must return kind:'transient' for 429 so that a rate-limit burst cannot
    // trip the consecutive-4xx threshold and permanently silence the card.
    const { driver, emits, advance, currentTurnKey } = failureHarness()

    driver.startTurn({ chatId: 'c', userText: 'task' })
    advance(0)
    const turnKey = currentTurnKey('c')

    driver.ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1' }, 'c')
    advance(0)
    const emitCountBeforeRateLimits = emits.length

    // Fire 10 consecutive 429 (transient) — more than 3× the default threshold.
    const rateLimit = { code: 429, description: 'Too Many Requests: retry after 5', kind: 'transient' as const }
    for (let i = 0; i < 10; i++) {
      driver.reportApiFailure(turnKey, rateLimit)
    }

    // Card must still be live. Subsequent events emit normally.
    driver.ingest({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' }, 'c')
    advance(100)
    expect(emits.length).toBeGreaterThan(emitCountBeforeRateLimits)

    // Extra guard: counter is genuinely zero. Two permanent_4xx after the
    // 429 burst must NOT tip into terminal (would take 3 to trigger).
    const emitsAfterTransient = emits.length
    const perm4xx = { code: 403, description: 'Forbidden', kind: 'permanent_4xx' as const }
    driver.reportApiFailure(turnKey, perm4xx)
    driver.reportApiFailure(turnKey, perm4xx)
    driver.ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't2' }, 'c')
    advance(100)
    expect(emits.length).toBeGreaterThan(emitsAfterTransient)
  })
})
