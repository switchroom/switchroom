import { describe, expect, it } from 'vitest'
import {
  createWorkerActivityFeed,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'
import { renderCombinedWorkerFeed, combinedHistoryDepth } from '../tool-activity-summary.js'
import { STATUS_CARD_CHAR_BUDGET } from '../status-no-truncate.js'
import { createSendGate, isSendGateShed, type Clock } from '../send-gate.js'

/**
 * Outcome tests for the coalesced worker-activity feed (#3084 follow-up).
 *
 * These drive the REAL send gate (perChatPerSec=1, burst 3, editFloorMs=1500 —
 * the shipped defaults) with the feed's real send/edit adapters wired exactly
 * as the gateway wires them (`useful` sends, `cosmetic` edits carrying
 * messageId+editPayload). The assertions prove the coalescing win that the
 * per-worker-message model cannot achieve:
 *
 *   - N=15 workers in one chat produce exactly ONE combined message (not 15).
 *   - Every worker's latest state refreshes TOGETHER in that one message within
 *     one ~1.5s edit cycle (the per-worker model refreshes each card only once
 *     per ~N·(1/perChatPerSec) seconds — liveness collapse).
 *   - The gate SHEDS ~nothing under the coalesced stream (the per-worker model
 *     sheds ~14/15 of every second's cosmetic edits — a real ban happened).
 *   - A `critical` reply mid-storm is admitted, never shed/starved.
 *   - Redundant identical renders don't produce redundant landed edits.
 */

/**
 * Deterministic fake clock shared by BOTH the send gate (Clock.now/sleep) and
 * the feed (`now: () => clock.now()`). Mirrors send-gate.test.ts's FakeClock.
 */
class FakeClock implements Clock {
  private cur = 0
  private seq = 0
  private timers: { at: number; id: number; resolve: () => void }[] = []
  now(): number {
    return this.cur
  }
  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.cur + ms, id: this.seq++, resolve })
    })
  }
  async advance(ms: number): Promise<void> {
    const target = this.cur + ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) break
      const t = due[0]
      this.timers = this.timers.filter((x) => x !== t)
      this.cur = t.at
      t.resolve()
      await flush()
    }
    this.cur = target
  }
}
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}
/** Flush the promise-chain a few times so feed chains + gate drivers settle. */
async function settle(clock: FakeClock, ms = 0): Promise<void> {
  await clock.advance(ms)
  for (let i = 0; i < 6; i++) await flush()
}

interface LandedEdit {
  chatId: string
  messageId: number
  text: string
  at: number
}

/**
 * Build the feed + a bot adapter routed through a REAL send gate, exactly like
 * the gateway (worker-feed sends are `useful`, edits are `cosmetic` carrying
 * messageId + editPayload for the gate's floor/coalesce/no-op logic).
 */
function harness(clock: FakeClock, opts: { maxRows?: number } = {}) {
  const gate = createSendGate({
    enabled: true,
    clock,
    globalPerSec: 1000, // global is not the limiter under test
    globalBurst: 1000,
    perChatPerSec: 1,
    perChatBurst: 3,
    editFloorMs: 1500,
  })
  const sends: { chatId: string; messageId: number; at: number }[] = []
  const edits: LandedEdit[] = []
  let seq = 1000
  const bot: BotApiForWorkerFeed = {
    sendMessage: (chatId, _text, o) =>
      gate.gate(
        async () => {
          const messageId = seq++
          sends.push({ chatId, messageId, at: clock.now() })
          return { message_id: messageId }
        },
        { chat_id: chatId, priorityClass: 'useful', verb: 'worker-feed' },
      ) as Promise<{ message_id: number }>,
    editMessageText: (chatId, messageId, text, o) =>
      gate.gate(
        async () => {
          edits.push({ chatId, messageId, text, at: clock.now() })
          return true
        },
        {
          chat_id: chatId,
          priorityClass: 'cosmetic',
          messageId,
          editPayload: text,
          verb: 'worker-feed',
        },
      ),
  }
  const feed = createWorkerActivityFeed({
    bot,
    now: () => clock.now(),
    // Let the send gate's editFloorMs (1500) be the pacing authority: the feed's
    // own proactive throttle matches it so the coalesced stream never outruns
    // the per-chat bucket (which is what would shed it).
    minEditIntervalMs: 1500,
    heartbeatTickMs: 1500,
    firstPaintMinMs: 0,
    // No auto-timer: the test drives heartbeatTick() deterministically.
    setInterval: () => 0,
    clearInterval: () => {},
    maxRows: opts.maxRows ?? 8,
  })
  return { gate, feed, sends, edits }
}

