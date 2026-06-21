import { describe, it, expect, afterEach } from 'vitest'
import {
  renderWorkerActivity,
  createWorkerActivityFeed,
  isWorkerActivityFeedEnabled,
  NARRATIVE_MAX_LINES,
  type WorkerActivityView,
  type BotApiForWorkerFeed,
} from '../worker-activity-feed.js'
import { STATUS_ROLLING_LINES } from '../status-no-truncate.js'

describe('isWorkerActivityFeedEnabled (default ON)', () => {
  it('defaults to true when the env var is unset', () => {
    expect(isWorkerActivityFeedEnabled(undefined)).toBe(true)
  })
  it('stays on for any value other than "0"', () => {
    expect(isWorkerActivityFeedEnabled('1')).toBe(true)
    expect(isWorkerActivityFeedEnabled('')).toBe(true)
  })
  it('only "0" disables it', () => {
    expect(isWorkerActivityFeedEnabled('0')).toBe(false)
  })
})

function view(partial: Partial<WorkerActivityView> = {}): WorkerActivityView {
  return {
    description: 'research competitors',
    lastTool: { name: 'Bash', sanitisedArg: 'grep -r pricing' },
    toolCount: 3,
    latestSummary: 'scanning vendor pages',
    elapsedMs: 10_000,
    state: 'running',
    ...partial,
  }
}

interface FakeBot extends BotApiForWorkerFeed {
  sent: Array<{ chatId: string; text: string; opts?: Record<string, unknown> }>
  edits: Array<{ messageId: number; text: string }>
  failNextSendWith?: unknown
  failNextEditWith?: unknown
}

function makeFakeBot(): FakeBot {
  let nextId = 1000
  const fb: FakeBot = {
    sent: [],
    edits: [],
    sendMessage: async (chatId, text, opts) => {
      if (fb.failNextSendWith != null) {
        const e = fb.failNextSendWith
        fb.failNextSendWith = undefined
        throw e
      }
      fb.sent.push({ chatId, text, opts })
      return { message_id: nextId++ }
    },
    editMessageText: async (_chatId, messageId, text) => {
      if (fb.failNextEditWith != null) {
        const e = fb.failNextEditWith
        fb.failNextEditWith = undefined
        throw e
      }
      fb.edits.push({ messageId, text })
      return {}
    },
  }
  return fb
}

// ─── renderWorkerActivity (pure) ─────────────────────────────────────────────

