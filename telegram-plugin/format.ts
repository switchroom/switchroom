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
 * Make a string safe to interpolate INSIDE a `code span`.
 *
 * Inside a GFM code span the content is LITERAL — backslash escaping does
 * NOT apply, so `escapeMarkdown` is exactly wrong there: it emits visible
 * backslashes (e.g. `openai\_key` for an identifier containing `_`). The
 * only character that can prematurely CLOSE the span is a backtick, so the
 * sole transform needed is to defuse embedded backticks. We insert a
 * zero-width space after each backtick so the raw ``` ` ``` can no longer
 * terminate the surrounding span while remaining visually identical.
 *
 * This is the canonical home for the helper (#2695 regression fix); other
 * modules re-export from here so there's one implementation.
 */
export function codeSpanSafe(s: string): string {
  return s.replace(/`/g, '`​')
}

/**
 * Make a URL safe to interpolate as the destination of a `[label](href)`
 * inline link.
 *
 * In GFM / Bot API 10.1 markdown a link destination written as `(...)` is a
 * bare destination whose parentheses must be BALANCED, or every paren must be
 * backslash-escaped. An href containing a literal `)` (Wikipedia
 * `..._(disambiguation)` URLs, tracking params, generated deep links) can
 * either truncate the URL (a lone `)` closing the destination) or, if we
 * escape only `)`, unbalance the parens and leak a literal backslash into the
 * decoded href. The destination honours C-style backslash escapes, so escape
 * `\` first (so we never double-escape a following escape), then BOTH `(` and
 * `)` — the whole URL is preserved balanced and micromark decodes it back to
 * the original href on round-trip. Bot API 10.1 lists `(`/`)` as escapable.
 */
export function escapeLinkHref(href: string): string {
  return href.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
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
 *
 * KNOWN ISSUE (accepted tradeoff): a literal backslash sequence `\n`/`\r`/`\t`
 * that a user genuinely meant as text OUTSIDE a code span is unescaped into a
 * real newline/tab — e.g. a bare Windows path `C:\new\table` becomes
 * `C:<newline>ew<tab>able`. This is deliberately not guarded: the fleet is
 * Linux-only, such paths in prose (rather than inside a `code span`, which is
 * masked and safe) are vanishingly rare, and the far commoner failure this
 * repairs is an LLM emitting JSON-escaped `\n\n` as literal text. If a
 * Windows-path use case ever matters, restrict the unescape to sequences not
 * flanked by path-like characters rather than removing it.
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
  /**
   * The placeholder prefix injected for FENCED-BLOCK masks only. A masked
   * fenced block occupies a whole line, so `isFenceOpenLine` / `isMarkerLine`
   * treat a line that STARTS with this prefix as a block construct. INLINE
   * code spans get a DISTINCT prefix (see maskCodeRegions) that deliberately
   * does NOT start with this one — so a line that merely opens with an inline
   * span (e.g. `\`key\` = \`value\``) reads as ordinary prose and still gets
   * its line break hardened.
   */
  placeholder: string
  /** Remove EVERY mask (fenced + inline) — used to measure visible length. */
  stripPlaceholders: (s: string) => string
}

/**
 * Mask fenced code blocks and inline code spans with collision-resistant
 * placeholders. `nonce` is a per-call random string the caller already holds
 * (so two maskers in one function share one nonce namespace cleanly).
 *
 * Fenced blocks are extracted FIRST and only when CLOSED (matching ```), so an
 * unclosed fence is left intact rather than misparsed by the inline pass. Inline
 * spans use `[^\`\n]+` — the same definition the chunker treats as code.
 *
 * Fenced and inline masks carry DISTINCT prefixes (`\x00RMF…` vs `\x00RMI…`).
 * This matters because the fenced prefix is what the block-structure predicates
 * (`isFenceOpenLine`, `isMarkerLine`) use to recognise a standalone masked code
 * block. Sharing one prefix (the pre-fix bug) made a line that merely STARTS
 * with an inline code span look like a fenced block, so its lone `\n` was never
 * hardened and the card collapsed into one run-on line (real victim:
 * `/vault get` rendering `\`key\` = \`value\``).
 */
