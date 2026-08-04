/**
 * Tests for src/worktree/gc.ts — the dev-worktree garbage collector.
 *
 * The pure decision functions are tested directly; the planner is driven with
 * injected fs/exec/pr deps so no real disk or git is touched. One temp-dir test
 * covers the quarantine move + purge.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseGitdirPointer,
  repoRootFromWorktreeGitdir,
  isSwitchroomRemote,
  parseWorktreeList,
  isEffectivelyClean,
  classifyRegistered,
  looksLikeAgentWorktree,
  isEphemeralPath,
  planGc,
  applyGc,
  selectPurgeTargets,
  pushStateFrom,
  isStablePerRepoBranch,
  classifyTaskTree,
  type GcDeps,
  type TaskTreeClassifyInput,
} from "../src/worktree/gc.js";

// ── pure helpers ──────────────────────────────────────────────────────────

describe("parseGitdirPointer", () => {
  it("extracts the gitdir path", () => {
    expect(parseGitdirPointer("gitdir: /home/op/code/switchroom/.git/worktrees/sr-x\n"))
      .toBe("/home/op/code/switchroom/.git/worktrees/sr-x");
  });
  it("returns null when absent", () => {
    expect(parseGitdirPointer("not a gitdir file")).toBeNull();
  });
});

describe("repoRootFromWorktreeGitdir", () => {
  it("derives the repo root", () => {
    expect(repoRootFromWorktreeGitdir("/home/op/code/switchroom/.git/worktrees/sr-x"))
      .toBe("/home/op/code/switchroom");
  });
  it("returns null for a non-worktree gitdir", () => {
    expect(repoRootFromWorktreeGitdir("/home/op/code/switchroom/.git")).toBeNull();
  });
});

describe("isSwitchroomRemote", () => {
  it("matches https + ssh canonical forms", () => {
    expect(isSwitchroomRemote("https://github.com/switchroom/switchroom.git")).toBe(true);
    expect(isSwitchroomRemote("git@github.com:switchroom/switchroom.git")).toBe(true);
    expect(isSwitchroomRemote("https://github.com/switchroom/switchroom")).toBe(true);
  });
  it("rejects other repos (incl. the dead fork & web repo)", () => {
    expect(isSwitchroomRemote("https://github.com/mekenthompson/switchroom-web.git")).toBe(false);
    expect(isSwitchroomRemote("https://github.com/someone/clued-in.git")).toBe(false);
    expect(isSwitchroomRemote("https://github.com/mekenthompson/switchroom.git")).toBe(false);
  });
});

describe("parseWorktreeList", () => {
  it("parses main + feature + detached + bare", () => {
    const porcelain = [
      "worktree /home/op/code/switchroom",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /home/op/code/sr-x",
      "HEAD def",
      "branch refs/heads/feat/foo",
      "",
      "worktree /home/op/code/sr-d",
      "HEAD 111",
      "detached",
      "",
    ].join("\n");
    const r = parseWorktreeList(porcelain);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ path: "/home/op/code/switchroom", branch: "main" });
    expect(r[1]).toMatchObject({ path: "/home/op/code/sr-x", branch: "feat/foo" });
    expect(r[2]).toMatchObject({ path: "/home/op/code/sr-d", detached: true, branch: null });
  });
});

describe("isEffectivelyClean", () => {
  it("true for empty / only build-info / only tgz", () => {
    expect(isEffectivelyClean([""])).toBe(true);
    expect(isEffectivelyClean([" M src/build-info.ts"])).toBe(true);
    expect(isEffectivelyClean(["?? switchroom-0.15.41.tgz"])).toBe(true);
    expect(isEffectivelyClean([" M src/build-info.ts", "?? switchroom-0.15.41.tgz", ""])).toBe(true);
  });
  it("FALSE for a staged-but-uncommitted new file (the lost-doc case)", () => {
    // This is the exact thing that must protect a worktree from removal.
    expect(isEffectivelyClean(["A  reference/rfcs/foo.md"])).toBe(false);
    expect(isEffectivelyClean(["?? docs/turn-status-surface-redesign.md"])).toBe(false);
  });
  it("FALSE for modified real source", () => {
    expect(isEffectivelyClean([" M src/cli/worktree.ts"])).toBe(false);
  });
  it("does NOT treat an untracked build-info as clean", () => {
    expect(isEffectivelyClean(["?? src/build-info.ts"])).toBe(false);
  });
});

describe("classifyRegistered", () => {
  const base = {
    isMain: false,
    isBare: false,
    isRegistryClaimed: false,
    isAgentWorktree: false,
    isEphemeralPath: false,
    prSignal: "merged" as const,
    clean: true,
  };
  it("removes a merged + clean unprotected worktree", () => {
    expect(classifyRegistered(base)).toBe("remove");
  });
  it("protects main/bare/registry/agent/ephemeral", () => {
    expect(classifyRegistered({ ...base, isMain: true })).toBe("skip-protected");
    expect(classifyRegistered({ ...base, isBare: true })).toBe("skip-protected");
    expect(classifyRegistered({ ...base, isRegistryClaimed: true })).toBe("skip-protected");
    expect(classifyRegistered({ ...base, isAgentWorktree: true })).toBe("skip-protected");
    expect(classifyRegistered({ ...base, isEphemeralPath: true })).toBe("skip-protected");
  });
  it("does NOT remove CLOSED (abandoned) PRs", () => {
    expect(classifyRegistered({ ...base, prSignal: "closed" })).toBe("skip-unmerged");
  });
  it("does NOT remove open / none", () => {
    expect(classifyRegistered({ ...base, prSignal: "open" })).toBe("skip-unmerged");
    expect(classifyRegistered({ ...base, prSignal: "none" })).toBe("skip-unmerged");
  });
  it("keeps on gh error (unknown ⇒ never delete)", () => {
    expect(classifyRegistered({ ...base, prSignal: "error" })).toBe("skip-unknown");
  });
  it("does NOT remove merged-but-dirty", () => {
    expect(classifyRegistered({ ...base, clean: false })).toBe("skip-dirty");
  });
});

describe("looksLikeAgentWorktree / isEphemeralPath", () => {
  it("flags agent + task branches, /work/ and .claude/worktrees paths", () => {
    expect(looksLikeAgentWorktree("/x/work/foo", null)).toBe(true);
    expect(looksLikeAgentWorktree("/x/y", "agent/clerk/main")).toBe(true);
    expect(looksLikeAgentWorktree("/x/y", "task/abc-123")).toBe(true);
    // Claude Code isolation worktrees — must be protected even with a feat/ branch.
    expect(looksLikeAgentWorktree("/home/op/code/switchroom/.claude/worktrees/agent-abc", "sec/1393-x")).toBe(true);
    expect(looksLikeAgentWorktree("/home/op/code/sr-x", "feat/foo")).toBe(false);
  });
  it("flags /tmp, /host and /state (container-internal)", () => {
    expect(isEphemeralPath("/tmp/wt-x")).toBe(true);
    expect(isEphemeralPath("/host/home/op/code/x")).toBe(true);
    expect(isEphemeralPath("/state/agent/home/workspace/sr-x")).toBe(true);
    expect(isEphemeralPath("/home/op/code/sr-x")).toBe(false);
  });
});

describe("selectPurgeTargets", () => {
  it("selects only entries at/over the age threshold", () => {
    const r = selectPurgeTargets(
      [
        { path: "/t/a", ageDays: 20 },
        { path: "/t/b", ageDays: 5 },
        { path: "/t/c", ageDays: 14 },
      ],
      14,
    );
    expect(r).toEqual(["/t/a", "/t/c"]);
  });
});

// ── planner (injected deps) ─────────────────────────────────────────────────

describe("planGc — orphan attribution + merged sweep", () => {
  // Virtual filesystem: ~/code with several candidate dirs.
  const REPO = "/home/op/code/switchroom"; // a switchroom repo
  const OTHER = "/home/op/code/clued-in"; // a non-switchroom repo
  const root = "/home/op/code";

  // dirs present under root
  const dirs = [
    "switchroom", // the repo itself (.git dir)
    "switchroom-web", // real clone, non-switchroom remote
    "sr-merged", // orphan, points into REPO, admin gone
    "sr-foreign", // orphan, points into OTHER (must be ignored)
    "sr-live", // worktree, admin still exists (Phase B, not A)
    "channel-spike", // no .git at all
  ];

  function makeDeps(prByBranch: Record<string, any>): GcDeps {
    const fileContents: Record<string, string> = {
      [`${root}/sr-merged/.git`]: `gitdir: ${REPO}/.git/worktrees/sr-merged\n`,
      [`${root}/sr-foreign/.git`]: `gitdir: ${OTHER}/.git/worktrees/sr-foreign\n`,
      [`${root}/sr-live/.git`]: `gitdir: ${REPO}/.git/worktrees/sr-live\n`,
    };
    const dirSet = new Set<string>([
      root,
      `${root}/switchroom`,
      `${root}/switchroom/.git`, // .git is a DIRECTORY → real repo
      `${root}/switchroom-web`,
      `${root}/switchroom-web/.git`, // real clone
      OTHER,
      // admin dirs that still exist:
      `${REPO}/.git/worktrees/sr-live`,
      // sr-merged admin dir intentionally ABSENT (orphan)
    ]);
    const fileSet = new Set<string>(Object.keys(fileContents));

    // .git paths that are DIRECTORIES (real repos) vs FILES (worktree pointers)
    const gitDirs = new Set<string>([`${root}/switchroom/.git`, `${root}/switchroom-web/.git`]);

    return {
      dateStamp: "2026-06-23",
      existsSync: (p: string) => dirSet.has(p) || fileSet.has(p),
      readDir: (p: string) => {
        if (p === root) return dirs;
        throw new Error("unexpected readDir " + p);
      },
      readFile: (p: string) => {
        if (fileContents[p]) return fileContents[p];
        throw new Error("unexpected readFile " + p);
      },
      stat: (p: string) => ({ isDirectory: () => gitDirs.has(p) }),
      exec: (file: string, args: string[], cwd?: string) => {
        if (file === "git" && args.includes("remote")) {
          const repo = args[args.indexOf("-C") + 1];
          if (repo === REPO) return "https://github.com/switchroom/switchroom.git\n";
          return "https://github.com/someone/clued-in.git\n";
        }
        if (file === "git" && args.includes("worktree") && args.includes("list")) {
          // worktree list for REPO: main + sr-live
          return [
            `worktree ${REPO}`,
            "branch refs/heads/main",
            "",
            `worktree ${root}/sr-live`,
            "branch refs/heads/feat/live",
            "",
          ].join("\n");
        }
        if (file === "git" && args.includes("status")) {
          return ""; // clean
        }
        throw new Error("unexpected exec " + file + " " + args.join(" "));
      },
      prSignal: (_repo: string, branch: string) => prByBranch[branch] ?? "none",
    };
  }

  it("quarantines the switchroom orphan, ignores the foreign orphan", () => {
    // NOTE: this test exercises attribution logic via injected readFile/exec.
    // The .git-is-a-directory short-circuit uses statSync on real paths, so we
    // assert on the orphan/registered outcomes that don't depend on it.
    const plan = planGc([root], makeDeps({ "feat/live": "merged" }));

    const orphanDirs = plan.orphans.map((o) => o.dir);
    expect(orphanDirs).toContain(`${root}/sr-merged`);
    expect(orphanDirs).not.toContain(`${root}/sr-foreign`);
    expect(orphanDirs).not.toContain(`${root}/sr-live`); // admin exists → not orphan

    // foreign orphan recorded as skipped (outside switchroom)
    expect(plan.skipped.some((s) => s.dir === `${root}/sr-foreign`)).toBe(true);

    // quarantine destination uses the date stamp
    const merged = plan.orphans.find((o) => o.dir === `${root}/sr-merged`)!;
    expect(merged.dest).toContain("2026-06-23");
    expect(merged.owner).toBe(REPO);
  });

  it("removes the merged+clean registered worktree (sr-live)", () => {
    const plan = planGc([root], makeDeps({ "feat/live": "merged" }));
    const live = plan.registered.find((r) => r.path === `${root}/sr-live`);
    expect(live?.verdict).toBe("remove");
    // main is protected
    const main = plan.registered.find((r) => r.path === REPO);
    expect(main?.verdict).toBe("skip-protected");
  });

  it("keeps the registered worktree when its PR is not merged", () => {
    const plan = planGc([root], makeDeps({ "feat/live": "open" }));
    const live = plan.registered.find((r) => r.path === `${root}/sr-live`);
    expect(live?.verdict).toBe("skip-unmerged");
  });
});

// ── task-tree coverage (RFC §4) ──────────────────────────────────────────────

describe("pushStateFrom", () => {
  it("pushed only when an upstream exists and HEAD is not ahead", () => {
    expect(pushStateFrom({ detached: false, upstream: "origin/feat/x", aheadCount: 0 })).toBe("pushed");
  });
  it("detached HEAD ⇒ detached (fail toward keep)", () => {
    expect(pushStateFrom({ detached: true, upstream: null, aheadCount: 0 })).toBe("detached");
  });
  it("no upstream ⇒ no-upstream (never-pushed abandoned branch)", () => {
    expect(pushStateFrom({ detached: false, upstream: null, aheadCount: 0 })).toBe("no-upstream");
  });
  it("commits ahead of upstream ⇒ unpushed", () => {
    expect(pushStateFrom({ detached: false, upstream: "origin/feat/x", aheadCount: 3 })).toBe("unpushed");
  });
  it("negative count (git failed) ⇒ error (fail toward keep)", () => {
    expect(pushStateFrom({ detached: false, upstream: "origin/feat/x", aheadCount: -1 })).toBe("error");
  });
});

describe("isStablePerRepoBranch", () => {
  it("matches agent/<name>/main only", () => {
    expect(isStablePerRepoBranch("agent/klanker/main")).toBe(true);
    expect(isStablePerRepoBranch("agent/overlord/main")).toBe(true);
    expect(isStablePerRepoBranch("feat/fix-3019")).toBe(false);
    expect(isStablePerRepoBranch("agent/klanker/feature")).toBe(false);
    expect(isStablePerRepoBranch(null)).toBe(false);
  });
});

describe("classifyTaskTree — safety-first decision order", () => {
  const clean: TaskTreeClassifyInput = {
    isRegistryClaimed: false,
    isStablePerRepoTree: false,
    isEphemeralPath: false,
    clean: true,
    pushed: "pushed",
    prSignal: "merged",
    idle: true,
    inUse: "free",
  };
  it("REAPS a clean + pushed + idle + merged + free tree", () => {
    expect(classifyTaskTree(clean)).toBe("reap");
  });
  it("REAPS a closed-PR (abandoned) task tree — closed is eligible here", () => {
    expect(classifyTaskTree({ ...clean, prSignal: "closed" })).toBe("reap");
  });
  it("protects registry-claimed / stable per-repo tree / ephemeral", () => {
    expect(classifyTaskTree({ ...clean, isRegistryClaimed: true })).toBe("skip-protected");
    expect(classifyTaskTree({ ...clean, isStablePerRepoTree: true })).toBe("skip-protected");
    expect(classifyTaskTree({ ...clean, isEphemeralPath: true })).toBe("skip-protected");
  });
  it("NEVER reaps a dirty tree", () => {
    expect(classifyTaskTree({ ...clean, clean: false })).toBe("skip-dirty");
  });
  it("NEVER reaps an in-use tree, even when otherwise reapable", () => {
    expect(classifyTaskTree({ ...clean, inUse: "in-use" })).toBe("skip-in-use");
  });
  it("keeps when the in-use probe is unavailable (cannot prove idle)", () => {
    expect(classifyTaskTree({ ...clean, inUse: "unavailable" })).toBe("skip-probe-unavailable");
  });
  it("in-use OUTRANKS dirty — a live dirty tree is skip-in-use, not escape-hatch eligible", () => {
    expect(classifyTaskTree({ ...clean, inUse: "in-use", clean: false })).toBe("skip-in-use");
  });
  it("NEVER reaps an unpushed / detached / no-upstream tree", () => {
    expect(classifyTaskTree({ ...clean, pushed: "unpushed" })).toBe("skip-unpushed");
    expect(classifyTaskTree({ ...clean, pushed: "detached" })).toBe("skip-unpushed");
    expect(classifyTaskTree({ ...clean, pushed: "no-upstream" })).toBe("skip-unpushed");
    expect(classifyTaskTree({ ...clean, pushed: "error" })).toBe("skip-unpushed");
  });
  it("NEVER reaps a non-idle (recently active) tree", () => {
    expect(classifyTaskTree({ ...clean, idle: false })).toBe("skip-active");
  });
  it("keeps open / no PR and gh errors", () => {
    expect(classifyTaskTree({ ...clean, prSignal: "open" })).toBe("skip-unmerged");
    expect(classifyTaskTree({ ...clean, prSignal: "none" })).toBe("skip-unmerged");
    expect(classifyTaskTree({ ...clean, prSignal: "error" })).toBe("skip-unknown");
  });
});

describe("planGc — task-tree sweep across all three tree shapes (RFC §4)", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;
  const root = "/agents/a1/home/work";
  const OWNER = "/agents/a1/work/switchroom";
  const SR = "https://github.com/switchroom/switchroom.git\n";

  interface TreeSpec {
    shape: "clone" | "worktree";
    remote?: string;
    branch?: string | null; // null ⇒ detached HEAD
    status?: string[]; // porcelain lines (default clean)
    upstream?: string | null; // default present
    ahead?: number; // default 0
    mtimeDaysAgo?: number; // default 30 (idle)
    pr?: string; // default merged
    inUse?: "free" | "in-use" | "unavailable"; // default free
  }

  function makeDeps(trees: Record<string, TreeSpec>, escapeHatch = false): GcDeps {
    const names = Object.keys(trees);
    const dirOf = (name: string) => `${root}/${name}`;
    const specByDir = new Map<string, TreeSpec>();
    for (const n of names) specByDir.set(dirOf(n), trees[n]);

    return {
      dateStamp: "2026-08-04",
      idleDays: 14,
      nowMs: NOW,
      escapeHatch,
      existsSync: (p: string) => p === root || p.endsWith("/.git") === true && specByDir.has(p.slice(0, -5)),
      readDir: (p: string) => {
        if (p === root) return names;
        throw new Error("unexpected readDir " + p);
      },
      stat: (p: string) => {
        const dir = p.slice(0, -5); // strip "/.git"
        const spec = specByDir.get(dir);
        return { isDirectory: () => spec?.shape === "clone" };
      },
      readFile: (p: string) => {
        // only worktree shapes read the .git pointer
        const dir = p.slice(0, -5);
        return `gitdir: ${OWNER}/.git/worktrees/${dir.split("/").pop()}\n`;
      },
      probeInUse: (p: string) => specByDir.get(p)?.inUse ?? "free",
      newestTrackedMtimeMs: (dir: string) => NOW - (specByDir.get(dir)?.mtimeDaysAgo ?? 30) * DAY,
      exec: (file: string, args: string[]) => {
        const dir = args[args.indexOf("-C") + 1];
        const spec = specByDir.get(dir);
        if (!spec) throw new Error("unexpected exec dir " + dir);
        if (args.includes("remote")) return spec.remote ?? SR;
        if (args.includes("status")) return (spec.status ?? []).join("\n");
        if (args.includes("rev-parse") && args.includes("HEAD") && !args.includes("@{upstream}")) {
          return spec.branch === null ? "HEAD\n" : `${spec.branch ?? "feat/x"}\n`;
        }
        if (args.includes("@{upstream}") && args.includes("rev-parse")) {
          if (spec.upstream === null) throw new Error("no upstream");
          return `${spec.upstream ?? "origin/feat/x"}\n`;
        }
        if (args.includes("rev-list")) return `${spec.ahead ?? 0}\n`;
        throw new Error("unexpected exec " + file + " " + args.join(" "));
      },
      prSignal: (_repo: string, _branch: string) => {
        const spec = specByDir.get(_repo);
        return (spec?.pr ?? "merged") as any;
      },
    };
  }

  function verdictOf(trees: Record<string, TreeSpec>, name: string, escapeHatch = false) {
    const plan = planGc([], makeDeps(trees, escapeHatch), [root]);
    return plan.taskTrees.find((t) => t.dir === `${root}/${name}`);
  }

  it("a clean + pushed + idle + merged CLONE IS eligible (willAct)", () => {
    const t = verdictOf({ "clone-x": { shape: "clone" } }, "clone-x");
    expect(t?.verdict).toBe("reap");
    expect(t?.willAct).toBe(true);
    expect(t?.shape).toBe("clone");
  });

  it("a clean + pushed + idle + merged WORKTREE IS eligible, with its owner repo captured for prune", () => {
    const t = verdictOf({ "wt-x": { shape: "worktree" } }, "wt-x");
    expect(t?.verdict).toBe("reap");
    expect(t?.willAct).toBe(true);
    expect(t?.shape).toBe("worktree");
    expect(t?.ownerRepo).toBe(OWNER);
  });

  it("a nested-repo-shaped (clone) closed-PR tree IS eligible", () => {
    const t = verdictOf({ "nested-x": { shape: "clone", pr: "closed" } }, "nested-x");
    expect(t?.verdict).toBe("reap");
    expect(t?.willAct).toBe(true);
  });

  it("a DIRTY tree is NOT reaped (skip-dirty, willAct false)", () => {
    const t = verdictOf({ dirty: { shape: "clone", status: ["A  docs/new.md"] } }, "dirty");
    expect(t?.verdict).toBe("skip-dirty");
    expect(t?.willAct).toBe(false);
  });

  it("an IN-USE tree is NOT reaped (skip-in-use), even under the escape hatch", () => {
    const t = verdictOf(
      { live: { shape: "clone", inUse: "in-use", status: ["A  docs/new.md"] } },
      "live",
      /* escapeHatch */ true,
    );
    expect(t?.verdict).toBe("skip-in-use");
    expect(t?.willAct).toBe(false);
  });

  it("an UNPUSHED (ahead-of-upstream) tree is NOT reaped", () => {
    const t = verdictOf({ ahead: { shape: "clone", ahead: 2 } }, "ahead");
    expect(t?.verdict).toBe("skip-unpushed");
    expect(t?.willAct).toBe(false);
  });

  it("a NO-UPSTREAM (never-pushed) tree is NOT reaped", () => {
    const t = verdictOf({ orphanbr: { shape: "clone", upstream: null } }, "orphanbr");
    expect(t?.verdict).toBe("skip-unpushed");
  });

  it("a DETACHED-HEAD tree is NOT reaped", () => {
    const t = verdictOf({ det: { shape: "clone", branch: null } }, "det");
    expect(t?.verdict).toBe("skip-unpushed");
  });

  it("a recently-active (non-idle) tree is NOT reaped", () => {
    const t = verdictOf({ active: { shape: "clone", mtimeDaysAgo: 1 } }, "active");
    expect(t?.verdict).toBe("skip-active");
    expect(t?.willAct).toBe(false);
  });

  it("an OPEN-PR tree is NOT reaped", () => {
    const t = verdictOf({ openpr: { shape: "clone", pr: "open" } }, "openpr");
    expect(t?.verdict).toBe("skip-unmerged");
  });

  it("a NON-switchroom tree is ignored (recorded in skipped, never actioned)", () => {
    const deps = makeDeps({ foreign: { shape: "clone", remote: "https://github.com/x/y.git\n" } });
    const plan = planGc([], deps, [root]);
    expect(plan.taskTrees.find((t) => t.dir === `${root}/foreign`)).toBeUndefined();
    expect(plan.skipped.some((s) => s.dir === `${root}/foreign`)).toBe(true);
  });

  it("the stable per-repo tree (agent/<name>/main) is protected", () => {
    const t = verdictOf({ stable: { shape: "worktree", branch: "agent/a1/main" } }, "stable");
    expect(t?.verdict).toBe("skip-protected");
    expect(t?.willAct).toBe(false);
  });

  it("escape hatch quarantines an IDLE dirty tree (willAct), but leaves auto behaviour off by default", () => {
    const spec = { dirtyidle: { shape: "clone" as const, status: ["A  docs/new.md"] } };
    expect(verdictOf(spec, "dirtyidle", false)?.willAct).toBe(false);
    const withHatch = verdictOf(spec, "dirtyidle", true);
    expect(withHatch?.verdict).toBe("skip-dirty");
    expect(withHatch?.willAct).toBe(true);
  });

  it("escape hatch does NOT quarantine a non-idle dirty tree (recently active)", () => {
    const t = verdictOf(
      { dirtyactive: { shape: "clone", status: ["A  docs/new.md"], mtimeDaysAgo: 1 } },
      "dirtyactive",
      true,
    );
    expect(t?.verdict).toBe("skip-dirty");
    expect(t?.willAct).toBe(false);
  });
});

