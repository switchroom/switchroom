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
 *   - a gateway that CRASHES DURING ITS OWN BOOT, before stamping the
 *     per-container-boot generation token
 *       → the successor gateway does the full boot resume; the interrupted
 *         turn is not lost. (This is the case the earlier starttime-ordering
 *         guard got wrong: it saw a live claude that predated it and
 *         suppressed forever.)
 *   - a suppressed respawn and the #3038 bridge-dead escalation marker
 *       → the marker is NOT re-consumed, because the gateway that stamped
 *         the token already consumed it this generation.
 *   - genuine agent restart (recorded process really is dead)
 *       → the resume still fires, exactly as before.
 *   - watchdog-timeout classification and first boot (no record file)
 *       → unchanged.
 *
 * Every "alive" claim is anchored on a process this test actually spawned, and
 * every "dead" claim on one it actually killed — so a probe hard-wired to
 * either answer fails here. The generation token is never hand-placed for a
 * suppression case without a boot that legitimately stamped it, or an
 * explicitly-stated stale-token scenario.
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
  markBootResumeComplete,
  bootResumeDonePath,
  AGENT_PROCESS_RECORD_FILE,
} from '../gateway/agent-process-liveness.js'
import { consumeBridgeDeadEscalationMarker } from '../gateway/bridge-dead-watchdog.js'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let agentDir: string
let stateDir: string
/** Long-lived stand-in for the `claude` process. */
let agentProc: ReturnType<typeof spawn>

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
  /** The #3038 bridge-dead marker this boot consumed, if any. */
  bridgeDeadStreak: number | null
  /** Did this boot stamp the per-container-boot generation token? */
  tokenStamped: boolean
}

/**
 * The gateway's boot-resume block, in gateway.ts's order, over the real
 * collaborators. `guarded: false` reproduces the pre-#4641 gateway.
 *
 * `crashAt` models a gateway that dies during its own boot (the Bun 1.3.13
 * crash-at-boot pattern that motivated the fix): `'guard'` dies immediately
 * after the guard, before any side effect; `'stamp'` gets all the way through
 * the effects but dies before stamping the token. Neither stamps it.
 */
function runBootSequence(opts: {
  guarded?: boolean
  markerTurnKey?: string | null
  markerAgeMs?: number | null
  crashAt?: 'guard' | 'stamp'
}): BootResult {
  const spoolPath = join(stateDir, 'inbound-spool.jsonl')
  const db = openTurnsDb(agentDir)
  const spool = createInboundSpool({ path: spoolPath, fs: SPOOL_FS, log: () => {} })
  let reaped = 0
  let bridgeDeadStreak: number | null = null
  let tokenStamped = false
  try {
    // ---- the guard (gateway.ts: immediately after applySubagentsSchema) ----
    const skip =
      (opts.guarded ?? true) &&
      shouldSkipBootResumeForGatewayOnlyRespawn(stateDir, { log: () => {} })
    if (!skip && opts.crashAt !== 'guard') {
      const res = markOrphanedWithTimeoutClassification(db, {
        markerTurnKey: opts.markerTurnKey ?? null,
        markerAgeMs: opts.markerAgeMs ?? null,
        hangThresholdMs: 300_000,
      })
      reaped = res.reaped
      // gateway.ts:~1721 — consumed (always cleared) whether or not a turn was
      // in flight. The `break` skips this too, which is only correct because
      // the token proves a gateway already consumed it this generation.
      const marker = consumeBridgeDeadEscalationMarker(
        join(stateDir, 'bridge-dead-escalation.json'),
      )
      if (marker != null) bridgeDeadStreak = marker.count ?? 1
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
      // gateway.ts: LAST statement of the block. A crash before here leaves no
      // token, so the successor gateway redoes the whole boot resume.
      if (opts.crashAt !== 'stamp') {
        markBootResumeComplete(stateDir)
        tokenStamped = true
      }
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
    bridgeDeadStreak,
    tokenStamped,
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
  // start.sh's outer pass: a fresh container boot clears the generation token.
  // Every case that wants a gateway-only respawn must first run a boot that
  // stamps it, exactly as production does.
  expect(existsSync(bootResumeDonePath(stateDir))).toBe(false)
  agentProc = spawn('sleep', ['120'], { stdio: 'ignore' })
  sleepMs(20)
})

afterEach(() => {
  try { agentProc.kill('SIGKILL') } catch { /* already gone */ }
  rmSync(agentDir, { recursive: true, force: true })
})

/** Write a fresh #3038 bridge-dead escalation marker. */
function writeBridgeDeadMarker(count = 2): string {
  const p = join(stateDir, 'bridge-dead-escalation.json')
  writeFileSync(p, JSON.stringify({ ts: Date.now(), reason: 'mcp-bridge-dead', count }))
  return p
}

// ---------------------------------------------------------------------------
// The bug
// ---------------------------------------------------------------------------


/** A completed first boot of this container generation: stamps the token. */
function firstBootOfThisContainer(): BootResult {
  return runBootSequence({})
}

describe('gateway-only respawn (claude still running)', () => {
  it('spools ZERO resume_interrupted entries and leaves the live turn open', () => {
    // Full production sequence. Boot #1 of this container: no turn in flight,
    // nothing reaped, generation token stamped. start.sh then publishes the
    // agent record and execs claude, which takes a message…
    const first = firstBootOfThisContainer()
    expect(first.tokenStamped).toBe(true)
    expect(first.spooledSources).toEqual([])
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))
    const turnKey = seedInFlightTurn()

    // …and THEN the gateway alone crashes and respawns.
    const out = runBootSequence({})

    // The outcome the issue names.
    expect(out.spooledSources).toEqual([])
    expect(out.spoolRaw).not.toContain('resume_interrupted')
    // …and no collateral: the live turn keeps its open row (no `restart` lie),
    // and the one-shot wake-audit env is not written by the respawn either.
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
    markBootResumeComplete(stateDir)

    // Same fixture, guard bypassed — the pre-#4641 gateway.
    const out = runBootSequence({ guarded: false })

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
    markBootResumeComplete(stateDir)
    for (let i = 0; i < 3; i++) {
      expect(runBootSequence({}).spooledSources).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// A gateway that crashes DURING its own boot (reviewer MAJOR 2)
// ---------------------------------------------------------------------------

describe('gateway crash during its own boot', () => {
  it('still resumes the interrupted turn — the token was never stamped', () => {
    // The container restarts with a genuinely interrupted turn. start.sh forks
    // gateway #1 and (before the exec) publishes a record naming a LIVE agent
    // process that predates gateway #2. Gateway #1 then dies before reaching
    // the boot block, so it never stamps the token.
    //
    // The replacement gateway MUST do the full boot resume. The previous
    // starttime-ordering guard suppressed exactly here — it saw a live claude
    // older than itself — and the interrupted turn was never reaped or
    // resumed at all.
    const turnKey = seedInFlightTurn()
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))

    const crashed = runBootSequence({ crashAt: 'guard' })
    expect(crashed.tokenStamped).toBe(false)
    expect(crashed.spooledSources).toEqual([])
    expect(existsSync(bootResumeDonePath(stateDir))).toBe(false)

    const out = runBootSequence({})

    expect(out.spooledSources).toEqual(['resume_interrupted'])
    expect(out.reaped).toBe(1)
    expect(out.pendingEnvWritten).toBe(true)
    expect(out.tokenStamped).toBe(true)
    const db = openTurnsDb(agentDir)
    try {
      expect(getTurnByKey(db, turnKey)!.ended_via).toBe('restart')
    } finally {
      db.close()
    }
  })

  it('still consumes the bridge-dead escalation marker', () => {
    // #3038: the marker is consumed (always cleared) whether or not a turn was
    // in flight, and its `count` seeds the cross-boot escalation damper. A
    // gateway that crashed before consuming it must not strand it on disk —
    // the successor's boot block has to reach it.
    const markerPath = writeBridgeDeadMarker(3)
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))

    const crashed = runBootSequence({ crashAt: 'guard' })
    expect(crashed.bridgeDeadStreak).toBeNull()
    expect(existsSync(markerPath)).toBe(true)

    const out = runBootSequence({})
    expect(out.bridgeDeadStreak).toBe(3)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('a crash after the effects but before the stamp does not suppress either', () => {
    // The other half of the window: the block ran, but the token write never
    // landed. The successor re-runs the block. That is a duplicate resume, not
    // a lost one — the deliberate fail-open direction.
    seedInFlightTurn()
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))

    const crashed = runBootSequence({ crashAt: 'stamp' })
    expect(crashed.spooledSources).toEqual(['resume_interrupted'])
    expect(crashed.tokenStamped).toBe(false)

    const out = runBootSequence({})
    expect(out.tokenStamped).toBe(true) // it did NOT suppress
  })
})

