import { describe, it, expect } from 'vitest'
import {
  renderWorkerActivity,
  createWorkerActivityFeed,
  isWorkerActivityFeedEnabled,
  type WorkerActivityView,
  type BotApiForWorkerFeed,
} from '../worker-activity-feed.js'
import { STATUS_ROLLING_LINES, WORKER_HISTORY_MAX, STATUS_LINE_MAX } from '../status-no-truncate.js'
import { SEND_GATE_SHED } from '../send-gate.js'

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
    // #3842: flush at the left margin — no `└─ ` card-level prefix.
    expect(out.startsWith('🛠 **WORKER** · _research competitors_')).toBe(true)
    // Unified header: running shows "<elapsed> · N tools" (no "running ·" word).
    expect(out).toContain('_10s · 3 tools_')
    expect(out).toContain('3 tools')
    // No narrativeLines → the latestSummary surfaces as the newest `→` step.
    expect(out).toContain('**→ scanning vendor pages**')
    // The old tool/arg chrome is gone.
    expect(out).not.toContain('⚡')
    expect(out).not.toContain('<code>')
  })

  it('renders the friendly live model on the worker metrics line', () => {
    const out = renderWorkerActivity(view({ model: 'claude-sonnet-5' }))
    expect(out).toContain('_10s · 3 tools · sonnet 5_')
  })

  it('omits the model tag when the worker model is unknown', () => {
    const out = renderWorkerActivity(view())
    expect(out).toContain('_10s · 3 tools_')
    expect(out).not.toContain('· sonnet')
  })

  it('shows a "starting…" line when no step has run yet', () => {
    const out = renderWorkerActivity(view({ lastTool: null, latestSummary: '' }))
    // #3842: flush at the left margin — no `└─ ` card-level prefix.
    expect(out.startsWith('🛠 **WORKER**')).toBe(true)
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
    expect(out).toContain('🛠 **WORKER** · _research competitors_')
    // Unified done header: "done · N tools · <elapsed>".
    expect(out).toContain('_done · 5 tools · ')
    expect(out).toContain('─────')
    expect(out).toContain('✅ _PR #21 opened_')
    // latestSummary is the RESULT on the finished path, never also a step.
    expect(out).not.toContain('~~_✓ PR #21 opened_~~')
  })

  it('renders a failed terminal recap', () => {
    const out = renderWorkerActivity(view({ state: 'failed', latestSummary: 'blew up' }))
    // The header word reflects the failure (`failed · …`) AND the ⚠️ result
    // block carries the detail — the two signals are complementary.
    expect(out).toContain('_failed · ')
    expect(out).not.toContain('_done · ')
    expect(out).toContain('⚠️ _blew up_')
  })

  it('a failed worker with EMPTY result is never byte-identical to a done worker (regression: #2553 failure-honesty)', () => {
    // Detail-less terminal error: resultText === '' (subagent-watcher path).
    const failed = renderWorkerActivity(view({ state: 'failed', latestSummary: '' }))
    const done = renderWorkerActivity(view({ state: 'done', latestSummary: '' }))
    // (a) The two renders must differ — the failure signal cannot vanish.
    expect(failed).not.toBe(done)
    // (b) The failed render carries a visible failure marker even with no
    //     result block (the `failed` header word and/or the ⚠️ emoji).
    expect(failed.includes('failed') || failed.includes('⚠️')).toBe(true)
    expect(failed).toContain('_failed · ')
    // The done render must NOT read as failed.
    expect(done).toContain('_done · ')
    expect(done).not.toContain('failed')
  })

  it('omits the rule + result line when the terminal result is empty', () => {
    const out = renderWorkerActivity(view({ state: 'done', latestSummary: '   ' }))
    expect(out).toContain('_done · ')
    expect(out).not.toContain('─────')
  })

  it('grows a step feed when narrativeLines is present (prior ✓, newest →)', () => {
    const out = renderWorkerActivity(
      view({
        latestSummary: 'newest only — should be ignored',
        narrativeLines: ['read the brief', 'scanned vendor A', 'scanned vendor B'],
      }),
    )
    expect(out).toContain('~~_✓ read the brief_~~')
    expect(out).toContain('~~_✓ scanned vendor A_~~')
    expect(out).toContain('**→ scanned vendor B**')
    // The single-line latestSummary fallback is NOT used when a block is present.
    expect(out).not.toContain('newest only')
    expect(stepCount(out)).toBe(3)
  })

  it('falls back to latestSummary when narrativeLines is empty', () => {
    const out = renderWorkerActivity(view({ narrativeLines: [], latestSummary: 'one line' }))
    expect(out).toContain('**→ one line**')
    expect(stepCount(out)).toBe(1)
  })

  it('drops blank narrative lines from the feed', () => {
    const out = renderWorkerActivity(view({ narrativeLines: ['kept', '   ', 'also kept'] }))
    expect(out).toContain('~~_✓ kept_~~')
    expect(out).toContain('**→ also kept**')
    expect(stepCount(out)).toBe(2)
  })

  it('shows a "+N earlier…" header when the feed exceeds WORKER_HISTORY_MAX (worker surface, #3349)', () => {
    const total = WORKER_HISTORY_MAX + 3
    const lines = Array.from({ length: total }, (_, i) => `step ${i + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines: lines }))
    expect(out).toContain(`_✓ +${total - WORKER_HISTORY_MAX} earlier…_`)
    expect(out).not.toContain('step 1<')
    const firstVisible = total - WORKER_HISTORY_MAX + 1
    expect(out).toContain(`~~_✓ step ${firstVisible}_~~`)
    expect(out).toContain(`**→ step ${total}**`)
    // WORKER_HISTORY_MAX visible step lines (the overflow header isn't a step).
    expect(out.match(/step \d/g) ?? []).toHaveLength(WORKER_HISTORY_MAX)
  })

  it('the lone-worker card shows the full 6-step trail — the raised ceiling (#3349)', () => {
    // Ken's curve at w=1 is 6; the single-worker surface must reach it (the old
    // STATUS_ROLLING_LINES=5 cap could never show the 6th step).
    expect(WORKER_HISTORY_MAX).toBe(6)
    const lines = Array.from({ length: 8 }, (_, n) => `ln-${n + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines: lines }))
    // Last 6 render (ln-3 … ln-8); the two oldest collapse into a "+2 earlier…".
    for (let n = 3; n <= 8; n++) expect(out).toContain(`ln-${n}`)
    expect(out).toContain('_✓ +2 earlier…_')
    expect(out).toContain('**→ ln-8**') // newest last, bold in-progress
    // Exactly 6 rendered step bullets (the +N header is not a bullet).
    expect((out.match(/ln-\d/g) ?? []).length).toBe(6)
  })

  it('strips the CONTENT Markdown markup (the card keeps its own ** / _ wrappers, #2669)', () => {
    // Post-#2669 the card itself is rich markdown — the header is **Worker**
    // and steps are ~~_✓ …_~~ / **→ …**. The per-line pipeline still runs
    // stripMarkdown over the user-supplied CONTENT so a model-authored
    // `**full**` / `` `git push` `` doesn't inject extra emphasis, but the
    // card's own wrapper markup is expected.
    const running = renderWorkerActivity(
      view({
        description: '**Build** the `sync`',
        narrativeLines: ['- ran the **full** suite', '`git push`'],
      }),
    )
    expect(running).toContain('🛠 **WORKER** · _Build the sync_')
    expect(running).toContain('ran the full suite')
    expect(running).toContain('git push')
    // The CONTENT bold/code markers were stripped — no `**full**`, no backticks.
    expect(running).not.toContain('**full**')
    expect(running).not.toContain('`')

    const done = renderWorkerActivity(
      view({ state: 'done', latestSummary: '## Done\n\n**PR #21** opened\n\n---\n`merged`' }),
    )
    expect(done).toContain('Done PR #21 opened merged')
    expect(done).not.toContain('**PR #21**')
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

  it('markdown-escapes emphasis specials inside narrative lines; passes < > & through (#2669)', () => {
    // The per-line pipeline strips paired markdown then escapes survivors.
    // `<`, `>`, `&` are literal in rich markdown; an intra-word `_` is escaped.
    const out = renderWorkerActivity(view({ narrativeLines: ['a <tag> & b_c y'] }))
    expect(out).toContain('a <tag> & b\\_c y')
  })

  it('markdown-escapes specials in description; passes < > & through', () => {
    const out = renderWorkerActivity(
      view({ description: 'a <tag> task b_c', latestSummary: 'a > b' }),
    )
    expect(out).toContain('a <tag> task b\\_c')
    expect(out).toContain('a > b')
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
    // #2669: the worker feed body is raw GFM markdown sent through the rich
    // path (the gateway wires sendMessage → sendRichMessage). No parse_mode.
    expect(bot.sent[0].opts?.parse_mode).toBeUndefined()
    expect(bot.sent[0].text).toContain('🛠 **WORKER**')
    expect(feed.has('w1')).toBe(true)
  })

  it('defaults firstPaintMin to 4000ms (no explicit firstPaintMinMs)', async () => {
    // Guards the module default. A prose-silent worker's first card must paint
    // once it has run ≥4000ms and NOT before — asserting the actual default so
    // this fails on the old 8000. #fix/worker-feed-first-paint.
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock })
    // Just below the 4000 default: still held.
    clock = 3999
    await feed.update('w1', 'chat', view({ elapsedMs: 3999 }))
    expect(bot.sent).toHaveLength(0)
    expect(feed.has('w1')).toBe(false)
    // At/above 4000: paints. (On the old 8000 default this would still be held
    // and bot.sent would be empty — so this assertion pins the new value.)
    clock = 4000
    await feed.update('w1', 'chat', view({ elapsedMs: 4000 }))
    expect(bot.sent).toHaveLength(1)
    expect(feed.has('w1')).toBe(true)
  })

  it('honors an explicit firstPaintMinMs override (env plumbing shape)', async () => {
    // The gateway threads SWITCHROOM_TG_WORKER_FEED_FIRST_PAINT_MS through as
    // firstPaintMinMs; an operator override (e.g. reverting to 8000) must hold
    // first paint until that value, overriding the 4000 default.
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock, firstPaintMinMs: 8000 })
    // Past the 4000 default but below the override: still held.
    clock = 5000
    await feed.update('w1', 'chat', view({ elapsedMs: 5000 }))
    expect(bot.sent).toHaveLength(0)
    expect(feed.has('w1')).toBe(false)
    // At the override threshold: paints.
    clock = 8000
    await feed.update('w1', 'chat', view({ elapsedMs: 8000 }))
    expect(bot.sent).toHaveLength(1)
    expect(feed.has('w1')).toBe(true)
  })

  it('messageIdOf exposes the posted message id (for status-pin) and is null before paint / after finish', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({ bot, now: () => clock, firstPaintMinMs: 8000 })
    // Before paint: no message, no id to pin.
    clock = 5000
    await feed.update('w1', 'chat', view({ elapsedMs: 5000 }))
    expect(feed.messageIdOf('w1')).toBeNull()
    // After paint: id is the posted message the gateway pins.
    clock = 9000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000 }))
    // The fake mints message ids starting at 1000; first paint → 1000.
    expect(feed.messageIdOf('w1')).toBe(1000)
    // After finish: handle is dropped → null (gateway unpins independently).
    await feed.finish('w1', view({ state: 'done' }))
    expect(feed.messageIdOf('w1')).toBeNull()
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
    expect(bot.edits[0].text).toContain('_done · 5 tools · ')
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
    expect(bot.sent[0].text).toContain('**→ read the brief**')

    clock = 11_000
    await feed.update('w1', 'chat', view({ toolCount: 2, latestSummary: 'scanned vendor A' }))
    clock = 12_000
    await feed.update('w1', 'chat', view({ toolCount: 3, latestSummary: 'scanned vendor B' }))

    const last = bot.edits.at(-1)!
    expect(last.text).toContain('~~_✓ read the brief_~~')
    expect(last.text).toContain('~~_✓ scanned vendor A_~~')
    expect(last.text).toContain('**→ scanned vendor B**')
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

  it('rolls the narrative block to the last WORKER_HISTORY_MAX lines (#3349)', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    const total = 9
    for (let i = 1; i <= total; i++) {
      clock += 1000
      await feed.update('w1', 'chat', view({ toolCount: i, latestSummary: `ln-${String(i).padStart(3, '0')}` }))
    }

    const last = bot.edits.at(-1)!
    expect(last.text.match(/[✓→]/g) ?? []).toHaveLength(WORKER_HISTORY_MAX)
    const firstVisible = total - WORKER_HISTORY_MAX + 1
    for (let i = 1; i < firstVisible; i++) expect(last.text).not.toContain(`ln-${String(i).padStart(3, '0')}`)
    for (let i = firstVisible; i <= total; i++) expect(last.text).toContain(`ln-${String(i).padStart(3, '0')}`)
  })

  it('the deeper 6-step trail does NOT add edits — one landed render per substantive step (#3349, no #3270 flood)', async () => {
    // Render-only change: edit frequency is a function of SUBSTANTIVE changes
    // (new narrative step), never of how many trail lines a render carries. Push
    // 8 distinct steps to a lone worker; with the edit floor at 0 exactly one
    // render lands per step: 1 send + 7 edits = 8 landed renders, regardless of
    // the 6-line trail depth. A widened window that re-fired edits would break
    // this (that is the #3270 flood we must not reintroduce).
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })
    for (let i = 1; i <= 8; i++) {
      clock += 1000
      await feed.update('w1', 'chat', view({ toolCount: i, latestSummary: `edit-step-${i}` }))
    }
    expect(bot.sent).toHaveLength(1)
    expect(bot.edits).toHaveLength(7)
    // Re-pushing the SAME newest step (no substance change) fires NO extra edit.
    clock += 1000
    await feed.update('w1', 'chat', view({ toolCount: 8, latestSummary: 'edit-step-8' }))
    expect(bot.edits).toHaveLength(7)
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
    expect(last.text).toContain('~~_✓ line A_~~')
    expect(last.text).toContain('~~_✓ line B_~~')
    expect(last.text).toContain('**→ line C**')
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

    // The feed message is per-(chat,thread) now (workers coalesce), so the
    // paint/edit lines are feed-scoped; the terminal `finish` line still names
    // the finishing worker + its state.
    expect(paint).toBeDefined()
    expect(paint).toContain('chat=chat-9')
    expect(paint).toContain('thread=7')
    expect(paint).toMatch(/msgId=\d+/)
    expect(paint).toMatch(/bytes=\d+/)

    expect(edit).toBeDefined()
    expect(edit).toContain('chat=chat-9')

    expect(finish).toBeDefined()
    expect(finish).toContain('agent=w-research')
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
  it('with 12 narrative lines, exactly the last WORKER_HISTORY_MAX render + a +N earlier header (#3349)', () => {
    const narrativeLines = Array.from({ length: 12 }, (_, i) => `stp-${String(i + 1).padStart(3, '0')}`)
    const out = renderWorkerActivity(view({ narrativeLines }))
    const firstVisible = 12 - WORKER_HISTORY_MAX + 1
    for (let i = firstVisible; i <= 12; i++) {
      expect(out).toContain(`stp-${String(i).padStart(3, '0')}`)
    }
    for (let i = 1; i < firstVisible; i++) {
      expect(out).not.toContain(`stp-${String(i).padStart(3, '0')}`)
    }
    // Overflow header now appears on the worker surface too.
    expect(out).toContain(`_✓ +${12 - WORKER_HISTORY_MAX} earlier…_`)
    expect(out).toContain('**→ stp-012**')
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
  it('with 12 pushes, only the last WORKER_HISTORY_MAX appear in the render (#3349)', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    for (let i = 1; i <= 12; i++) {
      clock += 1000
      await feed.update('w1', 'chat', view({ toolCount: i, latestSummary: `ln-${String(i).padStart(3, '0')}` }))
    }

    const last = bot.edits.at(-1)!
    const firstVisible = 12 - WORKER_HISTORY_MAX + 1
    for (let i = firstVisible; i <= 12; i++) {
      expect(last.text).toContain(`ln-${String(i).padStart(3, '0')}`)
    }
    for (let i = 1; i < firstVisible; i++) {
      expect(last.text).not.toContain(`ln-${String(i).padStart(3, '0')}`)
    }
    // The manager caps the in-memory narrative at WORKER_HISTORY_MAX, so the
    // render never sees overflow — no "+N earlier…" marker on the manager path
    // (it surfaces only on direct renderWorkerActivity calls with >6 lines).
    expect(last.text).not.toContain('earlier…')
    expect(last.text).toContain('**→ ln-012**')
  })
})

