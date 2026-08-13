/**
 * switchroom#4641 — the boot-resume generation guard.
 *
 * Two mechanisms, tested for what each is actually responsible for:
 *
 *   - the per-container-boot GENERATION TOKEN (`.boot-resume-done`) is the
 *     only thing that can say "suppress". start.sh deletes it once per
 *     container boot before forking the gateway; the gateway stamps it after
 *     completing its boot-resume block.
 *   - the `/proc` AGENT RECORD is a VETO only: it can re-enable a boot resume
 *     when the recorded agent is provably gone, never suppress one.
 *
 * Liveness assertions use REAL processes and the REAL `/proc`, not a mocked
 * fs: a fixture that hand-writes both answers would pass against a probe that
 * always says "alive". Every "alive" claim is anchored on a process this test
 * spawned; every "dead" claim on one it killed.
 *
 * Deliberately NOT tested here, because it no longer exists: any comparison of
 * the agent's `/proc` starttime against the gateway's. The previous revision
 * suppressed on "the agent predates me", which was correct only by accident of
 * the docker tmux re-exec (measured margin on a live container: one clock
 * tick) and which broke outright when a gateway crashed during its own boot.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseProcStat,
  readProcIdentity,
  readAgentProcessRecord,
  decideGatewayOnlyRespawn,
  detectGatewayOnlyRespawn,
  shouldSkipBootResumeForGatewayOnlyRespawn,
  markBootResumeComplete,
  bootResumeDonePath,
  readBootResumeSentinel,
  containerBootIdentity,
  AGENT_PROCESS_RECORD_FILE,
  BOOT_RESUME_DONE_FILE,
} from '../gateway/agent-process-liveness.js'

function starttimeOf(pid: number): string {
  const id = readProcIdentity(pid)
  expect(id, `pid ${pid} should be live`).not.toBeNull()
  return id!.starttime
}

function spawnSleeper(): ChildProcess {
  return spawn('sleep', ['120'], { stdio: 'ignore' })
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return
  await new Promise<void>((res) => child.once('exit', () => res()))
}

let dir: string
let agentProc: ChildProcess

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-liveness-'))
  agentProc = spawnSleeper()
  await new Promise((r) => setTimeout(r, 20))
})

afterAll(() => {
  try { agentProc.kill('SIGKILL') } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  // Every case states its own generation-token state explicitly.
  try { unlinkSync(bootResumeDonePath(dir)) } catch { /* absent */ }
  try { unlinkSync(join(dir, AGENT_PROCESS_RECORD_FILE)) } catch { /* absent */ }
})

/** start.sh's outer-pass "open a new generation" step. */
function clearToken(): void {
  try { unlinkSync(bootResumeDonePath(dir)) } catch { /* absent */ }
}

function writeRecord(rec: unknown, name = AGENT_PROCESS_RECORD_FILE): string {
  const p = join(dir, name)
  writeFileSync(p, typeof rec === 'string' ? rec : JSON.stringify(rec))
  return p
}

describe('parseProcStat', () => {
  it('reads state + starttime past a comm containing spaces and parens', () => {
    // A real-shaped line with a hostile comm — the naive `awk $22` split and a
    // first-`)` split both return the wrong field here.
    const raw =
      '4242 (weird ) name) S 1 4242 4242 0 -1 4194304 167 0 0 0 0 0 0 0 20 0 1 0 ' +
      '987654321 4165632 702 18446744073709551615 0 0 0 0 0 0 2 4 65536 1 0 0 17 0 0 0 0 0 0'
    expect(parseProcStat(raw)).toEqual({
      comm: 'weird ) name',
      state: 'S',
      starttime: '987654321',
    })
  })

  it('agrees with awk on this process\'s own /proc entry', () => {
    const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/)
    expect(parseProcStat(raw)!.starttime).toBe(fields[19])
  })

  it('treats a zombie as dead', () => {
    const raw = '4242 (claude) Z 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 5 ' +
      '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'
    expect(parseProcStat(raw)!.state).toBe('Z')
  })
})

