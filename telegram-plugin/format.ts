/**
 * Telegram-flavored markdown→HTML rendering and chunking.
 *
 * Extracted from server.ts so tests can import these helpers without
 * triggering the bot startup side effects (env loading, token check,
 * grammy instantiation). server.ts re-exports the public API for
 * backwards compatibility with any external callers.
 *
 * Three pieces:
 *   - markdownToHtml + isLikelyTelegramHtml: convert model output to
 *     Telegram-safe HTML, preserving any embedded whitelisted Telegram
 *     HTML tags so the model can mix markdown bold with raw <b>/<i>/<a>.
 *   - splitHtmlChunks: split a long HTML message into <=4096-char chunks
 *     that preserve open/close tag balance and don't bisect HTML entities.
 *   - escapeHtml: the three-char escape used everywhere.
 */

/**
 * Telegram-supported HTML tags. Anything outside this set is either
 * unrecognized (Telegram strips it) or actively dangerous (the API
 * rejects the message). Source: https://core.telegram.org/bots/api#html-style
 */
export const TELEGRAM_HTML_TAGS = new Set([
  'b', 'strong',
  'i', 'em',
  'u', 'ins',
  's', 'strike', 'del',
  'span', // requires class="tg-spoiler"
  'tg-spoiler',
  'a',
  'tg-emoji',
  'code',
  'pre',
  'blockquote',
])

/**
 * Heuristic: does this look like already-rendered Telegram HTML rather
 * than markdown waiting to be converted?
 *
 * Returns true when ALL the tags we find are recognized Telegram HTML
 * tags AND there's at least one of them AND the text doesn't also have
 * markdown-only syntax (** for bold, [text](url) for links). This is
 * conservative: if the model wrote `<div>foo</div>` (not Telegram HTML),
 * we treat it as markdown and escape it. If the model wrote `<b>foo</b>`,
 * we trust it.
 *
 * Critical: we strip markdown code spans and fenced code blocks BEFORE
 * scanning for tags, because the model frequently writes things like
 * `\`<b>tag</b>\`` (an inline code example showing literal HTML). Without
 * the strip, the heuristic would see `<b>` inside the code span and
 * misclassify the whole text as raw HTML.
 */
