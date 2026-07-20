/**
 * tool-call-deadline.ts — deterministic per-tool-call wall-clock deadline.
 *
 * WHY THIS EXISTS
 *
 * The gateway classifies "a tool is mid-call" as healthy work: while any
 * tool_use is open, `isLegitimatelyWorking` (gateway.ts) returns true and the
 * silence-poke 300s framework fallback is DEFERRED all the way to the 15-min
 * hard ceiling (silence-poke.ts tick()). A tool that never returns therefore
 * pins the conversation for 15 minutes before any net even considers acting —
 * and even then the fallback only tears down gateway state, never the child.
 * This is the "carrie" hang mode: an in-flight tool call that waits forever.
 *
 * This module bounds every in-flight tool with a hard wall-clock deadline,
 * measured from the tool's own `startedAt`, independent of the outbound-silence
 * clock. Past the class ceiling the tracker reports a BREACH; the gateway
 * injects a synthetic `tool_result` error for that toolUseId and drops the
 * masked flight entry so the hang stops being classified as healthy work.
 *
 * THREE CLASSES
 *
 *   - `standard`  — ordinary foreground tool calls (Read, Grep, most MCP tools).
 *                   Short ceiling (~120s). A standard tool that runs longer than
 *                   this is either genuinely wedged or so slow the model is
 *                   better served by an error it can react to than by an
 *                   unbounded stall.
 *   - `human`     — genuine human-in-the-loop waits (`ask_user`, and any tool
 *                   parked on an operator approval card). These are NOT
 *                   force-failed here: their lifetime is owned by the existing
 *                   permission-TTL sweep (`permission-ttl-sweep.ts`, #2724),
 *                   which auto-denies on a human-scale TTL. Double-reaping them
 *                   on a 120s clock would deny operators mid-decision.
 *   - `background`— legitimately long-running foreground tools whose progress
 *                   the gateway measures by a SEPARATE signal, so a fixed
 *                   wall-clock ceiling would misjudge them as hung: `Task` /
 *                   `Agent` sub-agent dispatches (progress = sub-agent JSONL
 *                   growth, `subagent-watcher.ts`) and long `Bash` runs. These
 *                   are EXCLUDED from the short ceiling — keying a kill on
 *                   "tool open N seconds" is exactly the anti-pattern the
 *                   turn-active-marker discriminator (Stage B) exists to avoid.
 *
 * The `human` and `background` classes exist so the tracker excludes them from
 * the short ceiling DETERMINISTICALLY rather than by omission.
 *
 * ENFORCEMENT IS OPT-IN. The tracker always observes and always reports
 * breaches, but the gateway only takes the destructive force-fail action when
 * enforcement is explicitly enabled (`SWITCHROOM_TOOL_DEADLINE_ENFORCE=1`).
 * Shipping the mechanism inert-by-default keeps the blast radius low: the
 * deterministic machinery + the per-toolUseId guard land and are proven by
 * tests, and enforcement is switched on per-agent once the Stage B
 * marker-staleness discriminator can distinguish a hang from a slow tool.
 *
 * THE PER-toolUseId GUARD (critical)
 *
 * After a breach the tracker remembers the toolUseId in a `reaped` set. If the
 * real `tool_result` for that id later arrives (the tool finally returned, or
 * the injected error raced the genuine completion), `noteResult` returns
 * `false` so the caller DROPS it — the model already received the synthetic
 * error, and processing the late real result would double-count the flight and
 * corrupt the silence/liveness bookkeeping. A result for a never-breached id
 * returns `true` (process normally).
 *
 * This module is pure and deterministic: the clock is injected, there are no
 * timers or IO. The gateway owns the timer and the injection side effect.
 */

/** Deadline class for an in-flight tool call. */
export type ToolDeadlineClass = 'standard' | 'human' | 'background'

/** An in-flight tool call under deadline tracking. */
export interface DeadlineEntry {
  toolUseId: string
  name: string
  startedAt: number
  klass: ToolDeadlineClass
}

/** A tool call that has exceeded its deadline and must be force-failed. */
export interface DeadlineBreach {
  toolUseId: string
  name: string
  klass: ToolDeadlineClass
  /** Wall-clock ms the tool was in flight when the breach was detected. */
  elapsedMs: number
  /** The class ceiling that was crossed, in ms. */
  deadlineMs: number
}

export interface DeadlineConfig {
  /** Ceiling for `standard` tools (default 120_000). */
  standardMs: number
  /**
   * Ceiling for `human` tools. Defaults to +Infinity: human waits are owned by
   * the permission-TTL sweep, so this tracker never force-fails them. Kept
   * configurable so a test can prove the exclusion explicitly.
   */
  humanMs: number
  /**
   * Ceiling for `background` tools (Task/Agent/long Bash). Defaults to
   * +Infinity: their health is judged by the marker-staleness discriminator
   * (Stage B), not a wall-clock. Configurable so a test can prove the exclusion.
   */
  backgroundMs: number
}

