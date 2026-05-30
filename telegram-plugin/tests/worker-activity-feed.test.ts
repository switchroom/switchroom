import { describe, it, expect } from 'vitest'
import {
  renderWorkerActivity,
  createWorkerActivityFeed,
  type WorkerActivityView,
  type BotApiForWorkerFeed,
} from '../worker-activity-feed.js'

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
  it('renders running header + tool activity line + summary', () => {
    const out = renderWorkerActivity(view())
    expect(out).toContain('🔧 <b>Worker</b> · <i>research competitors</i>')
    expect(out).toContain('⚡ <code>Bash</code> grep -r pricing')
    expect(out).toContain('(3 tools · ')
    expect(out).toContain('↳ <i>scanning vendor pages</i>')
  })

  it('shows a "starting…" line when no tool has run yet', () => {
    const out = renderWorkerActivity(view({ lastTool: null, latestSummary: '' }))
    expect(out).toContain('🔧 <b>Worker</b>')
    expect(out).toContain('starting…')
    expect(out).not.toContain('⚡')
  })

  it('omits the summary line when latestSummary is blank', () => {
    const out = renderWorkerActivity(view({ latestSummary: '   ' }))
    expect(out).not.toContain('↳')
  })

  it('uses singular "tool" for a single tool call', () => {
    const out = renderWorkerActivity(view({ toolCount: 1 }))
    expect(out).toContain('(1 tool · ')
  })

  it('renders a done terminal recap', () => {
    const out = renderWorkerActivity(view({ state: 'done', toolCount: 5 }))
    expect(out).toContain('✅ <b>Worker done</b> · <i>research competitors</i>')
    expect(out).toContain('5 tools · ')
    expect(out).not.toContain('⚡')
  })

  it('renders a failed terminal recap', () => {
    const out = renderWorkerActivity(view({ state: 'failed' }))
    expect(out).toContain('⚠️ <b>Worker failed</b>')
  })

  it('escapes HTML in description, tool, arg, and summary', () => {
    const out = renderWorkerActivity(
      view({
        description: 'a <b>bold</b> task',
        lastTool: { name: 'Ba<sh', sanitisedArg: 'x & y' },
        latestSummary: 'a > b',
      }),
    )
    expect(out).toContain('a &lt;b&gt;bold&lt;/b&gt; task')
    expect(out).toContain('Ba&lt;sh')
    expect(out).toContain('x &amp; y')
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
    expect(bot.edits[0].text).toContain('(3 tools · ')
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
    expect(bot.edits[0].text).toContain('✅ <b>Worker done</b>')
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

  it('forwards threadId as message_thread_id on send', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock })
    await feed.update('w1', 'chat', view(), 42)
    expect(bot.sent[0].opts?.message_thread_id).toBe(42)
  })
})