describe('renderWorkerActivity', () => {
  /** Count of step-feed bullets (`✓` done + `→` in-progress) in a body. */
  const stepCount = (s: string) => (s.match(/[✓→]/g) ?? []).length

  it('renders the native header + running status + step feed', () => {
    const out = renderWorkerActivity(view())
    expect(out).toContain('🛠 <b>Worker</b> · <i>research competitors</i>')
    expect(out).toContain('running · ')
    expect(out).toContain('3 tools')
    // No narrativeLines → the latestSummary surfaces as the newest `→` step.
    expect(out).toContain('<b>→ scanning vendor pages</b>')
    // The old tool/arg chrome is gone.
    expect(out).not.toContain('⚡')
    expect(out).not.toContain('<code>')
  })

  it('shows a "starting…" line when no step has run yet', () => {
    const out = renderWorkerActivity(view({ lastTool: null, latestSummary: '' }))
    expect(out).toContain('🛠 <b>Worker</b>')
    expect(out).toContain('starting…')
    expect(out).not.toContain('→')
  })

  it('falls back to starting… when the summary is blank', () => {
    const out = renderWorkerActivity(view({ latestSummary: '   ' }))
    expect(out).toContain('starting…')
    expect(stepCount(out)).toBe(0)
  })

  it('uses singular "tool" for a single tool call', () => {
    const out = renderWorkerActivity(view({ toolCount: 1 }))
    expect(out).toContain('1 tool')
    expect(out).not.toContain('1 tools')
  })

  it('renders a done terminal recap with a rule + cleaned result', () => {
    const out = renderWorkerActivity(
      view({ state: 'done', toolCount: 5, latestSummary: 'PR #21 opened' }),
    )
    expect(out).toContain('🛠 <b>Worker</b> · <i>research competitors</i>')
    expect(out).toContain('finished · completed · 5 tools · ')
    expect(out).toContain('─────')
    expect(out).toContain('✅ <i>PR #21 opened</i>')
  })

  it('renders a failed terminal recap', () => {
    const out = renderWorkerActivity(view({ state: 'failed', latestSummary: 'blew up' }))
    expect(out).toContain('finished · failed · ')
    expect(out).toContain('⚠️ <i>blew up</i>')
  })

  it('omits the rule + result line when the terminal result is empty', () => {
    const out = renderWorkerActivity(view({ state: 'done', latestSummary: '   ' }))
    expect(out).toContain('finished · completed · ')
    expect(out).not.toContain('─────')
  })

  it('grows a step feed when narrativeLines is present (prior ✓, newest →)', () => {
    const out = renderWorkerActivity(
      view({
        latestSummary: 'newest only — should be ignored',
        narrativeLines: ['read the brief', 'scanned vendor A', 'scanned vendor B'],
      }),
    )
    expect(out).toContain('<i>✓ read the brief</i>')
    expect(out).toContain('<i>✓ scanned vendor A</i>')
    expect(out).toContain('<b>→ scanned vendor B</b>')
    // The single-line latestSummary fallback is NOT used when a block is present.
    expect(out).not.toContain('newest only')
    expect(stepCount(out)).toBe(3)
  })

  it('falls back to latestSummary when narrativeLines is empty', () => {
    const out = renderWorkerActivity(view({ narrativeLines: [], latestSummary: 'one line' }))
    expect(out).toContain('<b>→ one line</b>')
    expect(stepCount(out)).toBe(1)
  })

  it('drops blank narrative lines from the feed', () => {
    const out = renderWorkerActivity(view({ narrativeLines: ['kept', '   ', 'also kept'] }))
    expect(out).toContain('<i>✓ kept</i>')
    expect(out).toContain('<b>→ also kept</b>')
    expect(stepCount(out)).toBe(2)
  })

  it('shows an overflow header when the feed exceeds the cap (no-truncate OFF)', () => {
    // This test exercises the capping behaviour that is active when the flag is OFF.
    process.env.SWITCHROOM_STATUS_NO_TRUNCATE = '0'
    const lines = Array.from({ length: 9 }, (_, i) => `step ${i + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines: lines }))
    expect(out).toContain('<i>✓ +3 earlier…</i>')
    expect(out).not.toContain('step 1')
    expect(out).toContain('<i>✓ step 4</i>')
    expect(out).toContain('<b>→ step 9</b>')
    // 6 visible step lines (the overflow header is not itself a step).
    expect(out.match(/step \d/g) ?? []).toHaveLength(6)
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
  })

  it('strips Markdown markup from narrative + description + result', () => {
    const running = renderWorkerActivity(
      view({
        description: '**Build** the `sync`',
        narrativeLines: ['- ran the **full** suite', '`git push`'],
      }),
    )
    expect(running).toContain('🛠 <b>Worker</b> · <i>Build the sync</i>')
    expect(running).toContain('ran the full suite')
    expect(running).toContain('git push')
    expect(running).not.toContain('**')
    expect(running).not.toContain('`')

    const done = renderWorkerActivity(
      view({ state: 'done', latestSummary: '## Done\n\n**PR #21** opened\n\n---\n`merged`' }),
    )
    expect(done).toContain('Done PR #21 opened merged')
    expect(done).not.toContain('**')
    expect(done).not.toContain('`')
    // The card's own divider is the box-drawing rule, never a raw `---`.
    expect(done).not.toMatch(/(^|\n)\s*-{3,}\s*(\n|$)/)
  })

  it('renders a multi-line narrative entry as one clean step (no raw ## leak)', () => {
    // Screenshot regression: a running-card step whose narrative entry is
    // itself multi-line ("Done.\n\n## Summary\n…"). The heading marker must
    // not leak and the step must collapse to a single visual line.
    const out = renderWorkerActivity(
      view({
        narrativeLines: ['Done.\n\n## Summary\n\nFixed the bug where a bad password logged you out'],
        latestSummary: '',
      }),
    )
    expect(out).not.toContain('## Summary')
    expect(out).not.toContain('\n\n')
    expect(out).toContain('Done. Summary Fixed the bug where a bad password logged you out')
  })

  it('escapes HTML inside narrative lines', () => {
    const out = renderWorkerActivity(view({ narrativeLines: ['a <b>x</b> & y'] }))
    expect(out).toContain('a &lt;b&gt;x&lt;/b&gt; &amp; y')
  })

  it('escapes HTML in description and summary', () => {
    const out = renderWorkerActivity(
      view({ description: 'a <b>bold</b> task', latestSummary: 'a > b' }),
    )
    expect(out).toContain('a &lt;b&gt;bold&lt;/b&gt; task')
    expect(out).toContain('a &gt; b')
  })
})

// ─── createWorkerActivityFeed (lifecycle) ────────────────────────────────────

describe('createWorkerActivityFeed', () => {
  it('holds first paint until the worker has run firstPaintMinMs', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 8000,
    })
    clock = 5000
    await feed.update('w1', 'chat', view({ elapsedMs: 5000 }))
    expect(bot.sent).toHaveLength(0)
    expect(feed.has('w1')).toBe(false)

    clock = 9000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000 }))
    expect(bot.sent).toHaveLength(1)
    expect(bot.sent[0].chatId).toBe('chat')
    expect(bot.sent[0].opts?.parse_mode).toBe('HTML')
    expect(feed.has('w1')).toBe(true)
  })

  it('dedups an identical body (no edit)', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })
    await feed.update('w1', 'chat', view())
    expect(bot.sent).toHaveLength(1)
    clock = 20_000
    await feed.update('w1', 'chat', view()) // same body
    expect(bot.edits).toHaveLength(0)
  })

  it('throttles edits inside minEditIntervalMs but lets them through after', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 2500 })
    await feed.update('w1', 'chat', view({ toolCount: 1 }))
    expect(bot.sent).toHaveLength(1)

    clock = 11_000 // +1000 < 2500
    await feed.update('w1', 'chat', view({ toolCount: 2 }))
    expect(bot.edits).toHaveLength(0)

    clock = 13_000 // +3000 since last edit > 2500
    await feed.update('w1', 'chat', view({ toolCount: 3 }))
    expect(bot.edits).toHaveLength(1)
    expect(bot.edits[0].text).toContain('3 tools')
  })

  it('forces a terminal edit on finish, skipping the throttle', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 9_999_999 })
    await feed.update('w1', 'chat', view())
    expect(bot.sent).toHaveLength(1)

    clock = 10_500 // well within the throttle window
    await feed.finish('w1', view({ state: 'done', toolCount: 5 }))
    expect(bot.edits).toHaveLength(1)
    expect(bot.edits[0].text).toContain('finished · completed · 5 tools')
    // finish forgets the worker.
    expect(feed.has('w1')).toBe(false)
    expect(feed.size).toBe(0)
  })

  it('finish is a no-op when no message was ever posted', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock, firstPaintMinMs: 8000 })
    clock = 2000
    await feed.update('w1', 'chat', view({ elapsedMs: 2000 })) // too short to paint
    expect(bot.sent).toHaveLength(0)
    await feed.finish('w1', view({ state: 'done' }))
    expect(bot.edits).toHaveLength(0)
    expect(bot.sent).toHaveLength(0)
  })

  it('drop forgets a worker without editing', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock })
    await feed.update('w1', 'chat', view())
    expect(feed.has('w1')).toBe(true)
    feed.drop('w1')
    expect(feed.has('w1')).toBe(false)
    expect(feed.size).toBe(0)
    await feed.finish('w1', view({ state: 'done' }))
    expect(bot.edits).toHaveLength(0)
  })

  it('honours a 429 cooldown before retrying the first paint', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, firstPaintMinMs: 0 })
    bot.failNextSendWith = { error_code: 429, parameters: { retry_after: 2 } }
    await feed.update('w1', 'chat', view())
    expect(bot.sent).toHaveLength(0) // failed send

    clock = 11_000 // still inside cooldown (10_000 + 2000 + 500 jitter = 12_500)
    await feed.update('w1', 'chat', view())
    expect(bot.sent).toHaveLength(0)

    clock = 13_000 // past cooldown
    await feed.update('w1', 'chat', view())
    expect(bot.sent).toHaveLength(1)
  })

  it('re-posts after a stale-message edit failure', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })
    await feed.update('w1', 'chat', view({ toolCount: 1 }))
    expect(bot.sent).toHaveLength(1)

    clock = 20_000
    bot.failNextEditWith = new Error('Bad Request: message to edit not found')
    await feed.update('w1', 'chat', view({ toolCount: 2 }))
    expect(bot.edits).toHaveLength(0) // edit threw
    expect(feed.has('w1')).toBe(false) // messageId reset

    clock = 30_000
    await feed.update('w1', 'chat', view({ toolCount: 3 }))
    expect(bot.sent).toHaveLength(2) // re-posted
    expect(feed.has('w1')).toBe(true)
  })

  it('skips entirely when chatId is empty (owner DM unconfigured)', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock })
    await feed.update('w1', '', view())
    expect(bot.sent).toHaveLength(0)
    expect(feed.has('w1')).toBe(false)
    expect(feed.size).toBe(0)
  })

  it('accumulates distinct narrative lines into a growing block across ticks', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'read the brief' }))
    expect(bot.sent).toHaveLength(1)
    expect(bot.sent[0].text).toContain('<b>→ read the brief</b>')

    clock = 11_000
    await feed.update('w1', 'chat', view({ toolCount: 2, latestSummary: 'scanned vendor A' }))
    clock = 12_000
    await feed.update('w1', 'chat', view({ toolCount: 3, latestSummary: 'scanned vendor B' }))

    const last = bot.edits.at(-1)!
    expect(last.text).toContain('<i>✓ read the brief</i>')
    expect(last.text).toContain('<i>✓ scanned vendor A</i>')
    expect(last.text).toContain('<b>→ scanned vendor B</b>')
    expect(last.text.match(/[✓→]/g) ?? []).toHaveLength(3)
  })

  it('dedups a repeated narrative line so the block does not duplicate', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'same line' }))
    // Repeated narrative but a changed tool count → body differs, edit fires,
    // but the narrative block must not gain a duplicate line.
    clock = 11_000
    await feed.update('w1', 'chat', view({ toolCount: 2, latestSummary: 'same line' }))

    const last = bot.edits.at(-1)!
    expect(last.text.match(/[✓→]/g) ?? []).toHaveLength(1)
  })

  it('caps the narrative block to the last 6 lines (no-truncate OFF)', async () => {
    // This test exercises the capping behaviour that is active when the flag is OFF.
    process.env.SWITCHROOM_STATUS_NO_TRUNCATE = '0'
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    for (let i = 1; i <= 9; i++) {
      clock += 1000
      await feed.update('w1', 'chat', view({ toolCount: i, latestSummary: `line ${i}` }))
    }

    const last = bot.edits.at(-1)!
    expect(last.text.match(/[✓→]/g) ?? []).toHaveLength(6)
    // Oldest lines evicted; newest retained.
    expect(last.text).not.toContain('line 1')
    expect(last.text).not.toContain('line 3')
    expect(last.text).toContain('line 4')
    expect(last.text).toContain('line 9')
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
  })

  it('grows the narrative even while throttled (line surfaces on next edit)', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 2500 })

    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'line A' }))
    expect(bot.sent).toHaveLength(1)

    // Throttled tick — no edit, but the line must still be accumulated.
    clock = 11_000
    await feed.update('w1', 'chat', view({ toolCount: 2, latestSummary: 'line B' }))
    expect(bot.edits).toHaveLength(0)

    // Past the throttle — the edit now carries BOTH lines.
    clock = 13_000
    await feed.update('w1', 'chat', view({ toolCount: 3, latestSummary: 'line C' }))
    const last = bot.edits.at(-1)!
    expect(last.text).toContain('<i>✓ line A</i>')
    expect(last.text).toContain('<i>✓ line B</i>')
    expect(last.text).toContain('<b>→ line C</b>')
  })

  it('forwards threadId as message_thread_id on send', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock })
    await feed.update('w1', 'chat', view(), 42)
    expect(bot.sent[0].opts?.message_thread_id).toBe(42)
  })
})

