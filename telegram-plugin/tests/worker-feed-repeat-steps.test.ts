import { describe, it, expect } from 'vitest'
import {
  createWorkerActivityFeed,
  stripRepeatSuffix,
  repeatCountOf,
  type WorkerActivityView,
  type BotApiForWorkerFeed,
} from '../worker-activity-feed.js'

/**
 * A worker whose steps all carry the SAME label must still visibly advance.
 *
 * The bug (observed live 2026-07-25, klanker): `description` is optional on
 * Bash, so a sub-agent that never wrote one produced the constant label
 * "Running a command" for every call. `accumulateNarrative` dropped every
 * repeat as a duplicate, and the card held ONE line at a constant byte length
 * for the whole job — editMessageText kept succeeding, so the surface looked
 * healthy while conveying nothing. A wedged worker and a busy worker rendered
 * identically.
 *
 * The fix counts repeats (`·×N`) instead of discarding them, gated on
 * `view.toolCount` so that a re-emitted UNCHANGED view (the watcher does this
 * every tick) never inflates the count.
 */

function view(partial: Partial<WorkerActivityView> = {}): WorkerActivityView {
  return {
    description: 'fix the thing',
    lastTool: { name: 'Bash', sanitisedArg: 'x' },
    toolCount: 1,
    latestSummary: 'Running a command',
    elapsedMs: 10_000,
    state: 'running',
    ...partial,
  }
}

interface FakeBot extends BotApiForWorkerFeed {
  sent: Array<{ text: string }>
  edits: Array<{ text: string }>
}

function makeFakeBot(): FakeBot {
  let nextId = 1000
  const fb: FakeBot = {
    sent: [],
    edits: [],
    sendMessage: async (_chatId, text) => {
      fb.sent.push({ text })
      return { message_id: nextId++ }
    },
    editMessageText: async (_chatId, _messageId, text) => {
      fb.edits.push({ text })
      return {}
    },
  }
  return fb
}

/** Latest rendered body for the group (last edit, else the first paint). */
function latestBody(bot: FakeBot): string {
  return bot.edits.length > 0 ? bot.edits[bot.edits.length - 1].text : bot.sent[0].text
}

describe('worker feed — repeated step labels', () => {
  it('renders a climbing ·×N counter instead of freezing on one line', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    for (let i = 1; i <= 5; i++) {
      clock += 10_000
      await feed.update('w1', 'chat', view({ toolCount: i, elapsedMs: clock }))
    }

    const body = latestBody(bot)
    expect(body).toContain('Running a command ·×5')
    // …and the frozen single-count line is gone from the newest render.
    expect(body).not.toMatch(/Running a command\*{0,2}\s*$/m)
  })

  it('does NOT inflate the count when the watcher re-emits an unchanged view', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    // Same toolCount across many ticks = the SAME tool call, re-observed.
    for (let i = 0; i < 6; i++) {
      clock += 5_000
      await feed.update('w1', 'chat', view({ toolCount: 2, elapsedMs: clock }))
    }

    const body = latestBody(bot)
    expect(body).toContain('Running a command')
    expect(body).not.toContain('·×')
  })

  it('starts a NEW step (no counter) when the label actually changes', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    clock += 10_000
    await feed.update('w1', 'chat', view({ toolCount: 1, elapsedMs: clock }))
    clock += 10_000
    await feed.update('w1', 'chat', view({ toolCount: 2, elapsedMs: clock }))
    clock += 10_000
    await feed.update('w1', 'chat', view({ toolCount: 3, latestSummary: 'Running git status', elapsedMs: clock }))

    const body = latestBody(bot)
    expect(body).toContain('Running a command ·×2')
    expect(body).toContain('Running git status')
    expect(body).not.toContain('Running git status ·×')
  })

  it('keeps the non-adjacent A,B,A dedup (no duplicate step lines)', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    const steps = ['Reading alpha.ts', 'Running grep', 'Reading alpha.ts']
    for (const [i, summary] of steps.entries()) {
      clock += 10_000
      await feed.update('w1', 'chat', view({ toolCount: i + 1, latestSummary: summary, elapsedMs: clock }))
    }

    const body = latestBody(bot)
    expect((body.match(/Reading alpha\.ts/g) ?? []).length).toBe(1)
    // Non-adjacent repeats are dropped, not counted — the A,B,A duplication
    // guard predates this change and stays intact.
    expect(body).not.toContain('Reading alpha.ts ·×')
  })
})

describe('repeat-suffix helpers', () => {
  it('round-trips the marker', () => {
    expect(stripRepeatSuffix('Running a command ·×12')).toBe('Running a command')
    expect(stripRepeatSuffix('Running a command')).toBe('Running a command')
    expect(repeatCountOf('Running a command')).toBe(1)
    expect(repeatCountOf('Running a command ·×12')).toBe(12)
  })

  it('does not mistake ordinary text for a marker', () => {
    expect(stripRepeatSuffix('Comparing 3 ×2 grids')).toBe('Comparing 3 ×2 grids')
    expect(repeatCountOf('Comparing 3 ×2 grids')).toBe(1)
  })
})
