import { describe, it, expect } from 'vitest'
import {
  renderWorkerActivity,
  createWorkerActivityFeed,
  isWorkerActivityFeedEnabled,
  type WorkerActivityView,
  type BotApiForWorkerFeed,
} from '../worker-activity-feed.js'
import { STATUS_ROLLING_LINES, STATUS_LINE_MAX } from '../status-no-truncate.js'

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
    // Unified header: running shows "<elapsed> · N tools" (no "running ·" word).
    expect(out).toContain('<i>10s · 3 tools</i>')
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
    // Unified done header: "done · N tools · <elapsed>".
    expect(out).toContain('<i>done · 5 tools · ')
    expect(out).toContain('─────')
    expect(out).toContain('✅ <i>PR #21 opened</i>')
    // latestSummary is the RESULT on the finished path, never also a step.
    expect(out).not.toContain('<i>✓ PR #21 opened</i>')
  })

  it('renders a failed terminal recap', () => {
    const out = renderWorkerActivity(view({ state: 'failed', latestSummary: 'blew up' }))
    // Failed maps to the "done" header word; the ⚠️ result carries the failure.
    expect(out).toContain('<i>done · ')
    expect(out).toContain('⚠️ <i>blew up</i>')
  })

  it('omits the rule + result line when the terminal result is empty', () => {
    const out = renderWorkerActivity(view({ state: 'done', latestSummary: '   ' }))
    expect(out).toContain('<i>done · ')
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

  it('shows a "+N earlier…" header when the feed exceeds STATUS_ROLLING_LINES (worker surface)', () => {
    const total = STATUS_ROLLING_LINES + 3
    const lines = Array.from({ length: total }, (_, i) => `step ${i + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines: lines }))
    expect(out).toContain(`<i>✓ +${total - STATUS_ROLLING_LINES} earlier…</i>`)
    expect(out).not.toContain('step 1<')
    const firstVisible = total - STATUS_ROLLING_LINES + 1
    expect(out).toContain(`<i>✓ step ${firstVisible}</i>`)
    expect(out).toContain(`<b>→ step ${total}</b>`)
    // STATUS_ROLLING_LINES visible step lines (the overflow header isn't a step).
    expect(out.match(/step \d/g) ?? []).toHaveLength(STATUS_ROLLING_LINES)
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
    expect(bot.edits[0].text).toContain('<i>done · 5 tools · ')
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

  it('rolls the narrative block to the last STATUS_ROLLING_LINES lines', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    const total = 9
    for (let i = 1; i <= total; i++) {
      clock += 1000
      await feed.update('w1', 'chat', view({ toolCount: i, latestSummary: `ln-${String(i).padStart(3, '0')}` }))
    }

    const last = bot.edits.at(-1)!
    expect(last.text.match(/[✓→]/g) ?? []).toHaveLength(STATUS_ROLLING_LINES)
    const firstVisible = total - STATUS_ROLLING_LINES + 1
    for (let i = 1; i < firstVisible; i++) expect(last.text).not.toContain(`ln-${String(i).padStart(3, '0')}`)
    for (let i = firstVisible; i <= total; i++) expect(last.text).toContain(`ln-${String(i).padStart(3, '0')}`)
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

// ─── Rolling window + STATUS_LINE_MAX (flag retired) ─────────────────────────
// Single mode: last STATUS_ROLLING_LINES lines render in full (clipped per-line
// at STATUS_LINE_MAX=200), overflow → `+N earlier…` header on the worker surface,
// char-budget backstop is the only wire-limit ceiling.

describe('rolling window + STATUS_LINE_MAX — renderWorkerActivity', () => {
  it('with 12 narrative lines, exactly the last STATUS_ROLLING_LINES render + a +N earlier header', () => {
    const narrativeLines = Array.from({ length: 12 }, (_, i) => `stp-${String(i + 1).padStart(3, '0')}`)
    const out = renderWorkerActivity(view({ narrativeLines }))
    const firstVisible = 12 - STATUS_ROLLING_LINES + 1
    for (let i = firstVisible; i <= 12; i++) {
      expect(out).toContain(`stp-${String(i).padStart(3, '0')}`)
    }
    for (let i = 1; i < firstVisible; i++) {
      expect(out).not.toContain(`stp-${String(i).padStart(3, '0')}`)
    }
    // Overflow header now appears on the worker surface too.
    expect(out).toContain(`<i>✓ +${12 - STATUS_ROLLING_LINES} earlier…</i>`)
    expect(out).toContain('<b>→ stp-012</b>')
  })

  it('STATUS_LINE_MAX=200: a 250-char line is clipped to 200 with a trailing …', () => {
    const longLine = 'a'.repeat(250)
    const out = renderWorkerActivity(view({ narrativeLines: [longLine] }))
    expect(out).toContain('…')
    expect(out).not.toContain(longLine)
    expect(out).toContain('a'.repeat(STATUS_LINE_MAX - 1) + '…')
  })

  it('a line at exactly STATUS_LINE_MAX is NOT clipped', () => {
    const exact = 'b'.repeat(STATUS_LINE_MAX)
    const out = renderWorkerActivity(view({ narrativeLines: [exact] }))
    expect(out).toContain(exact)
    expect(out).not.toContain('…')
  })

  it('no "+N earlier…" overflow header when the feed fits the window', () => {
    const narrativeLines = Array.from({ length: STATUS_ROLLING_LINES }, (_, i) => `step ${i + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines }))
    expect(out).not.toContain('earlier…')
  })

  it('pathologically oversized body: char-budget backstop fires, output ≤ 4096 chars', () => {
    const bigLine = 'z'.repeat(900)
    const narrativeLines = Array.from({ length: STATUS_ROLLING_LINES }, () => bigLine)
    const out = renderWorkerActivity(view({ narrativeLines }))
    expect(out.length).toBeLessThanOrEqual(4096)
    const hasBullet = out.includes('→') || out.includes('✓')
    expect(hasBullet).toBe(true)
  })
})

