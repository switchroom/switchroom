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

import { scrubVoice, normalizeDashes } from '../text-voice-scrub.js'

/**
 * Regression guard for the em-dash comma-splice bug seen in a real reply
 * (the #2737-era voice scrub). The original #1683 rule degraded a
 * clause-joining em-dash to a comma when the next word was lowercase, which
 * joined two independent clauses with a comma — a comma splice ("voice came
 * back, three PRs stacked"). The fix degrades to a full stop and recapitalizes
 * the following word, so the output is never a splice. These tests use the
 * verbatim failure strings from the stored bad message.
 */
describe('scrubVoice — em-dash between clauses never produces a comma splice', () => {
  beforeEach(() => {
    delete process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
    delete process.env.SWITCHROOM_VOICE_STRIP_OPENERS
  })

  it('lowercase-continued independent clause becomes two sentences, not a splice (real string 1)', () => {
    const r = scrubVoice('**Why voice came back** — three PRs stacked')
    // Was: "**Why voice came back**, three PRs stacked" (comma splice).
    expect(r.scrubbed).toBe('**Why voice came back**. Three PRs stacked')
    expect(r.scrubbed).not.toContain('**, three')
    expect(r.replaced).toBe(1)
  })

  it('lowercase-continued independent clause becomes two sentences, not a splice (real string 2)', () => {
    const r = scrubVoice(
      'never reached the agents — this is what unblocked everything today.',
    )
    // Was: "...the agents, this is what unblocked..." (comma splice).
    expect(r.scrubbed).toBe(
      'never reached the agents. This is what unblocked everything today.',
    )
    expect(r.scrubbed).not.toContain('agents, this')
    expect(r.replaced).toBe(1)
  })

  it('the scrubbed output contains no ", <lowercase clause>" splice for any spaced dash', () => {
    const r = scrubVoice(
      'first thing — second independent clause and — third one here',
    )
    // No comma directly joining the two independent clauses.
    expect(r.scrubbed).toBe(
      'first thing. Second independent clause and. Third one here',
    )
  })

  it('normalizeDashes (card / worker-narration path) also avoids the splice', () => {
    // The non-reply surfaces reuse normalizeDashes; same splice-free rule.
    expect(normalizeDashes('came back — three PRs stacked')).toBe(
      'came back. Three PRs stacked',
    )
  })

  it('a dash before a NON-letter (digit / paren) is not wrongly recapitalized', () => {
    // capFirst only touches an ASCII lowercase letter; a digit / punctuation
    // start is left as-is after the full stop.
    expect(normalizeDashes('the count — 3 items remain')).toBe(
      'the count. 3 items remain',
    )
    expect(normalizeDashes('the note — (see appendix)')).toBe(
      'the note. (see appendix)',
    )
  })

  it('dashes inside code spans, fenced blocks, and URLs are still never touched', () => {
    const input =
      'prose — one\n' +
      'inline `a — b — c` stays\n' +
      '```\nfenced x — y — z stays\n```\n' +
      'link https://ex.io/a—b—c stays too — end'
    const r = scrubVoice(input)
    expect(r.scrubbed).toContain('`a — b — c`')
    expect(r.scrubbed).toContain('fenced x — y — z stays')
    expect(r.scrubbed).toContain('https://ex.io/a—b—c')
    // Only the two prose dashes were scrubbed (to full stops).
    expect(r.scrubbed).toContain('prose. One')
    expect(r.scrubbed).toContain('stays too. End')
    expect(r.replaced).toBe(2)
  })

  it('a double-space inside inline code / a URL is left untouched by the scrub', () => {
    // The scrub must not normalize whitespace inside protected regions.
    const r = scrubVoice('keep `foo  bar` and http://h/a  b intact — done')
    expect(r.scrubbed).toContain('`foo  bar`')
    expect(r.scrubbed).toContain('http://h/a  b')
    expect(r.scrubbed).toContain('intact. Done')
  })
})