// ─── Worker heartbeat (option a — suffix-only, never opens a new message) ─────

describe('createWorkerActivityFeed — heartbeat', () => {
  it('(i) a tick fires a re-render with a climbing · Ns suffix showing the current step\'s OWN elapsed', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 2500,
      // Suffix-mechanics test: pin the elapsed-refresh cadence to the edit floor
      // so this exercises the classic 6s heartbeat suffix, not the coarse
      // flood-pacing cadence (covered by its own tests below).
      elapsedRefreshMs: 2500,
      heartbeatTickMs: 6000,
      // No real timer: drive ticks manually.
      setInterval: () => 1,
      clearInterval: () => {},
    })
    // First paint at elapsed 0 (firstPaintMin default 4000 — use 9000). The
    // narrative line 'pulling data' lands here, so the current step starts now.
    clock = 19_000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000, latestSummary: 'pulling data' }))
    expect(bot.sent).toHaveLength(1)
    const stepStart = clock // step began when the '→' line first appeared

    // Advance well past the per-step 10s gate so the heartbeat renders a suffix.
    clock = 32_000 // step is now 13s old; lastEditAt(19000)+13000 ≥ heartbeatTickMs
    feed.heartbeatTick()
    await feed.update('w1', 'chat', view({ elapsedMs: 22_000, latestSummary: 'pulling data' })).catch(() => {})
    // Drain the chain.
    await feed.update('w1', 'chat', view({ elapsedMs: 22_000, latestSummary: 'pulling data' }))
    const edit1 = bot.edits.find((e) => /· \d+s\*\*/.test(e.text))
    expect(edit1).toBeDefined()
    // The step suffix reflects the STEP's OWN elapsed (now - stepStart), NOT
    // the worker total — the header already carries the total.
    expect(edit1!.text).toContain(`· ${Math.floor((32_000 - stepStart) / 1000)}s`)
  })

  it('(i-a) suppresses the step suffix while the current step is younger than the 10s gate', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 2500,
      heartbeatTickMs: 6000,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    // Step begins here.
    clock = 19_000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000, latestSummary: 'pulling data' }))
    expect(bot.sent).toHaveLength(1)

    // Heartbeat only 7s into the step — under STEP_TIMER_MIN_MS (10s), so no
    // `· Ns` suffix on the '→' line yet (the header total still climbs).
    clock = 26_000
    feed.heartbeatTick()
    await feed.update('w1', 'chat', view({ elapsedMs: 16_000, latestSummary: 'pulling data' })).catch(() => {})
    await feed.update('w1', 'chat', view({ elapsedMs: 16_000, latestSummary: 'pulling data' }))
    const stepSuffixEdit = bot.edits.find((e) => /· \d+s\*\*/.test(e.text))
    expect(stepSuffixEdit).toBeUndefined()
  })

  it('(i-b) heartbeat repaint keeps the header master elapsed >= the step timer (same clock anchor)', async () => {
    // Ken-observed defect: the heartbeat computed a LIVE `· Ns` step suffix
    // from dispatchAtMs but re-rendered the header from the STALE
    // lastView.elapsedMs (frozen at the last watcher event), so the current
    // step's timer could read MORE than the card's master elapsed. Both must
    // derive from the same anchor at render time.
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      minEditIntervalMs: 2500,
      heartbeatTickMs: 6000,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    // First paint: view says elapsed 9s → dispatchAt = 19_000 - 9_000 = 10_000.
    clock = 19_000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000, latestSummary: 'pulling data' }))
    expect(bot.sent).toHaveLength(1)

    // No watcher events for a long stretch; the heartbeat repaints at 80s.
    clock = 80_000 // live elapsed = 70_000 ms = 1m10s
    feed.heartbeatTick()
    // Drain the handle's promise chain.
    await new Promise((r) => setTimeout(r, 0))

    const edit = bot.edits[bot.edits.length - 1]
    expect(edit).toBeDefined()
    // Header line 2 (`_{elapsed} · {n} tools_`) must show the LIVE master
    // elapsed — not the stale 9s from the last view.
    const headerMatch = /_(\d+(?:m\d+)?s) · \d+ tools?_/.exec(edit.text)
    expect(headerMatch, `no header elapsed in: ${edit.text}`).not.toBeNull()
    // Step suffix (`· Ns**`) on the in-progress line.
    const stepMatch = /· (\d+(?:m\d+)?s)\*\*/.exec(edit.text)
    expect(stepMatch, `no step suffix in: ${edit.text}`).not.toBeNull()

    const toMs = (s: string): number => {
      const m = /^(?:(\d+)m)?(\d+)s$/.exec(s)!
      return (m[1] ? Number(m[1]) * 60_000 : 0) + Number(m[2]) * 1000
    }
    const headerMs = toMs(headerMatch![1])
    const stepMs = toMs(stepMatch![1])
    // Outcome: both timers advance together off one anchor — the header is
    // live (not frozen at 9s) and the step never exceeds the master.
    expect(headerMs).toBeGreaterThanOrEqual(stepMs)
    expect(headerMs).toBe(70_000) // 1m10s — refreshed to the live value
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

  // ─── Prose-silent worker: first paint driven by the heartbeat ──────────────
  // The user-visible bug: a background worker that dives straight into quiet
  // work (a long `Bash` / `npm test`) fires ONE `sub_agent_tool_use` tick when
  // the command starts, then no more JSONL lines for the whole run. If that one
  // tick lands before `firstPaintMin` the paint is held — and pre-fix the
  // heartbeat skipped `messageId == null` handles, so nothing ever re-drove the
  // paint and the worker showed NOTHING for its entire run. The heartbeat now
  // performs the first paint once the held handle is past `firstPaintMin`.
  it('(vi) paints a prose-silent worker whose only tick arrived before firstPaintMin, via a later heartbeat', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 8000,
      heartbeatTickMs: 6000,
      minEditIntervalMs: 2500,
      // Heartbeat-liveness test: pin the elapsed-refresh cadence to the edit
      // floor so a later heartbeat repaints the climbing clock under the classic
      // 6s cadence (coarse flood-pacing is covered by its own tests below).
      elapsedRefreshMs: 2500,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    const drain = () => new Promise((r) => setTimeout(r, 0))

    // A single tool tick at 2s (the Bash invocation) — before firstPaintMin,
    // so the paint is held. This is the ONLY update the worker ever sends.
    clock = 2000
    await feed.update('w1', 'chat', view({ elapsedMs: 2000, toolCount: 1, latestSummary: '' }))
    expect(bot.sent).toHaveLength(0)
    expect(feed.messageIdOf('w1')).toBeNull()

    // A heartbeat still before firstPaintMin holds — trivial workers stay silent.
    clock = 6000
    feed.heartbeatTick()
    await drain()
    expect(bot.sent).toHaveLength(0)
    expect(feed.messageIdOf('w1')).toBeNull()

    // A heartbeat PAST firstPaintMin performs the first paint — the worker
    // becomes visible even though it never emitted prose or a second tick.
    clock = 12_000
    feed.heartbeatTick()
    await drain()
    expect(bot.sent).toHaveLength(1)
    expect(feed.messageIdOf('w1')).toBe(1000)
    expect(bot.sent[0].text).toContain('🛠 **WORKER**')

    // And it keeps updating: a later heartbeat edits the message with a
    // climbing `· Ns` suffix so the still-alive worker visibly advances.
    clock = 20_000
    feed.heartbeatTick()
    await drain()
    expect(bot.edits.length).toBeGreaterThanOrEqual(1)
    // No narrative step (prose-silent) → the advance shows in the header's
    // climbing master elapsed rather than a `· Ns` step suffix.
    expect(bot.edits[bot.edits.length - 1].text).toMatch(/_\d+s · 1 tool_/)
  })

  it('(vii) still holds a trivial sub-firstPaintMin worker silent (heartbeat never force-paints early)', async () => {
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 8000,
      heartbeatTickMs: 6000,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    const drain = () => new Promise((r) => setTimeout(r, 0))
    // Worker ticks once at 1s then finishes at 3s (handback covers it). No
    // heartbeat before firstPaintMin may paint it.
    clock = 1000
    await feed.update('w1', 'chat', view({ elapsedMs: 1000, toolCount: 1, latestSummary: '' }))
    clock = 3000
    feed.heartbeatTick()
    await drain()
    expect(bot.sent).toHaveLength(0)
    await feed.finish('w1', view({ state: 'done', toolCount: 1 }))
    // finish with no posted message → no recap edit (handback covers the result).
    expect(bot.edits).toHaveLength(0)
  })

  it('(viii) a finished, still-unpainted worker is NOT orphan-painted by a later heartbeat', async () => {
    // Regression guard: the heartbeat first-paint branch must never send a
    // fresh `running` message on an already-finished handle. finish() deletes
    // the handle; a subsequent heartbeat (even one past firstPaintMin) must
    // skip it — otherwise a permanently orphaned card that never finalizes.
    const bot = makeFakeBot()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 8000,
      heartbeatTickMs: 6000,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    const drain = () => new Promise((r) => setTimeout(r, 0))
    // One held tick before firstPaintMin — no paint yet.
    clock = 2000
    await feed.update('w1', 'chat', view({ elapsedMs: 2000, toolCount: 1, latestSummary: '' }))
    expect(bot.sent).toHaveLength(0)
    expect(feed.messageIdOf('w1')).toBeNull()
    // Worker finishes while still unpainted (finish drops the handle).
    await feed.finish('w1', view({ state: 'done', toolCount: 1 }))
    expect(feed.messageIdOf('w1')).toBeNull()
    // A heartbeat well past firstPaintMin must NOT paint a new message.
    clock = 20_000
    feed.heartbeatTick()
    await drain()
    expect(bot.sent).toHaveLength(0)
    expect(bot.edits).toHaveLength(0)
    expect(feed.messageIdOf('w1')).toBeNull()
  })
})

