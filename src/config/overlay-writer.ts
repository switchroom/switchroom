/**
 * Per-agent overlay-file writer (switchroom #1163, Phase E).
 *
 * Atomic write helpers that put YAML fragments under
 *   ~/.switchroom/agents/<name>/schedule.d/<slug>.yaml
 * — the same directory the overlay-loader (Phase B) reads from, so a
 * write here is visible to the next config-resolve cycle.
 *
 * (Note on path: the original plan called for `~/.switchroom/overlays/...`
 * but the existing loader reads from `~/.switchroom/agents/...`. We
 * align with the loader so writes are visible to reads. A future PR
 * may relocate both in lockstep.)
 *
 * Atomicity:
 *   - Write to `<dir>/.staging/<slug>.yaml`
 *   - `fsync` the staged file
 *   - `renameSync` into `<dir>/<slug>.yaml`
 *
 *   A crash between staging-write and rename leaves the staging file
 *   behind and the real path untouched; the loader globs `*.yaml` at
 *   the dir root and never recurses into `.staging/`. A subsequent
 *   write of the same slug overwrites the staging file before rename.
 *
 * Per-agent serialization:
 *   - flock on `~/.switchroom/agents/<name>/.lock` around the whole
 *     write/delete sequence. Concurrent writes for the same agent
 *     are serialized; concurrent writes for different agents do not
 *     contend.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { resolveDualPath } from "./paths.js";

const STAGING_SUBDIR = ".staging";

export interface OverlayPaths {
  agentRoot: string;       // ~/.switchroom/agents/<name>
  scheduleDir: string;     // <agentRoot>/schedule.d
  stagingDir: string;      // <scheduleDir>/.staging
  lockPath: string;        // <agentRoot>/.lock
}

export function overlayPathsFor(
  agent: string,
  opts: { root?: string } = {},
): OverlayPaths {
  const base = opts.root
    ? resolve(opts.root, agent)
    : resolve(resolveDualPath(`~/.switchroom/agents/${agent}`));
  const scheduleDir = join(base, "schedule.d");
  return {
    agentRoot: base,
    scheduleDir,
    stagingDir: join(scheduleDir, STAGING_SUBDIR),
    lockPath: join(base, ".lock"),
  };
}

function ensureDirs(paths: OverlayPaths): void {
  mkdirSync(paths.scheduleDir, { recursive: true });
  mkdirSync(paths.stagingDir, { recursive: true });
}

/**
 * Acquire a per-agent exclusive flock for the duration of `fn`.
 *
 * Uses `flock(2)` via a Node `openSync` + `fcntl` shim. Node's stdlib
 * doesn't expose flock; we use `proper-lockfile` semantics by creating
 * an exclusive lockfile rooted at `lockPath`. The lock is best-effort
 * advisory — operators cooperating with the protocol are protected.
 */
function withAgentLock<T>(paths: OverlayPaths, fn: () => T): T {
  ensureDirs(paths);
  // Simple O_EXCL-based lock with a stale-detection window. We retry
  // briefly to avoid spurious failures when two writers race; longer
  // waits are caller's responsibility.
  const start = Date.now();
  const TIMEOUT_MS = 5000;
  let fd: number | null = null;
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      fd = openSync(paths.lockPath, "wx");
      break;
    } catch (err) {
      // EEXIST → another writer holds. Sleep a tick and retry.
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      // Stale-lock detection: if the lockfile is >30s old, reclaim it.
      try {
        const age = Date.now() - statSync(paths.lockPath).mtimeMs;
        if (age > 30_000) {
          unlinkSync(paths.lockPath);
          continue;
        }
      } catch {
        /* fall through to retry */
      }
      // brief sleep
      const end = Date.now() + 25;
      while (Date.now() < end) { /* spin */ }
    }
  }
  if (fd === null) {
    throw new Error(
      `overlay-writer: could not acquire lock ${paths.lockPath} within ${TIMEOUT_MS}ms`,
    );
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(paths.lockPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Atomically write a YAML document to <slug>.yaml. Returns the absolute
 * path of the final on-disk file.
 */
export function writeOverlayEntry(
  agent: string,
  slug: string,
  yamlText: string,
  opts: { root?: string } = {},
): string {
  const paths = overlayPathsFor(agent, opts);
  return withAgentLock(paths, () => {
    ensureDirs(paths);
    const stagingPath = join(paths.stagingDir, `${slug}.yaml`);
    const finalPath = join(paths.scheduleDir, `${slug}.yaml`);
    const fd = openSync(stagingPath, "w", 0o600);
    try {
      writeSync(fd, yamlText);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stagingPath, finalPath);
    return finalPath;
  });
}

/**
 * Delete a <slug>.yaml under schedule.d. Returns true if a file was
 * removed; false if nothing matched (idempotent caller-side).
 */
export function deleteOverlayEntry(
  agent: string,
  slug: string,
  opts: { root?: string } = {},
): boolean {
  const paths = overlayPathsFor(agent, opts);
  return withAgentLock(paths, () => {
    const finalPath = join(paths.scheduleDir, `${slug}.yaml`);
    if (!existsSync(finalPath)) return false;
    unlinkSync(finalPath);
    return true;
  });
}

export interface ListedOverlayEntry {
  slug: string;
  path: string;
  raw: string;
}

/**
 * Enumerate the current overlay files for an agent. Reads file content
 * eagerly so a caller can match by `name:` or `cron_hash`. Ignores
 * `.staging/` and non-yaml entries.
 */
export function listOverlayEntries(
  agent: string,
  opts: { root?: string } = {},
): ListedOverlayEntry[] {
  const paths = overlayPathsFor(agent, opts);
  if (!existsSync(paths.scheduleDir)) return [];
  const out: ListedOverlayEntry[] = [];
  for (const name of readdirSync(paths.scheduleDir)) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const full = join(paths.scheduleDir, name);
    try {
      const raw = readFileSync(full, "utf-8");
      const slug = name.replace(/\.ya?ml$/i, "");
      out.push({ slug, path: full, raw });
    } catch {
      /* unreadable file — skip */
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
