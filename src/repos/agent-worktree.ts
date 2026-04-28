/**
 * Per-agent worktree management.
 *
 * Each agent that declares a repo in its switchroom.yaml config gets a
 * dedicated worktree at <agentDir>/work/<slug>/ on branch
 * agent/<agentName>/main. This worktree is:
 *   - Created on the first reconcile after the repo appears in config.
 *   - Fast-forwarded to upstream/main (or the remote's default branch)
 *     on each subsequent reconcile when the worktree is clean.
 *   - Left unchanged (dirty: true) when the worktree has uncommitted
 *     changes — we never git reset --hard an agent's in-flight work.
 *   - Removed with the agent on `switchroom agent remove`.
 *
 * Isolation: two agents on the same repo get separate worktrees on
 * separate branches; they cannot interfere with each other.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
 * Resolve the default remote tracking branch for the bare clone.
 * Tries refs/remotes/origin/HEAD → falls back to "main".
 */
function resolveDefaultBranch(bareClonePath: string): string {
  try {
    const out = execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        cwd: bareClonePath,
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
 * Ensure a per-agent worktree exists for a given repo.
 *
 * Behaviour:
 *   1. First call: creates <agentDir>/work/<slug>/ as a git worktree on
 *      branch agent/<agentName>/main. The branch is created off the
 *      remote's default branch (e.g. origin/main).
 *   2. Subsequent calls (clean worktree): fetches latest from remote
 *      and fast-forwards agent/<agentName>/main to origin/<defaultBranch>.
 *   3. Subsequent calls (dirty worktree): leaves the worktree unchanged,
 *      returns dirty: true.
 *
 * @param agentName      Agent identifier (e.g. "clerk")
 * @param slug           Repo slug (e.g. "switchroom-web")
 * @param bareClonePath  Absolute path to the bare clone directory
 * @param agentDir       Agent directory (e.g. ~/.switchroom/agents/clerk)
 */
export async function ensureAgentWorktree(
  agentName: string,
  slug: string,
  bareClonePath: string,
  agentDir: string,
): Promise<WorktreeState> {
  const worktreePath = agentWorktreePath(agentDir, slug);
  const branch = agentBranchName(agentName);
  const defaultBranch = resolveDefaultBranch(bareClonePath);

  if (!existsSync(worktreePath)) {
    // First time: create the worktree directory and the agent branch.
    mkdirSync(join(agentDir, "work"), { recursive: true });

    if (branchExistsInBare(bareClonePath, branch)) {
      // Branch already exists (e.g. re-provisioning after removal).
      // Add the worktree using the existing branch — don't re-create it.
      execFileSync(
        "git",
        ["worktree", "add", worktreePath, branch],
        {
          cwd: bareClonePath,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } else {
      // Create the worktree and the per-agent branch together.
      // The branch starts at origin/<defaultBranch>.
      execFileSync(
        "git",
        [
          "worktree", "add",
          worktreePath,
          "-b", branch,
          `origin/${defaultBranch}`,
        ],
        {
          cwd: bareClonePath,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }

    process.stderr.write(
      `[switchroom] repo "${slug}": worktree ready at ${worktreePath} (branch: ${branch})\n`,
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
 * Remove the per-agent worktree for a given repo.
 *
 * Steps:
 *   1. `git worktree remove --force <path>` from the bare clone.
 *   2. `git branch -D agent/<agentName>/main` from the bare clone.
 *
 * Idempotent — safe to call even when the worktree or branch is absent.
 */
export async function removeAgentWorktree(
  agentName: string,
  slug: string,
  bareClonePath: string,
  agentDir: string,
): Promise<void> {
  const worktreePath = agentWorktreePath(agentDir, slug);
  const branch = agentBranchName(agentName);

  if (existsSync(worktreePath)) {
    try {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", worktreePath],
        {
          cwd: bareClonePath,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