export function isLikelyTelegramHtml(text: string): boolean {
  // Strip fenced code blocks first (greedy, cross-line)
  let scanText = text.replace(/```[\s\S]*?```/g, '')
  // Then strip inline code spans (single backticks, no newlines)
  scanText = scanText.replace(/`[^`\n]+`/g, '')

  // If the stripped text contains markdown-only syntax (**bold**,
  // [text](url), or markdown headings), the caller is writing markdown
  // even if they ALSO sprinkled some <b> tags in. Treat as markdown.
  if (/\*\*[^\n*]+\*\*/.test(scanText)) return false
  if (/\[[^\]]+\]\([^)]+\)/.test(scanText)) return false
  if (/^#{1,6}\s+/m.test(scanText)) return false

  // Now count remaining HTML tags
  const tagMatches = scanText.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)
  let count = 0
  for (const m of tagMatches) {
    const tag = m[1].toLowerCase()
    if (!TELEGRAM_HTML_TAGS.has(tag)) {
      // Found an unsupported tag — caller didn't intend Telegram HTML
      return false
    }
    count++
  }
  return count > 0
}

/**
 * Convert markdown to Telegram-compatible HTML.
 * Handles bold, italic, code, code blocks, strikethrough, links.
 * Escapes HTML entities in plain text. Wraps file references in <code>.
 * Preserves embedded whitelisted Telegram HTML tags so the model can
 * mix markdown and raw HTML in the same message.
 */
export function markdownToHtml(text: string): string {
  // Smart pass-through: if the input is already valid Telegram HTML
  // (every tag is in the supported list), trust the caller and return
  // it unchanged.
  if (isLikelyTelegramHtml(text)) {
    return text
  }

  // First, extract code blocks and inline code to protect them from other transforms.
  const codeBlocks: string[] = []
  const BLOCK_PH = '\x00CODEBLOCK'
  const INLINE_PH = '\x00CODEINLINE'

  // Code blocks: ```lang\ncode\n```
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''))
    const cls = lang ? ` class="language-${lang}"` : ''
    const idx = codeBlocks.length
    codeBlocks.push(`<pre><code${cls}>${escaped}</code></pre>`)
    return `${BLOCK_PH}${idx}\x00`
  })

  // Convert markdown headings (# / ## / ### ...) to bold lines on their
  // own. Telegram has no <h1> tag, and rendering ## as plain text leaves
  // ugly hash marks in the message.
  result = result.replace(/^(#{1,6})\s+(.+?)\s*$/gm, (_m, _hashes, title: string) => {
    return `**${title}**`
  })

  // Inline code: `code`
  const inlineCodes: string[] = []
  result = result.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `${INLINE_PH}${idx}\x00`
  })

  // Telegram HTML tag pass-through. Extract any opening/closing tag
  // whose name is in the whitelist into placeholders. The TEXT BETWEEN
  // tags still flows through escapeHtml and the markdown conversions
  // below, so `<b>**bold**</b>` and `<b>plain</b>` both work. Tags are
  // restored verbatim at the very end.
  const htmlTags: string[] = []
  const HTMLTAG_PH = '\x00HTMLTAG'
  const tagNamePattern = Array.from(TELEGRAM_HTML_TAGS).join('|')
  const htmlTagRe = new RegExp(`</?(?:${tagNamePattern})\\b[^>]*>`, 'gi')
  result = result.replace(htmlTagRe, (match: string) => {
    const idx = htmlTags.length
    htmlTags.push(match)
    return `${HTMLTAG_PH}${idx}\x00`
  })

  // Escape HTML entities in remaining plain text
  result = escapeHtml(result)

  // Restore code-block placeholders (entity-escaped, fix them)
  result = result.replace(new RegExp(`${escapeHtml(BLOCK_PH)}(\\d+)${escapeHtml('\x00')}`, 'g'), (_m, idx) => codeBlocks[Number(idx)])
  result = result.replace(new RegExp(`${escapeHtml(INLINE_PH)}(\\d+)${escapeHtml('\x00')}`, 'g'), (_m, idx) => inlineCodes[Number(idx)])

  // Bold: **text** (must come before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // Italic: *text* (single asterisk, not preceded by another *)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // File references: wrap filename.ext patterns in <code> tags.
  // Lookbehind excludes `>` so we don't double-wrap filenames that are
  // already inside a restored inline-code placeholder like
  // `<code>settings.json</code>`. Without this, the regex matched the
  // filename character immediately after the `>` of the opening <code>
  // tag and re-wrapped it, producing `<code><code>settings.json</code></code>`.
  result = result.replace(/(?<![<\/\w>])(\b[\w][\w.-]*\.(?:ts|js|py|rs|go|json|yaml|yml|toml|md|txt|sh|bash|zsh|css|html|xml|sql|env|cfg|conf|ini|log|csv|tsx|jsx|vue|svelte|rb|java|kt|swift|c|cpp|h|hpp|zig|asm|wasm|lock|mod|sum)\b)(?![^<]*>)/g, '<code>$1</code>')

  // Restore preserved Telegram HTML tags (must run last so the file-ref
  // regex above doesn't accidentally match characters inside our placeholders).
  result = result.replace(new RegExp(`${escapeHtml(HTMLTAG_PH)}(\\d+)${escapeHtml('\x00')}`, 'g'), (_m, idx) => htmlTags[Number(idx)])

  return result
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Repair LLM-side JSON escape bungles.
 *
 * Some MCP clients (and some LLM tool-call generators) occasionally emit a
 * tool-argument string whose whitespace has been double-escaped — real
 * newlines become the two-character sequence `\n`, tabs become `\t`, etc.
 * The message then ships to Telegram intact and the user sees literal
 * `\n\n` in the chat instead of paragraph breaks.
 *
 * Heuristic: if the text contains ZERO real newlines AND has at least one
 * literal `\n`, `\r`, or `\t` escape sequence, the caller almost certainly
 * intended those as real whitespace and the client serializer ate them.
 * Unescape them (also `\\` and `\"`). If the text has any real newline,
 * trust the caller exactly as given and do nothing — legitimate content
 * may contain a literal `\n` inside a shell snippet or regex.
 *
 * This is intentionally narrow: it only fires on the clear bug signature
 * (multi-line-looking content collapsed to one physical line). False
 * positives on a single-line message that legitimately contains `\n` are
 * possible but rare — users writing single-line shell snippets typically
 * wrap them in backticks, and this runs before markdown→HTML so the
 * unescape has no effect on text inside fenced code blocks if it already
 * has real newlines around them.
 */
export function repairEscapedWhitespace(text: string): string {
  if (text.includes('\n') || text.includes('\r')) return text
  if (!/\\[nrt"\\]/.test(text)) return text
  // Order matters: protect existing `\\` first so `\\n` stays as `\n`
  // literal and doesn't become a newline.
  const BACKSLASH_PH = '\x00BKSL\x00'
  return text
    .replace(/\\\\/g, BACKSLASH_PH)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(new RegExp(BACKSLASH_PH, 'g'), '\\')
}

// ---------------------------------------------------------------------------
// Smart HTML chunking — preserves open/close tag boundaries
// ---------------------------------------------------------------------------

/**
 * Split HTML text into chunks that fit within maxLen, preserving tag integrity.
 * At split boundaries, open tags are closed and reopened in the next chunk.
 * Prefers splitting at \n\n, then \n, then spaces.
 */
export function splitHtmlChunks(html: string, maxLen = 4000): string[] {
  if (html.length <= maxLen) return [html]

  const chunks: string[] = []
  let rest = html

  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest)
      break
    }

    // Find a good split point
    let cut = maxLen
    const paraIdx = rest.lastIndexOf('\n\n', maxLen)
    const lineIdx = rest.lastIndexOf('\n', maxLen)
    const spaceIdx = rest.lastIndexOf(' ', maxLen)

    if (paraIdx > maxLen / 3) {
      cut = paraIdx
    } else if (lineIdx > maxLen / 3) {
      cut = lineIdx
    } else if (spaceIdx > 0) {
      cut = spaceIdx
    }

    // Defense-in-depth: refuse to split inside an HTML entity (&amp;,
    // &lt;, &#x1f4a9;). If the cut would land mid-entity, back up to
    // before the `&`. Telegram rejects messages with broken entities.
    cut = backOffEntity(rest, cut)
    // Same idea for a bisected tag: if the cut lands inside `<...>` (or
    // between `<` and its closing `>`), back up to before the `<`.
    // Otherwise we'd emit a chunk ending in `<a` or `<a href="..` which
    // Telegram rejects outright.
    cut = backOffOpenTag(rest, cut)
    // Pathological: the tag-back-off retreated to 0 because `rest`
    // begins with a tag and the nearest space we picked landed inside
    // that tag. Fall back to the hard maxLen cut — that position lives
    // in content past the opening tag (since the tag itself is at the
    // start) so it won't bisect anything, and we make forward progress.
    if (cut <= 0) {
      cut = Math.min(maxLen, rest.length)
      cut = backOffOpenTag(rest, cut)
      // If even the maxLen cut bisects a tag, emit the whole remainder
      // as one chunk rather than spin forever. Telegram will reject
      // a 4k+ message before it rejects a split one, but this only
      // fires on genuinely malformed input.
      if (cut <= 0) cut = rest.length
    }

    let segment = rest.slice(0, cut)
    rest = rest.slice(cut).replace(/^\n+/, '')

    // Track open tags in this segment — we keep the FULL opening tag
    // string (including attributes) so we can reopen `<a href="...">`
    // in the next chunk without dropping the href.
    const openTags = getOpenTags(segment)

    // Close any open tags at the end of this chunk (by tag name)
    for (let i = openTags.length - 1; i >= 0; i--) {
      segment += `</${openTags[i].name}>`
    }
    chunks.push(segment)

    // Reopen tags at the start of the next chunk, preserving attrs
    if (rest.length > 0 && openTags.length > 0) {
      const reopenPrefix = openTags.map(t => t.openTag).join('')
      rest = reopenPrefix + rest
    }
  }

  return chunks
}

