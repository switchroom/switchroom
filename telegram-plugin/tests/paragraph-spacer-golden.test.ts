/**
 * Durable anchor for the restored idempotent paragraph spacer (revert of
 * #3208 F1). Two guarantees the fleet depends on:
 *
 *   1. GOLDEN — the EXACT outbound byte string for a representative message
 *      (bold header + two prose paragraphs + a `- ` list + a fenced code
 *      block + closing prose) is pinned, BOTH after the `addParagraphSpacers`
 *      pass AND after the in-repo IR renderer (`render/`) re-parses and
 *      re-renders it. Any future change to paragraph spacing must CONSCIOUSLY
 *      update this fixture — it can't drift silently. The wire byte string is
 *      byte-identical to the spacer-pass output, proving the U+00A0 spacer
 *      survives the live rich-render path (`SWITCHROOM_RICH_RENDER` default-on).
 *
 *   2. IDEMPOTENCY — the pass inserts EXACTLY ONE spacer per prose gap and can
 *      never stack a second: running it twice equals running it once, and a
 *      gap that already carries a spacer (or an extra blank line, or an
 *      ASCII-space-only line) is normalised to the single canonical spacer,
 *      not doubled. The "naive re-add" control below shows WHY the guard is
 *      load-bearing: a non-canonicalising spacer pass (insert on every `\n\n`)
 *      double-gaps on the second run — exactly the #3208 symptom. That control
 *      asserts the naive output DIVERGES, so this test would fail if the real
 *      pass ever lost its idempotency guard.
 *
 * Context: #3208 F1 deleted the spacer wholesale on the false premise that the
 * Bot API 10.1 rich GFM renderer shows a bare `\n\n` gap as a visible blank
 * line. Live evidence says the opposite — `\n\n` renders TIGHT, only the
 * U+00A0 spacer produces a visible gap — so removal reintroduced the
 * "paragraphs jammed together" symptom #2692 originally fixed. The correct fix
 * for F1's real-but-narrow double-gap was to make the spacer idempotent (this),
 * not to delete it.
 */
import { describe, test, expect } from 'vitest'
import {
  addParagraphSpacers,
  normalizeParagraphBreaks,
  PARAGRAPH_SPACER,
} from '../format.js'
import { renderOutbound, renderOutboundChunks } from '../render/rich-render.js'

const SP = PARAGRAPH_SPACER // U+00A0

// A representative multi-construct message: a **bold** header, two prose
// paragraphs, a `- ` list, a fenced code block, and closing prose.
const REPRESENTATIVE = [
  '**Status report**',
  '',
  'First paragraph of prose explaining the situation in some detail.',
  '',
  'Second paragraph that continues the explanation across a gap.',
  '',
  '- first bullet item',
  '- second bullet item',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  'Closing prose after the code block.',
].join('\n')

// The EXACT expected outbound byte string. Every DISTINCT-block boundary
// carries exactly one U+00A0 spacer line; the list interior stays tight and the
// fenced block is byte-for-byte verbatim. Update this fixture ONLY with a
// conscious decision to change paragraph spacing.
const GOLDEN =
  `**Status report**\n\n${SP}\n\n` +
  `First paragraph of prose explaining the situation in some detail.\n\n${SP}\n\n` +
  `Second paragraph that continues the explanation across a gap.\n\n${SP}\n\n` +
  `- first bullet item\n- second bullet item\n\n${SP}\n\n` +
  '```js\nconst x = 1\n```' +
  `\n\n${SP}\n\n` +
  'Closing prose after the code block.'

