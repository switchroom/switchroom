/**
 * claim_worktree: atomically reserve an isolated checkout for a sub-agent.
 *
 * Protocol:
 *   1. Resolve repo path from alias or absolute path.
 *   2. Check concurrency cap.
 *   3. Write registry record BEFORE running git (atomic claim).
 *   4. Provision an INDEPENDENT CLONE of the repo on the generated branch.
 *   5. Return { id, path, branch }.
 *
 * If git fails after the registry write, we clean up the record so the
 * claim doesn't ghost.
 *
 * WHY A CLONE AND NOT `git worktree add` (worktree-collision fix):
 * linked worktrees share the parent repo's object store, refs — including
 * the SINGLE `refs/stash` — and `.git/worktrees/<name>` admin metadata.
 * Observed in production: one worker's `git stash pop` popped a DIFFERENT
 * worker's stash entry, leaving conflict markers in unrelated files; stale
 * `.git/worktrees/<name>` index metadata survived `worktree remove --force`
 * + `rm -rf` + `prune` and resurrected a previous claim's dirty state; and
 * workers stepping into the shared parent repo flipped it to detached HEAD
 * mid-run. Those are inherent to worktree semantics — no amount of naming
 * or locking discipline fixes a shared stash ref. An independent clone
 * shares NOTHING mutable with the source repo, so concurrent claims cannot
 * collide by construction. A local clone hardlinks the object store (same
 * filesystem), so the disk/time cost is near a worktree's, not a full
 * re-download.
 */

import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
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

/** Base directory where task checkouts are created. */
export function worktreesBaseDir(): string {
  return resolve(
    process.env.SWITCHROOM_WORKTREE_BASE ?? join(homedir(), ".switchroom", "worktree-checkouts"),
  );
}

/**
 * Reject a checkout base directory under a tmp mount.
 *
 * Agent containers mount /tmp `noexec`, so a checkout placed there fails the
 * moment anything tries to run a binary out of it (`npm ci` →
 * `spawnSync .../esbuild EACCES`). That failure surfaces minutes into a task
 * and looks like a toolchain bug; failing the CLAIM with a clear message is
 * the deterministic version of the "never /tmp, always $HOME" prose rule.
 *
 * Escape hatch: SWITCHROOM_WORKTREE_ALLOW_TMP=1 (tests and hosts whose tmp
 * is exec-mounted).
 */
export function assertBaseDirNotTmp(baseDir: string): void {
  if (process.env.SWITCHROOM_WORKTREE_ALLOW_TMP === "1") return;
  const base = resolve(baseDir);
  const tmpRoots = new Set([resolve(tmpdir()), "/tmp", "/var/tmp"]);
  for (const root of tmpRoots) {
    if (base === root || base.startsWith(root + sep)) {
      throw new Error(
        `Refusing to provision a checkout under "${base}": tmp filesystems are ` +
        `mounted noexec in agent containers, so builds there fail with EACCES ` +
        `(e.g. npm ci spawning esbuild). Set SWITCHROOM_WORKTREE_BASE to a ` +
        `directory under $HOME (default: ~/.switchroom/worktree-checkouts), or ` +
        `set SWITCHROOM_WORKTREE_ALLOW_TMP=1 if this host's tmp is exec-mounted.`,
      );
    }
  }
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

    // Compute checkout path — enforced OUTSIDE tmp (noexec in containers).
    const baseDir = worktreesBaseDir();
    assertBaseDirNotTmp(baseDir);
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
      kind: "clone" as const,
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
    // Provision an INDEPENDENT clone (see module header for why not
    // `git worktree add`). Branch from the source repo's current HEAD
    // commit — the same starting point `worktree add -b` used — resolved
    // BEFORE cloning so a detached-HEAD source still works.
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();

    // Local clone: hardlinks the object store on the same filesystem, so
    // this is cheap. --no-checkout because we check out the task branch
    // ourselves in the next step.
    execFileSync("git", ["clone", "--quiet", "--no-checkout", repoPath, worktreePath], {
      stdio: "pipe",
    });
    execFileSync("git", ["checkout", "--quiet", "-b", branch, headSha], {
      cwd: worktreePath,
      stdio: "pipe",
    });

    // Rewire `origin` from the local source path to the source repo's real
    // remote, so `git fetch origin` / `git push origin` in the checkout hit
    // upstream — matching what a linked worktree (which shared the parent's
    // remotes) used to give workers. If the source has no origin, leave the
    // local path in place.
    let originUrl: string | undefined;
    try {
      originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: repoPath,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
    } catch {
      /* source repo has no origin remote */
    }
    if (originUrl) {
      execFileSync("git", ["remote", "set-url", "origin", originUrl], {
        cwd: worktreePath,
        stdio: "pipe",
      });
    }
  } catch (err) {
    // Clean up the registry record AND any partial clone since git failed.
    deleteRecord(id);
    rmSync(worktreePath, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`checkout provisioning (git clone) failed: ${msg}`);
  }

  return { id, path: worktreePath, branch };
}
