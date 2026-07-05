/**
 * Tests for the fleet-wide consistent-formatting bundle:
 *
 *   1. addParagraphSpacers extension — a visible U+00A0 spacer line at EVERY
 *      block transition (paragraph→list, list→paragraph, heading→anything,
 *      blockquote/table boundaries), never inside a list/table interior.
 *   2. normalizePunctuation — em/en dashes → comma/hyphen, leading `•`/`·`
 *      list markers → `- `, on code-masked text, idempotent.
 *   3. stripExcessBold — over-bold tripwire: >30% bold or fully-bolded
 *      paragraphs/lists lose their bold markers; short messages exempt.
 */
import { describe, test, expect } from 'vitest'
import {
  addParagraphSpacers,
  normalizeParagraphBreaks,
  normalizePunctuation,
  stripExcessBold,
  splitMarkdownChunks,
  hardenCardBreaks,
  PARAGRAPH_SPACER,
} from '../format.js'

const SP = PARAGRAPH_SPACER // U+00A0

describe('hardenCardBreaks — deterministic card line-break hardener', () => {
  test('promotes lone field breaks to GFM hard breaks (the blob fix)', () => {
    const out = hardenCardBreaks('Agent: assistant\nAuth: Max\nStatus: running')
    expect(out).toBe('Agent: assistant  \nAuth: Max  \nStatus: running')
  })

  test('preserves `\\n\\n` block gaps (not promoted)', () => {
    const out = hardenCardBreaks('**Header**\nfield one\n\n**Next**\nfield two')
    expect(out).toBe('**Header**  \nfield one\n\n**Next**  \nfield two')
  })

  test('leaves GFM list items on their native single `\\n`', () => {
    const out = hardenCardBreaks('- one\n- two\n- three')
    expect(out).toBe('- one\n- two\n- three')
  })

  test('leaves GFM table rows untouched', () => {
    const src = '| a | b |\n| - | - |\n| 1 | 2 |'
    expect(hardenCardBreaks(src)).toBe(src)
  })

  test('never touches a fenced code block interior', () => {
    const src = '**Accounts**\n```\nalice  ok\nbob    ok\n```\n**Agents**'
    // The fenced monospace table keeps its single `\n`s; the header lines that
    // face the fence are not hard-broken (fence line is a block construct).
    expect(hardenCardBreaks(src)).toBe(src)
  })

  test('does not hard-break across a heading or blockquote', () => {
    expect(hardenCardBreaks('# Title\nbody')).toBe('# Title\nbody')
    expect(hardenCardBreaks('> quote\nbody')).toBe('> quote\nbody')
  })

  test('collapses 3+ newline runs to a single `\\n\\n` gap', () => {
    expect(hardenCardBreaks('a\n\n\n\nb')).toBe('a\n\nb')
  })

  test('is idempotent', () => {
    const src = 'Agent: x\nAuth: y\n\n**H**\n🟢 Broker running\n🟢 Kernel up'
    const once = hardenCardBreaks(src)
    expect(hardenCardBreaks(once)).toBe(once)
  })

  test('no-op for single-line text', () => {
    expect(hardenCardBreaks('just one line')).toBe('just one line')
  })
})

