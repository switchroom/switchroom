/**
 * connection-drop.ts — the ONE canonical "was this a mid-stream connection /
 * SSE drop?" wording matcher.
 *
 * THE PROBLEM this closes
 * -----------------------
 * Two independent classifiers historically disagreed about what a mid-stream
 * "connection lost" / SSE-drop is, and they are consulted on different code
 * paths:
 *
 *   - Path A — `parseLlmError` (llm-error-present.ts) → `detectModelUnavailable`
 *     (model-unavailable.ts): a network-drop wording maps to
 *     `{kind:'transient', source:'network'}`.
 *   - Path B — the sub-agent transcript path → `detectErrorInTranscriptLine`
 *     (session-tail.ts) → `classifyClaudeError` (operator-events.ts): a
 *     connection-drop-worded line that is NOT the exact `server_error` /
 *     `api_error` type falls through to `unknown-5xx`/`unknown-4xx` (a generic
 *     terminal), because that path never consulted the network-drop wording
 *     list.
 *
 * So the SAME dropped-stream line was a "transient network" event on one path
 * and a "generic terminal" event on the other. This module gives both paths a
 * single predicate to consult so a connection-drop is identifiable as such on
 * BOTH.
 *
 * SCOPE: this is a WORDING matcher only. It answers "does this text look like a
 * transport connection drop?" — it deliberately does NOT decide the final
 * error kind. Callers gate the raw predicate on their own classification (only
 * flagging a drop on the transient/unknown/transport families, never on a
 * positively-identified auth/quota/credit wall) so a wrapped auth/quota error
 * whose OUTER text happens to say "fetch failed" is never mislabelled a drop.
 *
 * Pure module: no IPC, no bot, no FS. Trivially unit-testable.
 */

/**
 * Canonical connection-drop / SSE-drop wordings (lowercase substrings, matched
 * case-insensitively). Provenance for each entry is in the PR description; the
 * list is deliberately CONSERVATIVE — it covers transport-layer connection
 * drops only and must NOT match auth / quota / overload / provider-credit
 * wording (verified by the negative tests). Bare `stream` / `terminated` are
 * intentionally EXCLUDED: `upstream`/`downstream` contain `stream`, and
 * `terminated` appears in unrelated contexts — both would over-match and risk a
 * false auto-resume in the later PRs that gate on this predicate.
 *
 * DNS-resolution failures (`enotfound`, `eai_again`, `getaddrinfo`, "request
 * timed out") are also excluded: a name-resolution failure is a network fault
 * but NOT a connection drop (no connection was ever established). Path A still
 * classifies those as its broader `network` kind, unchanged — they simply do
 * not set the connection-drop discriminator.
 */
export const CONNECTION_DROP_SIGNALS: readonly string[] = [
  // ── Node/undici transport error codes (worded + code forms) ──────────────
  'socket hang up', // model-unavailable.ts networkSignals; mcp-credential-failure.ts
  'econnreset', // model-unavailable.ts networkSignals; retry-api-call.ts; ubiquitous fixtures
  'econnrefused', // model-unavailable.ts networkSignals
  'etimedout', // model-unavailable.ts networkSignals; retry-api-call.ts
  'epipe', // broken pipe on a half-dead socket (tests: pending-card-expiry, boot-sweep-gate)
  'fetch failed', // model-unavailable.ts networkSignals; retry-api-call.ts
  'network error', // model-unavailable.ts networkSignals
  // ── Worded connection-lost forms ─────────────────────────────────────────
  'connection refused', // model-unavailable.ts networkSignals
  'connection reset', // worded ECONNRESET (retry-api-call.ts comment)
  'connection closed', // model-unavailable.ts networkSignals; canonical "Connection closed mid-response"
  'connection lost', // plausible SSE-drop wording (precise phrase, no over-match risk)
  // ── Mid-response / SSE-drop markers ──────────────────────────────────────
  'mid-response', // model-unavailable.ts networkSignals; "Connection closed mid-response"
  'premature close', // Node/undici stream "Premature close" — a response body that ended early
  'stream disconnected', // plausible SSE-drop wording (precise two-word phrase)
  'stream closed', // plausible SSE-drop wording (precise two-word phrase)
]

/**
 * True when `text` carries a canonical connection-drop / SSE-drop wording.
 *
 * WORDING ONLY — see the module header. Never throws; a non-string collapses to
 * `false`.
 */
export function isConnectionDropText(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  const lower = text.toLowerCase()
  return CONNECTION_DROP_SIGNALS.some(s => lower.includes(s))
}
