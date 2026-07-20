/**
 * Unit coverage for the per-chat subagent-handback marker
 * (fix/backstop-duplicate-reply). The marker is the deterministic signal the
 * supersede path uses to tell a flushed turn's OWN reworded late reply (no
 * handback in flight → supersede) from a background handback attributed to that
 * ended turn (handback in flight → keep the #3429 content gate).
 */

import { describe, it, expect } from 'vitest'
import { SubagentHandbackMarker } from '../gateway/subagent-handback-marker.js'

describe('SubagentHandbackMarker', () => {
  it('returns null for a chat with no recorded handback', () => {
    const m = new SubagentHandbackMarker()
    expect(m.lastAt('chatA')).toBe(null)
  })

  it('returns the recorded enqueue ts for the chat', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 1_000_000)
    expect(m.lastAt('chatA')).toBe(1_000_000)
  })

  it('is per-chat — one chat never leaks into another', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 1_000_000)
    expect(m.lastAt('chatB')).toBe(null)
  })

  it('keeps only the MOST RECENT enqueue (overwrites)', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 1_000_000)
    m.record('chatA', 1_050_000)
    expect(m.lastAt('chatA')).toBe(1_050_000)
  })
})
