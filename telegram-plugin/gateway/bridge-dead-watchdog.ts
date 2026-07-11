/**
 * bridge-dead-watchdog.ts — gateway-side escalation when the MCP bridge
 * never (re)registers (#3038, follow-up to #3033 / PR #3037).
 *
 * Failure mode: the gateway crashes and its supervisor relaunches it in
 * ~1s, but the bridge MCP-server process inside the RUNNING claude
 * session dies with it. Claude Code never respawns a dead MCP server, so
 * the session stays alive but toolless and mute ("No such tool
 * available: mcp__switchroom-telegram__reply") while the gateway sits at
 * `bridge_dead` buffering inbounds — in the 2026-07-11 clerk incident,
 * 7 minutes of a mute agent until a manual container restart.
 *
 * PR #3037 hardened the bridge against dying (uncaughtException handler
 * + crash breadcrumbs to STATE_DIR/bridge-crash.log). This module is the
 * structural belt-and-braces: after gateway boot (or after a main-bridge
 * disconnect), if no main-agent bridge registers within a grace window
 * while the claude session process is demonstrably alive, escalate by
 * bouncing the whole container via the existing self-restart machinery
 * (`triggerSelfRestart`) with the distinct reason
 * `bridge-dead-resume`. The container restart respawns claude, which
 * respawns the MCP bridge — the only recovery path that exists.
 *
 * Guard rails:
 *   - at most ONE escalation per gateway boot (a bridge that dies
 *     deterministically at startup must not restart-loop the agent);
 *   - skipped while the gateway is mid-shutdown;
 *   - skipped when the claude session process is NOT alive (that is a
 *     different failure class — container boot still in progress, or
 *     claude itself down — where a bounce is either premature or
 *     futile); the timer re-arms so a slow-booting claude gets the full
 *     grace window again once it appears;
 *   - loud, structured escalation log line including a fresh
 *     bridge-crash.log tail (PR #3037 breadcrumbs) so the operator sees
 *     WHY from the supervisor log alone.
 *
 * Honest resume: before firing the restart, the watchdog persists an
 * escalation marker (`STATE_DIR/bridge-dead-escalation.json`). The next
 * boot's resume-inbound block reads it and appends the real cause to the
 * synthetic resume inbound, so the agent tells the user "my chat bridge
 * died and the framework restarted me" instead of implying a watchdog
 * timeout or an operator restart.
 *
 * Pure-ish module: all IO (fs, timers, process liveness, restart) is
 * injected so the decision logic and the controller are unit-testable
 * without booting a gateway.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'

/** The distinct triggerSelfRestart reason for this escalation. Classified
 *  as intent 'keep' by intentForRestartReason (recovery bounce — session
 *  model stickiness preserved), like every other switchroom-managed
 *  relaunch. */
export const BRIDGE_DEAD_RESTART_REASON = 'bridge-dead-resume'

/** Default grace window before a missing bridge is treated as dead.
 *  Override with SWITCHROOM_BRIDGE_DEAD_GRACE_MS. Chosen well above the
 *  normal boot register time (bridge registers within ~1-5s of claude
 *  start) but well below the 7-minute mute window of the incident. */
export const DEFAULT_BRIDGE_DEAD_GRACE_MS = 90_000

/** Escalation marker freshness window at next boot. A marker older than
 *  this is stale debris (the escalated restart happened long ago or never
 *  completed) — cleared without surfacing. */
export const ESCALATION_MARKER_MAX_AGE_MS = 10 * 60_000

/** Crash-breadcrumb entries older than this are not "fresh" — they refer
 *  to some earlier incident and would mislead the escalation log line. */
export const CRASH_LOG_FRESH_WINDOW_MS = 15 * 60_000

/** Max breadcrumb lines quoted into the escalation log / marker. */
const CRASH_LOG_TAIL_LINES = 3

// ─── Pure decision ───────────────────────────────────────────────────────────

export interface BridgeDeadSnapshot {
  /** A real (named, non-cron) bridge is currently registered. */
  bridgeRegistered: boolean
  /** The claude session process exists in the container. */
  sessionAlive: boolean
  /** The gateway is mid-shutdown (SIGTERM/SIGINT handler ran). */
  shuttingDown: boolean
  /** This gateway boot already fired the one allowed escalation. */
  alreadyEscalated: boolean
}

export type BridgeDeadDecision =
  | { action: 'escalate' }
  | {
      action: 'skip'
      why: 'bridge-registered' | 'shutting-down' | 'already-escalated'
    }
  | { action: 'retry'; why: 'session-not-alive' }

/**
 * Decide what the watchdog should do when the grace window expires.
 * Precedence, highest first: a live bridge always wins; a shutdown in
 * progress must never be raced by a restart; the once-per-boot fuse is
 * checked before anything fires; a missing claude process re-arms rather
 * than escalating (bouncing a container whose claude never came up would
 * loop without fixing anything — and a container still booting deserves
 * the full grace window once claude appears).
 */
