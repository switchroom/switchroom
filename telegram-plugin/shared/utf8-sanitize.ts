/**
 * Wire-level UTF-8 sanitiser (#4728).
 *
 * ── The failure this exists to stop ───────────────────────────────────────
 *
 * A JavaScript string is UTF-16, and UTF-16 permits a LONE SURROGATE — a high
 * (`\uD800`-`\uDBFF`) or low (`\uDC00`-`\uDFFF`) code unit with no partner.
 * A lone surrogate has NO valid UTF-8 encoding. `JSON.stringify` does not
 * throw on one (well-formed `JSON.stringify`, ES2019): it emits the `\udXXX`
 * escape, so grammy happily POSTs a body Telegram's decoder then rejects with
 *
 *     400 Bad Request: strings must be encoded in UTF-8
 *
 * Observed in production on 2026-07-31 (agent `gymbro`, twice): a
 * `permission_request` approval card 400'd on `sendRichMessage` with exactly
 * that description and the operator never saw the card. An approval card is
 * the human safety boundary for a gated tool call — a dropped card means a
 * gated action silently never happens.
 *
 * ── Why HERE and not in the card formatter ────────────────────────────────
 *
 * The plugin already repairs a *trailing* high surrogate at each of its
 * truncation sites (`card-layout.ts:384`, `format.ts:1551`,
 * `tool-activity-summary.ts:488`, `reply-quote.ts:78`). Every one of those is
 * a per-cut patch that (a) only covers the cut it guards and (b) only covers
 * the HIGH half — an orphaned LOW surrogate, or a lone surrogate that entered
 * the body from upstream data (a tool `input_preview`, a file path, a
 * model-emitted token) rather than from a cut, sails straight through all of
 * them onto the wire. So the repair belongs at the ONE place every outbound
 * call must transit: the grammy API-transformer layer, which no `ctx.*`
 * helper and no raw `bot.api.*` call can bypass
 * (see `shared/bot-runtime.ts` header).
 *
 * The sanitiser walks the WHOLE payload, not a named field list, because a
 * lone surrogate anywhere in the JSON body fails the whole request — inline
 * keyboard button labels (`reply_markup`, which every approval card carries),
 * captions, `rich_message.markdown` and plain `text` alike.
 *
 * Substitution is U+FFFD REPLACEMENT CHARACTER rather than deletion: it is
 * the Unicode-standard substitution, and it is length-preserving in UTF-16
 * code units, so a body that was sized against a char budget upstream cannot
 * be pushed over that budget by the repair.
 */

import type { Bot } from 'grammy'

/**
 * Matches a code unit that is a surrogate with no partner:
 * a high surrogate not followed by a low one, or a low surrogate not
 * preceded by a high one. A well-formed pair matches neither alternative.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** True when `s` contains at least one unpaired surrogate. */
export function hasLoneSurrogate(s: string): boolean {
  LONE_SURROGATE.lastIndex = 0
  return LONE_SURROGATE.test(s)
}

/**
 * How many unpaired surrogate code units `s` carries. Safe to call on the
 * shared `/g` regex: `String.prototype.match` with a global pattern resets
 * `lastIndex` to 0 itself before it collects, so this cannot leak state into
 * `hasLoneSurrogate`.
 */
function countLoneSurrogates(s: string): number {
  return (s.match(LONE_SURROGATE) ?? []).length
}

/**
 * Replace every unpaired surrogate in `s` with U+FFFD. Returns the SAME
 * string instance when there is nothing to repair, so callers can use
 * identity to detect a no-op. Idempotent: U+FFFD is not a surrogate.
 */
export function sanitizeLoneSurrogates(s: string): string {
  if (!hasLoneSurrogate(s)) return s
  return s.replace(LONE_SURROGATE, '�')
}

/**
 * True for a value we may safely recurse into and rebuild: a plain object or
 * an array. Anything else (an `InputFile`, a `Buffer`, a stream, a `Date`,
 * a class instance) is returned untouched — rebuilding it would destroy its
 * prototype and grammy's multipart layer depends on those identities.
 */
