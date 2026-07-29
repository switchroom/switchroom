/**
 * Heuristic KEY=VALUE scanner. Fallback when the structured patterns miss —
 * e.g. lowercase env var names like `my_password=...` that the all-caps
 * `env_key_value` pattern skips.
 *
 * Flow:
 *   1. Regex-scan for `(password|token|secret|key|api_key)\s*[:=]\s*...`
 *   2. Extract the RHS value
 *   3. Gate on Shannon entropy ≥ 4.0 to cut obvious placeholders like
 *      `password=foo` or `key=changeme`.
 *
 * Returns `RawHit` entries pointing at the VALUE bytes (not the whole
 * `key=value` match), so the rewriter can preserve the `key=` prefix.
 */
import { shannonEntropy } from './entropy.js'

export interface RawHit {
  rule_id: string
  start: number
  end: number
  matched_text: string
  /** The identifier on the left of `=` or `:`, if any. Used for slug derivation. */
  key_name?: string
  /** Confidence tier — high = anchored pattern, ambiguous = entropy-only. */
  confidence: 'high' | 'ambiguous'
}

// Lower-case / mixed-case KEY=VALUE. Uppercase-only is handled by the
// structured `env_key_value` pattern for higher confidence.
const KV_RE = /\b([A-Za-z_][A-Za-z0-9_-]*(?:password|passwd|token|secret|key|api[_-]?key))\s*[:=]\s*["']?([^\s"'\\]{8,})["']?/gi

export const KV_ENTROPY_THRESHOLD = 4.0

// ─── Human-memorable passwords ────────────────────────────────────────
//
// Gap closed (2026-07 hindsight write-path audit): a password a human can
// remember — family names + a year, a two-word phrase with a digit — has
// Shannon entropy well under KV_ENTROPY_THRESHOLD, so `scanKeyValue` above
// skips it and it was stored in agent memory verbatim.
//
// Lowering KV_ENTROPY_THRESHOLD is NOT the fix: that threshold guards a
// wide LHS set (`key`, `token`, `secret`, `api_key`, and any identifier
// ending in them), where dropping the entropy floor would mask ordinary
// prose and config chatter wholesale.
//
// Instead this is a SEPARATE, much narrower rule:
//
//   * the LHS must be the password family specifically — `password`,
//     `passwd`, `passphrase`, `pwd` (optionally prefixed, e.g.
//     `db_password`). Not `key`/`token`/`secret`.
//   * the connector is `:`/`=` or the literal word `is` (so "the wifi
//     password is <value>" is covered, which is how a human actually
//     writes one down).
//   * the value must LOOK like a chosen credential rather than a word:
//     8..64 bytes, no whitespace, and at least two distinct character
//     classes of {lower, upper, digit, symbol}.
//
// The two-class gate is what keeps ordinary prose out. English words that
// follow "password is" in real sentences — "required", "rotated",
// "incorrect", "different", "unchanged", "protected" — are single-class
// lowercase and never match, while `FluffyBarnaby1998` (lower+upper+digit)
// does. The deliberate trade: a single-class credential such as an
// all-lowercase passphrase still slips through. That is the conservative
// side of the line — over-redacting prose corrupts stored conversation and
// is unrecoverable, whereas this rule's misses are the pre-existing
// behaviour, not a regression.
const MEMORABLE_PW_RE =
  /\b([A-Za-z0-9_-]*(?:password|passwd|passphrase|pwd))\b\s*(?:[:=]\s*|\s+is\s+)(["']?)([^\s"']{8,64})\2/gi

export const MEMORABLE_PW_RULE_ID = 'memorable_password'

/** Minimum distinct character classes for a value to look chosen-by-a-human. */
export const MEMORABLE_PW_MIN_CLASSES = 2

/**
 * Values that are placeholders, variable references or already-masked
 * text. Redacting these buys nothing and destroys the meaning of the
 * surrounding config line.
 */
const INERT_PW_RE = [
  /^\[REDACTED/i, // our own marker (idempotence)
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/, // $PASSWORD, ${DB_PASSWORD}
  /^\{\{.*\}\}$/, // {{ handlebars }}
  /^<[^>]*>$/, // <your-password-here>
  /^%[A-Za-z_][A-Za-z0-9_]*%$/, // %PASSWORD% (Windows)
  /^vault:/i, // switchroom vault reference
  /^[*x•.]+$/i, // ***, xxxx, ••••
]

function charClassCount(value: string): number {
  let n = 0
  if (/[a-z]/.test(value)) n++
  if (/[A-Z]/.test(value)) n++
  if (/[0-9]/.test(value)) n++
  if (/[^A-Za-z0-9]/.test(value)) n++
  return n
}

/** True when `value` looks like a human-chosen password, not prose. */
export function looksLikeMemorablePassword(value: string): boolean {
  if (value.length < 8 || value.length > 64) return false
  if (INERT_PW_RE.some((re) => re.test(value))) return false
  // A single repeated character is a mask, not a password.
  if (new Set(value).size < 4) return false
  return charClassCount(value) >= MEMORABLE_PW_MIN_CLASSES
}

export function scanMemorablePasswords(text: string): RawHit[] {
  const hits: RawHit[] = []
  MEMORABLE_PW_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MEMORABLE_PW_RE.exec(text)) !== null) {
    const keyName = m[1]!
    const value = m[3]
    if (!value || !looksLikeMemorablePassword(value)) continue
    const valueOffsetInMatch = m[0].indexOf(value, keyName.length)
    if (valueOffsetInMatch < 0) continue
    const start = m.index + valueOffsetInMatch
    hits.push({
      rule_id: MEMORABLE_PW_RULE_ID,
      start,
      end: start + value.length,
      matched_text: value,
      key_name: keyName,
      confidence: 'ambiguous',
    })
  }
  return hits
}

export function scanKeyValue(text: string): RawHit[] {
  const hits: RawHit[] = []
  KV_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KV_RE.exec(text)) !== null) {
    const [, keyName, value] = m
    if (!value) continue
    // Shannon entropy gate — only flag values that actually look random.
    const h = shannonEntropy(value)
    if (h < KV_ENTROPY_THRESHOLD) continue
    // The value starts at match.index + the length of everything before
    // it in the match. Compute by finding the value inside the match.
    const valueOffsetInMatch = m[0].indexOf(value, keyName!.length)
    if (valueOffsetInMatch < 0) continue
    const start = m.index + valueOffsetInMatch
    const end = start + value.length
    hits.push({
      rule_id: 'kv_entropy',
      start,
      end,
      matched_text: value,
      key_name: keyName,
      confidence: 'ambiguous',
    })
  }
  return hits
}
