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
 * Decode HTML entities (named + numeric) to their character so a TTS engine
 * never reads `&amp;` as "amp". Unknown named entities are left untouched.
 * Pure + deterministic.
 */
export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => {
      const cp = parseInt(hex, 16)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    })
    .replace(/&#(\d+);/g, (m, dec: string) => {
      const cp = Number(dec)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => {
      const ch = HTML_ENTITIES[name.toLowerCase()]
      return ch !== undefined ? ch : m
    })
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

/** Curated initialisms spoken letter-by-letter. Uppercase keys only. */
const ACRONYMS = new Set([
  'CI', 'PR', 'API', 'URL', 'GPU', 'CPU', 'TTS', 'STT', 'HTTP', 'JSON',
  'SQL', 'UI',
])

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
  s = s.replace(/:([a-z0-9][a-z0-9_+-]*):/gi, ' ')

  // 1. Fenced code blocks first (```lang … ``` or ~~~ … ~~~) — drop the
  //    whole block before any inline processing can see its contents.
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, `$1${CODE_BLOCK_PLACEHOLDER}.`)
  // An unterminated fence (opening ``` with no close) — drop to end.
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/g, `$1${CODE_BLOCK_PLACEHOLDER}.`)

  // 2. Images ![alt](url) → alt text (or drop when alt is empty).
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 3. Links [text](url) → text ; drop the URL entirely.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 4. Autolinks <https://…> and bare URLs → "a link" (never spell a URL).
  s = s.replace(/<https?:\/\/[^>\s]+>/gi, 'a link')
  s = s.replace(/\bhttps?:\/\/[^\s)]+/gi, 'a link')

  // 5. Inline code `x` → x (keep content, drop backticks). Run before the
  //    generic backtick sweep so paired spans are handled cleanly.
  s = s.replace(/`([^`\n]+)`/g, '$1')
  // Any residual backticks → drop.
  s = s.replace(/`/g, '')

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
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  s = s.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')
  s = s.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '')

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
  s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (m, hh, mm) => {
    const h = Number(hh)
    const min = Number(mm)
    const hw = belowThousand(h)
    if (min === 0) return `${hw} o'clock`
    return `${hw} ${minutesToWords(min)}`
  })

  // 14. Numbers, units & symbols → spoken words. Each sub-pass is guarded so
  //     it only fires on a clear number+token, never mid-word.
  //     Currency: $5 / $5.50 → "five dollars" / "five dollars fifty".
  s = s.replace(/\$(\d{1,9})(?:\.(\d{2}))?\b/g, (m, dollars, cents) => {
    const dw = numberToWords(Number(dollars))
    if (!dw) return m
    const noun = Number(dollars) === 1 && !cents ? 'dollar' : 'dollars'
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
  s = s.replace(
    /\b(\d{1,9})(ms|sec|min|kb|mb|gb|tb|hr|s|m|h|d)(?![a-z])/gi,
    (m, num, unitRaw) => {
      const unit = UNIT_MAP[unitRaw.toLowerCase()]
      if (!unit) return m
      const n = Number(num)
      const w = numberToWords(n)
      if (!w) return m
      return `${w} ${n === 1 ? unit.s : unit.p}`
    },
  )
  //     Symbols between tokens: standalone & → and, + → plus, = → equals.
  s = s.replace(/(\S)\s*\+\s*(\S)/g, '$1 plus $2')
  s = s.replace(/\s=\s/g, ' equals ')
  s = s.replace(/(\s)&(\s)/g, '$1and$2')
  s = s.replace(/(\w)&(\w)/g, '$1 and $2')

  // 15. Acronyms → letter-by-letter for a curated set of initialisms. Only a
  //     standalone all-caps token that exactly matches the map is expanded;
  //     word-style acronyms (NASA) and sub-tokens of larger words are left.
  s = s.replace(/\b[A-Z]{2,5}\b/g, (tok) =>
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
