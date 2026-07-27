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
 * `previewLines` below, and the discriminating control ("the same lines
 * joined WITHOUT collapseSafe still mash") is asserted explicitly so the suite
 * would fail on the pre-fix render.
 *
 * The collapse itself is client-side: there is no Bot API for a separate
 * pin-bar preview, so the message text is the only lever and a test can only
 * model the client. The model is deliberately conservative — it drops strictly
 * more than Telegram does (all inline markers, all newlines).
 */
import { describe, it, expect } from 'vitest'
import {
  renderActivityFeed,
  renderActivityFeedWithNested,
  renderCombinedWorkerFeed,
  renderStatusCard,
} from '../tool-activity-summary.js'
import { renderWorkerActivity } from '../worker-activity-feed.js'
import { stackCardLines, COLLAPSE_SAFE_SEPARATOR as NB } from '../card-format.js'
import {
  STATUS_CARD_CHAR_BUDGET,
  STATUS_LINE_MAX,
  WORKER_STEP_INDENT,
} from '../status-no-truncate.js'

/**
 * Model Telegram's pinned-bar render of a card body, per line. ONE function
 * backs both the per-line and the whole-string view so the two can never drift:
 *
 *   - inline entity markup (`**`, `~~`, `_`) is formatting, not text -> dropped
 *   - the two spaces before each `\n` are GFM hard-break SYNTAX, consumed by
 *     the parser -> dropped
 *   - a LEADING whitespace run on a line is dropped by Telegram's server-side
 *     CommonMark parser (reference/telegram-formatting-guide.md:118, "Telegram
 *     drops leading whitespace"). Modelled as ASCII **and** Unicode-whitespace
 *     (`\p{White_Space}`, which covers the Zs category): #3662 shipped a U+00A0
 *     indent on the assumption that only ASCII was stripped, and a live phone
 *     check on 2026-07-26 proved otherwise — the card rendered flat. Modelling
 *     this is what makes the nested-card assertion below DISCRIMINATING instead
 *     of vacuous: `NESTED_PREFIX` is three ASCII spaces (#3668, still open), so
 *     it cannot hold a collapsed seam apart — only the separator can.
 *     `WORKER_STEP_INDENT` is now U+2800 (category So, not whitespace at all),
 *     which survives this strip.
 *   - the newline itself is dropped with no substitute (this is the defect)
 */
function previewLines(body: string): string[] {
  return body
    .split(/[ \t]*\n/)
    .map((l) => l.replace(/^[\s\p{White_Space}]+/u, '').replace(/\*\*|~~|_/g, ''))
}

/** The whole collapsed one-line preview. */
function collapsePreview(body: string): string {
  return previewLines(body).join('')
}

/** Split a rendered card body back into its pre-join lines, markup intact. */
function rawCardLines(body: string): string[] {
  return body.split(/[ \t]*\n/)
}

/**
 * The outcome under test: at EVERY line seam, the two lines' text must not run
 * together in the collapsed string. Asserted as a property over the whole card
 * rather than on one hand-picked boundary, because the reported preview spanned
 * three different seams and a line-1-only separator would have fixed one.
 *
 * Blank entries (a genuine `\n\n` paragraph gap) are dropped first rather than
 * skipped: the empty string contributes NO character to a collapsed render, so
 * the seam that actually reaches the user is the one between the content lines
 * either side of the gap. Skipping instead of dropping would silently stop
 * checking that seam.
 */
function expectNoMashedSeams(body: string): void {
  const lines = previewLines(body).filter((l) => l !== '')
  const collapsed = collapsePreview(body)
  for (let i = 0; i + 1 < lines.length; i++) {
    const prev = lines[i]
    const next = lines[i + 1]
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
    // 1. the count/ordinal collision — glance line into row 1's ordinal. Since
    //    #3839 the row header is FLUSH (the #3820 card-level indent is gone),
    //    so the separator is the ONLY thing holding this seam apart.
    //    (The reported spelling was `3 running1.`; with the packed glance line
    //    the same seam now reads `… 512.3k tok` -> `1. Fix issue`, so assert on
    //    the CURRENT last token of line 1 — an assertion on the old spelling
    //    alone would be vacuously green.)
    expect(collapsed).not.toContain('running1.')
    expect(collapsed).not.toContain('tok1.')
    expect(collapsed).toContain(`tok${NB}1. Fix issue`)
    // 2. the mid-word ✓ (model tag running into the step trail). A step line
    //    still leads with WORKER_STEP_INDENT (three U+2800), so this seam is
    //    separator + step indent — asserted against the constant rather than a
    //    hardcoded run.
    expect(collapsed).not.toContain('opus 5✓')
    expect(collapsed).toContain(`opus 5${NB}${WORKER_STEP_INDENT}✓`)
    // 3. the step trail running into the next step, and into the next row's
    //    header (post-#3839 that last seam is the separator alone).
    expect(collapsed).not.toContain('gateway.ts→')
    expect(collapsed).toContain(`gateway.ts${NB}${WORKER_STEP_INDENT}→`)
    expect(collapsed).not.toContain('search2.')
    expect(collapsed).toContain(`search${NB}2.`)
  })

  it('leads with a self-contained glance that ends in a unit word, not a bare number', () => {
    const first = previewLines(body)[0].replace(new RegExp(NB, 'g'), '')
    expect(first).toContain('3 running')
    expect(first).toContain('oldest 38m16s') // max elapsed across all rows
    expect(first).toContain('196 tools') // 164 + 20 + 12
    expect(first).toContain('512.3k tok')
    // A bare trailing number would collide with row 1's `1.` even WITH a
    // separator ("… 196 1. Fix issue"); the glance always ends in a unit.
    expect(first).toMatch(/(running|tools?|tok|\d+s)$/)
  })

  it('CONTROL: the same lines joined without collapseSafe still mash (pre-fix shape)', () => {
    // Discriminator: re-join rendered card lines with the separator removed and
    // show the collapsed preview mashes again. Without this, the assertions
    // above could all be passing for reasons unrelated to the fix.
    //
    // The control runs on the 🤖 AGENT card. Post-#3839 the single-worker card
    // is flush too, so either would isolate the separator's contribution; the
    // agent card is kept because it has no step indent on ANY line, so no
    // future indent change can quietly make this control vacuous.
    const agent = renderActivityFeed([
      'Reading gateway.ts',
      'Searching memory',
      'Running tests',
    ])!
    const lines = rawCardLines(agent).map((l) => l.replace(new RegExp(NB + '$'), ''))
    const preFix = stackCardLines(lines)
    const collapsed = collapsePreview(preFix)
    expect(collapsed).toContain('gateway.ts✓ Searching')
    expect(collapsed).toContain('memory→ Running')
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

  it('the hand-rolled `starting…` seam carries the separator too', () => {
    // renderWorkerActivity appends this placeholder with its OWN `  \n` rather
    // than through stackCardLines (worker-activity-feed.ts), so it is the one
    // boundary on a pinned card that a collapseSafe flag alone does NOT reach.
    // Without the explicit separator there it reads `… 0 toolsstarting…`.
    const body = renderWorkerActivity({
      workerId: 'w1',
      description: 'lone worker',
      latestSummary: '',
      narrativeLines: [],
      elapsedMs: 1_000,
      toolCount: 0,
      state: 'running',
    })
    expect(body).toContain('starting')
    expectNoMashedSeams(body)
    const collapsed = collapsePreview(body)
    expect(collapsed).not.toContain('toolsstarting')
    // #3839: the single-worker card is flush, so the separator alone holds the
    // hand-rolled `starting…` seam apart — nothing else masks a regression.
    expect(collapsed).toContain(`0 tools${NB}starting`)
  })

  it('the nested child block stays separated even though its indent is ASCII (#3668)', () => {
    // NESTED_PREFIX is three ASCII SPACES, which Telegram's parser drops (see
    // previewLines), so on this surface the collapse separator is the ONLY
    // thing holding the parent->child seam apart. Unlike the combined card,
    // there is no U+2800 indent to mask a regression here.
    const body = renderActivityFeedWithNested(
      ['Reading gateway.ts'],
      ['Searching memory', 'Running tests'],
    )!
    expectNoMashedSeams(body)
    const collapsed = collapsePreview(body)
    expect(collapsed).not.toContain('gateway.ts↳')
    expect(collapsed).toContain(`gateway.ts${NB}↳`)
  })

  it('the char-budget backstop keeps the separator on every line it emits', () => {
    // fitCardToBudget is a SECOND, independent stacking path (the wire-limit
    // safety net). A collapseSafe flag set only on renderStatusCard's happy
    // path would leave every card that trips the backstop mashing.
    const steps = Array.from({ length: 400 }, (_, i) => `${'x'.repeat(STATUS_LINE_MAX)} ${i}`)
    const opts = {
      header: {
        emoji: '🤖',
        label: 'Agent',
        description: 'a very long turn',
        elapsedMs: 1_000,
        toolCount: steps.length,
        state: 'running' as const,
      },
      steps,
      historyWindow: steps.length,
    }
    // Precondition: without the backstop this card would blow the wire budget,
    // so the assertions below really are running on the backstop's output.
    expect(stackCardLines(steps).length).toBeGreaterThan(STATUS_CARD_CHAR_BUDGET)
    const body = renderStatusCard(opts)!
    expect(body.length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
    expect(body).toContain('earlier') // the `+N earlier…` marker fitCardToBudget adds
    expectNoMashedSeams(body)
  })

  it('every card size across the budget boundary keeps its seams separated', () => {
    // fitCardToBudget has a THIRD stack site: the last-resort return taken when
    // even a single bullet will not fit. escapeStepLine clips every bullet to
    // STATUS_LINE_MAX (200), so that branch is only reachable once the HEADER
    // alone nearly fills the budget — which is exactly why sweeping the header
    // size across the boundary, rather than naming one magic length, is what
    // walks the card through all three sites (happy path, shrink loop,
    // last resort) without hardcoding the arithmetic of any of them.
    for (const descLen of [
      64,
      STATUS_CARD_CHAR_BUDGET - 4 * STATUS_LINE_MAX,
      STATUS_CARD_CHAR_BUDGET - STATUS_LINE_MAX,
      STATUS_CARD_CHAR_BUDGET - 64,
      STATUS_CARD_CHAR_BUDGET - 48,
      STATUS_CARD_CHAR_BUDGET,
      STATUS_CARD_CHAR_BUDGET + 4096,
    ]) {
      const body = renderStatusCard({
        header: {
          emoji: '🤖',
          label: 'Agent',
          description: 'y'.repeat(descLen),
          elapsedMs: 1_000,
          toolCount: 3,
          state: 'running' as const,
        },
        steps: ['only step'],
      })!
      expectNoMashedSeams(body)
    }
  })
})

describe('stackCardLines collapseSafe is opt-in and structure-preserving', () => {
  it('default output is byte-identical to the pre-#3666 join', () => {
    expect(stackCardLines(['a', 'b', 'c'])).toBe('a  \nb  \nc')
    expect(stackCardLines(['a', '', 'b'])).toBe('a\n\nb')
  })

  it('collapseSafe appends the separator only at hard-break seams', () => {
    expect(stackCardLines(['a', 'b', 'c'], { collapseSafe: true })).toBe(
      `a${NB}  \nb${NB}  \nc`,
    )
    // Never on the last line — nothing follows it to collide with.
    expect(stackCardLines(['a'], { collapseSafe: true })).toBe('a')
  })

  it('a blank-line paragraph gap keeps its plain newline AND gets a separator', () => {
    // The blank entry is the EMPTY STRING: it contributes no character to a
    // collapsed render, so a gap seam mashes exactly like a hard-break seam
    // unless the content line before it carries the separator.
    expect(stackCardLines(['a', '', 'b'], { collapseSafe: true })).toBe(`a${NB}\n\nb`)
    // …but a blank CURRENT line never gets one: a U+00A0 on the blank entry
    // would turn the invisible gap into a VISIBLE spacer paragraph in the feed.
    expect(stackCardLines(['', 'b'], { collapseSafe: true })).toBe('\nb')
    expect(stackCardLines(['a', ''], { collapseSafe: true })).toBe(`a${NB}\n`)
    // And the property holds across the gap, where it did not before.
    expectNoMashedSeams(stackCardLines(['alpha', '', 'beta'], { collapseSafe: true }))
    expect(() => expectNoMashedSeams(stackCardLines(['alpha', '', 'beta']))).toThrow()
  })

  it('collapseSafe is idempotent — re-stacking adds no second separator', () => {
    // stackCardLines already promised "never accumulate spaces on a re-run";
    // the separator has to honour the same invariant or a body that is split
    // and re-joined grows one character per line per pass.
    const once = stackCardLines(['a', 'b', 'c'], { collapseSafe: true })
    expect(stackCardLines(once.split(/ {2}\n/), { collapseSafe: true })).toBe(once)
    expect(stackCardLines(once.split('\n'), { collapseSafe: true })).toBe(once)
    // A doubled separator collapses back to exactly one.
    expect(stackCardLines([`a${NB}${NB}`, 'b'], { collapseSafe: true })).toBe(`a${NB}  \nb`)
    // …including across a paragraph gap, whose separator is appended by a
    // different branch and would otherwise accumulate on its own.
    const gap = stackCardLines(['a', '', 'b'], { collapseSafe: true })
    expect(stackCardLines(gap.split('\n'), { collapseSafe: true })).toBe(gap)
    // Default mode is untouched by the separator strip.
    expect(stackCardLines([`a${NB}`, 'b'])).toBe(`a${NB}  \nb`)
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
    // …and it is non-empty. The strip loop treats an empty separator as a
    // no-op rather than spinning, but an empty separator would also silently
    // reinstate #3666 on every pinned card, so pin the contract here.
    expect(NB.length).toBeGreaterThan(0)
  })
})
