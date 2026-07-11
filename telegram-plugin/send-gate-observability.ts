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
}

export interface FloodWindowObserver {
  /** Poll persisted windows once: emit open/close snapshots + drive alerts. */
  tick(): Promise<void>
}

/** Human-readable ISO-ish timestamp (UTC, second precision) for alert wording. */
function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace('.000', '').replace(/\.\d{3}/, '')
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
  // Full records seen on the previous tick, keyed by scope (close detection).
  let lastSeen = new Map<string, FloodWindowRecord>()
  // Scopes whose alert could not be delivered during the window → owed on close.
  const owedOnClose = new Set<string>()
  // Close alerts queued but not yet deliverable (operator chat still covered).
  const pendingClose = new Map<string, FloodWindowRecord>()

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
      `Open for ${openFor}, expected to clear at ${fmtTs(w.untilTs)} UTC. ` +
      `Outbound to that scope is being suppressed.`
    )
  }

  function closeAlertText(w: FloodWindowRecord): string {
    return (
      `⚠️ Telegram flood ban cleared (scope \`${w.scopeKey}\`). ` +
      `The bot was banned from ${fmtTs(w.observedAt)} to ${fmtTs(w.untilTs)} UTC ` +
      `(~${fmtDur(w.untilTs - w.observedAt)}). Some outbound messages during that ` +
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

    // Newly-opened scopes → snapshot.
    for (const w of windows) {
      if (!lastSeen.has(w.scopeKey)) {
        config.log(
          `telegram gateway: send-gate flood window OPENED scope=${w.scopeKey} ` +
            `untilTs=${w.untilTs} src=${w.retryAfterSrc} — ${snapshotSuffix()}\n`,
        )
      }
    }

    // Closed scopes → snapshot, and queue any owed close-alert.
    for (const [scope, prev] of lastSeen) {
      if (current.has(scope)) continue
      config.log(
        `telegram gateway: send-gate flood window CLOSED scope=${scope} ` +
          `(was open ${fmtDur(now - prev.observedAt)}) — ${snapshotSuffix()}\n`,
      )
      if (owedOnClose.has(scope) && isAlertableScope(scope) && prev.alertedAt == null) {
        pendingClose.set(scope, prev)
      }
      owedOnClose.delete(scope)
    }

    // Prolonged open windows → alert now (if deliverable) or defer to close.
    for (const w of windows) {
      if (!isAlertableScope(w.scopeKey)) continue
      if (w.alertedAt != null) continue
      if (now - w.observedAt < alertThresholdMs) continue
      if (operatorReachable && !coversOperator(w, operatorChatId)) {
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

    // Flush deferred close alerts once the operator chat is reachable again.
    if (operatorReachable && pendingClose.size > 0) {
      for (const [scope, rec] of [...pendingClose]) {
        try {
          await config.sendAlert(closeAlertText(rec))
          pendingClose.delete(scope)
        } catch {
          /* keep it pending; retry next tick */
        }
      }
    }

    lastSeen = current
  }

  return { tick }
}