function view(desc: string, step: string, elapsedMs: number): WorkerActivityView {
  return {
    description: desc,
    lastTool: null,
    toolCount: 3,
    latestSummary: step,
    elapsedMs,
    state: 'running',
  }
}

describe('coalesced worker feed — one message per chat under load', () => {
  it('N=15 workers over 60s produce ONE message with a bounded, non-shedding edit stream', async () => {
    const clock = new FakeClock()
    const CHAT = 'chat-storm'
    const N = 15
    const { gate, feed, sends, edits } = harness(clock, { maxRows: N })
    const ids = Array.from({ length: N }, (_, i) => `w${i}`)

    // Latest step each worker last emitted (unique per cycle so we can prove
    // freshness in the rendered body).
    const latest: Record<string, string> = {}

    const CYCLE = 1500
    const CYCLES = 40 // 40 * 1.5s = 60s
    for (let c = 0; c < CYCLES; c++) {
      await clock.advance(CYCLE)
      for (const id of ids) {
        latest[id] = `${id}-step-${c}`
        void feed.update(id, CHAT, view(`task ${id}`, latest[id], clock.now()))
      }
      await settle(clock)
      feed.heartbeatTick() // flush the accumulated combined render
      await settle(clock)
    }
    await settle(clock, 3000)

    // ONE combined message — not one per worker. This is the structural
    // distinction from the per-worker-message model (which sends N).
    expect(sends.length).toBe(1)
    expect(feed.size).toBe(N)

    // Bounded edit stream: at most perChatPerSec·T + burst landed edits.
    const seconds = (CYCLES * CYCLE) / 1000
    const bound = Math.ceil(1 * seconds + 3)
    expect(edits.length).toBeLessThanOrEqual(bound)
    // And it actually stayed live (edited many times, not frozen).
    expect(edits.length).toBeGreaterThan(CYCLES / 3)

    // Shed pin: the coalesced single stream sheds ~nothing. The per-worker model
    // would shed ~ (N-1)/N of every second's cosmetic edits.
    expect(gate.stats().global.shed).toBeLessThanOrEqual(3)

    // Liveness: the LAST landed edit carries EVERY worker's latest step — all
    // rows refreshed together in the one message within one edit cycle.
    const lastBody = edits[edits.length - 1].text
    for (const id of ids) {
      expect(lastBody).toContain(latest[id])
    }
  })

  it('admits a critical reply mid-storm (never shed or starved by the cosmetic feed)', async () => {
    const clock = new FakeClock()
    const CHAT = 'chat-crit'
    const { gate, feed } = harness(clock, { maxRows: 15 })
    const ids = Array.from({ length: 12 }, (_, i) => `k${i}`)

    // Warm the storm.
    for (let c = 0; c < 4; c++) {
      await clock.advance(1500)
      for (const id of ids) void feed.update(id, CHAT, view(`task ${id}`, `${id}-s${c}`, clock.now()))
      await settle(clock)
      feed.heartbeatTick()
      await settle(clock)
    }

    // A critical reply to the SAME chat, mid-storm. `critical` is never shed and
    // never blocks behind the cosmetic feed edits.
    const CRIT = { ok: true, id: 'crit-reply' }
    const p = gate.gate(async () => CRIT, {
      chat_id: CHAT,
      priorityClass: 'critical',
      verb: 'reply',
    })
    await settle(clock, 2000)
    const res = await p
    expect(isSendGateShed(res)).toBe(false)
    expect(res).toEqual(CRIT)
  })

  it('does not produce redundant landed edits for redundant renders (coalesce/no-op)', async () => {
    const clock = new FakeClock()
    const CHAT = 'chat-dedupe'
    const { gate, feed, edits } = harness(clock)

    // First paint + one edit with a real state change.
    await clock.advance(1500)
    void feed.update('w', CHAT, view('task w', 'step-A', clock.now()))
    await settle(clock)
    feed.heartbeatTick()
    await settle(clock, 2000)
    const afterFirst = edits.length

    // Re-drive the SAME state many times over several cycles. No new step, no new
    // state → the feed dedups (body === lastBody) and/or the gate drops the no-op;
    // either way, NO new landed edit and NO shed.
    const shedBefore = gate.stats().global.shed
    for (let c = 0; c < 5; c++) {
      await clock.advance(1500)
      void feed.update('w', CHAT, view('task w', 'step-A', clock.now()))
      await settle(clock)
      feed.heartbeatTick()
      await settle(clock, 2000)
    }
    // The header elapsed climbs on heartbeat, so a redundant *content* update
    // must not multiply landed edits beyond the heartbeat's own climb cadence.
    expect(edits.length - afterFirst).toBeLessThanOrEqual(5)
    // Crucially: redundant identical narrative never sheds.
    expect(gate.stats().global.shed).toBe(shedBefore)
  })
})

