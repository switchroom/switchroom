/**
 * Worker-feed origin-race defer (DM-misrouted worker card).
 *
 * Root cause: the gateway picks a worker card's destination on the FIRST
 * progress tick of a new sub-agent. That tick can beat the async
 * `jsonl_agent_id` backfill that links the sub-agent's registry row to its
 * origin turn (retried ~every 3s). Until linked, origin resolution returns
 * null and the destination hard-falls back to the owner DM — CREATING the card
 * there. The origin (supergroup + forum topic) resolves ~3s later, but the DM
 * card already exists and stays the visible one.
 *
 * Fix (approach #1 — defer): when the agent is not yet linked AND no card
 * exists yet, SKIP card creation for that tick. The watcher re-fires within
 * seconds; once the backfill links the row the card is created in the correct
 * chat+topic.
 *
 * These tests exercise the REAL exported decision function
 * `decideWorkerFeedDestination` (worker-feed-dispatch.ts) — the SAME code the
 * gateway's `onProgress` block calls (issue #3460) — plus, in the integration
 * case, the REAL `createWorkerActivityFeed` with a mock Bot API that records
 * every send. A regression in the gateway's defer/route decision now fails a
 * test, because the test binds to the shared function the gateway runs, not to
 * a hand-rolled replica.
 */
