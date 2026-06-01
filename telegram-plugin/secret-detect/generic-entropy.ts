/**
 * Generic bare-high-entropy detector — the long-tail fallback.
 *
 * The provider/anchored patterns only catch tokens with a known prefix
 * (sk-, ghp_, shpat_, …) or a KEY=value context. A STANDALONE high-entropy
 * token pasted in prose — a raw Sanctum/base62 token, a bare base64url API
 * key with no prefix — matches none of them and used to slip through
 * entirely (the 2026-06-01 Sanctum incident). This scanner closes that gap.
 *
 * Emitted at **`ambiguous`** confidence, NOT `high`:
 *   - The inbound gate auto-DELETES on a high-confidence hit; a generic
 *     guess is not precise enough to justify that, so it routes to the
 *     "👀 looks like a high-entropy string — stash to vault or ignore?"
 *     ask-path instead.
 *   - `redact()` masks ambiguous hits too, so history storage is still
 *     protected as defense-in-depth.
 *
 * Precision/perf via a DISTINCT-CHARACTER gate rather than Shannon entropy:
 * requiring ≥ DISTINCT distinct chars over a long run is a fast O(n) check
 * (a 128-slot bitset with early-exit, no Map / no log2) and — crucially —
 * the floor is set just above the alphabets of the dominant benign shapes,
 * so they're excluded BY CONSTRUCTION:
 *   - hex hashes (md5/sha1/sha256, git SHAs, hex ids): ≤ 16 distinct
 *   - UUIDs (hex + `-`): ≤ 17 distinct
 *   - digit runs (phone/ids): ≤ 10 distinct
 * while real base62 / base64url tokens have 24–62 distinct → flagged.
 */
import type { RawHit } from './kv-scanner.js'

// A run of base62 / base64url token chars. Deliberately NOT `/` `+` `=`
// `.` `:` `|` — keeps file paths, standard-base64 data blobs, version
// strings, hostnames, and the separately-ruled Sanctum `<id>|<token>`
// shape out of the candidate set.
const CANDIDATE_RE = /[A-Za-z0-9_-]{28,}/g

// Just above hex (16) and UUID (17), below base62/base64url token diversity.
export const GENERIC_MIN_DISTINCT = 18

// A real message has at most a handful of credentials; bound the work on
// pathological/junk input (the O(n²) overlap-dedup downstream is the cost,
// not this scan) so 100KB of random text can't explode it.
const MAX_GENERIC_HITS = 20

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

export function scanGenericSecrets(text: string): RawHit[] {
  const hits: RawHit[] = []
  CANDIDATE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CANDIDATE_RE.exec(text)) !== null) {
    if (hits.length >= MAX_GENERIC_HITS) break
    const tok = m[0]
    // UUID is the one ≤17-distinct shape that's a single CANDIDATE run
    // (it embeds `-`); the distinct floor already excludes it, but keep
    // the explicit guard for clarity/robustness.
    if (UUID_RE.test(tok)) continue
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
