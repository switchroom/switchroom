/**
 * turn-liveness-floor.ts — the mid-turn liveness floor decision (issue #2527).
 *
 * The conversational-pacing safety net (`silence-poke.ts`) only ever sent a
 * user-visible TEXT signal at its 300s framework fallback, and DEFERRED even
 * that while the agent was "legitimately working" (an in-flight tool) on the
 * rationale that the live activity feed renders the work. But the feed only
 * exists for BACKGROUND sub-agents — a FOREGROUND turn grinding through
 * minutes of silent Bash/Read/restart calls has no feed, so the user sees
 * only the ambient 👀 and reasonably reads it as "done" (the documented
 * #2527 evidence: a 6-minute silent diagnose with "Status?" asked twice).
 *
 * This module is the missing floor: a code-owned, fire-once-per-turn interim
 * that fires PRECISELY BECAUSE the turn is busy-but-silent — the exact
 * inversion of silence-poke's "busy ⇒ suppress" defer. It is a pure decision
 * (the gateway owns the actual send, through the same path a model reply
 * takes) so the policy is unit-testable in isolation.
 *
 * Design contract: `reference/rfcs/turn-liveness-primitive.md`.
 * Job: `reference/jobs/know-what-my-agent-is-doing.md`.
 *
 * Keyed on LOOP ROLE, never chat type — so a DM and a forum-supergroup
 * topic get identical guarantees (surface parity by construction), and the
 * floor binds only the `user` role (a `system`/cron turn's silence is
 * legitimate; a `sub-agent`'s liveness is carried by the parent turn).
 */

/**
 * The single turn-provenance discriminator. Stamped once at enqueue and read
 * everywhere — replaces the scattered `chatType !== 'private'` /
 * `chatId == null` / `source === 'cron'` predicates. A research worker and a
 * nested sub-agent are BOTH `sub-agent`: new agent *types* are not new roles.
 */
export type LoopRole = 'user' | 'sub-agent' | 'system'

/**
 * Enqueue `source` values that mark a turn as system-initiated (no human is
 * waiting at that instant, so silence is legitimate). Everything else —
 * including a plain human DM (no source) and a sub-agent handback that
 * continues user-facing work — is `user` and owes the never-silent guarantee.
 *
 * Conservative by design: only known scheduled/wake sources are `system`, so
 * a novel source defaults to `user` (gets liveness) rather than silently
 * opting out of the floor.
 */
const SYSTEM_SOURCES = new Set(['cron', 'wake', 'schedule', 'scheduler', 'timer', 'heartbeat'])

/**
 * Derive the loop role for a MAIN-session turn from its enqueue envelope
 * (`<channel ... source="cron" ...>`). The gateway never creates a turn atom
 * for a sub-agent — those terminate on `SubagentStop` — so this returns only
 * `user` | `system`. Parsing mirrors `silent-end-scan.mjs:parseChannelEnvelope`.
 */
export function deriveTurnRole(rawContent: string | null | undefined): Exclude<LoopRole, 'sub-agent'> {
  if (typeof rawContent !== 'string') return 'user'
  const m = rawContent.match(/<channel[^>]*\bsource="([^"]+)"/)
  const source = m ? m[1] : null
  if (source != null && SYSTEM_SOURCES.has(source)) return 'system'
  return 'user'
}

export interface MidTurnFloorInput {
  /** Kill switch — `midTurnFloorEnabled()` resolved by the caller. */
  enabled: boolean
  /** The turn's loop role. The floor binds ONLY `user`. */
  role: LoopRole
  /** Whether a substantive answer has already reached the user this turn. */
  finalAnswerDelivered: boolean
  /** ms since the last user-visible outbound (or turn start if none). */
  silenceMs: number
  /** Floor threshold — fire at/after this much silence (default 45s). */
  floorThresholdMs: number
  /** The 300s fallback threshold — above it, the fallback owns the beat. */
  fallbackThresholdMs: number
  /** Whether the agent is demonstrably working (in-flight tool / dispatched
   *  sub-agent / open ask_user). The floor fires only when working — a
   *  genuinely silent/wedged turn is the 300s fallback's job. */
  legitimatelyWorking: boolean
  /** Whether the floor has already fired once this turn (fire-once latch). */
  alreadyFired: boolean
  /** When true (a user "Status?" mid-turn inbound), bypass the threshold and
   *  the working check — the user explicitly asked, so answer immediately —
   *  but still honour role / delivery / fire-once / enabled. */
  force?: boolean
}

export type MidTurnFloorDecision =
  | { kind: 'fire' }
  | { kind: 'skip'; reason: string }

/**
 * Pure decision: should the mid-turn liveness floor fire now?
 *
 * Fires exactly once per `user` turn when the turn has been silently working
 * past the floor threshold (and below the 300s fallback window), OR
 * immediately on a forced "Status?" poke. Skips with a machine-readable
 * reason otherwise so the decision is observable in telemetry.
 */
