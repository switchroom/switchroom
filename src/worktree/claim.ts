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
import { closeSync, mkdirSync, openSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { writeRecord, countByRepo, deleteRecord, registryDir } from "./registry.js";
import type { ClaimInput, ClaimResult, CodeRepoEntry } from "./types.js";

/**
 * Acquire a per-repo lockfile to serialize claim() across processes.
 *
 * The TOCTOU window between countByRepo() and writeRecord() lets two
 * concurrent claims both pass the cap check. A lockfile with O_EXCL
 * forces them to serialize. Returns a release function the caller MUST
 * call (use try/finally).
 */
function acquireRepoLock(repoPath: string): () => void {
  const lockDir = registryDir();
  mkdirSync(lockDir, { recursive: true });
  // Different repos shouldn't block each other — lockfile per repo path.
  const lockName = repoPath.replace(/[^A-Za-z0-9]/g, "_");
  const lockPath = join(lockDir, `.lock-${lockName}`);
  const deadline = Date.now() + 5_000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `Failed to acquire claim lock for "${repoPath}" within 5s. ` +
          `Another claim may be hung; check ${lockPath} and remove if stale.`,
        );
      }
      const start = Date.now();
      while (Date.now() - start < 50) { /* spin briefly */ }
    }
  }
  return () => {
    try { closeSync(fd as number); } catch { /* ignore */ }
    try { unlinkSync(lockPath); } catch { /* race-tolerant */ }
  };
}

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

  // Acquire per-repo lock so concurrent claims serialize through the
  // count-check + writeRecord critical section. Without the lock, two
  // callers can both read count<cap and both write, violating the cap.
  const releaseLock = acquireRepoLock(repoPath);

  let id: string;
  let branch: string;
  let worktreePath: string;
  try {
    // Check concurrency cap (now race-free under the lock)
    const current = countByRepo(repoPath);
    if (current >= concurrencyCap) {
      throw new Error(
        `Concurrency cap of ${concurrencyCap} reached for repo "${input.repo}". ` +
        `Release existing worktrees before claiming more.`,
      );
    }

    // Generate ID and branch
    id = shortId();
    const taskSuffix = input.taskName ? sanitizeTaskName(input.taskName) : "task";
    branch = `task/${taskSuffix}-${id}`;

    // Compute worktree path
    const baseDir = worktreesBaseDir();
    mkdirSync(baseDir, { recursive: true });
    worktreePath = join(baseDir, `${id}-${taskSuffix}`);

    // Default ownership from the ambient agent identity when the caller
    // didn't pass one explicitly. A worktree an agent claims WITHOUT the CLI
    // `-a/--agent` flag would otherwise produce an ownerless record, which the
    // gateway's `extraWatchCwdsProvider` filters out — so the sub-agent running
    // in it stays invisible in the worker feed (Known-Gap-2 regression). An
    // agent always claims its own worktrees, so `SWITCHROOM_AGENT_NAME` is the
    // correct owner when no explicit owner is given. Empty string is treated as
    // unset (never write a falsy owner).
    const ambientOwner = process.env.SWITCHROOM_AGENT_NAME;
    const ownerAgent =
      input.ownerAgent ?? (ambientOwner != null && ambientOwner !== "" ? ambientOwner : undefined);

    const now = new Date().toISOString();
    const record = {
      id,
      repo: repoPath,
      repoName: input.repo,
      branch,
      path: worktreePath,
      createdAt: now,
      heartbeatAt: now,
      ownerAgent,
    };

    // ATOMIC: write registry record BEFORE git operation.
    // If git fails, we delete the record to prevent orphaning.
    writeRecord(record);
  } finally {
    // Release lock before the (potentially slow) git operation. The cap
    // check + record write are done; subsequent counts include this record.
    releaseLock();
  }

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
