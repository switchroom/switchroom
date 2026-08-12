/**
 * Boot-resume generation guard — "did the AGENT restart, or only the gateway?"
 * (switchroom#4641)
 *
 * The gateway and the `claude` agent session are SEPARATE supervised
 * processes: `profiles/_base/start.sh.hbs` launches the gateway as a
 * supervised sidecar and then `exec claude`. When the gateway crashes (e.g.
 * the Bun 1.3.13 SIGBUS that motivated #4641) the supervisor respawns ONLY the
 * gateway — the claude session, its context, its in-flight turn, and its
 * sub-agents all keep running, untouched.
 *
 * The gateway's boot-resume block reads gateway-local state only, so it read
 * that respawn as "the agent restarted": it stamped the still-executing turn
 * `ended_via='restart'`, queued a `resume_interrupted` synthetic telling the
 * live session "You just restarted. Your previous turn was interrupted...",
 * and listed the still-running sub-agents as "killed by the restart".
 *
 * ## The mechanism: a per-container-boot generation token
 *
 * The boot-resume block is a ONCE-PER-CONTAINER-BOOT action. So make that
 * literal, with a sentinel file whose lifetime IS the container generation:
 *
 *   1. `start.sh`, in the OUTER docker pass and BEFORE it forks the gateway,
 *      deletes `<stateDir>/.boot-resume-done` (and any stale
 *      `agent-process.json`). That deletion happens exactly once per container
 *      boot, and the gateway supervisor cannot re-run it.
 *   2. The gateway runs its boot-resume block and, on completing it, writes
 *      the sentinel (`markBootResumeComplete`).
 *   3. A gateway that boots and FINDS the sentinel knows some gateway in this
 *      same container generation already did the boot resume — so this boot is
 *      a gateway-only respawn and must skip the whole block.
 *
 * This is deliberately NOT timing-derived. An earlier revision of this module
 * compared `/proc` starttimes ("the agent must predate me") and justified it
 * with the claim that start.sh writes the record after forking the gateway, so
 * the recorded process necessarily starts later. That reasoning was FALSE: the
 * recorded pid is `$$`, and the shell that forks the gateway
 * (`start.sh.hbs`, outer pass) obviously predates it. What actually made the
 * ordering hold was an incidental, undocumented detail — the docker tmux
 * re-exec (`start.sh.hbs`: `exec tmux ... bash -l "$0"`), which runs the inner
 * pass in a FRESH shell forked by the tmux server. Measured on a live
 * container the margin was one clock tick (gateway starttime 209640551, claude
 * 209640552 — 10ms). Correct by accident, with nothing pinning the accident.
 * The sentinel replaces that with a fact the boot sequence establishes.
 *
 * It also fixes a hole the starttime comparison could not see: a gateway that
 * CRASHES DURING ITS OWN BOOT (exactly the Bun-crash-at-boot pattern this fix
 * exists for) left a genuinely-interrupted turn unreaped forever, because the
 * respawned gateway saw a live claude that predated it and suppressed. With
 * the sentinel, gateway #1 never got far enough to write it, so gateway #2
 * runs the full boot resume — the resume survives the crash.
 *
 * ## The `/proc` record is a VETO, not the decision
 *
 * `start.sh` still publishes `<stateDir>/agent-process.json` — the agent
 * process's pid plus `/proc/<pid>/stat` field 22 (starttime) — immediately
 * before `exec claude` (`exec` replaces the shell without forking, so both
 * values survive into claude unchanged). It is no longer what decides
 * suppression; it can only VETO one. If the sentinel says "already done" but
 * the recorded agent process is provably gone, we run the boot resume anyway.
 * That can only ever re-enable a resume, never suppress a legitimate one.
 *
 * Identity is the (pid, starttime) PAIR, never pid alone: PIDs are reused and
 * a container restart resets the PID namespace, so a stale record's pid very
 * plausibly names a live-but-different process. A zombie counts as dead.
 *
 * ## FAIL-OPEN is the invariant
 *
 * No sentinel → run the boot resume (the pre-#4641 behaviour). Recorded
 * process dead or mismatched → run it. Probe throws → run it. Plus a
 * `SWITCHROOM_GATEWAY_RESPAWN_GUARD=0` ops escape hatch. Suppressing a real
 * resume loses work; an extra resume on an already-restarted agent is merely
 * the status quo.
 *
 * ## What `break bootResumeInit` skips, and why each is safe
 *
 * The guard in gateway.ts breaks out of the whole labelled boot block, which
 * skips MORE than the resume synthetic. Because the sentinel means "a gateway
 * in THIS container generation already ran this block to completion", every
 * one of these was already done exactly once this generation:
 *
 *   - the orphan-turn reaper (`markOrphanedWithTimeoutClassification`) — the
 *     thing that stamped the live turn `ended_via='restart'`;
 *   - `consumeBridgeDeadEscalationMarker` — its comment states the marker is
 *     "consumed (always cleared) whether or not a turn was in flight", and the
 *     gateway that wrote the sentinel is the one that consumed it. Re-running
 *     it here would find nothing; skipping it preserves the #3038 cross-boot
 *     escalation damper instead of double-counting or resetting it. If that
 *     gateway died BEFORE consuming, the sentinel is absent and we do not take
 *     this path at all;
 *   - the bridge-dead IDLE notice — same generation, same marker, already
 *     surfaced (or already declined for want of an allowFrom chat);
 *   - the `pendingRedelivery` capture — a crash-redelivery candidate for the
 *     interrupted turn. Skipped deliberately: on a gateway-only respawn the
 *     turn is STILL RUNNING and will emit its own answer, so re-sending a
 *     "Recovered from an interrupted turn:" draft would double-send;
 *   - `writePendingTurnEnv` — passive wake-audit context for a restart that
 *     did not happen.
 *
 * (The `.wake-audit-pending` sentinel needs no handling: start.sh drops it
 * once per CONTAINER boot and start.sh does not re-run on a gateway respawn.)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Default basename of the record start.sh writes into the telegram state dir. */
