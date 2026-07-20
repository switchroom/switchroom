/**
 * hang-restart-decision.ts — the progress-based hang-restart discriminator
 * (Stage B safety net).
 *
 * WHY THIS EXISTS
 *
 * The silence-poke framework fallback (`liveness-wiring.ts onFrameworkFallback`)
 * is the last-resort unwedge, but it only tears down GATEWAY state — it never
 * kills the wedged `claude` child. So a turn that hangs mid-tool-call recovers
 * its conversation slot but leaves the child stuck; the "carrie" incident
 * needed a MANUAL restart. Stage B closes that: when the fallback fires with a
 * tool still mid-call AND no real progress, escalate to an actual restart via
 * the SIGTERM-PID1 path, then let the boot classifier route recovery through
 * the ask-first `resume_watchdog_timeout` inbound (never assertive auto-resume).
 *
 * THE DISCRIMINATOR (the crux — do NOT key on "tool open N seconds")
 *
 * A healthy 20-minute research turn with one long `WebFetch` / sub-agent must
 * NOT be killed. The honest progress signal is the turn-active marker's mtime:
 * it is touched on every `tool_use` AND on foreground sub-agent JSONL growth
 * (`subagent-watcher.ts`), so a healthy long turn keeps advancing the mtime
 * while a true hang lets it go stale. We key the kill on marker-mtime STALENESS,
 * not tool-open duration.
 *
 *   markerAgeMs (from readTurnActiveMarkerAgeMs) small  → progress → NOT a hang
 *   markerAgeMs large, or null (no progress signal at all) → stale → hang
 *
 * A per-agent cooldown prevents restart storms; recovery routes through the
 * ask-first resume path so a turn that would hang again the same way is
 * reported to the user, not silently re-run.
 *
 * Pure + deterministic: the clock, the marker age, and the cooldown reading are
 * all injected. The gateway owns the SIGTERM side effect + the cooldown file.
 */

export interface HangRestartInput {
  /** Was a tool still in flight when the fallback fired? Only a mid-tool
   *  fallback is a candidate — an ordinary silent wedge (no tool open) is
   *  handled by the existing state-teardown, not a process kill. */
  midToolCall: boolean
  /** Turn-active marker mtime age in ms (`readTurnActiveMarkerAgeMs`), or null
   *  when the marker is absent/unstattable (no progress signal). */
  markerAgeMs: number | null
  /** Staleness ceiling: marker age at/above this counts as "no progress". Keyed
   *  to the same TURN_HANG_SECS the boot classifier uses so the live decision
   *  and the boot reclassification agree on what "stalled" means. */
  stalenessThresholdMs: number
  /** True when a hang-restart fired recently (persisted cooldown) — suppress to
   *  avoid a restart storm. */
  cooldownActive: boolean
}

export interface HangRestartDecision {
  restart: boolean
  reason: string
}

/**
 * Decide whether a mid-tool framework-fallback should escalate to a real
 * restart. Pure.
 *
 *  - not mid-tool          → no restart (ordinary teardown path owns it)
 *  - cooldown active       → no restart (storm guard)
 *  - marker still advancing → no restart (healthy long tool / sub-agent — the
 *                             crux false-positive we must never kill)
 *  - marker stale or absent → RESTART (genuine hang: mid-tool + no progress)
 */
export function decideHangRestart(input: HangRestartInput): HangRestartDecision {
  if (!input.midToolCall) return { restart: false, reason: 'not-mid-tool' }
  if (input.cooldownActive) return { restart: false, reason: 'cooldown-active' }
  // A healthy long tool / sub-agent keeps touching the marker (tool_use +
  // sub-agent JSONL growth), so a SMALL non-null age means real progress.
  if (input.markerAgeMs != null && input.markerAgeMs < input.stalenessThresholdMs) {
    return { restart: false, reason: 'marker-advancing' }
  }
  return { restart: true, reason: 'mid-tool-marker-stale' }
}

/** Default staleness ceiling (ms) — mirrors the watchdog's TURN_HANG_SECS=300. */
export const DEFAULT_HANG_STALENESS_MS = 300_000

/**
 * Resolve the staleness ceiling from the environment, keyed to the SAME
 * `TURN_HANG_SECS` the boot classifier reads, so a live kill and the boot
 * reclassification agree on "stalled". Blank/garbage/non-positive → default.
 */
export function hangStalenessMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.TURN_HANG_SECS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HANG_STALENESS_MS
  return Math.floor(n * 1000)
}

/** Default per-agent cooldown between hang-restarts (ms). Generous: a hang that
 *  recurs immediately should surface to the user via the ask-first resume
 *  report, not spin the container. */
export const DEFAULT_HANG_RESTART_COOLDOWN_MS = 10 * 60_000

export function hangRestartCooldownMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWITCHROOM_HANG_RESTART_COOLDOWN_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_HANG_RESTART_COOLDOWN_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HANG_RESTART_COOLDOWN_MS
  return Math.floor(n)
}

/**
 * Is a persisted hang-restart cooldown still active? Pure decision over an
 * injected last-fire timestamp (null = never fired) + clock. The gateway reads
 * the timestamp off `hang-restart-cooldown.json`.
 */
export function isHangRestartCooldownActive(
  lastFireAt: number | null,
  now: number,
  cooldownMs: number,
): boolean {
  if (lastFireAt == null) return false
  return now - lastFireAt < cooldownMs
}