// ─── Resurrection guard + deferred finalize (review findings #2 & #3) ─────────
// #3: a late watcher onProgress tick arriving after `finish()` queued its
//    chain must NOT resurrect the handle and paint a fresh running message.
// #2: a terminal edit that hit a 429 cooldown stages on `pendingFinish` and
//    is re-driven by the heartbeat after cooldown — the card can't get stuck
//    on its last running render. "not modified" / message-gone are success/drop.
describe('createWorkerActivityFeed — resurrection guard + deferred finalize', () => {
  const drain = () => new Promise((r) => setTimeout(r, 0))

  it('#3: a late update tick after finish does not resurrect a running card', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })
    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'step one' }))
    expect(bot.sent).toHaveLength(1)

    await feed.finish('w1', view({ state: 'done', toolCount: 1, latestSummary: 'done result' }))
    // finish landed a terminal edit and dropped the handle.
    expect(bot.edits.some((e) => e.text.includes('_done ·'))).toBe(true)
    expect(feed.has('w1')).toBe(false)

    // Late watcher tick arrives AFTER finish. Pre-fix this would create a
    // fresh handle and paint a new running message on a finalized worker.
    clock = 12_000
    await feed.update('w1', 'chat', view({ toolCount: 2, latestSummary: 'step two' }))
    expect(bot.sent).toHaveLength(1) // no new running message
    expect(feed.has('w1')).toBe(false)
    expect(feed.size).toBe(0)
  })

  it('#3023: resurrect() reopens the paint path after a FALSE finish so a fresh cue repaints', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })
    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'step one' }))
    expect(bot.sent).toHaveLength(1)

    // The card is FALSELY finalized (silent-stall synthesis fired while the
    // worker was actually still alive).
    await feed.finish('w1', view({ state: 'done', toolCount: 1, latestSummary: 'premature done' }))
    expect(feed.has('w1')).toBe(false)

    // Without resurrect(), the finalized gate would swallow any further cue
    // (the #3 case above). Prove that first: a plain late tick is a no-op.
    clock = 12_000
    await feed.update('w1', 'chat', view({ toolCount: 2, latestSummary: 'still going' }))
    expect(bot.sent).toHaveLength(1)

    // The watcher detected the false finish and resurrected the worker.
    feed.resurrect('w1')

    // Now a running cue repaints a live card — active work is visible again.
    clock = 13_000
    await feed.update('w1', 'chat', view({ toolCount: 3, latestSummary: 'back to work' }))
    expect(bot.sent).toHaveLength(2) // a fresh card was painted
    expect(feed.has('w1')).toBe(true)
    expect(bot.sent[1].text).toContain('back to work')
  })

  it('#3373: a GENUINE terminal then a SendMessage resume re-surfaces a live card (resurrect+update), while an un-resumed terminal stays dead', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    // Worker runs, then GENUINELY completes (a real turn_end handback) — the
    // row is dropped and the agentId latched into the terminal `finalized` gate.
    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'step one' }))
    await feed.finish('w1', view({ state: 'done', toolCount: 1, latestSummary: 'real result' }))
    expect(feed.has('w1')).toBe(false)

    // Anti-zombie: with NO resume signal, later cues stay swallowed forever — a
    // genuinely-finished worker must never zombie-resurface on a stray tick.
    clock = 12_000
    await feed.update('w1', 'chat', view({ toolCount: 2, latestSummary: 'stray tick' }))
    expect(bot.sent).toHaveLength(1)
    expect(feed.has('w1')).toBe(false)

    // Now the worker is RESUMED via SendMessage: the watcher observes jsonl
    // growth past the terminal boundary (#3315) and fires onResume, which the
    // gateway wires to feed.resurrect — clearing the finalized latch.
    feed.resurrect('w1')

    // The resumed worker's next progress cue re-surfaces a fresh live card.
    clock = 13_000
    await feed.update('w1', 'chat', view({ toolCount: 3, latestSummary: 'resumed work' }))
    expect(bot.sent).toHaveLength(2)
    expect(feed.has('w1')).toBe(true)
    expect(bot.sent[1].text).toContain('resumed work')
  })

  it('#3023: resurrect() on a never-finalized worker is a harmless no-op', () => {
    const bot = makeFakeBot()
    const feed = createWorkerActivityFeed({ bot, now: () => 10_000 })
    // No throw, nothing painted.
    feed.resurrect('never-seen')
    expect(bot.sent).toHaveLength(0)
  })

  it('#2: a 429 on the finish edit stages pendingFinish; the heartbeat re-drives it after cooldown', async () => {
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
    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'running step' }))
    expect(bot.sent).toHaveLength(1)

    // The terminal edit hits a 429 with a 2s retry_after.
    bot.failNextEditWith = { error_code: 429, parameters: { retry_after: 2 } }
    await feed.finish('w1', view({ state: 'done', toolCount: 1, latestSummary: 'final result' }))
    await drain()
    // No terminal edit landed yet — the last edit is still the running render.
    expect(bot.edits.some((e) => e.text.includes('_done ·'))).toBe(false)

    // Inside the cooldown — a heartbeat tick must NOT retry (would re-429).
    clock = 11_000
    feed.heartbeatTick()
    await drain()
    expect(bot.edits.some((e) => e.text.includes('_done ·'))).toBe(false)

    // Past the cooldown (10_000 + 2000 + 500 jitter = 12_500) — the heartbeat
    // re-drives the deferred finalize and the terminal edit lands.
    clock = 13_000
    feed.heartbeatTick()
    await drain()
    expect(bot.edits.some((e) => e.text.includes('_done ·'))).toBe(true)
    expect(feed.has('w1')).toBe(false) // handle dropped after the terminal edit landed
  })

  it('#2: "message is not modified" on finish is treated as success (card already correct)', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })
    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'x' }))
    expect(bot.sent).toHaveLength(1)

    bot.failNextEditWith = new Error('Bad Request: message is not modified')
    await feed.finish('w1', view({ state: 'done', toolCount: 1, latestSummary: 'x' }))
    await drain()
    // The handle is dropped — the not-modified outcome is success, no retry.
    expect(feed.has('w1')).toBe(false)
  })

  it('#2: a gone message on finish drops the handle silently (no card to finalize)', async () => {
    const bot = makeFakeBot()
    const logs: string[] = []
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0, log: (m) => logs.push(m) })
    await feed.update('w1', 'chat', view({ toolCount: 1, latestSummary: 'x' }))
    expect(bot.sent).toHaveLength(1)

    bot.failNextEditWith = new Error('Bad Request: message to edit not found')
    await feed.finish('w1', view({ state: 'done', toolCount: 1, latestSummary: 'done' }))
    await drain()
    expect(feed.has('w1')).toBe(false)
    // No scary "finish edit failed" warning for a transport-gone outcome.
    expect(logs.some((l) => l.includes('finish edit failed'))).toBe(false)
  })
})

