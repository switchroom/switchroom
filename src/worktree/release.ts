/**
 * release_worktree: tear down a claimed worktree.
 *
 * Best-effort cleanup:
 *   1. Read the registry record.
 *   2. Run `git worktree remove --force` on the path.
 *   3. Delete the registry record.
 *
 * If any step fails, we continue and report `released: false`.
 * The reaper will handle orphans on its next run.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readRecord, deleteRecord } from "./registry.js";
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
      execFileSync("git", ["worktree", "remove", "--force", record.path], {
        cwd: record.repo,
        stdio: "pipe",
      });
    } catch {
      // git remove failed — path may have been deleted externally, or
      // repo is gone. Don't block the record cleanup.
      gitSuccess = false;
    }
  }

  // Always delete the registry record
  deleteRecord(id);

  return { released: gitSuccess };
}
