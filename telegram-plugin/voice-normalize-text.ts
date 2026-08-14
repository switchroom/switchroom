/**
 * Speech normalization for OUTBOUND voice replies (voice-out).
 *
 * The problem: the agent's reply is Markdown-flavoured text. A TTS engine
 * (Kokoro sidecar or OpenAI) reads it LITERALLY — so `~about 3`, `**bold**`,
 * `` `code` ``, `# Heading`, `[label](https://…)`, and code fences all get
 * spoken as "tilde", "asterisk asterisk", "backtick", "hash", or the raw URL
 * read character-by-character. That is exactly the operator feedback: the
 * voice is good but it pronounces the markup.
 *
 * `normalizeForSpeech` is a PURE string→string pass applied to the reply text
 * BEFORE it is handed to any TTS engine. It replaces the older, partial
 * `stripMarkdown` pass on the voice-out path (that one left `~`, code fences,
 * tables, and arrows leaking through). It is deliberately conservative: the
 * goal is natural prose, not aggressive rewriting — when in doubt it leaves
 * real words alone.
 *
 * Documented behavioural choices (the "sensible defaults" the task allows):
 *   - Inline code (`` `x` ``): the backticks are dropped, the CONTENT is
 *     kept and spoken. Short inline code is usually a word/identifier the
 *     listener wants to hear.
 *   - Fenced code blocks (``` … ```): DROPPED entirely and replaced with a
 *     short spoken placeholder ("(code block omitted)"). Reading a block of
 *     code aloud is noise; a listener on a bike can't act on it anyway.
 *   - Links `[text](url)`: spoken as just `text`; the URL is dropped. A bare
 *     autolink `<https://…>` or a raw URL is replaced with "a link" so the
 *     engine never spells out a URL character-by-character.
 *   - `~` is DROPPED (not read as "tilde", not expanded to "about") — it is
 *     ambiguous (strikethrough marker vs. approx) and dropping is the safest
 *     choice that never mangles a real word.
 *   - `->` / `=>` / `→` become the spoken word "to".
 *   - Block boundaries (headings, bullets, ordered items) become SENTENCE
 *     boundaries: the marker is replaced with terminating punctuation so a
 *     multi-bullet reply is spoken as separate sentences with breath between
 *     them, instead of the newline-collapse fusing it into one run-on.
 *   - A multi-segment filesystem path (`/var/log/syslog`, `~/.config/x/y`,
 *     `a/b/c`) is spoken as its LAST segment, or "a path" when that segment
 *     is unspeakable noise. A single `word/word` is prose and is left for the
 *     downstream "word slash word" pass in normalizeForTts.
 *   - A tiny, well-tested set of trivially-safe abbreviations is expanded
 *     ("e.g." → "for example", "i.e." → "that is", "etc." → "and so on",
 *     "vs" → "versus", "approx" → "approximately", "w/" → "with").
 *     Anything ambiguous is left alone.
 *
 * Phase 2 pre-TTS naturalization (all conservative, number/token-guarded):
 *   - Emoji & pictographs are dropped entirely (TTS would read their long
 *     CLDR names); `:shortcode:` forms are dropped too. Whitespace collapses.
 *   - Numbers, units & symbols are spoken: `%` → "percent", `$5.50` → "five
 *     dollars fifty", `12x`/`12×` → "twelve times", `°C` → "degrees",
 *     unit suffixes (`500ms`, `2h`, `10KB`, `100k`) expand to words, and the
 *     `& + =` glue symbols become "and / plus / equals".
 *   - A curated acronym set (CI, PR, API, URL, GPU, CPU, TTS, STT, HTTP,
 *     JSON, SQL, UI) is spelled letter-by-letter; word-style acronyms
 *     (NASA) are left alone.
 *   - Clear time / date patterns: `12:45` → "twelve forty-five", ISO
 *     `2026-07-01` → "July first two thousand twenty-six".
 * Every phase-2 pass is guarded to fire only on a clear number+token so real
 * identifiers (`my_var`, `class5`, `my5thing`) pass through untouched.
 */

