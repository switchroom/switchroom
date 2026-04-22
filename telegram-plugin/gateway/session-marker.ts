/**
 * Gateway session marker — "who/when am I?" identity file recording the
 * current gateway process's PID and startedAt.
 *
 * 2026-04-22 incident: the crash-recovery banner ("⚡ Recovered from
 * unexpected restart. (down ~Ns)") fired every time grammY restarted
 * its long-poll, not every time the gateway process actually restarted.
 * Same PID across all banner-fires; systemd recorded zero lifecycle
 * events.
 *
 * Fix: on startup, write {pid, startedAtMs} to a marker file. Before
 * firing the banner, compare the stored marker to the current process:
 *   - no marker         → true first boot, fire
 *   - PID differs       → real restart, fire
 *   - startedAt differs → same PID reused (rare), still a new process,
 *                         fire
 *   - exact match       → we've been running continuously, suppress
 *                         (this is a grammY poll-restart, not a process
 *                         restart).
 */

import { writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";

export interface SessionMarker {
  pid: number;
  startedAtMs: number;
}

export function writeSessionMarker(path: string, marker: SessionMarker): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(marker), "utf-8");
  renameSync(tmp, path);
}

export function readSessionMarker(path: string): SessionMarker | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionMarker>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAtMs === "number" &&
      Number.isFinite(parsed.pid) &&
      Number.isFinite(parsed.startedAtMs)
    ) {
      return { pid: parsed.pid, startedAtMs: parsed.startedAtMs };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSessionMarker(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* best effort */
  }
}

/**
 * Pure decision: should the "recovered from unexpected restart" banner
 * fire for the current process?
 *
 * Fire when:
 *   - no stored marker (true first boot), OR
 *   - stored PID != current PID (real process restart), OR
 *   - stored startedAt != current startedAt (same PID reused).
 *
 * Suppress when stored === current: we are the same process we were
 * last time the banner logic looked, so any "restart" is happening
 * below the process level (e.g. grammY poll-restart on 409).
 */
export function shouldFireRestartBanner(input: {
  stored: SessionMarker | null;
  current: SessionMarker;
}): boolean {
  const { stored, current } = input;
  if (stored === null) return true;
  if (stored.pid !== current.pid) return true;
  if (stored.startedAtMs !== current.startedAtMs) return true;
  return false;
}
