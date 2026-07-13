import { describe, expect, it } from 'vitest'
import {
  createWorkerActivityFeed,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'
import { renderCombinedWorkerFeed } from '../tool-activity-summary.js'
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
})
