/**
 * Unit tests for the Telegraph publisher (#579).
 *
 * Three target areas:
 *   - createTelegraphAccount + createTelegraphPage: API client
 *     argument validation and success/error response handling.
 *   - markdownToTelegraphNodes: every block + inline branch in the
 *     converter.
 *   - deriveTelegraphTitle: heuristic title extraction.
 */

import { describe, it, expect } from 'bun:test'
import {
  createTelegraphAccount,
  createTelegraphPage,
  markdownToTelegraphNodes,
  parseInline,
  deriveTelegraphTitle,
} from '../telegraph.js'

function makeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  })) as unknown as typeof fetch
}

describe('createTelegraphAccount — validation', () => {
  it('rejects empty short_name', async () => {
    const r = await createTelegraphAccount({ shortName: '' })
    expect(r).toMatchObject({ ok: false })
  })

  it('rejects short_name over 32 chars', async () => {
    const r = await createTelegraphAccount({ shortName: 'a'.repeat(33) })
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('too long') })
  })
})

describe('createTelegraphAccount — happy path', () => {
  it('returns the access_token from a successful response', async () => {
    const r = await createTelegraphAccount({
      shortName: 'klanker',
      authorName: 'Klanker',
      fetchImpl: makeFetch(200, {
        ok: true,
        result: { short_name: 'klanker', access_token: 'tok-secret-12345' },
      }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.accessToken).toBe('tok-secret-12345')
      expect(r.value.shortName).toBe('klanker')
    }
  })

  it('returns the API error message when ok=false', async () => {
    const r = await createTelegraphAccount({
      shortName: 'klanker',
      fetchImpl: makeFetch(200, { ok: false, error: 'SHORT_NAME_INVALID' }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'SHORT_NAME_INVALID' })
  })

  it('reports HTTP errors verbatim for operator debugging', async () => {
    const r = await createTelegraphAccount({
      shortName: 'klanker',
      fetchImpl: makeFetch(503, 'service unavailable'),
    })
    expect(r).toMatchObject({ ok: false, reason: 'http-503' })
  })
})

describe('createTelegraphPage', () => {
  it('returns the published URL on success', async () => {
    const r = await createTelegraphPage({
      accessToken: 'tok',
      title: 'My Article',
      content: [{ tag: 'p', children: ['hello'] }],
      fetchImpl: makeFetch(200, {
        ok: true,
        result: { url: 'https://telegra.ph/My-Article-01-01', title: 'My Article', views: 0 },
      }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.url).toBe('https://telegra.ph/My-Article-01-01')
  })

  it('rejects missing access_token', async () => {
    const r = await createTelegraphPage({
      accessToken: '',
      title: 't',
      content: [],
    })
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('access_token') })
  })

  it('rejects empty title', async () => {
    const r = await createTelegraphPage({ accessToken: 'tok', title: '', content: [] })
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('title') })
  })

  it('rejects title over 256 chars', async () => {
    const r = await createTelegraphPage({
      accessToken: 'tok',
      title: 'x'.repeat(257),
      content: [],
    })
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('too long') })
  })
})

