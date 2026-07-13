/**
 * formatting-torture-set — curated fixtures for parse-level formatting
 * regression testing.
 *
 * Each fixture is an INTENT (`input`) plus the STRUCTURE we expect the
 * formatter's output to parse into (checked by `rich-markdown-oracle.ts`).
 * The `input` is the raw text as a model/card surface would author it — the
 * regression test runs it through the SAME outbound transform pipeline the
 * gateway uses (repairEscapedWhitespace -> normalizeParagraphBreaks ->
 * splitMarkdownChunks) and then asserts:
 *
 *   (a) every emitted chunk is parse-accept valid (no rich-path 400), and
 *   (b) the concatenated output parses into `expect` (entity structure).
 *
 * The `expect` block describes WHAT should survive, not a byte-for-byte echo
 * of formatter output — the oracle is independent of the formatter, so this is
 * a genuine cross-check, not a circular self-comparison.
 *
 * F1/F2/F4/F7 fixtures reproduce the specific formatting fixes from PR #2737
 * (see `telegram-plugin/format.ts` and `text-voice-scrub.ts`).
 */

import type { EntityType } from './rich-markdown-oracle.js'

export interface ExpectEntity {
  readonly type: EntityType
  /** Exact inner text the entity should carry. */
  readonly text: string
  /** For links, the destination. */
  readonly url?: string
  /** For fenced blocks, the language info string. */
  readonly lang?: string
}

export interface TortureFixture {
  readonly name: string
  /** One-line description of the intent this fixture pins. */
  readonly intent: string
  /** Raw authored input, before the outbound transform pipeline. */
  readonly input: string
  /**
   * Entities we expect to find in the transformed output. The test asserts
   * every listed entity is PRESENT (membership), not that these are the only
   * entities — spacer/structure passes may add nothing observable to the
   * entity set. Empty ⇒ only signal (a) is asserted for this fixture.
   */
  readonly expect: ReadonlyArray<ExpectEntity>
  /**
   * When set, the raw input is EXPECTED to be scrubbed by the card-surface
   * voice pass (F1) before it reaches the rich path — the test applies
   * `normalizeDashes` first and asserts the em/en-dash glyph is gone.
   */
  readonly cardSurfaceScrub?: boolean
}