/**
 * Deterministic lifecycle transitions with a DIRECT fake bot (no gate) so we
 * can assert the exact rendered body at each step.
 */
function directBot() {
  const sent: { chatId: string; text: string; messageId: number }[] = []
  const edits: { messageId: number; text: string }[] = []
  let seq = 500
  const bot: BotApiForWorkerFeed = {
    sendMessage: async (chatId, text) => {
      const messageId = seq++
      sent.push({ chatId, text, messageId })
      return { message_id: messageId }
    },
    editMessageText: async (_chatId, messageId, text) => {
      edits.push({ messageId, text })
      return true
    },
  }
  return { bot, sent, edits }
}

describe('coalesced worker feed — lifecycle transitions', () => {
  it('two workers in one chat share ONE message that becomes a combined body', async () => {
    let clock = 0
    const { bot, sent } = directBot()
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 0,
      firstPaintMinMs: 0,
      setInterval: () => 0,
      clearInterval: () => {},
    })
    clock = 1000
    await feed.update('a', 'chat', view('task A', 'a-doing', 1000))
    clock = 1100
    await feed.update('b', 'chat', view('task B', 'b-doing', 1100))

    // ONE message for the chat (both workers share it), and its id is the same.
    expect(sent.length).toBe(1)
    expect(feed.messageIdOf('a')).toBe(feed.messageIdOf('b'))
    expect(feed.size).toBe(2)
  })

  it('finishing one of two drops its row (result NOT in the feed edit); the survivor stays live', async () => {
    let clock = 0
    const { bot, edits } = directBot()
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 0,
      firstPaintMinMs: 0,
      setInterval: () => 0,
      clearInterval: () => {},
    })
    clock = 1000
    await feed.update('a', 'chat', view('task A', 'a-doing', 1000))
    await feed.update('b', 'chat', view('task B', 'b-doing', 1000))
    clock = 2000
    await feed.finish('a', {
      description: 'task A',
      lastTool: null,
      toolCount: 3,
      latestSummary: 'SECRET-RESULT-A should reach the user via handback only',
      elapsedMs: 2000,
      state: 'done',
    })

    const last = edits[edits.length - 1].text
    // The finished worker's RESULT is never folded into the cosmetic feed edit.
    expect(last).not.toContain('SECRET-RESULT-A')
    // The survivor's live step is still shown.
    expect(last).toContain('b-doing')
    expect(feed.size).toBe(1)
    expect(feed.has('a')).toBe(false)
    expect(feed.has('b')).toBe(true)
  })

  it('finishing the LAST worker finalizes the shared message to its terminal recap', async () => {
    let clock = 0
    const { bot, edits } = directBot()
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 0,
      firstPaintMinMs: 0,
      setInterval: () => 0,
      clearInterval: () => {},
    })
    clock = 1000
    await feed.update('solo', 'chat', view('task solo', 'working', 1000))
    clock = 2000
    await feed.finish('solo', {
      description: 'task solo',
      lastTool: null,
      toolCount: 5,
      latestSummary: 'the final recap paragraph',
      elapsedMs: 2000,
      state: 'done',
    })
    const last = edits[edits.length - 1].text
    // Terminal recap: the single 🛠 Worker card carries the done state + result.
    expect(last).toContain('the final recap paragraph')
    expect(feed.size).toBe(0)
    // The finalized worker is gated against a late resurrecting cue.
    await feed.update('solo', 'chat', view('task solo', 'late tick', 3000))
    expect(feed.size).toBe(0)
  })
})