export function decideBridgeDeadEscalation(s: BridgeDeadSnapshot): BridgeDeadDecision {
  if (s.bridgeRegistered) return { action: 'skip', why: 'bridge-registered' }
  if (s.shuttingDown) return { action: 'skip', why: 'shutting-down' }
  if (s.alreadyEscalated) return { action: 'skip', why: 'already-escalated' }
  if (!s.sessionAlive) return { action: 'retry', why: 'session-not-alive' }
  return { action: 'escalate' }
}

// ─── Crash-breadcrumb tail (PR #3037 integration) ────────────────────────────

/**
 * Read the fresh tail of STATE_DIR/bridge-crash.log. Returns the last few
 * breadcrumb lines whose leading ISO timestamp is within
 * `freshWindowMs` of `nowMs`, joined with " || " (single log line —
 * greppable, bounded). Returns null when the file is missing, unreadable,
 * or has no fresh entries. Never throws.
 */
export function readFreshCrashLogTail(
  path: string,
  opts: {
    nowMs?: number
    freshWindowMs?: number
    maxLines?: number
    readFile?: (p: string) => string
  } = {},
): string | null {
  const nowMs = opts.nowMs ?? Date.now()
  const freshWindowMs = opts.freshWindowMs ?? CRASH_LOG_FRESH_WINDOW_MS
  const maxLines = opts.maxLines ?? CRASH_LOG_TAIL_LINES
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  let raw: string
  try {
    raw = readFile(path)
  } catch {
    return null
  }
  const fresh = raw
    .split('\n')
    .filter((line) => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s/)
      if (!m) return false
      const t = Date.parse(m[1])
      return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= freshWindowMs
    })
    .slice(-maxLines)
  if (fresh.length === 0) return null
  // Bound each quoted line — breadcrumbs are already capped at 4000 chars
  // by the bridge, but one escalation log line quoting 3×4000 is noise.
  return fresh.map((l) => l.slice(0, 500)).join(' || ')
}

// ─── Escalation marker (honest boot-resume cause) ────────────────────────────

export interface BridgeDeadEscalationMarker {
  /** Wall-clock ms when the escalation fired. */
  ts: number
  /** Always BRIDGE_DEAD_RESTART_REASON — kept in the file for grep-ability. */
  reason: string
  /** Fresh crash-breadcrumb tail at escalation time, if any. */
  crashTail?: string
}

export function writeBridgeDeadEscalationMarker(
  path: string,
  marker: BridgeDeadEscalationMarker,
): void {
  // Atomic tmp+rename so a partial write can't be read back as malformed
  // JSON by the next boot (same discipline as clean-shutdown-marker.ts).
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(marker), 'utf8')
  renameSync(tmp, path)
}

/**
 * Read + consume the escalation marker at boot. Returns the marker only
 * when it is fresh (< maxAgeMs); a stale or malformed marker is cleared
 * and ignored. The file is ALWAYS removed — the cause note must surface
 * on exactly the boot that follows the escalation, never a later one.
 */
export function consumeBridgeDeadEscalationMarker(
  path: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = ESCALATION_MARKER_MAX_AGE_MS,
): BridgeDeadEscalationMarker | null {
  let marker: BridgeDeadEscalationMarker | null = null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeDeadEscalationMarker>
    if (
      typeof parsed.ts === 'number' &&
      Number.isFinite(parsed.ts) &&
      typeof parsed.reason === 'string'
    ) {
      const age = nowMs - parsed.ts
      if (age >= 0 && age < maxAgeMs) {
        marker = { ts: parsed.ts, reason: parsed.reason }
        if (typeof parsed.crashTail === 'string') marker.crashTail = parsed.crashTail
      }
    }
  } catch {
    /* missing or malformed — nothing to surface */
  }
  try {
    unlinkSync(path)
  } catch {
    /* best effort */
  }
  return marker
}

// ─── Watchdog controller ─────────────────────────────────────────────────────

export interface BridgeDeadWatchdogOpts {
  /** Grace window before a missing bridge is treated as dead. */
  graceMs: number
  /** Is the claude session process alive in this container? */
  isSessionAlive: () => boolean
  /** Is the gateway mid-shutdown? */
  isShuttingDown: () => boolean
  /** Fire the container bounce (triggerSelfRestart wrapper). Returns
   *  whether the restart was actually dispatched. */
  escalate: (reason: string) => boolean
  /** STATE_DIR/bridge-crash.log — PR #3037 breadcrumbs. */
  crashLogPath: string
  /** STATE_DIR/bridge-dead-escalation.json — honest-resume marker. */
  markerPath: string
  /** Structured log sink (stderr). */
  log: (line: string) => void
  /** Injectable timer pair for tests. Defaults to global setTimeout with
   *  unref (the watchdog must never keep the gateway process alive). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Injectable clock (marker ts + crash-log freshness). */
  nowMs?: () => number
  /** Injectable marker writer (tests avoid real fs). */
  writeMarker?: (path: string, marker: BridgeDeadEscalationMarker) => void
  /** Injectable crash-log reader (tests avoid real fs). */
  readCrashTail?: (path: string, nowMs: number) => string | null
}

