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
    expect(normalizeForSpeech('the API, i.e. the interface')).toBe(
      'the API, that is, the interface',
    )
    expect(normalizeForSpeech('cats, dogs, etc.')).toBe('cats, dogs, and so on')
  })

  it('collapses excessive punctuation', () => {
    expect(normalizeForSpeech('really?!?!')).toBe('really!')
    expect(normalizeForSpeech('wow!!!')).toBe('wow!')
  })
})

describe('normalizeForSpeech — conservative, does not mangle real words', () => {
  it('leaves plain prose untouched', () => {
    expect(normalizeForSpeech('The quick brown fox jumps.')).toBe(
      'The quick brown fox jumps.',
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
