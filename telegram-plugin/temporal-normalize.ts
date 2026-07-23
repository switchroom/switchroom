/**
 * temporal-normalize.ts — deterministic outbound temporal normalization (#3501).
 *
 * Two independent, idempotent rewrites applied to outbound Telegram prose, in
 * the shared `normalizeOutboundBody` seam (after redact/punctuation/bold,
 * before the voice scrub):
 *
 *   1. UTC/Zulu datetimes → the agent's LOCAL wall clock. A raw
 *      `2026-07-23T09:15:00Z` (or `…+00:00`, or a `14:00 UTC` / `2 pm GMT`
 *      label) is rewritten to `Thu 23 Jul 7:15 pm AEST` — DST-correct by
 *      construction (Intl resolves the per-instant offset) — so the operator
 *      never has to translate UTC in their head, and the model can never re-read
 *      its own outbound as "now in UTC".
 *
 *   2. Relative-day accuracy. A relative day word (today / tomorrow / yesterday /
 *      tonight / this morning|afternoon|evening) written ADJACENT to an absolute
 *      date is checked against the current date in the agent's configured TZ and
 *      corrected if wrong. The incident: a cron notification said "closed
 *      tomorrow (Thu 23 Jul)" when today WAS Thursday 23 Jul — it should read
 *      "closed today (Thu 23 Jul)". A relative word with NO adjacent absolute
 *      date is left untouched.
 *
 * Design constraints (all enforced here):
 *   - Pure over its arguments — `tz` and `nowMs` are passed in (callers use
 *     `resolveEnvTimezone()` and `Date.now()`); NO env / clock read here.
 *   - Never-throw: a bad/unresolvable IANA `tz` degrades to the INPUT unchanged
 *     rather than crashing a turn (mirrors `fmtLocalStamp`'s contract).
 *   - Intl-only: ZERO date libraries — reuses `localDay` / `tzAbbrev` from
 *     shared/local-time.ts.
 *   - False-positive guard: code fences, inline code, markdown link hrefs, and
 *     angle-bracket autolinks are masked before either pass, so an ISO string in
 *     a log / URL / code span is never rewritten. Blockquote (`>`) lines are
 *     excluded too — forwarded/quoted third-party text is left verbatim.
 *   - Idempotent: the UTC output carries no Z/UTC/GMT token (the detector can't
 *     re-match it); the relative-day output is a fixed point once the word and
 *     date agree.
 */

import { localDay, tzAbbrev } from './shared/local-time.js'

// ── Combined false-positive masker ─────────────────────────────────────────
// Covers the SAME regions normalizePunctuation protects (fenced blocks, inline
// code, `](href)` link destinations, `<scheme:…>` autolinks) — lifted here as a
// single shared masker because `maskCodeRegions` (format.ts) alone does NOT
// cover link hrefs / autolinks (that logic lives inline inside normalizePunctuation).
interface MaskedRegions {
  masked: string
  restore: (s: string) => string
}

function maskTemporalRegions(text: string): MaskedRegions {
  const nonce = Math.random().toString(36).slice(2)
  const PH = `\x00TN${nonce}_`
  const masks: string[] = []
  const push = (s: string): string => {
    masks.push(s)
    return `${PH}${masks.length - 1}\x00`
  }
  const masked = text
    // Fenced blocks first, only when CLOSED (matching ```), so an unclosed
    // fence is left intact rather than misparsed by the inline pass.
    .replace(/```[\s\S]*?```/g, (m) => push(m))
    // Inline code spans.
    .replace(/`[^`\n]+`/g, (m) => push(m))
    // Markdown inline-link DESTINATIONS `](href)` — only the href inside the
    // parens is masked; the visible label still normalizes like prose.
    .replace(/(\]\()([^)\n]*)(\))/g, (_m, open: string, href: string, close: string) =>
      `${open}${push(href)}${close}`,
    )
    // GFM angle-bracket autolink destinations `<scheme:…>`.
    .replace(/(<)([a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*)(>)/g, (_m, lt: string, uri: string, gt: string) =>
      `${lt}${push(uri)}${gt}`,
    )
  const esc = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\x00TN${esc}_(\\d+)\x00`, 'g')
  const restore = (s: string): string => s.replace(re, (_m, idx: string) => masks[Number(idx)] ?? _m)
  return { masked, restore }
}

/** A blockquote line (mirrors format.ts `isBlockquoteLine`). */
function isBlockquoteLine(line: string): boolean {
  return line.trimStart().startsWith('>')
}

/** Run a per-line transform on masked text, leaving blockquote lines verbatim. */
function perNonQuoteLine(masked: string, fn: (line: string) => string): string {
  return masked
    .split('\n')
    .map((line) => (isBlockquoteLine(line) ? line : fn(line)))
    .join('\n')
}

// ── Local rendering ─────────────────────────────────────────────────────────

/** `Thu 23 Jul` — weekday + day + short month in `tz`, no locale punctuation. */
function renderLocalDate(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(new Date(ms))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')}`
}

