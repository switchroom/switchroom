/**
 * Live-socket dispatch test for the legacy `update_placeholder` IPC
 * (#553 hotfix).
 *
 * Uses bun:test (NOT vitest) because it exercises Bun.listen / Bun.connect
 * through the real createIpcServer.
 *
 * Pins three properties recall.py needs from the gateway:
 *
 *   1. The gateway does NOT close the connection when it receives a
 *      legacy `update_placeholder` line — anonymous one-shots are fine,
 *      but a force-close would change the timing semantics that
 *      `vendor/hindsight-memory/scripts/lib/gateway_ipc.py` relies on
 *      (it sends one line and closes the socket itself).
 *   2. The validator does NOT log "invalid IPC message shape" — that
 *      log line was firing on every recall hook before this fix.
 *   3. The dispatcher emits exactly one "legacy update_placeholder
 *      ignored" log line per connection (rate-limited to one), so the
 *      operator can correlate the no-op decision without log spam.
 *
 * Run with:
 *   cd <repo-root> && bun test telegram-plugin/tests/gateway-update-placeholder-dispatch.test.ts
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createIpcServer, type IpcServer } from '../gateway/ipc-server.js'
import type { ScheduleRestartMessage } from '../gateway/ipc-protocol.js'

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-update-ph-'))
  return join(dir, 'test.sock')
}

function wait(ms: number): Promise<void> {
  return Bun.sleep(ms)
}

const servers: IpcServer[] = []

afterEach(async () => {
  for (const s of servers) await s.close().catch(() => {})
  servers.length = 0
})

function makeServer(socketPath: string, log: (m: string) => void, onDisconnect: () => void): IpcServer {
  const server = createIpcServer({
    socketPath,
    onClientRegistered: () => {},
    onClientDisconnected: () => onDisconnect(),
    onToolCall: async () => ({ type: 'tool_call_result', id: 'x', success: true, result: null }),
    onSessionEvent: () => {},
    onPermissionRequest: () => {},
    onHeartbeat: () => {},
    onScheduleRestart: (_c, _m: ScheduleRestartMessage) => {},
    log,
  })
  servers.push(server)
  return server
}

describe('update_placeholder dispatch — live IpcServer (bun)', () => {
  it('logs once and keeps the connection open across multiple legacy lines', async () => {
    const socketPath = tmpSocket()
    const logs: string[] = []
    let disconnectFired = 0
    makeServer(socketPath, (m) => logs.push(m), () => { disconnectFired++ })

    // Open a raw socket — mimics recall.py's one-shot client.
    const sock = await Bun.connect({
      unix: socketPath,
      socket: {
        data: () => {},
        open: () => {},
        close: () => {},
        error: () => {},
      },
    })

    const line1 = JSON.stringify({ type: 'update_placeholder', chatId: '123', text: 'first' }) + '\n'
    const line2 = JSON.stringify({ type: 'update_placeholder', chatId: '123', text: 'second' }) + '\n'
    sock.write(line1)
    sock.write(line2)

    await wait(50)

    // Connection still open from the gateway's perspective.
    expect(disconnectFired).toBe(0)

    // Negative log assertions — the two lines this fix is meant to silence.
    expect(logs.some(l => l.includes('invalid IPC message shape'))).toBe(false)
    expect(logs.some(l => l.includes('unknown IPC message type'))).toBe(false)

    // Positive: exactly one "legacy ... ignored" log line (rate-limit per connection).
    const legacy = logs.filter(l => l.includes('legacy update_placeholder ignored'))
    expect(legacy.length).toBe(1)

    sock.end()
    await wait(50)
  })

  it('does not crash on a malformed legacy line (validator still rejects bad shapes)', async () => {
    const socketPath = tmpSocket()
    const logs: string[] = []
    makeServer(socketPath, (m) => logs.push(m), () => {})

    const sock = await Bun.connect({
      unix: socketPath,
      socket: { data: () => {}, open: () => {}, close: () => {}, error: () => {} },
    })

    // Missing chatId → validator must still reject (defence in depth).
    sock.write(JSON.stringify({ type: 'update_placeholder', text: 'x' }) + '\n')
    await wait(50)

    // The shape-rejection log SHOULD fire here — we only soft-accept the
    // well-formed shape, not arbitrary `update_placeholder` payloads.
    expect(logs.some(l => l.includes('invalid IPC message shape'))).toBe(true)

    sock.end()
    await wait(50)
  })
})
