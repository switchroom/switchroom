/**
 * Observability + operator alerting for the Telegram send gate (#3084, PR 3/3).
 *
 * WHY
 * ---
 * PRs 1 and 2 built the gate (token buckets, priority shedding, degraded mode,
 * restart-proof scoped flood windows) but a live ban is still SILENT: the
 * counters sit in memory and a prolonged flood window is invisible until a user
 * notices dead air. part3-design §6 closes that gap:
 *
 *   1. A low-frequency one-line stats summary to the gateway-supervisor stderr
 *      log (only when a counter changed — no log spam), plus a snapshot on every
 *      flood-window open / close.
 *   2. An operator alert when a flood window has been open past a threshold
 *      (~60s), at-most-once per window.
 *
 * DELIVERABILITY OF THE ALERT (the tricky part)
 * ---------------------------------------------
 * The alert is a `critical` send, but it must NOT fight the very window it is
 * reporting: sending a "you're flood-banned" card straight into an open GLOBAL
 * ban just feeds the ban. So the observer distinguishes:
 *
 *   - The operator chat is NOT covered by any open window (e.g. a `chat:<other>`
 *     ban while the operator's own chat is clear) → deliver IMMEDIATELY, and
 *     persist an `alertedAt` marker on the window record so a restart mid-window
 *     never re-alerts.
 *   - The operator chat IS covered (a `global` ban, or a ban on the operator's
 *     own chat) → do NOT send during the window. Remember it is owed and send a
 *     "was banned from X to Y" alert when the window CLOSES (or as soon as the
 *     operator chat becomes reachable again).
 *
 * STATUS OF THE IMMEDIATE PATH (live since #3111)
 * -----------------------------------------------
 * The immediate-delivery branch is present, unit-tested, AND now fires in
 * production: as of #3111 a chat-scoped 429 opens ONLY that chat's window (no
 * coincident `global`), so when a ban covers `chat:<other>` while the operator's
 * own chat is clear, the alert is delivered IMMEDIATELY rather than deferred to
 * close. A genuinely global 429 still opens `global`, so the operator chat is
 * "covered" and the alert defers to close — once per incident, all scopes
 * coalesced into one card (M1, #3112).
 *
 * At-most-once is anchored by the persisted `alertedAt` (survives restart). The
 * deferred close-alert is best-effort at-least-once: if the gateway is down for
 * the entire tail of the window and the record is pruned before it is seen
 * again, the close alert is dropped — acceptable, because the invariant that
 * matters is "never RE-alert" (which `alertedAt` guarantees), not "always alert".
 *
 * DETERMINISM / TESTABILITY
 * -------------------------
 * Everything is driven by an injectable `Clock` and manual `tick()` calls; the
 * gateway wires `tick()` to a periodic timer. Window IO and the alert send are
 * injected, so the module unit-tests with no disk, timer, or bot.
 */

import type { Clock, SendGateStats } from './send-gate.js'
import type { FloodWindowRecord } from './flood-circuit-breaker.js'

/** One-line, human-scannable summary of the gate counters + global fill. */
export function formatStatsLine(stats: SendGateStats): string {
  const c = stats.global
  const globalFill = Math.round(stats.fill.global * 10) / 10
  const perChat = Object.keys(stats.fill.perChat).length
  return (
    `telegram gateway: send-gate stats: ` +
    `sent=${c.sent} queued=${c.queued} coalesced=${c.coalesced} dropped=${c.dropped} ` +
    `shed=${c.shed} expired=${c.expired} failedFast=${c.failedFast} ` +
    `msgStates=${stats.messageStates} chatBuckets=${perChat} globalFill=${globalFill}\n`
  )
}

/** True when any of the seven gate counters differ between two snapshots. */
export function countersChanged(a: SendGateStats['global'], b: SendGateStats['global']): boolean {
  return (
    a.sent !== b.sent ||
    a.queued !== b.queued ||
    a.coalesced !== b.coalesced ||
    a.dropped !== b.dropped ||
    a.shed !== b.shed ||
    a.expired !== b.expired ||
    a.failedFast !== b.failedFast
  )
}

export interface StatsLoggerConfig {
  /** Snapshot source (the gate's `stats()`). */
  stats: () => SendGateStats
  /** Where the one-line summary goes (gateway-supervisor stderr). */
  log: (line: string) => void
  /** Injectable clock. */
  clock: Clock
  /** Minimum ms between logged lines. Default 60_000. */
  intervalMs?: number
}

