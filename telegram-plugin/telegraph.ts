/**
 * Telegraph Instant View publisher (#579).
 *
 * When a reply would otherwise chunk into multiple Telegram messages
 * (default threshold 3000 chars), and the agent has telegraph
 * enabled, the gateway:
 *   1. Lazily creates a Telegraph account on first use, caches the
 *      access_token alongside the agent state.
 *   2. Converts the reply text into Telegraph node structure.
 *   3. Publishes a page → gets a URL.
 *   4. Replies with a single Telegram message containing the URL,
 *      which Telegram renders as a native Instant View card.
 *
 * Pure module. Takes the API key + content as args; no env reads,
 * no file I/O. The gateway side handles the access_token cache and
 * the routing decision.
 *
 * Telegraph API docs: https://telegra.ph/api
 */

const TELEGRAPH_API = 'https://api.telegra.ph'

/** Telegraph node structure. The API accepts a tree of these as
 *  `content`. Tags supported per docs: a, aside, b, blockquote, br,
 *  code, em, figcaption, figure, h3, h4, hr, i, iframe, img, li,
 *  ol, p, pre, s, strong, u, ul, video.
 *
 *  We only generate the conservative subset here (p, h3, h4, code,
 *  pre, b, i, a, br, ul, ol, li, blockquote) — anything more exotic
 *  isn't worth the format-conversion complexity for v1.
 */
export interface TelegraphNode {
  tag: string
  attrs?: Record<string, string>
  children?: Array<TelegraphNode | string>
}

export interface TelegraphAccount {
  shortName: string
  accessToken: string
  authorName?: string
  authorUrl?: string
}

export interface TelegraphCreateAccountArgs {
  shortName: string
  authorName?: string
  authorUrl?: string
  fetchImpl?: typeof fetch
}

export type TelegraphResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * Create a Telegraph account. The returned `accessToken` is the
 * credential for all subsequent calls — store it.
 *
 * Telegraph docs: https://telegra.ph/api#createAccount
 */
