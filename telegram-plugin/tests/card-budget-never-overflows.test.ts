import { describe, it, expect } from 'vitest'
import { renderStatusCard, renderCombinedWorkerFeed } from '../tool-activity-summary.js'
import { fitCardToBudget, hardTruncateCard, renderCardSpec } from '../card-layout.js'
import { STATUS_CARD_CHAR_BUDGET } from '../status-no-truncate.js'

/**
 * #3833 (and its duplicate #3682) — a rendered card must NEVER exceed
 * `STATUS_CARD_CHAR_BUDGET`. An over-budget card is not a cosmetic problem: it
 * is rejected by the Bot API, so the user's progress card simply does not
 * appear (or stops updating) for the whole turn.
 *
 * Two defects produced over-budget cards, and both are asserted here:
 *
 *  1. UNDER-COUNTED FIXED COST. The deepest shrink level charged its
 *     header/footer as `[...chrome, ...footer].join('\n')`, but cards are
 *     rendered by `stackCard`, which emits a collapse separator plus a
 *     two-space GFM hard break at every line boundary — 4 chars per boundary,
 *     not 1 — and it also charges the collapsed parent-marker line. The budget
 *     the fitter handed the body was therefore too generous and the card came
 *     out a few chars over.
 *
 *  2. NO RE-CHECK ON THE LAST RESORT. `fitCardToBudget` returned the deepest
 *     render unmeasured. When the FIXED chrome alone is over budget (the #3682
 *     repro: a 40k-char worker description), no shrink level can help — every
 *     level keeps the chrome — so a 40k-char card went to the wire.
 */

const HEADER = { emoji: '🛠', label: 'Worker', elapsedMs: 61_000, toolCount: 7, state: 'running' as const }

function card(opts: { desc?: string; steps?: string[]; children?: string[]; final?: boolean; result?: string }): string {
  return renderStatusCard({
    header: { ...HEADER, description: opts.desc ?? 'a task', state: opts.final === true ? 'done' : 'running' },
    steps: opts.steps ?? ['step one'],
    childSteps: opts.children,
    final: opts.final ?? false,
    stepCount: 3,
    result: opts.result != null ? { emoji: '✅', text: opts.result } : undefined,
  })!
}

