/**
 * Turn-active liveness marker (#412).
 *
 * Writes `<STATE_DIR>/turn-active.json` on turn_start, touches its mtime
 * on every tool_use, removes it on turn_complete. The watchdog
 * (bin/bridge-watchdog.sh) reads the mtime: if the file exists AND its
 * mtime is older than TURN_HANG_SECS (default 300s = 5min), the agent
 * is wedged mid-turn and the watchdog restarts.
 *
 * Why this exists: PR #410 raised the journal-silence detector to 4000s
 * to kill false positives on chat-cadence agents that legitimately
 * idle for hours between turns. That left a gap — Stop-hook deadlocks
 * (the original failure mode #116 tracked) are no longer caught under
 * default thresholds.
 *
 * The distinguisher is "in-turn-and-silent" vs "between-turns-and-silent":
 * the former is a wedge, the latter is healthy idle. This marker exists
 * exactly during in-turn windows, so its staleness uniquely indicates
 * the wedge.
 *
 * Pure file I/O. The actual hang-detection-and-restart loop lives in the
 * bash watchdog, where it composes with the existing
 * Restart=on-failure / journal-silence / bridge-disconnect detectors.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const TURN_ACTIVE_MARKER_FILE = "turn-active.json";

export interface TurnActiveMarker {
  turnKey: string;
  chatId: string;
  threadId?: string | null;
  startedAt: number;
}

/**
 * Write the marker file at turn-start. Idempotent — if the file
 * already exists from a stale prior turn (unlikely; turn_complete
 * removes it), the new write wins.
 */
export function writeTurnActiveMarker(stateDir: string, marker: TurnActiveMarker): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, TURN_ACTIVE_MARKER_FILE),
      JSON.stringify(marker, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Best-effort: marker file is a watchdog optimisation, not a
    // correctness requirement. Don't break the turn-start path on
    // disk-full, ENOSPC, etc.
  }
}

/**
 * Touch the marker file's mtime. Called on every tool_use event so an
 * agent doing real work continually advances the mtime. The watchdog's
 * threshold compares against this mtime.
 */
export function touchTurnActiveMarker(stateDir: string): void {
  const path = join(stateDir, TURN_ACTIVE_MARKER_FILE);
  if (!existsSync(path)) return;
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    // utimesSync can fail on some filesystems; fall back to a tiny
    // open-close cycle to bump the mtime via writes from the kernel side.
    try {
      const fd = openSync(path, "r+");
      closeSync(fd);
    } catch {
      /* swallow — best-effort */
    }
  }
}

/**
 * Remove the marker file at turn_complete. Absence of the file is the
 * watchdog's signal that no turn is in flight (legitimate idle, no
 * reason to suspect a hang).
 */
export function removeTurnActiveMarker(stateDir: string): void {
  try {
    unlinkSync(join(stateDir, TURN_ACTIVE_MARKER_FILE));
  } catch {
    // ENOENT is fine (already removed); other errors don't justify
    // breaking the turn-end path.
  }
}

/**
 * Sweep a stale marker file. Defence-in-depth backstop for #550 — when
 * the primary `turn_end` removal path is silently skipped (e.g. SDK
 * killed before the JSONL turn_duration record is written, or the
 * progress-card driver's `forceCompleteTurn` no-ops because the card
 * was already torn down), the marker leaks across restarts and the
 * watchdog reads it as a hung turn.
 *
 * Removes the marker if EITHER:
 *   - mtime is older than `idleSweepMs` AND the caller asserts that no
 *     turn is currently in flight (`turnInFlight=false`), OR
 *   - mtime is older than `hardTtlMs` unconditionally (the absolute
 *     ceiling — anything older than this can't be a real turn).
 *
 * Both conditions are best-effort and idempotent. Returns true if the
 * marker was removed, false otherwise.
 */
export function sweepStaleTurnActiveMarker(
  stateDir: string,
  opts: {
    turnInFlight: boolean;
    idleSweepMs: number;
    hardTtlMs: number;
    now?: number;
    /**
     * Optional diagnostic callback invoked when the marker is removed.
     * Best-effort: keeps the function pure (no logger coupling) while
     * letting the caller emit a structured journalctl line. Must not
     * throw — exceptions from this callback are swallowed.
     */
    onRemove?: (info: {
      ageMs: number;
      reason: "idle-stale" | "hard-ttl";
      payload: string | null;
    }) => void;
  },
): boolean {
  const path = join(stateDir, TURN_ACTIVE_MARKER_FILE);
  if (!existsSync(path)) return false;
  const now = opts.now ?? Date.now();
  try {
    const st = statSync(path);
    const ageMs = now - st.mtimeMs;
    const hardExpired = ageMs > opts.hardTtlMs;
    const idleExpired = !opts.turnInFlight && ageMs > opts.idleSweepMs;
    if (!hardExpired && !idleExpired) return false;
    // Best-effort read so the diagnostic callback can include the
    // payload (turnKey, chatId, startedAt) for forensic logging.
    let payload: string | null = null;
    try {
      payload = readFileSync(path, "utf8");
    } catch {
      /* unreadable — still drop the marker */
    }
    unlinkSync(path);
    if (opts.onRemove) {
      try {
        opts.onRemove({
          ageMs,
          reason: hardExpired ? "hard-ttl" : "idle-stale",
          payload,
        });
      } catch {
        /* swallow — diagnostics must never break the sweep */
      }
    }
    return true;
  } catch {
    // ENOENT race or stat failure — nothing actionable.
    return false;
  }
}

/**
 * Age (ms) of the turn-active marker's mtime, or null if the marker is
 * absent/unstattable. The marker is touched on every foreground tool_use AND
 * (via the subagent-watcher, #501) on foreground sub-agent JSONL growth — so a
 * SMALL age means the agent, or an orphaned/extended-autonomous foreground
 * sub-agent that outlived its turn (#2240), is actively working RIGHT NOW, even
 * though the turn-in-flight machine has gone idle. A large age (or null) means
 * the work stopped or the marker leaked. Used by the obligation sweep to avoid a
 * false "did I miss this? re-send" escalation while genuine post-turn work is in
 * flight. Pure read; clock injectable for tests. Never throws — a stat failure
 * is reported as null (treated as "not working").
 */
export function readTurnActiveMarkerAgeMs(stateDir: string, now?: number): number | null {
  const path = join(stateDir, TURN_ACTIVE_MARKER_FILE);
  try {
    const st = statSync(path);
    return (now ?? Date.now()) - st.mtimeMs;
  } catch {
    return null; // ENOENT / unstattable → not working
  }
}
