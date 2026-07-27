/**
 * #3820 — the 🤖 agent card and the 🛠 worker card must not be visually
 * interchangeable when both are live in one chat.
 *
 * Both surfaces render through the SAME primitive (`renderStatusCard`,
 * tool-activity-summary.ts), so before this fix they were byte-for-byte the
 * same layout — two header lines, the identical `Ns · N tools · Nk tok · model`
 * stat row, the identical `✓`/`→` step trail — differing only by an emoji and
 * one word. When a parent narrates the task it delegated, the two cards' step
 * lines are literally identical strings and the pair reads as a duplicate
 * rather than as parent + child.
 *
 * These tests assert the RENDERED OUTPUT differs structurally, using the same
 * inputs on both surfaces so a shared-layout regression cannot pass:
 *   - the worker card's line 1 carries `└─ ` and the agent card's never does;
 *   - every later worker line carries the subordinate indent;
 *   - with identical step text and identical stats, NO line of one card equals
 *     any line of the other.
 *
 * Plus the Telegram-reality guards: the prefixes survive the real outbound
 * markdown guard (`richMessage`) byte-identical, the indent is not whitespace
 * under any trimming rule (the #3662 lesson), and `└─` is not a line-start
 * block-construct trigger.
 */
import { describe, it, expect } from 'vitest'
import {
  renderActivityFeed,
  renderStatusCard,
  renderCombinedWorkerFeed,
} from '../tool-activity-summary.js'
import { renderWorkerActivity, type WorkerActivityView } from '../worker-activity-feed.js'
import {
  SUBORDINATE_HEADER_PREFIX,
  SUBORDINATE_LINE_INDENT,
  WORKER_STEP_INDENT,
  STATUS_CARD_CHAR_BUDGET,
  nestSubordinateCardLines,
} from '../status-no-truncate.js'
import { richMessage } from '../rich-send.js'

/** Split a rendered card into display lines, dropping the hard-break padding. */
function lines(card: string): string[] {
  return card.split('\n').map((l) => l.replace(/[\u00A0 \t\r]+$/, ''))
}

/** The exact scenario from the issue: parent narrating the task it delegated. */
const STEPS = ['PR 2502 details', 'Commits since v0.8.5']

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

describe('#3820 agent vs worker card distinguishability', () => {
  it('marks the worker card subordinate on line 1 and never the agent card', () => {
    const agent = lines(agentCard())
    const worker = lines(renderWorkerActivity(workerView()))

    expect(worker[0].startsWith(SUBORDINATE_HEADER_PREFIX)).toBe(true)
    expect(agent[0].startsWith(SUBORDINATE_HEADER_PREFIX)).toBe(false)
    // The agent card stays flush at the left margin on EVERY line — it is the
    // parent, so nothing about it may read as nested.
    for (const l of agent) {
      expect(l.startsWith(SUBORDINATE_HEADER_PREFIX)).toBe(false)
      expect(l.startsWith(SUBORDINATE_LINE_INDENT)).toBe(false)
    }
  })

  it('indents every worker card line after line 1', () => {
    const worker = lines(renderWorkerActivity(workerView()))
    expect(worker.length).toBeGreaterThan(2)
    for (const l of worker.slice(1)) {
      expect(l.startsWith(SUBORDINATE_LINE_INDENT)).toBe(true)
    }
  })

  it('shares no rendered line between the two cards even with identical steps and stats', () => {
    // This is the issue's actual symptom: the parent narrates the task it
    // delegated, so the step text overlaps. On the pre-#3820 renderer the
    // stat row AND both step lines were byte-identical across the two cards.
    const agent = lines(agentCard())
    const worker = lines(renderWorkerActivity(workerView()))
    const overlap = agent.filter((a) => worker.includes(a))
    expect(overlap).toEqual([])
  })

  it('uses a high-contrast caps type label on the worker card only', () => {
    const agent = agentCard()
    const worker = renderWorkerActivity(workerView())
    expect(worker).toContain('🛠 **WORKER**')
    expect(agent).toContain('🤖 **Agent**')
    expect(agent).not.toContain('WORKER')
  })

  it('keeps the terminal (result-block) worker render subordinate too', () => {
    const worker = lines(
      renderWorkerActivity(
        workerView({ state: 'done', latestSummary: 'Rebased and opened the PR.' }),
      ),
    )
    expect(worker[0].startsWith(SUBORDINATE_HEADER_PREFIX)).toBe(true)
    for (const l of worker.slice(1)) {
      expect(l.startsWith(SUBORDINATE_LINE_INDENT)).toBe(true)
    }
    // The result block is present and nested, not floated back to the margin.
    expect(worker.some((l) => l.startsWith(`${SUBORDINATE_LINE_INDENT}✅ `))).toBe(true)
  })

  it('keeps the just-dispatched (starting…) worker render subordinate', () => {
    // The first state a user ever sees for a worker takes a hand-rolled append
    // path outside renderStatusCard — the one place a nesting fix can silently
    // miss.
    const worker = lines(
      renderWorkerActivity(workerView({ narrativeLines: [], latestSummary: '' })),
    )
    expect(worker[0].startsWith(SUBORDINATE_HEADER_PREFIX)).toBe(true)
    expect(worker[worker.length - 1]).toBe(`${SUBORDINATE_LINE_INDENT}_starting…_`)
  })

  it('nests the combined (2+ worker) card and keeps its internal hierarchy', () => {
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
    const l = lines(card as string)
    expect(l[0]).toBe(`${SUBORDINATE_HEADER_PREFIX}🛠 **WORKERS** · _2 running · oldest 55s · 13 tools_`)
    // Row headers sit at one level; their steps stay one level deeper, so the
    // card's own parent/child structure survives the shift right.
    const rowHeaders = l.filter((x) => x.includes('**1. ') || x.includes('**2. '))
    expect(rowHeaders.length).toBe(2)
    for (const h of rowHeaders) {
      expect(h.startsWith(SUBORDINATE_LINE_INDENT)).toBe(true)
      expect(h.startsWith(SUBORDINATE_LINE_INDENT + WORKER_STEP_INDENT)).toBe(false)
    }
    const stepLines = l.filter((x) => x.includes('→ ') || x.includes('✓ '))
    expect(stepLines.length).toBeGreaterThan(0)
    for (const s of stepLines) {
      expect(s.startsWith(SUBORDINATE_LINE_INDENT + WORKER_STEP_INDENT)).toBe(true)
    }
  })

  it('stays under the wire char budget on the subordinate over-budget path', () => {
    // fitCardToBudget has its own line assembly + its own arithmetic; the
    // per-line nesting cost must be charged there or an oversized worker card
    // can overflow the wire cap.
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
      subordinate: true,
    })
    expect(card).not.toBeNull()
    expect((card as string).length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
    expect((card as string).startsWith(SUBORDINATE_HEADER_PREFIX)).toBe(true)
  })

  it('leaves a non-subordinate card byte-identical to the un-nested render', () => {
    const opts = {
      header: {
        emoji: '🤖',
        label: 'Agent',
        elapsedMs: 1000,
        toolCount: 2,
        state: 'running' as const,
      },
      steps: STEPS,
    }
    expect(renderStatusCard({ ...opts, subordinate: false })).toBe(renderStatusCard(opts))
  })
})

