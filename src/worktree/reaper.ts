/**
 * Reaper: clean up orphaned worktree claims.
 *
 * Reaper logic (liveness-based, NOT age-based):
 *   - A claim is stale when heartbeatAt is older than STALE_THRESHOLD_MS
 *     AND we can PROVE the worktree path is not held by any live process.
 *   - A claim is an orphan when the registry record exists but the
 *     filesystem worktree doesn't (a dangling record).
 *
 * FAIL-SAFE by construction (data-loss prevention, F1/H3):
 *   The reaper's whole job is to remove a *dead* claim's worktree with
 *   `git worktree remove --force`, which discards any working-tree state.
 *   That force-remove is only ever run when EVERY one of these holds:
 *     1. the heartbeat is stale (> STALE_THRESHOLD_MS), AND
 *     2. the worktree has NO uncommitted changes (a hard skip — never a
 *        mere warning: we do not destroy in-flight work), AND
 *     3. an in-use probe can DEFINITIVELY report the path as free.
 *   If the in-use probe is unavailable (neither `fuser` nor `lsof` is
 *   installed) we treat the path as live and keep it — "can't prove it's
 *   idle" must never license a force-remove. A live claim advances its own
 *   heartbeat (see registry.touchHeartbeat, refreshed from the gateway's
 *   watch loop), so a genuinely-abandoned claim is the only thing that
 *   reaches the stale branch in the first place.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { listRecords, deleteRecord } from "./registry.js";

/** Heartbeat age threshold in ms. Claims older than this are stale. */
export const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Result of probing whether a path is held open by a live process.
 *   - "in-use"      — a probe positively found a holder → keep the claim.
 *   - "free"        — a probe ran and found NO holder → safe to consider reap.
 *   - "unavailable" — NO probe tool is installed → we cannot tell, so the
 *                     reaper treats the path as live (fail-safe) and keeps it.
 */
export type PathUseState = "in-use" | "free" | "unavailable";

/** Injectable dependencies for `runReaper` (defaults use the real probes). */
export interface ReaperDeps {
  /** Probe whether the worktree path is held open by a live process. */
  probeInUse?: (path: string) => PathUseState;
  /** Detect uncommitted (staged or unstaged) changes in the worktree. */
  hasUncommittedChanges?: (repoPath: string, worktreePath: string) => boolean;
  /** Force-remove the worktree (defaults to `git worktree remove --force`). */
  removeWorktree?: (repoPath: string, worktreePath: string) => void;
}

export interface ReapResult {
  reaped: string[];
  warnings: string[];
}

/**
 * Probe whether any process holds the worktree path open.
 *
 * Tries `fuser` (Linux/procps) first, then `lsof` (macOS/BSD).
 *
 * Crucially, this distinguishes "the probe RAN and found nothing" (→ "free")
 * from "the probe tool is not installed" (→ "unavailable"). A missing binary
 * surfaces as a spawn `ENOENT`; a real "path not in use" surfaces as a
 * non-zero *exit* (no `ENOENT`). The reaper must never force-remove on the
 * strength of an "unavailable" result — that was the F1 data-loss hole where
 * a host without fuser/lsof reaped live worktrees.
 */
export function probePathInUse(path: string): PathUseState {
  let probeRan = false;

  // fuser: exits 0 when the path is in use; non-zero when not; ENOENT when
  // the binary itself is missing.
  try {
    execFileSync("fuser", [path], { stdio: "pipe" });
    return "in-use";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // fuser ran and exited non-zero → path not in use (per fuser).
      probeRan = true;
    }
  }

  // lsof: exits 0 with PID output when in use; exits 1 (non-ENOENT) when not.
  try {
    const out = execFileSync("lsof", ["-t", path], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    probeRan = true;
    if (out.length > 0) return "in-use";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // lsof ran and found nothing (exit 1) → not in use (per lsof).
      probeRan = true;
    }
  }

  return probeRan ? "free" : "unavailable";
}

/**
 * Check if a worktree has uncommitted changes.
 * Returns true if there are staged or unstaged changes.
 *
 * On ANY error running git (path is not a git worktree, git missing, etc.)
 * we return `true` — "can't tell" must fail toward preservation, never toward
 * a force-remove.
 */
function hasUncommittedChanges(_repoPath: string, worktreePath: string): boolean {
  try {
    const out = execFileSync(
      "git",
      ["-C", worktreePath, "status", "--porcelain"],
      { stdio: "pipe" },
    ).toString();
    return out.trim().length > 0;
  } catch {
    // Can't determine cleanliness → assume dirty so we never force-remove
    // work we failed to inspect.
    return true;
  }
}

/** Default force-remove: `git worktree remove --force <path>` from the repo. */
function defaultRemoveWorktree(repoPath: string, worktreePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch {
    // If git remove fails, the caller still deletes the record. The path may
    // have been manually deleted or the repo moved.
  }
}

/**
 * Run the reaper pass.
 *
 * @param nowMs Optional override for "now" (for testing).
 * @param deps  Optional injectable probes (for testing / host portability).
 */
export function runReaper(nowMs?: number, deps: ReaperDeps = {}): ReapResult {
  const now = nowMs ?? Date.now();
  const probeInUse = deps.probeInUse ?? probePathInUse;
  const uncommitted = deps.hasUncommittedChanges ?? hasUncommittedChanges;
  const removeWorktree = deps.removeWorktree ?? defaultRemoveWorktree;

  const records = listRecords();

  const reaped: string[] = [];
  const warnings: string[] = [];

  for (const record of records) {
    const heartbeatAge = now - new Date(record.heartbeatAt).getTime();
    const worktreeExists = existsSync(record.path);

    // Case 1: Orphan — registry record exists but filesystem worktree doesn't.
    // Nothing to force-remove; just drop the dangling record.
    if (!worktreeExists) {
      deleteRecord(record.id);
      reaped.push(record.id);
      continue;
    }

    // Not stale yet → live claim, keep it.
    if (heartbeatAge <= STALE_THRESHOLD_MS) continue;

    // ── Stale + worktree present: run the fail-safe gauntlet before any
    //    `git worktree remove --force`. Only reap when ALL guards clear. ──

    // Fail-safe 1: NEVER destroy uncommitted work. Hard skip (not a warning
    // that proceeds to remove — that was the F1/H3 data-loss bug).
    if (uncommitted(record.repo, record.path)) {
      warnings.push(
        `[worktree-reaper] SKIPPED stale worktree with UNCOMMITTED changes ` +
          `(not removed — preserving in-flight work): id=${record.id} ` +
          `branch=${record.branch} agent=${record.ownerAgent ?? "unknown"} ` +
          `path=${record.path}`,
      );
      continue;
    }

    // Fail-safe 2: only reap when the path is DEFINITIVELY free. Both
    // "in-use" and "unavailable" (no fuser/lsof to prove idleness) mean we
    // cannot show the worktree is dead → keep it.
    const use = probeInUse(record.path);
    if (use !== "free") {
      if (use === "unavailable") {
        warnings.push(
          `[worktree-reaper] SKIPPED stale worktree — in-use probe ` +
            `unavailable (neither fuser nor lsof installed); treating as ` +
            `live: id=${record.id} path=${record.path}`,
        );
      }
      continue;
    }

    // All guards cleared: stale, clean, and provably not in use → reap.
    removeWorktree(record.repo, record.path);
    deleteRecord(record.id);
    reaped.push(record.id);
  }

  return { reaped, warnings };
}
