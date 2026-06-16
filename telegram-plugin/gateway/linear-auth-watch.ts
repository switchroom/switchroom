/**
 * Proactive Linear auth watch (FIX 3 — observability).
 *
 * Before this, Linear auth was only ever checked REACTIVELY: a refresh (and the
 * "🔑 Linear auth needs you" operator alert) happened only when an agent made a
 * live Linear call and got a 401. A linear-enabled agent that rarely calls
 * Linear could therefore sit dead-auth (missing bundle / revoked refresh /
 * silently-expired token) completely unnoticed until the moment it needed
 * Linear.
 *
 * This runs a small check on boot + on an interval (mirrors quota-watch):
 *   - bundle missing/invalid  → fire the operator alert (no_bundle) NOW.
 *   - bundle present + access token within the refresh skew → proactively
 *     rotate it (so the next real call never eats a 401), and surface a revoked
 *     refresh token via the operator alert.
 *   - bundle present + token fresh → nothing.
 *
 * Pure orchestration over injected deps so it is unit-testable without a broker
 * or the network. The gateway wires the broker-backed deps + notifyLinearAuthDead.
 */

import {
  parseBundle,
  needsRefresh,
  type PerformRefreshResult,
} from '../../src/linear/oauth-refresh.js'

export type LinearAuthWatchStatus =
  | 'disabled'
  | 'fresh'
  | 'no_bundle'
  | 'refreshed'
  | 'revoked'
  | 'refresh_failed'

export interface LinearAuthWatchDeps {
  agent: string
  /** Whether this agent has linear_agent enabled (reads config). */
  linearEnabled: () => boolean
  /** Read the raw JSON bundle from linear/<agent>/oauth (broker). */
  readBundle: () => Promise<string | null>
  /** Rotate the token via the stored bundle (performLinearRefresh over broker). */
  refresh: () => Promise<PerformRefreshResult>
  /** Operator alert (gateway's notifyLinearAuthDead). */
  onAuthDead: (info: { agent: string; reason: 'no_bundle' | 'revoked'; detail: string }) => void
  /** Epoch seconds (injectable for tests). */
  nowSec?: () => number
  log?: (line: string) => void
}

/**
 * One proactive check. Never throws — returns a status the caller can log.
 */
export async function runLinearAuthCheck(deps: LinearAuthWatchDeps): Promise<LinearAuthWatchStatus> {
  const log = deps.log ?? (() => {})
  if (!deps.linearEnabled()) return 'disabled'

  let raw: string | null
  try {
    raw = await deps.readBundle()
  } catch (err) {
    // A broker read failure is transient infra, not an auth problem — don't
    // page the operator, just log.
    log(`telegram gateway: linear-auth-watch agent=${deps.agent} bundle read error: ${(err as Error).message}\n`)
    return 'refresh_failed'
  }

  const bundle = parseBundle(raw)
  if (!bundle) {
    // The silent-setup-failure case: linear_agent is enabled but no refresh
    // bundle was ever stored. Surface it proactively.
    log(`telegram gateway: linear-auth-watch agent=${deps.agent} — no refresh bundle (proactive)\n`)
    deps.onAuthDead({ agent: deps.agent, reason: 'no_bundle', detail: 'proactive watch: linear/<agent>/oauth missing or invalid' })
    return 'no_bundle'
  }

  const now = deps.nowSec ? deps.nowSec() : Math.floor(Date.now() / 1000)
  if (!needsRefresh(bundle.expiresAt, now)) {
    // Fresh, or expiry-untracked (older bundle) — the reactive-on-401 path
    // covers untracked bundles; nothing to do proactively.
    return 'fresh'
  }

  // Within the refresh skew → rotate now so the next real call never 401s.
  const res = await deps.refresh()
  if (res.ok) {
    log(`telegram gateway: linear-auth-watch agent=${deps.agent} proactively refreshed (was near expiry)\n`)
    return 'refreshed'
  }
  if (res.reason === 'revoked') {
    log(`telegram gateway: linear-auth-watch agent=${deps.agent} refresh REVOKED (proactive)\n`)
    deps.onAuthDead({ agent: deps.agent, reason: 'revoked', detail: res.detail })
    return 'revoked'
  }
  if (res.reason === 'no_bundle') {
    deps.onAuthDead({ agent: deps.agent, reason: 'no_bundle', detail: res.detail })
    return 'no_bundle'
  }
  // Transient (network/http_error/bad_response/persist_failed) — log, don't page.
  log(`telegram gateway: linear-auth-watch agent=${deps.agent} proactive refresh failed reason=${res.reason}\n`)
  return 'refresh_failed'
}
