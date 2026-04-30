/**
 * Fingerprint computation for issue dedup.
 *
 * Two events with the same fingerprint coalesce in the store. The
 * fingerprint is a stable function of `(source, code)` — the
 * inherent identity of the failure, independent of timestamps,
 * occurrence count, or stderr details.
 *
 * Format: `<source>::<code>`. Human-readable on purpose so users
 * inspecting the JSONL or filing bug reports can quote it directly
 * (`/issues resolve hook:handoff::cli-error`).
 */

export function computeFingerprint(source: string, code: string): string {
  // Reject empty components — they would let unrelated failures
  // collide on the empty fingerprint and silently mask each other.
  if (!source) throw new Error("fingerprint: source is required");
  if (!code) throw new Error("fingerprint: code is required");
  return `${source}::${code}`;
}