describe('rolling window — createWorkerActivityFeed narrative accumulation', () => {
  it('with 12 pushes, only the last STATUS_ROLLING_LINES appear in the render', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    for (let i = 1; i <= 12; i++) {
      clock += 1000
      await feed.update('w1', 'chat', view({ toolCount: i, latestSummary: `ln-${String(i).padStart(3, '0')}` }))
    }

    const last = bot.edits.at(-1)!
    const firstVisible = 12 - STATUS_ROLLING_LINES + 1
    for (let i = firstVisible; i <= 12; i++) {
      expect(last.text).toContain(`ln-${String(i).padStart(3, '0')}`)
    }
    for (let i = 1; i < firstVisible; i++) {
      expect(last.text).not.toContain(`ln-${String(i).padStart(3, '0')}`)
    }
    // The manager caps the in-memory narrative at STATUS_ROLLING_LINES, so the
    // render never sees overflow — no "+N earlier…" marker on the manager path
    // (it surfaces only on direct renderWorkerActivity calls with >5 lines).
    expect(last.text).not.toContain('earlier…')
    expect(last.text).toContain('<b>→ ln-012</b>')
  })
})

// ─── Worker heartbeat (option a — suffix-only, never opens a new message) ─────

describe('createWorkerActivityFeed — heartbeat', () => {
  it('(i) a tick fires a re-render with a climbing · Ns suffix on a stale worker', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 2500,
      heartbeatTickMs: 6000,
      // No real timer: drive ticks manually.
      setInterval: () => 1,
      clearInterval: () => {},
    })
    // First paint at elapsed 0 (firstPaintMin default 8000 — use 9000).
    clock = 19_000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000, latestSummary: 'pulling data' }))
    expect(bot.sent).toHaveLength(1)
    const dispatchAt = clock - 9000

    // Advance past the staleness window so the heartbeat ticks.
    clock = 26_000 // lastEditAt(19000) + 7000 ≥ heartbeatTickMs(6000) and ≥ minEditInterval
    feed.heartbeatTick()
    await feed.update('w1', 'chat', view({ elapsedMs: 16_000, latestSummary: 'pulling data' })).catch(() => {})
    // Drain the chain.
    await feed.update('w1', 'chat', view({ elapsedMs: 16_000, latestSummary: 'pulling data' }))
    const edit1 = bot.edits.find((e) => /· \d+s<\/b>/.test(e.text))
    expect(edit1).toBeDefined()
    // The suffix reflects the LIVE elapsed (now - dispatchAt), not the stale view.
    expect(edit1!.text).toContain(`· ${Math.floor((26_000 - dispatchAt) / 1000)}s`)
  })

  it('(ii) respects a 429 cooldown — no edit while cooldownUntil is in the future', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 0,
      heartbeatTickMs: 6000,
      firstPaintMinMs: 0,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    await feed.update('w1', 'chat', view({ elapsedMs: 1000, latestSummary: 'go' }))
    expect(bot.sent).toHaveLength(1)
    // Induce a cooldown by failing the next edit with a 429.
    clock = 20_000
    bot.failNextEditWith = { error_code: 429, parameters: { retry_after: 30 } }
    await feed.update('w1', 'chat', view({ elapsedMs: 11_000, latestSummary: 'changed' }))
    const editsAfterCooldown = bot.edits.length
    // Tick while still inside the cooldown window → no new edit.
    clock = 27_000
    feed.heartbeatTick()
    await feed.update('w1', 'chat', view({ elapsedMs: 18_000, latestSummary: 'changed' }))
    expect(bot.edits.length).toBe(editsAfterCooldown)
  })

  it('(iii) does not edit after the handle is removed on finish', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 0,
      heartbeatTickMs: 6000,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    await feed.update('w1', 'chat', view({ latestSummary: 'go' }))
    clock = 20_000
    await feed.finish('w1', view({ state: 'done', toolCount: 2 }))
    expect(feed.has('w1')).toBe(false)
    const editsBefore = bot.edits.length
    clock = 30_000
    feed.heartbeatTick()
    // No handle → tick is a no-op, no further edit.
    expect(bot.edits.length).toBe(editsBefore)
  })

  it('(iv) stop() clears the interval and a tick on empty handles is a no-op (no leak)', () => {
    let cleared = false
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      setInterval: () => 1,
      clearInterval: () => { cleared = true },
    })
    // No handles yet → tick does nothing and does not throw.
    expect(() => feed.heartbeatTick()).not.toThrow()
    feed.stop()
    expect(cleared).toBe(true)
  })

  it('(v) respects minEditInterval — a tick inside the throttle window does not edit', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 2500,
      heartbeatTickMs: 6000,
      firstPaintMinMs: 0,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    await feed.update('w1', 'chat', view({ elapsedMs: 1000, latestSummary: 'go' }))
    expect(bot.sent).toHaveLength(1)
    const editsBefore = bot.edits.length
    // Tick only 1000ms after the paint — inside minEditInterval (2500) → no edit.
    clock = 11_000
    feed.heartbeatTick()
    await feed.update('w1', 'chat', view({ elapsedMs: 2000, latestSummary: 'go' })).catch(() => {})
    expect(bot.edits.length).toBe(editsBefore)
  })
})

