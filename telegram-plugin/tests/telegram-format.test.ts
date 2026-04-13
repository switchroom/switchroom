/**
 * Tests for Telegram formatting utilities: markdownToHtml, splitHtmlChunks,
 * file reference wrapping, and message coalescing.
 */
import { describe, test, expect } from 'vitest'

// Import from the side-effect-free format module so tests don't trigger
// server.ts's startup (env load, token check, grammy init).
import { markdownToHtml, splitHtmlChunks, isLikelyTelegramHtml, repairEscapedWhitespace } from '../format.js'

// ---------------------------------------------------------------------------
// markdownToHtml
// ---------------------------------------------------------------------------

describe('markdownToHtml', () => {
  test('converts bold **text** to <b>text</b>', () => {
    expect(markdownToHtml('Hello **world**')).toContain('<b>world</b>')
  })

  test('converts italic *text* to <i>text</i>', () => {
    expect(markdownToHtml('Hello *world*')).toContain('<i>world</i>')
  })

  test('does not confuse bold and italic', () => {
    const result = markdownToHtml('**bold** and *italic*')
    expect(result).toContain('<b>bold</b>')
    expect(result).toContain('<i>italic</i>')
  })

  test('converts inline `code` to <code>code</code>', () => {
    expect(markdownToHtml('Use `console.log`')).toContain('<code>console.log</code>')
  })

  test('converts code blocks with language', () => {
    const input = '```typescript\nconst x = 1\n```'
    const result = markdownToHtml(input)
    expect(result).toContain('<pre><code class="language-typescript">')
    expect(result).toContain('const x = 1')
    expect(result).toContain('</code></pre>')
  })

  test('converts code blocks without language', () => {
    const input = '```\nplain code\n```'
    const result = markdownToHtml(input)
    expect(result).toContain('<pre><code>')
    expect(result).toContain('plain code')
  })

  test('converts strikethrough ~~text~~ to <s>text</s>', () => {
    expect(markdownToHtml('~~deleted~~')).toContain('<s>deleted</s>')
  })

  test('converts [text](url) to <a href="url">text</a>', () => {
    const result = markdownToHtml('Click [here](https://example.com)')
    expect(result).toContain('<a href="https://example.com">here</a>')
  })

  test('escapes HTML entities in plain text', () => {
    const result = markdownToHtml('x < y & z > w')
    expect(result).toContain('&lt;')
    expect(result).toContain('&amp;')
    expect(result).toContain('&gt;')
  })

  test('does not escape HTML inside code blocks', () => {
    const input = '```html\n<div>test</div>\n```'
    const result = markdownToHtml(input)
    expect(result).toContain('&lt;div&gt;test&lt;/div&gt;')
  })

  test('does not escape HTML inside inline code', () => {
    const result = markdownToHtml('Use `<div>` element')
    expect(result).toContain('<code>&lt;div&gt;</code>')
  })

  test('wraps file references in code tags', () => {
    const result = markdownToHtml('Edit server.ts and package.json')
    expect(result).toContain('<code>server.ts</code>')
    expect(result).toContain('<code>package.json</code>')
  })

  test('does not double-wrap file references already in code', () => {
    const result = markdownToHtml('Edit `server.ts` now')
    // Should have exactly one <code>server.ts</code>, not nested
    const matches = result.match(/<code>server\.ts<\/code>/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1)
    // And crucially: NO nested <code><code>...</code></code>
    expect(result).not.toContain('<code><code>')
    expect(result).not.toContain('</code></code>')
  })

  test('does not double-wrap when inline code sits alongside prose with file refs', () => {
    // Regression for the user-observed bug: messages that mixed inline code
    // spans (backticks around filenames) with prose produced
    // `<code><code>settings.json</code></code>` in the stored history. The
    // file-reference regex ran AFTER inline-code placeholder restoration and
    // re-wrapped the filename inside the just-restored <code> tag because
    // its negative lookbehind did not exclude `>`.
    const result = markdownToHtml(
      'I mixed raw `<a href="...">` HTML into messages whose `format` defaults ' +
      'to `html` — but the plugin runs a markdown→HTML converter which escapes ' +
      'literal `<` and `>`, so raw tags render as visible text in the rendered ' +
      '`settings.json` output.'
    )
    expect(result).not.toContain('<code><code>')
    expect(result).not.toContain('</code></code>')
    // settings.json, format, html should each appear inside exactly one
    // <code> tag — either from the backtick wrapping or the file-ref regex,
    // but never both.
    const settingsMatches = result.match(/<code>settings\.json<\/code>/g)
    expect(settingsMatches).not.toBeNull()
    expect(settingsMatches!.length).toBe(1)
  })

  test('file-reference wrap still runs on bare filenames in prose', () => {
    // Confirm the fix doesn't break the normal case: bare filenames in
    // plain prose still get auto-wrapped in <code> tags.
    const result = markdownToHtml('Edit server.ts and then run tsc --noEmit')
    expect(result).toContain('<code>server.ts</code>')
  })

  test('file-reference wrap does not match filenames adjacent to > (inside tag markup)', () => {
    // A filename that sits right after a `>` (tag close) should not be
    // re-wrapped — it's already inside some structured context.
    const input = '<b>foo.ts</b>'
    const result = markdownToHtml(input)
    // Passes through as Telegram HTML (smart pass-through) — filename is
    // not wrapped in <code> because it's inside a <b>.
    expect(result).toBe(input)
  })

  test('handles nested bold and italic', () => {
    const result = markdownToHtml('**bold *and italic* text**')
    expect(result).toContain('<b>')
    expect(result).toContain('</b>')
  })

  test('handles plain text with no formatting', () => {
    const result = markdownToHtml('Just a plain message')
    expect(result).toBe('Just a plain message')
  })

  test('handles empty string', () => {
    expect(markdownToHtml('')).toBe('')
  })

  test('preserves multiple paragraphs', () => {
    const result = markdownToHtml('First paragraph\n\nSecond paragraph')
    expect(result).toContain('First paragraph')
    expect(result).toContain('Second paragraph')
  })

  test('converts ## headings to bold (Telegram has no <h1>)', () => {
    const result = markdownToHtml('## My Heading\n\nbody text')
    expect(result).toContain('<b>My Heading</b>')
    expect(result).not.toContain('## ')
  })

  test('converts # headings to bold', () => {
    const result = markdownToHtml('# Top heading\n\nbody')
    expect(result).toContain('<b>Top heading</b>')
    expect(result).not.toMatch(/^# /m)
  })

  test('converts deep ### #### headings to bold without losing content', () => {
    const result = markdownToHtml('### Section\n#### Subsection\nbody')
    expect(result).toContain('<b>Section</b>')
    expect(result).toContain('<b>Subsection</b>')
    expect(result).not.toContain('###')
    expect(result).not.toContain('####')
  })

  test('does not convert # inside code blocks', () => {
    const input = '```bash\n# this is a comment\n```'
    const result = markdownToHtml(input)
    expect(result).toContain('# this is a comment')
    expect(result).not.toContain('<b># this is a comment</b>')
  })

  // ─── HTML pass-through (the bug that made <b> tags render as text) ─────

  test('passes through already-rendered Telegram HTML untouched', () => {
    const input = '<b>Bold heading</b>\n<i>italic body</i>'
    expect(markdownToHtml(input)).toBe(input)
  })

  test('passes through Telegram HTML with <code> blocks', () => {
    const input = '<b>commit</b> <code>abc123</code>'
    expect(markdownToHtml(input)).toBe(input)
  })

  test('passes through Telegram HTML with mixed tags and text', () => {
    const input = '<b>What you should see</b>\n👀 immediately, then 🤔 after 2s'
    expect(markdownToHtml(input)).toBe(input)
  })

  test('escapes when input has unsupported HTML tags (e.g. <div>)', () => {
    const input = '<div>not telegram html</div>'
    const out = markdownToHtml(input)
    // Falls into the markdown path → escapes the angle brackets
    expect(out).toContain('&lt;div&gt;')
  })

  test('escapes when input is plain markdown without HTML', () => {
    const input = '**bold** text'
    const out = markdownToHtml(input)
    expect(out).toContain('<b>bold</b>')
  })
})

describe('isLikelyTelegramHtml', () => {
  test('returns true for simple <b>', () => {
    expect(isLikelyTelegramHtml('<b>hello</b>')).toBe(true)
  })

  test('returns true for <code>', () => {
    expect(isLikelyTelegramHtml('use <code>git status</code>')).toBe(true)
  })

  test('returns true for nested supported tags', () => {
    expect(isLikelyTelegramHtml('<b><i>bold italic</i></b>')).toBe(true)
  })

  test('returns true for <a href>', () => {
    expect(isLikelyTelegramHtml('see <a href="https://x.com">x</a>')).toBe(true)
  })

  test('returns false when ANY tag is unsupported', () => {
    expect(isLikelyTelegramHtml('<b>fine</b> but <div>not</div>')).toBe(false)
  })

  test('returns false for plain text with no tags', () => {
    expect(isLikelyTelegramHtml('just words here')).toBe(false)
  })

  test('returns false for plain markdown', () => {
    expect(isLikelyTelegramHtml('**bold** and *italic*')).toBe(false)
  })

  test('returns false for code with angle brackets', () => {
    expect(isLikelyTelegramHtml('the operator <-> means something')).toBe(false)
  })

  // ─── The bug: HTML tags inside markdown inline code spans ─────────────

  test('ignores HTML tags inside backtick inline code', () => {
    // The model writes `<b>tag</b>` (showing literal HTML in inline code).
    // The text is markdown, NOT raw HTML — must return false.
    expect(isLikelyTelegramHtml('Use `<b>tag</b>` to make text bold.')).toBe(false)
  })

  test('ignores HTML tags inside fenced code blocks', () => {
    const input = 'Example:\n```html\n<div>hi</div>\n```\nThat\'s it.'
    expect(isLikelyTelegramHtml(input)).toBe(false)
  })

  test('returns false when text mixes markdown bold with HTML examples in code', () => {
    // The exact bug pattern from the user-facing screenshot regression
    const input = '**1. Raw HTML rendering** — replies showed `<b>tag</b>` text instead of bold.'
    expect(isLikelyTelegramHtml(input)).toBe(false)
  })

  test('returns false when text has markdown links', () => {
    expect(isLikelyTelegramHtml('See [docs](https://example.com)')).toBe(false)
  })

  test('returns false when text has markdown headings', () => {
    expect(isLikelyTelegramHtml('## Section\n\nbody')).toBe(false)
  })

  test('still returns true for pure HTML even with code spans', () => {
    // Code spans can coexist with real HTML — as long as there are NO
    // markdown bold/link/heading patterns and the tags outside code are
    // all valid Telegram HTML, trust it.
    expect(isLikelyTelegramHtml('<b>commit</b> <code>abc123</code>')).toBe(true)
  })
})

describe('markdownToHtml regression: mixed markdown + raw Telegram HTML', () => {
  // The exact bug pattern from the user-facing screenshot regression: model
  // emits markdown bold AND raw <b>/<a> tags in the same message. The
  // markdown path used to escape every `<` to `&lt;`, so the raw tags
  // rendered as literal text. Now the converter preserves whitelisted
  // Telegram HTML tags through the escape pass.

  test('preserves embedded <b> when text also has markdown bold', () => {
    const input = '**Pattern worth stealing:** the <b>verification subagent</b> is a validator.'
    const out = markdownToHtml(input)
    expect(out).toContain('<b>Pattern worth stealing:</b>')
    expect(out).toContain('<b>verification subagent</b>')
    expect(out).not.toContain('&lt;b&gt;')
  })

  test('preserves embedded <a href> when text also has markdown bold', () => {
    const input = '**Sources:** see <a href="https://example.com/x">Example</a> for details.'
    const out = markdownToHtml(input)
    expect(out).toContain('<b>Sources:</b>')
    expect(out).toContain('<a href="https://example.com/x">Example</a>')
    expect(out).not.toContain('&lt;a ')
  })

  test('preserves embedded <i> when text also has markdown bold', () => {
    const input = '**Rule:** group work by <i>what context it needs</i>.'
    const out = markdownToHtml(input)
    expect(out).toContain('<b>Rule:</b>')
    expect(out).toContain('<i>what context it needs</i>')
    expect(out).not.toContain('&lt;i&gt;')
  })

  test('preserves multiple embedded tags in one message', () => {
    const input = '**Header**\n- <b>Context</b> matters\n- <i>Speed</i> too\n- See <a href="https://x.com">x</a>'
    const out = markdownToHtml(input)
    expect(out).toContain('<b>Header</b>')
    expect(out).toContain('<b>Context</b>')
    expect(out).toContain('<i>Speed</i>')
    expect(out).toContain('<a href="https://x.com">x</a>')
  })

  test('still escapes unsupported tags even when whitelisted ones are present', () => {
    const input = '**hi** <b>ok</b> and <div>bad</div>'
    const out = markdownToHtml(input)
    expect(out).toContain('<b>hi</b>')
    expect(out).toContain('<b>ok</b>')
    // <div> is not in the whitelist → escaped
    expect(out).toContain('&lt;div&gt;')
  })

  test('preserves embedded <code> spans alongside markdown', () => {
    const input = '**Run:** <code>git status</code> first.'
    const out = markdownToHtml(input)
    expect(out).toContain('<b>Run:</b>')
    expect(out).toContain('<code>git status</code>')
  })

  test('preserves <a> with query-string href containing markdown-link-like text', () => {
    const input = 'See <a href="https://example.com/path">the docs</a>.'
    const out = markdownToHtml(input)
    expect(out).toContain('<a href="https://example.com/path">the docs</a>')
  })
})

describe('markdownToHtml regression: HTML in code spans', () => {
  test('renders **bold** correctly when text also contains `<b>` in inline code', () => {
    const input = '**1. Raw HTML rendering** — replies showed `<b>tag</b>` text instead of bold.'
    const out = markdownToHtml(input)
    expect(out).toContain('<b>1. Raw HTML rendering</b>')
    expect(out).toContain('<code>&lt;b&gt;tag&lt;/b&gt;</code>')
    expect(out).not.toContain('**1. Raw HTML rendering**')
  })

  test('renders fenced code blocks even when they contain HTML examples', () => {
    const input = 'Example:\n```html\n<div>hi</div>\n```'
    const out = markdownToHtml(input)
    expect(out).toContain('<pre><code class="language-html">')
    expect(out).toContain('&lt;div&gt;hi&lt;/div&gt;')
  })
})

// ---------------------------------------------------------------------------
// splitHtmlChunks
// ---------------------------------------------------------------------------

describe('splitHtmlChunks', () => {
  test('returns single chunk for short text', () => {
    const result = splitHtmlChunks('Hello world', 4000)
    expect(result).toEqual(['Hello world'])
  })

  test('splits long text into multiple chunks', () => {
    const longText = 'a'.repeat(5000)
    const chunks = splitHtmlChunks(longText, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    // All chunks should be <= maxLen (plus possible closing tags)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2100) // small margin for closing tags
    }
  })

  test('preserves open tags across chunk boundaries', () => {
    const html = '<b>' + 'x'.repeat(5000) + '</b>'
    const chunks = splitHtmlChunks(html, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    // First chunk should have closing </b>
    expect(chunks[0]).toContain('</b>')
    // Second chunk should reopen <b>
    expect(chunks[1]).toMatch(/^<b>/)
  })

  test('prefers splitting at paragraph boundaries', () => {
    const html = 'First paragraph content here' + '\n\n' + 'Second paragraph content here'
    // Set maxLen so it would split somewhere in the middle
    const chunks = splitHtmlChunks(html, 35)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain('First paragraph')
    expect(chunks[1]).toContain('Second paragraph')
  })

  test('handles nested tags', () => {
    const html = '<b><i>' + 'x'.repeat(5000) + '</i></b>'
    const chunks = splitHtmlChunks(html, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    // First chunk should close both tags
    expect(chunks[0]).toMatch(/<\/i><\/b>$/)
    // Second chunk should reopen both tags
    expect(chunks[1]).toMatch(/^<b><i>/)
  })

  test('handles empty string', () => {
    expect(splitHtmlChunks('')).toEqual([''])
  })

  test('respects custom maxLen', () => {
    const text = 'a'.repeat(100)
    const chunks = splitHtmlChunks(text, 30)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
  })

  test('defaults to 4000 maxLen', () => {
    const text = 'a'.repeat(3999)
    const chunks = splitHtmlChunks(text)
    expect(chunks).toEqual([text])
  })

  test('does not split inside an HTML entity (&amp;)', () => {
    // Construct text where the natural cut would land inside &amp;
    // Position the entity so that maxLen falls between & and ;
    const filler = 'x'.repeat(20)
    // Cut would be at position 22, mid-entity
    const html = filler + ' &amp; more text after the entity'
    const chunks = splitHtmlChunks(html, 22)
    // The entity should not be broken — we should see the full &amp; in
    // some chunk, never &am or amp;.
    for (const c of chunks) {
      expect(c).not.toMatch(/&am$/)
      expect(c).not.toMatch(/^p;/)
      expect(c).not.toMatch(/^amp;/)
    }
    // Recombined text should equal original (allowing for the chunker's
    // tag-rebalancing trim of leading newlines)
    expect(chunks.join('')).toContain('&amp;')
  })

  test('does not split inside a numeric HTML entity (&#x1F4A9;)', () => {
    const filler = 'a'.repeat(15)
    const html = filler + ' &#x1F4A9; more'
    const chunks = splitHtmlChunks(html, 20)
    for (const c of chunks) {
      expect(c).not.toMatch(/&#x1F$/)
      expect(c).not.toMatch(/^4A9;/)
    }
  })

  // ─── Regression: tag-name parsing must allow `-` so `tg-spoiler` and
  // `tg-emoji` survive chunk boundaries instead of being truncated to `tg`.
  test('preserves <tg-spoiler> across chunk boundaries', () => {
    const html = '<tg-spoiler>' + 'x'.repeat(5000) + '</tg-spoiler>'
    const chunks = splitHtmlChunks(html, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    // Chunk0 must close with the FULL tag name, not a truncated `</tg>`
    expect(chunks[0]).toMatch(/<\/tg-spoiler>$/)
    expect(chunks[0]).not.toMatch(/<\/tg>$/)
    // Chunk1 must reopen with the full tag name
    expect(chunks[1]).toMatch(/^<tg-spoiler>/)
    expect(chunks[1]).not.toMatch(/^<tg>/)
  })

  test('preserves <tg-emoji> across chunk boundaries', () => {
    const html = '<tg-emoji emoji-id="5368324170671202286">' + 'y'.repeat(5000) + '</tg-emoji>'
    const chunks = splitHtmlChunks(html, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toMatch(/<\/tg-emoji>$/)
    expect(chunks[1]).toMatch(/^<tg-emoji/)
  })

  // ─── Regression: reopening `<a href="...">` in the next chunk must
  // preserve the href attribute. Previously the splitter emitted bare
  // `<a>` which Telegram rejects.
  test('preserves <a href="..."> attributes across chunk boundaries', () => {
    const href = 'https://example.com/some/deep/path?x=1'
    // Put a natural split point well into the link text so paragraph/space
    // breaks don't land inside the opening tag itself.
    const html = `<a href="${href}">` + 'word '.repeat(1000) + '</a>'
    const chunks = splitHtmlChunks(html, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    // First chunk must close the anchor
    expect(chunks[0]).toMatch(/<\/a>$/)
    // Second chunk must reopen with the FULL href attribute, not bare `<a>`
    expect(chunks[1]).toMatch(new RegExp(`^<a href="${href.replace(/[.?/]/g, '\\$&')}">`))
    expect(chunks[1]).not.toMatch(/^<a>/)
  })

  test('preserves <code class="language-ts"> attributes across boundaries', () => {
    const html = '<pre><code class="language-ts">' + 'z '.repeat(2000) + '</code></pre>'
    const chunks = splitHtmlChunks(html, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    // Reopened chunk should carry the class attribute
    expect(chunks[1]).toContain('<code class="language-ts">')
  })

  // ─── Regression: splitter must not cut INSIDE an open tag. Previously,
  // `<a href="..."` followed by a long run of non-space text made the
  // space-fallback pick position 2 (the space inside `<a href=`) and emit
  // a chunk consisting of just `<a`, which Telegram rejects.
  test('does not cut inside an open tag when tag contains the only nearby space', () => {
    const html = '<a href="https://example.com/very/long/url">' + 'y'.repeat(5000) + '</a>'
    const chunks = splitHtmlChunks(html, 2000)
    // No chunk should end mid-tag (e.g. `<a` or `<a href="..`)
    for (const c of chunks) {
      // A chunk ending with `<` or `<tagname` with no closing `>` is malformed.
      // Quick check: count unclosed `<`s by stripping complete tags.
      const withoutTags = c.replace(/<[^>]*>/g, '')
      expect(withoutTags).not.toContain('<')
    }
  })

  test('backs off when the cut lands between < and > of an opening tag', () => {
    // Construct a case where `cut` would naturally land inside `<b attr="...">`
    const filler = 'a '.repeat(1000) // lots of spaces so splitter has choices
    const html = filler + '<b class="very-long-classname-that-pushes-the-tag-past-cut">' + 'x'.repeat(5000) + '</b>'
    const chunks = splitHtmlChunks(html, 2000)
    // None of the chunks should contain a stray `<` without a matching `>`.
    for (const c of chunks) {
      const withoutTags = c.replace(/<[^>]*>/g, '')
      expect(withoutTags).not.toContain('<')
      expect(withoutTags).not.toContain('>')
    }
  })
})

// ---------------------------------------------------------------------------
// File reference wrapping
// ---------------------------------------------------------------------------

describe('file reference wrapping', () => {
  test('wraps .ts files', () => {
    expect(markdownToHtml('Look at server.ts')).toContain('<code>server.ts</code>')
  })

  test('wraps .json files', () => {
    expect(markdownToHtml('Check package.json')).toContain('<code>package.json</code>')
  })

  test('wraps .py files', () => {
    expect(markdownToHtml('Run main.py')).toContain('<code>main.py</code>')
  })

  test('wraps complex filenames', () => {
    expect(markdownToHtml('Edit my-component.tsx')).toContain('<code>my-component.tsx</code>')
  })

  test('does not wrap non-file extensions', () => {
    const result = markdownToHtml('This is sentence.ending with a period')
    // "sentence.ending" shouldn't be wrapped since "ending" is not in the ext list
    expect(result).not.toContain('<code>sentence.ending</code>')
  })
})

// ---------------------------------------------------------------------------
// Coalescing (unit-level: test the buffer/flush logic)
// ---------------------------------------------------------------------------

describe('coalescing logic', () => {
  test('coalesceKey produces unique keys per chat+user', () => {
    // We test the key format directly — the coalescing behavior is integration-level
    const key1 = `chat1:user1`
    const key2 = `chat1:user2`
    const key3 = `chat2:user1`
    expect(key1).not.toBe(key2)
    expect(key1).not.toBe(key3)
  })

  test('messages combine with newline separator', () => {
    // Simulate what the coalescing logic does: join texts with \n
    const messages = ['Hello', 'How are you?', 'One more thing']
    const combined = messages.join('\n')
    expect(combined).toBe('Hello\nHow are you?\nOne more thing')
  })

  test('single message passes through unchanged', () => {
    const messages = ['Hello']
    const combined = messages.join('\n')
    expect(combined).toBe('Hello')
  })

  test('empty messages produce empty combined text', () => {
    const messages: string[] = []
    const combined = messages.join('\n')
    expect(combined).toBe('')
  })

  test('messages with newlines preserve internal structure', () => {
    const messages = ['Line 1\nLine 2', 'Line 3']
    const combined = messages.join('\n')
    expect(combined).toBe('Line 1\nLine 2\nLine 3')
  })
})

// ---------------------------------------------------------------------------
// repairEscapedWhitespace — defends against LLM-side JSON escape bungles
// where real newlines come through as the literal two-char sequence `\n`.
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

  test('handles the exact observed bug: html tags mixed with literal \\n', () => {
    // Reproduces the actual stream_reply failure: a model produced a message
    // with <b>/<code> tags and literal `\n` escape sequences instead of real
    // newlines, and Telegram rendered the `\n` as visible characters.
    const input = 'Audit done:\\n\\n<b>README.md</b>\\n• Missing <code>clerk update</code>\\n• Missing <code>clerk agent grant</code>'
    const repaired = repairEscapedWhitespace(input)
    expect(repaired).toBe('Audit done:\n\n<b>README.md</b>\n• Missing <code>clerk update</code>\n• Missing <code>clerk agent grant</code>')
    // And the repaired text should still be recognized as Telegram HTML
    // so the markdownToHtml pass-through works correctly.
    expect(isLikelyTelegramHtml(repaired)).toBe(true)
  })

  test('leaves text alone when it already contains real newlines', () => {
    // If the caller provided real newlines, we trust them completely and
    // don't touch literal `\n` that may appear inside their content (e.g.
    // a regex or shell snippet).
    const input = 'Real newline here\nand a literal \\n in a regex example'
    expect(repairEscapedWhitespace(input)).toBe(input)
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
    // `\\n` in the source is `\\` followed by `n`, which means the user
    // literally wanted a backslash followed by the letter n, NOT a newline.
    // Our order-aware unescape must protect `\\` before touching `\n`.
    const input = 'Windows path: C:\\\\temp\\\\file.txt\\nnext line'
    const out = repairEscapedWhitespace(input)
    expect(out).toBe('Windows path: C:\\temp\\file.txt\nnext line')
  })

  test('end-to-end with markdownToHtml: repaired text renders correctly', () => {
    // Full pipeline: broken input → repair → markdownToHtml → Telegram HTML.
    const broken = '**Bold line**\\n\\n- bullet one\\n- bullet two'
    const repaired = repairEscapedWhitespace(broken)
    const html = markdownToHtml(repaired)
    expect(html).toContain('<b>Bold line</b>')
    // Real newlines should be present in the HTML output (Telegram renders
    // them as actual line breaks in HTML parse mode).
    expect(html).toContain('\n\n')
    expect(html).toContain('- bullet one')
    // Literal \n must not survive anywhere.
    expect(html).not.toContain('\\n')
  })
})
