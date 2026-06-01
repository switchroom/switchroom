/**
 * Generic bare-high-entropy detector — the long-tail fallback.
 *
 * The provider/anchored patterns only catch tokens with a known prefix
 * (sk-, ghp_, shpat_, …) or a KEY=value context. A STANDALONE high-entropy
 * token pasted in prose — a raw Sanctum/base62 token with no prefix —
 * matches none of them and used to slip through (the 2026-06-01 Sanctum
 * incident). This scanner closes that gap.
 *
 * Emitted at **`ambiguous`** confidence, and `redact()` deliberately
 * EXCLUDES this rule (see redact.ts): a generic guess must never silently
 * mask — it would corrupt agent replies and stored messages (dense
 * identifiers look high-entropy too). Its sole job is to drive the inbound
 * gate's "👀 looks like a high-entropy string — stash to vault or ignore?"
 * ASK prompt, where the operator confirms.
 *
 * Precision (the hard part — distinguishing a random token from a long
 * technical identifier), via three cheap, composable filters:
 *  1. CHARSET `[A-Za-z0-9]` only — NO `_` `-` `/` `+` `=` `.` `:`. This
 *     breaks snake_case / kebab-case / npm paths / slugs / version strings
 *     into sub-28 runs, so identifiers like `get_user_profile_by_org`,
 *     `flex-row-gap-4`, `@babel/plugin-transform-modules-commonjs` never
 *     form a candidate. (Cost: base64url tokens with `-`/`_` aren't caught
 *     here — they usually appear in Bearer/JWT/KV contexts other rules
 *     handle.)
 *  2. ≥18 DISTINCT chars — excludes hex hashes/SHAs (≤16), digit runs
 *     (≤10) by construction; and since 18 distinct is unreachable with
 *     digits alone, a passing token necessarily contains letters.
 *  3. Contains ≥1 DIGIT — kills CamelCase-without-digits identifiers
 *     (`AbstractSingletonProxyFactoryBeanGenerator`, `TheQuickBrownFox…`),
 *     which are the residual no-separator FP shape. Real base62 tokens
 *     almost always contain a digit (>99% at 28+ chars).
 */
import type { RawHit } from './kv-scanner.js'

const CANDIDATE_RE = /[A-Za-z0-9]{28,}/g

// Unreachable with digits alone (10) → excludes hex (≤16) and digit runs;
// real base62 tokens have 24–62 distinct.
export const GENERIC_MIN_DISTINCT = 18

// A real message has at most a handful of credentials; bound the work on
// pathological/junk input (the O(n²) overlap-dedup downstream is the cost).
const MAX_GENERIC_HITS = 20

/** True once `tok` has at least `n` distinct chars (early-exit). ASCII-only
 *  by construction — CANDIDATE_RE admits no code point ≥ 128. */
function hasDistinctChars(tok: string, n: number): boolean {
  const seen = new Uint8Array(128)
  let distinct = 0
  for (let i = 0; i < tok.length; i++) {
    const c = tok.charCodeAt(i)
    if (seen[c] === 0) {
      seen[c] = 1
      if (++distinct >= n) return true
    }
  }
  return false
}

function hasDigit(tok: string): boolean {
  for (let i = 0; i < tok.length; i++) {
    const c = tok.charCodeAt(i)
    if (c >= 48 && c <= 57) return true
  }
  return false
}

export function scanGenericSecrets(text: string): RawHit[] {
  const hits: RawHit[] = []
  CANDIDATE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CANDIDATE_RE.exec(text)) !== null) {
    if (hits.length >= MAX_GENERIC_HITS) break
    const tok = m[0]
    if (!hasDigit(tok)) continue
    if (!hasDistinctChars(tok, GENERIC_MIN_DISTINCT)) continue
    hits.push({
      rule_id: 'generic_high_entropy',
      start: m.index,
      end: m.index + tok.length,
      matched_text: tok,
      confidence: 'ambiguous',
    })
  }
  return hits
}
