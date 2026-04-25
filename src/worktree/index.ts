/**
 * Public API for the switchroom-worktree subsystem.
 */

export { claimWorktree, resolveRepoPath, worktreesBaseDir } from "./claim.js";
export { releaseWorktree } from "./release.js";
export { listWorktrees } from "./list.js";
export { runReaper, STALE_THRESHOLD_MS } from "./reaper.js";
export {
  writeRecord,
  readRecord,
  deleteRecord,
  listRecords,
  touchHeartbeat,
  countByRepo,
  registryDir,
  recordPath,
} from "./registry.js";
export type {
  WorktreeRecord,
  ClaimInput,
  ClaimResult,
  ReleaseInput,
  ReleaseResult,
  CodeRepoEntry,
} from "./types.js";