// ─── Extreme-edge: single oversized narrative line (no-truncate ON) ──────────
// Reproduces the bug where accumulateNarrative's char-budget splice would push
// the oversized line then immediately splice it out, making the narrative empty
// and the step vanish from the rendered output.

/**
 * Cheap valid-rich-markdown checker (post-#2669): the `**…**` wrappers the
 * worker renderer emits must be balanced, and no escape backslash may be left
 * dangling at the very end (it would swallow the following close marker). This
 * is the markdown analogue of the old "no partial HTML entity at a slice
 * boundary" check — a naive RAW-slice that split a `\*` escape would surface
 * here as an odd trailing-backslash count.
 */
function isValidWorkerMarkdown(s: string): boolean {
  const bold = (s.match(/\*\*/g) ?? []).length
  if (bold % 2 !== 0) return false
  const trailing = /(\\*)$/.exec(s)?.[1].length ?? 0
  if (trailing % 2 === 1) return false
  return true
}

describe('extreme-edge: single oversized narrative line (no-truncate ON)', () => {
  it('no-truncate ON: one ~4100-char step is shown (truncated) not discarded, output ≤ budget and valid markdown', async () => {
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
    expect(isValidWorkerMarkdown(out)).toBe(true)
  })

  it('no-truncate ON: one ~4100-char step via renderWorkerActivity directly → ≤ budget and valid markdown', () => {
    const base = 'compile && link && package && ship: action=deploy env=<prod> flag=1 '
    const hugeStep = base.repeat(65)
    expect(hugeStep.length).toBeGreaterThan(4000)

    const out = renderWorkerActivity(view({ narrativeLines: [hugeStep] }))

    // Step must be present in some form (truncated is fine, absent is not).
    const hasBullet = out.includes('→') || out.includes('✓')
    expect(hasBullet).toBe(true)

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerMarkdown(out)).toBe(true)
  })
})

