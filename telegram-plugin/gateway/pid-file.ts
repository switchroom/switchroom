/**
 * Gateway PID file — records the live gateway's PID so the in-agent
 * plugin (server.ts dual-mode probe) can distinguish "gateway is
 * genuinely gone, fall back to legacy monolith" from "gateway is alive
 * but the socket blinked (EAGAIN, accept-backlog, handshake race)".
 *
 * 2026-04-22 incident: a transient Bun.connect failure against a LIVE
 * gateway tripped the legacy-fallback path in server.ts, spawning a
 * second grammY long-poll client. That client 409'd against the
 * gateway's own poller, which fired a grammY poll-restart, which fired
 * the "⚡ Recovered from unexpected restart" banner — without any
 * actual process restart (same PID across 8 minutes, systemd logged
 * zero lifecycle events).
 *
 * Rule: fall back to legacy ONLY if no PID file exists OR the recorded
 * PID is dead. If the PID is alive, retry the socket with backoff.
 */

import { writeFileSync, readFileSync, unlinkSync, renameSync } from "node:fs";

/** Shape of the PID file on disk. */
export interface GatewayPidRecord {
  pid: number;
  /** epoch ms when this process started (Date.now() at write time) */
  startedAtMs: number;
}

/**
 * Atomic write via tmp+rename so a crashed writer can't leave a
 * half-written file that subsequent readers mistake for a live PID.
 */
export function writePidFile(path: string, record: GatewayPidRecord): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record), "utf-8");
  renameSync(tmp, path);
}

export function readPidFile(path: string): GatewayPidRecord | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GatewayPidRecord>;
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

export function clearPidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* best effort */
  }
}

/**
 * Returns true if the PID refers to a live process. Uses kill(pid, 0)
 * which sends no signal but throws ESRCH if the process is gone.
 * EPERM means the process exists but is owned by another user — we
 * conservatively treat that as alive (don't fall back to legacy).
 */
export function isPidAlive(
  pid: number,
  killFn: (p: number, sig: number) => void = (p, s) => process.kill(p, s),
): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    killFn(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Pure decision function for the dual-mode probe. Extracted so the
 * fallback policy is testable in isolation.
 *
 * Fall back to legacy ONLY when we have strong evidence the gateway is
 * truly gone — no PID file OR a dead PID. A transient socket miss
 * against a live PID means "retry the socket", not "spawn a second
 * poller".
 */
export function shouldFallBackToLegacy(input: {
  socketReachable: boolean;
  pidFileExists: boolean;
  pidAlive: boolean;
}): boolean {
  if (input.socketReachable) return false;
  if (!input.pidFileExists) return true;
  return !input.pidAlive;
}
