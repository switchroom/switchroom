/**
 * Unit tests for the bridge-side outstanding permission-request ledger
 * (#2861 / #2859).
 *
 * The ledger is the primitive that closes R2 (bridge dropped permission
 * requests while the gateway IPC was down). bridge.ts wires it as:
 *   - permission_request notification → ledger.add(params) (BEFORE the
 *     connect check), then send if connected else buffer.
 *   - onPermission (verdict delivered) → ledger.delete(requestId).
 *   - onConnect (IPC (re)connect) → re-send ledger.all().
 *
 * bridge.ts has top-level side effects and isn't unit-importable, so here we
 * (a) unit-test the ledger primitive directly and (b) drive a faithful
 * re-implementation of the three wiring points against a fake IPC to prove the
 * buffer / re-send / delete behaviours. The source wiring itself is pinned in
 * permission-rearm-wiring.test.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  createOutstandingPermissionLedger,
  type OutstandingPermissionParams,
} from '../bridge/permission-ledger.js'

function params(requestId: string, tool = 'mcp__brevo__post'): OutstandingPermissionParams {
  return {
    request_id: requestId,
    tool_name: tool,
    description: `${tool} description`,
    input_preview: '{"foo":"bar"}',
  }
}

describe('createOutstandingPermissionLedger', () => {
  it('starts empty', () => {
    const led = createOutstandingPermissionLedger()
    expect(led.size).toBe(0)
    expect(led.all()).toEqual([])
  })

  it('add + all + has', () => {
    const led = createOutstandingPermissionLedger()
    led.add(params('aaaaa'))
    led.add(params('bbbbb'))
    expect(led.size).toBe(2)
    expect(led.has('aaaaa')).toBe(true)
    expect(led.has('zzzzz')).toBe(false)
    expect(led.all().map(p => p.request_id)).toEqual(['aaaaa', 'bbbbb'])
  })

  it('add is idempotent on request_id (latest params win)', () => {
    const led = createOutstandingPermissionLedger()
    led.add(params('aaaaa', 'mcp__brevo__post'))
    led.add(params('aaaaa', 'mcp__brevo__patch'))
    expect(led.size).toBe(1)
    expect(led.all()[0].tool_name).toBe('mcp__brevo__patch')
  })

  it('delete removes the entry (verdict delivered)', () => {
    const led = createOutstandingPermissionLedger()
    led.add(params('aaaaa'))
    led.delete('aaaaa')
    expect(led.size).toBe(0)
    expect(led.has('aaaaa')).toBe(false)
  })

  it('delete of an unknown id is a no-op', () => {
    const led = createOutstandingPermissionLedger()
    led.add(params('aaaaa'))
    led.delete('nope')
    expect(led.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Faithful re-implementation of the three bridge wiring points. Mirrors
// bridge.ts exactly so the buffer / re-send / delete contract is exercised
// without importing the side-effecting module.
// ---------------------------------------------------------------------------

interface FakeIpc {
  connected: boolean
  sent: Array<{ requestId: string }>
}

function makeHarness(rearmEnabled = true) {
  const ledger = createOutstandingPermissionLedger()
  const ipc: FakeIpc = { connected: false, sent: [] }

  // Mirrors the permission_request notification handler.
  function onPermissionRequest(p: OutstandingPermissionParams): void {
    if (rearmEnabled) ledger.add(p)
    if (!ipc.connected) {
      // BUFFER (not drop) when re-arm enabled.
      return
    }
    ipc.sent.push({ requestId: p.request_id })
  }

  // Mirrors onPermission (verdict delivered).
  function onVerdict(requestId: string): void {
    ledger.delete(requestId)
  }

  // Mirrors flushOutstandingPermissionRequests on onConnect.
  function onConnect(): void {
    ipc.connected = true
    if (!rearmEnabled) return
    for (const p of ledger.all()) ipc.sent.push({ requestId: p.request_id })
  }

  function disconnect(): void {
    ipc.connected = false
  }

  return { ledger, ipc, onPermissionRequest, onVerdict, onConnect, disconnect }
}

describe('bridge permission-request wiring (buffer / re-send / delete)', () => {
  it('buffers when disconnected — no drop, request retained', () => {
    const h = makeHarness()
    h.onPermissionRequest(params('aaaaa'))
    // Nothing sent (gateway down) but the ledger retained it.
    expect(h.ipc.sent).toEqual([])
    expect(h.ledger.has('aaaaa')).toBe(true)
  })

  it('re-sends every outstanding request on (re)connect', () => {
    const h = makeHarness()
    h.onPermissionRequest(params('aaaaa'))
    h.onPermissionRequest(params('bbbbb'))
    expect(h.ipc.sent).toEqual([]) // still down

    h.onConnect() // gateway comes up
    expect(h.ipc.sent.map(s => s.requestId).sort()).toEqual(['aaaaa', 'bbbbb'])
  })

  it('re-sends again after a disconnect/reconnect cycle (gateway restart)', () => {
    const h = makeHarness()
    h.onConnect() // connected
    h.onPermissionRequest(params('aaaaa')) // sent live
    expect(h.ipc.sent.map(s => s.requestId)).toEqual(['aaaaa'])

    h.disconnect() // gateway restarts
    h.onConnect() // reconnect → re-send outstanding
    expect(h.ipc.sent.map(s => s.requestId)).toEqual(['aaaaa', 'aaaaa'])
  })

  it('a delivered verdict removes the entry — no re-send after resolution', () => {
    const h = makeHarness()
    h.onPermissionRequest(params('aaaaa'))
    h.onVerdict('aaaaa') // operator tapped, verdict delivered
    expect(h.ledger.has('aaaaa')).toBe(false)

    h.onConnect() // reconnect
    expect(h.ipc.sent).toEqual([]) // nothing re-sent
  })

  it('kill switch: disabled → drop-when-disconnected, no ledger, no re-send', () => {
    const h = makeHarness(false)
    h.onPermissionRequest(params('aaaaa')) // disconnected → dropped, not recorded
    expect(h.ledger.size).toBe(0)
    h.onConnect()
    expect(h.ipc.sent).toEqual([]) // nothing to re-send
  })
})
