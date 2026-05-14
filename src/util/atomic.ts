/**
 * Atomic file write primitive — shared between vault-broker and
 * auth-broker (RFC H §4.4).
 *
 * Both brokers write secret-bearing files (vault entries, OAuth
 * credentials.json, per-agent mirrors) with the same one-writer-
 * many-readers shape and need the same atomicity guarantee: a
 * concurrent reader either sees the old bytes in full or the new
 * bytes in full, never a half-written file.
 *
 * The primitive: tempfile alongside the destination + fsync the
 * tempfile + rename(2). `rename` is atomic *within a single
 * filesystem*, which is why the tempfile must live in the same
 * directory as the destination (not /tmp).
 *
 * Failure modes:
 *   - mkdir/write/fsync error → tempfile cleaned up, error rethrown.
 *   - rename error → tempfile cleaned up, error rethrown. The
 *     destination is untouched.
 *   - Process crash mid-write → tempfile may be left behind;
 *     unique per-pid + random suffix means concurrent writers
 *     don't collide on the tempfile name.
 *
 * Mode defaults to 0o600 (owner read/write only) because the
 * canonical caller is writing OAuth tokens / vault entries.
 * Callers that need 0o644 (e.g. config files) pass it explicitly.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

export function atomicWriteFileSync(
  destPath: string,
  contents: string | Buffer,
  mode = 0o600,
): void {
  const tmp = `${destPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const buf = typeof contents === "string" ? Buffer.from(contents, "utf-8") : contents;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w", mode);
    writeSync(fd, buf, 0, buf.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, destPath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { rmSync(tmp, { force: true }); } catch { /* tempfile already gone */ }
    throw err;
  }
}

export function atomicWriteJsonSync(
  destPath: string,
  value: unknown,
  mode = 0o600,
): void {
  atomicWriteFileSync(destPath, JSON.stringify(value, null, 2) + "\n", mode);
}
