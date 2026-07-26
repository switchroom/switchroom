/**
 * Pinned-card COLLAPSED readability (#3666).
 *
 * The defect these tests exist to catch is invisible in the expanded render:
 * the `🛠 Workers` card is well-formed in the chat feed, but Telegram's
 * pinned-message bar shows it collapsed onto ONE line — the newlines are
 * dropped and NOTHING is substituted — so the last glyph of each line mashed
 * into the first glyph of the next:
 *
 *   🛠 Workers · 3 running1. Fix issue 3627 … · opus 5✓ Reading gateway.ts→ Run…
 *
 * Every existing golden asserts the EXPANDED body and passed throughout. So
 * these assertions all run against the COLLAPSED string, modelled by
 * `collapsePreview` below, and the discriminating control ("the same lines
 * joined WITHOUT collapseSafe still mash") is asserted explicitly so the suite
 * would fail on the pre-fix render.
 *
 * The collapse itself is client-side: there is no Bot API for a separate
 * pin-bar preview, so the message text is the only lever and a test can only
 * model the client. The model is deliberately conservative — it drops strictly
 * more than Telegram does (all inline markers, all newlines).
 */
import { describe, it, expect } from 'vitest'
import { renderActivityFeed, renderCombinedWorkerFeed } from '../tool-activity-summary.js'
import { stackCardLines, COLLAPSE_SAFE_SEPARATOR as NB } from '../card-format.js'

/**
 * Model Telegram's pinned-bar render of a card body:
 *   - inline entity markup (`**`, `~~`, `_`) is formatting, not text → dropped
 *   - the two spaces before each `\n` are GFM hard-break SYNTAX, consumed by
 *     the parser → dropped
 *   - the newline itself is dropped with no substitute (this is the defect)
 */
function collapsePreview(body: string): string {
  return body.replace(/[ \t]*\n/g, '').replace(/\*\*|~~|_/g, '')
}

/** Plain text of one rendered card line (same entity-dropping model). */
function plain(line: string): string {
  return line.replace(/\*\*|~~|_/g, '')
}

/** Split a rendered card body back into its pre-join lines. */
function cardLines(body: string): string[] {
  return body.split(/[ \t]*\n/)
}

/**
 * The outcome under test: at EVERY line seam, the two lines' text must not run
 * together in the collapsed string. Asserted as a property over the whole card
 * rather than on one hand-picked boundary, because the reported preview spanned
 * three different seams and a line-1-only separator would have fixed one.
 */
function expectNoMashedSeams(body: string): void {
  const lines = cardLines(body)
  const collapsed = collapsePreview(body)
  for (let i = 0; i + 1 < lines.length; i++) {
    const prev = plain(lines[i])
    const next = plain(lines[i + 1])
    const seam = prev.slice(-1) + next.slice(0, 1)
    expect(/\s/.test(seam), `seam ${i} mashes: "${seam}"`).toBe(true)
    // …and the mashed spelling must not appear anywhere in what the user reads.
    const mashed = prev.replace(/\s+$/, '').slice(-4) + next.slice(0, 4)
    expect(collapsed.includes(mashed), `collapsed contains "${mashed}"`).toBe(false)
  }
}

/** The three workers from the issue report, verbatim. */
const REPORTED_ROWS = [
  {
    description: 'Fix issue 3627 vault approval UX',
    elapsedMs: 2_296_000,
    toolCount: 164,
    currentStep: 'Running search',
    historyLines: ['Reading gateway.ts', 'Running search'],
    totalTokens: 512_300,
    model: 'claude-opus-5',
    ordinal: 1,
  },
  {
    description: 'Adopt release workflow',
    elapsedMs: 660_000,
    toolCount: 20,
    currentStep: 'Editing release.yml',
    ordinal: 2,
  },
  {
    description: 'Fix setup verification false green',
    elapsedMs: 640_000,
    toolCount: 12,
    currentStep: 'Running tests',
    ordinal: 3,
  },
]