/** Default short ceiling for a standard tool call. */
export const DEFAULT_STANDARD_DEADLINE_MS = 120_000

export const DEFAULT_DEADLINE_CONFIG: DeadlineConfig = {
  standardMs: DEFAULT_STANDARD_DEADLINE_MS,
  humanMs: Number.POSITIVE_INFINITY,
  backgroundMs: Number.POSITIVE_INFINITY,
}

/**
 * Resolve the live deadline config from the environment: `standard` from
 * `SWITCHROOM_TOOL_DEADLINE_STANDARD_MS`; `human` + `background` stay +Infinity
 * (owned by the permission-TTL sweep / marker-staleness discriminator).
 */
export function resolveDeadlineConfig(
  env: Record<string, string | undefined> = process.env,
): DeadlineConfig {
  return {
    standardMs: standardDeadlineMs(env),
    humanMs: Number.POSITIVE_INFINITY,
    backgroundMs: Number.POSITIVE_INFINITY,
  }
}

/**
 * Resolve the standard-tool deadline from the environment. Threaded as
 * `SWITCHROOM_TOOL_DEADLINE_STANDARD_MS`; a blank/garbage/non-positive value
 * falls back to the default so the deadline can never be born already-expired.
 */
export function standardDeadlineMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWITCHROOM_TOOL_DEADLINE_STANDARD_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_STANDARD_DEADLINE_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STANDARD_DEADLINE_MS
  return Math.floor(n)
}

/** Kill switch — the tracker stops OBSERVING entirely when set to `0`/`false`. */
export function toolCallDeadlineEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env.SWITCHROOM_DISABLE_TOOL_DEADLINE
  return !(v === '1' || v === 'true')
}

/**
 * Whether the gateway takes the destructive force-fail action on a breach.
 * OPT-IN (default OFF): the tracker + guard ship inert so the mechanism lands
 * with low blast radius; enforcement is enabled per-agent once Stage B's
 * marker-staleness discriminator is in place. See file header § ENFORCEMENT.
 */
export function toolCallDeadlineEnforced(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env.SWITCHROOM_TOOL_DEADLINE_ENFORCE
  return v === '1' || v === 'true'
}

/** Tool names that are genuine human-in-the-loop waits (deadline class `human`). */
const HUMAN_WAIT_TOOLS = new Set<string>(['ask_user'])

/**
 * Tool names whose progress is measured by a separate signal (sub-agent JSONL
 * growth / background output), so a fixed wall-clock ceiling would misjudge a
 * healthy long run as a hang — deadline class `background`.
 */
const BACKGROUND_TOOLS = new Set<string>(['Task', 'Agent'])

/**
 * Classify a tool call into a deadline class.
 *
 *  - `ask_user`, or any tool the caller flags as parked on an operator approval
 *    card → `human` (owned by the permission-TTL sweep).
 *  - `Task` / `Agent` sub-agent dispatch, or a `Bash` flagged as a background /
 *    long run → `background` (health judged by marker staleness, Stage B).
 *  - everything else → `standard`.
 */
export function classifyToolClass(
  toolName: string,
  opts: { awaitingApproval?: boolean; backgroundBash?: boolean } = {},
): ToolDeadlineClass {
  if (opts.awaitingApproval === true) return 'human'
  if (HUMAN_WAIT_TOOLS.has(toolName)) return 'human'
  if (BACKGROUND_TOOLS.has(toolName)) return 'background'
  if (toolName === 'Bash' && opts.backgroundBash === true) return 'background'
  return 'standard'
}

/**
 * The synthetic `tool_result` error body injected when a standard tool breaches
 * its deadline. Phrased so the model treats it as an operational error it can
 * react to (retry differently / report / move on), not a denial.
 */
export function deadlineErrorText(name: string, deadlineMs: number): string {
  const seconds = Math.round(deadlineMs / 1000)
  return (
    `Tool "${name}" exceeded its ${seconds}s wall-clock deadline and was ` +
    `force-failed by the gateway. It did not return in time. Do not simply ` +
    `retry the identical call — either take a different approach or tell the ` +
    `user this step could not complete.`
  )
}

/**
 * Deterministic tracker of in-flight tool calls against a per-call deadline.
 * Pure: the caller injects the clock (`now`) and owns the timer + the synthetic
 * result injection. See file header for the class + guard semantics.
 */
export class ToolCallDeadlineTracker {
  private readonly inFlight = new Map<string, DeadlineEntry>()
  /** toolUseIds force-failed on a breach — a later real result for one of these
   *  is dropped (the per-toolUseId double-processing guard). */
  private readonly reaped = new Set<string>()

  /**
   * Record the start of a tool call. Idempotent: a repeat start for the same
   * id overwrites (refreshes startedAt/label), matching silence-poke's
   * noteToolStart. Clears any stale reaped mark for a reused id.
   */
  noteStart(
    toolUseId: string,
    name: string,
    klass: ToolDeadlineClass,
    startedAt: number,
  ): void {
    if (toolUseId.length === 0) return
    this.reaped.delete(toolUseId)
    this.inFlight.set(toolUseId, { toolUseId, name, startedAt, klass })
  }

