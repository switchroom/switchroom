/**
 * Agent-process liveness — "did the AGENT restart, or only the gateway?"
 * (switchroom#4641)
 *
 * The gateway and the `claude` agent session are SEPARATE supervised
 * processes: `profiles/_base/start.sh.hbs` launches the gateway as a
 * supervised sidecar and then `exec claude` in the top-level shell. When the
 * gateway crashes (e.g. the Bun 1.3.13 SIGBUS that motivated #4641) the
 * supervisor respawns ONLY the gateway — the claude session, its context, its
 * in-flight turn, and its sub-agents all keep running, untouched.
 *
 * The gateway's boot-resume block reads gateway-local state only, so it read
 * that respawn as "the agent restarted": it stamped the still-executing turn
 * `ended_via='restart'`, queued a `resume_interrupted` synthetic telling the
 * live session "You just restarted. Your previous turn was interrupted...",
 * and listed the still-running sub-agents as "killed by the restart".
 *
 * This module is the missing liveness predicate. `start.sh` records the agent
 * process's identity (pid + `/proc/<pid>` starttime) immediately before
 * `exec claude`; the gateway reads it at boot and asks: is THAT EXACT process
 * still alive, and did it start before I did?
 *
 * Identity is (pid, starttime), never pid alone: PIDs are reused, and a
 * container restart resets the PID namespace, so a stale record's pid very
 * plausibly names a live-but-different process. `/proc/<pid>/stat` field 22 is
 * the process start time in clock ticks since HOST boot — it is assigned at
 * fork and is NOT reset by `exec`, so the value start.sh reads for its own
 * shell is the same value the exec'd `claude` carries. That makes it both a
 * stable identity and directly comparable with the gateway's own starttime
 * from `/proc/self/stat` (same clock, same units, no wall-clock skew).
 *
 * The "started before me" arm closes the fresh-boot race. On a genuine
 * container start the ordering is: start.sh launches the gateway → ... →
 * start.sh writes the record → `exec claude`. If the gateway's boot-resume
 * block were to run LATE enough to observe that freshly-written record, pid
 * and starttime would both match a live process and the aliveness check alone
 * would wrongly suppress a legitimate resume. But that process started AFTER
 * this gateway did, so the ordering check rejects it. A genuine gateway-only
 * respawn is always the other way round: claude was exec'd long before the
 * replacement gateway process was forked.
 *
 * FAIL-OPEN is the invariant. Every uncertainty — no record file, torn JSON,
 * unreadable `/proc`, missing gateway starttime — yields `gatewayOnly: false`,
 * i.e. exactly the pre-#4641 behaviour. Suppressing a real resume loses work;
 * an extra resume on an already-restarted agent is merely the status quo.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Default basename of the record start.sh writes into the telegram state dir. */
export const AGENT_PROCESS_RECORD_FILE = 'agent-process.json'

