/**
 * Per-agent standing-tree management.
 *
 * Each agent that declares a repo in its switchroom.yaml config gets a
 * dedicated standing tree at <agentDir>/work/<slug>/ on branch
 * agent/<agentName>/main. This tree is:
 *   - Created on the first reconcile after the repo appears in config.
 *   - Fast-forwarded to upstream/main (or the remote's default branch)
 *     on each subsequent reconcile when the tree is clean.
 *   - Left unchanged (dirty: true) when the tree has uncommitted
 *     changes — we never git reset --hard an agent's in-flight work.
 *   - Removed with the agent on `switchroom agent remove`.
 *
 * WHY AN INDEPENDENT CLONE AND NOT `git worktree add` (same class of bug
 * as the claim-path fix in src/worktree/claim.ts, PR #4659): linked
 * worktrees off the shared bare clone all share the bare's object store
 * and refs — including the SINGLE `refs/stash` — so a `git stash pop` in
 * one agent's standing tree can pop a DIFFERENT agent's stash entry, and
 * `.git/worktrees/<name>` admin metadata in the bare can go stale across
 * removals. An independent clone shares nothing mutable with the bare or
 * with any other agent's tree by construction. A local clone hardlinks
 * the object store (same filesystem), so the disk cost stays near a
 * worktree's. `origin` is rewired from the local bare-clone path to the
 * bare's real upstream URL so fetch/push in the tree hit upstream.
 *
 * PRE-EXISTING trees provisioned as linked worktrees are left in place
 * (never force-migrated — that could lose in-flight work) and remain
 * removable: removal is shape-aware via removeCheckout(), detecting by
 * filesystem shape (`.git` dir = clone, `.git` file = linked worktree),
 * never by a stored record field.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertBaseDirNotTmp } from "../worktree/claim.js";
import { removeCheckout } from "../worktree/remove-checkout.js";

export interface WorktreeState {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch the worktree is on (e.g. "agent/clerk/main") */
  branch: string;
  /**
   * true when the worktree has uncommitted changes and was NOT
   * fast-forwarded. The worktree is left exactly as-is.
   */
  dirty: boolean;
  /**
   * When dirty=true, the abbreviated HEAD SHA at the time of the call.
   * Useful for boot-card warnings.
   */
  dirtyCommit?: string;
}

/**
 * Resolve the per-agent branch name for a given agent.
 * Convention: agent/<agentName>/main
 */
export function agentBranchName(agentName: string): string {
  return `agent/${agentName}/main`;
}

/**
 * Resolve the worktree directory path for an agent's repo.
 * Convention: <agentDir>/work/<slug>/
 */
export function agentWorktreePath(agentDir: string, slug: string): string {
  return join(agentDir, "work", slug);
}

/**
 * Detect whether a worktree directory has uncommitted changes.
 * Returns true if `git status --porcelain` produces any output.
 */
function isWorktreeDirty(worktreePath: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return out.trim().length > 0;
  } catch {
    // If git status fails, treat as dirty to be safe (never overwrite).
    return true;
  }
}

/**
 * Read the abbreviated HEAD commit SHA for a worktree.
 */
