import { describe, expect, it } from 'vitest'
import {
  createWorkerActivityFeed,
  renderWorkerActivity,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'
import { renderCombinedWorkerFeed, combinedHistoryDepth } from '../tool-activity-summary.js'
import { STATUS_CARD_CHAR_BUDGET, WORKER_STEP_INDENT } from '../status-no-truncate.js'
import { richMessage } from '../rich-send.js'
import { parseRichEntities, validateRichMarkdown } from './rich-markdown-oracle.js'
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

    // Liveness + bounded card (#3349): under Ken's curve every SHOWN worker
    // keeps depth 3, so a 15-way storm cannot render every row — the 24-line
    // body ceiling collapses the newest rows into a `+N more working…` spill.
    // The last landed edit still carries the VISIBLE workers' latest steps
    // (refreshed together in the one message) and a spill marker for the rest.
    const lastBody = edits[edits.length - 1].text
    // 6 rows fit the 24-line budget (6·(1 header + 3 depth) = 24); the oldest
    // rows (w0…w5) stay visible, the 9 newest spill.
    for (let i = 0; i < 6; i++) {
      expect(lastBody).toContain(latest[`w${i}`])
    }
    expect(lastBody).toContain('more working')
    // Still exactly ONE message — the spill is a render detail, not a new send.
    expect(sends.length).toBe(1)
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

// ─── #3207 leaked-finished-row fix ────────────────────────────────────────────
//
// Root cause of the "progress card never unpins; later workers append to a
// stale pinned message" incident (a card observed pinned + edited for 2h12m):
// a finished worker row whose terminal edit hit a 429/flood window was left in
// `g.workers`, so the group never emptied → never deleted → never unpinned, and
// a later worker inherited the stale message. These outcome tests pin the fix:
// group emptiness / deletion / unpin are decoupled from terminal-edit success,
// the finalize staging is per-agent (no single-slot overwrite), and a later
// worker never reuses a terminated group's message.

describe('coalesced worker feed — leaked finished-row fix (#3207)', () => {
  interface PinCall {
    feedKey: string
    chatId: string
    messageId: number | null
  }
  function leakHarness(opts: { failEdits?: () => unknown } = {}) {
    const pins: PinCall[] = []
    const sent: { chatId: string; text: string; messageId: number }[] = []
    const edits: { messageId: number; text: string }[] = []
    let seq = 700
    let clock = 0
    const bot: BotApiForWorkerFeed = {
      sendMessage: async (chatId, text) => {
        const messageId = seq++
        sent.push({ chatId, text, messageId })
        return { message_id: messageId }
      },
      editMessageText: async (_chatId, messageId, text) => {
        const err = opts.failEdits?.()
        if (err != null) throw err
        edits.push({ messageId, text })
        return true
      },
    }
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 0,
      firstPaintMinMs: 0,
      heartbeatTickMs: 6000,
      setInterval: () => 0,
      clearInterval: () => {},
      reconcilePin: ({ feedKey, chatId, messageId }) => pins.push({ feedKey, chatId, messageId }),
    })
    return { feed, pins, sent, edits, setClock: (t: number) => (clock = t) }
  }
  const done = (desc: string, elapsedMs: number): WorkerActivityView => ({
    description: desc,
    lastTool: null,
    toolCount: 3,
    latestSummary: `${desc} result`,
    elapsedMs,
    state: 'done',
  })
  const drain = () => new Promise((r) => setTimeout(r, 0))

  it('drops the finished row + requests unpin even when the last terminal edit floods (429)', async () => {
    let flooding = true
    const { feed, pins, sent, edits, setClock } = leakHarness({
      failEdits: () => (flooding ? { error_code: 429, parameters: { retry_after: 2 } } : null),
    })
    setClock(1000)
    await feed.update('w1', 'chat', view('task 1', 'doing', 1000))
    expect(sent).toHaveLength(1)
    const feedKey = pins[pins.length - 1].feedKey

    // The LAST worker finishes but the terminal recap edit 429s.
    setClock(2000)
    await feed.finish('w1', done('task 1', 2000))
    await drain()

    // Outcome: the finished row is gone and the pin is RELEASED immediately —
    // neither is blocked by the failed terminal edit.
    expect(feed.has('w1')).toBe(false)
    expect(feed.size).toBe(0)
    // Pin-reaper backstop: no running rows remain → the group is not "running".
    expect(feed.hasRunningInFeed(feedKey)).toBe(false)
    expect(pins[pins.length - 1].messageId).toBeNull()
    // The terminal recap has NOT landed yet (still flooding) — proves the unpin
    // did not wait on it.
    expect(edits.some((e) => e.text.includes('_done ·'))).toBe(false)

    // Flood clears; a heartbeat past the cooldown re-drives the staged recap.
    flooding = false
    setClock(5000)
    feed.heartbeatTick()
    await drain()
    expect(edits.some((e) => e.text.includes('_done ·'))).toBe(true)

    // The group is fully reaped: a later worker in the SAME chat paints a FRESH
    // message — it does NOT reuse/edit the terminated group's message id.
    setClock(6000)
    await feed.update('w2', 'chat', view('task 2', 'doing2', 6000))
    await drain()
    expect(sent).toHaveLength(2)
    expect(feed.messageIdOf('w2')).toBe(sent[1].messageId)
    expect(feed.messageIdOf('w2')).not.toBe(sent[0].messageId)
  })

  it('TWO workers finishing in the same flood window are BOTH reaped (no single-slot overwrite)', async () => {
    let flooding = true
    const { feed, pins, sent, edits, setClock } = leakHarness({
      failEdits: () => (flooding ? { error_code: 429, parameters: { retry_after: 2 } } : null),
    })
    setClock(1000)
    await feed.update('a', 'chat', view('task A', 'a-doing', 1000))
    await feed.update('b', 'chat', view('task B', 'b-doing', 1000))
    expect(feed.size).toBe(2)
    const feedKey = pins[pins.length - 1].feedKey

    // Both finish before either finalize chain drains, so both latch terminal in
    // the SAME cooldown window. The old single `pendingFinalize` slot dropped all
    // but one → the other row leaked forever. The per-agent map keeps both.
    setClock(2000)
    const f1 = feed.finish('a', done('task A', 2000))
    const f2 = feed.finish('b', done('task B', 2000))
    await Promise.all([f1, f2])
    await drain()

    // NEITHER finished row leaks — the group is empty and unpinned.
    expect(feed.size).toBe(0)
    expect(feed.hasRunningInFeed(feedKey)).toBe(false)
    expect(pins[pins.length - 1].messageId).toBeNull()

    // Flood clears; one heartbeat drains ALL staged recaps and reaps the group.
    flooding = false
    setClock(5000)
    feed.heartbeatTick()
    await drain()

    // BOTH staged terminal recaps must actually repaint — not just one. This is
    // the contract the per-agent `pendingFinalize` map exists to hold: a single-
    // slot `pendingFinalize` would have let worker B's stage overwrite worker A's,
    // so only ONE recap edit would land and this assertion would FAIL. The
    // decoupled row-removal (fix 1) alone would pass size===0 + unpin above WITHOUT
    // repainting either recap, so those assertions do not pin this contract — these
    // do. Each recap carries its own worker's description ('task A' / 'task B').
    const doneEdits = edits.filter((e) => e.text.includes('_done ·'))
    expect(doneEdits.some((e) => e.text.includes('task A'))).toBe(true)
    expect(doneEdits.some((e) => e.text.includes('task B'))).toBe(true)

    // The group is gone: a later worker paints a FRESH message, never editing a
    // terminated sibling's message.
    setClock(6000)
    await feed.update('c', 'chat', view('task C', 'c-doing', 6000))
    await drain()
    const firstMsgId = sent[0].messageId
    expect(feed.messageIdOf('c')).toBe(sent[sent.length - 1].messageId)
    expect(feed.messageIdOf('c')).not.toBe(firstMsgId)
  })

  it('a later worker after all prior workers finished does NOT reuse the prior message id', async () => {
    const { feed, sent, setClock } = leakHarness()
    setClock(1000)
    await feed.update('w1', 'chat', view('task 1', 'doing', 1000))
    setClock(2000)
    await feed.finish('w1', done('task 1', 2000))
    await drain()
    expect(feed.size).toBe(0)

    // A brand-new worker in the same chat gets its OWN fresh message.
    setClock(3000)
    await feed.update('w2', 'chat', view('task 2', 'doing2', 3000))
    await drain()
    expect(sent).toHaveLength(2)
    expect(feed.messageIdOf('w2')).toBe(sent[1].messageId)
    expect(feed.messageIdOf('w2')).not.toBe(sent[0].messageId)
  })

  it('hasRunningInFeed is false once only finished rows remain (pin-reaper backstop fires)', async () => {
    // A sibling keeps the group running; when the LAST running worker finishes,
    // no running row remains → hasRunningInFeed flips to false so the gateway's
    // wk:group: reaper is free to unpin (finished rows never count as running).
    const { feed, pins, setClock } = leakHarness()
    setClock(1000)
    await feed.update('a', 'chat', view('task A', 'a-doing', 1000))
    await feed.update('b', 'chat', view('task B', 'b-doing', 1000))
    const feedKey = pins[pins.length - 1].feedKey
    expect(feed.hasRunningInFeed(feedKey)).toBe(true)

    setClock(2000)
    await feed.finish('a', done('task A', 2000))
    await drain()
    // One still runs → still counts.
    expect(feed.hasRunningInFeed(feedKey)).toBe(true)

    setClock(3000)
    await feed.finish('b', done('task B', 3000))
    await drain()
    // Only finished work remains → NOT running.
    expect(feed.hasRunningInFeed(feedKey)).toBe(false)
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

  it('holds the MIN_WORKER_DEPTH (3) floor per shown worker at a large fan-out and stays within the body budget (#3349)', () => {
    // 6 workers each with a deep (5-line) history. Ken's curve pins depth=3 at
    // 4+ workers, so every SHOWN worker paints its last 3 steps. 6·(1 header +
    // 3 history) = 24 lines = MAX_COMBINED_BODY_LINES, so all 6 stay visible.
    const rows = Array.from({ length: 6 }, (_, i) =>
      rowH(i, [`w${i} s1`, `w${i} s2`, `w${i} s3`, `w${i} s4`, `w${i} s5`]),
    )
    const body = renderCombinedWorkerFeed(rows, { maxRows: 8 })!
    for (let i = 0; i < 6; i++) {
      // Last 3 steps shown; the two oldest dropped by the depth-3 window.
      expect(body).toContain(current(`w${i} s5`))
      expect(body).toContain(struck(`w${i} s4`))
      expect(body).toContain(struck(`w${i} s3`))
      expect(body).not.toContain(`w${i} s1`)
      expect(body).not.toContain(`w${i} s2`)
    }
    // Body lines (worker headers + history) stay within the re-derived budget.
    const bodyLines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const headerAndHistory = bodyLines.filter(
      (l) => !l.startsWith('🛠') && !l.includes('more working'),
    )
    expect(headerAndHistory.length).toBeLessThanOrEqual(24)
  })

  it('drops NEWEST (trailing) rows into the spill when the fan-out overflows the 24-line body budget, keeping per-worker depth at 3 (#3349)', () => {
    // 8 workers × (1 header + 3 depth) = 32 > 24 → the backstop collapses the 2
    // newest (trailing) visible rows into `+M more working…`, so 6 rows render at full
    // depth-3 (24 lines) rather than every worker losing a step.
    const rows = Array.from({ length: 8 }, (_, i) =>
      rowH(i, [`w${i} s1`, `w${i} s2`, `w${i} s3`]),
    )
    const body = renderCombinedWorkerFeed(rows, { maxRows: 8 })!
    expect(body).toContain('more working')
    const bodyLines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const headerAndHistory = bodyLines.filter(
      (l) => !l.startsWith('🛠') && !l.includes('more working'),
    )
    expect(headerAndHistory.length).toBeLessThanOrEqual(24)
    expect(body).toContain('+2 more working')
    // The 6 kept rows render at full depth-3 (last row kept shows all 3 steps).
    expect(body).toContain(current('w5 s3'))
    expect(body).toContain(struck('w5 s2'))
    expect(body).toContain(struck('w5 s1'))
    // The 2 trailing rows spilled — none of worker 7's lines render.
    expect(body).not.toContain('w7 s3')
  })

  it("exposes Ken's deterministic depth curve max(3, 7−w): 1→6, 2→5, 3→4, 4→3, 5+→3 (#3349)", () => {
    expect(combinedHistoryDepth(1)).toBe(6)
    expect(combinedHistoryDepth(2)).toBe(5)
    expect(combinedHistoryDepth(3)).toBe(4)
    expect(combinedHistoryDepth(4)).toBe(3)
    expect(combinedHistoryDepth(5)).toBe(3)
    expect(combinedHistoryDepth(6)).toBe(3)
    expect(combinedHistoryDepth(8)).toBe(3)
  })

  // ── Worker numbering (#3298): stable ordinal prefix at 2+ workers ──────────
  const rowN = (i: number, ordinal: number) => ({ ...row(i, `step ${i}`), ordinal })

  it('numbers the workers with a literal "N. " prefix inside the bold header when 2+ run', () => {
    const body = renderCombinedWorkerFeed([rowN(1, 1), rowN(2, 2)], { maxRows: 8 })!
    // The literal `1. ` must survive markdown rendering, inside the bold span
    // before the escaped description.
    expect(body).toContain('**1. task number 1**')
    expect(body).toContain('**2. task number 2**')
  })

  it('renders non-contiguous ordinals as-is (survivors keep their numbers after a finish)', () => {
    // Worker 1 finished upstream — the surviving rows arrive with their
    // ORIGINAL ordinals. Positional numbering would render 1./2. here; the
    // stable scheme must render 2./3. and never a `1. `.
    const body = renderCombinedWorkerFeed([rowN(2, 2), rowN(3, 3)], { maxRows: 8 })!
    expect(body).toContain('**2. task number 2**')
    expect(body).toContain('**3. task number 3**')
    expect(body).not.toContain('**1. ')
  })

  it('a single row is never numbered, even when it carries an ordinal', () => {
    const body = renderCombinedWorkerFeed([rowN(1, 1)], { maxRows: 8 })!
    expect(body).toContain('**task number 1**')
    expect(body).not.toContain('**1. ')
  })

  it('rows without ordinals render unnumbered (back-compat for direct callers)', () => {
    const body = renderCombinedWorkerFeed([row(1, 'alpha'), row(2, 'beta')], { maxRows: 8 })!
    expect(body).toContain('**task number 1**')
    expect(body).toContain('**task number 2**')
    expect(body).not.toContain('1. task')
  })

  it('spilled rows take their ordinals with them; visible ordinals do not shift', () => {
    const rows = Array.from({ length: 10 }, (_, i) => rowN(i + 1, i + 1))
    const body = renderCombinedWorkerFeed(rows, { maxRows: 4 })!
    expect(body).toContain('+6 more working')
    for (let n = 1; n <= 4; n++) expect(body).toContain(`**${n}. task number ${n}**`)
    expect(body).not.toContain('**5. ')
  })
})

// ── #3349: Ken's per-worker depth curve 6/5/4/3, exact rendered depth ─────────
describe("Ken's per-worker step-trail depth curve (#3349)", () => {
  // A worker with a DEEP history (8 lines) so the depth curve — not the buffer —
  // is always the binding limit. Each history line is uniquely tokenised
  // (`w{i}-s{n}`) so we can count exactly how many of a worker's steps rendered.
  const deepRow = (i: number) => ({
    description: `task w${i}`,
    elapsedMs: 12_000 + i * 1000,
    toolCount: 3,
    ordinal: i + 1,
    currentStep: `w${i}-s8`,
    historyLines: Array.from({ length: 8 }, (_, n) => `w${i}-s${n + 1}`),
  })
  // Count how many of worker `i`'s step tokens appear in the rendered body.
  const shownSteps = (body: string, i: number): number =>
    (body.match(new RegExp(`w${i}-s\\d`, 'g')) ?? []).length

  it.each([
    [1, 6],
    [2, 5],
    [3, 4],
    [4, 3],
    [5, 3],
  ])('%i worker(s) → exactly %i steps rendered per worker', (workers, expectedDepth) => {
    const rows = Array.from({ length: workers }, (_, i) => deepRow(i))
    const body = renderCombinedWorkerFeed(rows, { maxRows: 8 })!
    expect(combinedHistoryDepth(workers)).toBe(expectedDepth)
    for (let i = 0; i < workers; i++) {
      expect(shownSteps(body, i)).toBe(expectedDepth)
    }
    // Newest step last (bottom-anchored → bold), oldest rendered step struck.
    const worker0 = `**→ w0-s8**`
    expect(body).toContain(worker0)
  })

  it('a worker with FEWER steps than the depth shows all it has, no padding', () => {
    // 3 workers → depth 4, but this worker only has 2 steps: render both, no more.
    const rows = [
      { description: 'shallow', elapsedMs: 12_000, toolCount: 1, ordinal: 1,
        currentStep: 'only-b', historyLines: ['only-a', 'only-b'] },
      deepRow(1),
      deepRow(2),
    ]
    const body = renderCombinedWorkerFeed(rows, { maxRows: 8 })!
    expect(combinedHistoryDepth(3)).toBe(4)
    expect(body).toContain('~~_✓ only-a_~~')
    expect(body).toContain('**→ only-b**')
    // Deep workers still get their full 4.
    expect(shownSteps(body, 1)).toBe(4)
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
function ghostHarness(opts: { staleWorkerTtlMs?: number; absoluteRowLifetimeCapMs?: number; now: () => number }) {
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
    absoluteRowLifetimeCapMs: opts.absoluteRowLifetimeCapMs,
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

  // ── ABSOLUTE row-lifetime cap (Carrie 5h zombie pin, v0.18.23) ──────────────
  // The silence-keyed `staleWorkerTtlMs` backstop is defeated by a leaked row
  // that never finishes AND keeps receiving `update()` cues every heartbeat:
  // each cue resets `lastUpdateAt`, so the silence sweep can NEVER match and the
  // pinned card lives forever (observed: 5h, re-edited 3000+ times). The
  // absolute cap is anchored to the row's IMMUTABLE creation time, so it reaps
  // the row regardless of how recently it updated.
  it('ABSOLUTE cap reaps an immortal-but-UPDATING row that resets lastUpdateAt every tick, then unpins', async () => {
    let t = 0
    // Silence TTL huge (would never fire); absolute cap small. The row keeps
    // updating just under the silence TTL each step, so ONLY the absolute cap
    // (immune to the lastUpdateAt reset) can catch it.
    const { feed, edits, pins } = ghostHarness({
      staleWorkerTtlMs: 1_000_000,
      absoluteRowLifetimeCapMs: 5000,
      now: () => t,
    })
    await feed.update('z', 'chat', view('zombie task', 's0', 0))
    await drain()
    expect(feed.size).toBe(1)
    expect(pins.at(-1)?.messageId).not.toBeNull()

    // Drive continuous updates past the absolute cap — each resets lastUpdateAt,
    // so the silence sweep stays defeated (exactly the Carrie failure mode).
    for (let step = 1; step <= 8; step++) {
      t = step * 1000
      await feed.update('z', 'chat', view('zombie task', `s${step}`, t))
      await drain()
      feed.heartbeatTick()
      await drain()
    }
    // The absolute cap (5s) has been crossed while the row kept updating →
    // reaped despite the fresh cues, and the shared card UNPINNED.
    expect(feed.size).toBe(0)
    expect(pins.at(-1)?.messageId).toBeNull()

    // Immortality closed for good: the finalized gate blocks a late cue from
    // resurrecting the row, and further heartbeats produce no edits.
    await feed.update('z', 'chat', view('zombie task', 's-late', t))
    await drain()
    expect(feed.size).toBe(0)
    const after = edits.length
    t += 10000
    feed.heartbeatTick()
    await drain()
    expect(edits.length).toBe(after)
  })

  it('ABSOLUTE cap reaps a row past the cap even when the silence TTL would never fire', async () => {
    let t = 0
    const { feed, pins } = ghostHarness({
      staleWorkerTtlMs: 1_000_000,
      absoluteRowLifetimeCapMs: 5000,
      now: () => t,
    })
    await feed.update('f', 'chat', view('task f', 's0', 0))
    await drain()
    expect(pins.at(-1)?.messageId).not.toBeNull()
    // Past the absolute cap with no update at all — the age anchor alone reaps.
    t = 6000
    feed.heartbeatTick()
    await drain()
    expect(feed.size).toBe(0)
    expect(pins.at(-1)?.messageId).toBeNull()
  })

  // ── Boot/reconnect purge (Ken's key ask) ───────────────────────────────────
  // Every tracked row is a dead child sub-agent after a restart/reconnect. On a
  // bare bridge reconnect the OLD feed's `wk:group:` pins are orphaned — the new
  // empty feed never knew those groups, so it can never unpin them, and no full-
  // boot pin sweep runs. `purgeAllOnBoot()` must reconcile the feed to empty AND
  // release the pin unconditionally.
  it('purgeAllOnBoot empties a restored running row + pinned card and UNPINS', async () => {
    let t = 0
    const { feed, pins } = ghostHarness({ now: () => t })
    // A running worker with a live pinned card (the "restored at startup" state).
    await feed.update('p', 'chat', view('task p', 'working', 0))
    await drain()
    expect(feed.size).toBe(1)
    expect(pins.at(-1)?.messageId).not.toBeNull()

    feed.purgeAllOnBoot()

    // Feed reconciled to empty AND the coalesced card unpinned (messageId null).
    expect(feed.size).toBe(0)
    expect(pins.at(-1)?.messageId).toBeNull()

    // A late cue on the torn-down feed must NOT resurrect a row (finalized gate).
    t = 100
    await feed.update('p', 'chat', view('task p', 'zombie tick', 100))
    await drain()
    expect(feed.size).toBe(0)
  })

  it('purgeAllOnBoot unpins EVERY group (multiple chats) and is a no-op when already empty', async () => {
    let t = 0
    const { feed, pins } = ghostHarness({ now: () => t })
    await feed.update('g1', 'chatA', view('a', 's', 0))
    await feed.update('g2', 'chatB', view('b', 's', 0))
    await drain()
    expect(feed.size).toBe(2)

    const pinsBefore = pins.length
    feed.purgeAllOnBoot()
    expect(feed.size).toBe(0)
    // Both groups emitted a final unpin (messageId null).
    const unpinsAfter = pins.slice(pinsBefore).filter((p) => p.messageId === null)
    expect(unpinsAfter.length).toBe(2)

    // Idempotent: a second purge on an empty feed emits no further pin calls.
    const afterFirst = pins.length
    feed.purgeAllOnBoot()
    expect(pins.length).toBe(afterFirst)
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

describe('worker numbering — stable per-card ordinals end to end (#3298)', () => {
  const doneView = (desc: string, elapsedMs: number): WorkerActivityView => ({
    description: desc,
    lastTool: null,
    toolCount: 3,
    latestSummary: `${desc} result`,
    elapsedMs,
    state: 'done',
  })
  const lastBody = (h: { sends: { text: string }[]; edits: { messageId: number; text: string }[] }): string => {
    if (h.edits.length > 0) return h.edits[h.edits.length - 1].text
    return h.sends[h.sends.length - 1].text
  }

  it('assigns 1./2./3. at dispatch and survivors KEEP their numbers when an earlier worker finishes', async () => {
    let clock = 1000
    const h = ghostHarness({ now: () => clock })
    await h.feed.update('a', 'chat', view('task alpha', 'a-doing', 0))
    await h.feed.update('b', 'chat', view('task beta', 'b-doing', 0))
    await h.feed.update('c', 'chat', view('task gamma', 'c-doing', 0))
    await drain()

    let body = lastBody(h)
    expect(body).toContain('**1. task alpha**')
    expect(body).toContain('**2. task beta**')
    expect(body).toContain('**3. task gamma**')

    // Worker 1 finishes: the survivors must STILL be 2. and 3. — positional
    // numbering would renumber them 1./2. and this assertion would fail.
    clock = 2000
    await h.feed.finish('a', doneView('task alpha', 1000))
    await drain()
    body = lastBody(h)
    expect(body).toContain('2 running')
    expect(body).toContain('**2. task beta**')
    expect(body).toContain('**3. task gamma**')
    expect(body).not.toContain('**1. ')
  })

  it('a single running worker is never numbered (single-worker layout)', async () => {
    const h = ghostHarness({ now: () => 1000 })
    await h.feed.update('solo', 'chat', view('task solo', 'working', 0))
    await drain()
    const body = lastBody(h)
    expect(body).toContain('task solo')
    expect(body).not.toContain('1. task solo')
  })

  it('a fresh card after ALL workers finish numbers from 1 again', async () => {
    let clock = 1000
    const h = ghostHarness({ now: () => clock })
    await h.feed.update('a', 'chat', view('task alpha', 'a-doing', 0))
    await h.feed.update('b', 'chat', view('task beta', 'b-doing', 0))
    await drain()
    clock = 2000
    await h.feed.finish('a', doneView('task alpha', 1000))
    await h.feed.finish('b', doneView('task beta', 1000))
    await drain()
    expect(h.feed.size).toBe(0)

    // New fan-out in the same chat → a NEW card that starts at 1., not 3.
    clock = 3000
    await h.feed.update('c', 'chat', view('task gamma', 'c-doing', 0))
    await h.feed.update('d', 'chat', view('task delta', 'd-doing', 0))
    await drain()
    const body = lastBody(h)
    expect(body).toContain('**1. task gamma**')
    expect(body).toContain('**2. task delta**')
  })

  it('introducing ordinals causes no dedup churn (same substance → edit still skipped)', async () => {
    const h = ghostHarness({ now: () => 1000 })
    await h.feed.update('a', 'chat', view('task alpha', 'same step', 0))
    await h.feed.update('b', 'chat', view('task beta', 'same step', 0))
    await drain()
    const landed = h.edits.length
    // Byte-identical substance re-update: the dedup/no-op skip must still fire
    // (a stable ordinal never varies the substance between identical renders).
    await h.feed.update('a', 'chat', view('task alpha', 'same step', 0))
    await drain()
    expect(h.edits.length).toBe(landed)
  })
})

// ── Per-worker step indent on the combined card ───────────────────────────────
//
// The multi-worker card put its `✓`/`→` step lines at the SAME left margin as
// the numbered worker header lines, so where one worker ended and the next
// began was invisible at a glance (operator report, 2026-07). Steps now nest
// one level under their worker.
//
// The indent MUST be a U+00A0 run, not ASCII spaces: card bodies go to Telegram
// as raw GFM markdown (`richMessage` → `sendRichMessage` /
// `editMessageText({ markdown })`, #2669) and are parsed server-side by a
// CommonMark/GFM-family parser that DROPS leading ASCII whitespace (see
// `reference/telegram-formatting-guide.md`, and #2692/#3229 where a U+00A0-only
// line survives as a real paragraph while an ASCII-blank one is discarded). So
// these tests assert the indent bytes, not merely "the line is indented" —
// an ASCII-space indent would look right in a string and render flat on a phone.
describe('combined worker card — steps indent under their worker (U+00A0)', () => {
  const NBSP = '\u00A0'
  const rowsFor = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      description: `worker task ${i + 1}`,
      elapsedMs: 60_000 * (i + 1),
      toolCount: 3,
      ordinal: i + 1,
      currentStep: `w${i + 1} step b`,
      historyLines: [`w${i + 1} step a`, `w${i + 1} step b`],
    }))

  /** Card lines as sent (the body is hard-break joined by stackCardLines). */
  const linesOf = (body: string) => body.split('\n').map((l) => l.replace(/[ \t]+$/, ''))

  it('every step line starts with the U+00A0 indent; header and chrome lines do not', () => {
    const body = renderCombinedWorkerFeed(rowsFor(3), { maxRows: 8 })!
    const lines = linesOf(body)
    const stepLines = lines.filter((l) => l.includes('✓ w') || l.includes('→ w'))
    const headerLines = lines.filter((l) => /\*\*\d\. worker task/.test(l))

    expect(stepLines.length).toBe(6) // 3 workers × 2 steps
    expect(headerLines.length).toBe(3)
    // Load-bearing: the exact indent bytes. `WORKER_STEP_INDENT` is U+00A0 ×3;
    // a plain-ASCII `'   '` indent fails this assertion, as does today's
    // pre-fix flat output (which had no prefix at all).
    for (const l of stepLines) {
      expect(l.startsWith(WORKER_STEP_INDENT)).toBe(true)
      expect(l.startsWith(NBSP)).toBe(true)
      expect(l.startsWith(' ')).toBe(false)
    }
    // Workers stay at the left margin so the nesting reads as nesting.
    for (const l of headerLines) expect(l.startsWith(NBSP)).toBe(false)
    expect(lines[0].startsWith('🛠')).toBe(true)
  })

  it('WORKER_STEP_INDENT contains no ASCII space or tab (Telegram would drop it)', () => {
    expect(WORKER_STEP_INDENT.length).toBeGreaterThan(0)
    expect(/^[\u00A0]+$/.test(WORKER_STEP_INDENT)).toBe(true)
  })

  it('the `starting…` placeholder line is indented too', () => {
    const body = renderCombinedWorkerFeed(
      [
        { description: 'fresh worker', elapsedMs: 1000, toolCount: 0, ordinal: 1, currentStep: '' },
        ...rowsFor(1),
      ],
      { maxRows: 8 },
    )!
    const starting = linesOf(body).find((l) => l.includes('starting…'))!
    expect(starting).toBeDefined()
    expect(starting.startsWith(WORKER_STEP_INDENT)).toBe(true)
    expect(starting.startsWith(NBSP)).toBe(true)
  })

  it('the indent survives the real outbound guard chain byte-for-byte and stays parseable', () => {
    const body = renderCombinedWorkerFeed(rowsFor(3), { maxRows: 8 })!
    // `richMessage` is the ONE adapter every `{ markdown }` wire send funnels
    // through (rich-send.ts) — it must not escape, strip, or rewrite the indent.
    const wire = richMessage(body).markdown
    expect(wire).toBe(body)
    expect(wire.includes(`${WORKER_STEP_INDENT}**→ w1 step b**`)).toBe(true)
    expect(wire.includes(`${NBSP}**→ w1 step b**`)).toBe(true)
    // Independent CommonMark/GFM oracle: still well-formed on the rich path.
    expect(validateRichMarkdown(wire)).toEqual([])
    // …and the indent stays OUTSIDE the entities — it must not leak into the
    // bold/strike spans (which would render the NBSPs inside the styled text).
    const ents = parseRichEntities(wire)
    expect(ents.some((e) => e.type === 'bold' && e.text === '→ w1 step b')).toBe(true)
    expect(ents.some((e) => e.type === 'strikethrough' && e.text === '_✓ w1 step a_')).toBe(true)
    expect(ents.every((e) => !e.text.includes(NBSP))).toBe(true)
  })

  it('the SINGLE-worker 🛠 card is untouched (no indent on its step lines)', () => {
    const single = renderWorkerActivity({
      workerId: 'w1',
      description: 'lone worker',
      latestSummary: 'step b',
      narrativeLines: ['step a', 'step b'],
      elapsedMs: 60_000,
      toolCount: 3,
      state: 'running',
    })
    expect(single).toContain('~~_✓ step a_~~')
    expect(single).toContain('**→ step b**')
    expect(single.includes(NBSP)).toBe(false)
  })
})