/** `7:15 pm` — spaced, lowercased am/pm wall clock in `tz`. */
function renderLocalClock(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(ms))
    .replace(/\s([AP])M$/, (_m, p: string) => ` ${p.toLowerCase()}m`)
}

/** `Thu 23 Jul 7:15 pm AEST` — full local datetime for a converted instant. */
function renderLocalDatetime(ms: number, tz: string): string {
  return `${renderLocalDate(ms, tz)} ${renderLocalClock(ms, tz)} ${tzAbbrev(ms, tz)}`
}

// ── Pass 1: UTC / Zulu datetime → local ─────────────────────────────────────

// Full ISO-8601 with a Z or +00:00 zero-offset. Seconds + fractional seconds
// optional. The trailing marker guarantees the output (which carries none)
// cannot re-match — idempotent by construction.
const ISO_UTC_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|\+00:00)/g

// Labelled clock time tagged UTC/GMT. The minutes / am|pm are OPTIONAL in the
// pattern but the replacer REQUIRES at least one of them (colon-minutes OR
// am/pm) before converting — so a bare "5 GMT" (as in "9 to 5 GMT") is left
// untouched, matching the tightened grammar.
const LABELLED_UTC_RE = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)?\s?(UTC|GMT)\b/gi

function convertUtcInLine(line: string, tz: string, nowMs: number): string {
  let out = line.replace(ISO_UTC_RE, (m) => {
    const ms = Date.parse(m)
    if (Number.isNaN(ms)) return m
    return renderLocalDatetime(ms, tz)
  })
  out = out.replace(LABELLED_UTC_RE, (m, hh: string, mm: string | undefined, ampm: string | undefined) => {
    // Tightened grammar: require colon-minutes OR am/pm — reject bare "5 GMT".
    if (mm == null && ampm == null) return m
    let h = Number(hh)
    const pm = ampm != null && /pm/i.test(ampm)
    if (ampm != null) {
      if (h > 12) return m // "14 pm" is nonsensical — leave untouched
      if (h === 12) h = pm ? 12 : 0
      else if (pm) h += 12
    }
    if (h > 23) return m
    const minute = mm != null ? Number(mm) : 0
    if (minute > 59) return m
    const now = new Date(nowMs)
    // Interpret the labelled time as UTC on nowMs's UTC calendar date, then
    // render the LOCAL wall clock. No date is emitted (the source carried none).
    const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, minute)
    return `${renderLocalClock(ms, tz)} ${tzAbbrev(ms, tz)}`
  })
  return out
}

/**
 * Rewrite UTC/Zulu datetimes in `text` to the local wall clock in `tz`.
 * Pure / never-throws: an invalid `tz` (or any internal failure) returns the
 * input unchanged.
 */
export function normalizeUtcDatetimes(text: string, tz: string, nowMs: number): string {
  if (!text) return text
  try {
    // Fast-path: nothing that could be a UTC datetime.
    if (!/\d{4}-\d{2}-\d{2}T|\b(?:UTC|GMT)\b/i.test(text)) return text
    const { masked, restore } = maskTemporalRegions(text)
    const out = perNonQuoteLine(masked, (line) => convertUtcInLine(line, tz, nowMs))
    return restore(out)
  } catch {
    return text
  }
}

// ── Pass 2: relative-day accuracy ───────────────────────────────────────────

const REL = '(today|tonight|this\\s+morning|this\\s+afternoon|this\\s+evening|tomorrow|yesterday)'
// A small, strict separator set: whitespace / commas, an optional "on ", and an
// optional opening paren. Bounded (only spaces/commas), so the effective window
// stays small — no `.{0,15}` wildcard that could swallow arbitrary prose.
const SEP = '([\\s,]*(?:on\\s+)?\\(?\\s*)'
const WD = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*'
const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*'
// One optional weekday token (captured, with its trailing separator), then one
// absolute-date core (captured whole; re-parsed in the replacer).
const WD_GROUP = `((?:${WD})[\\s,]+)?`
const DATE_CORE =
  `((?:\\d{1,2}\\s+${MON})|(?:${MON}\\s+\\d{1,2})|(?:\\d{4}-\\d{2}-\\d{2})|(?:\\d{1,2}\\/\\d{2}))`

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function buildRelRegex(): RegExp {
  return new RegExp(REL + SEP + WD_GROUP + DATE_CORE, 'gi')
}

interface ParsedDate {
  year: number | null
  month: number // 1-12
  day: number
}

/** Parse a matched absolute-date core into {year?, month, day}, or null. */
function parseDateCore(core: string): ParsedDate | null {
  let m: RegExpExecArray | null
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(core))) {
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  }
  if ((m = /^(\d{1,2})\/(\d{2})$/.exec(core))) {
    // DD/MM (fleet convention — matches the "23/07" nice-to-have).
    return { year: null, month: Number(m[2]), day: Number(m[1]) }
  }
  if ((m = /^(\d{1,2})\s+([a-z]+)$/i.exec(core))) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
    if (mon < 0) return null
    return { year: null, month: mon + 1, day: Number(m[1]) }
  }
  if ((m = /^([a-z]+)\s+(\d{1,2})$/i.exec(core))) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    if (mon < 0) return null
    return { year: null, month: mon + 1, day: Number(m[2]) }
  }
  return null
}

