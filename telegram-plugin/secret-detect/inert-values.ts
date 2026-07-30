/**
 * Inert VALUES — placeholders, variable references and already-masked
 * text that occupy a credential-shaped slot without being a credential.
 *
 * Masking one of these buys nothing and costs real information:
 *
 *   - `POSTGRES_PASSWORD: vault:pg/password` — the vault KEY NAME is
 *     precisely what an agent is supposed to remember. Redacting it
 *     deletes the pointer and keeps nothing.
 *   - `JWT_SECRET=<generate-with-openssl-rand>` — an instruction.
 *   - `const API_KEY = process.env.ANTHROPIC_API_KEY` — a reference.
 *
 * Before #3982's review this list existed only inside the new
 * `memorable_password` rule, so letter case decided the outcome:
 * `password: ${DB_PASSWORD}` survived while `PASSWORD: ${DB_PASSWORD}`
 * (matched by the ALL-CAPS `env_key_value` rule) was destroyed. Every
 * rule whose capture is a LABELLED slot now shares the list —
 * `env_key_value`, `json_secret_field`, `cli_flag` and
 * `memorable_password`.
 *
 * Mirrored in `vendor/hindsight-memory/scripts/lib/secret_redact.py`
 * (`_INERT_VALUE_RES` / `_INERT_GATED_RULES`) and pinned across both
 * engines by `secret_redaction_vectors.json`.
 */

export const INERT_VALUE_RE = [
  /^\[REDACTED/i, // our own marker (idempotence)
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/, // $PASSWORD, ${DB_PASSWORD}
  // `.` is spelled out: JS `.` and Python `.` exclude different line
  // terminators, and the two engines must agree byte for byte.
  /^\{\{[^\n\r\u2028\u2029]*\}\}$/, // {{ handlebars }}
  /^<[^>]*>$/, // <your-password-here>
  /^%[A-Za-z_][A-Za-z0-9_]*%$/, // %PASSWORD% (Windows)
  /^vault:/i, // switchroom vault reference
  /^[*x•.]+$/i, // ***, xxxx, ••••
  /^(?:process\.env|import\.meta\.env|os\.environ)\b/, // code reference
  // Well-known "fill this in" values. A live credential never begins
  // with the word telling you to replace it.
  /^(?:changeme|change-me|replaceme|replace-me|placeholder|todo|tbd|yourkey|your-key|yourpassword|your-password|yoursecret|your-secret|yourtoken|your-token)(?:[-_][A-Za-z0-9-]+)?$/i,
  // A lowercase English phrase — a help string or a JSON doc value such
  // as `{"token": "the bearer token to use"}`, never a credential.
  /^[a-z]+(?: [a-z]+){2,}$/,
]

/** True when `value` is a placeholder / reference rather than a secret. */
export function isInertValue(value: string): boolean {
  return INERT_VALUE_RE.some((re) => re.test(value))
}

/**
 * Rule ids whose captured value is a labelled slot, and which therefore
 * honour `isInertValue`. Keep in sync with `_INERT_GATED_RULES` in
 * `secret_redact.py`.
 */
export const INERT_GATED_RULES = new Set([
  'env_key_value',
  'json_secret_field',
  'cli_flag',
])

/**
 * The heuristic KEY=VALUE scanner honours the same list — it is the rule
 * that ate `ANTHROPIC_API_KEY: vault:anthropic/api_key` and
 * `const API_KEY = process.env.ANTHROPIC_API_KEY`. Kept as its own
 * export because `scanKeyValue` applies it directly rather than through
 * the `ALL_PATTERNS` loop.
 */
export const KV_ENTROPY_RULE_ID = 'kv_entropy'

/**
 * Trailing punctuation an English sentence puts AFTER a value. The value
 * character classes are `[^\s"']`-shaped, so a sentence-final `.` or a
 * list comma is swallowed INTO the value — and a `.` alone supplies a
 * second character class, which is what made
 * "The password is required." redact as a credential (#3982 review,
 * BLOCKER 2).
 */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/

export function stripTrailingPunctuation(value: string): string {
  return value.replace(TRAILING_PUNCT_RE, '')
}