function maskCodeRegions(text: string, nonce: string): MaskedCode {
  const FENCE_MASK_PH = `\x00RMF${nonce}_`
  const INLINE_MASK_PH = `\x00RMI${nonce}_`
  const codeMasks: string[] = []

  const masked = text
    .replace(/```[\s\S]*?```/g, (m) => {
      const idx = codeMasks.length
      codeMasks.push(m)
      return `${FENCE_MASK_PH}${idx}\x00`
    })
    .replace(/`[^`\n]+`/g, (m) => {
      const idx = codeMasks.length
      codeMasks.push(m)
      return `${INLINE_MASK_PH}${idx}\x00`
    })

  // Restore / strip match EITHER prefix, keyed on the shared index space.
  const escNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const anyMaskRe = new RegExp(`\x00RM[FI]${escNonce}_(\\d+)\x00`, 'g')
  const restore = (s: string): string =>
    s.replace(anyMaskRe, (_m, idx) => codeMasks[Number(idx)] ?? _m)
  const stripPlaceholders = (s: string): string => s.replace(anyMaskRe, '')

  return { masked, restore, placeholder: FENCE_MASK_PH, stripPlaceholders }
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

  // Step 1: collapse blank-line runs to exactly ONE clean blank line (`\n\n`),
  // never leaving a whitespace-only line between two paragraphs.
  //
  //   (a) Pure newline runs of 3+ → `\n\n`.
  //   (b) A blank-line run whose interior lines are ASCII-whitespace-only
  //       (spaces / tabs / CR) → `\n\n`. A model (or an upstream transform)
  //       that authors `A\n\n \n\nB` leaves a lone-space line between the
  //       paragraphs; CommonMark discards it (so it buys no gap) but it reads
  //       as an oversized / ragged gap in the raw text and in some clients, and
  //       it was the "stray blank line" seen in real replies. Collapse it.
  //
  // Deliberately ASCII-only: the `[ \t\r]` character class excludes U+00A0 by
  // construction, so a line whose only content is a non-breaking space a user
  // legitimately typed is left intact rather than silently collapsed. (This
  // used to also protect the NBSP paragraph spacer that addParagraphSpacers
  // injected downstream; that spacer pass was removed in the #2669 follow-up —
  // paragraph gaps now rely on plain `\n\n` — but keeping this ASCII-only is
  // still the conservative choice.) Runs on code-masked text, so a blank-ish
  // line inside a fenced block is parked and never touched.
  let out = masked
    // Collapse any run of newlines interleaved with ASCII whitespace-only
    // interior lines down to a single clean `\n\n`. Requires at least one
    // whitespace char between the first two newlines OR 3+ newlines, so it
    // fires on both `A\n \nB` (one space-only blank line) and `A\n\n \n\nB`
    // (a space-only line inside a multi-blank run) but never rewrites a clean
    // `A\n\nB` (no interior whitespace) — that already-correct gap is left to
    // the `\n{3,}` pass below, which collapses any surviving run of 3+
    // newlines (including pure `A\n\n\n\nB`) down to a single `\n\n`.
    .replace(/\n[ \t\r]+\n(?:[ \t\r]*\n)*/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')

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
  // START a new block. A properly block-separated table DOES render as a
  // real table (Bot API 10.1 rich messages); the failure mode this pass
  // fixes is the *glued* case — a block joined to the previous line by a
  // single `\n` (an un-separated table degrades to literal pipe text, prose
  // after a list is absorbed as a lazy list continuation). This pass inserts
  // the missing blank line at those transitions only, on the same masked text,
  // never touching code interiors, never collapsing/expanding existing `\n\n`,
  // and never splitting a table's header/delimiter/body rows apart.
  out = ensureBlockBoundaries(out, placeholder)

  return restore(out)
}

// ---------------------------------------------------------------------------
// Card line-break hardener — for DETERMINISTIC command/card bodies
// ---------------------------------------------------------------------------

/**
 * Harden the lone `\n` line breaks of a DETERMINISTIC card body into GFM hard
 * breaks (`  \n`, two trailing spaces) so every field lands on its own line
 * under Telegram's Bot API 10.1 rich-message (GFM) renderer.
 *
 * Why this exists (the run-on-blob bug): the rich path (#2669) renders a lone
 * `\n` between two non-blank lines as a *soft* break — the two lines collapse
 * onto the same visual line with a space between them. Agent PROSE is repaired
 * on the reply path by `normalizeParagraphBreaks`, but the ~98 slash-command
 * card replies dispatched through `switchroomReply(…, { html: true })` are sent
 * as RAW markdown with no normalization. Their builders stack short labelled
 * fields (`**5h window** …`, `**Model** …`, `Auth: ✓ Max …`) joined by a single
 * `\n`, so the whole card renders as one run-on blob.
 *
 * A deterministic card is NOT free prose — every newline its builder emits is
 * an INTENDED line break. So this hardener promotes UNCONDITIONALLY (no
 * sentence-terminal-punctuation gate, unlike `normalizeParagraphBreaks`) with
 * one exception: a line that participates in a genuine GFM block construct
 * (list / table / blockquote / heading / fenced code) keeps its single `\n` so
 * its native stacking / contiguity survives — a monospace table inside a ```
 * fence is never touched (it is code-masked AND the fence lines are excluded).
 * Real `\n\n` paragraph gaps (a builder's block separators) are preserved.
 *
 * This is the string-level sibling of `stackCardLines` (card-format.ts), which
 * does the same promotion from a pre-split `string[]` of guaranteed
 * single-line, non-block entries. Use `hardenCardBreaks` where the card body is
 * already an assembled string (e.g. the `switchroomReply` chokepoint) and may
 * legitimately contain GFM block constructs.
 *
 * Runs on code-masked text and is idempotent — a break already hardened to
 * `  \n` re-hardens to the same `  \n`.
 */
export function hardenCardBreaks(text: string): string {
  if (!text.includes('\n')) return text

  const nonce = Math.random().toString(36).slice(2)
  const { masked, restore, placeholder } = maskCodeRegions(text, nonce)

  // Collapse 3+ newline runs to a single clean `\n\n` gap (mirrors
  // normalizeParagraphBreaks step 1) so a stray extra blank line never becomes
  // an oversized gap. A genuine one-blank-line `\n\n` block gap is preserved.
  const out = masked.replace(/\n{3,}/g, '\n\n')

  // A line participating in a GFM block construct whose single-`\n` contiguity
  // must survive (its interior must NOT get a hard break).
  const isBlockConstructLine = (line: string): boolean =>
    isListItemLine(line) ||
    isTableRowLine(line) ||
    isTableDelimiterLine(line) ||
    isBlockquoteLine(line) ||
    isHeadingLine(line) ||
    isFenceOpenLine(line, placeholder)

  const lines = out.split('\n')
  const pieces: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const isLast = i === lines.length - 1
    const next = isLast ? '' : lines[i + 1]
    // Promote only between two non-blank content lines where NEITHER is a GFM
    // block-construct line (so lists / tables / quotes / headings / fences keep
    // their native single-`\n` stacking). A blank current/next line is a `\n\n`
    // paragraph gap — never promote across it.
    const promote =
      !isLast &&
      line.trim() !== '' &&
      next.trim() !== '' &&
      !isBlockConstructLine(line) &&
      !isBlockConstructLine(next)
    if (promote) {
      // Strip trailing whitespace so a re-run emits exactly one `  \n` (never
      // accumulate spaces). Include `\r` for CRLF sources.
      line = line.replace(/[ \t\r]+$/, '')
    }
    pieces.push(line)
    if (isLast) break
    pieces.push(promote ? '  \n' : '\n')
  }

  return restore(pieces.join(''))
}

// ---------------------------------------------------------------------------
// Paragraph spacing note (#2669 follow-up): the NBSP paragraph-spacer
// (PARAGRAPH_SPACER / addParagraphSpacers) was REMOVED. Its premise — that the
// Bot API 10.1 rich (GFM) renderer collapses a `\n\n` gap TIGHT — is false for
// the live renderer, which shows a `\n\n` gap as a normal single blank line.
// The old U+00A0 spacer therefore injected a spurious SECOND blank line
// (`\n\n \n\n`) between every paragraph fleet-wide. Paragraph spacing now
// relies on the plain `\n\n` that normalizeParagraphBreaks already guarantees
// at block boundaries — one correct single blank line, no spacer pass.

// ---------------------------------------------------------------------------
// Punctuation / bullet normalization — fleet-wide consistent typography
// ---------------------------------------------------------------------------

/**
 * Deterministic punctuation + bullet normalization for outbound messages
 * (fleet-wide consistent Telegram formatting). Runs in the send path AFTER
 * normalizeParagraphBreaks, on code-masked text (reuses maskCodeRegions), so
 * code spans and fenced blocks are never touched.
 *
 * Transforms:
 *   1. Space-flanked em/en dash (` — ` / ` – `) → `, ` — except a
 *      digit-flanked spaced dash (a numeric range `3 – 5`), which becomes a
 *      plain hyphen range (`3-5`).
 *   2. Bare em-dash between word characters (`word—word`) → `, `; a
 *      digit-flanked one (`3—5`) → hyphen.
 *   3. Bare en-dash between word characters → ASCII hyphen (`2019–2024` →
 *      `2019-2024`).
 *   4. Leading unicode bullets (`•` / `·`) as list markers → `- ` so every
 *      list renders as a real GFM list (indent preserved).
 *
 * Idempotent: the output contains no em/en dashes or leading unicode bullets
 * outside code regions, so a second pass is a no-op.
 */
export function normalizePunctuation(text: string): string {
  if (!/[—–•·]/.test(text)) return text

  const nonce = Math.random().toString(36).slice(2)
  const { masked, restore } = maskCodeRegions(text, nonce)

  // Mask inline-link DESTINATIONS `](href)` before the dash passes so a dash
  // inside a URL is never rewritten. maskCodeRegions only masks code spans/
  // fences, not link hrefs, so without this an en-dash in a path becomes a
  // silently-wrong URL, and an em-dash becomes `, ` — the injected space
  // TERMINATES the markdown link and leaks the trailing text as prose
  // (`[a](https://x/foo—bar)` → `[a](https://x/foo, bar)`). Only the href
  // inside the parens is masked; the visible link LABEL still normalizes like
  // ordinary prose (dashes in label text are intended, per existing behaviour).
  const linkMasks: string[] = []
  const LINK_MASK_PH = `\x00RML${nonce}_`
  const maskedLinks = masked.replace(/(\]\()([^)\n]*)(\))/g, (_m, open: string, href: string, close: string) => {
    const idx = linkMasks.length
    linkMasks.push(href)
    return `${open}${LINK_MASK_PH}${idx}\x00${close}`
  })
  const escNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const linkRestoreRe = new RegExp(`\x00RML${escNonce}_(\\d+)\x00`, 'g')
  const restoreLinks = (s: string): string =>
    s.replace(linkRestoreRe, (_m, idx: string) => linkMasks[Number(idx)] ?? _m)

  let out = maskedLinks
    // 1. Space-flanked em/en dash. Numeric range keeps a hyphen. The right
    //    flank is a LOOKAHEAD (captured, not consumed) so consecutive spaced
    //    dashes ("a — b — c") all normalize in one pass — a consumed \S would
    //    swallow the char that anchors the next match.
    .replace(/(\S)[ \t][—–][ \t](?=(\S))/g, (_m, a: string, b: string) =>
      /\d/.test(a) && /\d/.test(b) ? `${a}-` : `${a}, `,
    )
    // 2. Bare em-dash between word chars. Numeric range keeps a hyphen.
    //    Right flank is a lookahead for the same consecutive-match reason.
    .replace(/(\w)—(?=(\w))/g, (_m, a: string, b: string) =>
      /\d/.test(a) && /\d/.test(b) ? `${a}-` : `${a}, `,
    )
    // 3. Bare en-dash between word chars → hyphen (ranges: 2019–2024).
    .replace(/(\w)–(?=\w)/g, '$1-')

  // Restore link hrefs now that the dash passes are done — before the bullet
  // pass and the code restore.
  out = restoreLinks(out)

  // 4. Leading unicode bullet markers → GFM `- ` (per line, indent kept).
  out = out
    .split('\n')
    .map((line) => line.replace(/^([ \t]*)[•·][ \t]+/, '$1- '))
    .join('\n')

  return restore(out)
}