describe('a rendered card never exceeds the char budget (#3833 / #3682)', () => {
  it('the #3682 repro — a 40k-char description — comes back under budget', () => {
    // Fail-before: 40069 chars against a 32768 budget on origin/main.
    const out = card({ desc: 'd'.repeat(40_000), steps: ['x'.repeat(4_000)], children: ['y'.repeat(4_000)] })
    expect(out.length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
    // And it is still a card, not an empty string.
    expect(out.length).toBeGreaterThan(100)
    expect(out.startsWith('🛠')).toBe(true)
  })

  it('the join-cost under-count boundary — every description length near the budget fits', () => {
    // Fail-before: on origin/main the lengths 32693…32800 each rendered 1…98
    // chars OVER budget. That band is exactly the fixed-cost under-count: the
    // renderer's per-boundary separator + hard break, which the arithmetic
    // estimate charged as one newline.
    const over: Array<{ n: number; by: number }> = []
    for (let n = 32_600; n <= 32_900; n++) {
      const out = card({ desc: 'd'.repeat(n), steps: ['a', 'b', 'c'], result: 'done' })
      if (out.length > STATUS_CARD_CHAR_BUDGET) over.push({ n, by: out.length - STATUS_CARD_CHAR_BUDGET })
    }
    expect(over).toEqual([])
  })

  it('PROPERTY: no combination of description / steps / children / result overflows', () => {
    // A deterministic sweep over the shape space rather than a handful of
    // hand-picked cases: the guarantee is universal, so the test is too.
    //
    // Fillers matter as much as sizes — escaping EXPANDS text (`&` → `&amp;`
    // is 5×, markdown specials are 2×), which is what the fitter's clip loop
    // has to converge against, and `👍` is astral so a naive slice could split
    // a surrogate pair.
    //
    // Every filler is swept at the small/medium sizes; the huge sizes (where a
    // single render costs seconds purely in `escapeMarkdown`, unchanged by this
    // PR) are swept with the cheap-but-still-expanding fillers.
    const cases: Array<{ size: number; fill: string }> = []
    for (const size of [0, 1, 7, 200, 4_000, 16_000]) {
      for (const fill of ['x', '&', '_*[`', '👍', 'é']) cases.push({ size, fill })
    }
    for (const size of [32_700, 33_000, 90_000]) {
      for (const fill of ['x', '&', '👍']) cases.push({ size, fill })
    }
    for (const { size, fill } of cases) {
      const blob = fill.repeat(Math.ceil(size / fill.length)).slice(0, size)
      for (const final of [false, true]) {
        for (const withChildren of [false, true]) {
          const out = renderStatusCard({
            header: { ...HEADER, description: blob, state: final ? 'done' : 'running' },
            steps: [blob, blob, 'plain step'],
            childSteps: withChildren ? [blob, blob] : undefined,
            final,
            liveSuffix: ' · 22s',
            stepCount: 12,
            result: { emoji: '✅', text: blob },
          })
          if (out == null) continue
          expect(
            out.length,
            `over budget: size=${size} fill=${JSON.stringify(fill)} final=${final} children=${withChildren}`,
          ).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
          // Never blanked, and never sliced through a surrogate pair.
          expect(out.length).toBeGreaterThan(0)
          expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false)
        }
      }
    }
  }, 60_000)

  it('PROPERTY: the combined worker card also stays under budget for any fan-out', () => {
    for (const rows of [1, 2, 6, 25]) {
      for (const size of [50, 5_000, 40_000]) {
        const out = renderCombinedWorkerFeed(
          Array.from({ length: rows }, (_, i) => ({
            ordinal: i + 1,
            description: 'w'.repeat(size),
            currentStep: 's'.repeat(size),
            historyLines: ['h'.repeat(size), 'h2'],
            elapsedMs: 60_000,
            toolCount: 3,
          })),
          { maxRows: 8 },
        )!
        expect(out.length, `rows=${rows} size=${size}`).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
      }
    }
  })

  it('fitCardToBudget itself guarantees the budget even when every level overflows', () => {
    // The mechanism, isolated from any particular card: a build function whose
    // deepest level is still hopeless. Fail-before: this returned the raw
    // 50k-char render.
    const huge = 'q'.repeat(50_000)
    const out = fitCardToBudget(() => ({ spec: { chrome: [huge], sections: [], footer: [] } }), 3)
    expect(out.length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
    expect(out.length).toBeGreaterThan(0)
  })

  it('fitCardToBudget still returns the FIRST fitting level untouched', () => {
    // The backstop must not change the normal path: a level that fits is
    // returned byte-for-byte, and deeper levels are never built.
    const built: number[] = []
    const spec = { chrome: ['🛠 **Worker**'], sections: [], footer: ['_✓ 3 steps_'] }
    const out = fitCardToBudget((level) => {
      built.push(level)
      return { spec }
    }, 5)
    expect(built).toEqual([0])
    expect(out).toBe(renderCardSpec(spec))
  })

  it('hardTruncateCard cuts at a line boundary and never returns invalid UTF-16', () => {
    const lines = ['aaaa', 'bbbb', 'cccc'].join('  \n')
    // Budget lands inside the third line → cut back to the second boundary.
    const cut = hardTruncateCard(lines, 12)
    expect(cut.length).toBeLessThanOrEqual(12)
    expect(cut).toBe('aaaa  \nbbbb')
    // Under budget → identity.
    expect(hardTruncateCard(lines, 1000)).toBe(lines)
    // A single over-long line with an astral char at the cut → no lone surrogate.
    const astral = '👍'.repeat(50)
    const sliced = hardTruncateCard(astral, 11)
    expect(sliced.length).toBeLessThanOrEqual(11)
    expect(/[\uD800-\uDBFF]$/.test(sliced)).toBe(false)
  })
})
