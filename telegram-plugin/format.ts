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
 * The legacy plain-text `sendMessage` / `editMessageText` wire cap (4096
 * UTF-16 units). It does NOT apply to the rich path (`sendRichMessage`, up to
 * {@link RICH_MESSAGE_MAX_CHARS}), but it DOES apply the moment a send path
 * DEGRADES to the plain endpoint — the parse-reject fallbacks that resend a
 * rich chunk as plain text, and `renderSafe`'s `mode: "plain"` results.
 *
 * Lives here (next to the rich cap and the splitters) rather than in
 * `render/rich-render.ts` so every plain-degradation site can re-cap without
 * importing the renderer; `render/rich-render.ts` re-exports it for its
 * existing importers.
 */
export const PLAIN_TEXT_MAX_CHARS = 4096

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
 * Compute the delimiter for a fenced code block whose body is `text`.
 *
 * Fenced content is verbatim per the formatting guide; the only hazard is a
 * backtick run inside the body CLOSING the fence early. A hardcoded ``` around
 * a body that carries its own ``` ships three delimiters instead of two: the
 * wire opens at the first, closes at the embedded one, reads the remainder as
 * prose, and the trailing delimiter opens a fence that never terminates —
 * `can't find end of Pre entity`, a 400, and a whole-message plain-text
 * resend. Widening the delimiter to one backtick longer than the longest run
 * already present makes the open/close pair the only runs of that width, so
 * nothing in the body can match them.
 *
 * This is the canonical home for the rule (as `codeSpanSafe` is for the code
 * SPAN hazard above): the markdown fence (`renderCodeBlock`), the degraded
 * table fence (`degradeToCodeFence`) and the raw-HTML `<pre>` fold
 * (`buildPreBlock`, render/parse.ts) all call it, so there is exactly ONE
 * implementation of the width rule rather than a copy per call site.
 *
 * The scan is a LOOP, not `Math.max(0, ...runs.map(…))`. The spread form
 * (which both former copies of this rule used) passes one argument per run,
 * so a body with enough separate backtick runs blows the argument limit with
 * `RangeError: Maximum call stack size exceeded`, throwing out of the render
 * path entirely.
 *
 * The limit is ENGINE-DEPENDENT, so no single number describes it. The
 * shipping runtime is Bun (`telegram-plugin/package.json` `start`,
 * docker/Dockerfile.agent), where it measures at ~639k runs (~1.9 MB body);
 * this file is also collected by the vitest/Node runner, where it is ~125k
 * (~375 KB). Both measured on the pinned toolchain (Bun 1.3.13 — the CI
 * default in .github/actions/setup-switchroom/action.yml — and Node 22), and
 * both move with an engine upgrade.
 *
 * We deliberately do NOT rely on that threshold. Input here is unbounded:
 * `renderOutboundChunks` renders the WHOLE raw body before any
 * `splitMarkdownChunks` (render/rich-render.ts:146), so the fence scan is not
 * bounded by the 32768-character rich cap. Being honest about the size: on
 * Bun a ~1.9 MB single message is an unlikely body, so there this is a latent
 * crash rather than a routine one. The loop is O(n) either way and cannot
 * throw, so correctness costs nothing and the reachability argument does not
 * have to be won.
 */
export function codeFenceFor(text: string): string {
  let longestRun = 0
  let current = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      current++
      if (current > longestRun) longestRun = current
    } else {
      current = 0
    }
  }
  return '`'.repeat(Math.max(3, longestRun + 1))
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
 *
 * WHITESPACE and control characters are PERCENT-ENCODED rather than
 * backslash-escaped. A bare link destination ends at the first ASCII
 * whitespace character, so a space or a newline inside the href does not just
 * truncate the URL — the remainder is re-read as a link title, or (for a
 * newline) the inline link is terminated outright, leaving a structurally
 * broken construct with URL fragments visible as prose. Backslash cannot
 * rescue that: whitespace is not escapable in a bare destination. `%20` /
 * `%0A` are the canonical URL encodings, so the href a client resolves is
 * equivalent to the one the author wrote.
 */
