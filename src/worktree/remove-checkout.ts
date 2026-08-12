/**
 * Shape-aware removal of a claimed checkout.
 *
 * Claims are provisioned as INDEPENDENT CLONES (see claim.ts), but records
 * written before that fix point at `git worktree add` checkouts. The two
 * need different teardown:
 *
 *   - clone    → `rm -rf` of the directory. Nothing else exists: the task
 *                branch, index, stash, and worktree metadata all live inside
 *                the clone, so no state can go stale in the source repo.
 *   - worktree → `git worktree remove --force` run from the source repo, so
 *                the source repo's `.git/worktrees/<name>` admin entry is
 *                cleaned up along with the directory.
 *
 * Detection is by FILESYSTEM SHAPE, not by the registry record's `kind`
 * field: a full clone has a `.git` directory, a linked worktree has a `.git`
 * FILE (a gitdir pointer). Shape can't drift from reality the way a record
 * field can, and it handles legacy records that predate the `kind` field.
 */

import { execFileSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type CheckoutKind = "clone" | "worktree" | "missing" | "unknown";

/**
 * Classify a checkout directory by the shape of its `.git` entry.
 *   - `.git` is a directory → independent clone
 *   - `.git` is a file      → linked `git worktree`
 *   - path (or `.git`) absent → "missing"
 *   - anything else          → "unknown"
 */
export function detectCheckoutKind(checkoutPath: string): CheckoutKind {
  let gitStat;
  try {
    gitStat = statSync(join(checkoutPath, ".git"));
  } catch {
    try {
      statSync(checkoutPath);
    } catch {
      return "missing"; // path itself is gone
    }
    return "unknown"; // path exists but has no .git entry
  }
  if (gitStat.isDirectory()) return "clone";
  if (gitStat.isFile()) return "worktree";
  return "unknown";
}

/**
 * Remove a claimed checkout, whatever its provisioning shape.
 * Throws on failure (callers decide whether that is fatal).
 *
 * @param repoPath     Source repo the claim was made against (used only for
 *                     the legacy `git worktree remove` path).
 * @param checkoutPath Directory of the checkout to remove.
 */
export function removeCheckout(repoPath: string, checkoutPath: string): void {
  const kind = detectCheckoutKind(checkoutPath);

  if (kind === "clone") {
    // Independent clone: the directory is the whole claim. No metadata in
    // the source repo to prune, no branch to delete there.
    rmSync(checkoutPath, { recursive: true, force: true });
    return;
  }

  if (kind === "missing") {
    // Already gone — treat as removed (idempotent).
    return;
  }

  // Legacy linked worktree (or unknown shape): let git do the removal so the
  // source repo's .git/worktrees admin entry goes with it.
  execFileSync("git", ["worktree", "remove", "--force", checkoutPath], {
    cwd: repoPath,
    stdio: "pipe",
  });
}