describe('coalesced worker feed — GROUP-level pin lifecycle (#3207 review)', () => {
  interface PinCall {
    feedKey: string
    chatId: string
    messageId: number | null
  }
  function pinHarness() {
    const pins: PinCall[] = []
    const { bot } = directBot()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 0,
      firstPaintMinMs: 0,
      setInterval: () => 0,
      clearInterval: () => {},
      reconcilePin: ({ feedKey, chatId, messageId }) => pins.push({ feedKey, chatId, messageId }),
    })
    return { feed, pins, setClock: (t: number) => (clock = t) }
  }
  const done = (desc: string, elapsedMs: number): WorkerActivityView => ({
    description: desc,
    lastTool: null,
    toolCount: 3,
    latestSummary: `${desc} result`,
    elapsedMs,
    state: 'done',
  })

  it('a mid-group sibling finish does NOT unpin the shared message while a worker still runs', async () => {
    const { feed, pins, setClock } = pinHarness()
    setClock(1000)
    await feed.update('a', 'chat', view('task A', 'a-doing', 1000))
    await feed.update('b', 'chat', view('task B', 'b-doing', 1000))

    // The group's shared message is pinned (messageId non-null).
    const pinnedAfterPaint = pins.filter((p) => p.messageId != null)
    expect(pinnedAfterPaint.length).toBeGreaterThan(0)
    const sharedMsgId = pinnedAfterPaint[pinnedAfterPaint.length - 1].messageId
    expect(feed.messageIdOf('a')).toBe(sharedMsgId)
    expect(feed.messageIdOf('b')).toBe(sharedMsgId)

    // A finishes while B still runs — the pin MUST stay (B needs the message).
    setClock(2000)
    await feed.finish('a', done('task A', 2000))

    // Every reconcilePin emitted through A's finish keeps the message pinned —
    // there is NO unpin (messageId === null) while B is live. This is the exact
    // regression the review flagged: a per-worker unpin here strands B unpinned.
    const last = pins[pins.length - 1]
    expect(last.messageId).toBe(sharedMsgId)
    expect(pins.some((p) => p.messageId === null)).toBe(false)
    // The feed still vouches for the group (reaper exemption stays live).
    const feedKey = last.feedKey
    expect(feed.hasRunningInFeed(feedKey)).toBe(true)
  })

  it('unpins the shared message only when the LAST worker finishes (group empties)', async () => {
    const { feed, pins, setClock } = pinHarness()
    setClock(1000)
    await feed.update('a', 'chat', view('task A', 'a-doing', 1000))
    await feed.update('b', 'chat', view('task B', 'b-doing', 1000))
    setClock(2000)
    await feed.finish('a', done('task A', 2000))
    expect(pins.some((p) => p.messageId === null)).toBe(false) // B still runs

    // Now the last worker finishes → the group empties → unpin fires.
    setClock(3000)
    await feed.finish('b', done('task B', 3000))
    const last = pins[pins.length - 1]
    expect(last.messageId).toBeNull()
    const feedKey = last.feedKey
    expect(feed.hasRunningInFeed(feedKey)).toBe(false) // reaper may now reap it
  })
})