describe('the generation token decides', () => {
  it('suppresses ONLY after a gateway stamped the token this generation', () => {
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })

    // Fresh container boot: start.sh cleared the token, no gateway has
    // finished its boot resume yet. The live agent record must NOT suppress.
    expect(detectGatewayOnlyRespawn({ stateDir: dir })).toEqual({
      gatewayOnly: false,
      reason: 'no-boot-resume-sentinel',
      pid: agentProc.pid,
    })

    // …the first gateway completes its boot-resume block…
    markBootResumeComplete(dir)
    expect(existsSync(bootResumeDonePath(dir))).toBe(true)

    // …and a respawned gateway now sees the generation already handled.
    expect(detectGatewayOnlyRespawn({ stateDir: dir })).toEqual({
      gatewayOnly: true,
      reason: 'gateway-only-respawn',
      pid: agentProc.pid,
    })
  })

  it('does NOT suppress when the gateway crashed during its own boot', () => {
    // The #4641-motivating Bun crash-at-boot pattern: gateway #1 died before
    // finishing the boot-resume block, so it never stamped the token — even
    // though start.sh had already published a live agent record. Gateway #2
    // MUST do the boot resume; the previous starttime-ordering guard
    // suppressed here and lost the interrupted turn permanently.
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })
    const decision = detectGatewayOnlyRespawn({ stateDir: dir })
    expect(decision.gatewayOnly).toBe(false)
    expect(decision.reason).toBe('no-boot-resume-sentinel')
  })

  it('suppresses on a token with no record yet (gateway respawn pre-exec)', () => {
    // The gateway boots long before start.sh reaches `exec claude`. A gateway
    // that crashes in that window must still not repeat this generation's
    // boot resume — repeating it would spool the resume synthetic twice.
    markBootResumeComplete(dir)
    expect(detectGatewayOnlyRespawn({ stateDir: dir })).toEqual({
      gatewayOnly: true,
      reason: 'gateway-only-respawn-no-record',
      pid: null,
    })
  })

  it('a container restart re-opens the generation (start.sh clears the token)', () => {
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })
    markBootResumeComplete(dir)
    expect(detectGatewayOnlyRespawn({ stateDir: dir }).gatewayOnly).toBe(true)
    clearToken()
    expect(detectGatewayOnlyRespawn({ stateDir: dir }).gatewayOnly).toBe(false)
  })
})

describe('the /proc record can only VETO a suppression', () => {
  it('vetoes when the recorded agent process is really dead', async () => {
    const doomed = spawnSleeper()
    await new Promise((r) => setTimeout(r, 20))
    writeRecord({ pid: doomed.pid, starttime: starttimeOf(doomed.pid!) })
    doomed.kill('SIGKILL')
    await waitForExit(doomed)
    markBootResumeComplete(dir)

    const decision = detectGatewayOnlyRespawn({ stateDir: dir })
    expect(decision.gatewayOnly).toBe(false)
    expect(decision.reason).toBe('agent-process-dead')
  })

  it('vetoes a recycled PID: same pid, different starttime', () => {
    const live = starttimeOf(agentProc.pid!)
    writeRecord({ pid: agentProc.pid, starttime: String(BigInt(live) - 1n) })
    markBootResumeComplete(dir)
    expect(detectGatewayOnlyRespawn({ stateDir: dir })).toEqual({
      gatewayOnly: false,
      reason: 'starttime-mismatch',
      pid: agentProc.pid,
    })
  })

  it('cannot manufacture a suppression on its own', () => {
    // A live, matching, older record with NO token still runs the boot resume.
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })
    expect(detectGatewayOnlyRespawn({ stateDir: dir }).gatewayOnly).toBe(false)
  })

  it('fails open on a torn record even with the token present', () => {
    markBootResumeComplete(dir)
    writeRecord('{"pid": 12')
    // Torn record is indistinguishable from "no record" — and with the token
    // present that is a suppression, which is the safe answer here: the block
    // demonstrably already ran this generation.
    expect(detectGatewayOnlyRespawn({ stateDir: dir }).reason)
      .toBe('gateway-only-respawn-no-record')
  })

  it('honours the SWITCHROOM_GATEWAY_RESPAWN_GUARD=0 escape hatch', () => {
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })
    markBootResumeComplete(dir)
    const lines: string[] = []
    const prev = process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD
    process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD = '0'
    try {
      expect(
        shouldSkipBootResumeForGatewayOnlyRespawn(dir, { log: (s) => lines.push(s) }),
      ).toBe(false)
    } finally {
      if (prev == null) delete process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD
      else process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD = prev
    }
    expect(lines.join('')).toContain('guard-disabled')
  })

  it('skips the boot-resume path (and says so) for a live agent + token', () => {
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })
    markBootResumeComplete(dir)
    const lines: string[] = []
    expect(shouldSkipBootResumeForGatewayOnlyRespawn(dir, { log: (s) => lines.push(s) })).toBe(true)
    const out = lines.join('')
    expect(out).toContain('GATEWAY-ONLY respawn')
    // The log must name the side effects the break skips (the MEDIUM finding:
    // it skips more than the resume synthetic).
    expect(out).toContain('bridge-dead marker')
    expect(out).toContain('crash-redelivery')
  })
})

