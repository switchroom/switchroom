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

  return undefined
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
}

/**
 * Render the actionable ⚠️ card for a detected model-unavailable event.
 * HTML-formatted for Telegram. Stable shape so snapshot tests remain
 * meaningful when the suggestion list shifts.
 *
 *   ⚠️ <b>Model unavailable</b> on agent <b>name</b>
 *   Reason: quota exhausted (resets in 5h)
 *
 *   <b>What to try</b>
 *   • <code>/authfallback</code> — switch to the next account slot
 *   • <code>/auth add</code> — attach another subscription
 *   • <code>/usage</code> — show quota breakdown
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
    '<b>What to try</b>',
    '• <code>/authfallback</code> — switch to the next account slot',
    '• <code>/auth add</code> — attach another subscription',
    '• <code>/usage</code> — show quota breakdown',
  ]
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
    return detectModelUnavailable(detail) ?? { kind: 'overload', raw: detail }
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