// ─── Bug 2: fitCardToBudget must not slice already-escaped markdown ──────────
//
// Post-#2669 the wire format is GFM markdown. The same class of bug applies:
// the extreme budget fallback must truncate the RAW newest line first, THEN
// escape, THEN wrap — never slice an already-escaped string. A naive slice
// that landed right after an escape backslash (`\` from a `\*` escape) would
// leave a dangling backslash that swallows the bold close marker, producing
// `**→ …\**` → unbalanced. These tests place markdown specials at the slice
// boundary and assert the output stays valid (balanced ** + no dangling \).

describe('Bug 2 (#2506): fitCardToBudget does not split a markdown escape', () => {
  /**
   * Build a narrative line whose markdown-special character lands at roughly
   * the budget boundary so a naive escaped-string slice would cut a `\*`
   * escape in half.
   */
  function buildEscapeBoundaryLine(special: string, charBudget: number): string {
    const fillLen = Math.max(0, charBudget - 9)
    return 'x'.repeat(fillLen) + special + 'y'.repeat(50)
  }

  it("'*' at the budget boundary: output is valid markdown (balanced **, no dangling \\)", () => {
    const line = buildEscapeBoundaryLine('*', 4096)
    expect(line.length).toBeGreaterThan(100)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerMarkdown(out)).toBe(true)
    expect(out).not.toMatch(/\\$/) // no dangling escape backslash at the end
  })

  it("'_' at the budget boundary: output is valid markdown", () => {
    const line = buildEscapeBoundaryLine('_', 4096)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerMarkdown(out)).toBe(true)
    expect(out).not.toMatch(/\\$/)
  })

  it("'`' (code span) at the budget boundary: output is valid markdown", () => {
    const line = buildEscapeBoundaryLine('`', 4096)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerMarkdown(out)).toBe(true)
    expect(out).not.toMatch(/\\$/)
  })

  it('special-dense line (* _ ` ~ interleaved): output ≤ budget and valid markdown', () => {
    // Mix markdown specials throughout so any slice position is dangerous.
    const chunk = '*' + 'x'.repeat(3) + '_' + 'y'.repeat(3) + '`' + 'z'.repeat(3)
    const line = chunk.repeat(500) // ~10k chars raw → well over budget after escape
    expect(line.length).toBeGreaterThan(4000)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerMarkdown(out)).toBe(true)
    expect(out).not.toMatch(/\\$/)
  })

  it('single special alone in a huge line: valid markdown and within budget', () => {
    const line = 'x'.repeat(3000) + '*' + 'x'.repeat(1000)
    expect(line.length).toBeGreaterThan(4000)

    const out = renderWorkerActivity(view({ narrativeLines: [line] }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(isValidWorkerMarkdown(out)).toBe(true)
    expect(out).not.toMatch(/\\$/)
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

    expect(out).toContain('🛠 **WORKER**')
    // Unified running status line.
    expect(out).toContain('_10s · 7 tools_')
    expect(out).toContain('7 tools')
    // Every rendered line was clipped to STATUS_LINE_MAX → output well within budget.
    expect(out.length).toBeLessThanOrEqual(4096)
    // Newest bullet is the live → step.
    expect(out).toContain('**→ final short step**')
  })

  it('a "+N earlier…" rolling marker appears when more than STATUS_ROLLING_LINES lines render', () => {
    const narrativeLines = Array.from({ length: STATUS_ROLLING_LINES + 2 }, (_, i) => `step ${i + 1}`)
    const out = renderWorkerActivity(view({ narrativeLines }))

    expect(out.length).toBeLessThanOrEqual(4096)
    expect(out).toContain('earlier…')
    expect(out).toContain('🛠 **WORKER**')
    expect(out).toContain('_10s · ')
  })

  it('back-compat path (latestSummary only) still shows a step bullet, clipped + valid markdown', () => {
    const hugeSummary = 'deploy service && run migrations && verify health checks '.repeat(80)
    expect(hugeSummary.length).toBeGreaterThan(4000)

    const out = renderWorkerActivity(
      view({ narrativeLines: undefined, latestSummary: hugeSummary }),
    )

    expect(out.length).toBeLessThanOrEqual(4096)
    const hasBullet = out.includes('→') || out.includes('✓')
    expect(hasBullet).toBe(true)
    expect(out).toContain('🛠 **WORKER**')
    expect(out).toContain('_10s · ')
    expect(isValidWorkerMarkdown(out)).toBe(true)
  })
})

