/**
 * narrative-splice-before-finalize.test.ts — the gateway-level anti-double-print
 * guarantee for the TIMER early-paint path.
 *
 * ## What this proves
 * The kernel unit tests (narrative-flush.test.ts) prove the controller EMITS a
 * RETRACT effect. They do NOT prove the load-bearing gateway wiring: that the
 * RETRACT effect splices `mirrorLines` synchronously BEFORE the finalize render
 * (`clearActivitySummary` → `composeTurnActivity(final)`) reads that same array,
 * so a narration the timer painted early and that turned out to draft the reply
 * appears ZERO times in the finalized card.
 *
 * This test reconstructs the gateway's OWN effect wiring 1:1 with
 * `makeNarrativeGate` (gateway.ts): a shared `mirrorLines` array, a `show`
 * effect that mirrors `showNarrativeStep`'s core
 * (`appendActivityLabel(mirrorLines, clipNarrative(text))`), and a `retractShown`
 * effect that mirrors `retractNarrativeLine`'s core (splice the
 * `lastIndexOf(clipNarrative(text))` entry). The finalize render reads the SAME
 * live array. It drives the REAL `NarrativeFlushController`, the REAL render
 * helpers, and a REAL `setTimeout`-based scheduler under fake timers — every
 * assertion is an outcome.
 *
 * ## Red-on-regression
 *   - If the RETRACT effect were removed / made a no-op, the timer-painted line
 *     stays in `mirrorLines` and the finalize render contains it → RED.
 *   - If the finalize render were reordered to read a snapshot taken BEFORE the
 *     retract splice (the "splice-after-finalize" reordering), the snapshot still
 *     holds the line → RED. (Modeled here by taking the finalize snapshot AFTER
 *     `resolveOnTool`, exactly as the gateway sequences retract-then-finalize.)
 *
 * ## Honest limits
 * gateway.ts does NOT export `showNarrativeStep` / `retractNarrativeLine` /
 * `composeTurnActivity` / `clearActivitySummary`, so this test cannot invoke
 * those private functions directly — it reconstructs their effect bodies against
 * the real shared helpers. It therefore locks the CONTRACT (splice-before-read,
 * clipped-line matching, retract-empties-cleanly) but would not catch a future
 * edit that diverges the gateway's private effect bodies from this reconstruction
 * without also updating this test. The kernel test covers the controller; this
 * test covers the mirrorLines splice/finalize contract they compose into.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NarrativeFlushController } from '../narrative-flush.js'
import {
  clipNarrative,
  appendActivityLabel,
  renderActivityFeedWithNested,
} from '../tool-activity-summary.js'

const FLUSH_MS = 250

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count++
    from = at + needle.length
  }
}

describe('gateway wiring: retract splices mirrorLines BEFORE finalize reads it', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /**
   * Build the SAME effect wiring `makeNarrativeGate` builds, over a shared
   * `mirrorLines` array, with a real setTimeout scheduler (mirrors the gateway's
   * `unref`'d setTimeout wiring).
   */
  function wireGate() {
    const mirrorLines: string[] = []
    let handle: ReturnType<typeof setTimeout> | null = null
    const controller = new NarrativeFlushController(
      {
        // showNarrativeStep core: append the clipped narrative as a feed line.
        show: (text) => {
          appendActivityLabel(mirrorLines, clipNarrative(text))
        },
        // retractNarrativeLine core: splice the clipped line out of mirrorLines.
        retractShown: (text) => {
          const clipped = clipNarrative(text)
          const idx = mirrorLines.lastIndexOf(clipped)
          if (idx === -1) return
          mirrorLines.splice(idx, 1)
        },
      },
      {
        arm: (fn, ms) => {
          if (handle != null) clearTimeout(handle)
          handle = setTimeout(fn, ms)
          handle.unref?.()
        },
        disarm: () => {
          if (handle != null) {
            clearTimeout(handle)
            handle = null
          }
        },
      },
      FLUSH_MS,
    )
    // composeTurnActivity(final) core: render the SAME live mirrorLines array.
    const finalize = () => renderActivityFeedWithNested(mirrorLines, [], true)
    return { controller, mirrorLines, finalize }
  }

  it('early-painted narration that drafts the reply appears ZERO times in the finalized card', () => {
    const { controller, mirrorLines, finalize } = wireGate()
    const narration = 'The migration completed and all 40 rows were backfilled cleanly.'
    const reply = 'The migration completed and all 40 rows were backfilled cleanly.'
    const clipped = clipNarrative(narration)

    // 1. Stage the opening narration (parked, timer armed).
    controller.stage(narration)

    // 2. Fire the early-paint timer → SHOW paints the line into mirrorLines.
    vi.advanceTimersByTime(FLUSH_MS)
    expect(mirrorLines).toContain(clipped)
    // Sanity: before retract, a finalize WOULD have shown the line (proves the
    // assertion below is meaningful, not vacuously passing on an empty feed).
    expect(occurrences(finalize() ?? '', clipped)).toBe(1)

    // 3. Deliver the matching reply (draft-then-send) → RETRACT splices the line.
    controller.resolveOnTool('reply', { text: reply })

    // 4. Finalize reads the SAME (now-spliced) array → line appears ZERO times.
    const finalRender = finalize()
    expect(occurrences(finalRender ?? '', clipped)).toBe(0)
  })

  it('a genuinely different early-painted narration survives finalize exactly once (no over-retract)', () => {
    const { controller, mirrorLines, finalize } = wireGate()
    const narration = 'Running the integration suite against staging'
    const reply = 'All checks passed — deployed to production.'
    const clipped = clipNarrative(narration)

    controller.stage(narration)
    vi.advanceTimersByTime(FLUSH_MS)
    controller.resolveOnTool('reply', { text: reply })

    // Not a draft of the reply → NOT retracted → present exactly once.
    expect(mirrorLines).toContain(clipped)
    expect(occurrences(finalize() ?? '', clipped)).toBe(1)
  })

  it('retract that empties the feed collapses composeTurnActivity to null (interim-ack anti-blank guard input)', () => {
    // Documents the LOW cosmetic case: when the ONLY feed line is retracted, the
    // live re-render collapses to null and the guard leaves the stale line up
    // until the next event. Here we assert the *finalize* is clean (no double
    // print) even though the interim live render would be null.
    const { controller, mirrorLines, finalize } = wireGate()
    const narration = 'Drafting the summary of the deploy'
    const reply = 'Drafting the summary of the deploy'
    controller.stage(narration)
    vi.advanceTimersByTime(FLUSH_MS)
    controller.resolveOnTool('reply', { text: reply })
    expect(mirrorLines).toHaveLength(0)
    // Empty feed → renderActivityFeedWithNested returns null (the anti-blank
    // guard's null input). The finalized card carries the narration ZERO times.
    const finalRender = finalize()
    expect(finalRender == null || occurrences(finalRender, clipNarrative(narration)) === 0).toBe(true)
  })
})
