/**
 * #3842 — every status card is FLUSH at the left margin, and the only
 * indentation any card carries is the step indent that separates one worker's
 * steps from the next worker's on the combined (2+ worker) card.
 *
 * #3820/#3821 had made the worker card structurally subordinate to the 🤖 agent
 * card: line 1 prefixed with `└─ ` and every later line indented by a U+2800
 * run. Ken rejected that shape — it burns a level of horizontal space on a
 * phone, and the worker card does not always sit below the agent card, so a
 * card-LEVEL subordination marker asserts a relationship that is not always
 * true. Net effect of this file's expectations: everything shifted left by one
 * level; worker-vs-worker separation is carried by the surviving step indent
 * plus the numbered row headers.
 *
 * These tests assert the RENDERED OUTPUT of the real renderers, and they fail
 * on the pre-#3842 shape (which put `└─ ` on line 1 and U+2800 on every other
 * line of both worker surfaces).
 *
 * What is NOT asserted here any more, deliberately: that no rendered line is
 * shared between the agent card and the worker card. With whole-card nesting
 * gone and identical step text, the two cards' BODY lines coincide byte for
 * byte — see the explicit characterization test at the end. Line 1 (🤖 `Agent`
 * vs 🛠 `WORKER`) is now the only type cue, which is the accepted trade.
 */
import { describe, it, expect } from 'vitest'
import {
  renderActivityFeed,
  renderStatusCard,
  renderCombinedWorkerFeed,
} from '../tool-activity-summary.js'
import { renderWorkerActivity, type WorkerActivityView } from '../worker-activity-feed.js'
import { WORKER_STEP_INDENT, STATUS_CARD_CHAR_BUDGET } from '../status-no-truncate.js'
import { richMessage } from '../rich-send.js'

/** Split a rendered card into display lines, dropping the hard-break padding. */
function lines(card: string): string[] {
  return card.split('\n').map((l) => l.replace(/[  \t\r]+$/, ''))
}

/** The exact scenario from #3820: parent narrating the task it delegated. */
const STEPS = ['PR 2502 details', 'Commits since v0.8.5']

/** The card-level chrome #3842 removed. Asserted absent, never re-emitted. */
const REMOVED_HEADER_PREFIX = '└─ '

function agentCard(): string {
  const out = renderActivityFeed(STEPS, false, '', undefined, {
    label: 'Agent',
    elapsedMs: 108_000,
    toolCount: 15,
    state: 'running',
    model: 'claude-opus-5',
    totalTokens: 16_400,
  })
  expect(out).not.toBeNull()
  return out as string
}

function workerView(over: Partial<WorkerActivityView> = {}): WorkerActivityView {
  return {
    description: 'Check upstream hindsight changes',
    elapsedMs: 108_000,
    toolCount: 15,
    latestSummary: '',
    narrativeLines: STEPS,
    state: 'running',
    model: 'claude-opus-5',
    totalTokens: 16_400,
    ...over,
  } as WorkerActivityView
}

function combinedCard(): string {
  const card = renderCombinedWorkerFeed(
    [
      {
        description: 'Check upstream hindsight changes',
        elapsedMs: 55_000,
        toolCount: 9,
        currentStep: 'Commits since v0.8.5',
        historyLines: STEPS,
        ordinal: 1,
      },
      {
        description: 'Fix the card renderer',
        elapsedMs: 30_000,
        toolCount: 4,
        currentStep: 'Reading render.ts',
        historyLines: ['Reading render.ts'],
        ordinal: 2,
      },
    ],
    { maxRows: 4 },
  )
  expect(card).not.toBeNull()
  return card as string
}

