/**
 * Parse-level formatting regression suite.
 *
 * GOAL: catch formatting regressions at the *parse* level, not the string
 * level. For every torture-set fixture we run the raw intent through the SAME
 * outbound transform pipeline the gateway uses, then assert TWO independent
 * signals via `rich-markdown-oracle.ts` (an independent CommonMark/GFM
 * validator — NOT the formatter echoing itself):
 *
 *   (a) PARSE-ACCEPT — every emitted chunk is well-formed enough that
 *       Telegram's rich-message path would not 400 on it (balanced fences,
 *       terminated code spans, closed links, complete table rows, balanced
 *       emphasis). This is the signal that would have caught "we shipped
 *       markdown Telegram rejects."
 *
 *   (b) STRUCTURE — the transformed body parses into the entity structure the
 *       fixture intended (bold/italic/code/pre/link at the right inner text).
 *
 * The pipeline mirrors `telegram-plugin/gateway/gateway.ts`:
 *   repairEscapedWhitespace -> normalizeParagraphBreaks -> splitMarkdownChunks.
 *   (No paragraph-spacer pass — the NBSP spacer was removed in the #2669
 *   follow-up; gaps are plain `\n\n`. Card-surface fixtures also apply
 *   `normalizeDashes` first — that is where F1's voice scrub lives.)
 *
 * This suite is TEST-ONLY. It changes no production formatting behaviour. If a
 * fixture ever fails signal (a), it means the formatter emits markdown Telegram
 * would reject — a real regression, not a test to relax.
 */

import { describe, test, expect } from 'vitest'
import {
  repairEscapedWhitespace,
  normalizeParagraphBreaks,
  splitMarkdownChunks,
  RICH_MESSAGE_MAX_CHARS,
} from '../format.js'
import { normalizeDashes } from '../text-voice-scrub.js'
import {
  validateRichMarkdown,
  isRichMarkdownValid,
  parseRichEntities,
  entitiesOfType,
  scanFences,
  type RichEntity,
} from './rich-markdown-oracle.js'
import { TORTURE_SET, type TortureFixture, type ExpectEntity } from './formatting-torture-set.js'

/**
 * The outbound transform, mirroring the gateway. `cardSurfaceScrub` prepends
 * the voice-scrub pass (F1's surface). `cap` overrides the chunk cap so the
 * F7 hard-slice path is reachable in a test without a 32k fixture.
 */
function transform(input: string, opts: { cardSurfaceScrub?: boolean; cap?: number } = {}): {
  chunks: string[]
  /** The full transformed body BEFORE chunking — used for structure assertions. */
  body: string
} {
  let text = input
  if (opts.cardSurfaceScrub) text = normalizeDashes(text)
  const body = normalizeParagraphBreaks(repairEscapedWhitespace(text))
  const chunks = splitMarkdownChunks(body, opts.cap ?? RICH_MESSAGE_MAX_CHARS)
  return { chunks, body }
}

/** Assert an expected entity is present among `got` (membership, not index). */
function expectEntityPresent(got: ReadonlyArray<RichEntity>, want: ExpectEntity): void {
  const match = got.find(
    (e) =>
      e.type === want.type &&
      e.text === want.text &&
      (want.url == null || e.url === want.url) &&
      (want.lang == null || e.lang === want.lang),
  )
  expect(
    match,
    `expected a ${want.type} entity with text ${JSON.stringify(want.text)}` +
      (want.url != null ? ` url ${want.url}` : '') +
      (want.lang != null ? ` lang ${want.lang}` : '') +
      `; got: ${JSON.stringify(got)}`,
  ).toBeDefined()
}

// ---------------------------------------------------------------------------
// Oracle self-tests — prove the oracle is a real, non-vacuous validator.
// If the oracle accepted everything (signal a) or found nothing (signal b),
// the whole suite would be a rubber stamp. These guard against that.
// ---------------------------------------------------------------------------

