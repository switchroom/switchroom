/**
 * Residual B regression: a worker cleaned up by the TTL / authoritative
 * `terminate` sweep — i.e. reaped / vanished / crashed WITHOUT ever delivering
 * a clean `onFinish` result — must render a TRUTHFUL terminal state, NOT "done".
 *
 * `terminateWorker` synthesises the recap when NO clean finish arrived (a clean
 * `onFinish` removes the row first, making `terminate` a no-op; an errored
 * worker goes through `onFinish(outcome:'failed')`). So a row still present at
 * terminate time genuinely ended without a result → it must render as the
 * `incomplete` terminal ("incomplete · …"), never "done".
 *
 * OUTCOME assertions on the finalized card body (RED if `terminate` reverts to
 * `state:'done'`), applied to the generic worker row so the guarantee holds at
 * every nesting level (the feed keys rows by agentId, depth-agnostic):
 *   - a solo reaped worker's terminal card reads `incomplete`, never `done`;
 *   - a genuinely-`finish`ed worker still reads `done` with its result.
 */
import { describe, it, expect } from 'vitest'
import {
  createWorkerActivityFeed,
  renderWorkerActivity,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'

function makeFeed(now: () => number) {
  const sends: { text: string }[] = []
  const edits: { messageId: number; text: string }[] = []
  let seq = 900
  const bot: BotApiForWorkerFeed = {
    sendMessage: async (_c, text) => { sends.push({ text }); return { message_id: seq++ } },
    editMessageText: async (_c, messageId, text) => { edits.push({ messageId, text }); return true },
  }
  const feed = createWorkerActivityFeed({
    bot,
    now,
    minEditIntervalMs: 0,
    firstPaintMinMs: 0,
    setInterval: () => 0,
    clearInterval: () => {},
  })
  return { feed, sends, edits }
}
const runningView = (desc: string, step: string, elapsedMs: number): WorkerActivityView => ({
  description: desc, lastTool: null, toolCount: 3, latestSummary: step, elapsedMs, state: 'running',
})
async function drain(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r))
}

describe('worker terminal state is truthful for reaped workers (Residual B)', () => {
  it('a reaped/vanished worker (terminate, no clean finish) renders `incomplete`, never `done`', async () => {
    let clock = 1000
    const { feed, edits } = makeFeed(() => clock)
    clock = 1000
    await feed.update('w', 'chat', runningView('background job', 'doing work', 1000))
    await drain()
    clock = 5000
    // Authoritative sweep / TTL backstop: no onFinish ever arrived.
    await feed.terminate('w')
    await drain()

    const last = edits[edits.length - 1].text
    expect(last, 'reaped worker must NOT read as done').not.toMatch(/\bdone\b/)
    expect(last, 'reaped worker reads the truthful incomplete terminal').toContain('incomplete')
    expect(feed.size).toBe(0)
  })

  it('a genuinely finished worker still renders `done` with its result', async () => {
    let clock = 1000
    const { feed, edits } = makeFeed(() => clock)
    await feed.update('w', 'chat', runningView('background job', 'doing work', 1000))
    await drain()
    clock = 2000
    await feed.finish('w', {
      description: 'background job',
      lastTool: null,
      toolCount: 5,
      latestSummary: 'the delivered result paragraph',
      elapsedMs: 2000,
      state: 'done',
    })
    await drain()
    const last = edits[edits.length - 1].text
    expect(last).toContain('done')
    expect(last).toContain('the delivered result paragraph')
    expect(last).not.toContain('incomplete')
  })

  it('renderWorkerActivity renders the `incomplete` state as a finished card without a fabricated result', () => {
    const card = renderWorkerActivity({
      description: 'background job',
      lastTool: null,
      toolCount: 3,
      latestSummary: '', // reaped: no result text
      elapsedMs: 4000,
      state: 'incomplete',
    })
    expect(card).toContain('incomplete')
    expect(card).not.toMatch(/\bdone\b/)
    // No fabricated result paragraph (latestSummary empty) → no ✅ result block.
    expect(card).not.toContain('✅')
  })
})
