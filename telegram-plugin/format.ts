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
 *   - normalizeParagraphBreaks: promote a LONE prose `\n` into a GFM hard
 *     break (`  \n`) so paragraph separation survives the rich GFM path,
 *     while leaving lists / tables / code / `\n\n` untouched.
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
  const BACKSLASH_PH = `\x00BK${nonce}_`

  // Mask fenced code blocks and inline code spans so the unescape pass never
  // touches their content (shared masker — see maskCodeRegions for the exact
  // closed-fence / inline-span definitions).
  const { masked, restore } = maskCodeRegions(text, nonce)

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
  return restore(unescaped)
}

// ---------------------------------------------------------------------------
// Shared code-region masking (used by repairEscapedWhitespace AND
// normalizeParagraphBreaks). Closed fenced blocks (``` … ```) and inline
// code spans (` … `) are replaced with unique placeholders so neither pass
// ever rewrites their interior; `restore` puts them back verbatim.
// ---------------------------------------------------------------------------

interface MaskedCode {
  masked: string
  restore: (s: string) => string
  /** The placeholder prefix injected for each masked region (fence or span). */
  placeholder: string
}

/**
 * Mask fenced code blocks and inline code spans with collision-resistant
 * placeholders. `nonce` is a per-call random string the caller already holds
 * (so two maskers in one function share one nonce namespace cleanly).
 *
 * Fenced blocks are extracted FIRST and only when CLOSED (matching ```), so an
 * unclosed fence is left intact rather than misparsed by the inline pass. Inline
 * spans use `[^\`\n]+` — the same definition the chunker treats as code.
 */
function maskCodeRegions(text: string, nonce: string): MaskedCode {
  const CODE_MASK_PH = `\x00RM${nonce}_`
  const codeMasks: string[] = []

  const masked = text
    .replace(/```[\s\S]*?```/g, (m) => {
      const idx = codeMasks.length
      codeMasks.push(m)
      return `${CODE_MASK_PH}${idx}\x00`
    })
    .replace(/`[^`\n]+`/g, (m) => {
      const idx = codeMasks.length
      codeMasks.push(m)
      return `${CODE_MASK_PH}${idx}\x00`
    })

  const restoreRe = new RegExp(
    `${CODE_MASK_PH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\x00`,
    'g',
  )
  const restore = (s: string): string =>
    s.replace(restoreRe, (_m, idx) => codeMasks[Number(idx)] ?? _m)

  return { masked, restore, placeholder: CODE_MASK_PH }
}

// ---------------------------------------------------------------------------
// Paragraph-break normalizer — make lone prose newlines survive the GFM path
// ---------------------------------------------------------------------------

/**
 * GFM (the rich-message render path) treats a LONE `\n` as a *soft* break: the
 * two lines collapse onto the same visual line, so a model that separates its
 * paragraphs with a single newline produces a cramped wall of text. The old
 * markdown→HTML path rendered every `\n` as a hard break, which masked the
 * habit; the rich path no longer does.
 *
 * This normalizer fixes that DETERMINISTICALLY without breaking GFM block
 * syntax. It does exactly two things, on code-masked text:
 *
 *   1. Collapse runs of 3+ newlines down to exactly `\n\n` (never collapse a
 *      genuine `\n\n` paragraph gap).
 *   2. Promote a LONE `\n` (one not adjacent to another `\n`) into a GFM hard
 *      break (`  \n`, two trailing spaces) — but ONLY when it is a genuine
 *      prose paragraph break.
 *
 * The promotion heuristic is deliberately CONSERVATIVE — it prefers a false
 * negative (leaving a break un-promoted, so two prose lines stay cramped) over
 * a false positive (double-spacing a tight list or table). A break is promoted
 * only when ALL of these hold:
 *
 *   - The preceding line ends in sentence-terminal punctuation: `.`, `!`, `?`,
 *     `:`, or a closing `)` / `"` / `'` / `’` / `”` that itself follows such a
 *     terminator (e.g. `...done.")`).
 *   - The preceding line is NOT itself a marker line (list / table / quote /
 *     heading).
 *   - The NEXT line starts with a non-marker character: not a list bullet
 *     (`-`/`*`/`+`/`\d+.`/`\d+)`, incl. indented), not a table row (`|` or
 *     ` | `), not a blockquote (`>`), not a heading (`#`), not blank.
 *
 * Code fences and inline code are masked out before any of this runs, so their
 * interior `\n`s are never touched.
 */
export function normalizeParagraphBreaks(text: string): string {
  if (!text.includes('\n')) return text

  const nonce = Math.random().toString(36).slice(2)
  const { masked, restore, placeholder } = maskCodeRegions(text, nonce)

  // Step 1: collapse 3+ newlines to exactly two. This also normalizes runs that
  // contain interleaved spaces only between the newlines is NOT done here —
  // we only touch pure newline runs so we never eat meaningful whitespace.
  let out = masked.replace(/\n{3,}/g, '\n\n')

  // Step 2: walk lines and promote lone prose breaks. We rebuild the string by
  // joining lines with the right separator. A separator is "hard" (`  \n`) only
  // when the break between this line and the next is a genuine prose paragraph
  // break per the heuristic; otherwise it stays a plain `\n`. Blank lines (the
  // `\n\n` gaps) are preserved as empty entries in the split, so we never
  // promote a break that is adjacent to a blank line.
  const lines = out.split('\n')
  const pieces: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const isLast = i === lines.length - 1
    const next = isLast ? '' : lines[i + 1]
    // A blank current or next line means this is part of a `\n\n` gap — leave
    // the separator as a plain newline (the blank entry reconstructs the gap).
    const promote =
      !isLast &&
      line.trim() !== '' &&
      next.trim() !== '' &&
      shouldPromoteBreak(line, next, placeholder)
    if (promote) {
      // Strip any trailing whitespace the line already carried so we emit
      // exactly one `  \n` hard break (never accumulate spaces on a re-run).
      // Include `\r` so a CRLF source ("Alpha.\r\nBravo.") doesn't strand a
      // lone carriage return before the injected `  \n`.
      line = line.replace(/[ \t\r]+$/, '')
    }
    pieces.push(line)
    if (isLast) break
    pieces.push(promote ? '  \n' : '\n')
  }
  out = pieces.join('')

  return restore(out)
}

