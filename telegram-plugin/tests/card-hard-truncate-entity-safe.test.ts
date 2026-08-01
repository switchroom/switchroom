import { describe, it, expect } from 'vitest'
import { hardTruncateCard } from '../card-layout.js'
import { truncateMarkdownSafe, safeMarkdownCut } from '../format.js'
import { validateRichMarkdown } from './rich-markdown-oracle.js'

/**
 * #4116 — the LAST-RESORT truncation must not be able to fail the send.
 *
 * `hardTruncateCard` is the path `fitCardToBudget` falls to when no shrink
 * level can get a card under `STATUS_CARD_CHAR_BUDGET` (the #3682 repro: a
 * 40k-char worker description, where every level keeps the same over-budget
 * chrome). Its single-over-budget-line branch used to slice the raw markdown
 * by character count. A cut landing between a `**` pair — or inside a
 * `` `code` `` span, a `[label](href)`, an open ``` fence, a `~~strike~~`, a
 * `||spoiler||` — emits a body Telegram parse-REJECTS with "can't find end of
 * the entity". So the code path whose whole purpose is to guarantee delivery
 * within budget could itself make the send fail.
 *
 * The fix routes the cut through `truncateMarkdownSafe`, which reuses the
 * chunker's existing entity-boundary reasoning (`safeMarkdownCut` =
 * fence → table row → inline span back-offs, plus surrogate-pair safety)
 * rather than adding a second markdown parser.
 *
 * These tests assert the OUTCOME — "the emitted text parses" — using the
 * repo's own parse-accept oracle (`rich-markdown-oracle.ts`, the same one the
 * formatting-regression suite trusts), at EVERY cut offset rather than at a
 * handful of hand-picked ones.
 */

/** A card body carrying one of every entity kind that can straddle a cut. */
const MIXED_ENTITY_CARD = [
  '🛠 **Worker · fix/telegram-w0-de** · 2m05s · 12 tools',
  '~~_✓ Read `telegram-plugin/card-layout.ts` and `format.ts`_~~',
  '**→ Rewriting the last-resort clip** with a [linked issue](https://github.com/switchroom/switchroom/issues/4116) inline',
  '⠀⠀⠀↳ _nested_ step with a ||spoiler|| and ~~a struck phrase~~ plus 👍🏽 astral text',
  '```ts',
  'const out = hardTruncateCard(text, budget)',
  'const safe = safeMarkdownCut(text, cut)',
  '```',
  'A trailing prose line with **bold**, `code`, _italic_ and an emoji 🧵 at the end.',
].join('\n')

describe('the source fixture is itself valid markdown', () => {
  it('guards the property test against a vacuous baseline', () => {
    // If the fixture were already invalid, "every truncation is valid" could
    // only ever fail — or, worse, a broken oracle would make it vacuously pass.
    expect(validateRichMarkdown(MIXED_ENTITY_CARD)).toEqual([])
  })
})

describe('PROPERTY: hardTruncateCard emits parseable markdown at every offset (#4116)', () => {
  it('every budget from 1 to the full length yields a card Telegram can parse', () => {
    const failures: Array<{ budget: number; kinds: string[]; tail: string }> = []
    for (let budget = 1; budget <= MIXED_ENTITY_CARD.length; budget++) {
      const out = hardTruncateCard(MIXED_ENTITY_CARD, budget)
      const issues = validateRichMarkdown(out)
      if (issues.length > 0) {
        failures.push({
          budget,
          kinds: [...new Set(issues.map((i) => i.kind))],
          tail: out.slice(-24),
        })
      }
    }
    // Fail-before on origin/main: every offset whose cut lands inside a `**`
    // pair / code span / link / fence produces an unsendable card.
    expect(failures).toEqual([])
  })

  it('every truncation stays within its budget and is valid UTF-16', () => {
    for (let budget = 1; budget <= MIXED_ENTITY_CARD.length; budget++) {
      const out = hardTruncateCard(MIXED_ENTITY_CARD, budget)
      expect(out.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
      // No lone surrogate — a split astral char is invalid UTF-16 on the wire.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), `budget ${budget}`).toBe(false)
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), `budget ${budget}`).toBe(false)
    }
  })

  it('a clipped card is still a card — it never collapses to (nearly) nothing', () => {
    // The clip exists because "a clipped card beats no card". A back-off that
    // retreated past a huge entity could return an empty string, which is the
    // dropped card all over again. From a budget with room for real content,
    // at least half of it survives — minus the handful of delimiter characters
    // an opener-drop repair removes (measured worst case on this fixture: 8).
    const REPAIR_SLACK = 12
    for (let budget = 24; budget <= MIXED_ENTITY_CARD.length; budget++) {
      const out = hardTruncateCard(MIXED_ENTITY_CARD, budget)
      expect(out.length * 2 + REPAIR_SLACK, `budget ${budget}`).toBeGreaterThanOrEqual(budget)
    }
  })
})

