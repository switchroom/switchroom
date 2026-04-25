/**
 * list_worktrees: enumerate active worktree claims for operator visibility.
 */

import { listRecords } from "./registry.js";
import type { WorktreeRecord } from "./types.js";

export interface ListedWorktree {
  id: string;
  repo: string;
  repoName: string;
  branch: string;
  path: string;
  /** Age in seconds since claim was created */
  ageSeconds: number;
  /** Seconds since last heartbeat */
  heartbeatAgeSeconds: number;
  ownerAgent?: string;
  createdAt: string;
  heartbeatAt: string;
}

export interface ListResult {
  worktrees: ListedWorktree[];
}

/**
 * List all active worktree claims.
 */
export function listWorktrees(): ListResult {
  const now = Date.now();
  const records = listRecords();
  const worktrees: ListedWorktree[] = records.map(r => {
    const ageSeconds = Math.floor((now - new Date(r.createdAt).getTime()) / 1000);
    const heartbeatAgeSeconds = Math.floor(
      (now - new Date(r.heartbeatAt).getTime()) / 1000,
    );
    return {
      id: r.id,
      repo: r.repo,
      repoName: r.repoName,
      branch: r.branch,
      path: r.path,
      ageSeconds,
      heartbeatAgeSeconds,
      ownerAgent: r.ownerAgent,
      createdAt: r.createdAt,
      heartbeatAt: r.heartbeatAt,
    };
  });
  return { worktrees };
}
