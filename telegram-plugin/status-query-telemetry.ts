/**
 * Truthful `status-query` telemetry — issue #109 (truthful-telemetry PR).
 *
 * When the user has to ask "status?" mid-turn, the gateway logs a snapshot of
 * what is ACTUALLY in flight so the frequency of surface failures can be
 * counted. This module is the pure decision at the heart of that log line.
 *
 * History / why this is pure: the snapshot used to be read from the pinned
 * progress card via `progressDriver.peek(...)`. That card was retired
 * (#1122/#1126) and `progressDriver` is now permanently `null`, so the old
 * peek ALWAYS reported idle/zero regardless of live background work — a lying
 * diagnostic that actively misled debugging. The gateway now reads the LIVE
 * surfaces (running-background-worker DB count, the `🛠 Worker` activity-feed
 * size, the cross-turn pending-async-dispatch flag, and whether a turn is
 * active) and passes them here. A live background worker ⇒ non-idle.
 *
 * A `ux-failure` is emitted ONLY when `idle` is true — every surface is
 * genuinely zero AND no turn is active, i.e. the user asked "status?" and
 * there really was nothing in flight for the surfaces to have shown.
 */

export interface StatusQuerySurfaces {
  /** A turn is currently active for this chat key (`activeTurnStartedAt`). */
  turnActive: boolean
  /**
   * Age of the active turn in whole seconds, or `-1` when no turn is active
   * (numeric sentinel so structured-log parsers avoid string branches).
   */
  turnAgeS: number
  /** Background sub-agent workers currently `running` (registry DB count). */
  runningWorkers: number
  /** Workers tracked by the edit-in-place `🛠 Worker` activity feed. */
  workerFeedSize: number
  /** Cross-turn pending-async dispatch for this chat key: 1 if pending, else 0. */
  pendingAsync: number
}

export type StatusQueryStage = 'idle' | 'turn-active' | 'background-work'

export interface StatusQueryTelemetry {
  stage: StatusQueryStage
  /**
   * True only when NOTHING is live on any surface. Gates the `ux-failure`
   * emission: a live turn or a live background worker means the surfaces DID
   * have something to show, so the "status?" is not a clean surface failure.
   */
  idle: boolean
}

/**
 * Derive the truthful stage + idle verdict from the live surfaces. Pure and
 * total so it can be unit-tested without standing up the gateway.
 */
export function deriveStatusQueryTelemetry(s: StatusQuerySurfaces): StatusQueryTelemetry {
  const idle =
    !s.turnActive &&
    s.runningWorkers <= 0 &&
    s.workerFeedSize <= 0 &&
    s.pendingAsync <= 0
  const stage: StatusQueryStage = idle
    ? 'idle'
    : s.turnActive
      ? 'turn-active'
      : 'background-work'
  return { stage, idle }
}

/**
 * Render the primary structured log line (grep anchor: "status-query").
 * Kept here so the field layout is single-sourced with the derive logic and
 * covered by the same test.
 */
export function formatStatusQueryLine(
  agentName: string,
  chatId: string,
  thread: string,
  s: StatusQuerySurfaces,
  t: StatusQueryTelemetry,
): string {
  return (
    `telegram gateway: status-query agent=${agentName} chat_id=${chatId} thread=${thread} ` +
    `stage=${t.stage} turn_age_s=${s.turnAgeS} running_workers=${s.runningWorkers} ` +
    `worker_feed=${s.workerFeedSize} pending_async=${s.pendingAsync}\n`
  )
}

/**
 * Render the `ux-failure` line (grep anchor: "ux-failure: status-query"). Only
 * call this when `t.idle` is true.
 */
export function formatStatusQueryUxFailureLine(
  agentName: string,
  chatId: string,
  thread: string,
): string {
  return (
    `telegram gateway: ux-failure: status-query agent=${agentName} chat_id=${chatId} thread=${thread} ` +
    `stage=idle turn_age_s=-1 running_workers=0 worker_feed=0 pending_async=0\n`
  )
}
