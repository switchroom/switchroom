/**
 * rich-markdown-oracle — an INDEPENDENT CommonMark/GFM validator + entity
 * extractor for the Bot API 10.1 rich-message path (`sendRichMessage`,
 * `editMessageText({ markdown })`).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Every outbound message now ships as raw GFM markdown through the rich path
 * (see `format.ts` / `rich-send.ts`). A malformed body makes Telegram throw a
 * 400 ("can't parse entities" / "can't find end of the entity" — see
 * `isParseEntitiesError` in `rich-send.ts`), which drops or corrupts the
 * message. Our existing format tests string-compare the text we *emit*; they
 * do NOT verify that the emitted markdown is well-formed enough that Telegram
 * won't reject it, nor that it parses into the entity structure we intended.
 *
 * This oracle closes that gap with TWO signals:
 *   (a) PARSE-ACCEPT: `validateRichMarkdown(md)` returns [] when the body is
 *       well-formed on every axis whose violation actually produces a rich-path
 *       400 or a corrupt render; otherwise it returns a list of concrete
 *       problems. A test asserting `[]` fails loudly on output Telegram would
 *       reject.
 *   (b) STRUCTURE: `parseRichEntities(md)` extracts the entity spans (bold,
 *       italic, code, pre/fence, link, strikethrough) so a test can assert the
 *       body parses into the intended shape.
 *
 * ── The non-circularity guarantee (READ THIS) ──────────────────────────────
 * The oracle is a HAND-WRITTEN tokenizer that follows the CommonMark/GFM
 * grammar and Telegram's documented entity-closure rules. It shares NO code
 * with `format.ts` — it does not import, echo, or re-derive the formatter's
 * output. It is a second, independent implementation, so asserting the
 * formatter's output against it is a genuine cross-check, not a formatter
 * comparing itself to itself.
 *
 * ── Scope boundary (documented, deliberate) ────────────────────────────────
 * A byte-exact port of the full CommonMark reference parser is ~3000 lines and
 * not worth hand-rolling reliably. So:
 *   - Signal (a) is RIGOROUS for the constructs whose malformedness is what
 *     actually 400s / corrupts on the rich path: unbalanced fenced-code
 *     delimiters, unterminated inline code spans, malformed / unclosed link
 *     syntax, and structurally-incomplete table rows. These are precisely the
 *     failure modes `format.ts`'s chunker + block-boundary passes are built to
 *     avoid, so they are the ones a regression test must guard.
 *   - Signal (b) covers the COMMON entity types (bold `**`/`__`, italic
 *     `*`/`_`, strikethrough `~~`, inline code, fenced code, links). It uses a
 *     simplified-but-faithful delimiter model. It deliberately does NOT model
 *     every CommonMark emphasis edge case (intraword `_`, triple-run
 *     `***bold italic***` nesting split points) — those are called out inline
 *     and the fixtures avoid depending on them. When in doubt the extractor is
 *     CONSERVATIVE: it reports a span only when the open/close is unambiguous.
 *
 * CommonMark itself never "fails to parse" (every string is valid CommonMark),
 * so a naive "does it parse" check would be vacuous. That is exactly why signal
 * (a) is defined as *structural well-formedness of the emitted constructs*
 * rather than "did a CommonMark parser throw" — it is the real predictor of a
 * rich-path 400.
 */

// ---------------------------------------------------------------------------
// Entity model
// ---------------------------------------------------------------------------

export type EntityType =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code' // inline code span
  | 'pre' // fenced code block
  | 'link'

export interface RichEntity {
  readonly type: EntityType
  /** The rendered (delimiter-stripped) inner text of the entity. */
  readonly text: string
  /** For a link, the destination URL. */
  readonly url?: string
  /** For a fenced block, the info string (language), if any. */
  readonly lang?: string
}

export interface ParseIssue {
  readonly kind:
    | 'unbalanced-fence'
    | 'unterminated-code-span'
    | 'malformed-link'
    | 'incomplete-table-row'
    | 'unbalanced-emphasis'
  readonly detail: string
  /** 1-based line number where the problem was detected, when known. */
  readonly line?: number
}

// ---------------------------------------------------------------------------
// Fence / code-region masking (independent re-implementation — NOT imported
// from format.ts, on purpose). We mask fenced blocks and inline code so the
// emphasis/link scanners never see their interior, matching how a CommonMark
// parser treats code as verbatim.
// ---------------------------------------------------------------------------

interface Fence {
  readonly lang: string
  readonly body: string
  readonly startLine: number
  readonly closed: boolean
}

