/**
 * tts-normalize.ts — deterministic L1 text-normalization front-end for
 * the voice sidecar (issue #2760, Phase 1).
 *
 * Kokoro ships almost no text normalization, so raw agent text (markdown,
 * symbols, numbers, currency, emoji, URLs, code) gets read literally and
 * sounds unnatural. This module is a PURE string→string pass applied in
 * the gateway voice-out path immediately before the `POST /tts` body is
 * built, mirroring the `text-voice-scrub.ts` precedent: deterministic
 * transform, code-region park/restore, kill-switch env var, no network,
 * no LLM (Phase 2 adds the optional local-LLM layer).
 *
 * It runs AFTER `normalizeForSpeech` (which already strips most markdown
 * on the plan-building path) and is deliberately idempotent/overlapping
 * with it: the Listen lazy path synthesizes from a persisted cache whose
 * entries may predate normalizeForSpeech coverage, and this stage is the
 * last line of defence at the actual /tts body build. Rules where both
 * passes apply are no-ops the second time.
 *
 * Gating: ON BY DEFAULT (operator decision 2026-07-04 — Phase 1 ships
 * default-on). The only gate is the kill switch:
 * `SWITCHROOM_DISABLE_TTS_NORMALIZE=1` returns the input byte-identical —
 * same shape as `SWITCHROOM_DISABLE_VOICE_SCRUB`; rollback is one env var.
 *
 * Rules (en locale, deterministic, conservative — when unsure, pass
 * text through unchanged):
 *   - Markdown: bold/italic/strike markers removed; headings → plain;
 *     links → link text; bare URLs → spoken domain ("github dot com
 *     link"); list markers dropped; tables → "table omitted"; code
 *     fences → "code block omitted"; inline code read as-is without
 *     backticks (content is parked so number/symbol expansion can never
 *     mangle an identifier).
 *   - Emoji: stripped (a small map speaks the common ones).
 *   - Numbers: currency ($5.20 → "five dollars twenty"), percentages,
 *     ordinals (3rd → "third"), times (14:30), ISO dates, phone-like
 *     digit runs read digit-by-digit, units (km, GB, ms, …).
 *   - Symbols: & → and, @ → at, # → hash, word/word → "word slash word",
 *     ~5 → "about 5", > blockquote markers dropped.
 */

import { decodeHtmlEntities, stripBackslashEscapes } from './voice-normalize-text'

const NULL = '\x00'
const INLINE_PH = `${NULL}TN_INLINE`

/** On by default; the kill switch is the only gate. */
export function ttsNormalizeEnabled(): boolean {
  const kill = process.env.SWITCHROOM_DISABLE_TTS_NORMALIZE
  return !(kill === '1' || kill === 'true')
}

// ---------------------------------------------------------------------------
// Number → words (English cardinal, 0..999,999,999; larger stays digits so we
// never emit a wrong reading).
// ---------------------------------------------------------------------------
const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
]
const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety',
]

function belowThousand(n: number): string {
  if (n < 20) return ONES[n]!
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]!
    const o = n % 10
    return o ? `${t}-${ONES[o]}` : t
  }
  const h = `${ONES[Math.floor(n / 100)]} hundred`
  const rest = n % 100
  return rest ? `${h} ${belowThousand(rest)}` : h
}

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

/** Ordinal words for 0..99 ("third", "twenty-first"). null out of range. */
function ordinalToWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 99) return null
  const IRREGULAR: Record<number, string> = {
    0: 'zeroth', 1: 'first', 2: 'second', 3: 'third', 5: 'fifth',
    8: 'eighth', 9: 'ninth', 12: 'twelfth',
  }
  if (IRREGULAR[n]) return IRREGULAR[n]
  if (n < 20) return `${ONES[n]}th`
  const tens = Math.floor(n / 10)
  const ones = n % 10
  if (ones === 0) return `${TENS[tens]!.replace(/y$/, 'ie')}th`
  return `${TENS[tens]}-${ordinalToWords(ones)}`
}

function yearToWords(y: number): string | null {
  if (y < 1000 || y > 9999) return null
  if (y >= 2000 && y < 2100) {
    const lo = y % 100
    return lo ? `two thousand ${belowThousand(lo)}` : 'two thousand'
  }
  const hi = Math.floor(y / 100)
  const lo = y % 100
  return lo === 0 ? `${belowThousand(hi)} hundred` : `${belowThousand(hi)} ${belowThousand(lo)}`
}

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]

