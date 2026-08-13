/**
 * Crash-safe restore for the mutation check.
 *
 * The check writes mutated source into the REAL working tree, so an
 * interrupted run can leave `false && (…)` sitting in a production file — and
 * the next `git commit -a` ships it. `runMutationTarget`'s `finally` covers a
 * throw and a normal exit; it does not cover a kill.
 *
 * A signal handler does NOT close that gap here, and this was measured rather
 * than assumed: the runner spends essentially all its wall clock blocked in
 * `spawnSync`, and a `SIGTERM` delivered during that window terminated the
 * process at exit 143 (default disposition) without ever entering the
 * registered handler. SIGKILL and a lost machine are unreachable by any
 * handler regardless.
 *
 * So recovery is durable instead of in-process: before the first mutation the
 * pristine text is written to a sentinel file, and every run recovers from a
 * sentinel left behind by a previous one BEFORE it does anything else. That
 * covers SIGTERM, SIGKILL, and power loss with the same mechanism, and it is
 * testable without racing a signal.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

export const SENTINEL_NAME = ".mutation-restore.json";

/** Record the pristine text of `file` before it is mutated. */
export function arm(sentinelPath, { file, path, original }) {
  writeFileSync(
    sentinelPath,
    JSON.stringify({ file, path, original, armed_at: Date.now() }, null, 2),
    "utf8",
  );
}

/** Clear the sentinel once the source is safely back. */
export function disarm(sentinelPath) {
  if (existsSync(sentinelPath)) unlinkSync(sentinelPath);
}

/**
 * Restore whatever a previous, killed run left mutated.
 *
 * Returns `null` when there was nothing to do, otherwise `{file, restored}`.
 * `restored: false` means the on-disk text already matched the pristine copy
 * (the run died after its own `finally` but before disarming), which is the
 * benign case and is reported separately so a real recovery is not mistaken
 * for routine noise.
 */
export function recover(sentinelPath) {
  if (!existsSync(sentinelPath)) return null;
  let rec;
  try {
    rec = JSON.parse(readFileSync(sentinelPath, "utf8"));
  } catch {
    // A truncated sentinel (killed mid-write) tells us nothing about which
    // file to restore. Say so loudly rather than deleting it silently.
    throw new Error(
      `${sentinelPath} is unreadable. A previous mutation run was killed and ` +
        `may have left mutated source in the tree — check \`git diff\`, then ` +
        `delete the file.`,
    );
  }
  const current = existsSync(rec.path) ? readFileSync(rec.path, "utf8") : null;
  const needed = current !== rec.original;
  if (needed) writeFileSync(rec.path, rec.original, "utf8");
  unlinkSync(sentinelPath);
  return { file: rec.file, restored: needed };
}
