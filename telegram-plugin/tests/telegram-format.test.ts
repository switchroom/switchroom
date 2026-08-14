/**
 * Tests for the post-#2669 Telegram formatting utilities.
 *
 * The markdown→HTML engine, the HTML sanitizer, and the MarkdownV2 escaper
 * are gone — every outbound message ships raw GFM markdown via
 * `sendRichMessage` / `editMessageText({ markdown })`. What survives in
 * `format.ts` and is covered here:
 *
 *   - repairEscapedWhitespace — LLM-side JSON-escape repair (format-agnostic).
 *   - escapeMarkdown — inline-special escaper for dynamic card content.
 *   - splitMarkdownChunks — code-fence / table-row aware chunker.
 *   - RICH_MESSAGE_MAX_CHARS — the 32768 rich-message wire cap.
 */
import { describe, test, expect } from 'vitest'

// Import from the side-effect-free format module so tests don't trigger
// server.ts's startup (env load, token check, grammy init).
import {
  repairEscapedWhitespace,
  escapeMarkdown,
  splitMarkdownChunks,
  addParagraphSpacers,
  codeFenceFor,
  PARAGRAPH_SPACER,
  RICH_MESSAGE_MAX_CHARS,
} from '../format.js'

// ---------------------------------------------------------------------------
// codeFenceFor — the single shared fence-width rule (#4702 follow-up)
// ---------------------------------------------------------------------------

