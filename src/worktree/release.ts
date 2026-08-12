/**
 * release_worktree: tear down a claimed checkout.
 *
 * Best-effort cleanup:
 *   1. Read the registry record.
 *   2. Remove the checkout — shape-aware: independent clones are `rm -rf`d
 *      (nothing lives outside the directory), legacy linked worktrees go
 *      through `git worktree remove --force` so the source repo's admin
 *      entry is pruned too (see remove-checkout.ts).
 *   3. Delete the registry record.
 *
 * If any step fails, we continue and report `released: false`.
 * The reaper will handle orphans on its next run.
 */

import { existsSync } from "node:fs";
import { readRecord, deleteRecord } from "./registry.js";
import { removeCheckout } from "./remove-checkout.js";
import type { ReleaseInput, ReleaseResult } from "./types.js";

/**
 * Release a claimed worktree by ID.
 */
export function releaseWorktree(input: ReleaseInput): ReleaseResult {
  const { id } = input;
  const record = readRecord(id);

  if (!record) {
    // Already gone — idempotent success
    return { released: true };
  }

  let gitSuccess = true;
  if (existsSync(record.path)) {
    try {
      removeCheckout(record.repo, record.path);
    } catch {
      // removal failed — path may have been deleted externally, or the
      // repo is gone. Don't block the record cleanup.
      gitSuccess = false;
    }
  }

  // Always delete the registry record
  deleteRecord(id);

  return { released: gitSuccess };
}