describe('paragraph spacer — golden outbound byte string', () => {
  test('addParagraphSpacers output matches the golden fixture exactly', () => {
    const eff = addParagraphSpacers(normalizeParagraphBreaks(REPRESENTATIVE))
    expect(eff).toBe(GOLDEN)
  })

  test('the golden survives the single-piece IR renderer byte-for-byte', () => {
    // The renderer (default-on) re-parses and re-renders; a U+00A0-only line is
    // a genuine paragraph that round-trips intact, so the visible gap reaches
    // Telegram. (An ASCII-space-only line, by contrast, would be collapsed.)
    // This is the sub-cap single-piece case (`renderOutbound`); the live-path
    // assertion below proves the same through the ACTUAL send transform.
    const wire = renderOutbound(GOLDEN).text
    expect(wire).toBe(GOLDEN)
  })

  test('the golden reaches the wire through the LIVE send path (renderOutboundChunks) byte-for-byte', () => {
    // The live send path (stream-controller.ts) uses `renderOutboundChunks`, not
    // the single-piece `renderOutbound`. For a sub-cap body it returns exactly
    // one `markdown` piece; the joined piece text must preserve the U+00A0
    // spacer byte-for-byte, so the visible paragraph gaps reach Telegram on the
    // real path — not merely in the single-piece renderer. This is the load-
    // bearing anchor against a third flip of the paragraph-spacing behaviour.
    const pieces = renderOutboundChunks(GOLDEN)
    expect(pieces).toHaveLength(1) // sub-cap → single deliverable piece
    expect(pieces[0].mode).toBe('markdown')
    const joined = pieces.map((p) => p.text).join('')
    expect(joined).toBe(GOLDEN)
    // The U+00A0 spacer is present and never doubled at any boundary.
    expect(joined).toContain(`\n\n${SP}\n\n`)
    expect(joined).not.toContain(`${SP}\n\n${SP}`)
  })

  // Multi-chunk boundary safety (a body that exceeds the cap and splits, with no
  // spacer stranded or duplicated at a chunk boundary) is covered by
  // telegram-format.test.ts → 'no chunk starts or ends with a bare U+00A0
  // spacer line (reviewer repro)' and 'spacer-boundary strip is robust across
  // several gaps and small caps'. Not duplicated here.
})

describe('paragraph spacer — idempotency guard', () => {
  test('running the pass twice equals running it once', () => {
    const once = addParagraphSpacers(normalizeParagraphBreaks(REPRESENTATIVE))
    const twice = addParagraphSpacers(once)
    expect(twice).toBe(once)
  })

  test('a gap that already carries a spacer is not double-spaced', () => {
    const already = `Alpha.\n\n${SP}\n\nBravo.`
    expect(addParagraphSpacers(already)).toBe(already)
    // No gap ever grows a SECOND spacer line.
    expect(addParagraphSpacers(already)).not.toContain(`${SP}\n\n${SP}`)
  })

  test('a stray extra blank line / ASCII-space line is normalised, never stacked', () => {
    // Triple newline, and an ASCII-space-only spacer line, both canonicalise to
    // the single U+00A0 spacer — not to a spacer PLUS an extra blank.
    expect(addParagraphSpacers('Alpha.\n\n\nBravo.')).toBe(`Alpha.\n\n${SP}\n\nBravo.`)
    expect(addParagraphSpacers('Alpha.\n\n \n\nBravo.')).toBe(`Alpha.\n\n${SP}\n\nBravo.`)
  })

  test('CONTROL: a naive non-canonicalising spacer pass double-gaps on re-run (proves the guard is load-bearing)', () => {
    // A naive implementation inserts a spacer at EVERY `\n\n` with no guard.
    // First run is fine; the SECOND run sees the spacer's own `\n\n` gaps and
    // wedges more spacers, stacking blank lines — the #3208 double-gap. This
    // control asserts the naive pass DIVERGES from idempotency, so if the real
    // addParagraphSpacers ever regressed to naive behaviour the idempotency
    // test above would start failing rather than silently passing.
    const naive = (t: string): string => t.replace(/\n\n/g, `\n\n${SP}\n\n`)
    const once = naive('Alpha.\n\nBravo.')
    const twice = naive(once)
    expect(twice).not.toBe(once)
    // And the real pass does NOT behave like the naive one on re-run.
    const realOnce = addParagraphSpacers('Alpha.\n\nBravo.')
    expect(addParagraphSpacers(realOnce)).toBe(realOnce)
  })
})
