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
 * In the deployed topology these logs are bind-mounted into containers as
 * SINGLE FILES (not their parent directory) — e.g. the hostd audit log is
 * visible to admin agents at `/host-home/.switchroom/host-control-audit.log`,
 * and the vault audit log is mounted file-wise into the broker container.
 * A single-file bind mount makes the path a mount point inside that
 * container's mount namespace, and `rename(2)` cannot replace an active
 * mount point: it fails EBUSY on every attempt and the log grows forever
 * (issue #2953). Copying the bytes out to `<path>.1` and then
 * `ftruncate`-ing the original back to zero keeps the active inode (and
 * therefore the mount, mode, and any open O_APPEND fd) in place, so it
 * works whether the operator mounts the file or its parent directory.
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
  let size: number;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return false; // not created yet (or unreadable) — nothing to rotate
  }
  if (size < opts.maxBytes) return false;
  return rotateLogFile(logPath, opts.maxFiles, opts.tag);
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