export interface BridgeDeadWatchdog {
  /** Arm the grace timer (gateway boot). Idempotent while armed. */
  arm: () => void
  /** A real (named, non-cron) bridge registered — cancel the timer. */
  noteBridgeRegistered: () => void
  /** The real bridge disconnected mid-life — re-arm the grace timer so a
   *  bridge that dies AFTER boot (and never reconnects) also escalates.
   *  Still capped by the once-per-boot fuse. */
  noteBridgeDisconnected: () => void
  /** Evaluate now (the timer body — exposed for tests). Returns the
   *  decision taken. */
  check: () => BridgeDeadDecision
  /** Cancel any pending timer (gateway shutdown). */
  stop: () => void
  /** Test/introspection: has this boot escalated already? */
  hasEscalated: () => boolean
}

export function createBridgeDeadWatchdog(opts: BridgeDeadWatchdogOpts): BridgeDeadWatchdog {
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    })
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout))
  const nowMs = opts.nowMs ?? (() => Date.now())
  const writeMarker = opts.writeMarker ?? writeBridgeDeadEscalationMarker
  const readCrashTail =
    opts.readCrashTail ?? ((p: string, t: number) => readFreshCrashLogTail(p, { nowMs: t }))

  let timer: unknown = null
  let bridgeRegistered = false
  let escalated = false

  const cancel = (): void => {
    if (timer != null) {
      clearTimer(timer)
      timer = null
    }
  }

  const armInternal = (): void => {
    if (escalated) return // once-per-boot fuse — never re-arm after firing
    cancel()
    timer = setTimer(() => {
      timer = null
      check()
    }, opts.graceMs)
  }

  const check = (): BridgeDeadDecision => {
    const decision = decideBridgeDeadEscalation({
      bridgeRegistered,
      sessionAlive: opts.isSessionAlive(),
      shuttingDown: opts.isShuttingDown(),
      alreadyEscalated: escalated,
    })
    if (decision.action === 'retry') {
      // claude not up yet (slow container boot) — give it another full
      // grace window rather than escalating a bounce that can't help.
      opts.log(
        `telegram gateway: [bridge-dead-watchdog] no bridge registered after ${opts.graceMs}ms ` +
          `but claude session not found — re-arming (no escalation)`,
      )
      armInternal()
      return decision
    }
    if (decision.action === 'skip') {
      if (decision.why !== 'bridge-registered') {
        opts.log(
          `telegram gateway: [bridge-dead-watchdog] bridge missing but skipping escalation (${decision.why})`,
        )
      }
      return decision
    }
    // Escalate: bridge dead, session alive, not shutting down, first time
    // this boot. Set the fuse BEFORE any side effect so a throwing sink
    // can't produce a second fire.
    escalated = true
    const t = nowMs()
    const crashTail = (() => {
      try {
        return readCrashTail(opts.crashLogPath, t)
      } catch {
        return null
      }
    })()
    try {
      const marker: BridgeDeadEscalationMarker = { ts: t, reason: BRIDGE_DEAD_RESTART_REASON }
      if (crashTail != null) marker.crashTail = crashTail
      writeMarker(opts.markerPath, marker)
    } catch (err) {
      opts.log(
        `telegram gateway: [bridge-dead-watchdog] escalation marker write failed: ${(err as Error).message}`,
      )
    }
    // The audit line: loud, structured, greppable — the operator's answer
    // to "why did this container bounce itself".
    opts.log(
      `telegram gateway: [bridge-dead-watchdog] ESCALATING reason=${BRIDGE_DEAD_RESTART_REASON} — ` +
        `no MCP bridge registered within ${opts.graceMs}ms grace window while the claude session is alive ` +
        `(Claude Code never respawns a dead MCP server; bouncing the container to restore the chat surface). ` +
        (crashTail != null
          ? `bridge-crash.log tail: ${crashTail}`
          : `no fresh bridge-crash.log entries`),
    )
    const fired = opts.escalate(BRIDGE_DEAD_RESTART_REASON)
    if (!fired) {
      opts.log(
        `telegram gateway: [bridge-dead-watchdog] escalate() reported failure — ` +
          `restart not dispatched (fuse stays blown; no retry this boot)`,
      )
    }
    return decision
  }

  return {
    arm: armInternal,
    noteBridgeRegistered: () => {
      bridgeRegistered = true
      cancel()
    },
    noteBridgeDisconnected: () => {
      bridgeRegistered = false
      armInternal()
    },
    check,
    stop: cancel,
    hasEscalated: () => escalated,
  }
}
