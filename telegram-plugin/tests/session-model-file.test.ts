/**
 * Durable session-model file helpers (session-model-file.ts) — the gateway
 * side of the stickiness contract (reference/rfcs/session-model-stickiness.md).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  serializeSessionModel,
  parseSessionModel,
  writeSessionModelFile,
  readSessionModelFile,
  readSessionModelFileRaw,
  restoreSessionModelFileRaw,
  clearSessionModelFile,
  clearSessionModelBootAttempts,
  SESSION_MODEL_BOOT_ATTEMPTS_FILE,
  writeRelaunchModelIntent,
  clearRelaunchModelIntent,
  readConfiguredDefaultModel,
  intentForRestartReason,
  readRelaunchModelIntent,
  clearStaleGatewayShutdownIntent,
  GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX,
  SESSION_MODEL_FILE,
  RELAUNCH_MODEL_INTENT_FILE,
  CONFIGURED_DEFAULT_MODEL_FILE,
  parseSessionEffort,
  writeSessionEffortFile,
  readSessionEffortFile,
  clearSessionEffortFile,
} from '../gateway/session-model-file.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchroom-sm-file-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('serialize/parse round-trip', () => {
  it('round-trips a record', () => {
    const rec = { model: 'sr-glm-5', configuredDefaultAtWrite: 'claude-sonnet-5', ts: 1783948123456 }
    expect(parseSessionModel(serializeSessionModel(rec))).toEqual(rec)
  })

  it('rejects corrupt JSON, missing fields, and non-canonical model tokens', () => {
    expect(parseSessionModel('{broken')).toBeNull()
    expect(parseSessionModel('{"model":"opus"}')).toBeNull()
    expect(parseSessionModel('{"model":"Opus 4.8","configuredDefaultAtWrite":"x","ts":1}')).toBeNull()
    expect(parseSessionModel('{"model":42,"configuredDefaultAtWrite":"x","ts":1}')).toBeNull()
  })
})

describe('writeSessionModelFile — canonical-token guard (review finding 7)', () => {
  it('writes a canonical token with the current default + a fresh ts', () => {
    writeSessionModelFile(dir, 'claude-opus-4-8', 'claude-sonnet-5')
    const rec = readSessionModelFile(dir)!
    expect(rec.model).toBe('claude-opus-4-8')
    expect(rec.configuredDefaultAtWrite).toBe('claude-sonnet-5')
    expect(Math.abs(Date.now() - rec.ts)).toBeLessThan(5000)
  })

  it('THROWS on a display label — "Opus 4.5" must never be persisted', () => {
    expect(() => writeSessionModelFile(dir, 'Opus 4.5', 'claude-sonnet-5')).toThrow(/non-canonical/)
    expect(existsSync(join(dir, SESSION_MODEL_FILE))).toBe(false)
  })
})

describe('rollback snapshot (scheduleModelRelaunch dispatch failure)', () => {
  it('restores prior content when a file existed', () => {
    writeSessionModelFile(dir, 'claude-opus-4-8', 'claude-sonnet-5')
    const snapshot = readSessionModelFileRaw(dir)
    writeSessionModelFile(dir, 'sr-glm-5', 'claude-sonnet-5')
    restoreSessionModelFileRaw(dir, snapshot)
    expect(readSessionModelFile(dir)!.model).toBe('claude-opus-4-8')
  })

  it('deletes the file when there was none before', () => {
    const snapshot = readSessionModelFileRaw(dir) // null
    writeSessionModelFile(dir, 'sr-glm-5', 'claude-sonnet-5')
    restoreSessionModelFileRaw(dir, snapshot)
    expect(existsSync(join(dir, SESSION_MODEL_FILE))).toBe(false)
  })
})

describe('relaunch intent', () => {
  it('writes one-line JSON with intent, reason, and embedded ts (the freshness clock)', () => {
    writeRelaunchModelIntent(dir, 'keep', 'user: /new from chat')
    const raw = readFileSync(join(dir, RELAUNCH_MODEL_INTENT_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.intent).toBe('keep')
    expect(parsed.reason).toBe('user: /new from chat')
    expect(Math.abs(Date.now() - parsed.ts)).toBeLessThan(5000)
  })

  it('last-writer-wins and clearable', () => {
    writeRelaunchModelIntent(dir, 'keep', 'a')
    writeRelaunchModelIntent(dir, 'revert', 'b')
    expect(JSON.parse(readFileSync(join(dir, RELAUNCH_MODEL_INTENT_FILE), 'utf8')).intent).toBe('revert')
    clearRelaunchModelIntent(dir)
    expect(existsSync(join(dir, RELAUNCH_MODEL_INTENT_FILE))).toBe(false)
  })
})

describe('intentForRestartReason — the triggerSelfRestart per-reason table (RFC §3)', () => {
  it.each([
    'schedule-restart-immediate',
    'restart-drain-cap-forced',
    'turn-complete-pending-restart',
    'fleet-fallback-resume',
    'sr-to-claude-model-switch',
  ])('switchroom-managed relaunch %s → keep', (reason) => {
    expect(intentForRestartReason(reason)).toBe('keep')
  })

  it('inline-button-restart → keep (#3039: a restart is not "clear my model")', () => {
    expect(intentForRestartReason('inline-button-restart')).toBe('keep')
  })

  it('unknown gateway reasons default to keep (only gateway code calls triggerSelfRestart; crashes never do)', () => {
    expect(intentForRestartReason('some-future-recovery-path')).toBe('keep')
  })
})

describe('readRelaunchModelIntent', () => {
  it('round-trips a stamped intent; null when absent / corrupt / malformed', () => {
    expect(readRelaunchModelIntent(dir)).toBeNull()
    writeRelaunchModelIntent(dir, 'keep', 'watchdog recovery')
    const rec = readRelaunchModelIntent(dir)!
    expect(rec.intent).toBe('keep')
    expect(rec.reason).toBe('watchdog recovery')
    expect(Math.abs(Date.now() - rec.ts)).toBeLessThan(5000)
    writeFileSync(join(dir, RELAUNCH_MODEL_INTENT_FILE), '{broken')
    expect(readRelaunchModelIntent(dir)).toBeNull()
    writeFileSync(join(dir, RELAUNCH_MODEL_INTENT_FILE), '{"intent":"maybe","reason":"x","ts":1}\n')
    expect(readRelaunchModelIntent(dir)).toBeNull()
  })
})

describe('clearStaleGatewayShutdownIntent (#3018 finding 4 — a gateway-only bounce must not leave a keep stamp)', () => {
  it('clears ONLY a gateway-shutdown-stamped intent and reports it', () => {
    writeRelaunchModelIntent(
      dir,
      'keep',
      `${GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX} graceful SIGTERM shutdown (deploy/rolling restart) — preserving user-chosen session model`,
    )
    expect(clearStaleGatewayShutdownIntent(dir)).toBe(true)
    expect(existsSync(join(dir, RELAUNCH_MODEL_INTENT_FILE))).toBe(false)
    // Idempotent: a second call finds nothing.
    expect(clearStaleGatewayShutdownIntent(dir)).toBe(false)
  })

  it('never touches a triggerSelfRestart / user-slash stamp (un-prefixed reason)', () => {
    writeRelaunchModelIntent(dir, 'keep', 'sr-to-claude-model-switch')
    expect(clearStaleGatewayShutdownIntent(dir)).toBe(false)
    expect(readRelaunchModelIntent(dir)!.reason).toBe('sr-to-claude-model-switch')
  })

  it('is a safe no-op on an absent or corrupt intent file', () => {
    expect(clearStaleGatewayShutdownIntent(dir)).toBe(false)
    writeFileSync(join(dir, RELAUNCH_MODEL_INTENT_FILE), 'not json')
    expect(clearStaleGatewayShutdownIntent(dir)).toBe(false)
  })
})

describe('readConfiguredDefaultModel', () => {
  it('reads the trimmed value; null when absent or empty', () => {
    expect(readConfiguredDefaultModel(dir)).toBeNull()
    writeFileSync(join(dir, CONFIGURED_DEFAULT_MODEL_FILE), 'claude-sonnet-5\n')
    expect(readConfiguredDefaultModel(dir)).toBe('claude-sonnet-5')
    writeFileSync(join(dir, CONFIGURED_DEFAULT_MODEL_FILE), '\n')
    expect(readConfiguredDefaultModel(dir)).toBeNull()
  })

  it('clearSessionModelFile is a safe no-op when absent', () => {
    expect(() => clearSessionModelFile(dir)).not.toThrow()
  })
})

// ─── #3039: durable session-effort carrier ───────────────────────────────────

describe('session-effort file helpers (#3039)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sr-session-effort-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a valid level with the configured default at write', () => {
    writeSessionEffortFile(dir, 'xhigh', 'low')
    const rec = readSessionEffortFile(dir)
    expect(rec?.level).toBe('xhigh')
    expect(rec?.configuredDefaultAtWrite).toBe('low')
    expect(typeof rec?.ts).toBe('number')
  })

  it('refuses to persist a non-allowlisted level (verbatim --effort surface)', () => {
    expect(() => writeSessionEffortFile(dir, 'mega; rm -rf /', 'low')).toThrow(/non-allowlisted/)
    expect(readSessionEffortFile(dir)).toBeNull()
  })

  it('parseSessionEffort rejects corrupt JSON, bad shape, and bad levels', () => {
    expect(parseSessionEffort('{broken')).toBeNull()
    expect(parseSessionEffort('{"level":"turbo","configuredDefaultAtWrite":"low","ts":1}')).toBeNull()
    expect(parseSessionEffort('{"level":"high","ts":1}')).toBeNull()
    expect(parseSessionEffort('{"level":"high","configuredDefaultAtWrite":"low","ts":1}')?.level).toBe('high')
  })

  it('clearSessionEffortFile removes it; read after clear is null', () => {
    writeSessionEffortFile(dir, 'high', '')
    clearSessionEffortFile(dir)
    expect(readSessionEffortFile(dir)).toBeNull()
  })
})

describe('intentForRestartReason is keep-for-everything (#3039)', () => {
  it('every reason keeps — restarts never clear a user model choice', () => {
    for (const reason of [
      'inline-button-restart',
      'user: /restart from chat',
      'schedule-restart-immediate',
      'anything-else',
    ]) {
      expect(intentForRestartReason(reason)).toBe('keep')
    }
  })
})

describe('clearSessionModelBootAttempts (#3043 item 2: bridge-register clears the crashloop counter)', () => {
  const bootAttemptsPath = () => join(dir, SESSION_MODEL_BOOT_ATTEMPTS_FILE)

  // Faithful model of start.sh.hbs "Override crashloop self-heal": each boot
  // within 150s of the previous stamp bumps the count; a stale stamp resets to
  // 1. Reproduced here so the accumulate-vs-reset OUTCOME is asserted, not just
  // the delete call.
  function simulateBootStamp(nowSec: number): number {
    let count = 0
    let prev = 0
    if (existsSync(bootAttemptsPath())) {
      const [c, p] = readFileSync(bootAttemptsPath(), 'utf8').trim().split(/\s+/)
      count = Number(c) || 0
      prev = Number(p) || 0
    }
    count = nowSec - prev < 150 ? count + 1 : 1
    writeFileSync(bootAttemptsPath(), `${count} ${nowSec}\n`)
    return count
  }

  it('WITHOUT a bridge register, three fast boots accumulate toward the 3-strike clear', () => {
    // Three operator hand-bounces, each <150s apart, with no register between.
    expect(simulateBootStamp(1000)).toBe(1)
    expect(simulateBootStamp(1010)).toBe(2)
    expect(simulateBootStamp(1020)).toBe(3) // start.sh would now clear a HEALTHY override — the false positive
  })

  it('a bridge register between boots resets the counter, so a healthy agent never reaches 3', () => {
    expect(simulateBootStamp(1000)).toBe(1)
    // Boot 1 came all the way up and the bridge registered → gateway clears it.
    clearSessionModelBootAttempts(dir)
    expect(existsSync(bootAttemptsPath())).toBe(false)

    // Next fast boot starts fresh at 1 (no accumulation), and register clears again.
    expect(simulateBootStamp(1010)).toBe(1)
    clearSessionModelBootAttempts(dir)
    expect(simulateBootStamp(1020)).toBe(1)
    // The healthy agent's counter never climbs to the 3-strike clear.
    const [count] = readFileSync(bootAttemptsPath(), 'utf8').trim().split(/\s+/)
    expect(Number(count)).toBeLessThan(3)
  })

  it('is best-effort — no throw when the counter file is absent', () => {
    expect(existsSync(bootAttemptsPath())).toBe(false)
    expect(() => clearSessionModelBootAttempts(dir)).not.toThrow()
  })
})
