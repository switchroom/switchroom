/**
 * Unit tests for the Telegram-HTML sanitizer (issue #657).
 *
 * The sanitizer is the pre-validation layer that runs after
 * markdownToHtml() and before bot.api.sendMessage. Its job is to
 * guarantee that whatever HTML it emits, Telegram will accept under
 * parse_mode=HTML — closing the `400 Bad Request: can't parse entities`
 * loophole that produced the duplicate-message symptom in #657.
 */

import { describe, it, expect } from 'vitest'
import {
  sanitizeTelegramHtml,
  htmlToPlainText,
  escapeAllHtml,
} from '../html-sanitize.js'

describe('sanitizeTelegramHtml', () => {
  it('passes whitelisted tags through unchanged', () => {
    expect(sanitizeTelegramHtml('<b>bold</b>')).toBe('<b>bold</b>')
    expect(sanitizeTelegramHtml('<i>italic</i>')).toBe('<i>italic</i>')
    expect(sanitizeTelegramHtml('<code>x</code>')).toBe('<code>x</code>')
    expect(sanitizeTelegramHtml('<pre>block</pre>')).toBe('<pre>block</pre>')
    expect(sanitizeTelegramHtml('<blockquote>q</blockquote>')).toBe('<blockquote>q</blockquote>')
  })

  it('escapes unknown tags', () => {
    expect(sanitizeTelegramHtml('<frobnicate>x</frobnicate>')).toBe(
      '&lt;frobnicate&gt;x&lt;/frobnicate&gt;',
    )
    expect(sanitizeTelegramHtml('<div>hi</div>')).toBe('&lt;div&gt;hi&lt;/div&gt;')
  })

  it('escapes stray < that does not open a tag', () => {
    expect(sanitizeTelegramHtml('1 < 2 < 3')).toBe('1 &lt; 2 &lt; 3')
    expect(sanitizeTelegramHtml('a < b')).toBe('a &lt; b')
  })

  it('auto-closes unclosed whitelisted tags', () => {
    expect(sanitizeTelegramHtml('<b>unfinished')).toBe('<b>unfinished</b>')
    expect(sanitizeTelegramHtml('<b><i>nested')).toBe('<b><i>nested</i></b>')
  })

  it('drops unmatched closing tags', () => {
    expect(sanitizeTelegramHtml('hello</b>')).toBe('hello')
    expect(sanitizeTelegramHtml('</i>plain')).toBe('plain')
  })

  it('auto-closes inner tags when an outer is closed early', () => {
    // <b><i>x</b>  →  <b><i>x</i></b>
    const out = sanitizeTelegramHtml('<b><i>x</b>')
    expect(out).toBe('<b><i>x</i></b>')
  })

  it('strips disallowed attributes', () => {
    expect(sanitizeTelegramHtml('<b class="evil" onclick="x()">x</b>')).toBe('<b>x</b>')
    // <code class> is allowed
    expect(sanitizeTelegramHtml('<code class="language-ts">x</code>')).toBe(
      '<code class="language-ts">x</code>',
    )
  })

  it('blocks dangerous href schemes', () => {
    expect(sanitizeTelegramHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
    expect(sanitizeTelegramHtml('<a href="data:text/html,x">x</a>')).toBe('<a>x</a>')
    expect(sanitizeTelegramHtml('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com">x</a>',
    )
  })

  it('escapes naked ampersands but preserves entities', () => {
    expect(sanitizeTelegramHtml('a & b')).toBe('a &amp; b')
    expect(sanitizeTelegramHtml('a &amp; b')).toBe('a &amp; b')
    expect(sanitizeTelegramHtml('a &lt;b&gt;')).toBe('a &lt;b&gt;')
    expect(sanitizeTelegramHtml('a &#123;')).toBe('a &#123;')
  })

  it('is idempotent', () => {
    const fixtures = [
      '<b>x</b>',
      '<b><i>nested</i></b>',
      '<b>unclosed',
      '<frobnicate>x</frobnicate>',
      '1 < 2',
      '<b><i>x</b>',
      'a & b & c',
    ]
    for (const f of fixtures) {
      const once = sanitizeTelegramHtml(f)
      const twice = sanitizeTelegramHtml(once)
      expect(twice).toBe(once)
    }
  })

  it('handles the #657 repro fixture (1799-char "Where I route" message shape)', () => {
    // Reconstruct the structural shape of the body that tripped Telegram.
    // The exact text isn't checked into the repo; what matters is the
    // pattern: nested <code> inside <b> inside <pre>, plus a stray `<`
    // in the middle of the prose, plus an unclosed tag near the end.
    const fixture = [
      '<b>Where I route:</b>',
      '',
      '<pre><b><code>switchroom &lt;cmd&gt;</code></b></pre>',
      '',
      'When the user types `cmd <args>` in the bridge, the gateway forwards…',
      '',
      '<b>Some unclosed bold here',
      '<frobnicate>not a real tag</frobnicate>',
    ].join('\n')

    const out = sanitizeTelegramHtml(fixture)

    // Must not contain any unknown tag literally.
    expect(out).not.toMatch(/<frobnicate/)
    // Stray < (in `cmd <args>`) is escaped.
    expect(out).toContain('&lt;args&gt;')
    // The unclosed <b> at end has been auto-closed.
    const opens = (out.match(/<b\b[^>]*>/g) ?? []).length
    const closes = (out.match(/<\/b>/g) ?? []).length
    expect(opens).toBe(closes)
  })

  it('treats an attribute on a void/unknown tag like any unknown tag', () => {
    expect(sanitizeTelegramHtml('<img src="x">')).toBe('&lt;img src="x"&gt;')
  })

  it('preserves blockquote expandable bare attribute', () => {
    expect(sanitizeTelegramHtml('<blockquote expandable>x</blockquote>')).toBe(
      '<blockquote expandable>x</blockquote>',
    )
  })
})

describe('htmlToPlainText', () => {
  it('strips tags and unescapes entities', () => {
    expect(htmlToPlainText('<b>hi</b>')).toBe('hi')
    expect(htmlToPlainText('<b>a</b> &lt;b&gt; c')).toBe('a <b> c')
    expect(htmlToPlainText('a &amp; b')).toBe('a & b')
  })
})

describe('escapeAllHtml', () => {
  it('escapes all three HTML metachars', () => {
    expect(escapeAllHtml('<b>&hi</b>')).toBe('&lt;b&gt;&amp;hi&lt;/b&gt;')
  })
})
