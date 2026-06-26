import { describe, it, expect } from 'vitest'
import { clipNarrative } from '../tool-activity-summary.js'

// `clipNarrative` is the shared narrative-clip primitive used by both the
// main-agent gateway path (showNarrativeStep) and the sub-agent watcher. It
// collapses multi-line text to the first line, trims, and slices to 200 chars
// (= STATUS_LINE_MAX). Fix 1 raised the cap from 120 → 200 to match the tool-
// label cap so a narrative line reads as legibly as a tool step (no
// mid-sentence truncation on typical agent narration lengths of 130–180 chars).

describe('clipNarrative — shared subagent-watcher narrative clip', () => {
  it('collapses a multi-line block to its first line', () => {
    const text = 'On it. Let me find the repo…\nthen build it\nand run the tests'
    expect(clipNarrative(text)).toBe('On it. Let me find the repo…')
  })

  it('trims surrounding whitespace on the first line', () => {
    expect(clipNarrative('   Found both repos:   \nmore')).toBe('Found both repos:')
  })

  it('caps the first line at 200 characters (Fix 1: raised from 120 to match STATUS_LINE_MAX)', () => {
    // 200-char cap: a 250-char first line is clipped at exactly 200.
    const long = 'x'.repeat(250)
    const out = clipNarrative(long)
    expect(out.length).toBe(200)
    expect(out).toBe('x'.repeat(200))
  })

  it('a first line under 200 chars is returned verbatim', () => {
    expect(clipNarrative('short narrative line')).toBe('short narrative line')
  })

  it('a narrative between 120 and 200 chars is NOT truncated (the Fix 1 improvement)', () => {
    // Before Fix 1 the 120-char clip truncated typical 130–180 char agent narration.
    // After Fix 1 these are returned in full up to 200 chars.
    const narrative = 'I will now analyse all 30 changed files in /src/auth to understand the scope before patching the vulnerable token-parsing code path'
    expect(narrative.length).toBeGreaterThan(120)
    expect(narrative.length).toBeLessThanOrEqual(200)
    expect(clipNarrative(narrative)).toBe(narrative) // not truncated
  })

  it('matches the new 200-char cap expression (STATUS_LINE_MAX equivalence)', () => {
    const STATUS_LINE_MAX = 200
    const samples = [
      'line one\nline two',
      '   padded   \nrest',
      'a'.repeat(150),
      'b'.repeat(250),
      'single',
      '',
      'tab\tand spaces  \nnext',
    ]
    for (const s of samples) {
      const expected = s.split('\n')[0].trim().slice(0, STATUS_LINE_MAX)
      expect(clipNarrative(s)).toBe(expected)
    }
  })
})
