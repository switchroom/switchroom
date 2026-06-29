/**
 * Telegram rich-message formatting helpers.
 *
 * Since the Bot API 10.1 migration (#2669) every outbound message goes
 * through `sendRichMessage` / `editMessageText({ markdown })` with raw GFM
 * markdown. The old markdown→HTML engine, the HTML sanitizer, and the
 * MarkdownV2 escaper are all gone — there is exactly ONE rendering path.
 *
 * What lives here now:
 *   - repairEscapedWhitespace: format-agnostic repair of LLM-side JSON
 *     escape bungles (literal `\n` etc.). Applied to raw text BEFORE it is
 *     handed to the rich-message path.
 *   - escapeMarkdown: escape GFM-special characters in DYNAMIC content
 *     (filenames, user input, ids) so they render literally inside a
 *     hand-built markdown card instead of being interpreted as formatting.
 *   - splitMarkdownChunks: split a long markdown body into <=maxLen chunks
 *     at safe boundaries (never mid code-fence, never mid table row),
 *     defaulting maxLen to the rich-message cap of 32768.
 *   - RICH_MESSAGE_MAX_CHARS: the rich-text wire cap (32768).
 */

/**
 * Rich-message wire cap. Bot API 10.1 rich messages allow up to 32768
 * UTF-8 characters (JSDoc-only in @grammyjs/types; no exported constant,
 * so we hard-code it). The legacy plain-text `sendMessage`/`editMessageText`
 * cap of 4096 does NOT apply on the rich path.
 */
export const RICH_MESSAGE_MAX_CHARS = 32768

/**
 * Escape the GFM-markdown special characters so a dynamic value
 * (a filename, an id, arbitrary user text) renders LITERALLY inside a
 * hand-built markdown card instead of being parsed as formatting.
 *
 * Used wherever the old HTML cards called `escapeHtml(value)` while
 * interpolating into `<b>…</b>` / `<code>…</code>`. The markdown
 * equivalent is `**${escapeMarkdown(value)}**` / `` `${value}` `` (code
 * spans don't need escaping — backtick content is literal).
 *
 * Escapes only the characters that trigger INLINE formatting in
 * rich-markdown — backslash, `` ` ``, `*`, `_`, `~`, `=`, `[`, `]`, `|`.
 * Deliberately does NOT escape `.` `-` `+` `#` `(` `)` `{` `}` `!` `>`:
 * those are only meaningful at line-start (headings, lists, quotes) or in
 * link/structure context, and escaping them mid-word (filenames like
 * `foo.ts`, versions like `v1.2-rc`, URLs) would litter the output with
 * visible backslashes. The backslash is escaped first so we never
 * double-escape.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_~=\[\]|])/g, '\\$1')
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
 * Unescape literal `\n`, `\r`, `\t`, and `\"` sequences everywhere EXCEPT
 * inside code spans (inline backtick spans and fenced ``` blocks). Those
 * regions are masked with placeholders before the unescape pass so that a
 * literal `\n` a user typed inside a shell snippet or regex is preserved
 * verbatim. The genuine escaped-backslash sequence `\\n` (which the user
 * intended as a literal backslash + n, not a newline) is handled by
 * protecting `\\` before touching `\n`.
 *
 * This deliberately fires even when the message contains real newlines —
 * the old whole-message heuristic ("bail if any real newline exists") was
 * too broad and prevented repair of mixed messages that had both real
 * newlines and stray literal `\n` escape sequences outside code spans.
 */
