/**
 * Unit tests for normalizeForSpeech — the speech-normalization pass applied
 * to a reply BEFORE it is synthesized to a voice note. Covers every case the
 * operator reported (tilde, asterisks, backticks, headings, links, code
 * fences) plus the documented behavioural choices.
 */

import { describe, it, expect } from 'bun:test'
import { normalizeForSpeech } from '../voice-normalize-text.js'

describe('normalizeForSpeech — reported markdown/symbol cases', () => {
  it('drops stray tildes (never spoken as "tilde")', () => {
    expect(normalizeForSpeech('It costs ~5 dollars')).toBe('It costs 5 dollars')
    expect(normalizeForSpeech('done ~ ok')).toBe('done ok')
  })

  it('strips bold/italic asterisks and underscores, keeping the words', () => {
    expect(normalizeForSpeech('This is **bold** text')).toBe('This is bold text')
    expect(normalizeForSpeech('This is *italic* text')).toBe('This is italic text')
    expect(normalizeForSpeech('This is _emphasis_ text')).toBe('This is emphasis text')
    expect(normalizeForSpeech('***all*** three')).toBe('all three')
  })

  it('strips strikethrough ~~text~~ to plain text', () => {
    expect(normalizeForSpeech('~~gone~~ kept')).toBe('gone kept')
  })

  it('removes backticks from inline code but keeps the content', () => {
    expect(normalizeForSpeech('run `npm test` now')).toBe('run npm test now')
  })

  it('strips headings markers', () => {
    expect(normalizeForSpeech('# Summary\nAll good')).toBe('Summary All good')
    expect(normalizeForSpeech('### Deep heading')).toBe('Deep heading')
  })

  it('speaks link text and drops the URL', () => {
    expect(normalizeForSpeech('see [the docs](https://example.com/x) here')).toBe(
      'see the docs here',
    )
  })

  it('drops a fenced code block and leaves a spoken placeholder', () => {
    const input = 'Here is code:\n```js\nconst x = 1\nconsole.log(x)\n```\nDone.'
    const out = normalizeForSpeech(input)
    expect(out).toContain('code block omitted')
    expect(out).not.toContain('const x')
    expect(out).not.toContain('```')
    expect(out).toContain('Done.')
  })
})

describe('normalizeForSpeech — additional structures', () => {
  it('converts list bullets and numbers to prose pauses', () => {
    const out = normalizeForSpeech('Steps:\n- first\n- second\n1. third')
    expect(out).not.toMatch(/[-*+]\s/)
    expect(out).not.toMatch(/^\d+\./)
    expect(out).toContain('first')
    expect(out).toContain('second')
    expect(out).toContain('third')
  })

  it('strips blockquote markers', () => {
    expect(normalizeForSpeech('> quoted line')).toBe('quoted line')
  })

  it('turns tables into prose (no pipes or separator rows)', () => {
    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const out = normalizeForSpeech(table)
    expect(out).not.toContain('|')
    expect(out).not.toContain('---')
    expect(out).toContain('A')
    expect(out).toContain('B')
  })

  it('converts arrows to the word "to"', () => {
    expect(normalizeForSpeech('build -> deploy')).toBe('build to deploy')
    expect(normalizeForSpeech('a => b')).toBe('a to b')
    expect(normalizeForSpeech('x → y')).toBe('x to y')
  })

  it('replaces bare and autolink URLs with "a link"', () => {
    expect(normalizeForSpeech('go to https://example.com now')).toBe('go to a link now')
    expect(normalizeForSpeech('go to <https://example.com>')).toBe('go to a link')
  })

  it('drops images to their alt text', () => {
    expect(normalizeForSpeech('![a cat](x.png) sits')).toBe('a cat sits')
  })

  it('collapses newlines and whitespace into sentence flow', () => {
    expect(normalizeForSpeech('Line one.\n\nLine two.')).toBe('Line one. Line two.')
    expect(normalizeForSpeech('a   b\nc')).toBe('a b c')
  })

  it('expands a minimal, safe set of abbreviations', () => {
    expect(normalizeForSpeech('use it, e.g. here')).toBe('use it, for example, here')
    expect(normalizeForSpeech('the tool, i.e. the interface')).toBe(
      'the tool, that is, the interface',
    )
    expect(normalizeForSpeech('cats, dogs, etc.')).toBe('cats, dogs, and so on')
  })

  it('collapses excessive punctuation', () => {
    expect(normalizeForSpeech('really?!?!')).toBe('really!')
    expect(normalizeForSpeech('wow!!!')).toBe('wow!')
  })
})

describe('normalizeForSpeech — emoji & pictographs', () => {
  it('strips emoji and collapses the resulting whitespace', () => {
    expect(normalizeForSpeech('done 🚀 shipping')).toBe('done shipping')
    expect(normalizeForSpeech('great 👍🏽 job')).toBe('great job')
    expect(normalizeForSpeech('🎉')).toBe('')
  })

  it('drops :shortcode: emoji forms', () => {
    expect(normalizeForSpeech('nice :rocket: work')).toBe('nice work')
  })

  it('leaves ordinary colon usage alone', () => {
    expect(normalizeForSpeech('note: this is fine')).toBe('note: this is fine')
  })
})

