/**
 * shared/local-time.ts — operator-facing local wall-clock formatting.
 *
 * These four primitives render an epoch-ms instant in an operator's CONFIGURED
 * IANA timezone (e.g. `Australia/Melbourne`) instead of UTC, so a card reading
 * "clears ~4:52pm AEST" is legible at a glance where a raw `…T04:52:00Z UTC`
 * is not. They were originally file-private in `send-gate-observability.ts`
 * (#3084 / PR 3205); extracted here so BOTH the flood-window observer and the
 * humanized LLM-error card (`llm-error-present.ts`) render timestamps through
 * ONE source of truth rather than two drifting copies.
 *
 * Pure — no I/O, no clock, no env. Every function is total (never throws) and
 * degrades gracefully: an unknown tz falls back to the offset form or the tz
 * string itself. `tz='UTC'` reproduces the pre-extraction behaviour exactly, so
 * `send-gate-observability`'s snapshot-locked output is byte-identical.
 */

/** Lowercased wall-clock time in `tz`, e.g. `9:39am`. */
export function fmtLocalClock(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(ms))
    .replace(/\s([AP])M$/, (_m, p: string) => `${p.toLowerCase()}m`)
}

/** Compact local date, e.g. `12 Jul` — used only to disambiguate day-spanning windows. */
export function fmtLocalDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
  }).format(new Date(ms))
}

/** Calendar day (`YYYY-MM-DD`) in `tz`, for a timezone-correct "same day?" test. */
export function localDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms))
}

/**
 * Short tz abbreviation for `tz` at `ms`, e.g. `AEST`, `EDT`, `BST`. ICU only
 * surfaces the common alpha abbreviation for a locale whose region matches the
 * zone, so we try a small locale list and take the first genuine abbreviation;
 * zones with no common abbreviation (e.g. Asia/Kolkata) fall back to the offset
 * form (`GMT+5:30`), and `UTC` stays `UTC`.
 */
export function tzAbbrev(ms: number, tz: string): string {
  const at = new Date(ms)
  for (const loc of ['en-US', 'en-AU', 'en-GB']) {
    const v = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value
    if (v && !/^(?:GMT|UTC)/i.test(v)) return v
  }
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? tz
  )
}

/**
 * Resolve the agent's configured timezone from the process environment, the
 * SAME cascade `bin/timezone-hook.sh` and the config resolver use:
 * `SWITCHROOM_TIMEZONE` → `TZ` → `UTC`. Centralised so the inbound-tag,
 * forwarded_date, and recent-buffer callsites can't drift.
 */
export function resolveEnvTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return env.SWITCHROOM_TIMEZONE ?? env.TZ ?? 'UTC'
}

/**
 * Full model-facing local wall-clock stamp, e.g.
 * `Thursday 2026-07-16 04:09 PM AEST`.
 *
 * The deterministic replacement for the UTC ISO strings the model used to see
 * on inbound channel tags (`ts="…Z"`), `forwarded_date`, and the
 * `get_recent_messages` buffer. am/pm form in the agent's CONFIGURED timezone,
 * with NO "UTC" / trailing-Z — so the LLM can never read one of these as UTC
 * "now" and reason an offset wrong.
 *
 * Format mirrors `bin/timezone-hook.sh`'s `%A %Y-%m-%d %I:%M %p %Z` so the
 * inbound-tag time and the UserPromptSubmit local-time hint read identically.
 *
 * Pure / total: an invalid IANA `tz` (misconfigured agent) degrades to the
 * same am/pm shape rendered in UTC rather than throwing out of the inbound
 * path — a bad zone must never crash a turn.
 */
export function fmtLocalStamp(ms: number, tz: string): string {
  try {
    const at = new Date(ms)
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
    }).format(at)
    // localDay (en-CA) yields YYYY-MM-DD and throws first on a bad zone.
    const date = localDay(ms, tz)
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(at) // "04:09 PM"
    return `${weekday} ${date} ${time} ${tzAbbrev(ms, tz)}`
  } catch {
    // Invalid IANA zone — degrade to am/pm in UTC rather than crash the turn.
    if (tz !== 'UTC') return fmtLocalStamp(ms, 'UTC')
    return new Date(ms).toISOString()
  }
}
