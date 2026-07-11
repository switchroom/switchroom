/**
 * Sliding-window chunker for ReDoS-bounded detection.
 *
 * Inputs larger than 32 KB are split into 16 KB windows with 8 KB overlap.
 * Each window is scanned independently; the caller is responsible for
 * dedupe-by-byte-offset when merging per-window hits back together.
 *
 * The overlap exists so a secret that straddles a window boundary is still
 * fully contained in at least one scan. The guarantee is exact: a secret is
 * only missed if its length EXCEEDS the overlap (if length ≤ OVERLAP, a
 * boundary-straddling secret is wholly inside the next window, which starts
 * OVERLAP bytes before the boundary). The old 1 KB overlap was smaller than
 * a real PEM private key — a 4096-bit RSA key in PEM armor is ~3.2 KB, so a
 * boundary-straddling RSA key in a >32 KB payload slipped through unmasked
 * (2026-07 secret-scrub review, tp-support F2). At 8 KB the overlap clears
 * a 4096-bit RSA PEM (~3.2 KB) with >2x margin and also covers larger EC /
 * certificate blobs. Cost: windows advance by WINDOW_SIZE−OVERLAP = 8 KB,
 * so a big payload is scanned in ~2x as many windows — bounded and cheap.
 */

export interface Window {
  /** Start offset in the original string. */
  offset: number
  /** The window text. */
  text: string
}

export const CHUNK_THRESHOLD = 32 * 1024
export const WINDOW_SIZE = 16 * 1024
/**
 * 8 KB. MUST be ≥ the largest secret we need to catch across a window
 * boundary; a 4096-bit RSA private key in PEM armor is ~3.2 KB, so this
 * clears it with >2x headroom. See the module header for the exact
 * "missed only if secret length > OVERLAP" guarantee.
 */
export const OVERLAP = 8 * 1024

export function chunk(text: string): Window[] {
  if (text.length <= CHUNK_THRESHOLD) {
    return [{ offset: 0, text }]
  }
  const out: Window[] = []
  let offset = 0
  while (offset < text.length) {
    const end = Math.min(offset + WINDOW_SIZE, text.length)
    out.push({ offset, text: text.slice(offset, end) })
    if (end >= text.length) break
    offset = end - OVERLAP
  }
  return out
}
