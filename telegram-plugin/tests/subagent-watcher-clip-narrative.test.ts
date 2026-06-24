import { describe, it, expect } from 'vitest'
import { clipNarrative } from '../tool-activity-summary.js'

// subagent-watcher.ts now routes its narrative clip through the shared
// `clipNarrative` primitive (replacing the inline
// `ev.text.split('\n')[0].trim().slice(0, 120)`), so the watcher and the
// gateway narrative-step path collapse multi-line text identically. These
// tests pin that shared contract: first line only, trimmed, ≤ 120 chars.

describe('clipNarrative — shared subagent-watcher narrative clip', () => {
  it('collapses a multi-line block to its first line', () => {
    const text = 'On it. Let me find the repo…\nthen build it\nand run the tests'
    expect(clipNarrative(text)).toBe('On it. Let me find the repo…')
  })

  it('trims surrounding whitespace on the first line', () => {
    expect(clipNarrative('   Found both repos:   \nmore')).toBe('Found both repos:')
  })

  it('caps the first line at 120 characters', () => {
    const long = 'x'.repeat(200)
    const out = clipNarrative(long)
    expect(out.length).toBe(120)
    expect(out).toBe('x'.repeat(120))
  })

  it('a first line under 120 chars is returned verbatim', () => {
    expect(clipNarrative('short narrative line')).toBe('short narrative line')
  })

  it('matches the old inline expression exactly (regression equivalence)', () => {
    const samples = [
      'line one\nline two',
      '   padded   \nrest',
      'a'.repeat(150),
      'single',
      '',
      'tab\tand spaces  \nnext',
    ]
    for (const s of samples) {
      const inline = s.split('\n')[0].trim().slice(0, 120)
      expect(clipNarrative(s)).toBe(inline)
    }
  })
})
