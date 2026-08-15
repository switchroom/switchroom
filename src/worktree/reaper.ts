/**
 * Reaper: clean up orphaned worktree claims.
 *
 * Reaper logic (liveness-based, NOT age-based):
 *   - A claim is stale when heartbeatAt is older than STALE_THRESHOLD_MS
 *     AND we can PROVE the worktree path is not held by any live process.
 *   - A claim is an orphan when the registry record exists but the
 *     filesystem worktree doesn't (a dangling record).
 *
 * FAIL-SAFE by construction (data-loss prevention, F1/H3):
 *   The reaper's whole job is to remove a *dead* claim's worktree with
 *   `git worktree remove --force`, which discards any working-tree state.
 *   That force-remove is only ever run when EVERY one of these holds:
 *     1. the heartbeat is stale (> STALE_THRESHOLD_MS), AND
 *     2. the worktree has NO uncommitted changes (a hard skip — never a
 *        mere warning: we do not destroy in-flight work), AND
 *     3. an in-use probe can DEFINITIVELY report the path as free.
 *   If the in-use probe cannot reach a definitive answer (no readable procfs
 *   and no `fuser`/`lsof`, or a procfs sweep that could not inspect every
 *   process) we treat the path as live and keep it — "can't prove it's
 *   idle" must never license a force-remove. A live claim advances its own
 *   heartbeat (see registry.touchHeartbeat, refreshed from the gateway's
 *   watch loop), so a genuinely-abandoned claim is the only thing that
 *   reaches the stale branch in the first place.
 *
 * OPERATIONAL NOTE — dead-but-dirty worktrees are KEPT, not auto-deleted.
 *   Because fail-safe 2 hard-skips any stale worktree with uncommitted
 *   changes, a truly-abandoned claim whose tree is dirty is never reaped
 *   automatically — by design, so in-flight work is never destroyed. The
 *   trade-off is that such worktrees accumulate until a human clears them.
 *   The reaper therefore makes the skip VISIBLE: `runReaper` returns them in
 *   `ReapResult.skipped` (and `switchroom worktree reap` / `reap --dry-run`
 *   print them with a reason). The manual remediation for a dirty skip is:
 *     1. inspect the worktree (`git -C <path> status`),
 *     2. commit or salvage the work,
 *     3. release it: `switchroom worktree release <id>`  (or, if the record
 *        is already gone, `git worktree remove <path>`).
 *   There is deliberately NO auto-delete of a dirty tree.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { scanProcForHolders, type ProcScanResult } from "./proc-liveness.js";
import { listRecords, deleteRecord } from "./registry.js";
import { removeCheckout } from "./remove-checkout.js";
import type { WorktreeRecord } from "./types.js";

/** Heartbeat age threshold in ms. Claims older than this are stale. */
export const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Result of probing whether a path is held open by a live process.
 *   - "in-use"      — a probe positively found a holder → keep the claim.
 *   - "free"        — a probe ran and found NO holder → safe to consider reap.
 *   - "unavailable" — the probe could not reach a definitive answer (no
 *                     readable procfs and no fuser/lsof, or a procfs sweep
 *                     that could not inspect every process) → we cannot tell,
 *                     so the reaper treats the path as live (fail-safe).
 */
export type PathUseState = "in-use" | "free" | "unavailable";

/** Injectable dependencies for `runReaper` (defaults use the real probes). */
export interface ReaperDeps {
  /** Probe whether the worktree path is held open by a live process. */
  probeInUse?: (path: string) => PathUseState;
  /** Detect uncommitted (staged or unstaged) changes in the worktree. */
  hasUncommittedChanges?: (repoPath: string, worktreePath: string) => boolean;
  /** Force-remove the worktree (defaults to `git worktree remove --force`). */
  removeWorktree?: (repoPath: string, worktreePath: string) => void;
}