describe('markdownToTelegraphNodes — block elements', () => {
  it('emits a single paragraph for plain text', () => {
    const r = markdownToTelegraphNodes('hello world')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ tag: 'p' })
  })

  it('splits paragraphs on blank line', () => {
    const r = markdownToTelegraphNodes('first.\n\nsecond.')
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ tag: 'p' })
    expect(r[1]).toMatchObject({ tag: 'p' })
  })

  it('emits h3 for # heading', () => {
    const r = markdownToTelegraphNodes('# Section\n\nbody')
    expect(r[0]).toMatchObject({ tag: 'h3' })
    expect(r[1]).toMatchObject({ tag: 'p' })
  })

  it('emits h4 for ## heading', () => {
    const r = markdownToTelegraphNodes('## Subsection')
    expect(r[0]).toMatchObject({ tag: 'h4' })
  })

  it('groups consecutive - lines into one ul', () => {
    const r = markdownToTelegraphNodes('- one\n- two\n- three')
    expect(r).toHaveLength(1)
    expect(r[0].tag).toBe('ul')
    expect(r[0].children).toHaveLength(3)
  })

  it('groups consecutive 1. 2. 3. into one ol', () => {
    const r = markdownToTelegraphNodes('1. first\n2. second\n3. third')
    expect(r).toHaveLength(1)
    expect(r[0].tag).toBe('ol')
    expect(r[0].children).toHaveLength(3)
  })

  it('preserves fenced code blocks as pre>code', () => {
    const r = markdownToTelegraphNodes('```\nconst x = 1\n```')
    expect(r[0].tag).toBe('pre')
    const child = r[0].children?.[0]
    expect(typeof child === 'object' && child?.tag).toBe('code')
  })

  it('renders > quoted lines as blockquote', () => {
    const r = markdownToTelegraphNodes('> a saying\n> attributed')
    expect(r[0].tag).toBe('blockquote')
  })

  it('folds an expandable `**>` quote into one blockquote, marker stripped', () => {
    // The LEGACY switchroom expandable-quote encoding: `**>` opener on the first
    // line, `>` continuation lines. Telegra.ph has no collapsible-blockquote
    // tag, so it degrades to a normal blockquote — but the `**>` marker MUST be
    // recognised. Before the fix the `**>` line became a paragraph with literal
    // `**>` text and the `>` lines split into a detached second quote.
    const r = markdownToTelegraphNodes('**> summary of the thing\n> body one\n> body two')
    expect(r).toHaveLength(1)
    expect(r[0].tag).toBe('blockquote')
    // Summary and body are joined in the single quote, no literal `**>` leaks.
    const flat = JSON.stringify(r)
    expect(flat).not.toContain('**>')
    expect(flat).not.toContain('*') // no stray bold delimiter survives
    expect(flat).toContain('summary of the thing')
    expect(flat).toContain('body one')
    expect(flat).toContain('body two')
  })

  it('does not let a paragraph absorb a following `**>` opener', () => {
    // isBlockStart must treat `**>` as a block start so the preceding line ends
    // the paragraph instead of swallowing the quote (which left the `**>`
    // literal glued into prose).
    const r = markdownToTelegraphNodes('Intro line\n**> quoted summary')
    expect(r.map((n) => n.tag)).toEqual(['p', 'blockquote'])
    expect(r[0].children).toEqual(['Intro line'])
  })

  it('does not misread a line that merely opens with bold text', () => {
    // `**` is only a quote marker when `>` follows it immediately. A line
    // starting with real bold must stay a paragraph, not become a blockquote.
    const r = markdownToTelegraphNodes('**bold** > x')
    expect(r.map((n) => n.tag)).toEqual(['p'])
  })

  it('handles a mixed document end-to-end', () => {
    const md = '# Title\n\nIntro paragraph.\n\n## Steps\n\n- one\n- two\n\nFinal note.'
    const r = markdownToTelegraphNodes(md)
    expect(r.map((n) => n.tag)).toEqual(['h3', 'p', 'h4', 'ul', 'p'])
  })
})

describe('parseInline — inline markdown', () => {
  it('parses inline code', () => {
    const r = parseInline('use `npm install` to set up')
    const codeNode = r.find((c) => typeof c === 'object' && c.tag === 'code')
    expect(codeNode).toBeDefined()
  })

  it('parses bold', () => {
    const r = parseInline('this is **important**')
    const boldNode = r.find((c) => typeof c === 'object' && c.tag === 'b')
    expect(boldNode).toBeDefined()
  })

  it('parses italic', () => {
    const r = parseInline('a *highlighted* word')
    const italicNode = r.find((c) => typeof c === 'object' && c.tag === 'i')
    expect(italicNode).toBeDefined()
  })

  it('parses [text](url) anchors', () => {
    const r = parseInline('see [docs](https://example.com)')
    const anchor = r.find((c) => typeof c === 'object' && c.tag === 'a') as
      | { attrs?: { href?: string } }
      | undefined
    expect(anchor?.attrs?.href).toBe('https://example.com')
  })

  it('auto-links bare URLs', () => {
    const r = parseInline('visit https://example.com today')
    const anchor = r.find((c) => typeof c === 'object' && c.tag === 'a') as
      | { attrs?: { href?: string } }
      | undefined
    expect(anchor?.attrs?.href).toBe('https://example.com')
  })

  it('does not eagerly italic across word-boundaries', () => {
    // `a*b*c` should NOT match italic — common false-positive.
    const r = parseInline('a*b*c')
    const italicNode = r.find((c) => typeof c === 'object' && c.tag === 'i')
    expect(italicNode).toBeUndefined()
  })

  it('returns plain text when no markup present', () => {
    const r = parseInline('just plain words')
    expect(r).toEqual(['just plain words'])
  })
})

describe('deriveTelegraphTitle', () => {
  it('uses the first heading when present', () => {
    expect(deriveTelegraphTitle('# Important update\n\nbody')).toBe('Important update')
  })

  it('falls back to the first non-empty line', () => {
    expect(deriveTelegraphTitle('\n\nFirst non-empty line.\n\nMore.')).toBe('First non-empty line.')
  })

  it('strips leading list markers from the title', () => {
    expect(deriveTelegraphTitle('- first item\n- second')).toBe('first item')
  })

  it('returns Untitled for fully blank input', () => {
    expect(deriveTelegraphTitle('   \n\n   ')).toBe('Untitled')
    expect(deriveTelegraphTitle('')).toBe('Untitled')
  })

  it('truncates over-long titles to 64 chars + ellipsis', () => {
    const long = 'x'.repeat(80)
    const t = deriveTelegraphTitle(long)
    expect(t.length).toBeLessThanOrEqual(64)
    expect(t.endsWith('...')).toBe(true)
  })
})
