/**
 * Ack-first state flag — load-bearing for the ack-first-pretool hook
 * (see `src/cli/ack-first-pretool.ts` and
 * `reference/conversational-pacing.md` beat 1).
 *
 * The gateway is the source of truth for "has the model called reply
 * yet this turn?". The PreToolUse hook runs as a short-lived child
 * process so it can't read gateway in-memory state; the hand-off is
 * a single file inside `$TELEGRAM_STATE_DIR`:
 *
 *   - `markAckSent()` touches the file on the first reply per turn.
 *   - `clearAckSent()` removes it at turn_started.
 *   - The hook checks `existsSync(path)` → allow / block.
 *
 * Per-agent isolation is built-in: `$TELEGRAM_STATE_DIR` is the
 * agent's per-container state dir (~/.switchroom/agents/<name>/telegram,
 * bind-mounted into /state/agent/home/.switchroom/agents/<name>/telegram
 * inside the container).
 *
 * All operations are best-effort: a write or unlink failure logs to
 * stderr and returns; the gate is informational UX, not a safety
 * primitive, so a broken state-dir must never wedge reply itself.
 */

import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const ACK_SENT_MARKER = "ack-sent.flag";

function markerPath(): string | null {
  const dir = process.env.TELEGRAM_STATE_DIR;
  if (!dir) return null;
  return join(dir, ACK_SENT_MARKER);
}

/** Create the ack-sent marker. Idempotent (no-op if it exists). */
export function markAckSent(): void {
  const path = markerPath();
  if (path == null) return;
  if (existsSync(path)) return;
  try {
    const fd = openSync(path, "w");
    closeSync(fd);
  } catch (err) {
    process.stderr.write(
      `ack-flag: markAckSent failed path=${path}: ${err}\n`,
    );
  }
}

/** Remove the ack-sent marker. Idempotent. */
export function clearAckSent(): void {
  const path = markerPath();
  if (path == null) return;
  try {
    unlinkSync(path);
  } catch (err: unknown) {
    // ENOENT is the common case (turn started before any prior turn
    // ran a reply); silently swallow.
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "ENOENT") return;
    process.stderr.write(
      `ack-flag: clearAckSent failed path=${path}: ${err}\n`,
    );
  }
}