describe('renderCombinedWorkerFeed (pure)', () => {
  const row = (i: number, step: string) => ({
    description: `task number ${i}`,
    elapsedMs: 12_000 + i * 1000,
    toolCount: i,
    currentStep: step,
  })

  it('renders one row-block per worker with a running count header', () => {
    const body = renderCombinedWorkerFeed([row(1, 'alpha step'), row(2, 'beta step')], { maxRows: 8 })!
    expect(body).toContain('Workers')
    expect(body).toContain('2 running')
    expect(body).toContain('task number 1')
    expect(body).toContain('task number 2')
    expect(body).toContain('alpha step')
    expect(body).toContain('beta step')
  })

  it('caps at maxRows and spills the remainder to a compact +M more working line', () => {
    const rows = Array.from({ length: 15 }, (_, i) => row(i, `s${i}`))
    const body = renderCombinedWorkerFeed(rows, { maxRows: 8 })!
    expect(body).toContain('15 running')
    expect(body).toContain('+7 more working')
    // The 8th row is shown, the 9th is spilled.
    expect(body).toContain('s7')
    expect(body).not.toContain('s8')
  })

  it('stays under the rich-message wire budget even with many long rows (backstop drops rows)', () => {
    // 120 rows of ~700 raw chars each would be ~84k > the 32768 rich-message
    // cap; the char-budget backstop must shrink the visible set until it fits.
    const rows = Array.from({ length: 120 }, () => ({
      description: 'x'.repeat(300),
      elapsedMs: 60_000,
      toolCount: 40,
      currentStep: 'y'.repeat(400),
    }))
    const body = renderCombinedWorkerFeed(rows, { maxRows: 120 })!
    expect(body.length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
    // The backstop grew the spill line rather than overflowing the wire.
    expect(body).toContain('more working')
  })

  it('returns null for an empty worker set', () => {
    expect(renderCombinedWorkerFeed([], { maxRows: 8 })).toBeNull()
  })

  // ── Adaptive density: per-worker rolling history within a line budget ──────
  const rowH = (i: number, history: string[]) => ({
    description: `task number ${i}`,
    elapsedMs: 12_000 + i * 1000,
    toolCount: i,
    currentStep: history[history.length - 1] ?? '',
    historyLines: history,
  })

  // A history line rendered as a PRIOR (done) step in the single-worker idiom.
  const struck = (s: string) => `~~_✓ ${s}_~~`
  // A history line rendered as the NEWEST in-progress step.
  const current = (s: string) => `**→ ${s}**`

  it('with 2 workers paints each worker MULTIPLE history lines with the ✓/→ strikethrough idiom', () => {
    const body = renderCombinedWorkerFeed(
      [
        rowH(1, ['a first', 'a second', 'a third']),
        rowH(2, ['b first', 'b second', 'b third']),
      ],
      { maxRows: 8 },
    )!
    // Prior steps struck-through, newest bold — same idiom as the single card.
    expect(body).toContain(struck('a first'))
    expect(body).toContain(struck('a second'))
    expect(body).toContain(current('a third'))
    expect(body).toContain(struck('b first'))
    expect(body).toContain(struck('b second'))
    expect(body).toContain(current('b third'))
    // This is the regression assertion: the OLD single-line-only render would
    // have shown only 'a third'/'b third' as `→ _step_`, never the earlier
    // struck lines. Prove the trail is restored.
    expect(body).toContain('a first')
    expect(body).toContain('b first')
  })

  it('degrades to ONE history line per worker at a large fan-out and stays within the body budget', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      rowH(i, [`w${i} oldest`, `w${i} middle`, `w${i} newest`]),
    )
    const body = renderCombinedWorkerFeed(rows, { maxRows: 8 })!
    // Only the newest step of each worker survives — the earlier lines are
    // dropped by the per-worker depth clamp (floor((13-6)/6)=1).
    for (let i = 0; i < 6; i++) {
      expect(body).toContain(current(`w${i} newest`))
      expect(body).not.toContain(`w${i} oldest`)
      expect(body).not.toContain(`w${i} middle`)
    }
    // Total body lines (worker headers + history) stay within the budget: 6
    // header lines + 6 history lines = 12 ≤ MAX_COMBINED_BODY_LINES (13). Count
    // only the per-worker body lines (exclude the top count line + any spill).
    const bodyLines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const headerAndHistory = bodyLines.filter(
      (l) => !l.startsWith('🛠') && !l.includes('more working'),
    )
    expect(headerAndHistory.length).toBeLessThanOrEqual(13)
  })

  it('exposes the deterministic depth formula (2→5, 3→3, 4→2, 6→1)', () => {
    expect(combinedHistoryDepth(2)).toBe(5)
    expect(combinedHistoryDepth(3)).toBe(3)
    expect(combinedHistoryDepth(4)).toBe(2)
    expect(combinedHistoryDepth(6)).toBe(1)
    expect(combinedHistoryDepth(8)).toBe(1)
  })
})

/**
 * Worker-feed ghost-leak (immortal/unpinned/buried card) — outcome tests.
 *
 * Root cause: the feed removed a worker's row ONLY from the gateway's
 * `onFinish` handler. Terminal paths that never fire `onFinish` (the watcher's
 * JSONL-vanished `onFileVanished` → `cleanupTerminalAgent`, and boot done-at-
 * boot orphans) left the row in the feed forever — the shared card never
 * emptied, so it never collapsed/unpinned and heartbeat-edited indefinitely
 * while buried up-chat. The fix wires feed removal to the watcher's
 * authoritative terminal sweep (`terminate`, driven by `onTerminalCleanup`)
 * PLUS a backstop TTL sweep. These assert the OUTCOMES, not the code paths.
 */
function ghostHarness(opts: { staleWorkerTtlMs?: number; now: () => number }) {
  const edits: { messageId: number; text: string }[] = []
  const sends: { text: string }[] = []
  const pins: { messageId: number | null }[] = []
  let seq = 500
  const bot: BotApiForWorkerFeed = {
    sendMessage: async (_chatId, text) => {
      sends.push({ text })
      return { message_id: seq++ }
    },
    editMessageText: async (_chatId, messageId, text) => {
      edits.push({ messageId, text })
      return true
    },
  }
  const feed = createWorkerActivityFeed({
    bot,
    now: opts.now,
    minEditIntervalMs: 0,
    heartbeatTickMs: 1000,
    firstPaintMinMs: 0,
    setInterval: () => 0,
    clearInterval: () => {},
    staleWorkerTtlMs: opts.staleWorkerTtlMs,
    reconcilePin: ({ messageId }) => pins.push({ messageId }),
  })
  return { feed, edits, sends, pins }
}
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