describe('addParagraphSpacers — uniform block spacing', () => {
  test('still spaces prose→prose (existing behaviour)', () => {
    const out = addParagraphSpacers('Alpha.\n\nBravo.')
    expect(out).toBe(`Alpha.\n\n${SP}\n\nBravo.`)
  })

  test('spaces paragraph→list transition', () => {
    const out = addParagraphSpacers('Intro.\n\n- one\n- two')
    expect(out).toBe(`Intro.\n\n${SP}\n\n- one\n- two`)
  })

  test('spaces list→paragraph transition', () => {
    const out = addParagraphSpacers('- one\n- two\n\nOutro.')
    expect(out).toBe(`- one\n- two\n\n${SP}\n\nOutro.`)
  })

  test('spaces heading→anything', () => {
    expect(addParagraphSpacers('# Title\n\nBody.')).toBe(`# Title\n\n${SP}\n\nBody.`)
    expect(addParagraphSpacers('# Title\n\n- a\n- b')).toBe(`# Title\n\n${SP}\n\n- a\n- b`)
  })

  test('spaces blockquote and table boundaries', () => {
    expect(addParagraphSpacers('> quoted\n\nProse.')).toBe(`> quoted\n\n${SP}\n\nProse.`)
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(addParagraphSpacers(`Prose.\n\n${table}`)).toBe(`Prose.\n\n${SP}\n\n${table}`)
    expect(addParagraphSpacers(`${table}\n\nProse.`)).toBe(`${table}\n\n${SP}\n\nProse.`)
  })

  test('does NOT space between items of the same loose list', () => {
    const input = '- one\n\n- two\n\n- three'
    expect(addParagraphSpacers(input)).toBe(input)
  })

  test('does NOT space inside a tight list or table interior (single \\n)', () => {
    const list = 'Intro.\n\n- a\n- b\n- c'
    expect(addParagraphSpacers(list)).toBe(`Intro.\n\n${SP}\n\n- a\n- b\n- c`)
    const table = '| a |\n| --- |\n| 1 |\n| 2 |'
    expect(addParagraphSpacers(table)).toBe(table)
  })

  test('idempotent across every transition kind', () => {
    const input = '# H\n\nProse one.\n\n- a\n- b\n\nProse two.\n\n> quote'
    const once = addParagraphSpacers(input)
    expect(addParagraphSpacers(once)).toBe(once)
  })

  test('never touches code fences', () => {
    const input = '```\nA\n\nB\n```\n\n```\nC\n```'
    expect(addParagraphSpacers(input)).toBe(input)
  })

  test('full pipeline: mixed prose+list+heading message gets uniform gaps', () => {
    const raw = 'Summary line.\n- item one\n- item two\nClosing prose.'
    const out = addParagraphSpacers(normalizeParagraphBreaks(raw))
    // Every block transition carries exactly one visible spacer line.
    expect(out).toBe(
      `Summary line.\n\n${SP}\n\n- item one\n- item two\n\n${SP}\n\nClosing prose.`,
    )
  })

  test('chunk-boundary interaction: a cut in a spacer gap strips the spacer', () => {
    const a = 'A'.repeat(60)
    const b = 'B'.repeat(60)
    const text = `${a}\n\n${SP}\n\n${b}`
    const chunks = splitMarkdownChunks(text, 80)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe(a)
    expect(chunks[1]).toBe(b)
  })
})