// ---------------------------------------------------------------------------
// What the `break` skips, beyond the resume synthetic (reviewer MEDIUM)
// ---------------------------------------------------------------------------

describe('a suppressed respawn and the bridge-dead escalation marker', () => {
  it('leaves an already-consumed generation alone: no marker, no streak reset', () => {
    // Boot #1 of this container consumes the marker (count=3 → the damper) and
    // stamps the token. The respawn must NOT re-run that consumption: there is
    // nothing left to consume, and a fresh marker written later in the SAME
    // generation belongs to the live watchdog, not to a boot classification.
    writeBridgeDeadMarker(3)
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))
    const first = runBootSequence({})
    expect(first.bridgeDeadStreak).toBe(3)
    expect(first.tokenStamped).toBe(true)

    const markerPath = writeBridgeDeadMarker(5)
    const out = runBootSequence({})

    expect(out.bridgeDeadStreak).toBeNull() // the break skipped the consumption
    expect(existsSync(markerPath)).toBe(true) // …so the marker survives on disk
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
    // Even with a token from the previous generation left behind (a stale
    // volume, an unclean boot), a dead agent VETOES the suppression.
    markBootResumeComplete(stateDir)

    const out = runBootSequence({})

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

  it('still fires on a fresh container boot (token cleared by start.sh)', () => {
    seedInFlightTurn()
    // The fresh-boot shape the ordering arm used to guard: start.sh has
    // already published a record for a LIVE agent process. Without the token
    // there is no suppression, whatever /proc says.
    writeAgentProcessRecord(agentProc.pid!, starttimeOf(agentProc.pid!))
    expect(existsSync(bootResumeDonePath(stateDir))).toBe(false)

    const out = runBootSequence({})

    expect(out.spooledSources).toEqual(['resume_interrupted'])
    expect(out.pendingEnvWritten).toBe(true)
  })

  it('still fires on first boot, when no process record exists at all', () => {
    seedInFlightTurn()
    expect(existsSync(join(stateDir, AGENT_PROCESS_RECORD_FILE))).toBe(false)

    const out = runBootSequence({})

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
    markBootResumeComplete(stateDir)

    expect(runBootSequence({}).spooledSources).toEqual(['resume_interrupted'])
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
    markBootResumeComplete(stateDir)

    const out = runBootSequence({
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