export const AGENT_PROCESS_RECORD_FILE = 'agent-process.json'

/**
 * Per-container-boot generation token. Deleted by start.sh in the outer docker
 * pass BEFORE the gateway is forked; written by the gateway once its
 * boot-resume block completes. Its presence means "this container generation's
 * boot resume already happened".
 */
export const BOOT_RESUME_DONE_FILE = '.boot-resume-done'

/** The agent-process identity recorded by start.sh before `exec claude`. */
export interface AgentProcessRecord {
  /** PID of the shell that `exec`s claude — i.e. the claude process's own pid. */
  pid: number
  /** `/proc/<pid>/stat` field 22 (starttime, clock ticks since host boot). */
  starttime: string
  /**
   * `/proc/<pid>/stat` field 2 (comm) at record time. Optional extra veto.
   * start.sh does NOT write it (it is "bash" pre-exec and claude's after), and
   * with the generation token it buys nothing — but a mismatch, if a future
   * writer does record it post-exec, still fails open.
   */
  comm?: string
  /** Wall-clock ms when the record was written. Diagnostic only. */
  boot_at?: number
}

/** A live process's identity as read back from `/proc`. */
export interface ProcIdentity {
  starttime: string
  comm: string
  /** `/proc/<pid>/stat` field 3. `Z` is an unreaped corpse, not a live agent. */
  state: string
}

export type RespawnReason =
  | 'gateway-only-respawn'
  | 'gateway-only-respawn-no-record'
  | 'guard-disabled'
  | 'no-boot-resume-sentinel'
  | 'agent-process-dead'
  | 'starttime-mismatch'
  | 'comm-mismatch'

export interface RespawnDecision {
  /**
   * True ONLY when this container generation's boot resume is already done and
   * nothing contradicts it — i.e. only the gateway respawned. The boot-resume
   * block must then do nothing at all.
   */
  gatewayOnly: boolean
  reason: RespawnReason
  /** Recorded pid, when a record was readable. Diagnostic. */
  pid: number | null
}

/**
 * Parse `/proc/<pid>/stat` for (comm, state, starttime).
 *
 * `comm` is parenthesised and may itself contain spaces and `)`, so the field
 * split is anchored on the LAST `) ` — the documented way to parse this file.
 * Field 3 (state) is the first field after comm; field 22 (starttime) the 20th.
 */
