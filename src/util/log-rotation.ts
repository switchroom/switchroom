/**
 * log-rotation — one size-based rotation primitive for every append-only
 * log this codebase owns.
 *
 * Extracted from `src/vault/broker/audit-log.ts` (issue #2792 item B /
 * #2953 / #2955), which had the only correct implementation. Three other
 * logs were appending without ANY bound:
 *
 *   - `<agent>/telegram/webhook-events.jsonl` (src/web/webhook-gateway-record.ts)
 *   - `~/.switchroom/host-control-audit.log` (src/host-control/server.ts)
 *
 * Rather than grow a third and fourth copy of the copy/fsync/truncate
 * dance, both now call into here, and the vault broker delegates to it.
 *
 * ── Why copy-then-truncate rather than rename ────────────────────────
 * `rename` is wrong for every log this module serves — but for a
 * DIFFERENT reason per log. State them precisely, because "rename works
 * fine on the host" is true for the hostd log and will otherwise invite
 * an "optimisation" back to rename (#3600 review):
 *
 *   - Vault broker audit log: the active file is bind-mounted into the
 *     broker container as a SINGLE FILE, making the path a mount point in
 *     that namespace. `rename(2)` cannot replace an active mount point —
 *     it fails EBUSY on every attempt and the log grows forever (#2953).
 *
 *   - hostd audit log: hostd is the source-side writer, so EBUSY is NOT
 *     the operative constraint (rename would succeed on the host). The
 *     decisive reason is the READERS: every admin agent bind-mounts this
 *     file `:ro` as a single file (`src/cli/apply.ts:1107-1116` pre-creates
 *     it precisely so that `:ro` mount source exists), and hostd writes it
 *     through its own `/host-home` mount. A bind mount pins an INODE, not
 *     a path — renaming the active file would leave every one of those
 *     mounts permanently attached to the old, rotated inode. `/audit
 *     hostd` in each agent would silently freeze at the rotation instant,
 *     forever, with no error surfaced anywhere.
 *
 *   - Sidecar supervisor logs: the supervised child holds an open
 *     `O_APPEND` fd on the path; rename orphans that fd and the live file
 *     stops growing (the copytruncate rationale in start.sh.hbs).
 *
 * Copying the bytes out to `<path>.1` and then `ftruncate`-ing the
 * original back to zero keeps the active INODE — and therefore every
 * mount, every open fd, and the mode — in place, satisfying all three.
 *
 * The `.1 … .maxFiles` generations are ordinary files created by this
 * module, never mount points, so shifting THOSE with `rename` is fine.
 *
 * ── Durability ───────────────────────────────────────────────────────
 * `copyFileSync` returning does not mean the bytes are on stable storage.
 * Truncate is an explicitly data-destroying op, so the snapshot is
 * fsync'd (and its parent dir best-effort fsync'd) BEFORE the active file
 * is truncated. Every failure path leaves the active file intact — we
 * would rather keep growing than lose rows.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RotateOptions {
  /** Rotate when the active file is >= this many bytes. <= 0 disables. */
  maxBytes: number;
  /** How many `<path>.N` generations to retain. Minimum 1. */
  maxFiles: number;
  /** Prefix for stderr diagnostics, e.g. "vault-audit". */
  tag: string;
  /**
   * Serialize rotation against OTHER PROCESSES via an `O_CREAT|O_EXCL`
   * lockfile at `<path>.rotate.lock` (#3600 review, finding 1).
   *
   * Required whenever two processes can append to the same log. The
   * webhook event log is exactly that: `handleWebhookIngest` runs in the
   * web container and `recordWebhookEvent` in the agent's gateway, both
   * writing `<agent>/telegram/webhook-events.jsonl`. Without a lock they
   * can both stat an over-cap file, A rotates (`.1` ← copy, active
   * truncated), then B rotates the NOW-EMPTY active file — shifting the
   * real `.1` to `.2` and copying zero bytes over `.1`. With maxFiles=2
   * that discards a whole generation of events; the empty-copy is
   * strictly worse than the ordinary copy/truncate race window.
   *
   * The lock closes it twice over: only one rotator runs at a time, AND
   * the size is re-checked while holding the lock, so the loser sees the
   * freshly-truncated file and declines.
   *
   * Single-writer logs (vault audit, hostd audit — both serialized
   * in-process, see `audit-hashchain.ts` single-writer-process contract)
   * do not need it and leave this false.
   */
  lock?: boolean;
}

/** Stale-lock threshold: a rotation is a copy + fsync + truncate, tens of
 *  ms even for 32 MiB. A lock older than this is a crashed holder. */
const ROTATE_LOCK_STALE_MS = 30_000;

/**
 * Run `fn` while holding an `O_CREAT|O_EXCL` lockfile beside the log.
 * Returns `null` if the lock could not be taken (another process is
 * mid-rotation) — the caller treats that as "someone else handled it".
 *
 * A lock left behind by a killed process is reclaimed after
 * {@link ROTATE_LOCK_STALE_MS}; the reclaim is itself racy-safe because
 * the reclaimer re-attempts the same `O_EXCL` create and only one can win.
 */
