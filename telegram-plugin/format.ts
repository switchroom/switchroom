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
/**
 * Split a collapsed inline bullet list onto separate lines.
 *
 * Agents sometimes emit an entire bullet list on ONE line using interior
 * `•`/`·` separators, e.g.:
 *
 *   • Master Bath 1, clean • <b>Master Bath 2</b>, 33% loss • Cabinet, clean
 *
 * which renders as a single run-on line instead of stacked bullets (the GFM
 * rich path treats `•`/`·` as ordinary text, not list syntax, so nothing
 * stacks). This deterministically inserts a newline before each interior
 * unicode-bullet separator so each bullet lands on its own line.
 *
 * Conservative by construction:
 *  - Only a line that STARTS (after optional leading whitespace) with a bullet
 *    marker (`•`, `·`, `-`, or `*` followed by a space) is eligible — prose
 *    with a mid-sentence `•` is left untouched.
 *  - Only the unicode bullets `•`/`·` are split on (an interior whitespace +
 *    `•`/`·` + whitespace). `-`/`*` are NEVER used as interior split points —
 *    too many false positives (hyphens, ranges, "a * b" multiplication).
 *    They are only accepted as the LEADING marker.
 *  - The bullet glyphs are left as-is; we only insert `\n` before each split
 *    bullet and normalize the inter-bullet whitespace to a single space.
 *  - Idempotent: once split, each bullet begins its own line, so the
 *    interior-separator pattern (whitespace + bullet + whitespace) no longer
 *    matches anywhere on those lines.
 *
 * Runs on already-code-masked text, so a `•` inside a code span/fence is safe.
 */
export function splitCollapsedInlineBullets(text: string): string {
  if (!/[•·]/.test(text)) return text
  // Leading marker: optional indent, then • · - or * followed by a space.
  // Interior separator to split on: whitespace + • or · + whitespace.
  const interiorSep = /[ \t]+([•·])[ \t]+/g
  return text
    .split('\n')
    .map((line) => {
      if (!/^[ \t]*[•·*-] /.test(line)) return line
      if (!/[ \t][•·][ \t]/.test(line)) return line
      return line.replace(interiorSep, '\n$1 ')
    })
    .join('\n')
}

export function normalizeParagraphBreaks(text: string): string {
  // A text with no newline still needs the inline-bullet split (a collapsed
  // bullet list is a SINGLE line). Only bail early when there is neither a
  // newline nor a unicode bullet to potentially split.
  if (!text.includes('\n') && !/[•·]/.test(text)) return text

  const nonce = Math.random().toString(36).slice(2)
  const { masked: maskedRaw, restore, placeholder } = maskCodeRegions(text, nonce)

  // Step 0: split a collapsed inline bullet list onto separate lines. Done on
  // the code-masked text so a `•` inside a fenced block or inline code span is
  // never touched. See splitCollapsedInlineBullets for the exact rule.
  const masked = splitCollapsedInlineBullets(maskedRaw)

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

  // Step 3: guarantee a blank line (`\n\n`) at BLOCK BOUNDARIES. The
  // prose-promotion above keeps lists/tables tight by leaving their single
  // `\n` separators alone — but GFM's rich renderer needs a blank line to
  // START a new block, so a block that is glued to the previous line by a
  // single `\n` fails to render (a table prints as literal pipe text, prose
  // after a list is absorbed as a lazy list continuation). This pass inserts
  // the missing blank line at those transitions only, on the same masked text,
  // never touching code interiors, never collapsing/expanding existing `\n\n`,
  // and never splitting a table's header/delimiter/body rows apart.
  out = ensureBlockBoundaries(out, placeholder)

  return restore(out)
}

// ---------------------------------------------------------------------------
// Paragraph spacers — restore a VISIBLE blank line between prose paragraphs
// ---------------------------------------------------------------------------

