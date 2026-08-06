/**
 * Per-session privacy state — the gateway side of the `/private` `/public`
 * feature (switchroom private-mode).
 *
 * The operator can pause Hindsight auto-retain for a stretch of a session with
 * `/private`, then resume it with `/public`. The pause is recorded here as a
 * list of half-open time intervals in a small JSON state file that the Python
 * retain side (`vendor/hindsight-memory`) reads to EXCLUDE any turn whose
 * timestamp falls inside an interval from memory.
 *
 * ── The state-file contract (MUST match the Python reader exactly) ──────────
 * Path: `${TELEGRAM_STATE_DIR}/privacy-state.json` (dir resolved the same way
 * `src/cli/self-improve-stop.ts:resolveStateDir()` does). Schema:
 *
 *   { "version": 1,
 *     "intervals": [
 *       { "start": "2026-08-06T02:00:25.558Z", "end": "2026-08-06T02:05:10.100Z" },
 *       { "start": "2026-08-06T02:10:00.000Z", "end": null }
 *     ] }
 *
 * `end: null` = an OPEN interval = "private right now". At most one is open at
 * a time. A missing file (or `{"intervals":[]}`) means public — the default.
 * Timestamps are ISO-8601 via `new Date().toISOString()`.
 *
 * ── Invariants ──────────────────────────────────────────────────────────────
 *   - All writes are ATOMIC (tmp + fsync + rename via `atomicWriteFileSync`),
 *     so a crash mid-write can never leave the Python reader a torn file.
 *   - All reads are BEST-EFFORT and never throw: a missing, unreadable, or
 *     corrupt file resolves to the public default. Losing this state is
 *     fail-safe (memory records rather than drops), so — unlike the security
 *     stores — a corrupt file here is tolerated silently rather than
 *     quarantined.
 *   - `openPrivateInterval` / `closePrivateInterval` are IDEMPOTENT: a second
 *     `/private` while already private is a no-op, and `/public` while already
 *     public is a no-op.
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { atomicWriteFileSync } from '../../src/util/atomic.js'

/** One half-open privacy interval. `end: null` = still open ("private now"). */
export interface PrivacyInterval {
  start: string
  end: string | null
}

/** The on-disk shape of `privacy-state.json`. */
export interface PrivacyState {
  version: 1
  intervals: PrivacyInterval[]
}

/** The public (default) state — no private intervals. */
export function emptyPrivacyState(): PrivacyState {
  return { version: 1, intervals: [] }
}

// ── Loud, verbatim operator-facing strings ──────────────────────────────────
// Exported so the gateway command handlers and the boot alert use the exact
// wording the spec pins (and so tests assert against a single source).

/** Reply to `/private`. */
export const PRIVATE_ON_REPLY =
  '🔒 Private mode ON — memory writing paused. Nothing said until /public is stored.'

/** Reply to `/public`. */
export const PUBLIC_REPLY =
  '🔓 Public mode — memory writing resumed. The private stretch was excluded from memory.'

/** Loud alert posted when a genuine session start reset a leftover open interval. */
export const SESSION_RESET_ALERT =
  '🔓 New session — memory writing is ON by default. Private mode from the previous session was reset.'

/**
 * Agent state dir — set by start.sh; resolved identically to
 * `self-improve-stop.ts:resolveStateDir()` so the gateway writer and the
 * Python reader agree on where `privacy-state.json` lives.
 */
export function resolvePrivacyStateDir(): string {
  return (
    process.env.TELEGRAM_STATE_DIR ??
    join(homedir(), '.claude', 'channels', 'telegram')
  )
}

/** Absolute path to the shared state file. */
export function privacyStatePath(stateDir: string = resolvePrivacyStateDir()): string {
  return join(stateDir, 'privacy-state.json')
}

/** True iff `v` is a well-formed interval object. */
function isInterval(v: unknown): v is PrivacyInterval {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.start !== 'string') return false
  return o.end === null || typeof o.end === 'string'
}

/**
 * Read the current privacy state. BEST-EFFORT: a missing / unreadable /
 * corrupt file resolves to the public default and NEVER throws. Only
 * well-formed intervals survive; a partially-corrupt array is filtered down to
 * its valid members rather than discarded wholesale.
 */
export function readPrivacyState(stateDir: string = resolvePrivacyStateDir()): PrivacyState {
  try {
    const raw = readFileSync(privacyStatePath(stateDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return emptyPrivacyState()
    const rawIntervals = (parsed as Record<string, unknown>).intervals
    if (!Array.isArray(rawIntervals)) return emptyPrivacyState()
    return { version: 1, intervals: rawIntervals.filter(isInterval) }
  } catch {
    return emptyPrivacyState()
  }
}

/**
 * Atomically persist `state`. BEST-EFFORT: a write failure is logged to stderr
 * and swallowed so a transient fs error can never crash a command handler or
 * the boot path. (Losing the write is fail-safe — memory records the turn.)
 */
function writePrivacyState(state: PrivacyState, stateDir: string): void {
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch {
    /* dir may already exist / be unwritable — the write below reports */
  }
  try {
    atomicWriteFileSync(privacyStatePath(stateDir), JSON.stringify(state), 0o600)
  } catch (err) {
    process.stderr.write(
      `telegram gateway: privacy-state write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

/** True iff an interval is currently open ("private right now"). */
export function isPrivate(state: PrivacyState): boolean {
  return state.intervals.some(i => i.end === null)
}

/**
 * Start a private stretch. IDEMPOTENT: if an interval is already open this is a
 * no-op (a second `/private` doesn't stack).
 */
export function openPrivateInterval(
  now: Date = new Date(),
  stateDir: string = resolvePrivacyStateDir(),
): void {
  const state = readPrivacyState(stateDir)
  if (isPrivate(state)) return
  state.intervals.push({ start: now.toISOString(), end: null })
  writePrivacyState(state, stateDir)
}

/**
 * End the current private stretch. IDEMPOTENT: if no interval is open (already
 * public) this is a no-op.
 */
export function closePrivateInterval(
  now: Date = new Date(),
  stateDir: string = resolvePrivacyStateDir(),
): void {
  const state = readPrivacyState(stateDir)
  const open = state.intervals.find(i => i.end === null)
  if (!open) return
  open.end = now.toISOString()
  writePrivacyState(state, stateDir)
}

/** Truncate the state file back to the public default. */
export function resetToPublic(stateDir: string = resolvePrivacyStateDir()): void {
  writePrivacyState(emptyPrivacyState(), stateDir)
}

/** Outcome of a session-start reset. */
export interface SessionResetResult {
  /** True iff an OPEN interval existed and was reset (a private→public transition). */
  hadOpenInterval: boolean
}

/**
 * Reset privacy to public at a GENUINE session start (cold boot / crash /
 * planned restart / `/clear`). Always truncates the state file. If — and only
 * if — an OPEN interval existed (the previous session ended still private),
 * `onOpenIntervalReset` is invoked so the caller can post the loud alert. When
 * the previous session was already public there is no transition, so no alert
 * fires (silent reset).
 *
 * The alert is delegated to a callback rather than sent here so this module
 * stays free of gateway/bot dependencies and unit-testable in isolation.
 */
export function resetPrivacyOnGenuineSessionStart(opts: {
  stateDir?: string
  onOpenIntervalReset?: () => void
} = {}): SessionResetResult {
  const stateDir = opts.stateDir ?? resolvePrivacyStateDir()
  const hadOpenInterval = isPrivate(readPrivacyState(stateDir))
  resetToPublic(stateDir)
  if (hadOpenInterval) opts.onOpenIntervalReset?.()
  return { hadOpenInterval }
}