describe('rich-markdown-oracle — self-tests (guards against a vacuous oracle)', () => {
  test('parse-accept: rejects an UNCLOSED fenced code block', () => {
    const bad = 'intro\n```bash\necho hi\n' // no closing ```
    const issues = validateRichMarkdown(bad)
    expect(issues.some((i) => i.kind === 'unbalanced-fence')).toBe(true)
  })

  test('parse-accept: rejects an unterminated inline code span', () => {
    const issues = validateRichMarkdown('here is `unclosed code')
    expect(issues.some((i) => i.kind === 'unterminated-code-span')).toBe(true)
  })

  test('parse-accept: rejects an unclosed inline link destination', () => {
    const issues = validateRichMarkdown('see [label](https://example.com/path')
    expect(issues.some((i) => i.kind === 'malformed-link')).toBe(true)
  })

  test('parse-accept: rejects a bisected (half) table row', () => {
    const issues = validateRichMarkdown('| a | b')
    expect(issues.some((i) => i.kind === 'incomplete-table-row')).toBe(true)
  })

  test('parse-accept: rejects an unbalanced ** bold delimiter', () => {
    const issues = validateRichMarkdown('this is **bold with no close')
    expect(issues.some((i) => i.kind === 'unbalanced-emphasis')).toBe(true)
  })

  test('parse-accept: ACCEPTS well-formed markdown with mixed entities', () => {
    const good =
      'Intro **bold** and _italic_ and `code`.\n\n```js\nconst x = 1\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nSee [x](https://e.com).'
    expect(validateRichMarkdown(good)).toEqual([])
  })

  test('structure: extracts bold/italic/code/pre/link at the right text', () => {
    const md = 'A **b** and _i_ and `c`.\n```py\nprint(1)\n```\n[lab](https://u.co)'
    const ents = parseRichEntities(md)
    expect(ents).toContainEqual({ type: 'bold', text: 'b' })
    expect(ents).toContainEqual({ type: 'italic', text: 'i' })
    expect(ents).toContainEqual({ type: 'code', text: 'c' })
    expect(ents).toContainEqual({ type: 'pre', text: 'print(1)', lang: 'py' })
    expect(ents).toContainEqual({ type: 'link', text: 'lab', url: 'https://u.co' })
  })

  test('inline code interior is verbatim — reserved chars do not leak as entities', () => {
    // `*not bold*` inside code must NOT produce a bold/italic entity.
    const ents = parseRichEntities('literal `*x*` here')
    expect(ents.filter((e) => e.type === 'bold' || e.type === 'italic')).toEqual([])
    expect(ents).toContainEqual({ type: 'code', text: '*x*' })
  })
})

// ---------------------------------------------------------------------------
// The torture set — signal (a) + (b) for every fixture.
// ---------------------------------------------------------------------------

