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

// ---------------------------------------------------------------------------
// Markdown table → Telegram HTML
// ---------------------------------------------------------------------------

/**
 * Parse a contiguous block of lines as a markdown table.
 *
 * A valid markdown table requires:
 *   - A header row:    | col | col |   (leading/trailing pipes optional)
 *   - A separator row: | --- | --- |   (cells are only dashes, colons, spaces)
 *   - At least one data row.
 *
 * The separator row is the discriminating signal — it prevents plain prose
 * lines that happen to contain a pipe (e.g. `echo foo | bar`) from being
 * mistaken for tables.
 *
 * Returns null when the block is not a valid table.
 */
function parseMarkdownTable(lines: string[]): { headers: string[]; rows: string[][] } | null {
  if (lines.length < 3) return null

  // Separator line: cells contain only dashes, colons, and spaces.
  const sepRe = /^\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*\|?$/
  // A pipe-delimited row: must contain at least one |
  const rowRe = /\|/

  // Find the separator line index (must be index 1 in this block)
  if (!sepRe.test(lines[1].trim())) return null
  // Double-check: the header row must also look like a table row
  if (!rowRe.test(lines[0])) return null
  // Must have at least one data row
  if (lines.length < 3 || !rowRe.test(lines[2])) return null

  const splitRow = (line: string): string[] =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(c => c.trim())

  const headers = splitRow(lines[0])
  const rows: string[][] = []
  for (let i = 2; i < lines.length; i++) {
    if (!rowRe.test(lines[i])) break
    rows.push(splitRow(lines[i]))
  }

  if (rows.length === 0) return null
  return { headers, rows }
}

/**
 * Render a parsed markdown table as Telegram-compatible HTML.
 *
 * Branch rules:
 *   - ≤3 columns AND ≤6 rows → bullet list:
 *       Each row is one bullet. First column in <b>; subsequent columns
 *       appended as " — value".
 *   - otherwise → <pre> block with padded columns.
 */
function renderTable(headers: string[], rows: string[][]): string {
  const colCount = headers.length
  const rowCount = rows.length

  if (colCount <= 3 && rowCount <= 6) {
    // Bullet list rendering
    const bullets = rows.map(row => {
      // Normalise row length to match header count (guard empty cells)
      const cells = headers.map((_, i) => (row[i] ?? '').trim())
      const key = escapeHtml(cells[0] || '—')
      const rest = cells
        .slice(1)
        .filter(v => v !== '')
        .map(v => ` — ${escapeHtml(v)}`)
        .join('')
      return `• <b>${key}</b>${rest}`
    })
    // Prepend header names as a label line when there are 2+ columns
    const headerLine =
      colCount >= 2
        ? `<b>${headers.map(h => escapeHtml(h)).join(' / ')}</b>\n`
        : ''
    return headerLine + bullets.join('\n')
  }

  // Pre-block with padded columns
  // Compute column widths across headers + all rows
  const allRows = [headers, ...rows]
  const widths = headers.map((_, ci) =>
    Math.max(...allRows.map(r => (r[ci] ?? '').length))
  )
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))

  const formatRow = (r: string[]) =>
    headers.map((_, ci) => pad(r[ci] ?? '', widths[ci])).join('  ')

  const sepLine = widths.map(w => '-'.repeat(w)).join('  ')

  const lines = [
    formatRow(headers),
    sepLine,
    ...rows.map(r => formatRow(r)),
  ]
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`
}

/**
 * Replace markdown table blocks in `text` with rendered HTML, storing the
 * rendered output in `store` and emitting `placeholderPrefix<n>\x00` tokens
 * so the rest of the pipeline does not re-process them.
 *
 * Tables are identified by their separator line (`| --- |`) which prevents
 * plain prose containing a pipe (e.g. `echo foo | bar`) from being mistaken
 * for a table. Fenced code blocks are extracted before this runs, so
 * table-looking rows inside ``` blocks are already protected.
 */
