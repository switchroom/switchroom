/**
 * Regression guard for the feed-registry churn bug (FIX 2): a worker row whose
 * `agentId` migrated feeds (a fresh `update()` under a different chat/thread)
 * used to leave the OLD group's `workers` map holding an orphan row that the
 * `agentIndex` no longer pointed at. `groupOfAgent(agentId)` could then never
 * resolve it, so the heartbeat TTL sweep's `terminateWorker(agentId)` no-op'd
 * and the row churned every tick forever — the self-contradictory
 * `worker-feed: TTL reap … no update in 0s (>= 3000s); force-terminating
 * leaked row` log, repeating ~every 6s.
 *
 * Two guarantees are asserted as OUTCOMES:
 *   1. Migration eviction (root cause): after the same agentId updates a
 *      different feed, the old group's row is gone immediately — total tracked
 *      rows never double-count the migrated worker.
 *   2. Sweep force-eviction is idempotent: once every worker has ended, the TTL
 *      sweep drives `size` to 0 and it STAYS 0 across repeated heartbeat ticks
 *      (no churning row that re-reaps forever).
 */
import { describe, it, expect } from 'vitest'
import {
  createWorkerActivityFeed,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'

function view(desc: string, elapsedMs: number): WorkerActivityView {
  return { description: desc, lastTool: null, toolCount: 1, latestSummary: 'step', elapsedMs, state: 'running' }
}

function makeFeed(nowRef: { t: number }) {
  const pins: { messageId: number | null }[] = []
  let seq = 900
  const bot: BotApiForWorkerFeed = {
    sendMessage: async () => ({ message_id: seq++ }),
    editMessageText: async () => true,
  }
  const feed = createWorkerActivityFeed({
    bot,
    now: () => nowRef.t,
    minEditIntervalMs: 0,
    heartbeatTickMs: 1000,
    firstPaintMinMs: 0,
    staleWorkerTtlMs: 3_000_000, // 3000s — matches the observed churn log
    setInterval: () => 0,
    clearInterval: () => {},
    reconcilePin: ({ messageId }) => pins.push({ messageId }),
  })
  return { feed, pins }
}

async function drain(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r))
}

describe('worker-feed migration eviction + churn-free sweep (FIX 2)', () => {
  it('evicts the old-feed orphan when an agentId migrates feeds — no double-count', async () => {
    const nowRef = { t: 1_000_000 }
    const { feed } = makeFeed(nowRef)

    // Worker registers in feed A (chat -100).
    await feed.update('agent-1', '-100', view('task', 0))
    await drain()
    expect(feed.size).toBe(1)

    // SAME agentId now updates a DIFFERENT feed (chat -200) — a migration. The
    // old feed-A row must be evicted, not orphaned. Total rows stay 1.
    nowRef.t += 1000
    await feed.update('agent-1', '-200', view('task', 1000))
    await drain()
    expect(feed.size).toBe(1)
  })

  it('TTL sweep drives size to 0 and stays 0 across repeated ticks (no churn)', async () => {
    const nowRef = { t: 2_000_000 }
    const { feed } = makeFeed(nowRef)

    await feed.update('agent-1', '-100', view('task', 0))
    await drain()
    // Migrate to a second feed to exercise the exact desync path that leaked.
    nowRef.t += 1000
    await feed.update('agent-1', '-200', view('task', 1000))
    await drain()
    expect(feed.size).toBe(1)

    // Advance past the silence TTL so the sweep force-terminates the last row.
    nowRef.t += 3_000_001
    feed.heartbeatTick()
    await drain()
    expect(feed.size).toBe(0)

    // Idempotency: further ticks must not resurrect / re-reap a churning row.
    for (let i = 0; i < 3; i++) {
      nowRef.t += 3_000_001
      feed.heartbeatTick()
      await drain()
    }
    expect(feed.size).toBe(0)
  })
})
