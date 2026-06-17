/**
 * Cloudflare-only edge lock for the webhook ingest path (Phase 2 of the
 * Docker-native webhook work — see reference/rfcs/webhook-via-gateway-socket.md
 * and reference/rfcs/webhook-cloudflare-edge-lock.md).
 *
 * The receiver is reachable only behind Cloudflare (`hooks.switchroom.ai`
 * → cloudflared tunnel → localhost:8080). A Cloudflare Transform Rule
 * injects a shared secret as the `X-Switchroom-Edge` header on every
 * request that transits the edge. Requests that did NOT come through
 * Cloudflare (e.g. someone who learned the tunnel origin, or a SSRF from
 * a co-located service) won't carry the header and are rejected 403.
 *
 * This stacks on the existing defences (GitHub-IP WAF allowlist at the
 * edge + per-agent HMAC) — it is not a replacement for either. Its job is
 * to prove "this request entered through our Cloudflare edge", which the
 * HMAC alone cannot (HMAC proves the body came from a secret-holder, not
 * the network path).
 *
 * Fail-closed: when an agent opts in (`webhook_require_edge: true`) but the
 * secret file is missing/unreadable, EVERY request is rejected 403. A
 * misconfigured lock must never silently fall open.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { timingSafeEqual } from 'crypto'

/** Header the Cloudflare Transform Rule injects. Lower-cased for the
 *  Headers.get() lookup (HTTP header names are case-insensitive). */
export const EDGE_HEADER = 'x-switchroom-edge'

/**
 * Operator-managed secret file. Single value (the shared secret), no
 * structure. Mode 0600. Matches the Cloudflare Transform Rule's injected
 * value. Endpoint-global — one secret guards the whole receiver, not
 * per-agent (the per-agent grain is HMAC; this is the network-path proof).
 */
export function edgeSecretPath(): string {
  return join(homedir(), '.switchroom', 'webhook-edge-secret')
}

/**
 * Load the edge secret. Returns null when the file is missing or empty
 * (callers fail-closed on null when the lock is required). Trailing
 * whitespace/newlines are trimmed so an `echo > file` write matches a
 * header value that carries none.
 */
export function loadEdgeSecret(path?: string): string | null {
  const p = path ?? edgeSecretPath()
  try {
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf-8').trim()
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

/**
 * Constant-time compare of the presented header value against the
 * expected secret. Returns false (never throws) on any mismatch,
 * including a null/absent header or a null secret — the fail-closed
 * contract lives at the call site, this just answers "do they match".
 */
export function verifyEdgeHeader(
  headerValue: string | null | undefined,
  expectedSecret: string | null,
): boolean {
  if (!headerValue || !expectedSecret) return false
  const a = Buffer.from(headerValue, 'utf8')
  const b = Buffer.from(expectedSecret, 'utf8')
  if (a.length !== b.length) {
    // Compare against self to keep timing independent of length.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