/** Replace a fenced code block with a spoken placeholder. */
const CODE_BLOCK_PLACEHOLDER = 'code block omitted'

/** Named HTML entities the reply text realistically carries. */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/**
 * Markdown metacharacters that the block/emphasis/table stripper would
 * silently consume at line-start or as a pair. When such a char arrives via
 * an entity escape the user meant it LITERALLY (that is the whole point of
 * escaping it), so instead of emitting the raw char — which the downstream
 * stripper would then eat, losing the intent — we emit a neutral spoken form
 * that survives every later pass. Deterministic; the spoken form contains no
 * `&`/`;` so it can never re-enter the entity decoder.
 */
const METACHAR_SPOKEN: Record<string, string> = {
  '#': ' hash ',
  '*': ' asterisk ',
  '_': ' underscore ',
  '~': ' tilde ',
  '`': ' backtick ',
  '|': ' bar ',
}

/** One decode pass: named + numeric entities → char (or spoken metachar). */
function decodeHtmlEntitiesOnce(input: string): string {
  const toChar = (cp: number, raw: string): string => {
    if (!(cp > 0 && cp <= 0x10ffff)) return raw
    const ch = String.fromCodePoint(cp)
    return METACHAR_SPOKEN[ch] ?? ch
  }
  return input
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => toChar(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec: string) => toChar(Number(dec), m))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => {
      const ch = HTML_ENTITIES[name.toLowerCase()]
      if (ch === undefined) return m
      return METACHAR_SPOKEN[ch] ?? ch
    })
}

/**
 * Decode HTML entities (named + numeric) to their character so a TTS engine
 * never reads `&amp;` as "amp". Unknown named entities are left untouched.
 * Pure + deterministic.
 *
 * Iterates to a FIXPOINT: a double-encoded entity (`&amp;amp;lt;`) is decoded
 * repeatedly until no entity remains, so this pass is depth-idempotent —
 * applying it once yields the same result as applying it twice. That keeps
 * every voice callsite in lockstep: the immediate voice-out path runs
 * normalizeForSpeech THEN normalizeForTts, and the value the lazy Listen tap /
 * pre-synth queue reads is itself already normalizeForSpeech'd before its own
 * normalizeForTts — fixpoint decoding guarantees both speak an identical
 * string regardless of how deep the original encoding was. The loop strictly
 * shrinks the entity count each turn (and is capped) so it always terminates.
 * Text WITHOUT a trailing `;` (e.g. `Q&A`) matches nothing and is returned
 * untouched.
 */
export function decodeHtmlEntities(input: string): string {
  let s = input
  // A fully-decodable chain shrinks by at least one entity per pass; the cap
  // is a belt-and-braces guard against any pathological crafted input.
  for (let i = 0; i < 10; i++) {
    const next = decodeHtmlEntitiesOnce(s)
    if (next === s) break
    s = next
  }
  return s
}

/**
 * Remove markdown/MarkdownV2 backslash escapes so the spoken text carries no
 * literal backslashes. A backslash before ANY single character is dropped,
 * keeping the character (`\.` → ".", `\*` → "*", `\b` → "b"); a dangling
 * trailing backslash is dropped. Pure + deterministic + idempotent (a second
 * pass finds no backslashes). A real newline is preserved (only the escaping
 * backslash is consumed).
 */
export function stripBackslashEscapes(input: string): string {
  // `\X` → `X` for any following char (including an escaped `\\`), then drop
  // any lone backslash the first pass left (an escaped backslash's survivor).
  return input.replace(/\\([\s\S])/g, '$1').replace(/\\/g, '')
}

// ---------------------------------------------------------------------------
// Number → words helpers (small, deterministic, English cardinal only).
// Used by the numbers/units pass. Supports 0..999_999_999 which is far more
// than any realistic spoken quantity; larger inputs are left as digits so we
// never emit a wrong or truncated reading.
// ---------------------------------------------------------------------------
const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
]
const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty',
  'ninety',
]