describe('scrubVoice — em / en dash replacement', () => {
  beforeEach(() => {
    delete process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
  })
  afterEach(() => {
    delete process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
  })

  describe('mechanical rewrite of spaced dashes', () => {
    it('replaces a spaced em-dash before lowercase with a full stop (no comma splice)', () => {
      // #1683 originally emitted a comma here, which produced a comma splice
      // between two independent clauses ("on it, checking the calendar"). The
      // splice-free rule degrades the clause-joining dash to a period and
      // recapitalizes the following word.
      const r = scrubVoice('on it — checking the calendar')
      expect(r.scrubbed).toBe('on it. Checking the calendar')
      expect(r.replaced).toBe(1)
    })

    it('replaces a spaced em-dash before an uppercase letter with a period', () => {
      // The model often writes "Here's the result — Done." style.
      const r = scrubVoice("Here's the result — Done.")
      expect(r.scrubbed).toBe("Here's the result. Done.")
      expect(r.replaced).toBe(1)
    })

    it('handles multiple em-dashes in one sentence (each becomes a full stop)', () => {
      const r = scrubVoice('one — two — three — done')
      expect(r.scrubbed).toBe('one. Two. Three. Done')
      expect(r.replaced).toBe(3)
    })

    it('treats en-dash (–) identically to em-dash', () => {
      const r = scrubVoice('on it – checking the calendar')
      expect(r.scrubbed).toBe('on it. Checking the calendar')
      expect(r.replaced).toBe(1)
    })

    it('replaces unspaced word-dash-word with a full stop (no comma splice)', () => {
      // Less common but seen in tightly-typed prose. Same splice-free rule as
      // the spaced form: a period plus a recapitalized following word.
      const r = scrubVoice('flag—on or flag—off')
      expect(r.scrubbed).toBe('flag. On or flag. Off')
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
        'here is code:\n```bash\nfoo --bar — baz\n```\nand prose. Done',
      )
      expect(r.replaced).toBe(1)
    })

    it('preserves dashes inside inline code', () => {
      const r = scrubVoice('the flag `--really — keep` matters — yes')
      expect(r.scrubbed).toBe('the flag `--really — keep` matters. Yes')
      expect(r.replaced).toBe(1)
    })

    it('preserves dashes inside <code> HTML tags', () => {
      const r = scrubVoice('see <code>x — y</code> and note — ok')
      expect(r.scrubbed).toBe('see <code>x — y</code> and note. Ok')
      expect(r.replaced).toBe(1)
    })

    it('preserves dashes inside <pre> HTML tags', () => {
      const r = scrubVoice('block:\n<pre>x — y\nz — w</pre>\nend — ok')
      expect(r.scrubbed).toBe('block:\n<pre>x — y\nz — w</pre>\nend. Ok')
      expect(r.replaced).toBe(1)
    })

    it('preserves dashes inside URLs', () => {
      const r = scrubVoice('see https://example.com/a—b for context — ok')
      expect(r.scrubbed).toBe(
        'see https://example.com/a—b for context. Ok',
      )
      expect(r.replaced).toBe(1)
    })

    it('preserves a code block containing markdown that could otherwise match', () => {
      // The placeholder restore must put the original raw fence back,
      // not a transformed copy.
      const fence =
        '```\n# heading — title\nfunction f() {}\n```'
      const r = scrubVoice(fence + '\ntrailing — yes')
      expect(r.scrubbed).toBe(fence + '\ntrailing. Yes')
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
        "I'll check the calendar. Should take a few seconds. " +
        'Result: empty for Saturday. Nothing scheduled. Anything else?',
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
        'Running `git status --short`. Looks clean. ' +
        '```\nM file.ts — modified\n```\n' +
        'Ready to commit. Go?',
      )
      expect(r.replaced).toBe(2)
    })
  })
})