export interface ReapResult {
  reaped: string[];
  warnings: string[];
  /**
   * Stale worktrees that were KEPT (not reaped) because a fail-safe guard
   * fired — dirty tree, in-use, or an unavailable probe. Surfaced so the
   * consequence of the never-auto-delete-dirty policy is visible instead of
   * silently accumulating. (M2.)
   */
  skipped: ReapPlanEntry[];
}

/**
 * The decision the reaper reaches for a single record. Both `runReaper` (the
 * real pass) and `switchroom worktree reap --dry-run` route through the SAME
 * predicate (`planReaper`) so a dry-run reports EXACTLY what a real run would
 * do — the dirty / probe guards are applied in both, not just the real run
 * (L1: dry-run used to over-report by looking at heartbeat age alone).
 */
export type ReapAction =
  /** Registry record with no filesystem worktree → drop the dangling record. */
  | "reap-orphan"
  /** Stale + clean + provably free → force-remove the worktree. */
  | "reap"
  /** Heartbeat still fresh → live claim, untouched. */
  | "keep-fresh"
  /** Stale but has uncommitted changes → preserve (never auto-delete dirty). */
  | "skip-dirty"
  /** Stale + clean but nothing could prove it idle → treat as live. */
  | "skip-probe-unavailable"
  /** Stale + clean but the probe positively found a holder → keep. */
  | "skip-in-use";

export interface ReapPlanEntry {
  record: WorktreeRecord;
  action: ReapAction;
  /** Human-readable line (used for warnings and dry-run output). */
  message: string;
}

/** Short, user-facing reason for a `skip-*` action (CLI + dry-run output). */
export function reapSkipReasonText(action: ReapAction): string {
  switch (action) {
    case "skip-dirty":
      return "uncommitted changes";
    case "skip-probe-unavailable":
      return "cannot verify not in use";
    case "skip-in-use":
      return "in use by a live process";
    default:
      return action;
  }
}

/**
 * External-tool leg of the probe: `fuser` (Linux/procps), then `lsof`
 * (macOS/BSD).
 *
 * `lsof` is invoked with `+D` so it descends the tree — plain `lsof -t <dir>`
 * matches the directory EXACTLY and misses a process sitting in a nested
 * subdirectory, which is the bug this module's procfs scan exists to fix.
 * `fuser` has no recursive mode at all, so it is kept only as a POSITIVE
 * signal: it can say "in-use", it can never be trusted to say "free".
 *
 * Distinguishes "the tool RAN and found nothing" (→ "free") from "the tool is
 * not installed" (→ "unavailable"): a missing binary surfaces as a spawn
 * `ENOENT`, a real "not in use" as a non-zero *exit*.
 */
export function probePathInUseWithTools(path: string): PathUseState {
  let probeRan = false;

  // fuser: exits 0 when the path is in use; non-zero when not; ENOENT when
  // the binary itself is missing. Positive-only — a non-zero exit here does
  // NOT mark the probe as having answered, because fuser cannot see a holder
  // in a nested subdirectory.
  try {
    execFileSync("fuser", [path], { stdio: "pipe" });
    return "in-use";
  } catch {
    /* not in use per fuser, or fuser missing — either way, inconclusive. */
  }

  // lsof +D: recurses into the tree and reports every process with an open
  // file (cwd entries included) at or below it. Exits 0 with PID output when
  // in use; non-zero (non-ENOENT) when not.
  try {
    const out = execFileSync("lsof", ["-t", "+D", path], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    probeRan = true;
    if (out.length > 0) return "in-use";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // lsof ran and found nothing → not in use (per lsof).
      probeRan = true;
    }
  }

  return probeRan ? "free" : "unavailable";
}

/** Injectable seams for `probePathInUse` (tests / host portability). */
export interface ProbeDeps {
  scanProc?: (path: string) => ProcScanResult;
  probeTools?: (path: string) => PathUseState;
}

