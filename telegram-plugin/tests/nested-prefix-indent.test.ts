import { describe, it, expect } from 'vitest'
import { renderStatusCard } from '../tool-activity-summary.js'
import { NESTED_PREFIX } from '../status-no-truncate.js'
import { COLLAPSE_SAFE_SEPARATOR } from '../card-format.js'

/**
 * #3668 — the nested (foreground sub-agent) child block must actually LOOK
 * nested on a phone.
 *
 * `NESTED_PREFIX` used to be three ASCII spaces plus `↳ `. Card bodies reach
 * Telegram as GFM markdown parsed SERVER-SIDE, and that parser left-trims a
 * leading whitespace run off a content line, so the indent was dropped on the
 * wire and every child step rendered FLAT against its parent's steps — the
 * whole nesting cue reduced to one `↳` glyph.
 *
 * The replacement is the repo's already-live-verified indent idiom, U+2800
 * BRAILLE PATTERN BLANK: general category So (Symbol, other), not Zs, so no
 * whitespace-trimming rule can classify it as whitespace, yet it renders as
 * blank width. Evidence, in order of strength:
 *
 *   1. LIVE: on 2026-07-26 four candidate indents were sent to a real phone in
 *      one message (recorded at `status-no-truncate.ts`, WORKER_STEP_INDENT) —
 *      three U+00A0 rendered FLAT, three U+2800 INDENTED CORRECTLY, a leading
 *      `↳ ` rendered as visible ink, a leading `· ` was promoted by Telegram
 *      into a real list bullet.
 *   2. SHIPPED: `WORKER_STEP_INDENT` (the combined worker card) has used U+2800
 *      since that check and renders indented in production.
 *   3. CATEGORY: the property below — U+2800 is not `\s`, not `White_Space`,
 *      not `Zs`.
 *
 * Note what is NOT claimed: no character was chosen on inference. #3662 shipped
 * U+00A0 on exactly that kind of inference, was merged green, and was inert on
 * a phone — which is why these tests assert the PROPERTY, not just the bytes.
 */

/** Every rule a server-side trimmer could plausibly use. */
const isTrimmableWhitespace = (ch: string): boolean =>
  /\s/u.test(ch) || /\p{White_Space}/u.test(ch) || /\p{Zs}/u.test(ch)

function nestedCard(children: string[]): string {
  return renderStatusCard({
    header: { emoji: '🤖', label: 'Agent', elapsedMs: 95_000, toolCount: 12, state: 'running' },
    steps: ['Reading gateway.ts'],
    childSteps: children,
    final: false,
  })!
}

/** The card's pre-join lines, hard-break chrome removed. */
function linesOf(card: string): string[] {
  return card
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, '').replace(new RegExp(`${COLLAPSE_SAFE_SEPARATOR}$`), ''))
}

describe('NESTED_PREFIX renders as a real indent (#3668)', () => {
  it('contains no character any whitespace rule would trim', () => {
    // The `↳ ` glyph is visible ink and is kept; the run BEFORE it is the
    // indent, and every char of THAT must survive a left-trim. Pin the width
    // too — a single blank char reads as near-flat on a phone and would undo
    // the fix while keeping the character-class assertion green.
    const indent = [...NESTED_PREFIX.slice(0, NESTED_PREFIX.indexOf('↳'))]
    expect(indent.length).toBe(3)
    for (const ch of indent) {
      const cp = `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
      expect(
        isTrimmableWhitespace(ch),
        `NESTED_PREFIX's indent contains ${cp}, which is Unicode whitespace ` +
          `(\\s / White_Space / Zs). Telegram left-trims a leading whitespace run off a ` +
          `content line, so this indent renders FLAT on a phone — the #3662/#3668 failure. ` +
          `Use U+2800 BRAILLE PATTERN BLANK (category So), live-verified 2026-07-26.`,
      ).toBe(false)
    }
  })

  it('leads with exactly three U+2800 and keeps the ↳ glyph', () => {
    // Byte pin, companion to the property above: that one says "not
    // whitespace", this one says "the specific glyph we live-tested", in the
    // order that matters (blanks LEAD, so the glyph is never what gets trimmed).
    expect(NESTED_PREFIX).toBe('\u2800\u2800\u2800↳ ')
    // Not a GFM block-structure lead-in: `stackCardLines` promotes every
    // inter-line break to a hard break *because* card lines are never block
    // lines, and a live check showed Telegram promotes a leading `·` to a real
    // list bullet.
    expect(/^[-*+>|#·]/.test(NESTED_PREFIX)).toBe(false)
  })

  it('every rendered child line survives a server-side leading-whitespace trim with its indent intact', () => {
    const card = nestedCard(['Searching memory', 'Running tests'])
    const childLines = linesOf(card).filter((l) => l.includes('↳'))
    expect(childLines.length).toBe(2)
    for (const line of childLines) {
      // Fail-before assertion: with the old ASCII prefix, `line` started with
      // `'   '` and this strip removed the whole indent.
      expect(line.startsWith(NESTED_PREFIX)).toBe(true)
      expect(line.replace(/^[\s\p{White_Space}]+/u, '').startsWith(NESTED_PREFIX)).toBe(true)
      // And it leads with neither of the two characters already proven flat.
      expect(line.startsWith(' ')).toBe(false)
      expect(line.startsWith('\u00A0')).toBe(false)
    }
  })

  it('golden line ordering — parent steps stay flush, child steps sit one level in', () => {
    // Set-membership assertions alone would pass a render that emitted all the
    // parents and then all the children. This pins the ORDER, which is the
    // thing "nested" actually means.
    const card = nestedCard(['Searching memory', 'Running tests'])
    const body = linesOf(card).slice(2)
    expect(body).toEqual([
      '~~_✓ Reading gateway.ts_~~',
      `${NESTED_PREFIX}~~_Searching memory_~~`,
      `${NESTED_PREFIX}**→ Running tests**`,
    ])
  })
})
