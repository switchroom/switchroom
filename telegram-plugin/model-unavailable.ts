/**
 * model-unavailable.ts — graceful UX for the "model is down" failure modes.
 *
 * Issue #394 (Fix 2). When a user message hits Claude and the model is
 * unreachable — quota exhausted, overloaded / 429-storm, billing dead, or
 * the network simply timed out — the bridge used to relay Anthropic's raw
 * stderr verbatim ("You're out of extra usage · resets May 3, 11am"). The
 * desired UX is a clean ⚠️ card naming what failed and pointing at the
 * three actions that actually move the needle:
 *
 *   - /authfallback — auto-switch to next slot
 *   - /auth add     — attach another subscription
 *   - /usage        — full quota breakdown
 *
 * This module owns:
 *   1. `detectModelUnavailable(stderr)` — pattern-matches a raw error
 *      string into one of three structured kinds (overload / quota_exhausted
 *      / network), pulling out a reset Date when the source mentions one.
 *      Returns null on lines that don't look like a model-down event so
 *      callers can fall through to their default rendering.
 *   2. `formatModelUnavailableCard(detection, agent)` — renders the HTML
 *      card. Reset-time formatting routes through quota-check.ts's
 *      `formatResetRelative` so "/usage" and this card speak the same
 *      countdown dialect.
 *
 * Pure module: no IPC, no bot, no FS. Trivially unit-testable.
 */

import { formatResetRelative } from './quota-check.js'

// ─── Public types ────────────────────────────────────────────────────────────

export type ModelUnavailableKind = 'overload' | 'quota_exhausted' | 'network'

export interface ModelUnavailableDetection {
  kind: ModelUnavailableKind
  /** When the source mentions a reset window, parsed best-effort to a Date. */
  resetAt?: Date
  /** The raw stderr string that triggered the detection. */
  raw: string
}

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Inspect a raw stderr / error-message string for one of the known
 * model-unavailable patterns. Returns null when the line doesn't look
 * like one — never throws on weird input.
 *
 * Detection rules (matched in priority order):
 *   1. Quota / billing-style strings ("out of extra usage", "credit_balance_too_low",
 *      "usage limit", "quota exhausted") → quota_exhausted
 *   2. Overload / 429 / 5xx signals ("overloaded_error", "rate_limit_error",
 *      "HTTP 429", "Service Unavailable", "503", "529") → overload
 *   3. Network-layer failures (DNS, ECONNREFUSED, ETIMEDOUT, "fetch failed",
 *      "network error", "socket hang up") → network
 *
 * Quota strings can also carry a reset-time hint ("resets May 3, 11am",
 * "resets in 2h 15m", "retry after 60 seconds", ISO 8601). When present
 * and parseable, the Date is attached.
 */
export function detectModelUnavailable(
  stderr: string,
): ModelUnavailableDetection | null {
  if (typeof stderr !== 'string' || stderr.length === 0) return null
  // Defend against pathological input — anything beyond a few KB is almost
  // certainly not a clean error string and risks a regex stall.
  const sample = stderr.length > 16_384 ? stderr.slice(0, 16_384) : stderr
  const lower = sample.toLowerCase()

  // ── 1. Quota / billing exhaustion ──────────────────────────────────────
  const quotaSignals = [
    'out of extra usage',
    'extra usage',
    'credit_balance_too_low',
    'credit balance too low',
    'usage limit',
    'usage_limit',
    'quota exhausted',
    'quota_exhausted',
    'plan limit',
    'subscription limit',
    // Claude Code v2.1.x usage-limit wording: "You've hit your limit ·
    // resets 8:50am (Australia/Melbourne)".
    'hit your limit',
    'hit the limit',
    // SESSION-cap wording: "You've hit your session limit · resets 5pm".
    // A session cap is a quota exhaustion that frees in HOURS (its reset is a
    // bare time-of-day, see parseResetTime's time-only branch) — recognising
    // it here is what lets the time-only reset parse fire and keeps a
    // session-capped account from the +7d weekly bench.
    'session limit',
    'session cap',
  ]
  if (quotaSignals.some(s => lower.includes(s))) {
    const resetAt = parseResetTime(sample)
    return resetAt !== undefined
      ? { kind: 'quota_exhausted', resetAt, raw: stderr }
      : { kind: 'quota_exhausted', raw: stderr }
  }

  // ── 2. Overload / 429 / 5xx ────────────────────────────────────────────
  const overloadSignals = [
    'overloaded_error',
    'overloaded',
    'rate_limit_error',
    'rate limit',
    'rate-limited',
    'http 429',
    '"status":429',
    'status: 429',
    ' 429 ',
    '503 service',
    'service unavailable',
    '"status":529',
    'http 529',
    ' 529 ',
  ]
  if (overloadSignals.some(s => lower.includes(s))) {
    const resetAt = parseResetTime(sample)
    return resetAt !== undefined
      ? { kind: 'overload', resetAt, raw: stderr }
      : { kind: 'overload', raw: stderr }
  }

  // ── 3. Network-layer failure ───────────────────────────────────────────
  const networkSignals = [
    'econnrefused',
    'econnreset',
    'etimedout',
    'enotfound',
    'eai_again',
    'fetch failed',
    'network error',
    'socket hang up',
    'request timed out',
    'connection refused',
    'getaddrinfo',
  ]
  if (networkSignals.some(s => lower.includes(s))) {
    return { kind: 'network', raw: stderr }
  }

  return null
}

