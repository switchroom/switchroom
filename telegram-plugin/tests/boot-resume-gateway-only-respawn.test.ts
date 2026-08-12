/**
 * switchroom#4641 — OUTCOME test for the gateway-only-respawn guard.
 *
 * The bug: the gateway and the `claude` agent are separate supervised
 * processes. When the gateway alone crashed and respawned (three Bun SIGBUS
 * crashes on `overlord`, 2026-08-12), its boot block stamped the STILL-RUNNING
 * turn `ended_via='restart'`, spooled a `resume_interrupted` synthetic telling
 * the live session "You just restarted. Your previous turn was interrupted…",
 * and listed its still-running sub-agents as "killed by the restart".
 *
 * What this test asserts is the OUTCOME the issue names, end to end over the
 * REAL collaborators — a real bun:sqlite registry, the real boot reaper, the
 * real interrupted-turn finder, the real inbound builders and the real durable
 * inbound spool — with only the ORDERING supplied by `runBootSequence` below,
 * which mirrors gateway.ts's block 1:1 (and `boot-resume-guard-wiring.test.ts`
 * pins that gateway.ts still calls the guard in that position):
 *
 *   - gateway killed mid-turn while the claude process LIVES
 *       → ZERO `resume_interrupted` entries in the on-disk spool,
 *         the in-flight turn row is left OPEN (no `ended_via` lie), and
 *         no `.pending-turn.env` is written.
 *   - genuine agent restart (recorded process really is dead)
 *       → the resume still fires, exactly as before.
 *   - watchdog-timeout classification and first boot (no record file)
 *       → unchanged.
 *
 * Every "alive" claim is anchored on a process this test actually spawned, and
 * every "dead" claim on one it actually killed — so a probe hard-wired to
 * either answer fails here.
 *
 * Uses bun:sqlite (openTurnsDb) — excluded from vitest.config.ts, run by
 * telegram-plugin/scripts/bun-test-ci.sh (which runs `tests/`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  statSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  openTurnsDb,
  recordTurnStart,
  markOrphanedWithTimeoutClassification,
  findLatestTurnIfInterrupted,
  getTurnByKey,
} from '../registry/turns-schema.js'
import {
  decideBootResumeKind,
  buildResumeInterruptedInbound,
  buildResumeWatchdogReportInbound,
} from '../gateway/resume-inbound-builder.js'
import { writePendingTurnEnv } from '../gateway/pending-turn-env.js'
import { createInboundSpool } from '../gateway/inbound-spool.js'
import {
  readProcIdentity,
  shouldSkipBootResumeForGatewayOnlyRespawn,
  AGENT_PROCESS_RECORD_FILE,
} from '../gateway/agent-process-liveness.js'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let agentDir: string
let stateDir: string
/** Long-lived stand-in for the `claude` process. Spawned BEFORE `gatewayPid`. */
let agentProc: ReturnType<typeof spawn>
/** Stand-in for THIS (respawned) gateway process. Spawned after the agent. */
let gatewayProc: ReturnType<typeof spawn>

function sleepMs(ms: number): void {
  spawnSync('sleep', [String(ms / 1000)])
}

function starttimeOf(pid: number): string {
  const id = readProcIdentity(pid)
  if (id == null) throw new Error(`pid ${pid} unexpectedly not live`)
  return id.starttime
}

/** Write the record start.sh writes immediately before `exec claude`. */
function writeAgentProcessRecord(pid: number, starttime: string): void {
  writeFileSync(
    join(stateDir, AGENT_PROCESS_RECORD_FILE),
    JSON.stringify({ pid, starttime, boot_at: Date.now() }),
  )
}

const SPOOL_FS = {
  appendFileSync: (p: string, d: string) => appendFileSync(p, d),
  readFileSync: (p: string) => readFileSync(p, 'utf8'),
  writeFileSync: (p: string, d: string) => writeFileSync(p, d),
  renameSync: (a: string, b: string) => renameSync(a, b),
  existsSync: (p: string) => existsSync(p),
  statSizeSync: (p: string) => statSync(p).size,
  fsyncFileSync: () => {},
  fsyncDirSync: () => {},
}

interface BootResult {
  /** Every `source` value that reached the durable on-disk spool. */
  spooledSources: string[]
  /** Raw spool file contents (empty string when never created). */
  spoolRaw: string
  reaped: number
  pendingEnvWritten: boolean
}

/**
 * The gateway's boot-resume block, in gateway.ts's order, over the real
 * collaborators. `guarded: false` reproduces the pre-#4641 gateway.
 */
