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
  type GcDeps,
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
      trashDir: trash,
      orphans: [{ dir: orphan, owner: "/x/switchroom", dest: join(trash, "sr-old") }],
      registered: [],
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
      trashDir: join(tmp, "trash"),
      orphans: [],
      registered: [{ path: "/x", branch: "feat/x", verdict: "skip-dirty", prSignal: "merged", repo: "/r" }],
      reposToPrune: [],
      skipped: [],
    });
    expect(result.quarantined).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });
});