  /**
   * Record a tool_result for `toolUseId`.
   *
   * Returns `true` when the caller should process the result normally, `false`
   * when it must be DROPPED because the tool was already force-failed on a
   * breach (the synthetic error was injected; the late real result would
   * double-process). A result for an unknown/never-tracked id returns `true`
   * (nothing to guard).
   */
  noteResult(toolUseId: string): boolean {
    if (toolUseId.length === 0) return true
    if (this.reaped.delete(toolUseId)) return false
    this.inFlight.delete(toolUseId)
    return true
  }

  /**
   * Detect deadline breaches at wall-clock `now`. For every in-flight tool
   * whose class ceiling has been crossed, emit a breach, mark it reaped, and
   * drop it from the in-flight map (so the next sweep does not re-report it and
   * so `has`/`size` reflect that the gateway is about to force-fail it).
   *
   * `human` tools are never breached here (their ceiling defaults to +Infinity)
   * — the permission-TTL sweep owns them.
   */
  sweep(now: number, cfg: DeadlineConfig = DEFAULT_DEADLINE_CONFIG): DeadlineBreach[] {
    const breaches: DeadlineBreach[] = []
    for (const [id, entry] of this.inFlight) {
      const deadlineMs =
        entry.klass === 'human'
          ? cfg.humanMs
          : entry.klass === 'background'
            ? cfg.backgroundMs
            : cfg.standardMs
      if (!Number.isFinite(deadlineMs)) continue
      const elapsedMs = now - entry.startedAt
      if (elapsedMs >= deadlineMs) {
        breaches.push({
          toolUseId: id,
          name: entry.name,
          klass: entry.klass,
          elapsedMs,
          deadlineMs,
        })
      }
    }
    for (const b of breaches) {
      this.inFlight.delete(b.toolUseId)
      this.reaped.add(b.toolUseId)
    }
    return breaches
  }

  /** True when at least one tool is in flight under deadline tracking. */
  hasInFlight(): boolean {
    return this.inFlight.size > 0
  }

  /** Count of in-flight tool calls under deadline tracking (diagnostics). */
  inFlightCount(): number {
    return this.inFlight.size
  }

  /**
   * Clear all in-flight + reaped state — called on turn_end / enqueue (a new
   * turn starts clean; a killed turn may never emit trailing results). Mirrors
   * ToolFlightTracker.clear().
   */
  clear(): void {
    this.inFlight.clear()
    this.reaped.clear()
  }
}

/**
 * Observe a `tool_use` event: classify the tool and start its deadline clock.
 * Keeps the gateway's session-event handler a thin call. No-op when the
 * subsystem is disabled or the id is empty.
 */
export function observeToolUse(
  tracker: ToolCallDeadlineTracker,
  toolUseId: string | null | undefined,
  toolName: string,
  input: unknown,
  now: number,
): void {
  if (!toolCallDeadlineEnabled()) return
  if (toolUseId == null || toolUseId.length === 0) return
  const backgroundBash = (input as { run_in_background?: boolean } | undefined)?.run_in_background === true
  tracker.noteStart(toolUseId, toolName, classifyToolClass(toolName, { backgroundBash }), now)
}

/** Gateway-supplied side effects for the deadline sweep (P0c: the module owns
 *  the decision, the gateway owns the timer + the IO). */
export interface DeadlineSweepDeps {
  /** When false, breaches are only logged (observe-only) — not force-failed. */
  enforce: boolean
  /** Emit one diagnostic line (gateway prefixes + writes to stderr). */
  log: (line: string) => void
  /**
   * Force-fail a breached tool: the gateway un-masks the hang by dropping the
   * flight entry from the interrupt-defer tracker + the silence-poke in-flight
   * map so `isMidToolCall` stops classifying it as healthy work.
   */
  onForceFail: (breach: DeadlineBreach) => void
}

/**
 * Sweep the tracker at `now`, log every breach, and force-fail each one when
 * enforcement is enabled. The pure decision (which tools breached) lives in
 * `tracker.sweep`; this wraps it with the logging + enforcement policy so the
 * gateway's timer callback stays a thin shell (gateway anti-inflation ratchet,
 * switchroom#2996).
 */
export function sweepToolCallDeadlines(
  tracker: ToolCallDeadlineTracker,
  now: number,
  cfg: DeadlineConfig,
  deps: DeadlineSweepDeps,
): DeadlineBreach[] {
  const breaches = tracker.sweep(now, cfg)
  for (const b of breaches) {
    deps.log(
      `[tool-deadline] breach tool=${b.name} class=${b.klass} ` +
      `elapsed=${Math.round(b.elapsedMs / 1000)}s ` +
      `deadline=${Math.round(b.deadlineMs / 1000)}s enforce=${deps.enforce} ` +
      `synthetic="${deadlineErrorText(b.name, b.deadlineMs)}"`,
    )
    if (deps.enforce) deps.onForceFail(b)
  }
  return breaches
}
