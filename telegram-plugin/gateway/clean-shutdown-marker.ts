/**
 * Clean-shutdown marker — a sentinel written by the SIGTERM/SIGINT
 * handler so the NEXT gateway process knows the previous shutdown was
 * deliberate, not a crash.
 *
 * Why this exists:
 *   The boot path posts a "⚡ Recovered from unexpected restart"
 *   banner whenever it doesn't find a /restart user-marker — assuming
 *   any unannounced restart was a crash. But planned restarts
 *   (`systemctl --user restart switchroom-clerk-gateway`,
 *   `switchroom agent restart`, Coolify/CI redeploys, etc.) had no way
 *   to signal "this was planned" without claiming the user-ACK marker
 *   (RestartMarker), which carries chat_id + ack_message_id and is the
 *   wrong shape for non-user-initiated paths.
 *
 *   This is a SECOND, separate marker — purpose-built for "the OS told
 *   us to stop". It is intentionally simpler than RestartMarker: no
 *   chat_id, no ack_message_id, just `{ ts, signal }` so the next boot
 *   can verify the signal is fresh and suppress the recovery banner.
 *
 * Lifecycle:
 *   1. SIGTERM/SIGINT handler writes the marker BEFORE invoking the
 *      drain coordinator. (If the drain hangs and the +5s force-exit
 *      kills the process, the marker is already on disk.)
 *   2. Next gateway boot reads the marker. Fresh (<60s) → suppress the
 *      recovery banner + clear the marker. Stale (>=60s) → clear it but
 *      treat as a real crash anyway (a clean shutdown that took >60s
 *      almost certainly stalled mid-drain — operator probably wants the
 *      banner).
 *   3. The existing /restart user-marker (RestartMarker) is untouched
 *      by this module; that path remains the source of truth for "I
 *      was asked to restart by THIS user, post a quote-reply ack".
 */

import { writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";

export interface CleanShutdownMarker {
  /** Wall-clock ms when the SIGTERM/SIGINT was received. */
  ts: number;
  /** "SIGTERM" | "SIGINT" — kept as string to allow future signals. */
  signal: string;
  /** Optional free-form note (unused today; reserved for tagging
   *  caller intent like "deploy" or "agent-restart"). */
  reason?: string;
}

/** Default age cap. A clean shutdown that takes longer than this almost
 *  certainly stalled mid-drain; the operator probably wants to see the
 *  banner anyway. */
export const DEFAULT_MAX_AGE_MS = 60_000;

export function writeCleanShutdownMarker(
  path: string,
  marker: CleanShutdownMarker,
): void {
  // Atomic write via tmp + rename so a partial write can't ever be read
  // back as malformed JSON by the next boot.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(marker), "utf-8");
  renameSync(tmp, path);
}

export function readCleanShutdownMarker(
  path: string,
): CleanShutdownMarker | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CleanShutdownMarker>;
    if (
      typeof parsed.ts === "number" &&
      Number.isFinite(parsed.ts) &&
      typeof parsed.signal === "string" &&
      parsed.signal.length > 0
    ) {
      const out: CleanShutdownMarker = { ts: parsed.ts, signal: parsed.signal };
      if (typeof parsed.reason === "string") out.reason = parsed.reason;
      return out;
    }
    return null;
  } catch {
    // Missing file OR malformed JSON — both are "no usable marker", and
    // a malformed marker MUST NOT crash boot.
    return null;
  }
}

export function clearCleanShutdownMarker(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* best effort — file may already be gone */
  }
}

/**
 * Pure decision: should the boot path SUPPRESS the "recovered from
 * unexpected restart" banner because we found a fresh clean-shutdown
 * marker?
 *
 * Returns true ONLY when:
 *   - a marker is present, AND
 *   - the marker is younger than maxAgeMs (default 60s).
 *
 * Returns false when:
 *   - no marker (true crash or first boot — fire the banner), OR
 *   - marker is stale (clean shutdown initiated but never completed
 *     within maxAgeMs — almost certainly a crash mid-drain, fire the
 *     banner anyway).
 *
 * Keeping this pure makes the boot decision unit-testable without
 * having to spin up a real Bot/Context.
 */
export function shouldSuppressRecoveryBanner(
  marker: CleanShutdownMarker | null,
  now: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): boolean {
  if (marker === null) return false;
  const age = now - marker.ts;
  if (age < 0) return false; // clock skew defence — treat as stale
  return age < maxAgeMs;
}
