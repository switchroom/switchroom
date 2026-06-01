import { describe, it, expect } from 'vitest'
import { detectSecrets } from '../secret-detect/index.js'
import { scanGenericSecrets, GENERIC_MIN_DISTINCT } from '../secret-detect/generic-entropy.js'

/**
 * Generic bare-high-entropy fallback (#1) — the long-tail detector for
 * standalone tokens that no prefix/KV rule matches (the Sanctum class).
 * Emitted at `ambiguous` confidence: the inbound gate ASKS ("stash to
 * vault or ignore?") rather than auto-deleting, so recall can be generous.
 *
 * Fixtures built by concatenation (no contiguous secret-shaped literals).
 */

// 32 varied base62 chars → high entropy (~5 bits/char).
const HIGH_ENTROPY = 'q7Wm2Zx9' + 'Lk4Rp1Vn' + '8Bs3Yt6H' + 'd5Gj0Fc7'
// 32 chars but only 3 distinct → low entropy (< 4), must NOT flag.
const LOW_ENTROPY = 'abc'.repeat(11) // 33 chars, entropy ~1.6

describe('generic high-entropy detector', () => {
  it('flags a standalone high-entropy token as ambiguous', () => {
    const hits = detectSecrets(`the value is ${HIGH_ENTROPY} ok`)
    const hit = hits.find((d) => d.rule_id === 'generic_high_entropy')
    expect(hit).toBeDefined()
    expect(hit!.matched_text).toBe(HIGH_ENTROPY)
    expect(hit!.confidence).toBe('ambiguous') // asks, never auto-deletes
  })

  it('respects the distinct-char floor (repetitive long strings do not flag)', () => {
    expect(scanGenericSecrets(LOW_ENTROPY).length).toBe(0) // 3 distinct < 18
    expect(GENERIC_MIN_DISTINCT).toBe(18)
  })

  it('caps hits on pathological input (bounds the O(n²) overlap-dedup)', () => {
    // 100 distinct high-entropy tokens; the scanner must not return all 100.
    const blob = Array.from({ length: 100 }, (_, i) =>
      ('q7Wm2Zx9Lk4Rp1Vn8Bs3Yt6H' + 'd5Gj0Fc7') + String(i).padStart(3, '0'),
    ).join(' ')
    expect(scanGenericSecrets(blob).length).toBeLessThanOrEqual(20)
  })

  it('respects the length floor (short tokens do not flag)', () => {
    const short = 'q7Wm2Zx9Lk4Rp1Vn' // 16 chars
    expect(scanGenericSecrets(short).length).toBe(0)
  })

  it('does NOT downgrade a recognized high-confidence token', () => {
    // A ghp_ token is matched by the anchored pattern (high). The generic
    // pass must not swallow/downgrade it to ambiguous.
    const ghp = 'ghp_' + 'A1b2C3d4E5'.repeat(3) // ghp_ + 30
    const hits = detectSecrets(`token ${ghp} here`)
    const ghpHit = hits.find((d) => d.matched_text === ghp || d.rule_id === 'github_pat_classic')
    expect(ghpHit).toBeDefined()
    expect(ghpHit!.confidence).toBe('high')
  })

  describe('false-positive guards — benign high-entropy shapes do NOT flag', () => {
    const BENIGN: Array<[string, string]> = [
      ['a UUID', '550e8400-e29b-41d4-a716-446655440000'],
      ['a git SHA (40 hex)', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
      ['a sha256 (64 hex)', 'e3b0c44298fc1c149afbf4c8996fb924' + '27ae41e4649b934ca495991b7852b855'],
      ['an md5 (32 hex)', 'd41d8cd98f00b204' + 'e9800998ecf8427e'],
      ['a long digit run', '123456789012345678901234567890'],
      ['plain prose', 'the quick brown fox jumps over the lazy dog repeatedly today'],
      ['a file path', '/usr/local/lib/python3.11/site-packages/somepackage/internal/module.py'],
    ]
    for (const [label, text] of BENIGN) {
      it(`${label} does not flag generic_high_entropy`, () => {
        const hits = detectSecrets(text).filter((d) => d.rule_id === 'generic_high_entropy')
        expect(hits, `unexpected: ${JSON.stringify(hits.map((h) => h.matched_text))}`).toHaveLength(0)
      })
    }
  })
})