describe('combined worker card survives the pinned-bar collapse (#3666)', () => {
  const body = renderCombinedWorkerFeed(REPORTED_ROWS, { maxRows: 8 })!

  it('has no mashed seam anywhere in the collapsed preview', () => {
    expectNoMashedSeams(body)
  })

  it('kills the exact artifacts from the report', () => {
    const collapsed = collapsePreview(body)
    // 1. the count/ordinal collision — glance line into row 1's ordinal.
    //    This seam is owned by the collapse separator (a worker HEADER carries
    //    no leading indent, so nothing else separates it).
    //    (The reported spelling was `3 running1.`; with the packed glance line
    //    the same seam now reads `… 512.3k tok` → `1. Fix issue`, so assert on
    //    the CURRENT last token of line 1 — an assertion on the old spelling
    //    alone would be vacuously green.)
    expect(collapsed).not.toContain('running1.')
    expect(collapsed).not.toContain('tok1.')
    expect(collapsed).toMatch(/tok\u00A01\. Fix issue/)
    // 2. the mid-word ✓ (model tag running into the step trail). Here the
    //    separator and WORKER_STEP_INDENT (#3662, three U+00A0 leading a step
    //    line) stack, hence `\u00A0+` rather than exactly one.
    expect(collapsed).not.toContain('opus 5✓')
    expect(collapsed).toMatch(/opus 5\u00A0+✓/)
    // 3. the step trail running into the next step, and into the next row's
    //    header (that last seam is separator-only: headers are unindented).
    expect(collapsed).not.toContain('gateway.ts→')
    expect(collapsed).toMatch(/gateway\.ts\u00A0+→/)
    expect(collapsed).not.toContain('search2.')
    expect(collapsed).toContain(`search${NB}2.`)
  })

  it('leads with a self-contained glance that ends in a unit word, not a bare number', () => {
    const first = plain(cardLines(body)[0]).replace(new RegExp(NB, 'g'), '')
    expect(first).toContain('3 running')
    expect(first).toContain('oldest 38m16s') // max elapsed across all rows
    expect(first).toContain('196 tools') // 164 + 20 + 12
    expect(first).toContain('512.3k tok')
    // A bare trailing number would collide with row 1's `1.` even WITH a
    // separator ("… 196 1. Fix issue"); the glance always ends in a unit.
    expect(first).toMatch(/(running|tools?|tok|\d+s)$/)
  })

  it('CONTROL: the same lines joined without collapseSafe still mash (pre-fix shape)', () => {
    // Discriminator: re-join the SAME rendered lines with the separator removed
    // and show the collapsed preview mashes again. Without this, the assertions
    // above could all be passing for reasons unrelated to the fix.
    //
    // The seams asserted here are the ones the separator alone owns: a worker
    // HEADER line carries no leading WORKER_STEP_INDENT (#3662), so the
    // glance→row-1 and step→next-row seams have nothing else holding them
    // apart. (The header→step and step→step seams are separated by the indent
    // even pre-fix, which is why they are not the control.)
    const lines = cardLines(body).map((l) => l.replace(new RegExp(NB + '$'), ''))
    const preFix = stackCardLines(lines)
    const collapsed = collapsePreview(preFix)
    expect(collapsed).toContain('tok1.')
    expect(collapsed).toContain('search2.')
    // …and the property assertion itself would have failed on it.
    expect(() => expectNoMashedSeams(preFix)).toThrow()
  })
})

describe('single-worker / agent status card survives the collapse too (#3666)', () => {
  // Both are pinned by status-pin.ts ("the per-turn activity/status message and
  // the 🛠 Worker background-worker message"), so both must collapse cleanly.
  it('step bullets stay separated in the collapsed preview', () => {
    const body = renderActivityFeed(['Reading gateway.ts', 'Searching memory', 'Running tests'])!
    expectNoMashedSeams(body)
    expect(collapsePreview(body)).not.toContain('gateway.tsSearching')
    expect(collapsePreview(body)).toContain(`Reading gateway.ts${NB}✓ Searching memory`)
  })
})

describe('stackCardLines collapseSafe is opt-in and structure-preserving', () => {
  it('default output is byte-identical to the pre-#3666 join', () => {
    expect(stackCardLines(['a', 'b', 'c'])).toBe('a  \nb  \nc')
  })

  it('collapseSafe appends the separator only at hard-break seams', () => {
    expect(stackCardLines(['a', 'b', 'c'], { collapseSafe: true })).toBe(
      `a${NB}  \nb${NB}  \nc`,
    )
    // Never on the last line — nothing follows it to collide with.
    expect(stackCardLines(['a'], { collapseSafe: true })).toBe('a')
  })

  it('a genuine blank-line paragraph gap keeps its plain newline', () => {
    // The blank entry already contributes whitespace to a collapsed render, so
    // the separator would be pure noise there.
    expect(stackCardLines(['a', '', 'b'], { collapseSafe: true })).toBe('a\n\nb')
  })

  it('the separator survives the hard break rather than replacing it', () => {
    // Load-bearing: the two spaces must stay IMMEDIATELY before the `\n` or the
    // GFM hard break stops parsing and the card collapses in the FEED too.
    const out = stackCardLines(['a', 'b'], { collapseSafe: true })
    expect(out).toMatch(/ {2}\n/)
    expect(out).not.toMatch(/(?<! {2})\n/)
    // The separator is not ASCII whitespace, so the trailing-space strip that
    // guards against accumulation cannot eat it.
    expect(NB).not.toMatch(/[ \t\r]/)
  })
})
