/**
 * Webhook ingest client (RFC reference/rfcs/webhook-via-gateway-socket.md).
 *
 * Host-side counterpart to `telegram-plugin/gateway/webhook-ingest-server.ts`.
 * After the receiver verifies (HMAC/Bearer) and renders an event, it forwards
 * the rendered record to the agent's in-container gateway over the per-agent
 * `webhook.sock`. The gateway (running as the agent UID) owns the agent-dir
 * writes + dispatch; the receiver stays stateless.
 *
 * Returns null on any transport failure (socket missing, connect refused,
 * timeout) so the caller can map "gateway unreachable" to a 503 distinct
 * from a gateway-side 'error' (500).
 */

import net from 'node:net'

export interface WebhookForwardRequest {
  agent: string
  source: string
  event_type: string
  ts: number
  rendered_text: string
  payload: Record<string, unknown>
  delivery_id?: string
}

export interface WebhookForwardResponse {
  status: 'ok' | 'deduped' | 'error'
  ts?: number
  error?: string
  dispatched?: number
}

export interface ForwardOptions {
  /** Connect + round-trip timeout. Default 5s. */
  timeoutMs?: number
}

/**
 * Forward one verified event to the agent's gateway webhook socket.
 * Resolves to the gateway's response, or null when the gateway is
 * unreachable (socket absent / ECONNREFUSED / timeout).
 */
export function forwardToGateway(
  socketPath: string,
  req: WebhookForwardRequest,
  opts: ForwardOptions = {},
): Promise<WebhookForwardResponse | null> {
  const timeoutMs = opts.timeoutMs ?? 5_000

  return new Promise((resolve) => {
    let settled = false
    let buf = ''

    const done = (value: WebhookForwardResponse | null) => {
      if (settled) return
      settled = true
      try {
        conn.destroy()
      } catch {
        /* ignore */
      }
      resolve(value)
    }

    const conn = net.createConnection(socketPath)
    conn.setEncoding('utf8')
    conn.setTimeout(timeoutMs)

    conn.on('connect', () => {
      conn.write(JSON.stringify(req) + '\n')
    })

    conn.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl)
      try {
        done(JSON.parse(line) as WebhookForwardResponse)
      } catch {
        // Gateway sent something unparseable — treat as a gateway-side
        // error (not a transport failure), so the receiver returns 500.
        done({ status: 'error', error: 'unparseable gateway response' })
      }
    })

    conn.on('timeout', () => done(null))
    // ENOENT (socket missing), ECONNREFUSED (gateway not listening), etc.
    conn.on('error', () => done(null))
    conn.on('close', () => {
      // Connection closed before a full response line — transport failure.
      done(null)
    })
  })
}