describe('codeFenceFor', () => {
  test('defaults to three backticks when the body carries no long run', () => {
    expect(codeFenceFor('')).toBe('```')
    expect(codeFenceFor('plain body')).toBe('```')
    expect(codeFenceFor('a ` b `` c')).toBe('```')
  })

  test('widens to one longer than the longest run in the body', () => {
    expect(codeFenceFor('a\n```\nb')).toBe('````')
    expect(codeFenceFor('a\n````\nb')).toBe('`````')
    expect(codeFenceFor('` `` ``` ````')).toBe('`````')
    expect(codeFenceFor('x```y')).toBe('````')
  })

  test('the delimiter is strictly longer than every run in the body', () => {
    // The property the wire depends on: with the open/close pair the only
    // runs of that width, nothing in the body can close the fence early or
    // leave one open.
    for (const body of ['no ticks', '`', '```', '``````', 'a ``` b ````` c']) {
      const fence = codeFenceFor(body)
      for (const run of body.match(/`+/g) ?? []) {
        expect(run.length).toBeLessThan(fence.length)
      }
    }
  })

  test('does not blow the stack on a body with very many backtick runs', () => {
    // The former `Math.max(0, ...runs.map(…))` form passed one argument per
    // run and threw `RangeError: Maximum call stack size exceeded` from about
    // 125k runs — inside the render path, on a body well under the wire cap
    // the renderer sees before chunking.
    const body = 'x `'.repeat(200_000)
    expect(codeFenceFor(body)).toBe('```')
  })
})

// ---------------------------------------------------------------------------
// escapeMarkdown — narrowed inline-special escaper (#2669)
// ---------------------------------------------------------------------------

describe('escapeMarkdown', () => {
  test('escapes the inline-formatting specials: \\ ` * _ ~ = [ ] |', () => {
    expect(escapeMarkdown('\\')).toBe('\\\\')
    expect(escapeMarkdown('`')).toBe('\\`')
    expect(escapeMarkdown('*')).toBe('\\*')
    expect(escapeMarkdown('_')).toBe('\\_')
    expect(escapeMarkdown('~')).toBe('\\~')
    expect(escapeMarkdown('=')).toBe('\\=')
    expect(escapeMarkdown('[')).toBe('\\[')
    expect(escapeMarkdown(']')).toBe('\\]')
    expect(escapeMarkdown('|')).toBe('\\|')
  })

  test('does NOT escape line-start-only / structural chars: . - + # ( ) { } ! >', () => {
    // Escaping these mid-word would litter filenames/versions/URLs with
    // visible backslashes. They are only meaningful at line-start or in
    // link/structure context.
    for (const ch of ['.', '-', '+', '#', '(', ')', '{', '}', '!', '>']) {
      expect(escapeMarkdown(ch)).toBe(ch)
    }
  })

  test('leaves a plain filename untouched', () => {
    expect(escapeMarkdown('foo.ts')).toBe('foo.ts')
    expect(escapeMarkdown('v1.2-rc')).toBe('v1.2-rc')
    expect(escapeMarkdown('src/cli/index.ts')).toBe('src/cli/index.ts')
  })

  test('escapes emphasis markers inside dynamic text so they render literally', () => {
    expect(escapeMarkdown('a_b_c')).toBe('a\\_b\\_c')
    expect(escapeMarkdown('**not bold**')).toBe('\\*\\*not bold\\*\\*')
  })

  test('escapes the backslash first so it never double-escapes a following special', () => {
    // `\*` in the input is backslash + star → both get escaped exactly once.
    expect(escapeMarkdown('\\*')).toBe('\\\\\\*')
  })

  // The de-dup pass (#2695) replaced ~12 local escaper copies with this one
  // canonical function. Every consolidated caller now depends on this exact
  // contract: the FULL metacharacter set in a single string, each escaped.
  test('escapes the full metacharacter set in one combined string', () => {
    // Backslash placed last so it doesn't re-escape the chars after it.
    expect(escapeMarkdown('`*_~=[]|\\')).toBe('\\`\\*\\_\\~\\=\\[\\]\\|\\\\')
  })

  test('already-safe text passes through unchanged', () => {
    const safe = 'Switched fleet to alice (5h window 29% resets in 2h)'
    expect(escapeMarkdown(safe)).toBe(safe)
  })

  // card-format.ts re-exports this same symbol; the consolidated callers
  // import from one or the other. Lock that they are the identical function.
  test('card-format re-exports the identical canonical escaper', async () => {
    const cardFormat = await import('../card-format.js')
    expect(cardFormat.escapeMarkdown).toBe(escapeMarkdown)
  })
})

// ---------------------------------------------------------------------------
// splitMarkdownChunks — never bisects a code fence or a table row
// ---------------------------------------------------------------------------

describe('splitMarkdownChunks', () => {
  test('returns a single chunk when the body fits', () => {
    const text = 'short message'
    expect(splitMarkdownChunks(text, 100)).toEqual([text])
  })

  test('defaults the cap to RICH_MESSAGE_MAX_CHARS', () => {
    const text = 'x'.repeat(RICH_MESSAGE_MAX_CHARS)
    expect(splitMarkdownChunks(text)).toEqual([text])
    expect(splitMarkdownChunks(text + 'y')).toHaveLength(2)
  })

  test('every chunk fits within maxLen', () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} ${'word '.repeat(20)}`).join('\n\n')
    const chunks = splitMarkdownChunks(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200)
  })

  test('rejoining the chunks reproduces the original content (modulo trimmed boundary newlines)', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const chunks = splitMarkdownChunks(text, 50)
    // The chunker strips leading newlines from each subsequent chunk, so
    // join with '\n' and compare the whitespace-collapsed forms.
    const rejoined = chunks.join('\n').replace(/\n+/g, '\n')
    expect(rejoined).toBe(text.replace(/\n+/g, '\n'))
  })

  test('never leaves a chunk with an unbalanced ``` fence', () => {
    // A long body with a fenced code block straddling the cap. The chunker
    // must move the whole fence to a single chunk so no chunk has an odd
    // number of fence delimiters (which would swallow the next chunk).
    // The fence FITS within the cap, so the chunker can move it whole to a
    // single chunk and keep every chunk's fence count balanced. (An oversized
    // fence that cannot fit is hard-sliced instead — see the F7 tests below.)
    const fence = '```\n' + 'code line\n'.repeat(8) + '```'
    const text = 'intro paragraph '.repeat(15) + '\n\n' + fence + '\n\noutro paragraph'
    const chunks = splitMarkdownChunks(text, 180)
    for (const c of chunks) {
      const fences = (c.match(/^```/gm) ?? []).length
      expect(fences % 2).toBe(0)
    }
  })

  test('never bisects a markdown table row', () => {
    const header = '| col a | col b | col c |\n| --- | --- | --- |\n'
    const rows = Array.from({ length: 30 }, (_, i) => `| r${i}a | r${i}b | r${i}c |`).join('\n')
    const text = 'preamble '.repeat(10) + '\n\n' + header + rows
    const chunks = splitMarkdownChunks(text, 160)
    // Every line containing a `|` must be a complete row — i.e. start and
    // end with `|` once trimmed (the chunker cuts at line boundaries).
    for (const c of chunks) {
      for (const line of c.split('\n')) {
        if (!line.includes('|')) continue
        const t = line.trim()
        if (t.length === 0) continue
        expect(t.startsWith('|')).toBe(true)
        expect(t.endsWith('|')).toBe(true)
      }
    }
  })

  test('hard-slices an indivisible block that exceeds the cap (F7 — no oversized chunk)', () => {
    // A single fenced block larger than maxLen has no safe interior cut. The
    // OLD behaviour emitted it whole, which Telegram rejects with
    // RICH_MESSAGE_TEXT_TOO_LONG and drops the entire answer. F7 delegates to
    // hardSliceToCap so the region comes out as multiple <= cap character
    // slices instead — degraded-but-delivered beats a hard reject.
    const giant = '```\n' + 'x'.repeat(500) + '\n```'
    const chunks = splitMarkdownChunks(giant, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    // No content is dropped — the slices concatenate back to the original.
    expect(chunks.join('')).toBe(giant)
  })

  test('hard-slices a single unbreakable >maxLen token run into <= cap chunks (F7)', () => {
    // One giant pipe-bearing line with no space/newline boundary below the
    // cap: neither the blank-line, newline, nor space heuristic can find a
    // cut, and the table-row back-off cannot help either. This is the exact
    // "cut <= 0" path — it must hard-slice, not emit an oversized chunk.
    const runaway = 'a|b|'.repeat(200) // 800 chars, no spaces/newlines
    const chunks = splitMarkdownChunks(runaway, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    expect(chunks.join('')).toBe(runaway)
  })

  test('an indivisible region larger than the real 32768 cap still slices to <= cap (F7)', () => {
    const giant = 'z'.repeat(RICH_MESSAGE_MAX_CHARS + 5000)
    const chunks = splitMarkdownChunks(giant) // default cap = RICH_MESSAGE_MAX_CHARS
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(RICH_MESSAGE_MAX_CHARS)
  })

  // -------------------------------------------------------------------------
  // Chunk-boundary spacer hygiene. addParagraphSpacers injects a
  // `\n\n${PARAGRAPH_SPACER}\n\n` gap between prose paragraphs. When a cut
  // lands inside that gap, the boundary must not leave a chunk that opens or
  // ends with a bare U+00A0 spacer line (a stray blank bubble line).
  // -------------------------------------------------------------------------

  test('no chunk starts or ends with a bare U+00A0 spacer line (reviewer repro)', () => {
    // The exact reviewer repro: a spacer gap straddling a small cap.
    const A = 'Alpha sentence one'
    const B = 'Bravo sentence two'
    const spaced = addParagraphSpacers(`${A}.\n\n${B}.`)
    const chunks = splitMarkdownChunks(spaced, 33)
    expect(chunks.length).toBeGreaterThan(1)
    const spacerOnly = new RegExp(`^[ \\t]*${PARAGRAPH_SPACER}[ \\t]*$`)
    for (const c of chunks) {
      const lines = c.split('\n')
      expect(spacerOnly.test(lines[0])).toBe(false)
      expect(spacerOnly.test(lines[lines.length - 1])).toBe(false)
    }
  })

  test('visible paragraph content survives the boundary (no text dropped)', () => {
    const A = 'Alpha sentence one'
    const B = 'Bravo sentence two'
    const spaced = addParagraphSpacers(`${A}.\n\n${B}.`)
    const chunks = splitMarkdownChunks(spaced, 33)
    const rejoined = chunks.join('\n')
    expect(rejoined).toContain(`${A}.`)
    expect(rejoined).toContain(`${B}.`)
  })

  test('spacer-boundary strip is robust across several gaps and small caps', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} body text here.`)
    const spaced = addParagraphSpacers(paras.join('\n\n'))
    const spacerOnly = new RegExp(`^[ \\t]*${PARAGRAPH_SPACER}[ \\t]*$`)
    for (const cap of [20, 31, 40, 64]) {
      const chunks = splitMarkdownChunks(spaced, cap)
      for (const c of chunks) {
        const lines = c.split('\n')
        expect(spacerOnly.test(lines[0])).toBe(false)
        expect(spacerOnly.test(lines[lines.length - 1])).toBe(false)
      }
      // No visible word is dropped: concatenating the chunks' non-blank,
      // non-spacer tokens reproduces the original word sequence. (Word-level,
      // not line-level, because a small cap may split mid-word — that's the
      // chunker's normal space-boundary behaviour, orthogonal to spacers.)
      const words = (s: string): string[] =>
        s.split(/\s+/).filter((w) => w.length > 0 && w !== PARAGRAPH_SPACER)
      expect(words(chunks.join(' '))).toEqual(words(paras.join(' ')))
    }
  })

  test('a boundary with NO spacer is unaffected (legacy ^\\n+ behaviour preserved)', () => {
    const text = Array.from({ length: 10 }, (_, i) => `plain line ${i}`).join('\n\n')
    const chunks = splitMarkdownChunks(text, 40)
    // No spacer was ever present, so no chunk gains/loses anything beyond the
    // normal leading-newline strip; content is preserved.
    const rejoined = chunks.join('\n').replace(/\n+/g, '\n')
    expect(rejoined).toBe(text.replace(/\n+/g, '\n'))
  })

  // -------------------------------------------------------------------------
  // Entity-aware chunking (#finding-3): a cut must never bisect an inline
  // span (`**bold**`, `` `code` ``, `_italic_`, `[label](href)`), which would
  // strand an unclosed delimiter in the emitted chunk.
  // -------------------------------------------------------------------------

  test('a bold/code/link span straddling the cap is not bisected (balanced delimiters)', () => {
    // Build a body where each inline span sits right around a small cap so the
    // naive space/newline cut would land inside it. Every span is shorter than
    // the smallest cap tried (the longest is the 34-char link), so a straddling
    // span can always be kept whole — the entity-aware back-off must do so.
    const filler = 'x'.repeat(30)
    const body =
      `${filler} **bold span here** ` +
      `${filler} \`code span here\` ` +
      `${filler} [label here](https://ex.com/a-b-c) ` +
      `${filler} _italic span here_ ${filler}`
    for (const cap of [40, 50, 60, 70, 80]) {
      const chunks = splitMarkdownChunks(body, cap)
      for (const c of chunks) {
        // Balanced `**` and single-backtick delimiters in every chunk.
        expect((c.match(/\*\*/g) ?? []).length % 2).toBe(0)
        expect((c.match(/`/g) ?? []).length % 2).toBe(0)
        // No chunk ends mid-link (an open `](` with no closing `)`), and no
        // chunk starts with an orphan link tail.
        const opens = (c.match(/\]\(/g) ?? []).length
        const closesAfterOpen = (c.match(/\]\([^)\n]*\)/g) ?? []).length
        expect(opens).toBe(closesAfterOpen)
      }
      // Nothing is dropped.
      const words = (s: string): string[] => s.split(/\s+/).filter((w) => w.length > 0)
      expect(words(chunks.join(' '))).toEqual(words(body))
    }
  })

  test('a `***bold-italic***` / `___…___` span straddling the cap keeps SINGLE-marker balance', () => {
    // Regression for the triple-marker case: without the `***…***` pattern, the
    // bold pattern matches only the inner `**…**`, so a cut inside `***x***`
    // strands the lone outer `*` (odd asterisk count → the italic is lost). A
    // `**`-PAIR balance check misses that, so assert SINGLE-`*` / SINGLE-`_`
    // balance in every chunk.
    const filler = 'x'.repeat(30)
    const body =
      `${filler} ***bold italic here*** ` +
      `${filler} ___under bold here___ ${filler}`
    for (const cap of [40, 50, 60, 70]) {
      const chunks = splitMarkdownChunks(body, cap)
      for (const c of chunks) {
        // SINGLE-marker balance: an even count of `*` and of `_` in every chunk
        // (a stranded lone `*`/`_` from a bisected triple span makes it odd).
        expect((c.match(/\*/g) ?? []).length % 2).toBe(0)
        expect((c.match(/_/g) ?? []).length % 2).toBe(0)
      }
      // Each triple span survives intact in exactly one chunk.
      const rejoined = chunks.join('\n')
      expect(rejoined).toContain('***bold italic here***')
      expect(rejoined).toContain('___under bold here___')
      // Nothing dropped.
      const words = (s: string): string[] => s.split(/\s+/).filter((w) => w.length > 0)
      expect(words(chunks.join(' '))).toEqual(words(body))
    }
  })

  test('a boundary with NO spacer is unaffected (legacy ^\\n+ behaviour preserved)', () => {
    const text = Array.from({ length: 10 }, (_, i) => `plain line ${i}`).join('\n\n')
    const chunks = splitMarkdownChunks(text, 40)
    // No spacer was ever present, so no chunk gains/loses anything beyond the
    // normal leading-newline strip; content is preserved.
    const rejoined = chunks.join('\n').replace(/\n+/g, '\n')
    expect(rejoined).toBe(text.replace(/\n+/g, '\n'))
  })
})

// ---------------------------------------------------------------------------
// coalescing logic (pure helpers — unchanged by #2669)
// ---------------------------------------------------------------------------

describe('coalescing logic', () => {
  test('coalesceKey produces unique keys per chat+user', () => {
    const key1 = `chat1:user1`
    const key2 = `chat1:user2`
    const key3 = `chat2:user1`
    expect(key1).not.toBe(key2)
    expect(key1).not.toBe(key3)
  })

  test('messages combine with newline separator', () => {
    const messages = ['Hello', 'How are you?', 'One more thing']
    const combined = messages.join('\n')
    expect(combined).toBe('Hello\nHow are you?\nOne more thing')
  })

  test('single message passes through unchanged', () => {
    const messages = ['Hello']
    expect(messages.join('\n')).toBe('Hello')
  })

  test('empty messages produce empty combined text', () => {
    const messages: string[] = []
    expect(messages.join('\n')).toBe('')
  })

  test('messages with newlines preserve internal structure', () => {
    const messages = ['Line 1\nLine 2', 'Line 3']
    expect(messages.join('\n')).toBe('Line 1\nLine 2\nLine 3')
  })
})

// ---------------------------------------------------------------------------
// repairEscapedWhitespace — defends against LLM-side JSON escape bungles
// where real newlines come through as the literal two-char sequence `\n`.
// Format-agnostic: runs on the raw text BEFORE it reaches the rich path.
// ---------------------------------------------------------------------------

describe('repairEscapedWhitespace', () => {
  test('unescapes literal \\n when text has no real newlines', () => {
    const input = 'Line one\\nLine two\\nLine three'
    expect(repairEscapedWhitespace(input)).toBe('Line one\nLine two\nLine three')
  })

  test('unescapes literal \\n\\n paragraph breaks', () => {
    const input = 'Paragraph one.\\n\\nParagraph two.'
    expect(repairEscapedWhitespace(input)).toBe('Paragraph one.\n\nParagraph two.')
  })

  test('handles the exact observed bug: markdown mixed with literal \\n', () => {
    // Reproduces the actual stream_reply failure: a model produced a message
    // with markdown and literal `\n` escape sequences instead of real
    // newlines, and Telegram rendered the `\n` as visible characters. The
    // repair runs on raw markdown now (no HTML pass).
    const input =
      'Audit done:\\n\\n**README.md**\\n• Missing `switchroom update`\\n• Missing `switchroom agent grant`'
    const repaired = repairEscapedWhitespace(input)
    expect(repaired).toBe(
      'Audit done:\n\n**README.md**\n• Missing `switchroom update`\n• Missing `switchroom agent grant`',
    )
  })

  test('unescapes literal \\n in prose even when real newlines are present (mixed-message fix, #2456)', () => {
    const input = 'Real newline here\nand a literal \\n escape in prose'
    const out = repairEscapedWhitespace(input)
    expect(out).toBe('Real newline here\nand a literal \n escape in prose')
  })

  test('preserves literal \\n inside inline code span when mixed with real newlines (#2456)', () => {
    const input = 'First line\nUse `grep -P \\n` for newlines\nand prose \\n here'
    const out = repairEscapedWhitespace(input)
    expect(out).toContain('`grep -P \\n`')
    expect(out).toContain('and prose \n here')
    expect(out).toContain('First line\n')
  })

  test('preserves literal \\n inside fenced code block (#2456)', () => {
    const input = 'Prose \\n here\n```bash\necho "line1\\nline2"\n```\nMore \\n prose'
    const out = repairEscapedWhitespace(input)
    expect(out).toContain('```bash\necho "line1\\nline2"\n```')
    expect(out).toContain('Prose \n here')
    expect(out).toContain('More \n prose')
  })

  test('pure no-real-newline case still unescapes (backward compat)', () => {
    const input = 'Line one\\nLine two\\nLine three'
    expect(repairEscapedWhitespace(input)).toBe('Line one\nLine two\nLine three')
  })

  test('genuine escaped backslash (\\\\n) stays literal even in mixed-newline message (#2456)', () => {
    const input = 'Windows path: C:\\\\temp\\\\file.txt\\nnext line\nreal newline too'
    const out = repairEscapedWhitespace(input)
    expect(out).toContain('C:\\temp\\file.txt\nnext line')
    expect(out).toContain('real newline too')
  })

  test('leaves single-line text alone when it has no escape sequences', () => {
    const input = 'Just a plain single-line message.'
    expect(repairEscapedWhitespace(input)).toBe(input)
  })

  test('unescapes \\t and \\r as well', () => {
    const input = 'Col1\\tCol2\\tCol3'
    expect(repairEscapedWhitespace(input)).toBe('Col1\tCol2\tCol3')
  })

  test('unescapes \\" (quote) when present alongside \\n', () => {
    const input = 'Say \\"hello\\"\\nnext line'
    expect(repairEscapedWhitespace(input)).toBe('Say "hello"\nnext line')
  })

  test('preserves literal backslash sequences via \\\\', () => {
    const input = 'Windows path: C:\\\\temp\\\\file.txt\\nnext line'
    const out = repairEscapedWhitespace(input)
    expect(out).toBe('Windows path: C:\\temp\\file.txt\nnext line')
  })

  test('end-to-end: repaired raw markdown is ready for the rich path', () => {
    // Full pipeline now ends at raw GFM markdown — no HTML conversion.
    const broken = '**Bold line**\\n\\n- bullet one\\n- bullet two'
    const repaired = repairEscapedWhitespace(broken)
    expect(repaired).toBe('**Bold line**\n\n- bullet one\n- bullet two')
    // Real newlines present; no literal \n survives.
    expect(repaired).toContain('\n\n')
    expect(repaired).not.toContain('\\n')
  })

  // ── Sentinel-collision safety (reviewer blocker) ─────────────────────────

  test('does not produce "undefined" when input contains NUL-byte sequences (#2456)', () => {
    const dangerous = 'hello \x00REPMASK0\x00 world \\n end'
    const out = repairEscapedWhitespace(dangerous)
    expect(out).not.toContain('undefined')
    expect(out).toContain(' end')
    expect(out).not.toContain('\\n')
  })

  // ── Unclosed fenced block (reviewer major) ────────────────────────────────

  test('handles unclosed fenced block gracefully: \\n in trailing content is still unescaped', () => {
    const input = 'Prose \\n here\n```bash\necho "line1\\nline2"\n'
    const out = repairEscapedWhitespace(input)
    expect(out).toContain('Prose \n here')
    expect(typeof out).toBe('string')
  })

  // ── \\t and CRLF in mixed-newline messages (reviewer gaps) ────────────────

  test('unescapes \\t in prose even when real newlines are also present (#2456)', () => {
    const input = 'First line\nCol1\\tCol2\\tCol3\nthird'
    const out = repairEscapedWhitespace(input)
    expect(out).toContain('Col1\tCol2\tCol3')
    expect(out).toContain('First line\n')
    expect(out).toContain('\nthird')
  })

  test('unescapes \\r in prose when real newlines are also present (#2456)', () => {
    const input = 'First line\nsome \\r carriage return in prose'
    const out = repairEscapedWhitespace(input)
    expect(out).toContain('some \r carriage return in prose')
    expect(out).toContain('First line\n')
  })
})