export async function createTelegraphAccount(
  args: TelegraphCreateAccountArgs,
): Promise<TelegraphResult<TelegraphAccount>> {
  if (!args.shortName || args.shortName.length === 0) {
    return { ok: false, reason: 'short_name is required' }
  }
  // Telegraph accepts short_name 1-32 chars, A-Z a-z 0-9 + spaces.
  if (args.shortName.length > 32) {
    return { ok: false, reason: 'short_name too long (max 32)' }
  }

  const fetchFn = args.fetchImpl ?? fetch
  const params = new URLSearchParams()
  params.set('short_name', args.shortName)
  if (args.authorName) params.set('author_name', args.authorName)
  if (args.authorUrl) params.set('author_url', args.authorUrl)

  let res: Response
  try {
    res = await fetchFn(`${TELEGRAPH_API}/createAccount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
  } catch (err) {
    return { ok: false, reason: `fetch-failed: ${(err as Error).message}` }
  }

  if (!res.ok) {
    return { ok: false, reason: `http-${res.status}` }
  }

  type RawResponse = { ok?: boolean; result?: { short_name?: string; access_token?: string }; error?: string }
  let body: RawResponse
  try {
    body = await res.json() as RawResponse
  } catch (err) {
    return { ok: false, reason: `malformed-response: ${(err as Error).message}` }
  }

  if (!body.ok || !body.result?.access_token) {
    return { ok: false, reason: body.error ?? 'telegraph rejected createAccount' }
  }

  return {
    ok: true,
    value: {
      shortName: body.result.short_name ?? args.shortName,
      accessToken: body.result.access_token,
      authorName: args.authorName,
      authorUrl: args.authorUrl,
    },
  }
}

export interface TelegraphPage {
  url: string
  title: string
  views: number
}

export interface TelegraphCreatePageArgs {
  accessToken: string
  title: string
  content: TelegraphNode[]
  authorName?: string
  authorUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * Publish a Telegraph page with the given content tree.
 *
 * Title is required; max 256 chars. Content is the node array we
 * built from the agent's reply text via `markdownToTelegraphNodes`.
 *
 * Telegraph docs: https://telegra.ph/api#createPage
 */
export async function createTelegraphPage(
  args: TelegraphCreatePageArgs,
): Promise<TelegraphResult<TelegraphPage>> {
  if (!args.accessToken) return { ok: false, reason: 'access_token required' }
  if (!args.title || args.title.length === 0) {
    return { ok: false, reason: 'title required' }
  }
  if (args.title.length > 256) {
    return { ok: false, reason: 'title too long (max 256)' }
  }

  const fetchFn = args.fetchImpl ?? fetch
  const params = new URLSearchParams()
  params.set('access_token', args.accessToken)
  params.set('title', args.title)
  params.set('content', JSON.stringify(args.content))
  params.set('return_content', 'false')
  if (args.authorName) params.set('author_name', args.authorName)
  if (args.authorUrl) params.set('author_url', args.authorUrl)

  let res: Response
  try {
    res = await fetchFn(`${TELEGRAPH_API}/createPage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
  } catch (err) {
    return { ok: false, reason: `fetch-failed: ${(err as Error).message}` }
  }

  if (!res.ok) {
    return { ok: false, reason: `http-${res.status}` }
  }

  type RawResponse = { ok?: boolean; result?: { url?: string; title?: string; views?: number }; error?: string }
  let body: RawResponse
  try {
    body = await res.json() as RawResponse
  } catch (err) {
    return { ok: false, reason: `malformed-response: ${(err as Error).message}` }
  }

  if (!body.ok || !body.result?.url) {
    return { ok: false, reason: body.error ?? 'telegraph rejected createPage' }
  }

  return {
    ok: true,
    value: {
      url: body.result.url,
      title: body.result.title ?? args.title,
      views: body.result.views ?? 0,
    },
  }
}

/**
 * A blockquote line: a plain `> ` marker OR the LEGACY expandable-blockquote
 * opener `**> ` (a switchroom encoding once believed to be Bot API 10.1
 * syntax; wire probes 2026-08-13 showed the rich path renders `**>` as
 * literal text, so `render/render.ts` no longer emits it — but legacy agent
 * output still contains it and it must be tolerated on input here).
 * Telegra.ph has no collapsible
 * blockquote tag, so an expandable quote degrades to a normal `<blockquote>`;
 * the `**` prefix must still be recognised and stripped here, else the
 * unterminated `**` renders as literal `**>` text and the `>` continuation
 * lines split off into a second, detached quote.
 */
const TELEGRAPH_QUOTE_LINE = /^(?:\*\*)?>\s?/

/**
 * Convert reply text (markdown-ish) into Telegraph node structure.
 *
 * Lives between the two extremes of "raw text in one paragraph"
 * and "full markdown parser." The chosen middle:
 *   - Blank lines separate paragraphs.
 *   - Lines starting with `# ` / `## ` become h3/h4.
 *   - Lines starting with `- ` or `* ` become a `<ul>` block.
 *   - Lines starting with `1. ` etc. become an `<ol>` block.
 *   - Triple-backtick fenced code blocks become `<pre><code>`.
 *   - Inline `code` becomes `<code>`. Inline `**bold**` becomes
 *     `<b>`. Inline `*italic*` becomes `<i>`.
 *   - URLs become anchors.
 *
 * NOT a markdown spec implementation — a pragmatic converter that
 * makes Whisper/agent output read cleanly in Instant View. Edge
 * cases bias toward "render as plain text in a paragraph" rather
 * than throwing.
 *
 * Pure — no I/O, fully unit-testable.
 */
export function markdownToTelegraphNodes(text: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = []
  const lines = text.split(/\r?\n/)

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Blank line — skip.
    if (line.trim().length === 0) {
      i++
      continue
    }

    // Fenced code block.
    if (line.trim().startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // consume closing fence
      nodes.push({ tag: 'pre', children: [{ tag: 'code', children: [code.join('\n')] }] })
      continue
    }

    // Headings.
    const h3 = /^#\s+(.+)$/.exec(line)
    if (h3) {
      nodes.push({ tag: 'h3', children: parseInline(h3[1]) })
      i++
      continue
    }
    const h4 = /^##\s+(.+)$/.exec(line)
    if (h4) {
      nodes.push({ tag: 'h4', children: parseInline(h4[1]) })
      i++
      continue
    }

    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const items: TelegraphNode[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[-*]\s+/, '')
        items.push({ tag: 'li', children: parseInline(itemText) })
        i++
      }
      nodes.push({ tag: 'ul', children: items })
      continue
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      const items: TelegraphNode[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\d+\.\s+/, '')
        items.push({ tag: 'li', children: parseInline(itemText) })
        i++
      }
      nodes.push({ tag: 'ol', children: items })
      continue
    }

    // Blockquote — plain `> …` OR an expandable `**> …` opener followed by
    // `> …` continuation lines. Both collapse into one <blockquote> with the
    // markers stripped (Telegra.ph has no expandable-blockquote tag, so the
    // expandable quote degrades faithfully to a normal one; the `**>` marker is
    // stripped so no literal `**>` leaks and the summary stays with its body).
    if (TELEGRAPH_QUOTE_LINE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && TELEGRAPH_QUOTE_LINE.test(lines[i])) {
        quoted.push(lines[i].replace(TELEGRAPH_QUOTE_LINE, ''))
        i++
      }
      nodes.push({ tag: 'blockquote', children: parseInline(quoted.join(' ')) })
      continue
    }

    // Default — gather consecutive non-empty lines into one paragraph.
    const para: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim().length > 0 && !isBlockStart(lines[i])) {
      para.push(lines[i])
      i++
    }
    nodes.push({ tag: 'p', children: parseInline(para.join(' ')) })
  }

  return nodes
}

