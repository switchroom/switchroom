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
  writeRelaunchModelIntent,
  clearRelaunchModelIntent,
  readConfiguredDefaultModel,
  intentForRestartReason,
  SESSION_MODEL_FILE,
  RELAUNCH_MODEL_INTENT_FILE,
  CONFIGURED_DEFAULT_MODEL_FILE,
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

  it('inline-button-restart (operator-deliberate) → revert', () => {
    expect(intentForRestartReason('inline-button-restart')).toBe('revert')
  })

  it('unknown gateway reasons default to keep (only gateway code calls triggerSelfRestart; crashes never do)', () => {
    expect(intentForRestartReason('some-future-recovery-path')).toBe('keep')
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
