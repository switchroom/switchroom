/**
 * Report-only reaper pass — outcome tests.
 *
 * The invariants under test are: nothing on this path deletes anything, the
 * per-agent budget orders evictions oldest-first, and the budget can never
 * promote a tree that fails a safety guard.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listRecords, writeRecord } from "../src/worktree/registry.js";
import { STALE_THRESHOLD_MS, type ReapPlanEntry } from "../src/worktree/reaper.js";
import type { GcPlan, TaskTreeAction } from "../src/worktree/gc.js";
import {
  agentFromPath,
  agentTreeBudgetBytes,
  buildReapReport,
  formatReapReport,
  DEFAULT_AGENT_TREE_BUDGET_BYTES,
  UNATTRIBUTED_AGENT,
} from "../src/worktree/reap-report.js";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const DAY = 86_400_000;
const GB = 1024 * 1024 * 1024;

function taskTree(over: Partial<TaskTreeAction> & { dir: string }): TaskTreeAction {
  return {
    shape: "clone",
    ownerRepo: null,
    branch: "task/x",
    verdict: "reap",
    prSignal: "merged",
    idle: true,
    newestMtimeMs: NOW - 30 * DAY,
    dest: "/trash/x",
    willAct: true,
    ...over,
  };
}

function gcPlan(taskTrees: TaskTreeAction[]): GcPlan {
  return {
    roots: [],
    taskTreeRoots: [],
    trashDir: "/trash",
    orphans: [],
    registered: [],
    taskTrees,
    reposToPrune: [],
    skipped: [],
  };
}

/** `<home>/agents/<agent>/home/work/<slug>` — the real task-tree shape. */
function treePath(agent: string, slug: string): string {
  return join("/srv", ".switchroom", "agents", agent, "home", "work", slug);
}