// ─── Extreme-edge: single oversized narrative line (no-truncate ON) ──────────
// Reproduces the bug where accumulateNarrative's char-budget splice would push
// the oversized line then immediately splice it out, making the narrative empty
// and the step vanish from the rendered output.

/**
 * Cheap valid-HTML checker: balanced <b>/<i> tags and no dangling/partial entity.
 * Checks for partial entities (e.g. `&am`, `&l`, `&amp` without trailing `;`)
 * as produced by naive slicing of already-escaped HTML at an entity boundary.
 */
function isValidWorkerHtml(s: string): boolean {
  const bOpen = (s.match(/<b>/g) ?? []).length
  const bClose = (s.match(/<\/b>/g) ?? []).length
  const iOpen = (s.match(/<i>/g) ?? []).length
  const iClose = (s.match(/<\/i>/g) ?? []).length
  if (bOpen !== bClose || iOpen !== iClose) return false
  // Check every `&` occurrence: the run of letters after it must end with `;`.
  // A partial entity like `&am`, `&l`, or `&amp` (no ;) would fail this.
  // We scan every `&` manually so there's no regex backtracking ambiguity.
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '&') continue
    let j = i + 1
    while (j < s.length && s[j] >= 'a' && s[j] <= 'z') j++
    // j is now at the character after the letter run.
    // If there were letters and the next char isn't ';', it's a broken entity.
    if (j > i + 1 && (j >= s.length || s[j] !== ';')) return false
  }
  return true
}

