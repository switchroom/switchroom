/**
 * narrative-render.test.ts — T6: end-to-end narration through the REAL pure
 * render helpers, tied to the REAL LivenessTracker (thinking-pause fix).
 *
 * Proves the narration surface still behaves after the orphaned-reply fix:
 *   (a) a long narration is clipped and rendered as ONE feed line;
 *   (b) a narration that is a draft of the delivered reply is SUPPRESSED,
 *       while a differing narration is SHOWN;
 *   (c) a narration after a >30s stream gap keeps the turn alive (the tracker
 *       stamps liveness) AND renders; thinking / tool_result carry no narration
 *       text so they add NO feed line (thinking only drives the 🤔 reaction).
 *
 * All assertions drive the REAL helpers — no replicas.
 *
 * DEVIATION NOTE: the fix spec's T6(a) wrote "≤120-char line". The real clip
 * bound is `STATUS_LINE_MAX` (200) in status-no-truncate.ts, so this test pins
 * the real constant instead of the stale 120.
 */

import { describe, it, expect } from 'vitest'
import {
  clipNarrative,
  appendActivityLabel,
  renderActivityFeedWithNested,
} from '../tool-activity-summary.js'
import { isDraftOfReply, REPLY_TOOLS } from '../narrative-dedup.js'
import { STATUS_LINE_MAX } from '../status-no-truncate.js'
import { LivenessTracker, ORPHANED_REPLY_STREAM_WINDOW_MS } from '../context-exhaustion.js'

const W = ORPHANED_REPLY_STREAM_WINDOW_MS

describe('T6(a) — long narration is clipped to one feed line', () => {
  it('clipNarrative → appendActivityLabel → renderActivityFeedWithNested yields one clipped line', () => {
    const long = 'x'.repeat(STATUS_LINE_MAX + 50) // 250 chars, no newlines
    const clipped = clipNarrative(long)
    expect(clipped.length).toBe(STATUS_LINE_MAX)

    const lines: string[] = []
    appendActivityLabel(lines, clipped)
    expect(lines).toHaveLength(1)

    const rendered = renderActivityFeedWithNested(lines, [])
    expect(rendered).not.toBeNull()
    expect(rendered).toContain(clipped)
  })

  it('clipNarrative keeps only the first line, trimmed', () => {
    const multi = '  first line of narration  \nsecond line should be dropped'
    expect(clipNarrative(multi)).toBe('first line of narration')
  })
})

describe('T6(b) — a narration that drafts the reply is suppressed', () => {
  // Model the reducer decision: only render narration that is NOT a draft of
  // the delivered reply (narrative-dedup gate).
  function renderNarrationUnlessDraft(narration: string, replyText: string): string | null {
    if (isDraftOfReply(narration, replyText)) return null // suppressed
    const lines: string[] = []
    appendActivityLabel(lines, clipNarrative(narration))
    return renderActivityFeedWithNested(lines, [])
  }

  it('REPLY_TOOLS is the reply set (sanity — draft dedup only runs for reply tools)', () => {
    expect(REPLY_TOOLS.has('reply')).toBe(true)
    expect(REPLY_TOOLS.has('stream_reply')).toBe(true)
  })

  it('suppresses a trailing narration that is a draft of the delivered reply', () => {
    const reply = 'The build passed and I deployed the fix to staging.'
    const draft = 'The build passed and I deployed the fix to staging' // ~identical
    expect(isDraftOfReply(draft, reply)).toBe(true)
    expect(renderNarrationUnlessDraft(draft, reply)).toBeNull()
  })

  it('shows a genuinely different narration line', () => {
    const reply = 'The build passed and I deployed the fix to staging.'
    const working = 'Running the integration test suite'
    expect(isDraftOfReply(working, reply)).toBe(false)
    const rendered = renderNarrationUnlessDraft(working, reply)
    expect(rendered).not.toBeNull()
    expect(rendered).toContain('Running the integration test suite')
  })
})

describe('T6(c) — narration after a stream gap: alive + rendered; thinking/tool_result add no line', () => {
  it('a narration text event after a >30s gap stamps liveness (turn alive) and renders', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('text', undefined, 0)
    // >30s gap with no events — turn would previously have been at risk.
    const gapNow = 35_000
    // Narration lands: stamps liveness, keeping the turn alive.
    t.onStreamEvent('text', undefined, gapNow)
    expect(t.lastStreamEventAt).toBe(gapNow)
    expect(t.recentlyStreaming(gapNow, W)).toBe(true)

    const lines: string[] = []
    appendActivityLabel(lines, clipNarrative('Compiling the gateway bundle'))
    const rendered = renderActivityFeedWithNested(lines, [])
    expect(rendered).toContain('Compiling the gateway bundle')
  })

  it('thinking and tool_result stamp liveness but carry NO narration text → no feed line', () => {
    const t = new LivenessTracker(0)
    const lines: string[] = []
    // A rendered narration line already present.
    appendActivityLabel(lines, clipNarrative('Editing gateway.ts'))
    expect(lines).toHaveLength(1)

    // thinking: keeps the turn alive (liveness stamp) but produces no text.
    t.onStreamEvent('thinking', undefined, 5_000)
    expect(t.lastStreamEventAt).toBe(5_000)
    // A thinking/tool_result event has no label → appendActivityLabel adds nothing.
    expect(appendActivityLabel(lines, undefined)).toBeNull()
    expect(lines).toHaveLength(1)

    // tool_result: same — stamps liveness, no narration line.
    t.onStreamEvent('tool_result', undefined, 6_000)
    expect(t.lastStreamEventAt).toBe(6_000)
    expect(appendActivityLabel(lines, '')).toBeNull()
    expect(lines).toHaveLength(1)

    const rendered = renderActivityFeedWithNested(lines, [])
    expect(rendered).toContain('Editing gateway.ts')
  })
})
