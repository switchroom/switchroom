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
 *      boot, and the gateway supervisor cannot re-run it. NOTE: that clear
 *      lives inside start.sh's `[ "$SWITCHROOM_RUNTIME" = "docker" ]` guard, so
 *      it is DOCKER-ONLY. Under the legacy systemd runtime nothing clears the
 *      token, and the guard's fail-open rests entirely on the two vetoes below
 *      (the boot-identity check and the `/proc` record). The fleet is all
 *      docker; this is stated so a systemd revival does not inherit it silently.
 *   2. The gateway runs its boot-resume block and, once the resume inbound is
 *      DURABLY spooled, writes the sentinel (`markBootResumeComplete`). The
 *      token embeds the container-boot identity it was written under.
 *   3. A gateway that boots and FINDS the sentinel — carrying THIS container
 *      boot's identity — knows some gateway in this same container generation
 *      already did the boot resume, so this boot is a gateway-only respawn and
 *      must skip the whole block.
 *
 * ## WHERE the token is stamped, and why it is NOT the tail of the block
 *
 * The stamp must follow the point at which the resume becomes CRASH-SURVIVABLE,
 * not the point at which the block stops running. Those are ~8k lines apart in
 * gateway.ts: the `bootResumeInit` block only builds `bootResumeInbound` in
 * MEMORY; the inbound becomes durable much later, at
 * `inboundSpool.put(bootResumeInbound.agent, bootResumeInbound.msg)`. So
 * `markBootResumeComplete` is called immediately AFTER that put (and after
 * `markTurnResumed`, which obeys the identical rule — see turns-schema.ts:
 * "the caller must stamp only AFTER the resume inbound is durably spooled").
 *
 * Stamping at the tail of the block instead would create a NEW, silent
 * work-loss mode, worse than the bug this module fixes. On a genuine restart
 * the reaper durably stamps the interrupted turn `ended_via='restart'`; if the
 * gateway then dies before the durable put — the Bun-crash-at-boot pattern
 * #4641 exists for, and also the `acquireStartupLock` → `process.exit(1)`
 * path, both of which sit inside that window — the successor would find a
 * token, find no `agent-process.json` (start.sh has not reached `exec claude`;
 * its inner pass waits on the LiteLLM probe first), return
 * `gateway-only-respawn-no-record` and suppress. The turn stays
 * `ended_via='restart'` with `resumed_at` NULL and is never resumed.
 *
 * Stamping after the put moves that window the other way, which is safe BY
 * CONSTRUCTION: a successor that re-runs the block re-mints the same resume,
 * `resumed_at` is still NULL so the turn is still findable, and the spool
 * dedups on `s:resume:<resume_turn_key>` — so the retry is idempotent, not a
 * double-send. Lose the token, repeat the work; never lose the work.
 *
 * The stamp does not depend on there being anything to resume: a boot that
 * found nothing still completed this generation's boot resume, and a later
 * gateway-only respawn must still be suppressed — that respawn running the
 * reaper against a meanwhile-started live turn IS bug #4641.
 *
 * It DOES depend on the block not having thrown. gateway.ts's boot block ends
 * in a `catch` that logs, sets `turnsDb = null` and lets module init continue
 * — a swallow, not a death. Without a guard that path reaches the stamp with
 * `bootResumeInbound` still null, and it is reachable from ~156 lines of DB
 * and fs I/O between the reaper and the first assignment
 * (`findLatestTurnIfInterrupted`, the clean-shutdown-marker read,
 * `listNonTerminalSubagentsForTurn`, the synthetic builders). The reaper has
 * ALREADY durably written `ended_via='restart'` by then, so a token stamped on
 * that path is exactly the tail-of-block failure above reached through a
 * different door: gateway respawns, successor sees a this-generation token and
 * no `agent-process.json`, suppresses, and the turn is never resumed. So
 * gateway.ts carries a `bootResumeThrew` flag set in that `catch` and the
 * stamp is gated on it — a swallowed throw leaves NO token, and the next
 * gateway retries the boot resume. Fail open, as everywhere else here.
 *
 * (On `origin/main` a throw in that window also loses the boot's resume; what
 * the guard preserves is the accidental recovery-on-respawn that the token
 * would otherwise remove.)
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
 * No sentinel → run the boot resume (the pre-#4641 behaviour). Sentinel from a
 * DIFFERENT container boot → run it. Recorded process dead or mismatched → run
 * it. Probe throws → run it. Plus a `SWITCHROOM_GATEWAY_RESPAWN_GUARD=0` ops
 * escape hatch. Suppressing a real resume loses work; an extra resume on an
 * already-restarted agent is merely the status quo.
 *
 * The invariant admits no path-override env vars. An earlier revision let
 * `SWITCHROOM_BOOT_RESUME_DONE_FILE` / `SWITCHROOM_AGENT_PROCESS_FILE`
 * redirect the token and record paths from the live process env, while
 * start.sh hard-codes `"$TELEGRAM_STATE_DIR/.boot-resume-done"`. Setting
 * either in a container would have made start.sh clear one path and the
 * gateway read another — the token then never cleared, and EVERY boot
 * suppressing its resume forever. That is the one fail-CLOSED direction the
 * module can take, so the overrides are confined to `DetectOpts` (test
 * injection). Verified: nothing in the repo ever set them.
 *
 * ## Why the token carries the container-boot identity
 *
 * `gateway-only-respawn-no-record` is the only branch that suppresses on the
 * token ALONE, with no corroborating `/proc` evidence — and start.sh's clear is
 * `rm -f … 2>/dev/null || true`, which swallows a per-file failure (EROFS,
 * EACCES, an immutable attr) while the sibling `agent-process.json` unlink
 * succeeds. A token surviving into the next container generation would then
 * suppress a genuine restart's resume, permanently and silently.
 *
 * So the token records the container-boot identity it was written under: PID
 * 1's `/proc` starttime. PID 1 is the container's entry process — it lives for
 * exactly one container generation and a restart replaces it, which is the
 * property we need. (`/proc/sys/kernel/random/boot_id` is NOT usable here: it
 * identifies the HOST kernel boot, which containers share and which survives a
 * container restart.) A token naming a DIFFERENT boot is self-evidently stale
 * and is ignored.
 *
 * The check is deliberately one-directional — only a MISMATCH is evidence.
 * A token with no recorded identity, or an unreadable `/proc/1`, keeps the
 * pre-existing "present ⇒ suppress" behaviour, so the hardening can never
 * itself re-open #4641.
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
 *   - `bridgeDeadPriorStreak` — the #3038 cross-boot damper seed derived from
 *     that marker. Left at 0 on a respawn: the streak belongs to the boot that
 *     consumed the marker, and re-seeding it here would double-count;
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

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

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
  | 'stale-boot-token'
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

/** On-disk shape of the generation token. All fields are best-effort. */
export interface BootResumeToken {
  /** PID of the gateway that stamped it. Diagnostic. */
  pid?: number
  /** Wall-clock ms at stamp time. Diagnostic. */
  at?: number
  /** Container-boot identity (PID 1's starttime) at stamp time. */
  boot?: string
}

/**
 * This container generation's identity: PID 1's `/proc` starttime.
 *
 * PID 1 is the container's entry process — one per container generation,
 * replaced on restart. Null when `/proc/1` is unreadable, which callers must
 * treat as "no evidence", never as a mismatch.
 */
export function containerBootIdentity(procRoot = '/proc'): string | null {
  return readProcIdentity(1, procRoot)?.starttime ?? null
}

export interface SentinelState {
  /** The token file exists (whatever its contents). */
  present: boolean
  /** Present AND provably written under a DIFFERENT container boot. */
  stale: boolean
}

/**
 * Read the generation token and judge whether it belongs to THIS container
 * boot. Never throws.
 *
 * Only a positive mismatch marks the token stale. An absent/blank/legacy
 * `boot` field, an unparseable body, or an unreadable `/proc/1` all leave
 * `stale: false` — so the hardening can only ever ADD a fail-open path, never
 * suppress where the previous revision would not have.
 */
export function readBootResumeSentinel(
  path: string,
  opts: { procRoot?: string } = {},
): SentinelState {
  let raw: string
  try {
    if (!existsSync(path)) return { present: false, stale: false }
    raw = readFileSync(path, 'utf8')
  } catch {
    return { present: false, stale: false } // unreadable → fail open
  }
  let stamped: string | null = null
  try {
    const parsed = JSON.parse(raw) as BootResumeToken | null
    if (parsed != null && typeof parsed === 'object' && typeof parsed.boot === 'string' && parsed.boot.length > 0) {
      stamped = parsed.boot
    }
  } catch { /* legacy/foreign body — no identity evidence, treat as present */ }
  const live = containerBootIdentity(opts.procRoot)
  if (stamped != null && live != null && stamped !== live) return { present: true, stale: true }
  return { present: true, stale: false }
}

/**
 * Delete `<file>.tmp.<pid>` siblings left behind by a writer that died between
 * `writeFileSync` and `renameSync`.
 *
 * The tmp name is pid-qualified (two writers must not share one tmp path), so
 * a crashed write leaves a stray that nothing else removes: start.sh's cleanup
 * (`start.sh.hbs`) `rm -f`s the two exact filenames with no glob, so strays
 * would accumulate in STATE_DIR one per crashed generation, forever.
 *
 * Called only after our own successful rename, so it never races our own tmp.
 * Best-effort and never throws — a stray costs bytes, not correctness.
 */
function sweepStrayTmps(path: string): void {
  const prefix = `${basename(path)}.tmp.`
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix)) continue
      try { unlinkSync(join(dirname(path), name)) } catch { /* best effort */ }
    }
  } catch { /* unreadable dir — nothing to sweep */ }
}

