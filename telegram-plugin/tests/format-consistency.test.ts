/**
 * Tests for the fleet-wide consistent-formatting bundle:
 *
 *   1. paragraph gap spacing — a plain `\n\n` (one blank line) at EVERY block
 *      transition (paragraph→list, list→paragraph, heading→anything,
 *      blockquote/table boundaries), never a double blank line and never an
 *      NBSP spacer (the old spacer pass was removed in the #2669 follow-up).
 *   2. normalizePunctuation — em/en dashes → comma/hyphen, leading `•`/`·`
 *      list markers → `- `, on code-masked text, idempotent; link hrefs are
 *      protected from dash rewriting.
 *   3. stripExcessBold — over-bold tripwire: >30% bold or fully-bolded
 *      paragraphs/lists lose their bold markers; short messages exempt.
 */
import { describe, test, expect } from 'vitest'
import {
  normalizeParagraphBreaks,
  normalizePunctuation,
  stripExcessBold,
  splitMarkdownChunks,
  hardenCardBreaks,
} from '../format.js'

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

  // Regression (reviewer nit): a field line that STARTS with an inline code
  // span used to be misclassified as a masked fenced-block open (fenced +
  // inline masks shared one placeholder prefix), so its lone `\n` was never
  // hardened and the card collapsed. Real victim: `/vault get` rendering
  // `` `key` = `value` `` on one line.
  test('hardens a line that STARTS with an inline code span', () => {
    const out = hardenCardBreaks('`key` = `value`\n`k2` = `v2`')
    expect(out).toBe('`key` = `value`  \n`k2` = `v2`')
  })

  test('/vault get shape (`key` =\\n`value`) hard-breaks onto two lines', () => {
    const out = hardenCardBreaks('`sk-key` =\n`hunter2`')
    expect(out).toBe('`sk-key` =  \n`hunter2`')
  })

  test('inline-span-leading fix does NOT disturb a real fenced block', () => {
    // A genuine ``` fence between two inline-span-leading field lines: the
    // field lines harden, the fence interior stays byte-for-byte intact.
    const src = '`a` = 1\n```\nx = 1\ny = 2\n```\n`b` = 2'
    const out = hardenCardBreaks(src)
    expect(out).toContain('```\nx = 1\ny = 2\n```') // fence interior untouched
    expect(out).not.toContain('x = 1  \n') // no hard break injected inside fence
  })

  test('mid-line inline spans still harden (unchanged behaviour)', () => {
    expect(hardenCardBreaks('Model: `opus`\nAuth: `Max`')).toBe(
      'Model: `opus`  \nAuth: `Max`',
    )
  })
})

describe('paragraph gap spacing — plain single blank line, no NBSP', () => {
  const NBSP = String.fromCharCode(0xa0)

  test('prose→prose gap is one blank line, no NBSP', () => {
    const out = normalizeParagraphBreaks('Alpha.\n\nBravo.')
    expect(out).toBe('Alpha.\n\nBravo.')
    expect(out).not.toContain(NBSP)
  })

  test('paragraph→list transition is a single `\\n\\n` boundary', () => {
    expect(normalizeParagraphBreaks('Intro.\n\n- one\n- two')).toBe('Intro.\n\n- one\n- two')
  })

  test('list→paragraph transition is a single `\\n\\n` boundary', () => {
    expect(normalizeParagraphBreaks('- one\n- two\n\nOutro.')).toBe('- one\n- two\n\nOutro.')
  })

  test('heading→anything is a single `\\n\\n` boundary', () => {
    expect(normalizeParagraphBreaks('# Title\n\nBody.')).toBe('# Title\n\nBody.')
    expect(normalizeParagraphBreaks('# Title\n\n- a\n- b')).toBe('# Title\n\n- a\n- b')
  })

  test('blockquote and table boundaries are single `\\n\\n`', () => {
    expect(normalizeParagraphBreaks('> quoted\n\nProse.')).toBe('> quoted\n\nProse.')
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(normalizeParagraphBreaks(`Prose.\n\n${table}`)).toBe(`Prose.\n\n${table}`)
    expect(normalizeParagraphBreaks(`${table}\n\nProse.`)).toBe(`${table}\n\nProse.`)
  })

  test('never touches code fences', () => {
    const input = '```\nA\n\nB\n```\n\n```\nC\n```'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('full pipeline: mixed prose+list message gets single-blank-line gaps, no NBSP, no double gap', () => {
    const raw = 'Summary line.\n\n- item one\n- item two\n\nClosing prose.'
    const out = normalizeParagraphBreaks(raw)
    expect(out).toBe('Summary line.\n\n- item one\n- item two\n\nClosing prose.')
    expect(out).not.toContain(NBSP)
    expect(out).not.toMatch(/\n\n\n/)
  })

  test('chunk-boundary interaction: a cut in a `\\n\\n` gap leaves clean chunks (no stray blank lines)', () => {
    const a = 'A'.repeat(60)
    const b = 'B'.repeat(60)
    const text = `${a}\n\n${b}`
    const chunks = splitMarkdownChunks(text, 80)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe(a)
    expect(chunks[1]).toBe(b)
    // Neither chunk opens or ends with a stray blank line.
    for (const c of chunks) {
      expect(c).toBe(c.replace(/^\n+|\n+$/g, ''))
    }
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

  test('does NOT rewrite a dash inside a markdown link href (#finding-2)', () => {
    // An en-dash in a URL path must survive verbatim — rewriting it to `-`
    // silently points at a different URL.
    expect(normalizePunctuation('[a](https://x.com/foo–bar)')).toBe(
      '[a](https://x.com/foo–bar)',
    )
    // An em-dash in a URL must NOT become `, ` — the injected space would
    // TERMINATE the markdown link and leak the trailing text as prose.
    expect(normalizePunctuation('[a](https://x.com/foo—bar)')).toBe(
      '[a](https://x.com/foo—bar)',
    )
    // The visible LABEL still normalizes (dashes in label text are prose).
    expect(normalizePunctuation('[foo—bar](https://x.com/path)')).toBe(
      '[foo, bar](https://x.com/path)',
    )
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
