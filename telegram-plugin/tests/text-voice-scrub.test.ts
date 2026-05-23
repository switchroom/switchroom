/**
 * Unit suite for #1683 text-voice-scrub.
 *
 * The fleet sample on 2026-05-23 showed 73% of outbound replies
 * shipped at least one em-dash despite the SOUL.md.hbs soft rule.
 * These tests pin the deterministic transform that the framework
 * enforces, including the code/inline/HTML/URL preservation that
 * keeps the scrub from mangling legitimate non-prose contexts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scrubVoice } from '../text-voice-scrub.js'

describe('scrubVoice — em / en dash replacement', () => {
  beforeEach(() => {
    delete process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
  })
  afterEach(() => {
    delete process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
  })

  describe('mechanical rewrite of spaced dashes', () => {
    it('replaces a spaced em-dash before lowercase with a comma', () => {
      const r = scrubVoice('on it — checking the calendar')
      expect(r.scrubbed).toBe('on it, checking the calendar')
      expect(r.replaced).toBe(1)
    })

    it('replaces a spaced em-dash before an uppercase letter with a period', () => {
      // The model often writes "Here's the result — Done." style.
      const r = scrubVoice("Here's the result — Done.")
      expect(r.scrubbed).toBe("Here's the result. Done.")
      expect(r.replaced).toBe(1)
    })

    it('handles multiple em-dashes in one sentence', () => {
      const r = scrubVoice('one — two — three — done')
      expect(r.scrubbed).toBe('one, two, three, done')
      expect(r.replaced).toBe(3)
    })

    it('treats en-dash (–) identically to em-dash', () => {
      const r = scrubVoice('on it – checking the calendar')
      expect(r.scrubbed).toBe('on it, checking the calendar')
      expect(r.replaced).toBe(1)
    })

    it('replaces unspaced word-dash-word as a comma', () => {
      // Less common but seen in tightly-typed prose.
      const r = scrubVoice('flag—on or flag—off')
      expect(r.scrubbed).toBe('flag, on or flag, off')
      expect(r.replaced).toBe(2)
    })

    it('replaces end-of-line dashes with a period', () => {
      const r = scrubVoice('thinking out loud —\nnext line here')
      expect(r.scrubbed).toBe('thinking out loud.\nnext line here')
      expect(r.replaced).toBe(1)
    })

    it('converts a leading-dash sentence-start to ASCII hyphen', () => {
      // Quoted-style or list-bullet em-dash at message start; falls
      // through to the catch-all rule.
      const r = scrubVoice('— note: ship it')
      expect(r.scrubbed).toBe('- note: ship it')
      expect(r.replaced).toBe(1)
    })
  })

  describe('protected regions are left alone', () => {
    it('preserves dashes inside fenced code blocks', () => {
      const input = 'here is code:\n```bash\nfoo --bar — baz\n```\nand prose — done'
      const r = scrubVoice(input)
      expect(r.scrubbed).toBe(
        'here is code:\n```bash\nfoo --bar — baz\n```\nand prose, done',
      )
      expect(r.replaced).toBe(1)
    })

    it('preserves dashes inside inline code', () => {
      const r = scrubVoice('the flag `--really — keep` matters — yes')
      expect(r.scrubbed).toBe('the flag `--really — keep` matters, yes')
      expect(r.replaced).toBe(1)
    })

    it('preserves dashes inside <code> HTML tags', () => {
      const r = scrubVoice('see <code>x — y</code> and note — ok')
      expect(r.scrubbed).toBe('see <code>x — y</code> and note, ok')
      expect(r.replaced).toBe(1)
    })

    it('preserves dashes inside <pre> HTML tags', () => {
      const r = scrubVoice('block:\n<pre>x — y\nz — w</pre>\nend — ok')
      expect(r.scrubbed).toBe('block:\n<pre>x — y\nz — w</pre>\nend, ok')
      expect(r.replaced).toBe(1)
    })

    it('preserves dashes inside URLs', () => {
      const r = scrubVoice('see https://example.com/a—b for context — ok')
      expect(r.scrubbed).toBe(
        'see https://example.com/a—b for context, ok',
      )
      expect(r.replaced).toBe(1)
    })

    it('preserves a code block containing markdown that could otherwise match', () => {
      // The placeholder restore must put the original raw fence back,
      // not a transformed copy.
      const fence =
        '```\n# heading — title\nfunction f() {}\n```'
      const r = scrubVoice(fence + '\ntrailing — yes')
      expect(r.scrubbed).toBe(fence + '\ntrailing, yes')
      expect(r.replaced).toBe(1)
    })
  })

  describe('no-op cases', () => {
    it('returns identity (same string, replaced=0) when input has no dashes', () => {
      const input = 'no dashes anywhere, just commas and periods.'
      const r = scrubVoice(input)
      expect(r.scrubbed).toBe(input)
      expect(r.replaced).toBe(0)
    })

    it('returns identity when input is empty', () => {
      const r = scrubVoice('')
      expect(r.scrubbed).toBe('')
      expect(r.replaced).toBe(0)
    })

    it('kill switch (SWITCHROOM_DISABLE_VOICE_SCRUB=1) returns input unchanged', () => {
      process.env.SWITCHROOM_DISABLE_VOICE_SCRUB = '1'
      const r = scrubVoice('on it — checking')
      expect(r.scrubbed).toBe('on it — checking')
      expect(r.replaced).toBe(0)
    })

    it('kill switch accepts "true" as well as "1"', () => {
      process.env.SWITCHROOM_DISABLE_VOICE_SCRUB = 'true'
      const r = scrubVoice('on it — checking')
      expect(r.scrubbed).toBe('on it — checking')
      expect(r.replaced).toBe(0)
    })
  })

  describe('realistic fleet samples', () => {
    it('scrubs a multi-step status message', () => {
      const input =
        "I'll check the calendar — should take a few seconds. " +
        'Result: empty for Saturday — nothing scheduled. Anything else?'
      const r = scrubVoice(input)
      expect(r.scrubbed).toBe(
        "I'll check the calendar, should take a few seconds. " +
        'Result: empty for Saturday, nothing scheduled. Anything else?',
      )
      expect(r.replaced).toBe(2)
    })

    it('mixed prose and code keeps the code untouched', () => {
      const input =
        'Running `git status --short` — looks clean. ' +
        '```\nM file.ts — modified\n```\n' +
        'Ready to commit — go?'
      const r = scrubVoice(input)
      expect(r.scrubbed).toBe(
        'Running `git status --short`, looks clean. ' +
        '```\nM file.ts — modified\n```\n' +
        'Ready to commit, go?',
      )
      expect(r.replaced).toBe(2)
    })
  })
})