export const TORTURE_SET: ReadonlyArray<TortureFixture> = [
  // ── Multi-item bullet list — one fact per bullet ──────────────────────────
  {
    name: 'multi-item-bullet-list',
    intent: 'A plain multi-item bullet list stays parse-valid and keeps its items intact',
    input: [
      'Findings:',
      '- Master Bath 1 is clean',
      '- Master Bath 2 shows 33% loss',
      '- Cabinet is clean',
    ].join('\n'),
    expect: [],
  },

  // ── Middot (·) separator INSIDE a bullet — the collapsed-inline case ──────
  {
    name: 'middot-separator-inside-bullet',
    intent: 'A collapsed one-line bullet list using `·` separators splits without corrupting entities',
    input: '- Master Bath 1, clean · **Master Bath 2**, 33% loss · Cabinet, clean',
    expect: [{ type: 'bold', text: 'Master Bath 2' }],
  },

  // ── Em-dash in prose (voice scrub is a DIFFERENT surface — see F1) ────────
  {
    name: 'em-dash-in-prose',
    intent: 'Prose containing an em-dash is parse-valid on the rich path (raw, un-scrubbed)',
    input: 'The audit is done — every surface checked, nothing left open.',
    expect: [],
  },

  // ── Wide / long code block ────────────────────────────────────────────────
  {
    name: 'wide-long-code-block',
    intent: 'A fenced code block with a long line and reserved chars stays balanced and verbatim',
    input: [
      'Run this:',
      '```bash',
      'grep -rnE "foo\\|bar\\|baz" src/ | awk -F: \'{print $1}\' | sort -u  # a very very very long command line that keeps going and going',
      'echo "done"',
      '```',
    ].join('\n'),
    expect: [
      {
        type: 'pre',
        lang: 'bash',
        text: [
          'grep -rnE "foo\\|bar\\|baz" src/ | awk -F: \'{print $1}\' | sort -u  # a very very very long command line that keeps going and going',
          'echo "done"',
        ].join('\n'),
      },
    ],
  },

  // ── A GFM table ───────────────────────────────────────────────────────────
  {
    name: 'gfm-table',
    intent: 'A GFM table stays row-complete (no bisected/half rows) and parse-valid',
    input: [
      'Results:',
      '',
      '| Surface | Status | Loss |',
      '| --- | --- | --- |',
      '| Bath 1 | clean | 0% |',
      '| Bath 2 | flagged | 33% |',
    ].join('\n'),
    expect: [],
  },

  // ── A nested list ─────────────────────────────────────────────────────────
  {
    name: 'nested-list',
    intent: 'A nested bullet list stays parse-valid with inline emphasis preserved',
    input: [
      '- Top level one',
      '  - Nested **bold** item',
      '  - Nested plain item',
      '- Top level two',
    ].join('\n'),
    expect: [{ type: 'bold', text: 'bold' }],
  },

  // ── A long line that wraps ────────────────────────────────────────────────
  {
    name: 'long-wrapping-line',
    intent: 'A single long prose line is parse-valid and preserves inline entities',
    input:
      'This is a single very long line of prose that would wrap on a phone screen and keeps going with more and more words to exceed a comfortable width, and it ends with an inline `code token` plus a **bold phrase** to make sure entities survive the length.',
    expect: [
      { type: 'code', text: 'code token' },
      { type: 'bold', text: 'bold phrase' },
    ],
  },

  // ── Links ─────────────────────────────────────────────────────────────────
  {
    name: 'links',
    intent: 'Inline links parse into link entities with the right label + destination',
    input:
      'See the [switchroom repo](https://github.com/switchroom/switchroom) and the [docs](https://example.com/docs) for details.',
    expect: [
      { type: 'link', text: 'switchroom repo', url: 'https://github.com/switchroom/switchroom' },
      { type: 'link', text: 'docs', url: 'https://example.com/docs' },
    ],
  },

  // ── Inline code containing reserved chars ─────────────────────────────────
  {
    name: 'inline-code-reserved-chars',
    intent: 'Inline code holding *, _, [, ], | renders verbatim without breaking entities',
    input: 'The pattern `a_b*c[d]|e` is matched literally, and `f*g` too.',
    expect: [
      { type: 'code', text: 'a_b*c[d]|e' },
      { type: 'code', text: 'f*g' },
    ],
  },

  // ── F1 — dash-scrub on the card surface ───────────────────────────────────
  // The card/worker-narration surface runs `normalizeDashes` (voice scrub)
  // before the rich path; an em-dash must not survive to the wire. Assert the
  // scrub removes the glyph AND the scrubbed text is parse-valid.
  {
    name: 'F1-card-surface-dash-scrub',
    intent: 'F1: em/en-dash is scrubbed off the card surface and the result stays parse-valid',
    input: 'Cabinet clean — 33% loss noted, second pass pending – rechecking now.',
    expect: [],
    cardSurfaceScrub: true,
  },

  // ── F2 — a stray pipe must NOT eat paragraph spacing ──────────────────────
  // A prose line containing a loose ` | ` used to be misread as a table row,
  // suppressing the paragraph break that follows. The two paragraphs must stay
  // separated and the whole thing must be parse-valid (no half-table-row).
  {
    name: 'F2-stray-pipe-keeps-paragraph-spacing',
    intent: 'F2: a loose interior pipe in prose does not collapse the following paragraph break',
    input:
      'You can choose plan A | plan B depending on scale.\n\nEither way the migration completes in one pass.',
    expect: [],
  },

  // ── F4 — blank line after a closed code fence ─────────────────────────────
  // Prose glued directly onto a fence close (single `\n`) can be swallowed.
  // The block-boundary pass inserts a blank line; the fence must stay balanced
  // and the trailing prose must survive as parse-valid text.
  {
    name: 'F4-blank-line-after-closed-fence',
    intent: 'F4: a closed fence followed immediately by prose stays balanced and the prose survives',
    input: ['Here is the fix:', '```', 'const x = 1', '```', 'And it ships today.'].join('\n'),
    expect: [{ type: 'pre', text: 'const x = 1' }],
  },

  // ── F7 — over-cap chunk falls back to hard-slice, not dropped ─────────────
  // An indivisible fenced block larger than the cap must be hard-sliced into
  // <= cap pieces rather than emitted whole (which Telegram rejects) or dropped.
  // The test drives this with a small cap so the giant block cannot fit; it
  // asserts no content is lost and every emitted chunk fits the cap.
  {
    name: 'F7-over-cap-hard-slice',
    intent: 'F7: an oversized indivisible fenced block is hard-sliced to <= cap, losing no content',
    input: '```\n' + 'x'.repeat(600) + '\n```',
    expect: [],
  },
]