describe('normalizePunctuation', () => {
  test('spaced em-dash → comma', () => {
    expect(normalizePunctuation('voice came back — three PRs stacked')).toBe(
      'voice came back, three PRs stacked',
    )
  })

  test('spaced en-dash → comma', () => {
    expect(normalizePunctuation('one thing – another thing')).toBe('one thing, another thing')
  })

  test('bare em-dash between words → comma', () => {
    expect(normalizePunctuation('word—word')).toBe('word, word')
  })

  test('bare en-dash between words → hyphen (ranges survive as ASCII)', () => {
    expect(normalizePunctuation('2019–2024')).toBe('2019-2024')
    expect(normalizePunctuation('pre–war')).toBe('pre-war')
  })

  test('digit-flanked spaced dash → hyphen range, not comma', () => {
    expect(normalizePunctuation('3 – 5 days')).toBe('3-5 days')
    expect(normalizePunctuation('10 — 20')).toBe('10-20')
  })

  test('leading • and · bullets → `- ` (indent preserved)', () => {
    expect(normalizePunctuation('• one\n• two')).toBe('- one\n- two')
    expect(normalizePunctuation('  · indented')).toBe('  - indented')
  })

  test('mid-line bullet glyph untouched', () => {
    expect(normalizePunctuation('rated 4.5 • 120 reviews')).toBe('rated 4.5 • 120 reviews')
  })

  test('never touches code spans or fences', () => {
    const input = 'run `a — b` now\n\n```\nx — y\n• bullet\n```'
    expect(normalizePunctuation(input)).toBe(input)
  })

  test('idempotent', () => {
    const once = normalizePunctuation('a — b\n• c\nd—e\n1–2')
    expect(normalizePunctuation(once)).toBe(once)
  })

  test('consecutive spaced dashes all normalize in ONE pass (#2755 finding 2)', () => {
    expect(normalizePunctuation('a — b — c')).toBe('a, b, c')
    expect(normalizePunctuation('one — two — three — four')).toBe('one, two, three, four')
    expect(normalizePunctuation('x—y—z')).toBe('x, y, z')
    expect(normalizePunctuation('1–2–3')).toBe('1-2-3')
  })

  test('cross-path ordering: normalizePunctuation before scrubVoice yields the comma treatment', async () => {
    // The stream path runs normalizePunctuation BEFORE scrubVoice, same as
    // reply/edit — so a spaced em-dash gets the comma substitution on every
    // path, and scrubVoice (period substitution) finds no dash left. Pins
    // the #2755 finding-1 ordering contract.
    const { scrubVoice } = await import('../text-voice-scrub.js')
    const input = 'voice came back — three PRs stacked'
    const normalized = normalizePunctuation(input)
    const scrub = scrubVoice(normalized)
    expect(normalized).toBe('voice came back, three PRs stacked')
    expect(scrub.replaced).toBe(0)
    expect(scrub.scrubbed).toBe(normalized)
  })
})

describe('stripExcessBold', () => {
  const filler =
    'This is an ordinary paragraph of connected prose that provides enough plain ' +
    'characters to clear the one-hundred character exemption comfortably.'

  test('short messages (<100 chars) exempt even when fully bold', () => {
    const input = '**Everything here is bold.**'
    expect(stripExcessBold(input)).toBe(input)
  })

  test('strips all bold when >30% of non-code chars are bold', () => {
    const bold = '**' + 'B'.repeat(80) + '**'
    const input = `${bold} plus a little plain text tail here.`
    const out = stripExcessBold(input)
    expect(out).not.toContain('**')
    expect(out).toContain('B'.repeat(80))
  })

  test('keeps bold when clearly under threshold', () => {
    const input = `${filler} The key fact is **42**.`
    expect(stripExcessBold(input)).toBe(input)
  })

  test('strips a fully-bolded multi-line paragraph, leaves others', () => {
    const input = `${filler}\n\n**This whole paragraph is bold.**\n**Every single line of it.**`
    const out = stripExcessBold(input)
    expect(out).toContain('This whole paragraph is bold.')
    expect(out).not.toContain('**This whole paragraph is bold.**')
    expect(out.startsWith(filler)).toBe(true)
  })

  test('single short fully-bolded line (pseudo-heading) survives', () => {
    const input = `**Summary**\n\n${filler}`
    expect(stripExcessBold(input)).toBe(input)
  })

  test('strips a list whose EVERY item is fully bolded', () => {
    const input = `${filler}\n\n- **alpha item**\n- **bravo item**\n- **charlie item**`
    const out = stripExcessBold(input)
    expect(out).toContain('- alpha item')
    expect(out).not.toContain('**alpha item**')
  })

  test('leaves a list where only some items are bolded', () => {
    const input = `${filler}\n\n- **alpha item**\n- plain bravo\n- plain charlie`
    expect(stripExcessBold(input)).toBe(input)
  })

  test('code regions neither counted nor modified', () => {
    const fence = '```\n**not really bold**\n' + 'x'.repeat(400) + '\n```'
    const input = `${filler} Key: **fact**.\n\n${fence}`
    const out = stripExcessBold(input)
    expect(out).toContain('**not really bold**')
    expect(out).toContain('**fact**')
  })

  test('idempotent', () => {
    const bold = '**' + 'B'.repeat(80) + '**'
    const input = `${bold} plus a little plain text tail.`
    const once = stripExcessBold(input)
    expect(stripExcessBold(once)).toBe(once)
  })
})