describe('worker-feed ghost-leak — deterministic terminal removal + backstop', () => {
  it('finish() on the LAST worker removes its row, collapses to the terminal summary, and UNPINS', async () => {
    let t = 0
    const { feed, sends, edits, pins } = ghostHarness({ now: () => t })
    await feed.update('a', 'chat', view('task a', 'reading files', 0))
    await drain()
    expect(sends.length).toBe(1)
    expect(feed.size).toBe(1)
    // Painting the group pins the shared message.
    expect(pins.at(-1)?.messageId).not.toBeNull()

    t = 5000
    await feed.finish('a', {
      description: 'task a',
      lastTool: null,
      toolCount: 3,
      latestSummary: 'all done',
      elapsedMs: 5000,
      state: 'done',
    })
    await drain()
    // Row gone → the active set empties.
    expect(feed.size).toBe(0)
    // Collapsed to a terminal summary (a distinct edit landed, showing 'done').
    expect(edits.length).toBeGreaterThan(0)
    expect(edits.at(-1)?.text).toContain('done')
    // And UNPINNED (group empty → reconcilePin messageId null).
    expect(pins.at(-1)?.messageId).toBeNull()
  })

  it('terminate() (authoritative onTerminalCleanup sweep) reaps a worker whose onFinish NEVER fired — collapses + unpins', async () => {
    let t = 0
    const { feed, edits, pins } = ghostHarness({ now: () => t })
    await feed.update('b', 'chat', view('task b', 'running a command', 0))
    await drain()
    expect(feed.size).toBe(1)
    expect(pins.at(-1)?.messageId).not.toBeNull()

    // Simulate the watcher's JSONL-vanished sweep: cleanupTerminalAgent → this,
    // with NO onFinish ever delivered.
    t = 3000
    await feed.terminate('b')
    await drain()
    expect(feed.size).toBe(0)
    expect(pins.at(-1)?.messageId).toBeNull()
    // The card stopped editing: no further heartbeat edits after termination.
    const after = edits.length
    t = 20000
    feed.heartbeatTick()
    await drain()
    expect(edits.length).toBe(after)
  })

  it('backstop TTL sweep force-reaps a leaked slot (terminal signal never delivered), then the card collapses + unpins', async () => {
    let t = 0
    const { feed, edits, pins } = ghostHarness({ staleWorkerTtlMs: 1000, now: () => t })
    await feed.update('c', 'chat', view('task c', 'thinking', 0))
    await drain()
    expect(feed.size).toBe(1)

    // No finish, no terminate — the worker is a pure leak. Advance past the TTL.
    t = 2500
    feed.heartbeatTick()
    await drain()
    expect(feed.size).toBe(0)
    expect(pins.at(-1)?.messageId).toBeNull()

    // Immortality closed: subsequent heartbeats produce no further edits.
    const after = edits.length
    t = 10000
    feed.heartbeatTick()
    await drain()
    expect(edits.length).toBe(after)
  })

  it('a still-live worker (fresh update within the TTL) is NOT reaped by the backstop sweep', async () => {
    let t = 0
    const { feed } = ghostHarness({ staleWorkerTtlMs: 1000, now: () => t })
    await feed.update('d', 'chat', view('task d', 's0', 0))
    await drain()
    // A fresh cue just before the sweep keeps it live.
    t = 900
    await feed.update('d', 'chat', view('task d', 's1', 900))
    await drain()
    t = 1500
    feed.heartbeatTick()
    await drain()
    // Still tracked — the sweep only reaps rows silent PAST the TTL.
    expect(feed.size).toBe(1)
  })

  it('no-op re-render is skipped (byte-identical body → no redundant edit)', async () => {
    let t = 0
    const { feed, edits } = ghostHarness({ now: () => t })
    await feed.update('e', 'chat', view('task e', 'same step', 0))
    await drain()
    const afterPaint = edits.length // first paint is a send, not an edit
    // Identical view (same elapsed → byte-identical rendered body): dedup skips.
    await feed.update('e', 'chat', view('task e', 'same step', 0))
    await drain()
    expect(edits.length).toBe(afterPaint)
  })
})
