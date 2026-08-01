/**
 * Tests for the fleet-wide consistent-formatting bundle:
 *
 *   1. addParagraphSpacers — a visible U+00A0 spacer line at EVERY block
 *      transition (paragraph→list, list→paragraph, heading→anything,
 *      blockquote/table boundaries), idempotent and double-gap-proof; list/
 *      table interiors stay tight. Restored after the #3208 F1 misfire — the
 *      rich GFM renderer renders a bare `\n\n` gap TIGHT, so the spacer is what
 *      produces the visible paragraph gap.
 *   2. normalizePunctuation — em/en dashes → comma/hyphen, leading `•`/`·`
 *      list markers → `- `, on code-masked text, idempotent; link hrefs are
 *      protected from dash rewriting.
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

  test('does NOT rewrite a dash inside a `<scheme:…>` autolink (#finding-2 sibling)', () => {
    // An en-dash in an angle-bracket autolink URL must survive verbatim.
    expect(normalizePunctuation('<https://x.com/foo–bar>')).toBe('<https://x.com/foo–bar>')
    // An em-dash in an autolink must NOT become `, `.
    expect(normalizePunctuation('<https://x.com/foo—bar>')).toBe('<https://x.com/foo—bar>')
    // Autolink mid-prose: the surrounding prose still normalizes, the URL does not.
    expect(normalizePunctuation('see <https://x.com/a–b> now — go')).toBe(
      'see <https://x.com/a–b> now, go',
    )
    // Arbitrary `<…>` prose (no scheme) is NOT treated as an autolink: a dash
    // inside it still normalizes like ordinary text.
    expect(normalizePunctuation('<not—a—url>')).toBe('<not, a, url>')
  })

  test('does NOT rewrite a dash inside a `>` blockquote (verbatim quote)', () => {
    // `>` blockquotes hold quoted text the author is reproducing verbatim;
    // rewriting their em-dash to `, ` corrupts the quotation.
    expect(normalizePunctuation('> she said — plainly — no')).toBe(
      '> she said — plainly — no',
    )
    // Indented blockquote line is still a blockquote.
    expect(normalizePunctuation('  > quoted — text')).toBe('  > quoted — text')
    // The expandable-blockquote opener `**>` is a blockquote line too.
    expect(normalizePunctuation('**> first — line\n> continues — here')).toBe(
      '**> first — line\n> continues — here',
    )
    // Prose OUTSIDE the quote still normalizes; only the quoted line is spared.
    expect(normalizePunctuation('intro — here\n> quote — verbatim\nafter — end')).toBe(
      'intro, here\n> quote — verbatim\nafter, end',
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

  // ── Heading exemption in the GLOBAL (>30%) rule ──────────────────────────
  // A bold-dense digest tripped the global ratio and lost EVERY bold marker,
  // including its section headings, with no signal. Short standalone
  // pseudo-heading blocks must now survive the global strip.

  const boldDenseBody =
    '**alpha** **bravo** **charlie** **delta** **echo** **foxtrot** **golf** ' +
    '**hotel** **india** **juliet** **kilo** **lima** plus a short plain tail here.'

  test('global strip keeps a short standalone bold heading, strips the rest', () => {
    const input = `**Section One**\n\n${boldDenseBody}`
    const out = stripExcessBold(input)
    // Heading survives.
    expect(out).toContain('**Section One**')
    // Non-heading inline bold is flattened.
    expect(out).toContain('alpha')
    expect(out).not.toContain('**alpha**')
    expect(out).not.toContain('**golf**')
  })

  test('global strip preserves EVERY heading in a multi-section digest', () => {
    const input =
      `**Overview**\n\n${boldDenseBody}\n\n` +
      `**Next steps:**\n\n**one** **two** **three** **four** **five** **six** ` +
      'plus a plain closing clause long enough to matter here.'
    const out = stripExcessBold(input)
    expect(out).toContain('**Overview**')
    expect(out).toContain('**Next steps:**')
    expect(out).not.toContain('**one**')
    expect(out).not.toContain('**six**')
  })

  test('regression: global strip with NO headings still fully strips', () => {
    const input = `${boldDenseBody}`
    const out = stripExcessBold(input)
    expect(out).not.toContain('**')
    expect(out).toContain('alpha')
  })

  test('regression: under-threshold message keeps all bold (incl. headings)', () => {
    const input = `**Summary**\n\n${filler} The key fact is **42**.`
    expect(stripExcessBold(input)).toBe(input)
  })

  test('64/65-char pseudo-heading boundary honoured under global strip', () => {
    // Heading length is measured WITH the `**` markers. 60 inner chars → 64
    // total (exempt); 61 inner chars → 65 total (stripped).
    const heading64 = '**' + 'H'.repeat(60) + '**' // length 64
    const heading65 = '**' + 'H'.repeat(61) + '**' // length 65
    expect(heading64.length).toBe(64)
    expect(heading65.length).toBe(65)

    const out64 = stripExcessBold(`${heading64}\n\n${boldDenseBody}`)
    expect(out64).toContain(heading64)

    const out65 = stripExcessBold(`${heading65}\n\n${boldDenseBody}`)
    expect(out65).not.toContain(heading65)
    expect(out65).toContain('H'.repeat(61))
  })

  // ── #4021: long-but-legitimate bold section labels survive ───────────────
  // At PSEUDO_HEADING_MAX_CHARS=48 a real section label of 50-63 chars was
  // read as an over-bolded paragraph and flattened. The cap is 64.

  test.each([
    // [label, survives?]
    ['**Deployment status across all three regions:**', true], // 46
    ['**Deployment status across all three AWS regions:**', true], // 50
    ['**What changed in the delivery path since last Tuesday:**', true], // 56
    ['**What actually changed in the delivery path since Tue:**', true], // 56
    ['**Everything that changed across the delivery path this week:**', true], // 62
    ['**Everything that changed across the whole delivery path today:**', false], // 65
  ])('bold section label %s survives=%s under global strip', (label, survives) => {
    // Sanity: the fixtures must straddle the 64-char boundary.
    expect(label.length <= 64).toBe(survives)

    const out = stripExcessBold(`${label}\n\n${boldDenseBody}`)
    const inner = label.slice(2, -2)
    if (survives) {
      expect(out).toContain(label)
    } else {
      expect(out).not.toContain(label)
      expect(out).toContain(inner)
    }
    // Either way the body is still flattened — the ratio guard is intact.
    expect(out).not.toContain('**alpha**')
  })

  // ── #4017: a message that is ALL pseudo-headings still strips ────────────
  // Every block exempted meant `out === masked`: a 100%-bold digest stayed
  // fully bold and onStrip never fired.

  test('all-pseudo-heading message strips (no body to contrast against)', () => {
    const input = [
      '**Deploy status**',
      '**Open incidents**',
      '**Merged today**',
      '**Blocked on review**',
      '**Rollout window tomorrow**',
      '**Next steps:**',
    ].join('\n\n')
    expect(input.length).toBeGreaterThan(100)

    const calls: Array<{ rule: string; ratio: number }> = []
    const out = stripExcessBold(input, (d) => calls.push(d))

    expect(out).not.toContain('**')
    expect(out).toContain('Deploy status')
    expect(out).toContain('Next steps:')
    // Blank-line gaps between the headings are preserved.
    expect(out).toBe(input.replace(/\*\*/g, ''))
    // …and the strip is logged.
    expect(calls).toHaveLength(1)
    expect(calls[0].rule).toBe('global')
    expect(calls[0].ratio).toBeGreaterThan(0.3)
  })

  test.each([
    [
      'all headings, no body → strip',
      `**Deploy status**\n\n**Open incidents this morning**\n\n**Merged today since the last release**\n\n**Next steps:**`,
      false,
    ],
    [
      'headings + bold-dense body → headings survive',
      `**Deploy status**\n\n${boldDenseBody}`,
      true,
    ],
    [
      'headings around a bold-dense body → headings survive',
      `**Deploy status**\n\n**Open incidents**\n\n${boldDenseBody}\n\n**Next steps:**`,
      true,
    ],
  ])('all-heading guard: %s', (_name, input, headingSurvives) => {
    expect(input.length).toBeGreaterThan(100)
    const out = stripExcessBold(input)
    expect(out.includes('**Deploy status**')).toBe(headingSurvives)
    expect(out).toContain('Deploy status')
  })

  // ── #4114: a code-only block is NOT body for the all-heading guard ───────
  // #4108's short-circuit tested `blocks.every(isPseudoHeadingBlock)` on every
  // non-blank block. A masked code block satisfies neither side, so ONE code
  // fence in an all-headings digest flipped `every(...)` to false, re-exempted
  // every heading, and reproduced #4017 exactly: 100% bold, onStrip silent.
  // Decision pinned here: masked code is not body — it is invisible to every
  // other measurement in stripExcessBold (it is stripped before the ratio is
  // taken), so it does not buy the headings an exemption either.

  const HEADINGS = ['**Deploy status**', '**Open incidents**', '**Merged today**']
  const TAIL = ['**Blocked on review**', '**Rollout window tomorrow**', '**Next steps:**']

  test.each([
    ['fenced code block', '```\nswitchroom agent restart klanker\n```'],
    ['inline code span', '`switchroom agent restart klanker`'],
    ['fenced block with a language tag', '```bash\nswitchroom agent restart klanker\n```'],
    ['several inline spans on one line', '`alpha` `beta` `gamma` `delta` `epsilon`'],
  ])('all-heading guard: headings + a code-only block (%s) still strips', (_name, code) => {
    const input = [...HEADINGS, code, ...TAIL].join('\n\n')
    expect(input.length).toBeGreaterThan(100)

    const calls: Array<{ rule: string; ratio: number }> = []
    const out = stripExcessBold(input, (d) => calls.push(d))

    // Outcome 1: no bold survives — this is the assertion that fails on the
    // real bug, where `out` was the input verbatim.
    expect(out).not.toContain('**')
    expect(out).toContain('Deploy status')
    expect(out).toContain('Next steps:')
    // Outcome 2: the code block itself is preserved byte-for-byte.
    expect(out).toContain(code)
    expect(out).toBe(input.replace(/\*\*/g, ''))
    // Outcome 3: the strip is logged (the #4017 silence is what made this
    // class of bug invisible in the first place).
    expect(calls).toHaveLength(1)
    expect(calls[0].rule).toBe('global')
    expect(calls[0].ratio).toBeGreaterThan(0.3)
  })

  test('all-heading guard: real prose body CONTAINING inline code keeps headings', () => {
    // The counterpart that stops the #4114 fix from over-correcting: a block
    // with visible text around its code span IS body, so the headings keep
    // their bold. Only blocks that are *nothing but* code are skipped.
    const input = [
      ...HEADINGS,
      'Run `switchroom agent restart klanker` now, then check the gateway log for errors.',
      ...TAIL,
    ].join('\n\n')

    const calls: Array<{ rule: string; ratio: number }> = []
    const out = stripExcessBold(input, (d) => calls.push(d))

    expect(out).toContain('**Deploy status**')
    expect(out).toContain('**Next steps:**')
    expect(calls).toHaveLength(0)
  })

  test('all-heading guard: a code-only block does not rescue a headings-only digest', () => {
    // Degenerate shape: the code block is the ONLY non-heading block and sits
    // last. Same verdict, so the rule does not depend on block position.
    const input = [...HEADINGS, ...TAIL, '```\nok\n```'].join('\n\n')
    const out = stripExcessBold(input)
    expect(out).not.toContain('**')
    expect(out).toContain('```\nok\n```')
  })

  test('multi-line fully-bolded block is NOT mislabelled a heading (global)', () => {
    // Two bolded lines in one block must be flattened, not exempted — the
    // heading exemption is single-line only.
    const input = `**First bold line here**\n**Second bold line here**\n\n${boldDenseBody}`
    const out = stripExcessBold(input)
    expect(out).not.toContain('**First bold line here**')
    expect(out).toContain('First bold line here')
  })

  // ── Observability ────────────────────────────────────────────────────────
  test('onStrip fires with rule=global + ratio when global rule strips', () => {
    const calls: Array<{ rule: string; ratio: number }> = []
    stripExcessBold(`**Section One**\n\n${boldDenseBody}`, (d) => calls.push(d))
    expect(calls).toHaveLength(1)
    expect(calls[0].rule).toBe('global')
    expect(calls[0].ratio).toBeGreaterThan(0.3)
  })

  test('onStrip fires with rule=per-block when only a block is flattened', () => {
    const calls: Array<{ rule: string; ratio: number }> = []
    const input = `${filler}\n\n**This whole paragraph is bold.**\n**Every single line of it.**`
    stripExcessBold(input, (d) => calls.push(d))
    expect(calls).toHaveLength(1)
    expect(calls[0].rule).toBe('per-block')
    expect(calls[0].ratio).toBeLessThanOrEqual(0.3)
  })

  test('onStrip does NOT fire when nothing is stripped', () => {
    const calls: Array<{ rule: string; ratio: number }> = []
    stripExcessBold(`**Summary**\n\n${filler} The key fact is **42**.`, (d) => calls.push(d))
    expect(calls).toHaveLength(0)
  })
})