/** Cardinal words for 0..999. */
function belowThousand(n: number): string {
  if (n < 20) return ONES[n]
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]
    const o = n % 10
    return o ? `${t}-${ONES[o]}` : t
  }
  const h = `${ONES[Math.floor(n / 100)]} hundred`
  const rest = n % 100
  return rest ? `${h} ${belowThousand(rest)}` : h
}

/** Cardinal words for a non-negative integer, or null if out of range. */
function numberToWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) return null
  if (n === 0) return 'zero'
  const parts: string[] = []
  const millions = Math.floor(n / 1_000_000)
  const thousands = Math.floor((n % 1_000_000) / 1000)
  const rest = n % 1000
  if (millions) parts.push(`${belowThousand(millions)} million`)
  if (thousands) parts.push(`${belowThousand(thousands)} thousand`)
  if (rest) parts.push(belowThousand(rest))
  return parts.join(' ')
}

/** Ordinal words for 1..31 (used for spoken dates). */
const ORDINALS: Record<number, string> = {
  1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth',
  7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth', 11: 'eleventh',
  12: 'twelfth', 13: 'thirteenth', 14: 'fourteenth', 15: 'fifteenth',
  16: 'sixteenth', 17: 'seventeenth', 18: 'eighteenth', 19: 'nineteenth',
  20: 'twentieth', 21: 'twenty-first', 22: 'twenty-second',
  23: 'twenty-third', 24: 'twenty-fourth', 25: 'twenty-fifth',
  26: 'twenty-sixth', 27: 'twenty-seventh', 28: 'twenty-eighth',
  29: 'twenty-ninth', 30: 'thirtieth', 31: 'thirty-first',
}

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]

/** Spoken form for a 4-digit year (e.g. 2026 → "two thousand twenty six"). */
function yearToWords(y: number): string | null {
  if (y < 1000 || y > 9999) return null
  // 2000..2099 read as "two thousand …" which is the realistic range for
  // these timestamps and reads naturally for TTS.
  if (y >= 2000 && y < 2100) {
    const lo = y % 100
    const base = 'two thousand'
    return lo ? `${base} ${belowThousand(lo)}` : base
  }
  // Generic "nineteen eighty-four" style for other centuries.
  const hi = Math.floor(y / 100)
  const lo = y % 100
  const hiW = belowThousand(hi)
  if (lo === 0) return `${hiW} hundred`
  return `${hiW} ${belowThousand(lo)}`
}

/** Spoken minutes for a time-of-day (e.g. 45 → "forty-five", 5 → "oh five"). */
function minutesToWords(mm: number): string {
  if (mm === 0) return "o'clock"
  if (mm < 10) return `oh ${ONES[mm]}`
  return belowThousand(mm)
}

/** Number-unit suffixes: token suffix → { singular, plural } spoken unit. */
const UNIT_MAP: Record<string, { s: string; p: string }> = {
  ms: { s: 'millisecond', p: 'milliseconds' },
  s: { s: 'second', p: 'seconds' },
  sec: { s: 'second', p: 'seconds' },
  min: { s: 'minute', p: 'minutes' },
  m: { s: 'minute', p: 'minutes' },
  h: { s: 'hour', p: 'hours' },
  hr: { s: 'hour', p: 'hours' },
  d: { s: 'day', p: 'days' },
  kb: { s: 'kilobyte', p: 'kilobytes' },
  mb: { s: 'megabyte', p: 'megabytes' },
  gb: { s: 'gigabyte', p: 'gigabytes' },
  tb: { s: 'terabyte', p: 'terabytes' },
}

/**
 * Curated initialisms spoken letter-by-letter. Uppercase keys only.
 *
 * Only tokens in this set are ever expanded, so widening the set is safe:
 * word-style acronyms (NASA, ALWAYS) still fall through untouched because the
 * generic all-caps matcher consults this map before doing anything.
 */
