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
