/**
 * Regression for #1115 follow-up — vault-approval-posture config errors
 * must NOT manifest as unhandled-rejection crash loops.
 *
 * Pre-fix (2026-05-13 overnight UAT discovery): when the operator
 * declared `vault.broker.approvalAuth: telegram-id` in switchroom.yaml
 * but the auto-unlock blob couldn't be read (e.g. agent UID can't
 * access the operator's home dir), `resolveVaultApprovalPosture`
 * threw, the startup IIFE in gateway.ts let the error propagate as an
 * unhandled rejection, and `_switchroom_supervise` saw status=0 from
 * the shutdown handler and respawned the gateway. 10 restarts in <60s
 * before the supervisor's restart-cap kicked in. Each restart posted
 * an "agent-crashed" operator-event card and the bridge was alive only
 * in brief windows between restarts — inbound messages dropped.
 *
 * Post-fix: the startup catches the config-class error, writes a
 * quarantine marker with reason `startup.config_error`, and calls
 * `process.exit(78)` (sysexits EX_CONFIG). The supervisor short-
 * circuits on exit 78 without restarting (`_switchroom_supervise` in
 * `profiles/_base/start.sh.hbs`), so the operator sees ONE clean
 * error and a quarantine file instead of a crash-loop log smear.
 *
 * These tests assert the contracts:
 *   1. The reason code `startup.config_error` exists in both quarantine
 *      modules (host-side and plugin-side stay in sync).
 *   2. The quarantine marker writer accepts the new reason and writes
 *      a parseable JSON file.
 *   3. The reader at `src/agents/quarantine.ts` round-trips the new
 *      reason.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeQuarantineMarker, QUARANTINE_FILENAME } from '../gateway/quarantine.js'
import {
  readQuarantineMarker,
  type QuarantineReason,
} from '../../src/agents/quarantine.js'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'vault-posture-quarantine-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('quarantine — startup.config_error reason', () => {
  it('plugin-side writer accepts the new reason and writes a parseable marker', () => {
    writeQuarantineMarker(
      stateDir,
      'startup.config_error',
      'vault.broker.approvalAuth=telegram-id but blob unreadable',
    )
    const raw = readFileSync(join(stateDir, QUARANTINE_FILENAME), 'utf-8')
    const parsed = JSON.parse(raw) as {
      v: number
      reason: string
      ts: number
      detail?: string
    }
    expect(parsed.v).toBe(1)
    expect(parsed.reason).toBe('startup.config_error')
    expect(typeof parsed.ts).toBe('number')
    expect(parsed.detail).toContain('vault.broker.approvalAuth')
  })

  it('host-side reader round-trips the new reason', () => {
    writeQuarantineMarker(stateDir, 'startup.config_error', 'detail goes here')
    const m = readQuarantineMarker(stateDir)
    expect(m).not.toBeNull()
    expect(m!.reason).toBe('startup.config_error')
    expect(m!.detail).toBe('detail goes here')
  })

  it('startup.unauthorized reason still round-trips (no regression)', () => {
    writeQuarantineMarker(stateDir, 'startup.unauthorized', '401 Unauthorized')
    const m = readQuarantineMarker(stateDir)
    expect(m!.reason).toBe('startup.unauthorized')
  })

  it('type-level: both reasons accepted by QuarantineReason union', () => {
    const accepted: QuarantineReason[] = ['startup.unauthorized', 'startup.config_error']
    expect(accepted).toHaveLength(2)
  })

  it('marker survives in detail field — no truncation of operator-facing message', () => {
    const longDetail =
      'vault.broker.approvalAuth=telegram-id but reading auto-unlock blob at '
      + '/state/agent/home/.switchroom/vault-auto-unlock failed: ENOENT no such '
      + 'file or directory. Refusing to boot — silently falling back to '
      + 'passphrase posture would invert the operator\'s declared security '
      + 'posture. Either repair the auto-unlock blob (rerun `switchroom setup` '
      + '/ `switchroom vault auto-unlock`) or remove vault.broker.approvalAuth '
      + 'from switchroom.yaml.'
    writeQuarantineMarker(stateDir, 'startup.config_error', longDetail)
    const m = readQuarantineMarker(stateDir)
    expect(m!.detail).toBe(longDetail)
  })
})