/**
 * Best-effort reset-time extraction. Tries, in order:
 *   - "retry after N seconds" / "retry-after: N"
 *   - "resets in 2h 15m" (relative — anchored at parseTimeNow)
 *   - "resets May 3, 11am" / "resets at May 3 11:00"
 *   - bare ISO-8601 timestamp anywhere in the string
 *
 * Returns undefined when nothing parseable is found. The `parseTimeNow`
 * arg lets tests pin the relative-clock anchor; production callers omit
 * it to use Date.now().
 */
function parseResetTime(text: string, parseTimeNow: Date = new Date()): Date | undefined {
  const lower = text.toLowerCase()

  // "retry after 60 seconds" / "retry-after: 60"
  const retryAfter = lower.match(/retry[\s-]*after[:\s]+(\d+)\s*(seconds?|s\b|minutes?|m\b|hours?|h\b)?/)
  if (retryAfter) {
    const n = Number(retryAfter[1])
    if (Number.isFinite(n) && n > 0 && n < 7 * 24 * 3600) {
      const unit = (retryAfter[2] ?? 'seconds').toLowerCase()
      const ms = unit.startsWith('h')
        ? n * 3600_000
        : unit.startsWith('m')
        ? n * 60_000
        : n * 1000
      return new Date(parseTimeNow.getTime() + ms)
    }
  }

  // "resets in 2h 15m" / "resets in 30 minutes"
  const relReset = lower.match(/resets?\s+in\s+([0-9hms\s]+)/)
  if (relReset) {
    const ms = parseRelativeDuration(relReset[1])
    if (ms != null) return new Date(parseTimeNow.getTime() + ms)
  }

  // ISO-8601 timestamp anywhere in the text
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/)
  if (iso) {
    const d = new Date(iso[0])
    if (!Number.isNaN(d.getTime())) return d
  }

  // "resets May 3, 11am" / "resets May 3 at 11:00"
  // Conservative regex — avoid greedy backtracking on long strings.
  const calReset = text.match(
    /resets?\s+(?:at\s+)?([A-Z][a-z]{2,8}\s+\d{1,2}(?:,?\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?))?)/,
  )
  if (calReset) {
    // Anchor to the current year — Anthropic's user-facing strings omit it.
    const candidate = `${calReset[1]} ${parseTimeNow.getUTCFullYear()}`
    const d = new Date(candidate)
    if (!Number.isNaN(d.getTime())) return d
  }

  // "resets 5pm (Australia/Melbourne)" / "resets 8:50am" / "resets 17:00 (UTC)"
  // SESSION-cap wording: a time of day with NO month/day. This frees in
  // HOURS, not a week — without this branch it falls through to undefined,
  // and the 429 inference path then applies resolveExhaustUntil's +7d weekly
  // floor, benching a session-capped account for a week. Must sit AFTER the
  // calendar branch so "resets May 3, 11am" never matches here. The leading
  // negative lookahead `(?!...)` rejects a month name so a date-bearing
  // string can't fall into this time-only branch.
  const timeOnly = text.match(
    /resets?\s+(?:at\s+)?(?!(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i,
  )
  if (timeOnly) {
    const d = resolveNextWallClock(
      Number(timeOnly[1]),
      timeOnly[2] ? Number(timeOnly[2]) : 0,
      timeOnly[3]?.toLowerCase(),
      timeOnly[4]?.trim(),
      parseTimeNow,
    )
    if (d != null) return d
  }

  return undefined
}

/**
 * Resolve a bare wall-clock time ("5pm", "8:50am", "17:00") to the NEXT
 * occurrence of that time, tz-aware. Returns the soonest future Date (rolls
 * to tomorrow when the time has already passed today). Null on bad input
 * (out-of-range hour/minute or an unknown tz). When `tz` is omitted the
 * time is interpreted in UTC (best-effort) — Anthropic's strings normally
 * carry the IANA tz in parens, e.g. "(Australia/Melbourne)".
 */
function resolveNextWallClock(
  hour12or24: number,
  minute: number,
  ampm: string | undefined,
  tz: string | undefined,
  nowDate: Date,
): Date | undefined {
  let hour = hour12or24
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  if (!Number.isFinite(hour) || hour > 23 || hour < 0) return undefined
  if (!Number.isFinite(minute) || minute > 59 || minute < 0) return undefined
  const nowMs = nowDate.getTime()
  // Walk today and the next two days (DST-safe span) and pick the first
  // occurrence strictly in the future relative to now.
  const base = new Date(nowMs)
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    // Derive the y/m/d for `dayOffset` days from now IN THE TARGET TZ, so the
    // wall-clock date we resolve is the tz's calendar date, not the container's.
    const dateParts = tzDateParts(new Date(nowMs + dayOffset * 86_400_000), tz)
    if (dateParts == null) return undefined
    const epoch = wallClockToEpoch(
      dateParts.year, dateParts.month, dateParts.day, hour, minute, tz,
    )
    if (epoch != null && epoch > nowMs) return new Date(epoch)
  }
  // Fallback: shouldn't happen, but keep the function total.
  void base
  return undefined
}

