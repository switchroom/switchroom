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
 * A healthy 20-minute research turn must NOT be killed. The honest progress
 * signal is the turn-active marker's mtime: it is touched on every `tool_use`
 * AND on foreground sub-agent JSONL growth (`subagent-watcher.ts`), so a turn
 * that keeps advancing it is working; a stale mtime means work stopped.
 *
 *   markerAgeMs (from readTurnActiveMarkerAgeMs) small  → progress → NOT a hang
 *   markerAgeMs large, or null (no progress signal at all) → stale → hang
 *
 * THE MARKER-ADVANCEMENT BLIND SPOT + THE TOOL-CLASS GUARD (review Finding A)
 *
 * The marker advances only on `tool_use` and sub-agent JSONL growth. A healthy
 * long SINGLE FOREGROUND tool with no sub-agent and no interim tool_use never
 * advances it — a 15-min foreground `Bash` build/test, a big `WebFetch`/crawl,
 * a multi-minute research call. At the 15-min silence ceiling that turn is
 * mid-tool with a stale marker and would be WRONGLY restarted by marker
 * staleness alone. So we additionally protect known-long-running tool classes:
 * if any in-flight tool is a `background`/long-fetch/research class, we do NOT
 * restart, regardless of marker age.
 *
 *   RESIDUAL RISK (documented, not silently accepted): a genuine hang INSIDE a
 *   protected long-running tool (a truly-wedged `Bash`, a `WebFetch` that never
 *   returns) is indistinguishable from healthy long work by any signal the
 *   gateway has — the marker cannot advance mid-single-tool either way. Those
 *   are NOT auto-restarted here; recovery for that class relies on the tool's
 *   own timeout, an operator `/restart`, or the ordinary state-teardown. We
 *   choose to never false-kill a healthy long tool over catching the rare
 *   hung-inside-a-long-tool case, because the false-kill is the common,
 *   user-visible harm and the discriminator exists precisely to avoid it.
 *
 * Recovery routes through the ask-first resume path so a turn that would hang
 * again the same way is reported to the user, not silently re-run — that is
 * also the storm guard (see § STORM GUARD below).
 *
 * Pure + deterministic: the clock, the marker age, and the in-flight tool names
 * are all injected. The gateway owns the SIGTERM side effect.
 */

/**
 * Tool classes ported from Stage A's tool-call-deadline taxonomy. `background`
 * covers sub-agent dispatch + long Bash; `human` covers approval waits;
 * `standard` is everything else. Stage B additionally treats a broader set of
 * single-foreground long tools as hang-restart-protected (see
 * `isHangRestartProtectedTool`).
 */
export type ToolDeadlineClass = 'standard' | 'human' | 'background'

/** Human-in-the-loop waits. */
const HUMAN_WAIT_TOOLS = new Set<string>(['ask_user'])
/** Sub-agent dispatch — progress is sub-agent JSONL growth. */
const BACKGROUND_TOOLS = new Set<string>(['Task', 'Agent'])

/**
 * Classify a tool into the Stage A taxonomy. `Bash` with `run_in_background` is
 * `background`; `Task`/`Agent` are `background`; `ask_user` is `human`.
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
 * Exact-name tools that legitimately run long as a SINGLE foreground call
 * without touching the marker, so their staleness is not a hang signal.
 */
const HANG_PROTECTED_EXACT = new Set<string>([
  'Task', 'Agent',      // sub-agent dispatch (background class)
  'Bash',               // foreground builds/tests routinely run many minutes
  'WebFetch', 'WebSearch',
])

/**
 * Name substrings marking long-running fetch/crawl/research MCP tools (matched
 * case-insensitively) — perplexity_research, deep research, site crawls, etc.
 */
const HANG_PROTECTED_SUBSTRINGS = ['research', 'perplexity', 'crawl', 'deep_research', 'webkite']

/**
 * True when a tool is a known-long-running / opaque-progress class that must
 * NOT be hang-restarted on marker staleness (review Finding A). Covers the
 * `background` class plus foreground Bash, web fetch/search, and research/crawl
 * MCP tools. `ask_user` (`human`) is also protected — an operator wait is not a
 * hang. See the module header § RESIDUAL RISK for the tradeoff.
 */
export function isHangRestartProtectedTool(toolName: string): boolean {
  if (HANG_PROTECTED_EXACT.has(toolName)) return true
  if (classifyToolClass(toolName) !== 'standard') return true // background / human
  const lower = toolName.toLowerCase()
  return HANG_PROTECTED_SUBSTRINGS.some((s) => lower.includes(s))
}

export interface HangRestartInput {
  /** Names of the tools in flight when the fallback fired (silence-poke
   *  snapshot). Empty ⇒ not a mid-tool fallback (ordinary teardown owns it). */
  inFlightToolNames: string[]
  /** Turn-active marker mtime age in ms (`readTurnActiveMarkerAgeMs`), or null
   *  when the marker is absent/unstattable (no progress signal). */
  markerAgeMs: number | null
  /** Staleness ceiling: marker age at/above this counts as "no progress". Keyed
   *  to the same TURN_HANG_SECS the boot classifier uses so the live decision
   *  and the boot reclassification agree on what "stalled" means. */
  stalenessThresholdMs: number
}

export interface HangRestartDecision {
  restart: boolean
  reason: string
}

/**
 * Decide whether a mid-tool framework-fallback should escalate to a real
 * restart. Pure.
 *
 *  - not mid-tool            → no restart (ordinary teardown path owns it)
 *  - a protected long tool in flight → no restart (healthy long tool / sub-
 *                              agent / research — the crux false-positive we
 *                              must never kill; see § RESIDUAL RISK)
 *  - marker still advancing  → no restart (real progress)
 *  - marker stale or absent  → RESTART (genuine hang: mid-tool + no progress
 *                              + no protected long tool that would explain it)
 */
export function decideHangRestart(input: HangRestartInput): HangRestartDecision {
  if (input.inFlightToolNames.length === 0) return { restart: false, reason: 'not-mid-tool' }
  // Finding A: never restart while a known-long-running tool is in flight — a
  // stale marker is EXPECTED for a single long foreground tool.
  const protectedName = input.inFlightToolNames.find(isHangRestartProtectedTool)
  if (protectedName != null) {
    return { restart: false, reason: `protected-long-tool:${protectedName}` }
  }
  // A working turn keeps touching the marker (tool_use + sub-agent JSONL
  // growth), so a SMALL non-null age means real progress.
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

/**
 * § STORM GUARD (review Finding B)
 *
 * There is deliberately NO restart cooldown here. A cooldown could only engage
 * if two hang-restarts fired close together, but two mid-tool framework
 * fallbacks are >= the 15-min silence-defer ceiling apart (they only fire after
 * that ceiling), so a sub-15-min cooldown can never engage on the organic path
 * — a dead guard giving false confidence. The REAL storm guard is the ask-first
 * `resume_watchdog_timeout` recovery: after a hang-restart the agent does NOT
 * auto-resume the wedged work — it reports to the user and asks — so the same
 * hang cannot immediately recur without fresh human action. That is sufficient
 * and self-documenting; a persisted cooldown file is not needed.
 */
