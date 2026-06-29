/**
 * Tests for normalizeParagraphBreaks (task A of the Telegram-formatting bundle).
 *
 * The rich GFM render path collapses a LONE `\n` (it's a soft break), so a model
 * that separates paragraphs with one newline produces a cramped wall of text.
 * normalizeParagraphBreaks promotes a lone *prose* `\n` into a GFM hard break
 * (`  \n`) while leaving lists, tables, blockquotes, headings, code, and genuine
 * `\n\n` gaps untouched. It is deliberately conservative — false negatives
 * (un-promoted break) are preferred over false positives (double-spaced list).
 */
import { describe, test, expect } from 'vitest'
import { normalizeParagraphBreaks } from '../format.js'

describe('normalizeParagraphBreaks', () => {
  test('promotes a lone prose paragraph break (prev ends with `.`, next is prose)', () => {
    const input = 'First thought ends here.\nSecond thought starts here.'
    expect(normalizeParagraphBreaks(input)).toBe(
      'First thought ends here.  \nSecond thought starts here.',
    )
  })

  test('promotes after ! ? and : terminators too', () => {
    expect(normalizeParagraphBreaks('Done!\nNext line here.')).toBe('Done!  \nNext line here.')
    expect(normalizeParagraphBreaks('Really?\nYes, really.')).toBe('Really?  \nYes, really.')
    expect(normalizeParagraphBreaks('Steps follow:\nDo the thing.')).toBe(
      'Steps follow:  \nDo the thing.',
    )
  })

  test('promotes when the terminator is wrapped by a closing quote or paren', () => {
    expect(normalizeParagraphBreaks('He said "go."\nThen we went.')).toBe(
      'He said "go."  \nThen we went.',
    )
    expect(normalizeParagraphBreaks('(all done.)\nMoving on now.')).toBe(
      '(all done.)  \nMoving on now.',
    )
  })

  test('does NOT promote a lone mid-sentence soft wrap (prev has no terminator)', () => {
    // A soft-wrapped sentence: the first line does not end in terminal
    // punctuation, so we leave the break alone (false negative by design).
    const input = 'this is a long sentence that wrapped\nonto a second line mid-thought'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('does NOT promote when the next line is a list item (tight list stays tight)', () => {
    const input = 'Here are the steps.\n- first\n- second\n- third'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('does NOT promote between list items (ordered or unordered)', () => {
    const ul = '- alpha.\n- beta.\n- gamma.'
    const ol = '1. first.\n2. second.\n3. third.'
    expect(normalizeParagraphBreaks(ul)).toBe(ul)
    expect(normalizeParagraphBreaks(ol)).toBe(ol)
  })

  test('does NOT promote indented (nested) list items', () => {
    const input = '- parent.\n    - child one.\n    - child two.'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('does NOT touch a markdown table', () => {
    const input = '| col a | col b |\n| --- | --- |\n| r1a | r1b |\n| r2a | r2b |'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('does NOT promote into a blockquote or heading', () => {
    expect(normalizeParagraphBreaks('As noted.\n> a quoted line')).toBe('As noted.\n> a quoted line')
    expect(normalizeParagraphBreaks('Intro line.\n# Heading')).toBe('Intro line.\n# Heading')
  })

  test('preserves a fenced code block verbatim (interior newlines untouched)', () => {
    const input = 'Look here.\n```js\nconst a = 1;\nconst b = 2;\n```\nDone.'
    const out = normalizeParagraphBreaks(input)
    // The fence body is preserved exactly — no hard break injected inside it.
    expect(out).toContain('```js\nconst a = 1;\nconst b = 2;\n```')
    // The fence start line is a marker, so the break before it is not promoted.
    expect(out).toContain('Look here.\n```js')
  })

  test('preserves inline code spans verbatim', () => {
    const input = 'Run `npm test` now.\nThen check the output.'
    const out = normalizeParagraphBreaks(input)
    expect(out).toContain('`npm test`')
    // Prose break after a sentence ending in `.` is still promoted.
    expect(out).toBe('Run `npm test` now.  \nThen check the output.')
  })

  test('preserves an existing `\\n\\n` paragraph gap (never collapses it)', () => {
    const input = 'Paragraph one.\n\nParagraph two.'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('collapses 3+ newlines down to exactly `\\n\\n`', () => {
    expect(normalizeParagraphBreaks('A.\n\n\nB.')).toBe('A.\n\nB.')
    expect(normalizeParagraphBreaks('A.\n\n\n\n\nB.')).toBe('A.\n\nB.')
  })

  test('does not promote a break adjacent to a blank line', () => {
    // The newline that is part of a `\n\n` gap must stay a plain newline, not
    // become a `  \n` hard break.
    const input = 'Done.\n\nMore prose.'
    const out = normalizeParagraphBreaks(input)
    expect(out).not.toContain('  \n\n')
    expect(out).toBe('Done.\n\nMore prose.')
  })

  test('handles a mixed body: prose promoted, list left alone, fence preserved', () => {
    const input = [
      'Summary of the change.',
      'It does two things now.',
      '',
      '- adds a normalizer',
      '- lifts the char cap',
      '',
      '```ts',
      'const x = 1',
      '```',
    ].join('\n')
    const out = normalizeParagraphBreaks(input)
    // The two prose lines get a hard break between them.
    expect(out).toContain('Summary of the change.  \nIt does two things now.')
    // The list stays tight.
    expect(out).toContain('- adds a normalizer\n- lifts the char cap')
    // The fence is intact.
    expect(out).toContain('```ts\nconst x = 1\n```')
  })

  test('returns single-line input unchanged (no newline to consider)', () => {
    expect(normalizeParagraphBreaks('just one line, no breaks')).toBe('just one line, no breaks')
  })

  test('does not double-promote an already-hard break', () => {
    // A break already followed by two trailing spaces should not gain more.
    const input = 'Done.  \nNext.'
    const out = normalizeParagraphBreaks(input)
    // prev line trimEnd() ends in `.`, so it promotes — but the result must not
    // accumulate extra spaces beyond the single `  \n` hard break.
    expect(out).toBe('Done.  \nNext.')
  })

  test('CRLF input promotes to a hard break with NO stranded `\\r`', () => {
    // A CRLF source must not leave a lone carriage return before the injected
    // `  \n`. The trailing-whitespace strip includes `\r` so the result is a
    // clean `  \n` hard break, not `  \r\n` or `\r  \n`.
    const out = normalizeParagraphBreaks('Alpha.\r\nBravo.')
    expect(out).toBe('Alpha.  \nBravo.')
    expect(out).not.toContain('\r')
  })

  test('does NOT promote a break adjacent to an indented code block', () => {
    // CommonMark indented code block (4+ leading spaces then non-space) is a
    // block marker — a break adjacent to it must NOT be promoted to a hard break.
    const input = 'Note:\n    indented code'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })
})