function extractMarkdownTables(
  text: string,
  store: string[],
  placeholderPrefix: string,
): string {
  const inputLines = text.split('\n')
  const outputLines: string[] = []
  let i = 0

  while (i < inputLines.length) {
    const line = inputLines[i]
    if (!line.includes('|')) {
      outputLines.push(line)
      i++
      continue
    }

    // Collect a run of pipe-containing lines as a candidate block
    let j = i
    while (j < inputLines.length && inputLines[j].includes('|')) {
      j++
    }
    const block = inputLines.slice(i, j)

    const parsed = parseMarkdownTable(block)
    if (parsed) {
      const tableLineCount = 2 + parsed.rows.length
      const remainder = block.slice(tableLineCount)
      const idx = store.length
      store.push(renderTable(parsed.headers, parsed.rows))
      outputLines.push(`${placeholderPrefix}${idx}\x00`)
      for (const r of remainder) outputLines.push(r)
      i = j
    } else {
      for (const b of block) outputLines.push(b)
      i = j
    }
  }

  return outputLines.join('\n')
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

  // Tables are extracted after code blocks so that table-looking rows inside
  // fenced code blocks are already parked in codeBlocks placeholders and
  // won't be touched. Rendered table HTML is stored alongside codeBlocks and
  // uses the same placeholder so restoration happens in a single pass.
  const TABLE_PH = '\x00TABLEBLOCK'

  // Code blocks: ```lang\ncode\n```
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''))
    const cls = lang ? ` class="language-${lang}"` : ''
    const idx = codeBlocks.length
    codeBlocks.push(`<pre><code${cls}>${escaped}</code></pre>`)
    return `${BLOCK_PH}${idx}\x00`
  })

  // Extract markdown tables after fenced code blocks are parked. Rendered
  // HTML is stored in codeBlocks (shared store); TABLE_PH is a distinct
  // prefix so the two restore regexes below can target each independently.
  result = extractMarkdownTables(result, codeBlocks, TABLE_PH)

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

  // Restore code-block and table-block placeholders (entity-escaped, fix them)
  result = result.replace(new RegExp(`${escapeHtml(BLOCK_PH)}(\\d+)${escapeHtml('\x00')}`, 'g'), (_m, idx) => codeBlocks[Number(idx)])
  result = result.replace(new RegExp(`${escapeHtml(TABLE_PH)}(\\d+)${escapeHtml('\x00')}`, 'g'), (_m, idx) => codeBlocks[Number(idx)])
  result = result.replace(new RegExp(`${escapeHtml(INLINE_PH)}(\\d+)${escapeHtml('\x00')}`, 'g'), (_m, idx) => inlineCodes[Number(idx)])

  // Bold: **text** (must come before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // Italic: *text* (single asterisk, not preceded by another *)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')

  // Italic: _text_ (underscore form). Lookarounds guard snake_case,
  // __double__, and word-internal underscores. Emoji codepoints are not
  // \w, so emoji-leading/trailing italics like `_📥 queued_` work correctly.
  result = result.replace(/(?<![\w_])_(?!_)([^_\n]+?)_(?![\w_])/g, '<i>$1</i>')

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links: [text](url). Two safety requirements here:
  //
  //  1. URL scheme allowlist. Unrestricted href accepts `javascript:` and
  //     `data:` URIs; Telegram historically renders tg:// links directly
  //     (opening another bot) which is a phishing primitive. Anything not
  //     in the allowlist falls back to `#`.
  //
  //  2. Escape the URL before interpolating into the attribute. The HTML
  //     tag extraction above parks whitelisted tags in \x00HTMLTAG<n>\x00
  //     placeholders that get restored AFTER this replace. Without escaping
  //     the href value, an adversarial `[text](x"></a><a href="evil">)` in
  //     model output produces two <a> tags after placeholder restoration —
  //     the second hijacks the visible link target. escapeAttr covers both
  //     the placeholder-restoration attack and plain `"` breakout.
  const ALLOWED_LINK_SCHEMES = /^(?:https?|mailto|tel|tg):/i
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText: string, url: string) => {
    const safe = ALLOWED_LINK_SCHEMES.test(url.trim()) ? url.trim() : '#'
    return `<a href="${escapeHtml(safe)}">${linkText}</a>`
  })

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
  // Also escape `"` so callers that interpolate into HTML attribute values
  // don't need a second helper. Safe for tag-content use too.
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Output sanitizer — enforces fleet-wide Telegram formatting invariants
// ---------------------------------------------------------------------------