/**
 * Probe whether any process holds the worktree path open — AT OR BELOW the
 * tree root.
 *
 * Primary mechanism is the procfs scan (`scanProcForHolders`): it matches a
 * process whose cwd is any directory beneath the tree, and any open fd into
 * the tree, including across a container mount namespace. See
 * `proc-liveness.ts` for the failure it fixes — `fuser`/`lsof -t` match the
 * path exactly, so both reported "free" for a tree an agent was working in.
 *
 * Resolution order, safety-first:
 *   1. procfs found a holder                      → "in-use"
 *   2. procfs swept EVERY process, found none     → "free"   (definitive)
 *   3. procfs sweep was PARTIAL (some processes
 *      unreadable) or procfs is absent            → fall back to the tools;
 *      a tool hit is still "in-use", but a tool MISS after a partial sweep is
 *      "unavailable", never "free" — we could not inspect every process and
 *      the tools cannot see a nested holder, so nothing here proves the tree
 *      is idle.
 *
 * Consequence worth knowing before automating deletion: run as a uid that
 * cannot read other users' `/proc/<pid>/cwd` (i.e. not the tree owner and not
 * root), this returns "unavailable" for a tree it cannot clear — the reaper
 * keeps it. That is the intended posture ("can't prove it's idle" must never
 * license a force-remove, per this module's fail-safe contract), and the
 * report-only pass (`reap-report.ts`) surfaces the count so the exposure is
 * measurable before anyone turns on deletion.
 */
export function probePathInUse(path: string, deps: ProbeDeps = {}): PathUseState {
  const scanProc = deps.scanProc ?? ((p: string) => scanProcForHolders(p));
  const probeTools = deps.probeTools ?? probePathInUseWithTools;

  const scan = scanProc(path);
  if (scan.state === "in-use") return "in-use";
  if (scan.state === "free" && scan.inaccessible === 0) return "free";

  const tool = probeTools(path);
  if (tool === "in-use") return "in-use";
  // Partial procfs sweep: a tool miss cannot upgrade it to "free".
  if (scan.state === "free") return "unavailable";
  // No procfs at all (non-Linux): the tools are the only evidence there is.
  return tool;
}

/**
 * Check if a worktree has uncommitted changes.
 * Returns true if there are staged or unstaged changes.
 *
 * On ANY error running git (path is not a git worktree, git missing, etc.)
 * we return `true` — "can't tell" must fail toward preservation, never toward
 * a force-remove.
 */
function hasUncommittedChanges(_repoPath: string, worktreePath: string): boolean {
  try {
    const out = execFileSync(
      "git",
      ["-C", worktreePath, "status", "--porcelain"],
      { stdio: "pipe" },
    ).toString();
    return out.trim().length > 0;
  } catch {
    // Can't determine cleanliness → assume dirty so we never force-remove
    // work we failed to inspect.
    return true;
  }
}

/**
 * Default force-remove — shape-aware (see remove-checkout.ts): independent
 * clones are `rm -rf`d, legacy linked worktrees go through
 * `git worktree remove --force`.
 */
function defaultRemoveWorktree(repoPath: string, worktreePath: string): void {
  try {
    removeCheckout(repoPath, worktreePath);
  } catch {
    // If removal fails, the caller still deletes the record. The path may
    // have been manually deleted or the repo moved.
  }
}

/**
 * Classify every registry record into the action the reaper would take,
 * WITHOUT mutating anything. This is the single source of truth for the
 * reaper's decision — `runReaper` executes the plan and the CLI dry-run
 * merely reports it, so the two can never diverge (L1).
 *
 * @param nowMs Optional override for "now" (for testing).
 * @param deps  Optional injectable probes (for testing / host portability).
 */