export function escapeLinkHref(href: string): string {
  return href
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(
      /[\x00-\x20\x7f]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    )
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
  // construction, so a line whose only content is a non-breaking space is left
  // intact rather than silently collapsed.
  //
  // That is load-bearing, not merely conservative. `addParagraphSpacers` (below)
  // wedges a U+00A0-only line into every prose paragraph gap to force a VISIBLE
  // gap (#2692) and is LIVE on the outbound path today — gateway/
  // outbound-send-path.ts (`normalizeOutboundBody`) and gateway/gateway.ts (the
  // rich `sendRichMessage` chunker). Within a single `normalizeOutboundBody`
  // pass the spacer is injected AFTER this normalizer, so this pass usually does
  // not see it — but the ASCII-only class is a deliberate, pinned invariant, not
  // an accident of that ordering: tests/paragraph-normalizer.test.ts ("the
  // deliberate U+00A0 spacer … is preserved") asserts
  // `normalizeParagraphBreaks(spaced) === spaced`, so this function stays safe
  // to re-enter over already-spacered text. Widening `[ \t\r]` to catch U+00A0
  // would eat the spacer, fail that test, and regress #2692.
  //
  // It also leaves a non-breaking space a user legitimately typed alone. Runs on
  // code-masked text, so a blank-ish line inside a fenced block is parked and
  // never touched.
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
// Paragraph spacers — restore a VISIBLE blank line between prose paragraphs
// ---------------------------------------------------------------------------

/**
 * The non-collapsible spacer paragraph injected between two prose paragraphs.
 *
 * Telegram's Bot API 10.1 rich-message renderer (the GFM/CommonMark engine
 * behind `sendRichMessage` / `editMessageText({ markdown })`, and the in-repo
 * IR renderer in `render/` that feeds it) renders a `\n\n` paragraph break
 * TIGHT — the two paragraphs sit on adjacent lines with no visible empty line
 * between them (live-confirmed: an outbound message with real `\n\n` gaps
 * renders jammed; only list/table BLOCK boundaries produce a visible gap). The
 * legacy markdown→HTML path (removed in #2669) sent `\n\n` literally with
 * `parse_mode:"HTML"`, where two newlines render as a real blank line. That
 * regression is the operator-confirmed "paragraphs jammed together" symptom
 * (#2692).
 *
 * CommonMark discards blank lines made of ASCII whitespace, but a line whose
 * only content is a NON-breaking space (U+00A0) is a genuine, non-empty
 * paragraph — it renders as a visible empty line. So `A\n\n \n\nB` renders as
 * three paragraphs: A, a blank-looking line, then B — the visible gap the HTML
 * path used to produce. This survives the in-repo IR renderer's re-parse /
 * re-render (verified: a U+00A0-only line round-trips intact, while an
 * ASCII-space-only line is collapsed to a tight `\n\n`), so it reaches the wire
 * whether `SWITCHROOM_RICH_RENDER` is on (default) or off.
 */
export const PARAGRAPH_SPACER = ' '

/**
 * Insert a visible blank-line spacer into each genuine `\n\n` paragraph gap so
 * the rich GFM renderer shows a real empty line between paragraphs (matching
 * the pre-#2669 HTML behaviour). See PARAGRAPH_SPACER for why a U+00A0 line is
 * the reliable trick.
 *
 * Uniform-block-spacing contract: a spacer is inserted into EVERY `\n\n` gap
 * that separates two DISTINCT blocks — prose→prose, paragraph→list,
 * list→paragraph, heading→anything, blockquote/table/fence boundaries — so a
 * mixed message renders with one identical visible blank line between blocks.
 * The one exception is a gap INSIDE a block of the same structural kind (two
 * items of a loose list, consecutive table rows/quotes/fences): those stay
 * tight so the block's contiguity survives. Interiors joined by a single `\n`
 * are never gaps at all and are untouched by construction.
 *
 * Runs on code-masked text (so a blank line inside a fenced block is never
 * touched).
 *
 * IDEMPOTENT & DOUBLE-GAP-PROOF (the #3208 regression this restores fixes):
 * each inter-block gap — whatever it originally holds (a bare `\n\n`, a
 * pre-existing U+00A0 spacer `\n\n \n\n`, a stray extra blank line `\n\n\n`, an
 * ASCII-space-only line) — is CANONICALISED to exactly one form: `\n\n`
 * (tight) or `\n\n${PARAGRAPH_SPACER}\n\n` (spaced). It therefore inserts
 * EXACTLY ONE spacer per spaced gap and can never stack a second, and running
 * the pass twice yields the same output as running it once. #3208 removed the
 * whole mechanism to kill a double-gap; the correct fix was to make the gap
 * canonical (this), not to delete the spacer and reintroduce the jammed-
 * paragraph symptom fleet-wide.
 *
 * Intended to run in the outbound send path AFTER normalizeParagraphBreaks
 * (which has already collapsed 3+ newline runs to `\n\n` and guaranteed
 * block-boundary blank lines) — but the canonicalisation above means it is
 * safe on un-normalized text too (e.g. the edit path).
 */
export function addParagraphSpacers(text: string): string {
  if (!text.includes('\n\n')) return text

  const nonce = Math.random().toString(36).slice(2)
  const { masked, restore, placeholder } = maskCodeRegions(text, nonce)

  if (!masked.includes('\n\n')) return restore(masked)

  const SP = PARAGRAPH_SPACER

  // ASCII-only trim (preserve U+00A0): `String.prototype.trim()` strips U+00A0,
  // so a spacer line would read as "blank"; trimming ASCII whitespace only
  // keeps the spacer line recognisable as content.
  const asciiTrim = (line: string): string =>
    line.replace(/^[ \t\r\f\v]+|[ \t\r\f\v]+$/g, '')

  // "Blank-ish" = a line that renders as an empty paragraph: ASCII-whitespace-
  // only, OR a line whose only non-ASCII-whitespace content is the U+00A0
  // spacer. Coalescing BOTH kinds into one gap is what makes the pass
  // idempotent and double-gap-proof — a pre-existing spacer or extra blank line
  // is absorbed into the gap and re-emitted canonically, never stacked.
  const isBlankish = (line: string): boolean => {
    const t = asciiTrim(line)
    return t === '' || t === SP
  }

  // Classify the block kind of a facing content line so the spacer decision can
  // be made per BLOCK TRANSITION (#uniform-block-spacing). A spacer is inserted
  // at every gap between two DIFFERENT block kinds and between two prose
  // paragraphs, but NEVER inside a single block's interior (two items of the
  // same loose list, two rows of a table, consecutive quotes/fences/dividers).
  type BlockKind = 'list' | 'table' | 'quote' | 'heading' | 'fence' | 'divider' | 'prose'
  const blockKind = (line: string): BlockKind => {
    if (isFenceOpenLine(line, placeholder)) return 'fence'
    if (isListItemLine(line)) return 'list'
    if (isTableRowLine(line) || isTableDelimiterLine(line)) return 'table'
    if (isBlockquoteLine(line)) return 'quote'
    if (isHeadingLine(line)) return 'heading'
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trimStart())) return 'divider'
    return 'prose'
  }

  // Same-kind structural pairs whose gap is a block INTERIOR — no spacer there.
  const SAME_KIND_TIGHT: ReadonlySet<BlockKind> = new Set([
    'list',
    'table',
    'quote',
    'fence',
    'divider',
  ])

  const shouldSpaceGap = (above: string, below: string): boolean => {
    const a = blockKind(above)
    const b = blockKind(below)
    if (a === b && SAME_KIND_TIGHT.has(a)) return false
    // Everything else is a genuine block transition (incl. prose→prose,
    // heading→anything, list↔paragraph, table/quote boundaries) — space it.
    return true
  }

  // Tokenize into CONTENT runs (consecutive non-blank-ish lines, joined by a
  // single `\n` — soft breaks stay inside a content block) and GAP runs
  // (consecutive blank-ish lines). Tokens strictly alternate by construction.
  type Tok = { kind: 'content' | 'gap'; lines: string[] }
  const toks: Tok[] = []
  for (const line of masked.split('\n')) {
    const kind = isBlankish(line) ? 'gap' : 'content'
    const last = toks[toks.length - 1]
    if (last && last.kind === kind) last.lines.push(line)
    else toks.push({ kind, lines: [line] })
  }

  // Rebuild. A CONTENT token re-emits its lines verbatim. An INTER-content GAP
  // (a gap flanked by content on BOTH sides) is re-emitted in canonical form —
  // one blank line (`''` → `\n\n`) for a tight gap, or `['', SP, '']`
  // (→ `\n\n${SP}\n\n`) for a spaced gap — discarding whatever it held. A
  // leading/trailing gap (no content on one side, only possible before the
  // first / after the last content block) is preserved verbatim.
  const out: string[] = []
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]
    if (tok.kind === 'content') {
      out.push(...tok.lines)
      continue
    }
    const prev = toks[i - 1]
    const next = toks[i + 1]
    if (prev?.kind === 'content' && next?.kind === 'content') {
      const above = prev.lines[prev.lines.length - 1]
      const below = next.lines[0]
      if (shouldSpaceGap(above, below)) out.push('', SP, '')
      else out.push('')
    } else {
      out.push(...tok.lines)
    }
  }

  return restore(out.join('\n'))
}

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
  // Also protect GFM ANGLE-BRACKET AUTOLINK destinations `<scheme:…>` for the
  // same reason (`<https://x/foo–bar>` → the en-dash would be rewritten to `-`,
  // corrupting the URL). Only the URI inside the brackets is masked; the `<`/`>`
  // are untouched. Conservative — requires a scheme-like `xxx:` prefix and no
  // whitespace/`>` in the body (loosely mirrors the GFM absolute-URI autolink
  // rule), so arbitrary `<…>` prose is never masked.
  const maskedAutolinks = maskedLinks.replace(
    /(<)([a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*)(>)/g,
    (_m, lt: string, uri: string, gt: string) => {
      const idx = linkMasks.length
      linkMasks.push(uri)
      return `${lt}${LINK_MASK_PH}${idx}\x00${gt}`
    },
  )
  const escNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const linkRestoreRe = new RegExp(`\x00RML${escNonce}_(\\d+)\x00`, 'g')
  const restoreLinks = (s: string): string =>
    s.replace(linkRestoreRe, (_m, idx: string) => linkMasks[Number(idx)] ?? _m)

  // The dash rewrite runs per line so blockquote lines can be exempted:
  // `>` blockquotes are reserved for VERBATIM quoted text, and rewriting an
  // author's ` — ` to `, ` inside a quotation would corrupt what they quoted.
  // A line opening with the LEGACY `**>` expandable-quote marker is a
  // blockquote line too (the render path no longer emits `**>` — it is
  // MarkdownV2-only syntax, see render.ts renderBlockquote — but legacy agent
  // output still contains it and parse.ts repairs it into a real quote), so
  // exempt it explicitly even though isBlockquoteLine (which keys on a leading
  // `>`) doesn't catch the `**` prefix. Code spans and link hrefs stay masked
  // throughout, so their dashes are already protected on every line.
  const rewriteDashes = (line: string): string =>
    line
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

  const isQuotedLine = (line: string): boolean =>
    isBlockquoteLine(line) || line.trimStart().startsWith('**>')

  let out = maskedAutolinks
    .split('\n')
    .map((line) => (isQuotedLine(line) ? line : rewriteDashes(line)))
    .join('\n')

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

/**
 * Max length (markers included) of a standalone fully-bolded line that is
 * treated as a legitimate pseudo-heading (`**Section**`) rather than an
 * over-bolded paragraph. Single source of truth for BOTH the per-block rule
 * and the global-ratio heading exemption.
 *
 * 64, not 48: at 48 a legitimate long section label
 * (`**Deployment status across all three regions:**` — 50 chars with markers)
 * was read as an over-bolded paragraph and flattened. 64 still bounds the
 * exemption to something that reads as a label on a phone; the alternative of
 * exempting any fully-bold line ending in `:` regardless of length was
 * rejected because an arbitrarily long bolded paragraph that happens to end
 * in a colon would then escape the tripwire entirely.
 */
const PSEUDO_HEADING_MAX_CHARS = 64

/**
 * True when a blank-line-delimited block is a single-line pseudo-heading: one
 * non-empty line that is a single fully-bolded span of ≤PSEUDO_HEADING_MAX_CHARS
 * characters (`**Summary**`, `**Next steps:**`). Multi-line blocks are never
 * headings, so this can never mislabel a bolded paragraph as exempt.
 */
function isPseudoHeadingBlock(block: string): boolean {
  const lines = block.split('\n').filter((l) => l.trim() !== '')
  if (lines.length !== 1) return false
  const t = lines[0].trim()
  return t.length <= PSEUDO_HEADING_MAX_CHARS && isFullyBolded(t)
}

/** Diagnostic emitted when the over-bold tripwire actually removes bold. */
export interface ExcessBoldStripDiagnostic {
  /** Which rule fired: the whole-message ratio, or per-block flattening. */
  rule: 'global' | 'per-block'
  /** Measured bold ratio: bold chars / visible (non-code) chars. */
  ratio: number
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
 *   - A single-line fully-bolded paragraph of ≤PSEUDO_HEADING_MAX_CHARS chars
 *     is treated as a pseudo-heading (the "**Section**" label the fleet style
 *     encourages) and is NOT stripped — neither by the per-block rule NOR by
 *     the global-ratio rule (it still counts toward the global ratio, so a
 *     genuinely over-bolded message still trips, but its section headings
 *     survive instead of the whole reply going plain). The one exception:
 *     when EVERY block of the message is such a heading there is no body to
 *     preserve contrast against, so the global rule strips them all rather
 *     than leaving a 100%-bold message untouched. A block that is nothing but
 *     masked code (a bare fence, a lone inline span) does NOT count as body
 *     for that test — see the note at the call site.
 *   - A list with any non-fully-bolded item is left alone.
 *
 * Code spans/fences are masked (maskCodeRegions) and never counted or
 * modified. Idempotent: stripped output has no `**` spans left to trip on.
 *
 * `onStrip` is an optional diagnostic sink invoked exactly once, only when
 * bold is actually removed, carrying which rule fired and the measured ratio.
 */
export function stripExcessBold(
  text: string,
  onStrip?: (d: ExcessBoldStripDiagnostic) => void,
): string {
  if (!text.includes('**')) return text

  const nonce = Math.random().toString(36).slice(2)
  const { masked, restore, placeholder, stripPlaceholders } = maskCodeRegions(text, nonce)

  // Non-code character budget: masked text with BOTH fenced + inline masks
  // removed (stripPlaceholders handles the two distinct prefixes).
  const visible = stripPlaceholders(masked)
  if (visible.length < 100) return restore(masked)

  let boldChars = 0
  for (const m of visible.matchAll(/\*\*([^*]+)\*\*/g)) boldChars += m[1].length
  const ratio = boldChars / visible.length

  // Blank-line-delimited blocks of the masked text (shared by both rules).
  const blocks = masked.split(/\n{2,}/)

  if (ratio > 0.3) {
    // Clearly over-bolded — strip every bold span, keeping the text, EXCEPT
    // standalone short pseudo-heading blocks (`**Section**`), which stay bold
    // so a bold-dense digest keeps its section headings.
    //
    // The exemption only makes sense when there is body text for the headings
    // to stand out FROM. A message whose every block is a pseudo-heading has
    // no body: exempting all of them leaves a 100%-bold message untouched and
    // unlogged. In that case the exemption is dropped and the whole message is
    // stripped, which is what the ratio rule says.
    //
    // "Body" here means VISIBLE (non-code) text, so a block that is nothing but
    // masked code is skipped rather than counted as body (#4114). Masked code
    // is invisible to every other measurement in this function — it is stripped
    // out of `visible` before the ratio is taken — so counting a bare fence as
    // body would be the one place code influences the bold decision, and it
    // would do so by RESTORING the exact #4017 symptom: a headings-plus-one-
    // snippet digest (a very ordinary agent status report) stayed 100% bold
    // with no onStrip line, because the code block broke `every(...)`. The
    // contrast a code block provides is real but partial, and it does not make
    // every remaining visible character being bold the right render.
    //
    // Filtering with `stripPlaceholders` (the masker's own "remove EVERY mask"
    // primitive) rather than a fence-specific test means all mask kinds — the
    // FENCE and INLINE prefixes today, anything maskCodeRegions adds later —
    // are handled by construction instead of by enumeration.
    const contentBlocks = blocks.filter((b) => stripPlaceholders(b).trim() !== '')
    const allHeadings =
      contentBlocks.length > 0 && contentBlocks.every(isPseudoHeadingBlock)
    const rebuilt = blocks.map((block) =>
      !allHeadings && isPseudoHeadingBlock(block) ? block : unbold(block),
    )
    const out = rejoinBlocks(masked, rebuilt)
    if (out !== masked) onStrip?.({ rule: 'global', ratio })
    return restore(out)
  }

  // Per-block check on the same blocks.
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
    if (isPseudoHeadingBlock(block)) return block
    return unbold(block)
  })

  const out = rejoinBlocks(masked, rebuilt)
  if (out !== masked) onStrip?.({ rule: 'per-block', ratio })
  return restore(out)
}

