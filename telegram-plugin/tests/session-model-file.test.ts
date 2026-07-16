/**
 * Session-model file helpers (session-model-file.ts) — the gateway side of the
 * session-scoped /model contract (reference/rfcs/session-model-stickiness.md
 * §0.1, rev 4 — consume-once). The `.relaunch-model-intent` subsystem and the
 * crashloop counter were retired with rev 4; their tests are gone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
  consumeSessionModelCarrierOnHealthyBoot,
  readConfiguredDefaultModel,
  SESSION_MODEL_FILE,
  SESSION_MODEL_BOOT_ATTEMPTS_FILE,
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

describe('consumeSessionModelCarrierOnHealthyBoot (#3284 healthy-boot consume)', () => {
  it('deletes BOTH the carrier and the bounded-retry attempt counter', () => {
    writeFileSync(join(dir, SESSION_MODEL_FILE), 'whatever\n')
    writeFileSync(join(dir, SESSION_MODEL_BOOT_ATTEMPTS_FILE), '2\n')
    consumeSessionModelCarrierOnHealthyBoot(dir)
    expect(existsSync(join(dir, SESSION_MODEL_FILE))).toBe(false)
    expect(existsSync(join(dir, SESSION_MODEL_BOOT_ATTEMPTS_FILE))).toBe(false)
  })

  it('is idempotent / best-effort when neither file exists (no throw)', () => {
    expect(() => consumeSessionModelCarrierOnHealthyBoot(dir)).not.toThrow()
    expect(existsSync(join(dir, SESSION_MODEL_FILE))).toBe(false)
  })

  it('clears the counter even when the carrier is already gone (wedge that lost its carrier mid-race)', () => {
    writeFileSync(join(dir, SESSION_MODEL_BOOT_ATTEMPTS_FILE), '1\n')
    consumeSessionModelCarrierOnHealthyBoot(dir)
    expect(existsSync(join(dir, SESSION_MODEL_BOOT_ATTEMPTS_FILE))).toBe(false)
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

// ─── #3186: consume-once session-effort carrier (queued-command boot apply) ──

describe('session-effort file helpers (#3186)', () => {
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