describe('extreme-edge: single oversized narrative line (no-truncate ON)', () => {
  it('no-truncate ON: one ~4100-char step is shown (truncated) not discarded, output ≤ budget and valid HTML', async () => {
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

// ─── Bug 2: _fitWorkerBodyToCharBudget must not slice already-escaped HTML ───
//
// Before the fix, the extreme fallback in _fitWorkerBodyToCharBudget sliced
// directly into the already-HTML-escaped newest line string. If the slice
// boundary landed inside an HTML entity (&amp;, &lt;, &gt;), the output
// contained a broken entity fragment (&am, &l, &amp without ;), which
// Telegram Bot API rejects with HTTP 400 on parse_mode:'HTML'.
//
// The fix mirrors _fitToCharBudget (tool-activity-summary.ts): truncate RAW
// content first, then escape, then wrap, re-checking post-escape because
// escaping can expand the string (&→&amp; etc.).
//
// These tests place entity characters (&, <, >) at positions that, under the
// old naive slice, would produce exactly the broken fragments the issue
// identified (&am, &l). They assert the output is valid HTML and within budget.

describe('Bug 2 (#2506): _fitWorkerBodyToCharBudget does not split HTML entities', () => {
  /**
   * Build a narrative line that, after HTML-escaping, has the entity boundary
   * at a precise position so a naive `escaped.slice(3, 3 + N)` would split it.
   *
   * Strategy: fill with 'x' characters up to a budget, then append an entity
   * character so the entity starts right where the slice would land.
   */
  function buildEntityBoundaryLine(entityChar: string, charBudget: number): string {
    // The fitter computes sliceAt ≈ charBudget - tagOverhead - closingTag.length.
    // After the "→ " prefix (2 chars) and <b>…</b> wrapper (7 chars total overhead
    // in the old code), the inner slice window is roughly charBudget - 9.
    // Place the entity character so it lands at the very start of where the
    // naive slice would begin — i.e., fill with (charBudget - 9) 'x's then '&'.
    const fillLen = Math.max(0, charBudget - 9)
    return 'x'.repeat(fillLen) + entityChar + 'y'.repeat(50)
  }

  it('& at entity boundary: output is valid HTML (no &am, &amp without ; etc.)', () => {
    // A line that places '&' right at the slice boundary so naive cut → &am
    const line = buildEntityBoundaryLine('&', 4096)
    expect(line.length).toBeGreaterThan(100) // sanity: line is substantial

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerHtml(out)).toBe(true)
    // No partial entity fragments that the old code produced.
    expect(out).not.toMatch(/&amp$/)   // incomplete &amp; at end
    expect(out).not.toMatch(/&am[^p]/) // &am followed by non-p (e.g. &amy)
    expect(out).not.toMatch(/&[lg]t?[^;]/) // &l, &lt without semicolon
  })

  it('< at entity boundary: output is valid HTML (no &l, &lt without ; etc.)', () => {
    const line = buildEntityBoundaryLine('<', 4096)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerHtml(out)).toBe(true)
    expect(out).not.toMatch(/&lt$/)    // incomplete &lt; at end
    expect(out).not.toMatch(/&l[^t;]/) // &l followed by non-t
  })

  it('> at entity boundary: output is valid HTML (no &g, &gt without ; etc.)', () => {
    const line = buildEntityBoundaryLine('>', 4096)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerHtml(out)).toBe(true)
    expect(out).not.toMatch(/&gt$/)    // incomplete &gt; at end
    expect(out).not.toMatch(/&g[^t;]/) // &g followed by non-t
  })

  it('entity-dense line (& < > interleaved): output ≤ budget and valid HTML', () => {
    // Mix entity characters throughout so any slice position is dangerous.
    const chunk = '&' + 'x'.repeat(3) + '<' + 'y'.repeat(3) + '>' + 'z'.repeat(3)
    const line = chunk.repeat(500) // ~10k chars raw → well over budget after escape
    expect(line.length).toBeGreaterThan(4000)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerHtml(out)).toBe(true)
  })

  it('single & alone in the line: valid HTML and within budget', () => {
    // Regression: a one-char entity line is a degenerate case the while-loop
    // must handle without infinite-looping or returning empty content.
    // Build a huge line: filler xs then '&' then more xs
    const line = 'x'.repeat(3000) + '&' + 'x'.repeat(1000)
    expect(line.length).toBeGreaterThan(4000)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerHtml(out)).toBe(true)
  })
})