describe('formatting torture-set — parse-accept + structure', () => {
  // F7 is the deliberate degraded path: a >cap indivisible fenced block is
  // hard-sliced, so its individual chunks are intentionally NOT balanced
  // markdown. Handled separately below.
  const standard = TORTURE_SET.filter((f) => f.name !== 'F7-over-cap-hard-slice')

  for (const fx of standard) {
    describe(fx.name, () => {
      test(`(intent) ${fx.intent}`, () => {
        // (a) PARSE-ACCEPT — every emitted chunk is well-formed.
        const { chunks, body } = transform(fx.input, { cardSurfaceScrub: fx.cardSurfaceScrub })
        for (const c of chunks) {
          const issues = validateRichMarkdown(c)
          expect(
            issues,
            `chunk failed parse-accept for fixture "${fx.name}":\n${c}\nissues: ${JSON.stringify(issues)}`,
          ).toEqual([])
        }

        // (b) STRUCTURE — the transformed body parses into the intended shape.
        const ents = parseRichEntities(body)
        for (const want of fx.expect) expectEntityPresent(ents, want)
      })
    })
  }

  // ── F1 extra assertion: the em/en-dash glyph is actually gone. ────────────
  test('F1: card-surface scrub removes the em/en-dash glyph before the wire', () => {
    const fx = TORTURE_SET.find((f) => f.name === 'F1-card-surface-dash-scrub')!
    const { body } = transform(fx.input, { cardSurfaceScrub: true })
    expect(body).not.toContain('—') // em dash
    expect(body).not.toContain('–') // en dash
    // And the scrubbed body is still parse-accept clean.
    expect(isRichMarkdownValid(body)).toBe(true)
  })

  // ── F2 extra assertion: the paragraph break survives (not collapsed). ─────
  test('F2: a loose interior pipe does not swallow the following paragraph break', () => {
    const fx = TORTURE_SET.find((f) => f.name === 'F2-stray-pipe-keeps-paragraph-spacing')!
    const { body } = transform(fx.input)
    // Both paragraphs are present and separated by a blank line (>= one \n\n).
    expect(body).toContain('plan A | plan B')
    expect(body).toContain('one pass')
    expect(body).toMatch(/\n\s*\n/) // a real paragraph gap survived
    // The loose pipe line must NOT have been turned into / read as a table
    // row — the oracle would flag a half-row; it must be clean.
    expect(isRichMarkdownValid(body)).toBe(true)
  })

  // ── F4 extra assertion: a blank line now separates the fence from prose. ──
  test('F4: a blank line is inserted between a closed fence and the following prose', () => {
    const fx = TORTURE_SET.find((f) => f.name === 'F4-blank-line-after-closed-fence')!
    const { body } = transform(fx.input)
    // The fence stays balanced (closed) and the trailing prose survives.
    const { fences } = scanFences(body)
    expect(fences.length).toBe(1)
    expect(fences[0].closed).toBe(true)
    expect(body).toContain('And it ships today.')
    // The line immediately following the fence close is blank (the F4 fix).
    const lines = body.split('\n')
    const closeIdx = lines.findIndex((l, i) => i > 0 && /^```/.test(l.trim()) && lines[i - 1] !== '```')
    // Find the LAST fence-close line then assert the next non-fence line has a
    // blank between it and the fence.
    const fenceCloseLine = lines.map((l) => l.trim()).lastIndexOf('```')
    expect(fenceCloseLine).toBeGreaterThan(0)
    expect(lines[fenceCloseLine + 1] ?? '').toBe('')
    void closeIdx
  })
})

// ---------------------------------------------------------------------------
// F7 — over-cap indivisible block hard-slices (degraded-but-delivered).
// Signal (a) does NOT apply per-chunk here by design (a hard slice can bisect
// a fence). What MUST hold: no content is dropped and every chunk fits the cap.
// ---------------------------------------------------------------------------

describe('F7-over-cap-hard-slice', () => {
  const fx = TORTURE_SET.find((f) => f.name === 'F7-over-cap-hard-slice')!
  const CAP = 100

  test('an oversized indivisible fenced block is sliced to <= cap chunks, losing no content', () => {
    const { chunks } = transform(fx.input, { cap: CAP })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CAP)
    // No content dropped: the slices concatenate back to the original body.
    // (The transform is a no-op on this fixture apart from chunking — it has no
    // prose paragraphs to space, so body === input here.)
    expect(chunks.join('')).toContain('x'.repeat(600))
  })

  test('the UN-chunked body is itself parse-accept valid (the fence is balanced)', () => {
    // Sanity: the corruption F7 accepts is ONLY the intra-chunk fence bisection
    // forced by the cap — the body as a whole is well-formed. This guards
    // against F7 silently masking a genuine unbalanced-fence bug in the source.
    const { body } = transform(fx.input, { cap: RICH_MESSAGE_MAX_CHARS })
    expect(isRichMarkdownValid(body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Wiring-level: the fake bot API surfaces parsed entities on the rich path so
// a test can assert structure at the send boundary (deliverable 3). This uses
// the SAME independent oracle, keeping the check non-circular.
// ---------------------------------------------------------------------------

describe('wiring: sendRichMessage entity structure at the send boundary', () => {
  test('a rich send of a torture body lands parse-valid with the intended entities', async () => {
    const { createFakeBotApi } = await import('./fake-bot-api.js')
    const bot = createFakeBotApi()
    const fx = TORTURE_SET.find((f) => f.name === 'links')!
    const { body } = transform(fx.input)

    await bot.api.sendRichMessage('chat-1', { markdown: body })
    const sent = bot.messagesIn('chat-1')
    expect(sent).toHaveLength(1)
    expect(sent[0].rich).toBe(true)

    // Re-derive entities from what actually landed on the wire (sent[0].text is
    // the rich markdown body) using the independent oracle.
    const landed = sent[0].text
    expect(isRichMarkdownValid(landed)).toBe(true)
    for (const want of fx.expect) expectEntityPresent(parseRichEntities(landed), want)
  })
})

// Keep a reference so unused-import lint never trips on entitiesOfType even if
// a future edit drops its only direct use.
void entitiesOfType