function headShortSha(worktreePath: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Check if a branch already exists in the bare clone.
 */
function branchExistsInBare(bareClonePath: string, branchName: string): boolean {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", `refs/heads/${branchName}`],
      {
        cwd: bareClonePath,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the default remote tracking branch for a repo (bare clone or
 * checked-out tree). Tries refs/remotes/origin/HEAD → falls back to "main".
 */
function resolveDefaultBranch(repoPath: string): string {
  try {
    const out = execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      },
    ).trim();
    // out is like "refs/remotes/origin/main"
    const parts = out.split("/");
    return parts[parts.length - 1] ?? "main";
  } catch {
    return "main";
  }
}

/**
 * Check whether a fully-qualified ref exists in a repo.
 */
function refExists(repoPath: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a per-agent standing tree exists for a given repo.
 *
 * Behaviour:
 *   1. First call: creates <agentDir>/work/<slug>/ as an INDEPENDENT
 *      local clone of the bare clone (own object store, own refs, own
 *      refs/stash — see module header) on branch agent/<agentName>/main.
 *      The branch starts at the bare's copy of the per-agent branch when
 *      one exists (re-provisioning after a pre-fix removal), else at the
 *      remote's default branch (e.g. origin/main). `origin` is rewired
 *      to the bare's real upstream URL.
 *   2. Subsequent calls (clean tree): fetches latest from origin and
 *      fast-forwards agent/<agentName>/main to origin/<defaultBranch>.
 *      Works unchanged for PRE-EXISTING linked-worktree trees.
 *   3. Subsequent calls (dirty tree): leaves the tree unchanged,
 *      returns dirty: true.
 *
 * Synchronous: uses execFileSync internally; exported as a sync function
 * so that callers (reconcileAgent) do not need to become async.
 *
 * @param agentName      Agent identifier (e.g. "clerk")
 * @param slug           Repo slug (e.g. "switchroom-web")
 * @param bareClonePath  Absolute path to the bare clone directory
 * @param agentDir       Agent directory (e.g. ~/.switchroom/agents/clerk)
 */
export function ensureAgentWorktree(
  agentName: string,
  slug: string,
  bareClonePath: string,
  agentDir: string,
): WorktreeState {
  const worktreePath = agentWorktreePath(agentDir, slug);
  const branch = agentBranchName(agentName);

  if (!existsSync(worktreePath)) {
    // First time: provision an independent clone of the bare clone.
    // Same remedy shape as the claim path (src/worktree/claim.ts, #4659).
    const workDir = join(agentDir, "work");
    // Agent containers mount /tmp noexec — a standing tree there fails the
    // moment a build runs in it. Same guard as the claim path.
    assertBaseDirNotTmp(workDir);
    mkdirSync(workDir, { recursive: true });

    try {
      // Local clone: hardlinks the bare's object store (same filesystem), so
      // this is cheap. --no-checkout because we check out the per-agent
      // branch ourselves in the next step. Cloning a bare repo maps the
      // bare's refs/heads/* to refs/remotes/origin/* in the clone, so a
      // legacy per-agent branch left in the bare by the pre-fix
      // `worktree add -b` provisioning surfaces as origin/<branch> here.
      execFileSync(
        "git",
        ["clone", "--quiet", "--no-checkout", bareClonePath, worktreePath],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      const defaultBranch = resolveDefaultBranch(worktreePath);
      const startPoint = refExists(worktreePath, `refs/remotes/origin/${branch}`)
        ? `origin/${branch}` // preserve the legacy per-agent branch's state
        : `origin/${defaultBranch}`;
      execFileSync(
        "git",
        ["checkout", "--quiet", "-b", branch, startPoint],
        { cwd: worktreePath, stdio: ["ignore", "pipe", "pipe"] },
      );

      // Rewire `origin` from the local bare-clone path to the bare's real
      // upstream URL, so fetch/push in the standing tree hit upstream —
      // matching what a linked worktree (which shared the bare's remote
      // config) used to give agents. If the bare has no origin, leave the
      // local path in place.
      let originUrl: string | undefined;
      try {
        originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
          cwd: bareClonePath,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8",
        }).trim();
      } catch {
        /* bare clone has no origin remote */
      }
      if (originUrl) {
        execFileSync("git", ["remote", "set-url", "origin", originUrl], {
          cwd: worktreePath,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (err) {
      // Remove any partial clone: a half-provisioned dir would otherwise be
      // mistaken for an existing tree (and reported dirty) on the next
      // reconcile. Mirrors the claim path's failure cleanup.
      rmSync(worktreePath, { recursive: true, force: true });
      throw err;
    }

    process.stderr.write(
      `[switchroom] repo "${slug}": standing tree ready at ${worktreePath} (branch: ${branch}, independent clone)\n`,
    );
    return { path: resolve(worktreePath), branch, dirty: false };
  }

  // Worktree already exists — check for uncommitted changes.
  if (isWorktreeDirty(worktreePath)) {
    const sha = headShortSha(worktreePath);
    process.stderr.write(
      `[switchroom] repo "${slug}": dirty (uncommitted changes at ${sha ?? "unknown"}) — skipping ff-to-main\n`,
    );
    return {
      path: resolve(worktreePath),
      branch,
      dirty: true,
      dirtyCommit: sha,
    };
  }

  // Clean worktree: fast-forward to the latest upstream.
  try {
    // Fetch inside the worktree so it updates the tracking branches.
    execFileSync("git", ["fetch", "origin"], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Resolve from the tree itself: works for both shapes (an independent
    // clone has its own refs/remotes/origin/HEAD; a legacy linked worktree
    // resolves through the bare clone's refs).
    const defaultBranch = resolveDefaultBranch(worktreePath);

    execFileSync(
      "git",
      ["merge", "--ff-only", `origin/${defaultBranch}`],
      {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    process.stderr.write(
      `[switchroom] repo "${slug}": worktree ready at ${worktreePath} (ff-d to origin/${defaultBranch})\n`,
    );
  } catch (err) {
    // ff-only merge failed (e.g. diverged history) — leave as-is.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[switchroom] repo "${slug}": ff-only merge failed (leaving as-is): ${msg}\n`,
    );
  }

  return { path: resolve(worktreePath), branch, dirty: false };
}

/**
 * Remove the per-agent standing tree for a given repo.
 *
 * Steps:
 *   1. Shape-aware removal via removeCheckout(): an independent clone
 *      (`.git` directory) is `rm -rf`'d — everything lives inside it; a
 *      PRE-EXISTING linked worktree (`.git` FILE) goes through
 *      `git worktree remove --force` from the bare clone so the bare's
 *      `.git/worktrees/<name>` admin entry is cleaned up too. Detection
 *      is by filesystem shape, never a stored kind field.
 *   2. `git branch -D agent/<agentName>/main` from the bare clone (a
 *      legacy leftover for clone-shaped trees; the live branch for
 *      worktree-shaped ones).
 *
 * Idempotent — safe to call even when the tree or branch is absent.
 *
 * Synchronous: uses execFileSync internally; exported as a sync function
 * so that callers do not need to become async.
 */
export function removeAgentWorktree(
  agentName: string,
  slug: string,
  bareClonePath: string,
  agentDir: string,
): void {
  const worktreePath = agentWorktreePath(agentDir, slug);
  const branch = agentBranchName(agentName);

  if (existsSync(worktreePath)) {
    try {
      removeCheckout(bareClonePath, worktreePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[switchroom] repo "${slug}": worktree remove failed: ${msg}\n`,
      );
    }
  }

  // Prune the per-agent branch from the bare clone.
  if (branchExistsInBare(bareClonePath, branch)) {
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: bareClonePath,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[switchroom] repo "${slug}": branch delete failed: ${msg}\n`,
      );
    }
  }

  // Prune stale worktree entries from the bare clone's admin directory.
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: bareClonePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // non-fatal
  }

  process.stderr.write(
    `[switchroom] repo "${slug}": worktree removed (agent: ${agentName})\n`,
  );
}

/**
 * List the repo slugs for which a worktree has been provisioned under
 * an agent's <agentDir>/work/ directory.
 *
 * Returns an empty array when the work/ directory doesn't exist.
 */
export function listAgentWorktrees(agentDir: string): string[] {
  const workDir = join(agentDir, "work");
  if (!existsSync(workDir)) return [];
  try {
    return readdirSync(workDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