/**
 * The non-collapsible spacer paragraph injected between two prose paragraphs.
 *
 * Telegram's Bot API 10.1 rich-message renderer (the GFM/CommonMark engine
 * behind `sendRichMessage` / `editMessageText({ markdown })`) renders a `\n\n`
 * paragraph break TIGHT — the two paragraphs sit on adjacent lines with no
 * visible empty line between them. The legacy markdown→HTML path (removed in
 * #2669) sent `\n\n` literally with `parse_mode:"HTML"`, where two newlines
 * render as a real blank line. That regression is the operator-confirmed
 * "paragraphs jammed together" symptom.
 *
 * CommonMark discards blank lines made of ASCII whitespace, but a line whose
 * only content is a NON-breaking space (U+00A0) is a genuine, non-empty
 * paragraph — it renders as a visible empty line. So `A\n\n \n\nB`
 * renders as three paragraphs: A, a blank-looking line, then B — the visible
 * gap the HTML path used to produce.
 */
export const PARAGRAPH_SPACER = ' '

/**
 * Insert a visible blank-line spacer into each genuine `\n\n` paragraph gap so
 * the rich GFM renderer shows a real empty line between paragraphs (matching
 * the pre-#2669 HTML behaviour). See PARAGRAPH_SPACER for why a U+00A0 line is
 * the reliable trick.
 *
 * Conservative by construction — a spacer is inserted into a `\n\n` gap ONLY
 * when BOTH the block ENDING above the gap and the block STARTING below it are
 * ordinary prose. A gap adjacent to a structural block (list item, table row,
 * fenced code, blockquote, heading, indented code) is left exactly as it was:
 * those blocks already carry their own vertical rhythm, and a spacer paragraph
 * wedged against a tight list / table would either re-introduce the cramped
 * look from the other side or break the block's contiguity.
 *
 * Runs on code-masked text (so a blank line inside a fenced block is never
 * touched) and is idempotent — a gap that already contains a U+00A0 spacer
 * paragraph is recognised and never doubled.
 *
 * Intended to run in the outbound send path AFTER normalizeParagraphBreaks,
 * which has already collapsed 3+ newline runs to `\n\n`, promoted lone prose
 * breaks, and guaranteed block-boundary blank lines. normalizeParagraphBreaks
 * itself deliberately does NOT do this so its (well-tested) `\n\n`-preserving
 * contract is unchanged.
 */
export function addParagraphSpacers(text: string): string {
  if (!text.includes('\n\n')) return text

  const nonce = Math.random().toString(36).slice(2)
  const { masked, restore, placeholder } = maskCodeRegions(text, nonce)

  if (!masked.includes('\n\n')) return restore(masked)

  // The line we inject for a spacer paragraph (its only content is U+00A0).
  const spacerLine = PARAGRAPH_SPACER

  // CRITICAL: `String.prototype.trim()` strips U+00A0, so a spacer line would
  // read as "blank" and the pass would lose idempotency (re-spacing an
  // already-spaced gap). Detect blank-ness with an ASCII-whitespace-only test
  // so the U+00A0 spacer line is correctly seen as NON-blank.
  const isBlankLine = (line: string): boolean => /^[ \t\r\f\v]*$/.test(line)
  // Trim ASCII-only (preserve U+00A0) so the spacer line is recognisable.
  const asciiTrim = (line: string): string => line.replace(/^[ \t\r\f\v]+|[ \t\r\f\v]+$/g, '')

  // A line is "prose" for spacing purposes when it is non-blank, not a
  // structural block marker, not the spacer line itself. Only a gap with prose
  // on BOTH sides earns a visible spacer.
  const isProseLine = (line: string): boolean => {
    if (isBlankLine(line)) return false
    if (asciiTrim(line) === spacerLine) return false
    if (isMarkerLine(line, placeholder)) return false
    // A standalone masked fenced block line is structural.
    if (isFenceOpenLine(line, placeholder)) return false
    return true
  }

  // Split into blank-line-delimited segments, then re-join inserting a spacer
  // paragraph between two adjacent NON-blank segments whose facing lines are
  // both prose and which are not already separated by a spacer.
  // A `\n\n` paragraph gap is a SINGLE blank entry between two content lines
  // (`"A\n\nB".split('\n')` → `["A", "", "B"]`). normalizeParagraphBreaks has
  // already collapsed 3+ newline runs to exactly `\n\n`, so we only ever see a
  // one-blank gap here; a multi-blank run is handled defensively the same way
  // (the FIRST blank of the run carries the spacer decision).
  const lines = masked.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isBlank = isBlankLine(line)
    // The spacer decision is made at the FIRST blank of a gap, i.e. when the
    // previously emitted line is non-blank prose. Inject the spacer BEFORE the
    // blank so the result is `above \n\n   \n\n below`.
    if (isBlank) {
      const prevEmitted = out.length > 0 ? out[out.length - 1] : null
      const prevIsBlank = prevEmitted != null && isBlankLine(prevEmitted)
      if (!prevIsBlank) {
        const above = lastNonBlank(out, isBlankLine)
        const below = nextNonBlank(lines, i + 1, isBlankLine)
        const alreadySpaced =
          (above != null && asciiTrim(above) === spacerLine) ||
          (below != null && asciiTrim(below) === spacerLine)
        if (
          !alreadySpaced &&
          above != null &&
          below != null &&
          isProseLine(above) &&
          isProseLine(below)
        ) {
          // Emit: blank, spacer paragraph, blank — a U+00A0 paragraph wedged
          // between two real blank lines so CommonMark renders it as a visible
          // empty line between the two prose paragraphs.
          out.push('')
          out.push(spacerLine)
          out.push('')
          continue
        }
      }
    }
    out.push(line)
  }

  return restore(out.join('\n'))
}

