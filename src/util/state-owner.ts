/**
 * Ownership adoption for files written into an agent's state directory.
 *
 * ## The problem
 *
 * Most switchroom agents run as their own unprivileged uid, so everything a
 * gateway (or hook, or sidecar) writes into `~/.switchroom/agents/<name>/`
 * is owned by that agent and nobody thinks about ownership.
 *
 * A ROOT-TIER agent breaks that assumption. Its container runs as uid 0, so
 * its gateway also runs as uid 0, so every state file it creates lands
 * `root:root` inside a directory owned by the agent's uid. Nothing breaks
 * while every reader in that container is also root — which is exactly what
 * makes it dangerous. The moment a non-root reader appears (the agent is
 * downgraded off root tier, the host operator at uid 1000 reads or rotates
 * the state, a `docker exec -u` inspection), that reader gets EACCES on a
 * file it owns the directory of.
 *
 * That failure is SILENT. It is the same shape as #4371, where root-owned
 * overlay files EACCES'd an agent's in-container schedule loader and dropped
 * its crons for weeks with nothing in any log. `CLAUDE.md` § "Dev flow & PR
 * hygiene" ¶2 already states the rule this module enforces mechanically:
 * a file a root-running process writes into an agent tree MUST end up owned
 * by that agent's uid.
 *
 * ## The fix
 *
 * One helper, used by the write paths, that makes a newly created file adopt
 * the owner of the directory it lives in. Nothing else changes.
 *
 * ## Off the root path this is a no-op — by construction
 *
 * {@link resolveStateOwner} returns `null` immediately when
 * `process.getuid() !== 0`, before touching the filesystem. Every other
 * export short-circuits on that `null`. A non-root gateway therefore issues
 * ZERO extra syscalls: no stat, no open, no chown. That matters because the
 * overwhelming majority of the fleet is non-root and these paths sit in the
 * hot loop (a beacon write every 5s, a heartbeat, a status-pin persist per
 * reconcile).
 *
 * ## Failure is never fatal
 *
 * A chown can fail for reasons that are not the caller's fault — a FUSE or
 * overlay mount that rejects it, a container without `CAP_CHOWN`, a file that
 * vanished under us. Losing the ownership fix is a hygiene regression; losing
 * the WRITE would drop a message or an approval. So every failure here is
 * swallowed, logged ONCE per process (not per path — a 5-second beacon tick
 * would otherwise fill the log), and the write proceeds.
 *
 * ## Symlinks are never followed
 *
 * Every ownership change goes through a file descriptor opened `O_NOFOLLOW`
 * and is applied with `fchown(2)`, never a path-based `chown(2)`. A
 * path-based chown run by root can be redirected by a symlink raced (or
 * pre-planted) at the target and hand an attacker a root-owned chown of an
 * arbitrary inode. `O_NOFOLLOW` + `fchown` closes that: the fd already names
 * the inode, so there is no TOCTOU window between the check and the change.
 * This is the same reasoning as the `fchownSync`-on-the-tempfile-fd rule in
 * `src/util/atomic.ts`.
 *
 * A symlink encountered at a write or adopt target therefore yields `ELOOP`,
 * which is treated as "skip the chown, keep the write" — fail-safe, not
 * fail-closed.
 */

import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fchownSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  type Dirent,
  writeFileSync,
  type MakeDirectoryOptions,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { atomicWriteFileSync } from "./atomic.js";

/** Resolved target ownership for a state directory. */
export interface StateOwner {
  uid: number;
  gid: number;
}

/** `O_NOFOLLOW` where the platform has it; `0` (inert) where it doesn't. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Per-directory owner cache.
 *
 * A `stat(2)` per state write would be a real cost on the beacon tick, and
 * the answer effectively never changes for a live process (the state dir's
 * owner is fixed at scaffold time). A cached miss (`null`) is cached too, so
 * the common "root process, root-owned dir" case also costs one stat total.
 *
 * Staleness is bounded and benign: if the directory's owner is changed under
 * a running gateway, subsequent writes adopt the OLD owner until restart. The
 * boot reconcile then corrects the tree on the next boot.
 */
const ownerCache = new Map<string, StateOwner | null>();

let loggedFailure = false;

/** Default sink — matches the gateway's existing `process.stderr.write` use. */
function defaultLog(line: string): void {
  process.stderr.write(line);
}

/**
 * Log the FIRST ownership failure of the process and nothing after it.
 *
 * One line is enough to diagnose (the errno tells you whether it's a mount,
 * a missing capability, or a symlink); a line per write would be thousands
 * per day on the 5-second beacon tick.
 */