describe('markBootResumeComplete', () => {
  it('writes the token atomically and leaves no tmp file behind', () => {
    markBootResumeComplete(dir)
    const p = bootResumeDonePath(dir)
    expect(p.endsWith(BOOT_RESUME_DONE_FILE)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toMatchObject({ pid: process.pid })
    expect(existsSync(`${p}.tmp.${process.pid}`)).toBe(false)
  })

  it('never throws when the state dir is unwritable — it logs and continues', () => {
    const lines: string[] = []
    expect(() =>
      markBootResumeComplete(join(dir, 'no', 'such', 'dir'), { log: (s) => lines.push(s) }),
    ).not.toThrow()
    expect(lines.join('')).toContain(BOOT_RESUME_DONE_FILE)
  })
})

describe('decideGatewayOnlyRespawn (pure)', () => {
  const record = { pid: 42, starttime: '1000' }
  const live = { starttime: '1000', comm: 'claude', state: 'S' }

  it('rejects a comm mismatch when the record carries one', () => {
    expect(
      decideGatewayOnlyRespawn({
        sentinelPresent: true,
        record: { ...record, comm: 'claude' },
        live: { ...live, comm: 'imposter' },
      }),
    ).toEqual({ gatewayOnly: false, reason: 'comm-mismatch', pid: 42 })
  })

  it('never suppresses without the generation token, whatever /proc says', () => {
    for (const l of [live, null]) {
      expect(decideGatewayOnlyRespawn({ sentinelPresent: false, record, live: l }).gatewayOnly)
        .toBe(false)
    }
  })
})

describe('readAgentProcessRecord', () => {
  it('accepts the exact shape start.sh writes', () => {
    const p = writeRecord({ pid: 7, starttime: '213153204', boot_at: 1786572493000 })
    expect(readAgentProcessRecord(p)).toEqual({
      pid: 7,
      starttime: '213153204',
      boot_at: 1786572493000,
    })
  })

  it('rejects a nonsense pid', () => {
    expect(readAgentProcessRecord(writeRecord({ pid: 0, starttime: '5' }))).toBeNull()
    expect(readAgentProcessRecord(writeRecord({ pid: -1, starttime: '5' }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #4648 LOW-2: the token carries the container-boot identity
// ---------------------------------------------------------------------------

describe('generation-token boot identity', () => {
  it('stamps the live container-boot identity (PID 1 starttime) into the token', () => {
    markBootResumeComplete(dir)
    const body = JSON.parse(readFileSync(bootResumeDonePath(dir), 'utf8')) as { boot?: string }
    expect(body.boot).toBe(containerBootIdentity()!)
  })

  it('treats a token from a DIFFERENT container boot as stale, not as a suppressor', () => {
    // The failure this closes: start.sh's `rm -f … 2>/dev/null || true` swallows
    // a per-file unlink failure, so a token can outlive its generation and
    // suppress EVERY later resume — permanently and silently, since
    // `gateway-only-respawn-no-record` needs no corroborating evidence.
    writeFileSync(
      bootResumeDonePath(dir),
      JSON.stringify({ pid: 4242, at: Date.now(), boot: '1' }) + '\n',
    )
    const decision = detectGatewayOnlyRespawn({ stateDir: dir })
    expect(decision.gatewayOnly).toBe(false)
    expect(decision.reason).toBe('stale-boot-token')
  })

  it('still suppresses for a token stamped in THIS boot, with no record present', () => {
    // The `gateway-only-respawn-no-record` path must survive the hardening:
    // the gateway boots long before start.sh `exec`s claude.
    markBootResumeComplete(dir)
    expect(existsSync(join(dir, AGENT_PROCESS_RECORD_FILE))).toBe(false)
    const decision = detectGatewayOnlyRespawn({ stateDir: dir })
    expect(decision.gatewayOnly).toBe(true)
    expect(decision.reason).toBe('gateway-only-respawn-no-record')
  })

  it('keeps the pre-existing behaviour when the token carries NO identity', () => {
    // One-directional by design: only a positive MISMATCH is evidence. A
    // legacy/identity-less token must not become a fail-open path, or the
    // hardening would itself re-open #4641.
    writeFileSync(bootResumeDonePath(dir), JSON.stringify({ pid: 4242, at: Date.now() }) + '\n')
    expect(readBootResumeSentinel(bootResumeDonePath(dir))).toEqual({ present: true, stale: false })
    expect(detectGatewayOnlyRespawn({ stateDir: dir }).gatewayOnly).toBe(true)
  })

  it('keeps the pre-existing behaviour when the token body is unparseable', () => {
    writeFileSync(bootResumeDonePath(dir), 'not json at all')
    expect(readBootResumeSentinel(bootResumeDonePath(dir))).toEqual({ present: true, stale: false })
  })

  it('keeps the pre-existing behaviour when /proc/1 is unreadable', () => {
    // No live identity to compare against → no evidence → not stale.
    writeFileSync(
      bootResumeDonePath(dir),
      JSON.stringify({ pid: 4242, at: Date.now(), boot: '1' }) + '\n',
    )
    const emptyProc = mkdtempSync(join(tmpdir(), 'noproc-'))
    try {
      expect(containerBootIdentity(emptyProc)).toBeNull()
      expect(readBootResumeSentinel(bootResumeDonePath(dir), { procRoot: emptyProc }))
        .toEqual({ present: true, stale: false })
    } finally {
      rmSync(emptyProc, { recursive: true, force: true })
    }
  })

  it('reports absent when there is no token at all', () => {
    clearToken()
    expect(readBootResumeSentinel(bootResumeDonePath(dir))).toEqual({ present: false, stale: false })
  })
})

// ---------------------------------------------------------------------------
// #4648 LOW-1: no env var may redirect the token/record paths
// ---------------------------------------------------------------------------

describe('path overrides are test-injection only (fail-open invariant)', () => {
  it('ignores SWITCHROOM_BOOT_RESUME_DONE_FILE / SWITCHROOM_AGENT_PROCESS_FILE', () => {
    // If these were honoured, start.sh (which hard-codes
    // "$TELEGRAM_STATE_DIR/.boot-resume-done") would clear one path while the
    // gateway read another: the token would never be cleared and EVERY boot
    // would suppress its resume forever — the module's one fail-CLOSED path.
    const decoy = mkdtempSync(join(tmpdir(), 'decoy-'))
    const prevToken = process.env.SWITCHROOM_BOOT_RESUME_DONE_FILE
    const prevRecord = process.env.SWITCHROOM_AGENT_PROCESS_FILE
    try {
      process.env.SWITCHROOM_BOOT_RESUME_DONE_FILE = join(decoy, 'token')
      process.env.SWITCHROOM_AGENT_PROCESS_FILE = join(decoy, 'record')
      clearToken()
      // A token written into the decoy path must NOT be seen…
      writeFileSync(join(decoy, 'token'), JSON.stringify({ pid: 1, at: Date.now() }) + '\n')
      expect(shouldSkipBootResumeForGatewayOnlyRespawn(dir, { log: () => {} })).toBe(false)
      // …and the stamp must land in stateDir, not the decoy.
      markBootResumeComplete(dir)
      expect(existsSync(bootResumeDonePath(dir))).toBe(true)
      expect(shouldSkipBootResumeForGatewayOnlyRespawn(dir, { log: () => {} })).toBe(true)
    } finally {
      if (prevToken == null) delete process.env.SWITCHROOM_BOOT_RESUME_DONE_FILE
      else process.env.SWITCHROOM_BOOT_RESUME_DONE_FILE = prevToken
      if (prevRecord == null) delete process.env.SWITCHROOM_AGENT_PROCESS_FILE
      else process.env.SWITCHROOM_AGENT_PROCESS_FILE = prevRecord
      rmSync(decoy, { recursive: true, force: true })
    }
  })
})