/** Lines that introduce GFM block structure — never reflow around these. */
function isMarkerLine(line: string, placeholder?: string): boolean {
  // CommonMark indented code block: 4+ leading spaces then a non-space char.
  // Checked on the RAW (pre-trim) line — trimming would erase the very indent
  // that makes it a code block, so we must look before `trimStart()`.
  if (/^ {4,}\S/.test(line)) return true
  const t = line.trimStart()
  // A line that begins with the code-mask placeholder is a standalone masked
  // fenced block — treat it as a block marker so we never inject a hard break
  // immediately before/after a code block. (An INLINE code span sits mid-line,
  // so the line won't START with the placeholder and ordinary prose rules apply.)
  if (placeholder != null && placeholder.length > 0 && t.startsWith(placeholder)) return true
  return (
    // Unordered list bullet: -, *, + followed by a space.
    /^[-*+]\s/.test(t) ||
    // Ordered list: `1.` or `1)` followed by a space.
    /^\d+[.)]\s/.test(t) ||
    // Blockquote / pull-quote.
    t.startsWith('>') ||
    // ATX heading.
    /^#{1,6}\s/.test(t) ||
    // Table row (leading pipe) or table-ish line (interior ` | `).
    t.startsWith('|') ||
    line.includes(' | ') ||
    // Fenced code delimiter (defensive — fences are masked, but a lone/odd
    // fence line can survive masking).
    t.startsWith('```') ||
    // Thematic break / divider.
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(t)
  )
}

/**
 * Decide whether the lone `\n` between `prev` and `next` is a genuine prose
 * paragraph break worth promoting to a GFM hard break. Conservative by design
 * (see normalizeParagraphBreaks doc) — returns false on any doubt.
 */
function shouldPromoteBreak(prev: string, next: string, placeholder?: string): boolean {
  if (isMarkerLine(prev, placeholder) || isMarkerLine(next, placeholder)) return false
  // Next line must begin with ordinary prose, not a structural marker char.
  const nextTrimmed = next.trimStart()
  if (nextTrimmed.length === 0) return false
  // The preceding line must read as a finished sentence/clause: it ends in a
  // sentence-terminal punctuation mark, optionally wrapped by a closing quote
  // or paren that itself follows such a terminator.
  const prevTrimmed = prev.trimEnd()
  // Strip up to one trailing closing-bracket/quote run to look at the real
  // terminator (e.g. `He said "go."` or `(done.)`).
  const unwrapped = prevTrimmed.replace(/[)"'’”\]]+$/, '')
  const terminator = unwrapped.slice(-1)
  return terminator === '.' || terminator === '!' || terminator === '?' || terminator === ':'
}

/**
 * Last-resort hard slicer for a body that `splitMarkdownChunks` could not break
 * (a single indivisible region larger than the cap — e.g. a giant fenced block
 * with no interior boundary). Cuts on raw character count so every emitted
 * piece is guaranteed `<= cap`, accepting that a cut MAY land inside a fence
 * (which Telegram renders imperfectly) — a degraded-but-delivered message beats
 * a hard `RICH_MESSAGE_TEXT_TOO_LONG` reject that drops the answer entirely.
 *
 * Returns the input as a single-element array when it already fits.
 */
export function hardSliceToCap(text: string, cap = RICH_MESSAGE_MAX_CHARS): string[] {
  if (cap <= 0) return [text]
  if (text.length <= cap) return [text]
  const out: string[] = []
  for (let i = 0; i < text.length; i += cap) {
    out.push(text.slice(i, i + cap))
  }
  return out
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