// ─── Dedup — non-adjacent repeats within the rolling window (unified cards) ──

describe('narrative dedup — non-adjacent repeats collapse (A,B,A)', () => {
  it('a line already in the rolling window is not re-appended', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    // The live-observed duplication: a preamble ("Look for nested subagents
    // structure") surfaces, another step lands, then the same text re-fires
    // (e.g. as the Task tool's describeToolUse label for the same step).
    const seq = [
      'Look for nested subagents structure',
      'Inspect subagents dir files',
      'Look for nested subagents structure', // non-adjacent repeat — must collapse
      'Inspect subagents dir files',         // non-adjacent repeat — must collapse
      'Tail the child jsonl',
    ]
    for (const line of seq) {
      clock += 1000
      await feed.update('w-dedup', 'chat', view({ latestSummary: line }))
    }

    const last = bot.edits.at(-1) ?? bot.sent.at(-1)!
    const count = (needle: string): number => last.text.split(needle).length - 1
    expect(count('Look for nested subagents structure')).toBe(1)
    expect(count('Inspect subagents dir files')).toBe(1)
    expect(last.text).toContain('Tail the child jsonl')
    // Source order preserved: first occurrence wins its slot.
    expect(last.text.indexOf('Look for nested subagents structure'))
      .toBeLessThan(last.text.indexOf('Inspect subagents dir files'))
  })

  it('a legitimate revisit re-appears once the earlier copy scrolls out of the window', async () => {
    const bot = makeFakeBot()
    let clock = 10_000
    const feed = createWorkerActivityFeed({ bot, now: () => clock, minEditIntervalMs: 0 })

    await feed.update('w2', 'chat', view({ latestSummary: 'step-repeat' }))
    // Push WORKER_HISTORY_MAX distinct lines so 'step-repeat' scrolls out (#3349).
    for (let i = 0; i < WORKER_HISTORY_MAX; i++) {
      clock += 1000
      await feed.update('w2', 'chat', view({ latestSummary: `filler-${i}` }))
    }
    clock += 1000
    await feed.update('w2', 'chat', view({ latestSummary: 'step-repeat' }))
    const last = bot.edits.at(-1)!
    expect(last.text).toContain('step-repeat')
  })
})