describe('scrubVoice — leading sycophancy openers (opt-in backstop)', () => {
  // The opener strip is OFF by default (tone is the prompt's job); these
  // tests opt it in to exercise the mechanism that remains available via
  // SWITCHROOM_VOICE_STRIP_OPENERS=1.
  beforeEach(() => {
    delete process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
    process.env.SWITCHROOM_VOICE_STRIP_OPENERS = '1'
  })
  afterEach(() => {
    delete process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
    delete process.env.SWITCHROOM_VOICE_STRIP_OPENERS
  })

  it('strips a leading "You\'re absolutely right" and recapitalizes', () => {
    const r = scrubVoice("You're absolutely right, the build is broken.")
    expect(r.scrubbed).toBe('The build is broken.')
    expect(r.openersStripped).toBe(1)
    expect(r.replaced).toBeGreaterThan(0) // total counts the opener
  })

  it('strips the affirmation even when only an opener changed (no dashes)', () => {
    // Regression: the gateway gates on `replaced > 0`; an opener-only
    // strip MUST still report replaced > 0 or the scrub is discarded.
    const r = scrubVoice('Great catch! I fixed the off-by-one.')
    expect(r.scrubbed).toBe('I fixed the off-by-one.')
    expect(r.replaced).toBe(1)
    expect(r.openersStripped).toBe(1)
  })

  it('consumes a trailing em-dash after the opener (no leftover dash)', () => {
    const r = scrubVoice('Exactly right — the token had expired.')
    expect(r.scrubbed).toBe('The token had expired.')
    expect(r.openersStripped).toBe(1)
  })

  it('handles curly apostrophe and "you are" form', () => {
    expect(scrubVoice('You’re absolutely right. Done.').scrubbed).toBe('Done.')
    expect(scrubVoice('You are absolutely right, done.').scrubbed).toBe('Done.')
  })

  it('leaves a standalone affirmation ack intact (no content follows)', () => {
    const r = scrubVoice("You're absolutely right!")
    expect(r.scrubbed).toBe("You're absolutely right!")
    expect(r.openersStripped).toBe(0)
  })

  it('does NOT strip bare "you\'re right" (often load-bearing)', () => {
    const r = scrubVoice("You're right that the config drifted.")
    expect(r.scrubbed).toBe("You're right that the config drifted.")
    expect(r.openersStripped).toBe(0)
  })

  it('does NOT strip an affirmation mid-message', () => {
    const r = scrubVoice('I checked the logs. Great catch on the typo.')
    expect(r.scrubbed).toBe('I checked the logs. Great catch on the typo.')
    expect(r.openersStripped).toBe(0)
  })

  it('does NOT over-strip when the phrase is a literal sentence start (no separator)', () => {
    // The affirmation must be followed by a separator/end, not a bare
    // space into more words — otherwise "Spot on the map..." loses "Spot
    // on". These are real sentences, not detachable affirmations.
    for (const s of [
      'Spot on the map shows three sites.',
      'Good catch basin overflow is the root cause.',
      'Exactly right now, the count is 3.',
      'Absolutely right turns are banned on that road.',
    ]) {
      const r = scrubVoice(s)
      expect(r.scrubbed, s).toBe(s)
      expect(r.openersStripped, s).toBe(0)
    }
  })

  it('still strips when a separator follows (comma / period / dash)', () => {
    expect(scrubVoice('Spot on, the value is 5.').scrubbed).toBe('The value is 5.')
    expect(scrubVoice('Good catch. Fixed it.').scrubbed).toBe('Fixed it.')
  })

  it('does not touch an opener-like phrase inside code', () => {
    const r = scrubVoice('`spot on` is the variable name. Here is the value.')
    expect(r.scrubbed).toContain('`spot on`')
    expect(r.openersStripped).toBe(0)
  })

  it('kill switch disables opener strip too', () => {
    process.env.SWITCHROOM_DISABLE_VOICE_SCRUB = '1'
    const r = scrubVoice("You're absolutely right, the build is broken.")
    expect(r.scrubbed).toBe("You're absolutely right, the build is broken.")
    expect(r.replaced).toBe(0)
    expect(r.openersStripped).toBe(0)
  })
})

describe('scrubVoice — opener strip is OFF by default (prompt carries tone)', () => {
  // No SWITCHROOM_VOICE_STRIP_OPENERS set: the deterministic layer must
  // NOT delete words. Em-dash normalization (punctuation, no content
  // removed) still runs. Tone is the prompt VOICE directive's job.
  beforeEach(() => {
    delete process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
    delete process.env.SWITCHROOM_VOICE_STRIP_OPENERS
  })
  afterEach(() => {
    delete process.env.SWITCHROOM_VOICE_STRIP_OPENERS
  })

  it('does NOT strip a leading affirmation by default', () => {
    const r = scrubVoice("You're absolutely right, the build is broken.")
    expect(r.scrubbed).toBe("You're absolutely right, the build is broken.")
    expect(r.openersStripped).toBe(0)
  })

  it('does NOT strip "Great catch" by default', () => {
    const r = scrubVoice('Great catch! Fixed it.')
    expect(r.scrubbed).toBe('Great catch! Fixed it.')
    expect(r.openersStripped).toBe(0)
  })

  it('STILL normalizes em-dashes by default (punctuation, no content removed)', () => {
    const r = scrubVoice('on it — checking the calendar')
    expect(r.scrubbed).toBe('on it. Checking the calendar')
    expect(r.replaced).toBe(1)
    expect(r.openersStripped).toBe(0)
  })

  it('an affirmation opener with an em-dash keeps the words, fixes only the dash', () => {
    const r = scrubVoice('Exactly right — the token had expired.')
    // Opener preserved (strip is OFF); the em-dash between two independent
    // clauses becomes a full stop, not a comma (no splice).
    expect(r.scrubbed).toBe('Exactly right. The token had expired.')
    expect(r.openersStripped).toBe(0)
    expect(r.replaced).toBe(1)
  })
})
