import { describe, it, expect } from 'vitest'
import {
  cleanWorkerResultParagraph,
  escapeHtml,
  formatDuration,
  stripMarkdown,
  truncate,
} from '../card-format.js'

describe('stripMarkdown', () => {
  it('strips paired bold and emphasis', () => {
    expect(stripMarkdown('a **bold** and *em* and __b__ and _e_')).toBe(
      'a bold and em and b and e',
    )
  })

  it('strips inline code spans', () => {
    expect(stripMarkdown('run `git push` now')).toBe('run git push now')
  })

  it('strips leading headings, blockquotes, bullets, and ordered items', () => {
    expect(stripMarkdown('### Heading')).toBe('Heading')
    expect(stripMarkdown('> quoted')).toBe('quoted')
    expect(stripMarkdown('- a bullet')).toBe('a bullet')
    expect(stripMarkdown('* star bullet')).toBe('star bullet')
    expect(stripMarkdown('1. first')).toBe('first')
    expect(stripMarkdown('2) second')).toBe('second')
  })

  it('reduces a link to its label', () => {
    expect(stripMarkdown('see [the PR](https://x/y) here')).toBe('see the PR here')
  })

  it('removes residual doubled markers but keeps a lone asterisk (math)', () => {
    expect(stripMarkdown('**dangling')).toBe('dangling')
    expect(stripMarkdown('3 * 4 = 12')).toBe('3 * 4 = 12')
  })

  it('does not touch HTML-significant characters (escaping stays separate)', () => {
    expect(stripMarkdown('a < b & c > d')).toBe('a < b & c > d')
  })
})

describe('cleanWorkerResultParagraph', () => {
  it('collapses multi-line Markdown into one plain paragraph', () => {
    const input = '## Done\n\n**PR #21** opened\n\n- merged\n- pushed'
    expect(cleanWorkerResultParagraph(input)).toBe('Done PR #21 opened merged pushed')
  })

  it('drops fenced code blocks entirely', () => {
    const input = 'before\n```ts\nconst x = 1\n```\nafter'
    expect(cleanWorkerResultParagraph(input)).toBe('before after')
  })

  it('drops horizontal rules', () => {
    expect(cleanWorkerResultParagraph('a\n---\nb\n***\nc')).toBe('a b c')
  })

  it('returns empty for whitespace/markup-only input', () => {
    expect(cleanWorkerResultParagraph('   \n---\n')).toBe('')
  })
})

describe('formatDuration', () => {
  it('renders sub-second as ms and seconds/minutes as MM:SS', () => {
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(1000)).toBe('00:01')
    expect(formatDuration(60_000)).toBe('01:00')
  })
})

describe('escapeHtml / truncate', () => {
  it('escapes the three HTML-significant characters', () => {
    expect(escapeHtml('a <b> & c')).toBe('a &lt;b&gt; &amp; c')
  })
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
  })
})
