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
  // Our own marker (idempotence). `maskToken` only ever emits
  // `[REDACTED]` or `[REDACTED:<rule_id>]`, so the closing bracket is
  // part of the shape.
  /^\[REDACTED(?::[A-Za-z0-9_]+)?\]$/i,
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/, // $PASSWORD, ${DB_PASSWORD}
  // `.` is spelled out: JS `.` and Python `.` exclude different line
  // terminators, and the two engines must agree byte for byte.
  /^\{\{[^\n\r\u2028\u2029]*\}\}$/, // {{ handlebars }}
  /^<[^<>\n\r\u2028\u2029]*>$/, // <your-password-here>
  /^%[A-Za-z_][A-Za-z0-9_]*%$/, // %PASSWORD% (Windows)
  /^vault:[A-Za-z0-9_./-]*$/i, // switchroom vault reference
  /^[*x•.]+$/i, // ***, xxxx, ••••
  // Code reference — `process.env.FOO`, `import.meta.env.VITE_X`,
  // `os.environ["FOO"]`. The member path is PART OF THE SHAPE: a bare
  // prefix followed by anything else is not a reference.
  /^(?:process\.env|import\.meta\.env|os\.environ)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[["']?[A-Za-z_$][A-Za-z0-9_$]*["']?\])*$/,
  // Well-known "fill this in" values. A live credential never begins
  // with the word telling you to replace it.
  /^(?:changeme|change-me|replaceme|replace-me|placeholder|todo|tbd|yourkey|your-key|yourpassword|your-password|yoursecret|your-secret|yourtoken|your-token)(?:[-_][A-Za-z0-9-]+)?$/i,
  // A lowercase English phrase — a help string or a JSON doc value such
  // as `{"token": "the bearer token to use"}`, never a credential.
  /^[a-z]+(?: [a-z]+){2,}$/,
]

/**
 * An unbroken run of `[A-Za-z0-9]` long enough to BE a credential.
 *
 * Placeholder text is words joined by separators (`your-password-here`,
 * `generate-with-openssl-rand`, `pg/password`, `ANTHROPIC_API_KEY`) — the
 * longest alphanumeric run across every value this list protects is 10
 * (`production`). A credential is the opposite shape: one dense run.
 */
const CREDENTIAL_RUN_RE = /[A-Za-z0-9]{12,}/g

/**
 * Mixed-class floor — `ENV_KV_MIN_LEN`, the length below which the env
 * scanner already declines to call something a secret. Must not exceed
 * `CREDENTIAL_RUN_RE`'s own floor.
 */
const MIXED_CLASS_RUN_MIN = 12

/**
 * Single-class floor. A run of only letters or only digits is far more
 * likely to be an English word than a credential (`authentication`,
 * `configuration`), so it gets more rope — but not unlimited rope:
 * `abcdefghijklmnop` and a 40-`x` filler are values `main` masked, and no
 * word in the protected corpus reaches 16.
 */
const SINGLE_CLASS_RUN_MIN = 16

function runIsCredentialShaped(run: string): boolean {
  // Classes present among {lower, upper, digit}. Hex, base62 and
  // CamelCase-with-digits tokens are two or three; `yourtokenhere` and
  // the segments of `YOUR_TOKEN_HERE` are one.
  let classes = 0
  if (/[a-z]/.test(run)) classes++
  if (/[A-Z]/.test(run)) classes++
  if (/[0-9]/.test(run)) classes++
  return (
    run.length >= (classes >= 2 ? MIXED_CLASS_RUN_MIN : SINGLE_CLASS_RUN_MIN)
  )
}

/**
 * True when `value` carries a credential-shaped run anywhere inside it.
 *
 * #3982 review, MAJOR 7. The inert SHAPES above are necessary but not
 * sufficient: `<a8f3…40 hex…>` and `{{tok_…}}` are legal instances of the
 * `<…>` / `{{…}}` shapes, and a wrapper left behind after someone filled
 * the value in (`vault:pg/password<secret>`, `[REDACTED]<secret>`,
 * `changeme-<secret>`) turned a false-positive fix into a bypass of
 * already-shipped coverage. "Inert shape AND carries no credential" is
 * the property actually wanted; end-anchoring alone is not enough,
 * because `<secret>` is a well-formed instance of the shape.
 */
export function hasCredentialShapedRun(value: string): boolean {
  for (const run of value.match(CREDENTIAL_RUN_RE) ?? []) {
    if (runIsCredentialShaped(run)) return true
  }
  return false
}

/** True when `value` is a placeholder / reference rather than a secret. */
export function isInertValue(value: string): boolean {
  if (!INERT_VALUE_RE.some((re) => re.test(value))) return false
  return !hasCredentialShapedRun(value)
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