/** The agent-process identity recorded by start.sh before `exec claude`. */
export interface AgentProcessRecord {
  /** PID of the shell that `exec`s claude — i.e. the claude process's own pid. */
  pid: number
  /** `/proc/<pid>/stat` field 22 (starttime, clock ticks since host boot). */
  starttime: string
  /** `/proc/<pid>/stat` field 2 (comm) at record time. Optional extra guard. */
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
  | 'guard-disabled'
  | 'no-record'
  | 'unreadable-record'
  | 'agent-process-dead'
  | 'starttime-mismatch'
  | 'comm-mismatch'
  | 'agent-started-after-gateway'
  | 'gateway-starttime-unavailable'

export interface RespawnDecision {
  /**
   * True ONLY when the recorded agent process is provably still alive and
   * predates this gateway process — i.e. nothing but the gateway respawned.
   * The boot-resume block must then do nothing at all.
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

/**
 * The decision, pure. `live` is the `/proc` identity read back for
 * `record.pid` (null when that pid is gone), `gatewayStarttime` this
 * process's own field-22 value.
 */
export function decideGatewayOnlyRespawn(input: {
  record: AgentProcessRecord | null
  live: ProcIdentity | null
  gatewayStarttime: string | null
}): RespawnDecision {
  const { record, live, gatewayStarttime } = input
  if (record == null) return { gatewayOnly: false, reason: 'no-record', pid: null }
  if (live == null) return { gatewayOnly: false, reason: 'agent-process-dead', pid: record.pid }
  // PID reuse guard: same pid, different process.
  if (live.starttime !== record.starttime) {
    return { gatewayOnly: false, reason: 'starttime-mismatch', pid: record.pid }
  }
  if (record.comm != null && record.comm !== live.comm) {
    return { gatewayOnly: false, reason: 'comm-mismatch', pid: record.pid }
  }
  if (gatewayStarttime == null || !/^\d+$/.test(gatewayStarttime)) {
    return { gatewayOnly: false, reason: 'gateway-starttime-unavailable', pid: record.pid }
  }
  // Fresh-boot race guard: an agent that started AFTER this gateway process
  // cannot be the one this gateway is a respawn of.
  if (BigInt(record.starttime) >= BigInt(gatewayStarttime)) {
    return { gatewayOnly: false, reason: 'agent-started-after-gateway', pid: record.pid }
  }
  return { gatewayOnly: true, reason: 'gateway-only-respawn', pid: record.pid }
}

export interface DetectOpts {
  /** Gateway STATE_DIR (`<agentDir>/telegram`). The record lives here. */
  stateDir: string
  /** Override the record path outright (tests, ops escape hatch). */
  recordPath?: string
  /** `/proc` root; injectable for tests. */
  procRoot?: string
  /** This gateway process's pid. Defaults to `process.pid`. */
  selfPid?: number
  /** Explicit gateway starttime; defaults to reading `/proc/<selfPid>/stat`. */
  gatewayStarttime?: string | null
  /** Set false to force the pre-#4641 behaviour (ops escape hatch). */
  enabled?: boolean
}

/** Read the record + `/proc` and decide. Never throws. */
export function detectGatewayOnlyRespawn(opts: DetectOpts): RespawnDecision {
  if (opts.enabled === false) return { gatewayOnly: false, reason: 'guard-disabled', pid: null }
  const procRoot = opts.procRoot ?? '/proc'
  const recordPath = opts.recordPath ?? join(opts.stateDir, AGENT_PROCESS_RECORD_FILE)
  const record = readAgentProcessRecord(recordPath)
  if (record == null) return { gatewayOnly: false, reason: 'no-record', pid: null }
  const live = readProcIdentity(record.pid, procRoot)
  const gatewayStarttime =
    opts.gatewayStarttime !== undefined
      ? opts.gatewayStarttime
      : readProcIdentity(opts.selfPid ?? process.pid, procRoot)?.starttime ?? null
  return decideGatewayOnlyRespawn({ record, live, gatewayStarttime })
}

/**
 * Gateway boot entry point: decide, log the decision, and answer the one
 * question the boot block asks — "should I skip the whole boot-resume path?".
 *
 * Called from gateway.ts BEFORE the orphan-turn reaper, so a gateway-only
 * respawn touches nothing: no `ended_via='restart'` stamp on the live turn, no
 * resume synthetic, no `.pending-turn.env`. (The `.wake-audit-pending`
 * sentinel needs no handling here — it is dropped by start.sh once per
 * CONTAINER boot and start.sh does not re-run on a gateway respawn.)
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
    })
  } catch (err) {
    // Fail-open: any surprise keeps the pre-#4641 behaviour.
    log(`telegram gateway: boot: agent-liveness probe failed (${(err as Error).message}) — assuming agent restart\n`)
    return false
  }
  if (decision.gatewayOnly) {
    log(
      `telegram gateway: boot: GATEWAY-ONLY respawn — agent process pid=${decision.pid} is still alive and ` +
      `predates this gateway (#4641). Skipping orphan-turn reaper, boot-resume synthetic and .pending-turn.env: ` +
      `the claude session, its in-flight turn and its sub-agents were never interrupted.\n`,
    )
    return true
  }
  log(`telegram gateway: boot: agent-liveness probe → treating as agent restart (reason=${decision.reason})\n`)
  return false
}