const ACRONYMS = new Set([
  'CI', 'PR', 'API', 'URL', 'GPU', 'CPU', 'TTS', 'STT', 'HTTP', 'JSON',
  'SQL', 'UI',
  // Common in agent replies; previously read as nonsense words ("hoops",
  // "duh-ness", "mick-p") by the engine.
  'HTTPS', 'SSH', 'DNS', 'CLI', 'AWS', 'UTC', 'MCP', 'PDF', 'ID', 'OK',
  'VM', 'LLM', 'YAML', 'RAM', 'USB',
])

/** Longest key in ACRONYMS — the all-caps matcher's upper length bound. */
const ACRONYM_MAX_LEN = Math.max(...[...ACRONYMS].map((a) => a.length))

/**
 * A filesystem-path-shaped token: two or more `/`-separated segments, with an
 * optional leading segment (`a/b/c`), `~` (`~/.config/foo`) or nothing
 * (`/var/log/syslog`). Requiring TWO separators is deliberate — a single
 * `word/word` is prose ("and/or") and is left for the downstream
 * "word slash word" pass in tts-normalize.
 */
const PATH_TOKEN_RE =
  /(?<![\w~./-])(?:~|\.{1,2}|[A-Za-z0-9_.@-]+)?(?:\/[A-Za-z0-9_.@+-]+){2,}\/?(?![\w/-])/g

/**
 * A path-shaped token needs an ANCHOR before we may swallow it: a leading
 * `/`, `./`, `../` or `~/`, or a final segment carrying a file extension.
 * "Two or more slashes ⇒ path" is false in English — `yes/no/maybe`,
 * `read/write/exec`, `he/she/they`, `client/server/proxy` and
 * `unit/integration/e2e` are all prose, and swallowing them DELETES words
 * from the reply. Anything that is only a run of ordinary lowercase
 * word-shaped segments is left for the downstream "word slash word" pass.
 */
function looksLikePath(m: string, segs: string[]): boolean {
  if (/^(?:\/|\.{1,2}\/|~\/)/.test(m)) return true
  const last = segs[segs.length - 1]!
  if (/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(last)) return true
  // Every segment an ordinary lowercase word (letters, then optional digits)
  // ⇒ prose, not a path.
  return !segs.every((sg) => /^[a-z][a-z0-9]*$/.test(sg))
}

/** True when a path segment is worth speaking (a real name, not a blob). */
function isSpeakableSegment(seg: string): boolean {
  if (!/[A-Za-z]/.test(seg)) return false
  if (seg.length > 32) return false
  // A hex blob (sha, uuid chunk) reads as noise; prefer "a path".
  if (/^[0-9a-f]{8,}$/i.test(seg)) return false
  return true
}

/**
 * Speak a filesystem path as just its final segment ("/var/log/syslog" →
 * "syslog"), or "a path" when that segment carries no speakable name. Reading
 * a full path aloud is the worst kind of TTS noise — a long run of "slash"
 * between unpronounceable fragments. An all-numeric token run (a date like
 * `12/25/2026`) is explicitly NOT a path and is returned untouched.
 */
function speakPaths(input: string): string {
  return input.replace(PATH_TOKEN_RE, (m) => {
    const segs = m.split('/').filter((sg) => sg.length > 0)
    if (segs.length < 2) return m
    if (segs.every((sg) => /^\d+$/.test(sg))) return m
    if (!looksLikePath(m, segs)) return m
    const last = segs[segs.length - 1]!
    return isSpeakableSegment(last) ? last : 'a path'
  })
}