import { describe, it, expect } from 'vitest'
import { decideWorkerFeedDestination } from '../gateway/worker-feed-dispatch.js'
import {
  createWorkerActivityFeed,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'

const MAX = 10
const OWNER_DM = '111111'
const ORIGIN_CHAT = '-1002000000000' // supergroup
const ORIGIN_THREAD = 42 // forum topic

// The gateway resolves the owner DM from access config; the extracted pure
// function takes it as an explicit input. All calls in this suite pass the
// same owner DM so a fall-through to it is observable.
function decide(overrides: Partial<Parameters<typeof decideWorkerFeedDestination>[0]>) {
  return decideWorkerFeedDestination({
    origin: null,
    cardExists: false,
    priorDeferrals: 0,
    maxDeferrals: MAX,
    fleetChatId: '',
    stampChatId: undefined,
    stampThreadId: undefined,
    ownerDm: OWNER_DM,
    ...overrides,
  })
}

describe('decideWorkerFeedDestination (origin-race defer + routing decision)', () => {
  it('(a) unlinked + no card → DEFER (no paint)', () => {
    const out = decide({ origin: null, cardExists: false, priorDeferrals: 0 })
    expect(out.action).toBe('defer')
    if (out.action === 'defer') expect(out.deferrals).toBe(1)
  })

  it('(b) linked → PAINT to the origin chat + forum thread', () => {
    const out = decide({
      origin: { chatId: ORIGIN_CHAT, threadId: ORIGIN_THREAD },
      cardExists: false,
      priorDeferrals: 3,
    })
    expect(out.action).toBe('paint')
    if (out.action === 'paint') {
      expect(out.chatId).toBe(ORIGIN_CHAT)
      expect(out.threadId).toBe(ORIGIN_THREAD)
      expect(out.deferrals).toBe(0)
      expect(out.exhausted).toBe(false)
      expect(out.ownerDmFallback).toBe(false)
    }
  })

  it('(c) exhausted defer (never-backfill, forum) → PAINT to the stamp chat + stamp FORUM THREAD, not owner DM', () => {
    // priorDeferrals = MAX-1 → this tick is the MAX-th: paint anyway. No fleet
    // chat is configured, so the destination is the live turn's chat AND its
    // forum topic (stamp-turn fallback, #3458) — NOT General, NOT the owner DM.
    const out = decide({
      origin: null,
      cardExists: false,
      priorDeferrals: MAX - 1,
      fleetChatId: '',
      stampChatId: ORIGIN_CHAT,
      stampThreadId: ORIGIN_THREAD,
    })
    expect(out.action).toBe('paint')
    if (out.action === 'paint') {
      expect(out.chatId).toBe(ORIGIN_CHAT)
      expect(out.threadId).toBe(ORIGIN_THREAD) // forum topic carried, not General
      expect(out.chatId).not.toBe(OWNER_DM)
      expect(out.exhausted).toBe(true)
      expect(out.deferrals).toBe(MAX)
    }
  })

  it('exhausted defer with NO stamp chat → owner DM (durable floor), flagged as fallback', () => {
    const out = decide({
      origin: null,
      cardExists: false,
      priorDeferrals: MAX - 1,
      fleetChatId: '',
      stampChatId: undefined,
    })
    expect(out.action).toBe('paint')
    if (out.action === 'paint') {
      expect(out.chatId).toBe(OWNER_DM)
      expect(out.ownerDmFallback).toBe(true)
      expect(out.exhausted).toBe(true)
    }
  })

  it('(d) existing card always PAINTS (updates proceed) even while unlinked', () => {
    const out = decide({
      origin: null,
      cardExists: true,
      priorDeferrals: 0,
      fleetChatId: ORIGIN_CHAT,
    })
    expect(out.action).toBe('paint')
    if (out.action === 'paint') {
      expect(out.chatId).toBe(ORIGIN_CHAT)
      expect(out.deferrals).toBe(0)
    }
  })

  it('fleet chat wins over the stamp fallback when configured', () => {
    const out = decide({
      origin: null,
      cardExists: true, // paint (not defer) so we observe the route
      fleetChatId: ORIGIN_CHAT,
      stampChatId: '999999',
      stampThreadId: 7,
    })
    expect(out.action).toBe('paint')
    if (out.action === 'paint') {
      expect(out.chatId).toBe(ORIGIN_CHAT)
      // Fleet-chat route carries no stamp thread (usingStampFallback is false).
      expect(out.threadId).toBeUndefined()
    }
  })
})

// ─── Integration: the real feed, driven by the real decision ──────────────────

interface SentRecord {
  chatId: string
  threadId: number | undefined
}

function makeRecordingBot(sent: SentRecord[]): BotApiForWorkerFeed {
  let nextId = 1000
  return {
    async sendMessage(chatId, _text, opts) {
      sent.push({
        chatId,
        threadId: (opts?.message_thread_id as number | undefined) ?? undefined,
      })
      return { message_id: nextId++ }
    },
    async editMessageText() {
      return {}
    },
  }
}

/**
 * Faithful model of the gateway `onProgress` worker-feed block: run the REAL
 * `decideWorkerFeedDestination` and — only when it says paint — call the real
 * feed with the resolved chat/thread. `resolveOrigin` mimics
 * `resolveSubagentOriginChat` (null until the backfill links the row).
 */
function workerFeedTick(
  feed: ReturnType<typeof createWorkerActivityFeed>,
  deferrals: Map<string, number>,
  agentId: string,
  resolveOrigin: () => { chatId: string; threadId?: number } | null,
  view: WorkerActivityView,
  // The stamp-turn fallback used when no fleet chat is configured. Mirrors the
  // gateway's exhausted-defer paint source (stampTurn.sessionChatId / thread).
  stamp: { chatId?: string; threadId?: number } = { chatId: OWNER_DM, threadId: undefined },
): void {
  const dest = decideWorkerFeedDestination({
    origin: resolveOrigin(),
    cardExists: feed.has(agentId),
    priorDeferrals: deferrals.get(agentId) ?? 0,
    maxDeferrals: MAX,
    fleetChatId: '',
    stampChatId: stamp.chatId,
    stampThreadId: stamp.threadId,
    ownerDm: OWNER_DM,
  })
  if (dest.action === 'defer') {
    deferrals.set(agentId, dest.deferrals)
    return
  }
  deferrals.delete(agentId)
  void feed.update(agentId, dest.chatId, view, dest.threadId)
}

describe('worker-feed origin race — outcome: no owner-DM card', () => {
  const runningView = (elapsedMs: number): WorkerActivityView => ({
    description: 'racing worker',
    lastTool: 'Read',
    toolCount: 1,
    latestSummary: 'reading files',
    elapsedMs,
    state: 'running',
    model: 'sonnet',
    totalTokens: 10,
  })

  it('defers the racing first tick, then paints the card in the ORIGIN topic — never the DM', async () => {
    let now = 0
    const sent: SentRecord[] = []
    const feed = createWorkerActivityFeed({
      bot: makeRecordingBot(sent),
      now: () => now,
      firstPaintMinMs: 0, // paint immediately once we do update
      minEditIntervalMs: 0,
    })
    const deferrals = new Map<string, number>()
    const agentId = 'a37ad7639ae61476c'

    // The backfill has NOT linked the row yet: origin resolves to null.
    let linked = false
    const resolveOrigin = () =>
      linked ? { chatId: ORIGIN_CHAT, threadId: ORIGIN_THREAD } : null

    // First progress tick — races the backfill (origin unresolved).
    workerFeedTick(feed, deferrals, agentId, resolveOrigin, runningView(1000))
    await Promise.resolve()

    // OUTCOME: nothing sent. In particular, no card in the owner DM.
    expect(sent).toHaveLength(0)
    expect(deferrals.get(agentId)).toBe(1)
    expect(feed.has(agentId)).toBe(false)

    // ~3s later the backfill completes and links the row → origin resolves.
    linked = true
    now = 4000
    workerFeedTick(feed, deferrals, agentId, resolveOrigin, runningView(4000))
    await Promise.resolve()
    await Promise.resolve()

    // OUTCOME: the card is created in the ORIGIN supergroup + forum topic,
    // and NEVER in the owner DM.
    expect(sent.length).toBeGreaterThanOrEqual(1)
    for (const s of sent) {
      expect(s.chatId).not.toBe(OWNER_DM)
    }
    expect(sent.some((s) => s.chatId === ORIGIN_CHAT && s.threadId === ORIGIN_THREAD)).toBe(true)
    // Defer state cleared once linked.
    expect(deferrals.has(agentId)).toBe(false)
  })

  it('bounded fallback: paints anyway if the backfill never links (no infinite defer)', async () => {
    let now = 0
    const sent: SentRecord[] = []
    const feed = createWorkerActivityFeed({
      bot: makeRecordingBot(sent),
      now: () => now,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
    })
    const deferrals = new Map<string, number>()
    const agentId = 'neverlinks00000'
    const resolveOrigin = () => null // backfill permanently broken

    for (let i = 0; i < MAX; i++) {
      now = i * 1000
      workerFeedTick(feed, deferrals, agentId, resolveOrigin, runningView(now))
      await Promise.resolve()
    }
    await Promise.resolve()

    // The first MAX-1 ticks deferred; the MAX-th painted. The universal-liveness
    // contract wins over infinite silence, so a card IS eventually created —
    // here to the owner DM (the only resort when origin never resolves and no
    // stamp chat is set).
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent.every((s) => s.chatId === OWNER_DM)).toBe(true)
  })

  it('exhausted-defer (never-backfill) fallback lands in the origin FORUM THREAD, not General (#3458)', async () => {
    // The backfill never links, so origin stays null through the bounded cap.
    // In a forum supergroup the gateway paints using the live turn's chat AND
    // its forum-topic id (stampTurn.sessionChatId / .sessionThreadId). Before
    // the fix the thread was dropped and the card landed in General (thread
    // undefined). Assert the thread id is carried to the painted card.
    let now = 0
    const sent: SentRecord[] = []
    const feed = createWorkerActivityFeed({
      bot: makeRecordingBot(sent),
      now: () => now,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
    })
    const deferrals = new Map<string, number>()
    const agentId = 'neverlinks-forum'
    const resolveOrigin = () => null // backfill permanently broken
    // Live turn's chat + forum topic — the exhausted-defer fallback source.
    const liveFallback = { chatId: ORIGIN_CHAT, threadId: ORIGIN_THREAD }

    for (let i = 0; i < MAX; i++) {
      now = i * 1000
      workerFeedTick(feed, deferrals, agentId, resolveOrigin, runningView(now), liveFallback)
      await Promise.resolve()
    }
    await Promise.resolve()

    // OUTCOME: a card painted, in the origin supergroup AND its forum topic —
    // the thread id survived the never-backfill fallback (not General).
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent.every((s) => s.chatId === ORIGIN_CHAT)).toBe(true)
    expect(sent.every((s) => s.threadId === ORIGIN_THREAD)).toBe(true)
  })
})
