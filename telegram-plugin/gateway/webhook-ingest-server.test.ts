/**
 * Tests for the peercred-gated webhook ingest UDS server
 * (RFC reference/rfcs/webhook-via-gateway-socket.md).
 *
 * MUST run under `bun test`: the peer-credential gate calls
 * `getPeerCred` (bun:ffi getsockopt SO_PEERCRED), which returns null
 * under node/vitest — so the allow path is only exercisable under bun.
 * This file is excluded from the vitest run (see vitest.config.ts) and
 * listed in the `test:bun` / `test` scripts in package.json.
 *
 * Sockets live in an isolated tmpdir — never `~/.switchroom`.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startWebhookIngestServer,
  type WebhookIngestServer,
  type WebhookIngestRequest,
} from './webhook-ingest-server.js'
import { forwardToGateway } from '../../src/web/webhook-ingest-client.js'

const servers: WebhookIngestServer[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-ingest-srv-'))
  return join(dir, 'webhook.sock')
}

function sampleReq(): WebhookIngestRequest {
  return {
    agent: 'reggie',
    source: 'github',
    event_type: 'pull_request',
    ts: 1_700_000_000_000,
    rendered_text: 'PR opened',
    payload: { action: 'opened', number: 7 },
    delivery_id: 'd-7',
  }
}

describe('startWebhookIngestServer (peercred-gated)', () => {
  it('accepts a connection from an allowed uid and round-trips onRecord', async () => {
    const socketPath = tmpSocket()
    let received: WebhookIngestRequest | null = null
    const server = startWebhookIngestServer({
      socketPath,
      allowedUids: [process.getuid!()], // our own uid → allowed
      onRecord: (req) => {
        received = req
        return { status: 'ok', ts: req.ts, dispatched: 1 }
      },
      log: () => {},
    })
    servers.push(server)

    const resp = await forwardToGateway(socketPath, sampleReq())

    expect(resp).not.toBeNull()
    expect(resp!.status).toBe('ok')
    expect(resp!.ts).toBe(1_700_000_000_000)
    expect(resp!.dispatched).toBe(1)
    expect(received).not.toBeNull()
    expect(received!.agent).toBe('reggie')
    expect(received!.event_type).toBe('pull_request')
    expect(received!.delivery_id).toBe('d-7')
  })

  it('denies a connection whose uid is not in allowedUids (onRecord never runs)', async () => {
    const socketPath = tmpSocket()
    let called = false
    const server = startWebhookIngestServer({
      socketPath,
      allowedUids: [999_999], // definitely not our uid
      onRecord: () => {
        called = true
        return { status: 'ok' }
      },
      log: () => {},
    })
    servers.push(server)

    // The server destroys the connection in its accept callback BEFORE
    // reading any bytes, so onRecord must never run. We assert the
    // security property (no service for an unlisted uid) directly rather
    // than via the client resolving: bun's net client does not observe a
    // server-side destroy of a just-accepted UDS connection promptly, so
    // awaiting forwardToGateway here would hang. Send raw bytes and give
    // the server ample time to (not) process them.
    const raw = net.createConnection(socketPath)
    raw.on('connect', () => raw.write(JSON.stringify(sampleReq()) + '\n'))
    raw.on('error', () => {})
    await new Promise((r) => setTimeout(r, 300))
    raw.destroy()

    expect(called).toBe(false)
  })

  it('returns null when the socket does not exist (gateway down)', async () => {
    const socketPath = tmpSocket() // never bound
    const resp = await forwardToGateway(socketPath, sampleReq(), { timeoutMs: 2000 })
    expect(resp).toBeNull()
  })

  it('surfaces a gateway-side error status from onRecord', async () => {
    const socketPath = tmpSocket()
    const server = startWebhookIngestServer({
      socketPath,
      allowedUids: [process.getuid!()],
      onRecord: () => ({ status: 'error', error: 'write failed' }),
      log: () => {},
    })
    servers.push(server)

    const resp = await forwardToGateway(socketPath, sampleReq())
    expect(resp).not.toBeNull()
    expect(resp!.status).toBe('error')
  })
})