// ─── Regression: header/status row + rolling overflow survive trimming ───────
//
// The unified renderer clips every line to STATUS_LINE_MAX (200) BEFORE the
// char-budget backstop, so ordinary "long step" turns fit the budget without
// dropping any bullets. The two-line header always survives, and a rolling
// "+N earlier…" marker appears when more than STATUS_ROLLING_LINES lines are
// rendered directly. The char-budget backstop (fitCardToBudget) is exercised
// only by genuinely pathological single oversized lines (covered elsewhere).

describe('header row + rolling overflow survive in the unified worker render', () => {
  it('the two-line header survives even with many long lines (clipped to STATUS_LINE_MAX)', () => {
    const bigLine = 'a'.repeat(700)
    const narrativeLines = Array.from({ length: 6 }, (_, i) =>
      i < 5 ? bigLine : 'final short step',
    )
    const out = renderWorkerActivity(view({ narrativeLines, toolCount: 7 }))

    expect(out).toContain('🛠 <b>Worker</b>')
    // Unified running status line.
    expect(out).toContain('<i>10s · 7 tools</i>')
    expect(out).toContain('7 tools')
    // Every rendered line was clipped to STATUS_LINE_MAX → output well within budget.
    expect(out.length).toBeLessThanOrEqual(4096)
    // Newest bullet is the live → step.
    expect(out).toContain('<b>→ final short step</b>')
  })

  it('a "+N earlier…" rolling marker appears when more than STATUS_ROLLING_LINES lines render', () => {
    const narrativeLines = Array.from({ length: STATUS_ROLLING_LINES + 2 }, (_, i) => `step ${i + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(out).toContain('earlier…')
    expect(out).toContain('🛠 <b>Worker</b>')
    expect(out).toContain('<i>10s · ')
  })

  it('back-compat path (latestSummary only) still shows a step bullet, clipped + valid HTML', () => {
    const hugeSummary = 'deploy service && run migrations && verify health checks '.repeat(80)
    expect(hugeSummary.length).toBeGreaterThan(4000)

    const out = renderWorkerActivity(
      view({ narrativeLines: undefined, latestSummary: hugeSummary }),
    )

    expect(out.length).toBeLessThanOrEqual(4096)
    const hasBullet = out.includes('→') || out.includes('✓')
    expect(hasBullet).toBe(true)
    expect(out).toContain('🛠 <b>Worker</b>')
    expect(out).toContain('<i>10s · ')
    expect(isValidWorkerHtml(out)).toBe(true)
  })
})