describe('the specific entity kinds that can straddle a cut (#4116)', () => {
  const cases: Array<[string, string]> = [
    ['bold', 'lead in **a bold run that is long enough to straddle** tail'],
    ['italic-underscore', 'lead in _an italic run long enough to straddle_ tail'],
    ['bold-italic', 'lead in ***a bold-italic run long enough to straddle*** tail'],
    ['inline code', 'lead in `a code span long enough to straddle the cut` tail'],
    ['link', 'lead in [a label](https://example.com/a/long/path/here) tail'],
    ['strikethrough', 'lead in ~~a struck run long enough to straddle~~ tail'],
    ['spoiler', 'lead in ||a spoiler run long enough to straddle|| tail'],
    ['table row', 'lead in\n| col a | col b | col c | col d |\ntail'],
    ['fenced block', 'lead in\n```ts\nconst x = 1\nconst y = 2\n```\ntail'],
  ]

  for (const [kind, body] of cases) {
    it(`never bisects a ${kind}`, () => {
      expect(validateRichMarkdown(body)).toEqual([])
      const bad: number[] = []
      for (let budget = 1; budget <= body.length; budget++) {
        if (validateRichMarkdown(hardTruncateCard(body, budget)).length > 0) bad.push(budget)
      }
      expect(bad).toEqual([])
    })
  }
})

describe('truncateMarkdownSafe — the shared mechanism', () => {
  it('backs off rather than cutting inside a span, keeping formatting intact', () => {
    const text = 'abcdefghij **bold text here** klmno'
    // Budget 20 lands inside the bold span (which opens at 11).
    const out = truncateMarkdownSafe(text, 20)
    expect(out).toBe('abcdefghij ')
    expect(validateRichMarkdown(out)).toEqual([])
  })

  it('drops the opener instead of returning a near-empty result when one entity swallows the budget', () => {
    // The #3682 shape: a single span longer than the whole window. Backing off
    // would return `🛠 ` — a card with no content. Dropping the (unrenderable,
    // because its closer is far past the budget) opener keeps the text.
    const text = `🛠 **${'d'.repeat(500)}**`
    const out = truncateMarkdownSafe(text, 64)
    // Within budget, and only the dropped `**` short of it — the window is
    // held fixed in SOURCE terms so the repair can never pull the span's
    // closing delimiter into the output.
    expect(out.length).toBe(62)
    expect(out.startsWith('🛠 d')).toBe(true)
    expect(out).not.toContain('*')
    expect(validateRichMarkdown(out)).toEqual([])
  })

  it('is a no-op when the text already fits', () => {
    expect(truncateMarkdownSafe('**short**', 64)).toBe('**short**')
  })

  it('safeMarkdownCut never splits a surrogate pair', () => {
    const text = 'ab👍cd'
    // Index 3 is between the two halves of the astral char.
    expect(safeMarkdownCut(text, 3)).toBe(2)
    expect(safeMarkdownCut(text, 4)).toBe(4)
  })
})
