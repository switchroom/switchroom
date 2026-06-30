import { describe, it, expect } from 'vitest'
import {
  cleanWorkerResultParagraph,
  formatDuration,
  stackCardLines,
  stripMarkdown,
  truncate,
} from '../card-format.js'
import { escapeMarkdown } from '../format.js'

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

  it('strips leading block markup on EVERY line, not just the string start', () => {
    // The screenshot regression: a worker summary that opens with prose
    // ("Done.") then a `## Summary` heading mid-string. Without the `gm`
    // flags the heading marker leaked into the rendered card.
    const headed = stripMarkdown('Done.\n\n## Summary\n\nFixed the bug')
    expect(headed).not.toContain('##')
    expect(headed).toContain('Done.')
    expect(headed).toContain('Summary')
    expect(headed).toContain('Fixed the bug')

    const mixed = stripMarkdown('intro\n> quoted\n- item')
    expect(mixed).not.toMatch(/(^|\n)\s*[>\-*]/)
    expect(mixed).toContain('quoted')
    expect(mixed).toContain('item')
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

describe('escapeMarkdown / truncate', () => {
  it('escapes the inline-markdown specials, leaving < > & literal (#2669)', () => {
    // The HTML escaper is gone; escapeMarkdown escapes \ ` * _ ~ = [ ] | only.
    expect(escapeMarkdown('a <b> & c')).toBe('a <b> & c')
    expect(escapeMarkdown('a *b* _c_')).toBe('a \\*b\\* \\_c\\_')
  })
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
  })
})

describe('stackCardLines — card bodies stack like the reply path', () => {
  // The bug this fixes: the rich-message renderer (#2669) treats a LONE `\n`
  // between two non-blank lines as a SOFT break and collapses them onto one
  // visual line. A card built as a list of styled prose lines and joined with
  // `\n` therefore renders as a run-on blob. stackCardLines promotes every
  // inter-line break to a GFM hard break (`  \n`) so the lines stack — the
  // same end-state the reply path reaches via normalizeParagraphBreaks.

  it('promotes every inter-line break to a GFM hard break so bullets stack', () => {
    const out = stackCardLines(['_✓ Reading a.ts_', '_✓ Searching memory_', '**→ List workspace**'])
    expect(out).toBe('_✓ Reading a.ts_  \n_✓ Searching memory_  \n**→ List workspace**')
    // No LONE `\n` survives between non-blank lines — every break is a hard break.
    expect(out.replace(/ {2}\n/g, '')).not.toContain('\n')
  })

  it('single line is returned verbatim (no trailing hard break)', () => {
    expect(stackCardLines(['**→ Reading a.ts**'])).toBe('**→ Reading a.ts**')
  })

  it('preserves an intentional blank-line paragraph gap', () => {
    // A blank entry is a genuine `\n\n` gap (e.g. boot card header → rows);
    // it must NOT become a hard-break run — the blank reconstructs the gap.
    const out = stackCardLines(['🔔 **Header**', '', '_✓ row one_', '_✓ row two_'])
    expect(out).toBe('🔔 **Header**\n\n_✓ row one_  \n_✓ row two_')
  })

  it('does not accumulate trailing spaces on a re-run (idempotent breaks)', () => {
    const once = stackCardLines(['a.', 'b.', 'c.'])
    // Feeding the stacked output back in (split on hard break) yields the same.
    const twice = stackCardLines(once.split('  \n'))
    expect(twice).toBe(once)
  })

  it('keeps bold, code-spans and the worker-result rule intact (only breaks change)', () => {
    const out = stackCardLines([
      '🛠 **Worker** · _build_',
      '_✓ Running `git push`_',
      '─────',
      '✅ _Fixed the **bug** in `foo.ts`_',
    ])
    // Inline markup is untouched — bold, code spans, the rule line all survive.
    expect(out).toContain('**Worker**')
    expect(out).toContain('`git push`')
    expect(out).toContain('Fixed the **bug** in `foo.ts`')
    expect(out).toContain('─────')
    // And the four lines stack (three hard breaks, no soft breaks).
    expect(out.match(/ {2}\n/g)?.length).toBe(3)
  })
})