// ---------------------------------------------------------------------------
// Over-bold tripwire — strip bold when a message is clearly over-bolded
// ---------------------------------------------------------------------------

/** A line's content once a leading list marker (`- ` / `1. `) is removed. */
function listItemContent(line: string): string {
  return line.trimStart().replace(/^(?:[-*+]|\d+[.)])\s+/, '')
}

/** True when a text fragment is one single fully-bolded span (`**…**`). */
function isFullyBolded(fragment: string): boolean {
  return /^\*\*[^*]+\*\*[.,:;!?]?$/.test(fragment.trim())
}

/** Strip `**bold**` markers from a fragment, keeping the text. */
function unbold(fragment: string): string {
  return fragment.replace(/\*\*([^*]+)\*\*/g, '$1')
}

/**
 * Over-bold tripwire (fleet-wide consistent Telegram formatting). If a
 * message is clearly over-bolded, strip the `**` markers and keep the text:
 *
 *   - GLOBAL: when >30% of the message's non-code characters sit inside
 *     `**bold**` spans, ALL bold markers are stripped.
 *   - PER-BLOCK: an entire multi-line paragraph fully bolded, or a list whose
 *     EVERY item is fully bolded, has that block's bold stripped.
 *
 * Deliberately conservative:
 *   - Messages under 100 non-code characters are exempt (a short reply whose
 *     one key fact is bolded is exactly the house style).
 *   - A single-line fully-bolded paragraph of ≤48 chars is treated as a
 *     pseudo-heading (the "**Section**" label the fleet style encourages) and
 *     is NOT stripped by the per-block rule (it still counts toward the
 *     global ratio).
 *   - A list with any non-fully-bolded item is left alone.
 *
 * Code spans/fences are masked (maskCodeRegions) and never counted or
 * modified. Idempotent: stripped output has no `**` spans left to trip on.
 */
