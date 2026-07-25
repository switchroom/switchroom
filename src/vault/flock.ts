/**
 * Vault writer lock — PID-file flock replacing `proper-lockfile`.
 *
 * Background (#964 / plan v3 §4 / §11). v0.7.12 (#955) added flock to
 * `saveVault` via `proper-lockfile`, which creates a sentinel directory
 * `vault.enc.lock/` next to the file. That worked but missed three
 * properties #964 calls out:
 *
 *   1. **PID exposure.** plan v3 §11 wanted contention errors of shape
 *      `vault busy: held by pid <N> path <P>`. proper-lockfile's
 *      sentinel-dir doesn't surface the holder PID anywhere readable,
 *      so we shipped a worse message ("another writer holds the lock
 *      at <path>") and lost forensic ground.
 *   2. **Ad-hoc tooling.** A sentinel directory is only honored by
 *      other proper-lockfile callers. Operators shelling in with a
 *      different lock tool (`flock(1)`, lsof, /proc/locks) see nothing.
 *   3. **Crash recovery.** proper-lockfile auto-recovers stale locks
 *      via mtime + pid liveness, but that logic lives inside the
 *      library — no other consumer can replicate it without reading
 *      proper-lockfile internals.
 *
 * The issue suggested native `fcntl(F_SETLK)` via N-API or FFI. That
 * IS the most honest kernel-backed primitive, but it adds a native
 * build step (broken without node-gyp present, problematic on bun
 * vs node, cross-arch headache) for a problem where 99% of contention
 * is between *our own processes*. So this module takes a no-deps
 * middle path:
 *
 *   - Lock is a **regular file** (not a directory) at `<vaultPath>.lock`.
 *   - Acquisition is `openSync(path, O_WRONLY | O_CREAT | O_EXCL)` —
 *     the kernel does the atomic "create-if-not-exists" check.
 *   - On success we write `<pid>\n<ts_ms>\n<argv0>\n` and fsync. The
 *     content is human-readable; any peer or operator can `cat` it.
 *   - On EEXIST we read the existing file, parse the holder PID, and
 *     check liveness via `/proc/<pid>` (Linux) or `kill(pid, 0)`
 *     (portable). A dead PID = stale lock; we unlink and retry.
 *   - Contention error embeds the holder PID + acquired-ago seconds
 *     per plan v3 §11.
 *
 * Migration from v0.7.14: an in-flight v0.7.14 sentinel-DIR at the
 * lock path looks the same as a never-released file to the new
 * acquirer. The acquire path handles this lazily — if openSync fails
 * with EISDIR (path exists as a directory), the dir is a stale v0.7.14
 * artifact (no v0.7.15+ writer makes a dir), so we rmdir it and retry.
 * Safe because v0.7.15 binary replacement requires a service restart,
 * which terminates any v0.7.14 process that could legitimately have
 * been mid-write.
 */

import {
  existsSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  constants as fsConstants,
} from "node:fs";

/** Default retry budget — matches the v0.7.12 number for behavioral parity. */
export const DEFAULT_LOCK_RETRY_MS = 5000;

/** Path suffix appended to the protected file. */
export function lockPathFor(vaultPath: string): string {
  return `${vaultPath}.lock`;
}

/** Parsed holder metadata read from a live lock file. */
export interface LockHolder {
  /** PID of the writer that currently holds the lock. */
  pid: number;
  /** Wallclock time (ms since epoch) when the lock was acquired. */
  acquiredAtMs: number;
  /** argv[0] of the holder process, best-effort. May be empty string. */
  argv0: string;
}

/**
 * Read holder metadata from a lock file. Returns `null` on any parse or
 * read failure (caller treats null as "unknown holder"; the error
 * message degrades from "held by pid 12345" to "held by another writer"
 * but doesn't break correctness).
 */
export function readLockHolder(lockPath: string): LockHolder | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const lines = raw.split("\n");
    const pid = Number.parseInt(lines[0] ?? "", 10);
    const acquiredAtMs = Number.parseInt(lines[1] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(acquiredAtMs) || acquiredAtMs <= 0) return null;
    return { pid, acquiredAtMs, argv0: lines[2] ?? "" };
  } catch {
    return null;
  }
}

