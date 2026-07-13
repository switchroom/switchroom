/**
 * raw-error-scrub.ts — the ONE scrubber that removes raw-API-error bytes from a
 * string before it reaches a user, shared by every surface that might print an
 * error `detail`.
 *
 * Zero dependencies (a leaf module) so both the pure `operator-events.ts`
 * renderer AND `llm-error-present.ts` can import it without a cycle. Anchored on
 * the same markers as `looksLikeRawApiError` (pty-partial-handler.ts): the CLI's
 * Python `· b'{…}'` byte-blob, a trailing `{"type":"error"…}` JSON object, and an
 * `API Error:` prefix.
 */

/**
 * Strip the raw-API-error bytes a source can smuggle into an otherwise-human
 * string. Total — never throws; a clean human string passes through unchanged
 * (modulo whitespace tidy-up).
 */
export function stripRawErrorBytes(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  let s = raw
  // 1. `API Error:` / `API Error 429:` prefix anywhere.
  s = s.replace(/API Error:?\s*\d*\s*/gi, ' ')
  // 2. Python byte-blob render: ` b'{…}'` or ` b"{…}"` (the CLI's raw-body echo).
  s = s.replace(/\bb'[^']*'/g, ' ')
  s = s.replace(/\bb"[^"]*"/g, ' ')
  // 3. A JSON error object `{"type":"error"…}` (or `'type': 'error'`) and
  //    everything after it — these blobs are always trailing on the real lines,
  //    and brace-balanced stripping is not worth the fragility.
  s = s.replace(/[·\-\s]*\{[\s\S]*?["']type["']\s*:\s*["']error["'][\s\S]*$/i, ' ')
  // 4. A bare leading/trailing JSON object with no human text around it.
  s = s.replace(/^\s*\{[\s\S]*\}\s*$/g, ' ')
  // 5. Tidy: collapse whitespace, drop dangling separators.
  s = s.replace(/\s+/g, ' ').replace(/[·:\-\s]+$/g, '').replace(/^[·:\-\s]+/g, '').trim()
  return s
}

/**
 * Pull an Anthropic `request_id` out of a raw error string, or undefined. The
 * id lives in the trailing byte-blob (`…,"request_id":"req_abc"}'`) and can sit
 * far into a long body — see `truncateDetailPreservingRequestId`. Total.
 */
export function extractRequestId(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const m =
    raw.match(/["']request[_-]?id["']\s*:\s*["']([A-Za-z0-9._-]+)["']/i) ??
    raw.match(/\brequest[_-]?id[=:]\s*([A-Za-z0-9._-]+)/i)
  return m ? m[1] : undefined
}

/**
 * Truncate an error `detail` to `max` chars WITHOUT losing the `request_id`.
 *
 * Why this exists: the bridge forwards operator-event detail truncated to 1000
 * chars (OPERATOR_EVENT_DETAIL_MAX), but the Anthropic `request_id` lives in the
 * trailing byte-blob, which can sit PAST char 1000. A naive `slice(0, 1000)`
 * drops it, so the cross-surface dedup gate silently degrades from the reliable
 * `rid:` EXACT key to the coarse `${kind}:${agent}:${bucket}` key — collapsing
 * two genuinely-distinct same-kind errors within 60s into one card.
 *
 * Fix: extract the id from the FULL body first; if the plain head would drop it,
 * append `request_id=<id>` in the freed tail budget (`extractRequestId` matches
 * that form), keeping the result ≤ `max`. Total — never throws.
 */
export function truncateDetailPreservingRequestId(detail: string, max: number): string {
  if (typeof detail !== 'string') return ''
  if (detail.length <= max) return detail
  const rid = extractRequestId(detail)
  const head = detail.slice(0, max)
  if (rid == null || head.includes(rid)) return head
  const suffix = ` request_id=${rid}`
  const headBudget = Math.max(0, max - suffix.length)
  return `${detail.slice(0, headBudget)}${suffix}`
}
