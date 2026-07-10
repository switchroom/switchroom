/**
 * Web dashboard startup guard — crash-loop backoff + stale single-file
 * bind detection (issue #2915).
 *
 * Background: `switchroom-web` runs with `restart: always` and mounts the
 * operator's `switchroom.yaml` as a SINGLE-FILE bind into
 * `/state/config/switchroom.yaml`. If the source is momentarily absent at
 * (re)create time Docker auto-materialises an empty DIRECTORY at the mount
 * target, and — worse — a plain `docker restart` does NOT re-resolve the
 * bind, so the container keeps a STALE DIRECTORY INODE even after the host
 * path is a normal file again. The server then reads its config, gets
 * `EISDIR`, throws, exits non-zero, and `restart: always` relaunches it
 * immediately — 417 times in the field before anyone noticed.
 *
 * Two independent defences live here, both pure + injectable so they unit
 * test without a container:
 *
 *   1. `detectConfigMountFault` — recognise the directory-inode condition
 *      and produce a LOUD, actionable message that names the real remedy
 *      (a container *recreate*, not a restart).
 *   2. `nextCrashBackoff` — a persisted, bounded exponential backoff so a
 *      persistent startup failure fails loudly ONCE and then PACES the
 *      restarts (seconds, then tens of seconds) instead of hammering the
 *      host hundreds of times. A clean boot resets the counter.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface ConfigMountFault {
  kind: "directory-inode";
  path: string;
  message: string;
}

/**
 * Detect the #2915 stale single-file-bind fault: the config path that MUST
 * be a file has resolved to a DIRECTORY (Docker auto-created an empty dir,
 * or a stale directory inode survived a `docker restart` in the container's
 * mount namespace). Returns null when the path is a normal file or simply
 * absent (absent is a different, self-explanatory error the loader already
 * reports).
 */
export function detectConfigMountFault(
  configPath: string,
  deps: { stat?: (p: string) => { isDirectory(): boolean } } = {},
): ConfigMountFault | null {
  const stat = deps.stat ?? ((p: string) => statSync(p));
  let st: { isDirectory(): boolean };
  try {
    st = stat(configPath);
  } catch {
    return null; // missing / unstat-able — not the directory-inode fault
  }
  if (!st.isDirectory()) return null;
  return {
    kind: "directory-inode",
    path: configPath,
    message:
      `switchroom-web: the config bind source ${configPath} resolved to a DIRECTORY, ` +
      `not a file — reads fail with EISDIR and the server cannot start.\n\n` +
      `Cause: the single-file bind mount was (re)created while the host source was ` +
      `momentarily absent, so Docker auto-created an empty directory, OR a stale ` +
      `directory inode survived a plain \`docker restart\` inside the container's mount ` +
      `namespace (a restart does NOT re-resolve a single-file bind).\n\n` +
      `Remedy: RECREATE the container (not restart) so the bind re-resolves to the file:\n` +
      `    docker compose -p switchroom-web -f ~/.switchroom/web/docker-compose.yml up -d --force-recreate\n` +
      `and if the host source itself is a directory, remove it and restore the file first.`,
  };
}

export interface CrashLoopState {
  /** Consecutive rapid failures within the reset window. */
  count: number;
  /** Epoch ms of the most recent recorded failure. */
  lastTs: number;
}

export interface CrashBackoffOptions {
  /** First backoff step in ms (doubles each consecutive failure). Default 1000. */
  baseMs?: number;
  /** Hard cap on a single backoff, in ms. Default 60_000 (1 min). */
  maxMs?: number;
  /**
   * If the previous failure was longer ago than this, the counter resets
   * (the crash loop is considered broken). Default 300_000 (5 min).
   */
  resetAfterMs?: number;
}

/**
 * Given the prior crash state and the current time, return the updated
 * state and how long to sleep before exiting so `restart: always` doesn't
 * relaunch instantly. Pure — persistence is the caller's job.
 *
 * Backoff is exponential (base, 2×, 4×, …) capped at `maxMs`. A gap longer
 * than `resetAfterMs` since the last failure resets the count to 1 (fresh
 * loop), so an unrelated failure months later doesn't inherit an old
 * exponent.
 */
export function nextCrashBackoff(
  prior: CrashLoopState | null,
  now: number,
  options: CrashBackoffOptions = {},
): { state: CrashLoopState; delayMs: number } {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 60_000;
  const resetAfterMs = options.resetAfterMs ?? 300_000;

  const withinWindow =
    prior !== null && now - prior.lastTs <= resetAfterMs && now >= prior.lastTs;
  const count = withinWindow ? prior!.count + 1 : 1;

  // Exponent uses count-1 so the FIRST failure (count=1) has no penalty:
  // fail loudly once, immediately. Subsequent rapid failures back off.
  const exp = Math.min(count - 1, 30); // clamp to avoid Math.pow overflow
  const delayMs = count <= 1 ? 0 : Math.min(baseMs * 2 ** (exp - 1), maxMs);

  return { state: { count, lastTs: now }, delayMs };
}

/** Read persisted crash state; null on absence / parse failure. */
export function readCrashState(statePath: string): CrashLoopState | null {
  try {
    if (!existsSync(statePath)) return null;
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<CrashLoopState>;
    if (typeof raw.count !== "number" || typeof raw.lastTs !== "number") return null;
    return { count: raw.count, lastTs: raw.lastTs };
  } catch {
    return null;
  }
}

/** Persist crash state (best-effort; a write failure must not itself crash). */
export function writeCrashState(statePath: string, state: CrashLoopState): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* best-effort: the backoff still applied in-process this run */
  }
}

/** Clear crash state after a clean start so the counter resets. */
export function clearCrashState(statePath: string): void {
  try {
    if (existsSync(statePath)) unlinkSync(statePath);
  } catch {
    /* best-effort */
  }
}