function noteFailure(op: string, path: string, err: unknown, log: (line: string) => void): void {
  if (loggedFailure) return;
  loggedFailure = true;
  const code = (err as NodeJS.ErrnoException).code ?? "";
  log(
    `switchroom state-owner: ${op} could not adopt directory ownership for ${path}` +
      `${code ? ` (${code})` : ""}: ${(err as Error).message}. ` +
      `Continuing; state files may stay owned by the writing uid. ` +
      `Further ownership warnings this process are suppressed.\n`,
  );
}

/**
 * A state file has exactly one name. More than one link to the same inode
 * means somebody else also names it, and chowning it would change ownership
 * of THEIR file — the hardlink analogue of the symlink escape `O_NOFOLLOW`
 * already closes. `fs.protected_hardlinks=1` (the default on the fleet's
 * kernels) already stops an unprivileged user linking a file they don't own,
 * so this is defence in depth rather than the primary control.
 *
 * Directories are exempt: their link count is `2 + subdirectories` by
 * construction, so `nlink > 1` says nothing about them.
 */
function isMultiplyLinked(st: { nlink: number; isDirectory(): boolean }): boolean {
  return !st.isDirectory() && st.nlink > 1;
}

/** Test seam — clears the owner cache and the once-per-process log latch. */
export function _resetStateOwnerCacheForTests(): void {
  ownerCache.clear();
  loggedFailure = false;
}

/**
 * The uid/gid a file written into `dir` should end up owned by, or `null`
 * when nothing needs to change.
 *
 * `null` — the overwhelmingly common case — means "do nothing", and is
 * returned WITHOUT any filesystem call whenever the process is not root.
 */
export function resolveStateOwner(dir: string): StateOwner | null {
  // Fast path, no syscalls: a non-root writer already produces files owned by
  // the uid that owns the tree. `process.getuid` is absent on Windows.
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;

  const cached = ownerCache.get(dir);
  if (cached !== undefined) return cached;

  let owner: StateOwner | null = null;
  try {
    const st = statSync(dir);
    // A root-owned directory is already consistent with root-created files.
    owner = st.uid === 0 && st.gid === 0 ? null : { uid: st.uid, gid: st.gid };
  } catch {
    // Directory missing or unreadable — callers that create it will re-resolve
    // against the parent. Cache the miss so we don't stat on every write.
    owner = null;
  }
  ownerCache.set(dir, owner);
  return owner;
}

/**
 * Give the inode at `path` the ownership of the directory it lives in.
 *
 * Use this for files created by something that cannot be routed through the
 * write helpers below — most importantly SQLite's `-wal` / `-shm` sidecars,
 * which are created by the SQLite C library at connection and checkpoint
 * time, not by any `node:fs` call we control.
 *
 * No-op when not root, when the directory is root-owned, when the file
 * doesn't exist, when it's a symlink, or when the file already has the right
 * owner. Never throws.
 */
export function adoptStateOwnership(
  path: string,
  owner?: StateOwner | null,
  log: (line: string) => void = defaultLog,
): void {
  const target = owner === undefined ? resolveStateOwner(dirname(path)) : owner;
  if (!target) return;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    if (st.uid === target.uid && st.gid === target.gid) return;
    if (isMultiplyLinked(st)) return;
    fchownSync(fd, target.uid, target.gid);
  } catch (err) {
    // ENOENT is the normal "sidecar not created yet" case, not a fault.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      noteFailure("adopt", path, err, log);
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Ownership adoption against an ALREADY-OPEN descriptor.
 *
 * The best available form, and the one to prefer wherever the caller has an
 * fd: there is no path to re-resolve, so a symlink cannot be raced in and
 * TOCTOU is structurally impossible. Callers that write via
 * `openSync`+`writeFileSync(fd, …)`+`rename` (the beacon, the durable
 * tmp+rename writers) should call this on the tempfile fd BEFORE the rename,
 * so the file is never visible at its final name under the wrong owner.
 *
 * `dir` is the directory whose ownership should be adopted — for a tempfile,
 * the directory it will be renamed within.
 *
 * No-op when not root or when the directory is root-owned. Never throws.
 */
export function adoptStateOwnershipFd(
  fd: number,
  dir: string,
  log: (line: string) => void = defaultLog,
): void {
  const owner = resolveStateOwner(dir);
  if (!owner) return;
  try {
    const st = fstatSync(fd);
    if (st.uid === owner.uid && st.gid === owner.gid) return;
    fchownSync(fd, owner.uid, owner.gid);
  } catch (err) {
    noteFailure("adopt-fd", dir, err, log);
  }
}

/**
 * Adopt ownership of a SQLite database and both of its WAL sidecars.
 *
 * `history.db` / `registry.db` create `<db>-wal` and `<db>-shm` LAZILY: not
 * at `new Database(...)` but when WAL mode is first engaged, and again after
 * `PRAGMA wal_checkpoint(TRUNCATE)` deletes and re-creates them. Both call
 * sites already re-apply `chmod` for exactly this reason; this rides the same
 * hook so ownership and mode stay in step.
 *
 * Missing sidecars are silently skipped (see {@link adoptStateOwnership}).
 */
export function adoptSqliteOwnership(
  dbPath: string,
  log: (line: string) => void = defaultLog,
): void {
  const owner = resolveStateOwner(dirname(dbPath));
  if (!owner) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    adoptStateOwnership(dbPath + suffix, owner, log);
  }
}