// ── applyGc quarantine (real temp dir) ───────────────────────────────────────

describe("applyGc — quarantine move (real fs)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sw-gc-apply-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("moves an orphan dir into the trash dir (recoverable, not deleted)", () => {
    const code = join(tmp, "code");
    const orphan = join(code, "sr-old");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "uncommitted.txt"), "precious work");
    const trash = join(tmp, "trash", "2026-06-23");

    const result = applyGc({
      roots: [code],
      taskTreeRoots: [],
      trashDir: trash,
      orphans: [{ dir: orphan, owner: "/x/switchroom", dest: join(trash, "sr-old") }],
      registered: [],
      taskTrees: [],
      reposToPrune: [],
      skipped: [],
    });

    expect(result.quarantined).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false); // moved out of ~/code
    expect(existsSync(join(trash, "sr-old", "uncommitted.txt"))).toBe(true); // recoverable
    expect(readdirSync(join(trash))).toContain("sr-old");
  });

  it("does nothing destructive for a dry-run-shaped (empty) plan", () => {
    const result = applyGc({
      roots: [tmp],
      taskTreeRoots: [],
      trashDir: join(tmp, "trash"),
      orphans: [],
      registered: [{ path: "/x", branch: "feat/x", verdict: "skip-dirty", prSignal: "merged", repo: "/r" }],
      taskTrees: [],
      reposToPrune: [],
      skipped: [],
    });
    expect(result.quarantined).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it("quarantines an actioned task tree (recoverable move, not delete)", () => {
    const work = join(tmp, "home", "work");
    const tree = join(work, "fix-3019");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "src.ts"), "content");
    const trash = join(tmp, "trash", "2026-08-04");

    const result = applyGc({
      roots: [],
      taskTreeRoots: [work],
      trashDir: trash,
      orphans: [],
      registered: [],
      taskTrees: [
        {
          dir: tree,
          shape: "clone",
          ownerRepo: null,
          branch: "feat/fix-3019",
          verdict: "reap",
          prSignal: "merged",
          idle: true,
          dest: join(trash, "fix-3019"),
          willAct: true,
        },
      ],
      reposToPrune: [],
      skipped: [],
    });

    expect(result.quarantined).toEqual([tree]);
    expect(existsSync(tree)).toBe(false); // moved out of home/work
    expect(existsSync(join(trash, "fix-3019", "src.ts"))).toBe(true); // recoverable
  });

  it("does NOT move a task tree whose willAct is false (surfaced-only)", () => {
    const work = join(tmp, "home", "work");
    const tree = join(work, "dirty-tree");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "wip.ts"), "uncommitted");
    const trash = join(tmp, "trash", "2026-08-04");

    const result = applyGc({
      roots: [],
      taskTreeRoots: [work],
      trashDir: trash,
      orphans: [],
      registered: [],
      taskTrees: [
        {
          dir: tree,
          shape: "clone",
          ownerRepo: null,
          branch: "feat/wip",
          verdict: "skip-dirty",
          prSignal: "error",
          idle: true,
          dest: join(trash, "dirty-tree"),
          willAct: false,
        },
      ],
      reposToPrune: [],
      skipped: [],
    });

    expect(result.quarantined).toHaveLength(0);
    expect(existsSync(join(tree, "wip.ts"))).toBe(true); // untouched
  });

  it("prunes the owner repo after quarantining a worktree-shaped task tree", () => {
    const work = join(tmp, "home", "work");
    const tree = join(work, "review-3022");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "a.ts"), "x");
    const trash = join(tmp, "trash", "2026-08-04");
    const owner = "/agents/a1/work/switchroom";
    const execCalls: string[][] = [];

    const result = applyGc(
      {
        roots: [],
        taskTreeRoots: [work],
        trashDir: trash,
        orphans: [],
        registered: [],
        taskTrees: [
          {
            dir: tree,
            shape: "worktree",
            ownerRepo: owner,
            branch: "feat/review-3022",
            verdict: "reap",
            prSignal: "merged",
            idle: true,
            dest: join(trash, "review-3022"),
            willAct: true,
          },
        ],
        reposToPrune: [owner],
        skipped: [],
      },
      { exec: (file, args) => { execCalls.push([file, ...args]); return ""; } },
    );

    expect(result.quarantined).toEqual([tree]);
    expect(existsSync(tree)).toBe(false);
    expect(result.pruned).toEqual([owner]);
    expect(execCalls).toContainEqual(["git", "-C", owner, "worktree", "prune"]);
  });
});