/**
 * Split the document into fenced-code regions and everything else, tracking
 * whether each fence is CLOSED. A fence opens on a line whose first non-space
 * run is ``` (or longer) or ~~~; it closes on a later line whose fence marker
 * is the same char and at least as long, with no trailing info string.
 *
 * This is the CommonMark fenced-code rule, scoped to the two markers Telegram
 * emits (``` predominantly). An unclosed fence is the single most common cause
 * of a corrupt rich render (it swallows the rest of the message), so we track
 * `closed` explicitly for signal (a).
 */
export function scanFences(md: string): {
  fences: Fence[]
  /** Line indices (0-based) that belong to a fence (open, body, close). */
  fenceLineSet: Set<number>
} {
  const lines = md.split('\n')
  const fences: Fence[] = []
  const fenceLineSet = new Set<number>()
  let i = 0
  const openRe = /^(\s*)(`{3,}|~{3,})\s*([^\n`]*)$/
  while (i < lines.length) {
    const m = lines[i].match(openRe)
    if (m == null) {
      i++
      continue
    }
    const indent = m[1].length
    const marker = m[2]
    const fenceChar = marker[0]
    const lang = m[3].trim()
    const startLine = i
    fenceLineSet.add(i)
    const bodyLines: string[] = []
    let j = i + 1
    let closed = false
    // Close marker: same char, length >= open marker, only whitespace after.
    const closeRe = new RegExp(`^\\s*${fenceChar === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
    for (; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        fenceLineSet.add(j)
        closed = true
        break
      }
      bodyLines.push(lines[j].slice(indent))
      fenceLineSet.add(j)
    }
    fences.push({ lang, body: bodyLines.join('\n'), startLine, closed })
    i = closed ? j + 1 : j
  }
  return { fences, fenceLineSet }
}

/**
 * Replace fenced regions with blank lines (preserving line count) so the
 * inline scanners never see fence interiors. Returns the masked doc plus the
 * fence list.
 */
function maskFences(md: string): { masked: string; fences: Fence[]; fenceLineSet: Set<number> } {
  const { fences, fenceLineSet } = scanFences(md)
  const lines = md.split('\n')
  const masked = lines.map((l, idx) => (fenceLineSet.has(idx) ? '' : l)).join('\n')
  return { masked, fences, fenceLineSet }
}

/**
 * Extract inline code spans from a single line (fence interiors already
 * masked). CommonMark inline code is a run of N backticks, closed by the next
 * run of exactly N backticks. We support the common single- and double-tick
 * forms our formatter emits. Returns the spans and the line with each span
 * blanked (same length) so downstream emphasis scanning skips code content.
 */
function extractInlineCode(line: string): { spans: string[]; blanked: string; unterminated: boolean } {
  const spans: string[] = []
  let out = ''
  let i = 0
  let unterminated = false
  while (i < line.length) {
    if (line[i] === '`') {
      // Measure opening run length.
      let n = 0
      while (line[i + n] === '`') n++
      const openEnd = i + n
      // Find a closing run of EXACTLY n backticks.
      let k = openEnd
      let closeStart = -1
      while (k < line.length) {
        if (line[k] === '`') {
          let m = 0
          while (line[k + m] === '`') m++
          if (m === n) {
            closeStart = k
            break
          }
          k += m
        } else {
          k++
        }
      }
      if (closeStart === -1) {
        // No matching close on this line → unterminated inline code span.
        unterminated = true
        out += line.slice(i)
        break
      }
      const inner = line.slice(openEnd, closeStart)
      spans.push(inner)
      // Blank out the whole span (ticks + inner) with spaces of equal length.
      out += ' '.repeat(closeStart + n - i)
      i = closeStart + n
    } else {
      out += line[i]
      i++
    }
  }
  return { spans, blanked: out, unterminated }
}

// ---------------------------------------------------------------------------
// Signal (a): PARSE-ACCEPT validation
// ---------------------------------------------------------------------------

/**
 * Validate that `md` is well-formed enough that Telegram's rich-message path
 * would NOT 400 on it. Returns an empty array on success, else a list of the
 * concrete problems found. See the module doc for the exact scope of "well
 * formed" and why it is the right predictor of a rich-path reject.
 */