/**
 * Normalize outbound Telegram HTML text against well-known invariants.
 *
 * Runs AFTER markdownToHtml, just before the text is sent to the Bot API.
 * Conservative by design: only rewrites things that are universally wrong;
 * leaves semantic decisions (where to bold, link choice, list-vs-prose) to
 * the agent.
 *
 * Rules applied (in order):
 *  1. Strip markdown heading markers (`## Foo` → `<b>Foo</b>\n\n`).
 *     Headings that survived the markdown→HTML pass (e.g. when the input
 *     was already HTML and passed through isLikelyTelegramHtml) would render
 *     as ugly `## Foo` plain text. Convert to bold + blank line.
 *  2. Flatten nested bullet indentation: `\n  - sub` → `\n· sub`.
 *  3. Collapse 3+ consecutive blank lines to exactly 2.
 *  4. Strip trailing whitespace on each line.
 *  5. Ensure `<` `>` `&` inside `<code>` and `<pre>` blocks are
 *     HTML-escaped (idempotent: won't double-escape existing `&amp;` etc.).
 *
 * The function is idempotent: sanitize(sanitize(x)) === sanitize(x).
 * Content inside `<code>` / `<pre>` blocks is excluded from rules 1–4.
 */
export function sanitizeForTelegram(text: string): string {
  // ── Phase 1: extract <code> and <pre> blocks so rules 1-4 don't touch them.
  //
  // We capture the full tag with its content so we can round-trip correctly.
  // Placeholders are non-printing control sequences that cannot appear in
  // normal text.
  const CODE_PH = '\x00SANCODE'
  const PRE_PH = '\x00SANPRE'
  const codeSegments: string[] = []
  const preSegments: string[] = []

  // Extract <pre>...</pre> blocks first (they may contain <code> inside).
  let result = text.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const idx = preSegments.length
    // Rule 5: escape unescaped < > & inside pre blocks.
    preSegments.push(`<pre>${escapeUnescapedEntities(inner)}</pre>`)
    return `${PRE_PH}${idx}\x00`
  })

  // Extract standalone <code>...</code> blocks (not nested inside <pre>).
  result = result.replace(/<code([^>]*)>([\s\S]*?)<\/code>/gi, (_m, attrs: string, inner: string) => {
    const idx = codeSegments.length
    // Rule 5: escape unescaped < > & inside code spans.
    codeSegments.push(`<code${attrs}>${escapeUnescapedEntities(inner)}</code>`)
    return `${CODE_PH}${idx}\x00`
  })

  // ── Phase 2: apply text-level rules to the remaining (non-code) content.

  // Rule 1: strip markdown heading markers that survived markdown→HTML pass.
  // Matches lines starting with one or more `#` followed by a space.
  // Preserves the heading text as bold + trailing blank line.
  result = result.replace(/^(#{1,6}) +(.+?)\s*$/gm, (_m, _hashes, title: string) => {
    return `<b>${title}</b>\n`
  })

  // Rule 2: flatten nested bullet indentation.
  // Matches lines with a tab OR 2+ spaces at the start followed by - or *.
  // A single tab is treated as sufficient indentation (standard 4-space equiv).
  // Converts to a middle-dot bullet so the sub-detail survives as readable text.
  result = result.replace(/^(?:\t+[ \t]*|[ \t]{2,})[*-] /gm, '· ')

  // Rule 4: strip trailing whitespace on each line.
  result = result.replace(/[ \t]+$/gm, '')

  // Rule 3: collapse 3+ consecutive blank lines to exactly 2.
  // A "blank line" is a line that contains only optional whitespace (already
  // stripped above, but let's be safe).
  result = result.replace(/(\n[ \t]*){3,}/g, '\n\n')

  // ── Phase 3: restore placeholders.
  result = result.replace(new RegExp(`${CODE_PH}(\\d+)\x00`, 'g'), (_m, idx) => codeSegments[Number(idx)])
  result = result.replace(new RegExp(`${PRE_PH}(\\d+)\x00`, 'g'), (_m, idx) => preSegments[Number(idx)])

  return result
}

/**
 * Escape `<`, `>`, and `&` characters that are NOT already part of an HTML
 * entity or tag. Used inside `<code>` and `<pre>` content to correct
 * unescaped characters without double-escaping existing `&amp;`, `&lt;`, etc.
 *
 * Strategy: we walk the string and escape `&` only when it is not the start
 * of a valid entity (`&name;` or `&#digits;` or `&#xhex;`). We always escape
 * bare `<` and `>` because they cannot appear literally inside code content
 * that is correct Telegram HTML.
 */
function escapeUnescapedEntities(inner: string): string {
  // Escape bare & first: replace & that is NOT followed by a valid entity
  // pattern. A valid entity is: &[a-zA-Z][a-zA-Z0-9]*; or &#[0-9]+; or &#x[0-9a-fA-F]+;
  let out = inner.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);)/g, '&amp;')
  // Escape bare < and > (they should never appear literally in code content)
  out = out.replace(/</g, '&lt;')
  out = out.replace(/>/g, '&gt;')
  return out
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