function isWalkable(v: unknown): v is Record<string, unknown> | unknown[] {
  if (Array.isArray(v)) return true
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Depth cap: Telegram payloads are shallow (deepest real nesting is
 * `reply_markup.inline_keyboard[][]`, depth 3). The cap is a cheap guard
 * against a pathological or cyclic input, never reached in practice. */
const MAX_DEPTH = 16

/** Mutable tally threaded through the walk so the caller can log HOW MANY
 * code units were repaired without ever seeing the content itself. */
export interface SanitizeStats {
  /** Total unpaired surrogate code units replaced with U+FFFD. */
  repaired: number
}

/**
 * Deep-sanitise every string in `value`, CLONE-ON-WRITE: the input is never
 * mutated, and the exact same instance is returned when nothing changed (so
 * the common case allocates nothing).
 *
 * Pass `stats` to collect the repair count.
 */
export function sanitizePayloadStrings<T>(value: T, depth = 0, stats?: SanitizeStats): T {
  if (typeof value === 'string') {
    const next = sanitizeLoneSurrogates(value)
    if (stats && next !== value) stats.repaired += countLoneSurrogates(value)
    return next as unknown as T
  }
  if (depth >= MAX_DEPTH || !isWalkable(value)) return value

  if (Array.isArray(value)) {
    let changed = false
    const out = value.map(item => {
      const next = sanitizePayloadStrings(item, depth + 1, stats)
      if (next !== item) changed = true
      return next
    })
    return (changed ? out : value) as unknown as T
  }

  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    const next = sanitizePayloadStrings(v, depth + 1, stats)
    if (next !== v) changed = true
    // `out[k] = next` would REASSIGN the clone's prototype for the single key
    // `__proto__` (the `Object.prototype` accessor), silently dropping an own
    // `__proto__` key from the payload. defineProperty always makes an own
    // data property, for that key like any other.
    Object.defineProperty(out, k, {
      value: next,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return (changed ? out : value) as unknown as T
}

/** One log line per method per minute. The draft-stream `editMessageText`
 * path edits the same card many times a second, so an upstream that is
 * PERSISTENTLY corrupt would otherwise emit a line per edit and drown the
 * gateway log in the exact situation you most need to read it. */
const LOG_THROTTLE_MS = 60_000
const lastLoggedAtByMethod = new Map<string, number>()

/** Test seam: drop the throttle state so a suite can observe the first line
 * of a fresh window. Not used in production. */
export function __resetUtf8SanitizeLogThrottle(): void {
  lastLoggedAtByMethod.clear()
}

/** True when this method may log now; records the emission when it may. */
function shouldLogRepair(method: string, now: number): boolean {
  const last = lastLoggedAtByMethod.get(method)
  if (last !== undefined && now - last < LOG_THROTTLE_MS) return false
  lastLoggedAtByMethod.set(method, now)
  return true
}

/**
 * Install the UTF-8 sanitiser as a grammy API transformer.
 *
 * MUST be installed FIRST, before every other transformer: grammy composes
 * `call = trans(prev, ...)` (`grammy/out/core/client.js:9-11,91`), so the
 * LAST-installed transformer is the OUTERMOST and the FIRST-installed is the
 * INNERMOST — the one that sees the final payload immediately before it is
 * serialised and POSTed. Anything installed after this one can therefore not
 * reintroduce a lone surrogate behind its back.
 *
 * A repair is logged with the method and the repaired code-unit COUNT — never
 * the body, which may carry operator content — so a corrupt upstream producer
 * stays diagnosable instead of being silently papered over. The line is
 * throttled to once per method per minute.
 *
 * The sanitise call FAILS OPEN. It runs on the innermost hop of every single
 * `bot.api.*` call, and its object walk reads own enumerable properties —
 * which invokes getters. A throwing getter, or any future bug in the walk,
 * would otherwise propagate out of every outbound call and wedge the whole
 * gateway. Sending the original payload is never worse than throwing: the
 * worst case is the pre-#4728 behaviour (Telegram 400s that one send), while
 * throwing here breaks sends that had nothing wrong with them.
 */
export function installUtf8Sanitizer(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    let clean = payload
    const stats: SanitizeStats = { repaired: 0 }
    try {
      clean = sanitizePayloadStrings(payload, 0, stats)
    } catch {
      clean = payload
    }
    if (clean !== payload && shouldLogRepair(method, Date.now())) {
      process.stderr.write(
        `telegram gateway: utf8-sanitize repaired ${stats.repaired} lone surrogate(s) ` +
        `method=${method} — body would have been rejected by Telegram ` +
        `(400 "strings must be encoded in UTF-8")\n`,
      )
    }
    return prev(method, clean, signal)
  })
}
