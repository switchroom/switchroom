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
import {
  normalizeParagraphBreaks,
  splitCollapsedInlineBullets,
} from '../format.js'

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

  test('promotes every interior break in a vertical stat card (#2750)', () => {
    // The gymbro food-log card: lines end in digits/letters (no terminator),
    // but each is a standalone `label: value` stat line, so every interior
    // break must become a GFM hard break instead of collapsing to one wall.
    const input = 'Calories: 1800\nProtein: 120g\nCarbs: 200g'
    expect(normalizeParagraphBreaks(input)).toBe(
      'Calories: 1800  \nProtein: 120g  \nCarbs: 200g',
    )
  })

  test('promotes a key-value line followed by prose (#2750)', () => {
    const input = 'Status: active\nEverything is running smoothly.'
    expect(normalizeParagraphBreaks(input)).toBe(
      'Status: active  \nEverything is running smoothly.',
    )
  })

  test('promotes bold-label stat cards — colon inside AND outside the emphasis (#2750)', () => {
    // The fleet HOUSE style uses markdown-bold labels. Both `**Calories:** 1800`
    // (colon inside the bold) and `**Calories**: 1800` (colon outside) must have
    // every interior break promoted.
    const inside = '**Calories:** 1800\n**Protein:** 120g\n**Carbs:** 200g'
    expect(normalizeParagraphBreaks(inside)).toBe(
      '**Calories:** 1800  \n**Protein:** 120g  \n**Carbs:** 200g',
    )
    const outside = '**Calories**: 1800\n**Protein**: 120g'
    expect(normalizeParagraphBreaks(outside)).toBe('**Calories**: 1800  \n**Protein**: 120g')
  })

  test('regression guard: a mid-sentence colon soft-wrap still does NOT promote (#2750)', () => {
    // A wrapped sentence that happens to contain a colon must NOT be mistaken
    // for a stat line: the next line continues the sentence in lowercase.
    const input = 'He made one point: the plan was sound and\nthe timing was right too'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('regression guard: a long colon-clause with a CAPITAL continuation does NOT promote (#2750)', () => {
    // The lowercase-continuation guard alone would miss this: the wrapped clause
    // continues with a capitalised proper noun. The label before the colon is a
    // long multi-word run (not a short stat label), so the word/length cap keeps
    // it from being mistaken for a stat line.
    const input = 'The deal has one catch: the buyer wants it and\nToronto lawyers must sign off'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('lowercase-label stat cards are an ACCEPTED false-negative (not promoted) (#2750)', () => {
    // `calories: 1800\nprotein: 120g` — the lowercase-started next line is
    // indistinguishable from a mid-sentence soft-wrap continuation, so the
    // conservative guard leaves it alone. Documented, not fixed: models are
    // steered toward capitalised / bold labels, and a false-negative (un-promoted
    // break) is the module's preferred failure mode over a false-positive.
    const input = 'calories: 1800\nprotein: 120g'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('list glued to prose gains a block-boundary blank line; interior stays tight', () => {
    // Uniform-block-spacing: a list start glued to prose by a single `\n`
    // gets a blank line (so the spacer pass can see the transition); the
    // list's own single-`\n` interior is never touched.
    const input = 'Here are the steps.\n- first\n- second\n- third'
    expect(normalizeParagraphBreaks(input)).toBe(
      'Here are the steps.\n\n- first\n- second\n- third',
    )
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

  test('does NOT promote into a blockquote or heading (but DOES guarantee a block-start blank line)', () => {
    // The lone `\n` is never promoted to a hard break (`  \n`) when the next
    // line is a blockquote / heading marker — but Step 3 DOES guarantee the
    // blank line a GFM block needs to start, so prose→quote and prose→heading
    // transitions get a `\n\n` gap (the block renders correctly).
    expect(normalizeParagraphBreaks('As noted.\n> a quoted line')).toBe(
      'As noted.\n\n> a quoted line',
    )
    expect(normalizeParagraphBreaks('Intro line.\n# Heading')).toBe('Intro line.\n\n# Heading')
    // No spurious hard break (`  \n`) is ever introduced at the boundary.
    expect(normalizeParagraphBreaks('As noted.\n> a quoted line')).not.toContain('  \n')
  })

  test('preserves a fenced code block verbatim (interior newlines untouched)', () => {
    const input = 'Look here.\n```js\nconst a = 1;\nconst b = 2;\n```\nDone.'
    const out = normalizeParagraphBreaks(input)
    // The fence body is preserved exactly — no hard break injected inside it.
    expect(out).toContain('```js\nconst a = 1;\nconst b = 2;\n```')
    // A blank line is guaranteed BEFORE the fence open so it starts a fresh
    // GFM code block instead of being glued to the preceding prose line.
    expect(out).toContain('Look here.\n\n```js')
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

  // -------------------------------------------------------------------------
  // Step 3 — block-boundary blank-line guarantee. A GFM block glued to the
  // previous line by a single `\n` fails to render (a table prints as literal
  // pipe text; prose after a list is absorbed as a lazy list continuation).
  // These cases capture the two live-render bugs plus the regression guards
  // that the tight-list / code / table-internals constraints depend on.
  // -------------------------------------------------------------------------

  test('inserts a blank line before a table header glued to a single-`\\n` text line (VERIFY 5)', () => {
    // The live render showed the table printing as inline literal pipe text
    // because only a single `\n` separated the preceding text line from the
    // table's first row. A blank line must be inserted BEFORE the header, and
    // header + delimiter + body rows must stay contiguous (single `\n`).
    const input =
      'VERIFY 5 — GFM table\n| Name | Role |\n|---|---|\n| Ada | Engineer |\n| Bob | Designer |'
    expect(normalizeParagraphBreaks(input)).toBe(
      'VERIFY 5 — GFM table\n\n| Name | Role |\n|---|---|\n| Ada | Engineer |\n| Bob | Designer |',
    )
  })

  test('inserts a blank line before post-list prose, list stays tight, fence untouched (VERIFY 7)', () => {
    // The live render showed "A prose line after the list." absorbed into the
    // last bullet (GFM lazy continuation). A blank line must break it out of
    // the list, while the bullets stay tight and the fence stays verbatim.
    const input =
      'VERIFY 7 — mixed\n' +
      'This first prose sentence stands alone.\n' +
      'This second prose sentence should show a gap above it.\n' +
      '- bullet\n' +
      '- list\n' +
      'A prose line after the list.\n' +
      '```\n' +
      'echo hello.\n' +
      'echo world.\n' +
      '```'
    const out = normalizeParagraphBreaks(input)
    // The two leading prose sentences are promoted (each ends in `.`).
    expect(out).toContain(
      'This first prose sentence stands alone.  \nThis second prose sentence should show a gap above it.',
    )
    // The bullet items stay TIGHT — no blank line between same-list items.
    expect(out).toContain('- bullet\n- list')
    // The post-list prose is separated from the list by a blank line.
    expect(out).toContain('- list\n\nA prose line after the list.')
    // The fence interior is untouched and the fence is preceded by a blank line.
    expect(out).toContain('```\necho hello.\necho world.\n```')
    expect(out).toContain('A prose line after the list.\n\n```')
  })

  test('regression: a pure tight bullet list stays tight (no blank lines inserted)', () => {
    const input = '- alpha\n- beta\n- gamma'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('regression: a pure tight numbered list stays tight (no blank lines inserted)', () => {
    const input = '1. first\n2. second\n3. third'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('regression: existing `\\n\\n` paragraphs are unchanged (no extra gap)', () => {
    const input = 'Para one.\n\nPara two.\n\nPara three.'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('regression: a fenced code block with `|` pipes / `-` lines is NOT treated as a table', () => {
    // The pipes and dashes live INSIDE a fence — masking must keep them out of
    // the table heuristic so no spurious blank line is injected inside or
    // around the code, and the interior is byte-for-byte preserved.
    const input = 'Header here.\n```\n| not | a | table |\n|---|---|---|\n--- dash line\n```'
    const out = normalizeParagraphBreaks(input)
    // The fence interior is verbatim — pipes and dashes untouched.
    expect(out).toContain('```\n| not | a | table |\n|---|---|---|\n--- dash line\n```')
    // The fence open gets its block-start blank line (it's a code block, not a
    // table) but nothing inside it is reflowed.
    expect(out).toBe(
      'Header here.\n\n```\n| not | a | table |\n|---|---|---|\n--- dash line\n```',
    )
  })

  test('a heading after prose gets its block-start blank line', () => {
    expect(normalizeParagraphBreaks('Some intro prose.\n## Section')).toBe(
      'Some intro prose.\n\n## Section',
    )
  })

  test('a blockquote after prose gets its block-start blank line', () => {
    expect(normalizeParagraphBreaks('Some intro prose.\n> quoted wisdom')).toBe(
      'Some intro prose.\n\n> quoted wisdom',
    )
  })

  test('does NOT split a table header from its delimiter or body rows', () => {
    // A table already preceded by a blank line must keep all of its own rows
    // contiguous (single `\n`) — the blank-line rule only fires BEFORE the
    // header, never between header/delimiter/body.
    const input = 'Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('list followed by an indented continuation line stays glued (no breakout)', () => {
    // A 4-space indented line under a bullet is a lazy paragraph continuation
    // of that item, not breakout prose — it must NOT gain a blank line.
    const input = '- first item\n    continued text of the first item'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('F2: prose with an interior ` | ` gets normal paragraph-break treatment (not table)', () => {
    // `isMarkerLine` used to treat any line containing ` | ` as a table row and
    // suppress the paragraph-break promotion. A sentence like "choose A | B" is
    // prose, not a table — the lone `\n` after a terminated prose line must
    // still be promoted to a GFM hard break.
    const input = 'Pick one option, choose A | B here.\nThen continue below.'
    expect(normalizeParagraphBreaks(input)).toBe(
      'Pick one option, choose A | B here.  \nThen continue below.',
    )
  })

  test('F2: a genuine table (header + delimiter) is still detected as structural', () => {
    // The tightened check must still recognise a real GFM table: a blank line
    // is inserted before the header and the rows stay contiguous.
    const input = 'Here is data.\n| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(normalizeParagraphBreaks(input)).toBe(
      'Here is data.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
    )
  })

  test('F4: blank line inserted after a closed code fence before glued prose', () => {
    // Prose glued directly onto a fence close (single `\n`) can be swallowed /
    // mis-parsed. A blank line after a closed fence is always CommonMark-safe.
    const input = 'Intro.\n\n```\nconst x = 1\n```\nThen the prose continues.'
    const out = normalizeParagraphBreaks(input)
    // The fence interior is untouched...
    expect(out).toContain('```\nconst x = 1\n```')
    // ...and a blank line now separates the fence close from the following prose.
    expect(out).toContain('```\n\nThen the prose continues.')
  })
})

// ---------------------------------------------------------------------------
// splitCollapsedInlineBullets — stack an inline-collapsed bullet list
// ---------------------------------------------------------------------------

describe('splitCollapsedInlineBullets', () => {
  test('splits the bath-bulb run-on (4 inline bullets → 4 lines)', () => {
    const input =
      '• Master Bath 1, clean • Master Bath 2, 33% packet loss • Master Bath 3, clean • Cabinet, clean'
    expect(splitCollapsedInlineBullets(input)).toBe(
      '• Master Bath 1, clean\n• Master Bath 2, 33% packet loss\n• Master Bath 3, clean\n• Cabinet, clean',
    )
  })

  test('a bold segment inside one bullet survives the split', () => {
    const input = '• A, clean • **Master Bath 2** (192.168.5.252), **33% loss** • C, clean'
    expect(splitCollapsedInlineBullets(input)).toBe(
      '• A, clean\n• **Master Bath 2** (192.168.5.252), **33% loss**\n• C, clean',
    )
  })

  test('a <b> segment inside one bullet survives the split', () => {
    const input = '• A, clean • <b>Master Bath 2</b>, <b>33% packet loss</b> • C, clean'
    expect(splitCollapsedInlineBullets(input)).toBe(
      '• A, clean\n• <b>Master Bath 2</b>, <b>33% packet loss</b>\n• C, clean',
    )
  })

  test('splits on the middle-dot `·` separator too, and a `·`-led line', () => {
    const input = '· one · two · three'
    expect(splitCollapsedInlineBullets(input)).toBe('· one\n· two\n· three')
  })

  test('accepts a `-` or `*` leading marker (but only splits unicode interior bullets)', () => {
    expect(splitCollapsedInlineBullets('- lead marker • two • three')).toBe(
      '- lead marker\n• two\n• three',
    )
    expect(splitCollapsedInlineBullets('* lead marker • two')).toBe('* lead marker\n• two')
  })

  test('prose containing a mid-sentence `•` (line does not start with a bullet) is untouched', () => {
    const input = 'The plan uses A • B notation throughout the design doc.'
    expect(splitCollapsedInlineBullets(input)).toBe(input)
  })

  test('does NOT split on interior `-`/`*` (hyphens, ranges, multiplication)', () => {
    const input = '• range 1-3 and a * b product stay on one bullet'
    // No interior unicode bullet → line is returned unchanged.
    expect(splitCollapsedInlineBullets(input)).toBe(input)
  })

  test('is idempotent on the bath-bulb input', () => {
    const input =
      '• Master Bath 1, clean • Master Bath 2, 33% packet loss • Master Bath 3, clean • Cabinet, clean'
    const once = splitCollapsedInlineBullets(input)
    const twice = splitCollapsedInlineBullets(once)
    expect(twice).toBe(once)
  })

  test('an already-correct multi-line bullet list passes through unchanged', () => {
    const input = '• Master Bath 1, clean\n• Master Bath 2, 33% loss\n• Cabinet, clean'
    expect(splitCollapsedInlineBullets(input)).toBe(input)
  })
})

// ---------------------------------------------------------------------------
// Paragraph gap spacing — plain \n\n, no NBSP spacer (#2669 follow-up).
//
// The NBSP paragraph-spacer (addParagraphSpacers / PARAGRAPH_SPACER) was
// REMOVED: its premise — that the Bot API 10.1 rich GFM renderer collapses a
// `\n\n` gap TIGHT — is false for the live renderer, which shows a `\n\n` gap
// as one normal blank line. The spacer therefore injected a spurious SECOND
// blank line (`\n\n \n\n`) between every paragraph fleet-wide. Paragraph
// spacing now relies on the plain `\n\n` that normalizeParagraphBreaks already
// guarantees. These tests pin: multi-paragraph output has exactly one blank
// line per gap, and no U+00A0 anywhere.
// ---------------------------------------------------------------------------

describe('paragraph gap spacing — single blank line, no NBSP', () => {
  const NBSP = String.fromCharCode(0xa0)

  test('a two-paragraph prose body has exactly one blank-line gap and no NBSP', () => {
    const out = normalizeParagraphBreaks('Paragraph one.\n\nParagraph two.')
    expect(out).toBe('Paragraph one.\n\nParagraph two.')
    expect(out).not.toContain(NBSP)
    // Exactly one empty line between the two content lines.
    expect(out.split('\n')).toEqual(['Paragraph one.', '', 'Paragraph two.'])
  })

  test('a three-paragraph body keeps single-blank-line gaps, no NBSP', () => {
    const out = normalizeParagraphBreaks('One.\n\nTwo.\n\nThree.')
    expect(out).toBe('One.\n\nTwo.\n\nThree.')
    expect(out).not.toContain(NBSP)
    // No gap is a DOUBLE blank line (`\n\n\n`), which the old spacer produced.
    expect(out).not.toMatch(/\n\n\n/)
  })

  test('prose->list transition is a single `\n\n` boundary, list interior tight', () => {
    const out = normalizeParagraphBreaks('Here are the steps.\n\n- first\n- second')
    expect(out).toBe('Here are the steps.\n\n- first\n- second')
    expect(out).not.toContain(NBSP)
  })

  test('composed prose+list body: one blank line per gap, no NBSP, no double gap', () => {
    const input = [
      'Summary of the change.',
      '',
      'It does two things.',
      '',
      '- adds a normalizer',
      '- lifts the cap',
    ].join('\n')
    const out = normalizeParagraphBreaks(input)
    expect(out).toContain('Summary of the change.\n\nIt does two things.')
    expect(out).toContain('It does two things.\n\n- adds a normalizer\n- lifts the cap')
    expect(out).not.toContain(NBSP)
    expect(out).not.toMatch(/\n\n\n/)
  })
})

describe('normalizeParagraphBreaks — inline bullet split integration', () => {
  test('splits the bath-bulb run-on as part of the full outbound pass', () => {
    const input =
      '• Master Bath 1, clean • Master Bath 2, 33% packet loss • Master Bath 3, clean • Cabinet, clean'
    expect(normalizeParagraphBreaks(input)).toBe(
      '• Master Bath 1, clean\n• Master Bath 2, 33% packet loss\n• Master Bath 3, clean\n• Cabinet, clean',
    )
  })

  test('a `•` inside an inline code span is NOT split (code masked)', () => {
    const input = '`• a • b • c` is a code span'
    // The line does not start with a bullet marker (it starts with the masked
    // code placeholder), and the bullets live inside masked code regardless.
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('a `•` inside a fenced code block is NOT split', () => {
    const input = '```\n• a • b • c\n```'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('idempotent through the full pass on the bath-bulb input', () => {
    const input =
      '• Master Bath 1, clean • Master Bath 2, 33% packet loss • Cabinet, clean'
    const once = normalizeParagraphBreaks(input)
    const twice = normalizeParagraphBreaks(once)
    expect(twice).toBe(once)
  })
})

/**
 * Regression guard for the stray whitespace-only blank line between paragraphs
 * (the "\n\n \n\n" seen in a real reply). A model (or an upstream transform)
 * that authors a blank line whose only content is ASCII whitespace leaves a
 * ragged / oversized gap: CommonMark discards it so it buys no visible space,
 * but it reads as noise in the raw text. Step 1 of normalizeParagraphBreaks now
 * collapses any run of blank lines — including whitespace-only interior lines —
 * to exactly one clean `\n\n`. The collapse is deliberately ASCII-only, so a
 * genuine user-typed U+00A0 line survives (the conservative choice; there is no
 * longer an NBSP paragraph spacer to protect — that pass was removed).
 */
describe('normalizeParagraphBreaks — whitespace-only blank-line collapse (Bug 2)', () => {
  const NBSP = String.fromCharCode(0xa0)

  test('a lone-space blank line between paragraphs collapses to a clean `\\n\\n` (real string)', () => {
    const input =
      "Here's what was fixed and how it validates.\n\n \n\n" +
      'One loose end: a stray thing.'
    expect(normalizeParagraphBreaks(input)).toBe(
      "Here's what was fixed and how it validates.\n\n" +
        'One loose end: a stray thing.',
    )
  })

  test('a single whitespace-only blank line (`A\\n \\nB`) collapses to `\\n\\n`', () => {
    expect(normalizeParagraphBreaks('Alpha para.\n \nBravo para.')).toBe(
      'Alpha para.\n\nBravo para.',
    )
    expect(normalizeParagraphBreaks('Alpha para.\n\t\nBravo para.')).toBe(
      'Alpha para.\n\nBravo para.',
    )
  })

  test('multiple stray whitespace-only lines in one gap collapse to a single `\\n\\n`', () => {
    expect(normalizeParagraphBreaks('A.\n\n \n\n \n\nB.')).toBe('A.\n\nB.')
  })

  test('a legitimate single `\\n\\n` paragraph break is preserved exactly', () => {
    expect(normalizeParagraphBreaks('Alpha para.\n\nBravo para.')).toBe(
      'Alpha para.\n\nBravo para.',
    )
  })

  test('never EMITS a whitespace-only line between two prose paragraphs', () => {
    const out = normalizeParagraphBreaks('First.\n\n  \n\nSecond.')
    for (const line of out.split('\n')) {
      // Every line is either empty or has real (non-ASCII-whitespace) content.
      expect(line === '' || /\S/.test(line) || line.includes(NBSP)).toBe(true)
    }
    expect(out).toBe('First.\n\nSecond.')
  })

  test('a blank line inside a fenced code block (masked) is NOT collapsed', () => {
    const input = '```\ncode line 1\n \ncode line 2\n```'
    // The whitespace-only line lives inside a masked fence and must survive.
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('trailing hard-break spaces on a CONTENT line are not eaten', () => {
    // "line.  \n\nNext." — the two trailing spaces are a GFM hard break on a
    // content line, not a blank line; they must survive.
    const input = 'Trailing spaces on line.  \n\nNext.'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('a genuine user-typed U+00A0-only line survives (ASCII-only collapse)', () => {
    // The blank-line collapse is deliberately ASCII-only, so a non-breaking
    // space a user actually typed on its own line is not silently eaten.
    const input = 'Alpha para.\n' + NBSP + '\nBravo para.'
    expect(normalizeParagraphBreaks(input)).toBe(input)
  })

  test('idempotent: collapsing a stray gap twice is stable', () => {
    const once = normalizeParagraphBreaks('A.\n\n \n\nB.')
    const twice = normalizeParagraphBreaks(once)
    expect(twice).toBe(once)
    expect(once).toBe('A.\n\nB.')
  })
})
