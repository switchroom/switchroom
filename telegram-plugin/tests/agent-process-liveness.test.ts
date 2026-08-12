/**
 * switchroom#4641 — agent-process liveness probe.
 *
 * These tests use REAL processes and the REAL `/proc`, not a mocked fs: the
 * whole point of the probe is that it can tell a live agent from a dead one,
 * and a fixture that hand-writes both answers would pass against a probe that
 * always says "alive". Every liveness assertion below is anchored on a process
 * this test actually spawned (and, for the dead case, actually killed).
 *
 * The two stand-ins are ordinary `sleep` children spawned in a known order:
 * `agentProc` first, `gatewayProc` second — exactly the production ordering of
 * a gateway-only respawn (claude has been running for ages; the replacement
 * gateway was forked seconds ago).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseProcStat,
  readProcIdentity,
  readAgentProcessRecord,
  decideGatewayOnlyRespawn,
  detectGatewayOnlyRespawn,
  shouldSkipBootResumeForGatewayOnlyRespawn,
  AGENT_PROCESS_RECORD_FILE,
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
let gatewayProc: ChildProcess

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-liveness-'))
  // Order is load-bearing: the "agent" must exist BEFORE the "gateway".
  agentProc = spawnSleeper()
  await new Promise((r) => setTimeout(r, 20))
  gatewayProc = spawnSleeper()
  await new Promise((r) => setTimeout(r, 20))
})

afterAll(() => {
  for (const p of [agentProc, gatewayProc]) {
    try { p.kill('SIGKILL') } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

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

describe('gateway-only respawn detection (real processes)', () => {
  it('reports a gateway-only respawn when the agent is alive and older', () => {
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })
    const decision = detectGatewayOnlyRespawn({ stateDir: dir, selfPid: gatewayProc.pid })
    expect(decision).toEqual({
      gatewayOnly: true,
      reason: 'gateway-only-respawn',
      pid: agentProc.pid,
    })
  })

  it('does NOT claim a gateway-only respawn when the agent process is dead', async () => {
    const doomed = spawnSleeper()
    await new Promise((r) => setTimeout(r, 20))
    writeRecord({ pid: doomed.pid, starttime: starttimeOf(doomed.pid!) })
    doomed.kill('SIGKILL')
    await waitForExit(doomed)
    const decision = detectGatewayOnlyRespawn({ stateDir: dir, selfPid: gatewayProc.pid })
    expect(decision.gatewayOnly).toBe(false)
    expect(decision.reason).toBe('agent-process-dead')
  })

  it('rejects a recycled PID: same pid, different starttime', () => {
    const live = starttimeOf(agentProc.pid!)
    writeRecord({ pid: agentProc.pid, starttime: String(BigInt(live) - 1n) })
    const decision = detectGatewayOnlyRespawn({ stateDir: dir, selfPid: gatewayProc.pid })
    expect(decision).toEqual({
      gatewayOnly: false,
      reason: 'starttime-mismatch',
      pid: agentProc.pid,
    })
  })

  it('rejects an agent that started AFTER this gateway (fresh-boot race)', () => {
    // Swap the roles: the record names the LATER process, the probe runs as
    // the EARLIER one. This is the fresh-container ordering (gateway launched,
    // then `exec claude`), where the resume must still fire.
    writeRecord({ pid: gatewayProc.pid, starttime: starttimeOf(gatewayProc.pid!) })
    const decision = detectGatewayOnlyRespawn({ stateDir: dir, selfPid: agentProc.pid })
    expect(decision).toEqual({
      gatewayOnly: false,
      reason: 'agent-started-after-gateway',
      pid: gatewayProc.pid,
    })
  })

  it('fails open with no record at all (first boot)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agent-liveness-empty-'))
    try {
      expect(detectGatewayOnlyRespawn({ stateDir: empty, selfPid: gatewayProc.pid })).toEqual({
        gatewayOnly: false,
        reason: 'no-record',
        pid: null,
      })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('fails open on a torn record', () => {
    writeRecord('{"pid": 12')
    expect(detectGatewayOnlyRespawn({ stateDir: dir, selfPid: gatewayProc.pid }).gatewayOnly)
      .toBe(false)
    writeRecord({ pid: agentProc.pid, starttime: 'not-a-number' })
    expect(detectGatewayOnlyRespawn({ stateDir: dir, selfPid: gatewayProc.pid }).gatewayOnly)
      .toBe(false)
  })

  it('honours the SWITCHROOM_GATEWAY_RESPAWN_GUARD=0 escape hatch', () => {
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })
    const lines: string[] = []
    const prev = process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD
    process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD = '0'
    try {
      expect(
        shouldSkipBootResumeForGatewayOnlyRespawn(dir, {
          selfPid: gatewayProc.pid,
          log: (s) => lines.push(s),
        }),
      ).toBe(false)
    } finally {
      if (prev == null) delete process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD
      else process.env.SWITCHROOM_GATEWAY_RESPAWN_GUARD = prev
    }
    expect(lines.join('')).toContain('guard-disabled')
  })

  it('skips the boot-resume path (and says so) for a live older agent', () => {
    writeRecord({ pid: agentProc.pid, starttime: starttimeOf(agentProc.pid!) })
    const lines: string[] = []
    const skip = shouldSkipBootResumeForGatewayOnlyRespawn(dir, {
      selfPid: gatewayProc.pid,
      log: (s) => lines.push(s),
    })
    expect(skip).toBe(true)
    expect(lines.join('')).toContain('GATEWAY-ONLY respawn')
  })
})

describe('decideGatewayOnlyRespawn (pure)', () => {
  const record = { pid: 42, starttime: '1000' }

  it('rejects a comm mismatch when the record carries one', () => {
    expect(
      decideGatewayOnlyRespawn({
        record: { ...record, comm: 'claude' },
        live: { starttime: '1000', comm: 'imposter', state: 'S' },
        gatewayStarttime: '2000',
      }),
    ).toEqual({ gatewayOnly: false, reason: 'comm-mismatch', pid: 42 })
  })

  it('fails open when this gateway has no readable starttime', () => {
    expect(
      decideGatewayOnlyRespawn({
        record,
        live: { starttime: '1000', comm: 'claude', state: 'S' },
        gatewayStarttime: null,
      }).gatewayOnly,
    ).toBe(false)
  })

  it('rejects an exact starttime tie (cannot have forked before itself)', () => {
    expect(
      decideGatewayOnlyRespawn({
        record,
        live: { starttime: '1000', comm: 'claude', state: 'S' },
        gatewayStarttime: '1000',
      }).reason,
    ).toBe('agent-started-after-gateway')
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
