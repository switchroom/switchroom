/**
 * Database / service connection-URI credential scanner.
 *
 * Gap closed (2026-07 hindsight write-path audit): a connection string
 * like `postgres://appuser:<password>@db.internal:5432/prod` passed the
 * whole detection stack untouched and was stored verbatim in agent
 * memory. `url-redact.ts` only rewrites `http(s)`/`ws(s)`/`ftp` (its
 * `URL_RE` is scheme-limited), and no pattern in `patterns.ts` describes
 * the `scheme://user:pass@host` shape, so a production database password
 * was invisible to every caller of `detectSecrets`.
 *
 * This scanner is deliberately SCHEME-AGNOSTIC — it matches any
 * `<scheme>://<user>:<password>@<host>` — so postgres, mysql, mongodb,
 * redis, amqp, clickhouse, mssql and whatever ships next are all covered
 * without a scheme allowlist to keep current. Precision comes from the
 * shape, not from the scheme list: userinfo-with-password in a URI is a
 * credential by construction.
 *
 * Only the PASSWORD bytes are reported. The username is left intact: it
 * is rarely the secret, and keeping it preserves the diagnostic value of
 * the stored line ("which account", not just "some database").
 *
 * Confidence is `ambiguous`, NOT `high`. `pipeline.ts` auto-writes every
 * high-confidence inbound hit to the vault and the caller DELETES the
 * user's Telegram message; promoting this rule to `high` would change
 * inbound gating as a side effect of a redaction fix. `redact()` masks
 * ambiguous hits, which is what this change is for.
 */
import type { RawHit } from './kv-scanner.js'

/**
 * `<scheme>://<user>:<password>@<host>`.
 *
 * - scheme: RFC 3986 shape, at least two chars so a Windows drive letter
 *   (`c://`) can't anchor a match.
 * - user: no `/`, `@`, `:` or whitespace.
 * - password: no `/`, `@` or whitespace — one or more bytes. `@` is
 *   excluded so the match stops at the FIRST `@`, and a password
 *   containing a literal `@` (which must be percent-encoded in a valid
 *   URI) cannot swallow the host.
 * - host: at least one non-delimiter byte, so `user:pass@` with nothing
 *   after it is not a connection string.
 */
const DB_URI_RE =
  /\b([a-zA-Z][a-zA-Z0-9+.-]+):\/\/([^\s:/@]+):([^\s/@]+)@([^\s/@]+)/g

export const DB_URI_RULE_ID = 'db_uri_password'

/** Values that are already masked or are obviously not a live credential. */
function isInertPassword(value: string): boolean {
  if (value.startsWith('[REDACTED')) return true
  // `redactUrls()` rewrites `user:pass@` to `***@` (empty password), but a
  // hand-written `***`/`xxx` mask should not round-trip into a detection
  // either.
  return /^[*x]+$/i.test(value)
}

export function scanDbUris(text: string): RawHit[] {
  const hits: RawHit[] = []
  DB_URI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DB_URI_RE.exec(text)) !== null) {
    const scheme = m[1]!
    const user = m[2]!
    const password = m[3]!
    if (isInertPassword(password)) continue
    // Offset of the password = match start + scheme + "://" + user + ":".
    const start = m.index + scheme.length + 3 + user.length + 1
    hits.push({
      rule_id: DB_URI_RULE_ID,
      start,
      end: start + password.length,
      matched_text: password,
      key_name: `${scheme}_password`,
      confidence: 'ambiguous',
    })
  }
  return hits
}