describe('#3820 subordinate prefixes survive Telegram reality', () => {
  it('passes through the real outbound markdown guard byte-identical', () => {
    // richMessage() is the ONE adapter every `{ markdown }` wire send funnels
    // through (rich-send.ts) — it runs the line-start / heading / dollar-math
    // guards. A prefix that gets escaped there would render as literal markup.
    for (const card of [
      agentCard(),
      renderWorkerActivity(workerView()),
      renderCombinedWorkerFeed(
        [{ description: 'a', elapsedMs: 1, toolCount: 1, currentStep: 'b', ordinal: 1 }],
        { maxRows: 4 },
      ) as string,
    ]) {
      expect(richMessage(card).markdown).toBe(card)
    }
  })

  it('uses an indent that no whitespace-trimming rule can eat (#3662 lesson)', () => {
    // U+00A0 shipped in #3662 and was INERT: Telegram left-trims a leading
    // Unicode-whitespace run, and U+00A0 is category Zs. Assert the PROPERTY,
    // not the bytes — a byte-only assertion is what let #3662 ship green.
    for (const ch of Array.from(SUBORDINATE_LINE_INDENT)) {
      expect(/\s/.test(ch)).toBe(false)
      expect(/\p{White_Space}/u.test(ch)).toBe(false)
      expect(/\p{Zs}/u.test(ch)).toBe(false)
    }
  })

  it('uses a header prefix that is ink, not a line-start block trigger', () => {
    const first = SUBORDINATE_HEADER_PREFIX[0]
    // Not whitespace (would be trimmed), and not one of the GFM line-start
    // block-construct triggers guarded in render/line-start-guard.ts.
    expect(/\s/.test(first)).toBe(false)
    expect('#>-+*'.includes(first)).toBe(false)
    expect(/^\d+[.)]/.test(SUBORDINATE_HEADER_PREFIX)).toBe(false)
  })

  it('charges one flat per-line cost: header prefix and indent are equal length', () => {
    // fitCardToBudget's arithmetic depends on this invariant.
    expect(SUBORDINATE_HEADER_PREFIX.length).toBe(SUBORDINATE_LINE_INDENT.length)
  })

  it('nestSubordinateCardLines is pure and handles the empty case', () => {
    expect(nestSubordinateCardLines([])).toEqual([])
    expect(nestSubordinateCardLines(['a', 'b'])).toEqual([
      `${SUBORDINATE_HEADER_PREFIX}a`,
      `${SUBORDINATE_LINE_INDENT}b`,
    ])
  })
})