/**
 * If `cut` lies inside an HTML entity (a `&...;` sequence), back it up to
 * just before the `&` so the chunk boundary doesn't bisect the entity.
 */
function backOffEntity(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut
  // Look backward up to 10 chars for an unterminated entity
  const lookback = Math.max(0, cut - 10)
  for (let i = cut - 1; i >= lookback; i--) {
    const ch = text[i]
    if (ch === ';') return cut // entity already closed before cut → safe
    if (ch === '&') {
      const closeIdx = text.indexOf(';', cut)
      if (closeIdx !== -1 && closeIdx - i <= 10) {
        // The entity spans the cut — back up to just before the `&`
        return i
      }
      return cut
    }
  }
  return cut
}

/**
 * If `cut` lands inside an HTML tag (between `<` and the next `>`), back
 * up to before the `<`. Telegram rejects messages that contain a stray
 * `<` without a matching `>` (e.g. chunk ending `<a href="..`).
 */
function backOffOpenTag(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut
  // Scan backward for the nearest `<` or `>` before the cut. If we hit
  // `>` first the cut is outside any tag → safe. If we hit `<` first,
  // check whether its closing `>` lies at or after the cut → bisected.
  for (let i = cut - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '>') return cut
    if (ch === '<') {
      const closeIdx = text.indexOf('>', i)
      if (closeIdx >= cut) return i
      return cut
    }
  }
  return cut
}

/** A tag still open at the end of a fragment. */
interface OpenTag {
  name: string       // lowercase tag name, e.g. "a", "tg-spoiler"
  openTag: string    // full opening string with attrs, e.g. `<a href="...">`
}

/** Parse an HTML fragment and return the list of tags still open at the end. */
function getOpenTags(html: string): OpenTag[] {
  const tagStack: OpenTag[] = []
  // Allow hyphens in tag names so `tg-spoiler` and `tg-emoji` parse as a
  // single tag rather than `tg` plus stray text.
  const tagRe = /<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html)) !== null) {
    const full = m[0]
    const isClosing = m[1] === '/'
    const tagName = m[2].toLowerCase()
    if (isClosing) {
      // Closing tag — pop the most recent matching entry off the stack
      for (let i = tagStack.length - 1; i >= 0; i--) {
        if (tagStack[i].name === tagName) {
          tagStack.splice(i, 1)
          break
        }
      }
    } else if (!full.endsWith('/>')) {
      // Opening tag (not self-closing) — remember the full open string
      // so reopen in the next chunk preserves attributes.
      tagStack.push({ name: tagName, openTag: full })
    }
  }
  return tagStack
}