export function parseProcStat(raw: string): ProcIdentity | null {
  const close = raw.lastIndexOf(') ')
  const open = raw.indexOf(' (')
  if (close < 0 || open < 0 || close < open) return null
  const comm = raw.slice(open + 2, close)
  const rest = raw.slice(close + 2).trim().split(/\s+/)
  const state = rest[0]
  const starttime = rest[19]
  if (state == null || state.length === 0) return null
  if (starttime == null || !/^\d+$/.test(starttime)) return null
  return { comm, state, starttime }
}

/**
 * Read a live process's identity, or null when it is gone.
 *
 * A zombie (`state === 'Z'`) counts as GONE: the agent has exited and only an
 * unreaped exit status remains, so its turn really was interrupted.
 */
export function readProcIdentity(pid: number, procRoot = '/proc'): ProcIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  let identity: ProcIdentity | null
  try {
    identity = parseProcStat(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'))
  } catch {
    return null // process gone, or /proc unreadable — treat as dead (fail-open)
  }
  if (identity != null && identity.state === 'Z') return null
  return identity
}

/** Read + validate the record start.sh wrote. Null on absent/torn/invalid. */
export function readAgentProcessRecord(path: string): AgentProcessRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const pid = typeof o.pid === 'number' ? o.pid : Number(o.pid)
  const starttime = typeof o.starttime === 'string' ? o.starttime : String(o.starttime ?? '')
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!/^\d+$/.test(starttime)) return null
  const rec: AgentProcessRecord = { pid, starttime }
  if (typeof o.comm === 'string' && o.comm.length > 0) rec.comm = o.comm
  if (typeof o.boot_at === 'number' && Number.isFinite(o.boot_at)) rec.boot_at = o.boot_at
  return rec
}

/** Resolve the generation-token path for a gateway STATE_DIR. */
export function bootResumeDonePath(stateDir: string): string {
  return join(stateDir, BOOT_RESUME_DONE_FILE)
}

/** Is this container generation's boot resume already done? Never throws. */
export function readBootResumeSentinel(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false // unreadable → fail open (run the boot resume)
  }
}

/**
 * Stamp the generation token: THIS container generation's boot-resume block
 * ran to completion, so a later gateway respawn must not re-run it.
 *
 * Called from gateway.ts at the END of the boot block (so a gateway that dies
 * mid-boot leaves no token and its successor redoes the work). Atomic
 * tmp+rename, and never throws: failing to stamp only costs a duplicate
 * boot-resume on a respawn, which is the pre-#4641 behaviour.
 */
export function markBootResumeComplete(
  stateDir: string,
  opts: { path?: string; now?: number; log?: (s: string) => void } = {},
): void {
  const path = opts.path ?? process.env.SWITCHROOM_BOOT_RESUME_DONE_FILE ?? bootResumeDonePath(stateDir)
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: opts.now ?? Date.now() }) + '\n')
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    const log = opts.log ?? ((s: string) => process.stderr.write(s))
    log(
      `telegram gateway: boot: could not stamp ${BOOT_RESUME_DONE_FILE} ` +
      `(${(err as Error).message}) — a gateway respawn may repeat the boot resume (#4641)\n`,
    )
  }
}

/**
 * The decision, pure.
 *
 * `sentinelPresent` is the generation token — the ONLY thing that can say
 * "suppress". `live` is the `/proc` identity read back for `record.pid` (null
 * when that pid is gone) and can only VETO a suppression.
 */
