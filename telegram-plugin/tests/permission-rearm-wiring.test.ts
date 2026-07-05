/**
 * Source-text wiring pins for the approval-card re-arm feature (#2861 / #2859).
 *
 * gateway.ts and bridge.ts have top-level side effects and aren't
 * unit-importable; the decision logic is unit-tested in permission-rearm.test.ts
 * and permission-ledger.test.ts. These pins lock the wiring that connects those
 * primitives so the two failure modes can't silently regress:
 *   R1 — gateway restart orphans pending approvals (boot-sweep stripped them).
 *   R2 — bridge dropped permission requests while the gateway IPC was down.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')
const GATEWAY = read('gateway/gateway.ts')
const BRIDGE = read('bridge/bridge.ts')
const IPC_CLIENT = read('bridge/ipc-client.ts')

function slice(src: string, header: string, span = 2400): string {
  const start = src.indexOf(header)
  expect(start, `expected to find ${header}`).toBeGreaterThan(-1)
  return src.slice(start, start + span)
}

// ─── Bridge: outstanding-request ledger (R2) ──────────────────────────────

describe('bridge ledger wiring', () => {
  it('imports and instantiates the outstanding-permission ledger', () => {
    expect(BRIDGE).toMatch(/from '\.\/permission-ledger\.js'/)
    expect(BRIDGE).toMatch(/createOutstandingPermissionLedger\(\)/)
  })

  it('records every permission_request in the ledger BEFORE the connect check', () => {
    const handler = slice(BRIDGE, "method: z.literal('notifications/claude/channel/permission_request')", 2600)
    const addIdx = handler.indexOf('outstandingPermissions.add(')
    const connIdx = handler.indexOf('!ipc.isConnected()')
    expect(addIdx, 'ledger.add must be present in the handler').toBeGreaterThan(-1)
    expect(connIdx, 'connect check must be present').toBeGreaterThan(-1)
    expect(addIdx, 'ledger.add must precede the connect check so a disconnected request is retained')
      .toBeLessThan(connIdx)
  })

  it('the early-return no longer DROPS unconditionally — it buffers on reconnect', () => {
    const handler = slice(BRIDGE, "method: z.literal('notifications/claude/channel/permission_request')", 2600)
    // The old drop path was a bare `if (!ipc || !ipc.isConnected()) { log; return }`
    // with no ledger/buffer. Pin the new buffer semantics instead.
    expect(handler).toMatch(/buffered.*re-send on reconnect/i)
    // Structural anti-regression: the legacy standalone drop message must only
    // appear behind the kill-switch fallback, never as the sole behavior.
    expect(handler).toMatch(/permissionRearmEnabled/)
  })

  it('deletes from the ledger when a verdict is delivered (onPermission)', () => {
    const onPerm = slice(BRIDGE, 'function onPermission(msg: PermissionEvent)', 900)
    expect(onPerm).toMatch(/outstandingPermissions\.delete\(msg\.requestId\)/)
  })

  it('flushes outstanding requests on every IPC (re)connect', () => {
    expect(BRIDGE).toMatch(/function flushOutstandingPermissionRequests/)
    expect(BRIDGE).toMatch(/onConnect:\s*flushOutstandingPermissionRequests/)
    const flush = slice(BRIDGE, 'function flushOutstandingPermissionRequests', 900)
    expect(flush).toMatch(/outstandingPermissions\.all\(\)/)
    expect(flush).toMatch(/sendPermissionRequest/)
  })

  it('honours the SWITCHROOM_PERMISSION_REARM kill switch', () => {
    expect(BRIDGE).toMatch(/SWITCHROOM_PERMISSION_REARM\s*!==\s*'0'/)
  })
})

// ─── IPC client: onConnect hook ───────────────────────────────────────────

describe('ipc-client onConnect hook', () => {
  it('exposes an onConnect option', () => {
    expect(IPC_CLIENT).toMatch(/onConnect\?:\s*\(\)\s*=>\s*void/)
  })
  it('invokes onConnect from the socket open() handler (after register)', () => {
    const open = slice(IPC_CLIENT, 'open(sock)', 900)
    const regIdx = open.indexOf('sendRegister()')
    const connIdx = open.indexOf('onConnect(')
    expect(connIdx, 'open() must call onConnect').toBeGreaterThan(-1)
    expect(regIdx).toBeLessThan(connIdx)
  })
})

// ─── Gateway: dedupe + re-arm (R1) ────────────────────────────────────────

describe('gateway re-arm wiring', () => {
  it('imports the pure re-arm helpers', () => {
    expect(GATEWAY).toMatch(/from '\.\/permission-rearm\.js'/)
    expect(GATEWAY).toMatch(/classifyPermissionRequest/)
    expect(GATEWAY).toMatch(/computeBootSweepStripTargets/)
  })

  it('tracks re-claimed request_ids for the grace-period sweep', () => {
    expect(GATEWAY).toMatch(/const rearmReclaimedRequestIds = new Set<string>\(\)/)
  })

  it('onPermissionRequest dedupes / re-arms before posting a card', () => {
    const fn = slice(GATEWAY, 'onPermissionRequest(_client: IpcClient, msg: PermissionRequestForward)', 5200)
    expect(fn).toMatch(/isPermissionRearmEnabled\(\)/)
    expect(fn).toMatch(/classifyPermissionRequest/)
    // duplicate → return (no second card); rearm → restore from store.
    expect(fn).toMatch(/disposition === 'duplicate'/)
    expect(fn).toMatch(/disposition === 'rearm'/)
    expect(fn).toMatch(/rearmPermissionFromStore\(/)
    expect(fn).toMatch(/rearmReclaimedRequestIds\.add\(requestId\)/)
    // The dedup/re-arm block must sit before the card-post (formatPermissionCardBody).
    const rearmIdx = fn.indexOf('classifyPermissionRequest')
    const postIdx = fn.indexOf('formatPermissionCardBody')
    expect(postIdx).toBeGreaterThan(-1)
    expect(rearmIdx).toBeLessThan(postIdx)
  })

  it('re-arm preserves the ORIGINAL startedAt (TTL clock, not Date.now())', () => {
    const fn = slice(GATEWAY, 'function rearmPermissionFromStore', 1800)
    // startedAt is derived from the persisted entries, never re-stamped.
    expect(fn).toMatch(/c\.startedAt/)
    expect(fn).toMatch(/startedAt,/)
    expect(fn).not.toMatch(/startedAt:\s*Date\.now\(\)/)
    expect(fn).toMatch(/pendingPermissions\.set\(requestId/)
  })

  it('re-arm re-attaches the keyboard on the EXISTING message(s) via editMessageText', () => {
    const fn = slice(GATEWAY, 'function rearmPermissionFromStore', 1800)
    expect(fn).toMatch(/buildPermissionActionRow\(requestId/)
    expect(fn).toMatch(/editMessageText\(/)
    // Re-arm edits existing messages; it must NOT post a brand-new card.
    expect(fn).not.toMatch(/sendRichMessage/)
  })

  it('never auto-answers — no dispatchPermissionVerdict inside re-arm (no-self-escalation)', () => {
    const fn = slice(GATEWAY, 'function rearmPermissionFromStore', 1800)
    expect(fn).not.toMatch(/dispatchPermissionVerdict/)
  })
})

// ─── Gateway: grace-period boot-sweep (R1) ────────────────────────────────

describe('gateway boot-sweep grace period', () => {
  it('defers the strip when re-arm is enabled, keeps immediate strip as the kill-switch path', () => {
    const sweep = slice(GATEWAY, 'Boot-sweep for permission cards from a prior gateway session', 3400)
    expect(sweep).toMatch(/if \(!isPermissionRearmEnabled\(\)\)/)
    // legacy immediate path still strips everything + clears the store
    expect(sweep).toMatch(/permCardStore\.clear\(\)/)
    // grace path: setTimeout + grace-ms knob + reclaimed filter
    expect(sweep).toMatch(/setTimeout\(/)
    expect(sweep).toMatch(/permissionRearmGraceMs\(\)/)
    expect(sweep).toMatch(/computeBootSweepStripTargets\(remaining, rearmReclaimedRequestIds\)/)
  })

  it('the grace path removes only stripped request_ids, not the whole store', () => {
    const sweep = slice(GATEWAY, 'Boot-sweep for permission cards from a prior gateway session', 3400)
    // Per-request removal (preserves re-armed live entries) inside the deferred block.
    expect(sweep).toMatch(/distinctRequestIds\(toStrip\)/)
    expect(sweep).toMatch(/permCardStore\.remove\(id\)/)
  })
})

// ─── Gateway: re-arm re-holds the #2840 inbound gate ──────────────────────

describe('re-armed pending card re-holds the inbound gate (#2840)', () => {
  it('turnInFlightForGate counts pending approvals', () => {
    const gate = slice(GATEWAY, 'function turnInFlightForGate()', 1200)
    expect(gate).toMatch(/pendingPermissions\.size > 0/)
  })
  it('re-arm restores a pendingPermissions entry → gate held automatically', () => {
    // The gate reads pendingPermissions.size; rearmPermissionFromStore sets an
    // entry, so a re-armed card holds the gate with no extra wiring.
    const fn = slice(GATEWAY, 'function rearmPermissionFromStore', 1800)
    expect(fn).toMatch(/pendingPermissions\.set\(requestId/)
  })
})