/**
 * `mkdirSync(path, { recursive: true, ... })` that hands every directory it
 * actually CREATES to the owner of the nearest pre-existing ancestor.
 *
 * `mkdirSync` with `recursive` returns the first path element it created (or
 * `undefined` when everything already existed), which is precisely the set we
 * need to walk: existing directories are left alone.
 */
export function mkdirStateSync(
  path: string,
  options: MakeDirectoryOptions = { recursive: true },
  log: (line: string) => void = defaultLog,
): void {
  const first = mkdirSync(path, { ...options, recursive: true });
  if (first === undefined) return; // nothing created — nothing to adopt
  // The owner comes from the parent of the shallowest directory we created:
  // that one already existed, so it carries the tree's intended ownership.
  const owner = resolveStateOwner(dirname(first));
  if (!owner) return;
  // Adopt every component from `first` down to `path`.
  let current = first;
  adoptStateOwnership(current, owner, log);
  const tail = relative(first, path);
  if (tail === "" || tail.startsWith("..")) return;
  for (const part of tail.split(sep)) {
    if (part === "") continue;
    current = join(current, part);
    adoptStateOwnership(current, owner, log);
  }
}

/**
 * `writeFileSync` that leaves the file owned by the directory's owner.
 *
 * Off the root path this IS `writeFileSync` — same call, same arguments, no
 * wrapper syscalls.
 *
 * On the root path the write goes through an `O_NOFOLLOW` descriptor so the
 * `fchown` targets the exact inode we wrote, with no path resolved twice. If
 * the target is a symlink (`ELOOP`), we log once and fall back to the plain
 * write WITHOUT a chown: refusing to chown through a symlink is the security
 * requirement, refusing to write is not — dropping a state write can drop an
 * approval or an owed reply.
 */
export function writeStateFileSync(
  path: string,
  data: string | Buffer,
  options?: { mode?: number },
  log: (line: string) => void = defaultLog,
): void {
  const owner = resolveStateOwner(dirname(path));
  if (!owner) {
    writeFileSync(path, data, options);
    return;
  }
  const mode = options?.mode ?? 0o666;
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, mode);
    writeFileSync(fd, buf);
    try {
      fchownSync(fd, owner.uid, owner.gid);
    } catch (err) {
      noteFailure("write", path, err, log);
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      fd = null;
    }
    // Could not open our way (symlink at the target, or an fs that rejects
    // the flag set). The write itself must still land.
    noteFailure("write", path, err, log);
    writeFileSync(path, data, options);
    return;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * `appendFileSync` that leaves the file owned by the directory's owner.
 *
 * Appending to an EXISTING file never changes its owner, so the only case
 * that matters is the first append, which creates the file. Off the root path
 * this IS `appendFileSync`.
 */
export function appendStateFileSync(
  path: string,
  data: string | Buffer,
  options?: { mode?: number },
  log: (line: string) => void = defaultLog,
): void {
  const owner = resolveStateOwner(dirname(path));
  if (!owner) {
    appendFileSync(path, data, options);
    return;
  }
  const existed = existsSync(path);
  appendFileSync(path, data, options);
  if (!existed) adoptStateOwnership(path, owner, log);
}

/**
 * {@link atomicWriteFileSync} with the destination directory's ownership.
 *
 * The underlying primitive already flips ownership on the TEMPFILE fd before
 * the rename, which is the only correct ordering: chowning the destination
 * path after the rename would follow a symlink raced into place there.
 */