export function decideGatewayOnlyRespawn(input: {
  sentinelPresent: boolean
  record: AgentProcessRecord | null
  live: ProcIdentity | null
}): RespawnDecision {
  const { sentinelPresent, record, live } = input
  // No token → no gateway in this container generation has completed the boot
  // resume yet. That covers a genuine container restart, a first boot, AND a
  // gateway that crashed during its own boot before finishing the block.
  if (!sentinelPresent) {
    return { gatewayOnly: false, reason: 'no-boot-resume-sentinel', pid: record?.pid ?? null }
  }
  // Token present but start.sh has not yet published the agent record (the
  // gateway boots long before `exec claude`). The token alone is proof enough:
  // re-running the block would duplicate this generation's resume.
  if (record == null) {
    return { gatewayOnly: true, reason: 'gateway-only-respawn-no-record', pid: null }
  }
  if (live == null) return { gatewayOnly: false, reason: 'agent-process-dead', pid: record.pid }
  // PID reuse guard: same pid, different process.
  if (live.starttime !== record.starttime) {
    return { gatewayOnly: false, reason: 'starttime-mismatch', pid: record.pid }
  }
  if (record.comm != null && record.comm !== live.comm) {
    return { gatewayOnly: false, reason: 'comm-mismatch', pid: record.pid }
  }
  return { gatewayOnly: true, reason: 'gateway-only-respawn', pid: record.pid }
}

export interface DetectOpts {
  /** Gateway STATE_DIR (`<agentDir>/telegram`). The record + token live here. */
  stateDir: string
  /** Override the record path outright (tests, ops escape hatch). */
  recordPath?: string
  /** Override the generation-token path (tests). */
  sentinelPath?: string
  /** `/proc` root; injectable for tests. */
  procRoot?: string
  /** Set false to force the pre-#4641 behaviour (ops escape hatch). */
  enabled?: boolean
}

/** Read the token, the record and `/proc`, and decide. Never throws. */
export function detectGatewayOnlyRespawn(opts: DetectOpts): RespawnDecision {
  if (opts.enabled === false) return { gatewayOnly: false, reason: 'guard-disabled', pid: null }
  const procRoot = opts.procRoot ?? '/proc'
  const sentinelPresent = readBootResumeSentinel(
    opts.sentinelPath ?? bootResumeDonePath(opts.stateDir),
  )
  const recordPath = opts.recordPath ?? join(opts.stateDir, AGENT_PROCESS_RECORD_FILE)
  const record = readAgentProcessRecord(recordPath)
  const live = record == null ? null : readProcIdentity(record.pid, procRoot)
  return decideGatewayOnlyRespawn({ sentinelPresent, record, live })
}

/**
 * Gateway boot entry point: decide, log the decision, and answer the one
 * question the boot block asks — "should I skip the whole boot-resume path?".
 *
 * Called from gateway.ts BEFORE the orphan-turn reaper, so a gateway-only
 * respawn touches nothing. See "What `break bootResumeInit` skips" above for
 * the full accounting of the skipped side effects.
 */
export function shouldSkipBootResumeForGatewayOnlyRespawn(
  stateDir: string,
  opts: Omit<DetectOpts, 'stateDir'> & { log?: (s: string) => void } = {},
): boolean {
  const log = opts.log ?? ((s: string) => process.stderr.write(s))
  let decision: RespawnDecision
  try {
    decision = detectGatewayOnlyRespawn({
      ...opts,
      stateDir,
      enabled: opts.enabled ?? process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD !== '0',
      recordPath: opts.recordPath ?? process.env.SWITCHROOM_AGENT_PROCESS_FILE ?? undefined,
      sentinelPath: opts.sentinelPath ?? process.env.SWITCHROOM_BOOT_RESUME_DONE_FILE ?? undefined,
    })
  } catch (err) {
    // Fail-open: any surprise keeps the pre-#4641 behaviour.
    log(`telegram gateway: boot: agent-liveness probe failed (${(err as Error).message}) — assuming agent restart\n`)
    return false
  }
  if (decision.gatewayOnly) {
    log(
      `telegram gateway: boot: GATEWAY-ONLY respawn — this container generation's boot resume is already ` +
      `done (${BOOT_RESUME_DONE_FILE} present, reason=${decision.reason}, agent pid=${decision.pid ?? 'unrecorded'}). ` +
      `Skipping the orphan-turn reaper, the bridge-dead marker, the resume synthetic, crash-redelivery capture ` +
      `and .pending-turn.env (#4641): the claude session, its in-flight turn and its sub-agents were never interrupted.\n`,
    )
    return true
  }
  log(`telegram gateway: boot: agent-liveness probe → treating as agent restart (reason=${decision.reason})\n`)
  return false
}