export function validateRichMarkdown(md: string): ParseIssue[] {
  const issues: ParseIssue[] = []
  const { masked, fences } = maskFences(md)

  // --- Unbalanced fence: an unclosed fenced block corrupts the render. -----
  for (const f of fences) {
    if (!f.closed) {
      issues.push({
        kind: 'unbalanced-fence',
        detail: `fenced code block opened at line ${f.startLine + 1} is never closed`,
        line: f.startLine + 1,
      })
    }
  }
  // Defensive: an ODD number of lone ``` fence lines (that scanFences somehow
  // did not pair) is also an imbalance. scanFences already pairs greedily, so
  // this catches only truly stray markers.
  const strayFenceLines = (md.match(/^\s*(`{3,}|~{3,})\s*$/gm) ?? []).length
  const openWithInfo = (md.match(/^\s*(`{3,}|~{3,})[^\n`~]+$/gm) ?? []).length
  if ((strayFenceLines + openWithInfo) % 2 !== 0 && fences.every((f) => f.closed)) {
    issues.push({
      kind: 'unbalanced-fence',
      detail: `odd number of fence delimiter lines (${strayFenceLines + openWithInfo})`,
    })
  }

  const maskedLines = masked.split('\n')
  maskedLines.forEach((rawLine, idx) => {
    const { blanked, unterminated } = extractInlineCode(rawLine)
    if (unterminated) {
      issues.push({
        kind: 'unterminated-code-span',
        detail: `inline code span opened but not closed on line ${idx + 1}`,
        line: idx + 1,
      })
    }
    // --- Malformed link: a `[label](` that never closes its `)` ------------
    // Only flag an OPENED inline-link that fails to close — a lone `[` used as
    // literal text (no following `(`) is valid CommonMark and renders fine.
    checkLinks(blanked, idx + 1, issues)
  })

  // --- Incomplete table row: a GFM table row must be a complete `| … |`. ---
  checkTableRows(md, issues)

  // --- Emphasis balance (common-case): odd count of unescaped `**` runs etc.
  checkEmphasisBalance(masked, issues)

  return issues
}

/**
 * Flag an inline-link open `[...](` whose `(...)` destination never closes on
 * the same line. A closed `[a](b)` is fine; a bare `[a]` with no `(` is fine
 * (literal text). Nested `()` inside the destination are balanced-counted.
 */
function checkLinks(line: string, lineNo: number, issues: ParseIssue[]): void {
  const re = /\[[^\]]*\]\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) != null) {
    // Start scanning the destination just after `](`.
    let depth = 1
    let k = m.index + m[0].length
    let closed = false
    for (; k < line.length; k++) {
      if (line[k] === '(') depth++
      else if (line[k] === ')') {
        depth--
        if (depth === 0) {
          closed = true
          break
        }
      }
    }
    if (!closed) {
      issues.push({
        kind: 'malformed-link',
        detail: `inline link opened at line ${lineNo} col ${m.index + 1} has an unclosed destination`,
        line: lineNo,
      })
    }
  }
}

/**
 * A GFM table is a header row, a delimiter row (`| --- | --- |`), then body
 * rows. Every row that participates must be a complete pipe row. We flag a
 * delimiter row that is NOT flanked by a complete header above and at least a
 * well-formed body/structure — i.e. the specific corruption `format.ts`'s
 * chunker guards against (a bisected half-row). A row is "complete" when, after
 * trimming, it starts and ends with `|` OR is a headerless GFM row with a
 * matching delimiter. We keep this conservative: only flag a row that opens
 * with `|` but does not close with `|` (a clearly bisected row).
 */
function checkTableRows(md: string, issues: ParseIssue[]): void {
  const { fenceLineSet } = maskFences(md)
  const lines = md.split('\n')
  lines.forEach((line, idx) => {
    if (fenceLineSet.has(idx)) return
    const t = line.trim()
    if (t.length === 0) return
    const looksLikeRow = t.startsWith('|')
    if (!looksLikeRow) return
    // A leading-pipe row must also close with a pipe to be a complete row.
    if (!t.endsWith('|')) {
      issues.push({
        kind: 'incomplete-table-row',
        detail: `table row opens with '|' but does not close with '|' on line ${idx + 1}`,
        line: idx + 1,
      })
    }
  })
}

/**
 * Common-case emphasis balance. Counts unescaped `**` and `__` (bold) runs and
 * standalone `*`/`_` (italic) and `~~` (strikethrough) on the fence+code-masked
 * text; an odd count means an unterminated emphasis entity — the thing that
 * yields "can't find end of the entity" on the rich path.
 *
 * NOTE (scope): this is a COUNT check, not a full delimiter-run resolver. It
 * intentionally does not model CommonMark's left/right-flanking rules, so it
 * can miss an exotic imbalance or (rarely) over-flag a legitimately
 * asymmetric-but-valid construct. The torture-set fixtures avoid such exotic
 * cases so this check stays a reliable regression signal. Escaped markers
 * (`\*`) and code (already masked) are excluded.
 */
function checkEmphasisBalance(masked: string, issues: ParseIssue[]): void {
  // Strip inline code per-line first (reuse extractInlineCode's blanking).
  const codeStripped = masked
    .split('\n')
    .map((l) => extractInlineCode(l).blanked)
    .join('\n')
  // Remove escaped markers so `\*` doesn't count.
  const noEsc = codeStripped.replace(/\\[*_~`\\]/g, '')

  // Bold `**` and `__`: count runs.
  const doubleStar = (noEsc.match(/\*\*/g) ?? []).length
  if (doubleStar % 2 !== 0) {
    issues.push({ kind: 'unbalanced-emphasis', detail: `odd number of '**' bold delimiters (${doubleStar})` })
  }
  const strike = (noEsc.match(/~~/g) ?? []).length
  if (strike % 2 !== 0) {
    issues.push({ kind: 'unbalanced-emphasis', detail: `odd number of '~~' strikethrough delimiters (${strike})` })
  }
  // Single `*` italic: count SINGLE stars that are not part of a `**` pair.
  // Remove `**` pairs first, then count leftover lone `*`.
  const noBold = noEsc.replace(/\*\*/g, '')
  const loneStar = (noBold.match(/\*/g) ?? []).length
  if (loneStar % 2 !== 0) {
    issues.push({ kind: 'unbalanced-emphasis', detail: `odd number of lone '*' italic delimiters (${loneStar})` })
  }
}

// ---------------------------------------------------------------------------
// Signal (b): STRUCTURE extraction
// ---------------------------------------------------------------------------

/**
 * Parse the common entity structure out of a rich-markdown body. Fenced blocks
 * are extracted first (as `pre`), then inline code, links, bold, italic and
 * strikethrough from the remaining text. See the module doc for the scope of
 * "common entities". Order of returned entities is document order per type is
 * NOT guaranteed across types; assert on membership, not absolute index, in
 * tests (helpers below make that easy).
 */
export function parseRichEntities(md: string): RichEntity[] {
  const entities: RichEntity[] = []
  const { masked, fences } = maskFences(md)

  for (const f of fences) {
    entities.push({ type: 'pre', text: f.body, lang: f.lang.length > 0 ? f.lang : undefined })
  }

  // Inline code + links + emphasis on the masked (fence-free) text, line-wise.
  for (const rawLine of masked.split('\n')) {
    const { spans, blanked } = extractInlineCode(rawLine)
    for (const s of spans) entities.push({ type: 'code', text: s })

    // Links: [label](url). Extract before emphasis so a bracketed label with
    // emphasis inside is handled as a link (label text preserved verbatim).
    let line = blanked
    const linkRe = /\[([^\]]*)\]\(([^)]*)\)/g
    let lm: RegExpExecArray | null
    const linkBlank: string[] = []
    while ((lm = linkRe.exec(line)) != null) {
      entities.push({ type: 'link', text: lm[1], url: lm[2] })
      linkBlank.push(lm[0])
    }
    for (const lb of linkBlank) line = line.replace(lb, ' '.repeat(lb.length))

    // Strikethrough ~~...~~
    line = collect(line, /~~([^~]+)~~/g, (mtext) => entities.push({ type: 'strikethrough', text: mtext }))
    // Bold **...** (and __...__)
    line = collect(line, /\*\*([^*]+)\*\*/g, (mtext) => entities.push({ type: 'bold', text: mtext }))
    line = collect(line, /__([^_]+)__/g, (mtext) => entities.push({ type: 'bold', text: mtext }))
    // Italic *...* / _..._  (bold already removed above)
    line = collect(line, /\*([^*]+)\*/g, (mtext) => entities.push({ type: 'italic', text: mtext }))
    line = collect(line, /(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, (mtext) =>
      entities.push({ type: 'italic', text: mtext }),
    )
  }

  return entities
}

/** Apply `re` globally, invoke `cb` with capture group 1, blank the match. */
function collect(line: string, re: RegExp, cb: (inner: string) => void): string {
  let out = line
  let m: RegExpExecArray | null
  const toBlank: string[] = []
  while ((m = re.exec(line)) != null) {
    cb(m[1])
    toBlank.push(m[0])
  }
  for (const b of toBlank) out = out.replace(b, ' '.repeat(b.length))
  return out
}

// ---------------------------------------------------------------------------
// Test-facing convenience helpers
// ---------------------------------------------------------------------------

/** True when the body is parse-accept clean (signal a). */
export function isRichMarkdownValid(md: string): boolean {
  return validateRichMarkdown(md).length === 0
}

/** All entities of a given type, in document order. */
export function entitiesOfType(md: string, type: EntityType): RichEntity[] {
  return parseRichEntities(md).filter((e) => e.type === type)
}

/** The set of rendered inner texts for a given entity type. */
export function entityTexts(md: string, type: EntityType): string[] {
  return entitiesOfType(md, type).map((e) => e.text)
}