export function stripExcessBold(text: string): string {
  if (!text.includes('**')) return text

  const nonce = Math.random().toString(36).slice(2)
  const { masked, restore, placeholder, stripPlaceholders } = maskCodeRegions(text, nonce)

  // Non-code character budget: masked text with BOTH fenced + inline masks
  // removed (stripPlaceholders handles the two distinct prefixes).
  const visible = stripPlaceholders(masked)
  if (visible.length < 100) return restore(masked)

  let boldChars = 0
  for (const m of visible.matchAll(/\*\*([^*]+)\*\*/g)) boldChars += m[1].length

  if (boldChars / visible.length > 0.3) {
    // Clearly over-bolded — strip every bold span, keep the text.
    return restore(unbold(masked))
  }

  // Per-block check on blank-line-delimited blocks of the masked text.
  const blocks = masked.split(/\n{2,}/)
  const rebuilt = blocks.map((block) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (lines.length === 0 || !block.includes('**')) return block

    const listLines = lines.filter((l) => isListItemLine(l))
    if (listLines.length >= 2 && listLines.length === lines.length) {
      // A list block: strip only when EVERY item is fully bolded.
      if (lines.every((l) => isFullyBolded(listItemContent(l)))) return unbold(block)
      return block
    }

    // A prose paragraph (no structural marker lines): strip when every line
    // is one fully-bolded span — except the single-short-line pseudo-heading.
    const isProseBlock = lines.every((l) => !isMarkerLine(l, placeholder))
    if (!isProseBlock) return block
    if (!lines.every((l) => isFullyBolded(l))) return block
    if (lines.length === 1 && lines[0].trim().length <= 48) return block
    return unbold(block)
  })

  // Rejoin with the original gap shapes: split() lost them, so re-split the
  // masked text capturing the separators and interleave.
  const seps = masked.match(/\n{2,}/g) ?? []
  let out = rebuilt[0] ?? ''
  for (let i = 1; i < rebuilt.length; i++) out += (seps[i - 1] ?? '\n\n') + rebuilt[i]

  return restore(out)
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
      // List start glued to prose above by a single `\n` (uniform-block-
      // spacing): a `- ` line already interrupts a paragraph in CommonMark,
      // so the blank line is render-safe — it makes the prose→list transition
      // a real `\n\n` block boundary the GFM renderer honours. Never fires
      // between two list items (prev is a list item) so list interiors stay
      // tight.
      const startsList = isListItemLine(line) && !isListItemLine(prev)

      if (startsTableHere || startsFence || startsQuote || startsHeading || startsList) {
        result.push('')
      }
    }

    // ---- Rule A2: blank line AFTER a closed code fence, before prose ----
    // Prose glued directly onto a fence's close (single `\n`) can be swallowed
    // or mis-parsed; a blank line after a closed fence is always CommonMark-safe.
    // Masked blocks collapse to a single placeholder-leading line, so a fence
    // "close" is a prev line that opens a fence (masked placeholder or literal
    // ``` fence). Only fire when the current line is non-blank prose that is NOT
    // itself a new block start (those are handled by Rule A above).
    if (prevNonBlank && !curBlank && isFenceOpenLine(prev, placeholder)) {
      const alreadySeparated = result.length > 0 && result[result.length - 1].trim() === ''
      const curIsBlockStart =
        isFenceOpenLine(line, placeholder) ||
        isBlockquoteLine(line) ||
        isHeadingLine(line) ||
        isTableRowLine(line) ||
        isTableDelimiterLine(line)
      if (!alreadySeparated && !curIsBlockStart) {
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
    // Table row (leading pipe) or a table delimiter row. A loose interior
    // ` | ` substring misclassifies prose like `choose A | B` as a table row
    // and suppresses paragraph spacing — require a real GFM table row/delimiter
    // instead. (A header row lacking a leading pipe is still recognised as
    // structural when its delimiter row follows, via ensureBlockBoundaries.)
    isTableRowLine(line) ||
    isTableDelimiterLine(line) ||
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
  if (terminator === '.' || terminator === '!' || terminator === '?' || terminator === ':') {
    return true
  }
  // Stat-card / key-value promotion (#2750). A vertical card like
  // `Calories: 1800 / Protein: 120g / Carbs: 200g` (or the fleet's HOUSE style
  // `**Calories:** 1800 / **Protein:** 120g`) has lines ending in digits/
  // letters, so the terminator rule above never fires and the whole card
  // collapses into one wall of text. Promote a lone `\n` when the prev line
  // reads as a standalone `label: value` stat line.
  //
  // The discriminator that separates a stat line from a mid-sentence soft wrap
  // that merely contains a colon (`The deal has one catch: the buyer wants it
  // and\nToronto lawyers sign off`) is two-fold:
  //   1. The LABEL (text before the colon) is SHORT — a stat label is a term
  //      of a few words, a wrapped prose clause is a long run of words. We cap
  //      the label at 3 words / 24 chars.
  //   2. The next line is NOT a lowercase-started mid-sentence continuation.
  //      A genuine wrapped sentence continues in lowercase; a stat/label line
  //      is followed by another label or capitalised prose.
  // Markdown emphasis (`*` `_` `` ` ``) is stripped first so bold labels like
  // `**Calories:**` are recognised. A prev with no colon never matches, so a
  // plain soft-wrapped sentence is untouched.
  const statStripped = prevTrimmed.replace(/[*_`]/g, '')
  const colonIdx = statStripped.indexOf(':')
  if (colonIdx > 0) {
    const label = statStripped.slice(0, colonIdx).trim()
    const value = statStripped.slice(colonIdx + 1)
    const labelWords = label.length === 0 ? 0 : label.split(/\s+/).length
    const isStatLine =
      /^[ \t]+\S/.test(value) && labelWords >= 1 && labelWords <= 3 && label.length <= 24
    if (isStatLine && !/^[a-z]/.test(nextTrimmed)) {
      return true
    }
  }
  return false
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
    // Back off so the cut doesn't bisect an inline entity (`**bold**`,
    // `` `code` ``, `_italic_`, `[label](href)`), which would leave an unclosed
    // delimiter in the emitted chunk (Telegram then parse-rejects it to
    // plaintext, or mis-renders the continuation). Runs LAST so it also cleans
    // up a boundary the fence/table back-offs landed on.
    cut = backOffOpenInline(rest, cut)

    if (cut <= 0) {
      // Could not find a safe boundary below maxLen — the region is one
      // indivisible block (e.g. a single huge fenced block or an unbreakable
      // token run). Emitting the oversized remainder whole makes Telegram
      // reject it (RICH_MESSAGE_TEXT_TOO_LONG) and drops the whole answer, so
      // fall back to a raw character slice: every piece is guaranteed <= maxLen
      // (a degraded-but-delivered message beats a hard reject). hardSliceToCap
      // returns the head chunk plus the rest; keep looping on the remainder so
      // any trailing splittable region still gets normal boundary treatment.
      const sliced = hardSliceToCap(rest, maxLen)
      chunks.push(stripBoundarySpacers(sliced[0], 'trailing'))
      rest = stripBoundarySpacers(sliced.slice(1).join(''), 'leading')
      continue
    }

    chunks.push(stripBoundarySpacers(rest.slice(0, cut), 'trailing'))
    rest = stripBoundarySpacers(rest.slice(cut), 'leading')
  }

  return chunks.map((c) => stripBoundarySpacers(c, 'trailing'))
}

/**
 * Strip stray blank lines off a chunk boundary so a cut that lands in a `\n\n`
 * paragraph gap never leaves a continuation chunk that OPENS with a bare blank
 * line, nor a prior chunk that ENDS with one.
 *
 * (Pre-#2669-follow-up this also peeled the NBSP paragraph spacer that
 * addParagraphSpacers injected into every gap. That spacer pass was removed —
 * gaps are now plain `\n\n` — so this reduces to the original behaviour: strip
 * a run of ASCII-whitespace-only blank lines off the boundary.) Idempotent: a
 * chunk already trimmed has nothing left to strip.
 *
 *  - `'leading'`  → strip the run from the START (the continuation chunk).
 *  - `'trailing'` → strip the run from the END (the just-emitted prior chunk).
 */
function stripBoundarySpacers(chunk: string, side: 'leading' | 'trailing'): string {
  // A boundary blank run is one-or-more lines that render empty (ASCII
  // whitespace only). Peel it off the requested side.
  if (side === 'leading') {
    return chunk.replace(/^(?:[ \t]*\n)+/, '')
  }
  return chunk.replace(/(?:\n[ \t]*)+$/, '')
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

/**
 * Inline entities that must not be bisected by a chunk cut. Each pattern is
 * matched over the full `text`; if the chosen `cut` lands STRICTLY inside a
 * matched span, retreat to that span's start so the whole span moves to the
 * next chunk (mirrors backOffOpenFence / backOffTableRow). Cutting inside a
 * span would strand an unclosed `**` / `` ` `` / `_` / `](` delimiter, which
 * Telegram parse-rejects to plaintext or mis-renders across the boundary.
 *
 * The `_italic_` pattern is boundary-guarded so snake_case identifiers
 * (`foo_bar_baz`) don't read as emphasis; a stray match there is harmless
 * anyway (it only shifts the cut to a `_` character, still a clean boundary).
 */
const INLINE_SPAN_PATTERNS: readonly RegExp[] = [
  /`[^`\n]+`/g, // inline code
  /\*\*[^*\n]+\*\*/g, // bold
  /__[^_\n]+__/g, // underline
  /(?<![\w*])_[^_\n]+_(?![\w*])/g, // italic (snake_case-guarded)
  /\[[^\]\n]*\]\([^)\n]*\)/g, // link [label](href)
]

function backOffOpenInline(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut
  let earliest = cut
  for (const re of INLINE_SPAN_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      // Cut strictly inside this span → the span straddles the boundary.
      if (start < cut && cut < end && start < earliest) earliest = start
      // Matches arrive in order; once a span starts at/after the cut, no later
      // span can contain it.
      if (start >= cut) break
      // Guard against a zero-width match wedging the loop.
      if (re.lastIndex === start) re.lastIndex = start + 1
    }
  }
  return earliest
}