/**
 * Last non-blank entry already emitted into `arr`, or null. `isBlank` is the
 * caller's blank test (ASCII-only, so a U+00A0 spacer line counts as
 * non-blank — `String.trim()` would wrongly strip it).
 */
function lastNonBlank(arr: string[], isBlank: (s: string) => boolean): string | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!isBlank(arr[i])) return arr[i]
  }
  return null
}

/** First non-blank line at or after index `from` in `lines`, or null. */
function nextNonBlank(
  lines: string[],
  from: number,
  isBlank: (s: string) => boolean,
): string | null {
  for (let i = from; i < lines.length; i++) {
    if (!isBlank(lines[i])) return lines[i]
  }
  return null
}

// ---------------------------------------------------------------------------
// Block-boundary blank-line guarantee (Step 3 of normalizeParagraphBreaks)
// ---------------------------------------------------------------------------

/** A line that begins a GFM list item (bullet or ordered), incl. leading indent. */
function isListItemLine(line: string): boolean {
  const t = line.trimStart()
  return /^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t)
}

/** A GFM table body/header row: a line whose first non-space char is `|`. */
function isTableRowLine(line: string): boolean {
  return /^\s*\|/.test(line)
}

/**
 * A GFM table delimiter row: optional leading pipe, then one or more
 * `:?-{1,}:?` cells separated by pipes (e.g. `|---|---|`, `---|:--:`,
 * `| :-- | --: |`). This is what turns the line ABOVE it into a table header.
 */
function isTableDelimiterLine(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line)
}

/** A fenced-code OPEN line — either a literal ``` fence or a masked block. */
function isFenceOpenLine(line: string, placeholder?: string): boolean {
  const t = line.trimStart()
  if (placeholder != null && placeholder.length > 0 && t.startsWith(placeholder)) return true
  return t.startsWith('```')
}

/** A blockquote line. */
function isBlockquoteLine(line: string): boolean {
  return line.trimStart().startsWith('>')
}

/** An ATX heading line. */
function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s/.test(line.trimStart())
}

/**
 * Insert a blank line at block boundaries that are currently separated by
 * exactly one `\n`. Operates line-by-line on already-code-masked text.
 *
 * A blank line is guaranteed:
 *   - BEFORE the first row of a GFM table (a `|`-leading line that is itself a
 *     delimiter row, OR a `|`-containing header line immediately followed by a
 *     delimiter row) when the previous emitted line is non-blank and not part
 *     of a table — never between a table's own header/delimiter/body rows.
 *   - BEFORE a fenced-code open, a blockquote, or an ATX heading when the
 *     previous line is non-blank and of a DIFFERENT block type.
 *   - AFTER a list block: when a list-item line is followed by a non-blank
 *     line that is NOT itself a list item and NOT an indented continuation of
 *     the item (4+ leading spaces / a tab), so the prose breaks out of the list.
 *
 * Conservative: prefers a false negative (leave glued) over corrupting a valid
 * block. Existing blank lines (empty entries from a `\n\n` gap) are preserved
 * and short-circuit every rule — we never double up a gap.
 */