/**
 * Stamp the generation token: THIS container generation's boot-resume block
 * ran to completion, so a later gateway respawn must not re-run it.
 *
 * Called from gateway.ts immediately AFTER the boot-resume inbound is durably
 * spooled — NOT at the end of the boot block; see "WHERE the token is stamped"
 * above for why those are different places and why the difference is a
 * work-loss bug. Atomic tmp+rename, and never throws: failing to stamp only
 * costs a duplicate boot-resume on a respawn, which is the pre-#4641
 * behaviour.
 *
 * The body records the container-boot identity so a token that outlives its
 * generation (start.sh's `rm -f … || true` swallowing a per-file failure) is
 * self-evidently stale rather than a permanent resume suppressor.
 */
export function markBootResumeComplete(
  stateDir: string,
  opts: { path?: string; now?: number; procRoot?: string; log?: (s: string) => void } = {},
): void {
  const path = opts.path ?? bootResumeDonePath(stateDir)
  const tmp = `${path}.tmp.${process.pid}`
  const boot = containerBootIdentity(opts.procRoot)
  try {
    const token: BootResumeToken = { pid: process.pid, at: opts.now ?? Date.now() }
    if (boot != null) token.boot = boot
    writeFileSync(tmp, JSON.stringify(token) + '\n')
    renameSync(tmp, path)
    sweepStrayTmps(path)
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
 * "suppress". `sentinelStale` and `live` (the `/proc` identity read back for
 * `record.pid`, null when that pid is gone) can only VETO a suppression.
 */
export function decideGatewayOnlyRespawn(input: {
  sentinelPresent: boolean
  /** Token exists but names a different container boot. Defaults false. */
  sentinelStale?: boolean
  record: AgentProcessRecord | null
  live: ProcIdentity | null
}): RespawnDecision {
  const { sentinelPresent, sentinelStale, record, live } = input
  // No token → no gateway in this container generation has completed the boot
  // resume yet. That covers a genuine container restart, a first boot, AND a
  // gateway that crashed during its own boot before finishing the block.
  if (!sentinelPresent) {
    return { gatewayOnly: false, reason: 'no-boot-resume-sentinel', pid: record?.pid ?? null }
  }
  // A token start.sh's `rm -f` failed to clear: it names a PREVIOUS container
  // boot, so it proves nothing about this generation. Run the boot resume.
  if (sentinelStale === true) {
    return { gatewayOnly: false, reason: 'stale-boot-token', pid: record?.pid ?? null }
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
  /**
   * Override the record path. TEST INJECTION ONLY — deliberately not readable
   * from the process env: start.sh hard-codes the production paths, so an env
   * override could only ever desynchronise the writer from the reader. See
   * "FAIL-OPEN is the invariant".
   */
  recordPath?: string
  /** Override the generation-token path. Test injection only (see above). */
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
  const sentinel = readBootResumeSentinel(
    opts.sentinelPath ?? bootResumeDonePath(opts.stateDir),
    { procRoot },
  )
  const recordPath = opts.recordPath ?? join(opts.stateDir, AGENT_PROCESS_RECORD_FILE)
  const record = readAgentProcessRecord(recordPath)
  const live = record == null ? null : readProcIdentity(record.pid, procRoot)
  return decideGatewayOnlyRespawn({
    sentinelPresent: sentinel.present,
    sentinelStale: sentinel.stale,
    record,
    live,
  })
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
