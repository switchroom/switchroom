/**
 * Bare-clone management for per-agent worktree provisioning.
 *
 * One bare clone per repo slug lives at ~/.switchroom/repos/<slug>.git,
 * shared across all agents. The bare clone is the source from which
 * per-agent worktrees are created (git worktree add).
 *
 * Design decision: bare clones share .git/objects across all worktrees
 * checked out of them, so five agents on the same 200MB repo cost one
 * clone worth of storage, not five.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStatePath } from "../config/paths.js";

/**
 * Resolve the filesystem path for the bare clone of a given slug.
 * All bare clones live under ~/.switchroom/repos/<slug>.git.
 */
export function bareClonePath(slug: string): string {
  return resolveStatePath(`repos/${slug}.git`);
}

/**
 * Ensure a bare clone of `url` exists at ~/.switchroom/repos/<slug>.git.
 *
 * - First call: `git clone --bare <url> <path>` (creates the clone).
 * - Subsequent calls: `git fetch --all` to refresh all remotes.
 *
 * Idempotent — safe to call on every reconcile.
 *
 * @param slug   Kebab-case repo key from switchroom.yaml (e.g. "switchroom-web")
 * @param url    Git remote URL (used verbatim; never auto-derived)
 * @returns      Absolute path to the bare clone directory
 */
export async function ensureBareClone(slug: string, url: string): Promise<string> {
  const reposDir = resolveStatePath("repos");
  mkdirSync(reposDir, { recursive: true });

  const clonePath = bareClonePath(slug);

  if (!existsSync(clonePath)) {
    process.stderr.write(`[switchroom] repo "${slug}": cloning ${url} …\n`);
    execFileSync("git", ["clone", "--bare", url, clonePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stderr.write(`[switchroom] repo "${slug}": bare clone ready at ${clonePath}\n`);
  } else {
    // Already cloned — refresh all remotes so the per-agent branch can
    // fast-forward to the latest upstream.
    process.stderr.write(`[switchroom] repo "${slug}": fetching ${clonePath} …\n`);
    try {
      execFileSync("git", ["fetch", "--all"], {
        cwd: clonePath,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // Non-fatal: fetch can fail when the network is unreachable or the
      // remote URL has rotated. We still return the clone path so the
      // worktree can resume from its last-known state.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[switchroom] repo "${slug}": fetch failed (continuing with cached clone): ${msg}\n`,
      );
    }
  }

  return resolve(clonePath);
}