/** Unit suffixes → spoken units (singular/plural). Lowercased keys. */
const UNIT_MAP: Record<string, { s: string; p: string }> = {
  ms: { s: 'millisecond', p: 'milliseconds' },
  s: { s: 'second', p: 'seconds' },
  sec: { s: 'second', p: 'seconds' },
  min: { s: 'minute', p: 'minutes' },
  h: { s: 'hour', p: 'hours' },
  hr: { s: 'hour', p: 'hours' },
  d: { s: 'day', p: 'days' },
  km: { s: 'kilometre', p: 'kilometres' },
  m: { s: 'metre', p: 'metres' },
  cm: { s: 'centimetre', p: 'centimetres' },
  mm: { s: 'millimetre', p: 'millimetres' },
  mi: { s: 'mile', p: 'miles' },
  kg: { s: 'kilogram', p: 'kilograms' },
  g: { s: 'gram', p: 'grams' },
  kb: { s: 'kilobyte', p: 'kilobytes' },
  mb: { s: 'megabyte', p: 'megabytes' },
  gb: { s: 'gigabyte', p: 'gigabytes' },
  tb: { s: 'terabyte', p: 'terabytes' },
  ghz: { s: 'gigahertz', p: 'gigahertz' },
  mhz: { s: 'megahertz', p: 'megahertz' },
}

/** Small spoken map for the most common emoji; everything else is dropped. */
const EMOJI_SPOKEN: Record<string, string> = {
  '👍': 'thumbs up',
  '👎': 'thumbs down',
  '✅': 'done',
  '❤️': 'love',
  '⚠️': 'warning',
}

