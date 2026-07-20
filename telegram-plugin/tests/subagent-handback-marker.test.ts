/**
 * Unit coverage for the per-chat/thread subagent-handback marker
 * (fix/backstop-duplicate-reply; thread-keying — dup-audit F2 2026-07-21). The
 * marker is the deterministic signal the supersede path uses to tell a flushed
 * turn's OWN reworded late reply (no handback in flight → supersede) from a
 * background handback attributed to that ended turn (handback in flight → keep
 * the #3429 content gate).
 */

import { describe, it, expect } from 'vitest'
import { SubagentHandbackMarker } from '../gateway/subagent-handback-marker.js'

describe('SubagentHandbackMarker', () => {
  it('returns null for a chat with no recorded handback', () => {
    const m = new SubagentHandbackMarker()
    expect(m.lastAt('chatA', undefined)).toBe(null)
  })

  it('returns the recorded enqueue ts for the chat', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', undefined, 1_000_000)
    expect(m.lastAt('chatA', undefined)).toBe(1_000_000)
  })

  it('is per-chat — one chat never leaks into another', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', undefined, 1_000_000)
    expect(m.lastAt('chatB', undefined)).toBe(null)
  })

  it('keeps only the MOST RECENT enqueue (overwrites)', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', undefined, 1_000_000)
    m.record('chatA', undefined, 1_050_000)
    expect(m.lastAt('chatA', undefined)).toBe(1_050_000)
  })

  // ── F2: thread-keying (dup-audit 2026-07-21) ────────────────────────────
  it('is per-THREAD — a handback in topic A does not leak into topic B', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 111, 1_000_000)
    // Same chat, different topic → no marker: topic B's CASE-A collapse is
    // untouched by topic A's handback (the visible-dup gap F2 closed).
    expect(m.lastAt('chatA', 222)).toBe(null)
    expect(m.lastAt('chatA', 111)).toBe(1_000_000)
  })

  it('a thread handback does not leak into the DM (no-thread) lane of the same chat', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 111, 1_000_000)
    expect(m.lastAt('chatA', undefined)).toBe(null)
  })

  it('the no-thread lane keys identically to the supersede registry (chat only)', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', undefined, 1_000_000)
    // A later thread read must NOT see the DM stamp, and vice-versa.
    expect(m.lastAt('chatA', undefined)).toBe(1_000_000)
    expect(m.lastAt('chatA', 111)).toBe(null)
  })
})
