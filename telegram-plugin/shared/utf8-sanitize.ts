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
 * Define `k` as an own enumerable data property of `out`.
 *
 * `out[k] = v` would REASSIGN the clone's prototype for the single key
 * `__proto__` (the `Object.prototype` accessor), silently dropping an own
 * `__proto__` key from the payload. defineProperty always makes an own data
 * property, for that key like any other.
 */
function defineOwn(out: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(out, k, {
    value: v,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

/**
 * Deep-sanitise every string in `value`, CLONE-ON-WRITE: the input is never
 * mutated, and the exact same instance is returned when nothing changed.
 *
 * The clone is materialised LAZILY, on the first key/index that actually
 * changed — so a clean payload allocates no container and performs no
 * property definition at any depth, it is only walked and handed back by
 * identity. That matters: this runs on the innermost hop of EVERY `bot.api.*`
 * call, including the draft-stream `editMessageText` path that edits the same
 * card several times a second, and the overwhelming majority of payloads are
 * clean. (Pinned by the "clean nested payload" test, which fails if any
 * container is rebuilt.)
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
    let out: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      const next = sanitizePayloadStrings(item, depth + 1, stats)
      // First change: copy the already-walked prefix, all of it unchanged.
      if (out === undefined && next !== item) out = value.slice(0, i)
      if (out !== undefined) out.push(next)
    }
    return (out ?? value) as unknown as T
  }

  // `for...in` rather than `Object.entries`, so the clean path allocates no
  // key/entry array either. The `hasOwnProperty` guard keeps this EXACTLY
  // equivalent to `Object.entries`: `for...in` also yields INHERITED
  // enumerable keys, so without it a polluted `Object.prototype` would leak an
  // extra field into the body we hand to Telegram.
  const hasOwn = Object.prototype.hasOwnProperty
  let out: Record<string, unknown> | undefined
  for (const k in value) {
    if (!hasOwn.call(value, k)) continue
    const v = (value as Record<string, unknown>)[k]
    const next = sanitizePayloadStrings(v, depth + 1, stats)
    if (out === undefined && next !== v) {
      // First change: materialise the clone and backfill the keys already
      // walked, every one of which came back unchanged. This re-reads those
      // properties (so an own getter in the prefix is invoked twice), which
      // only ever happens on the repair path — a payload with an own getter
      // AND a lone surrogate. Telegram payloads are plain data; a getter that
      // throws is caught by the fail-open guard in `installUtf8Sanitizer`.
      out = {}
      for (const prev in value) {
        if (prev === k) break
        if (!hasOwn.call(value, prev)) continue
        defineOwn(out, prev, (value as Record<string, unknown>)[prev])
      }
    }
    if (out !== undefined) defineOwn(out, k, next)
  }
  return (out ?? value) as unknown as T
}

/** One log line per method per minute. The draft-stream `editMessageText`
 * path edits the same card many times a second, so an upstream that is
 * PERSISTENTLY corrupt would otherwise emit a line per edit and drown the
 * gateway log in the exact situation you most need to read it. */
const LOG_THROTTLE_MS = 60_000

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
 * throwing here breaks sends that had nothing wrong with them. It is not
 * silent, though: failing open logs its own throttled line naming the method,
 * so the degraded state stays diagnosable.
 *
 * `now` is an injected clock so the throttle can be driven deterministically
 * from a test: this file runs under BOTH vitest and `bun test`, and bun's
 * `vi` has no `setSystemTime`.
 */
export function installUtf8Sanitizer(bot: Bot, now: () => number = Date.now): void {
  // Throttle state is per-install, not module-global, so one bot's log budget
  // cannot be consumed by another (and a test needs no reset hook).
  const lastLoggedAtByMethod = new Map<string, number>()
  const shouldLogRepair = (method: string, at: number): boolean => {
    const last = lastLoggedAtByMethod.get(method)
    if (last !== undefined && at - last < LOG_THROTTLE_MS) return false
    lastLoggedAtByMethod.set(method, at)
    return true
  }

  bot.api.config.use(async (prev, method, payload, signal) => {
    let clean = payload
    const stats: SanitizeStats = { repaired: 0 }
    try {
      clean = sanitizePayloadStrings(payload, 0, stats)
    } catch (err) {
      clean = payload
      // Fail open, but never SILENTLY: without this line a future walk bug or
      // a genuinely throwing getter degrades to a bare Telegram 400 with no
      // trail back to the sanitiser — precisely the opacity #4728 exists to
      // end. Throttled on its own budget (a distinct key), so a persistent
      // walk failure cannot be starved by, or starve, the repair line above.
      // The error MESSAGE is included because without it the line cannot
      // diagnose anything; the payload body still never is.
      // The separator is written as the ESCAPE "backslash-u-0000", never as a raw NUL
      // byte: a literal 0x00 in a source file trips the #3676 binary-file
      // guard (tests/source-files-are-text.test.ts) and blocks the merge
      // queue. The runtime key is identical either way.
      if (shouldLogRepair(`${method}\u0000sanitize-failed`, now())) {
        process.stderr.write(
          `telegram gateway: utf8-sanitize FAILED OPEN method=${method} — ` +
          `payload sent unrepaired; if it carries a lone surrogate Telegram ` +
          `will reject it (400 "strings must be encoded in UTF-8"): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    }
    if (clean !== payload && shouldLogRepair(method, now())) {
      process.stderr.write(
        `telegram gateway: utf8-sanitize repaired ${stats.repaired} lone surrogate(s) ` +
        `method=${method} — body would have been rejected by Telegram ` +
        `(400 "strings must be encoded in UTF-8")\n`,
      )
    }
    return prev(method, clean, signal)
  })
}