// ─── log sink: success-path observability ────────────────────────────────────
// Before this, the feed only logged on FAILURE, so a feed that rendered fine
// was invisible in the gateway log — the exact gap that made the marko
// status-dark incident hard to triage. Assert paint/edit/finish each emit a
// structured, greppable line naming the worker, chat, thread, and message id.
describe('createWorkerActivityFeed — log sink', () => {
  it('logs paint on first send, edit on each in-place update, and finish on terminal', async () => {
    const bot = makeFakeBot()
    const logs: string[] = []
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 0,
      log: (m) => logs.push(m),
    })

    await feed.update('w-research', 'chat-9', view({ toolCount: 1, latestSummary: 'first' }), 7)
    clock = 11_000
    await feed.update('w-research', 'chat-9', view({ toolCount: 2, latestSummary: 'second' }), 7)
    clock = 12_000
    await feed.finish('w-research', view({ state: 'done', toolCount: 2 }))

    const paint = logs.find((l) => l.startsWith('worker-feed: paint'))
    const edit = logs.find((l) => l.startsWith('worker-feed: edit'))
    const finish = logs.find((l) => l.startsWith('worker-feed: finish'))

    expect(paint).toBeDefined()
    expect(paint).toContain('agent=w-research')
    expect(paint).toContain('chat=chat-9')
    expect(paint).toContain('thread=7')
    expect(paint).toMatch(/msgId=\d+/)
    expect(paint).toMatch(/bytes=\d+/)

    expect(edit).toBeDefined()
    expect(edit).toContain('agent=w-research')

    expect(finish).toBeDefined()
    expect(finish).toContain('state=done')
  })

  it('renders thread=- in the log line when no forum topic is set', async () => {
    const bot = makeFakeBot()
    const logs: string[] = []
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, log: (m) => logs.push(m) })
    await feed.update('w1', 'chat', view()) // no threadId
    expect(logs.find((l) => l.startsWith('worker-feed: paint'))).toContain('thread=-')
  })

  it('does not log a paint when the worker stays below firstPaintMin (still silent)', async () => {
    const bot = makeFakeBot()
    const logs: string[] = []
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock, firstPaintMinMs: 8000, log: (m) => logs.push(m) })
    clock = 3000
    await feed.update('w1', 'chat', view({ elapsedMs: 3000 }))
    expect(logs.some((l) => l.startsWith('worker-feed: paint'))).toBe(false)
  })
})