/** The y/m/d of `d` as seen in `tz` (UTC when tz omitted). Null on bad tz. */
function tzDateParts(
  d: Date,
  tz: string | undefined,
): { year: number; month: number; day: number } | null {
  if (!tz) {
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() }
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    })
    const parts = Object.fromEntries(
      fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    )
    return {
      year: Number(parts.year),
      month: Number(parts.month) - 1,
      day: Number(parts.day),
    }
  } catch {
    return null
  }
}

/**
 * Convert a wall-clock time in an IANA tz to epoch-ms (null if the tz is
 * unknown). Resolves the tz's offset AT that date via Intl, so it is correct
 * across DST — NOT `new Date(localString)`, which assumes the container TZ.
 * Mirrors wedge-watchdog.ts's helper of the same name (kept local to keep
 * this module dependency-free / pure-testable).
 */
function wallClockToEpoch(
  year: number, month: number, day: number, hour: number, minute: number, tz: string | undefined,
): number | null {
  const asUtc = Date.UTC(year, month, day, hour, minute, 0)
  if (!tz) return asUtc // no tz given → best-effort UTC
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(asUtc)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    )
    const shown = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    )
    const offset = shown - asUtc // how far ahead the tz wall clock is of UTC
    return asUtc - offset
  } catch {
    return null // unknown tz
  }
}

function parseRelativeDuration(s: string): number | null {
  // "2h 15m" / "30m" / "45 seconds"
  let total = 0
  let matched = false
  const re = /(\d+)\s*(h|hours?|m|minutes?|s|seconds?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) != null) {
    matched = true
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    if (unit.startsWith('h')) total += n * 3600_000
    else if (unit.startsWith('m')) total += n * 60_000
    else total += n * 1000
  }
  return matched && total > 0 ? total : null
}

// ─── Card rendering ──────────────────────────────────────────────────────────

export interface FormatCardOptions {
  /** Slot the agent was using when the failure happened — when known,
   *  named in the card so the user can act precisely. */
  slot?: string | null
  /** Anchor for relative-time formatting. Tests pin this; prod omits it. */
  now?: Date
  /**
   * True when the gateway has concurrently fired
   * `fireFleetAutoFallback` for this event. Switches the card body
   * from "What to try" (manual commands) to "Auto-failover in
   * progress" so the user doesn't manually `/auth use` while a
   * fleet swap is mid-flight. Caller MUST pass this when invoking
   * the dispatcher in parallel — otherwise the card lies.
   */
  autoFallbackInFlight?: boolean
}

/**
 * Render the actionable ⚠️ card for a detected model-unavailable event.
 * HTML-formatted for Telegram. Stable shape so snapshot tests remain
 * meaningful when the suggestion list shifts.
 */