describe("worktree reap-report", () => {
  it("attributes a task tree to its agent, and falls back cleanly", () => {
    expect(agentFromPath(treePath("klanker", "fix-3019"))).toBe("klanker");
    expect(agentFromPath("/home/op/code/switchroom-x")).toBeNull();
  });

  it("orders each agent's trees oldest-first", () => {
    const report = buildReapReport({
      nowMs: NOW,
      reapPlan: [],
      dirSizeBytes: () => 1024,
      gcPlan: gcPlan([
        taskTree({ dir: treePath("klanker", "newer"), newestMtimeMs: NOW - 20 * DAY }),
        taskTree({ dir: treePath("klanker", "oldest"), newestMtimeMs: NOW - 90 * DAY }),
        taskTree({ dir: treePath("klanker", "middle"), newestMtimeMs: NOW - 45 * DAY }),
      ]),
    });

    const agent = report.agents.find((a) => a.agent === "klanker");
    expect(agent?.entries.map((e) => e.path)).toEqual([
      treePath("klanker", "oldest"),
      treePath("klanker", "middle"),
      treePath("klanker", "newer"),
    ]);
    expect(agent?.entries.map((e) => e.idleDays)).toEqual([90, 45, 20]);
  });

  it("sorts a tree with unknown activity LAST, never at the head of the eviction order", () => {
    const report = buildReapReport({
      nowMs: NOW,
      reapPlan: [],
      dirSizeBytes: () => 1024,
      gcPlan: gcPlan([
        taskTree({ dir: treePath("a", "unknown"), newestMtimeMs: null }),
        taskTree({ dir: treePath("a", "old"), newestMtimeMs: NOW - 60 * DAY }),
      ]),
    });
    expect(report.agents[0]!.entries.map((e) => e.path)).toEqual([
      treePath("a", "old"),
      treePath("a", "unknown"),
    ]);
  });

  it("marks only as many oldest trees over-budget as it takes to get under budget", () => {
    const report = buildReapReport({
      nowMs: NOW,
      budgetBytes: 5 * GB,
      reapPlan: [],
      dirSizeBytes: () => 2 * GB, // 4 trees × 2 GB = 8 GB against a 5 GB budget
      gcPlan: gcPlan([
        taskTree({ dir: treePath("klanker", "t1"), newestMtimeMs: NOW - 10 * DAY }),
        taskTree({ dir: treePath("klanker", "t2"), newestMtimeMs: NOW - 20 * DAY }),
        taskTree({ dir: treePath("klanker", "t3"), newestMtimeMs: NOW - 30 * DAY }),
        taskTree({ dir: treePath("klanker", "t4"), newestMtimeMs: NOW - 40 * DAY }),
      ]),
    });

    const agent = report.agents[0]!;
    expect(agent.totalBytes).toBe(8 * GB);
    // 8 GB − 2 evictions × 2 GB = 4 GB ≤ 5 GB, so exactly the two oldest.
    expect(agent.entries.filter((e) => e.overBudget).map((e) => e.path)).toEqual([
      treePath("klanker", "t4"),
      treePath("klanker", "t3"),
    ]);
    expect(agent.reclaimableBytes).toBe(4 * GB);
    expect(agent.stillOverBytes).toBe(0);
  });

  it("never marks a guard-blocked tree over-budget, and says how much stays over", () => {
    const report = buildReapReport({
      nowMs: NOW,
      budgetBytes: 1 * GB,
      reapPlan: [],
      dirSizeBytes: () => 2 * GB,
      gcPlan: gcPlan([
        // The oldest tree is dirty — the budget must not promote it.
        taskTree({
          dir: treePath("klanker", "dirty"),
          newestMtimeMs: NOW - 90 * DAY,
          verdict: "skip-dirty",
          willAct: false,
        }),
        taskTree({
          dir: treePath("klanker", "inuse"),
          newestMtimeMs: NOW - 80 * DAY,
          verdict: "skip-in-use",
          willAct: false,
        }),
        taskTree({ dir: treePath("klanker", "clean"), newestMtimeMs: NOW - 10 * DAY }),
      ]),
    });

    const agent = report.agents[0]!;
    const overBudget = agent.entries.filter((e) => e.overBudget);
    expect(overBudget.map((e) => e.path)).toEqual([treePath("klanker", "clean")]);
    // 6 GB total − 2 GB reclaimable = 4 GB, i.e. 3 GB still over a 1 GB budget.
    expect(agent.stillOverBytes).toBe(3 * GB);
    expect(formatReapReport(report)).toContain("would remain over budget");
  });

  it("counts verdicts and the unprovable-idle exposure across both sources", () => {
    const claim = (id: string, action: ReapPlanEntry["action"]): ReapPlanEntry => ({
      record: {
        id,
        repo: "/repo",
        repoName: "switchroom",
        branch: `task/${id}`,
        path: `/srv/.switchroom/worktree-checkouts/${id}`,
        createdAt: new Date(NOW - STALE_THRESHOLD_MS * 4).toISOString(),
        heartbeatAt: new Date(NOW - STALE_THRESHOLD_MS * 3).toISOString(),
        ownerAgent: "klanker",
      },
      action,
      message: "",
    });

    const report = buildReapReport({
      nowMs: NOW,
      reapPlan: [
        claim("keep", "keep-fresh"), // excluded: not a candidate
        claim("c1", "skip-probe-unavailable"),
        claim("c2", "reap"),
      ],
      dirSizeBytes: () => 1024,
      gcPlan: gcPlan([
        taskTree({ dir: treePath("klanker", "t1"), verdict: "skip-probe-unavailable", willAct: false }),
        taskTree({ dir: treePath("klanker", "t2") }),
        // Protected trees are never candidates.
        taskTree({ dir: treePath("klanker", "stable"), verdict: "skip-protected", willAct: false }),
      ]),
    });

    expect(report.totals.candidates).toBe(4);
    expect(report.totals.wouldReap).toBe(2);
    expect(report.totals.wouldSkip).toBe(2);
    expect(report.totals.probeUnavailable).toBe(2);
    expect(report.verdictCounts["skip-protected"]).toBeUndefined();
    expect(report.verdictCounts["keep-fresh"]).toBeUndefined();
  });

  it("labels an unattributable tree instead of dropping it", () => {
    const report = buildReapReport({
      nowMs: NOW,
      reapPlan: [],
      dirSizeBytes: () => 1024,
      gcPlan: gcPlan([taskTree({ dir: "/home/op/code/switchroom-stray" })]),
    });
    expect(report.agents[0]!.agent).toBe(UNATTRIBUTED_AGENT);
  });

  it("counts a tree whose size cannot be measured as 0 bytes, flagged, not skipped", () => {
    const report = buildReapReport({
      nowMs: NOW,
      reapPlan: [],
      dirSizeBytes: () => {
        throw new Error("du: permission denied");
      },
      gcPlan: gcPlan([taskTree({ dir: treePath("a", "t1") })]),
    });
    const entry = report.agents[0]!.entries[0]!;
    expect(entry.sizeKnown).toBe(false);
    expect(entry.sizeBytes).toBe(0);
    expect(report.totals.candidates).toBe(1);
  });

  it("resolves the budget from env, falling back to the default on garbage", () => {
    expect(agentTreeBudgetBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_AGENT_TREE_BUDGET_BYTES);
    expect(agentTreeBudgetBytes({ SWITCHROOM_AGENT_TREE_BUDGET_GB: "2" } as NodeJS.ProcessEnv)).toBe(2 * GB);
    expect(agentTreeBudgetBytes({ SWITCHROOM_AGENT_TREE_BUDGET_GB: "-3" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_AGENT_TREE_BUDGET_BYTES,
    );
    expect(agentTreeBudgetBytes({ SWITCHROOM_AGENT_TREE_BUDGET_GB: "banana" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_AGENT_TREE_BUDGET_BYTES,
    );
  });

  it("says report-only, and says nothing was deleted", () => {
    const report = buildReapReport({
      nowMs: NOW,
      reapPlan: [],
      dirSizeBytes: () => 0,
      gcPlan: gcPlan([]),
    });
    expect(report.mode).toBe("report-only");
    expect(formatReapReport(report)).toContain("nothing was deleted");
  });
});

// ── The safety default: a report pass leaves the disk and registry alone ────

describe("worktree reap-report — deletes nothing", () => {
  let tmpDir: string;
  const origEnv = process.env.SWITCHROOM_WORKTREE_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-reap-report-"));
    process.env.SWITCHROOM_WORKTREE_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.SWITCHROOM_WORKTREE_DIR;
    else process.env.SWITCHROOM_WORKTREE_DIR = origEnv;
  });

  it("leaves a would-reap orphan record and a would-reap tree on disk untouched", () => {
    // A stale registry claim whose tree exists AND a task tree the classifier
    // says it would reap. A real reap pass would delete both; the report pass
    // must leave every byte in place.
    const treeDir = join(tmpDir, "checkouts", "stale01");
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(join(treeDir, "file.txt"), "work");
    writeRecord({
      id: "stale01",
      repo: "/repo",
      repoName: "switchroom",
      branch: "task/stale01",
      path: treeDir,
      createdAt: new Date(Date.now() - STALE_THRESHOLD_MS * 4).toISOString(),
      heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS * 3).toISOString(),
      ownerAgent: "klanker",
    });

    const taskDir = join(tmpDir, "agents", "klanker", "home", "work", "fix-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "keep.txt"), "task work");

    const report = buildReapReport({
      // Real planReaper (reads the registry above), synthetic gc plan so the
      // test does not shell out to git/gh.
      reaperDeps: { probeInUse: () => "free", hasUncommittedChanges: () => false },
      gcPlan: gcPlan([taskTree({ dir: taskDir })]),
      dirSizeBytes: () => 4096,
    });

    expect(report.totals.wouldReap).toBeGreaterThanOrEqual(2);
    // Outcome: everything still there.
    expect(existsSync(join(treeDir, "file.txt"))).toBe(true);
    expect(existsSync(join(taskDir, "keep.txt"))).toBe(true);
    expect(listRecords().map((r) => r.id)).toEqual(["stale01"]);
  });
});