/** Every worker surface, in each of its render states, as rendered strings. */
function everyWorkerSurface(): Array<{ name: string; card: string }> {
  return [
    { name: 'running', card: renderWorkerActivity(workerView()) },
    {
      name: 'just dispatched',
      card: renderWorkerActivity(workerView({ narrativeLines: [], latestSummary: '' })),
    },
    {
      name: 'done + result block',
      card: renderWorkerActivity(
        workerView({ state: 'done', latestSummary: 'Rebased and opened the PR.' }),
      ),
    },
    {
      name: 'failed + result block',
      card: renderWorkerActivity(
        workerView({ state: 'failed', latestSummary: 'Scoped tests went red.' }),
      ),
    },
    {
      name: 'incomplete',
      card: renderWorkerActivity(workerView({ state: 'incomplete', latestSummary: '' })),
    },
    { name: 'combined (2 workers)', card: combinedCard() },
  ]
}

describe('#3842 every card is flush at the left margin', () => {
  it('emits no `└─ ` header prefix on any surface', () => {
    for (const { name, card } of [{ name: 'agent', card: agentCard() }, ...everyWorkerSurface()]) {
      expect(card.includes(REMOVED_HEADER_PREFIX), `${name} card carries └─`).toBe(false)
    }
  })

  it('leaves every line of the SINGLE-worker card unindented', () => {
    // Pre-#3842 line 1 started `└─ ` and lines 2..n started with a U+2800 run.
    const surfaces = everyWorkerSurface()
    for (const name of [
      'running',
      'just dispatched',
      'done + result block',
      'failed + result block',
      'incomplete',
    ]) {
      const card = surfaces.find((s) => s.name === name)?.card as string
      const l = lines(card)
      expect(l.length).toBeGreaterThan(1)
      for (const line of l) {
        expect(line.startsWith(WORKER_STEP_INDENT), `${name}: "${line}"`).toBe(false)
      }
    }
  })

  it('keeps the just-dispatched `starting…` tail flush too', () => {
    // The one render state a user always sees first takes a hand-rolled append
    // path outside renderStatusCard — the place a shape change silently misses.
    const l = lines(renderWorkerActivity(workerView({ narrativeLines: [], latestSummary: '' })))
    expect(l[0].startsWith('🛠 **WORKER**')).toBe(true)
    expect(l[l.length - 1]).toBe('_starting…_')
  })

  it('keeps the terminal result block flush', () => {
    const l = lines(
      renderWorkerActivity(
        workerView({ state: 'done', latestSummary: 'Rebased and opened the PR.' }),
      ),
    )
    expect(l.some((x) => x.startsWith('✅ '))).toBe(true)
    expect(l.some((x) => x.startsWith(`${WORKER_STEP_INDENT}✅ `))).toBe(false)
  })
})

describe('#3842 the combined card keeps exactly ONE level of indent', () => {
  it('puts the glance line and row headers flush', () => {
    const l = lines(combinedCard())
    expect(l[0]).toBe('🛠 **WORKERS** · _2 running · oldest 55s · 13 tools_')
    const rowHeaders = l.filter((x) => x.includes('**1. ') || x.includes('**2. '))
    expect(rowHeaders.length).toBe(2)
    for (const h of rowHeaders) expect(h.startsWith(WORKER_STEP_INDENT)).toBe(false)
  })

  it('indents step lines exactly one level — never two', () => {
    const l = lines(combinedCard())
    const stepLines = l.filter((x) => x.includes('→ ') || x.includes('✓ '))
    expect(stepLines.length).toBeGreaterThan(0)
    for (const s of stepLines) {
      expect(s.startsWith(WORKER_STEP_INDENT)).toBe(true)
      // The pre-#3842 double indent (SUBORDINATE_LINE_INDENT + WORKER_STEP_INDENT).
      expect(s.startsWith(WORKER_STEP_INDENT + WORKER_STEP_INDENT)).toBe(false)
    }
  })

  it('puts the `+M more working…` spill line flush', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      description: `task ${i + 1}`,
      elapsedMs: 10_000,
      toolCount: 1,
      currentStep: 'working',
      historyLines: ['working'],
      ordinal: i + 1,
    }))
    const card = renderCombinedWorkerFeed(rows, { maxRows: 2 }) as string
    const spill = lines(card).find((x) => x.includes('more working…'))
    expect(spill).toBe('_+3 more working…_')
  })
})