export function decideMidTurnFloor(input: MidTurnFloorInput): MidTurnFloorDecision {
  if (!input.enabled) return { kind: 'skip', reason: 'disabled' }
  if (input.alreadyFired) return { kind: 'skip', reason: 'already-fired' }
  // The floor binds the user role only — system/cron silence is legitimate,
  // and a sub-agent's liveness is carried by its parent turn.
  if (input.role !== 'user') return { kind: 'skip', reason: 'non-user-role' }
  // The user already saw a real answer — no floor needed.
  if (input.finalAnswerDelivered) return { kind: 'skip', reason: 'answer-delivered' }

  // A forced poke (user asked "Status?") short-circuits timing + working.
  if (input.force === true) return { kind: 'fire' }

  if (input.silenceMs < input.floorThresholdMs) return { kind: 'skip', reason: 'below-threshold' }
  // At/above the 300s window the loud fallback owns the beat; the floor
  // is the quiet early one.
  if (input.silenceMs >= input.fallbackThresholdMs) return { kind: 'skip', reason: 'fallback-window' }
  // Only fire when the turn is demonstrably busy: a genuinely silent turn is
  // a wedge, which is the 300s fallback's job (it unwedges; the floor does not).
  if (!input.legitimatelyWorking) return { kind: 'skip', reason: 'not-working' }
  return { kind: 'fire' }
}

export interface TerminalReasonInput {
  /** Kill switch for the role-aware terminal honesty (#2527). */
  enabled: boolean
  /** The turn's loop role. */
  role: LoopRole
  /** Whether a substantive answer reached the user this turn. */
  finalAnswerDelivered: boolean
}

/**
 * Pure decision: which terminal reaction a turn finalizes to.
 *
 * `'undelivered'` (😐, the gentle non-celebratory terminal) ONLY when a
 * `user` turn ends without a delivered answer and the honesty gate is on —
 * the #2527 "thumbs-up false done" fix. Everything else (a delivered user
 * turn, any system/sub-agent turn, or the gate disabled) is `'done'` (👍).
 * A `system`/cron turn's silence is legitimate, so it keeps 👍.
 */
export function decideTerminalReason(input: TerminalReasonInput): 'done' | 'undelivered' {
  if (!input.enabled) return 'done'
  if (input.role !== 'user') return 'done'
  if (input.finalAnswerDelivered) return 'done'
  return 'undelivered'
}

/** Default floor threshold — fire a first liveness beat after this much
 *  busy-silence. 45s is comfortably past a normal short turn and well under
 *  the 300s wedge fallback. Overridable via env at the gateway. */
export const DEFAULT_FLOOR_THRESHOLD_MS = 45_000

/**
 * Kill switch for the mid-turn floor. Default ON; set
 * `SWITCHROOM_TG_LIVENESS_FLOOR` to `0`/`false`/`off`/`no` to disable without
 * a rebuild. Re-read every call so tests can toggle env without reloading.
 */
export function midTurnFloorEnabled(): boolean {
  const v = process.env.SWITCHROOM_TG_LIVENESS_FLOOR
  if (v == null) return true
  const t = v.trim().toLowerCase()
  return !(t === '0' || t === 'false' || t === 'off' || t === 'no')
}

/**
 * Parse the post-answer liveness window (`SWITCHROOM_POST_ANSWER_LIVENESS_MS`).
 *
 * This is the threshold (in ms) after the substantive final answer at which
 * `feedHeartbeatTick` will surface a post-answer background-activity card when
 * genuine new sub-agent/tool activity is detected (i.e. `lastToolLabelAt` has
 * advanced past the answer-delivery timestamp). This restores the #2547
 * visibility outcome under the #2564 determinism gate.
 *
 *   - UNSET or empty ⇒ **6 000 ms** (default on, matching the
 *     `FEED_HEARTBEAT_MIN_STALE_MS` cadence constant in gateway.ts — after one
 *     heartbeat interval of post-answer real-tool activity the card surfaces).
 *   - a positive integer ⇒ that threshold in ms (operator override).
 *   - 0 or negative ⇒ **0** = silent post-answer behaviour (opt-out).
 *   - non-numeric or "0" ⇒ treated as 0 (silent).
 *
 * Extracted as a pure function so the contract is unit-testable
 * (gateway.ts is not importable in isolation — top-level side effects). Mirrors
 * `parseVisibleAnswerStreamEnabled`'s pattern.
 */
export const POST_ANSWER_LIVENESS_DEFAULT_MS = 6_000

export function parsePostAnswerLivenessMs(raw: string | undefined): number {
  if (raw == null || raw === '') return POST_ANSWER_LIVENESS_DEFAULT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n
}
