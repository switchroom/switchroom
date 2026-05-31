/**
 * Regression guard for the Model A foreground sub-agent nesting gate (#2032).
 *
 * #2027 shipped foreground nesting but gated every render path on
 * `turn.replyCalled`. Because the framework's ack-first pattern replies
 * "On it…" FIRST and then delegates, `replyCalled` was already true before any
 * foreground sub-agent ran — so the feature silently produced ZERO live
 * foreground activity for the exact case it was built for, and that went
 * unnoticed because #2027 only tested the pure renderer, never the gate.
 *
 * These tests pin the gate decisions directly so the replyCalled-independence
 * can never regress silently again.
 */
import { describe, it, expect } from 'vitest'
import {
  shouldRenderForegroundProgress,
  foregroundFinishAction,
} from '../gateway/foreground-nesting.js'
import { renderActivityFeedWithNested } from '../tool-activity-summary.js'

describe('shouldRenderForegroundProgress', () => {
  it('renders even after the parent has acked (the #2027 blindspot)', () => {
    // THE regression guard: ack-first sets replyCalled=true before the
    // foreground sub-agent runs. It MUST still render.
    expect(
      shouldRenderForegroundProgress({ nestingEnabled: true, replyCalled: true }),
    ).toBe(true)
  })

  it('renders before any reply (pre-ack flow, unchanged)', () => {
    expect(
      shouldRenderForegroundProgress({ nestingEnabled: true, replyCalled: false }),
    ).toBe(true)
  })

  it('is independent of replyCalled — the flag never flips the outcome', () => {
    const on = shouldRenderForegroundProgress({ nestingEnabled: true, replyCalled: true })
    const off = shouldRenderForegroundProgress({ nestingEnabled: true, replyCalled: false })
    expect(on).toBe(off)
  })

  it('honours the kill-switch regardless of replyCalled', () => {
    expect(
      shouldRenderForegroundProgress({ nestingEnabled: false, replyCalled: false }),
    ).toBe(false)
    expect(
      shouldRenderForegroundProgress({ nestingEnabled: false, replyCalled: true }),
    ).toBe(false)
  })
})

describe('foregroundFinishAction', () => {
  it('hands off to the answer when the last sub-agent finishes post-ack', () => {
    expect(
      foregroundFinishAction({ removed: true, replyCalled: true, remainingForeground: 0 }),
    ).toBe('handoff-clear')
  })

  it('recomposes when other foreground sub-agents are still running post-ack', () => {
    expect(
      foregroundFinishAction({ removed: true, replyCalled: true, remainingForeground: 1 }),
    ).toBe('recompose')
  })

  it('recomposes pre-ack (original behaviour preserved)', () => {
    expect(
      foregroundFinishAction({ removed: true, replyCalled: false, remainingForeground: 0 }),
    ).toBe('recompose')
  })

  it('does nothing for an agent it was not tracking', () => {
    expect(
      foregroundFinishAction({ removed: false, replyCalled: true, remainingForeground: 0 }),
    ).toBe('none')
  })
})

describe('end-to-end render shape under ack-first', () => {
  it('produces a live nested block from a post-ack foreground narrative', () => {
    // marko's real scenario: parent acked with no prior steps (empty mirror),
    // then a foreground researcher emits progress. The gate now ALLOWS this
    // render; prove the render is a real, non-empty nested feed with a live
    // bold "→ current" line — i.e. the user would actually see activity.
    const html = renderActivityFeedWithNested(
      [],
      [
        'searching Unsplash CC0 desk',
        'checking license on 4 candidates',
        'ranking by resolution',
      ],
    )
    expect(html).not.toBeNull()
    // newest child is the live, bold current step
    expect(html).toContain('<b>→ ranking by resolution</b>')
    // an earlier child is present as a done/italic step
    expect(html).toContain('checking license on 4 candidates')
  })
})
