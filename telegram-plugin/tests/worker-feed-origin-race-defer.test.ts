/**
 * Worker-feed origin-race defer (DM-misrouted worker card).
 *
 * Root cause: the gateway picks a worker card's destination on the FIRST
 * progress tick of a new sub-agent. That tick can beat the async
 * `jsonl_agent_id` backfill that links the sub-agent's registry row to its
 * origin turn (retried ~every 3s). Until linked, origin resolution returns
 * null and `resolveWorkerFeedChat` hard-falls back to the owner DM — CREATING
 * the card there. The origin (supergroup + forum topic) resolves ~3s later,
 * but the DM card already exists and stays the visible one.
 *
 * Fix (approach #1 — defer): when the agent is not yet linked AND no card
 * exists yet, SKIP card creation for that tick. The watcher re-fires within
 * seconds; once the backfill links the row the card is created in the correct
 * chat+topic.
 *
 * These tests assert the OUTCOME (no card ever posted to the owner DM), not
 * just the decision code path — the integration case drives the REAL
 * `createWorkerActivityFeed` with a mock Bot API that records every send.
 */
import { describe, it, expect } from 'vitest'
import { decideWorkerFeedOriginDefer } from '../gateway/worker-feed-dispatch.js'
import {
  createWorkerActivityFeed,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'

const MAX = 10

describe('decideWorkerFeedOriginDefer (origin-race defer decision)', () => {
  it('DEFERS the first tick of a not-yet-linked worker with no card', () => {
    const out = decideWorkerFeedOriginDefer({
      originResolved: false,
      cardExists: false,
      priorDeferrals: 0,
      maxDeferrals: MAX,
    })
    expect(out.defer).toBe(true)
    expect(out.deferrals).toBe(1)
  })

  it('does NOT defer once the origin has resolved (row linked)', () => {
    const out = decideWorkerFeedOriginDefer({
      originResolved: true,
      cardExists: false,
      priorDeferrals: 3,
      maxDeferrals: MAX,
    })
    expect(out.defer).toBe(false)
  })

  it('does NOT defer when a card already exists (updates proceed)', () => {
    const out = decideWorkerFeedOriginDefer({
      originResolved: false,
      cardExists: true,
      priorDeferrals: 0,
      maxDeferrals: MAX,
    })
    expect(out.defer).toBe(false)
  })

  it('stops deferring once the bounded cap is reached (pathological backfill)', () => {
    // priorDeferrals = MAX-1 → this tick is the MAX-th; paint anyway.
    const out = decideWorkerFeedOriginDefer({
      originResolved: false,
      cardExists: false,
      priorDeferrals: MAX - 1,
      maxDeferrals: MAX,
    })
    expect(out.defer).toBe(false)
    expect(out.deferrals).toBe(MAX)
  })
})

// ─── Integration: no card is ever created in the owner DM on the racing tick ──

const OWNER_DM = '111111'
const ORIGIN_CHAT = '-1002000000000' // supergroup
const ORIGIN_THREAD = 42 // forum topic

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
 * Faithful model of the gateway `onProgress` worker-feed block (gateway.ts):
 * run the real defer decision, and — only when NOT deferring — call the real
 * feed with the resolved chat. `resolveOrigin` mimics `resolveSubagentOriginChat`
 * (null until the backfill links the row); the owner-DM fallback mirrors
 * `resolveWorkerFeedChat` (origin → owner DM when unresolved).
 */
function workerFeedTick(
  feed: ReturnType<typeof createWorkerActivityFeed>,
  deferrals: Map<string, number>,
  agentId: string,
  resolveOrigin: () => { chatId: string; threadId?: number } | null,
  view: WorkerActivityView,
): void {
  const origin = resolveOrigin()
  const originResolved = origin != null
  const cardExists = feed.has(agentId)
  const { defer, deferrals: next } = decideWorkerFeedOriginDefer({
    originResolved,
    cardExists,
    priorDeferrals: deferrals.get(agentId) ?? 0,
    maxDeferrals: MAX,
  })
  if (defer) {
    deferrals.set(agentId, next)
    return
  }
  deferrals.delete(agentId)
  // resolveWorkerFeedChat: origin chat when resolved, else owner DM.
  const chat = originResolved ? origin! : { chatId: OWNER_DM, threadId: undefined }
  void feed.update(agentId, chat.chatId, view, chat.threadId)
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
    // here to the owner DM (the only resort when origin never resolves).
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent.every((s) => s.chatId === OWNER_DM)).toBe(true)
  })
})
