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
import { enumerateMutants } from "./operators.mjs";

export const SENTINEL_NAME = ".mutation-restore.json";

/** Record the pristine text of `file` before it is mutated. `armed_at` is
 *  forensic only — a stale sentinel's age is the first thing a human asks
 *  when `git diff` is unexpectedly dirty; nothing branches on it. */
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
 *
 * A restore is only performed when the on-disk text is DEMONSTRABLY a mutant
 * of the recorded original — one of `enumerateMutants(original)`'s outputs.
 * Without that check this function is an unconditional overwrite of a source
 * file from a stale JSON blob, and the losing case is ordinary: a killed run
 * leaves a sentinel behind (it dies before `disarm`), the developer then edits
 * that same file for real, and the next `npm run lint` silently reverts their
 * work behind a `console.warn`. Unrecognised text is a hard error for the same
 * reason a truncated sentinel is — the sentinel no longer knows what it is
 * looking at, and guessing costs the human their edits.
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
  if (current === rec.original) {
    // Benign: the run died after its own `finally` restored the file but
    // before it disarmed.
    unlinkSync(sentinelPath);
    return { file: rec.file, restored: false };
  }
  const isKnownMutant = enumerateMutants(rec.file ?? "sentinel.ts", rec.original)
    .mutants.some((m) => m.source === current);
  if (!isKnownMutant) {
    throw new Error(
      `${sentinelPath} points at ${rec.file}, but that file's current contents are ` +
        `neither the recorded original nor any mutant of it. A previous mutation ` +
        `run was killed and the file has been edited since — restoring the ` +
        `recorded copy would DELETE those edits. Reconcile by hand (\`git diff\`), ` +
        `then delete the sentinel.`,
    );
  }
  writeFileSync(rec.path, rec.original, "utf8");
  unlinkSync(sentinelPath);
  return { file: rec.file, restored: true };
}