export interface StatsLogger {
  /**
   * Emit the summary IFF (a) the gate is enabled, (b) at least `intervalMs`
   * has elapsed since the last logged line, and (c) a counter changed since
   * the last logged line. All three must hold — so a quiet gate is silent and
   * a busy gate logs at most once per interval.
   */
  tick(): void
}

/** Low-frequency, change-gated stats logger (part3-design §6, item 1). */
export function createStatsLogger(config: StatsLoggerConfig): StatsLogger {
  const intervalMs = config.intervalMs ?? 60_000
  let lastLoggedMs = Number.NEGATIVE_INFINITY
  let lastCounters: SendGateStats['global'] | null = null

  return {
    tick() {
      const s = config.stats()
      if (!s.enabled) return
      const now = config.clock.now()
      if (now - lastLoggedMs < intervalMs) return
      // First-ever log always fires (no baseline); afterwards only on a change.
      if (lastCounters && !countersChanged(lastCounters, s.global)) return
      lastLoggedMs = now
      lastCounters = { ...s.global }
      config.log(formatStatsLine(s))
    },
  }
}

// ─── Flood-window observer: open/close snapshots + operator alerting ─────────

/** Alert-worthy scopes. `msg-edit:` windows are cosmetic and never alerted. */
function isAlertableScope(scopeKey: string): boolean {
  return scopeKey === 'global' || scopeKey.startsWith('chat:') || scopeKey.startsWith('group:')
}

export interface FloodWindowObserverConfig {
  /** Injectable clock. */
  clock: Clock
  /** Where snapshot lines go. */
  log: (line: string) => void
  /** Gate stats source (for the open/close snapshot line). */
  stats: () => SendGateStats
  /** Read the persisted scoped windows (expired pruned), e.g. `readFloodWindows`. */
  readWindows: (now: number) => FloodWindowRecord[]
  /** Persist an `alertedAt` marker on a window record (at-most-once anchor). */
  markAlerted: (scopeKey: string, alertedAt: number) => void
  /**
   * Send ONE operator alert (a `critical` send to the operator chat). Rejections
   * are swallowed by the observer so a failed alert never breaks the tick loop.
   */
  sendAlert: (text: string) => Promise<void>
  /**
   * Resolve the operator chat id (`allowFrom[0]`) fresh each tick — `allowFrom`
   * can change at runtime. When it returns undefined, no chat is "covered", so
   * every alertable window is treated as immediately deliverable to the operator.
   */
  operatorChatId?: () => string | undefined
  /** Ms a window must be open before it earns an alert. Default 60_000. */
  alertThresholdMs?: number
  /**
   * IANA timezone (e.g. `Australia/Melbourne`) for rendering the operator-facing
   * alert timestamps in local wall-clock time instead of UTC. The gateway sources
   * this from `SWITCHROOM_TIMEZONE ?? TZ` (the same env the config cascade bakes
   * into every agent service — see `src/config/timezone.ts`). Defaults to `'UTC'`
   * so a missing tz degrades to the previous behaviour rather than throwing.
   */
  tz?: string
}

export interface FloodWindowObserver {
  /** Poll persisted windows once: emit open/close snapshots + drive alerts. */
  tick(): Promise<void>
}

// ─── Operator-facing local-time formatting ──────────────────────────────────
// Operator alerts (openAlertText / closeAlertText) render timestamps in the
// operator's CONFIGURED timezone, not UTC — a "was banned from 9:39am to 9:46am
// AEST" reads at a glance where a raw `2026-07-12T23:39:24Z UTC` does not. The
// machine-facing snapshot LOG lines (config.log → gateway-supervisor.log) keep
// their epoch/ISO wording; only the chat/card text is localized.

/** Lowercased wall-clock time in `tz`, e.g. `9:39am`. */
function fmtLocalClock(ms: number, tz: string): string {
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
function fmtLocalDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
  }).format(new Date(ms))
}