/** Speak a URL's domain: "https://github.com/x/y" → "github dot com link". */
function spokenUrl(url: string): string {
  const m = /^https?:\/\/(?:www\.)?([^/\s:?#]+)/i.exec(url)
  if (!m) return 'a link'
  const host = m[1]!
  // Only verbalize simple dotted hostnames; an IP or userinfo-laden host
  // reads badly — fall back to "a link".
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return 'a link'
  }
  return `${host.toLowerCase().split('.').join(' dot ')} link`
}

function parkInline(text: string): {
  parked: string
  parts: Array<{ idx: number; raw: string }>
} {
  const parts: Array<{ idx: number; raw: string }> = []
  const parked = text.replace(/`([^`\n]+)`/g, (_m, content: string) => {
    const idx = parts.length
    // Park the CONTENT (backticks already dropped) so the spoken output
    // reads the identifier as-is and no later pass can rewrite it.
    parts.push({ idx, raw: content })
    return `${INLINE_PH}${idx}${NULL}`
  })
  return { parked, parts }
}

function restoreInline(text: string, parts: Array<{ idx: number; raw: string }>): string {
  let restored = text
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!
    restored = restored.replace(`${INLINE_PH}${p.idx}${NULL}`, () => p.raw)
  }
  return restored
}

/**
 * Normalize reply text for TTS. Pure + deterministic; returns the input
 * unchanged when the feature flag is off, the kill switch is on, or the
 * input is empty.
 */
export function normalizeForTts(text: string): string {
  if (!ttsNormalizeEnabled() || text.length === 0) return text

  let s = text.replace(/\r\n?/g, '\n')

  // -- HTML entities → char, then backslash escapes → the escaped char. The
  //    last line of defence at the /tts body build: the Listen lazy path and
  //    the pre-synth queue can synthesize from cache entries that predate the
  //    normalizeForSpeech coverage, so these must be stripped here too. Both
  //    are idempotent — if normalizeForSpeech already ran there is nothing
  //    left to decode/unescape. Without this the engine speaks `\b` as
  //    "backslash b" and `&amp;` as "amp".
  s = decodeHtmlEntities(s)
  s = stripBackslashEscapes(s)

  // -- Code fences → spoken placeholder (before anything can see contents).
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '$1code block omitted.')
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/g, '$1code block omitted.')

  // -- Park inline code (content spoken as-is, backticks gone).
  const { parked, parts } = parkInline(s)
  s = parked
  s = s.replace(/`/g, '') // residual unpaired backticks

  // -- Markdown tables → "table omitted." A table block = consecutive lines
  //    with pipes that include a separator row (|---|---|).
  s = s.replace(
    /(?:^|\n)((?:[ \t]*\|[^\n]*\n)?[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*(?:\n[ \t]*\|[^\n]*)*)/g,
    '\ntable omitted.',
  )

  // -- Images / links → text; autolinks + bare URLs → spoken domain.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/<(https?:\/\/[^>\s]+)>/gi, (_m, url: string) => spokenUrl(url))
  s = s.replace(/\bhttps?:\/\/[^\s)]+/gi, (m) => spokenUrl(m))

  // -- Emoji: speak the small common map, drop everything else.
  for (const [emoji, spoken] of Object.entries(EMOJI_SPOKEN)) {
    s = s.split(emoji).join(` ${spoken} `)
  }
  s = s.replace(
    /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2B50}]/gu,
    '',
  )

  // -- Emphasis markers (paired forms, longest first), strikethrough.
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
  s = s.replace(/___(.+?)___/g, '$1')
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
  s = s.replace(/__(.+?)__/g, '$1')
  s = s.replace(/\*(.+?)\*/g, '$1')
  s = s.replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/g, '$1')
  s = s.replace(/~~(.+?)~~/g, '$1')

  // -- Block markup per line: headings, blockquote '>' markers, list
  //    markers, horizontal rules.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  s = s.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')
  s = s.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '')
  s = s.replace(/^[ \t]{0,3}([-_*])\1{2,}[ \t]*$/gm, '')

  // -- ISO dates YYYY-MM-DD → "July fourth two thousand twenty-six".
  //    MUST run before the phone-run pass (an ISO date is 8 digits with
  //    hyphens and would otherwise be read digit-by-digit).
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, da: string) => {
    const month = Number(mo)
    const day = Number(da)
    if (month < 1 || month > 12 || day < 1 || day > 31) return m
    const yw = yearToWords(Number(y))
    const dw = ordinalToWords(day)
    if (!yw || !dw) return m
    return `${MONTHS[month]} ${dw} ${yw}`
  })

  // -- Phone-like digit runs → digit-by-digit. Fires ONLY on clearly
  //    phone-shaped tokens: a leading + (international), or a leading 0
  //    (national) with separator-delimited 2-4-digit grouping; 7-15
  //    digits total. Ordinary space-separated numbers ("1024 2048 4096")
  //    and short groupings without a phone prefix ("12 34 56 78") stay
  //    untouched.
  s = s.replace(/(?<![\w.])(\+?\d[\d\- ]{6,}\d)(?![\w.])/g, (m: string) => {
    const digits = m.replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) return m
    const groups = m.replace(/^\+/, '').split(/[- ]+/)
    const phoneShaped =
      m.startsWith('+') ||
      (m.startsWith('0') &&
        groups.length >= 2 &&
        groups.every((g) => /^\d{2,4}$/.test(g)))
    if (!phoneShaped) return m
    const words: string[] = []
    if (m.startsWith('+')) words.push('plus')
    for (const ch of digits) words.push(ONES[Number(ch)]!)
    return words.join(' ')
  })

  // -- Times HH:MM (24h) → spoken. The (?<![\d:]) / (?!:?\d) guards skip
  //    HH:MM:SS entirely — a half-spoken time with a dangling ":46" reads
  //    worse than leaving the digits as-is. The LOOKBEHIND is load-bearing:
  //    without it the scan re-anchors INSIDE the timestamp (`09:00:00` →
  //    "09:zero o'clock") because the trailing `00` is itself a legal HH:MM.
  s = s.replace(/(?<![\d:])\b([01]?\d|2[0-3]):([0-5]\d)(?!:?\d)/g, (_m, hh: string, mm: string) => {
    const h = Number(hh)
    const min = Number(mm)
    const hw = belowThousand(h)
    if (min === 0) return `${hw} o'clock`
    if (min < 10) return `${hw} oh ${ONES[min]}`
    return `${hw} ${belowThousand(min)}`
  })

  // -- Currency: $5 → "five dollars"; $5.20 → "five dollars twenty";
  //    $1,000 → "one thousand dollars" (thousands separators consumed).
  //    The trailing lookahead bails on odd-cents ("$5.203") and partial
  //    thousands ("$1,00") — the whole token is left unchanged rather
  //    than half-read.
  s = s.replace(
    /\$(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{2}))?(?![\d,]|\.\d)/g,
    (m, dollarsRaw: string, cents?: string) => {
      const dollars = Number(dollarsRaw.replace(/,/g, ''))
      const dw = numberToWords(dollars)
      if (!dw) return m
      const noun = dollars === 1 && !cents ? 'dollar' : 'dollars'
      if (cents && cents !== '00') {
        const cw = numberToWords(Number(cents))
        if (!cw) return m
        return `${dw} ${noun} ${cw}`
      }
      return `${dw} ${noun}`
    },
  )

  // -- Percentages: 12% → "twelve percent"; 3.5% keeps digits + "percent".
  s = s.replace(/\b(\d{1,9})%/g, (m, n: string) => {
    const w = numberToWords(Number(n))
    return w ? `${w} percent` : m
  })
  s = s.replace(/(\d)\s*%/g, '$1 percent')

  // -- Ordinals: 3rd → "third" (guarded to matching suffix only).
  s = s.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, (m, n: string, suffix: string) => {
    const num = Number(n)
    const correct =
      (num % 10 === 1 && num % 100 !== 11 && suffix.toLowerCase() === 'st') ||
      (num % 10 === 2 && num % 100 !== 12 && suffix.toLowerCase() === 'nd') ||
      (num % 10 === 3 && num % 100 !== 13 && suffix.toLowerCase() === 'rd') ||
      (suffix.toLowerCase() === 'th' &&
        !((num % 10 === 1 && num % 100 !== 11) || (num % 10 === 2 && num % 100 !== 12) || (num % 10 === 3 && num % 100 !== 13)))
    if (!correct) return m
    const w = ordinalToWords(num)
    return w ?? m
  })

  // -- Number + unit suffix glued to the number (500ms, 5km, 10GB). Only a
  //    known unit bounded by a non-letter, so identifiers never match.
  //
  //    The leading `(?<![\d.,])` lookbehind is load-bearing: without it
  //    `\b` is satisfied between a decimal point (or thousands comma) and
  //    the digits that follow, so "17s" inside "0.17s" — or "500s" inside
  //    "1,500s" — would match on its own and mangle the number ("0.17s" →
  //    "0.seventeen seconds"; "1,500s" → "1,five hundred seconds"). Excludes
  //    both `.` and `,` so a glued decimal/thousands-separated number is
  //    never re-anchored on. Multi-letter units (ms, GB, …) stay
  //    case-insensitive since `5MB`/`500ms` must keep working regardless of
  //    case; single-letter units (s, m, h, d, g) are matched
  //    case-sensitively lowercase-only in a second pass — the single letter
  //    "M" is one keystroke from meaning "million" in prose ("$5M",
  //    "Revenue was 5M") and must never fall through to "minutes" just
  //    because the whole alternation ran under /i.
  //
  //    KNOWN GAP, disclosed deliberately (2026-08, hotfix for #2760-derived
  //    corpus regression): a decimal- or comma-glued number with a unit
  //    (27.5s, 1,500s, 89.5g, 0.7-0.8m) is now left completely UNEXPANDED —
  //    the unit goes unspoken — rather than mangled the way it was before.
  //    Corpus-measured: samples carrying a digit-adjacent unspoken unit go
  //    65 → 122 (61 samples change under this fix, every one gaining an
  //    unspoken unit). Correctly expanding a decimal/comma-glued number is
  //    explicitly out of scope for this narrow hotfix — see the pinning
  //    tests below (13.0 GB / 89.5g / 27.5 s) marking the baseline for a
  //    follow-up decimal-expansion pass.
  //
  //    ASYMMETRY WITH pass 1 (voice-normalize-text.ts), pre-existing and
  //    NOT introduced by this fix: this pass allows an optional space
  //    (`\s?`) between the number and the unit and maps `m` to METRE; pass
  //    1 has no `\s?` and maps `m` to MINUTE. That accident is exactly what
  //    makes "5m" (no space) come out of pass 1 as minutes and "16 m"
  //    (space) come out of pass 2 as metres in the composed pipeline —
  //    pinned by the composed-pipeline test in the test suite.
  const unitReplacer = (m: string, num: string, unitRaw: string): string => {
    const unit = UNIT_MAP[unitRaw.toLowerCase()]
    if (!unit) return m
    const n = Number(num)
    const w = numberToWords(n)
    if (!w) return m
    return `${w} ${n === 1 ? unit.s : unit.p}`
  }
  s = s.replace(
    /(?<![\d.,])\b(\d{1,9})\s?(ms|sec|min|km|cm|mm|kg|kb|mb|gb|tb|ghz|mhz|hr|mi)(?![a-zA-Z])/gi,
    unitReplacer,
  )
  s = s.replace(
    /(?<![\d.,])\b(\d{1,9})\s?(s|m|h|d|g)(?![a-zA-Z])/g,
    unitReplacer,
  )

  // -- Symbols in prose.
  s = s.replace(/(\s)&(\s)/g, '$1and$2')
  s = s.replace(/(\w)&(\w)/g, '$1 and $2')
  s = s.replace(/(^|\s)@(\w)/g, '$1at $2')
  s = s.replace(/(^|\s)#(\w)/g, '$1hash $2')
  // word/word in prose → "word slash word" (letters only, so paths/dates
  // with digits are untouched).
  s = s.replace(/\b([a-zA-Z]{2,})\/([a-zA-Z]{2,})\b/g, '$1 slash $2')
  // ~ before a number → "about"; other tildes dropped.
  s = s.replace(/~\s*(\d)/g, 'about $1')
  s = s.replace(/~/g, '')
  // Arrows → "to".
  s = s.replace(/[=-]>/g, ' to ')
  s = s.replace(/[→⇒]/g, ' to ')

  // -- Restore parked inline-code contents verbatim.
  s = restoreInline(s, parts)

  // -- Whitespace → sentence flow.
  s = s.replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '. ')
  s = s.replace(/\s*\n\s*/g, ' ')
  s = s.replace(/[ \t]{2,}/g, ' ')
  s = s.replace(/\.\s*\.(\s|$)/g, '.$1')
  s = s.replace(/\s+([,.!?;:])/g, '$1')

  return s.trim()
}