// ─── send-gate shed contract (#3174) ────────────────────────────────────────
//
// The feed's send/edit adapters transit the deterministic send gate
// (telegram-plugin/send-gate.ts, #3084), wired at the robustApiCall layer. The
// gate SHEDS a call — resolves `undefined` WITHOUT hitting the API — when a
// flood window is open (or a `useful` send exceeds its queue TTL, or a cosmetic
// edit finds no free token). Before this fix the first-paint path dereferenced
// `sent.message_id` on that `undefined`, throwing every heartbeat tick (~6s) for
// the whole ban — 578 `undefined is not an object (evaluating 'sent.message_id')`
// crashes in one 6h flood ban on 2026-07-12. These tests pin the shed contract:
// (a) an open flood window parks the handle and makes ZERO api calls; (b) an
// undefined send is treated as NOT-delivered (no crash, no phantom message id);
// (c)/(d) an undefined edit is not recorded as on-screen (shed honesty, mirroring
// PR #3173) so the update re-sends once the gate clears.

interface GateBot extends BotApiForWorkerFeed {
  /** Times sendMessage was INVOKED (attempts), delivered or shed. */
  sendCalls: number
  /** Times editMessageText was INVOKED (attempts), delivered or shed. */
  editCalls: number
  /** DELIVERED sends (gate admitted). */
  sent: Array<{ text: string }>
  /** DELIVERED edits (gate admitted). */
  edits: Array<{ messageId: number; text: string }>
  /**
   * One-shot: shed the next send even with the window closed. Faithful to the
   * gate: a worker-feed SEND is `useful` (never `cosmetic`), so a gate that
   * can't admit it resolves `undefined` (queue-TTL `expired`) — NEVER the
   * cosmetic-only SEND_GATE_SHED sentinel. The feed's send-shed detection is
   * structural (`typeof sent.message_id !== 'number'`), catching either.
   */
  shedNextSend: boolean
  /**
   * One-shot: shed the next EDIT even with the window closed. Faithful to the
   * gate: worker-feed edits are `cosmetic`, so a gate shed resolves the
   * distinguishable SEND_GATE_SHED sentinel (#3110 F1) — NOT `undefined` (which
   * the gate reserves for a benign no-op drop whose payload IS on screen).
   */
  shedNextEdit: boolean
}

/**
 * A bot adapter that models the send gate: it SHEDS (without recording a
 * delivery) whenever the injected flood probe reports an open window, or a
 * one-shot `shedNext*` flag is set (the race where the window opens between the
 * feed's probe read and the send). Faithful to the post-#3110 contract: a shed
 * EDIT resolves the SEND_GATE_SHED sentinel (cosmetic shed), a shed SEND
 * resolves `undefined` (`useful` queue-TTL expiry). A DELIVERED edit resolves a
 * non-shed value (`{}` — grammy returns `true`/`Message`).
 */
function makeGateBot(floodRemaining: () => number): GateBot {
  let nextId = 1000
  const gb: GateBot = {
    sendCalls: 0,
    editCalls: 0,
    sent: [],
    edits: [],
    shedNextSend: false,
    shedNextEdit: false,
    sendMessage: async (_chatId, text) => {
      gb.sendCalls++
      if (floodRemaining() > 0 || gb.shedNextSend) {
        gb.shedNextSend = false
        return undefined as unknown as { message_id: number }
      }
      gb.sent.push({ text })
      return { message_id: nextId++ }
    },
    editMessageText: async (_chatId, messageId, text) => {
      gb.editCalls++
      if (floodRemaining() > 0 || gb.shedNextEdit) {
        gb.shedNextEdit = false
        return SEND_GATE_SHED as unknown as undefined
      }
      gb.edits.push({ messageId, text })
      return {}
    },
  }
  return gb
}

describe('worker-feed send-gate shed contract', () => {
  it('makes ZERO api calls while a flood window is open, then paints full state after it closes', async () => {
    let clock = 0
    const untilTs = 6 * 60 * 60 * 1000 // a 6h ban, as observed 2026-07-12
    const probe = () => Math.max(0, untilTs - clock)
    const bot = makeGateBot(probe)
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      floodWaitRemainingMs: probe,
    })

    // Drive the heartbeat cadence hammering the feed for the whole ban.
    for (let i = 0; i < 30; i++) {
      clock += 6000
      await feed.update('w1', 'chat', view({ elapsedMs: clock }))
    }
    // Parked on the window — never even called the API (the whole point).
    expect(bot.sendCalls).toBe(0)
    expect(bot.sent).toHaveLength(0)
    expect(feed.has('w1')).toBe(false)

    // Window closes: the next tick paints full state exactly once.
    clock = untilTs + 1000
    await feed.update('w1', 'chat', view({ elapsedMs: clock }))
    expect(bot.sendCalls).toBe(1)
    expect(bot.sent).toHaveLength(1)
    expect(bot.sent[0].text).toContain('🛠 **WORKER**')
    expect(feed.has('w1')).toBe(true)
  })

  it('treats an undefined send result as not-delivered — no crash, no phantom message id', async () => {
    let clock = 10_000
    const logs: string[] = []
    const bot = makeGateBot(() => 0) // probe reads clear …
    bot.shedNextSend = true // … but the gate sheds this send (race)
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      floodWaitRemainingMs: () => 0,
      log: (m) => logs.push(m),
    })

    await feed.update('w1', 'chat', view())
    expect(bot.sendCalls).toBe(1) // it attempted the send
    expect(bot.sent).toHaveLength(0) // but nothing was delivered
    expect(feed.messageIdOf('w1')).toBeNull() // and no phantom message id recorded
    expect(feed.has('w1')).toBe(false)
    // Regression pin: the old code dereferenced `undefined.message_id` and logged
    // it as a hard "send failed"; the shed is now a recognized, clean skip.
    expect(logs.some((l) => l.startsWith('worker-feed: send failed'))).toBe(false)
    expect(logs.some((l) => l.includes('shed by send gate'))).toBe(true)

    // The next paint (gate no longer shedding) lands cleanly.
    clock = 20_000
    await feed.update('w1', 'chat', view())
    expect(bot.sent).toHaveLength(1)
    expect(feed.has('w1')).toBe(true)
  })

  it('does not record a shed cosmetic edit as on-screen — the update re-sends after the gate clears', async () => {
    let clock = 10_000
    const bot = makeGateBot(() => 0)
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
      floodWaitRemainingMs: () => 0,
    })

    await feed.update('w1', 'chat', view({ toolCount: 1 }))
    expect(bot.sent).toHaveLength(1)

    // Gate sheds the edit (undefined) — it is NOT on screen.
    clock = 20_000
    bot.shedNextEdit = true
    await feed.update('w1', 'chat', view({ toolCount: 2 }))
    expect(bot.editCalls).toBe(1)
    expect(bot.edits).toHaveLength(0)

    // Shed honesty: the SAME update re-sends once the gate clears — the shed
    // payload was never recorded as `lastBody`, so it is not dropped as a dup.
    clock = 30_000
    await feed.update('w1', 'chat', view({ toolCount: 2 }))
    expect(bot.edits).toHaveLength(1)
    expect(bot.edits[0].text).toContain('2 tools')
  })

  it('a shed terminal edit drops the finished row immediately but stages the recap for a heartbeat re-drive (#3207)', async () => {
    let clock = 10_000
    const bot = makeGateBot(() => 0)
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
      floodWaitRemainingMs: () => 0,
      setInterval: () => 1,
      clearInterval: () => {},
    })

    await feed.update('w1', 'chat', view({ toolCount: 1 }))
    expect(bot.sent).toHaveLength(1)

    // Gate sheds the terminal edit (SEND_GATE_SHED sentinel).
    clock = 20_000
    bot.shedNextEdit = true
    await feed.finish('w1', view({ state: 'done', toolCount: 5 }))
    expect(bot.editCalls).toBe(1)
    expect(bot.edits).toHaveLength(0)
    // #3207: the finished row is dropped RIGHT AWAY — it is NOT kept alive to
    // leak the group/pin when the terminal edit fails. The recap is staged for
    // the heartbeat re-drive instead (a second finish() would be a no-op: the
    // agent is already finalized + removed).
    expect(feed.has('w1')).toBe(false)
    expect(feed.size).toBe(0)

    // A heartbeat with the gate clear re-drives the staged recap → it lands.
    clock = 30_000
    feed.heartbeatTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(bot.edits).toHaveLength(1)
    expect(bot.edits[0].text).toContain('_done · 5 tools')
    expect(feed.has('w1')).toBe(false)
  })
})