/** A line whose leading markup starts a new block (heading / list item). */
const BLOCK_MARKER_RE = /^[ \t]{0,3}(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/
/** Heading subset — a heading never has continuation lines. */
const HEADING_MARKER_RE = /^[ \t]{0,3}#{1,6}[ \t]+/

/** Give a line sentence-terminating punctuation without doubling it. */
function ensureTerminated(line: string): string {
  const t = line.replace(/[ \t]+$/, '')
  if (!t.trim()) return t
  // Already terminal (or a natural pause) — leave it, never emit ".." / ". .".
  if (/[.!?:;]$/.test(t)) return t
  // A trailing comma at a block boundary is an artifact of list formatting.
  if (/,$/.test(t)) return `${t.slice(0, -1)}.`
  return `${t}.`
}

/**
 * Strip heading / list markers AND turn each block boundary into a sentence
 * boundary. Without this the later newline-collapse joins every bullet into
 * one breathless run-on sentence — the single biggest voice-pacing complaint.
 *
 * A wrapped list item (a continuation line carrying no marker of its own) is
 * terminated only at the END of the unit, so a sentence split across two
 * source lines is not chopped mid-clause. The line immediately BEFORE a block
 * starts is terminated too, so "Steps" + bullets doesn't read as
 * "Steps first".
 */
function applyBlockPauses(input: string): string {
  const lines = input.split('\n')
  const isBlock = lines.map((l) => BLOCK_MARKER_RE.test(l))
  const isHeading = lines.map((l) => HEADING_MARKER_RE.test(l))
  const stripped = lines.map((l, i) =>
    isBlock[i] ? l.slice(l.match(BLOCK_MARKER_RE)![0].length) : l,
  )
  // A line is "inside a block unit" if it starts one, or continues one. A
  // heading owns exactly its own line — the prose under it is a new unit.
  const inUnit: boolean[] = []
  for (let i = 0; i < stripped.length; i++) {
    inUnit[i] =
      isBlock[i] === true ||
      (i > 0 &&
        inUnit[i - 1] === true &&
        isHeading[i - 1] !== true &&
        stripped[i]!.trim() !== '')
  }
  return stripped
    .map((line, i) => {
      const next = stripped[i + 1]
      const nextIsBlock = isBlock[i + 1] === true
      const unitEndsHere =
        isHeading[i] === true ||
        next === undefined ||
        next.trim() === '' ||
        nextIsBlock
      if (inUnit[i] && unitEndsHere) return ensureTerminated(line)
      if (nextIsBlock && line.trim() !== '') return ensureTerminated(line)
      return line
    })
    .join('\n')
}

/**
 * Convert a Markdown/plain reply into clean text for a TTS engine.
 * Pure and deterministic — same input always yields the same output.
 */
export function normalizeForSpeech(input: string): string {
  if (!input) return ''
  let s = input.replace(/\r\n?/g, '\n')

  // 0a. HTML entities → their character. The reply text can carry entity
  //     escapes (`&amp;`, `&lt;`, `&#39;`) that a TTS engine would otherwise
  //     read as "amp" / "lt" / a digit run. Decode BEFORE markdown/symbol
  //     passes so the recovered char is then handled naturally (e.g. a
  //     decoded `&` becomes "and" in the symbols pass).
  s = decodeHtmlEntities(s)

  // 0b. Backslash escapes → the escaped character. Telegram MarkdownV2 and
  //     CommonMark escape literal punctuation with a leading backslash
  //     (`\.`, `\-`, `\*`), and a backslash before a non-punctuation char
  //     (`\b`) is a literal backslash. Left in place the engine speaks
  //     "backslash b" / "slash b" — exactly the operator's "trash" report.
  //     Unescaping here (before the emphasis pass) restores the literal text
  //     so genuine `*emphasis*` markers are still stripped downstream while
  //     an escaped `\*` collapses to nothing spoken. Runs once; idempotent.
  s = stripBackslashEscapes(s)

  // 0. Emoji & pictographs → dropped entirely, then whitespace collapsed.
  //    TTS reads an emoji as its long CLDR name ("grinning face"), which is
  //    noise. We also drop `:shortcode:` forms so nothing is read as
  //    "colon rocket colon". The shortcode form is matched narrowly
  //    (:word: with letters/digits/_/- ) so real colon usage survives.
  s = s.replace(
    /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2B50}\u{3030}\u{303D}\u{3297}\u{3299}\u{24C2}]/gu,
    '',
  )
  //    Digit-bodied shortcodes are real (`:100:`, `:8ball:`,
  //    `:1st_place_medal:`), so the body may start with a digit — the
  //    timestamp protection is positional instead: the opening colon may not
  //    follow a digit/colon and the closing colon may not precede a digit, so
  //    the pass can never eat the colons out of `14:30:46`.
  s = s.replace(/(?<![\w:]):([a-z0-9][a-z0-9_+-]*):(?!\d)/gi, ' ')

  // 1. Fenced code blocks first (```lang … ``` or ~~~ … ~~~) — drop the
  //    whole block before any inline processing can see its contents.
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, `$1${CODE_BLOCK_PLACEHOLDER}.`)
  // An unterminated fence (opening ``` with no close) — drop to end.
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/g, `$1${CODE_BLOCK_PLACEHOLDER}.`)

  // 2. Images ![alt](url) → alt text (or drop when alt is empty).
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 3. Links [text](url) → text ; drop the URL entirely.
  // FUTURE (not built): the Kokoro sidecar's misaki G2P (docker/voice-sidecar/
  // server.py) accepts a per-word phoneme override via `[word](/phoneme/)`
  // markup. Wiring a caller-supplied pronunciation override end-to-end would
  // mean detecting that `/…/` form HERE and passing it through instead of
  // collapsing it to the link text below. Deliberately left as a hook.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 4. Autolinks <https://…> and bare URLs → "a link" (never spell a URL).
  s = s.replace(/<https?:\/\/[^>\s]+>/gi, 'a link')
  s = s.replace(/\bhttps?:\/\/[^\s)]+/gi, 'a link')

  // 5. Inline code `x` → x (keep content, drop backticks). Run before the
  //    generic backtick sweep so paired spans are handled cleanly.
  s = s.replace(/`([^`\n]+)`/g, '$1')
  // Any residual backticks → drop.
  s = s.replace(/`/g, '')

  // 5b. Filesystem paths → their last segment. Runs before the block/symbol
  //     passes (and before the downstream "word slash word" pass in
  //     normalizeForTts) so a path is never spelled out slash-by-slash.
  s = speakPaths(s)

  // 6. Emphasis markers. Paired forms first (longest marker first), then
  //    strip residual markup-by-construction doubles. A LONE `*` or `_` in
  //    the middle of maths/words is left alone (see step 11).
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
  s = s.replace(/___(.+?)___/g, '$1')
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
  s = s.replace(/__(.+?)__/g, '$1')
  s = s.replace(/\*(.+?)\*/g, '$1')
  s = s.replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/g, '$1')
  // Strikethrough ~~text~~ → text.
  s = s.replace(/~~(.+?)~~/g, '$1')

  // 7. Leading block markup, per line: headings, blockquotes, list markers.
  //    List bullets/numbers become a natural sentence pause rather than a
  //    spoken "dash" / "1 dot".
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  s = applyBlockPauses(s)

  // 8. Horizontal rules (---, ___, ***) on their own line → drop.
  s = s.replace(/^[ \t]{0,3}([-_*])\1{2,}[ \t]*$/gm, '')

  // 9. Table syntax: drop pipes and separator rows so tables read as prose.
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, '')
  s = s.replace(/\|/g, ' ')

  // 10. Arrows → the spoken word "to".
  s = s.replace(/[=-]>/g, ' to ')
  s = s.replace(/[→⇒]/g, ' to ')

  // 11. Stray tildes (approx / leftover markers) → drop. Ambiguous; dropping
  //     is the safe choice that never mangles a real word.
  s = s.replace(/~/g, '')

  // 12. Trivially-safe abbreviation expansions (case-insensitive, only at a
  //     word boundary followed by space/comma). Kept minimal on purpose.
  s = s.replace(/\be\.g\.,?/gi, 'for example,')
  s = s.replace(/\bi\.e\.,?/gi, 'that is,')
  s = s.replace(/\betc\./gi, 'and so on')
  s = s.replace(/\bapprox\.?(?=\s|$)/gi, 'approximately')
  s = s.replace(/\bvs\.?(?=\s|$)/gi, 'versus')
  s = s.replace(/\bw\/(?=\s)/gi, 'with ')

  // 13. Dates & times (clear patterns only, run before the numbers pass so
  //     the colon in HH:MM and the hyphens in ISO dates are consumed here).
  //     ISO date YYYY-MM-DD → "Month Dayth Year".
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, da) => {
    const year = Number(y)
    const month = Number(mo)
    const day = Number(da)
    if (month < 1 || month > 12 || day < 1 || day > 31) return m
    const yw = yearToWords(year)
    const ord = ORDINALS[day]
    if (!yw || !ord) return m
    return `${MONTHS[month]} ${ord} ${yw}`
  })
  //     Clock time HH:MM (24h ok) → spoken. Guarded by word boundaries so a
  //     ratio like "3:2" or a bare number isn't caught (needs 2-digit MM).
  //     The (?<![\d:]) / (?!:?\d) guards skip HH:MM:SS entirely (parity with
  //     normalizeForTts) — a half-spoken time with a dangling ":46" reads
  //     worse than leaving the digits as-is. The LOOKBEHIND is load-bearing:
  //     without it the scan re-anchors INSIDE the timestamp (`09:00:00` →
  //     "09:zero o'clock") because the trailing `00` is itself a legal HH:MM.
  s = s.replace(/(?<![\d:])\b([01]?\d|2[0-3]):([0-5]\d)(?!:?\d)/g, (m, hh, mm) => {
    const h = Number(hh)
    const min = Number(mm)
    const hw = belowThousand(h)
    if (min === 0) return `${hw} o'clock`
    return `${hw} ${minutesToWords(min)}`
  })

  // 14. Numbers, units & symbols → spoken words. Each sub-pass is guarded so
  //     it only fires on a clear number+token, never mid-word.
  //     Currency: $5 / $5.50 → "five dollars" / "five dollars fifty";
  //     $1,000 → "one thousand dollars" (thousands separators consumed, so
  //     the old "one dollar,000" misreading is impossible). The trailing
  //     lookahead bails on odd cents ("$5.203") and partial thousands
  //     ("$1,00") — the whole token is left unchanged rather than half-read.
  //     The guard must NOT fire on an ordinary sentence comma ("$500, plus
  //     tax") — only on a comma/period that STARTS another digit group.
  s = s.replace(/\$(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{2}))?(?!\d|[.,]\d)/g, (m, dollarsRaw, cents) => {
    const dollars = Number(String(dollarsRaw).replace(/,/g, ''))
    const dw = numberToWords(dollars)
    if (!dw) return m
    const noun = dollars === 1 && !cents ? 'dollar' : 'dollars'
    if (cents && cents !== '00') {
      const cw = numberToWords(Number(cents))
      return `${dw} ${noun} ${cw}`
    }
    return `${dw} ${noun}`
  })
  //     Percent sign → " percent".
  s = s.replace(/(\d)\s*%/g, '$1 percent')
  //     Temperature °C / °F → "degrees".
  s = s.replace(/°\s*[CF]\b/g, ' degrees')
  s = s.replace(/°/g, ' degrees')
  //     Multiplier NN× / NNx → "NN times" (x only when glued to a number).
  s = s.replace(/\b(\d{1,9})\s*[×x](?![a-z0-9])/gi, (m, n) => {
    const w = numberToWords(Number(n))
    return w ? `${w} times` : m
  })
  //     "100k" shorthand → "one hundred thousand" (k as thousands multiplier).
  s = s.replace(/\b(\d{1,6})k\b/gi, (m, n) => {
    const w = numberToWords(Number(n) * 1000)
    return w ? w : m
  })
  //     Number + unit suffix → "<number> <unit>" (e.g. 500ms, 2h, 10KB).
  //     Only when the suffix is a known unit glued directly to the number and
  //     bounded by a non-letter (so "my5thing" / "class5" are never touched).
  //
  //     The leading `(?<![\d.,])` lookbehind is load-bearing: without it
  //     `\b` is satisfied between a decimal point (or thousands comma) and
  //     the digits that follow, so "17s" inside "0.17s" — or "500s" inside
  //     "1,500s" — would match on its own and mangle the number ("0.17s" →
  //     "0.seventeen seconds"; "1,500s" → "1,five hundred seconds"). Excludes
  //     both `.` and `,` so a glued decimal/thousands-separated number is
  //     never re-anchored on. Multi-letter units (ms, GB, …) stay
  //     case-insensitive since `5MB`/`500ms` must keep working regardless of
  //     case; single-letter units (s, m, h, d) are matched case-sensitively
  //     lowercase-only in a second pass — the single letter "M" is one
  //     keystroke from meaning "million" in prose ("$5M", "Revenue was 5M")
  //     and must never fall through to "minutes" just because the whole
  //     alternation ran under /i.
  //
  //     KNOWN GAP, disclosed deliberately (2026-08, hotfix for a corpus
  //     regression): a decimal- or comma-glued number with a unit (27.5s,
  //     1,500s, 89.5g, 0.7-0.8m) is now left completely UNEXPANDED — the
  //     unit goes unspoken — rather than mangled the way it was before.
  //     Corpus-measured: samples carrying a digit-adjacent unspoken unit go
  //     65 → 122 (61 samples change under this fix, every one gaining an
  //     unspoken unit). Correctly expanding a decimal/comma-glued number is
  //     explicitly out of scope for this narrow hotfix — see the pinning
  //     tests below (13.0 GB / 89.5g / 27.5 s) marking the baseline for a
  //     follow-up decimal-expansion pass.
  //
  //     ASYMMETRY WITH pass 2 (tts-normalize.ts), pre-existing and NOT
  //     introduced by this fix: this pass has NO optional space between the
  //     number and the unit (unlike pass 2's `\s?`) and maps `m` to MINUTE;
  //     pass 2 maps `m` to METRE. That accident is exactly what makes "5m"
  //     (no space) come out of THIS pass as minutes and "16 m" (space) fall
  //     through untouched here but come out of pass 2 as metres in the
  //     composed pipeline — pinned by the composed-pipeline test in the
  //     tts-normalize test suite.
  const unitReplacer = (m: string, num: string, unitRaw: string): string => {
    const unit = UNIT_MAP[unitRaw.toLowerCase()]
    if (!unit) return m
    const n = Number(num)
    const w = numberToWords(n)
    if (!w) return m
    return `${w} ${n === 1 ? unit.s : unit.p}`
  }
  s = s.replace(
    /(?<![\d.,])\b(\d{1,9})(ms|sec|min|kb|mb|gb|tb|hr)(?![a-zA-Z])/gi,
    unitReplacer,
  )
  s = s.replace(
    /(?<![\d.,])\b(\d{1,9})(s|m|h|d)(?![a-zA-Z])/g,
    unitReplacer,
  )
  //     Symbols between tokens: standalone & → and, + → plus, = → equals.
  s = s.replace(/(\S)\s*\+\s*(\S)/g, '$1 plus $2')
  s = s.replace(/\s=\s/g, ' equals ')
  s = s.replace(/(\s)&(\s)/g, '$1and$2')
  s = s.replace(/(\w)&(\w)/g, '$1 and $2')

  // 15. Acronyms → letter-by-letter for a curated set of initialisms. Only a
  //     standalone all-caps token that exactly matches the map is expanded;
  //     word-style acronyms (NASA) and sub-tokens of larger words are left.
  s = s.replace(new RegExp(`\\b[A-Z]{2,${ACRONYM_MAX_LEN}}\\b`, 'g'), (tok) =>
    ACRONYMS.has(tok) ? tok.split('').join(' ') : tok,
  )

  // 16. Collapse excessive punctuation the engine would over-emphasise.
  s = s.replace(/([!?.]){2,}/g, '$1')

  // 17. Whitespace → sentence flow. Blank lines become a sentence break so
  //     paragraphs don't run together; everything else collapses to a single
  //     space.
  s = s.replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '. ')
  s = s.replace(/\s*\n\s*/g, ' ')
  s = s.replace(/[ \t]{2,}/g, ' ')
  // Tidy artifacts from the paragraph→". " substitution (". ." → ". ").
  s = s.replace(/\.\s*\.(\s|$)/g, '.$1')
  s = s.replace(/\s+([,.!?;:])/g, '$1')

  return s.trim()
}