function withRotateLock<T>(
  logPath: string,
  tag: string,
  fn: () => T,
): T | null {
  const lockPath = `${logPath}.rotate.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      process.stderr.write(
        `[${tag}] ERROR: could not take rotation lock ${lockPath}: ${(err as Error).message}\n`,
      );
      return null;
    }
    // Held. Reclaim only if it is stale (holder died mid-rotation).
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      return null; // vanished under us — the holder just finished
    }
    if (age < ROTATE_LOCK_STALE_MS) return null;
    process.stderr.write(
      `[${tag}] WARN: reclaiming stale rotation lock ${lockPath} (${Math.round(age / 1000)}s old)\n`,
    );
    try {
      fs.unlinkSync(lockPath);
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch {
      return null; // someone else won the reclaim
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Rotate `<path>` unconditionally: drop `<path>.<maxFiles>`, shift
 * `<path>.(n-1)` → `<path>.n`, snapshot `<path>` → `<path>.1`, truncate
 * `<path>` in place.
 *
 * Best-effort: returns `false` (and writes a diagnostic to stderr) if the
 * rotation could not complete, in which case the active file is left
 * exactly as it was. Never throws.
 */
export function rotateLogFile(
  logPath: string,
  maxFiles: number,
  tag: string,
): boolean {
  const keep = Math.max(1, Math.floor(maxFiles));
  // Delete the oldest retained generation — it falls off the window.
  const oldest = `${logPath}.${keep}`;
  if (fs.existsSync(oldest)) {
    try {
      fs.unlinkSync(oldest);
    } catch (err) {
      process.stderr.write(
        `[${tag}] ERROR: could not drop oldest rotation ${oldest}: ${(err as Error).message}\n`,
      );
    }
  }
  // Shift .(n-1) → .n. Ordinary files; rename is safe.
  for (let n = keep - 1; n >= 1; n--) {
    const from = `${logPath}.${n}`;
    const to = `${logPath}.${n + 1}`;
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, to);
    } catch (err) {
      process.stderr.write(
        `[${tag}] ERROR: could not rotate ${from} → ${to}: ${(err as Error).message}\n`,
      );
      return false;
    }
  }
  const snapshotPath = `${logPath}.1`;
  try {
    fs.copyFileSync(logPath, snapshotPath);
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not snapshot active log ${logPath} → ${snapshotPath}: ${(err as Error).message}\n`,
    );
    return false;
  }
  // Durably persist the snapshot before destroying the source.
  try {
    const fd = fs.openSync(snapshotPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not fsync snapshot ${snapshotPath}; leaving active log intact to avoid data loss: ${(err as Error).message}\n`,
    );
    return false;
  }
  // Best-effort dirent persist — non-fatal, rotation is idempotent.
  try {
    const dirFd = fs.openSync(path.dirname(snapshotPath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* some filesystems refuse fsync on directories */
  }
  try {
    fs.truncateSync(logPath, 0);
  } catch (err) {
    process.stderr.write(
      `[${tag}] ERROR: could not truncate active log ${logPath}: ${(err as Error).message}\n`,
    );
    return false;
  }
  return true;
}

/**
 * Stat `<path>` and rotate it if it has reached `maxBytes`. Returns true
 * iff a rotation actually happened. A missing file, a stat failure, or a
 * non-positive `maxBytes` are all no-ops (never throws) — rotation is a
 * housekeeping concern and must never break the write path it guards.
 */
export function maybeRotateLogFile(
  logPath: string,
  opts: RotateOptions,
): boolean {
  if (!(opts.maxBytes > 0)) return false;
  if (!overCap(logPath, opts.maxBytes)) return false;
  if (!opts.lock) {
    return rotateLogFile(logPath, opts.maxFiles, opts.tag);
  }
  // Multi-writer log: take the cross-process lock and RE-CHECK the size
  // under it. The recheck is the part that matters — a racing process may
  // have rotated between our stat above and our acquiring the lock, and
  // rotating the now-empty active file would copy zero bytes over a good
  // `.1` and shift the real history off the end of the window.
  const rotated = withRotateLock(logPath, opts.tag, () => {
    if (!overCap(logPath, opts.maxBytes)) return false;
    return rotateLogFile(logPath, opts.maxFiles, opts.tag);
  });
  return rotated === true;
}

/** True iff `logPath` exists and is at least `maxBytes` long. Never throws. */
function overCap(logPath: string, maxBytes: number): boolean {
  try {
    return fs.statSync(logPath).size >= maxBytes;
  } catch {
    return false; // not created yet (or unreadable) — nothing to rotate
  }
}

/**
 * Resolve a `{maxBytes, maxFiles}` pair from explicit options, then env
 * overrides, then defaults. `maxBytes === 0` means "unset" (fall through);
 * a NEGATIVE explicit/env value disables rotation entirely — the operator
 * escape hatch, matching the vault broker's long-standing semantics.
 */
export function resolveRotationConfig(args: {
  maxBytes?: number;
  maxFiles?: number;
  envBytesVar: string;
  envFilesVar: string;
  defaultBytes: number;
  defaultFiles: number;
  env?: NodeJS.ProcessEnv;
}): { maxBytes: number; maxFiles: number } {
  const env = args.env ?? process.env;
  const envBytes = Number(env[args.envBytesVar]);
  const envFiles = Number(env[args.envFilesVar]);
  const maxBytes =
    args.maxBytes !== undefined && args.maxBytes !== 0
      ? args.maxBytes
      : Number.isFinite(envBytes) && envBytes !== 0
        ? envBytes
        : args.defaultBytes;
  const maxFiles =
    args.maxFiles !== undefined && args.maxFiles > 0
      ? args.maxFiles
      : Number.isFinite(envFiles) && envFiles > 0
        ? envFiles
        : args.defaultFiles;
  return { maxBytes, maxFiles };
}