describe('normalizeForSpeech — numbers, units & symbols', () => {
  it('speaks percent', () => {
    expect(normalizeForSpeech('up 20% today')).toBe('up 20 percent today')
  })

  it('speaks currency amounts', () => {
    expect(normalizeForSpeech('costs $5')).toBe('costs five dollars')
    expect(normalizeForSpeech('costs $5.50')).toBe('costs five dollars fifty')
    expect(normalizeForSpeech('just $1')).toBe('just one dollar')
  })

  it('speaks standalone & as "and"', () => {
    expect(normalizeForSpeech('cats & dogs')).toBe('cats and dogs')
    expect(normalizeForSpeech('R&D team')).toBe('R and D team')
  })

  it('speaks + between words as "plus" and = as "equals"', () => {
    expect(normalizeForSpeech('speed + power')).toBe('speed plus power')
    expect(normalizeForSpeech('x = y')).toBe('x equals y')
  })

  it('speaks × / x multipliers as "times"', () => {
    expect(normalizeForSpeech('12× faster')).toBe('twelve times faster')
    expect(normalizeForSpeech('a 12x speedup')).toBe('a twelve times speedup')
  })

  it('speaks temperature degrees', () => {
    expect(normalizeForSpeech('it is 30°C outside')).toBe(
      'it is 30 degrees outside',
    )
    expect(normalizeForSpeech('72°F')).toBe('72 degrees')
  })

  it('expands number + time/size unit suffixes', () => {
    expect(normalizeForSpeech('waited 2s')).toBe('waited two seconds')
    expect(normalizeForSpeech('took 500ms')).toBe('took five hundred milliseconds')
    expect(normalizeForSpeech('run 5m')).toBe('run five minutes')
    expect(normalizeForSpeech('run 5min')).toBe('run five minutes')
    expect(normalizeForSpeech('wait 2h')).toBe('wait two hours')
    expect(normalizeForSpeech('wait 2hr')).toBe('wait two hours')
    expect(normalizeForSpeech('in 3d')).toBe('in three days')
    expect(normalizeForSpeech('10kb file')).toBe('ten kilobytes file')
    expect(normalizeForSpeech('10KB file')).toBe('ten kilobytes file')
    expect(normalizeForSpeech('a 5MB image')).toBe('a five megabytes image')
    expect(normalizeForSpeech('a 2GB dump')).toBe('a two gigabytes dump')
    expect(normalizeForSpeech('1s ping')).toBe('one second ping')
  })

  it('expands the "k" thousands shorthand', () => {
    expect(normalizeForSpeech('100k users')).toBe('one hundred thousand users')
  })

  it('leaves number-glued-to-word identifiers alone', () => {
    expect(normalizeForSpeech('my5thing works')).toBe('my5thing works')
    expect(normalizeForSpeech('class5 room')).toBe('class5 room')
  })
})

describe('normalizeForSpeech — abbreviations (phase 2)', () => {
  it('expands vs / approx / w/', () => {
    expect(normalizeForSpeech('cats vs dogs')).toBe('cats versus dogs')
    expect(normalizeForSpeech('cats vs. dogs')).toBe('cats versus dogs')
    expect(normalizeForSpeech('approx 10 items')).toBe('approximately 10 items')
    expect(normalizeForSpeech('tea w/ milk')).toBe('tea with milk')
  })
})

describe('normalizeForSpeech — acronyms', () => {
  it('spells curated initialisms letter-by-letter', () => {
    expect(normalizeForSpeech('the CI passed')).toBe('the C I passed')
    expect(normalizeForSpeech('open a PR')).toBe('open a P R')
    expect(normalizeForSpeech('call the API via HTTP')).toBe(
      'call the A P I via H T T P',
    )
    expect(normalizeForSpeech('GPU and CPU load')).toBe('G P U and C P U load')
    expect(normalizeForSpeech('parse the JSON')).toBe('parse the J S O N')
  })

  it('leaves word-style acronyms and unknown caps alone', () => {
    expect(normalizeForSpeech('NASA launch')).toBe('NASA launch')
    expect(normalizeForSpeech('the FBI report')).toBe('the FBI report')
  })

  it('does not touch caps inside a larger word', () => {
    expect(normalizeForSpeech('myAPIkey stays')).toBe('myAPIkey stays')
  })
})

describe('normalizeForSpeech — times & dates', () => {
  it('speaks clock times', () => {
    expect(normalizeForSpeech('meet at 12:45')).toBe('meet at twelve forty-five')
    expect(normalizeForSpeech('at 09:05')).toBe('at nine oh five')
    expect(normalizeForSpeech('at 14:00')).toBe("at fourteen o'clock")
  })

  it('speaks ISO dates', () => {
    expect(normalizeForSpeech('on 2026-07-01 we ship')).toBe(
      'on July first two thousand twenty-six we ship',
    )
    expect(normalizeForSpeech('2026-12-25')).toBe(
      'December twenty-fifth two thousand twenty-six',
    )
  })
})

describe('normalizeForSpeech — conservative, does not mangle real words', () => {
  it('leaves plain prose untouched', () => {
    expect(normalizeForSpeech('The quick brown fox jumps.')).toBe(
      'The quick brown fox jumps.',
    )
  })

  it('leaves lowercase day/word tokens and a symbol-free sentence alone', () => {
    expect(normalizeForSpeech('see you wednesday afternoon')).toBe(
      'see you wednesday afternoon',
    )
    expect(normalizeForSpeech('The report covers three main areas.')).toBe(
      'The report covers three main areas.',
    )
  })

  it('preserves an underscore inside an identifier-like word', () => {
    // A lone mid-word underscore is not emphasis; keep the token intact.
    expect(normalizeForSpeech('the my_var name')).toBe('the my_var name')
  })

  it('returns empty for empty/whitespace input', () => {
    expect(normalizeForSpeech('')).toBe('')
    expect(normalizeForSpeech('   \n  ')).toBe('')
  })
})
