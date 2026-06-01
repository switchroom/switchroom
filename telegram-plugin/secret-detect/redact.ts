/**
 * `redact(text)` — sanitize text by replacing detected secrets and
 * credential-bearing URL parts with `[REDACTED]` markers, in place.
 *
 * This is the shared mask-in-place chokepoint. Unlike the inbound
 * vault-staging flow (which DELETES the Telegram message and offers to
 * save the secret), `redact()` leaves the surrounding prose intact and
 * only masks the secret byte-ranges — the right behavior when we must
 * keep a record but never store/log/forward the raw value:
 *
 *   - INBOUND + OUTBOUND history persistence — `history.ts`
 *     `recordInbound` / `recordOutbound` redact before the row hits
 *     SQLite, so no detected secret survives in the message store in
 *     either direction (defense-in-depth behind the inbound gate, and
 *     the only redaction on the agent→user direction).
 *   - `switchroom issues record` — `src/issues/store.ts:capDetail`.
 *   - `switchroom secret-detect redact --stdin` — bash-callable shim.
 *   - hostd — `src/host-control/server.ts`.
 *
 * Detection is delegated to `detectSecrets()` (same patterns, same
 * suppressor, same engine as the inbound Telegram gate) so a pattern
 * added once — e.g. the Laravel/Coolify Sanctum `<id>|<token>` shape —
 * covers detection, inbound interception, and this redactor uniformly.
 *
 * Idempotence: for token-shape detections the marker doesn't re-match.
 * For *structural* detectors (`cli_flag`, `json_secret_field`) a second
 * pass may rewrite the tag, but the bytes stay redacted. Rely on "no
 * detected secret bytes survive any number of passes", not on strict
 * `redact(redact(x)) === redact(x)`.
 */
import { detectSecrets, type Detection } from './index.js'
import { redactUrls } from './url-redact.js'

export const REDACTED_MARKER = '[REDACTED]'

/**
 * Synchronous, fast redactor. Vendored pattern engine only (no async
 * secretlint) so it is safe on hot paths (every stored message).
 *
 * Order matters:
 *   1. URL credentials (`https://u:p@host` → `https://***@host`,
 *      sensitive query params → `?key=***`).
 *   2. Token-shape detection over the URL-normalized text; matched byte
 *      ranges are replaced right-to-left so earlier offsets stay valid.
 */
export function redact(text: string): string {
  if (!text || text.length === 0) return text

  // Step 1 — URL credentials and known-sensitive query params.
  const urlScrubbed = redactUrls(text)

  // Step 2 — token shape detection over the URL-scrubbed text.
  // EXCLUDE the generic high-entropy fallback: it is a low-precision
  // "looks like a secret" signal (it flags dense technical identifiers —
  // CamelCase class names, snake_case symbols, npm paths, slugs — as well
  // as real tokens). It exists to drive the inbound "stash to vault or
  // ignore?" ASK prompt, NOT to silently mask. Letting it into redact()
  // would corrupt agent replies (the outbound mask) and stored messages.
  // Only prefix/structured (high) + the contextual kv_entropy hits mask.
  const hits: Detection[] = detectSecrets(urlScrubbed).filter(
    (h) => h.rule_id !== 'generic_high_entropy',
  )
  if (hits.length === 0) return urlScrubbed

  // Apply replacements right-to-left so byte offsets stay valid.
  const sorted = [...hits].sort((a, b) => b.start - a.start)
  let out = urlScrubbed
  for (const h of sorted) {
    out = out.slice(0, h.start) + redactedMarker(h.rule_id) + out.slice(h.end)
  }
  return out
}

/**
 * `[REDACTED:<rule_id>]` when the rule_id is informative,
 * `[REDACTED]` otherwise. The rule_id is detector-emitted, so it never
 * contains attacker-controlled bytes — safe to embed verbatim.
 */
function redactedMarker(ruleId: string): string {
  const trimmed = ruleId.replace(/^(kv|env)_/, '')
  if (!trimmed || trimmed === 'key_value' || trimmed === 'kv_entropy') {
    return REDACTED_MARKER
  }
  return `[REDACTED:${trimmed}]`
}
