/**
 * Source-text pins for the no-repeat-on-timeout wiring (marko Rentals-budget
 * loop, 2026-06-17). gateway.ts / bridge.ts have top-level side effects and
 * aren't unit-importable; the decision logic is unit-tested in
 * permission-timeout.test.ts. These pins lock the wiring so it can't silently
 * regress.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')
const GATEWAY = read('gateway/gateway.ts')
const BRIDGE = read('bridge/bridge.ts')
const IPC_PROTOCOL = read('gateway/ipc-protocol.ts')
const IPC_CLIENT = read('bridge/ipc-client.ts')

function slice(src: string, fnHeader: string, span = 1600): string {
  const start = src.indexOf(fnHeader)
  expect(start, `expected to find ${fnHeader}`).toBeGreaterThan(-1)
  return src.slice(start, start + span)
}

describe('no-repeat-on-timeout wiring', () => {
  it('PermissionEvent carries an optional message field', () => {
    const evt = slice(IPC_PROTOCOL, 'export interface PermissionEvent', 2400)
    expect(evt).toMatch(/message\?:\s*string/)
  })

  it('the bridge IPC validator accepts an optional non-empty message', () => {
    expect(IPC_CLIENT).toMatch(/m\.message === undefined/)
  })

  it('the bridge forwards message on the permission channel notification', () => {
    const fn = slice(BRIDGE, 'function onPermission(', 1600)
    expect(fn).toContain('notifications/claude/channel/permission')
    expect(fn).toMatch(/msg\.message/)
  })

  it('the TTL auto-deny attaches a timeout message and records the signature', () => {
    // Within the pending-permission sweep block. Span bumped (2200 → 3200)
    // when Bug 2 added per-tool TTL + the timed-out keyboard-strip to this
    // block — the signature-record line now sits further down but the wiring
    // is intact.
    const sweep = slice(GATEWAY, 'for (const [k, v] of pendingPermissions)', 3200)
    expect(sweep).toContain('timeoutDenyMessage(')
    expect(sweep).toContain('permissionTimeoutSignatures.set(')
  })

  it('the TTL auto-deny strips the timed-out card keyboard (Bug 2)', () => {
    const sweep = slice(GATEWAY, 'for (const [k, v] of pendingPermissions)', 3200)
    // Per-tool TTL + keyboard-strip are both wired into the sweep.
    expect(sweep).toContain('ttlForTool(')
    expect(sweep).toContain('stripTimedOutPermissionCards(')
  })

  it('onPermissionRequest short-circuits a recent-timeout duplicate before posting a card', () => {
    const fn = slice(GATEWAY, 'onPermissionRequest(', 6000)
    const dupIdx = fn.indexOf('isRecentTimeoutDuplicate(')
    const cardIdx = fn.indexOf('pendingPermissions.set(requestId')
    expect(dupIdx).toBeGreaterThan(-1)
    expect(cardIdx).toBeGreaterThan(-1)
    // The duplicate check must run BEFORE the card is registered/posted.
    expect(dupIdx).toBeLessThan(cardIdx)
    expect(fn).toContain('duplicateDenyMessage')
  })

  it('suppression is reset on operator activity (inbound + card verdict + slash)', () => {
    // Three distinct reset points so a returning operator always gets a fresh card.
    const resets = GATEWAY.match(/clearPermissionTimeoutSuppression\(/g) ?? []
    // 1 definition call inside the helper + at least 3 reset callsites.
    expect(resets.length).toBeGreaterThanOrEqual(3)
    expect(GATEWAY).toContain("clearPermissionTimeoutSuppression('operator inbound')")
  })

  it('has a kill switch', () => {
    expect(GATEWAY).toContain('SWITCHROOM_PERMISSION_NO_REPEAT')
  })

  it('sweeps stale suppression entries past the safety-cap window', () => {
    expect(GATEWAY).toMatch(/permissionTimeoutSignatures\.delete\(sig\)/)
  })
})

describe('inbound gate holds while approval card is outstanding (#2841)', () => {
  // turnInFlightForGate() must return true when pendingPermissions is non-empty,
  // even after releaseTurnBufferGate has cleared claudeBusyKeys/machine on the
  // first interim reply. Without this, a new inbound delivered in that window
  // displaces the approval context and orphans the pending MCP call.
  it('turnInFlightForGate includes pendingPermissions.size > 0 on the legacy path', () => {
    // span 2600: the function gained a ~1100-char note (#3084 follow-up) documenting
    // the one case with no timeout valve — a HELD approval.
    const fn = slice(GATEWAY, 'function turnInFlightForGate()', 2600)
    // Both paths (legacy claudeBusyKeys + machine-authoritative) must include the check.
    expect(fn).toMatch(/claudeBusyKeys\.size\s*>\s*0\s*\|\|\s*hasPendingApproval/)
  })

  it('turnInFlightForGate includes pendingPermissions.size > 0 on the machine path', () => {
    const fn = slice(GATEWAY, 'function turnInFlightForGate()', 2700)
    // probeGateParity(...) || hasPendingApproval — the inner arg contains its own
    // parens (isMachineInTurn()), so match the two tokens independently.
    expect(fn).toContain('probeGateParity(')
    expect(fn).toMatch(/probeGateParity[\s\S]+?\|\|\s*hasPendingApproval/)
  })

  it('hasPendingApproval reads pendingPermissions.size', () => {
    const fn = slice(GATEWAY, 'function turnInFlightForGate()', 2600)
    expect(fn).toMatch(/pendingPermissions\.size\s*>\s*0/)
  })
})
