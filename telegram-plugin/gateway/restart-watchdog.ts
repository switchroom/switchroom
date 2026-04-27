/**
 * restart-watchdog.ts — polls systemd's NRestarts counter for the agent
 * service and emits `agent-restarted-unexpectedly` when it ticks up
 * without a corresponding planned-restart marker. Closes #30 task 4 and
 * the 2026-04-21 lessons-learned loop where IPC flaps falsely triggered
 * the gateway's recovery banner.
 *
 * Pure module — no telegram or grammy deps. The poller takes injected
 * `execShow` and `emit` callbacks so the decision function can be tested
 * with no systemd present.
 *
 * Detection model:
 *   t0: snapshot NRestarts at gateway boot.
 *   t1+: every pollIntervalMs, re-read. If NRestarts increased AND no
 *        recent restart-pending marker, emit one event. Update snapshot.
 *
 * The "no recent restart-pending" check is the signal that this restart
 * was unplanned. A user-issued /restart or `agent restart <name>` from
 * the CLI writes restart-pending.json, which the gateway would have
 * already consumed (clearRestartMarker) by the time this watchdog ticks.
 * The marker is NOT a perfect signal — but combined with the cooldown
 * inside the operator-events pipeline (5min per agent+kind), spurious
 * emissions are bounded.
 */

export interface SystemdShowResult {
  /** Cumulative restart count since unit was loaded. */
  nRestarts: number
  /** Microseconds since epoch — systemd's monotonic timestamp for the
   *  current activation. Used for telemetry only; the decision is
   *  driven by the NRestarts delta. */
  activeEnterTimestampMonotonic: number
}

/** Output of `systemctl --user show <unit> -p NRestarts,ActiveEnterTimestampMonotonic`.
 *  Format is one `Key=Value` per line. Returns `null` if either field is
 *  missing or unparsable — the caller treats that as "skip this tick". */
export function parseSystemdShowOutput(raw: string): SystemdShowResult | null {
  const lines = raw.split(/\r?\n/)
  let nRestarts: number | null = null
  let activeEnter: number | null = null
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'NRestarts') {
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) nRestarts = n
    } else if (key === 'ActiveEnterTimestampMonotonic') {
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) activeEnter = n
    }
  }
  if (nRestarts == null || activeEnter == null) return null
  return { nRestarts, activeEnterTimestampMonotonic: activeEnter }
}

export interface WatchdogTickInput {
  /** Most recent reading from systemctl. */
  current: SystemdShowResult
  /** Reading from the previous tick (or boot snapshot). null on first tick. */
  previous: SystemdShowResult | null
  /** True if a restart-pending marker is on disk right now. The gateway
   *  consumes the marker on boot, so a fresh marker means the restart
   *  was user-initiated and shouldn't fire the operator event. */
  recentPlannedRestart: boolean
}

export interface WatchdogTickDecision {
  /** Should the operator-event emit fire? */
  emit: boolean
  /** Detail string passed through to the OperatorEvent renderer. */
  detail: string
  /** New snapshot to retain for the next tick (always `current`). */
  nextSnapshot: SystemdShowResult
}

/**
 * Decide whether this tick should fire an `agent-restarted-unexpectedly`
 * event. Pure function — no I/O, no clock reads.
 */
export function decideWatchdogTick(input: WatchdogTickInput): WatchdogTickDecision {
  const { current, previous, recentPlannedRestart } = input
  // First tick after boot — no baseline to compare. Just record.
  if (previous == null) {
    return { emit: false, detail: '', nextSnapshot: current }
  }
  const delta = current.nRestarts - previous.nRestarts
  if (delta <= 0) {
    return { emit: false, detail: '', nextSnapshot: current }
  }
  // NRestarts went up — was it user-initiated?
  if (recentPlannedRestart) {
    return {
      emit: false,
      detail: `planned restart (delta=${delta})`,
      nextSnapshot: current,
    }
  }
  return {
    emit: true,
    detail: delta === 1
      ? 'systemd auto-restarted the agent service unexpectedly'
      : `systemd auto-restarted the agent service ${delta} times since last poll`,
    nextSnapshot: current,
  }
}

export interface WatchdogConfig {
  /** Agent name to monitor. The systemd unit is `switchroom-<agent>`. */
  agentName: string
  /** Poll cadence (ms). Default 30s. Set to 0 to disable. */
  pollIntervalMs?: number
  /** Injected systemctl show — returns the raw stdout string, or throws
   *  on failure (the watchdog skips that tick on error). */
  execShow: (unit: string) => string
  /** Returns true if a restart-pending marker is on disk. */
  isPlannedRestartFresh: () => boolean
  /** Called when the watchdog decides to emit. */
  emit: (detail: string) => void
  /** Optional log sink. */
  log?: (msg: string) => void
}

export interface WatchdogHandle {
  stop(): void
}

/**
 * Start the watchdog poller. Returns a handle whose `stop()` clears the
 * timer. Safe to call before the IPC server is up — the first tick just
 * establishes a baseline.
 */
export function startRestartWatchdog(config: WatchdogConfig): WatchdogHandle {
  const {
    agentName,
    pollIntervalMs = 30_000,
    execShow,
    isPlannedRestartFresh,
    emit,
    log,
  } = config

  if (pollIntervalMs <= 0) {
    log?.(`restart-watchdog: disabled (pollIntervalMs=${pollIntervalMs})`)
    return { stop() {} }
  }

  const unit = `switchroom-${agentName}`
  let snapshot: SystemdShowResult | null = null

  function tick(): void {
    let raw: string
    try {
      raw = execShow(unit)
    } catch (err) {
      log?.(`restart-watchdog: systemctl show failed unit=${unit}: ${(err as Error).message}`)
      return
    }
    const parsed = parseSystemdShowOutput(raw)
    if (!parsed) {
      log?.(`restart-watchdog: could not parse systemctl output unit=${unit}`)
      return
    }
    const decision = decideWatchdogTick({
      current: parsed,
      previous: snapshot,
      recentPlannedRestart: isPlannedRestartFresh(),
    })
    snapshot = decision.nextSnapshot
    if (decision.emit) {
      log?.(`restart-watchdog: detected unexpected restart agent=${agentName} ${decision.detail}`)
      try {
        emit(decision.detail)
      } catch (err) {
        log?.(`restart-watchdog: emit threw: ${(err as Error).message}`)
      }
    } else if (decision.detail) {
      log?.(`restart-watchdog: tick agent=${agentName} ${decision.detail}`)
    }
  }

  // Establish the baseline immediately so a planned restart that lands
  // in the first poll interval doesn't get attributed to "before this
  // gateway started." Then schedule the recurring poll.
  tick()
  const timer = setInterval(tick, pollIntervalMs)
  // unref so the watchdog doesn't keep the gateway process alive past
  // shutdown.
  if (typeof timer.unref === 'function') timer.unref()

  log?.(`restart-watchdog: started agent=${agentName} unit=${unit} interval=${pollIntervalMs}ms`)

  return {
    stop() {
      clearInterval(timer)
    },
  }
}
