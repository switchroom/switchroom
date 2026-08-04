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
  chownSync,
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
  scheduleStagingDir: string; // <scheduleDir>/.staging
  skillsDir: string;       // <agentRoot>/skills.d (Phase 2 of #1163)
  skillsStagingDir: string;   // <skillsDir>/.staging
  lockPath: string;        // <agentRoot>/.lock — covers BOTH overlay subdirs
  /** @deprecated Use scheduleStagingDir; preserved for backwards compat. */
  stagingDir: string;
}

export function overlayPathsFor(
  agent: string,
  opts: { root?: string } = {},
): OverlayPaths {
  const base = opts.root
    ? resolve(opts.root, agent)
    : resolve(resolveDualPath(`~/.switchroom/agents/${agent}`));
  const scheduleDir = join(base, "schedule.d");
  const scheduleStagingDir = join(scheduleDir, STAGING_SUBDIR);
  const skillsDir = join(base, "skills.d");
  const skillsStagingDir = join(skillsDir, STAGING_SUBDIR);
  return {
    agentRoot: base,
    scheduleDir,
    scheduleStagingDir,
    skillsDir,
    skillsStagingDir,
    lockPath: join(base, ".lock"),
    // Backwards-compat alias — callers that referenced `stagingDir` get
    // the schedule one (the original semantics). New callers should use
    // the kind-specific names.
    stagingDir: scheduleStagingDir,
  };
}

function ensureDirs(paths: OverlayPaths): void {
  mkdirSync(paths.scheduleDir, { recursive: true });
  mkdirSync(paths.scheduleStagingDir, { recursive: true });
}

function ensureSkillsDirs(paths: OverlayPaths): void {
  mkdirSync(paths.skillsDir, { recursive: true });
  mkdirSync(paths.skillsStagingDir, { recursive: true });
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
  // Pre-create the agentRoot so the lockfile open succeeds. Subdir
  // ensure (`ensureDirs` / `ensureSkillsDirs`) is the caller's
  // responsibility — keeps the lock helper subdir-agnostic so both
  // schedule.d and skills.d writes share the same flock.
  mkdirSync(paths.agentRoot, { recursive: true });
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
 * Process/syscall seams, injectable for tests (unit tests run as an
 * unprivileged UID and cannot chown to a foreign uid; they stub these to
 * record calls and simulate a root euid). Same pattern as
 * `ownershipRuntime` in `src/agents/agent-owned-tree.ts`.
 */
export const overlayWriterRuntime = {
  geteuid: (): number | undefined => process.geteuid?.(),
  chown: (path: string, uid: number, gid: number): void => chownSync(path, uid, gid),
};

/**
 * Align a staged overlay file's ownership to its TARGET directory's owner
 * before the rename publishes it.
 *
 * Why (CLAUDE.md "Root-context editing" rule; #3168 class): the overlay
 * dirs are chowned to the agent's container uid, but the WRITER may run
 * with a different euid — hostd verbs and sudo'd CLIs run as root, the
 * operator's host CLI as uid 1000. A tmp+rename atomic write creates a NEW
 * inode owned by the writer's euid with mode 0600, so the agent (dir
 * owner) gets EACCES on its own cron overlay, the loader skips the file,
 * and its crons silently stop firing until an ownership sweep runs — on
 * the live fleet that window was write→next-`apply`, i.e. weeks (clerk:
 * 2,298 EACCES loader hits, entries dropped throughout).
 *
 * Root writers are fixed here deterministically. An unprivileged foreign
 * writer (operator uid, no CAP_CHOWN) gets EPERM — swallowed; the
 * reconcile/apply ownership sweeps remain the backstop for that case.
 */
function alignStagedOwnerToDir(stagingPath: string, targetDir: string): void {
  try {
    const euid = overlayWriterRuntime.geteuid();
    if (euid === undefined) return; // e.g. Windows — no uid semantics
    const dirStat = statSync(targetDir);
    if (dirStat.uid === euid) return; // same-owner write — already correct
    overlayWriterRuntime.chown(stagingPath, dirStat.uid, dirStat.gid);
  } catch {
    /* best-effort — the reconcile/apply ownership sweeps are the backstop */
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
    const stagingPath = join(paths.scheduleStagingDir, `${slug}.yaml`);
    const finalPath = join(paths.scheduleDir, `${slug}.yaml`);
    const fd = openSync(stagingPath, "w", 0o600);
    try {
      writeSync(fd, yamlText);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    alignStagedOwnerToDir(stagingPath, paths.scheduleDir);
    renameSync(stagingPath, finalPath);
    return finalPath;
  });
}

/**
 * Atomically write a skills-overlay YAML document to
 * `~/.switchroom/agents/<agent>/skills.d/<slug>.yaml`. Mirrors
 * `writeOverlayEntry` but targets the skills.d/ tree. (#1163 Phase 2.)
 */
export function writeSkillsOverlayEntry(
  agent: string,
  slug: string,
  yamlText: string,
  opts: { root?: string } = {},
): string {
  const paths = overlayPathsFor(agent, opts);
  return withAgentLock(paths, () => {
    ensureSkillsDirs(paths);
    const stagingPath = join(paths.skillsStagingDir, `${slug}.yaml`);
    const finalPath = join(paths.skillsDir, `${slug}.yaml`);
    const fd = openSync(stagingPath, "w", 0o600);
    try {
      writeSync(fd, yamlText);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    alignStagedOwnerToDir(stagingPath, paths.skillsDir);
    renameSync(stagingPath, finalPath);
    return finalPath;
  });
}

/** Delete a <slug>.yaml under skills.d. (#1163 Phase 2.) */
export function deleteSkillsOverlayEntry(
  agent: string,
  slug: string,
  opts: { root?: string } = {},
): boolean {
  const paths = overlayPathsFor(agent, opts);
  return withAgentLock(paths, () => {
    const finalPath = join(paths.skillsDir, `${slug}.yaml`);
    if (!existsSync(finalPath)) return false;
    unlinkSync(finalPath);
    return true;
  });
}

/** Enumerate skills overlay files. Mirror of `listOverlayEntries`. */
export function listSkillsOverlayEntries(
  agent: string,
  opts: { root?: string } = {},
): ListedOverlayEntry[] {
  const paths = overlayPathsFor(agent, opts);
  if (!existsSync(paths.skillsDir)) return [];
  const out: ListedOverlayEntry[] = [];
  for (const name of readdirSync(paths.skillsDir)) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const full = join(paths.skillsDir, name);
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