function ensureBlockBoundaries(text: string, placeholder?: string): string {
  if (!text.includes('\n')) return text
  const lines = text.split('\n')
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prev = result.length > 0 ? result[result.length - 1] : null
    const prevNonBlank = prev != null && prev.trim() !== ''
    const curBlank = line.trim() === ''

    // ---- Rule A: blank line BEFORE a block that needs one to start ----
    if (prevNonBlank && !curBlank) {
      const next = i + 1 < lines.length ? lines[i + 1] : ''

      // Table first row: either THIS line is a delimiter row (header was the
      // prev line — but only treat as a table start when prev itself isn't
      // already a table row), or THIS line is a `|`-bearing header whose NEXT
      // line is a delimiter. We anchor the blank-line insertion on the HEADER
      // line so header+delimiter+body stay contiguous.
      const prevIsTable = isTableRowLine(prev)
      const startsTableHere =
        !prevIsTable &&
        ((line.includes('|') && isTableDelimiterLine(next)) ||
          (isTableRowLine(line) && isTableDelimiterLine(next)))

      const startsFence = isFenceOpenLine(line, placeholder) && !isFenceOpenLine(prev, placeholder)
      const startsQuote = isBlockquoteLine(line) && !isBlockquoteLine(prev)
      const startsHeading = isHeadingLine(line) && !isHeadingLine(prev)

      if (startsTableHere || startsFence || startsQuote || startsHeading) {
        result.push('')
      }
    }

    // ---- Rule B: blank line AFTER a list block, before breakout prose ----
    if (prevNonBlank && !curBlank && isListItemLine(prev) && !isListItemLine(line)) {
      // A 4+ space (or tab) indent means `line` is a lazy continuation of the
      // list item's paragraph, NOT breakout prose — leave it glued.
      const isIndentedContinuation = /^(\t| {4,})\S/.test(line)
      // A table/fence/quote/heading start is already handled by Rule A above
      // (its blank line was just inserted); avoid inserting a second one.
      const alreadySeparated = result.length > 0 && result[result.length - 1].trim() === ''
      if (!isIndentedContinuation && !alreadySeparated) {
        result.push('')
      }
    }

    result.push(line)
  }

  return result.join('\n')
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

    chunks.push(stripBoundarySpacers(rest.slice(0, cut), 'trailing'))
    rest = stripBoundarySpacers(rest.slice(cut), 'leading')
  }

  return chunks.map((c) => stripBoundarySpacers(c, 'trailing'))
}

/**
 * Strip stray paragraph-spacer / blank lines off a chunk boundary so a cut that
 * lands inside an injected spacer gap (`\n\n${PARAGRAPH_SPACER}\n\n`, see
 * addParagraphSpacers) never leaves a continuation chunk that OPENS with a bare
 * U+00A0 spacer line, nor a prior chunk that ENDS with one.
 *
 * A "boundary blank run" is any sequence of newlines and spacer-only lines (a
 * line whose only content is the U+00A0 spacer, optionally surrounded by ASCII
 * spaces/tabs) in ANY interleaving — `\n \n`, ` \n\n`, `\n\n \n`, etc. The
 * legacy behaviour (strip leading ASCII `\n+` only) is a strict subset, so a
 * boundary with NO spacer is unaffected. Idempotent: a chunk already trimmed
 * has nothing left to strip.
 *
 *  - `'leading'`  → strip the run from the START (the continuation chunk).
 *  - `'trailing'` → strip the run from the END (the just-emitted prior chunk).
 */
function stripBoundarySpacers(chunk: string, side: 'leading' | 'trailing'): string {
  // One blank-or-spacer line: optional ASCII ws, optional one U+00A0, optional
  // ASCII ws — i.e. a line that renders empty. A run of these (joined by \n,
  // with leading/trailing \n) is what we peel off the boundary.
  const sp = PARAGRAPH_SPACER
  if (side === 'leading') {
    // Leading: one-or-more newlines, optionally with spacer-only lines mixed in.
    return chunk.replace(
      new RegExp(`^(?:[ \\t]*${sp}?[ \\t]*\\n+)+`),
      '',
    )
  }
  // Trailing: a newline run, optionally with spacer-only lines, at the very end.
  return chunk.replace(
    new RegExp(`(?:\\n+[ \\t]*${sp}?[ \\t]*)+$`),
    '',
  )
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