export function formatModelUnavailableCard(
  detection: ModelUnavailableDetection,
  agent: string,
  opts: FormatCardOptions = {},
): string {
  const now = opts.now ?? new Date()
  const slotPart = opts.slot ? ` (slot <b>${escHtml(opts.slot)}</b>)` : ''
  const reason = formatReason(detection, now)
  const lines = [
    `⚠️ <b>Model unavailable</b> on agent <b>${escHtml(agent)}</b>${slotPart}`,
    `Reason: ${reason}`,
    '',
  ]
  if (opts.autoFallbackInFlight) {
    // Quiet variant — the gateway already kicked off a fleet-wide
    // swap; a follow-up announcement (causal-shape) will land within
    // ~1s. Mention it explicitly so the user knows not to react.
    lines.push(
      '<i>Auto-failover in progress — see the announcement below.</i>',
    )
  } else {
    // Default — kinds where auto-fallback can't help (network)
    // or pre-Format-2 callers. Also: `/authfallback` is no longer
    // a verb (post-RFC-H); `/auth use <label>` is the canonical
    // fleet-wide swap.
    lines.push(
      '<b>What to try</b>',
      '• <code>/auth use &lt;label&gt;</code> — switch the fleet to a healthy account',
      '• <code>/auth add</code> — attach another subscription',
      '• <code>/usage</code> — show quota breakdown',
    )
  }
  return lines.join('\n')
}

function formatReason(d: ModelUnavailableDetection, now: Date): string {
  const reset = d.resetAt ? ` (${formatResetRelative(d.resetAt, now)})` : ''
  switch (d.kind) {
    case 'quota_exhausted':
      return `quota exhausted${reset}`
    case 'overload':
      return `model overloaded${reset}`
    case 'network':
      return 'network unreachable'
  }
}

// ─── Operator-event bridge ───────────────────────────────────────────────────

/**
 * Minimal shape for the operator-event input — kept structural to avoid a
 * runtime dependency on `operator-events.ts`. The gateway passes its real
 * `OperatorEvent` here; tests can pass a hand-rolled object with just the
 * `kind` and `detail` fields.
 *
 * The string union covers exactly the kinds that are model-availability-
 * relevant. Any kind outside that set falls through to text-pattern
 * detection on `detail`.
 */
export interface OperatorEventLike {
  kind: string
  detail: string
}

/**
 * Decide whether an operator event represents a model-unavailable failure.
 * Returns null when it's something else (auth issue, agent crash, etc.) so
 * the caller can fall back to its default per-kind renderer.
 *
 * Used by the gateway's `emitGatewayOperatorEvent` to decide whether to
 * suppress the raw stderr-style `detail` and post the actionable card
 * instead. Lives here (not in the gateway) so it's pure-testable without
 * spinning up the bot.
 *
 * Decision order:
 *   1. If the kind is one of the known model-unavailable kinds, build a
 *      synthetic detection from kind + detail (passing detail through
 *      `detectModelUnavailable` first to pick up reset-time hints).
 *   2. Otherwise, run pattern detection on `detail` — covers cases where
 *      a generic 4xx/5xx slipped past the upstream classifier carrying
 *      a quota/overload message in its body.
 */
export function resolveModelUnavailableFromOperatorEvent(
  ev: OperatorEventLike,
): ModelUnavailableDetection | null {
  const detail = typeof ev.detail === 'string' ? ev.detail : ''
  if (ev.kind === 'quota-exhausted') {
    return detectModelUnavailable(detail) ?? { kind: 'quota_exhausted', raw: detail }
  }
  if (ev.kind === 'rate-limited') {
    // A rate-limited / transient overload is NOT "model unavailable" —
    // it is retryable and Claude Code retries it internally. Escalate
    // to the model-unavailable card ONLY if the detail carries a
    // genuine quota signal (a 4xx that slipped past the classifier
    // with usage-limit wording in its body). A bare overload /
    // rate-limit returns null → the caller renders the calm
    // `rate-limited` card, never the scary "⚠️ Model unavailable" one.
    // Returning `{kind:'overload'}` here is what fired a false
    // model-unavailable card on every transient 529.
    const detected = detectModelUnavailable(detail)
    return detected?.kind === 'quota_exhausted' ? detected : null
  }
  if (ev.kind === 'unknown-5xx') {
    return detectModelUnavailable(detail) ?? { kind: 'overload', raw: detail }
  }
  return detectModelUnavailable(detail)
}

// ─── HTML escape (mirrors operator-events.ts) ────────────────────────────────

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
