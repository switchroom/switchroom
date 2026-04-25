/**
 * claim_worktree: atomically reserve a git worktree for a sub-agent.
 *
 * Protocol:
 *   1. Resolve repo path from alias or absolute path.
 *   2. Check concurrency cap.
 *   3. Write registry record BEFORE running git (atomic claim).
 *   4. Run git worktree add with the generated branch.
 *   5. Return { id, path, branch }.
 *
 * If git fails after the registry write, we clean up the record so the
 * claim doesn't ghost.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { writeRecord, countByRepo, deleteRecord } from "./registry.js";
import type { ClaimInput, ClaimResult, CodeRepoEntry } from "./types.js";

/** Default max simultaneous worktrees per repo. */
export const DEFAULT_CONCURRENCY = 5;

/** Base directory where worktrees are created. */
export function worktreesBaseDir(): string {
  return resolve(
    process.env.SWITCHROOM_WORKTREE_BASE ?? join(homedir(), ".switchroom", "worktree-checkouts"),
  );
}

/**
 * Generate a short URL-safe ID (8 hex chars).
 */
function shortId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Sanitize a task name for use in a branch name.
 * Allows alphanumeric, hyphens, underscores. Truncates at 40 chars.
 */
function sanitizeTaskName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Resolve a repo alias or absolute path to an absolute path.
 * Expands ~ and env vars minimally (only ~/).
 */
export function resolveRepoPath(
  repo: string,
  codeRepos?: CodeRepoEntry[],
): string {
  // Try alias match first
  if (codeRepos) {
    const entry = codeRepos.find(r => r.name === repo);
    if (entry) {
      return expandHome(entry.source);
    }
  }
  // Accept absolute path directly
  if (repo.startsWith("/") || repo.startsWith("~")) {
    return expandHome(repo);
  }
  throw new Error(
    `Repository "${repo}" is not declared in code_repos and is not an absolute path. ` +
    `Declare it in your agent's code_repos list or pass an absolute path.`,
  );
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Claim a worktree.
 *
 * @param input.repo    Alias from code_repos or absolute path.
 * @param input.taskName Optional human-readable suffix.
 * @param input.ownerAgent Optional agent name for the registry record.
 * @param codeRepos  code_repos entries from switchroom.yaml (optional).
 */
export async function claimWorktree(
  input: ClaimInput,
  codeRepos?: CodeRepoEntry[],
): Promise<ClaimResult> {
  const repoPath = resolveRepoPath(input.repo, codeRepos);

  // Check repo exists
  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  // Determine concurrency cap
  let concurrencyCap = DEFAULT_CONCURRENCY;
  if (codeRepos) {
    const entry = codeRepos.find(r => r.name === input.repo);
    if (entry?.concurrency !== undefined) concurrencyCap = entry.concurrency;
  }

  // Check concurrency cap
  const current = countByRepo(repoPath);
  if (current >= concurrencyCap) {
    throw new Error(
      `Concurrency cap of ${concurrencyCap} reached for repo "${input.repo}". ` +
      `Release existing worktrees before claiming more.`,
    );
  }

  // Generate ID and branch
  const id = shortId();
  const taskSuffix = input.taskName ? sanitizeTaskName(input.taskName) : "task";
  const branch = `task/${taskSuffix}-${id}`;

  // Compute worktree path
  const baseDir = worktreesBaseDir();
  mkdirSync(baseDir, { recursive: true });
  const worktreePath = join(baseDir, `${id}-${taskSuffix}`);

  const now = new Date().toISOString();
  const record = {
    id,
    repo: repoPath,
    repoName: input.repo,
    branch,
    path: worktreePath,
    createdAt: now,
    heartbeatAt: now,
    ownerAgent: input.ownerAgent,
  };

  // ATOMIC: write registry record BEFORE git operation.
  // If git fails, we delete the record to prevent orphaning.
  writeRecord(record);

  try {
    // git worktree add -b <branch> <path>
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch (err) {
    // Clean up the registry record since git failed
    deleteRecord(id);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git worktree add failed: ${msg}`);
  }

  return { id, path: worktreePath, branch };
}
