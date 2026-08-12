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
 *   - at most ONE escalation per gateway boot (in-memory fuse), AND at
 *     most MAX_CONSECUTIVE_ESCALATIONS across boots (the escalation
 *     marker carries a consecutive-fire count — see below): a bridge
 *     that dies deterministically at startup must not restart-loop the
 *     agent forever;
 *   - skipped while the gateway is mid-shutdown;
 *   - skipped when the claude session process is NOT alive (that is a
 *     different failure class — container boot still in progress, or
 *     claude itself down — where a bounce is either premature or
 *     futile); the timer re-arms so a slow-booting claude gets the full
 *     grace window again once it appears;
 *   - cron-session bridges (`<agent>-cron`), anonymous IPC clients
 *     (recall.py one-shots, pre-handshake connects), AND secondary/relay
 *     clients that register a DIFFERENT agent name than this gateway serves
 *     (e.g. an `overlord-relay` connecting into another agent's gateway
 *     socket — #3086) neither satisfy nor re-arm the watchdog: only the
 *     gateway's OWN primary bridge (agentName === $SWITCHROOM_AGENT_NAME)
 *     counts. The gating lives INSIDE noteBridge* so a gateway handler
 *     refactor can't silently reintroduce the bounce-after-cron-fire or the
 *     bounce-after-relay-disconnect false positive;
 *   - loud, structured escalation log line including a fresh
 *     bridge-crash.log tail (PR #3037 breadcrumbs) so the operator sees
 *     WHY from the supervisor log alone.
 *
 * Honest resume: before firing the restart, the watchdog persists an
 * escalation marker (`STATE_DIR/bridge-dead-escalation.json`). The next
 * boot consumes it and (a) appends the real cause to the synthetic boot
 * resume/report inbound when work was in flight, or (b) synthesizes a
 * minimal idle notice (buildBridgeDeadIdleNoticeInbound) when nothing
 * was — either way the agent tells the user "my chat bridge died and the
 * framework restarted me" instead of implying a watchdog timeout or an
 * operator restart, and the chat is never left wondering why the
 * container bounced.
 *
 * Pure-ish module: all IO (fs, timers, process liveness, restart) is
 * injected so the decision logic and the controller are unit-testable
 * without booting a gateway.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { isCronIdentity } from './cron-session.js'
import type { InboundMessage } from './ipc-protocol.js'

/** The distinct triggerSelfRestart reason for this escalation. Like every
 *  other switchroom-managed relaunch it reverts any session `/model` override
 *  to the configured default (session-scoped, rev 4). */
export const BRIDGE_DEAD_RESTART_REASON = 'bridge-dead-resume'

/** Default grace window before a missing bridge is treated as dead.
 *  Override with SWITCHROOM_BRIDGE_DEAD_GRACE_MS. Chosen well above the
 *  normal boot register time (bridge registers within ~1-5s of claude
 *  start) but well below the 7-minute mute window of the incident. */
export const DEFAULT_BRIDGE_DEAD_GRACE_MS = 90_000

/** Escalation marker freshness window at next boot. A marker older than
 *  this is stale debris (the escalated restart happened long ago or never
 *  completed) — cleared without surfacing, and the consecutive-escalation
 *  streak resets with it. */
export const ESCALATION_MARKER_MAX_AGE_MS = 10 * 60_000

/** Cross-boot restart-loop damper: the once-per-boot fuse is in-memory
 *  and a container bounce RESETS it, so a bridge that dies
 *  deterministically at startup (corrupt plugin bundle, bad .mcp.json)
 *  would otherwise bounce the container every grace window forever,
 *  spamming boot cards. The escalation marker carries a consecutive-fire
 *  `count`; a boot that consumed a marker with count >= this cap stands
 *  the watchdog down (loud audit line, operator investigates) instead of
 *  firing again. A successful bridge registration at any boot breaks the
 *  streak. With the default cap of 2 the framework attempts the
 *  self-heal twice, then stops. */
export const MAX_CONSECUTIVE_ESCALATIONS = 2

/** Crash-breadcrumb entries older than this are not "fresh" — they refer
 *  to some earlier incident and would mislead the escalation log line. */
export const CRASH_LOG_FRESH_WINDOW_MS = 15 * 60_000

/** Max breadcrumb lines quoted into the escalation log / marker. */
const CRASH_LOG_TAIL_LINES = 3

// ─── Pure decision ───────────────────────────────────────────────────────────

export interface BridgeDeadSnapshot {
  /** A real (named, non-cron) bridge is currently registered. */
  bridgeRegistered: boolean
  /** A real bridge registered at some point THIS boot (breaks the
   *  cross-boot escalation streak even if it later disconnected). */
  bridgeEverRegistered: boolean
  /** The claude session process exists in the container. */
  sessionAlive: boolean
  /** The gateway is mid-shutdown (SIGTERM/SIGINT handler ran). */
  shuttingDown: boolean
  /** This gateway boot already fired the one allowed escalation. */
  alreadyEscalated: boolean
  /** Consecutive escalations by PRIOR boots (from the consumed marker;
   *  0 when no fresh marker was found). */
  priorStreak: number
  /** The cross-boot cap (MAX_CONSECUTIVE_ESCALATIONS unless a test
   *  overrides). */
  maxConsecutive: number
}

export type BridgeDeadDecision =
  | { action: 'escalate' }
  | {
      action: 'skip'
      why: 'bridge-registered' | 'shutting-down' | 'already-escalated' | 'streak-capped'
    }
  | { action: 'retry'; why: 'session-not-alive' }

/**
 * Decide what the watchdog should do when the grace window expires.
 * Precedence, highest first: a live bridge always wins; a shutdown in
 * progress must never be raced by a restart; the once-per-boot fuse and
 * the cross-boot streak cap are checked before anything fires; a missing
 * claude process re-arms rather than escalating (bouncing a container
 * whose claude never came up would loop without fixing anything — and a
 * container still booting deserves the full grace window once claude
 * appears).
 */
export function decideBridgeDeadEscalation(s: BridgeDeadSnapshot): BridgeDeadDecision {
  if (s.bridgeRegistered) return { action: 'skip', why: 'bridge-registered' }
  if (s.shuttingDown) return { action: 'skip', why: 'shutting-down' }
  if (s.alreadyEscalated) return { action: 'skip', why: 'already-escalated' }
  // Cross-boot damper: prior boots already escalated `priorStreak` times
  // in a row and the bridge STILL hasn't registered this boot — the bounce
  // is not fixing it. Stand down. (A registration this boot breaks the
  // streak: the current outage is then a NEW incident, not the same one.)
  if (!s.bridgeEverRegistered && s.priorStreak >= s.maxConsecutive) {
    return { action: 'skip', why: 'streak-capped' }
  }
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

// ─── Escalation marker (honest boot-resume cause + cross-boot damper) ────────

export interface BridgeDeadEscalationMarker {
  /** Wall-clock ms when the escalation fired. */
  ts: number
  /** Always BRIDGE_DEAD_RESTART_REASON — kept in the file for grep-ability. */
  reason: string
  /** Consecutive escalations INCLUDING this one (1 = first fire of a
   *  streak). The next boot reads this as its `priorStreak` and stands
   *  down at MAX_CONSECUTIVE_ESCALATIONS. Absent in pre-damper markers —
   *  treated as 1. */
  count?: number
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
 * and ignored. Whenever this function runs the file IS removed — the cause
 * note must surface on exactly the boot that follows the escalation, never
 * a later one.
 *
 * Since #4641 the caller does not always run: the gateway's boot-resume
 * block `break`s before reaching this call when the per-container-boot
 * generation token says only the GATEWAY respawned. That narrows — and for
 * the common shape closes — the race documented below, so it is an
 * improvement rather than a hole; the marker is left on disk for the boot
 * that genuinely follows the container restart. See "What `break
 * bootResumeInit` skips" in agent-process-liveness.ts.
 *
 * Known race window (accepted, documented per review; largely closed by the
 * #4641 guard above): the marker is written by gateway boot N and consumed
 * by whichever gateway boots NEXT and reaches this call. Normally that is
 * the post-container-restart gateway (the SIGTERM to PID 1 fires ~1.5s
 * after the write and takes the whole container down). But if the
 * escalating gateway PROCESS dies and its supervisor relaunches a new
 * gateway inside the same container before the SIGTERM lands, and that
 * interim gateway's boot block is NOT suppressed by the generation token
 * (i.e. no gateway in this generation had completed its boot resume yet),
 * the interim gateway consumes the marker instead — the cause note is then
 * surfaced (or dropped with the interim process) one boot early, and the
 * post-restart boot sees no marker. Consequences are bounded and safe:
 * the honesty note may be lost for one incident (the loud supervisor-log
 * audit line survives regardless), and the cross-boot streak damper
 * under-counts by one (strictly MORE willing to self-heal, never a
 * tighter loop, since the in-memory once-per-boot fuse still caps each
 * process at one fire). Not worth a consume-side handshake.
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
        marker.count =
          typeof parsed.count === 'number' && Number.isFinite(parsed.count) && parsed.count >= 1
            ? Math.floor(parsed.count)
            : 1
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

// ─── Idle notice (honest cause when NO turn was in flight) ───────────────────

/**
 * Build the minimal synthetic inbound surfaced when the previous boot was
 * a bridge-dead escalation but NO turn was interrupted (idle agent, dead
 * bridge). Without this the cause reaches only stderr — the agent and the
 * user never learn why the container bounced (review finding 2 on #3038).
 * Mirrors the resume-builder shapes: meta.source is what Claude Code
 * renders as `<channel source="…">`; meta.chat_id/message_id let the
 * gateway's enqueue path build a currentTurn + ack the synthetic.
 */
export function buildBridgeDeadIdleNoticeInbound(args: {
  /** Chat to surface the notice in (the agent's default/owner chat). */
  chatId: string
  /** The consumed escalation marker. */
  marker: BridgeDeadEscalationMarker
  /** Wall-clock ms; defaults to Date.now(). */
  nowMs?: number
}): InboundMessage {
  const ts = args.nowMs ?? Date.now()
  return {
    type: 'inbound',
    chatId: args.chatId,
    messageId: ts,
    user: 'switchroom',
    userId: 0,
    ts,
    text:
      `You just restarted. The framework itself triggered this restart: your Telegram ` +
      `MCP bridge process had died (chat tools were unavailable — you could not send ` +
      `replies), so the container was bounced to restore the chat surface. No work was ` +
      `in flight when it happened. Briefly let the user know the messaging bridge died ` +
      `and the framework restarted you to fix it — one short message, no drama. This was ` +
      `NOT an operator-initiated restart and NOT a hang-watchdog kill; report only that ` +
      `honest cause.`,
    meta: {
      source: 'bridge_dead_restart',
      chat_id: args.chatId,
      message_id: String(ts),
      restart_cause: args.marker.reason,
    },
  }
}

// ─── Watchdog controller ─────────────────────────────────────────────────────

export interface BridgeDeadWatchdogOpts {
  /** Grace window before a missing bridge is treated as dead. Doubled
   *  when the consumed marker shows a prior escalation streak (the retry
   *  after a failed self-heal deserves more patience). */
  graceMs: number
  /** Is the claude session process alive in this container? Callers
   *  should require a confident match (comm === 'claude'), NOT the
   *  heaviest-node fallback — an orphaned node process must not flip a
   *  retry into an escalation (review finding 4). */
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
  /** Consecutive escalations by prior boots (the consumed marker's
   *  `count`; 0 when no fresh marker). Drives the cross-boot damper. */
  priorStreak?: number
  /** Cross-boot cap override (tests). */
  maxConsecutive?: number
  /** Injectable timer pair for tests. Defaults to global setTimeout with
   *  unref (the watchdog must never keep the gateway process alive). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** The agent identity THIS gateway serves ($SWITCHROOM_AGENT_NAME).
   *  Only a bridge client registering under this exact name is the
   *  primary bridge whose presence/absence drives the watchdog. Secondary
   *  or relay clients (a different named identity connecting into this
   *  gateway's socket — e.g. `overlord-relay`, #3086) are ignored on both
   *  the register and disconnect paths. When unset/empty (a misconfigured
   *  gateway with no agent name), the watchdog falls back to the pre-#3086
   *  test — any named non-cron client counts — so a genuine bridge death is
   *  still caught rather than silently un-guarded. */
  selfAgentName?: string
  /** Injectable clock (marker ts + crash-log freshness). */
  nowMs?: () => number
  /** Injectable marker writer (tests avoid real fs). */
  writeMarker?: (path: string, marker: BridgeDeadEscalationMarker) => void
  /** Injectable crash-log reader (tests avoid real fs). */
  readCrashTail?: (path: string, nowMs: number) => string | null
}

export interface BridgeDeadWatchdog {
  /** Arm the grace timer (gateway boot). Idempotent while armed. No-op
   *  when the cross-boot streak cap is already reached (stands down with
   *  an audit line instead). */
  arm: () => void
  /** A bridge client registered. Only THIS gateway's OWN primary bridge
   *  (agentName === selfAgentName, named, non-cron) satisfies the watchdog
   *  — cron sessions (`<agent>-cron`), anonymous clients (agentName null),
   *  and secondary/relay clients registering a different name (#3086) are
   *  ignored HERE so a gateway handler refactor can't reorder the gating
   *  away (review finding 5). */
  noteBridgeRegistered: (agentName: string | null | undefined) => void
  /** A bridge client disconnected. Re-arms the grace window only for THIS
   *  gateway's own primary bridge (same internal gating), so a bridge that
   *  dies AFTER boot and never reconnects also escalates — while a
   *  transient relay/secondary client's disconnect (#3086) is a no-op.
   *  Still capped by the once-per-boot fuse. */
  noteBridgeDisconnected: (agentName: string | null | undefined) => void
  /** Evaluate now (the timer body — exposed for tests). Returns the
   *  decision taken. */
  check: () => BridgeDeadDecision
  /** Cancel any pending timer (gateway shutdown). */
  stop: () => void
  /** Test/introspection: has this boot escalated already? */
  hasEscalated: () => boolean
}

/**
 * Is this client identity THIS gateway's OWN primary main-agent bridge?
 *
 * A named, non-cron client whose name matches the gateway's own agent
 * identity (`selfAgentName` = $SWITCHROOM_AGENT_NAME). A switchroom gateway
 * serves exactly one agent, and its real bridge registers under exactly that
 * name (see bridge/bridge.ts — `agentName: AGENT_NAME`). Secondary or relay
 * clients (e.g. an `overlord-relay` that connects into another agent's
 * gateway socket, #3086) register a DIFFERENT name; they are named and
 * non-cron but are NOT this gateway's primary bridge, so their register /
 * disconnect must neither satisfy nor re-arm the watchdog — otherwise a
 * transient relay disconnect marks the (still-alive) primary bridge dead and
 * bounces a healthy container.
 *
 * When `selfAgentName` is unset/empty (misconfigured gateway) we cannot
 * identity-match, so fall back to the pre-#3086 test — any named non-cron
 * client counts — keeping the watchdog protective rather than un-guarded.
 */
function isRealBridgeIdentity(
  agentName: string | null | undefined,
  selfAgentName: string | null | undefined,
): boolean {
  if (agentName == null || agentName.length === 0) return false
  if (isCronIdentity(agentName)) return false
  if (selfAgentName != null && selfAgentName.length > 0) {
    return agentName === selfAgentName
  }
  return true
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
  const priorStreak = opts.priorStreak ?? 0
  const maxConsecutive = opts.maxConsecutive ?? MAX_CONSECUTIVE_ESCALATIONS
  const selfAgentName = opts.selfAgentName

  let timer: unknown = null
  let bridgeRegistered = false
  let bridgeEverRegistered = false
  let escalated = false

  const cancel = (): void => {
    if (timer != null) {
      clearTimer(timer)
      timer = null
    }
  }

  /** The retry after a failed self-heal gets a doubled window: if one
   *  bounce didn't bring the bridge back inside graceMs, a second fire on
   *  the same clock mostly races container boot noise. */
  const effectiveGraceMs = (): number =>
    !bridgeEverRegistered && priorStreak >= 1 ? opts.graceMs * 2 : opts.graceMs

  const armInternal = (): void => {
    if (escalated) return // once-per-boot fuse — never re-arm after firing
    if (!bridgeEverRegistered && priorStreak >= maxConsecutive) {
      // Cross-boot damper: prior boots already bounced the container
      // `priorStreak` times in a row for this same condition and the
      // bridge still hasn't come back — a third bounce won't either.
      // Stand down LOUDLY: the operator must investigate (corrupt plugin
      // bundle / bad .mcp.json / broken IPC socket path).
      opts.log(
        `telegram gateway: [bridge-dead-watchdog] STANDING DOWN — ${priorStreak} consecutive ` +
          `bridge-dead escalations already restarted this container without the bridge coming ` +
          `back (cap=${maxConsecutive}). The bridge is failing deterministically; a further ` +
          `restart will not fix it. Investigate the bridge (plugin bundle, .mcp.json, ` +
          `STATE_DIR/bridge-crash.log). Manual recovery: fix the cause, then restart the ` +
          `container. SWITCHROOM_BRIDGE_DEAD_ESCALATION=0 disables this watchdog entirely.`,
      )
      return
    }
    cancel()
    timer = setTimer(() => {
      timer = null
      check()
    }, effectiveGraceMs())
  }

  const check = (): BridgeDeadDecision => {
    const decision = decideBridgeDeadEscalation({
      bridgeRegistered,
      bridgeEverRegistered,
      sessionAlive: opts.isSessionAlive(),
      shuttingDown: opts.isShuttingDown(),
      alreadyEscalated: escalated,
      priorStreak,
      maxConsecutive,
    })
    if (decision.action === 'retry') {
      // claude not up yet (slow container boot) — give it another full
      // grace window rather than escalating a bounce that can't help.
      opts.log(
        `telegram gateway: [bridge-dead-watchdog] no bridge registered after ${effectiveGraceMs()}ms ` +
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
    // this boot, streak under the cap. Set the fuse BEFORE any side effect
    // so a throwing sink can't produce a second fire.
    escalated = true
    const t = nowMs()
    const crashTail = (() => {
      try {
        return readCrashTail(opts.crashLogPath, t)
      } catch {
        return null
      }
    })()
    // Streak accounting: a registration THIS boot breaks the prior streak
    // (this escalation starts a new one at 1); otherwise it extends it.
    const streakCount = bridgeEverRegistered ? 1 : priorStreak + 1
    try {
      const marker: BridgeDeadEscalationMarker = {
        ts: t,
        reason: BRIDGE_DEAD_RESTART_REASON,
        count: streakCount,
      }
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
      `telegram gateway: [bridge-dead-watchdog] ESCALATING reason=${BRIDGE_DEAD_RESTART_REASON} ` +
        `consecutive=${streakCount}/${maxConsecutive} — ` +
        `no MCP bridge registered within ${effectiveGraceMs()}ms grace window while the claude session is alive ` +
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
    noteBridgeRegistered: (agentName) => {
      if (!isRealBridgeIdentity(agentName, selfAgentName)) return
      bridgeRegistered = true
      bridgeEverRegistered = true
      cancel()
    },
    noteBridgeDisconnected: (agentName) => {
      if (!isRealBridgeIdentity(agentName, selfAgentName)) return
      bridgeRegistered = false
      armInternal()
    },
    check,
    stop: cancel,
    hasEscalated: () => escalated,
  }
}