export function atomicWriteStateFileSync(
  path: string,
  data: string | Buffer,
  mode = 0o600,
  log: (line: string) => void = defaultLog,
): void {
  const owner = resolveStateOwner(dirname(path));
  if (!owner) {
    atomicWriteFileSync(path, data, mode);
    return;
  }
  atomicWriteFileSync(path, data, {
    mode,
    uid: owner.uid,
    gid: owner.gid,
    onChownError: err => noteFailure("atomic-write", path, err, log),
  });
}

/** Result of a {@link reconcileStateDirOwnership} pass. */
export interface StateOwnershipReconcileResult {
  /** Entries examined (files + directories). */
  scanned: number;
  /** Entries whose ownership was changed. */
  adopted: number;
  /** Symlinks skipped without being followed or chowned. */
  symlinksSkipped: number;
  /** True when the walk stopped early on `maxEntries` or `maxDepth`. */
  truncated: boolean;
}

const EMPTY_RECONCILE: StateOwnershipReconcileResult = {
  scanned: 0,
  adopted: 0,
  symlinksSkipped: 0,
  truncated: false,
};

/**
 * Bounded one-pass ownership reconcile over a state directory.
 *
 * ### Why this exists alongside the write helpers
 *
 * The helpers above fix ownership going FORWARD, at the write sites they are
 * wired into. They do nothing about (a) the files a previously-root gateway
 * already left behind — a live root-tier agent was measured with 1,344 of
 * them — and (b) files created by a writer outside this process, e.g. a hook
 * or a sidecar that also runs as root. This pass covers both.
 *
 * ### Why it is not a substitute for the write helpers
 *
 * A root gateway re-creates its state files continuously (a beacon every five
 * seconds), so a sweep alone would be a band-aid that is stale seconds after
 * it runs. The helpers are the fix; this is the backfill.
 *
 * ### Bounds — deliberate, and load-bearing
 *
 * - **Never follows a symlink.** A real agent state tree contains symlinks
 *   pointing OUTSIDE the agent directory (e.g. `home/.switchroom ->
 *   /home/<operator>/.switchroom`). Walking or chowning through one would
 *   re-own the operator's real home. `readdir(withFileTypes)` classifies via
 *   `lstat`, so a symlink is identified without ever being resolved, and it is
 *   counted and skipped — not chowned, not descended into.
 * - **Depth-capped** (`maxDepth`, default 4) — enough for the state dir's own
 *   subdirectories (`voice-cache/`, `approved/`, `inbox/`, `buzz/`) without
 *   turning into an unbounded tree walk.
 * - **Entry-capped** (`maxEntries`, default 5000) — a runaway directory
 *   (thousands of cached voice clips) cannot stall boot.
 *
 * Never throws. Returns a zero result without any filesystem call when the
 * process is not root.
 */
export function reconcileStateDirOwnership(
  dir: string,
  opts: { maxDepth?: number; maxEntries?: number; log?: (line: string) => void } = {},
): StateOwnershipReconcileResult {
  const owner = resolveStateOwner(dir);
  if (!owner) return { ...EMPTY_RECONCILE };

  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 5000;
  const log = opts.log ?? defaultLog;
  const result: StateOwnershipReconcileResult = { ...EMPTY_RECONCILE };

  const walk = (current: string, depth: number): void => {
    if (result.scanned >= maxEntries) {
      result.truncated = true;
      return;
    }
    if (depth > maxDepth) {
      result.truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      noteFailure("reconcile", current, err, log);
      return;
    }
    for (const entry of entries) {
      if (result.scanned >= maxEntries) {
        result.truncated = true;
        return;
      }
      // lstat-derived: a symlink is NEVER resolved, descended, or chowned.
      if (entry.isSymbolicLink()) {
        result.symlinksSkipped++;
        continue;
      }
      const child = join(current, entry.name);
      result.scanned++;
      if (adoptAndReport(child, owner, log)) result.adopted++;
      if (entry.isDirectory()) walk(child, depth + 1);
    }
  };

  // The state directory itself is the owner reference, so it needs no adopt.
  walk(dir, 1);
  return result;
}

/**
 * Adopt and report whether anything actually changed — the reconcile pass
 * needs the "did I change it" bit that {@link adoptStateOwnership} discards.
 */
function adoptAndReport(path: string, owner: StateOwner, log: (line: string) => void): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    if (st.uid === owner.uid && st.gid === owner.gid) return false;
    if (isMultiplyLinked(st)) return false;
    fchownSync(fd, owner.uid, owner.gid);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      noteFailure("reconcile", path, err, log);
    }
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}
