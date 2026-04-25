/**
 * Types for the switchroom-worktree subsystem.
 *
 * Registry records live at ~/.switchroom/worktrees/<id>.json.
 * Each record describes a single active git worktree claim.
 */

export interface WorktreeRecord {
  /** Unique claim ID (nanoid short) */
  id: string;
  /** Resolved absolute path to the source repo */
  repo: string;
  /** Logical name declared in code_repos (or the path itself if undeclared) */
  repoName: string;
  /** Auto-generated branch: task/<taskName>-<shortId> */
  branch: string;
  /** Absolute path of the worktree directory */
  path: string;
  /** ISO 8601 timestamp when the claim was created */
  createdAt: string;
  /** ISO 8601 timestamp of most recent heartbeat */
  heartbeatAt: string;
  /** Agent name that claimed this worktree (optional) */
  ownerAgent?: string;
}

/** Input to claim_worktree */
export interface ClaimInput {
  /** Repo alias from code_repos, or an absolute path */
  repo: string;
  /** Human-readable suffix for the branch name */
  taskName?: string;
  /** Agent name requesting the claim */
  ownerAgent?: string;
}

/** Output from claim_worktree */
export interface ClaimResult {
  id: string;
  path: string;
  branch: string;
}

/** Input to release_worktree */
export interface ReleaseInput {
  id: string;
}

/** Output from release_worktree */
export interface ReleaseResult {
  released: boolean;
}

/**
 * A single code repo entry from switchroom.yaml agent config.
 */
export interface CodeRepoEntry {
  /** Short alias used when claiming (e.g. "switchroom") */
  name: string;
  /** Absolute or home-relative path to the repo (e.g. ~/code/switchroom) */
  source: string;
  /** Max simultaneous worktrees for this repo (default 5) */
  concurrency?: number;
}
