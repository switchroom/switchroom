/**
 * Reaper: clean up orphaned worktree claims.
 *
 * Reaper logic (liveness-based, NOT age-based):
 *   - A claim is stale when heartbeatAt is older than STALE_THRESHOLD_MS
 *     AND no process holds the worktree path open (fuser check).
 *   - A claim is an orphan when the registry record exists but the
 *     filesystem worktree doesn't, or vice versa.
 *
 * On reap:
 *   1. Run git worktree remove --force.
 *   2. Delete the registry record.
 *   3. If the worktree had uncommitted changes, emit a warning to stderr
 *      (callers can forward this to Telegram).
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { listRecords, deleteRecord } from "./registry.js";
import type { WorktreeRecord } from "./types.js";

/** Heartbeat age threshold in ms. Claims older than this are stale. */
export const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export interface ReapResult {
  reaped: string[];
  warnings: string[];
}

/**
 * Check whether any process holds the worktree path open (Linux).
 * Uses `fuser` (procps); returns false if fuser is unavailable.
 */
function isPathInUse(path: string): boolean {
  try {
    execFileSync("fuser", [path], { stdio: "pipe" });
    return true; // fuser exits 0 when it finds a process
  } catch {
    return false; // fuser exits 1 when no process holds it, or not available
  }
}

/**
 * Check if a worktree has uncommitted changes.
 * Returns true if there are staged or unstaged changes.
 */
function hasUncommittedChanges(repoPath: string, worktreePath: string): boolean {
  try {
    const out = execFileSync(
      "git",
      ["-C", worktreePath, "status", "--porcelain"],
      { stdio: "pipe" },
    ).toString();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Reap a single stale/orphan record.
 * Returns a warning string if there were uncommitted changes, otherwise null.
 */
function reapRecord(record: WorktreeRecord): string | null {
  const { id, path, repo, branch, ownerAgent } = record;

  let warning: string | null = null;

  if (existsSync(path)) {
    // Check for uncommitted changes before removing
    if (hasUncommittedChanges(repo, path)) {
      warning =
        `[worktree-reaper] Reaped worktree with uncommitted changes: ` +
        `id=${id} branch=${branch} agent=${ownerAgent ?? "unknown"} path=${path}`;
    }

    try {
      execFileSync("git", ["worktree", "remove", "--force", path], {
        cwd: repo,
        stdio: "pipe",
      });
    } catch {
      // If git remove fails, still clean up the record.
      // The path may have been manually deleted.
    }
  }

  deleteRecord(id);
  return warning;
}

/**
 * Run the reaper pass.
 *
 * @param nowMs Optional override for "now" (for testing).
 */
export function runReaper(nowMs?: number): ReapResult {
  const now = nowMs ?? Date.now();
  const records = listRecords();

  const reaped: string[] = [];
  const warnings: string[] = [];

  for (const record of records) {
    const heartbeatAge = now - new Date(record.heartbeatAt).getTime();
    const worktreeExists = existsSync(record.path);

    // Case 1: Orphan — registry record exists but filesystem worktree doesn't.
    // Clean up the dangling record.
    if (!worktreeExists) {
      deleteRecord(record.id);
      reaped.push(record.id);
      continue;
    }

    // Case 2: Stale heartbeat AND path not in use → reap.
    if (heartbeatAge > STALE_THRESHOLD_MS && !isPathInUse(record.path)) {
      const warning = reapRecord(record);
      if (warning) warnings.push(warning);
      reaped.push(record.id);
      continue;
    }
  }

  return { reaped, warnings };
}