export function repairEscapedWhitespace(text: string): string {
  if (!/\\[nrt"\\]/.test(text)) return text

  // Per-call random nonce prevents sentinel collision: if user text happens to
  // contain our placeholder bytes, the restore step would look up an out-of-range
  // index and produce "undefined" in the Telegram output. A nonce that is unique
  // per invocation makes the sentinel statistically impossible to collide with.
  const nonce = Math.random().toString(36).slice(2)
  const CODE_MASK_PH = `\x00RM${nonce}_`
  const BACKSLASH_PH = `\x00BK${nonce}_`

  // Mask fenced code blocks (``` ... ```) and inline code spans (` ... `)
  // so the unescape pass never touches their content.
  //
  // Fenced blocks are extracted first. Only CLOSED fenced blocks (with a
  // matching closing ```) are masked — an unclosed fence is left as-is so the
  // inline-code pass below won't misparse the two leading backticks as an empty
  // inline span and expose the block's interior.
  //
  // Inline code uses `[^\`\n]+` (one or more non-backtick, non-newline chars)
  // matching the same definition the chunker uses, so the masked regions are
  // consistent with what the downstream pipeline treats as code.
  const codeMasks: string[] = []

  const masked = text
    // Closed fenced code blocks only (``` ... ``` with a matching closer).
    .replace(/```[\s\S]*?```/g, (m) => {
      const idx = codeMasks.length
      codeMasks.push(m)
      return `${CODE_MASK_PH}${idx}\x00`
    })
    // Inline code spans: at least one character between backticks, no embedded
    // backtick or newline.
    .replace(/`[^`\n]+`/g, (m) => {
      const idx = codeMasks.length
      codeMasks.push(m)
      return `${CODE_MASK_PH}${idx}\x00`
    })

  // Order matters: protect existing `\\` first so `\\n` stays as a literal
  // backslash + n and doesn't become a newline.
  const unescaped = masked
    .replace(/\\\\/g, BACKSLASH_PH)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(new RegExp(BACKSLASH_PH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '\\')

  // Restore masked code spans verbatim.
  const restoreRe = new RegExp(`${CODE_MASK_PH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\x00`, 'g')
  return unescaped.replace(restoreRe, (_m, idx) => codeMasks[Number(idx)] ?? _m)
}

// ---------------------------------------------------------------------------
// Markdown-aware chunking — never bisects a code fence or a table row
// ---------------------------------------------------------------------------

/**
 * Split a markdown body into chunks that each fit within `maxLen`.
 *
 * The rich-message path is raw GFM markdown, so chunk boundaries must not
 * land inside a fenced code block (``` … ```) or in the middle of a table
 * row — either produces a chunk Telegram renders wrong (an unterminated
 * fence swallows the next chunk's text, a half table row drops cells).
 *
 * Strategy:
 *   1. If the whole body fits, return it as one chunk.
 *   2. Otherwise pick the largest safe cut <= maxLen, preferring a blank
 *      line, then a single newline, then a space. The cut is then nudged
 *      so it never falls inside an open fenced block or inside a line that
 *      is part of a table (a line containing `|`).
 *   3. An unsplittable region (a single code fence longer than maxLen) is
 *      emitted whole rather than spun on forever — Telegram will reject an
 *      oversized message, which is a louder, debuggable failure than an
 *      infinite loop.
 */
export function splitMarkdownChunks(text: string, maxLen = RICH_MESSAGE_MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let rest = text

  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest)
      break
    }

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

    // Back off so the cut doesn't fall inside an open ``` fence.
    cut = backOffOpenFence(rest, cut)
    // Back off so the cut doesn't bisect a table row (a line with `|`).
    cut = backOffTableRow(rest, cut)

    if (cut <= 0) {
      // Could not find a safe boundary below maxLen — the region is one
      // indivisible block (e.g. a single huge fenced block). Emit the
      // whole remainder rather than loop forever.
      chunks.push(rest)
      break
    }

    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }

  return chunks
}

/**
 * Count fenced-code delimiters (``` at line start) up to `cut`. If the
 * count is odd, the cut lands inside an open fence — retreat to just before
 * the opening fence so the boundary sits between complete blocks.
 */
function backOffOpenFence(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut
  const before = text.slice(0, cut)
  const fences = before.match(/^```/gm)
  if (fences == null || fences.length % 2 === 0) return cut
  // Odd number of fences → inside an open block. Find the opening fence and
  // cut just before it (so the whole fenced block goes to the next chunk).
  const lastFence = before.lastIndexOf('\n```')
  if (lastFence <= 0) {
    // Fence opens at the very start of `before` — can't retreat past it.
    return 0
  }
  return lastFence
}

/**
 * If the cut lands on a line that contains a `|` (a markdown table row),
 * retreat to the start of that line so we never emit a half table row.
 */
function backOffTableRow(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut
  const lineStart = text.lastIndexOf('\n', cut - 1) + 1
  const nextNl = text.indexOf('\n', cut)
  const lineEnd = nextNl === -1 ? text.length : nextNl
  const line = text.slice(lineStart, lineEnd)
  if (line.includes('|')) {
    // Cut at the line start so the whole row moves to the next chunk.
    return lineStart > 0 ? lineStart - 1 : 0
  }
  return cut
}