function runBootSequence(opts: {
  gatewayPid: number
  guarded?: boolean
  markerTurnKey?: string | null
  markerAgeMs?: number | null
}): BootResult {
  const spoolPath = join(stateDir, 'inbound-spool.jsonl')
  const db = openTurnsDb(agentDir)
  const spool = createInboundSpool({ path: spoolPath, fs: SPOOL_FS, log: () => {} })
  let reaped = 0
  try {
    // ---- the guard (gateway.ts: immediately after applySubagentsSchema) ----
    const skip =
      (opts.guarded ?? true) &&
      shouldSkipBootResumeForGatewayOnlyRespawn(stateDir, {
        selfPid: opts.gatewayPid,
        log: () => {},
      })
    if (!skip) {
      const res = markOrphanedWithTimeoutClassification(db, {
        markerTurnKey: opts.markerTurnKey ?? null,
        markerAgeMs: opts.markerAgeMs ?? null,
        hangThresholdMs: 300_000,
      })
      reaped = res.reaped
      const pending = findLatestTurnIfInterrupted(db)
      if (pending != null) {
        const kind = decideBootResumeKind({
          pending,
          suppressed: false,
          ageMs: Math.max(0, Date.now() - pending.started_at),
          maxAgeMs: 10_800_000,
        })
        if (kind === 'resume') {
          spool.put('tester', buildResumeInterruptedInbound({ turn: pending, subagents: [] }))
        } else if (kind === 'report') {
          spool.put(
            'tester',
            buildResumeWatchdogReportInbound({ turn: pending, idleMs: 600_000, subagents: [] }),
          )
        }
      }
      writePendingTurnEnv(agentDir, pending, () => {})
    }
  } finally {
    db.close()
  }
  const spoolRaw = existsSync(spoolPath) ? readFileSync(spoolPath, 'utf8') : ''
  const spooledSources = spoolRaw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { t: string; msg?: { meta?: { source?: string } } })
    .filter((r) => r.t === 'put')
    .map((r) => r.msg?.meta?.source ?? '(none)')
  return {
    spooledSources,
    spoolRaw,
    reaped,
    pendingEnvWritten: existsSync(join(agentDir, '.pending-turn.env')),
  }
}

/** Seed an in-flight turn: started, never ended — the live turn's row. */
function seedInFlightTurn(turnKey = 'chat:1786528508921'): string {
  const db = openTurnsDb(agentDir)
  try {
    recordTurnStart(db, {
      turnKey,
      chatId: '12345',
      userPromptPreview: 'dispatch the worker',
    })
  } finally {
    db.close()
  }
  return turnKey
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'boot-respawn-'))
  stateDir = join(agentDir, 'telegram')
  mkdirSync(stateDir, { recursive: true })
  agentProc = spawn('sleep', ['120'], { stdio: 'ignore' })
  sleepMs(20)
  gatewayProc = spawn('sleep', ['120'], { stdio: 'ignore' })
  sleepMs(20)
})