// ─── elapsed-only edit pacing (flood-ban defense, Part 1) ────────────────────

describe('createWorkerActivityFeed — elapsed-only edit pacing', () => {
  const drain = () => new Promise((r) => setTimeout(r, 0))

  function mkFeed(bot: FakeBot, nowRef: { t: number }) {
    return createWorkerActivityFeed({
      bot,
      now: () => nowRef.t,
      minEditIntervalMs: 2500,
      elapsedRefreshMs: 15_000,
      firstPaintMinMs: 8000,
      heartbeatTickMs: 6000,
      setInterval: () => 1,
      clearInterval: () => {},
    })
  }

  it('suppresses clock-only churn: elapsed advancing within elapsedRefreshMs emits NO edit', async () => {
    const bot = makeFakeBot()
    const ref = { t: 10_000 }
    const feed = mkFeed(bot, ref)

    // First paint.
    ref.t = 20_000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000, latestSummary: 'scanning', toolCount: 3 }))
    expect(bot.sent).toHaveLength(1)

    // A stream of ticks where ONLY the elapsed clock advances (same step, same
    // toolCount). Every one is past the 2.5s edit floor but under the 15s
    // elapsed-refresh cadence measured from the last edit (paint @20_000) — so
    // the send-gate-evading clock-only edit that earns a flood ban never fires.
    for (const t of [23_000, 26_000, 30_000, 34_000]) {
      ref.t = t
      await feed.update('w1', 'chat', view({ elapsedMs: t - 11_000, latestSummary: 'scanning', toolCount: 3 }))
    }
    await drain()
    expect(bot.edits).toHaveLength(0)
  })

  it('renders a substantive step change PROMPTLY (before the elapsed-refresh cadence)', async () => {
    const bot = makeFakeBot()
    const ref = { t: 10_000 }
    const feed = mkFeed(bot, ref)

    ref.t = 20_000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000, latestSummary: 'scanning', toolCount: 3 }))
    expect(bot.sent).toHaveLength(1)

    // 6s later: still under the 15s elapsed-refresh cadence, but the STEP and
    // toolCount changed — a real update. It renders immediately (only the 2.5s
    // floor applies), not held for the coarse clock cadence.
    ref.t = 26_000
    await feed.update('w1', 'chat', view({ elapsedMs: 15_000, latestSummary: 'writing report', toolCount: 4 }))
    await drain()
    expect(bot.edits.length).toBeGreaterThanOrEqual(1)
    expect(bot.edits[bot.edits.length - 1].text).toContain('writing report')
  })

  it('forces the terminal edit through and renders the honest final elapsed', async () => {
    const bot = makeFakeBot()
    const ref = { t: 10_000 }
    const feed = mkFeed(bot, ref)

    ref.t = 20_000
    await feed.update('w1', 'chat', view({ elapsedMs: 9000, latestSummary: 'scanning', toolCount: 3 }))
    expect(bot.sent).toHaveLength(1)

    // Completion within the elapsed-refresh window still finalizes immediately
    // (terminal edits bypass the pacing) and shows the correct final elapsed.
    ref.t = 28_000
    await feed.finish('w1', view({ state: 'done', toolCount: 6, elapsedMs: 31_000, latestSummary: 'all done' }))
    await drain()
    expect(bot.edits.length).toBeGreaterThanOrEqual(1)
    const last = bot.edits[bot.edits.length - 1].text
    expect(last).toContain('done · 6 tools')
    expect(last).toContain('31s')
  })

  it('does not over-suppress a substantive change that would field-boundary-collide under naive concatenation', async () => {
    const bot = makeFakeBot()
    const ref = { t: 10_000 }
    const feed = mkFeed(bot, ref)

    // Paint: toolCount 1, totalTokens 23. Under a delimiter-less substance key
    // the fields `1` and `23` concatenate to `123`.
    ref.t = 20_000
    await feed.update(
      'w1',
      'chat',
      view({ elapsedMs: 9000, latestSummary: 'scanning', toolCount: 1, totalTokens: 23 }),
    )
    expect(bot.sent).toHaveLength(1)

    // A REAL substantive change (toolCount 1→12, totalTokens 23→3) that collides
    // to the SAME `123` under naive concatenation. It lands within the 15s
    // elapsed-refresh window (past the 2.5s floor), so ONLY a substance-key
    // difference can drive the edit. A colliding key would wrongly treat this as
    // elapsed-only churn and suppress it; the NUL/RS-delimited key keeps them
    // distinct, so the edit fires promptly.
    ref.t = 22_500
    await feed.update(
      'w1',
      'chat',
      view({ elapsedMs: 11_500, latestSummary: 'scanning', toolCount: 12, totalTokens: 3 }),
    )
    await drain()
    expect(bot.edits.length).toBeGreaterThanOrEqual(1)
    // The rendered card reflects the new tool count, proving the change landed.
    expect(bot.edits[bot.edits.length - 1].text).toContain('12 tools')
  })
})