/**
 * Rejoin blocks produced by `masked.split(/\n{2,}/)` after per-block mapping,
 * restoring the ORIGINAL blank-gap shapes (split() drops the separators, so
 * re-capture them from the masked source and interleave).
 */
function rejoinBlocks(masked: string, rebuilt: string[]): string {
  const seps = masked.match(/\n{2,}/g) ?? []
  let out = rebuilt[0] ?? ''
  for (let i = 1; i < rebuilt.length; i++) out += (seps[i - 1] ?? '\n\n') + rebuilt[i]
  return out
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

/**
 * Re-cap a body that is about to be sent through the PLAIN `sendMessage` /
 * `editMessageText` endpoint (switchroom #4043).
 *
 * Every plain-text FALLBACK in the send path inherits a chunk that was split
 * for the RICH cap ({@link RICH_MESSAGE_MAX_CHARS} = 32768). Handing such a
 * chunk to the plain endpoint (which caps at {@link PLAIN_TEXT_MAX_CHARS} =
 * 4096) makes Telegram reject it with `message is too long` — so the fallback
 * that exists precisely to rescue a failed send fails too, and the user never
 * receives the message (in the outbox sweep it retries forever).
 *
 * Cuts at `splitMarkdownChunks`' safe boundaries first (never bisecting a
 * fenced block or a table row) and hard-slices any residual indivisible region,
 * so EVERY returned piece is guaranteed `<= cap`. Returns the input as a
 * single-element array when it already fits (the overwhelmingly common case,
 * byte-identical to the pre-fix behaviour).
 */
export function splitPlainTextToCap(text: string, cap = PLAIN_TEXT_MAX_CHARS): string[] {
  if (cap <= 0) return [text]
  if (text.length <= cap) return [text]
  const out: string[] = []
  for (const piece of splitMarkdownChunks(text, cap)) {
    if (piece.length <= cap) {
      if (piece.length > 0) out.push(piece)
      continue
    }
    // `splitMarkdownChunks` emits an unsplittable region whole; hard-cut it so
    // the plain endpoint can actually accept it.
    for (const slice of hardSliceToCap(piece, cap)) {
      if (slice.length > 0) out.push(slice)
    }
  }
  return out.length > 0 ? out : [text]
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

    // Back the cut off any markdown entity it would bisect — fenced block,
    // table row, inline span. One shared mechanism (`safeMarkdownCut`), also
    // used by the card fitter's last-resort clip (#4116).
    cut = safeMarkdownCut(rest, cut)

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
    return chunk.replace(new RegExp(`^(?:[ \\t]*${sp}?[ \\t]*\\n+)+`), '')
  }
  // Trailing: a newline run, optionally with spacer-only lines, at the very end.
  return chunk.replace(new RegExp(`(?:\\n+[ \\t]*${sp}?[ \\t]*)+$`), '')
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
 * span would strand an unclosed `***`/`**`/`*` / `` ` `` / `___`/`__`/`_` /
 * `](` delimiter, which Telegram parse-rejects to plaintext or mis-renders
 * across the boundary.
 *
 * The TRIPLE-marker patterns (`***bold-italic***` / `___…___`) come FIRST so
 * their whole span wins the earliest-start back-off in backOffOpenInline: the
 * double-marker pattern would otherwise match the inner `**…**` of a `***…***`
 * span and retreat only past that, stranding the lone outer `*` (odd asterisk
 * count → the italic is lost).
 *
 * The `_italic_` pattern is boundary-guarded so snake_case identifiers
 * (`foo_bar_baz`) don't read as emphasis; a stray match there is harmless
 * anyway (it only shifts the cut to a `_` character, still a clean boundary).
 */
const INLINE_SPAN_PATTERNS: readonly RegExp[] = [
  /`[^`\n]+`/g, // inline code
  /\*\*\*[^*\n]+\*\*\*/g, // bold-italic (triple) — before the bold pattern
  /___[^_\n]+___/g, // bold-italic underscore (triple)
  /\*\*[^*\n]+\*\*/g, // bold
  /__[^_\n]+__/g, // underline
  /(?<![\w*])_[^_\n]+_(?![\w*])/g, // italic (snake_case-guarded)
  // link `[label](href)` — and, via the optional leading `!`, Telegram's
  // inline-entity form `![22:45 tomorrow](tg://time?unix=…&format=…)` /
  // `![](tg://emoji?id=…)`. Without the `!?` the protected span would start at
  // the `[`, so a cut could land in the one-character gap and strand the `!`
  // on the previous chunk — silently demoting a date_time entity to a link.
  /!?\[[^\]\n]*\]\([^)\n]*\)/g,
  /~~[^~\n]+~~/g, // strikethrough
  /\|\|[^|\n]+\|\|/g, // spoiler
]