/**
 * Liveness check for a held-lock PID. Linux uses `/proc/<pid>`
 * existence (preferred — `kill(0)` has portability quirks around
 * privilege boundaries). Other platforms fall back to `kill(pid, 0)`,
 * which raises ESRCH when the process is gone.
 */
function pidIsLive(pid: number): boolean {
  if (process.platform === "linux") {
    return existsSync(`/proc/${pid}`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a Linux process's start time from `/proc/<pid>/stat` field 22
 * (in clock ticks since boot — `man 5 proc` "starttime"). Combined
 * with the system boot time (`/proc/stat:btime`, seconds since epoch)
 * we get the wallclock millisecond when the process started.
 *
 * Returns `null` on non-Linux, missing PID, or parse failure (caller
 * treats null as "unknown start time" and conservatively assumes the
 * PID may be the original holder).
 *
 * Used by `pidIsOriginalHolder` to defend against PID reuse:
 * if the running process started AFTER the lock was acquired, the
 * PID was reused and the lock is stale. Closes #976.
 */
/**
 * Pure parser for /proc/<pid>/stat — split out from {@link pidStartTimeMs}
 * so the regression cases (notably comm fields containing literal `)`,
 * see #989) can be unit-tested without mocking the filesystem.
 *
 * Returns the process start time in epoch-milliseconds, or null if
 * either input is malformed / outside the sanity window.
 *
 * @param statLine    The raw single line read from /proc/<pid>/stat.
 * @param procStat    The raw contents of /proc/stat (we need the `btime` line).
 * @param now         Current epoch-ms — accepted as a param so tests don't depend on wall-clock.
 */
export function parseProcStartTimeMs(
  statLine: string,
  procStat: string,
  now: number,
): number | null {
  // The comm field (field 2 of /proc/<pid>/stat) is wrapped in parens
  // and can contain any byte except null — including literal `)`. The
  // canonical way to skip it is `lastIndexOf(")")` because the comm
  // string is guaranteed to be followed by ` <state> …`, and `state`
  // is one of " RSDZTtWXxKWPI" — none of which contain `)`. So the
  // LAST `)` in the line always terminates the comm field.
  const tailStart = statLine.lastIndexOf(")");
  if (tailStart < 0) return null;
  const tokens = statLine.slice(tailStart + 1).trim().split(/\s+/);
  // After the closing `)`, the next field is `state` (index 0 of
  // tokens, which corresponds to field 3 of /proc/<pid>/stat).
  // starttime is field 22, so index 22 - 3 = 19.
  const starttimeTicks = Number.parseInt(tokens[19] ?? "", 10);
  if (!Number.isFinite(starttimeTicks)) return null;

  // Boot wallclock (seconds since epoch) — `btime` in /proc/stat.
  const btimeMatch = procStat.match(/^btime\s+(\d+)/m);
  if (!btimeMatch) return null;
  const bootEpochSec = Number.parseInt(btimeMatch[1], 10);
  if (!Number.isFinite(bootEpochSec)) return null;

  // USER_HZ (clock ticks per second). On Linux this is almost always
  // 100 (`getconf CLK_TCK`); we can't read it from /proc directly
  // but the constant has been 100 on every common distro for 20+
  // years. If this ever changes we surface "unknown start time" by
  // returning null via the sanity check below rather than computing
  // a wrong answer.
  const USER_HZ = 100;
  const startEpochMs = bootEpochSec * 1000 + (starttimeTicks / USER_HZ) * 1000;

  // Sanity range: process start must be between boot time and now
  // (with a 5s slop for clock skew / leap-second weirdness). A
  // result outside that band suggests USER_HZ drift, parsing bug,
  // or a /proc impostor — return null and let the caller fall
  // back to the conservative "treat as live" path.
  const bootEpochMs = bootEpochSec * 1000;
  const SLOP_MS = 5000;
  if (startEpochMs < bootEpochMs - SLOP_MS || startEpochMs > now + SLOP_MS) {
    return null;
  }
  return Math.floor(startEpochMs);
}

/**
 * Wall-clock ms at which the process at `pid` started, or null when it cannot
 * be determined (non-Linux, no such pid, unparseable /proc).
 *
 * Exported because it is the repo's ONE correct answer to "is the process at
 * this pid still the process I recorded?" — `kill(pid, 0)` alone cannot tell a
 * surviving holder from an unrelated process that inherited the pid. Also used
 * by the rollout pin journal (`src/cli/rollout-pin-journal.ts`), where the pid
 * is recorded inside a container: PID namespaces restart at 1, so after a
 * container recreate the recorded pid is very likely occupied by an unrelated
 * live process and a bare liveness probe answers "alive" essentially always.
 */
export function pidStartTimeMs(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
    const procStat = readFileSync("/proc/stat", "utf8");
    return parseProcStartTimeMs(statLine, procStat, Date.now());
  } catch {
    return null;
  }
}

/**
 * Defense against PID reuse (#976). If `pidIsLive(holder.pid)` is
 * true but the running process at `holder.pid` started AFTER
 * `holder.acquiredAtMs`, the PID has been reused by a fresh
 * (unrelated) process and the lock is stale.
 *
 * Returns:
 *   - true  → the process at this PID started before or at the time
 *             the lock was acquired (could be the original holder, or
 *             we can't tell — be conservative, treat as live).
 *   - false → the process at this PID started after the lock was
 *             acquired → PID reuse → stale lock.
 *
 * Conservative on unknown: returns true (treat as live) if we can't
 * read /proc/<pid>/stat. False positives (treating a reused PID as
 * live) cause a 5s busy-wait. False negatives (treating a live PID
 * as dead) could double-grab the lock — much worse. So unknown is
 * always "live".
 */
function pidIsOriginalHolder(holder: LockHolder): boolean {
  const startMs = pidStartTimeMs(holder.pid);
  if (startMs === null) return true; // conservative
  // Tolerance: process start times are 1-tick (10ms on USER_HZ=100)
  // granularity; the lock's acquiredAtMs is millisecond-precision
  // from before the writeSync. Allow a 100ms slop so we don't
  // false-positive on a process that legitimately wrote its own
  // lockfile within the same tick as starting.
  return startMs <= holder.acquiredAtMs + 100;
}

/**
 * Threshold for the unparseable-lockfile + mtime-stale recovery
 * path. Set well above any realistic retry budget so a normal
 * wait loop never trips it — only files that pre-date the current
 * acquirer's wait are considered "definitely stale". The check
 * uses `max(STALE_MTIME_FLOOR_MS, budgetMs * 2)` so callers with
 * huge budgets (test stress, long broker-vs-CLI contention)
 * still get a safe margin.
 */
const STALE_MTIME_FLOOR_MS = 10_000;

/**
 * Returns true if the lock file's mtime is older than the
 * stale threshold (see STALE_MTIME_FLOOR_MS). Used by the
 * unparseable-lockfile + mtime-stale recovery path (#977): if
 * the holder content can't be parsed AND the file is much older
 * than the current wait budget, no live writer could plausibly
 * still be using it — almost certainly a process that crashed
 * mid-write of the metadata block.
 *
 * Returns false on any stat failure (caller treats this as "fresh,
 * keep waiting") rather than null so the calling expression stays
 * boolean-typed.
 */
function lockFileMtimeIsOlderThan(lockPath: string, budgetMs: number): boolean {
  try {
    const s = statSync(lockPath);
    const threshold = Math.max(STALE_MTIME_FLOOR_MS, budgetMs * 2);
    return Date.now() - s.mtimeMs > threshold;
  } catch {
    return false;
  }
}

/**
 * Best-effort cleanup of a v0.7.14 sentinel-DIRECTORY lock at the
 * given path. Removes the directory's contents (proper-lockfile may
 * leave one or two files inside) then rmdir's it. Returns true on
 * success or if nothing was there.
 *
 * Refuses to migrate (returns false) if ANY file inside the sentinel
 * dir has an mtime newer than `SENTINEL_DIR_RECENT_WRITE_MS` — that
 * suggests a v0.7.14 writer might actually still be using the lock
 * (the standard `switchroom update` flow recreates containers and
 * SIGTERMs v0.7.14 writers, so this is rare, but operator-side
 * manual upgrades can leave a window where the v0.7.15 host CLI is
 * on PATH while the v0.7.14 broker is still mid-write). Closes #979.
 *
 * Caller treats a false return as "fall through to the contention
 * path" so we don't busy-loop. After the recent-write window
 * passes (or the v0.7.14 writer is killed), the next acquire
 * succeeds.
 */
const SENTINEL_DIR_RECENT_WRITE_MS = 60_000;

function clearStaleSentinelDir(lockPath: string): boolean {
  try {
    if (!existsSync(lockPath)) return true;
    const s = statSync(lockPath);
    if (!s.isDirectory()) return true; // already a file — nothing to do

    // Defensive: if any file inside has been written recently, a
    // v0.7.14 writer may still be active. Refuse migration; caller
    // falls through to contention.
    //
    // KNOWN TOCTOU: a v0.7.14 writer can create a file between the
    // recent-write readdir below and the unlink loop further down.
    // Accepted because (a) the migration path is only relevant
    // during the v0.7.14 → v0.7.15 upgrade window, (b) the standard
    // `switchroom update` flow SIGTERMs the v0.7.14 broker before
    // the v0.7.15 host CLI runs, and (c) the only way the race
    // matters is if the v0.7.14 writer is actively writing at
    // exactly the migration moment — operators are documented to
    // bounce the broker first if they upgrade the CLI manually.
    // See #979 for the upgrade-window operator note.
    const now = Date.now();
    for (const entry of readdirSync(lockPath)) {
      try {
        const childStat = statSync(`${lockPath}/${entry}`);
        if (now - childStat.mtimeMs < SENTINEL_DIR_RECENT_WRITE_MS) {
          return false;
        }
      } catch { /* */ }
    }

    for (const entry of readdirSync(lockPath)) {
      try { unlinkSync(`${lockPath}/${entry}`); } catch { /* */ }
    }
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive lock on `vaultPath`. Blocks (via Atomics.wait)
 * until acquired or the retry budget expires. Returns a release
 * function — call it from `finally{}` to unlink the lock file.
 *
 * @throws VaultBusyError if the budget expires with the lock still
 *   held. The error message names the holder PID per plan v3 §11.
 */
export function acquireLock(
  vaultPath: string,
  options: { budgetMs?: number } = {},
): { release: () => void } {
  const budgetMs = options.budgetMs ?? DEFAULT_LOCK_RETRY_MS;
  const lockPath = lockPathFor(vaultPath);
  const deadline = Date.now() + budgetMs;
  // SharedArrayBuffer-backed Atomics.wait sleeps the current thread
  // without burning CPU. Same shape as the previous proper-lockfile
  // retry loop.
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

  while (true) {
    let fd: number | null = null;
    try {
      fd = openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "";
      if (code === "EEXIST") {
        // Path exists. It might be:
        //   (a) a live PID-file lock from a peer writer → wait
        //   (b) a stale PID-file lock from a dead holder → unlink + retry
        //   (c) a v0.7.14 sentinel DIRECTORY → migrate to file
        //
        // statSync tells us (c) vs (a/b). O_EXCL doesn't return
        // EISDIR — the kernel checks existence before type — so we
        // do the type-check ourselves in the EEXIST branch.
        let isDir = false;
        try { isDir = statSync(lockPath).isDirectory(); } catch { /* */ }
        if (isDir) {
          // v0.7.14 sentinel-dir migration — see file header. Clear
          // it and retry immediately (no sleep — this is a one-shot
          // migration step, not contention).
          if (clearStaleSentinelDir(lockPath)) continue;
          // clearStaleSentinelDir returned false — couldn't remove
          // the dir (permission error, races with another acquirer).
          // Fall through to the contention path so we don't busy-loop.
        }

        // Regular file: PID-file lock. Inspect liveness.
        const holder = readLockHolder(lockPath);

        // Three stale-recovery paths, in order of how confidently we
        // can call the lock dead:
        //   1. holder PID dead (kill(0)/proc check) — fastest signal.
        //   2. holder PID alive but the process started AFTER the
        //      lock was acquired — PID reuse (#976).
        //   3. lockfile content unparseable AND file's mtime is older
        //      than the retry budget — almost certainly a writer that
        //      crashed mid-write of the metadata block (#977).
        const isDeadPid = holder !== null && !pidIsLive(holder.pid);
        const isReusedPid = holder !== null && pidIsLive(holder.pid) && !pidIsOriginalHolder(holder);
        const isUnparseableAndOld = holder === null && lockFileMtimeIsOlderThan(lockPath, budgetMs);
        if (isDeadPid || isReusedPid || isUnparseableAndOld) {
          // Stale lock — best-effort unlink + retry. If another
          // racing acquirer beats us to the unlink, the next loop
          // iteration's openSync just contends again normally.
          try { unlinkSync(lockPath); } catch { /* lost the race */ }
          continue;
        }

        if (Date.now() >= deadline) {
          // Budget expired. Build the diagnostic message.
          throw makeBusyError(vaultPath, lockPath, holder, budgetMs);
        }
        // 100ms backoff between retries — matches the v0.7.12 cadence.
        Atomics.wait(sleepBuf, 0, 0, 100);
        continue;
      } else {
        // Some other open error (EACCES, ENOENT on parent dir, etc.).
        // Don't swallow — the caller needs the real reason.
        throw err;
      }
    }

    // Acquired. Write holder metadata.
    try {
      const meta = `${process.pid}\n${Date.now()}\n${process.argv[1] ?? ""}\n`;
      writeSync(fd, meta);
      fsyncSync(fd);
    } catch {
      // Metadata-write failed but the FD is ours. Close + clean up.
      try { closeSync(fd); } catch { /* */ }
      try { unlinkSync(lockPath); } catch { /* */ }
      throw new Error(`vault flock: failed to write holder metadata to ${lockPath}`);
    }

    const ownedFd = fd;
    return {
      release: () => {
        try { closeSync(ownedFd); } catch { /* */ }
        try { unlinkSync(lockPath); } catch { /* */ }
      },
    };
  }
}

/**
 * VaultBusyError — thrown by acquireLock when the retry budget
 * expires. Subclass of Error so callers can `instanceof` distinguish
 * "contention timeout" from "filesystem error / permission denied".
 *
 * The holder details are attached to fields so a programmatic caller
 * (e.g. the Telegram gateway error-renderer added in #972) can format
 * the message however it wants without re-parsing the string.
 */
export class VaultBusyError extends Error {
  readonly vaultPath: string;
  readonly lockPath: string;
  readonly holderPid: number | null;
  readonly heldForMs: number | null;
  readonly budgetMs: number;

  constructor(
    message: string,
    fields: {
      vaultPath: string;
      lockPath: string;
      holderPid: number | null;
      heldForMs: number | null;
      budgetMs: number;
    },
  ) {
    super(message);
    this.name = "VaultBusyError";
    this.vaultPath = fields.vaultPath;
    this.lockPath = fields.lockPath;
    this.holderPid = fields.holderPid;
    this.heldForMs = fields.heldForMs;
    this.budgetMs = fields.budgetMs;
  }
}

function makeBusyError(
  vaultPath: string,
  lockPath: string,
  holder: LockHolder | null,
  budgetMs: number,
): VaultBusyError {
  const holderPid = holder?.pid ?? null;
  const heldForMs = holder ? Date.now() - holder.acquiredAtMs : null;
  // Plan v3 §11 message shape: "vault busy: held by pid <N> path <P>".
  const holderClause = holder
    ? `held by pid ${holder.pid} (acquired ${Math.round((heldForMs ?? 0) / 1000)}s ago)`
    : "held by another writer (holder PID unreadable — lock file empty or unparseable)";
  return new VaultBusyError(
    `vault busy: ${holderClause} at ${lockPath} (retried for ${budgetMs}ms). ` +
    `Try again in a moment. If the holder process is gone, the next acquirer ` +
    `will clear the stale lock automatically.`,
    { vaultPath, lockPath, holderPid, heldForMs, budgetMs },
  );
}