// ─── SWITCHROOM_STATUS_NO_TRUNCATE feature flag tests ────────────────────────
// New contract (rolling-5-full):
//   ON  → last STATUS_ROLLING_LINES lines rendered in FULL; no overflow header;
//          char-budget backstop (_fitWorkerBodyToCharBudget) is the only ceiling.
//   OFF → NARRATIVE_MAX_LINES cap + STEP_MAX per-line clip (legacy, unchanged).

describe('SWITCHROOM_STATUS_NO_TRUNCATE — renderWorkerActivity', () => {
  afterEach(() => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
  })

  it('no-truncate ON (default): with 12 narrative lines, exactly the last STATUS_ROLLING_LINES render', () => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE // default = ON
    // Use zero-padded numbers so "stp-001" cannot be a substring of "stp-010".
    const narrativeLines = Array.from({ length: 12 }, (_, i) => `stp-${String(i + 1).padStart(3, '0')}`)
    const out = renderWorkerActivity(view({ narrativeLines }))
    // The last STATUS_ROLLING_LINES lines must appear.
    const firstVisible = 12 - STATUS_ROLLING_LINES + 1
    for (let i = firstVisible; i <= 12; i++) {
      expect(out).toContain(`stp-${String(i).padStart(3, '0')}`)
    }
    // The first (12 - STATUS_ROLLING_LINES) lines must NOT appear.
    for (let i = 1; i < firstVisible; i++) {
      expect(out).not.toContain(`stp-${String(i).padStart(3, '0')}`)
    }
    // No overflow header in no-truncate mode.
    expect(out).not.toContain('earlier…')
    expect(out).toContain('<b>→ stp-012</b>')
  })

  it('no-truncate ON: a 150-char line renders in FULL (no "…" mid-line truncation)', () => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
    const longLine = 'a'.repeat(75) + ' ' + 'b'.repeat(74) // 150 chars total
    const out = renderWorkerActivity(view({ narrativeLines: [longLine] }))
    // Must appear without "…" from per-line STEP_MAX clip.
    expect(out).toContain(longLine)
    expect(out).not.toContain('…')
  })

  it('no-truncate ON: no "✓ +N earlier…" overflow header', () => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
    const narrativeLines = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines }))
    expect(out).not.toContain('earlier…')
  })

  it('no-truncate OFF (=0): existing NARRATIVE_MAX_LINES cap + STEP_MAX clip are preserved', () => {
    process.env.SWITCHROOM_STATUS_NO_TRUNCATE = '0'
    const narrativeLines = Array.from({ length: 9 }, (_, i) => `step ${i + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines }))
    // Overflow header must appear (legacy cap active).
    expect(out).toContain('<i>✓ +3 earlier…</i>')
    expect(out).not.toContain('step 1')
    expect(out).toContain('step 4')
    expect(out).toContain('<b>→ step 9</b>')
    expect(out.match(/step \d/g) ?? []).toHaveLength(6)
  })

  it('no-truncate OFF (=0): a 150-char line is clipped at STEP_MAX (regression guard)', () => {
    process.env.SWITCHROOM_STATUS_NO_TRUNCATE = '0'
    const longLine = 'x'.repeat(150)
    const out = renderWorkerActivity(view({ narrativeLines: [longLine] }))
    // Per-line clip must apply when flag is OFF.
    expect(out).toContain('…')
    expect(out).not.toContain(longLine)
  })

  it('no-truncate ON + pathologically oversized body: char-budget backstop fires, output ≤ 4096 chars', () => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
    // 5 huge lines × ~900 chars each → well over 4000 chars rendered.
    const bigLine = 'z'.repeat(900)
    const narrativeLines = Array.from({ length: 5 }, () => bigLine)
    const out = renderWorkerActivity(view({ narrativeLines }))
    // Hard invariant: must never exceed Telegram's 4096 char limit.
    expect(out.length).toBeLessThanOrEqual(4096)
    // The newest step must still be present (some portion of it).
    const hasBullet = out.includes('→') || out.includes('✓')
    expect(hasBullet).toBe(true)
  })
})

describe('SWITCHROOM_STATUS_NO_TRUNCATE — createWorkerActivityFeed narrative accumulation', () => {
  afterEach(() => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
  })

  it('no-truncate ON: rolling window — with 12 pushes, only the last STATUS_ROLLING_LINES appear in render', async () => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    // Use zero-padded names to avoid substring collisions (ln-001 vs ln-010).
    for (let i = 1; i <= 12; i++) {
      clock += 1000
      await feed.update('w1', 'chat', view({ toolCount: i, latestSummary: `ln-${String(i).padStart(3, '0')}` }))
    }

    const last = bot.edits.at(-1)!
    const firstVisible = 12 - STATUS_ROLLING_LINES + 1
    // The last STATUS_ROLLING_LINES lines must be present.
    for (let i = firstVisible; i <= 12; i++) {
      expect(last.text).toContain(`ln-${String(i).padStart(3, '0')}`)
    }
    // Earlier lines must have rolled off.
    for (let i = 1; i < firstVisible; i++) {
      expect(last.text).not.toContain(`ln-${String(i).padStart(3, '0')}`)
    }
    // No overflow header in no-truncate mode.
    expect(last.text).not.toContain('earlier…')
    expect(last.text).toContain('<b>→ ln-012</b>')
  })

  it('no-truncate OFF (=0): narrative is still spliced to NARRATIVE_MAX_LINES (original behaviour)', async () => {
    process.env.SWITCHROOM_STATUS_NO_TRUNCATE = '0'
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    for (let i = 1; i <= 9; i++) {
      clock += 1000
      await feed.update('w1', 'chat', view({ toolCount: i, latestSummary: `line ${i}` }))
    }

    const last = bot.edits.at(-1)!
    expect(last.text.match(/[✓→]/g) ?? []).toHaveLength(6)
    expect(last.text).not.toContain('line 1')
    expect(last.text).not.toContain('line 3')
    expect(last.text).toContain('line 4')
    expect(last.text).toContain('line 9')
  })

  it('no-truncate ON: env-flip seam works (set/delete per test)', () => {
    // Verify the seam: after setting '0', the flag reads as OFF (legacy cap).
    process.env.SWITCHROOM_STATUS_NO_TRUNCATE = '0'
    // Use zero-padded names to avoid substring collisions.
    const total = NARRATIVE_MAX_LINES + 2
    const lines = Array.from({ length: total }, (_, i) => `sv-${String(i + 1).padStart(3, '0')}`)
    const offOut = renderWorkerActivity(view({ narrativeLines: lines }))
    expect(offOut).toContain('+2 earlier')

    // After deleting, the flag reads as ON (rolling-5-full).
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
    const onOut = renderWorkerActivity(view({ narrativeLines: lines }))
    // No overflow header in no-truncate mode.
    expect(onOut).not.toContain('earlier…')
    // Only the last STATUS_ROLLING_LINES lines should be visible.
    const firstVisible = total - STATUS_ROLLING_LINES + 1
    for (let i = firstVisible; i <= total; i++) {
      expect(onOut).toContain(`sv-${String(i).padStart(3, '0')}`)
    }
    for (let i = 1; i < firstVisible; i++) {
      expect(onOut).not.toContain(`sv-${String(i).padStart(3, '0')}`)
    }
  })
})

// ─── Extreme-edge: single oversized narrative line (no-truncate ON) ──────────
// Reproduces the bug where accumulateNarrative's char-budget splice would push
// the oversized line then immediately splice it out, making the narrative empty
// and the step vanish from the rendered output.

/** Cheap valid-HTML checker: balanced <b>/<i> tags and no partial entity. */
function isValidWorkerHtml(s: string): boolean {
  const bOpen = (s.match(/<b>/g) ?? []).length
  const bClose = (s.match(/<\/b>/g) ?? []).length
  const iOpen = (s.match(/<i>/g) ?? []).length
  const iClose = (s.match(/<\/i>/g) ?? []).length
  if (bOpen !== bClose || iOpen !== iClose) return false
  // No partial entity (e.g. &amp without semicolon at end or mid-string).
  if (/&[a-z]+$/.test(s)) return false
  return true
}

describe('extreme-edge: single oversized narrative line (no-truncate ON)', () => {
  afterEach(() => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
  })

  it('no-truncate ON: one ~4100-char step is shown (truncated) not discarded, output ≤ budget and valid HTML', async () => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    // Build a latestSummary > STATUS_CARD_CHAR_BUDGET chars with && and special chars.
    const base = 'run build && deploy && notify with <args> & flags=1 '
    const hugeStep = base.repeat(80) + '&&'
    expect(hugeStep.length).toBeGreaterThan(4000)

    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: hugeStep }))
    expect(bot.sent).toHaveLength(1)
    const out = bot.sent[0].text

    // The step must NOT have vanished — some portion must appear.
    // Since the step is huge it will be truncated, but the worker card itself
    // must contain a step bullet (→ or ✓).
    const hasBullet = out.includes('→') || out.includes('✓')
    expect(hasBullet).toBe(true)

    // Wire safety: output must be within the Telegram char budget.
    expect(out.length).toBeLessThanOrEqual(4096)

    // Valid HTML: balanced tags and no partial entity.
    expect(isValidWorkerHtml(out)).toBe(true)
  })

  it('no-truncate ON: one ~4100-char step via renderWorkerActivity directly → ≤ budget and valid HTML', () => {
    delete process.env.SWITCHROOM_STATUS_NO_TRUNCATE
    const base = 'compile && link && package && ship: action=deploy env=<prod> flag=1 '
    const hugeStep = base.repeat(65)
    expect(hugeStep.length).toBeGreaterThan(4000)

    const out = renderWorkerActivity(view({ narrativeLines: [hugeStep] }))

    // Step must be present in some form (truncated is fine, absent is not).
    const hasBullet = out.includes('→') || out.includes('✓')
    expect(hasBullet).toBe(true)

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerHtml(out)).toBe(true)
  })
})