afterEach(() => {
  for (const p of [agentProc, gatewayProc]) {
    try { p.kill('SIGKILL') } catch { /* already gone */ }
  }
  rmSync(agentDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The bug
// ---------------------------------------------------------------------------

describe('gateway-only respawn (claude still running)', () => {
  it('spools ZERO resume_interrupted entries and leaves the live turn open', () => {
    const turnKey = seedInFlightTurn()
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))

    const out = runBootSequence({ gatewayPid: gatewayProc.pid! })

    // The outcome the issue names.
    expect(out.spooledSources).toEqual([])
    expect(out.spoolRaw).not.toContain('resume_interrupted')
    // …and no collateral: the live turn keeps its open row (no `restart` lie),
    // and the one-shot wake-audit env is not written either.
    expect(out.reaped).toBe(0)
    expect(out.pendingEnvWritten).toBe(false)
    const db = openTurnsDb(agentDir)
    try {
      const turn = getTurnByKey(db, turnKey)!
      expect(turn.ended_at).toBeNull()
      expect(turn.ended_via).toBeNull()
    } finally {
      db.close()
    }
  })

  it('WOULD fire the false resume without the guard (bug reproduction)', () => {
    const turnKey = seedInFlightTurn()
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))

    // Same fixture, guard bypassed — the pre-#4641 gateway.
    const out = runBootSequence({ gatewayPid: gatewayProc.pid!, guarded: false })

    expect(out.spooledSources).toEqual(['resume_interrupted'])
    expect(out.reaped).toBe(1)
    const db = openTurnsDb(agentDir)
    try {
      expect(getTurnByKey(db, turnKey)!.ended_via).toBe('restart')
    } finally {
      db.close()
    }
  })

  it('stays silent across repeated gateway crashes', () => {
    seedInFlightTurn()
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))
    for (let i = 0; i < 3; i++) {
      expect(runBootSequence({ gatewayPid: gatewayProc.pid! }).spooledSources).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// The cases that must NOT change
// ---------------------------------------------------------------------------

describe('genuine agent restart', () => {
  it('still fires resume_interrupted when the recorded process is really dead', () => {
    const turnKey = seedInFlightTurn()
    const doomed = spawn('sleep', ['120'], { stdio: 'ignore' })
    sleepMs(20)
    writeAgentProcessRecord(doomed.pid!, starttimeOf(doomed.pid!))
    doomed.kill('SIGKILL')
    sleepMs(200)

    const out = runBootSequence({ gatewayPid: gatewayProc.pid! })

    expect(out.spooledSources).toEqual(['resume_interrupted'])
    expect(out.spoolRaw).toContain('resume_interrupted')
    expect(out.reaped).toBe(1)
    expect(out.pendingEnvWritten).toBe(true)
    const db = openTurnsDb(agentDir)
    try {
      expect(getTurnByKey(db, turnKey)!.ended_via).toBe('restart')
    } finally {
      db.close()
    }
  })

  it('still fires on first boot, when no process record exists at all', () => {
    seedInFlightTurn()
    expect(existsSync(join(stateDir, AGENT_PROCESS_RECORD_FILE))).toBe(false)

    const out = runBootSequence({ gatewayPid: gatewayProc.pid! })

    expect(out.spooledSources).toEqual(['resume_interrupted'])
    expect(out.pendingEnvWritten).toBe(true)
  })

  it('still fires when a recycled PID matches but the starttime does not', () => {
    seedInFlightTurn()
    // A live pid whose recorded starttime disagrees — the post-container-
    // restart shape, where the old record's pid names a different process.
    writeAgentProcessRecord(
      agentProc.pid!,
      String(BigInt(starttimeOf(agentProc.pid!)) - 1n),
    )

    expect(runBootSequence({ gatewayPid: gatewayProc.pid! }).spooledSources)
      .toEqual(['resume_interrupted'])
  })

  it('still fires when the agent started AFTER this gateway (fresh boot race)', () => {
    seedInFlightTurn()
    // Roles swapped: the record names the process spawned SECOND, and the
    // probe runs as the one spawned FIRST — i.e. a live claude that this
    // gateway cannot be a respawn of.
    writeAgentProcessRecord(gatewayProc.pid!, starttimeOf(gatewayProc.pid!))

    expect(runBootSequence({ gatewayPid: agentProc.pid! }).spooledSources)
      .toEqual(['resume_interrupted'])
  })
})

describe('watchdog-timeout classification', () => {
  it('still reports resume_watchdog_timeout for a dead agent that stalled', () => {
    const turnKey = seedInFlightTurn()
    const doomed = spawn('sleep', ['120'], { stdio: 'ignore' })
    sleepMs(20)
    writeAgentProcessRecord(doomed.pid!, starttimeOf(doomed.pid!))
    doomed.kill('SIGKILL')
    sleepMs(200)

    const out = runBootSequence({
      gatewayPid: gatewayProc.pid!,
      markerTurnKey: turnKey,
      markerAgeMs: 600_000, // past the 300s hang threshold
    })

    expect(out.spooledSources).toEqual(['resume_watchdog_timeout'])
    const db = openTurnsDb(agentDir)
    try {
      expect(getTurnByKey(db, turnKey)!.ended_via).toBe('timeout')
    } finally {
      db.close()
    }
  })

  it('does NOT report a timeout when the agent is alive and only the gateway died', () => {
    // The nastiest false positive: a long tool call means no marker touch for
    // >5 min, so the pre-fix gateway classified a HEALTHY long-running turn as
    // a hang and asked the user whether to retry it.
    const turnKey = seedInFlightTurn()
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))

    const out = runBootSequence({
      gatewayPid: gatewayProc.pid!,
      markerTurnKey: turnKey,
      markerAgeMs: 600_000,
    })

    expect(out.spooledSources).toEqual([])
    const db = openTurnsDb(agentDir)
    try {
      expect(getTurnByKey(db, turnKey)!.ended_via).toBeNull()
    } finally {
      db.close()
    }
  })
})
