import { describe, it, expect } from 'vitest'
import { detectSecrets } from '../secret-detect/index.js'
import { chunk, CHUNK_THRESHOLD, WINDOW_SIZE, OVERLAP } from '../secret-detect/chunker.js'

/**
 * OUTCOME test for tp-support F2 — the sliding-window overlap must exceed a
 * real PEM private key so a boundary-straddling key in a >32 KB payload is
 * still fully contained in (and therefore detected by) at least one window.
 *
 * The old 1 KB overlap was smaller than a 4096-bit RSA PEM (~3.2 KB), so a
 * ~3.2 KB key straddling a 16 KB window boundary fell into the gap between
 * consecutive windows and was scanned by NEITHER — it slipped past the
 * scrubber unmasked. This pins the fix behaviorally: the key is detected.
 *
 * Proof-of-bite: reverting OVERLAP to 1024 (its pre-fix value) makes the
 * boundary-straddling assertion below fail — the key lands in the gap.
 */

// A representative ~3.2 KB PEM private key (4096-bit RSA armor size). Body is
// obviously-fake filler; only the BEGIN/END markers + non-empty body matter
// for the `pem_private_key` regex. Assembled at runtime per CLAUDE.md.
const PEM_BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_END = '-----END RSA PRIVATE KEY-----'
const PEM_BODY = 'A'.repeat(3100)
const PEM = `${PEM_BEGIN}\n${PEM_BODY}\n${PEM_END}`

describe('chunker overlap ≥ real PEM key size (tp-support F2)', () => {
  it('overlap safely exceeds a 4096-bit RSA PEM (~3.2 KB)', () => {
    // Guarantee: a secret is only missed if its length EXCEEDS OVERLAP.
    expect(OVERLAP).toBeGreaterThanOrEqual(4 * 1024)
    expect(PEM.length).toBeGreaterThan(1024) // the finding's ">1KB" threshold
    expect(OVERLAP).toBeGreaterThan(PEM.length) // key fits inside the overlap
  })

  it('detects a >1KB PEM key straddling a window boundary in a >32KB payload', () => {
    // Place the PEM so it straddles the first window boundary (16 KB): it
    // starts before the boundary and ends after it. With the fixed 8 KB
    // overlap the whole key sits inside the second window [8K, 24K]; with the
    // old 1 KB overlap it fell into the gap between [0,16K] and [15.36K,31.74K].
    const pemStart = WINDOW_SIZE - 1384 // 15000: before the 16384 boundary
    const leading = 'a'.repeat(pemStart)
    const trailing = 'a'.repeat(20000)
    const text = leading + PEM + trailing

    // Sanity: the payload is over the chunk threshold (so chunking is active)
    // and the PEM genuinely straddles a real window boundary.
    expect(text.length).toBeGreaterThan(CHUNK_THRESHOLD)
    const windows = chunk(text)
    expect(windows.length).toBeGreaterThan(1)
    const pemEnd = pemStart + PEM.length
    // Straddles the first boundary: starts before it, ends after it.
    expect(pemStart).toBeLessThan(WINDOW_SIZE)
    expect(pemEnd).toBeGreaterThan(WINDOW_SIZE)
    // No single window before the fix (1 KB overlap) would have contained it,
    // yet with the current overlap at least one window does.
    const containing = windows.filter(
      (w) => pemStart >= w.offset && pemEnd <= w.offset + w.text.length,
    )
    expect(containing.length).toBeGreaterThan(0)

    // The actual outcome: the detector flags the straddling PEM.
    const hits = detectSecrets(text)
    expect(hits.some((h) => h.rule_id === 'pem_private_key')).toBe(true)
  })
})
