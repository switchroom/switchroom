/**
 * Turn-active liveness marker (#412).
 *
 * Writes `<STATE_DIR>/turn-active.json` on turn_start, touches its mtime on
 * every tool_use AND (via the subagent-watcher, #501) on foreground sub-agent
 * JSONL growth, removes it on turn_complete. The mtime is therefore "ms since
 * last observable progress": it advances while a turn — even a long one running
 * one big tool or a sub-agent — is genuinely working, and goes stale only when
 * work stops (a wedge).
 *
 * Why this exists: PR #410 raised the journal-silence detector to 4000s to kill
 * false positives on chat-cadence agents that legitimately idle for hours
 * between turns. That left a gap — Stop-hook deadlocks (the original failure
 * mode #116 tracked) are no longer caught under default thresholds. The
 * distinguisher is "in-turn-and-silent" vs "between-turns-and-silent": the
 * former is a wedge, the latter is healthy idle. This marker exists exactly
 * during in-turn windows, so its staleness uniquely indicates the wedge.
 *
 * WHO CONSUMES THE STALENESS (contract corrected — the historical
 * `bin/bridge-watchdog.sh` bash watchdog this header once named was never
 * committed to the repo; do not reintroduce a reference to it):
 *
 *   - The gateway BOOT classifier (`markOrphanedWithTimeoutClassification` in
 *     gateway.ts): on restart, a marker whose mtime is older than TURN_HANG_SECS
 *     (default 300s) reclassifies the orphaned turn as `timeout`, routing the
 *     next session to the ask-first `resume_watchdog_timeout` inbound.
 *   - The LIVE Stage B hang-restart (`hang-restart-decision.ts`, consulted from
 *     the silence-poke framework fallback): a mid-tool fallback with a stale
 *     marker escalates to a real SIGTERM-PID1 restart. `readTurnActiveMarkerAgeMs`
 *     below is the shared read.
 *   - The obligation / phantom-turn sweeps (`readTurnActiveMarkerAgeMs`,
 *     `effectiveTurnAgeMs`): a small age means work is still in flight, so a
 *     "did I miss this?" re-send is suppressed.
 *
 * Pure file I/O; the mtime is the honest cross-process progress signal.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { mkdirStateSync, writeStateFileSync } from "../../src/util/state-owner.js";

export const TURN_ACTIVE_MARKER_FILE = "turn-active.json";

/**
 * Absolute ceiling (ms) beyond which a turn-active signal cannot reflect a
 * real in-flight turn. This is the marker sweep's `hardTtlMs` (`gateway.ts`
 * `sweepStaleTurnActiveMarker` callsite). Exported so the `/model` & `/effort`
 * busy-gate cross-checks the in-memory turn atom and the pending-approval hold
 * against the SAME ceiling it sweeps the marker file at (#3262) — instead of
 * the atom leaking past it and reading as a phantom "active turn" on an idle
 * session.
 */
export const TURN_ACTIVE_HARD_TTL_MS = 10 * 60_000;

/**
 * Idle-sweep threshold (ms): the marker is swept this soon when the caller
 * asserts no turn is in flight. Exported alongside the hard TTL so both
 * bounds have a single source of truth.
 */
export const TURN_ACTIVE_IDLE_SWEEP_MS = 60_000;

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
    mkdirStateSync(stateDir, { recursive: true });
    writeStateFileSync(
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

/**
 * Effective age (ms) of a live turn for the phantom-turn cross-check (#3262):
 * prefer the turn-active liveness marker's mtime age (touched on every
 * tool_use / sub-agent activity, so a genuinely long turn keeps it small),
 * falling back to `now - turnStartedAt` when the marker is absent (e.g. already
 * swept away). Pure so the fallback branch is unit-testable with an injected
 * clock. `markerAgeMs` is the result of `readTurnActiveMarkerAgeMs` (null when
 * the marker is gone).
 */
export function effectiveTurnAgeMs(
  markerAgeMs: number | null,
  turnStartedAt: number,
  now: number,
): number {
  return markerAgeMs ?? now - turnStartedAt;
}