/** Characters that form multi-character markdown delimiter runs (`**`, `~~`, `||`, ` ``` `). */
const DELIMITER_RUN_CHARS = new Set(['*', '_', '`', '~', '|'])

/**
 * The opening delimiter of every entity kind {@link safeMarkdownCut} can
 * retreat past, anchored at the head of a string. Used ONLY by
 * {@link truncateMarkdownSafe}'s repair step — see the doc there for why
 * dropping an opener is the right repair. Kept adjacent to
 * `INLINE_SPAN_PATTERNS` so the two marker vocabularies stay in step.
 */
const FENCE_OPENER_AT_HEAD = /^(\n?)(?:`{3,}|~{3,})[^\n]*/
const INLINE_OPENER_AT_HEAD = /^(?:\*{1,3}|_{1,3}|`+|~~|\|\||\[)/
const TABLE_ROW_OPENER_AT_HEAD = /^(\n?[ \t]*)\|/

/**
 * Bound on {@link truncateMarkdownSafe}'s opener-drop repair loop. Each pass
 * removes at least one character, so this only caps a pathologically nested
 * head (`***` + `` ` `` + `[` …); eight is far past anything a card produces.
 */
const MAX_OPENER_REPAIRS = 8

/**
 * The largest index `<= cut` at which `text` can be split without bisecting a
 * markdown entity — the ONE place "where is it safe to cut markdown?" is
 * answered.
 *
 * Composes the three back-offs in the order the chunker has always applied
 * them (fenced block → table row → inline span; the inline pass runs last so
 * it also cleans a boundary the first two landed on), then refuses to split a
 * surrogate pair so the result is always valid UTF-16 as well as valid
 * markdown.
 *
 * Returns `0` when NO safe boundary exists at or below `cut` — i.e. an entity
 * that starts at index 0 swallows the whole window. Callers must handle that
 * case; see {@link truncateMarkdownSafe}.
 */
export function safeMarkdownCut(text: string, cut: number): number {
  if (cut <= 0) return 0
  if (cut >= text.length) return text.length
  let safe = backOffOpenFence(text, cut)
  safe = backOffTableRow(text, safe)
  safe = backOffOpenInline(text, safe)
  // Never cut INSIDE a delimiter run: `**bold**` cut between the two closing
  // stars emits one lone `*` (odd marker count → parse-reject), and the span
  // back-off above cannot see it because the run's first half is a complete
  // span's tail, not a straddle. Retreat to the run's start.
  while (safe > 0 && DELIMITER_RUN_CHARS.has(text[safe]) && text[safe - 1] === text[safe]) safe--
  if (safe <= 0) return 0
  // Never leave a lone high surrogate by cutting through an astral character.
  const prev = text.charCodeAt(safe - 1)
  const here = text.charCodeAt(safe)
  if (prev >= 0xd800 && prev <= 0xdbff && here >= 0xdc00 && here <= 0xdfff) safe -= 1
  return safe
}

/**
 * Truncate `text` to at most `budget` characters such that the RESULT IS
 * ALWAYS PARSEABLE MARKDOWN — no half-open `**`/`_`/`` ` ``/`~~`/`||` run, no
 * unclosed fence, no bisected link or table row, no split surrogate pair.
 *
 * Why this exists (#4116): the card fitter's last-resort clip used to slice
 * the raw markdown by character count. A cut landing between a `**` pair
 * yields a body Telegram parse-REJECTS — so the code path that exists
 * specifically to guarantee delivery within the char budget could itself make
 * the send fail. A clipped card beats no card, but only if it can be sent.
 *
 * Two steps, in order:
 *
 *  1. **Back off** to the nearest safe boundary ({@link safeMarkdownCut}).
 *     This is the normal case and it preserves formatting exactly: an entity
 *     that straddles the limit simply doesn't make the cut.
 *
 *  2. **Drop the opener** when backing off would keep less than HALF the
 *     window. That happens when a single entity is longer than the window —
 *     `**<40k-char description>**`, the #3682 repro — and a back-off would
 *     return a near-empty card, which is no better than the dropped card the
 *     clip exists to prevent. The entity cannot render anyway (its closing
 *     delimiter is past the window), so we drop its OPENING delimiter and ask
 *     again: the text survives as literal prose, the markdown stays balanced,
 *     and the card is delivered.
 *
 * The window END IS HELD FIXED IN SOURCE TERMS across a repair (`end` shrinks
 * by exactly the characters removed). Letting the window slide forward by the
 * dropped opener's width would pull the entity's CLOSING delimiter into the
 * output — an orphan closer, unbalanced again. That is a real defect this
 * function had before its property test swept every offset.
 *
 * The repair loop is bounded (each pass removes at least one character; at
 * most `MAX_OPENER_REPAIRS` passes) so a pathological body cannot spin.
 */
export function truncateMarkdownSafe(text: string, budget: number): string {
  if (budget <= 0) return ''
  if (text.length <= budget) return text
  let t = text
  let end = budget
  for (let pass = 0; pass <= MAX_OPENER_REPAIRS; pass++) {
    const safe = safeMarkdownCut(t, end)
    // A back-off that keeps at least half the window is the good outcome: the
    // straddling entity is dropped whole and everything before it renders as
    // authored.
    if (safe * 2 >= end) return t.slice(0, safe)
    const repaired = dropLeadingOpener(t.slice(safe))
    // No opener to drop (unreachable in principle — every back-off above
    // retreats TO one). Prefer the short-but-valid back-off over a slice that
    // cannot be parsed.
    if (repaired == null) return t.slice(0, safe)
    end -= t.length - safe - repaired.length
    t = t.slice(0, safe) + repaired
  }
  return t.slice(0, Math.max(0, safeMarkdownCut(t, end)))
}

/**
 * Remove the opening delimiter of the entity that begins at the head of
 * `rest`, preserving any leading newline so line structure survives. Returns
 * `null` when the head is not an entity opener.
 */
function dropLeadingOpener(rest: string): string | null {
  const fence = FENCE_OPENER_AT_HEAD.exec(rest)
  if (fence != null) return fence[1] + rest.slice(fence[0].length)
  const inline = INLINE_OPENER_AT_HEAD.exec(rest)
  if (inline != null) return rest.slice(inline[0].length)
  const row = TABLE_ROW_OPENER_AT_HEAD.exec(rest)
  if (row != null) return row[1] + rest.slice(row[0].length)
  return null
}

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
