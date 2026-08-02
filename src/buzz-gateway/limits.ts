/**
 * Buzz sidecar — Phase 2b size limits + chunking (F6 constants, S5).
 *
 * Pure, socket-free helpers so the size discipline is unit-testable without a
 * relay. Two byte budgets are in play and must not be conflated:
 *
 *   - CONTENT budget — the UTF-8 byte length of a single Nostr event's
 *     `content`. Oversized answers are SPLIT into multiple chunk events.
 *   - FRAME budget — the byte length of the whole `["EVENT", <event>]` JSON
 *     frame put on the wire. This is validated PER FRAME, AFTER chunk-splitting
 *     (S5): splitting first guarantees each chunk's frame is checked on its own,
 *     so a giant answer can never sneak past as one over-budget frame.
 *
 * All lengths are measured in BYTES (UTF-8), never UTF-16 code units, because
 * the relay and NIP-01 count bytes. Splitting is done on a byte budget with a
 * code-point-safe cut so a multi-byte character is never severed.
 */

/** F6 — max UTF-8 bytes of a single event's `content`. */
export const BUZZ_MAX_CONTENT_BYTES = 262_144;

/** F6 — target UTF-8 byte size of each chunk when an answer is split. Kept
 *  below BUZZ_MAX_CONTENT_BYTES so a chunk with appended threading tags and a
 *  part marker still clears the content budget with headroom. */
export const BUZZ_CHUNK_BYTES = 200_000;

/** F6 — hard ceiling on the whole `["EVENT", …]` frame put on the wire. */
export const BUZZ_MAX_FRAME_BYTES = 524_288;

/** F6 — max acceptable clock drift (seconds) for a `created_at` the relay will
 *  accept; the publisher clamps to now and this bounds a sanity assertion. */
export const BUZZ_TS_DRIFT_SEC = 900;

/** F6 — how long to await a relay OK for a published event before giving up. */
export const BUZZ_PUBLISH_TIMEOUT_MS = 10_000;

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Split `text` into chunks each ≤ `maxBytes` UTF-8 bytes, cutting only on
 * code-point boundaries (a surrogate pair / multi-byte char is never severed).
 * A string already within budget returns as a single-element array. Empty
 * input returns `[""]` so a caller always publishes at least one event.
 */
export function splitByBytes(text: string, maxBytes: number = BUZZ_CHUNK_BYTES): string[] {
  if (maxBytes <= 0) return [text];
  if (byteLength(text) <= maxBytes) return [text];

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  // Iterate by code point (the string iterator yields whole code points).
  for (const ch of text) {
    const chBytes = encoder.encode(ch).length;
    if (currentBytes + chBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

/**
 * True IFF the serialized `["EVENT", <event>]` frame is within the wire budget.
 * Called PER chunk-frame AFTER splitting (S5) — never as a pre-split gate on the
 * whole answer.
 */
export function isFrameWithinBudget(
  frame: unknown,
  maxBytes: number = BUZZ_MAX_FRAME_BYTES,
): boolean {
  return byteLength(JSON.stringify(frame)) <= maxBytes;
}