/** Detect the start of a block-level construct so paragraph
 *  collection knows when to stop. */
function isBlockStart(line: string): boolean {
  return (
    /^#{1,2}\s/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    line.trim().startsWith('```') ||
    // A `**>` expandable-quote opener is a block start too, so a preceding
    // paragraph does not absorb it (which is what left the `**>` literal).
    TELEGRAPH_QUOTE_LINE.test(line)
  )
}

/**
 * Parse inline-markdown into a mix of strings and inline-formatting
 * nodes. Order: code first (so backticks don't get re-parsed as
 * other formatting), then bold, then italic, then auto-link URLs.
 */
export function parseInline(text: string): Array<TelegraphNode | string> {
  // Strategy: tokenize iteratively. Each pass replaces the matched
  // pattern with a placeholder, accumulating nodes. Final string
  // pieces are joined as text children.
  //
  // Simpler implementation: sequential regex scans with a cursor.
  // We construct an array of tokens (string | node) and skip past
  // matched ranges.

  const out: Array<TelegraphNode | string> = []
  let cursor = 0
  while (cursor < text.length) {
    const codeMatch = /`([^`\n]+)`/.exec(text.slice(cursor))
    const boldMatch = /\*\*([^*]+)\*\*/.exec(text.slice(cursor))
    const italicMatch = /(?<![*\w])\*([^*\n]+)\*(?!\*)/.exec(text.slice(cursor))
    const linkMatch = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(cursor))
    const urlMatch = /(https?:\/\/[^\s<>]+)/.exec(text.slice(cursor))

    // Find the EARLIEST match across all pattern types.
    const candidates = [codeMatch, boldMatch, italicMatch, linkMatch, urlMatch].filter(Boolean) as RegExpExecArray[]
    if (candidates.length === 0) {
      out.push(text.slice(cursor))
      break
    }
    candidates.sort((a, b) => a.index - b.index)
    const earliest = candidates[0]
    const rel = earliest.index
    if (rel > 0) out.push(text.slice(cursor, cursor + rel))

    if (earliest === codeMatch) {
      out.push({ tag: 'code', children: [earliest[1]] })
    } else if (earliest === boldMatch) {
      out.push({ tag: 'b', children: parseInline(earliest[1]) })
    } else if (earliest === italicMatch) {
      out.push({ tag: 'i', children: parseInline(earliest[1]) })
    } else if (earliest === linkMatch) {
      out.push({ tag: 'a', attrs: { href: earliest[2] }, children: parseInline(earliest[1]) })
    } else if (earliest === urlMatch) {
      out.push({ tag: 'a', attrs: { href: earliest[1] }, children: [earliest[1]] })
    }
    cursor += rel + earliest[0].length
  }

  return out
}

/**
 * Pick a title from the message body. Telegraph requires one;
 * agents pass a body without a title. Heuristic: first heading,
 * else first non-empty line, else "Untitled". Trimmed to 64 chars.
 */
export function deriveTelegraphTitle(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.replace(/^[#>*\-\d.]\s*/, '').trim()
    if (stripped.length > 0) {
      return stripped.length > 64 ? stripped.slice(0, 61) + '...' : stripped
    }
  }
  return 'Untitled'
}
