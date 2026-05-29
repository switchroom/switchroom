/**
 * Webhook ingest UDS server (RFC docs/rfcs/webhook-via-gateway-socket.md).
 *
 * A dedicated, peercred-gated Unix socket the host-side web receiver
 * forwards verified webhook events to. It is deliberately SEPARATE from
 * the bridge IPC socket (`gateway.sock`):
 *
 *   - `gateway.sock` is bound via `Bun.listen`, whose accepted socket does
 *     NOT expose a file descriptor — so SO_PEERCRED can't be read on it.
 *     This server uses `node:net` (whose `Socket._handle.fd` IS readable
 *     under Bun, verified empirically) precisely so the peer-credential
 *     gate works.
 *   - Keeping the chat-critical bridge socket untouched avoids any risk to
 *     the bridge-flap-sensitive reconnect path.
 *
 * Auth model — two independent layers:
 *   1. **Filesystem**: the socket is chmod 0o666 so the host operator UID
 *      can connect at all (the agent dir itself is 0775/agent-UID, which
 *      blocks the operator from writing files but not from connecting a
 *      world-connectable socket).
 *   2. **Peer credentials**: every connection's SO_PEERCRED UID must be in
 *      `allowedUids` (the agent's own UID + the operator/receiver UID).
 *      This is the load-bearing gate: it ensures only the trusted receiver
 *      (which enforces per-event HMAC) — or the agent itself — can inject a
 *      webhook turn. Fail-closed: unreadable creds or an unlisted UID is
 *      denied.
 *
 * Wire protocol: one JSON line in (`WebhookIngestRequest`), one JSON line
 * out (`WebhookIngestResponse`), then the connection closes. No framing
 * beyond the trailing newline; requests are small (a rendered event +
 * payload).
 */

import net from 'node:net'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { getPeerCred } from '../../src/vault/broker/peercred-ffi.js'

/** Forwarded by the receiver; structural mirror of WebhookGatewayRecord. */
export interface WebhookIngestRequest {
  agent: string
  source: string
  event_type: string
  ts: number
  rendered_text: string
  payload: Record<string, unknown>
  delivery_id?: string
}

export interface WebhookIngestResponse {
  status: 'ok' | 'deduped' | 'error'
  ts?: number
  error?: string
  dispatched?: number
}

export interface WebhookIngestServerOptions {
  socketPath: string
  /** SO_PEERCRED UIDs permitted to inject. Connections from any other UID
   *  (or with unreadable creds) are denied and the socket destroyed. */
  allowedUids: number[]
  /** Handle one verified, forwarded event. Synchronous return (the record
   *  path is file I/O + an in-process inject) wrapped in Promise for the
   *  server's await. */
  onRecord: (req: WebhookIngestRequest) => WebhookIngestResponse | Promise<WebhookIngestResponse>
  log?: (line: string) => void
}

export interface WebhookIngestServer {
  close: () => void
}

const MAX_REQUEST_BYTES = 1024 * 1024 // 1 MiB — github payloads fit easily

/** Read the accepted connection's fd via the undocumented `_handle.fd`.
 *  Under Bun's node:net polyfill this is present (verified); returns null
 *  if absent so the caller fails closed. */
function fdOf(conn: net.Socket): number | null {
  const handle = (conn as unknown as { _handle?: { fd?: number } })._handle
  if (!handle || typeof handle.fd !== 'number' || handle.fd < 0) return null
  return handle.fd
}

/**
 * Start the webhook ingest server. Never throws — bind failures are logged
 * and surfaced via the returned server still being usable as a no-op close.
 * The CALLER (gateway boot) additionally wraps this so a failure here can
 * never take the agent down; this function's own try/catch is belt-and-
 * suspenders.
 */
export function startWebhookIngestServer(
  opts: WebhookIngestServerOptions,
): WebhookIngestServer {
  const log = opts.log ?? ((s) => process.stderr.write(s))
  const allowed = new Set(opts.allowedUids)

  // Clear a stale socket from a previous (crashed) gateway. Safe: only this
  // agent's gateway binds this path, and we're about to rebind it.
  try {
    if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath)
  } catch (err) {
    log(`webhook-ingest-server: could not unlink stale socket: ${(err as Error).message}\n`)
  }

  const server = net.createServer((conn) => {
    // ── Peer-credential gate (fail-closed) ──────────────────────────────────
    const fd = fdOf(conn)
    const cred = fd !== null ? getPeerCred(fd) : null
    if (cred === null || !allowed.has(cred.uid)) {
      log(
        `webhook-ingest-server: DENY connection uid=${cred?.uid ?? 'unknown'} ` +
          `(allowed=${[...allowed].join(',')})\n`,
      )
      conn.destroy()
      return
    }

    let buf = ''
    let handled = false
    conn.setEncoding('utf8')

    const reply = (resp: WebhookIngestResponse) => {
      if (handled) return
      handled = true
      try {
        conn.write(JSON.stringify(resp) + '\n')
      } catch {
        /* peer may have hung up */
      }
      conn.end()
    }

    conn.on('data', (chunk: string) => {
      if (handled) return
      buf += chunk
      if (buf.length > MAX_REQUEST_BYTES) {
        reply({ status: 'error', error: 'request too large' })
        return
      }
      const nl = buf.indexOf('\n')
      if (nl === -1) return // wait for the full line
      const line = buf.slice(0, nl)

      let req: WebhookIngestRequest
      try {
        req = JSON.parse(line) as WebhookIngestRequest
      } catch {
        reply({ status: 'error', error: 'malformed request' })
        return
      }
      if (
        !req ||
        typeof req.agent !== 'string' ||
        typeof req.source !== 'string' ||
        typeof req.event_type !== 'string' ||
        typeof req.rendered_text !== 'string' ||
        typeof req.payload !== 'object' ||
        req.payload === null
      ) {
        reply({ status: 'error', error: 'invalid request shape' })
        return
      }

      Promise.resolve()
        .then(() => opts.onRecord(req))
        .then((resp) => reply(resp))
        .catch((err: unknown) => {
          log(`webhook-ingest-server: onRecord threw: ${String(err)}\n`)
          reply({ status: 'error', error: 'internal error' })
        })
    })

    conn.on('error', (err) => {
      log(`webhook-ingest-server: conn error: ${err.message}\n`)
    })

    // Drop slow/idle clients so a stuck connection can't pin the socket.
    conn.setTimeout(10_000, () => {
      if (!handled) reply({ status: 'error', error: 'timeout' })
      conn.destroy()
    })
  })

  server.on('error', (err) => {
    log(`webhook-ingest-server: server error: ${err.message}\n`)
  })

  try {
    server.listen(opts.socketPath, () => {
      try {
        // World-connectable at the FS layer; peercred is the real gate.
        chmodSync(opts.socketPath, 0o666)
      } catch (err) {
        log(`webhook-ingest-server: chmod failed: ${(err as Error).message}\n`)
      }
      log(
        `webhook-ingest-server: listening at ${opts.socketPath} ` +
          `(allowed uids: ${[...allowed].join(',')})\n`,
      )
    })
  } catch (err) {
    log(`webhook-ingest-server: listen failed: ${(err as Error).message}\n`)
  }

  return {
    close: () => {
      try {
        server.close()
      } catch {
        /* ignore */
      }
      try {
        if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath)
      } catch {
        /* ignore */
      }
    },
  }
}