export function planReaper(nowMs?: number, deps: ReaperDeps = {}): ReapPlanEntry[] {
  const now = nowMs ?? Date.now();
  const probeInUse = deps.probeInUse ?? probePathInUse;
  const uncommitted = deps.hasUncommittedChanges ?? hasUncommittedChanges;

  const plan: ReapPlanEntry[] = [];

  for (const record of listRecords()) {
    const heartbeatAge = now - new Date(record.heartbeatAt).getTime();
    const worktreeExists = existsSync(record.path);

    // Case 1: Orphan — registry record exists but filesystem worktree doesn't.
    // Nothing to force-remove; just drop the dangling record.
    if (!worktreeExists) {
      plan.push({
        record,
        action: "reap-orphan",
        message: `[worktree-reaper] orphan record (no worktree on disk): id=${record.id} path=${record.path}`,
      });
      continue;
    }

    // Not stale yet → live claim, keep it.
    if (heartbeatAge <= STALE_THRESHOLD_MS) {
      plan.push({ record, action: "keep-fresh", message: "" });
      continue;
    }

    // ── Stale + worktree present: run the fail-safe gauntlet before any
    //    `git worktree remove --force`. Only reap when ALL guards clear. ──

    // Fail-safe 1: NEVER destroy uncommitted work. Hard skip (not a warning
    // that proceeds to remove — that was the F1/H3 data-loss bug). The skip is
    // surfaced with the manual remediation path (M2) so dirty worktrees don't
    // silently accumulate.
    if (uncommitted(record.repo, record.path)) {
      plan.push({
        record,
        action: "skip-dirty",
        message:
          `[worktree-reaper] SKIPPED stale worktree with UNCOMMITTED changes ` +
          `(not removed — preserving in-flight work): id=${record.id} ` +
          `branch=${record.branch} agent=${record.ownerAgent ?? "unknown"} ` +
          `path=${record.path} — remediation: inspect, commit/salvage, then ` +
          `\`switchroom worktree release ${record.id}\` (or \`git worktree remove ${record.path}\`)`,
      });
      continue;
    }

    // Fail-safe 2: only reap when the path is DEFINITIVELY free. Both
    // "in-use" and "unavailable" (nothing could prove idleness) mean we
    // cannot show the worktree is dead → keep it.
    const use = probeInUse(record.path);
    if (use === "unavailable") {
      plan.push({
        record,
        action: "skip-probe-unavailable",
        message:
          `[worktree-reaper] SKIPPED stale worktree — in-use probe ` +
          `could not prove the path idle (no readable procfs, no ` +
          `fuser/lsof, or a partial procfs sweep); treating as ` +
          `live: id=${record.id} path=${record.path}`,
      });
      continue;
    }
    if (use === "in-use") {
      plan.push({
        record,
        action: "skip-in-use",
        message:
          `[worktree-reaper] kept stale worktree held open by a live process: ` +
          `id=${record.id} path=${record.path}`,
      });
      continue;
    }

    // All guards cleared: stale, clean, and provably not in use → reap.
    plan.push({
      record,
      action: "reap",
      message: `[worktree-reaper] reaping stale worktree: id=${record.id} path=${record.path}`,
    });
  }

  return plan;
}

/**
 * Run the reaper pass — execute the plan from `planReaper`.
 *
 * @param nowMs Optional override for "now" (for testing).
 * @param deps  Optional injectable probes (for testing / host portability).
 */
export function runReaper(nowMs?: number, deps: ReaperDeps = {}): ReapResult {
  const removeWorktree = deps.removeWorktree ?? defaultRemoveWorktree;
  const plan = planReaper(nowMs, deps);

  const reaped: string[] = [];
  const warnings: string[] = [];
  const skipped: ReapPlanEntry[] = [];

  for (const entry of plan) {
    switch (entry.action) {
      case "reap-orphan":
        deleteRecord(entry.record.id);
        reaped.push(entry.record.id);
        break;
      case "reap":
        removeWorktree(entry.record.repo, entry.record.path);
        deleteRecord(entry.record.id);
        reaped.push(entry.record.id);
        break;
      case "keep-fresh":
        break;
      case "skip-dirty":
      case "skip-probe-unavailable":
        // These two carry an operator-facing warning (backward-compatible with
        // the pre-M2 behaviour); an in-use skip is expected/benign and is only
        // reported via `skipped`, not `warnings`.
        warnings.push(entry.message);
        skipped.push(entry);
        break;
      case "skip-in-use":
        skipped.push(entry);
        break;
    }
  }

  return { reaped, warnings, skipped };
}
