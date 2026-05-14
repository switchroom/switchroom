/**
 * Reconciler — three-state per RFC C §8.
 *
 *   present  — files.get returns 200, hash unchanged.
 *   missing  — files.get returns 404 OR `trashed: true`.
 *   conflict — modifiedTime newer / hash differs / mimeType changed /
 *              permissions changed in a way that excludes the agent.
 *
 * The "last seen" snapshot is provided by the caller (kept on the grant row;
 * see `grants-store.ts`). The reconciler is pure: feed it `(remote, lastSeen)`,
 * get a verdict.
 */

export interface DriveFileMetadata {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string; // RFC 3339 from Google
  /** SHA-256 hex of (mimeType + modifiedTime + size) — see hashFile() below. */
  contentHash?: string;
  trashed?: boolean;
  /** True when the agent's identity is no longer in the permissions list. */
  ownerExcluded?: boolean;
}

export interface LastSeenSnapshot {
  modifiedTime?: string;
  contentHash?: string;
  mimeType?: string;
}

export type ReconcilerVerdict =
  | { state: "present"; meta: DriveFileMetadata }
  | { state: "missing"; reason: "not_found" | "trashed" }
  | {
      state: "conflict";
      meta: DriveFileMetadata;
      reasons: ConflictReason[];
    };

export type ConflictReason =
  | "modified_time_newer"
  | "content_hash_changed"
  | "mime_type_changed"
  | "owner_excluded";

/**
 * Simulate a `files.get` response into a verdict.
 *
 * Inputs:
 *   - `remote`:   what `files.get` returned. `null` = 404. The `trashed`
 *                 flag (when present and true) is treated as missing.
 *   - `lastSeen`: snapshot from the grant row, or `null` if this is the
 *                 first observation (in which case `present` is always the
 *                 verdict — we don't have a baseline to diff against yet).
 */
export function reconcile(
  remote: DriveFileMetadata | null,
  lastSeen: LastSeenSnapshot | null,
): ReconcilerVerdict {
  if (remote === null) return { state: "missing", reason: "not_found" };
  if (remote.trashed === true) return { state: "missing", reason: "trashed" };

  // First observation — establish baseline, no conflict possible.
  if (lastSeen === null) return { state: "present", meta: remote };

  const reasons: ConflictReason[] = [];

  if (
    lastSeen.modifiedTime !== undefined &&
    remote.modifiedTime !== undefined &&
    isNewer(remote.modifiedTime, lastSeen.modifiedTime)
  ) {
    reasons.push("modified_time_newer");
  }

  if (
    lastSeen.contentHash !== undefined &&
    remote.contentHash !== undefined &&
    lastSeen.contentHash !== remote.contentHash
  ) {
    reasons.push("content_hash_changed");
  }

  if (
    lastSeen.mimeType !== undefined &&
    remote.mimeType !== undefined &&
    lastSeen.mimeType !== remote.mimeType
  ) {
    reasons.push("mime_type_changed");
  }

  if (remote.ownerExcluded === true) {
    reasons.push("owner_excluded");
  }

  if (reasons.length === 0) return { state: "present", meta: remote };
  return { state: "conflict", meta: remote, reasons };
}

/** Compare two RFC 3339 timestamps. Strings are compared via Date so the */
/* fractional-second precision Google sometimes returns is honored. */
export function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a !== b;
  return ta > tb;
}

// ────────────────────────────────────────────────────────────────────────
// RFC E §4.4 — missing→present recovery detection
// ────────────────────────────────────────────────────────────────────────

/**
 * The shape of "recovery" the user-facing JTBD cares about: a doc that
 * was missing (deleted/trashed) on the previous reconciler check is
 * back. Conflict↔present transitions are NOT recoveries — those are
 * normal evolution, not the "I un-trashed it" signal that warrants a
 * chat nudge.
 *
 * Recovery is asymmetric on purpose:
 *   - missing → present  ✅ recovery (operator un-trashed / restored)
 *   - missing → conflict ✅ recovery (restored but evolved while gone)
 *   - present → present  ✗ no event
 *   - present → missing  ✗ that's the loss event, separate signal
 *   - conflict → *       ✗ the staleness digest covers conflict drift
 *
 * Pure: takes the previous + current verdicts, returns whether to fire
 * a recovery event. Caller is responsible for the actual side-effects
 * (writing the `recover` row to `approval_audit` per RFC B §5,
 * surfacing the `[ ↻ Re-enabled ]` line in the staleness digest, and
 * posting the chat nudge). Phase 1d ships the detector; wiring those
 * three side-effects into the as-yet-unwritten reconciler-driver is
 * follow-up work (matches the same shipped-helper-then-wire-up
 * pattern as RFC G Phase 2's `detectLegacyGdriveSlots`).
 */
export interface RecoveryEvent {
  recovered: true;
  fromReason: "not_found" | "trashed";
  toState: "present" | "conflict";
  meta: DriveFileMetadata;
}

export type RecoveryResult = RecoveryEvent | { recovered: false };

export function detectRecovery(
  prev: ReconcilerVerdict | null,
  current: ReconcilerVerdict,
): RecoveryResult {
  if (prev === null) return { recovered: false };
  if (prev.state !== "missing") return { recovered: false };
  if (current.state === "missing") return { recovered: false };
  return {
    recovered: true,
    fromReason: prev.reason,
    toState: current.state,
    meta: current.meta,
  };
}

/**
 * Stable content hash from the metadata fields Drive returns cheaply (we
 * don't want to download the body just to hash it — `files.get` is the only
 * round-trip we want per access). Hash inputs:
 *   - mimeType   (catches doc→pdf conversions)
 *   - modifiedTime (catches edits)
 *   - size       (catches body churn that didn't bump modifiedTime)
 *
 * If Google's response is missing any of these, the hash is computed over
 * what's present. Two hashes computed from disjoint field sets will diff
 * and trigger a conflict — that's the correct behavior.
 */
export async function hashMetadata(parts: {
  mimeType?: string;
  modifiedTime?: string;
  size?: string | number;
}): Promise<string> {
  const canonical = JSON.stringify({
    mimeType: parts.mimeType ?? null,
    modifiedTime: parts.modifiedTime ?? null,
    size: parts.size ?? null,
  });
  const data = new TextEncoder().encode(canonical);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