/** UTC-midnight day index for a Y-M-D (calendar-day math, DST-irrelevant). */
function dayIndex(y: number, mo1: number, d: number): number {
  return Math.floor(Date.UTC(y, mo1 - 1, d) / 86_400_000)
}

/** Resolve a possibly-yearless date to the occurrence nearest today-in-tz. */
function resolveYear(parsed: ParsedDate, todayY: number, todayIdx: number): number {
  if (parsed.year != null) return parsed.year
  let best = todayY
  let bestAbs = Infinity
  for (const y of [todayY - 1, todayY, todayY + 1]) {
    const diff = Math.abs(dayIndex(y, parsed.month, parsed.day) - todayIdx)
    if (diff < bestAbs) {
      bestAbs = diff
      best = y
    }
  }
  return best
}

/** Preserve the original casing pattern of a rewritten day word. */
function matchCase(sample: string, replacement: string): string {
  if (sample.length > 0 && sample[0] === sample[0].toUpperCase() && sample[0] !== sample[0].toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  }
  return replacement
}

const TIME_OF_DAY_RE = /^(tonight|this\s+)/i

function rewriteRelativeInLine(line: string, tz: string, nowMs: number): string {
  const today = localDay(nowMs, tz) // YYYY-MM-DD (throws first on a bad tz)
  const [ty, tm, td] = today.split('-').map(Number)
  const todayIdx = dayIndex(ty, tm, td)

  return line.replace(buildRelRegex(), (full, rel: string, sep: string, wdGroup: string | undefined, core: string) => {
    const parsed = parseDateCore(core)
    if (parsed == null) return full
    const year = resolveYear(parsed, ty, todayIdx)
    const targetIdx = dayIndex(year, parsed.month, parsed.day)
    const diff = targetIdx - todayIdx

    // Out-of-range (|diff| > 1): leave the ENTIRE match untouched — do NOT
    // invent a word and do NOT auto-delete (open question 3 resolution).
    if (diff < -1 || diff > 1) return full

    const isTimeOfDay = TIME_OF_DAY_RE.test(rel)

    // Determine the corrected relative word.
    let newRel = rel
    if (isTimeOfDay) {
      // tonight / this morning|afternoon|evening are a correct SUBSET of today.
      // Only valid when the date resolves to today (diff==0); never remap them
      // to bare tomorrow/yesterday. Otherwise leave the whole match untouched.
      if (diff !== 0) return full
      // diff==0: the word is already correct — keep it verbatim.
    } else {
      const want = diff === 1 ? 'tomorrow' : diff === 0 ? 'today' : 'yesterday'
      newRel = matchCase(rel, want)
    }

    // Weekday repair: if a weekday token precedes the date and disagrees with
    // the true weekday of the resolved date in-tz, correct it.
    let newWdGroup = wdGroup
    if (wdGroup != null) {
      const trueDow = new Date(Date.UTC(year, parsed.month - 1, parsed.day)).getUTCDay()
      const trueShort = WEEKDAY_SHORT[trueDow]
      // Preserve the original separator tail after the weekday token.
      const wdMatch = /^([a-z]+)([\s,]+)$/i.exec(wdGroup)
      if (wdMatch != null) {
        const writtenShort = wdMatch[1].slice(0, 3).toLowerCase()
        if (writtenShort !== trueShort.toLowerCase()) {
          const wasLong = wdMatch[1].length > 3
          const corrected = wasLong ? longWeekday(trueDow) : trueShort
          newWdGroup = matchCase(wdMatch[1], corrected) + wdMatch[2]
        }
      }
    }

    return `${newRel}${sep}${newWdGroup ?? ''}${core}`
  })
}

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function longWeekday(dow: number): string {
  return WEEKDAY_LONG[dow]
}

/**
 * Correct relative-day words that are wrong for the absolute date they sit next
 * to, resolved against `nowMs` in `tz`. Pure / never-throws.
 */
export function normalizeRelativeDays(text: string, tz: string, nowMs: number): string {
  if (!text) return text
  try {
    if (!/\b(today|tonight|this\s+(?:morning|afternoon|evening)|tomorrow|yesterday)\b/i.test(text)) {
      return text
    }
    const { masked, restore } = maskTemporalRegions(text)
    const out = perNonQuoteLine(masked, (line) => rewriteRelativeInLine(line, tz, nowMs))
    return restore(out)
  } catch {
    return text
  }
}

/**
 * Convenience composition: UTC→local FIRST (so it produces absolute local
 * datetimes the relative-day pass can then check), THEN relative-day accuracy.
 * Pure / never-throws — each sub-pass degrades to its input on failure.
 */
export function normalizeTemporal(text: string, tz: string, nowMs: number): string {
  return normalizeRelativeDays(normalizeUtcDatetimes(text, tz, nowMs), tz, nowMs)
}
