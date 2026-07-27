/**
 * END-TO-END card lifecycle — drives the REAL feed manager
 * (`createWorkerActivityFeed`) with realistic worker cues and asserts the
 * EXACT text that reaches Telegram at every stage of a worker's life:
 *
 *   dispatch → running → a second worker joins (coalesce) → spill/overflow
 *   → one finishes (survivors keep ordinals) → failure recap → supersede.
 *
 * This is deliberately NOT `renderStatusCard(opts)` in isolation. The seam is
 * the highest one drivable in-process: feed state in, `sendMessage` /
 * `editMessageText` bodies out — the same bytes the user reads on their phone.
 * The golden suite (`card-golden.test.ts`) pins each variant's shape; this
 * suite proves the lifecycle actually PRODUCES those variants, in order.
 *
 * Every assertion here is one that fails if the shared card layout core
 * (`card-layout.ts`) changes header composition, step-block drawing, the
 * rolling window, the placeholder, the spill line or the budget backstop.
 */
import { describe, expect, it } from 'vitest'

import {
  createWorkerActivityFeed,
  WORKER_CARD_SUPERSEDED_BODY,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'
import { WORKER_STEP_INDENT } from '../status-no-truncate.js'

const CHAT = '4242'

interface Painted {
  kind: 'send' | 'edit'
  messageId: number
  text: string
}

function harness(opts: { maxRows?: number; groupMessageLifetimeCapMs?: number } = {}) {
  let now = 1_000_000
  const painted: Painted[] = []
  let nextId = 500
  const bot: BotApiForWorkerFeed = {
    async sendMessage(_chatId, text) {
      const message_id = ++nextId
      painted.push({ kind: 'send', messageId: message_id, text })
      return { message_id }
    },
    async editMessageText(_chatId, messageId, text) {
      painted.push({ kind: 'edit', messageId, text })
      return {}
    },
  }
  const feed = createWorkerActivityFeed({
    bot,
    now: () => now,
    // Zero the rate limiters so every cue paints — this suite is about the
    // RENDERED BYTES, not the edit budget (that is worker-feed-coalesce's job).
    minEditIntervalMs: 0,
    elapsedRefreshMs: 0,
    firstPaintMinMs: 0,
    maxRows: opts.maxRows ?? 6,
    groupMessageLifetimeCapMs: opts.groupMessageLifetimeCapMs,
    // No real timers in the test process.
    setInterval: () => null,
    clearInterval: () => {},
  })
  return {
    feed,
    painted,
    advance: (ms: number) => {
      now += ms
    },
    nowMs: () => now,
    /** The most recent body sent or edited — what the user is looking at. */
    last: (): string => painted[painted.length - 1]?.text ?? '',
    reset: () => {
      painted.length = 0
    },
  }
}

const view = (over: Partial<WorkerActivityView> = {}): WorkerActivityView => ({
  description: 'Audit every card render path',
  state: 'running',
  elapsedMs: 12_000,
  toolCount: 3,
  lastTool: null,
  latestSummary: '',
  narrativeLines: [],
  model: 'claude-opus-4-8',
  totalTokens: 10_000,
  ...over,
})

/** Await the feed's internal promise chain. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}

describe('worker card lifecycle — the bytes the user actually sees', () => {
  it('dispatch: the first paint is a real card with a starting… placeholder, not a bare header', async () => {
    const h = harness()
    await h.feed.update('w1', CHAT, view({ elapsedMs: 1_200, toolCount: 0, narrativeLines: [] }))
    await settle()

    expect(h.painted.length).toBeGreaterThan(0)
    expect(h.painted[0].kind).toBe('send')
    const card = h.painted[0].text
    // Title line, metrics line, placeholder — three lines, all from the layout core.
    expect(card).toContain('🛠 **WORKER**')
    expect(card).toContain('Audit every card render path')
    expect(card).toMatch(/_1s · 0 tools · 10\.0k tok · opus 4\.8_/)
    expect(card).toContain('_starting…_')
    // #3846: the placeholder is a SECTION of the card, so it carries the same
    // collapse-safe line joining as every other line — a hand-appended tail did not.
    const lines = card.split('\n')
    expect(lines.length).toBe(3)
    for (const l of lines.slice(0, -1)) expect(l.endsWith('  ')).toBe(true)
    expect(card).not.toContain('starting…\n_starting…_')
  })

  it('running: narrative steps become a ✓/→ trail under one shared header', async () => {
    const h = harness()
    await h.feed.update('w1', CHAT, view({ latestSummary: 'Fetching origin' }))
    await settle()
    h.reset()
    // The watcher emits ONE latest step per tick; the feed accumulates them.
    await h.feed.update('w1', CHAT, view({ toolCount: 10, latestSummary: 'Reading the renderer' }))
    await settle()
    await h.feed.update(
      'w1',
      CHAT,
      view({ elapsedMs: 143_000, toolCount: 31, totalTokens: 88_400, latestSummary: 'Mapping callers' }),
    )
    await settle()

    const card = h.last()
    expect(card).toContain('~~_✓ Fetching origin_~~')
    expect(card).toContain('~~_✓ Reading the renderer_~~')
    expect(card).toContain('**→ Mapping callers**')
    expect(card).not.toContain('_starting…_')
    // The metrics line is composed once, by metricsRun — running order is
    // `{elapsed} · {tools} · {tok} · {model}`.
    expect(card).toContain('_2m23s · 31 tools · 88.4k tok · opus 4.8_')
    // Single-worker card carries NO indent (#3843 de-indent).
    expect(card).not.toContain(WORKER_STEP_INDENT)
  })

  it('depth budget: a row deeper than its per-worker budget shows only its newest steps', async () => {
    // The feed retains WORKER_HISTORY_MAX (6) steps; with 2 workers the shared
    // layout gives each row a depth of 5, so the oldest step must drop out.
    const h = harness()
    for (let i = 1; i <= 6; i++) {
      await h.feed.update('w1', CHAT, view({ toolCount: i, latestSummary: `s${i}` }))
      await settle()
    }
    await h.feed.update('w2', CHAT, view({ description: 'Second worker', latestSummary: 'b1' }))
    await settle()

    const card = h.last()
    expect(card).not.toContain('s1_')
    expect(card).toContain(`${WORKER_STEP_INDENT}~~_✓ s2_~~`)
    expect(card).toContain(`${WORKER_STEP_INDENT}**→ s6**`)
    // Exactly depth-1 done steps plus the one live step.
    expect(card.split('\n').filter((l) => /~~_✓ s\d_~~/.test(l)).length).toBe(4)
    expect(card.split('\n').filter((l) => l.includes('**→ ')).length).toBe(2)
  })

  it('two workers coalesce into ONE message whose rows share the header composer', async () => {
    const h = harness()
    await h.feed.update('w1', CHAT, view({ latestSummary: 'audit 1' }))
    await settle()
    const firstId = h.painted[0].messageId
    h.reset()
    await h.feed.update(
      'w2',
      CHAT,
      view({
        description: 'Fix the hindsight recall floor',
        elapsedMs: 60_000,
        toolCount: 7,
        totalTokens: 20_000,
        latestSummary: 'recall 1',
      }),
    )
    await settle()

    // One message, edited — not a second send.
    expect(h.painted.every((p) => p.messageId === firstId)).toBe(true)
    expect(h.painted.some((p) => p.kind === 'send')).toBe(false)

    const card = h.last()
    expect(card).toContain('🛠 **WORKERS**')
    expect(card).toContain('2 running')
    expect(card).toContain('**1. Audit every card render path**')
    expect(card).toContain('**2. Fix the hindsight recall floor**')
    // Row headers use the SAME metricsRun as the single-worker card.
    expect(card).toContain('_· 1m00s · 7 tools · 20.0k tok · opus 4.8_')
    // Rows are indented with the braille blank so Telegram cannot left-trim.
    expect(card).toContain(`${WORKER_STEP_INDENT}**→ recall 1**`)
  })

  it('a worker with no history yet renders the shared placeholder inside its row', async () => {
    const h = harness()
    await h.feed.update('w1', CHAT, view({ latestSummary: 'audit 1' }))
    await settle()
    h.reset()
    await h.feed.update('w2', CHAT, view({ description: 'Freshly dispatched', latestSummary: '' }))
    await settle()

    const card = h.last()
    expect(card).toContain('**2. Freshly dispatched**')
    expect(card).toContain(`${WORKER_STEP_INDENT}→ _starting…_`)
  })

  it('spill: beyond maxRows the newest rows collapse into one +M more working… line', async () => {
    const h = harness({ maxRows: 6 })
    for (let i = 1; i <= 8; i++) {
      await h.feed.update(`w${i}`, CHAT, view({ description: `Background task ${i}`, latestSummary: `t${i} a` }))
      await settle()
    }
    const card = h.last()
    expect(card).toContain('8 running')
    expect(card).toContain('**6. Background task 6**')
    expect(card).not.toContain('**7. Background task 7**')
    expect(card).toContain('_+2 more working…_')
    // The spill line is the LAST line of the card (a footer, not a stray row).
    const lines = card.split('\n')
    expect(lines[lines.length - 1]).toContain('+2 more working…')
  })

  it('spill honours the body-line budget: many deep rows still shrink to fit', async () => {
    const h = harness({ maxRows: 6 })
    for (let i = 1; i <= 6; i++) {
      await h.feed.update(
        `w${i}`,
        CHAT,
        view({
          description: `Background task ${i}`,
          latestSummary: `t${i} step`,
        }),
      )
      await settle()
      for (const step of ['b', 'c', 'd', 'e', 'f']) {
        await h.feed.update(`w${i}`, CHAT, view({ description: `Background task ${i}`, latestSummary: `t${i} ${step}` }))
        await settle()
      }
    }
    const card = h.last()
    // MAX_COMBINED_BODY_LINES = 6 rows × (1 header + 3 steps) = 24.
    const body = card.split('\n').filter((l) => !l.includes('🛠 **WORKERS**') && !l.includes('more working…'))
    expect(body.length).toBeLessThanOrEqual(24)
    // Shrinking drops ROWS, never the glance chrome.
    expect(card).toContain('🛠 **WORKERS**')
    expect(card).toContain('6 running')
  })

  it('one worker finishing leaves the survivors numbered as they were dispatched', async () => {
    const h = harness()
    await h.feed.update('w1', CHAT, view({ latestSummary: 'audit 1' }))
    await settle()
    await h.feed.update('w2', CHAT, view({ description: 'Second worker', latestSummary: 'b1' }))
    await settle()
    await h.feed.update('w3', CHAT, view({ description: 'Third worker', latestSummary: 'c1' }))
    await settle()
    expect(h.last()).toContain('**1. Audit every card render path**')
    h.reset()

    await h.feed.finish('w1', view({ state: 'done', latestSummary: 'All done.' }))
    await settle()

    const card = h.last()
    expect(card).toContain('2 running')
    expect(card).toContain('**2. Second worker**')
    expect(card).toContain('**3. Third worker**')
    expect(card).not.toContain('**1. ')
  })

  it('completion: the last worker collapses to a struck feed plus the ✅ result recap', async () => {
    const h = harness()
    await h.feed.update('w1', CHAT, view({ latestSummary: 'Fetching origin' }))
    await settle()
    await h.feed.update('w1', CHAT, view({ toolCount: 20, latestSummary: 'Mapping callers' }))
    await settle()
    h.reset()
    await h.feed.finish(
      'w1',
      view({
        state: 'done',
        elapsedMs: 902_000,
        toolCount: 44,
        latestSummary: 'Inventoried every card variant and unified the renderer. PR #0000.',
      }),
    )
    await settle()

    const card = h.last()
    // Terminal metrics order flips: `{state} · {tools} · {tok} · {elapsed}`.
    expect(card).toContain('_done · 44 tools · 10.0k tok · 15m02s · opus 4.8_')
    // No live `→` marker survives on a finished card.
    expect(card).not.toContain('**→ ')
    expect(card).toContain('~~_✓ Mapping callers_~~')
    // The result block: shared rule, then the ✅ recap paragraph.
    expect(card).toContain('─────')
    expect(card).toContain('✅ _Inventoried')
    expect(card).toContain('Inventoried every card variant and unified the renderer.')
  })

  it('failure: the card reads failed and carries the error recap', async () => {
    const h = harness()
    await h.feed.update('w1', CHAT, view({ latestSummary: 'Running the scoped suite' }))
    await settle()
    h.reset()
    await h.feed.finish(
      'w1',
      view({
        state: 'failed',
        elapsedMs: 61_000,
        toolCount: 9,
        latestSummary: 'Scoped test run failed: 3 assertions.',
      }),
    )
    await settle()

    const card = h.last()
    expect(card).toContain('_failed · 9 tools · 10.0k tok · 1m01s · opus 4.8_')
    expect(card).toContain('⚠️ _Scoped test run failed: 3 assertions._')
    expect(card).not.toContain('**→ ')
  })

  it('supersede: the retired message is finalised to the shared-chrome notice, and a fresh card opens', async () => {
    const h = harness({ groupMessageLifetimeCapMs: 60_000 })
    await h.feed.update('w1', CHAT, view({ latestSummary: 'step one' }))
    await settle()
    const firstId = h.painted[0].messageId
    h.reset()

    // Push the group's shared message past its lifetime cap, then let the
    // heartbeat (the real rotation trigger) run.
    h.advance(120_000)
    await h.feed.update('w1', CHAT, view({ elapsedMs: 132_000, toolCount: 9, latestSummary: 'step two' }))
    await settle()
    h.feed.heartbeatTick()
    await settle()

    const superseded = h.painted.find((p) => p.text === WORKER_CARD_SUPERSEDED_BODY)
    expect(superseded, 'the retired message must be finalised to the superseded notice').toBeDefined()
    expect(superseded?.kind).toBe('edit')
    expect(superseded?.messageId).toBe(firstId)
    // Shared chrome: same title composer as every live card.
    expect(WORKER_CARD_SUPERSEDED_BODY.startsWith('🛠 **WORKER** · _continued_')).toBe(true)
    // The retired notice carries no live-styled rows — it must not read as a
    // stuck worker.
    expect(WORKER_CARD_SUPERSEDED_BODY).not.toContain('**→ ')

    // A fresh, live card was opened for the still-running worker.
    const fresh = h.painted.filter((p) => p.kind === 'send')
    expect(fresh.length).toBe(1)
    expect(fresh[0].messageId).not.toBe(firstId)
    expect(fresh[0].text).toContain('🛠 **WORKER**')
    expect(fresh[0].text).toContain('step two')
  })
})