/** Calendar day (`YYYY-MM-DD`) in `tz`, for a timezone-correct "same day?" test. */
function localDay(ms: number, tz: string): string {
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
function tzAbbrev(ms: number, tz: string): string {
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
 * A single operator-facing local timestamp with tz suffix, e.g. `9:46am AEST`.
 * When `refMs` is on a different local calendar day (or omitted), the date is
 * prepended (`12 Jul 11:52pm AEST`) so a day-spanning window is unambiguous.
 */
function fmtLocalStamp(ms: number, tz: string, refMs?: number): string {
  const clock = fmtLocalClock(ms, tz)
  const sameDay = refMs != null && localDay(ms, tz) === localDay(refMs, tz)
  const body = sameDay ? clock : `${fmtLocalDate(ms, tz)} ${clock}`
  return `${body} ${tzAbbrev(ms, tz)}`
}

/**
 * A local time RANGE with a single tz suffix, e.g. `9:39am to 9:46am AEST`.
 * Same-local-day windows drop the redundant start date; day-spanning windows
 * carry the date on each end (`12 Jul 11:59pm to 13 Jul 12:04am AEST`).
 */
function fmtLocalRange(startMs: number, endMs: number, tz: string): string {
  const sameDay = localDay(startMs, tz) === localDay(endMs, tz)
  if (sameDay) {
    return `${fmtLocalClock(startMs, tz)} to ${fmtLocalClock(endMs, tz)} ${tzAbbrev(endMs, tz)}`
  }
  return (
    `${fmtLocalDate(startMs, tz)} ${fmtLocalClock(startMs, tz)} to ` +
    `${fmtLocalDate(endMs, tz)} ${fmtLocalClock(endMs, tz)} ${tzAbbrev(endMs, tz)}`
  )
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem ? `${m}m${rem}s` : `${m}m`
}

/**
 * Flood-window observer (part3-design §6, item 2 + snapshots). Reads the
 * persisted scoped windows each tick, diffs against the previous tick to detect
 * opens / closes (snapshot log), and decides — per the deliverability rules in
 * the module header — whether to alert the operator now, defer to window close,
 * or stay quiet.
 */
export function createFloodWindowObserver(
  config: FloodWindowObserverConfig,
): FloodWindowObserver {
  const alertThresholdMs = config.alertThresholdMs ?? 60_000
  const tz = config.tz ?? 'UTC'
  // Full records seen on the previous tick, keyed by scope (close detection).
  let lastSeen = new Map<string, FloodWindowRecord>()
  // First tick after boot: any window already present was loaded from disk
  // (a ban that predates this process), NOT freshly opened — so we log a single
  // "loaded N windows" line instead of a per-scope OPENED snapshot (L3, #3112).
  let firstTick = true
  // Scopes whose alert could not be delivered during the window → owed on close.
  const owedOnClose = new Set<string>()
  // Close alerts owed but not yet deliverable, grouped per INCIDENT (an approx
  // untilTs bucket). One real 429 opens several scopes (global + chat:<id> +
  // group:<id>, all sharing one untilTs — see #3111's global over-suppression),
  // which all close in the same tick; grouping collapses them into ONE operator
  // "flood ban cleared" card listing every scope, instead of 2–3 near-identical
  // cards per incident (M1, #3112).
  // NOTE (L2, #3112): owedOnClose / pendingCloseByIncident are IN-MEMORY only —
  // a restart during an open window drops the "owed" state and the deferred
  // close-alert may be lost. This is the accepted at-least-once tradeoff
  // documented in the module header; the invariant that matters (never RE-alert)
  // is anchored on the persisted `alertedAt`, not on this state.
  const pendingCloseByIncident = new Map<number, FloodWindowRecord[]>()

  /** Bucket windows of one incident together by ~1s-rounded expiry. */
  function incidentBucket(untilTs: number): number {
    return Math.round(untilTs / 1000)
  }

  function coversOperator(w: FloodWindowRecord, operatorChatId: string | undefined): boolean {
    if (w.scopeKey === 'global') return true
    if (operatorChatId == null) return false
    return (
      w.scopeKey === `chat:${operatorChatId}` || w.scopeKey === `group:${operatorChatId}`
    )
  }

  function snapshotSuffix(): string {
    const c = config.stats().global
    return (
      `sent=${c.sent} shed=${c.shed} coalesced=${c.coalesced} ` +
      `expired=${c.expired} failedFast=${c.failedFast}`
    )
  }

  function openAlertText(w: FloodWindowRecord, now: number): string {
    const openFor = fmtDur(now - w.observedAt)
    return (
      `⚠️ Telegram flood ban active (scope \`${w.scopeKey}\`). ` +
      `Open for ${openFor}, expected to clear at ${fmtLocalStamp(w.untilTs, tz, now)}. ` +
      `Outbound to that scope is being suppressed.`
    )
  }

  /**
   * ONE close-alert card for a whole incident. `recs` are the scopes of a
   * single 429 (they share an ~untilTs bucket); we list every scope and span
   * the interval as [earliest observedAt, latest untilTs] so the operator gets
   * one card per incident rather than one per scope (M1, #3112).
   */
  function closeAlertText(recs: FloodWindowRecord[]): string {
    const observedAt = Math.min(...recs.map((r) => r.observedAt))
    const untilTs = Math.max(...recs.map((r) => r.untilTs))
    const scopes = recs.map((r) => `\`${r.scopeKey}\``).join(', ')
    const plural = recs.length > 1 ? 's' : ''
    return (
      `⚠️ Telegram flood ban cleared (scope${plural} ${scopes}). ` +
      `The bot was banned from ${fmtLocalRange(observedAt, untilTs, tz)} ` +
      `(~${fmtDur(untilTs - observedAt)}). Some outbound messages during that ` +
      `window were suppressed.`
    )
  }

  async function tick(): Promise<void> {
    const s = config.stats()
    if (!s.enabled) return
    const now = config.clock.now()
    const operatorChatId = config.operatorChatId?.()
    const windows = config.readWindows(now)
    const current = new Map<string, FloodWindowRecord>()
    for (const w of windows) current.set(w.scopeKey, w)
    const operatorReachable = !windows.some((w) => coversOperator(w, operatorChatId))

    if (firstTick) {
      // Windows present on the very first tick were loaded at boot, not opened
      // now — log ONE "loaded" line rather than a misleading OPENED snapshot per
      // window (L3, #3112). Alerting for these still runs below (alertedAt-gated).
      if (windows.length > 0) {
        config.log(
          `telegram gateway: send-gate flood observer loaded ${windows.length} ` +
            `open flood window(s) at boot: ${windows.map((w) => w.scopeKey).join(', ')} ` +
            `— ${snapshotSuffix()}\n`,
        )
      }
    } else {
      // Newly-opened scopes → snapshot.
      for (const w of windows) {
        if (!lastSeen.has(w.scopeKey)) {
          config.log(
            `telegram gateway: send-gate flood window OPENED scope=${w.scopeKey} ` +
              `untilTs=${w.untilTs} src=${w.retryAfterSrc} — ${snapshotSuffix()}\n`,
          )
        }
      }
    }

    // Closed scopes → snapshot, and queue any owed close-alert (grouped per
    // incident so the operator gets ONE card listing all scopes — M1, #3112).
    for (const [scope, prev] of lastSeen) {
      if (current.has(scope)) continue
      config.log(
        `telegram gateway: send-gate flood window CLOSED scope=${scope} ` +
          `(was open ${fmtDur(now - prev.observedAt)}) — ${snapshotSuffix()}\n`,
      )
      if (owedOnClose.has(scope) && isAlertableScope(scope) && prev.alertedAt == null) {
        const bucket = incidentBucket(prev.untilTs)
        const list = pendingCloseByIncident.get(bucket) ?? []
        list.push(prev)
        pendingCloseByIncident.set(bucket, list)
      }
      owedOnClose.delete(scope)
    }

    // Prolonged open windows → alert now (if deliverable) or defer to close.
    for (const w of windows) {
      if (!isAlertableScope(w.scopeKey)) continue
      if (w.alertedAt != null) continue
      if (now - w.observedAt < alertThresholdMs) continue
      if (operatorReachable && !coversOperator(w, operatorChatId)) {
        // NOTE (M1, #3112 / #3111): this immediate-delivery branch is now LIVE
        // for recorder-produced state. Since #3111 a chat-scoped 429 opens only
        // that chat's window (no coincident `global`), so when a ban covers a
        // chat OTHER than the operator's, `operatorReachable` is true and the
        // alert is delivered here rather than deferred to close. A genuinely
        // global 429 still opens `global`, keeping the operator "covered".
        // NOTE (L1, #3112): send-first, then persist `alertedAt`. A crash between
        // the delivered card and the disk write re-alerts on restart — a benign
        // duplicate. Deliberate: send-first guarantees an alert is never LOST,
        // and never RE-alerting is the weaker of the two guarantees.
        try {
          await config.sendAlert(openAlertText(w, now))
          config.markAlerted(w.scopeKey, now)
          owedOnClose.delete(w.scopeKey)
        } catch {
          /* best-effort — a failed alert must not break the observer loop */
        }
      } else {
        // Cannot deliver during the window → alert when it closes.
        owedOnClose.add(w.scopeKey)
      }
    }

    // Flush deferred close alerts once the operator chat is reachable again —
    // ONE card per incident, listing every scope (M1, #3112).
    if (operatorReachable && pendingCloseByIncident.size > 0) {
      for (const [bucket, recs] of [...pendingCloseByIncident]) {
        try {
          await config.sendAlert(closeAlertText(recs))
          pendingCloseByIncident.delete(bucket)
        } catch {
          /* keep it pending; retry next tick */
        }
      }
    }

    lastSeen = current
    firstTick = false
  }

  return { tick }
}
