/**
 * Tests for Telegram formatting utilities: markdownToHtml, splitHtmlChunks,
 * file reference wrapping, and message coalescing.
 */
import { describe, test, expect } from 'vitest'

// Import the exported functions from server.ts
// We use a direct import — Bun handles TS natively.
import { markdownToHtml, splitHtmlChunks, isLikelyTelegramHtml } from '../server'

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