describe('#3842 char-budget accounting matches the flush shape', () => {
  it('keeps an oversized worker card under the wire budget', () => {
    // fitCardToBudget has its own line assembly + arithmetic. With the per-line
    // nest cost removed it must still land under the cap, and must not emit any
    // chrome the card no longer carries.
    const huge = Array.from({ length: 500 }, (_, i) => `${i} `.repeat(100))
    const card = renderStatusCard({
      header: {
        emoji: '🛠',
        label: 'WORKER',
        description: 'big',
        elapsedMs: 1000,
        toolCount: 1,
        state: 'running',
      },
      steps: huge,
      historyWindow: 6,
    })
    expect(card).not.toBeNull()
    const s = card as string
    expect(s.length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
    expect(s.includes(REMOVED_HEADER_PREFIX)).toBe(false)
    for (const l of lines(s)) expect(l.startsWith(WORKER_STEP_INDENT)).toBe(false)
  })

  it('keeps an oversized combined card under the wire budget', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      description: 'D'.repeat(72),
      elapsedMs: 10_000,
      toolCount: 3,
      currentStep: 'x',
      historyLines: Array.from({ length: 6 }, (_, k) => `${'s'.repeat(180)}-${i}-${k}`),
      ordinal: i + 1,
    }))
    const card = renderCombinedWorkerFeed(rows, { maxRows: 6 }) as string
    expect(card.length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
  })
})

describe('#3842 the surviving type cues', () => {
  it('uses a high-contrast caps type label on the worker card only', () => {
    const agent = agentCard()
    const worker = renderWorkerActivity(workerView())
    expect(worker).toContain('🛠 **WORKER**')
    expect(agent).toContain('🤖 **Agent**')
    expect(agent).not.toContain('WORKER')
  })

  it('distinguishes the two cards on LINE 1 — the only remaining cue', () => {
    // Characterization, not aspiration: with whole-card nesting gone and
    // identical step text + stats, the two cards' BODY lines coincide byte for
    // byte. Line 1 is doing all of the work, so it must never converge.
    const agent = lines(agentCard())
    const worker = lines(renderWorkerActivity(workerView()))
    expect(agent[0]).not.toBe(worker[0])
    expect(agent[0].startsWith('🤖 ')).toBe(true)
    expect(worker[0].startsWith('🛠 ')).toBe(true)
    // The documented cost of #3842, pinned so a future change to it is visible:
    // every line BELOW line 1 is now shared between the two cards.
    const overlap = agent.filter((a) => worker.includes(a))
    expect(overlap).toEqual(agent.slice(1))
  })
})

describe('#3842 the surviving step indent survives Telegram reality', () => {
  it('passes every card through the real outbound markdown guard byte-identical', () => {
    // richMessage() is the ONE adapter every `{ markdown }` wire send funnels
    // through (rich-send.ts) — it runs the line-start / heading / dollar-math
    // guards. Chrome that got escaped there would render as literal markup.
    for (const { card } of [{ card: agentCard() }, ...everyWorkerSurface()]) {
      expect(richMessage(card).markdown).toBe(card)
    }
  })

  it('uses an indent that no whitespace-trimming rule can eat (#3662 lesson)', () => {
    // U+00A0 shipped in #3662 and was INERT: Telegram left-trims a leading
    // Unicode-whitespace run, and U+00A0 is category Zs. Assert the PROPERTY,
    // not the bytes — a byte-only assertion is what let #3662 ship green.
    for (const ch of Array.from(WORKER_STEP_INDENT)) {
      expect(/\s/.test(ch)).toBe(false)
      expect(/\p{White_Space}/u.test(ch)).toBe(false)
      expect(/\p{Zs}/u.test(ch)).toBe(false)
    }
  })
})
